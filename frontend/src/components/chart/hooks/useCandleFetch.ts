/**
 * useCandleFetch.ts - Extracted data fetching utilities from ProCandlestickChart.tsx
 *
 * This module contains all the pure functions and helpers that were previously
 * inlined in ProCandlestickChart. They handle:
 * - Table name resolution (pair string to PostgREST table name)
 * - Symbol formatting (pair string to human-readable symbol like BTC/USD)
 * - Candle data aggregation (1m -> any timeframe, including monthly, tick, second)
 * - Backtester fallback fetching
 * - Timeframe parsing and conversion
 *
 * The actual fetch orchestration (fetchCandleData, progressive loading, phase 1/2)
 * stays in ProCandlestickChart because it is deeply coupled to component state
 * (setCandles, setLoading, setIsBackgroundLoading, etc). Extracting that would
 * require passing 15+ state setters, adding complexity without benefit.
 */

import { api, apiGet } from '@/lib/api';
import { fetchLocalCandles } from '@/lib/localEngine';
// useSymbolTableMap replaced by useMarketData (single source of truth for all symbol data)
import { useMarketData } from '@/hooks/useMarketData';
import { isMarketOpenForPair } from '@/lib/marketHours';
import { useMemo, useCallback } from 'react';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CandleData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

// Candle data is served by the terminal's own local engine on the same origin.
// The `BACKTEST_API` name is retained because several call sites import it; it
// is now just the local origin, and no credential is involved (nothing leaves
// this machine unless the user explicitly configures a remote data provider).
export const BACKTEST_API = '';

// Maps chart timeframe strings to their duration in minutes.
// Used throughout the codebase to convert user-facing timeframe labels to numeric values
// for candle bucketing, countdown timers, and API limit calculations.
export const TF_MINUTES: Record<string, number> = {
  'tick': 0,   // 0 signals tick mode (raw trade-by-trade data)
  '1s': 1/60, '5s': 5/60, '10s': 10/60, '30s': 30/60, // Sub-minute second timeframes
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1H': 60,
  '4H': 240,
  '1D': 1440,
  '1W': 10080,
  '1M': 43200
};

// Crypto base currencies for symbol classification
export const CRYPTO_BASES = ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'DOT', 'AVAX', 'LINK', 'MATIC', 'UNI', 'SHIB', 'LTC', 'ATOM', 'XLM', 'ALGO', 'VET', 'FTM', 'NEAR', 'AAVE', 'EOS', 'ZEC', 'XMR', 'ETC', 'MKR', 'COMP', 'SUSHI', 'YFI', 'SNX', 'CRV', 'BAL', '1INCH', 'DASH'];
export const CRYPTO_QUOTES = ['USD', 'USDT', 'USDC', 'BUSD', 'BTC', 'ETH'];
export const FIAT_QUOTES = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'NZD', 'NOK', 'SEK', 'DKK', 'SGD', 'HKD', 'CNH', 'ZAR', 'MXN', 'BRL', 'TRY', 'PLN', 'CZK', 'HUF', 'ILS', 'INR', 'THB', 'PHP', 'KRW', 'TWD', 'CLP', 'COP', 'PEN'];

// ─── Timeframe Parsing ─────────────────────────────────────────────────────────

// Parse tick count from timeframe string: 'tick' -> 1, '5tick' -> 5, '100tick' -> 100
// Returns 0 for non-tick timeframes
export function parseTickCount(tf: string): number {
  if (tf === 'tick') return 1;
  const match = tf.match(/^(\d+)tick$/i);
  return match ? parseInt(match[1], 10) : 0;
}

// Check if a timeframe is any tick-based timeframe (1 tick, 5 tick, etc.)
export function isTickTimeframe(tf: string): boolean {
  return parseTickCount(tf) > 0;
}

// Parse second count from timeframe string: '1s' -> 1, '5s' -> 5, '10s' -> 10, '30s' -> 30
// Returns 0 for non-second timeframes
export function parseSecondCount(tf: string): number {
  const match = tf.match(/^(\d+)s$/i);
  return match ? parseInt(match[1], 10) : 0;
}

// Check if a timeframe is a second-based timeframe
export function isSecondTimeframe(tf: string): boolean {
  return parseSecondCount(tf) > 0;
}

// Convert any timeframe string to minutes.
// Returns 0 for tick-based timeframes, fractional values for second-based.
export function timeframeToMinutes(tf: string): number {
  if (TF_MINUTES[tf] !== undefined) return TF_MINUTES[tf];
  // N-tick timeframes return 0 (tick mode)
  if (isTickTimeframe(tf)) return 0;
  // Second timeframes return fractional minutes
  const secs = parseSecondCount(tf);
  if (secs > 0) return secs / 60;
  const match = tf.match(/^(\d+)([mHDW])$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toUpperCase();
    switch (unit) {
      case 'M': return value;
      case 'H': return value * 60;
      case 'D': return value * 1440;
      case 'W': return value * 10080;
    }
  }
  return 1;
}

// ─── Symbol Classification ─────────────────────────────────────────────────────

// Determine if a pair string is a stock (not forex, not crypto, not commodity).
// If pair ends with any known quote currency, it is NOT a stock.
export function isStock(pairStr: string): boolean {
  const quotes = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'NZD', 'BTC', 'NOK', 'SEK', 'DKK', 'SGD', 'HKD', 'CNH', 'ZAR', 'MXN', 'BRL', 'TRY', 'PLN', 'CZK', 'HUF', 'ILS', 'INR', 'THB', 'PHP', 'KRW', 'TWD', 'CLP', 'COP', 'PEN'];
  const upper = pairStr.toUpperCase();
  for (const q of quotes) {
    if (upper.endsWith(q) && upper.length > q.length) return false;
  }
  return true;
}

export function isCommodity(pairStr: string): boolean {
  const upper = pairStr.toUpperCase();
  return /XAU|XAG|GOLD|SILVER|XAUUSD|XAGUSD/.test(upper);
}

export function isCrypto(pairStr: string): boolean {
  const upper = pairStr.toUpperCase();
  return /BTC|ETH|SOL|ADA|XRP|DOGE|BNB|XMR|LTC|AVAX|DOT|MATIC|LINK|UNI|ATOM|APT|ARB|OP|SUI|SEI|INJ|TIA|NEAR|FTM|ALGO|VET|HBAR|ICP|FIL|SAND|MANA|AXS|GALA|ENJ|IMX|BLUR|CRV|AAVE|COMP|MKR|SNX|SUSHI|YFI|1INCH|BAL|LDO|RPL|PEPE|SHIB|FLOKI|WIF|BONK/i.test(upper);
}

export function isForex(pairStr: string): boolean {
  return !isStock(pairStr) && !isCrypto(pairStr) && !isCommodity(pairStr);
}

// ─── Table Name Resolution ─────────────────────────────────────────────────────

// Convert a pair string to its PostgREST table name.
// Uses the symbol table map (from x_pricecache) for database-driven
// resolution, with fallback to computed names for unknown symbols.
// dataSource switches between 'candles_*' (default), the FX/CFD source's own tables, and prop firm tables.
export function formatPairForTable(
  pairStr: string,
  dataSource: 'default' | 'oanda' | 'ftmo' | 'prop',
  getTableNameFromMap: (symbol: string) => string | null
): string {
  // The FX/CFD source: its own views, one per pair, named with its prefix
  if (dataSource === 'oanda') {
    const allQuotes = ['USD', ...FIAT_QUOTES.filter(q => q !== 'USD'), ...CRYPTO_QUOTES.filter(q => q !== 'USD')];
    for (const q of allQuotes) {
      if (pairStr.toUpperCase().endsWith(q)) {
        return `oanda_${pairStr.slice(0, -q.length).toLowerCase()}_${q.toLowerCase()}`;
      }
    }
    return `oanda_${pairStr.toLowerCase().replace(/\./g, '_')}`;
  }

  // First try the dynamic map from x_pricecache (has correct candle_name)
  const mappedName = getTableNameFromMap(pairStr);
  if (mappedName && mappedName !== `candles_${pairStr.toLowerCase()}`) {
    return mappedName;
  }

  // For stocks (including international with dots like SHEL.L, 9988.HK),
  // replace dots with underscores
  if (isStock(pairStr)) {
    const mapResult = getTableNameFromMap(pairStr);
    return mapResult || `candles_${pairStr.toLowerCase().replace(/\./g, '_')}`;
  }

  // All pairs use underscore format: candles_bnb_usd, candles_eur_usd, etc.
  // USD must come BEFORE USDT/USDC/BUSD to avoid BNBUSD matching as BN+BUSD
  const allQuotes = ['USD', ...FIAT_QUOTES.filter(q => q !== 'USD'), ...CRYPTO_QUOTES.filter(q => q !== 'USD')];
  for (const q of allQuotes) {
    if (pairStr.toUpperCase().endsWith(q)) {
      return `candles_${pairStr.slice(0, -q.length).toLowerCase()}_${q.toLowerCase()}`;
    }
  }
  return getTableNameFromMap(pairStr) || `candles_${pairStr.toLowerCase().replace(/\./g, '_')}`;
}

// Convert a pair string to a human-readable symbol (e.g. BTCUSD -> BTC/USD).
// Used for HTF table queries which store symbols with slash separators,
// and for WebSocket subscriptions.
export function formatPairForSymbol(pairStr: string): string {
  if (isStock(pairStr)) return pairStr.toUpperCase();
  const quotes = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'NZD', 'BTC', 'NOK', 'SEK', 'DKK', 'SGD', 'HKD', 'CNH', 'ZAR', 'MXN', 'BRL', 'TRY', 'PLN', 'CZK', 'HUF', 'ILS', 'INR', 'THB', 'PHP', 'KRW', 'TWD', 'CLP', 'COP', 'PEN'];
  for (const q of quotes) {
    if (pairStr.toUpperCase().endsWith(q)) {
      return `${pairStr.slice(0, -q.length).toUpperCase()}/${q}`;
    }
  }
  return pairStr.toUpperCase();
}

// Build list of symbol variants to try for aggregated candle tables.
// The table may store symbols as: BTCUSD, BTC/USD, BTC, EURUSD, EUR/USD, NAS100, etc.
// We try all possible forms so at least one matches.
export function buildSymbolVariants(pair: string): string[] {
  const indexBases = ['NAS100', 'SPX500', 'US30', 'US2000', 'JP225', 'DE30', 'UK100', 'UK250', 'EU50', 'FR40', 'CN50', 'AU200', 'HK33', 'HSI', 'NIKKEI', 'DAX', 'CAC', 'VIX'];
  const quotesCurrency = ['USD', 'USDT', 'USDC', 'BUSD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'NZD', 'BTC'];

  let symbol = pair.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // Check if this is an index; strip quote currency suffix
  for (const idx of indexBases) {
    if (symbol.startsWith(idx) && symbol.length > idx.length) {
      symbol = idx;
      break;
    }
  }

  const symbolVariants: string[] = [symbol];

  for (const q of quotesCurrency) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      const baseSymbol = symbol.slice(0, -q.length);
      const slashVariant = `${baseSymbol}/${q}`;
      if (!symbolVariants.includes(slashVariant)) {
        symbolVariants.push(slashVariant);
      }
      if (!symbolVariants.includes(baseSymbol)) {
        symbolVariants.push(baseSymbol);
      }
    }
  }

  return symbolVariants;
}

// ─── Candle Aggregation ────────────────────────────────────────────────────────

// Map raw PostgREST response rows (desc order) to CandleData array (asc order).
// PostgREST returns newest first; chart needs oldest first.
export function mapCandleData(data: any[]): CandleData[] {
  return data.reverse().map((c: any) => ({
    timestamp: c.timestamp,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: c.volume != null ? Number(c.volume) : undefined
  }));
}

// Aggregate 1m candles into any higher timeframe.
// For daily+ timeframes (>=1440 min), buckets by date in LOCAL timezone
// to prevent timezone offset from shifting candles to wrong days.
// For intraday, uses UTC-based bucketing.
export function aggregateCandles(candles: CandleData[], minutes: number): CandleData[] {
  if (minutes === 1) return candles;
  const bucketMs = minutes * 60_000;
  const buckets = new Map<number, CandleData>();

  for (const c of candles) {
    const d = new Date(c.timestamp);
    let bucket: number;

    if (minutes >= 1440) {
      // Use midnight local time as bucket key to prevent TZ-shifted candles
      const localMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      bucket = localMidnight;
    } else {
      const t = d.getTime();
      bucket = Math.floor(t / bucketMs) * bucketMs;
    }

    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        timestamp: new Date(bucket).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume ?? 0
      });
    } else {
      existing.high = Math.max(Number(existing.high), Number(c.high));
      existing.low = Math.min(Number(existing.low), Number(c.low));
      existing.close = Number(c.close);
      existing.volume = (existing.volume ?? 0) + (c.volume ?? 0);
    }
  }
  return Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]).map(([_, v]) => v);
}

// ─── Fresh HTF live-edge tail ────────────────────────────────────────────────
// The x_candles_* HTF tables are rebuilt by a BATCHED aggregator, so their newest
// (just-closed) bucket lags the live price for up to one cycle. During a fast move
// that stale bucket renders a visible GAP against the real-time forming candle. This
// helper rebuilds ONLY the newest few buckets from the FRESH per-symbol 1m table
// (written per tick, the same source the 1m chart reads), so the live edge is correct;
// the frozen deep history keeps coming from x_candles_* untouched.
//
// nativeIntervalMinutes MUST be the interval of the HTF TABLE that backs the chart's
// `candles` array, NOT the display timeframe: 5m->5, 15m->15, 30m->15 (30m is shown by
// re-aggregating x_candles_15m), 1h->60, 4h->240. Aggregating to the table interval keeps
// the spliced rows keyed identically to the table rows so a merge REPLACES the stale
// bucket (one bar per bucket); aggregating to the display interval would leave foreign
// rows that the later display re-aggregation double-counts (volume ~doubles).
//
// Returns ISO-Z stamped buckets (aggregateCandles emits new Date(bucket).toISOString()),
// so callers MUST also normalize the x_candles_* rows to ISO-Z for the keys to collide.
export async function fetchFreshHtfTail(
  tableName1m: string,
  nativeIntervalMinutes: number,
  windowBuckets: number = 3
): Promise<CandleData[]> {
  if (nativeIntervalMinutes < 1) return [];
  const bucketMs = nativeIntervalMinutes * 60_000;
  const sinceMs = Math.floor(Date.now() / bucketMs) * bucketMs - windowBuckets * bucketMs;
  // Headroom: one extra bucket of minutes + 5 rows so the oldest target bucket is fully
  // covered even across the desc-fetch boundary. This is a few dozen rows, never millions.
  const rowLimit = (windowBuckets + 1) * nativeIntervalMinutes + 5;
  const raw = await api.getCandlesRange(tableName1m, {
    limit: rowLimit,
    order: 'desc',
    select: 'timestamp,open,high,low,close,volume',
  });
  const asc: CandleData[] = (raw || [])
    .reverse()
    .map((c: any) => ({
      timestamp: c.timestamp,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: c.volume != null ? Number(c.volume) : undefined,
    }))
    .filter((c: CandleData) => new Date(c.timestamp).getTime() >= sinceMs);
  if (asc.length === 0) return [];
  return aggregateCandles(asc, nativeIntervalMinutes);
}

// Calendar-month aggregation: buckets by actual month boundaries (Jan 1-31, Feb 1-28, etc.)
// Used for 1M timeframe where fixed-minute bucketing would create incorrect boundaries.
export function aggregateCandlesByMonth(candles: CandleData[]): CandleData[] {
  if (candles.length === 0) return [];
  const buckets = new Map<string, CandleData>();

  for (const c of candles) {
    const date = new Date(c.timestamp);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const bucketKey = `${year}-${String(month).padStart(2, '0')}`;
    const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

    const existing = buckets.get(bucketKey);
    if (!existing) {
      buckets.set(bucketKey, {
        timestamp: monthStart.toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume ?? 0
      });
    } else {
      existing.high = Math.max(Number(existing.high), Number(c.high));
      existing.low = Math.min(Number(existing.low), Number(c.low));
      existing.close = Number(c.close);
      existing.volume = (existing.volume ?? 0) + (c.volume ?? 0);
    }
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([_, v]) => v);
}

// Aggregate raw candles up to a specific timestamp (for backtesting partial candles).
// Shows all candle data up to and including the given timestamp.
// sourceMinutes: the interval of the source data (1 for 1m data, 60 for 1H data).
// Uses binary search (O(log n)) instead of filter (O(n)) for performance.
export function aggregateCandlesPartial(
  candles: CandleData[],
  targetMinutes: number,
  upToTimestamp: string,
  sourceMinutes: number = 1
): CandleData[] {
  if (candles.length === 0) return [];
  const upToMs = new Date(upToTimestamp).getTime();

  // Binary search for the last candle <= upToMs (candles are sorted by timestamp)
  let lo = 0, hi = candles.length - 1, cutoff = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = new Date(candles[mid].timestamp).getTime();
    if (t <= upToMs) { cutoff = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (cutoff < 0) return [];

  // If source data is already at or larger than target resolution, just slice
  if (sourceMinutes >= targetMinutes) return candles.slice(0, cutoff + 1);

  // Source is finer resolution, aggregate up to target
  const bucketMs = targetMinutes * 60_000;
  const filtered = candles.slice(0, cutoff + 1);
  const buckets = new Map<number, CandleData>();

  for (const c of filtered) {
    const t = new Date(c.timestamp).getTime();
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        timestamp: new Date(bucket).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume ?? 0
      });
    } else {
      existing.high = Math.max(Number(existing.high), Number(c.high));
      existing.low = Math.min(Number(existing.low), Number(c.low));
      existing.close = Number(c.close);
      existing.volume = (existing.volume ?? 0) + (c.volume ?? 0);
    }
  }

  return Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]).map(([_, v]) => v);
}

// Aggregate raw ticks into N-tick candles.
// Each candle is formed from exactly N consecutive trades.
// Groups from the END backwards to ensure stable bucket boundaries;
// if grouped from index 0, every new tick would shift all historical candle shapes.
export function aggregateTickCandles(ticks: CandleData[], ticksPerCandle: number): CandleData[] {
  if (ticksPerCandle <= 1 || ticks.length === 0) return ticks;
  const candles: CandleData[] = [];
  const remainder = ticks.length % ticksPerCandle;

  let i = 0;
  while (i < ticks.length) {
    const chunkSize = (i === 0 && remainder > 0) ? remainder : ticksPerCandle;
    const group = ticks.slice(i, i + chunkSize);

    if (group.length > 0) {
      const open = group[0].open;
      const close = group[group.length - 1].close;
      let high = -Infinity;
      let low = Infinity;
      let vol = 0;

      for (const t of group) {
        if (t.high > high) high = t.high;
        if (t.low < low) low = t.low;
        vol += (t.volume ?? 0);
      }

      candles.push({
        timestamp: group[group.length - 1].timestamp,
        open, high, low, close,
        volume: vol || undefined,
      });
    }
    i += chunkSize;
  }
  return candles;
}

// Aggregate raw ticks into time-based candles (for second timeframes: 1s, 5s, 10s, 30s).
// Each candle covers a fixed time window of `seconds` length.
export function aggregateTicksByTime(ticks: CandleData[], seconds: number): CandleData[] {
  if (ticks.length === 0) return [];
  const bucketMs = seconds * 1000;
  const candles: CandleData[] = [];
  let bucketStart = Math.floor(new Date(ticks[0].timestamp).getTime() / bucketMs) * bucketMs;
  let open = ticks[0].open;
  let high = ticks[0].high;
  let low = ticks[0].low;
  let close = ticks[0].close;
  let vol = ticks[0].volume ?? 0;

  for (let i = 1; i < ticks.length; i++) {
    const t = new Date(ticks[i].timestamp).getTime();
    const thisBucket = Math.floor(t / bucketMs) * bucketMs;

    if (thisBucket !== bucketStart) {
      candles.push({
        timestamp: new Date(bucketStart).toISOString(),
        open, high, low, close,
        volume: vol || undefined,
      });
      bucketStart = thisBucket;
      open = ticks[i].open;
      high = ticks[i].high;
      low = ticks[i].low;
      close = ticks[i].close;
      vol = ticks[i].volume ?? 0;
    } else {
      if (ticks[i].high > high) high = ticks[i].high;
      if (ticks[i].low < low) low = ticks[i].low;
      close = ticks[i].close;
      vol += (ticks[i].volume ?? 0);
    }
  }
  candles.push({
    timestamp: new Date(bucketStart).toISOString(),
    open, high, low, close,
    volume: vol || undefined,
  });
  return candles;
}

// Drop candles whose timestamp falls outside the symbol's market hours.
// Uses isMarketOpenForPair() so each MIC gets its correct schedule
// (XNYS 09:30-16:00 ET, XLON 08:00-16:30 London, XTKS with lunch break, etc.).
// Crypto/forex pass through unchanged.
//
// Skipped for tfMinutes >= 240 (4h, 1d, 1w, 1M): those HTF buckets are
// epoch-aligned to UTC (project-wide bucketing convention), so their
// timestamps don't map cleanly to local market open boundaries. A daily
// candle stamped at UTC midnight would be 19:00/20:00 ET the previous day
// and the timestamp test would delete every daily bar.
// Memoization layer: isMarketOpenForPair(pair, ts) is a pure function of static
// data (market schedules + holiday tables baked into the bundle). The result
// for a given (pair, timestamp) never changes within a session, so we cache
// it per-pair, keyed by the parsed UTC ms. Filling 10k candles becomes 10k
// timezone calculations the first time and ~10k Map lookups thereafter, so
// re-renders triggered by other state changes (live tick, TF flip back to a
// previously-viewed value) don't redo the work.
//
// Layer paired with the arithmetic ET helpers in marketHours.ts: with those
// in place the first computation is also cheap (~2µs per candle vs. ~300µs
// when going through Intl.DateTimeFormat on iOS Safari), so even cold-cache
// filtering of 10k candles finishes in ~20ms.
const _marketOpenCache = new Map<string, Map<number, boolean>>();

export function filterMarketHoursCandles(
  candles: CandleData[],
  pair: string,
  tfMinutes: number
): CandleData[] {
  if (tfMinutes >= 240) return candles;
  let pairCache = _marketOpenCache.get(pair);
  if (!pairCache) {
    pairCache = new Map();
    _marketOpenCache.set(pair, pairCache);
  }
  return candles.filter((c) => {
    const ms = typeof c.timestamp === 'number' ? c.timestamp : Date.parse(c.timestamp);
    const cached = pairCache!.get(ms);
    if (cached !== undefined) return cached;
    const result = isMarketOpenForPair(pair, c.timestamp);
    pairCache!.set(ms, result);
    return result;
  });
}

// Merge two sorted candle arrays by timestamp. Used for WS reconnect catch-up
// where we fetch 50 latest candles from DB and merge them into the existing state,
// updating any overlapping timestamps with fresh data.
export function mergeCandles(existing: CandleData[], incoming: CandleData[]): CandleData[] {
  const map = new Map<string, CandleData>();
  for (const c of existing) map.set(c.timestamp, c);
  for (const c of incoming) map.set(c.timestamp, c);
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

// ─── Candle Fetcher (local engine) ─────────────────────────────────────────────

// Fetch candle rows from the terminal's local engine.
//
// Upstream this hit a remote table-per-symbol backend; here it delegates to
// localEngine, which translates the table name into the engine's single
// /api/candles call. The row shape ({timestamp, open, high, low, close,
// volume} with ISO-Z timestamps) is unchanged so every caller and the merge
// path behave exactly as before.
//
// Time windows matter here: the manual backtester's replay load asks for the
// full range "25,000 minutes before the session start onward" with a limit far
// above the engine's 5,000-per-request cap. A single capped request would
// silently truncate the replay to its first few days, so windowed fetches
// paginate: newest-first pages anchored by an `end` cursor, walked backward
// until the window's start (or the caller's limit) is reached. Every provider
// implements "end + limit = the newest N bars at or before end", which is the
// only semantic this loop relies on.
const ENGINE_PAGE_LIMIT = 5000;

export async function fetchWindowedCandles(
  tableName: string,
  options: { gte?: string; gt?: string; lte?: string; limit?: number; order?: 'asc' | 'desc' }
): Promise<any[]> {
  const floor = options.gte ?? options.gt;
  const want = options.limit ?? ENGINE_PAGE_LIMIT;

  if (!floor && want <= ENGINE_PAGE_LIMIT) {
    return fetchLocalCandles(tableName, {
      limit: want,
      order: options.order,
      end: options.lte,
    });
  }

  const merged: CandleData[] = [];
  if (floor) {
    // Forward pagination: oldest N from the window start, exactly upstream's
    // order=asc + limit semantics. Providers return the oldest page when a
    // start anchor is present, so the cursor is the newest bar seen so far.
    let cursor: string | undefined = floor;
    // Hard stop well above any real request (50k limit / 5k pages = 10) so a
    // provider that ignores the window can never loop forever.
    for (let i = 0; i < 32 && merged.length < want; i++) {
      const rows = await fetchLocalCandles(tableName, {
        limit: ENGINE_PAGE_LIMIT,
        order: 'asc',
        start: cursor,
        end: options.lte,
      });
      // The inclusive start filter re-returns the cursor bar itself on every
      // page after the first; drop it to guarantee progress.
      const page = i === 0
        ? rows.filter((r) => (options.gte ? r.timestamp >= options.gte : r.timestamp > (options.gt as string)))
        : rows.filter((r) => r.timestamp > cursor!);
      if (!page.length) break;
      merged.push(...page);
      cursor = page[page.length - 1].timestamp;
      if (rows.length < ENGINE_PAGE_LIMIT) break;
    }
  } else {
    // No window start: walk backward from the newest bar (or lte) until the
    // caller's limit is met.
    const pages: CandleData[][] = [];
    let cursor = options.lte;
    let total = 0;
    for (let i = 0; i < 32 && total < want; i++) {
      const rows = await fetchLocalCandles(tableName, {
        limit: ENGINE_PAGE_LIMIT,
        order: 'asc',
        end: cursor,
      });
      // First page: inclusive of the lte bound, or a backtest anchored exactly
      // on a bar open silently lost that bar. Later pages: strictly older than
      // the oldest bar already taken, to guarantee progress.
      const page = cursor
        ? rows.filter((r) => (i === 0 ? r.timestamp <= cursor! : r.timestamp < cursor!))
        : rows;
      if (!page.length) break;
      pages.push(page);
      total += page.length;
      cursor = page[0].timestamp;
    }
    pages.reverse();
    merged.push(...pages.flat());
  }

  const bounded = merged.length > want
    ? (floor ? merged.slice(0, want) : merged.slice(-want))
    : merged;
  return options.order === 'desc' ? [...bounded].reverse() : bounded;
}

// ─── HTF Table Mapping ─────────────────────────────────────────────────────────

// Returns the pre-aggregated HTF table name for a given timeframe in minutes.
// Returns null for custom timeframes that need RPC aggregation instead.
// The FX/CFD source uses separate higher-timeframe tables of its own.
export function getHTFTableName(
  tfMinutes: number,
  dataSource: 'default' | 'oanda'
): string | null {
  const htfTableMap: Record<number, string> = dataSource === 'oanda' ? {
    5: 'oanda_candles_5m',
    15: 'oanda_candles_15m',
    30: 'oanda_candles_15m',  // 30m aggregated from 15m
    60: 'oanda_candles_1h',
    240: 'oanda_candles_4h',
  } : {
    // x_candles_* tables: the canonical HTF tables driven by the instrument catalog
    5: 'x_candles_5m',
    15: 'x_candles_15m',
    30: 'x_candles_15m',  // 30m aggregated from 15m (no separate x_candles_30m table)
    60: 'x_candles_1h',
    240: 'x_candles_4h',
  };
  return htfTableMap[tfMinutes] || null;
}

// Returns the daily HTF table name based on data source.
export function getDailyTableName(
  dataSource: 'default' | 'oanda'
): string {
  // x_candles_1d: canonical daily candle table for the default source
  return dataSource === 'oanda' ? 'oanda_candles_1d' : 'x_candles_1d';
}

// ─── FX/CFD HTF Fetcher ────────────────────────────────────────────────────────

// Generic FX/CFD HTF fetcher: queries the FX/CFD source's higher-timeframe tables with a symbol filter.
// Tries multiple symbol variants (BTC/USD, BTCUSD, BTC) to find a match.
export async function fetchOandaHtf(
  table: string,
  pairName: string,
  limit: number
): Promise<CandleData[]> {
  const symbolVariants = buildSymbolVariants(pairName);
  for (const sym of symbolVariants) {
    try {
      const data = await apiGet<any[]>(table, {
        params: { symbol: `eq.${sym}`, order: 'timestamp.desc', limit: limit.toString() }
      });
      if (data && data.length > 0) {
        return mapCandleData(data);
      }
    } catch { /* try next variant */ }
  }
  return [];
}

// ─── Luminance Helper ──────────────────────────────────────────────────────────

// Determines if a hex color is light by checking perceived luminance (ITU-R BT.709).
// Used to pick black or white text based on the actual chart background color,
// not just the page theme. Prevents invisible OHLC text when user picks
// a white background while in dark mode.
export function isLightBackground(hex: string): boolean {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128;
}

// ─── React Hook ────────────────────────────────────────────────────────────────

// Hook that wraps the symbol table map and provides memoized formatters.
// Returns stable references to formatPairForTable and formatPairForSymbol
// that are bound to the current dataSource and table map state.
export function useSymbolFormatters(dataSource: 'default' | 'oanda' | 'ftmo' | 'prop' = 'default') {
  const { getTableName: getTableNameFromMap, isLoaded: tableMapLoaded } = useMarketData();

  const boundFormatPairForTable = useCallback(
    (pairStr: string) => formatPairForTable(pairStr, dataSource, getTableNameFromMap),
    [dataSource, getTableNameFromMap]
  );

  const boundFormatPairForSymbol = useCallback(
    (pairStr: string) => formatPairForSymbol(pairStr),
    []
  );

  return {
    formatPairForTable: boundFormatPairForTable,
    formatPairForSymbol: boundFormatPairForSymbol,
    tableMapLoaded,
    getTableNameFromMap,
  };
}

// ─── Broker-direct candle fetch ────────────────────────────────────────────
// Called from ProCandlestickChart when brokerSelection has a slug, to bypass
// LSE central PostgREST and pull candles straight from the broker's own server.
// Bandwidth then comes from the broker's region, the whole point of the
// broker-direct path. When brokerSelection is null these helpers
// don't run; the chart's existing LSE-central fetch path is unchanged.

// Maps the chart's user-facing timeframe label to the broker's `interval` query
// param. The broker contract's Interval names are UPPERCASE, so these
// strings round-trip directly. Standard buckets (M1..D1) hit the
// per-symbol candles_<tf> tables; sub-minute (S1..S30) and tick (T5..T1000)
// hit the broker-side candles_Ns / candles_Nticks tables.
export const BROKER_INTERVAL_MAP: Record<string, string> = {
  // Sub-minute (second buckets)
  '1s':  'S1',
  '5s':  'S5',
  '10s': 'S10',
  '30s': 'S30',
  // Standard
  '1m':  'M1',
  '5m':  'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1H':  'H1',
  '4H':  'H4',
  '1D':  'D1',
  // Tick-bucket
  '5tick':    'T5',
  '10tick':   'T10',
  '100tick':  'T100',
  '1000tick': 'T1000',
};

// Convert chart `pair` (e.g. "BTCUSD") to the broker's `symbol` query param.
// Broker-side symbols are stored as entered by the broker; the endpoint
// lowercases on read so case is forgiven. Lowercase URL form is the safest
// cross-broker default: the chart never has to know whether a particular
// broker's symbols carry slashes or not.
export function formatPairForBroker(pair: string): string {
  return pair.toLowerCase();
}

// Fetch candles directly from a connected broker's /candles endpoint.
// Wire shape:
//   GET https://<broker>/api/runtime/candles
//       ?symbol=btcusd&interval=M5&from=ISO&to=ISO
//   -> [{symbol, interval, bar_start, open, high, low, close, volume,
//        is_closed}, ...]
// `bar_start` is ISO-Z; numeric fields arrive as NUMERIC strings, so we
// Number() them here for parity with mapCandleData().
export async function fetchBrokerCandles(
  httpsBase: string,
  symbol: string,
  brokerInterval: string,
  fromIso: string,
  toIso: string,
): Promise<CandleData[]> {
  const url = new URL(`${httpsBase}/candles`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', brokerInterval);
  url.searchParams.set('from', fromIso);
  url.searchParams.set('to', toIso);
  const res = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`broker /candles failed: ${res.status} ${res.statusText}`);
  }
  const rows: Array<{
    bar_start: string;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number | null;
  }> = await res.json();
  return rows.map(r => ({
    timestamp: r.bar_start,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: r.volume == null ? undefined : Number(r.volume),
  }));
}
