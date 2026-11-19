// ============================================================================
// localEngine.ts - the terminal's data adapter.
//
// The ported chart engine was written against a remote PostgREST backend where
// every (symbol, timeframe) pair had its own table, so its fetch layer speaks
// "table names". The terminal has exactly one endpoint instead:
//
//     GET /api/candles?provider=&symbol=&timeframe=&limit=
//
// This module is the only translation point between those two worlds. Keeping
// it isolated means the rendering code above it stays byte-identical to the
// original, which is what preserves 1:1 behaviour: any divergence in the draw
// loop, the wheel physics or the crosshair would show up as a feel difference.
//
// It also deliberately holds NO credentials and NO remote host. Everything
// resolves against the local engine on the same origin, so the bundle carries
// nothing that could leak if this repo is ever published.
// ============================================================================

export interface EngineContext {
  provider: string;
  symbol: string;
}

// The chart's fetch layer receives a table name but not the symbol/provider it
// belongs to (upstream those were baked into the table). The mount layer sets
// the active context whenever the user changes symbol or provider, and the
// resolver below combines it with the timeframe parsed out of the table name.
let ctx: EngineContext = { provider: 'demo', symbol: '' };

export function setEngineContext(next: EngineContext): void {
  ctx = next;
}

export function getEngineContext(): EngineContext {
  return ctx;
}

// Map a legacy table name back to a terminal timeframe.
//
// Upstream naming falls into two shapes:
//   - per-pair minute tables:  candles_btcusd, candles_xauusd   -> 1m
//   - pre-aggregated HTF:      x_candles_5m, <prefix>_candles_1h -> that suffix
//   - sub-minute:              candles_5s, candles_100ticks     -> that suffix
// Anything unrecognised falls back to 1m, which matches the upstream default
// for per-pair tables rather than inventing a new behaviour.
const TF_SUFFIX = /_(\d+(?:s|m|h|d|w)|1M|\d+ticks)$/i;

export function resolveTimeframe(tableName: string): string {
  const m = tableName.match(TF_SUFFIX);
  if (!m) return '1m';
  const raw = m[1];
  // Upstream uses '1H'/'1D' casing in TF_MINUTES; the terminal API wants
  // lowercase. Normalise here so callers never have to care.
  return raw === '1M' ? '1M' : raw.toLowerCase();
}

// ── Imported files have ONE resolution ─────────────────────────────────
// The ported chart addresses history by upstream table names ("candles_gold"),
// which carry no timeframe and so resolve to the site's 1m base assumption.
// Upstream that is right (every pair has a 1m table); here the history is a
// file the user imported at one resolution, and the engine refuses to invent
// finer bars: GET /api/candles?...&timeframe=1m answers 502 "GOLD was
// imported as 30m; cannot serve 1m". That is what left the manual backtester
// showing "No data available" for both bundled 30m samples.
// /api/data is the manifest of imported datasets with their resolutions; a
// request finer than the file is raised to the file's own. Aggregation
// upward stays correct because aggregateCandles buckets by wall-clock time,
// not by counting input bars.
let datasetTfs: Promise<Record<string, string>> | null = null;
function datasetTimeframes(): Promise<Record<string, string>> {
  if (!datasetTfs) {
    datasetTfs = fetch('/api/data')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ symbol?: string; timeframe?: string }>) => {
        const m: Record<string, string> = {};
        if (Array.isArray(rows)) {
          for (const d of rows) {
            if (d && d.symbol && d.timeframe) m[String(d.symbol).toUpperCase()] = d.timeframe;
          }
        }
        return m;
      })
      .catch(() => ({}));   // no manifest: behave exactly as before
  }
  return datasetTfs;
}

/** Minutes per bar, for comparing two timeframe strings. 0 = not comparable. */
function tfMinutes(tf: string): number {
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(String(tf).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 's': return n / 60;
    case 'm': return n;
    case 'h': return n * 60;
    case 'd': return n * 1440;
    case 'w': return n * 10080;
    default: return 0;
  }
}

export interface CandleRow {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Fetch candles from the local engine and return them in the row shape the
// ported chart code already expects ({timestamp, open, ...} with ISO-Z
// timestamps). The engine returns compact arrays [ts, o, h, l, c, v] with ts
// in epoch SECONDS, so the conversion is a straight map.
export async function fetchLocalCandles(
  tableName: string,
  options: {
    limit?: number;
    order?: 'asc' | 'desc';
    // ISO timestamps forwarded to the engine's start/end window. The manual
    // backtester fetches "history up to the session start" and pages further
    // back with an exclusive `before`; regular chart loads leave these unset.
    start?: string;
    end?: string;
    // Symbol override for callers that carry it explicitly (the HTF and
    // multi-chart paths); everything else resolves from the mount context.
    symbol?: string;
    // Explicit timeframe override, for callers whose table name does not
    // encode the timeframe (the rpc aggregation shim).
    timeframe?: string;
  } = {}
): Promise<CandleRow[]> {
  const symbol = options.symbol || ctx.symbol;
  if (!symbol) return [];

  let timeframe = options.timeframe ?? resolveTimeframe(tableName);
  if (ctx.provider === 'userdata') {
    const native = (await datasetTimeframes())[symbol.toUpperCase()];
    const nm = tfMinutes(native || '');
    if (nm > 0 && tfMinutes(timeframe) > 0 && tfMinutes(timeframe) < nm) timeframe = native;
  }

  const url = new URL('/api/candles', window.location.origin);
  url.searchParams.set('provider', ctx.provider);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('timeframe', timeframe);
  // The engine caps at 5000 server-side; ask for the caller's limit and let it
  // clamp rather than duplicating the cap here (one source of truth). Default
  // to a full page (the cap) so unqualified fetches open with deep history.
  url.searchParams.set('limit', String(options.limit ?? 5000));
  if (options.start) url.searchParams.set('start', options.start);
  if (options.end) url.searchParams.set('end', options.end);

  const res = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`local candle fetch failed: ${res.status}`);
  }
  const data = await res.json();
  const rows: CandleRow[] = (data.candles || []).map(
    (c: [number, number, number, number, number, number]) => ({
      // Epoch seconds -> ISO Z. The chart keys candles by timestamp string in
      // its merge path, so this must stay stable and timezone-independent.
      timestamp: new Date(c[0] * 1000).toISOString(),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    })
  );

  // The engine always returns oldest-first. Upstream callers that asked for
  // 'desc' expect newest-first, so honour that rather than silently ignoring it.
  return options.order === 'desc' ? rows.reverse() : rows;
}
