/* LSE Terminal v0.2 UI: dynamic indicators, multi-pane rendering, chart
   types, OHLC legend. Vanilla JS on purpose; the richer React workspace
   replaces this later, speaking to exactly the same /api endpoints. */

const TF_SECONDS = { "1s": 1, "30s": 30,
                     "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
                     "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
// A tick chart appends one bar per trade; big liquid pairs print ~24/s, so
// without a cap a day-open session would grow the array into millions of
// bars and the canvas repaint would die long before the memory did.
const TICK_MAX_BARS = 20000;
const MAX_STREAM_SYMBOLS = 16; // free-plan concurrent stream allowance
const OVERLAY_PALETTE = ["#8b8b93", "#c9c9cf", "#6e6e76", "#a8a8b3"];
const PANE_PALETTE = ["#a1a1aa", "#7dd3fc", "#fbbf24", "#f0abfc"];

// Exact legacy spellings verified against the LSE symbol registry.
// These supply display metadata only; data reads, stars and broker orders
// keep the requested spelling. Never guess across asset classes (GOLD is a share).
const LSE_SAVED_SYMBOLS = Object.freeze({
  "ES.F": "SP500.F", "NQ.F": "NASDAQ100.F", "GC.F": "GOLD.F",
  "SI.F": "SILVER.F", "VIX/USD": "VIX.IDX",
});
function catalogInstrument(symbol, bySymbol) {
  const lookup = (name) => bySymbol
    ? bySymbol.get(name) : state.instruments.find((item) => item.symbol === name);
  const exact = lookup(symbol);
  if (exact || state.provider !== "lse") return exact;
  const canonical = LSE_SAVED_SYMBOLS[symbol];
  const item = canonical && lookup(canonical);
  return item ? { ...item, symbol } : undefined;
}

const state = {
  // The active rail tab decides the provider: MARKETS = "lse" (live data,
  // needs the free API key), BACKTEST / MY DATA = "userdata" (imported
  // files). There is no user-facing source dropdown.
  provider: null, providers: [], lseConfigured: false, indicatorSpecs: [],
  groupsOpen: {},                  // sidebar folders the user expanded
  groupShown: {},                  // rows revealed so far per opened folder
  hosted: false,                   // hosted web terminal: no local subprocesses
  symbol: null, timeframe: "1h", chartType: "candles",
  activeIndicators: [],            // [{name}] params use registry defaults
  favoriteIndicators: [],          // registry names starred in the picker; float to the top
  instruments: [], ws: null, lastBar: null, prices: {}, quotes: {}, priceTimes: {}, candleData: [],
  logos: {},                       // symbol -> {light, dark} watchlist logo URLs
  // Starred instruments per SOURCE: provider name ->
  // [symbol]. A broker's list is its own (its symbol space, its catalog),
  // the LSE source has its own; the WATCHLIST group at the top of the
  // sidebar shows the active source's list. Persisted in the workspace
  // "shell" section with the rest of the shell's session state.
  watchlists: {},
  // The LSE logo map, fetched once per session for the trade ticket. The
  // ticket can trade a symbol the active source has no art for (source =
  // the connected broker, whose provider has no logos()), and lse-sim +
  // the hosted relay speak the LSE symbol space, so the LSE map is the
  // right fallback there. null = not fetched yet.
  logoFallback: null,
};

/* Hosted-vs-local base path: the same bundle serves the local app (at "/")
   and the site terminal (behind "/terminal/"). Every API call in this file
   uses an absolute "/api/..." literal, so ONE wrapper rebases them all onto
   the directory this page was served from; nothing else needs to know. */
const APP_BASE = location.pathname.replace(/\/[^/]*$/, "/");
const API_PREFIX = APP_BASE === "/" ? "" : APP_BASE.replace(/\/$/, "");
{
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (url, opts) =>
    nativeFetch(typeof url === "string" && url.startsWith("/api/")
      ? API_PREFIX + url : url, opts);
}

const $ = (id) => document.getElementById(id);
// Words from elsewhere (an engine's detail, an exception, a listing's line,
// an installer's output) as one line, whole: runs of spaces, tabs and line
// breaks read as one space. Where a layout needs a cut, the element cuts it
// with a visible "…" and keeps the whole as its tooltip; the words are not
// cut here.
function oneLine(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

/* A key box (an LSE key, a broker's secret) that no browser offers to save
   or fill. A password box is what a browser's password manager takes for a
   login, and autocomplete="off" does not stop it: with Chrome's manager on,
   a broker's row was offered for saving and its login email kept in
   Chrome's store. So the box is a text box, masked by -webkit-text-security
   (the stylesheet's .cs-secret) where the browser has it: Chromium, which is
   the desktop app, Chrome and Edge. A browser without it gets a password box
   back, so what is typed is never shown (its own manager may then offer to
   save, as before). No name; the ignore marks password manager extensions
   read; copy and cut of what it holds are refused, as a password box
   refuses them; a paste is taken. The input, for chaining. */
function csSecretBox(inp) {
  const masked = typeof CSS !== "undefined" && !!CSS.supports && CSS.supports("-webkit-text-security", "disc");
  inp.type = masked ? "text" : "password";
  inp.autocomplete = "off";
  inp.spellcheck = false;
  inp.classList.add("cs-secret");
  inp.dataset.secret = "1";
  inp.setAttribute("autocapitalize", "off");
  inp.setAttribute("autocorrect", "off");
  inp.setAttribute("data-1p-ignore", "");
  inp.setAttribute("data-lpignore", "true");
  inp.setAttribute("data-bwignore", "");
  inp.setAttribute("data-form-type", "other");
  for (const t of ["copy", "cut", "dragstart"]) inp.addEventListener(t, (e) => e.preventDefault());
  return inp;
}
let statusMessage = "", pricePollError = "";
function paintStatus() { $("status").textContent = [statusMessage, pricePollError].filter(Boolean).join(" · "); }
const status = (msg) => { statusMessage = msg; paintStatus(); };
function setPricePollError(message) { pricePollError = message; paintStatus(); }
const fmt = (p, by = p) => by >= 1000 ? p.toFixed(1) : by >= 10 ? p.toFixed(2) : p.toFixed(4);
// Spread readout under each watchlist price: FX rows in
// pips ("spread: 0.1 pips"), everything else in price units, because a pip
// is an FX unit. Two significant digits covers the non-FX universe without
// a per-class table; parseFloat strips the exponent form toPrecision emits.
const fmtSpread = (d) => !isFinite(d) || d <= 0 ? "" : d >= 1 ? d.toFixed(2) : parseFloat(d.toPrecision(2)).toString();
// Native decimal places seen per symbol, running max. The feed snaps every
// price/ask to the pair's native grid, so this converges to the true count
// within a few ticks; the pip is the second-to-last native decimal (the
// market convention: 0.0001 on 5-decimal pairs, 0.01 on 3-decimal JPY
// quotes). Before enough ticks land, the price-magnitude floor (>=20 means
// a JPY-style 3-decimal quote) keeps the first readouts sane.
const decOf = (x) => { const s = String(x); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; };
function pipSize(symbol, refPrice) {
  const seen = (state.pipDec || {})[symbol] || 0;
  const dec = Math.max(seen, refPrice >= 20 ? 3 : 5);
  return Math.pow(10, -(dec - 1));
}
// A venue's own price, printed with the `digits` its catalog declares for the
// instrument (a whole number from 0 to 20; anything else is 0) cut to what a
// price of its size can use: max(2, 6 - floor(log10(size))) places, about
// seven significant figures and at least two, so fewer than two only when
// fewer are declared. The size is |scale| when a finite, non-zero `scale` is
// given, else |value|; a size of 0 keeps `digits`.
// The sidebar, the spread, the dock and History pass the instrument's current
// max(bid, ask) (quoteScale), as the ticket does, so one instrument's prices
// share their places: "9999.80" beside "10000.10". No zero is trimmed
// ("1.28080"); nine declared places of a coin at 73100.5 print "73100.50".
// The same rule, and the same size, as the chart's formatPriceForSymbol, which
// is handed this instrument's max(bid, ask) too, so a declared instrument's
// chart labels and these print the same places beside a power of ten. "" for a
// value that is missing or not a finite number; plain
// decimals (toFixed turns to the exponent form only from 1e21). Display only:
// nothing an order SENDS passes through here.
function fmtPx(value, digits, scale) {
  const n = Number(value);
  if (value == null || value === "" || !isFinite(n)) return "";
  const d = Math.min(20, Math.max(0, Math.trunc(Number(digits)) || 0));
  const by = Math.abs(scale != null && isFinite(Number(scale)) && Number(scale) !== 0 ? Number(scale) : n);
  const fits = by > 0 && isFinite(by) ? Math.max(2, 6 - Math.floor(Math.log10(by))) : d;
  return n.toFixed(Math.min(d, fits));
}
// The decimals the active SOURCE declares for one of its instruments, or null
// when it declares none (LSE and imported files: their rows carry no digits
// and their prices keep the magnitude rule in fmt). Filled by loadInstruments.
function srcDigits(symbol) {
  const d = (state.digitsBySym || {})[symbol];
  return Number.isInteger(d) && d >= 0 && d <= 20 ? d : null;
}
// The size one instrument's prices choose their places by: its quote's larger
// side, max(|bid|, |ask|), as the ticket's three numbers use; undefined with no
// usable quote, when each value is its own size (fmt, fmtPx). Near a power of
// ten a bid and an ask chose different places, and so did one tick and the
// next: "9999.800" beside "10000.10".
function quoteScale(q) {
  if (!q || typeof q !== "object") return undefined;
  const sides = [q.bid, q.ask].map(Number).filter((v) => isFinite(v) && v !== 0).map(Math.abs);
  return sides.length ? Math.max(...sides) : undefined;
}
// A price of the active source, for the sidebar: from the instrument's digits
// when the source declares them, by magnitude otherwise, at the places its
// current quote's size gives (quoteScale). fmt alone printed a venue's
// 0.0000189 as "0.0000".
function fmtQuote(symbol, p) {
  const d = srcDigits(symbol);
  const by = quoteScale((state.quotes || {})[symbol]);
  return d == null ? fmt(p, by) : fmtPx(p, d, by);
}
// A level read off the chart (the right-click menu's "@ price"): the same
// digits, but no more decimals than five significant figures need, because
// the level comes from a pixel and nine decimals of it are noise.
function fmtLevel(symbol, p) {
  const d = srcDigits(symbol);
  if (d == null || !(Math.abs(p) > 0) || !isFinite(p)) return fmt(p);
  const need = Math.max(2, 5 - Math.floor(Math.log10(Math.abs(p))));
  return fmtPx(p, Math.min(d, need));
}
function spreadText(symbol, q) {
  if (!q || !(q.ask > q.bid)) return "";
  const d = q.ask - q.bid;
  if (((state.catBySym || {})[symbol] || "") === "forex") {
    const p = d / pipSize(symbol, q.bid);
    return `spread: ${p >= 10 ? Math.round(p) : p.toFixed(1)} pips`;
  }
  // In the instrument's own decimals when the source declares them, at its
  // prices' places (quoteScale): two significant digits of a 0.00000002
  // spread printed "2e-8".
  const dg = srcDigits(symbol);
  const by = quoteScale(q);
  const t = dg == null ? fmtSpread(d) : (Number(fmtPx(d, dg, by)) > 0 ? fmtPx(d, dg, by) : "");
  return t ? `spread: ${t}` : "";
}

/* ---------- launch price cache ---------- */

/* Last-known watchlist prices persist in localStorage so a fresh launch
   paints numbers immediately instead of dashes for the first catalog-load +
   board-poll round trip.
   Cached rows carry .stale (dimmed) until the first live update replaces
   them, so a terminal opened after a weekend never passes Friday's close
   off as a live quote. Keyed per provider: LSE prices must not bleed into
   a custom vendor's board after a source switch. */
const priceCacheKey = () => `lset-prices-${state.provider}`;
function loadPriceCache() {
  state.priceTimes = {}; // only newly received source times can establish monotonicity
  state.quotes = {};
  state.staleFromCache = new Set();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(priceCacheKey())); } catch (e) { /* corrupt entry */ }
  if (!saved || typeof saved !== "object") return;
  for (const [sym, v] of Object.entries(saved.prices || {})) {
    if (state.prices[sym] === undefined && typeof v === "number" && isFinite(v)) {
      state.prices[sym] = v;
      state.staleFromCache.add(sym);
    }
  }
  for (const [sym, q] of Object.entries(saved.quotes || {})) {
    if (!state.quotes[sym] && q && q.ask >= q.bid) {
      state.quotes[sym] = { ...q, ts: saved.source_times === true ? sourcePriceTime(q.ts) : null };
    }
  }
}
let priceCacheSavedAt = 0;
function savePriceCache() {
  // Throttled to one write per 5s: the board polls and ticks
  // stream constantly; serialising 4k symbols on each would be pure waste.
  const now = Date.now();
  if (now - priceCacheSavedAt < 5000) return;
  priceCacheSavedAt = now;
  try {
    localStorage.setItem(priceCacheKey(),
      JSON.stringify({ prices: state.prices, quotes: state.quotes, source_times: true }));
  } catch (e) { /* quota or private mode; the cache is best-effort */ }
}

/* ---------- chart palette ---------- */

// Shell theme vars (style.css). Read at call time, not module time, so
// anything built after a theme flip picks up the right palette.
const themeVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

// Kept for the backtest equity curve, which is still a lightweight-charts
// instance. The price chart is the ported LSE engine (see pushToChart).
const chartOpts = () => ({
  layout: { background: { color: themeVar("--bg", "#212121") },
            textColor: themeVar("--dim", "#8b8e94"),
            attributionLogo: false },
  grid: { vertLines: { color: themeVar("--hover", "#1a1c1f") },
          horzLines: { color: themeVar("--hover", "#1a1c1f") } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: themeVar("--edge", "#26282c") },
  rightPriceScale: { borderColor: themeVar("--edge", "#26282c") },
  crosshair: { mode: 0 },
  autoSize: true,
});

/* ---------- data loading ---------- */

function indicatorQuery() {
  // "sma:length=50,rsi:length=14" - the engine's _parse_indicators format
  // (params ; separated). No params = registry defaults, same as before.
  return state.activeIndicators.map((i) => {
    const ps = Object.entries(i.params || {});
    return i.name + (ps.length ? ":" + ps.map(([k, v]) => `${k}=${v}`).join(";") : "");
  }).join(",");
}

/* The shell's own session state (active indicators + chart type), persisted
   in the workspace "shell" section so a restart reopens the chart exactly as
   left. Small and whole-object, so a plain debounced PUT is enough. */
let shellSaveTimer = null;
function saveShellState() {
  if (shellSaveTimer) clearTimeout(shellSaveTimer);
  shellSaveTimer = setTimeout(() => {
    shellSaveTimer = null;
    // The PUT replaces the whole section, so a save that fires before the
    // widget list has loaded (rwSetup's fetch is in flight at boot) would
    // silently wipe the stored railWidgets. Re-arm and wait instead; the
    // load is an engine-local read, so this settles within a tick or two.
    if (typeof rw !== "undefined" && rw && !rw.loaded) { saveShellState(); return; }
    fetch("/api/workspace/shell", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeIndicators: state.activeIndicators,
        favoriteIndicators: state.favoriteIndicators,
        chartType: state.chartType,
        watchlists: state.watchlists,
        // Rail widget stack. Rides the shell section
        // rather than a section of its own: SECTIONS is frozen into the
        // desktop engine, so a new name would 404 on every frozen build.
        railWidgets: (typeof rw !== "undefined" && rw) ? rw.list : [],
      }),
    }).catch(() => { /* session state; next change retries */ });
  }, 500);
}

/* ---------- the chart ---------- */

// The chart is the ported LSE engine: same canvas draw loop, drawing overlay,
// crosshair and indicator registry as the live charts. The lightweight-charts
// objects above still back the backtest equity curve; they no longer draw the
// price chart.

/* The chart area's own word. What it says when it has no bars to draw: a
   candle request that failed (the source's own message and a Retry), a
   source that answered with no bars, or the next load in flight after
   either. One opaque element over the chart (#chart-note), so nothing of the
   previous instrument shows beneath it. Every word a source supplied is set
   as text, never as markup. */
const chartNoteState = { kind: "", detail: "", symbol: "", timeframe: "",
                         source: "", watching: false };

// A source's name as the page shows it elsewhere (a broker's row label, such as
// "<Broker> (paper trading)").
function chartSourceName(name) {
  const p = (state.providers || []).find((x) => x.name === name);
  return String((p && p.title) || String(name || "").replace(/^broker:/, "") || "the source");
}

// The reason a candle request failed, in the source's own words. The engine
// leads with "candles failed: " (the note's first line already says that) and
// a broker's connector leads with its protocol code word ("internal: ..."),
// which is machine vocabulary (see tpbPlainReason); what is left is the
// sentence the source wrote. A bare status code means it wrote none.
function chartFailReason(detail) {
  let t = String(detail == null ? "" : detail).replace(/^candles failed:\s*/, "").trim();
  if (typeof tpbPlainReason === "function") t = tpbPlainReason(t);
  if (/^\d{3}$/.test(t)) return `The engine answered ${t} and gave no reason.`;
  return t || "No reason was given.";
}

// What the note reads for each state. Pure, so it can be checked on its own.
function chartNoteText(n) {
  const what = `${n.symbol} (${n.timeframe})`;
  if (n.kind === "fail") {
    return { title: `Could not load ${what} from ${n.source}`,
             detail: chartFailReason(n.detail), retry: true };
  }
  if (n.kind === "empty") {
    return { title: `${n.source} returned no candles for ${what}`,
             detail: "", retry: true };
  }
  return { title: `Loading ${what}…`, detail: "", retry: false };
}

function chartNotePaint() {
  const el = $("chart-note");
  if (!el) return;
  const n = chartNoteState;
  // The multi-chart layouts draw panes that fetch their own bars; the note
  // speaks for the single chart only, and must not cover the panes.
  const ls = window.LSEChart && window.LSEChart.layoutStore;
  const st = ls && ls.get ? ls.get() : null;
  const single = !st || st.layout === "1x1";
  el.textContent = "";
  el.dataset.kind = n.kind;
  el.classList.toggle("hidden", !n.kind || !single);
  // The chart keeps controls of its own floating over its canvas (the zoom
  // strip, the corner buttons). With no bars they act on nothing, and they
  // stack above this note, so the mount is hidden for as long as the note is
  // up. Hidden, not removed: it keeps its size and nothing re-measures.
  const wrap = $("chart-wrap");
  if (wrap) wrap.classList.toggle("noted", !!n.kind && single);
  if (!n.kind) return;
  const t = chartNoteText(n);
  const line = (cls, text) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    el.appendChild(d);
  };
  line("cn-title", t.title);
  if (t.detail) line("cn-detail", t.detail);
  if (t.retry) {
    const b = document.createElement("button");
    b.id = "chart-retry";
    b.type = "button";
    b.textContent = "Retry";
    b.onclick = () => loadChart();
    el.appendChild(b);
  }
}

// kind: "fail" (detail = what the engine answered), "empty", "loading", or
// "" to take the note away.
function chartNote(kind, detail) {
  const n = chartNoteState;
  n.kind = kind || "";
  n.detail = detail == null ? "" : String(detail);
  n.symbol = state.symbol;
  n.timeframe = state.timeframe;
  n.source = chartSourceName(state.provider);
  const ls = window.LSEChart && window.LSEChart.layoutStore;
  if (ls && ls.subscribe && !n.watching) {
    n.watching = true;
    ls.subscribe(chartNotePaint);   // follow a switch into or out of multi-chart
  }
  chartNotePaint();
}

// A note left by the last load (a failure, an empty answer) is about THAT
// load. While a reload of the SAME chart is in flight (Retry, an indicator
// added) the chart area says so instead of showing the old reason. No note,
// nothing to say: such a reload keeps its own bars until the new ones land.
// (Another instrument or timeframe always gets the loading note: loadChart.)
function chartNoteLoading() {
  if (chartNoteState.kind) chartNote("loading", "");
}

/* A broker's first page is often short. Its adapter answers within its time
   with the newest bars it has and goes on reading older ones, so the same
   request a few seconds later returns more. For a broker source only, a page
   shorter than the one asked for is asked for again about 8 s and about 25 s
   after it was drawn, while the count keeps growing: at most those two
   re-asks per chart load, and none once a re-ask brings no more than before.

   What the user is looking at must not move. A chart nobody has touched is
   still following its newest bar, and redrawing it with older bars in front
   keeps its zoom and keeps those newest bars where they are. A chart the
   user has moved or zoomed holds its place by bar NUMBER, and this build of
   the chart cannot be told that bars were added in front of it: a redraw
   would throw the view back by exactly that many bars. So for a chart that
   has been touched (a drag, a wheel, a drawing begun) the longer page is
   held, a small button says how many older bars have arrived, and pressing
   it draws them, with the view back on the newest bars. */
const CHART_REASK_MS = [8000, 25000];
const chartGrow = { timer: null, held: null, shown: 0, touched: false,
                    series: "", listening: false, watching: false };

function chartGrowTouched() { chartGrow.touched = true; }

// The button, as the state says: only while a longer page is held, and only
// over the single chart (the multi-chart panes are not this chart).
function chartGrowPaint() {
  const el = $("chart-more");
  if (!el) return;
  const more = chartGrow.held ? chartGrow.held.candles.length - chartGrow.shown : 0;
  const ls = window.LSEChart && window.LSEChart.layoutStore;
  const st = ls && ls.get ? ls.get() : null;
  const show = more > 0 && (!st || st.layout === "1x1");
  el.classList.toggle("hidden", !show);
  if (!show) return;
  el.textContent = `${more.toLocaleString("en-US")} older bar${more === 1 ? " has" : "s have"} arrived · Show`;
  el.title = "Draws them, with the chart back on its newest bars. " +
    "They were not drawn by themselves because you have moved or zoomed the chart.";
  el.onclick = chartGrowShow;
}

// Draw a page the venue sent for the chart on screen, in place of the
// shorter one. Same shape as loadChart's own (which stays self-contained).
function chartGrowApply(data) {
  // The bar the stream is forming (onTick) is newer than every closed bar a
  // venue sends: keep it, or each re-ask would wipe the live bar and start it
  // again from the next tick. A page that ends with that same bar still
  // forming (the engine builds it from the venue's closed minutes) gives its
  // open; the stream's latest price in it stays its close, so the price never
  // steps back to the last closed minute's. Once that bar is closed, the
  // venue's own wins.
  const forming = state.lastBar;
  state.candleData = (data.candles || []).map(([t, o, h, l, c, v]) =>
    ({ time: t, open: o, high: h, low: l, close: c, volume: v }));
  chartGrow.shown = state.candleData.length;
  const last = state.candleData[state.candleData.length - 1];
  if (forming && last && forming.time > last.time) state.candleData.push(forming);
  else if (forming && last && forming.time === last.time
           && Date.now() / 1000 < last.time + (TF_SECONDS[state.timeframe] || 3600)) {
    const px = state.prices[state.symbol];
    const ticked = px != null && (state.priceTimes[state.symbol] || 0) >= last.time * 1000;
    state.candleData[state.candleData.length - 1] = { ...last,
      close: ticked ? px : last.close,
      high: Math.max(last.high, forming.high, ticked ? px : -Infinity),
      low: Math.min(last.low, forming.low, ticked ? px : Infinity) };
  }
  state.engineIndicators = data.indicators || {};
  state.lastBar = state.candleData[state.candleData.length - 1] || null;
  chartGrow.held = null;
  pushToChart();
  chartGrowPaint();
}

// The button: draw the held page. The chart is mounted afresh, the way
// applying a saved layout does, so it comes back following its newest bars
// instead of sitting that many bars in the past.
function chartGrowShow() {
  const data = chartGrow.held;
  if (!data) return;
  if (state.chartMounted && window.LSEChart && window.LSEChart.unmount) {
    window.LSEChart.unmount();
    state.chartMounted = false;
  }
  chartGrow.touched = false;
  chartGrowApply(data);
}

// A chart load starts: whatever the last one was waiting for is over. The
// "touched" mark belongs to an instrument at a timeframe, which is exactly
// when the chart goes back to following its newest bar by itself.
function chartGrowStop() {
  clearTimeout(chartGrow.timer);
  chartGrow.timer = null;
  chartGrow.held = null;
  const series = `${state.symbol}|${state.timeframe}`;
  if (series !== chartGrow.series) {
    chartGrow.series = series;
    chartGrow.touched = false;
  }
  chartGrowPaint();
}

// A load's bars are drawn: `got` of the `asked` the request named. seq and
// want are that load's own; url is its request, asked again unchanged.
function chartGrowWatch(seq, want, url, asked, got) {
  const host = $("chart-pro");
  if (host && host.addEventListener && !chartGrow.listening) {
    chartGrow.listening = true;
    for (const ev of ["pointerdown", "wheel", "touchstart"]) {
      host.addEventListener(ev, chartGrowTouched, { capture: true, passive: true });
    }
  }
  const ls = window.LSEChart && window.LSEChart.layoutStore;
  if (ls && ls.subscribe && !chartGrow.watching) {
    chartGrow.watching = true;
    ls.subscribe(chartGrowPaint);
  }
  // One wait at a time: a watch never runs beside an earlier one.
  clearTimeout(chartGrow.timer);
  chartGrow.timer = null;
  chartGrow.held = null;
  chartGrow.shown = got;
  chartGrowPaint();
  if (!isBrokerSource(state.provider) || got >= asked) return;
  const drawnAt = Date.now();
  const again = (n, had) => {
    chartGrow.timer = setTimeout(async () => {
      chartGrow.timer = null;
      // Another instrument, timeframe or source, or a reload: not this chart.
      if (seq !== state.loadSeq || state.candleKey !== want) return;
      let data = null;
      try {
        const res = await fetch(url);
        if (res.ok) data = await res.json();
      } catch (e) { data = null; }
      if (seq !== state.loadSeq || state.candleKey !== want) return;
      const now = data && Array.isArray(data.candles) ? data.candles.length : 0;
      // No more than before (or no answer): the venue has sent what it has.
      if (now <= had) return;
      if (chartGrow.touched) {
        chartGrow.held = data;
        chartGrowPaint();
      } else {
        chartGrowApply(data);
      }
      if (n + 1 < CHART_REASK_MS.length && now < asked) again(n + 1, now);
    }, Math.max(0, drawnAt + CHART_REASK_MS[n] - Date.now()));
  };
  again(0, got);
}

// The decimals the active source declares for its instruments (a broker's
// catalog, loadInstruments), for the chart's axis, OHLC line, price tag and
// position labels, whose formatter otherwise guesses from a symbol's
// spelling (a pair spelt EUR_USD printed as a share, to two places). The
// whole map, once each time it changes; null when the chart has it already.
// Sent with the source they came from (`priceSource`, chartDigitsSource):
// the chart keeps them by source, so a chart of another source never prints
// with them.
function chartDigitsPayload() {
  if (state.chartDigitsVer === state.digitsVer) return null;
  state.chartDigitsVer = state.digitsVer;
  return { ...(state.digitsBySym || {}) };
}

function chartDigitsSource() {
  return state.digitsSource || state.provider;
}

// The same, sent on its own: the instruments can land after the bars.
function chartPushDigits() {
  if (!window.LSEChart || !state.chartMounted) return;
  const digits = chartDigitsPayload();
  if (digits) window.LSEChart.update({ priceDigits: digits, priceSource: chartDigitsSource() });
}

function pushToChart() {
  if (!window.LSEChart || !state.candleData) return;
  // Bars that arrive by another road end a failure note: the tick tape
  // builds from live trades even after its history request failed.
  if (state.candleData.length && chartNoteState.kind
      && chartNoteState.kind !== "loading") chartNote("", "");
  const payload = {
    provider: state.provider,
    symbol: state.symbol,
    timeframe: state.timeframe,
    candles: state.candleData,
    chartType: state.chartType,
    trades: state.trades || [],
    engineIndicators: state.engineIndicators || {},
    quote: state.quotes[state.symbol] || null,
  };
  const digits = chartDigitsPayload();
  if (digits) {
    payload.priceDigits = digits;
    payload.priceSource = chartDigitsSource();
  }
  if (!state.chartMounted) {
    window.LSEChart.mount($("chart-pro"), payload);
    state.chartMounted = true;
  } else {
    window.LSEChart.update(payload);
  }
}

function activeGridSymbol() {
  // In a multi-chart layout the SELECTED pane's pair drives the title and
  // receives symbol picks (no name overlays on the panes,
  // the top-left title names whichever graph is selected). Null in single
  // -chart mode, when symbol-sync makes every pane follow the main pair, or
  // before the chart bundle is up.
  const ls = window.LSEChart && window.LSEChart.layoutStore;
  if (!ls) return null;
  const st = ls.get();
  if (!st || st.layout === "1x1") return null;
  if (st.sync && st.sync.syncSymbol) return null;
  return st.panelSymbols[st.activePanel] || state.symbol;
}

function updateWindowTitle() {
  // The native title bar mirrors the open chart:
  // pair + timeframe instead of the bare app name. Electron forwards
  // document.title to the OS title bar; browser tabs get it for free.
  // The instrument's display name rides between symbol and timeframe,
  // same source as the sidebar labels.
  const shown = activeGridSymbol() || state.symbol;
  if (!shown) return;   // pre-login / pre-instrument state: keep the app name
  const inst = catalogInstrument(shown);
  document.title = `${shown}${inst && inst.name ? " · " + inst.name : ""} ${state.timeframe} · LSE Terminal`;
  // The assistant's hero names the charted symbol + timeframe too.
  aiPanelRefreshEmpty();
}

function recoverUnavailableSymbol(detail) {
  // Only a confirmed missing-history response retires a saved selection.
  // Aliases absent from today's live catalogue still work through the API.
  if (state.provider !== "lse" || !/\[404\].*has no candle data/i.test(String(detail))) return false;
  const old = state.symbol;
  const fallback = state.instruments.find((item) => item.symbol !== old);
  if (!fallback) return false;
  state.symbol = fallback.symbol;
  state.watchlists.lse = (state.watchlists.lse || []).filter((symbol) => symbol !== old);
  saveShellState();
  renderWatchlist();
  if (typeof tpbFollowChart === "function") tpbFollowChart(state.symbol);
  connectStream();
  return true;
}

async function loadChart() {
  if (!state.provider || !state.symbol) return;
  // Sequence the loads: rapid symbol/timeframe switches can finish out of
  // order, and a slow older response landing last would paint the previous
  // instrument's candles under the new title. Only the newest load may win.
  const seq = (state.loadSeq = (state.loadSeq || 0) + 1);
  // What this load is for, to compare with what the bars in hand are of.
  const want = `${state.provider}|${state.symbol}|${state.timeframe}`;
  updateWindowTitle();
  // trade ticket header follows the symbol immediately, not on the next tick
  if (typeof tpxUpdateQuote === "function") try { tpxUpdateQuote(); } catch (e) { /* panel absent */ }
  // Level 3 button appears/disappears with the instrument (only the recorded
  // futures universe has order-by-order data)
  if (typeof l3SyncButton === "function") try { l3SyncButton(); } catch (e) { /* rail absent */ }
  status(`loading ${state.symbol}…`);
  // Whatever the last load was still waiting for (a re-ask of a short page,
  // bars held behind the button) is over.
  if (typeof chartGrowStop === "function") chartGrowStop();
  if (state.candleKey !== want) {
    // Another instrument, timeframe or source. A broker can take seconds to
    // answer, and for those seconds the ticket, the dock and the title were
    // on the NEW instrument over the OLD one's candles and prices. The old
    // bars leave at once, and with them what the tick handler builds on
    // (state.lastBar), so no tick of the new instrument is drawn onto the old
    // one's last bar; the chart area says what is loading until it is drawn.
    state.candleData = [];
    state.engineIndicators = {};
    state.lastBar = null;
    state.candleKey = "";
    // Only a chart that is up has bars to take off. (Mounting it here, empty,
    // would put its first render ahead of the load that used to start it.)
    if (state.chartMounted) pushToChart();
    if (typeof chartNote === "function") chartNote("loading", "");
  } else if (typeof chartNoteLoading === "function") {
    // The same chart again (Retry, an indicator added): its bars are right
    // and stay. A note the last load left is about that load.
    chartNoteLoading();
  }
  // 5000 = the engine's per-request cap: open with one full page of history
  // so deep scrollback starts loaded instead of paging immediately.
  const url = `/api/candles?provider=${encodeURIComponent(state.provider)}` +
    `&symbol=${encodeURIComponent(state.symbol)}&timeframe=${state.timeframe}` +
    `&limit=5000&indicators=${encodeURIComponent(indicatorQuery())}`;
  // A fetch that throws (the engine is not answering) is a failed load like
  // any other. Uncaught, it left "loading X…" in the header for good.
  let res = null, down = "";
  try { res = await fetch(url); } catch (e) { down = String((e && e.message) || e); }
  if (seq !== state.loadSeq) return; // superseded while in flight
  if (!res || !res.ok) {
    let detail = res ? res.status : `the Terminal's engine did not answer (${down})`;
    if (res) try { detail = (await res.json()).detail || detail; } catch (e) { /* keep status */ }
    if (seq !== state.loadSeq) return; // a delayed failure cannot replace a newer selection
    if (recoverUnavailableSymbol(detail)) return loadChart();
    if (seq === state.loadSeq) {
      status(`error: ${detail}`);
      // One failure is not the source's: the engine answers 400 when an
      // INDICATOR could not be computed over bars the source did return. If
      // the bars in hand are this very chart's (an indicator was just added
      // or edited), they are still right and stay; the header says why.
      if (res && res.status === 400 && state.candleKey === want) return;
      // Otherwise the bars in hand belong to whatever loaded last: another
      // instrument, or this one before the source failed. They leave the
      // screen, and the tick path with them: onTick builds on state.lastBar,
      // so left in place the next tick of the NEW symbol was drawn onto the
      // OLD symbol's last bar.
      state.candleData = [];
      state.engineIndicators = {};
      state.lastBar = null;
      state.candleKey = "";
      pushToChart();
      // And the chart area says why, in the source's words, with a Retry:
      // one line in the header over a blank chart told nobody what to do.
      if (typeof chartNote === "function") chartNote("fail", detail);
    }
    return;
  }
  const data = await res.json();
  if (seq !== state.loadSeq) return; // superseded while parsing

  // Volume is carried on the candle now: the pro engine renders its own volume
  // pane from this field, where the classic view uses a separate series.
  state.candleData = (data.candles || []).map(([t, o, h, l, c, v]) =>
    ({ time: t, open: o, high: h, low: l, close: c, volume: v }));
  // Python-computed indicators (built-ins and the user's own) ride along and
  // are drawn by the chart as precomputed series.
  state.engineIndicators = data.indicators || {};
  state.candleKey = want;
  pushToChart();
  state.lastBar = state.candleData[state.candleData.length - 1] || null;
  // However many bars came back is what the source has now. A page shorter
  // than the 5000 asked for is an honest answer and is drawn as it is. Only
  // NO bars at all gets a word in the chart area, and not on the tick tape,
  // which starts empty on a quiet symbol by design.
  if (typeof chartNote === "function") {
    chartNote(!state.candleData.length && state.timeframe !== "tick" ? "empty" : "", "");
  }
  // A broker may still be reading older bars: its short page is asked for
  // again, twice at most (chartGrowWatch). No other source is asked again.
  if (typeof chartGrowWatch === "function") {
    chartGrowWatch(seq, want, url, 5000, state.candleData.length);
  }
  // No symbol/timeframe readout in the chrome: the window title stays plain
  // "LSE Terminal" and the topline status only carries transient loading and
  // error messages (classic pro-terminal quiet top bar).
  status(state.provider === "lse" && state.timeframe === "tick" ? "Live ticks · history starts when connected" : "");
}

/* ---------- live stream + price board poll ---------- */

/* Division of labor (replaced the viewport-rotation websocket):
   the WEBSOCKET streams ONLY the charted symbol (it needs tick-level updates
   to build the live candle and the trade ticket's quote). The WATCHLIST is
   fed by a budgeted 3s poll of the platform price board (/api/prices -> data-api
   /v1/prices -> latest ticks), so every visible row prices on
   the next poll no matter how many pairs are open; no per-row stream slots,
   no 16-symbol plan-cap fight. */
function visibleWatchSymbols() {
  const list = $("watchlist");
  if (!list || !list.offsetParent) return []; // watchlist hidden on this tab
  const box = list.getBoundingClientRect();
  const out = [];
  // .wrow[data-symbol] exists only for live-source rows; MY DATA's tree
  // rows use .tree-row, so userdata mode naturally contributes nothing.
  // data-live="0" rows are history-only datasets: polling them burns plan
  // quota on symbols the board can never have.
  for (const row of list.querySelectorAll('.wrow[data-symbol]:not([data-live="0"])')) {
    const r = row.getBoundingClientRect();
    if (r.bottom >= box.top && r.top <= box.bottom) out.push(row.dataset.symbol);
  }
  return out;
}

// Store source time in milliseconds for quote-age consumers. Old local cache
// timestamps are untrusted: previous releases stamped receipt time there.
function sourcePriceTime(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0
    ? (value < 1e12 ? value * 1000 : value) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
function acceptPriceTime(symbol, time) {
  const previous = state.priceTimes[symbol];
  if (previous != null && (time == null || time < previous)) return false;
  if (time != null) state.priceTimes[symbol] = time;
  return true;
}

/* Paint one board row into the watchlist. Skips the charted symbol: its
   websocket ticks are fresher and repainting a 1s-old poll price over them
   would make the row flicker backwards. */
function paintBoardPrice(r) {
  if (!r || r.price == null || r.symbol === state.symbol) return;
  const time = sourcePriceTime(r.ts);
  if (!acceptPriceTime(r.symbol, time)) return;
  const prev = state.prices[r.symbol];
  state.prices[r.symbol] = r.price;
  if (r.bid != null && r.ask != null && r.ask >= r.bid) {
    // Stamped: a quote for a closed market can be hours old, and the agent
    // states it as current unless the age travels with it (a blind read
    // could only say "as old as this turn").
    state.quotes[r.symbol] = { bid: r.bid, ask: r.ask, ts: time };
  } else delete state.quotes[r.symbol];
  if (state.staleFromCache) state.staleFromCache.delete(r.symbol);
  // Every row of that symbol: a starred instrument sits in WATCHLIST and in
  // its own folder at once, and both must read the same price.
  for (const cell of document.querySelectorAll(`.wrow[data-symbol="${CSS.escape(r.symbol)}"] .wprice`)) {
    cell.textContent = fmtQuote(r.symbol, r.price);
    cell.classList.remove("stale"); // live now; drop the cached-price dimming
    cell.classList.toggle("up", prev !== undefined && r.price >= prev);
    cell.classList.toggle("down", prev !== undefined && r.price < prev);
    const q = state.quotes[r.symbol];
    const sc = cell.parentElement.querySelector(".wspread");
    if (sc && q) sc.textContent = spreadText(r.symbol, q);
  }
}

const PRICE_POLL_INTERVAL_MS = 3000;
let pricePollBusy = false, pricePollNextAt = 0, pricePollTimer = null;
let pricePollProvider = state.provider, pricePollKeyGeneration = 0;
const pricePollBudgets = new Map();
function syncPricePollBudget() {
  if (pricePollProvider === state.provider) return;
  pricePollBudgets.set(pricePollProvider, { nextAt: pricePollNextAt, error: pricePollError });
  if (pricePollTimer !== null) { clearTimeout(pricePollTimer); pricePollTimer = null; }
  pricePollProvider = state.provider;
  const budget = pricePollBudgets.get(pricePollProvider);
  pricePollNextAt = budget ? budget.nextAt : 0;
  setPricePollError(budget ? budget.error : "");
}
function resetPricePollKey() {
  pricePollKeyGeneration++;
  pricePollBudgets.delete("lse");
  if (pricePollProvider === "lse") {
    pricePollNextAt = 0; setPricePollError("");
    if (pricePollTimer !== null) { clearTimeout(pricePollTimer); pricePollTimer = null; }
  }
}

/* One price budget for the whole terminal, however many windows are open
   and whoever asks. The plan counts calls to the price board per key, not
   per window: a second window with a watchlist, the rail's QUOTES card and
   a dashboard widget would each have added their own calls on top of the
   watchlist's 20 a minute (the demo broker's adapter takes 30 of a free
   key's 60). So there is one gate per source, kept where every window of
   this terminal reads it, and one call at a time behind it:
   - the gate is the time before which no window asks that source again
     (three seconds after the last call; a 429's wait when the board says so);
   - the window that asks carries what the others want (told over a
     BroadcastChannel when they find the gate closed) and what widgets asked
     for, in the same call, and passes the rows on, so every window is
     priced by one call, not one each;
   - a Web Lock keeps two windows from asking in the same instant.
   A browser without these (and the tests' bare context) is one window with
   its own budget, as before. */
const PRICE_GATE_KEY = "lset-price-gate:";
const PRICE_WANT_MS = 10000;      // how long a told or asked symbol stays wanted
const PRICE_FRESH_MS = 5000;      // a row this new answers a widget without a call
function priceGateWait(provider) {
  try {
    if (typeof localStorage === "undefined") return 0;
    const wait = (Number(localStorage.getItem(PRICE_GATE_KEY + provider)) || 0) - Date.now();
    // further off than the longest back-off (120 s) is a changed clock, not a wait
    return wait > 0 && wait <= 125000 ? wait : 0;
  } catch (e) { return 0; }
}
function priceGateSet(provider, ms) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PRICE_GATE_KEY + provider, String(Date.now() + ms));
    }
  } catch (e) { /* storage disabled: this window's own budget still holds */ }
}

// want: source -> Map(symbol -> wanted until), asked by a widget here or
// told by another window. rows: "source\nsymbol" -> {row, at}.
const priceDesk = { want: new Map(), rows: new Map(), waiting: [], chan: null, pump: null };
function priceDeskWant(provider, symbols, ms) {
  let m = priceDesk.want.get(provider);
  if (!m) { m = new Map(); priceDesk.want.set(provider, m); }
  const until = Date.now() + (ms || PRICE_WANT_MS);
  for (const s of symbols) if (s && typeof s === "string") m.set(s, until);
}
function priceDeskWanted(provider) {
  const m = priceDesk.want.get(provider);
  if (!m) return [];
  const now = Date.now();
  for (const [s, until] of m) if (until < now) m.delete(s);
  return [...m.keys()];
}
function priceDeskChannel() {
  if (priceDesk.chan !== null) return priceDesk.chan;
  priceDesk.chan = false;
  try {
    if (typeof BroadcastChannel === "undefined") return false;
    const ch = new BroadcastChannel("lset-prices");
    ch.onmessage = (m) => {
      const d = m && m.data;
      if (!d || typeof d.provider !== "string") return;
      if (d.t === "want" && Array.isArray(d.symbols)) {
        priceDeskWant(d.provider, d.symbols.slice(0, 50));
      } else if (d.t === "rows" && Array.isArray(d.rows)) {
        // another window asked: its rows price this window too
        if (d.provider === state.provider) {
          for (const row of d.rows) paintBoardPrice(row);
        }
        priceDeskFeed(d.provider, d.rows, true);
      }
    };
    priceDesk.chan = ch;
  } catch (e) { /* no channel: each window keeps to the shared gate alone */ }
  return priceDesk.chan;
}
function priceDeskTell(provider, symbols) {
  const ch = priceDeskChannel();
  if (ch && symbols.length) {
    try { ch.postMessage({ t: "want", provider, symbols: symbols.slice(0, 50) }); } catch (e) {}
  }
}
function priceDeskFeed(provider, rows, fromOtherWindow) {
  const now = Date.now();
  for (const row of rows) {
    if (row && typeof row.symbol === "string") {
      priceDesk.rows.set(provider + "\n" + row.symbol, { row, at: now });
    }
  }
  if (!fromOtherWindow) {
    const ch = priceDeskChannel();
    if (ch) { try { ch.postMessage({ t: "rows", provider, rows }); } catch (e) {} }
  }
  // whoever waits on this source looks again (the board answers only the
  // symbols it has, so a waiter is released by the call, not by its rows)
  const waiting = priceDesk.waiting;
  priceDesk.waiting = [];
  for (const w of waiting) {
    if (w.provider === provider) w.done(); else priceDesk.waiting.push(w);
  }
}

/* Prices for symbols outside the watchlist (a dashboard widget, the rail's
   QUOTES card): answered from the last call when it is fresh, otherwise
   added to the next call any window makes and waited for. Never a call of
   its own outside the gate. Resolves to the rows the board has (a symbol
   it does not know is simply absent), or null when no call got through. */
async function priceDeskPrices(provider, symbols, maxAgeMs) {
  const want = [...new Set(symbols.filter((s) => s && typeof s === "string"))].slice(0, 50);
  if (!want.length) return [];
  const age = maxAgeMs == null ? PRICE_FRESH_MS : maxAgeMs;
  const have = () => want.map((s) => priceDesk.rows.get(provider + "\n" + s));
  const fresh = () => have().every((e) => e && Date.now() - e.at <= age);
  let fed = fresh();
  if (!fed) {
    priceDeskWant(provider, want);
    priceDeskTell(provider, want);
    priceDeskPump(provider);
    fed = await new Promise((resolve) => {
      const w = { provider, done: () => { clearTimeout(t); resolve(true); } };
      const t = setTimeout(() => {
        priceDesk.waiting = priceDesk.waiting.filter((x) => x !== w);
        resolve(false);
      }, 15000);
      priceDesk.waiting.push(w);
    });
  }
  const rows = have().filter(Boolean).map((e) => e.row);
  return fed || rows.length ? rows : null;
}

/* The call itself: one source, the symbols given, behind the shared gate
   and the lock. Answers {rows} on success, {status, retry} when the board
   refused, null when another window is asking this moment or the gate
   closed meanwhile (its rows arrive over the channel). */
async function priceBoardAsk(provider, symbols) {
  const ask = async () => {
    priceGateSet(provider, PRICE_POLL_INTERVAL_MS);
    const res = await fetch(`/api/prices?provider=${encodeURIComponent(provider)}` +
      `&symbols=${encodeURIComponent(symbols.slice(0, 50).join(","))}`);
    const body = await res.json(); // consume errors as well as successful rows
    if (!res.ok) {
      let retry = 0;
      if (res.status === 429) {
        retry = Math.max(3, Math.min(120, Number(res.headers.get("Retry-After")) || 60));
        priceGateSet(provider, retry * 1000); // every window waits it out
      }
      return { status: res.status, retry };
    }
    return { rows: Array.isArray(body) ? body : [] };
  };
  const locks = typeof navigator !== "undefined" && navigator.locks;
  if (!locks || !locks.request) return ask();
  return locks.request("lset-price-poll:" + provider, { ifAvailable: true }, async (lock) => {
    if (!lock || priceGateWait(provider) > 0) return null;
    return ask();
  });
}

/* Asked symbols that no watchlist poll of this window will carry (the
   watchlist is off screen, or shows another source): the desk asks for
   them itself, at the gate, until nobody wants them. */
function priceDeskPump(provider) {
  if (priceDesk.pump !== null) return;
  const tick = async () => {
    priceDesk.pump = null;
    const want = priceDeskWanted(provider);
    if (!want.length) return;
    const carried = provider === state.provider && !document.hidden &&
      visibleWatchSymbols().some((s) => s !== state.symbol);
    const wait = priceGateWait(provider);
    if (!carried && !pricePollBusy && wait <= 0) {
      try {
        const out = await priceBoardAsk(provider, want);
        if (out && out.rows) priceDeskFeed(provider, out.rows, false);
      } catch (e) { /* the next tick asks again */ }
    }
    if (priceDeskWanted(provider).length && priceDesk.pump === null) {
      priceDesk.pump = setTimeout(tick, Math.max(500, priceGateWait(provider)));
    }
  };
  priceDesk.pump = setTimeout(tick, 0);
}

async function pollPrices() {
  syncPricePollBudget();
  if (document.hidden || pricePollBusy) return;
  const shared = priceGateWait(state.provider);
  const wait = Math.max(pricePollNextAt - performance.now(), shared);
  if (wait > 0) {
    // Another window asked last: tell it what this one shows, so its next
    // call prices these rows too.
    if (shared > 0) {
      priceDeskTell(state.provider, visibleWatchSymbols().filter((s) => s !== state.symbol));
    }
    // Render/scroll primes and the interval share one trailing attempt.
    if (pricePollTimer === null) pricePollTimer = setTimeout(() => {
      pricePollTimer = null; pollPrices();
    }, wait);
    return;
  }
  const syms = visibleWatchSymbols().filter((s) => s !== state.symbol);
  if (!syms.length) return;
  if (pricePollTimer !== null) { clearTimeout(pricePollTimer); pricePollTimer = null; }
  pricePollBusy = true;
  pricePollNextAt = performance.now() + PRICE_POLL_INTERVAL_MS;
  const provider = state.provider, prices = state.prices, keyGeneration = pricePollKeyGeneration;
  const current = () => state.provider === provider && state.prices === prices &&
    (provider !== "lse" || pricePollKeyGeneration === keyGeneration);
  const showError = (message) => {
    if (!current()) return;
    setPricePollError(message);
  };
  try {
    // This window's rows first; then what widgets and other windows asked for.
    const asked = [...new Set([...syms, ...priceDeskWanted(provider)])];
    const out = await priceBoardAsk(provider, asked);
    if (!out || !current()) return;
    if (!out.rows) {
      if (out.status === 429) {
        pricePollNextAt = performance.now() + out.retry * 1000;
        showError(`Watchlist price limit reached; retrying in ${out.retry}s`);
      } else showError("Watchlist prices unavailable; retrying");
      return;
    }
    for (const row of out.rows) paintBoardPrice(row);
    priceDeskFeed(provider, out.rows, false);
    savePriceCache();
    setPricePollError("");
  } catch (e) { showError("Watchlist prices unavailable; retrying"); }
  finally { pricePollBusy = false; }
}

function connectStream() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  const syms = [state.symbol].filter(Boolean);
  if (!syms.length) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}/api/ws` +
    `?provider=${encodeURIComponent(state.provider)}&symbols=${encodeURIComponent(syms.join(","))}`);
  ws.onmessage = (ev) => {
    // Ticks queued on a replaced stream (old provider/symbol set) must not
    // paint prices or extend candles after the switch.
    if (state.ws !== ws) return;
    const m = JSON.parse(ev.data);
    if (m.type === "error") {
      // "does not stream" is a capability, not a fault; stay quiet.
      if (!/does not stream/i.test(m.message || "")) status(`stream: ${m.message}`);
      return;
    }
    if (m.type === "tick") onTick(m);
  };
  ws.onclose = () => { if (state.ws === ws) state.ws = null; };
  state.ws = ws;
}

function onTick(t) {
  const time = sourcePriceTime(t.ts);
  if (!acceptPriceTime(t.symbol, time)) return;
  const prev = state.prices[t.symbol];
  state.prices[t.symbol] = t.price;
  if (state.staleFromCache) state.staleFromCache.delete(t.symbol);
  // Bid/ask ride every tick when the provider has them (real, or inferred
  // for quote-less LSE classes); the chart draws them as MT5-style lines.
  if (t.bid != null && t.ask != null && t.ask >= t.bid) {
    state.quotes[t.symbol] = { bid: t.bid, ask: t.ask, ts: time,
                               synthetic: !!t.quote_synthetic };
    state.pipDec = state.pipDec || {};
    state.pipDec[t.symbol] = Math.max(state.pipDec[t.symbol] || 0, decOf(t.price), decOf(t.ask));
    // live ticket prices (trade panel defines this later in the file; function
    // declarations hoist, and ticks only flow long after load)
    if (t.symbol === state.symbol && typeof tpxUpdateQuote === "function") tpxUpdateQuote();
  } else delete state.quotes[t.symbol];
  savePriceCache(); // persist price, quote and source time from this same row
  // (No tick fan-out to the multi-grid panes from here: the
  // TerminalMultiGrid panes fetch their own tails every 10s, so there is
  // nothing for the shell to fan.)
  // All rows of the symbol (WATCHLIST + its folder), same as paintBoardPrice.
  for (const cell of document.querySelectorAll(`.wrow[data-symbol="${CSS.escape(t.symbol)}"] .wprice`)) {
    cell.textContent = fmtQuote(t.symbol, t.price);
    cell.classList.remove("stale");
    cell.classList.toggle("up", prev !== undefined && t.price >= prev);
    cell.classList.toggle("down", prev !== undefined && t.price < prev);
    const q = state.quotes[t.symbol];
    const sc = cell.parentElement.querySelector(".wspread");
    if (sc && q) sc.textContent = spreadText(t.symbol, q);
  }
  if (t.symbol !== state.symbol) return;
  if (state.timeframe === "tick") {
    // No lastBar guard here: a quiet symbol can open with an EMPTY tick
    // history (nothing in the replay window), and the tape must still
    // start printing from the first live trade.
    // One bar per trade, no bucketing; history from the replay endpoint has
    // the same shape (o=h=l=c=price), so the tape stays visually continuous.
    const bar = { time: Math.floor(t.ts || Date.now() / 1000),
                  open: t.price, high: t.price, low: t.price, close: t.price };
    if (state.lastBar && bar.time < state.lastBar.time) return;
    state.candleData.push(bar);
    if (state.candleData.length > TICK_MAX_BARS) {
      state.candleData = state.candleData.slice(-TICK_MAX_BARS);
    }
    state.lastBar = bar;
    state.candleData = state.candleData.slice();
    pushToChart();
    return;
  }
  if (!state.lastBar) return;
  const step = TF_SECONDS[state.timeframe] || 3600;
  const bucket = Math.floor((t.ts || Date.now() / 1000) / step) * step;
  let bar = state.lastBar;
  // A cached last quote can predate the loaded candle tail.
  if (bucket < bar.time) return;
  if (bucket > bar.time) {
    bar = { time: bucket, open: t.price, high: t.price, low: t.price, close: t.price };
    state.candleData.push(bar);
  } else {
    bar = { ...bar, close: t.price,
            high: Math.max(bar.high, t.price), low: Math.min(bar.low, t.price) };
    state.candleData[state.candleData.length - 1] = bar;
  }
  state.lastBar = bar;
  // Replace the array identity so the chart's props compare as changed and
  // the new/updated bar actually repaints.
  state.candleData = state.candleData.slice();
  pushToChart();
}

/* ---------- indicator picker ---------- */

// Chip label: title plus the params that differ from spec defaults, so
// "SMA 50" reads at a glance while an untouched RSI stays just "RSI".
function paramSummary(item, spec) {
  if (!spec || !item.params) return "";
  const shown = Object.entries(item.params)
    .filter(([k, v]) => spec.params[k] && String(spec.params[k].default) !== String(v))
    .map(([, v]) => v);
  return shown.length ? " " + shown.join("/") : "";
}

function renderActiveIndicators() {
  const wrap = $("ind-active");
  wrap.innerHTML = "";
  for (const item of state.activeIndicators) {
    const spec = state.indicatorSpecs.find((s) => s.name === item.name);
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.title = "Customise " + (spec ? spec.title : item.name);
    chip.textContent = (spec ? spec.title : item.name) + paramSummary(item, spec);
    chip.onclick = () => openIndicatorConfig(item, chip);
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = (e) => {
      e.stopPropagation();
      state.activeIndicators = state.activeIndicators.filter((i) => i !== item);
      renderActiveIndicators();
      loadChart();
      saveShellState();
    };
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
}

/* ---------- indicator browser + parameter editor ---------- */

function positionPanel(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.min(r.left, window.innerWidth - panel.offsetWidth - 8) + "px";
  panel.style.top = (r.bottom + 6) + "px";
}

function closeIndPanels() {
  $("ind-panel").classList.add("hidden");
  $("ind-cfg").classList.add("hidden");
}

function renderIndicatorList() {
  const q = $("ind-search").value.trim().toLowerCase();
  const list = $("ind-list");
  list.innerHTML = "";
  // Starred indicators float to the top; the sort is stable, so both groups
  // keep the registry's alphabetical order inside themselves.
  const favs = new Set(state.favoriteIndicators);
  const specs = [...state.indicatorSpecs]
    .sort((a, b) => Number(favs.has(b.name)) - Number(favs.has(a.name)));
  let pastFavs = false;
  for (const s of specs) {
    if (q && !(s.title.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))) continue;
    const isFav = favs.has(s.name);
    // Thin rule between the starred block and the rest, only when both exist.
    if (!isFav && !pastFavs && list.children.length) {
      const sep = document.createElement("div");
      sep.className = "ind-sep";
      list.appendChild(sep);
    }
    if (!isFav) pastFavs = true;
    const active = state.activeIndicators.find((i) => i.name === s.name);
    const row = document.createElement("div");
    row.className = "ind-row" + (active ? " active" : "");
    row.innerHTML =
      `<span class="ind-check">${active ? "&#10003;" : ""}</span>` +
      `<span class="ind-title">${s.title}</span>` +
      `<button class="ind-star${isFav ? " fav" : ""}" title="${isFav ? "Unfavourite" : "Favourite: pins it to the top"}">${isFav ? "&#9733;" : "&#9734;"}</button>` +
      `<span class="ind-tag">${s.overlay ? "overlay" : "pane"}</span>` +
      (active ? `<button class="ind-gear" title="Parameters">&#9998;</button>` : "");
    row.onclick = () => {
      const cur = state.activeIndicators.find((i) => i.name === s.name);
      if (cur) {
        state.activeIndicators = state.activeIndicators.filter((i) => i !== cur);
      } else {
        state.activeIndicators.push({ name: s.name, params: {} });
      }
      renderActiveIndicators();
      renderIndicatorList();
      loadChart();
      saveShellState();
    };
    const gear = row.querySelector(".ind-gear");
    if (gear) gear.onclick = (e) => {
      e.stopPropagation();
      openIndicatorConfig(active, row);
    };
    row.querySelector(".ind-star").onclick = (e) => {
      e.stopPropagation();
      const at = state.favoriteIndicators.indexOf(s.name);
      if (at >= 0) state.favoriteIndicators.splice(at, 1);
      else state.favoriteIndicators.push(s.name);
      renderIndicatorList();
      saveShellState();
    };
    list.appendChild(row);
  }
  if (!list.children.length) {
    list.innerHTML = '<div class="ind-empty">Nothing matches.</div>';
  }
}

// The parameter editor: one input per spec param (already typed and bounded
// by the registry; the engine re-validates on every request).
function openIndicatorConfig(item, anchor) {
  const spec = state.indicatorSpecs.find((s) => s.name === item.name);
  if (!spec || !Object.keys(spec.params || {}).length) {
    status(`${item.name} has no parameters`);
    return;
  }
  const cfg = $("ind-cfg");
  cfg.innerHTML = `<div class="cfg-title">${spec.title}</div>` +
    Object.entries(spec.params).map(([k, p]) => {
      const cur = (item.params && item.params[k] !== undefined) ? item.params[k] : p.default;
      const step = p.type === "int" ? 1 : "any";
      const bounds = `${p.min !== undefined ? `min="${p.min}"` : ""} ${p.max !== undefined ? `max="${p.max}"` : ""}`;
      return `<label class="cfg-row"><span>${k}</span>` +
        `<input type="number" data-param="${k}" value="${cur}" step="${step}" ${bounds}></label>`;
    }).join("") +
    `<div class="modal-row"><button class="modal-ok" id="cfg-apply">Apply</button>` +
    `<button id="cfg-reset">Defaults</button><button id="cfg-close">Close</button></div>`;
  cfg.classList.remove("hidden");
  positionPanel(cfg, anchor);
  $("cfg-apply").onclick = () => {
    const params = {};
    for (const inp of cfg.querySelectorAll("input[data-param]")) {
      const k = inp.dataset.param;
      if (inp.value !== "" && String(spec.params[k].default) !== inp.value) params[k] = inp.value;
    }
    item.params = params;
    cfg.classList.add("hidden");
    renderActiveIndicators();
    loadChart();
    saveShellState();
  };
  $("cfg-reset").onclick = () => {
    for (const inp of cfg.querySelectorAll("input[data-param]")) {
      inp.value = spec.params[inp.dataset.param].default;
    }
  };
  $("cfg-close").onclick = () => cfg.classList.add("hidden");
}

function setupIndicatorPanel() {
  $("ind-open").onclick = (e) => {
    e.stopPropagation();
    const panel = $("ind-panel");
    const opening = panel.classList.contains("hidden");
    closeIndPanels();
    if (!opening) return;
    renderIndicatorList();
    panel.classList.remove("hidden");
    positionPanel(panel, $("ind-open"));
    $("ind-search").focus();
  };
  // The chart's tool rail and settings affordances (React island) have no
  // indicator dialog of their own since the built-in indicator dialog was retired; they
  // raise this event to open the shell's browser instead.
  window.addEventListener("lset:open-indicators", () => {
    // Deferred: the originating click is still bubbling and would hit the
    // click-away closer below, shutting the panel the moment it opened.
    setTimeout(() => {
      const panel = $("ind-panel");
      if (!panel.classList.contains("hidden")) return;
      renderIndicatorList();
      panel.classList.remove("hidden");
      positionPanel(panel, $("ind-open"));
      $("ind-search").focus();
    }, 0);
  });
  $("ind-search").oninput = renderIndicatorList;
  $("ind-create").onclick = () => { closeIndPanels(); openEditor(); };
  // Click-away closes; clicks inside the panels stay.
  document.addEventListener("click", (e) => {
    if (!$("ind-panel").contains(e.target) && !$("ind-cfg").contains(e.target) &&
        e.target !== $("ind-open")) {
      closeIndPanels();
    }
  });
}

/* ---------- watchlist + controls ---------- */

/* Starred instruments of the ACTIVE source (state.watchlists, keyed by
   provider name: "lse", "broker:<id>", ...). Order = order starred. */
const WL_FAV_GROUP = "\u2605watchlist"; // groupsOpen key; cannot collide with a category name
function wlFavs() { return state.watchlists[state.provider] || []; }
function wlIsFav(sym) { return wlFavs().includes(sym); }
function wlToggleFav(sym) {
  const list = wlFavs().slice();
  const i = list.indexOf(sym);
  if (i >= 0) list.splice(i, 1); else list.push(sym);
  state.watchlists[state.provider] = list;
  saveShellState();
  renderWatchlist();
}

/* Text from a data source, made safe to place inside markup. A connected
   broker's catalog is third-party text arriving over a pipe (and with "add
   your own broker" it is text from an adapter anyone may have written), so a
   symbol or an instrument name is never allowed to be parsed as HTML: an
   instrument named `<img onerror=...>` must show as those characters. Every
   template below that prints a source's symbol, name or category goes through
   this, or through textContent. */
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* One sidebar row as markup. `ins` is the instrument as the source sent it;
   `o` carries what the caller worked out (logo address, monogram, price and
   spread text, the row's flags). Nothing from `ins` reaches the string
   unescaped. */
function wlRowHtml(ins, o) {
  const sym = escHtml(ins.symbol);
  const name = escHtml(ins.name);
  return `<span class="wlogo">` +
    (o.logo ? `<img src="${escHtml(o.logo)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
    `<span class="winit">${escHtml(o.initial)}</span></span>` +
    `<span class="wsym" title="${name || sym}">${sym}` +
    (ins.name ? `<span class="wname">${name}</span>` : "") +
    `</span>` +
    (o.hist
      ? `<span class="wpricecol"><span class="whist" ` +
        `title="Historical dataset: chartable, but no live feed">history</span></span>`
      : `<span class="wpricecol">` +
        `<span class="wprice${o.stale ? " stale" : ""}">${escHtml(o.price)}</span>` +
        `<span class="wspread">${escHtml(o.spread)}</span>` +
        `</span>`) +
    `<button class="wstar${o.fav ? " on" : ""}" title="${o.fav ? "Remove from watchlist" : "Add to watchlist"}">` +
    `${o.fav ? "&#9733;" : "&#9734;"}</button>`;
}

/* What the sidebar says when it holds only part of a source's catalog. The
   sidebar asks for a bounded page (5,000 rows); a venue with 13,575
   instruments used to show the first 5,000 after sorting and nothing to say
   the rest existed. `total` is the source's own count when it sent one, else
   0, in which case a page that came back exactly full is called what it is. */
function wlCutNote(shown, total, limit) {
  const n = (x) => Number(x).toLocaleString("en-US");
  if (total > shown) return `showing ${n(shown)} of ${n(total)}; search for the rest`;
  if (!total && limit && shown >= limit) return `showing the first ${n(shown)}; search for the rest`;
  return "";
}

function renderWatchlist() {
  renderConnBar();
  const el = $("watchlist");
  el.innerHTML = "";
  if (state.provider === "userdata") {
    // The user's data always shows as the managed library tree: add,
    // folders, rename, delete, drag; clicking a dataset charts it.
    refreshDatasets().then(renderDataSidebar);
    return;
  }
  if (!state.instruments.length && state.provider === "userdata") {
    el.innerHTML =
      '<div class="empty-actions">' +
      '<div class="md-empty">No data yet.</div>' +
      '<button id="empty-add">Add data</button>' +
      '<button id="empty-folder">New folder</button>' +
      '</div>';
    $("empty-add").onclick = () => {
      $("rail-data").click();
      $("md-file").click(); // native OS file dialog, no intermediate form
    };
    $("empty-folder").onclick = async () => {
      // Inline input row where the folder will appear (VS Code style).
      const name = await treeInlineInput({
        parent: el, folder: true,
      });
      if (!name) return;
      await fetch("/api/data/folders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: name }),
      });
      $("rail-data").click();
    };
    return;
  }
  // Live sources render as collapsible category folders (closed by
  // default). The provider delivers instruments already
  // grouped and ordered (see loadInstruments), so folders emerge from one
  // pass; state.groupsOpen remembers what the user opened until the
  // provider changes.
  const groups = [];
  for (const ins of state.instruments) {
    const cat = ins.category || "Other";
    if (!groups.length || groups[groups.length - 1].cat !== cat) {
      groups.push({ cat, items: [] });
    }
    groups[groups.length - 1].items.push(ins);
  }
  // Logo variant follows the shell theme (html.dark, flipped via reload, so
  // one read per render is safe). Missing/failed art falls back to the
  // monogram tile underneath the <img>; loading="lazy" keeps an opened
  // 3.9k-row stocks folder from firing thousands of image fetches at once.
  const dark = document.documentElement.classList.contains("dark");
  const pendingGrow = [];   // folders with rows still to reveal on scroll
  // One row builder for the WATCHLIST group and the category folders, so a
  // starred instrument looks identical in both places (logo, symbol, name,
  // price, spread) and the star is the only difference: filled on a
  // starred row, shown on hover otherwise. The star's click never charts.
  const wrow = (ins) => {
    const row = document.createElement("div");
    row.className = "wrow" + (ins.symbol === state.symbol ? " active" : "");
    row.dataset.symbol = ins.symbol;
    // live === false: a history-only dataset (chartable archive, no feed).
    // Labeled instead of showing a dash that reads like a broken price,
    // and excluded from the price poll (visibleWatchSymbols).
    const hist = ins.live === false;
    if (hist) row.dataset.live = "0";
    const lg = state.logos[ins.symbol];
    // A cache-seeded price renders dimmed until the first live update
    // (paintBoardPrice/onTick strip the class); no cache and no price
    // keeps the old dash.
    const stale = state.staleFromCache && state.staleFromCache.has(ins.symbol);
    const fav = wlIsFav(ins.symbol);
    // The markup comes from wlRowHtml, which escapes everything the source
    // supplied (symbol, name, logo address): see escHtml.
    row.innerHTML = wlRowHtml(ins, {
      logo: lg ? String(dark ? lg.dark : lg.light) : "",
      initial: logoInitial(ins), hist, stale, fav,
      price: state.prices[ins.symbol] ? fmtQuote(ins.symbol, state.prices[ins.symbol]) : "–",
      spread: spreadText(ins.symbol, state.quotes[ins.symbol]),
    });
    row.onclick = () => setSymbol(ins.symbol);
    row.querySelector(".wstar").onclick = (e) => { e.stopPropagation(); wlToggleFav(ins.symbol); };
    return row;
  };
  // WATCHLIST: the active source's starred instruments, first group in the
  // sidebar, open by default. Verified saved LSE spellings reuse canonical
  // metadata while keeping their own names for charts, quotes and the ticket.
  // Unknown names remain hidden; no instrument metadata is invented.
  {
    const favs = wlFavs();
    const bySym = new Map(state.instruments.map((i) => [i.symbol, i]));
    const items = favs.map((sy) => catalogInstrument(sy, bySym)).filter(Boolean);
    const open = state.groupsOpen[WL_FAV_GROUP] !== false;
    const head = document.createElement("div");
    head.className = "wgroup wgroup-fav";
    head.innerHTML = `<span class="wcaret">${open ? "▾" : "▸"}</span>` +
      `Watchlist<span class="wcount">${items.length}</span>`;
    head.onclick = () => { state.groupsOpen[WL_FAV_GROUP] = !open; renderWatchlist(); };
    el.appendChild(head);
    if (open) for (const ins of items) el.appendChild(wrow(ins));
  }
  // A page of a bigger catalog says so, above the folders it is a page of.
  {
    const note = wlCutNote(state.instruments.length, state.instrumentsTotal || 0,
                           state.provider === "lse" ? 0 : 5000);
    if (note) {
      const n = document.createElement("div");
      n.className = "wnote";
      n.textContent = note;
      el.appendChild(n);
    }
  }
  for (const g of groups) {
    const open = !!state.groupsOpen[g.cat];
    const head = document.createElement("div");
    head.className = "wgroup";
    // the folder name is the source's own category text: escaped
    head.innerHTML = `<span class="wcaret">${open ? "▾" : "▸"}</span>` +
      `${escHtml(g.cat)}<span class="wcount">${g.items.length}</span>`;
    head.onclick = () => {
      state.groupsOpen[g.cat] = !open;
      state.groupShown[g.cat] = WL_CHUNK;   // reopening starts from the top
      renderWatchlist();
    };
    el.appendChild(head);
    if (!open) continue;
    // An opened folder renders in chunks, not whole. Stocks is 3,885 rows:
    // building them all cost ~100ms of scripting plus ~250ms of layout on
    // every render (measured), left ~35k nodes in the sidebar and
    // fired hundreds of logo requests as you scrolled. The next chunk is
    // appended as the scroll approaches it (wlMoreOnScroll), so scrolling
    // behaves exactly as before; only the up-front cost is gone.
    const shownFor = state.groupShown[g.cat] || WL_CHUNK;
    const items = g.items.slice(0, shownFor);
    if (items.length < g.items.length) pendingGrow.push(g.cat);
    for (const ins of items) el.appendChild(wrow(ins));
  }
  wlWireGrow(pendingGrow);
  // Folder opens/closes expose new rows; price them now instead of waiting
  // out the rest of the current poll interval (rects need layout first).
  // The shared minimum-attempt gate coalesces these primes.
  setTimeout(pollPrices, 50);
}

/* Rows per reveal in an opened sidebar folder. 200 covers any screen at the
   26px row height with room to spare, so the reveal always lands before the
   scroll reaches the end of what is rendered. */
const WL_CHUNK = 200;

/* Reveal the next chunk as the sidebar scroll nears the bottom. One listener
   for the whole watchlist (re-armed on each render, since renderWatchlist
   rebuilds the element's children but not the element itself). */
function wlWireGrow(pending) {
  const el = $("watchlist");
  if (el._wlGrowWired) { el._wlPending = pending; return; }
  el._wlGrowWired = true;
  el._wlPending = pending;
  el.addEventListener("scroll", () => {
    const more = el._wlPending || [];
    if (!more.length) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 400) return;
    // Grow every folder still holding rows back; only opened folders can be
    // in the list, and the scroll position survives because renderWatchlist
    // appends to the same element.
    const keep = el.scrollTop;
    for (const cat of more) {
      state.groupShown[cat] = (state.groupShown[cat] || WL_CHUNK) + WL_CHUNK;
    }
    renderWatchlist();
    el.scrollTop = keep;
  });
}

/* MARKETS hosts every LIVE source: LSE plus whatever vendors the user has
   configured with their own keys. Switching and key entry live ONLY in the
   top-left key manager (conn bar): saving a vendor key there flips the whole
   terminal to that vendor's universe. The sidebar deliberately carries no
   source list; a duplicate OTHER SOURCES section was removed. */
function isLiveSource(name) {
  if (name === "lse") return true;
  const p = state.providers.find((x) => x.name === name);
  return !!(p && (p.custom || p.broker));
}

/* A connected broker driving the markets page. Its prices are the ones you
   are executing against, which is exactly why the chart should show them. */
function isBrokerSource(name) {
  return String(name || "").startsWith("broker:");
}

/* What MARKETS's own page (PRICE & CHARTS) shows: the key form, or the
   charts with the ticket and the dock. Without an LSE key it is the key form
   unless the source is one of the user's own, a vendor key or a broker's
   source; with a key, the charts. It is decided from what is known, when the
   tab is clicked and again whenever the source changes while that page is up
   (runSwitchProvider): at boot the tab's click and the source being chosen
   race, and the same page showed the key form on one load and an empty LSE
   chart on the next. */
function marketsWantsKey() {
  const own = !!state.provider && state.provider !== "lse" && isLiveSource(state.provider);
  return !state.lseConfigured && !own;
}

// MARKETS is the tab in use and its own page is the one up (not OPTIONS,
// NEWS or SCREENER under it).
function marketsMainShowing() {
  const rail = $("rail-markets");
  if (!rail || !rail.classList.contains("active")) return false;
  return ["optpage", "scrpage", "news"].every((id) => { const e = $(id); return !e || e.classList.contains("hidden"); });
}

// The decision applied to that page: the key form (with the sidebar's line
// saying why the list is empty) or the charts; the ticket follows (tpx.sync).
function marketsDecide() {
  if (marketsWantsKey()) {
    renderConnBar();
    const wl = $("watchlist");
    if (wl) {
      wl.innerHTML =
        '<div class="empty-actions"><div class="md-empty">' +
        'Live pairs appear here once your LSE API key is connected.</div></div>';
    }
    $("charts").classList.add("hidden");
    $("lse-connect").classList.remove("hidden");
  } else {
    $("lse-connect").classList.add("hidden");
    $("charts").classList.remove("hidden");
  }
  if (typeof tpx !== "undefined" && tpx.sync) tpx.sync();
}

/* With no LSE key, once the ticket has chosen its broker and the engine's
   record has been read (tpbSetup; again after the ticket line's Connect): a
   request out or held there, on any broker, puts MARKETS on the ticket
   broker's own source, so the ticket and its line (the warning, Ask again,
   Connect) are on screen. It sat on a ticket hidden behind the key form
   until the user pressed Use. Nothing held: the key form, as on a first
   run. A source the user chose is kept; a user on another tab is left
   there. */
function marketsBootSource() {
  if (state.hosted || state.lseConfigured || !marketsMainShowing()) return;
  const own = !!state.provider && state.provider !== "lse" && isLiveSource(state.provider);
  if (own && state.provider !== state.marketsBoot) return;
  const held = (tpx.record || []).some((e) => e && (e.state == null || e.state === "out" || e.state === "unknown"));
  if (!held) return;
  const name = tpbSourceName();
  if (!name || name === state.provider) return;
  state.marketsBoot = name;
  enterLiveSource(name);
}

/* The source BACKTESTS and RESEARCH read, which is deliberately not the
   broker. A venue keeps a shallow slice of history next to the LSE archive,
   so following the broker here would silently shrink every backtest to
   whatever that venue happens to retain. Markets follows the broker;
   research stays on the data connection. */
function dataProvider() {
  if (!isBrokerSource(state.provider)) return state.provider;
  return state.lastDataProvider || "lse";
}

async function refreshProviders() {
  state.providers = await fetch("/api/providers").then((r) => r.json());
  // The deleted source can be the active one; fall back to LSE.
  if (!state.providers.some((p) => p.name === state.provider)) {
    await switchProvider("lse");
  }
}

/* Switch the MARKETS surface to a live source. Also correct when the
   connect form is up (keyless user picking their own vendor): the chart
   must replace the form, which a bare switchProvider would leave hidden. */
function enterLiveSource(name) {
  // Remember the last non-broker source, so switching to a venue for
  // execution never costs you the archive that backtests read.
  if (!isBrokerSource(name)) state.lastDataProvider = name;
  state.groupsOpen = {};
  $("lse-connect").classList.add("hidden");
  $("charts").classList.remove("hidden");
  switchProvider(name);
  // The chart surface just came up (or changed source), and the ticket's
  // visibility hangs on exactly that. Without this a user with no LSE key who
  // pressed "Use" on their own broker got its chart and no ticket until they
  // happened to click a rail tab.
  if (typeof tpx !== "undefined" && tpx.sync) tpx.sync();
}

/* ---------- data connection bar (top of the sidebar) ---------- */
/* What feeds the terminal right now, always visible above the watchlist;
   clicking it opens the key manager: change/add the LSE key, jump between
   sources, add or remove bring-your-own-key vendors. */

function activeLiveProvider() {
  if (isLiveSource(state.provider)) {
    return state.providers.find((p) => p.name === state.provider) || null;
  }
  return state.providers.find((p) => p.name === "lse") || null;
}

function renderConnBar() {
  const bar = $("conn-bar");
  if (!bar || bar.classList.contains("hidden")) return;
  const p = activeLiveProvider();
  const isLse = !p || p.name === "lse";
  const connected = isLse ? state.lseConfigured : true; // customs always carry a key
  $("conn-title").textContent = (p && p.title) || "London Strategic Edge";
  // "your LSE key" / "your own key" was saying what the title directly above
  // it already says (the title IS the provider whose key is in use), so the
  // line now states only the fact the title does not carry: whether the feed
  // is live. Sentence case, since this is a statement and not a badge.
  // Both halves name the DATA connection, never a bare "Not connected": the
  // broker sits on the same line, so "Not connected · Paper simulator" read
  // as though the broker were down when only the data key was missing.
  const data = connected ? "Live data" : "No data key";
  // The picked broker rides on the same line as the data source: prices and
  // execution are two connections and the user has to be able to see both
  // without opening anything.
  const brk = activeBrokerLabel();
  $("conn-sub").textContent = brk ? `${data} · ${brk}` : data;
  // The ticket's instrument row is a door to the venue's pair list only while
  // the sidebar is somewhere else; every source switch repaints this bar, so
  // this is where that state is kept honest.
  if (typeof tpbSyncBsymVisibility === "function") tpbSyncBsymVisibility();
}

function activeBrokerLabel() {
  if (typeof tpb === "undefined" || !tpb || tpb.broker === "lse-hosted") return "";
  const row = brokerPicker.rows.find((x) => x.broker === tpb.broker);
  const name = row ? brokerDisplayName(row) : tpb.broker;
  const mode = row ? String(brokerIdentity(row).mode || row.mode || "") : "";
  if (mode !== "live") return name;
  // Real money is named here at all times (SPEC 3), and so is whether this
  // session may send orders to it: a live broker that was connected without
  // that consent is read-only, and the engine refuses its orders.
  return row && row.connected && !row.armed ? `${name} (LIVE, read-only)` : `${name} (LIVE)`;
}

function closeConnMenu() {
  $("conn-menu").classList.add("hidden");
  $("conn-menu").innerHTML = "";
}

/* Save an LSE API key and PROVE it against the live API before trusting it, so
   a typo shows here and not later as an empty watchlist. Shared by the
   conn-menu dropdown and the connection screen so both prove the key the same
   way. Throws with the sentence to show the user; updates shared state on
   success. Callers own their own chrome (which menu to close, what to render). */
async function saveLseKey(key) {
  const r = await fetch("/api/config/lse_key", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!r.ok) throw new Error(`could not save the key (HTTP ${r.status})`);
  resetPricePollKey();
  const probe = await fetch("/api/instruments?provider=lse&query=&limit=1");
  if (!probe.ok) throw new Error("The LSE API rejected this key. Check for typos and try again.");
  state.lseConfigured = true;
  state.providers = await fetch("/api/providers").then((x) => x.json());
  if (typeof l3Init === "function") try { l3Init(); } catch (e) { /* rail absent */ }
  // The ticket's account dock asked for the sim accounts at boot, before any
  // key existed, and showed "sim account unavailable"; nothing re-asked after
  // the key was saved, so the message sat there until an unrelated refresh.
  // Re-ask now that the relay can authenticate.
  if (typeof tpxRefreshAccount === "function") try { tpxRefreshAccount(); tpxRefreshPositions(); } catch (e) { /* ticket absent */ }
}

async function openConnMenu() {
  const menu = $("conn-menu");
  menu.innerHTML = "";
  const head = document.createElement("div");
  head.className = "conn-head";
  head.textContent = "DATA CONNECTIONS";
  menu.appendChild(head);

  // LSE row: status, switch-on-click, inline change-key form.
  const lseRow = document.createElement("div");
  lseRow.className = "conn-row";
  lseRow.innerHTML =
    `<span class="conn-name">London Strategic Edge</span>` +
    `<span class="conn-key">${state.lseConfigured ? "key set" : "no key"}</span>` +
    `<button class="conn-act">${state.lseConfigured ? "Change key" : "Add key"}</button>` +
    (state.lseConfigured ? `<button class="conn-act conn-signout">Sign out</button>` : "");
  menu.appendChild(lseRow);
  // Signing out is total: the key, the live data and the demo account that
  // comes with the key all go together, and the app restarts its view
  // exactly as it boots with no key, so nothing LSE can linger on screen.
  const signout = lseRow.querySelector(".conn-signout");
  if (signout) signout.onclick = async () => {
    signout.disabled = true;
    try { await fetch("/api/config/lse_key", { method: "DELETE" }); } catch (e) { /* offline: reload shows the truth */ }
    location.reload();
  };
  const keyline = document.createElement("div");
  keyline.className = "conn-keyline hidden";
  keyline.innerHTML =
    `<input type="text" class="cs-secret" placeholder="lse_live_..." autocomplete="off" spellcheck="false">` +
    `<button>Save</button>`;
  // a key box no browser offers to save (csSecretBox)
  csSecretBox(keyline.querySelector("input"));
  menu.appendChild(keyline);
  const err = document.createElement("div");
  err.className = "conn-err hidden";
  menu.appendChild(err);

  lseRow.onclick = (e) => {
    if (e.target.closest("button")) return;
    if (state.lseConfigured) { closeConnMenu(); enterLiveSource("lse"); }
  };
  lseRow.querySelector(".conn-act").onclick = () => {
    keyline.classList.toggle("hidden");
    if (!keyline.classList.contains("hidden")) keyline.querySelector("input").focus();
  };
  const saveLse = async () => {
    const key = keyline.querySelector("input").value.trim();
    if (!key) return;
    const btn = keyline.querySelector("button");
    btn.disabled = true;
    err.classList.add("hidden");
    try {
      await saveLseKey(key);
      closeConnMenu();
      renderConnBar();
      enterLiveSource("lse");
    } catch (e2) {
      err.textContent = String(e2.message || e2);
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  };
  keyline.querySelector("button").onclick = saveLse;
  keyline.querySelector("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveLse();
  });

  // No other-vendor line here: bring-your-own-key was pulled (different
  // keys return later, server-side) and the data section should state
  // only what exists.
  await renderBrokerRows(menu);
  menu.classList.remove("hidden");
}

/* ── Brokers in the connection menu ────────────────────────────────────────
   A broker is a connection like a data source, so it lives in the same menu
   and the user picks it the same way. Everything each row displays about a
   broker comes from that broker's OWN handshake (brue-connect SPEC 3.1),
   which is the point: a broker nobody here has ever heard of, linked by the
   user with `brueconnect add`, gets exactly the row a pre-integrated one
   gets. Nothing in this file may special-case a broker name.

   Two rules the code enforces rather than documents:
   - broker-supplied text goes in through textContent, never innerHTML. It is
     third-party text arriving over a pipe; the engine sanitises it and this
     end still refuses to parse it as markup.
   - the profile name the USER chose is always shown next to the broker's own
     display name, so a broker cannot pass for another by copying it. */
const brokerPicker = { rows: [], probing: false };

function brokerIdentity(b) { return (b && b.identity) || {}; }

function brokerDisplayName(b) {
  const id = brokerIdentity(b);
  return id.display_name || (b && b.label) || (b && b.broker) || "broker";
}

function brokerSubline(b) {
  const id = brokerIdentity(b);
  const bits = [];
  // The broker's own health leads when it is not well, as one word. The
  // broker's explanation can be a list of 35 symbols, which belongs in the
  // tooltip: a row that turns into a wall of text loses the facts next to it.
  if (b.connected && b.session && b.session.state !== "connected") {
    bits.push(b.session.state.toUpperCase());
  }
  if (b.connected) {
    // connected: the facts, not the pitch
    if (b.symbols) bits.push(`${b.symbols.length} instruments`);
    if (id.account_currency) bits.push(id.account_currency);
    if (id.account_model) bits.push(id.account_model);
  } else if (b.ready === false && b.blocked) {
    bits.push(b.blocked);          // what it needs, in the engine's words
  } else if (id.tagline) {
    bits.push(id.tagline);
  } else if (id.asset_classes && id.asset_classes.length) {
    bits.push(id.asset_classes.join(", "));
  }
  return bits.join(" · ");
}

function brokerTooltip(b) {
  const id = brokerIdentity(b);
  const lines = [];
  // Whatever the broker said about its own health, in full, in its own words.
  if (b.session && b.session.state !== "connected") {
    lines.push(`${b.session.state}: ${b.session.detail || "no detail given"}`);
  }
  if (id.country) lines.push(id.country);
  if (id.regulated_by && id.regulated_by.length) lines.push(id.regulated_by.join("; "));
  if (id.website) lines.push(id.website);
  if (id.support) lines.push(id.support);
  if (id.adapter && id.adapter.name) lines.push(`adapter ${id.adapter.name} ${id.adapter.version || ""}`.trim());
  // The broker's terms, in one sentence (SPEC 3.3).
  if (b.terms && (b.terms.said || b.terms.summary)) lines.push(String(b.terms.said || b.terms.summary));
  if (b.unlinked) lines.push("no longer linked; still connected");
  else lines.push(b.registered ? "linked by you" : "shipped with the terminal");
  return lines.join("\n");
}

/* Paper, and only paper, is the safe mode. An adapter that reports nothing,
   or something we do not recognise, is treated as real money: the cost of
   being wrong in that direction is a confirmation dialog, and in the other
   direction it is someone's money. The engine makes the same judgement on the
   order path, so this is the polite half of the rule, not the whole rule. */
function brokerIsPaper(b) {
  return String(brokerIdentity(b).mode || b.mode || "") === "paper";
}

/* ── A broker's terms (Brue Connect SPEC 3.3) ──────────────────────────────
   What the broker's own agreement lets the terminal do with a connection, as
   the engine's row states it (`terms`: the stricter of our listing and the
   broker's handshake). Each flag only takes something away:
   - data_local_only: the broker's prices (quotes, bars, the current price of
     its positions) are shown and used on this computer, and nothing handed to
     an AI carries them: the screen map and the account the assistants read
     say "withheld" and why, and no screenshot is taken while they are shown;
   - orders_by_hand_only, on a connection that is not paper: every order is
     the user's own, from the terminal's own window (the ticket, the
     positions, the chart); the assistants are told so.
   The engine enforces both on its own and words every sentence; the page
   keeps what IT hands the assistants clean, and shows the terms as text.
   A broker this page has no row for is treated as withholding: what its
   terms say is not known here, and not known is not "nothing". */
function brokerTermsOf(rows, broker) {
  const row = (rows || []).find((b) => b && b.broker === broker);
  const t = row && row.terms;
  return t && typeof t === "object" ? t : null;
}

function termsWithheld(rows, broker) {
  if (!broker || broker === "lse-hosted") return "";
  const known = (rows || []).some((b) => b && b.broker === broker);
  if (!known) return "Withheld: the terms of this connection are not known here yet.";
  const t = brokerTermsOf(rows, broker);
  if (!t || !t.data_local_only) return "";
  return String(t.withheld || "Withheld under this broker's terms, which keep its prices on this computer.");
}

/* The sentence an order the user did not place is refused with, on a
   connection whose broker has every order on a live account placed by hand;
   "" when none applies. `by_hand` is set by the engine only when the
   connection is not paper. */
function termsByHand(rows, broker) {
  if (!broker || broker === "lse-hosted") return "";
  const t = brokerTermsOf(rows, broker);
  return t && t.by_hand ? String(t.by_hand) : "";
}

/* What stays of the account and its positions when a broker's prices stay on
   this computer: the account's own record (SPEC 3.3). Every other field is
   set to null: the prices, and every figure marked to them (a position's
   unrealised P/L, the account's equity, open P/L and margin), which with the
   size and the entry price give the price back. A field added to the account
   later is withheld until it is named here. */
const AI_ACCOUNT_KEEP = ["name", "balance", "leverage", "currency", "starting_balance", "positions", "error", "note"];
const AI_POSITION_KEEP = ["symbol", "side", "qty", "avg_price", "sl_price", "tp_price", "trail_points", "opened_at"];

/* The account the assistants read, with those figures left out and the
   reason in their place. */
function aiWithholdAccount(acct, why) {
  if (!why || !acct || typeof acct !== "object") return acct;
  const out = {};
  for (const k of Object.keys(acct)) out[k] = AI_ACCOUNT_KEEP.includes(k) ? acct[k] : null;
  // Positions only as the page built them: a failed snapshot stays one.
  if (!Array.isArray(acct.positions)) {
    if ("positions" in acct) out.positions = null;
    out.prices_withheld = why;
    return out;
  }
  out.positions = acct.positions.map((p) => {
    if (!p || typeof p !== "object") return p;
    const q = {};
    for (const k of Object.keys(p)) q[k] = AI_POSITION_KEEP.includes(k) ? p[k] : null;
    // A stop the broker trails is moved by the broker from the price: with
    // its distance it gives back the best price since entry. The distance,
    // the user's own choice, stays, and the position says what is held back,
    // since a null sl_price otherwise means "no stop set".
    if (q.trail_points) {
      q.sl_price = null;
      q.withheld = "The level of a stop the broker trails " +
        (/^Withheld\b/.test(why) ? "withheld" + why.slice("Withheld".length) : "withheld. " + why);
    }
    return q;
  });
  out.prices_withheld = why;
  return out;
}

/* The chart region of the screen map without the chart's prices. */
function aiWithholdChart(data, why) {
  if (!why || !data || typeof data !== "object") return data;
  return Object.assign({}, data, { last_close: null, bid: null, ask: null,
                                   prices_withheld: why });
}

/* What the screen map's trade ticket tells an assistant about placing an
   order: its usual doors, or, on a live by-hand connection, the sentence. */
function aiTradeDoor(rows, broker, more) {
  const why = termsByHand(rows, broker);
  return why ? [why] : more;
}

/* Why no screenshot may go to an agent now, or "": the chart's source or the
   ticket's broker is a connection whose prices stay on this computer. */
function aiCaptureWithheld(rows, chartProvider, ticketBroker) {
  const chart = isBrokerSource(chartProvider) ? String(chartProvider).slice("broker:".length) : "";
  for (const b of [chart, ticketBroker]) {
    const why = termsWithheld(rows, b);
    if (why) return why;
  }
  return "";
}

/* The terms on a connection's row, and when a live one is armed: the
   engine's words for them as text (never markup), and the terms themselves
   one click away when the broker gave an https address. null when the
   broker's terms say nothing. */
function csTermsLine(terms) {
  if (!terms || typeof terms !== "object") return null;
  // The engine's sentence first. With one restriction in force it is the
  // broker's summary with its full stop, else the terminal's own sentence.
  // With both, the summary (when there is one) followed by the terminal's
  // sentence naming each, unless the summary is our listing's own and the
  // listing says it names both: then the summary alone, said once.
  const said = String(terms.said || terms.summary || "").trim();
  if (!said) return null;
  const line = document.createElement("div");
  line.className = "cs-terms";
  const txt = document.createElement("span");
  txt.textContent = said;
  line.appendChild(txt);
  const url = String(terms.url || "");
  if (/^https:\/\/[^\s"'<>]+$/.test(url)) {
    line.append(" ");
    const a = document.createElement("a");
    a.className = "cs-support cs-terms-link";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Read the terms";
    line.appendChild(a);
  }
  return line;
}

/* The broker list, read again now: the terms an assistant's context is built
   from must be the engine's of this moment. Best effort and capped; the rows
   already held stand when the engine does not answer in time. */
async function brokerRowsFresh() {
  if (state.hosted) return;
  try {
    const r = await Promise.race([fetch("/api/broker/list"),
      new Promise((res) => setTimeout(() => res(null), 1500))]);
    if (r && r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows)) brokerPicker.rows = rows;
    }
  } catch (e) { /* the rows held stand */ }
}

/* Disconnect a broker and, when the trade ticket was pointed at it, fall the
   ticket back to the hosted sim so the panel never sits on a dead connection.
   Shared by the dropdown row and the connection screen. */
async function brokerDisconnect(broker) {
  await fetch("/api/broker/disconnect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ broker }),
  });
  if (typeof tpb !== "undefined" && tpb.broker === broker) {
    const sel = $("tpx-broker");
    if (sel) sel.value = "lse-hosted";
    if (typeof tpbSwitch === "function") await tpbSwitch("lse-hosted");
  }
  renderConnBar();
  if (typeof tpx !== "undefined" && tpx.sync) tpx.sync();
}

function brokerRow(b) {
  const id = brokerIdentity(b);
  const row = document.createElement("div");
  row.className = "conn-brow" + (b.connected ? " on" : "");
  const mark = document.createElement("span");
  mark.className = "conn-mark";
  mark.textContent = (id.mark || brokerDisplayName(b).slice(0, 2)).slice(0, 3);
  const mid = document.createElement("div");
  mid.className = "conn-bmid";
  const nameLine = document.createElement("div");
  nameLine.className = "conn-bname";
  const nm = document.createElement("span");
  nm.textContent = brokerDisplayName(b);
  const slug = document.createElement("span");
  slug.className = "conn-bslug";
  slug.textContent = b.broker;
  nameLine.append(nm, slug);
  const sub = document.createElement("div");
  sub.className = "conn-bsub";
  sub.textContent = brokerSubline(b);
  mid.append(nameLine, sub);
  const m = String(id.mode || b.mode || "");
  const mode = document.createElement("span");
  // Anything that is not paper is badged as the exception, including an
  // unknown mode, which shows as "?" rather than as nothing.
  mode.className = "conn-bmode" + (brokerIsPaper(b) ? "" : " live");
  mode.textContent = m ? m.toUpperCase() : (id.display_name ? "?" : "");
  row.append(mark, mid, mode);
  if (b.connected) {
    const off = document.createElement("button");
    off.className = "conn-act";
    off.title = "Disconnect this broker";
    off.innerHTML = "&#10005;";
    off.onclick = async (e) => {
      e.stopPropagation();
      // a request out or held on it: asked first (tpxHeldAsk)
      if (!(await tpxHeldAsk(b.broker, "Disconnect"))) return;
      await brokerDisconnect(b.broker);
      refreshBrokerRows();
    };
    row.append(off);
  }
  row.title = brokerTooltip(b);
  row.onclick = (e) => {
    if (e.target.closest("button")) return;
    pickBroker(b);
  };
  return row;
}

async function renderBrokerRows(menu) {
  // Not in the hosted terminal: every broker endpoint but this one is
  // local-only (a connection is a subprocess on the user's own machine), so a
  // list there could never be connected and would read as broken.
  if (state.hosted) return;
  const box = document.createElement("div");
  box.id = "conn-brokers";
  menu.appendChild(box);
  await refreshBrokerRows();
}

/* Repaints ONLY the broker rows. Rebuilding the whole menu also rebuilt the
   LSE key form, which wiped a key the user was halfway through typing when a
   probe came back. */
async function refreshBrokerRows() {
  const box = $("conn-brokers");
  if (!box) return;
  let brokers = [];
  try {
    brokers = await fetch("/api/broker/list").then((r) => (r.ok ? r.json() : []));
  } catch (e) { return; } // no brue-connect installed
  if (!Array.isArray(brokers)) return;
  brokerPicker.rows = brokers;
  box.innerHTML = "";
  if (!brokers.length) return;
  const head = document.createElement("div");
  head.className = "conn-head";
  head.textContent = "BROKERS";
  box.appendChild(head);
  // The LSE demo account is not a broker the user connects: it comes with
  // the LSE key (see the LSE row above), so only third-party venues list
  // here. None ship yet, hence the announcement alone.
  const shown = brokers.filter((b) => !LSE_DEMO_KEYS.has(b.broker) && !["paper", "paper-fast"].includes(b.broker));
  for (const b of shown) box.appendChild(brokerRow(b));
  const soon = document.createElement("div");
  soon.className = "conn-row conn-soon";
  soon.innerHTML = `<span class="conn-key">Upcoming</span>`;
  box.appendChild(soon);
  brokerProbeUnknown(shown);
}

/* A broker we have never connected has no name yet, only a profile slug. The
   handshake is the cheapest truthful way to learn one (it carries no
   credentials either way), so ask for it, remember it, and repaint. Opening
   a real session is a separate decision the user makes below. */
async function brokerProbeUnknown(brokers) {
  if (brokerPicker.probing) return;
  const todo = brokers.filter((b) => !b.connected && !brokerIdentity(b).display_name);
  if (!todo.length) return;
  brokerPicker.probing = true;
  let learned = false;
  try {
    for (const b of todo) {
      try {
        const r = await fetch("/api/broker/probe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ broker: b.broker }),
        });
        if (r.ok) learned = true;
      } catch (e) { /* an adapter that will not start stays unnamed */ }
    }
  } finally {
    brokerPicker.probing = false;
  }
  // Repaint only if the menu is still open. Cannot loop: every successful
  // probe leaves a display_name behind, so `todo` is empty next time.
  if (learned && !$("conn-menu").classList.contains("hidden")) refreshBrokerRows();
}

/* The sentence that asks for consent to trade real money. One wording, used
   by Connect and by the card's "Allow trading" button. */
function brokerLiveQuestion(b) {
  const m = String(brokerIdentity(b).mode || b.mode || "");
  const what = m === "live" ? "a LIVE account" : `mode "${m || "unknown"}"`;
  return `${brokerDisplayName(b)} reports ${what}. Orders sent here may be real. ` +
         `Connect and allow trading?`;
}

/* Carry the user's consent to the engine: arm this connection for orders.
   Returns true only when the engine says it is armed. The rule itself is the
   engine's (an unarmed live broker's orders are refused with a 403); this is
   how the refusal becomes a decision instead of a dead end. */
async function brokerArm(broker) {
  try {
    const r = await fetch("/api/broker/arm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker, armed: true }),
    });
    if (!r.ok) return false;
    const out = await r.json();
    return !!out.armed;
  } catch (e) { return false; } // unarmed: the engine will refuse orders, which is correct
}

/* Connect a broker from a row. Resolves to what happened:
   {ok, connected, readOnly, armed, needsAccount, error}. A failed connect is
   reported, not swallowed: the card that asked shows the broker's own reason
   and its Connect button works again. */
async function pickBroker(b) {
  // A broker whose mode nobody has asked about yet is not evidence of real
  // money, it is an unasked question. `hello` is answerable cold (SPEC 3.1)
  // precisely so a picker can learn mode without opening a session, so ask
  // once here rather than showing the live-money warning for a paper venue
  // the user has simply never connected before. The connection screen has no
  // probe of its own (the dropdown's brokerProbeUnknown only runs while that
  // menu is open), which is how a paper venue reached this dialog reporting
  // mode "unknown".
  // The same handshake answers a live login, never bound, whose row does not
  // know whether it reaches several accounts (null: a profile remembered by
  // an earlier build): asked at Connect, it could be a question about an
  // account not yet chosen, which was dropped once the chooser came up.
  const unknownAccounts = b.accounts_multi === null && !b.connected && !b.account_id;
  if (!brokerIsPaper(b) && (!String(brokerIdentity(b).mode || b.mode || "") || unknownAccounts)) {
    try {
      const r = await fetch("/api/broker/probe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ broker: b.broker }),
      });
      if (r.ok) b = await r.json();
    } catch (e) { /* unprobeable: fall through to the careful path below */ }
  }
  // A broker whose login reaches SEVERAL accounts has no single mode until
  // one is chosen: the last one you used may have been live, the one you are
  // about to pick may be demo. Asking at connect time would be asking about
  // a decision that has not been made, using a stale answer; there the
  // account row states real or demo before you commit, and the card offers
  // "Allow trading" once a live account is bound.
  // That exception is ONLY for a login known to reach several accounts with
  // none bound: one that lists several, or whose own hello said it can
  // (accounts_multi) and that was never bound (asked here, its answer was
  // dropped once the chooser came up, and the card asked again). It used to
  // cover every broker that was not connected and had no stored account,
  // which is every single-account broker: a live one was then never asked
  // and never armed, and every order it was sent came back refused. One of
  // these that binds its only account as it connects is asked just after.
  const choosing = !b.connected && !b.account_id
    && (!!b.needs_account || (b.accounts || []).length > 1 || !!b.accounts_multi);
  const paper = brokerIsPaper(b);
  const askedBefore = !paper && !choosing;
  let allow = false;
  if (askedBefore) {
    // Real money is never reached by one click. The engine refuses the order
    // regardless (an unarmed live broker gets a 403), so this dialog is what
    // turns that refusal into consent rather than a dead end. Declining still
    // connects, read-only: looking at an account is not trading it.
    // The broker's terms are shown with the question (SPEC 3.3).
    allow = await askConfirm(brokerLiveQuestion(b), "Allow trading", "Connect read-only", b.terms);
  }
  closeConnMenu();
  // A broker that still needs the user (log in, or pick an account) has its
  // answer ON THIS SCREEN, so closing it hid the very thing being waited for.
  // Only leave the screen once the connection is actually live.
  const sel = $("tpx-broker");
  if (sel && !Array.from(sel.options).some((o) => o.value === b.broker)) {
    const o = document.createElement("option");
    o.value = b.broker;
    o.textContent = brokerDisplayName(b);
    sel.appendChild(o);
  }
  if (sel) sel.value = b.broker;
  const res = (typeof tpbSwitch === "function" ? await tpbSwitch(b.broker) : null) || {};
  if (res.ok === false) {
    renderConnBar();
    return { ok: false, error: res.error || "the broker did not connect" };
  }
  // What the connection actually is, from the engine's row for it (tpbSwitch
  // re-read the list): the mode here is the live handshake's, not a memory.
  const row = (brokerPicker.rows || []).find((x) => x.broker === b.broker) || {};
  const out = { ok: true, connected: !!row.connected, armed: !!row.armed,
                needsAccount: !!res.needsAccount, readOnly: false };
  if (out.connected && !brokerIsPaper(row)) {
    // Nobody was asked above: remembered as paper and connected as something
    // else (its file was changed to "live" since its last connect, the
    // walkthrough's own step, or the venue changed), or a login that could
    // reach several accounts and was bound to its only one. Ask now, while
    // the connection is open read-only and its account is the one in use:
    // the same question, answered before anything can trade.
    if (!askedBefore) {
      // The Connections screen behind the question says what is so first:
      // connected, live and read-only, from the engine's row. It went on
      // saying "Not connected" with "Connecting…" until the answer came.
      const screen = $("conn-screen");
      if (screen && !screen.classList.contains("hidden")) renderConnScreen(true);
      allow = await askConfirm(
        brokerLiveQuestion(row).replace(/Connect and allow trading\?$/, "Allow trading?"),
        "Allow trading", "Stay read-only", row.terms);
    }
    // Armed only AFTER the connection succeeded, only for the broker the user
    // just said yes to, and only when they said yes. A failed connect leaves
    // nothing armed, and neither does a "no".
    if (allow && typeof tpb !== "undefined" && tpb.broker === b.broker) {
      out.armed = await brokerArm(b.broker);
      row.armed = out.armed;
    }
    out.readOnly = !out.armed;
  }
  renderConnBar();
  return out;
}

function setupConnBar() {
  // The connection control opens the full-surface screen, not the little
  // dropdown. The dropdown code (openConnMenu and friends) stays as the low
  // level the screen is built on: it owns brokerRow/refreshBrokerRows, and the
  // screen reuses its plumbing (saveLseKey, pickBroker, brokerDisconnect).
  $("conn-bar").onclick = (e) => {
    e.stopPropagation();
    openConnScreen();
  };
  $("cs-close").onclick = closeConnScreen;
  // Backdrop click closes; clicks on the card (typing a key) do not.
  $("conn-screen").onclick = (e) => {
    if (e.target === $("conn-screen")) closeConnScreen();
  };
  setupInquiry();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("conn-screen").classList.contains("hidden")) {
      closeConnScreen();
    }
  });
  // A window made shorter or taller, or zoomed, with the sheet open: it is
  // hung again (csHang) and its scroll bar's room read again (csGutter).
  window.addEventListener("resize", () => {
    if ($("conn-screen").classList.contains("hidden")) return;
    csHang();
    csGutter();
  });
  csPressWatch();
}

/* ── Connection screen ─────────────────────────────────────────────────────
   The full-surface version of the conn-menu dropdown, same information
   architecture: the LSE data connection first (the default, always), then the
   brokers. What is bigger here is only the surface. The connect/disconnect and
   key plumbing is exactly the dropdown's (saveLseKey, pickBroker,
   brokerDisconnect); nothing here re-implements the broker hub. The extra
   content (logos, taglines, partner tags, instrument counts, per-broker
   credential forms) comes from the hosted directory (/api/directory), which the
   engine already fetches and caches, merged at render time with the hub's live
   connection state (/api/broker/list). */
const connScreen = { dir: [], origin: "", broker: null,
                     brokerPinned: false, pickOpen: false, sig: "",
                     // which cards have "Lines the adapter printed" open,
                     // kept across repaints (csBrokerCard)
                     printedOpen: {},
                     // per broker, the account the chooser's first click
                     // previewed, kept across repaints (csBrokerCard)
                     acctPreview: {},
                     // "Add your own broker": the adapters this engine's kit
                     // offers in one click, whether the engine is too old to
                     // link at all, the form (open, busy, what was typed,
                     // which field to put the cursor back in) and what the
                     // last attempt said.
                     examples: [], linkOld: false,
                     addOpen: false, addBusy: false, addFocus: "",
                     addDraft: { name: "", path: "", args: "" },
                     addError: null,   // {message, stderr, update}
                     // This machine's facts for that card (GET
                     // /api/broker/own-guide): undefined until asked, null
                     // while asked, then the answer or {failed: true}.
                     ownGuide: undefined,
                     devOpen: false,     // the add card's "For developers" fold
                     addSaved: null,     // {path, folder, existing} once "Create my starter adapter" ran
                     addDownloaded: false,
                     // Per broker: one line about what just happened on its
                     // card, and why its last action failed. Kept here
                     // because the card is rebuilt on every repaint.
                     notes: {}, errors: {}, keysOpen: {},
                     // Per broker: what has been typed into its key boxes
                     // and not yet submitted (see csDraft). In memory only.
                     keyDrafts: {} };

/* ── Key-box drafts ────────────────────────────────────────────────────────
   The Connections screen rebuilds its whole body whenever anything it shows
   changes, and it re-reads the engine on a timer. A rebuild makes new, empty
   inputs. So what a person has typed into a broker's key boxes cannot live in
   the inputs: it lives here, each keystroke, and every rebuild puts it back
   (the cursor too: see renderConnScreen). Without this, someone pasting two
   long keys watched the first one vanish while they fetched the second.

   The rules, because these are secrets:
   - memory only. Never localStorage, never sessionStorage, never a cookie,
     never a request. The one way a draft leaves the page is the Connect
     button, through csConnect, to the user's own engine.
   - short-lived. A broker's drafts are dropped the moment they are submitted,
     when the user closes its card or the screen, when its keys are forgotten
     and when it is unlinked. Nothing is kept "for next time". */
function csDraft(broker, field) {
  const d = connScreen.keyDrafts[broker];
  return (d && typeof d[field] === "string") ? d[field] : "";
}

function csDraftSet(broker, field, value) {
  const v = String(value == null ? "" : value);
  let d = connScreen.keyDrafts[broker];
  if (v === "") {
    if (!d) return;
    delete d[field];
    if (!Object.keys(d).length) delete connScreen.keyDrafts[broker];
    return;
  }
  if (!d) d = connScreen.keyDrafts[broker] = {};
  d[field] = v;
}

/* Forget one broker's drafts, or everybody's when no broker is named. */
function csDraftDrop(broker) {
  if (broker === undefined) connScreen.keyDrafts = {};
  else delete connScreen.keyDrafts[broker];
}

/* Fields that a LISTING marks required and that have neither a typed nor a
   stored value: Connect stops for these and names them, before anything is
   sent. Only a directory row can mark a field required. A form declared by an
   adapter's own handshake has no such flag (brue-connect SPEC 3.2: an adapter
   that cannot go on without a value says so itself), so its fields never
   block here; see csEmptyFields for what the card says about those. */
function csMissingFields(fields, values, stored) {
  return (fields || []).filter((f) => f && f.required === true
    && !String((values || {})[f.key] || "").trim()
    && !(stored && stored.has(f.key)));
}

/* Every declared field with neither a typed nor a stored value, required or
   not. Shown beside a broker's refusal, so "the key was rejected" can be read
   next to "you left the secret empty" without knowing its variable names. */
function csEmptyFields(fields, values, stored) {
  return (fields || []).filter((f) => f && f.key
    && !String((values || {})[f.key] || "").trim()
    && !(stored && stored.has(f.key)));
}

/* "A", "A and B", "A, B and C": field labels in a sentence. */
function csListWords(labels) {
  const l = (labels || []).map(String);
  if (l.length < 2) return l.join("");
  return l.slice(0, -1).join(", ") + " and " + l[l.length - 1];
}

/* A broker the user linked from one of the rows this terminal ships (the
   engine marks such a profile with its example's key) wears that row's mark:
   linking a listed broker does not turn its logo back into two letters. */
function csExampleLogo(e) {
  const ex = e && e.hub && e.hub.example;
  if (!ex) return "";
  const x = (connScreen.examples || []).find((r) => r && r.key === ex);
  return (x && x.logo) ? String(x.logo) : "";
}

/* The broker's own mark for the picker row, or its initials when it has no
   art. Same grayscale treatment as the card, so the list reads as one thing. */
function csBrokerMark(e) {
  const src = (e.d && (e.d.logo || (connScreen.origin && e.d.logo_url
    ? connScreen.origin + e.d.logo_url : ""))) || csExampleLogo(e);
  const mono = (e.label || "?").slice(0, 2).toUpperCase();
  return src
    ? `<img src="${csEsc(src)}" alt="">`
    : `<span class="cs-pickinit">${csEsc(mono)}</span>`;
}

function closeConnScreen() {
  $("conn-screen").classList.add("hidden");
  // The user closed the screen, and every card with it: nothing typed and
  // unsubmitted is kept behind a closed door (see csDraft). That means the
  // boxes too, not only the draft store: the screen is hidden, not removed,
  // so the inputs are still in the document holding what was typed, and
  // opening the screen again does not rebuild them when nothing else changed.
  // They are emptied now, and the next opening is made to rebuild.
  csDraftDrop();
  for (const inp of document.querySelectorAll("#cs-body input[data-cred]")) inp.value = "";
  connScreen.sig = "";
}

/* "Inquire" (Connections footer, bottom right): a broker asking to be
   connected. POSTs straight to the hosted API, NOT the local engine: the
   frozen engine on an installed app cannot gain routes by a UI deploy,
   and the hosted endpoint predates no one. The request
   deliberately carries NO Content-Type header: that keeps it a CORS "simple
   request", which is what lets it work from the desktop app's random
   localhost origin and the hosted embed alike, with no CORS preflight.
   The engine parses the raw bytes as JSON regardless. */
const INQUIRY_URL = "https://api.londonstrategicedge.com/sim/inquiry";

function openInquiry() {
  $("inq-err").classList.add("hidden");
  $("inq-form").classList.remove("hidden");
  $("inq-done").classList.add("hidden");
  $("inq-modal").classList.remove("hidden");
  $("inq-firm").focus();
}

function setupInquiry() {
  $("inq-close").onclick = () => $("inq-modal").classList.add("hidden");
  $("inq-modal").onclick = (e) => {
    if (e.target === $("inq-modal")) $("inq-modal").classList.add("hidden");
  };
  // The engine is the authority on what is accepted (freemail refusal, MX
  // check, volume caps); these local checks only save a round trip for the
  // obvious cases and word the same way the engine does.
  const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|pm|gmx|mail|yandex|zoho|fastmail|tutanota|hey|qq|163|126|rediffmail|inbox)\.[a-z.]+$/i;
  const fail = (msg) => {
    const err = $("inq-err");
    err.textContent = msg;
    err.classList.remove("hidden");
  };
  $("inq-send").onclick = async () => {
    const btn = $("inq-send");
    $("inq-err").classList.add("hidden");
    const firm = $("inq-firm").value.trim();
    const email = $("inq-email").value.trim();
    const msg = $("inq-msg").value.trim();
    if (!firm) { fail("Firm is required."); $("inq-firm").focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
      fail("Enter a valid work email address."); $("inq-email").focus(); return;
    }
    if (FREEMAIL.test(email)) {
      fail("Use your firm's email address, not a personal webmail account.");
      $("inq-email").focus(); return;
    }
    if (msg.length < 20) {
      fail("Tell us a little more about your firm and what you are looking for.");
      $("inq-msg").focus(); return;
    }
    btn.disabled = true;
    btn.textContent = "Sending\u2026";
    try {
      const r = await fetch(INQUIRY_URL, {
        method: "POST",
        body: JSON.stringify({
          firm: $("inq-firm").value.trim(),
          contact_name: $("inq-name").value.trim(),
          email: $("inq-email").value.trim(),
          site: $("inq-site").value.trim(),
          asset_classes: $("inq-assets").value.trim(),
          // regulator field removed from the form; the
          // endpoint reads it with a get() fallback, so omitting is safe
          kind: "broker",   // the form is the brokers row's only
          message: $("inq-msg").value.trim(),
          website: $("inq-web").value,   // honeypot; humans leave it empty
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
      $("inq-form").classList.add("hidden");
      $("inq-done").classList.remove("hidden");
    } catch (e) {
      fail(String(e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Send inquiry";
    }
  };
}

/* While the screen is open and a broker is mid-decision (waiting on the
   browser login, or waiting for you to pick an account), repaint it. The
   answer arrives OUT OF BAND: you finish on the broker's page in another
   window and come back expecting the card to have moved on. Without this it
   only repaints when something else happens to call refresh, so the account
   chooser could be ready on the engine and invisible on screen. */
function connScreenWatch() {
    clearTimeout(brokerPicker.watch);
    if ($("conn-screen").classList.contains("hidden")) return;
    const waiting = (brokerPicker.rows || []).some(
        (b) => b.auth_pending || b.needs_account);
    brokerPicker.watch = setTimeout(async () => {
        if ($("conn-screen").classList.contains("hidden")) return;
        // Listing brokers only READS. `connect` is what advances a pending
        // login ("has the user finished on the broker's page yet"), so a
        // screen that merely refreshed would wait forever: the engine had
        // the answer and nobody was asking the question.
        for (const b of brokerPicker.rows || []) {
            if (!b.auth_pending) continue;
            try {
                await fetch("/api/broker/connect", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ broker: b.broker }),
                });
            } catch (e) { /* transient; the next tick asks again */ }
        }
        refreshConnScreen();
    }, waiting ? 2000 : 6000);
}

/* The listed rows' last known examples (GET /api/broker/examples), kept for
   the next page in this browser's store, so the screen's first paint gives
   the listed rows their places: they used to come with the refresh, 34 to 67
   ms after the first paint, ABOVE the linked rows and "Add your own broker",
   and push them about 190 px down under the pointer. The engine's public
   listing only, never a key. Every read and write is in a try: a store that
   throws, or holds something that is not a list of rows, is an empty one. */
function csExamplesKept() {
  try {
    const rows = JSON.parse(localStorage.getItem("lse.cs.examples") || "null");
    if (!Array.isArray(rows)) return [];
    return rows.filter((x) => x && typeof x === "object" && !Array.isArray(x) && typeof x.key === "string" && x.key);
  } catch (e) {
    return [];
  }
}
function csExamplesKeep(rows) {
  try { localStorage.setItem("lse.cs.examples", JSON.stringify(rows || [])); } catch (e) { /* not kept: next time waits */ }
}

/* Where the sheet hangs (style.css, #conn-screen): 12px below the header, its
   bottom and the rule drawn under it, when that is lower than 6vh. Read when
   the sheet opens and when the window changes size, at no other time: a
   sheet hung again while it is open would move every row on it. */
function csHang() {
  const head = document.querySelector("body > header"), screen = $("conn-screen");
  if (!head || !screen) return;
  screen.style.setProperty("--cs-top", Math.ceil(head.getBoundingClientRect().bottom + 1) + "px");
}

/* The room the sheet keeps for its scroll bar from the start (scrollbar-gutter:
   stable), as wide as the scroll bar is here (none where scroll bars float
   over the page), given back from its right padding (style.css, --cs-gutter):
   its rows have as much room on the right as on the left whether it scrolls
   or not. Read once the sheet is shown, before it is painted. */
function csGutter() {
  const card = $("cs-card");
  if (!card) return;
  const cs = getComputedStyle(card);
  const kept = card.offsetWidth - card.clientWidth
    - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
  card.style.setProperty("--cs-gutter", Math.max(0, kept) + "px");
}

/* Boot draws the header's second row (the section's sub-views) when it lands
   on its first section, its last step. A sheet hung before that would run
   across that row once it came, or have to move to clear it: the screen
   waits for boot to land (csLand, called by boot), never longer than
   CS_LAND_WAIT_MS. */
const CS_LAND_WAIT_MS = 1500;
let csLandedNow = false;
let csLand = () => {};
const csLanded = new Promise((ok) => { csLand = () => { csLandedNow = true; ok(); }; });

async function openConnScreen() {
  if (typeof csLandedNow !== "undefined" && !csLandedNow) {
    await Promise.race([csLanded, new Promise((ok) => setTimeout(ok, CS_LAND_WAIT_MS))]);
  }
  csHang();
  $("conn-screen").classList.remove("hidden");
  csGutter();
  // The listed rows' places from the last examples known: in memory, else
  // kept for this page (csExamplesKept). With none, the rows below them wait
  // for the first answer (renderConnScreen).
  if (!(connScreen.examples || []).length) {
    const kept = csExamplesKept();
    if (kept.length) connScreen.examples = kept;
  }
  if (!connScreen.dismissWired) {
    connScreen.dismissWired = true;
    // Click-away and Escape close the dropdown, the way every other menu on
    // this screen behaves.
    document.addEventListener("click", () => {
      if (!connScreen.pickOpen) return;
      connScreen.pickOpen = false;
      renderConnScreen(true);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !connScreen.pickOpen) return;
      connScreen.pickOpen = false;
      renderConnScreen(true);
    });
  }
  // Paint at once from whatever is already in hand, then refresh so the panel
  // never opens blank.
  renderConnScreen();
  await refreshConnScreen();
}

async function refreshConnScreen() {
  // Two reads, in parallel: the hub is the source of truth for what is
  // connected, the directory for what exists and how it looks. Both optional:
  // any that is away just leaves that part of the screen as it was.
  const jobs = [];
  let dirJob = null;
  if (!state.hosted) {
    jobs.push(fetch("/api/broker/list")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => { if (Array.isArray(rows)) brokerPicker.rows = rows; })
      .catch(() => { /* no brue-connect installed */ }));
    // A connected broker that can serve candles is registered as a data
    // source by the engine, and that is what decides whether this screen
    // offers it a "Use" button. Read fresh, or the button is missing until
    // something else happens to refresh the provider list.
    jobs.push(refreshProviders().catch(() => { /* keep the last list */ }));
    // The adapters the engine's kit ships that can be linked in one click.
    // An engine from before "add your own broker" has no such route (404 or
    // 405): remembered, so the form can say "update the terminal" instead
    // of offering fields that can only fail.
    jobs.push(fetch("/api/broker/examples")
      .then((r) => {
        connScreen.linkOld = r.status === 404 || r.status === 405;
        return r.ok ? r.json() : null;
      })
      .then((rows) => {
        connScreen.examples = Array.isArray(rows) ? rows : [];
        // kept for the next page's first paint (csExamplesKept)
        if (Array.isArray(rows)) csExamplesKeep(rows);
      })
      .catch(() => { connScreen.examples = []; }));
    // (the directory is read beside these, and is not waited for before the
    // rows below the listed ones are painted: its hosted fallback can be
    // slow; its rows come when it lands, as before)
    dirJob = (async () => {
      // The same-origin proxy is the fast path, but a frozen or older engine
      // may not carry that route yet (it 404s). Fall back to the hosted
      // directory directly: logos travel INLINE in the payload, so the screen
      // needs nothing from the local engine to render them. Either way a
      // failure just leaves the hub list showing.
      let d = await fetch("/api/directory")
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!d || !(d.brokers && d.brokers.length)) {
        d = await fetch("https://api.londonstrategicedge.com/sim/directory")
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      }
      if (d) { connScreen.dir = d.brokers || []; connScreen.origin = d.origin || ""; }
    })();
  }
  await Promise.all(jobs);
  // The engine has been read once (its brokers, sources and examples): the
  // rows below the listed ones are painted from now on (renderConnScreen).
  connScreen.loaded = true;
  if (!$("conn-screen").classList.contains("hidden")) renderConnScreen();
  if (dirJob) {
    await dirJob;
    if (!$("conn-screen").classList.contains("hidden")) renderConnScreen();
  }
  // Re-arm after every repaint: a decision that lands out of band (the user
  // finishing on the broker's page) has to reach the screen on its own.
  connScreenWatch();
}

function csSection(text) {
  const el = document.createElement("div");
  el.className = "cs-section";
  el.textContent = text;
  return el;
}

/* What the screen is currently showing, reduced to a string. The watch tick
   repaints every couple of seconds; without this it rebuilt the DOM even when
   nothing had changed, which closed the open dropdown a second after it was
   clicked and threw away any focus with it. */
function csSignature() {
  // Everything a row or its card DISPLAYS is in here. It used to cover only
  // the connection state, so a row whose name, mode, arming, stored keys or
  // last error changed kept its stale DOM until the user clicked something:
  // a failed connect left its card blank with a disabled button.
  const rows = (brokerPicker.rows || []).map((b) => [b.broker, b.connected,
    b.auth_pending, b.needs_account, b.account_id,
    (b.accounts || []).length, b.label, b.registered, b.unlinked,
    b.update_required, b.mode, b.armed, brokerIdentity(b).display_name,
    (b.stored_credentials || []).join(","), (b.credential_form || []).length,
    b.last_error ? b.last_error.at : "",
    // (Not what its adapter printed: an adapter that prints as it runs would
    // repaint the screen at every tick and throw away the account preview,
    // the first of the chooser's two clicks. New lines are put on the card
    // where it is, csPrintedRefresh.)
    (b.command_preview || []).join(" "),
    // The terms shown on the row (SPEC 3.3): a hello can change them.
    b.terms ? [b.terms.said || b.terms.summary || "", b.terms.url || ""].join(" ") : ""].join(":")).join("|");
  const add = [connScreen.addOpen, connScreen.addBusy, connScreen.linkOld, !!connScreen.loaded,
    (connScreen.examples || []).map((x) => x.key).join(","),
    connScreen.addError ? connScreen.addError.message : "",
    JSON.stringify(connScreen.ownGuide === undefined ? "" : connScreen.ownGuide)].join(":");
  return [rows, (connScreen.dir || []).length,
          connScreen.broker, connScreen.pickOpen, state.lseConfigured, add,
          JSON.stringify(connScreen.notes), JSON.stringify(connScreen.errors),
          JSON.stringify(connScreen.keysOpen)].join("~");
}

/* A press under way on the screen's rows. A rebuild of the body between its
   down and its up threw away the row it went down on: the up landed on the
   rebuilt twin, no click was made and the press opened nothing (23 of 25
   quick presses after a reload were lost to the rebuild the engine's first
   answers make about 30 ms after the first paint, and every press across
   the directory's). A rebuild asked for while a press is down
   waits until the press has ended and its click has been taken
   (renderConnScreen, csPressDone); a press held longer than CS_PRESS_HOLD_MS
   is no quick one, and the rebuild is made then. */
const CS_PRESS_HOLD_MS = 1500;
function csPressWatch() {
  const body = $("cs-body");
  if (!body || connScreen.pressWired) return;
  connScreen.pressWired = true;
  body.addEventListener("pointerdown", (e) => {
    if (e.isPrimary && e.button === 0) connScreen.press = { id: e.pointerId, at: Date.now() };
  }, true);
  const end = (e) => {
    const p = connScreen.press;
    if (!p || (e && e.pointerId !== undefined && e.pointerId !== p.id)) return;
    connScreen.press = null;
    // after the press's click, which comes after its up in the same turn
    if (connScreen.held) setTimeout(csPressDone, 0);
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  window.addEventListener("blur", () => end());
}

/* The rebuild a press held, once the press has ended or outlasted
   CS_PRESS_HOLD_MS, unless one has been made since. */
function csPressDone() {
  const held = connScreen.held;
  if (!held || $("conn-screen").classList.contains("hidden")) return;
  renderConnScreen(held.force);
}

function csPressCap() {
  if (connScreen.pressCap) return;
  const left = CS_PRESS_HOLD_MS - (Date.now() - connScreen.press.at);
  connScreen.pressCap = setTimeout(() => { connScreen.pressCap = null; csPressDone(); }, Math.max(0, left) + 5);
}

function renderConnScreen(force) {
  const body = $("cs-body");
  if (!body) return;
  // A press is down on a row: rebuilt under it, it would make no click.
  if (connScreen.press && Date.now() - connScreen.press.at < CS_PRESS_HOLD_MS) {
    connScreen.held = { force: !!(force || (connScreen.held && connScreen.held.force)) };
    csPressCap();
    return;
  }
  const held = connScreen.held;
  connScreen.press = null;
  connScreen.held = null;
  if (held && held.force) force = true;
  const sig = csSignature();
  if (!force && sig === connScreen.sig && body.childElementCount) {
    // Nothing a row shows changed; what an adapter printed may have, and is
    // put where it is shown, in place.
    csPrintedRefresh(body);
    return;
  }
  connScreen.sig = sig;
  // A rebuild throws the DOM away. What was typed into the add form lives in
  // connScreen.addDraft and is put back by the form itself; the cursor is
  // put back here, so a repaint caused by some other row never interrupts
  // someone mid-word.
  // The same goes for a broker's key boxes: their text is in
  // connScreen.keyDrafts (csDraft), and each carries a data-cs-field name, so
  // a key being typed when the timer refresh lands keeps its text, its focus
  // and its caret. The scroll position of the card is kept as well, so the
  // box being typed in does not jump.
  const active = document.activeElement;
  const typing = active && body.contains(active) && active.dataset
    ? active.dataset.csField || "" : "";
  const caret = typing ? [active.selectionStart, active.selectionEnd] : null;
  const scroller = body.parentElement;
  const scrolled = scroller ? scroller.scrollTop : 0;
  // Drafts of a broker that is no longer listed have nowhere to go back to.
  for (const k of Object.keys(connScreen.keyDrafts)) {
    if (!(brokerPicker.rows || []).some((b) => b.broker === k)
        && !(connScreen.dir || []).some((d) => d && d.key === k)
        && !(connScreen.examples || []).some((x) => x && csExampleKey(x) === k)) csDraftDrop(k);
  }
  body.innerHTML = "";

  // 1) DATA CONNECTION: the LSE default, then the announcement row. Other
  //    vendors return as server-listed connections later;
  //    until then the section states that rather than offering a form.
  body.appendChild(csSection("DATA CONNECTION"));
  body.appendChild(csLseCard());

  // 2) BROKERS.
  body.appendChild(csSection("BROKERS"));
  if (state.hosted) {
    // Broker connections are a subprocess on the user's own machine, so a
    // hosted terminal can never open one; say so instead of listing dead rows.
    const note = document.createElement("div");
    note.className = "cs-hosted";
    note.textContent =
      "Broker connections run locally, on your own machine. Download the terminal to connect a broker.";
    body.appendChild(note);
    body.appendChild(csInquireFoot());
    return;
  }
  // Every venue as a row, the connected one open (the old
  // dropdown-plus-card named the same broker twice within 60px and hid the
  // rest of the list behind a control, so the screen showed one item of a
  // catalogue and read as a form). A row states the whole decision: who they
  // are, what they deal, whether you are connected. Opening one shows its
  // detail in place; the connect flow underneath is unchanged.
  // The hosted directory decides what is offered; a broker the user linked
  // themselves (brueconnect add) is offered too. A hub-only row that is
  // neither (a lingering session on a delisted venue) is not acknowledged:
  // the engine's normal paths disconnect it. A listed broker this build
  // cannot spawn yet is still a row, stating that an update unlocks it.
  const entries = csBrokerEntries().filter(
    (e) => e.d || (e.hub && e.hub.registered));
  const live = entries.find((e) => e.hub && e.hub.connected);
  const open = connScreen.brokerPinned
    ? connScreen.broker                       // the user's own choice, incl. "" for all closed
    : (live ? live.key : "");
  // The real brokers this terminal ships an adapter for come FIRST, each a
  // row of its own with its key boxes, linked or not: someone looking for a
  // broker we list finds it here, not a link at the bottom of the list that
  // leads to it. Once linked it is the user's own row (csBrokerRow), in the
  // same place.
  const shown = new Set();
  for (const x of (connScreen.examples || []).filter((x) => x && x.key)) {
    const h = (brokerPicker.rows || []).find((b) => b.example === x.key && b.registered);
    const e = h && entries.find((y) => y.key === h.broker);
    if (e) {
      // (opened as well by a press made while it was painted as a listed row
      // not set up, before the engine's answer showed it linked)
      body.appendChild(csBrokerRow(e, e.key === open || open === csExampleKey(x)));
      shown.add(e.key);
    } else {
      body.appendChild(csExampleRow(x, open === csExampleKey(x)));
    }
  }
  // Until the screen has been read once, the rows below the listed ones
  // wait: the listed rows, and the directory's, come with that answer above
  // them, and a row painted now would be pushed down under the pointer. A
  // line says the list is being read.
  if (!connScreen.loaded) {
    const wait = document.createElement("div");
    wait.className = "cs-note cs-wait";
    wait.textContent = "Reading the brokers on this computer…";
    body.appendChild(wait);
  } else {
    for (const e of entries) if (!shown.has(e.key)) body.appendChild(csBrokerRow(e, e.key === open));
    // The user's own door, under the brokers we list and above what is
    // coming. It is not the Inquire footer: that one is for a FIRM asking to
    // be listed.
    body.appendChild(csAddBrokerRow());
    body.appendChild(csInquireFoot());
  }
  if (scroller) scroller.scrollTop = scrolled;
  const want = connScreen.addFocus || typing;
  connScreen.addFocus = "";
  if (want) {
    // Found by comparing the name, not by building a selector from it: a
    // broker's key is part of the name and is not ours to trust in a selector.
    const again = [...body.querySelectorAll("[data-cs-field]")]
      .find((el) => el.dataset.csField === want);
    if (again) {
      again.focus({ preventScroll: want === typing });
      if (caret && want === typing) {
        try { again.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
      }
    }
  }
}

/* One venue in the list: the header row is always visible, the detail card
   appears under whichever row is open. The header carries the identity so the
   card does not repeat it (headless), which is what made the old layout read
   as two copies of the same broker. */
function csBrokerRow(e, open) {
  const wrap = document.createElement("div");
  const hub = e.hub || null;
  // A broker the user linked themselves: no listing of ours describes it, so
  // everything on its row is the adapter's own handshake (SPEC 3.1) plus the
  // one thing the adapter cannot choose, the profile ID the user gave it.
  const own = !!(hub && hub.registered);
  wrap.className = "cs-brow" + (open ? " open" : "")
    + (hub && hub.connected ? " on" : "") + (own ? " cs-own" : "");
  wrap.dataset.broker = e.key;
  const head = document.createElement("button");
  head.className = "cs-bhead";
  const id = hub ? brokerIdentity(hub) : {};
  const name = own ? brokerDisplayName(hub) : e.label;

  const mark = document.createElement("span");
  mark.className = "cs-pickmark";
  const exLogo = own ? csExampleLogo(e) : "";
  if (exLogo) {
    // Linked from a row this terminal ships: that row's own logo.
    mark.classList.add("logo-tile");
    const img = document.createElement("img");
    img.src = exLogo;
    img.alt = "";
    mark.appendChild(img);
  } else if (own) {
    // The adapter's own monogram when it sent one (three characters at most,
    // sanitised by the engine), else the first two letters of its name. Text,
    // never markup: this row is built without innerHTML for that reason.
    const init = document.createElement("span");
    init.className = "cs-pickinit";
    init.textContent = String(id.mark || name || "?").slice(0, id.mark ? 3 : 2).toUpperCase();
    mark.appendChild(init);
  } else {
    mark.innerHTML = csBrokerMark(e);   // a listed broker's logo (escaped there)
  }

  const mid = document.createElement("span");
  mid.className = "cs-bheadmid";
  const line = document.createElement("span");
  line.className = "cs-pickline";
  const nm = document.createElement("span");
  nm.className = "cs-pickname";
  nm.textContent = name;
  line.appendChild(nm);
  if (own) {
    // The profile ID beside the broker's own name, always: it is the one
    // name on this row the adapter did not choose, so an adapter cannot pass
    // for another broker by copying its display name (SPEC 3.1).
    const pid = document.createElement("span");
    pid.className = "cs-pickid";
    pid.textContent = e.key;
    line.appendChild(pid);
  }
  mid.appendChild(line);
  const tag = (e.d && e.d.tagline) || id.tagline || "";
  if (tag) {
    const tg = document.createElement("span");
    tg.className = "cs-btag";
    tg.textContent = tag;
    mid.appendChild(tg);
  }

  const st = document.createElement("span");
  st.className = "cs-pickstate";
  if (hub && hub.connected) { st.textContent = "Connected"; st.classList.add("ok"); }
  else if (csNeedsUpdate(e)) { st.textContent = "Update to use"; st.classList.add("upd"); }
  else if (own) st.textContent = hub.unlinked ? "No longer linked" : "Not connected";
  if (own) {
    // Real money is said on the row, in words and weight rather than an
    // alarm colour (SPEC 1.7's rule for accounts, applied to the one-account
    // adapter this row is). Unknown is not paper: it is named as it is.
    const mode = String(id.mode || hub.mode || "");
    if (mode && mode !== "paper" && mode !== "unknown") {
      const lv = document.createElement("span");
      lv.className = "cs-live";
      lv.textContent = mode === "live" ? "LIVE" : mode.toUpperCase().slice(0, 12);
      if (st.textContent) st.append(" · ");
      st.appendChild(lv);
    }
  }
  const caret = document.createElement("span");
  caret.className = "cs-pickcaret";
  head.append(mark, mid);
  if (st.textContent) head.appendChild(st);
  head.appendChild(caret);
  head.onclick = (ev) => {
    ev.stopPropagation();
    connScreen.broker = open ? "" : e.key;    // clicking the open row closes it
    connScreen.brokerPinned = true;
    // One card is open at a time, so this click closes a card whichever row
    // it lands on: the user put its unsubmitted keys away (see csDraft).
    csDraftDrop();
    renderConnScreen(true);
  };
  wrap.appendChild(head);
  // The broker's terms, on the row itself, open or closed (SPEC 3.3). Below
  // the header rather than in it: the header is a button, and a link inside
  // a button is a click on both.
  const terms = csTermsLine(hub && hub.terms);
  if (terms) wrap.appendChild(terms);
  if (open) wrap.appendChild(csBrokerCard(e.d, e.hub, { headless: true }));
  return wrap;
}

/* ── Add your own broker ───────────────────────────────────────────────────
   A broker here is an adapter: a small program on the user's machine that
   speaks the Brue Connect protocol for one venue. Linking one hands the engine
   the path of that program; the engine runs it once, handshakes it, and only
   then stores it (POST /api/broker/link). After that it is a row like any
   other, drawn entirely from what the adapter says about itself. */

/* What the user typed as a name, as the profile ID it is saved under: lower
   case letters, digits, "-" and "_", 2 to 32 characters, starting with a
   letter or digit. The ID names a folder on disk, hence the narrow alphabet;
   the engine applies the same rule and is the one that counts. */
function csSlug(name) {
  return String(name || "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "").slice(0, 32).replace(/[-_]+$/, "");
}

/* "--paper --label \"two words\"" as the argument list the engine wants:
   split on spaces, with double quotes keeping a phrase together. A list, not
   a command line: nothing here is ever handed to a shell. */
function csSplitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/* The path as pasted, without the quotes Windows "Copy as path" wraps it in. */
function csCleanPath(text) {
  const t = String(text || "").trim();
  return t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === '"' || t[0] === "'")
    ? t.slice(1, -1).trim() : t;
}

/* Checks that save a round trip. {message, field} for the first thing wrong,
   or null. The engine repeats every one of them; these are not the gate. */
function csValidateOwnBroker(draft, taken) {
  const name = String(draft.name || "").trim();
  if (!name) return { field: "name", message: "Give the broker a name." };
  const id = csSlug(name);
  if (id.length < 2) {
    return { field: "name",
             message: "The name needs at least two letters or digits." };
  }
  if (taken && taken.has(id)) {
    return { field: "name",
             message: `"${id}" is already in use. Choose another name.` };
  }
  const path = csCleanPath(draft.path);
  if (!path) {
    return { field: "path",
             message: "Paste the full path to the adapter's .py file." };
  }
  if (!/\.py$/i.test(path)) {
    return { field: "path",
             message: "The adapter must be a Python file ending in .py." };
  }
  if (csSplitArgs(draft.args).length > 30) {
    return { field: "args", message: "At most 30 arguments." };
  }
  return null;
}

/* Every ID a new link cannot take: what the engine lists, what the directory
   lists, and the names the engine keeps for itself. */
function csTakenIds() {
  const taken = new Set(["paper", "paper-fast", "novafx", "lse-sim", "lse-hosted"]);
  for (const b of brokerPicker.rows || []) taken.add(b.broker);
  for (const d of connScreen.dir || []) if (d && d.key) taken.add(d.key);
  return taken;
}

/* How a handshake's mode reads in a sentence. Anything that is not exactly
   "paper" is real money as far as this screen is concerned. */
function csModeWords(mode) {
  const m = String(mode || "");
  if (m === "paper") return "paper trading";
  if (m === "live") return "a LIVE account: real money";
  return `mode "${m || "unknown"}", treated as real money`;
}

/* Ask the engine to link an adapter. Resolves to {ok, row} or
   {ok: false, message, stderr, update}; never throws. An engine from before
   this feature has no such route and answers 404 or 405 (its static file
   mount refuses the POST), which is said as what it is: update the terminal. */
async function csLinkBroker(body) {
  let r;
  try {
    r = await fetch("/api/broker/link", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, message: "The terminal's engine did not answer. Try again." };
  }
  const out = await readResult(r);
  // 405: an older engine's static file mount refusing the POST. 404 without
  // this route's own answer shape (it always sends `stderr`): the same thing
  // from an engine that routes it differently. A 404 WITH that shape is this
  // engine saying the example is not in its kit, which is a real answer.
  if (r.status === 405 || (r.status === 404 && !("stderr" in out))) {
    return { ok: false, update: true,
             message: "This terminal's engine is older than its interface. " +
                      "Update the terminal to add your own broker." };
  }
  if (!r.ok) {
    return { ok: false, stderr: String(out.stderr || ""),
             message: String(out.detail || `The engine refused (HTTP ${r.status}).`) };
  }
  return { ok: true, row: out };
}

/* Run one link attempt from the form or from an example button, and leave the
   screen saying what happened: the new row open with the adapter's own name
   and mode, or the adapter's own error and the end of its stderr in place. */
async function csSubmitLink(body) {
  if (connScreen.addBusy) return;
  connScreen.addBusy = true;
  connScreen.addError = null;
  renderConnScreen(true);
  const res = await csLinkBroker(body);
  connScreen.addBusy = false;
  if (!res.ok) {
    connScreen.addError = { message: res.message, stderr: res.stderr || "",
                            update: !!res.update };
    if (res.update) connScreen.linkOld = true;
    renderConnScreen(true);
    return;
  }
  const row = res.row || {};
  connScreen.addOpen = false;
  connScreen.addDraft = { name: "", path: "", args: "" };
  connScreen.broker = row.broker || body.name;
  connScreen.brokerPinned = true;
  connScreen.notes[connScreen.broker] =
    `Added. It calls itself "${brokerDisplayName(row)}" and reports ` +
    `${csModeWords(brokerIdentity(row).mode || row.mode)}.`;
  await refreshConnScreen();
  renderConnScreen(true);
}

/* ── A real broker this terminal ships an adapter for ──────────────────────
   Before it is linked it is a row of its own: its name, what it deals, the
   boxes its key form asks for and where to make that key. Connect links it
   (as "my-<key>", an ordinary profile of the user's own), stores what was
   typed on this machine and connects, in that order, from one press. After
   that it is the user's own row (csBrokerRow), in the same place. */

// The row's key while it is not linked: a ":" is never part of a profile ID
// (csSlug), so it cannot collide with a broker's name.
function csExampleKey(x) {
  return "example:" + String((x && x.key) || "");
}

function csExampleRow(x, open) {
  const key = csExampleKey(x);
  const name = String(x.name || x.label || x.key);
  const fields = (Array.isArray(x.form) ? x.form : []).filter((f) => f && f.key && f.type !== "none");
  const wrap = document.createElement("div");
  wrap.className = "cs-brow cs-native" + (open ? " open" : "");
  wrap.dataset.example = x.key;
  const head = document.createElement("button");
  head.className = "cs-bhead";
  const mark = document.createElement("span");
  mark.className = "cs-pickmark";
  if (x.logo) {
    // The broker's own mark, shipped inline by the engine, in a tile like the
    // other rows' marks.
    mark.classList.add("logo-tile");
    const img = document.createElement("img");
    img.src = String(x.logo);
    img.alt = "";
    mark.appendChild(img);
  } else {
    const init = document.createElement("span");
    init.className = "cs-pickinit";
    init.textContent = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
    mark.appendChild(init);
  }
  const mid = document.createElement("span");
  mid.className = "cs-bheadmid";
  const line = document.createElement("span");
  line.className = "cs-pickline";
  const nm = document.createElement("span");
  nm.className = "cs-pickname";
  nm.textContent = name;
  line.appendChild(nm);
  mid.appendChild(line);
  if (x.about) {
    const tg = document.createElement("span");
    tg.className = "cs-btag";
    tg.textContent = String(x.about);
    mid.appendChild(tg);
  }
  const st = document.createElement("span");
  st.className = "cs-pickstate";
  st.textContent = "Not set up";
  const caret = document.createElement("span");
  caret.className = "cs-pickcaret";
  head.append(mark, mid, st, caret);
  head.onclick = (ev) => {
    ev.stopPropagation();
    connScreen.broker = open ? "" : key;      // clicking the open row closes it
    connScreen.brokerPinned = true;
    csDraftDrop();
    if (!open) connScreen.addFocus = fields.length ? "cred:" + key + ":" + fields[0].key : "";
    renderConnScreen(true);
  };
  wrap.appendChild(head);
  // Our listing's statement of this broker's terms, before it is ever run.
  const terms = csTermsLine(x.terms);
  if (terms) wrap.appendChild(terms);
  if (!open) return wrap;

  const card = document.createElement("div");
  card.className = "cs-bcard cs-bcard-in";
  // What the row calls the credential its boxes ask for ("API token" on a
  // row whose one box is the token), so the card's words match the boxes.
  const keyName = String(x.key_name || "API key");
  const what = document.createElement("div");
  what.className = "cs-note";
  what.textContent = `Connect your own ${name} account with your own ${keyName}. It is kept on ` +
    `this computer and handed only to the ${name} connector running here.`;
  card.appendChild(what);
  const help = csKeysHelp(x);
  if (help) card.appendChild(help);
  const form = document.createElement("div");
  form.className = "cs-form";
  const inputs = {};
  for (const f of fields) {
    const lab = document.createElement("label");
    lab.textContent = f.label || f.key;
    const inp = document.createElement("input");
    // a hidden field is a key box no browser offers to save (csSecretBox)
    if (f.type === "password") csSecretBox(inp);
    else inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.dataset.cred = f.key;
    inp.dataset.csField = "cred:" + key + ":" + f.key;
    inp.value = csDraft(key, f.key);
    inp.oninput = () => csDraftSet(key, f.key, inp.value);
    lab.appendChild(inp);
    inputs[f.key] = inp;
    form.appendChild(lab);
  }
  card.appendChild(form);
  const err = document.createElement("div");
  err.className = "cs-err hidden";
  const tail = document.createElement("div");
  tail.className = "cs-errtail hidden";
  const failed = connScreen.errors[key];
  if (failed) {
    err.textContent = String(failed.message || "");     // text only: may be the adapter's words
    err.classList.remove("hidden");
    if (failed.stderr) {
      tail.textContent = String(failed.stderr);
      tail.classList.remove("hidden");
    }
  }
  const actions = document.createElement("div");
  actions.className = "cs-bactions";
  const go = document.createElement("button");
  go.className = "cs-connect";
  go.textContent = connScreen.addBusy ? "Connecting…" : "Connect";
  go.disabled = !!connScreen.addBusy;
  go.onclick = () => csNativeConnect(x, inputs);
  actions.appendChild(go);
  for (const inp of Object.values(inputs)) {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
  }
  card.append(actions, err, tail);
  wrap.appendChild(card);
  return wrap;
}

/* What a listed row's link calls the credential its boxes ask for: the name
   exactly as the row gives it, its words and their case, with its spaces
   tidied; only a leading "your", "a", "an" or "the" (in any case) is dropped,
   because the link already reads "Get your <name> at <address>". A row that
   gives no name (or only that word) is the "API key" its boxes say. */
function csKeyLinkWords(keyName) {
  const name = String(keyName || "").trim().replace(/\s+/g, " ")
    .replace(/^(?:your|an|a|the)(?: |$)/i, "");
  return name || "API key";
}

/* How to get a listed row's key, in the row's own words, then where to make
   it (https only: the address is ours, EXAMPLES, but the rule is the one a
   broker's own link meets on this screen). Text, never markup. On the row
   before it is linked and on the user's own card after (csBrokerCard): one
   row's help says who may not use its broker's API, which is what a refused
   key most often means. null when the row gives neither. */
function csKeysHelp(x) {
  if (!x || !(x.keys_help || x.keys_url)) return null;
  const help = document.createElement("div");
  help.className = "cs-note";
  help.textContent = x.keys_help ? String(x.keys_help) + " " : "";
  if (/^https:\/\/[^\s]+$/.test(String(x.keys_url || ""))) {
    const a = document.createElement("a");
    a.className = "cs-support";
    a.href = x.keys_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `Get your ${csKeyLinkWords(x.key_name)} at ` +
      String(x.keys_url).replace(/^https:\/\//, "").replace(/\/$/, "");
    help.appendChild(a);
  }
  return help;
}

/* The row this terminal lists that a profile was linked from (its
   `example`), or null: a profile of the user's own adapter has none. */
function csListedRow(hub) {
  const ex = hub && hub.example;
  if (!ex) return null;
  return (connScreen.examples || []).find((r) => r && r.key === ex) || null;
}

/* Connect on a row that is not linked yet: link, store, connect. Every box
   is needed the first time (nothing is stored yet). What was typed is read
   once, before anything repaints, and follows the profile it now belongs to,
   so the linked row's boxes hold it through the repaint until it is saved.
   The storing and connecting are the linked row's own (csConnect), so the
   live-money question and arming stay on their one path. */
async function csNativeConnect(x, inputs) {
  if (connScreen.addBusy) return;
  const key = csExampleKey(x);
  const id = csSlug("my-" + x.key);
  const fields = (Array.isArray(x.form) ? x.form : []).filter((f) => f && f.key && f.type !== "none");
  const typed = {};
  for (const f of fields) typed[f.key] = String((inputs[f.key] && inputs[f.key].value) || "").trim();
  const missing = fields.filter((f) => !typed[f.key]);
  if (missing.length) {
    const names = csListWords(missing.map((f) => f.label || f.key));
    connScreen.errors[key] = { message: `Type your ${names}, then press Connect.` };
    connScreen.addFocus = "cred:" + key + ":" + missing[0].key;
    renderConnScreen(true);
    return;
  }
  connScreen.addBusy = true;
  delete connScreen.errors[key];
  renderConnScreen(true);
  try {
    const res = await csLinkBroker({ name: id, example: x.key });
    if (!res.ok) {
      connScreen.errors[key] = { message: res.message, stderr: res.stderr || "" };
      return;
    }
    for (const [k, v] of Object.entries(typed)) csDraftSet(id, k, v);
    csDraftDrop(key);
    connScreen.broker = id;
    connScreen.brokerPinned = true;
    await refreshConnScreen();
    const hub = (brokerPicker.rows || []).find((b) => b.broker === id) || null;
    const boxes = {};
    for (const [k, v] of Object.entries(typed)) boxes[k] = { value: v };
    try {
      const out = await csConnect(id, hub, boxes, []);
      csDraftDrop(id);
      if (out && out.ok === false) throw new Error(out.error || "the broker did not connect");
    } catch (e) {
      connScreen.errors[id] = { message: String((e && e.message) || e) };
    }
  } finally {
    connScreen.addBusy = false;
    await refreshConnScreen();
    renderConnScreen(true);
  }
}

/* ── The starter adapter and this computer's test ──────────────────────────
   The card under "+ Add your own broker" says what an adapter is, links the
   walkthrough's steps and the starter file, and shows the one command that
   tests that file on this computer. The command is the engine's (GET
   /api/broker/own-guide): only the engine knows which Python runs an adapter
   here and where its SDK is, and it quotes the paths for the shell they are
   pasted into. Its answer cannot change while the engine runs: asked once. */
const CS_GUIDE_ID = "gd-add-your-own-broker";   // gdSlug("Add your own broker")

async function csLoadOwnGuide() {
  if (connScreen.ownGuide !== undefined) return;
  connScreen.ownGuide = null;                   // asked, not answered yet
  let g = null;
  try {
    const r = await fetch("/api/broker/own-guide");
    if (r.ok) g = await r.json();
  } catch (e) { /* the card says so (csTestHelp) */ }
  connScreen.ownGuide = g && typeof g === "object" ? g : { failed: true };
  if (connScreen.addOpen) renderConnScreen(true);
}

/* What the developers' fold says, from the engine's answer: {cmd, steps,
   note} for this computer's shell, or {none} saying why there is no command;
   null while the engine has not answered. The steps are three short lines a
   person can follow; the naming rule is a note with its names set as code. */
function csTestHelp(g) {
  if (g === null || g === undefined) return null;
  if (g.failed) {
    return { none: "The terminal's engine did not say how to test an adapter " +
                   "here. Close this card and open it again." };
  }
  if (!g.python || !g.python_version) {
    return { none: "Testing an adapter needs Python 3.10 or newer, and none was " +
                   "found on this computer. " +
                   (g.platform === "win32"
                     ? 'Install it with "Add python.exe to PATH" ticked, then restart the terminal.'
                     : "Install it, then restart the terminal.") };
  }
  if (!g.python_ok) {
    return { none: "Testing an adapter needs Python 3.10 or newer. The Python " +
                   `this terminal found is ${g.python_version}.` };
  }
  const win = g.platform === "win32";
  const mac = g.platform === "darwin";
  const cmd = g.commands ? String((win ? g.commands.windows : g.commands.posix) || "") : "";
  if (!cmd) {
    return { none: "This terminal has no broker kit to test with. Update the terminal." };
  }
  const file = String(g.file || "my_broker_adapter.py");
  // The window to type it in, named so that it cannot be read as this app
  // (everywhere else "the terminal" is the LSE Terminal), opened in the
  // folder the file is in; the command names the file bare.
  const open = win
    ? "In File Explorer, open the folder with the file, right-click inside it and choose " +
      "“Open in Terminal” (Windows 10: Shift + right-click, “Open PowerShell window here”)."
    : mac
      ? "Open the Mac's own Terminal app (Applications, then Utilities), type cd, a space and " +
        "the folder's path, and press Enter."
      : "Open a shell window in the folder with the file.";
  return {
    cmd,
    steps: [open, "Copy the command, paste it there and press Enter.",
            "It passed if the last line ends with 0 fail."],
    note: [
      "It tests the file named ", { code: file }, " in that folder. Each key box reaches the file as ",
      { code: "BRUE_CRED_" }, " and the box's key in capitals: if you change the file's key boxes, " +
      "change those names in the command (a username box is ", { code: "BRUE_CRED_USERNAME" }, ").",
      win ? " The keys it sets stay in that PowerShell window until you close it." : "",
      ` Adapters run here with Python ${g.python_version}.`],
  };
}

/* The command onto the clipboard. Where the page may not write there (a
   browser on a plain http address that is not this computer), the command
   is selected instead, for the keyboard's own copy. */
function csCopyCommand(text, codeEl, btn) {
  const said = (word) => {
    btn.textContent = word;
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  };
  const select = () => {
    try { window.getSelection().selectAllChildren(codeEl); } catch (e) { /* nothing to select with */ }
    said("Selected");
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => said("Copied"), select);
  } else {
    select();
  }
}

function csTestBlock(g) {
  const box = document.createElement("div");
  box.className = "cs-test";
  const t = csTestHelp(g);
  if (!t) {
    const wait = document.createElement("div");
    wait.className = "cs-note";
    wait.textContent = "Reading this computer's Python…";
    box.appendChild(wait);
    return box;
  }
  if (t.none) {
    const no = document.createElement("div");
    no.className = "cs-note cs-said";
    no.id = "cs-test-none";
    no.textContent = t.none;
    box.appendChild(no);
    return box;
  }
  const list = document.createElement("ol");
  list.className = "cs-devsteps";
  for (const line of t.steps) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  // The command in a well, Copy in its corner.
  const row = document.createElement("div");
  row.className = "cs-testrow";
  const code = document.createElement("code");
  code.className = "cs-testcmd";
  code.id = "cs-test-cmd";
  code.textContent = t.cmd;                 // text only: it holds paths
  const copy = document.createElement("button");
  copy.className = "cs-copy";
  copy.id = "cs-test-copy";
  copy.textContent = "Copy";
  copy.onclick = () => csCopyCommand(t.cmd, code, copy);
  row.append(code, copy);
  const note = document.createElement("p");
  note.className = "cs-devnote";
  for (const part of t.note) {
    if (!part) continue;
    if (typeof part === "string") note.appendChild(document.createTextNode(part));
    else {
      const c = document.createElement("code");
      c.textContent = part.code;
      note.appendChild(c);
    }
  }
  box.append(list, row, note);
  return box;
}

function csAddBrokerRow() {
  const wrap = document.createElement("div");
  wrap.className = "cs-brow cs-add" + (connScreen.addOpen ? " open" : "");
  // The row's face: a + in the house green, what it is, and one line saying
  // what it is for. It reads as an action, not as a footnote.
  const head = document.createElement("button");
  head.className = "cs-addhead";
  head.id = "cs-add-open";
  const plus = document.createElement("span");
  plus.className = "cs-addplus";
  plus.textContent = "+";
  const hmid = document.createElement("span");
  hmid.className = "cs-addheadmid";
  const htitle = document.createElement("span");
  htitle.className = "cs-addtitle";
  htitle.textContent = "Add your own broker";
  const hsub = document.createElement("span");
  hsub.className = "cs-addsub";
  hsub.textContent = "Connect a broker we don't list, with your own API keys.";
  hmid.append(htitle, hsub);
  const caret = document.createElement("span");
  caret.className = "cs-pickcaret";
  head.append(plus, hmid, caret);
  head.onclick = (ev) => {
    ev.stopPropagation();
    connScreen.addOpen = !connScreen.addOpen;
    connScreen.addError = null;
    // The cursor waits for step 2 until step 1 is done: the first thing to do is step 1's.
    connScreen.addFocus = connScreen.addOpen && (connScreen.addSaved || connScreen.addDownloaded) ? "name" : "";
    // An engine that did not answer is asked again when the card reopens.
    if (connScreen.addOpen && connScreen.ownGuide && connScreen.ownGuide.failed) {
      connScreen.ownGuide = undefined;
    }
    renderConnScreen(true);
  };
  wrap.appendChild(head);
  if (!connScreen.addOpen) return wrap;

  const card = document.createElement("div");
  card.className = "cs-bcard cs-bcard-in cs-addcard";

  const err = document.createElement("div");
  err.className = "cs-err hidden";
  err.id = "cs-add-err";
  const tail = document.createElement("div");
  tail.className = "cs-errtail hidden";
  tail.id = "cs-add-stderr";
  const showError = (e) => {
    if (!e) return;
    err.textContent = e.message;       // the adapter's own words: text only
    err.classList.remove("hidden");
    if (e.stderr) {
      tail.textContent = e.stderr;
      tail.classList.remove("hidden");
    }
  };

  if (connScreen.linkOld) {
    // The interface can be newer than the engine it talks to. Nothing typed
    // here could be sent anywhere, so the only control is the fix.
    const old = document.createElement("div");
    old.className = "cs-bupd";
    old.textContent = "This terminal's engine is older than its interface. " +
                      "Update the terminal to add your own broker.";
    const acts = document.createElement("div");
    acts.className = "cs-bactions";
    const upd = document.createElement("button");
    upd.className = "cs-connect";
    upd.textContent = "Update terminal";
    upd.onclick = () => startAppUpdate();
    acts.appendChild(upd);
    card.append(old, acts);
    wrap.appendChild(card);
    return wrap;
  }

  // The brokers this terminal ships an adapter for are rows of their own at
  // the top of the list (csExampleRow); this door is for an adapter the user
  // brings: a broker we do not ship yet, or their own program. Three numbered
  // steps, each a title, one or two plain sentences and its one action; the
  // developers' test sits folded at the foot.
  const g = connScreen.ownGuide;
  const plat = (g && g.platform) || "";
  const win = plat ? plat === "win32" : /win/i.test(navigator.platform || "");
  const mac = plat ? plat === "darwin" : /mac/i.test(navigator.platform || "");
  const para = (text, cls) => {
    const el = document.createElement("p");
    el.className = cls || "cs-steptext";
    el.textContent = text;
    return el;
  };
  const steps = document.createElement("ol");
  steps.className = "cs-steps";
  const started = !!(connScreen.addSaved || connScreen.addDownloaded);
  const stepState = (n) => (n === 1 ? (started ? "done" : "current")
                            : n === 2 ? (started ? "current" : "") : "");
  const step = (n, title, ...body) => {
    const li = document.createElement("li");
    const st = stepState(n);
    li.className = "cs-step" + (st ? " " + st : "");
    const num = document.createElement("span");
    num.className = "cs-stepnum";
    num.textContent = st === "done" ? "\u2713" : String(n);
    const main = document.createElement("div");
    main.className = "cs-stepmain";
    const t = document.createElement("div");
    t.className = "cs-steptitle";
    t.textContent = title;
    main.append(t, ...body);
    li.append(num, main);
    steps.appendChild(li);
  };

  // 1. The starter file, and the walkthrough's full steps beside it. The
  // download is a plain link with `download`: a browser saves it, and in the
  // desktop window it meets Electron's default for a download with no
  // will-download handler, a Save dialog (desktop/main.js sets none). Same
  // window, so the shell's new-window handler is not involved.
  const dlRow = document.createElement("div");
  dlRow.className = "cs-steprow";
  const savedTo = connScreen.addSaved;
  if (g && g.template === false) {
    dlRow.appendChild(para("This terminal's kit has no starter adapter. Update the terminal.",
                           "cs-steptext cs-stepwarn"));
  } else if (savedTo) {
    // Created: where it is, and the way to it.
    const where = document.createElement("div");
    where.className = "cs-saved";
    where.id = "cs-add-saved";
    const lab = document.createElement("span");
    lab.textContent = savedTo.existing ? "Already in your folder:" : "Saved to:";
    const code = document.createElement("code");
    code.textContent = String(savedTo.path || "");
    where.append(lab, code);
    const reveal = document.createElement("button");
    reveal.className = "cs-btn cs-btn-ghost";
    reveal.id = "cs-add-reveal";
    reveal.textContent = "Open folder";
    reveal.onclick = async () => {
      reveal.disabled = true;
      try {
        const r = await fetch("/api/broker/template/reveal", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "HTTP " + r.status);
      } catch (e) {
        connScreen.addError = { message: "The folder could not be opened here (" + String(e.message || e) +
                                         "). The file is at the path shown." };
        renderConnScreen(true);
        return;
      }
      reveal.disabled = false;
    };
    dlRow.append(where, reveal);
  } else {
    const make = document.createElement("button");
    make.className = "cs-btn cs-btn-primary";
    make.id = "cs-add-make";
    make.textContent = "Create my starter adapter";
    make.onclick = async () => {
      make.disabled = true;
      make.textContent = "Creating\u2026";
      try {
        const r = await fetch("/api/broker/template/save", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || "HTTP " + r.status);
        connScreen.addSaved = body;
        if (!String(connScreen.addDraft.path || "").trim()) connScreen.addDraft.path = String(body.path || "");
        connScreen.addFocus = "name";
      } catch (e) {
        connScreen.addError = { message: "The starter adapter could not be created: " + String(e.message || e) };
      }
      renderConnScreen(true);
    };
    const dl = document.createElement("a");
    dl.className = "cs-steplink cs-steplink-plain";
    dl.id = "cs-add-template";
    dl.href = "/api/broker/template";
    dl.setAttribute("download", "my_broker_adapter.py");
    dl.textContent = "or download it";
    dl.addEventListener("click", () => {
      connScreen.addDownloaded = true;
      setTimeout(() => renderConnScreen(true), 400);
    });
    dlRow.append(make, dl);
  }
  const how = document.createElement("a");
  how.className = "cs-steplink";
  how.id = "cs-add-how";
  how.href = "#" + CS_GUIDE_ID;
  how.textContent = "Read the step-by-step guide";
  how.onclick = (ev) => {
    ev.preventDefault();
    closeConnScreen();
    gdOpenAt(CS_GUIDE_ID);
  };
  const guideRow = document.createElement("div");
  guideRow.className = "cs-steprow";
  guideRow.appendChild(how);
  step(1, "Get the starter adapter",
       para(savedTo ? "It is ready, and step 2 already points at it."
                    : "A starter file that links the terminal to a broker. It runs on practice prices " +
                      "straight away, so you can try every step before it is set up for your broker."),
       dlRow, guideRow);

  // 2. Name it and point the terminal at the file.
  const form = document.createElement("div");
  form.className = "cs-form cs-addform";
  const draft = connScreen.addDraft;
  const submit = () => {
    const bad = csValidateOwnBroker(draft, csTakenIds());
    if (bad) {
      connScreen.addError = { message: bad.message };
      connScreen.addFocus = bad.field;
      renderConnScreen(true);
      return;
    }
    const body = { name: csSlug(draft.name), description: draft.name.trim(),
                   python_file: csCleanPath(draft.path) };
    const args = csSplitArgs(draft.args);
    if (args.length) body.args = args;
    csSubmitLink(body);
  };
  const field = (key, label, placeholder, hint, into) => {
    const lab = document.createElement("label");
    lab.className = "cs-field";
    const cap = document.createElement("span");
    cap.className = "cs-fieldlabel";
    cap.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.placeholder = placeholder;
    inp.dataset.csField = key;
    inp.value = draft[key] || "";
    inp.disabled = connScreen.addBusy;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    lab.append(cap, inp);
    if (hint) lab.appendChild(hint);
    (into || form).appendChild(lab);
    return inp;
  };
  const idHint = document.createElement("span");
  idHint.className = "cs-fhelp";
  idHint.id = "cs-add-id";
  const showId = () => {
    const id = csSlug(draft.name);
    idHint.textContent = id ? `Shown in your list of brokers, saved on this computer as ${id}.`
                            : "Shown in your list of brokers.";
  };
  let go = null;
  const ready = () => !!(String(draft.name || "").trim() && String(draft.path || "").trim());
  const nameIn = field("name", "Broker name", "e.g. Acme Markets", idHint);
  nameIn.oninput = () => { draft.name = nameIn.value; showId(); if (go) go.disabled = connScreen.addBusy || !ready(); };
  const pathHint = document.createElement("span");
  pathHint.className = "cs-fhelp";
  pathHint.textContent = savedTo
    ? "Filled in for you: the file step 1 created."
    : "Step 1 fills this in. Downloaded the file instead? " + (win
      ? "In File Explorer, right-click it, choose \u201cCopy as path\u201d and paste it here."
      : mac
        ? "In Finder, hold Option, right-click it, choose \u201cCopy as Pathname\u201d and paste it here."
        : "Paste its full path here.");
  // A pasted path: the desktop shell has no file dialog to offer, and a
  // browser file input does not reveal where a file lives.
  const pathIn = field("path", "Adapter file", "No file yet", pathHint);
  pathIn.oninput = () => { draft.path = pathIn.value; if (go) go.disabled = connScreen.addBusy || !ready(); };
  // Arguments are for an adapter that takes them; the starter takes none.
  const more = document.createElement("details");
  more.className = "cs-more";
  if (draft.args) more.open = true;
  const moreSum = document.createElement("summary");
  moreSum.textContent = "More options";
  more.appendChild(moreSum);
  const argsHint = document.createElement("span");
  argsHint.className = "cs-fhelp";
  argsHint.textContent = "Words the terminal passes to the adapter when it starts it. The starter needs none.";
  const argsIn = field("args", "Arguments", "none needed for the starter adapter", argsHint, more);
  argsIn.oninput = () => { draft.args = argsIn.value; };
  form.appendChild(more);
  showId();

  const acts = document.createElement("div");
  acts.className = "cs-steprow";
  go = document.createElement("button");
  go.className = "cs-btn cs-btn-primary";
  go.id = "cs-add-go";
  go.textContent = connScreen.addBusy ? "Testing\u2026" : "Test and add";
  go.disabled = connScreen.addBusy || !ready();
  go.onclick = submit;
  const cancel = document.createElement("button");
  cancel.className = "cs-btn cs-btn-ghost";
  cancel.textContent = "Cancel";
  cancel.disabled = connScreen.addBusy;
  cancel.onclick = () => {
    connScreen.addOpen = false;
    connScreen.addError = null;
    renderConnScreen(true);
  };
  acts.append(go, cancel);
  step(2, "Add it to the terminal",
       para("Name it and point the terminal at the file. The terminal runs the file once " +
            "to check it before adding it."),
       form, acts, err, tail);

  // 3. What comes next happens on the new row, not here.
  const live = document.createElement("a");
  live.className = "cs-steplink";
  live.href = "#" + CS_GUIDE_ID;
  live.textContent = "Set it up for your broker";
  live.onclick = (ev) => { ev.preventDefault(); closeConnScreen(); gdOpenAt(CS_GUIDE_ID); };
  const liveRow = document.createElement("div");
  liveRow.className = "cs-steprow";
  liveRow.appendChild(live);
  step(3, "Connect",
       para("It appears in your list of brokers above. Open it, type your API key and " +
            "secret, and press Connect. Until the file is set up for your broker it only " +
            "uses practice prices, so any key works for a test."),
       liveRow);
  card.appendChild(steps);

  // For developers: the kit's test of an adapter, run on this computer.
  const dev = document.createElement("details");
  dev.className = "cs-dev";
  dev.id = "cs-dev";
  dev.open = !!connScreen.devOpen;       // the card is rebuilt on every repaint
  dev.ontoggle = () => { connScreen.devOpen = dev.open; };
  const devSum = document.createElement("summary");
  devSum.textContent = "For developers: test your adapter on this computer";
  dev.append(devSum, csTestBlock(g));
  card.appendChild(dev);
  csLoadOwnGuide();          // asked once per run; repaints this card when answered

  showError(connScreen.addError);
  wrap.appendChild(card);
  return wrap;
}

/* Unlink a broker the user linked: confirm, disconnect, remove the profile
   and its saved keys, and move anything that was pointed at it somewhere that
   still exists. Only ever offered on a row the hub marks `registered`. */
async function csUnlinkBroker(key, hub) {
  const name = brokerDisplayName(hub);
  // a request out or held on it: asked first (tpxHeldAsk), then the unlink's own question
  if (!(await tpxHeldAsk(key, "Unlink"))) return;
  const ok = await askConfirm(
    `Unlink ${name} (${key})? It is disconnected and its saved keys on this ` +
    `machine are removed. The adapter file itself is not touched.`,
    "Unlink", "Cancel");
  if (!ok) return;
  const wasSource = state.provider === "broker:" + key;
  // The ticket leaves first, the same way Disconnect does it, so it never
  // sits on a broker that is about to stop existing.
  if (hub && hub.connected) await brokerDisconnect(key);
  let r;
  try {
    r = await fetch("/api/broker/unlink", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: key, forget: true }),
    });
  } catch (e) { r = null; }
  if (!r || !r.ok) {
    const out = r ? await readResult(r) : {};
    const old = r && (r.status === 405
      || (r.status === 404 && (!out.detail || out.detail === "Not Found")));
    connScreen.errors[key] = {
      message: old
        ? "This terminal's engine is older than its interface. Update the terminal to unlink a broker."
        : String(out.detail || "The broker could not be unlinked."),
    };
    await refreshConnScreen();
    renderConnScreen(true);
    return;
  }
  delete connScreen.notes[key];
  delete connScreen.errors[key];
  delete connScreen.keysOpen[key];
  csDraftDrop(key);
  connScreen.broker = "";
  try { await refreshProviders(); } catch (e) { /* the list below still repaints */ }
  if (wasSource) enterLiveSource(state.lastDataProvider || "lse");
  await refreshConnScreen();
  renderConnScreen(true);
}

/* Forget the keys saved for a broker. Its own action with its own question:
   a stored key is never deleted as a side effect of anything else. */
async function csForgetKeys(key, name) {
  // a request out or held on it: asked first (tpxHeldAsk), then the forget's own question
  if (!(await tpxHeldAsk(key, "Forget"))) return;
  const ok = await askConfirm(
    `Forget the keys saved for ${name}? They are deleted from this machine ` +
    `and it is disconnected.`, "Forget keys", "Cancel");
  if (!ok) return;
  try {
    // An empty object WITHOUT merge is the engine's "forget everything".
    const r = await fetch("/api/broker/credentials", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker: key, values: {} }),
    });
    if (!r.ok) throw new Error((await readResult(r)).detail || r.status);
    delete connScreen.errors[key];
    connScreen.notes[key] = "Keys forgotten.";
  } catch (e) {
    connScreen.errors[key] = { message: String(e.message || e) };
  }
  delete connScreen.keysOpen[key];
  csDraftDrop(key);
  if (typeof tpb !== "undefined" && tpb.broker === key) await brokerDisconnect(key);
  await refreshConnScreen();
  renderConnScreen(true);
}

function csLseCard() {
  const card = document.createElement("div");
  card.className = "cs-lse";
  const row = document.createElement("div");
  row.className = "cs-lse-row";
  // Two candlesticks, not a status light. This connection is not something
  // you log into and it is never "off": it is the terminal's own data, always
  // there, so a green/grey indicator was answering a question nobody asks.
  const dot = document.createElement("span");
  dot.className = "cs-mark";
  // The brand mark's own geometry, straight from public/lse-favicon.svg
  // (same 200x200 viewBox, same coordinates), so this is the logo rather
  // than a drawing that resembles it: a shorter down candle beside a taller
  // up candle that opens higher.
  dot.innerHTML =
    '<svg viewBox="0 0 200 200" aria-hidden="true">'
    + '<g class="lg-down" stroke-width="9" stroke-linecap="round">'
    + '<line x1="72" y1="48" x2="72" y2="72"/>'
    + '<line x1="72" y1="128" x2="72" y2="156"/>'
    + '<rect x="52" y="72" width="40" height="56" rx="7" stroke="none"/></g>'
    + '<g class="lg-up" stroke-width="9" stroke-linecap="round">'
    + '<line x1="128" y1="38" x2="128" y2="58"/>'
    + '<line x1="128" y1="122" x2="128" y2="162"/>'
    + '<rect x="108" y="58" width="40" height="64" rx="7" stroke="none"/></g>'
    + '</svg>';
  const tile = document.createElement("span");
  tile.className = "cs-tile";
  tile.appendChild(dot);
  const mid = document.createElement("div");
  mid.className = "cs-lse-mid";
  const name = document.createElement("div");
  name.className = "cs-lse-name";
  name.textContent = "London Strategic Edge";
  const st = document.createElement("div");
  st.className = "cs-lse-state";
  st.textContent = state.lseConfigured ? "Key set \u00b7 live \u00b7 your LSE key" : "No key connected";
  mid.append(name, st);
  const act = document.createElement("div");
  act.className = "cs-lse-act";
  // Charting this source is the card's one action. The Trade button that used
  // to sit here opened the LSE demo ACCOUNT, which is a trading decision in the
  // middle of the data section; that account is now a row under BROKERS with
  // every other venue, so each section does one thing.
  const inUse = state.provider === "lse";
  if (state.lseConfigured && inUse) {
    const pill = document.createElement("span");
    pill.className = "cs-pill ok";
    pill.textContent = "In use";
    act.appendChild(pill);
  } else if (state.lseConfigured) {
    const useBtn = document.createElement("button");
    useBtn.className = "cs-act";
    useBtn.textContent = "Use";
    useBtn.onclick = () => { closeConnScreen(); enterLiveSource("lse"); };
    act.appendChild(useBtn);
  }
  const keyBtn = document.createElement("button");
  keyBtn.className = state.lseConfigured ? "cs-act" : "cs-act primary";
  keyBtn.textContent = state.lseConfigured ? "Change key" : "Add key";
  act.appendChild(keyBtn);
  if (state.lseConfigured) {
    // Total sign-out: key, live data and the demo account that comes with
    // the key leave together; the view restarts as a no-key boot.
    const outBtn = document.createElement("button");
    outBtn.className = "cs-act";
    outBtn.textContent = "Sign out";
    outBtn.onclick = async () => {
      outBtn.disabled = true;
      try { await fetch("/api/config/lse_key", { method: "DELETE" }); } catch (e) { /* reload shows the truth */ }
      location.reload();
    };
    act.append(outBtn);
  }
  row.append(tile, mid, act);

  const keyline = document.createElement("div");
  keyline.className = "cs-keyline hidden";
  // a key box no browser offers to save (csSecretBox)
  const input = csSecretBox(document.createElement("input"));
  input.placeholder = "lse_live_...";
  const save = document.createElement("button");
  save.textContent = "Save";
  keyline.append(input, save);
  const err = document.createElement("div");
  err.className = "cs-err hidden";

  keyBtn.onclick = () => {
    keyline.classList.toggle("hidden");
    if (!keyline.classList.contains("hidden")) input.focus();
  };
  const doSave = async () => {
    const key = input.value.trim();
    if (!key) return;
    save.disabled = true;
    err.classList.add("hidden");
    try {
      await saveLseKey(key);   // same save + live proof the dropdown uses
      renderConnBar();
      enterLiveSource("lse");
      renderConnScreen();      // repaint the card as connected
    } catch (e2) {
      err.textContent = String(e2.message || e2);
      err.classList.remove("hidden");
      save.disabled = false;
    }
  };
  save.onclick = doSave;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSave(); });

  card.append(row, keyline, err);
  return card;
}

/* An announcement, not a control: names what the section will offer next
   without pretending it is connectable today.
   Deliberately NOT a card: one dim line under the section, no border,
   no button. */

/* The commercial door, bottom right of the whole screen:
   the one red thing on the surface, one word. Opens the broker inquiry form. */
function csInquireFoot() {
  const foot = document.createElement("div");
  foot.id = "cs-foot";
  // For a broker FIRM that wants to be listed (the form asks for the firm,
  // its regulator and a work email), said in words, in this screen's link
  // style, rather than one orange word in capitals.
  const btn = document.createElement("button");
  btn.id = "inq-open";
  btn.textContent = "Are you a broker? Ask to be listed";
  btn.onclick = openInquiry;
  foot.appendChild(btn);
  return foot;
}

// Neither LSE door is a row anyone connects: the hosted relay is what a
// hosted terminal uses, and `lse-sim`, the LSE demo account, comes with the
// LSE key (connected when the key is saved, gone when the user signs out).
// Only third-party venues belong in the venue list.
const LSE_DEMO_KEYS = new Set(["lse-hosted", "lse-sim"]);

/* A directory broker whose adapter is not in this build: the hub says so
   (update_required), or the hub does not know the broker at all, which on an
   older engine means the same thing. Either way the fix is one update. */
function csNeedsUpdate(e) {
  return !!(e.d && (!e.hub || e.hub.update_required));
}

/* Every venue the user could connect, as {key, label, d, hub} rows. Paper is
   left out on purpose: it is the built-in local simulator the platform falls
   back to, not a broker anyone chooses to connect. Ours sorts first; the rest
   keep the directory's partners-first order. */
function csBrokerEntries() {
  const out = [];
  const dir = connScreen.dir || [];
  const hubRows = brokerPicker.rows || [];
  const byKey = {};
  for (const h of hubRows) byKey[h.broker] = h;
  const seen = new Set();
  // paper is the built-in local simulator the platform falls back to, and
  // paper-fast is its accelerated-clock twin used for testing; neither is a
  // venue anyone chooses to connect, and paper-fast's own label ("paper sim,
  // 20ms ticks") read as a broken row in a list of firms.
  const hidden = new Set(["paper", "paper-fast"]);
  for (const d of dir) {
    if (LSE_DEMO_KEYS.has(d.key) || hidden.has(d.key)) continue;
    seen.add(d.key);
    out.push({ key: d.key, label: d.label || d.key, d,
               hub: byKey[d.key] || null });
  }
  for (const h of hubRows) {
    if (seen.has(h.broker) || LSE_DEMO_KEYS.has(h.broker)
        || hidden.has(h.broker)) continue;
    out.push({ key: h.broker, label: h.label || h.broker, d: null, hub: h });
  }
  out.sort((a, b) => (a.key === "lse-sim" ? -1 : 0) - (b.key === "lse-sim" ? -1 : 0));
  return out;
}


/* One broker card. Either side may be null: `d` is the directory listing (rich
   metadata, no session), `hub` is the live hub row (session state, no art). */
/* Broker-supplied strings (account labels, ids) reach the DOM as HTML here,
   so they are escaped: the label is the BROKER's text, not ours. */
const csEsc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function csBrokerCard(d, hub, opts) {
  const key = (d && d.key) || (hub && hub.broker) || "broker";
  const connected = !!(hub && hub.connected);
  const label = (d && d.label) || (hub && brokerDisplayName(hub)) || key;
  // Inside a list row the identity is already on the row's own header, so the
  // card drops its logo/name/tagline block and starts at the detail.
  const headless = !!(opts && opts.headless);

  const card = document.createElement("div");
  card.className = "cs-bcard" + (connected ? " on" : "")
    + (headless ? " cs-bcard-in" : "");

  const top = document.createElement("div");
  top.className = "cs-btop";
  const logo = document.createElement("div");
  logo.className = "cs-logo";
  const mono = (String(label).replace(/[^A-Za-z0-9]/g, "").slice(0, 2) || "?").toUpperCase();
  // The broker's own art. Prefer the INLINE logo the directory carries (a
  // self-contained data URI: renders with no extra request, works offline, and
  // never depends on the webview allowing an external image). Fall back to the
  // logo_url path prefixed with the directory's origin, then to a monogram, so
  // a card is never a blank tile. This is the one place the house "no remote
  // images" habit is relaxed: the logos are exactly the colour the neutral
  // chrome deliberately lacks.
  const logoSrc = (d && d.logo)
    || (d && d.logo_url && connScreen.origin ? connScreen.origin + d.logo_url : null)
    || csExampleLogo({ hub }) || null;
  if (logoSrc) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = logoSrc;
    img.onerror = () => { img.remove(); logo.textContent = mono; };
    logo.appendChild(img);
  } else {
    logo.textContent = mono;
  }

  const mid = document.createElement("div");
  mid.className = "cs-bmid";
  const nameRow = document.createElement("div");
  nameRow.className = "cs-bnamerow";
  const nm = document.createElement("span");
  nm.className = "cs-bname";
  nm.textContent = label;   // textContent: broker text is third-party
  nameRow.appendChild(nm);
  // No PARTNER tag and no LIVE/PAPER chip here. The tag was our label for a
  // commercial relationship, which is not a fact about the connection; and
  // whether real money is at stake belongs to the ACCOUNT, not the broker,
  // so it is stated on the account row where the decision is actually made.
  mid.appendChild(nameRow);
  const tagline = (d && d.tagline) || (hub && brokerIdentity(hub).tagline) || "";
  if (tagline) {
    const tg = document.createElement("div");
    tg.className = "cs-btag";
    tg.textContent = tagline;
    mid.appendChild(tg);
  }
  const instruments = (d && d.instruments)
    || (hub && hub.symbols ? hub.symbols.length : 0);
  if (instruments > 0) {
    const meta = document.createElement("div");
    meta.className = "cs-bmeta";
    meta.textContent = `${instruments} instruments`;
    mid.appendChild(meta);
  }
  top.append(logo, mid);
  if (!headless) card.appendChild(top);
  else if (instruments > 0) {
    // The one fact from that block worth keeping in a row: how much the venue
    // deals. Name, art and tagline are already on the row header above.
    const meta = document.createElement("div");
    meta.className = "cs-bmeta";
    meta.textContent = `${instruments} instruments`;
    card.appendChild(meta);
  }

  // What happened on this card last, in one line (a link that just
  // succeeded, keys just forgotten). Ours, or built from sanitised handshake
  // fields; text either way.
  const own = !!(hub && hub.registered);
  if (connScreen.notes[key]) {
    const n = document.createElement("div");
    n.className = "cs-note cs-said";
    n.textContent = connScreen.notes[key];
    card.appendChild(n);
  }
  if (own && Array.isArray(hub.command_preview) && hub.command_preview.length) {
    // What will be run on this machine when this broker is connected: the
    // argument list as the engine spawns it. The user linked a program, so
    // the program is shown.
    const cmd = document.createElement("div");
    cmd.className = "cs-bmeta cs-cmd";
    cmd.textContent = "Runs " + hub.command_preview.map(
      (a) => (/[\s"]/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
    card.appendChild(cmd);
  }

  // A broker that shows an access note instead of a form (fixed demo creds,
  // self-registration) says so inline.
  // The fields to type come from the directory listing when there is one,
  // else from the hub row, which carries the form the adapter's OWN handshake
  // declared (SPEC 3.2). That second source is what gives a broker the user
  // linked themselves a key form at all.
  const fields = (d && Array.isArray(d.credential_form)) ? d.credential_form
    : (hub && Array.isArray(hub.credential_form)) ? hub.credential_form : [];
  const realFields = fields.filter((f) => f && f.key && f.type !== "none");
  // Which fields already hold a value on this machine: NAMES only, from the
  // engine. null with an engine too old to say, where the form falls back to
  // its previous behaviour.
  const stored = hub && Array.isArray(hub.stored_credentials)
    ? new Set(hub.stored_credentials) : null;
  const allStored = !!stored && realFields.length > 0
    && realFields.every((f) => stored.has(f.key));
  const accessNote = d && d.extra && d.extra.access_note;
  if (accessNote && !realFields.length) {
    const note = document.createElement("div");
    note.className = "cs-note";
    note.textContent = accessNote;
    card.appendChild(note);
  }
  // The broker's own launch line and support door (directory extra.welcome
  // and extra.support). We serve the row but the words are the broker's, so
  // they land as text, and the link only when it is https or mailto: the same
  // bar SPEC 3.1 sets for adapter-supplied fields. Still no colours, no art
  // beyond the logo above.
  const extra = (d && d.extra) || {};
  if (extra.welcome) {
    const w = document.createElement("div");
    w.className = "cs-note";
    w.textContent = oneLine(extra.welcome);
    card.appendChild(w);
  }
  const support = String(extra.support || "");
  if (/^(https:\/\/|mailto:)[^\s]+$/.test(support)) {
    const s = document.createElement("a");
    s.className = "cs-support";
    s.href = support;
    s.target = "_blank";
    s.rel = "noopener";
    s.textContent = support.replace(/^mailto:/, "");
    card.appendChild(s);
  }

  // A profile linked from a row this terminal lists keeps that row's help
  // beside its boxes until it is connected (csKeysHelp): where to make the
  // key, and on one row who may not use its broker's API. It used to go with
  // the row on the very press that linked it, the one an ineligible key is
  // refused on.
  const keysHelp = connected ? null : csKeysHelp(csListedRow(hub));
  if (keysHelp) card.appendChild(keysHelp);

  // Credential form: built from the directory's field descriptors, hidden until
  // the user presses Connect on a broker that has one.
  // Saved keys are stated, never shown: which fields hold a value, with the
  // two things a person may want to do about it. A stored key is changed by
  // typing a new one and deleted only by "Forget keys".
  if (stored && stored.size && !connected) {
    const labels = [...stored].map((k) => {
      const f = realFields.find((x) => x.key === k);
      return (f && f.label) || k;
    });
    const line = document.createElement("div");
    line.className = "cs-saved";
    const txt = document.createElement("span");
    txt.textContent = `Saved on this machine: ${labels.join(", ")}.`;
    line.appendChild(txt);
    if (realFields.length) {
      const chg = document.createElement("button");
      chg.className = "cs-quiet";
      chg.textContent = connScreen.keysOpen[key] ? "Hide" : "Change";
      chg.onclick = () => {
        connScreen.keysOpen[key] = !connScreen.keysOpen[key];
        renderConnScreen(true);
      };
      line.appendChild(chg);
    }
    const fg = document.createElement("button");
    fg.className = "cs-quiet";
    fg.dataset.act = "forget";
    fg.textContent = "Forget keys";
    fg.onclick = () => csForgetKeys(key, label);
    line.appendChild(fg);
    card.appendChild(line);
  }

  // The boxes are ON SCREEN whenever this card is open and there is something
  // to type: a field with no saved value, or the user pressed Change. They
  // used to stay hidden until Connect was pressed once, so that first press
  // only revealed them and sent nothing, which read as a button that did
  // nothing; and text typed before it went nowhere at all.
  const showForm = !connected && realFields.length > 0
    && (!allStored || !!connScreen.keysOpen[key]);
  const form = document.createElement("div");
  form.className = "cs-form" + (showForm ? "" : " hidden");
  const inputs = {};
  for (const f of realFields) {
    const lab = document.createElement("label");
    lab.textContent = f.label || f.key;
    if (f.help) {
      const h = document.createElement("span");
      h.className = "cs-fhelp";
      h.textContent = f.help;
      lab.appendChild(h);
    }
    const inp = document.createElement("input");
    // a hidden field is a key box no browser offers to save (csSecretBox)
    if (f.type === "password") csSecretBox(inp);
    else inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.dataset.cred = f.key;
    // The name the rebuild finds this box by, to give it back its focus and
    // caret (renderConnScreen). Only set, never read as markup.
    inp.dataset.csField = "cred:" + key + ":" + f.key;
    // What has been typed and not yet submitted comes back after a repaint
    // (csDraft). A STORED value is never put back in the box: the box says it
    // is saved and that leaving it empty keeps it.
    inp.value = csDraft(key, f.key);
    inp.oninput = () => csDraftSet(key, f.key, inp.value);
    if (stored && stored.has(f.key)) inp.placeholder = "saved · leave blank to keep";
    lab.appendChild(inp);
    inputs[f.key] = inp;
    form.appendChild(lab);
  }
  card.appendChild(form);

  const err = document.createElement("div");
  err.className = "cs-err hidden";
  // Why the last attempt on this card failed, kept across repaints: what the
  // page itself caught, else what the engine remembers of the last failed
  // connect (the broker's own message, and for the user's own adapter the
  // end of its stderr, where a traceback lives). Both are text.
  const errTail = document.createElement("div");
  errTail.className = "cs-errtail hidden";
  const failed = connected ? null
    : (connScreen.errors[key] || (hub && hub.last_error) || null);
  // Beside a refusal: which of the broker's boxes hold nothing, typed or
  // saved. The broker's sentence may speak of variable names; this speaks of
  // the boxes on this card.
  const errEmpty = document.createElement("div");
  errEmpty.className = "cs-empty hidden";
  if (failed && failed.message) {
    const more = failed.stderr || (hub && hub.last_error && hub.last_error.stderr) || "";
    err.textContent = csFailText(failed.message, more);
    err.classList.remove("hidden");
    if (more) {
      errTail.textContent = more;
      errTail.classList.remove("hidden");
    }
    const drafts = connScreen.keyDrafts[key] || {};
    const empty = failed.required ? [] : csEmptyFields(realFields, drafts, stored);
    if (empty.length) {
      errEmpty.textContent = "Left empty: " + empty.map((f) => f.label || f.key).join(", ") + ".";
      errEmpty.classList.remove("hidden");
    }
  }
  // What the adapter printed (the engine's `printed`: its stray output and
  // the end of its stderr, its runs' latest last), kept for this card while
  // it is connected and after a run that ended with no failure to show; a
  // failed connect shows its own lines under its sentence instead. A
  // data_local_only adapter's lines go nowhere else, and the engine's own
  // log says this card shows them. Text, folded: the evidence, not the news.
  // The fold is there, hidden, before the first line, so the watch tick can
  // put new lines in it without repainting the card (csPrintedRefresh).
  let printedFold = null;
  if (!(failed && failed.message) && hub) {
    printedFold = document.createElement("details");
    printedFold.className = "cs-more cs-printed" + (hub.printed ? "" : " hidden");
    printedFold.dataset.csPrinted = hub.broker || key;
    printedFold.open = !!connScreen.printedOpen[key];
    printedFold.addEventListener("toggle", () => { connScreen.printedOpen[key] = printedFold.open; });
    const sum = document.createElement("summary");
    sum.textContent = "Lines the adapter printed";
    const lines = document.createElement("div");
    lines.className = "cs-errtail";
    lines.textContent = String(hub.printed || "");
    printedFold.append(sum, lines);
  }

  // Every account the login reaches, always visible once we know them: which
  // one your orders land on is the most consequential fact on this card, so
  // it is shown rather than hidden behind a button. The one in use is marked;
  // clicking another previews it, and clicking again switches.
  const accounts = (hub && hub.accounts) || [];
  if (accounts.length) {
    const bound = hub.account_id || "";
    // Three kinds of list. Connected: the switch (the one in use marked).
    // Waiting on the chooser the engine asked for (needs_account): the
    // chooser. Otherwise, before Connect: the accounts this login reached
    // when it was last connected, as information, not as controls. Shown
    // as buttons there, a click on one right after Connect was lost when
    // Connect repainted the card, or read as a choice of account.
    const choosing = !connected && !!hub.needs_account;
    const live = connected || choosing;
    const pick = document.createElement("div");
    pick.className = "cs-accts" + (live ? "" : " cs-accts-info");
    const head = document.createElement("div");
    head.className = "cs-accts-label";
    head.textContent = bound
      ? `Accounts (${accounts.length})`
      : `${live ? "Select an account" : "Accounts"} (${accounts.length})`;
    pick.appendChild(head);
    if (!live) {
      const n = document.createElement("div");
      n.className = "cs-note";
      n.textContent = bound
        ? "Connect uses the account used last. Once connected, click another account to switch."
        : "Press Connect, then choose one of them.";
      pick.appendChild(n);
    }
    // The chooser's first click (the preview), kept across repaints of the
    // screen, so the second click is the choice it was.
    const previewed = live && connScreen.acctPreview ? connScreen.acctPreview[key] : undefined;
    const preview = (b, a) => {
      b.classList.add("chosen");
      const pv = document.createElement("span");
      pv.className = "cs-acct-preview";
      pv.innerHTML =
        `<span class="cs-acct-line">${csEsc(a.mode === "live"
            ? "Real money. Orders must be armed before they are sent."
            : "Demo money. Orders cost nothing.")}</span>`
        + `<span class="cs-acct-go">Click again to ${bound ? "switch to" : "use"} this account</span>`;
      b.appendChild(pv);
    };

    for (const a of accounts) {
      const inUse = !!bound && a.id === bound;
      if (!live) {
        // information: the account, its words, and the one used last
        const row = document.createElement("div");
        row.className = "cs-acct cs-acct-info" + (a.mode === "live" ? " live" : " demo");
        row.innerHTML =
          `<span class="cs-acct-name">${csEsc(a.label || a.id)}</span>`
          + `<span class="cs-acct-tags">`
          + (inUse ? '<span class="cs-acct-last">Used last</span>' : "")
          + `<span class="cs-acct-tag">${a.mode === "live" ? "LIVE" : "DEMO"}</span>`
          + `</span>`
          + `<span class="cs-acct-id">${csEsc(a.id)}`
          + (a.type ? ` · ${csEsc(String(a.type).replace(/_/g, " "))}` : "")
          + `</span>`;
        pick.appendChild(row);
        continue;
      }
      const b = document.createElement("button");
      b.className = "cs-acct" + (a.mode === "live" ? " live" : " demo")
        + (inUse ? " inuse" : "");
      const money = a.balance != null
        ? Number(a.balance).toLocaleString(undefined,
            { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "";
      // Only the broker's own words. An account it labelled with nothing but
      // an id is shown as an id rather than dressed up with a guess.
      b.innerHTML =
        `<span class="cs-acct-name">${csEsc(a.label || a.id)}</span>`
        + `<span class="cs-acct-tags">`
        + (inUse ? '<span class="cs-acct-use">In use</span>' : "")
        + `<span class="cs-acct-tag">${a.mode === "live" ? "LIVE" : "DEMO"}</span>`
        + `</span>`
        + `<span class="cs-acct-id">${csEsc(a.id)}`
        + (a.type ? ` · ${csEsc(String(a.type).replace(/_/g, " "))}` : "")
        + `</span>`
        + `<span class="cs-acct-bal">${csEsc(money)}`
        + (a.currency ? ` <em>${csEsc(a.currency)}</em>` : "") + `</span>`;

      if (inUse) {
        b.disabled = true;      // already yours; nothing to decide
        pick.appendChild(b);
        continue;
      }
      if (previewed === a.id) preview(b, a);
      b.onclick = async () => {
        // First click PREVIEWS, second commits. Which account your orders
        // land on is not a thing to change by accident, and the preview is
        // where the consequence is stated plainly.
        if (!b.classList.contains("chosen")) {
          pick.querySelectorAll(".cs-acct").forEach((x) => {
            x.classList.remove("chosen");
            const p2 = x.querySelector(".cs-acct-preview");
            if (p2) p2.remove();
          });
          preview(b, a);
          if (connScreen.acctPreview) connScreen.acctPreview[key] = a.id;
          return;
        }
        if (connScreen.acctPreview) delete connScreen.acctPreview[key];
        pick.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        try {
          // Asks first while a request is out or held on this broker, and
          // points the ticket at the account once it is bound
          // (csSwitchAccount). Not now switches nothing.
          const done = await csSwitchAccount(key, a.id);
          if (!done) {
            // (the account in use stays disabled: nothing to decide there)
            pick.querySelectorAll("button").forEach((x) => { x.disabled = x.classList.contains("inuse"); });
            return;
          }
          await refreshConnScreen(true);
        } catch (e2) {
          err.textContent = String(e2.message || e2);
          err.classList.remove("hidden");
          pick.querySelectorAll("button").forEach((x) => { x.disabled = false; });
        }
      };
      pick.appendChild(b);
    }
    card.appendChild(pick);
  }

  const actions = document.createElement("div");
  actions.className = "cs-bactions";
  if (connected && !brokerIsPaper(hub)) {
    // Real money, connected. Whether this session may send it orders is the
    // most consequential fact on the card after the account, so it is a
    // sentence here, not a colour: allowed, or read-only with the one button
    // that changes it. The engine holds the rule (an unarmed broker's orders
    // come back refused); this is where the user's decision is taken to it.
    const tr = document.createElement("div");
    tr.className = "cs-trade" + (hub.armed ? " armed" : "");
    const say = document.createElement("span");
    say.textContent = hub.armed
      ? "LIVE. Trading is allowed for this session."
      : "LIVE, connected read-only. Orders are refused until you allow trading.";
    tr.appendChild(say);
    if (!hub.armed) {
      const allow = document.createElement("button");
      allow.className = "cs-connect";
      allow.dataset.act = "arm";
      allow.textContent = "Allow trading";
      allow.onclick = async () => {
        const yes = await askConfirm(
          brokerLiveQuestion(hub).replace(/Connect and allow trading\?$/, "Allow trading?"),
          "Allow trading", "Not now", hub.terms);
        if (!yes) return;
        allow.disabled = true;
        const armed = await brokerArm(key);
        if (!armed) connScreen.errors[key] = { message: "The engine did not arm this broker. Reconnect and try again." };
        await refreshConnScreen();
        renderConnBar();
      };
      tr.appendChild(allow);
    }
    card.appendChild(tr);
  }
  if (connected) {
    // "Use" points the MARKETS page at this venue: its instruments become the
    // watchlist and its prices become the chart, which is what you want to be
    // looking at while you execute there. Offered only when the venue can
    // actually serve candles (the engine registers a source for it), so an
    // order-entry-only venue never becomes a source with an empty chart.
    // Backtest and Research stay on the data connection either way.
    const src = (state.providers || []).find((p) => p.name === "broker:" + key);
    if (src) {
      const use = document.createElement("button");
      use.textContent = state.provider === src.name ? "In use" : "Use";
      use.disabled = state.provider === src.name;
      // The forward action is black like every action on this screen; "In
      // use" is a status, the same inverted pill as the LSE row's.
      use.className = use.disabled ? "cs-inuse" : "cs-primary";
      // Then MARKETS, as its own tab does it: Use pressed while another page
      // was showing (the walkthrough's "Add your own broker" steps send you
      // here from it) left that page on screen beside the chart. The source
      // is already this venue, so the tab only shows it and loads nothing.
      use.onclick = () => { closeConnScreen(); enterLiveSource(src.name); $("rail-markets").click(); };
      actions.appendChild(use);
    }
    // No "Switch account" button: every account is listed above with the one
    // in use marked, so switching is clicking the account you want. A button
    // that reopened a chooser already on screen was a second way to do the
    // same thing.
    const off = document.createElement("button");
    off.textContent = "Disconnect";
    off.onclick = async () => {
      // a request out or held on it: asked first (tpxHeldAsk)
      if (!(await tpxHeldAsk(key, "Disconnect"))) return;
      off.disabled = true;
      // Leaving the venue must not strand the markets page on a source that
      // no longer exists; fall back to the data connection it came from.
      const wasHere = state.provider === "broker:" + key;
      await brokerDisconnect(key);
      await refreshProviders();
      if (wasHere) enterLiveSource(state.lastDataProvider || "lse");
      // Its row stays open with Connect in it. It was open only because it
      // was connected, so it used to close here, and "Disconnect, then
      // Connect" (the walkthrough's step after editing an adapter) meant
      // finding the row and opening it again.
      connScreen.broker = key;
      connScreen.brokerPinned = true;
      await refreshConnScreen();
    };
    actions.appendChild(off);
  } else if (hub && hub.needs_account && (hub.accounts || []).length) {
    // The chooser IS the action. A Connect button beside it offers a second,
    // vaguer way to do the same thing and lands on the login's primary.
    // Cancel lets the waiting connection go (the engine keeps a login that
    // waits on its chooser running, logged in, for up to an hour); the card
    // then reads as linked, not connected (csCancelPending).
    // (an outline, as Disconnect is: it goes back, not forward)
    const cancel = document.createElement("button");
    cancel.dataset.act = "cancel";
    cancel.textContent = "Cancel";
    cancel.onclick = async () => {
      cancel.disabled = true;
      await csCancelPending(key);
    };
    actions.appendChild(cancel);
  } else if (csNeedsUpdate({ d, hub })) {
    // The broker is offered, the connector for it is not in this build.
    // Say so in one line and make the fix the only button.
    const note = document.createElement("div");
    note.className = "cs-bupd";
    note.textContent = "Your terminal does not have the connector for this broker yet. Update to use it.";
    card.appendChild(note);
    const upd = document.createElement("button");
    upd.className = "cs-connect";
    upd.textContent = "Update terminal";
    upd.onclick = () => startAppUpdate();
    actions.appendChild(upd);
  } else {
    const on = document.createElement("button");
    on.className = "cs-connect";
    on.textContent = "Connect";
    on.onclick = async () => {
      // Connect always means connect: the boxes are already on screen when
      // there is something to type (showForm above), so there is no first
      // press that only reveals them.
      //
      // A field the LISTING marks required, left with nothing typed and
      // nothing saved, stops here: the card names it and puts the cursor in
      // it, and nothing is sent. (A form an adapter declared itself has no
      // required flag; the adapter is asked, and its refusal is shown with
      // the boxes that were left empty: see errEmpty.)
      const typedNow = {};
      for (const f of realFields) typedNow[f.key] = showForm ? inputs[f.key].value : "";
      const missing = csMissingFields(realFields, typedNow, stored);
      if (missing.length) {
        const names = csListWords(missing.map((f) => f.label || f.key));
        connScreen.errors[key] = { required: true,
          message: `${names} ${missing.length > 1 ? "are" : "is"} required. ` +
                   `Type ${missing.length > 1 ? "them" : "it"}, then press Connect.` };
        connScreen.addFocus = "cred:" + key + ":" + missing[0].key;
        renderConnScreen(true);
        return;
      }
      on.disabled = true;
      on.textContent = "Connecting…";
      err.classList.add("hidden");
      errTail.classList.add("hidden");
      errEmpty.classList.add("hidden");
      delete connScreen.errors[key];
      delete connScreen.notes[key];
      try {
        const out = await csConnect(key, hub, showForm ? inputs : {}, stored);
        // csConnect came back, so what was typed has been handed to the
        // engine (or there was nothing to hand over): the drafts have done
        // their job and are dropped, whether or not the broker then let us
        // in. Had the save itself failed, csConnect would have thrown and
        // they would still be in the boxes.
        csDraftDrop(key);
        if (out && out.ok === false) throw new Error(out.error || "the broker did not connect");
        delete connScreen.keysOpen[key];
        await refreshConnScreen();
        renderConnScreen(true);
      } catch (e2) {
        // On the card, in the broker's own words, with Connect usable again.
        // (The reason used to go only to the ticket line, which is behind
        // this screen, and the button stayed disabled.)
        connScreen.errors[key] = { message: String(e2.message || e2) };
        err.textContent = csFailText(connScreen.errors[key].message, null);
        err.classList.remove("hidden");
        on.disabled = false;
        on.textContent = "Connect";
        // The engine's record of the failure carries the stderr tail for a
        // linked adapter; repainting from it replaces this card with one
        // that shows both.
        await refreshConnScreen();
        renderConnScreen(true);
      }
    };
    actions.appendChild(on);
  }
  if (own) {
    // Only on a row the user linked. A broker we ship or list is not theirs
    // to remove, and the engine refuses it for them too.
    const un = document.createElement("button");
    un.className = "cs-quiet cs-unlink";
    un.dataset.act = "unlink";
    un.textContent = "Unlink";
    un.onclick = () => csUnlinkBroker(key, hub);
    actions.appendChild(un);
  }
  // Enter in a key box is Connect, as it is Test and add in the form below.
  const go = actions.querySelector(".cs-connect");
  if (go && go.textContent === "Connect") {
    for (const inp of Object.values(inputs)) {
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    }
  }
  card.append(actions, err, errEmpty, errTail);
  if (printedFold) card.appendChild(printedFold);
  return card;
}

/* "Cancel" on a card waiting on its account chooser: the connection the
   engine holds open for the choice is let go, and the card reads as linked
   (Connect, no chooser). The engine keeps such a login running, logged in,
   for up to an hour (pending_auth). Until it has a route of its own for
   letting one go, the pending row is disconnected: its disconnect ends a
   login waiting on its chooser as well, so nothing of the broker is left
   running, and it puts a ticket that waited on it back as a Disconnect does
   (brokerDisconnect). Nothing was sent on it: no session was ever opened. */
async function csCancelPending(key) {
  if (connScreen.acctPreview) delete connScreen.acctPreview[key];
  try {
    await brokerDisconnect(key);
    delete connScreen.errors[key];
  } catch (e) {
    connScreen.errors[key] = { message: String((e && e.message) || e) };
  }
  connScreen.broker = key;            // its row stays open, with Connect in it
  connScreen.brokerPinned = true;
  await refreshConnScreen();
  renderConnScreen(true);
}

/* What an adapter printed since the screen was drawn, put on its card where
   it is (renderConnScreen, at the watch tick): a repaint for each new line
   threw away the account preview, the first of the chooser's two clicks, and
   any focus or open dropdown with it. The fold is found by the profile it
   names (csBrokerCard's data-cs-printed), compared, never built into a
   selector. */
function csPrintedRefresh(body) {
  for (const fold of body.querySelectorAll(".cs-printed")) {
    const name = fold.dataset.csPrinted;
    const hub = (brokerPicker.rows || []).find((b) => b.broker === name);
    const text = String((hub && hub.printed) || "");
    const lines = fold.querySelector(".cs-errtail");
    if (lines && lines.textContent !== text) lines.textContent = text;
    if (text) fold.classList.remove("hidden");
    else fold.classList.add("hidden");
  }
}

/* Why a connect failed, as a broker's card says it. The engine passes the
   protocol's code word in front of the broker's own sentence
   ("unauthorized: The API secret box is empty…"); the card shows the
   sentence (tpbPlainReason, as the ticket does). An adapter that ended
   before answering is said in words: `printed` is what it printed (shown
   under the sentence), "" when it printed nothing, null when not yet known. */
function csFailText(message, printed) {
  const said = tpbPlainReason(message);
  if (!/^adapter disconnected\.?$/.test(said.trim())) return said;
  if (printed == null) return "The adapter stopped.";
  return printed ? "The adapter stopped. The last lines it printed are below."
                 : "The adapter stopped without saying why.";
}

/* The account a broker's profile deals on, chosen on its card (the chooser's
   second click). Requests out or held on that broker went out on the
   account in use, and keep it (the engine's record): while anything is, the
   switch asks first, "<the held sentence> Switch account anyway?" (Switch /
   Not now). Not now sends nothing; Switch sends the switch with "confirm":
   true, and the engine refuses an Ask again of those requests on the other
   account (tpxOtherAccount). An engine that knows of one the page did not
   answers 409 held_requests with its own sentence, asked about the same
   way. The engine's row back, or null when nothing was switched. */
async function csSwitchAccount(key, accountId) {
  const held = await tpxHeldOn(key);
  let confirm = false;
  if (held.length) {
    if (!(await askConfirm(`${tpxHeldText(held[held.length - 1])} Switch account anyway?`, "Switch", "Not now"))) {
      return null;
    }
    confirm = true;
  }
  for (;;) {
    const body = { broker: key, account_id: accountId };
    if (confirm) body.confirm = true;
    const r = await fetch("/api/broker/account", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const res = await readResult(r);
    const code = res.code || (res.detail && typeof res.detail === "object" ? res.detail.code : null);
    if (r.status === 409 && code === "held_requests" && !confirm) {
      const words = oneLine(typeof res.detail === "string" ? res.detail
        : (res.detail && res.detail.detail) || "A request of this broker may have been carried out.");
      if (!(await askConfirm(`${tpbPlainReason(words)} Switch account anyway?`, "Switch", "Not now"))) return null;
      confirm = true;
      continue;
    }
    if (!r.ok) throw new Error(typeof res.detail === "string" ? res.detail : String(r.status));
    // The account is bound and the session is open: point the ticket at it.
    // Nothing did, so the ticket kept saying "choose an account" with no
    // catalog while the card said connected. No arming happens here: a live
    // account is armed from this card's own "Allow trading", after it is
    // seen to be the one in use.
    if (res.connected && typeof tpbSwitch === "function") {
      const sel = $("tpx-broker");
      if (sel) sel.value = key;
      await tpbSwitch(key);
    }
    return res;
  }
}

async function csConnect(key, hub, inputs, stored) {
  // Whatever the user typed goes to the ENGINE first, which stores it in this
  // broker's private state directory and hands it to the adapter as
  // environment at spawn (SPEC 8.5). It never rides a protocol message and it
  // never leaves this machine.
  //
  // ONLY what was typed is sent, with `merge`, so the engine lays it over
  // what is already stored. This form used to post every field on every
  // Connect, blanks included, and a blank deleted the stored value: reopening
  // a card and pressing Connect with empty boxes wiped the saved keys.
  // Forgetting a key is its own action now (csForgetKeys).
  //
  // `stored` is null with an engine from before it reported stored field
  // names. That engine does not know `merge` either and would treat a partial
  // post as "replace everything", so there the old full post is kept.
  const typed = {};
  for (const [k, inp] of Object.entries(inputs || {})) {
    const v = inp.value.trim();
    if (stored ? v !== "" : true) typed[k] = v;
  }
  if (Object.keys(typed).length) {
    const body = { broker: key, values: typed };
    if (stored) body.merge = true;
    const r = await fetch("/api/broker/credentials", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || "could not save the credentials for " + key);
    }
  }
  // A broker the hub already knows (a shipped adapter or one the user linked):
  // reuse the dropdown's connect decision VERBATIM. The live-money
  // confirmation and the post-connect arming both live in pickBroker, and a
  // broker must never reach real money by a second, parallel code path.
  if (hub) return await pickBroker(hub);
  // A directory broker with no local adapter installed. The hub gates it (it
  // only runs adapters it ships or the user linked), so a 404 here is the
  // honest state, not a faked success. Credentials the user typed are not sent:
  // an adapter reads its own credentials from its private state directory
  // (SPEC 8.5), never from the connect message, so there is nowhere on the
  // existing path to hand them to. Wiring these venues is a backend step
  // (their adapter has to be onboarded) and is out of this screen's scope.
  const r = await fetch("/api/broker/connect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ broker: key }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail
      || `${key} has no local adapter yet. Link it with brueconnect first.`);
  }
}

/* The symbol box. What it takes for the text typed into it: the instrument
   whose symbol IS that text, whatever case it was typed in, else the first
   suggestion, else nothing. The exact match is looked for in the suggestions
   and then in the sidebar's catalog. */
function symbolChoice(typed, suggestions, catalog) {
  const q = String(typed == null ? "" : typed).trim().toUpperCase();
  if (!q) return "";
  const exact = (list) => (list || []).find(
    (i) => String((i && i.symbol) || "").toUpperCase() === q);
  const hit = exact(suggestions) || exact(catalog);
  if (hit) return String(hit.symbol);
  return suggestions && suggestions.length ? String(suggestions[0].symbol || "") : "";
}

/* Enter in the box, a pick from its list, or leaving it with text in it.
   The box used to chart the typed text verbatim: "aapl" became the symbol
   "aapl", which no source lists, so Enter looked as if it did nothing.
   Now the text is resolved first (symbolChoice). An instrument already in
   hand is taken at once; otherwise the source is asked for this exact text,
   because the list on screen may still answer an earlier keystroke. */
const symPick = { seq: 0, settling: false };
async function pickTypedSymbol(input) {
  if (symPick.settling) return;   // the blur() below fires `change` again
  const typed = String(input.value || "").trim();
  if (!typed) return;
  const seq = ++symPick.seq, source = state.provider;
  const take = (symbol) => {
    symPick.settling = true;
    try { input.value = symbol; setSymbol(symbol); input.blur(); }
    finally { symPick.settling = false; }
  };
  const offered = state.suggest && state.suggest.provider === source
    ? state.suggest.items : null;
  const known = symbolChoice(typed, null, offered) || symbolChoice(typed, null, state.instruments);
  if (known) { take(known); return; }
  let ranked = null;
  try { ranked = await loadInstruments(typed); } catch (e) { ranked = null; }
  // A later Enter, a switch of source, or more typing while the answer was
  // on its way: this pick is no longer the one that was asked for.
  if (seq !== symPick.seq || source !== state.provider) return;
  if (String(input.value || "").trim() !== typed) return;
  const symbol = Array.isArray(ranked) ? symbolChoice(typed, ranked, state.instruments) : "";
  if (symbol) { take(symbol); return; }
  // Nothing answers the text. A broker's catalog is the whole of what it
  // deals, so there is nothing to chart and the header says so. Every other
  // source keeps what the box always did (LSE serves saved spellings that
  // today's catalogue no longer lists): the text goes through as typed.
  if (isBrokerSource(source)) {
    if (Array.isArray(ranked)) status(`no instrument matches "${typed}"`);
    return;
  }
  take(typed);
}

function setSymbol(symbol) {
  // Multi-chart mode with symbol-sync off: a sidebar/search pick retargets
  // the SELECTED pane only (the panes have no inputs of their own); the
  // shell's main pair stays put for when the user returns to 1x1.
  const ls = window.LSEChart && window.LSEChart.layoutStore;
  const st = ls ? ls.get() : null;
  if (st && st.layout !== "1x1" && !(st.sync && st.sync.syncSymbol)) {
    ls.setPanelSymbol(st.activePanel, symbol);
    updateWindowTitle();
    return;
  }
  state.symbol = symbol;
  // Imported files carry their own resolution, so the usable timeframe ladder
  // changes with the dataset: re-render it, and if the one in hand is finer
  // than the new file holds, move up to the file's own rather than firing a
  // request the engine answers with a 502.
  if (state.provider === "userdata") {
    const nativeMin = tfMinutes(datasetTf(symbol));
    if (nativeMin > 0 && tfMinutes(state.timeframe) > 0
        && tfMinutes(state.timeframe) < nativeMin) {
      state.timeframe = datasetTf(symbol);
    }
    renderTimeframes();
  }
  renderWatchlist();
  loadChart();
  // The websocket streams exactly the charted symbol; retarget it on switch.
  connectStream();
  // One pick, both surfaces: on a venue's own source the sidebar row IS the
  // instrument choice, so the ticket takes it too (see tpbFollowChart).
  if (typeof tpbFollowChart === "function") tpbFollowChart(symbol);
}

function renderTimeframes() {
  const nav = $("timeframes");
  nav.innerHTML = "";
  const p = state.providers.find((x) => x.name === state.provider);
  // An imported file has ONE resolution and the engine will not invent finer
  // bars (it answers 502 "GOLD was imported as 30m; cannot serve 5m"), but the
  // userdata provider advertises the full 1s..1w ladder for every dataset. So
  // the finer buttons were live and simply failed when pressed. Disable what
  // this dataset cannot serve instead of offering a click that errors.
  const nativeMin = state.provider === "userdata" ? tfMinutes(datasetTf(state.symbol)) : 0;
  // The source's own list, by length (tfOffered): a broker source lists the
  // timeframes its adapter serves, 30m among them where it serves 30m, and
  // in whatever order its adapter gave them.
  for (const tf of tfOffered(p)) {
    const b = document.createElement("button");
    b.textContent = tf;
    if (state.provider === "lse" && tf === "tick") b.title = "Live ticks only; history starts when connected";
    const tooFine = nativeMin > 0 && tfMinutes(tf) > 0 && tfMinutes(tf) < nativeMin;
    b.className = (tf === state.timeframe ? "active" : "") + (tooFine ? " disabled" : "");
    if (tooFine) {
      b.disabled = true;
      b.title = `${state.symbol} was imported at ${datasetTf(state.symbol)}`;
    } else {
      b.onclick = () => { state.timeframe = tf; renderTimeframes(); loadChart(); };
    }
    nav.appendChild(b);
  }
}

/* The resolution a dataset was imported at ("30m"), or "" for anything not in
   the imported-file manifest (every live source pair). */
function datasetTf(symbol) {
  if (!symbol) return "";
  const d = (state.datasetList || []).find((x) => x.symbol === symbol);
  return (d && d.timeframe) || "";
}

/* The timeframes a source lists, as its buttons show them: any that cannot be
   compared by length (a tick chart) first, as listed, then the rest by
   length, so 30m sits between 15m and 1h wherever the list put it. [] for a
   source that lists none. */
function tfOffered(p) {
  const list = (p && Array.isArray(p.timeframes) ? p.timeframes : []).filter((tf) => typeof tf === "string" && tf);
  const odd = list.filter((tf) => !(tfMinutes(tf) > 0));
  const timed = list.filter((tf) => tfMinutes(tf) > 0).map((tf, i) => [tf, i])
    .sort((a, b) => tfMinutes(a[0]) - tfMinutes(b[0]) || a[1] - b[1]).map((x) => x[0]);
  return [...odd, ...timed];
}

/* The timeframe to chart on a source that does not list the one in hand:
   the listed one nearest in length (the longer of two as near), a tick
   chart's place taken by the finest; the one in hand when it is listed or
   nothing is. */
function tfNearest(want, offered) {
  const list = (offered || []).filter((tf) => tfMinutes(tf) > 0);
  if (!list.length || (offered || []).includes(want)) return want;
  const m = tfMinutes(want);
  if (!(m > 0)) return list.reduce((a, b) => (tfMinutes(b) < tfMinutes(a) ? b : a));
  let best = null, gap = Infinity;
  for (const tf of list) {
    const g = Math.abs(Math.log(tfMinutes(tf) / m));
    if (g < gap - 1e-9 || (Math.abs(g - gap) <= 1e-9 && tfMinutes(tf) > tfMinutes(best))) { best = tf; gap = g; }
  }
  return best;
}

/* Minutes per bar, for comparing two timeframe strings. 0 = not comparable
   (tick charts, or an unknown label). */
function tfMinutes(tf) {
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(String(tf || "").trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === "s" ? 1 / 60 : unit === "m" ? 1
            : unit === "h" ? 60 : unit === "d" ? 1440 : 10080);
}

async function loadInstruments(query = "") {
  // The sidebar (no query) wants the whole catalog: folders are collapsed
  // so only opened groups ever render rows. The search datalist stays 30.
  const limit = query ? 30 : 5000;
  const asked = state.provider;   // the source this answer belongs to
  const url = `/api/instruments?provider=${encodeURIComponent(state.provider)}` +
              `&query=${encodeURIComponent(query)}&limit=${limit}` +
              (!query && state.provider === "lse" ? "&all_current=true" : "");
  // The catalog is the one call the whole MARKETS tab is built on, and the
  // first one after a key is saved always pays for a cold provider: saving
  // registers a BRAND NEW LseProvider, so its catalog cache is empty and the
  // call fetches the catalogue once for both SDK views, while later calls
  // use the provider's cache. A single failure used to dead-end the tab:
  // state.instruments stayed empty, so no symbol was picked, loadChart() drew
  // nothing, and nothing ever retried. Entering a perfectly good key then
  // looked exactly like a broken app. Search-as-you-type keeps its single
  // shot (the user is still typing); only the catalog retries.
  // No retry when the answer is a foregone conclusion: with no key saved the
  // LSE catalog 502s ("needs an API key") every time, so retrying it just adds
  // 1.2s of backoff to every keyless launch.
  const hopeless = state.provider === "lse" && !state.lseConfigured;
  const tries = (query || hopeless) ? 1 : 3;
  let res = null;
  for (let i = 0; i < tries; i++) {
    // A thrown fetch (offline, connection reset) takes the same retry path as
    // a bad status; before this it rejected out of runSwitchProvider entirely.
    try { res = await fetch(url); if (res.ok) break; } catch (e) { res = null; }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (query) {
    // The latest text typed wins. Every keystroke asks, and the answers come
    // back in any order: the one for "aap" can land after the one for "aapl"
    // and used to overwrite it, so the list offered AAP, AAPB, AAPD under a
    // box that said "aapl". An answer that is not for the text now in the
    // box is dropped, whole: no list, no status, nothing remembered.
    const box = $("symbol");
    if (box && typeof box.value === "string"
        && box.value.trim() !== String(query).trim()) return;
  }
  if (!res || !res.ok) {
    if (!query) {
      state.instrumentsTotal = 0;
      const wl = $("watchlist");
      if (wl) {
        wl.innerHTML = '<div class="empty-actions">' +
          '<button id="wl-retry" class="md-btn">Retry</button></div>';
        const b = $("wl-retry");
        if (b) b.onclick = () => switchProvider(state.provider);
      }
    }
    status("instrument load failed");
    return;
  }
  const items = await res.json();
  if (query) {
    // Everything this block needs is inside it (it is exercised on its own
    // by tests/test_current_catalog.mjs), hence an escape of its own.
    // A source's symbols and names are third-party text: escaped, so a name
    // holding markup or a quote can never become an element or an attribute.
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    // The exact symbol first, then symbols that start with what was typed,
    // then the rest in the source's own order. A venue with thousands of
    // instruments has hundreds whose symbol merely contains "F"; typing F
    // must offer F at the top, not thirty rows down or not at all.
    const q = String(query).trim().toUpperCase();
    const rank = (i) => {
      const sy = String(i.symbol || "").toUpperCase();
      return sy === q ? 0 : sy.startsWith(q) ? 1 : sy.includes(q) ? 2 : 3;
    };
    const ranked = items.map((i, n) => [rank(i), n, i])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
    $("symbol-options").innerHTML =
      ranked.map((i) => `<option value="${esc(i.symbol)}">${esc(i.name)}</option>`).join("");
    // A found instrument may lie beyond the sidebar's page: keep the decimals
    // its source declares, so its price prints right once it is charted.
    if (asked === state.provider) {
      state.digitsBySym = state.digitsBySym || {};
      // A source's own digits only: the map still held another source's
      // while this one's catalog was on its way.
      if (state.digitsSource !== asked) { state.digitsBySym = {}; state.digitsSource = asked; }
      let added = false;
      for (const i of items) {
        if (i.digits != null && state.digitsBySym[i.symbol] !== i.digits) {
          state.digitsBySym[i.symbol] = i.digits;
          added = true;
        }
      }
      if (added) {
        // the chart's map, sent again only when a search found new ones
        state.digitsVer = (state.digitsVer || 0) + 1;
        chartPushDigits();
      }
      // What the box now offers, in the order offered (pickTypedSymbol).
      state.suggest = { provider: asked, query: String(query), items: ranked };
    }
    return ranked;
  } else {
    // How many instruments the source holds in all, when it says (a
    // connected broker does, in a header): the sidebar is a bounded page and
    // must be able to say what it left out (see wlCutNote).
    const total = Number(res.headers && res.headers.get
      ? res.headers.get("X-Total-Count") : 0);
    state.instrumentsTotal = total > 0 ? total : 0;
    // Arrival order IS the display order: the provider contract says results
    // come grouped contiguously, groups pre-ordered by the source (the
    // translator layer). No source-specific rules here, so any future
    // broker provider renders correctly unchanged. (Live prices no longer
    // depend on this order: the stream follows the visible rows.)
    state.instruments = items;
    // symbol -> category lookup for the tick path (spread pips are FX-only)
    state.catBySym = {};
    // symbol -> the decimals the source declares for it (fmtQuote, spreadText),
    // and which source that is: the one asked, whatever is active by now
    state.digitsBySym = {};
    state.digitsSource = asked;
    for (const i of items) {
      state.catBySym[i.symbol] = i.category || "";
      if (i.digits != null) state.digitsBySym[i.symbol] = i.digits;
    }
    state.digitsVer = (state.digitsVer || 0) + 1;
    chartPushDigits();
    renderWatchlist();
  }
}

/* One fetch per provider switch; the map is provider-wide and static for the
   session. Fire-and-forget: rows render immediately as monogram tiles and
   upgrade to art in one re-render when the map lands. */
async function loadLogos() {
  const prov = state.provider;
  let map = {};
  try {
    const res = await fetch(`/api/logos?provider=${encodeURIComponent(prov)}`);
    if (res.ok) map = (await res.json()) || {};
  } catch (e) { /* decoration only; monograms stand in */ }
  if (state.provider !== prov) return; // user switched source mid-flight
  state.logos = map;
  if (Object.keys(map).length) {
    renderWatchlist();
    // The ticket's tile drew a monogram while the map was in flight.
    if (tpxVisible()) tpxUpdateQuote();
  }
}

/* The LSE map for the ticket's fallback (see state.logoFallback): one fetch
   per session, shared by every caller through the same promise, failure =
   empty map (monogram tiles, never an error). Refreshes the ticket when it
   lands so a tile that missed the lookup upgrades to art. */
let logoFallbackLoad = null;
function loadLogoFallback() {
  if (logoFallbackLoad) return logoFallbackLoad;
  logoFallbackLoad = (async () => {
    let map = {};
    try {
      const res = await fetch("/api/logos?provider=lse");
      if (res.ok) map = (await res.json()) || {};
    } catch (e) { /* decoration only */ }
    state.logoFallback = map;
    if (tpxVisible()) tpxUpdateQuote();
  })();
  return logoFallbackLoad;
}

// The last switch's promise. Callers that pick a symbol right after a rail
// click need it: the rail handlers call switchProvider() WITHOUT awaiting,
// and its tail sets state.symbol to instruments[0], so anything set in the
// meantime is silently replaced when the switch lands.
function switchProvider(name) {
  state.providerReady = runSwitchProvider(name);
  return state.providerReady;
}

async function runSwitchProvider(name) {
  state.provider = name;
  // The source is known now: MARKETS's page is decided again from it, if it
  // is up (marketsDecide).
  if (marketsMainShowing()) marketsDecide();
  syncPricePollBudget();
  state.prices = {};
  state.logos = {};
  loadPriceCache(); // last session's board paints instantly, dimmed as stale
  // A timeframe the new source does not list is not asked of it (a broker's
  // adapter serves only what it serves): the nearest one it lists.
  const offered = tfOffered((state.providers || []).find((x) => x && x.name === name));
  if (offered.length) state.timeframe = tfNearest(state.timeframe, offered);
  renderTimeframes();
  await loadInstruments();
  loadLogos();
  if (state.instruments.length) state.symbol = state.instruments[0].symbol;
  renderWatchlist();
  // The ticket goes to the instrument now, not when its candles have come:
  // a broker can take seconds over the first chart, and for those seconds
  // the ticket sat on its catalog's first entry under another title.
  if (typeof tpbFollowChart === "function") tpbFollowChart(state.symbol);
  await loadChart();
  connectStream();
  // A source switch (boot included) recharts to the list's first row without
  // going through setSymbol; the ticket follows this too, else at boot it can
  // sit on its catalog's first entry (0001.HK) under a EUR/JPY chart when the
  // broker's catalog landed before this list did.
  if (typeof tpbFollowChart === "function") tpbFollowChart(state.symbol);
  // The key form's line in the sidebar again, after the list above was
  // painted under it (the source has not changed since: marketsDecide).
  if (state.provider === name && marketsMainShowing() && marketsWantsKey()) marketsDecide();
}

/* Chart an LSE instrument from a surface that is not the watchlist (the
   screener card today). Waits out any provider switch already in flight so
   the pick is the last write, then goes through setSymbol so multi-chart
   panes, the stream and the watchlist highlight all behave as they do for a
   sidebar click. */
async function chartLseSymbol(symbol) {
  // The screener snapshot is the LSE universe (/api/screener?provider=lse),
  // so its rows only resolve against the LSE source: a user parked on their
  // own vendor or a broker feed is moved back to LSE rather than handed a
  // candle request that source cannot answer.
  if (state.provider !== "lse") {
    await switchProvider("lse");
  } else if (state.providerReady) {
    try { await state.providerReady; } catch (e) { /* switch failed; pick anyway */ }
  }
  setSymbol(symbol);
}

/* ---------- saved layouts (chart right-click "Chart template" menu) ---------- */

/* A layout = where you were and how the chart read: provider, symbol,
   timeframe, chart type, active engine indicators. Rows persist in the
   workspace file's "layouts" section (the same store the richer React
   workspace reads), with the shell's fields under layout_data.shell so the
   two row shapes never fight. Drawings are NOT part of a layout: they
   already persist per symbol on their own. The sidebar LAYOUTS zone was
   removed (it duplicated the chart menu); the chart's
   template submenu is now the only list/apply surface. */
const layoutsZone = { rows: [] };

async function refreshLayouts() {
  try {
    const res = await fetch("/api/workspace/layouts");
    const body = res.ok ? await res.json() : null;
    layoutsZone.rows = Array.isArray(body && body.value) ? body.value : [];
  } catch (e) { layoutsZone.rows = []; }
}

// Returns whether the store actually took the write. fetch resolves for a 4xx
// or 5xx as happily as for a 200, so without this check a template that never
// reached disk (hosted mode's 403, a full disk's 507) reported success to the
// chart menu and vanished on the next reload.
async function writeLayouts(rows) {
  const before = layoutsZone.rows;
  layoutsZone.rows = rows;
  try {
    const res = await fetch("/api/workspace/layouts", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rows),
    });
    if (!res.ok) { layoutsZone.rows = before; return false; }
  } catch (e) {
    layoutsZone.rows = before;   // engine gone; the menu must not show a ghost row
    return false;
  }
  return true;
}

// The row shape applyLayout reads. Indicators carry their params (the old
// zone saved bare names; applyLayout accepts both), so "RSI 7 + BB 30/2.5"
// comes back exactly, not reset to defaults.
function currentLayoutRow(name) {
  const now = new Date().toISOString();
  return {
    id: String(Date.now()), name, created_at: now, updated_at: now,
    layout_data: {
      symbol: state.symbol, timeframe: state.timeframe,
      shell: {
        provider: state.provider, chart_type: state.chartType,
        indicators: state.activeIndicators.map((i) => ({ name: i.name, params: i.params || {} })),
      },
    },
  };
}

async function applyLayout(row) {
  const d = row.layout_data || {};
  const sh = d.shell || {};
  if (d.chart_settings && window.LSEChart) {
    // Restore the saved appearance. Order matters: unmount FIRST and wait out
    // the settings context's 300ms save debounce, so an in-flight write from
    // a just-made colour edit lands before ours instead of clobbering it.
    // Then write, drop the React api layer's cached copy, and let the remount
    // (pushToChart below) re-read the file fresh.
    if (state.chartMounted) { window.LSEChart.unmount(); state.chartMounted = false; }
    await new Promise((r) => setTimeout(r, 400));
    await fetch("/api/workspace/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d.chart_settings),
    });
    if (window.LSEChart.invalidateWorkspaceSection) {
      window.LSEChart.invalidateWorkspaceSection("settings");
    }
  }
  const provider = sh.provider || state.provider;
  if (provider !== state.provider &&
      state.providers.some((p) => p.name === provider)) {
    state.provider = provider;
    syncPricePollBudget();
    state.prices = {};
    state.logos = {};
    loadPriceCache();
    await loadInstruments();
    loadLogos();
  }
  if (d.timeframe) state.timeframe = d.timeframe;
  if (sh.chart_type) { state.chartType = sh.chart_type; $("chart-type").value = sh.chart_type; }
  if (Array.isArray(sh.indicators)) {
    // Bare names (old rows) or {name, params} (new rows); only indicators
    // that still exist, so a deleted user indicator cannot wedge the layout.
    state.activeIndicators = sh.indicators
      .map((x) => typeof x === "string" ? { name: x } : x)
      .filter((i) => i && state.indicatorSpecs.some((s) => s.name === i.name));
    renderActiveIndicators();
    saveShellState();
  }
  renderTimeframes();
  if (d.symbol) state.symbol = d.symbol;
  renderWatchlist();
  await loadChart();
  connectStream();
  // A saved layout is an explicit pick of its symbol; the ticket follows.
  if (typeof tpbFollowChart === "function") tpbFollowChart(state.symbol);
}

// The label the ENGINE gives an active indicator, matching the one
// engine/server.py builds when it returns the computed series. It is the only
// handle the chart has for a Python indicator (it becomes the subplot's title),
// so the shell bridge below addresses indicators by it.
function engineLabel(item) {
  const ps = Object.entries(item.params || {});
  return item.name + (ps.length ? "(" + ps.map(([k, v]) => `${k}=${v}`).join(";") + ")" : "");
}

function setupLayouts() {
  // The sidebar LAYOUTS zone is gone (it duplicated the chart's own
  // "Chart template" right-click menu); this bridge is that menu's data
  // source, so the store and apply path stay.
  window.__lseShell = {
    layouts: () => layoutsZone.rows.map((r) => ({ id: r.id, name: r.name })),
    applyLayout: (id) => {
      const row = layoutsZone.rows.find((r) => r.id === id);
      if (row) applyLayout(row);
    },
    // Save door for the chart menu (the sidebar has no save UI, so without
    // this the menu could list templates but nothing could create one).
    // Captures symbol/timeframe/type/provider, the active engine
    // indicators WITH params, and a snapshot of the chart's appearance
    // settings. Same name replaces, so re-saving a template updates it.
    saveLayout: async (name) => {
      name = String(name || "").trim();
      if (!name || !state.symbol) return false;
      const row = currentLayoutRow(name);
      try {
        const cs = await fetch("/api/workspace/settings").then((r) => r.ok ? r.json() : null);
        if (cs && cs.value) row.layout_data.chart_settings = cs.value;
      } catch (e) { /* a template without colours is still a template */ }
      const wrote = await writeLayouts([row, ...layoutsZone.rows.filter((r) => r.name !== name)]);
      if (!wrote) { status("could not save the chart template"); return false; }
      status(`chart template saved: ${name}`);
      renderTplPanel();   // the toolbar Templates list is the same store
      return true;
    },
    deleteLayout: async (id) => {
      const before = layoutsZone.rows.length;
      const wrote = await writeLayouts(layoutsZone.rows.filter((r) => r.id !== id));
      if (!wrote) return false;
      renderTplPanel();
      return layoutsZone.rows.length !== before;
    },
    // Default name for the save input: where the user is right now.
    layoutDefaultName: () => (state.symbol ? `${state.symbol} ${state.timeframe}` : ""),
    // Remove / edit from the chart's right-click menu on an indicator's
    // subplot panel. The chart only knows the ENGINE's label ("ao",
    // "rsi(length=14)") while the active list is keyed by name + params, so
    // both rebuild that label the same way engine/server.py does and match on
    // it. Each returns false when nothing matched, so a label mismatch is
    // visible rather than a silent no-op.
    removeIndicator: (label) => {
      const before = state.activeIndicators.length;
      state.activeIndicators = state.activeIndicators.filter((i) => engineLabel(i) !== label);
      if (state.activeIndicators.length === before) return false;
      renderActiveIndicators();
      loadChart();
      saveShellState();
      return true;
    },
    // Chart right-click trading. The menu (mount.tsx) renders the rows; the
    // ticket owns the broker routing and the result message. tradeInfo says
    // whether trading is available at all and which pending types the
    // connected venue deals. The menu's order form sends the size typed in
    // it (`units`); the rows at market send none, and take the ticket's box.
    tradeInfo: () => tpxTradeInfo(),
    quickOrder: (side, otype, price, units) => tpxQuickOrder(side, otype, price, units),
    // The shell's own price formatter, so menu rows print "@ 64,731.9" the
    // same way the dock does instead of inventing a second decimals rule.
    // On a source that declares digits the level follows them (fmtLevel).
    fmtPrice: (p) => fmtLevel(state.symbol, p),
    editIndicator: (label) => {
      const idx = state.activeIndicators.findIndex((i) => engineLabel(i) === label);
      if (idx < 0) return false;
      // Deferred one tick. The caller is the chart's own right-click menu, so
      // the click that got us here is still propagating and will reach
      // setupIndicatorPanel's click-away listener, whose target is neither
      // panel nor #ind-open: it would close ind-cfg the instant we opened it.
      // Anchor on that indicator's OWN chip so the editor lands where a chip
      // click would have put it.
      setTimeout(() => {
        openIndicatorConfig(state.activeIndicators[idx], $("ind-active").children[idx] || $("ind-open"));
      }, 0);
      return true;
    },
  };

  // Toolbar Templates dropdown: the second door to the same store as the
  // chart's right-click submenu (keep the menu AND give
  // it a visible button). Rows apply, x deletes on a second armed click,
  // the dashed bottom row saves the current setup under a name.
  const panel = $("tpl-panel");
  let armedDelete = null; // template id whose x is armed
  function renderTplPanel() {
    panel.innerHTML = "";
    if (!layoutsZone.rows.length) {
      panel.innerHTML = '<div class="tpl-empty">No saved templates yet.</div>';
    }
    for (const row of layoutsZone.rows) {
      const d = row.layout_data || {};
      const el = document.createElement("div");
      el.className = "tpl-row";
      const sub = [d.symbol, d.timeframe].filter(Boolean).join(" ");
      const armed = armedDelete === row.id;
      el.innerHTML =
        `<span class="tpl-name">${row.name}</span>` +
        `<span class="tpl-sub">${sub}</span>` +
        `<button class="tpl-del${armed ? " armed" : ""}" title="${armed ? "Click again to delete" : "Delete template"}">${armed ? "sure?" : "&times;"}</button>`;
      el.onclick = () => { panel.classList.add("hidden"); applyLayout(row); };
      el.querySelector(".tpl-del").onclick = async (e) => {
        e.stopPropagation();
        if (armedDelete !== row.id) { armedDelete = row.id; renderTplPanel(); return; }
        armedDelete = null;
        await writeLayouts(layoutsZone.rows.filter((r) => r.id !== row.id));
        renderTplPanel();
      };
      panel.appendChild(el);
    }
    const save = document.createElement("button");
    save.id = "tpl-save-row";
    save.textContent = "+ Save current as template";
    save.onclick = (e) => {
      e.stopPropagation();
      // Name box AND a Save button, not the box alone: this row used to turn
      // into a bare input whose only commit was an undocumented Enter, so the
      // panel offered nothing that said "save" (same complaint the chart's
      // right-click menu drew). Enter still works.
      const row = document.createElement("div");
      row.id = "tpl-name-row";
      const input = document.createElement("input");
      input.id = "tpl-name-input";
      input.spellcheck = false;
      input.placeholder = "Template name";
      input.value = state.symbol ? `${state.symbol} ${state.timeframe}` : "";
      const go = document.createElement("button");
      go.id = "tpl-name-save";
      go.textContent = "Save";
      const commit = async () => {
        if (!input.value.trim()) { input.focus(); return; }
        if (await window.__lseShell.saveLayout(input.value)) renderTplPanel();
      };
      go.onclick = (ev) => { ev.stopPropagation(); commit(); };
      input.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === "Escape") { renderTplPanel(); return; }
        if (ev.key === "Enter") commit();
      };
      row.append(input, go);
      save.replaceWith(row);
      input.focus();
      input.select();
    };
    panel.appendChild(save);
  }
  $("tpl-open").onclick = (e) => {
    e.stopPropagation();
    const opening = panel.classList.contains("hidden");
    panel.classList.add("hidden");
    if (!opening) return;
    armedDelete = null;
    renderTplPanel();
    panel.classList.remove("hidden");
    positionPanel(panel, $("tpl-open"));
  };
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && e.target !== $("tpl-open")) {
      panel.classList.add("hidden");
    }
  });

  refreshLayouts();
}

/* ---------- backtest ---------- */

const backtest = { engine: "python", equityChart: null, equitySeries: null };

function setupBacktest() {
  $("bt-open").onclick = async () => {
    $("backtest").classList.remove("hidden");
    if (!$("bt-src").value) {
      const t = await fetch(`/api/backtest/template?engine=${backtest.engine}`)
        .then((r) => r.json()).catch(() => ({ template: "" }));
      $("bt-src").value = t.template || "";
    }
    if (!backtest.equityChart) {
      backtest.equityChart = LightweightCharts.createChart($("bt-equity"), chartOpts());
      backtest.equitySeries = backtest.equityChart.addAreaSeries({
        lineColor: "#21b3a4", topColor: "rgba(33,179,164,.25)",
        bottomColor: "rgba(33,179,164,.02)", lineWidth: 2,
      });
    }
  };
  $("bt-close").onclick = () => {
    $("backtest").classList.add("hidden");
  };
  $("bt-mode").onchange = () => {
    const mode = $("bt-mode").value;
    $("bt-mc-opts").classList.toggle("hidden", mode !== "montecarlo");
    $("bt-wf-opts").classList.toggle("hidden", mode !== "walkforward");
    // Risk stats belong to a plain run; the quant modes have their own output.
    $("bt-ext").disabled = mode !== "run";
  };
  $("bt-run").onclick = runBacktest;
  $("bt-algo").onclick = algoStart;
}

/* ---------- Algo trading (MT5-style attach, paper broker) ----------
   The editor's Brue strategy runs LIVE against the brue-connect paper
   adapter, supervised by the engine (/api/algo/*). Each run is a row in
   #algo-strip: status light, symbol@tf, last journal event, Journal and
   Stop buttons, plus one kill switch for everything. Poll only while runs
   exist; the strip stays hidden until the first start. */
let algoTimer = null;

async function algoStart() {
  status("starting live paper run…");
  try {
    const r = await fetch("/api/algo/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script: $("bt-src").value }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    status("live paper run started");
    algoRefresh();
  } catch (e) {
    $("bt-err").textContent = `live run: ${e.message}`;
    $("bt-err").classList.remove("hidden");
    status("");
  }
}

async function algoRefresh() {
  let runs = [];
  try { runs = await fetch("/api/algo/runs").then((r) => r.json()); } catch { /* engine gone */ }
  const strip = $("algo-strip");
  strip.classList.toggle("hidden", !runs.length);
  strip.innerHTML = "";
  if (runs.length) {
    const kill = document.createElement("button");
    kill.className = "algo-kill";
    kill.textContent = "KILL ALL";
    kill.title = "Stop every live run and flatten positions";
    kill.onclick = async () => { await fetch("/api/algo/killswitch", { method: "POST" }); algoRefresh(); };
    strip.appendChild(kill);
  }
  for (const run of runs) {
    const row = document.createElement("div");
    row.className = "algo-row";
    const light = run.running ? "🟢" : (run.exit_code === 0 ? "⚪" : "🔴");
    let last = "";
    try { const j = JSON.parse(run.last_journal); last = j.kind || Object.keys(j)[0] || ""; } catch { /* raw */ }
    row.innerHTML = `<span>${light} <b>${run.symbol}</b>@${run.timeframe}</span>` +
      `<span class="algo-last">${last}</span>`;
    const jbtn = document.createElement("button");
    jbtn.textContent = "Journal";
    jbtn.onclick = async () => {
      const j = await fetch(`/api/algo/journal?id=${run.id}`).then((r) => r.json());
      const lines = j.events.map((e) => JSON.stringify(e)).join("\n") || j.log_tail || "(empty)";
      alert(lines.slice(-3000));
    };
    row.appendChild(jbtn);
    if (run.running) {
      const stop = document.createElement("button");
      stop.textContent = "Stop";
      stop.onclick = async () => {
        await fetch("/api/algo/stop", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: run.id }),
        });
        algoRefresh();
      };
      row.appendChild(stop);
    }
    strip.appendChild(row);
  }
  clearTimeout(algoTimer);
  if (runs.some((r) => r.running)) algoTimer = setTimeout(algoRefresh, 3000);
}

/* ---------- AI rail (full-height, whole terminal) ----------
   The permanent right-hand panel, open on every tab like the left sidebar
   (the old Assistant/AI header buttons are gone).
   The provider dropdown leads with "LSE Assistant", the hosted bot proxied
   through /api/assistant on the user's LSE API key, then the user's OWN
   agent CLIs (Claude, ChatGPT/Codex, Gemini, Kimi, Qwen, Copilot, OpenCode;
   list built from /api/ai/status), cwd'd into a workspace that mirrors the
   strategy editor: strategy.py <-> #bt-src (two-way, mtime-guarded),
   backtest.py lets the agent run the engine itself. Agent CLIs get two
   views: Chat (default) speaks /api/ai/chat, one structured turn per
   message; Terminal is the agent's own TUI over the /api/ai/pty PTY, still
   needed once per provider for interactive sign-in. The LSE Assistant is
   chat-only. The terminal ships no AI and holds no keys; agent sign-in and
   billing are the user's own subscription. */

// "lse" is a pseudo-provider: it never appears in /api/ai/status and takes
// the hosted /api/assistant path instead of a local CLI.
const AI_LABEL = { lse: "Veron",
                   claude: "Claude", codex: "ChatGPT", gemini: "Gemini",
                   kimi: "Kimi", qwen: "Qwen", copilot: "Copilot",
                   opencode: "OpenCode" };

/* Real brand marks, inlined so the local app never fetches anything
   (simple-icons 24x24 paths, fetched at build time and
   embedded verbatim). Monochrome marks (OpenAI, Copilot, Kimi) ride
   currentColor so they flip with the theme; Claude keeps its coral and
   Qwen its indigo (the marks' own colors, not chrome accents); Gemini
   gets its blue-to-purple sweep via an SVG gradient. */
const AI_LOGO_PATH = {
  codex: { fill: "", d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
  claude: { fill: "#d97757", d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" },
  gemini: { fill: "url(#air-ggrad)", defs: '<defs><linearGradient id="air-ggrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4285f4"/><stop offset="1" stop-color="#9b72cb"/></linearGradient></defs>', d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" },
  copilot: { fill: "", d: "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" },
  qwen: { fill: "#615ced", d: "M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" },
  kimi: { fill: "", d: "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441" },
};

// Logo as an inline-SVG span. LSE gets the brand's candlestick pair, not a
// wordmark tile (no "LSE" lettering, just the candles).
// Geometry and green are taken from the brand asset (frontend/src/assets/
// lse-logo-dark.png, body green #0c5e24); the left candle rides currentColor
// so it is black on light / white on dark, exactly how the PNG pair flips.
// Providers without a known path (opencode, future registry additions) fall
// back to a neutral monogram tile so the picker never shows a blank.
const LSE_CANDLES_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="8.45" y="4.6" width="0.9" height="18.2" fill="currentColor"/>' +
  '<rect x="6.5" y="8.2" width="4.8" height="10.7" fill="currentColor"/>' +
  '<rect x="14.65" y="1.9" width="0.9" height="18.7" fill="#0c5e24"/>' +
  '<rect x="12.7" y="6.2" width="4.8" height="11.1" fill="#0c5e24"/>' +
  '</svg>';
function aiLogoHtml(agent) {
  if (agent === "lse") return `<span class="air-logo lse-candles">${LSE_CANDLES_SVG}</span>`;
  const p = AI_LOGO_PATH[agent];
  if (!p) {
    const mono = agent === "opencode" ? "&gt;_"
      : aiEscape(((AI_LABEL[agent] || agent) + "?")[0].toUpperCase());
    return `<span class="air-logo air-logo-mono">${mono}</span>`;
  }
  return `<span class="air-logo"><svg viewBox="0 0 24 24" aria-hidden="true">` +
    `${p.defs || ""}<path fill="${p.fill || "currentColor"}" d="${p.d}"/></svg></span>`;
}

/* Composer "/" menu, mirroring the VS Code Claude composer menu: sectioned
   (Context / Model / Panel), keyboard-navigable, with submenus for model,
   effort and dataset mentions. Typing after "/" filters the rows. */

/* Model menus come from the user's own CLI. GET /api/ai/models asks Codex
   for its catalogue and Claude Code for its own menu, so a model the
   provider ships or withdraws reaches this menu with no app release, in the
   provider's words, for the account that is signed in.

   The two lists below are only what the menu shows before the CLI has
   answered, or when it cannot be asked. They hold names the CLI resolves
   itself, with no version in the words, and no exact model id: a typed id
   is a row that fails the day the provider withdraws the model. */
const AIR_CLAUDE_MODELS = [
  { id: "", name: "Default (recommended)", desc: "Whatever your plan uses out of the box" },
  { id: "opus", name: "Opus", desc: "Best for everyday, complex tasks" },
  { id: "fable", name: "Fable", desc: "Most capable for your hardest and longest-running tasks" },
  { id: "sonnet", name: "Sonnet", desc: "Efficient for routine tasks" },
  { id: "haiku", name: "Haiku", desc: "Fastest for quick answers" },
];
const AIR_CODEX_MODELS = [
  { id: "", name: "Default (recommended)", desc: "Codex picks the model for you" },
];

// What each CLI last said, by provider: { models, unavailable, cli, at }.
// `unavailable` are models the CLI names but cannot run until it is updated;
// Claude Code says which version each one needs, and the row shows its line.
// `cli` is set when the CLI itself is behind its newest published version:
// a CLI lists only the models it knows, so the menu offers to update it.
// `fresh` is true once the CLI has answered in this window: an answer kept
// from the last launch draws the menu but never starts an update.
const AIR_MODELS_KEY = "lset-air-models";
const AIR_MODELS_MAX_AGE_MS = 7 * 86400 * 1000;
const AIR_CLI_NAME = { claude: "Claude Code", codex: "Codex" };
const AIR_UPDATE_CMD = { claude: "claude update", codex: "codex update" };
const AIR_UPDATE_OFFERED_KEY = "lset-air-update-offered";
const aiLiveModels = {};
const aiCliUpdating = {}; // provider -> true while its updater runs

function aiModelsApply(agent, d, at) {
  if (!agent || !d || d.ok !== true || !Array.isArray(d.models)) return false;
  const text = (v, cap) => String(v == null ? "" : v).slice(0, cap);
  const models = d.models
    .filter((m) => m && typeof m.id === "string" && m.id.length <= 100 &&
                   typeof m.name === "string" && m.name)
    .map((m) => ({ id: m.id, name: text(m.name, 80), desc: text(m.desc, 200) }));
  if (!models.length) return false;
  const unavailable = (Array.isArray(d.unavailable) ? d.unavailable : [])
    .filter((m) => m && typeof m.name === "string" && m.name)
    .map((m) => ({ name: text(m.name, 80), desc: text(m.desc, 200) }));
  const c = d.cli;
  // auto: true = the terminal keeps this CLI current, false = the user said
  // no, null = never chosen. tried: a version an update did not reach.
  const auto = c && c.auto === true ? true : c && c.auto === false ? false : null;
  const cli = c && c.outdated === true && typeof c.installed === "string" && c.installed &&
              typeof c.latest === "string" && c.latest
    ? { name: text(c.name || agent, 40), installed: text(c.installed, 20),
        latest: text(c.latest, 20), update: text(c.update || "", 60),
        auto, tried: text(c.tried || "", 20) }
    : null;
  aiLiveModels[agent] = { models, unavailable, cli, auto, fresh: false, at: at || Date.now(),
                          version: c && typeof c.installed === "string" ? text(c.installed, 20) : "" };
  return true;
}

// The last answer is kept so the menu is right the moment the app opens; a
// week-old one is dropped rather than trusted.
(function aiModelsBoot() {
  try {
    const saved = JSON.parse(localStorage.getItem(AIR_MODELS_KEY) || "null") || {};
    for (const agent of Object.keys(saved)) {
      const one = saved[agent];
      if (one && Date.now() - (one.at || 0) < AIR_MODELS_MAX_AGE_MS) {
        aiModelsApply(agent, { ok: true, models: one.models, unavailable: one.unavailable,
                               cli: one.cli ? Object.assign({ outdated: true }, one.cli) : null }, one.at);
      }
    }
  } catch (e) { /* no cache yet */ }
})();

// Ask the CLI again. Resolves true when the menu's rows changed, so an open
// menu can redraw; a CLI that cannot answer leaves the rows as they were.
function aiModelsRefresh(agent, force) {
  if (!agent || agent === "lse") return Promise.resolve(false);
  const rows = (one) => JSON.stringify(one ? [one.models, one.unavailable, one.cli] : null);
  const before = rows(aiLiveModels[agent]);
  return fetch("/api/ai/models?agent=" + encodeURIComponent(agent) + (force ? "&refresh=1" : ""),
               { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!aiModelsApply(agent, d)) return false;
      aiLiveModels[agent].fresh = true;
      try { localStorage.setItem(AIR_MODELS_KEY, JSON.stringify(aiLiveModels)); }
      catch (e) { /* cache is optional */ }
      return rows(aiLiveModels[agent]) !== before;
    })
    .catch(() => false);
}

// Bring the CLI to its newest version: the engine runs the CLI's own
// updater, then the CLI is asked for its models again. `asked` is the
// user's own click or /update, which also turns on keeping it current;
// without it the engine allows the update only where that is already on.
// Resolves the engine's answer ({ok, changed, before, after, error}), or
// null when an update of this CLI is already running.
function aiCliUpdate(agent, asked) {
  if (aiCliUpdating[agent]) return Promise.resolve(null);
  aiCliUpdating[agent] = true;
  return fetch("/api/ai/update", { method: "POST", headers: { "Content-Type": "application/json" },
                                   body: JSON.stringify({ agent, asked: !!asked }) })
    .then((r) => r.json().then((d) => (r.ok ? d
      : { ok: false, error: (d && d.detail) || "the update was refused" })))
    .catch(() => ({ ok: false, error: "the terminal's engine did not answer" }))
    .then((res) => {
      aiCliUpdating[agent] = false;
      return aiModelsRefresh(agent, true).then(() => res);
    });
}

// True when the terminal should update this CLI by itself now: the user
// turned that on (or the terminal installed the CLI), the CLI has just said
// it is behind, and this version has not already been tried without success.
function aiShouldAutoUpdate(agent) {
  const live = aiLiveModels[agent];
  const c = live && live.fresh && live.cli;
  return !!c && c.auto === true && c.tried !== c.latest && !aiCliUpdating[agent];
}

// For a user who has not chosen: one line, once per new version, saying
// the CLI is behind and how to update it. "" when there is nothing to say.
function aiUpdateOffer(agent) {
  const live = aiLiveModels[agent];
  const c = live && live.fresh && live.cli;
  if (!c || c.auto !== null) return "";
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(AIR_UPDATE_OFFERED_KEY) || "{}") || {}; }
  catch (e) { seen = {}; }
  if (seen[agent] === c.latest) return "";
  seen[agent] = c.latest;
  try { localStorage.setItem(AIR_UPDATE_OFFERED_KEY, JSON.stringify(seen)); }
  catch (e) { /* then it is said again next launch */ }
  return `${c.name} ${c.latest} is out; this computer has ${c.installed}, so the newest models ` +
    "may be missing from the model menu. Type /update to update it now and keep it up to date.";
}

// Model choices per provider: the CLI's own list when it has answered,
// else the built-in names above. Other CLIs keep Default plus a typed name.
function modelsFor(agent) {
  const live = aiLiveModels[agent];
  if (live) return live.models;
  if (agent === "claude") return AIR_CLAUDE_MODELS;
  if (agent === "codex") return AIR_CODEX_MODELS;
  return [{ id: "", name: "Default", desc: "The CLI's own default model" }];
}

// The rows both model menus draw: the models, then the ones that need a
// newer CLI (shown, not selectable), then one click to update the CLI when
// it is behind, then a typed name for every provider, so no list can ever
// stand between a user and a model.
function modelMenuRows(agent) {
  const live = aiLiveModels[agent];
  const rows = modelsFor(agent).map((m) => ({ id: m.id, name: m.name, desc: m.desc }));
  ((live && live.unavailable) || []).forEach((m, i) => {
    rows.push({ id: "__update:" + i, name: m.name, desc: m.desc, needsUpdate: true });
  });
  if (live && live.cli) {
    const c = live.cli;
    rows.push(aiCliUpdating[agent]
      ? { id: "__update:cli", name: `Updating ${c.name}…`, needsUpdate: true, cliUpdate: true, busy: true,
          desc: "A few seconds. The newest models appear here when it is done." }
      : { id: "__update:cli", name: `Update ${c.name} to ${c.latest}`, cliUpdate: true,
          desc: `This computer has ${c.installed}; new models come with new versions. ` +
                (c.auto === true ? "Click to update now." : "Click to update now and keep it up to date.") });
  }
  rows.push({ id: "__custom", name: "Custom model…", desc: "Type a model name" });
  return rows;
}

// What picking a model that needs a newer CLI says: the CLI's own line, and
// how to act.
function modelUpdateNote(agent, row) {
  return `${row.name} needs a newer version of ${AIR_CLI_NAME[agent] || "this provider's CLI"}` +
    (row.desc ? ` (${row.desc})` : "") + ". Type /update to update it now.";
}

const AIR_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

/* ── Modes: how the assistant behaves this session ─────────────────
   A slash command sets a standing stance that rides with EVERY turn until
   /mode off (or another mode). Each brief is an operating procedure, not
   a persona: what to do first, what to refuse to skip, what the output
   must contain. The same brief reaches both channels: the hosted LSE
   Assistant gets it as a system message the cloud folds into its prompt
   (brue_cloud client_system), a local agent CLI gets it prefixed to the
   turn text. `/audit <text>` runs ONE turn in that stance without
   switching. */
const AIR_MODES = [
  { id: "quant", label: "Quant", short: "quant",
    desc: "practitioner rigor: causality, costs, benchmark, sample size",
    brief: "MODE quant. You are a buy-side quant reviewing your own work before it goes to a PM. On every strategy or result: state the hypothesis in one line and why it should have an edge; check causality explicitly (decisions on bar i fill at i+1, no future data in features, publication lags on macro series); include costs and slippage; name the buy-and-hold benchmark next to any long-only result; state the sample size and how many independent regimes it spans; say what would falsify the idea. Prefer robust parameters (plateaus) over the single best cell and say so. Numbers you quote must come from a run you actually did." },
  { id: "audit", label: "Audit", short: "audit",
    desc: "adversarial review of the code on screen: leaks, bugs, overfitting",
    brief: "MODE audit. Do NOT write new strategies unless asked. Adversarially review whatever code or result is on screen (Editor content in the context). Hunt for: lookahead and survivorship leaks, off-by-one indexing on entry/exit, indicators computed with future bars, resampling that peeks, unrealistic fills (gap-through stops, limit fills without touch), missing costs, parameter overfitting, degenerate cases (0 trades, corr==1 with itself, NaN gates), and dataset mismatches (a `# run:` pin that names the wrong dataset). Output: a numbered findings list, most severe first, each with the exact line and a one-line fix; then a verdict: SAFE / FIX FIRST / DO NOT TRUST. If you find nothing, say what you checked, not just 'clean'." },
  { id: "teach", label: "Teach", short: "teach",
    desc: "explain the concept and the code line by line, no black boxes",
    brief: "MODE teach. The user is learning. Explain the WHY before the code: the market intuition, the statistical idea, then the implementation. Walk through the code in order, one block at a time, naming what each line does and what would break if it were removed. Define every term the first time it appears (z-score, ATR, merge_asof, half-life). Show one worked number from the actual data when possible. No unexplained magic constants. End with two questions the user should be able to answer now." },
  { id: "fast", label: "Fast", short: "fast",
    desc: "answer only, code only, no preamble",
    brief: "MODE fast. Minimum words. No preamble, no recap of the question, no options list. If code is asked for, deliver the complete tested code block and one line of numbers. If a fact is asked for, one sentence. Never pad." },
  { id: "research", label: "Research", short: "research",
    desc: "hypothesis-first: literature, mechanism, then a testable design",
    brief: "MODE research. Treat the request as a research question. First: the mechanism (why would this effect exist, who is on the other side of the trade, why is it not arbitraged away). Second: what is known (name specific papers or practitioner sources when you are confident; say 'not sure' otherwise, never invent citations). Third: a testable design on the user's actual datasets: signal definition, holding period, benchmark, sample split, what result would confirm and what would kill it. Only then code, if asked. Be explicit about the difference between an anomaly and a tradeable edge after costs." },
  { id: "risk", label: "Risk", short: "risk",
    desc: "position sizing, drawdown, ruin, correlation; what can go wrong",
    brief: "MODE risk. Every answer leads with risk, not return. For any strategy or position: max drawdown and its duration, worst single trade, tail behavior, position sizing rule and leverage, what happens in a gap or a liquidity hole, correlation to the user's other positions if visible, and probability of ruin under the stated sizing. State the assumptions behind every number. If the user asks 'is this good', answer 'what could lose the account' first." },
  { id: "debug", label: "Debug", short: "debug",
    desc: "read the error, find the root cause, smallest fix, then verify",
    brief: "MODE debug. Read the exact error text on screen (Terminal output in the context) before anything else. State the root cause in one sentence, quoting the failing line. Propose the SMALLEST change that fixes it, not a rewrite. If you have run_backtest, run the fixed code and report the real result. Do not add features, do not restyle code, do not guess: if the error text is missing, ask for it or reproduce it." },
  { id: "pm", label: "PM", short: "pm",
    desc: "portfolio-manager brief: decision, size, invalidation, in 6 lines",
    brief: "MODE pm. Write for a portfolio manager with 30 seconds. Format, always: 1) the call in one line, 2) the evidence in two lines with numbers, 3) size and horizon, 4) the invalidation level or condition, 5) the main risk, 6) what you would need to see to add. No code unless explicitly asked; no methodology essay." },
];

function aiModeById(id) { return AIR_MODES.find((m) => m.id === id) || null; }

/* Served catalog. The list above is the offline fallback; the live one is
   GET api.londonstrategicedge.com/brue-cloud/terminal-modes, so a brief
   edit or a new mode is a server-side change, never an app release.
   Order: apply the cached copy synchronously (menus render right), then
   refresh from the network and re-cache. The array is mutated IN PLACE so
   every closure holding AIR_MODES sees the served list. */
const AIR_MODES_URL = "https://api.londonstrategicedge.com/brue-cloud/terminal-modes";
const AIR_MODES_KEY = "lset-air-modes";
function aiModesApply(list) {
  const ok = Array.isArray(list) && list.length &&
    list.every((m) => m && typeof m.id === "string" && /^[a-z0-9_-]{1,24}$/.test(m.id) &&
      typeof m.brief === "string" && m.brief.length > 20 && m.brief.length < 4000);
  if (!ok) return false;
  AIR_MODES.length = 0;
  for (const m of list) {
    AIR_MODES.push({ id: m.id, label: String(m.label || m.id), short: m.id,
                     desc: String(m.desc || ""), brief: m.brief });
  }
  return true;
}
(function aiModesBoot() {
  try { aiModesApply(JSON.parse(localStorage.getItem(AIR_MODES_KEY) || "null")); }
  catch (e) { /* no cache yet */ }
  fetch(AIR_MODES_URL, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && aiModesApply(d.modes)) {
        try { localStorage.setItem(AIR_MODES_KEY, JSON.stringify(d.modes)); }
        catch (e) { /* cache is optional */ }
      }
    })
    .catch(() => { /* offline: the cached or built-in list stands */ });
})();

const AIR_HELP =
  "This panel runs your own locally installed AI agent on your machine, " +
  "signed in to your own account. Chat here for normal work; the Terminal " +
  "view is the agent's full interactive UI (first-time sign-in, approving " +
  "actions the chat view is not allowed to auto-approve).\n\n" +
  "Commands: /new fresh conversation, /model <name> switch model, " +
  "/update bring your agent's CLI to its newest version (new models come " +
  "with new versions), /autoupdate on|off whether the terminal does that " +
  "by itself, /terminal open the agent's terminal, /help this text.\n\n" +
  "Modes (a standing stance for every turn until /mode off): " +
  AIR_MODES.map((m) => "/" + m.id + " " + m.desc).join("; ") +
  ". Add text after the command to run one turn in that stance without switching.";

const LSE_HELP =
  "Veron is hosted by London Strategic Edge and answers on " +
  "your free LSE API key; it is free to use. It sees what is on your " +
  "screen, and it can read your data library, run backtests, read your " +
  "positions and fills, load candles, read the economic data and the " +
  "research feed, read your workspace files, open pages in the app, and " +
  "search the web (the tool strip above lists every tool).\n\n" +
  "Commands: /usage today's messages against your daily allowance, /new " +
  "fresh conversation, /help this text. For an agent that can edit files " +
  "and run code on this machine, pick Claude or another provider in the " +
  "dropdown above.\n\n" +
  "Modes (a standing stance for every turn until /mode off): " +
  AIR_MODES.map((m) => "/" + m.id + " " + m.desc).join("; ") +
  ". Add text after the command to run one turn in that stance without switching.";

/* ── More than one window ────────────────────────────────────────────────
   The terminal can be open in several windows at once: MARKETS on one
   monitor, WORKSPACE on another. Every window is this same page on the same
   engine; a window knows which it is from its address (?win=, read in
   index.html into window.__lseWin) and keeps the view it shows there too
   (?view=), so a reload, and the desktop app's next launch, bring each
   window back where it was.

   Opening one: the NEW WINDOW button in the header (the view on screen),
   Ctrl+Shift+N, or Ctrl-click / middle-click on a section or sub-view tab
   (that tab). In the desktop app the shell makes the window, places it on
   a monitor that has none, and remembers it (desktop/main.js); in a
   browser it is window.open.

   What every window shares is the engine, and four things that assumed one
   page are kept right across windows:
   - the watchlist's price budget (pollPrices, above);
   - a broker's display subscriptions (X-LSE-Window names the window; the
     hub keeps each window's claim apart);
   - saved chart work (the engine merges each window's save, workspace.py),
     and the shared lists a window shows are read again when another window
     saves them (winSectionChanged);
   - the assistant's "open this" commands, carried out by the window last
     used and no other (winTakesNavigation). */
const lseWin = (typeof window !== "undefined" && window.__lseWin) ||
  { id: "main", token: "main.0", view: "" };
const WIN_ACTIVE_KEY = "lset-win-active";

/* The view on screen as "<section>" or "<section>/<sub-view id>": the rail
   tab's id without "rail-", and the lit sub-rail button's id. */
function viewId() {
  const rail = document.querySelector(".rail-btn.active");
  if (!rail || !rail.id || rail.id.indexOf("rail-") !== 0) return "markets";
  const sub = document.querySelector("#subrail .subrail-btn.active");
  return rail.id.slice(5) + (sub && sub.id ? "/" + sub.id : "");
}

// The view a tab leads to: a rail tab's section, or a sub-view under the
// section whose bar lists it.
function viewOfTab(btn) {
  if (!btn || !btn.id) return "";
  if (btn.classList.contains("rail-btn")) return btn.id.indexOf("rail-") === 0 ? btn.id.slice(5) : "";
  for (const [section, items] of Object.entries(SUBRAIL)) {
    if (items.some((it) => it.id === btn.id && it.go)) return section + "/" + btn.id;
  }
  return "";
}

/* Go to a view by its id, with the same handlers a click uses. False when
   the id names nothing this build shows (an older address, a hosted page
   without that section): the window then stays where it is. */
function viewOpen(id) {
  const m = /^([a-z]{1,16})(?:\/([a-z0-9-]{1,40}))?$/.exec(String(id || ""));
  if (!m) return false;
  if (m[2]) {
    const items = SUBRAIL[m[1]] || [];
    const it = items.find((x) => x.id === m[2]);
    const rail = document.getElementById("rail-" + m[1]);
    if (it && it.go && rail && !rail.classList.contains("hidden")) { it.go(); return true; }
  }
  const b = document.getElementById("rail-" + m[1]);
  if (!b || !b.classList.contains("rail-btn") || b.classList.contains("hidden")) return false;
  b.click();
  return true;
}

// The address follows the view (replaceState: no history entry, no load).
let viewSyncTimer = null;
function viewSyncAddress() {
  if (viewSyncTimer !== null) return;
  viewSyncTimer = setTimeout(() => {
    viewSyncTimer = null;
    // The ticket, its dock and the rail's cards belong to MARKETS > PRICE &
    // CHARTS. Their own sync listens for clicks on the tabs; a view opened
    // by its address, or by the assistant, is not a click.
    try { if (typeof tpx !== "undefined" && tpx && tpx.sync) tpx.sync(); } catch (e) { /* not set up yet */ }
    try {
      const q = new URLSearchParams(location.search);
      const v = viewId();
      if (q.get("view") === v) return;
      q.set("view", v);
      history.replaceState(null, "", location.pathname + "?" + q.toString());
    } catch (e) { /* a page without an address to keep */ }
  }, 0);
}

function winOpen(view) {
  const v = view || viewId();
  const shell = window.lseShell && window.lseShell.openWindow;
  if (shell) {
    Promise.resolve(shell(v)).catch(() => status("could not open a new window"));
    return;
  }
  const id = "w" + Date.now().toString(36);
  const url = location.origin + "/?win=" + id + "&view=" + encodeURIComponent(v);
  // In a browser: a window of its own, not a tab, so it can go to another
  // monitor. An older desktop shell answers this by opening the browser.
  const w = window.open(url, "lset-" + id, "popup=yes,width=1280,height=820");
  if (!w) status("The new window was blocked; allow pop-ups for this page.");
}

/* The window last used. A click, a key or the focus arriving marks it; the
   mark is cleared when that window goes. */
function winMarkActive() {
  try {
    if (localStorage.getItem(WIN_ACTIVE_KEY) !== lseWin.token) {
      localStorage.setItem(WIN_ACTIVE_KEY, lseWin.token);
    }
  } catch (e) { /* storage disabled */ }
}

// The windows open now, by token: each holds a lock named for itself for
// as long as its page lives. null when the browser cannot say.
async function winOpenTokens() {
  try {
    if (!navigator.locks || !navigator.locks.query) return null;
    const q = await navigator.locks.query();
    return (q.held || []).map((l) => String(l.name || ""))
      .filter((n) => n.indexOf("lset-win:") === 0).map((n) => n.slice(9));
  } catch (e) { return null; }
}

/* Does this window carry out a navigation the assistant asked for? One
   window does: the one last used when it is still open, else the main
   window, else the first by name. */
async function winTakesNavigation() {
  let cur = null;
  try { cur = localStorage.getItem(WIN_ACTIVE_KEY); } catch (e) { return true; }
  if (cur === lseWin.token) return true;
  const open = await winOpenTokens();
  if (open === null) return !cur && lseWin.id === "main";
  if (cur && open.includes(cur)) return false;
  const mains = open.filter((t) => t.indexOf("main.") === 0);
  const pick = (mains.length ? mains : open).slice().sort()[0];
  return !pick || pick === lseWin.token;
}

/* Another window saved a workspace section: read again the parts of it
   this window shows. The chart bundle keeps its own copy of its sections;
   it is told to drop that copy, and reads the file at its next use. */
async function winSectionChanged(section) {
  try {
    if (window.LSEChart && window.LSEChart.invalidateWorkspaceSection) {
      window.LSEChart.invalidateWorkspaceSection(section);
    }
  } catch (e) { /* an older bundle without the call */ }
  if (section === "dashboards") {
    if (typeof dashRemoteChanged === "function") dashRemoteChanged();
    return;
  }
  if (section !== "shell") return;
  let v = null;
  try {
    const body = await fetch("/api/workspace/shell").then((r) => (r.ok ? r.json() : null));
    v = body && body.value;
  } catch (e) { return; }
  if (!v || typeof v !== "object") return;
  // The lists every window shares: stars, favourite indicators, the rail's
  // cards. The chart type and active indicators stay each window's own.
  if (v.watchlists && typeof v.watchlists === "object") {
    const next = {};
    for (const [prov, list] of Object.entries(v.watchlists)) {
      if (Array.isArray(list)) next[prov] = list.filter((x) => typeof x === "string");
    }
    if (JSON.stringify(next) !== JSON.stringify(state.watchlists || {})) {
      state.watchlists = next;
      if (state.provider && state.provider !== "userdata" &&
          !$("side").classList.contains("hidden")) renderWatchlist();
    }
  }
  if (Array.isArray(v.favoriteIndicators)) {
    state.favoriteIndicators = v.favoriteIndicators.filter((n) => typeof n === "string");
  }
  if (Array.isArray(v.railWidgets) && typeof rw !== "undefined" && rw && rw.loaded) {
    const list = v.railWidgets.filter((x) => x && RW_DEFS[x.type]);
    if (JSON.stringify(list) !== JSON.stringify(rw.list)) { rw.list = list; rwRenderStack(); }
  }
}

function setupWindows(hosted) {
  const btn = $("win-new");
  if (hosted) {
    // the hosted page is one embedded frame; there is no second window of it
    if (btn) btn.classList.add("hidden");
    return;
  }
  if (btn) btn.onclick = () => winOpen();
  // Ctrl-click (Cmd on a Mac) or middle-click on a tab opens that tab in a
  // new window, as a browser does with a link. Capture phase: the tab's own
  // handler must not also switch this window.
  const tabOf = (e) => (e.target && e.target.closest
    ? e.target.closest(".rail-btn, .subrail-btn") : null);
  document.addEventListener("click", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    const view = viewOfTab(tabOf(e));
    if (!view) return;
    e.preventDefault(); e.stopPropagation();
    winOpen(view);
  }, true);
  document.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const view = viewOfTab(tabOf(e));
    if (!view) return;
    e.preventDefault(); e.stopPropagation();
    winOpen(view);
  }, true);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey &&
        (e.key === "N" || e.key === "n")) {
      e.preventDefault();
      winOpen();
    }
  }, true);
  // presence, and "the window last used"
  try {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request("lset-win:" + lseWin.token, () => new Promise(() => {}));
    }
  } catch (e) { /* no locks: winTakesNavigation falls back to the mark alone */ }
  window.addEventListener("focus", winMarkActive);
  document.addEventListener("pointerdown", winMarkActive, true);
  document.addEventListener("keydown", winMarkActive, true);
  window.addEventListener("pagehide", () => {
    try {
      if (localStorage.getItem(WIN_ACTIVE_KEY) === lseWin.token) {
        localStorage.removeItem(WIN_ACTIVE_KEY);
      }
    } catch (e) { /* storage disabled */ }
  });
  if (document.hasFocus()) winMarkActive();
}

/* ── UI event bus: the assistant's open_in_app tool drives the screen ──
   The engine pushes navigation events over SSE (/api/ui/events); this
   window performs them with the same view functions the user's own clicks
   use, and announces each one in the status line so nothing moves
   silently. Local app only (the endpoint denies hosted mode). */
function uiEventsConnect() {
  let delay = 3000;
  const open = () => {
    const es = new EventSource("/api/ui/events");
    es.onopen = () => { delay = 3000; };
    es.onmessage = (m) => {
      try { uiEventHandle(JSON.parse(m.data)); } catch (e) { /* malformed */ }
    };
    es.onerror = () => {
      es.close();
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  open();
}

// Bridge into the AI panel's closure for bus events that concern it
// (assigned by setupAiPanel; null on the hosted build where the panel is
// hidden and the bus never connects anyway).
let aiPanelNotify = null;
// Repaint the assistant's empty-state hero (assigned by setupAiPanel). The
// hero states what the assistant sees (section, symbol, timeframe) and its
// starts name that symbol, so a symbol / timeframe / section change while
// the transcript is still empty must redraw it; a transcript with messages
// is left alone (no-op).
let aiPanelRefreshEmpty = () => {};
// Send one message through the assistant's own composer path (assigned by
// setupAiPanel): the STRATEGY BRIEF's BUILD button and anything else
// outside the panel that wants to ask something. No-op on the hosted build.
let aiPanelSend = () => false;

async function uiEventHandle(ev) {
  if (ev.type === "agent_signed_out") {
    // The CLI's machine-global login vanished (a /logout elsewhere, an
    // interrupted /login, revocation). Say so now instead of letting the
    // next message fail.
    if (aiPanelNotify) {
      aiPanelNotify(ev.agent,
        "Signed out of this machine's " +
        (ev.agent === "claude" ? "Claude" : ev.agent) +
        " login (from outside this panel or by sign-out). Use Switch " +
        "account or the sign-in card to continue.");
    }
    return;
  }
  if (ev.type === "workspace_section") {
    // another window saved a workspace section (the engine names the sender)
    if (ev.by !== lseWin.token) await winSectionChanged(String(ev.section || ""));
    return;
  }
  // A navigation moves ONE window: the one last used. File changes below
  // (workspace_changed, workspace_removed) concern every window.
  if (["open_dataset", "open_file", "open_backtest_run", "show_chart",
       "open_section"].includes(ev.type) && !(await winTakesNavigation())) return;
  if (ev.type === "open_dataset") {
    await openBacktest("py");
    const d = (state.datasetList || []).find((x) => x.symbol === ev.symbol);
    if (!d) return;
    pySetDataset(d.symbol);
    pyShowPreview(d);
    status(`assistant opened ${d.symbol}`);
  } else if (ev.type === "open_file") {
    await openBacktest("py");
    await pyOpen(ev.path);
    status(`assistant opened ${ev.path}`);
  } else if (ev.type === "open_backtest_run") {
    // The assistant's show_backtest tool: put the strategy it
    // just tested on screen with the results window the IDE already draws
    // (trade list, equity curve, plot panes, stats). Exactly what "To
    // strategy IDE" then RUN does by hand: file the block under its # name
    // (a same-named file with the same code is reused, never duplicated),
    // pin the dataset, run. The write is client-side and never overwrites,
    // which is what keeps the assistant's tool path read-only on the engine.
    const code = String(ev.script || "");
    if (!code.trim()) return;
    await openBacktest("py");
    const pin = pyRunPin(code);
    const target = "strategies/" + pyStrategyFileName(code, pin) + ".py";
    let reused = false;
    if (py.files.some((f) => f.path === target)) {
      await pyOpen(target);
      reused = $("py-code").value.trim() === code.trim();
    }
    if (!reused) await pyCreateFile(target, code);
    const sym = (pin && pin.symbol) || ev.symbol;
    if (sym && (state.datasetList || []).some((d) => d.symbol === sym)) {
      pySetDataset(sym);
    }
    status(`assistant is running ${py.open || target}`);
    await pyBacktest();
  } else if (ev.type === "show_chart") {
    // BACKTEST > CHARTS is gone; an older sidecar's view=chart
    // still emits this, so it means the same as open_dataset now.
    await openBacktestDataset(ev.symbol);
    status(`assistant opened ${ev.symbol || state.symbol}`);
  } else if (ev.type === "open_section") {
    const sec = String(ev.section || "");
    if (sec === "markets") $("rail-markets").click();
    else if (sec === "economic") $("rail-econ").click();
    else if (sec === "workspace") $("rail-workspace").click();
    else if (sec === "research") $("rail-research").click();
    else if (sec === "guide") $("rail-guide").click();
    else if (sec === "mydata") $("rail-data").click();
    else if (sec.startsWith("backtest")) {
      await openBacktest(sec.split(":")[1] || "");
    }
    status(`assistant opened ${sec}`);
  } else if (ev.type === "workspace_changed") {
    // A file changed on disk (agent Edit/Write, MCP tool, revert): refresh
    // the explorer, and reload any open buffer FROM DISK. Never route this
    // through pyOpen: it saves a dirty buffer first, which would overwrite
    // the agent's edit with the stale editor content.
    await refreshLibraryAll();
    if (py.open === ev.path) await pyReloadFromDisk(ev.path);
    if (wsx.bufs[ev.path]) await wsxReloadFromDisk(ev.path);
    status(`${ev.path} updated by the assistant`);
  } else if (ev.type === "workspace_removed") {
    // Deleted outside the app's own delete flow (agent or external tool).
    await refreshLibraryAll();
    if (py.tabs.includes(ev.path)) pyCloseTab(ev.path);
    if (py.open === ev.path) { py.open = null; pyIdeSetCode(""); }
    if (wsx.bufs[ev.path]) wsxCloseTab(ev.path, true);
    status(`${ev.path} was deleted`);
  }
}

function setupAiPanel(hosted) {
  const rail = $("ai-rail");
  if (!rail) return;
  if (hosted) {
    // Hosted site build: no local agent CLIs and no per-user key file for
    // the assistant proxy, so the whole rail stays out of the layout.
    rail.classList.add("hidden");
    return;
  }
  const ai = { term: null, fit: null, ws: null, ptyAgent: null, poll: null,
               push: null, mtime: 0, agent: "lse", mode: "chat",
               meta: {}, sessions: {}, chatsDir: "" };
  // Pull the on-disk chat log into localStorage once at startup, so history
  // survives a cleared cache or a different browser profile.
  syncChatsFromDisk();
  // Signed-out bus events land as a note in that agent's transcript and
  // force a status re-probe so the welcome/account cards flip to Sign in.
  aiPanelNotify = (agent, text) => {
    session(agent).msgs.push({ kind: "note", text });
    refreshStatus().then(chatRender);
  };
  aiPanelRefreshEmpty = () => {
    if (ai.mode !== "chat" || !ai.sessions[ai.agent] || ai.sessions[ai.agent].msgs.length) return;
    if (!$("air-welcome")) return; // no hero on screen (a card owns the pane)
    chatRender();
  };
  aiPanelSend = (text) => {
    if (!text) return false;
    if (rail.classList.contains("collapsed")) $("air-expand").click();
    if (ai.mode !== "chat") setMode("chat");
    $("air-input").value = text;
    sendChat();
    return true;
  };

  const label = (a) => (ai.meta[a] && ai.meta[a].label) || AI_LABEL[a] || a;

  /* ----- keeping the user's own CLI current -----
     A CLI lists only the models it knows, so the model menus are only as
     new as the CLI. modelsSync asks the CLI for its models and, when it is
     behind: updates it by itself where the user turned that on (or the
     terminal installed it), else says so once per new version. cliUpdate
     runs the update and tells the user what happened, in that provider's
     transcript. Never during a turn; the engine refuses that too. */
  const cliName = (a) => AIR_CLI_NAME[a] || label(a);
  function noteTo(agent, text) {
    session(agent).msgs.push({ kind: "note", text });
    if (ai.agent === agent) chatRender();
  }
  function redrawModelMenus() {
    renderModelBtn();
    if (!$("air-model-menu").classList.contains("hidden")) renderModelMenu();
    if (ai.menu && ai.menu.view === "model" && !$("air-slash").classList.contains("hidden")) slashRender(true);
  }
  function cliUpdate(agent, asked) {
    if (aiCliUpdating[agent]) return Promise.resolve(null);
    const c = (aiLiveModels[agent] || {}).cli;
    const name = (c && c.name) || cliName(agent);
    noteTo(agent, `Updating ${name}${c ? " to " + c.latest : ""}…`);
    const run = aiCliUpdate(agent, asked);
    if (ai.agent === agent) redrawModelMenus();
    return run.then((r) => {
      if (!r) return r;
      let text;
      if (r.ok && r.changed) {
        text = `${name} updated: ${r.before} → ${r.after}. The model menu now lists what it offers.` +
          (asked ? " The terminal keeps it up to date from now on (« /autoupdate off » stops that)." : "");
      } else if (r.ok) {
        text = `${name} is already the newest its own updater offers (${r.after || r.before}).`;
      } else {
        text = `${name} could not be updated: ${r.error || "the update failed"}. It still works as it was` +
          (AIR_UPDATE_CMD[agent] ? `; you can also run « ${AIR_UPDATE_CMD[agent]} » in the Terminal view.` : ".");
      }
      noteTo(agent, text);
      if (ai.agent === agent) redrawModelMenus();
      return r;
    });
  }
  function modelsSync(agent, force) {
    return aiModelsRefresh(agent, force).then((changed) => {
      if (changed && ai.agent === agent) redrawModelMenus();
      if (aiShouldAutoUpdate(agent) && !session(agent).busy) {
        cliUpdate(agent, false);
      } else {
        const offer = aiUpdateOffer(agent);
        if (offer) noteTo(agent, offer);
      }
      return changed;
    });
  }
  function setAutoUpdate(agent, on) {
    return fetch("/api/ai/auto-update", { method: "POST", headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ agent, enabled: !!on }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) { noteTo(agent, "The setting could not be saved."); return; }
        noteTo(agent, on
          ? `The terminal keeps ${cliName(agent)} up to date from now on.`
          : `The terminal no longer updates ${cliName(agent)} by itself. /update still does it when you ask.`);
        return modelsSync(agent, true);
      })
      .catch(() => noteTo(agent, "The setting could not be saved."));
  }
  const session = (a) => {
    if (!ai.sessions[a]) ai.sessions[a] = { ws: null, msgs: [], busy: false, model: "", effort: "", id: "", sid: "", mode: "" };
    return ai.sessions[a];
  };

  /* ----- previous chats -----
     Every conversation is archived so the header's clock button can bring an
     old chat back, VS Code style. A chat gets its id at first save, its title
     from its first user message, and is re-saved at every turn boundary, so a
     reload loses at most the turn that was streaming.

     TWO stores, on purpose:
       - localStorage: the fast synchronous read the render path uses.
       - ~/.config/lse-terminal/chats/*.json: the RECORD. localStorage is
         capped, wiped by a cache clear, and invisible as files; a chat log the
         user is told they own has to be real files they can open and keep.
     Disk wins on conflict, since it is the one that survives.

     Each entry also carries `sid`, the agent CLI's own session id, which is
     what makes reopening a chat resume the conversation instead of showing a
     transcript the agent has forgotten. */
  const CHATS_KEY = "lset-air-chats";
  const chatId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function loadChats() {
    try { return JSON.parse(localStorage.getItem(CHATS_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveChats(list) {
    // localStorage quota is the cap; when a write fails, drop the oldest
    // chats until it fits rather than losing the newest.
    for (let keep = list.length; keep >= 0; keep -= 1) {
      try {
        localStorage.setItem(CHATS_KEY, JSON.stringify(list.slice(0, keep)));
        return;
      } catch (e) { /* quota exceeded; retry with fewer chats */ }
    }
  }
  function persistChat(agent) {
    const s = session(agent);
    // Transient cards (installs, sign-in offers) re-derive from live state,
    // so only real conversation turns are worth archiving.
    const msgs = s.msgs.filter((m) => ["user", "text", "tool", "toolcard", "note", "error"].includes(m.kind));
    const first = msgs.find((m) => m.kind === "user");
    if (!first) return; // nothing said yet: no archive entry
    if (!s.id) s.id = chatId();
    const entry = { id: s.id, agent, ts: Date.now(), title: first.text.slice(0, 80),
                    model: s.model || "", effort: s.effort || "", sid: s.sid || "",
                    mode: s.mode || "", msgs };
    const list = loadChats().filter((c) => c.id !== s.id);
    list.unshift(entry);
    saveChats(list.slice(0, 40));
    saveChatToDisk(entry);
  }

  // The durable half of persistChat. Fire and forget: a failed write must never
  // block the chat, and localStorage still holds the conversation either way.
  function saveChatToDisk(entry) {
    fetch(`${API_PREFIX}/api/ai/chats/${encodeURIComponent(entry.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    }).catch(() => { /* hosted build or engine restarting; localStorage stands */ });
  }

  // Merge the on-disk log into localStorage at startup. Disk is authoritative
  // because it is the copy that survives a cache clear, a different browser
  // profile, or the 40-chat cap; without this merge the history menu would
  // still look empty on a machine whose browser storage was wiped even though
  // every conversation was sitting in the user's config folder.
  async function syncChatsFromDisk() {
    let doc;
    try {
      const r = await fetch(`${API_PREFIX}/api/ai/chats`);
      if (!r.ok) return;
      doc = await r.json();
    } catch (e) { return; } // hosted build has no chat store
    ai.chatsDir = doc.dir || "";
    const local = loadChats();
    const byId = new Map(local.map((c) => [c.id, c]));
    let added = 0;
    for (const meta of (doc.chats || [])) {
      if (byId.has(meta.id)) { byId.get(meta.id).sid = byId.get(meta.id).sid || meta.sid; continue; }
      try {
        const full = await (await fetch(
          `${API_PREFIX}/api/ai/chats/${encodeURIComponent(meta.id)}`)).json();
        if (full && full.id) { local.push(full); added += 1; }
      } catch (e) { /* one unreadable file must not stop the merge */ }
    }
    if (added) {
      local.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      saveChats(local);
    }
  }

  // "+" (and /new): the current conversation is already archived at each turn
  // boundary, so just open a blank one. The agent's server-side context is
  // reset so the fresh chat really is fresh.
  function newChat() {
    const s = session(ai.agent);
    persistChat(ai.agent);
    if (ai.agent === "lse" && s.abort) s.abort.abort();
    s.msgs = [];
    s.id = chatId();
    s.sid = "";           // a new chat must not inherit the old thread
    s.busy = false;
    if (s.ws && s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({ type: "reset" }));
      s.ws.__sidSynced = "";
    }
    histClose();
    chatRender();
    $("air-input").focus();
  }

  // Reopen an archived chat AND carry on with it.
  //
  // This used to send a hard "reset", so a reopened chat was a dead
  // transcript: the words were on screen, the agent remembered none of them,
  // and the next message started from nothing ("I can't continue
  // from where I left off"). We now hand the stored session id back, so the
  // next turn runs as `claude --resume <sid>` / `codex exec resume <sid>` and
  // the agent picks up where it stopped. The LSE Assistant needs none of this:
  // it replays the transcript to the model every turn already.
  function openChat(c) {
    const s = session(c.agent);
    if (s.id !== c.id) persistChat(c.agent); // keep the live chat before swapping it out
    if (c.agent === "lse" && s.abort) s.abort.abort();
    s.msgs = (c.msgs || []).slice();
    s.id = c.id;
    s.sid = c.sid || "";
    s.model = c.model || "";
    s.effort = c.effort || "";
    s.mode = c.mode || "";
    s.busy = false;
    if (s.ws && s.ws.readyState === 1) {
      if (c.agent === "lse" || !s.sid) {
        s.ws.send(JSON.stringify({ type: "reset" }));
        s.ws.__sidSynced = "";
      } else {
        // reset first: see the note in the send path. An older engine ignores
        // resume, and must not be left continuing the previous conversation.
        s.ws.send(JSON.stringify({ type: "reset" }));
        s.ws.send(JSON.stringify({ type: "resume", sid: s.sid }));
        s.ws.__sidSynced = s.sid;
      }
    }
    histClose();
    if (c.agent !== ai.agent) selectAgent(c.agent);
    if (ai.mode !== "chat") setMode("chat");
    else chatRender();
    renderModeHint();
    $("air-input").focus();
  }

  function histClose() { $("air-hist-menu").classList.add("hidden"); }
  function histWhen(ts) {
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days < 1) return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days < 7) return days + "d ago";
    return new Date(ts).toLocaleDateString();
  }
  function renderHist() {
    const menu = $("air-hist-menu");
    menu.innerHTML = "";
    const list = loadChats();
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "air-hist-empty";
      e.textContent = "No previous chats yet.";
      menu.appendChild(e);
    }
    for (const c of list) {
      const row = document.createElement("div");
      row.className = "air-hist-row" + (c.id === session(ai.agent).id ? " active" : "");
      row.innerHTML = aiLogoHtml(c.agent) +
        `<span class="air-hist-title">${aiEscape(c.title || "Untitled chat")}</span>` +
        `<span class="air-hist-when">${aiEscape(histWhen(c.ts || 0))}</span>`;
      const del = document.createElement("button");
      del.className = "air-hist-del";
      del.title = "Delete this chat";
      del.innerHTML = "&#215;";
      del.onclick = (ev) => {
        ev.stopPropagation();
        saveChats(loadChats().filter((x) => x.id !== c.id));
        // Delete the file too, or the next syncChatsFromDisk would restore
        // the chat the user just removed.
        fetch(`${API_PREFIX}/api/ai/chats/${encodeURIComponent(c.id)}`,
              { method: "DELETE" }).catch(() => {});
        renderHist();
      };
      row.appendChild(del);
      row.onclick = () => openChat(c);
      menu.appendChild(row);
    }
    // Where the log lives, as the raw path. Users want to be able to keep
    // a log of their chats; a folder they can open is the answer, so the menu
    // states the location rather than describing it.
    if (ai.chatsDir) {
      const foot = document.createElement("div");
      foot.className = "air-hist-foot";
      foot.textContent = ai.chatsDir;
      foot.title = "Click to copy";
      foot.onclick = (ev) => {
        ev.stopPropagation();
        navigator.clipboard.writeText(ai.chatsDir).then(
          () => status("chat folder path copied"), () => {});
      };
      menu.appendChild(foot);
    }
  }

  // Provider picker: the hosted LSE Assistant always leads (it is the
  // default and needs no local install), then the engine's agent registry,
  // so a new agent on the server shows up here with no shell change. Every
  // row carries the provider's logo and its install/sign-in state; the
  // active row gets a check instead. Re-fetched when returning from the
  // terminal view, so a completed sign-in flips the chat over.
  function agentStatus(name) {
    if (name === "lse") return "Hosted";
    const m = ai.meta[name] || {};
    if (m.installed === false) return "Not installed";
    if (m.authed === false) return "Sign in";
    if (m.mode === "api-key") return "API key";
    if (m.mode === "foundry") return "Foundry";
    // The signed-in account IS the status when the CLI's own local store
    // names it: "Ready" hid whose machine-global login the panel inherits.
    if (m.identity && m.identity.email) return m.identity.email;
    return "Ready";
  }
  function renderPicker() {
    $("air-picker-btn").innerHTML = aiLogoHtml(ai.agent) +
      `<span class="air-pick-cur">${aiEscape(label(ai.agent))}</span>` +
      `<span class="air-caret">&#9662;</span>`;
    const menu = $("air-picker-menu");
    menu.innerHTML = "";
    for (const name of ["lse"].concat(Object.keys(ai.meta))) {
      const row = document.createElement("button");
      row.className = "air-pick-row" + (name === ai.agent ? " active" : "");
      row.innerHTML = aiLogoHtml(name) +
        `<span class="air-pick-name">${aiEscape(label(name))}</span>` +
        (name === ai.agent
          ? '<span class="air-pick-check">&#10003;</span>'
          : `<span class="air-pick-status">${aiEscape(agentStatus(name))}</span>`);
      row.onclick = () => { menu.classList.add("hidden"); selectAgent(name); };
      menu.appendChild(row);
    }
  }
  function refreshStatus() {
    return fetch("/api/ai/status").then((r) => r.json()).then((s) => {
      ai.meta = s.meta || {};
      ai.paths = s.paths || {};
      renderPicker();
    }).catch(() => { renderPicker(); /* engine briefly away */ });
  }
  renderPicker();
  refreshStatus();

  $("air-picker-btn").onclick = (e) => {
    e.stopPropagation();
    histClose();
    $("air-picker-menu").classList.toggle("hidden");
  };
  $("air-hist-btn").onclick = (e) => {
    e.stopPropagation();
    $("air-picker-menu").classList.add("hidden");
    const menu = $("air-hist-menu");
    if (menu.classList.contains("hidden")) {
      renderHist(); // rebuilt on every open: chats archive as they happen
      menu.classList.remove("hidden");
    } else {
      histClose();
    }
  };
  $("air-new").onclick = newChat;

  /* ----- settings: the instruction .md files every agent reads -----
     The gear (the collapse button's old spot) lists the workspace's context
     files. USER.md is the user's persistent custom instructions; the
     generated briefs open read-only, because a workspace push rewrites them
     and would eat hand edits. */
  function setClose() { $("air-set-menu").classList.add("hidden"); }
  function renderSet(files, dir) {
    // Only the files the ACTIVE provider actually involves (six
    // internal filenames read as mystery clutter). USER.md
    // always, the terminal briefing once, plus the one context file the
    // signed-in local CLI reads; the other CLIs' name-clones stay on disk
    // for whoever runs those tools but stay out of the list.
    const ctxFor = { claude: "CLAUDE.md", codex: "AGENTS.md",
                     kimi: "AGENTS.md", copilot: "AGENTS.md",
                     opencode: "AGENTS.md", gemini: "GEMINI.md",
                     qwen: "QWEN.md" };
    const keep = new Set(["USER.md", "LSE-TERMINAL.md"]);
    if (ctxFor[ai.agent]) keep.add(ctxFor[ai.agent]);
    files = files.filter((f) => keep.has(f.name));
    const menu = $("air-set-menu");
    menu.innerHTML = "";
    const head = document.createElement("div");
    head.className = "air-set-head";
    head.textContent = "Instruction files the AI reads";
    menu.appendChild(head);
    for (const f of files) {
      const row = document.createElement("button");
      row.className = "air-set-row";
      row.innerHTML = `<span class="air-set-name">${aiEscape(f.name)}</span>` +
        `<span class="air-set-tag">${f.editable ? "Yours, editable" : "Auto-generated"}</span>`;
      row.onclick = () => { setClose(); openMd(f); };
      menu.appendChild(row);
    }
    if (dir) {
      const foot = document.createElement("div");
      foot.className = "air-set-dir";
      foot.textContent = dir;
      foot.title = "The agent workspace folder on this computer";
      menu.appendChild(foot);
    }
  }
  $("air-set-btn").onclick = (e) => {
    e.stopPropagation();
    histClose();
    modelClose();
    $("air-picker-menu").classList.add("hidden");
    const menu = $("air-set-menu");
    if (!menu.classList.contains("hidden")) { setClose(); return; }
    menu.innerHTML = '<div class="air-set-head">loading…</div>';
    menu.classList.remove("hidden");
    // A fresh install has no workspace yet; push one first so the files
    // listed are exactly what an agent would read right now.
    fetch("/api/ai/workspace", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: workspaceBody() })
      .then(() => fetch("/api/ai/instructions"))
      .then((r) => r.json())
      .then((d) => renderSet(d.files || [], d.dir))
      .catch(() => { menu.innerHTML = '<div class="air-set-head">engine away; try again</div>'; });
  };

  function openMd(f) {
    $("air-md-name").textContent = f.name;
    $("air-md-note").textContent = f.editable
      ? "Added to every provider's briefing."
      : "Auto-generated; put changes in USER.md.";
    const t = $("air-md-text");
    t.value = f.content || "";
    t.readOnly = !f.editable;
    $("air-md-save").classList.toggle("hidden", !f.editable);
    $("air-md-status").textContent = "";
    $("air-chat").classList.add("hidden");
    $("air-term").classList.add("hidden");
    $("air-md").classList.remove("hidden");
    if (f.editable) t.focus();
  }
  function closeMd() {
    $("air-md").classList.add("hidden");
    setMode(ai.mode); // restores whichever of chat/terminal was on screen
  }
  $("air-md-close").onclick = closeMd;
  $("air-md-save").onclick = async () => {
    const st = $("air-md-status");
    st.textContent = "saving…";
    const r = await fetch("/api/ai/instructions", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "USER.md", content: $("air-md-text").value }),
    }).catch(() => null);
    if (r && r.ok) {
      pushWorkspace(); // rebake the generated briefs with the new text
      st.textContent = "saved";
    } else {
      st.textContent = "could not save (engine away?)";
    }
  };

  // Outside click or Escape dismisses the menus, like every other popover.
  document.addEventListener("click", (e) => {
    for (const id of ["air-picker-menu", "air-hist-menu", "air-set-menu", "air-auto-menu", "air-model-menu"]) {
      const menu = $(id);
      if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
        menu.classList.add("hidden");
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("air-picker-menu").classList.add("hidden");
      histClose();
      setClose();
      autoClose();
      toolsClose();
    }
  });

  const hasEditor = () => !!$("bt-src");

  /* Account snapshot for the agent's context file. Reads the same state the
     positions dock renders, so what the agent is told and what the user sees
     cannot drift apart. Null account (no sim session) yields null, not a
     fabricated empty book, so the agent says "no account" instead of
     "no positions". */
  const aiAccountNow = () => {
    try {
      return aiAccountBuild();
    } catch (e) {
      // NEVER throw from here. workspaceBody() calls this inline, so an
      // exception takes the whole POST down and the agent gets NO context
      // at all, which is strictly worse than partial context (a
      // half-initialised state at startup is exactly when the first push
      // happens).
      return { error: String(e),
               note: "account snapshot failed; call get_positions" };
    }
  };

  const aiAccountBuild = () => {
    if (!tpx || !tpx.acct) return null;
    // /api/sim/positions returns no current price (checked:
    // it gives account_id, avg_price, id, opened_at, qty, sl_price, symbol,
    // tp_price, unrealized_pnl, updated_at). The price MUST be derived the
    // same way acdRenderPositions derives the dock's Price column, or the
    // agent quotes a different number than the user is reading: from
    // state.quotes, marked at the CLOSING side (bid exits a long, ask exits
    // a short). state.prices (last trade) is the wrong cache and has no side
    // convention. Null when no quote has arrived for that symbol yet, which
    // happens whenever the position is not on the chart or the watchlist.
    const poss = (tpx.positions || []).map((p) => {
      // dockQuote: broker-fed quotes when the ticket trades through
      // brue-connect, the site feed otherwise; broker positions carry the
      // broker's own symbol spelling, which state.quotes has never heard of.
      const q = dockQuote(p.symbol);
      const cur = q ? (p.qty > 0 ? q.bid : q.ask) : null;
      return {
      symbol: p.symbol,
      side: p.qty > 0 ? "long" : "short",
      qty: Math.abs(p.qty),
      avg_price: p.avg_price,
      price: cur,
      bid: q ? q.bid : null,
      ask: q ? q.ask : null,
      // When that quote arrived. A five-hour-old price on a closed market
      // must not be reported as the current one.
      price_ts: q && q.ts ? new Date(q.ts).toISOString() : null,
      price_synthetic: q ? !!q.synthetic : null,
      unrealized_pnl: p.unrealized_pnl,
      // Whether a position is protected is a question users actually ask,
      // and null is a meaningful answer ("no stop set"), not missing data.
      sl_price: p.sl_price === undefined ? null : p.sl_price,
      tp_price: p.tp_price === undefined ? null : p.tp_price,
      trail_points: p.trail_points || 0,
      opened_at: p.opened_at || null,
      };
    });
    // The dock's broker, when the ticket trades through one: a broker whose
    // terms keep its prices on this computer has the current prices of its
    // positions left out of what an assistant is given, with the reason.
    const dockBroker = (typeof tpb !== "undefined" && tpb && tpb.broker) || "lse-hosted";
    return aiWithholdAccount({
      name: tpx.acct.name || "",
      balance: tpx.acct.balance,
      equity: tpx.acct.equity,
      open_pnl: poss.reduce((a, p) => a + (p.unrealized_pnl || 0), 0),
      leverage: tpx.acct.leverage,
      currency: tpx.acct.currency || "",
      starting_balance: tpx.acct.starting_balance,
      used_margin: tpx.acct.used_margin,
      positions: poss,
    }, termsWithheld(brokerPicker.rows, dockBroker));
  };

  /* ── the screen map ────────────────────────────────────────────────────
     One self-describing snapshot of the whole terminal, rebuilt on every
     prompt. Each region says four things: WHERE it is (bounds, visible),
     WHAT it currently holds (summary + data), and CRUCIALLY what to call to
     get more (`more`). That last field is the point: the agent does not need
     a brief that enumerates every possible question, it reads the map, sees
     which region owns the thing being asked about, and knows the tool or
     endpoint that answers it.

     Why a map rather than a screenshot: a vision model cannot read a P&L
     reliably (it once read EUR/JPY as "EURUSD" and flipped +69.17 to
     -77.37), and pixels cannot express a HIDDEN panel at all, which is the
     difference between "your options chain is collapsed" and "you don't have
     one". The screenshot stays, for shape. This is for substance.

     Adding a field later means one entry here, not another incident. */
  const AI_REGIONS = [
    { id: "rail", label: "Top navigation",
      what: "which section of the app is open",
      more: ["open_in_app to navigate"],
      data: () => ({ view: aiViewNow() }) },

    { id: "watchlist", label: "Watchlist (left sidebar)",
      what: "the instrument list and its live prices",
      more: ["GET /api/instruments?provider=&query=",
             "GET /api/prices?provider=&symbols=  (any symbol, on or off screen)"],
      data: () => {
        const ins = state.instruments || [];
        return {
          count: ins.length,
          groups_open: Object.keys(state.groupsOpen || {}).filter(
            (k) => state.groupsOpen[k]),
          // First 25 only: the full tape can be thousands and would drown
          // the context file. The endpoint above returns the rest.
          symbols: ins.slice(0, 25).map((i) => i.symbol),
          truncated: ins.length > 25,
        };
      } },

    { id: "chart-wrap", label: "Price chart",
      what: "the charted instrument, timeframe and overlaid indicators",
      more: ["get_candles for the actual bars",
             "GET /api/prices for the live quote"],
      data: () => {
        const c = state.candleData || [];
        const last = c.length ? c[c.length - 1] : null;
        const q = state.quotes[state.symbol];
        // A chart on a broker whose terms keep its prices on this computer
        // tells the assistant what is charted, never at what price, and why.
        const why = isBrokerSource(state.provider)
          ? termsWithheld(brokerPicker.rows, String(state.provider).slice("broker:".length)) : "";
        return aiWithholdChart({
          symbol: state.symbol, timeframe: state.timeframe,
          chart_type: state.chartType,
          bars_loaded: c.length,
          last_close: last ? last.close : null,
          last_bar_ts: last ? last.time || last.ts || null : null,
          bid: q ? q.bid : null, ask: q ? q.ask : null,
          // The answer to "what indicators are on my chart", which was
          // unanswerable before this map existed.
          indicators: (state.activeIndicators || []).map((i) => i.name),
        }, why);
      } },

    { id: "acct-dock", label: "Account dock (positions / history)",
      what: "the open positions, the account summary, and closed-trade history",
      more: ["get_positions for live positions with prices",
             "get_fills for closed trades and realised P&L",
             "both return one entry per connected account; this dock shows " +
             "the entry matching `broker` below"],
      // `broker` names which venue the dock is rendering: "lse-hosted" is
      // the hosted sim relay, anything else is a brue-connect broker. The
      // tools report every connected account, so without this field the
      // agent cannot tell which one the user is looking at.
      data: () => ({ tab: tpx.dockTab === "pos" ? "positions" : "history",
                     broker: (typeof tpb !== "undefined" && tpb)
                       ? tpb.broker : "lse-hosted",
                     account: aiAccountNow() }) },

    { id: "trade-panel", label: "Trade ticket",
      what: "the order form: symbol, quantity, stop and target being staged",
      // The order door follows the ticket's broker (see the acct-dock
      // region's `broker` field): the hosted sim relay takes /api/sim/orders;
      // a brue-connect broker takes /api/broker/order. Pointing the agent
      // only at the sim door made it trade the WRONG ACCOUNT whenever the
      // ticket was on a broker.
      more: ["broker \"lse-hosted\": POST /api/sim/orders places an order " +
             "(needs user approval)",
             "any other broker: POST /api/broker/order " +
             "{broker, symbol, side, qty, sl?, tp?} (needs user approval); " +
             "symbol must be the BROKER's spelling from its catalog"],
      // On a live connection whose broker has every order placed by hand
      // (SPEC 3.3), no door is offered: the sentence says why.
      moreNow: (more) => aiTradeDoor(brokerPicker.rows,
        (typeof tpb !== "undefined" && tpb) ? tpb.broker : "", more),
      data: () => {
        const v = (id) => { const e = $(id); return e ? e.value : null; };
        return { symbol: state.symbol, qty: v("tpx-qty"),
                 sl: v("tpx-sl"), tp: v("tpx-tp") };
      } },

    { id: "pyide", label: "Algo development IDE",
      what: "the strategy file being edited and the dataset it will backtest on",
      more: ["read_workspace_file / list_workspace",
             "run_backtest, run_walkforward, run_montecarlo"],
      data: () => {
        const runs = (() => { try {
          return JSON.parse(localStorage.getItem("lse.btRuns") || "{}");
        } catch (e) { return {}; } })();
        // The docked terminal's output travels WITH the region: "look at
        // the error message" was unanswerable while the map only said a
        // terminal existed. Tab-capped smaller
        // than the hosted headline tail so a chatty run cannot eat the map.
        const act = (py.terms || []).find((t) => t.id === py.termActive);
        return {
          open_file: py.open, unsaved_changes: !!py.dirty,
          dataset_selected: py.dataset || null,
          files: (py.files || []).map((f) => f.path || f),
          // Last run per strategy file, so "was that any good" does not
          // need a re-run.
          last_runs: runs,
          terminal: {
            tabs: (py.terms || []).map((t) => t.name),
            active_tab: act ? act.name : null,
            output_tail: act ? aiTermTail(act.term, 25, 1500) : "",
          },
        };
      } },

    { id: "wsx", label: "Workspace editor",
      what: "the general-purpose file editor and its open tabs",
      more: ["read_workspace_file / list_workspace / write_workspace_file"],
      data: () => ({
        open_file: wsx.open, tabs: wsx.tabs || [],
        terminal_mode: wsx.mode,
        // wsx tracks dirty per buffer, unlike py's single flag; report the
        // open file's state and every unsaved path, so "do I have unsaved
        // work" is answerable for this editor too.
        unsaved_changes: !!(wsx.open && wsx.bufs[wsx.open]
                            && wsx.bufs[wsx.open].dirty),
        unsaved_files: Object.keys(wsx.bufs || {}).filter(
          (k) => wsx.bufs[k] && wsx.bufs[k].dirty),
        // Same reason as the pyide region: the panel's printed output is
        // the thing users ask about ("what does this error mean").
        terminal_output_tail: wsx.term ? aiTermTail(wsx.term, 25, 1500) : "",
      }) },

    { id: "mydata", label: "My Data library",
      what: "the imported price and series datasets",
      more: ["list_datasets", "import_lse_data", "GET /api/data"],
      // null datasetList means NOT LOADED, never "empty": reporting an
      // empty library before the list has loaded makes the assistant burn
      // its tool budget searching the web for data it was told did not
      // exist.
      data: () => (state.datasetList
        ? { datasets: state.datasetList.map(
            // columns ride along so the assistant knows a series file's
            // shape without guessing (or web-searching for it).
            (d) => ({ symbol: d.symbol, timeframe: d.timeframe, kind: d.kind,
                      rows: d.rows,
                      ...(d.columns && d.columns.length
                          ? { columns: d.columns } : {}) })) }
        : { note: "dataset list not loaded yet this session; it is NOT " +
                  "known to be empty. GET /api/data or list_datasets " +
                  "returns the real contents." }) },

    { id: "mlpage", label: "ML Studio",
      what: "machine-learning blueprints, models and running jobs",
      more: ["list_ml_models, generate_ml_blueprint, build_ml_dataset",
             "run_ml_blueprint, get_ml_job"],
      data: () => ({
        model: ml.model ? { key: ml.model.key, name: ml.model.name } : null,
        job: ml.job ? (ml.job.id || ml.job) : null,
        // The blueprint code ON SCREEN, capped like the editor headline.
        // This region used to carry only {model, job}, which is why the
        // assistant could describe the ML page but not read the script the
        // user was editing on it.
        blueprint: (($("ml-code") || {}).value || "").slice(0, 4000) || null,
      }) },

    { id: "optpage", label: "Options chain",
      what: "the option chain for an underlying",
      // The param is `underlying` (symbol= 422s).
      more: ["GET /api/options/chain?underlying="],
      // optState directly: the old (window.optState||{}).symbol read null
      // forever (top-level const is not a window property, and the field
      // is `und`), so the agent never knew the underlying.
      data: () => ({ view: optState.view,
                     underlying: optState.und || null,
                     expiry: optState.expiry || null,
                     rows_loaded: (optState.chainRows || []).length,
                     underlyings_available: (optState.unds || []).length,
                     // Spelled out so the model does not borrow the CHART
                     // symbol as the chain's underlying.
                     status: optState.und ? "chain loaded"
                       : "no underlying selected; the chain is empty and "
                         + "belongs to NO symbol yet" }) },

    // One host element carries FOUR economic views (the LSEEconCalendar
    // island remounts with a view prop), so a bare "Economic calendar"
    // label would make the assistant call the BOND YIELDS page "the
    // Economic Calendar panel". The open view comes from the subrail, the
    // same source aiViewNow trusts.
    { id: "econcal", label: "Economic pages (calendar / indicators / bond yields / central banks)",
      what: "the ECONOMIC section; data.open_view names which of its views is mounted",
      more: ["get_economics"],
      data: () => {
        const sb = document.querySelector("#subrail .subrail-btn.active");
        // The React island publishes its own live state (which country,
        // which series is open, curve vs board...); the
        // subrail label stays as the fallback for an old bundle.
        const isl = window.__lseAiIslands || {};
        return { open_view: sb ? sb.textContent.trim() : null,
                 ...(isl.econ || {}),
                 detail: isl.econ_detail || null };
      } },

    { id: "news", label: "News",
      what: "the headline feed and its globe",
      // There is NO /api/news route; the wire is
      // a static asset refreshed server-side.
      more: ["GET /assets/news/news_wire.json"],
      data: () => ({
        headlines_loaded: (newsGlobe.events || []).length,
        top_headlines: (newsGlobe.events || []).slice(0, 5).map(
          (e) => ({ headline: e.headline, source: e.source })),
        selected: newsGlobe.sel >= 0 && newsGlobe.events[newsGlobe.sel]
          ? newsGlobe.events[newsGlobe.sel].headline : null,
      }) },

    { id: "research", label: "Research",
      what: "the papers feed, the in-app paper reader and quant models",
      more: ["read_research_paper on the paper's link for its FULL text",
             "GET /api/research/feed"],
      // The paper is reported even when the reader is hidden (it is what
      // the user last read; open_in_reader says whether it is on screen
      // NOW). Before this the region was {}, which is how the assistant
      // ended up asking "which paper?" while one filled the screen.
      data: () => {
        const rd = $("rs-reader");
        const readerOpen = !!(rd && rd.offsetParent !== null);
        const it = rsState.readerItem;
        // The inner view matters: without it the QUANT MODELS page was
        // described as "a library of papers" in simulation,
        // because papers_loaded was the only signal in the region.
        const vis = (id) => { const el = $(id); return !!(el && el.offsetParent !== null); };
        return {
          view: readerOpen ? "paper reader"
            : vis("rs-models") ? "quant models (interactive model visualisations, NOT the papers feed)"
            : vis("rs-articles") ? "articles feed" : null,
          papers_loaded: (rsState.items || []).length,
          source_filter: rsState.srcFilter,
          category_filter: rsState.catFilter,
          reader_open: readerOpen,
          paper: it ? { title: it.title || null,
                        authors: it.authors || [],
                        source: it.source || null,
                        category: it.category || null,
                        link: it.link || null,
                        open_in_reader: readerOpen } : null,
          // Which interactive model visualisation is open (published by
          // the QuantModels island).
          quant_models: (window.__lseAiIslands || {}).quant_models || null,
        };
      } },

    { id: "backtest", label: "Backtest results",
      what: "the equity curve, trade markers and stats of the last run",
      more: ["run_backtest returns the same result as JSON"],
      data: () => ({ engine: backtest.engine }) },

    { id: "scrpage", label: "Screener",
      what: "the market screener table: filters, sort and the rows listed",
      more: ["GET /api/screener?provider=lse for the full snapshot"],
      data: () => ({
        view: scrState.view,
        class_filter: scrState.cls || "all",
        search: scrState.q || null,
        sort: scrState.sort ? { column: scrState.sort.col,
          direction: scrState.sort.dir === -1 ? "desc" : "asc" } : null,
        rows_listed: (scrState.shown || []).length,
        // Top of the CURRENT sort only; the endpoint above has the rest.
        top_rows: (scrState.shown || []).slice(0, 10).map((r) => r.symbol),
      }) },

    { id: "lse-connect", label: "LSE Connect",
      what: "the LSE data key connect form (shown until a key is saved)",
      more: ["the top-left key manager switches data sources"],
      data: () => ({ lse_key_connected: !!state.lseConfigured,
                     provider: state.provider || null }) },

    // NOT the economic pages (those live in econcal above): this element
    // hosts WORKSPACE > DATA VISUALISATION, the chart builder over the
    // user's own tables. The first label said "Economic data pages" and
    // the assistant described the chart builder as a Python IDE.
    { id: "dataviz", label: "Data visualisation (WORKSPACE chart builder)",
      what: "build charts from your own imported tables (React island)",
      more: ["list_datasets for the tables it can chart"],
      data: () => (window.__lseAiIslands || {}).dataviz || {} },

    // WORKSPACE > NOTEBOOKS, the infinite research canvas. The island
    // publishes the open document's live state (block counts, the text and
    // maths in reading order, image names, armed tool); without this the
    // assistant was blind on the whole page.
    { id: "nbpage", label: "Notebooks (infinite research canvas)",
      what: "WORKSPACE > NOTEBOOKS: freeform canvases holding text, maths, "
        + "photos, ink and shapes; data.open.content is the open canvas's "
        + "text and LaTeX in reading order",
      more: ["GET /api/notebooks lists the library; "
             + "GET /api/notebooks/<id> returns a full canvas as JSON"],
      data: () => (window.__lseAiIslands || {}).notebooks || {} },

    { id: "manual-backtest", label: "Manual backtest (bar replay)",
      what: "step through history candle by candle and trade it by hand",
      more: ["the BACKTEST > MANUAL sub-tab hosts it"],
      data: () => (window.__lseAiIslands || {}).manual_backtest || {} },
  ];

  /* Visible means actually rendered, not merely present: offsetParent is null
     for anything display:none, which is how every page region here is
     toggled (266 hidden-class flips in this file). A collapsed panel is
     reported as visible:false WITH its data, so the agent can say "it is
     there but closed" instead of "you do not have one". */
  const aiRegionState = (id) => {
    const el = $(id);
    if (!el) return { present: false, visible: false, bounds: null };
    const r = el.getBoundingClientRect();
    return {
      present: true,
      visible: el.offsetParent !== null && r.width > 0 && r.height > 0,
      bounds: [Math.round(r.left), Math.round(r.top),
               Math.round(r.width), Math.round(r.height)],
    };
  };

  const aiTerminalNow = () => {
    try {
      return aiTerminalBuild();
    } catch (e) {
      // Same contract as aiAccountNow: a broken map must degrade, not stop
      // the user's prompt from being sent.
      return { error: String(e), regions: [],
               note: "screen map failed to build; rely on tools" };
    }
  };
  // The hosted LSE Assistant's aiContext() lives at top level (outside this
  // closure) and needs the SAME screen map: one universal source of vision
  // for every AI in the app, instead of the CLI agents seeing everything
  // and the hosted bot seeing only page + chart.
  window.aiTerminalNow = aiTerminalNow;

  const aiTerminalBuild = () => {
    const regions = [];
    for (const spec of AI_REGIONS) {
      const st = aiRegionState(spec.id);
      let data = null;
      // A throwing region must not cost the agent the whole map, so each
      // one is isolated and reports its own failure honestly.
      try { data = spec.data(); } catch (e) { data = { error: String(e) }; }
      // `moreNow`: a region whose doors depend on the moment (the ticket's,
      // on a connection whose broker's terms have orders placed by hand).
      let more = spec.more;
      if (typeof spec.moreNow === "function") {
        try { more = spec.moreNow(spec.more); } catch (e) { more = spec.more; }
      }
      regions.push({ id: spec.id, label: spec.label, what: spec.what,
                     ...st, more, data });
    }
    return {
      // Stamped so stale state is visible rather than silently wrong: the
      // screenshot was once 2.6 hours old and nothing said so.
      captured_at: new Date().toISOString(),
      // Lets the screenshot's pixels and this map's bounds share an origin.
      window: { w: window.innerWidth, h: window.innerHeight,
                dpr: window.devicePixelRatio || 1 },
      view: aiViewNow(),
      regions,
      note: "Every region carries `more`: the tool or endpoint that returns "
          + "its detail. Read the region that owns the question before "
          + "answering. `visible:false` with data means the panel exists but "
          + "is closed. Numbers here are authoritative; never read a number "
          + "off the screenshot.",
    };
  };

  const workspaceBody = () => JSON.stringify({
    // Same visible-editor rule as the hosted context (see aiVisibleEditorSrc):
    // bt-src alone missed the Python IDE's code.
    script: aiVisibleEditorSrc() || (hasEditor() ? $("bt-src").value : ""),
    provider: state.provider || "", symbol: state.symbol || "",
    timeframe: state.timeframe || "1h",
    // The strategy file open right now (either IDE), so the agent edits
    // THAT file when the user says "the code on my screen" instead of
    // guessing among similarly-named workspace files.
    open_file: py.open || wsx.open || "",
    view: aiViewNow(),
    // The live account and its open positions, as DATA. The agent can see
    // the screen (ai-workspace/chart.png), but a vision model reads 186.36
    // as 186.30 and flips the sign on a P&L, so anything numeric has to
    // arrive as numbers. Screenshot is for what the chart LOOKS like;
    // this is for what anything IS.
    // Both are total by construction (they catch internally), but the belt
    // stays on the braces: a thrown workspaceBody means the prompt never
    // reaches the agent, which is the one failure mode worth two guards.
    account: (() => { try { return aiAccountNow(); }
                      catch (e) { return null; } })(),
    // The whole screen, self-describing (see AI_REGIONS above).
    terminal: (() => { try { return aiTerminalNow(); }
                       catch (e) { return null; } })(),
  });

  function sendSize() {
    if (ai.ws && ai.ws.readyState === 1 && ai.term) {
      ai.ws.send(JSON.stringify({ type: "resize", cols: ai.term.cols, rows: ai.term.rows }));
    }
  }

  function ptyConnect() {
    if (ai.ws) { try { ai.ws.close(); } catch (e) { /* replacing */ } }
    ai.ptyAgent = ai.agent;
    // This panel reuses one xterm across every agent session, so each fresh
    // PTY inherits whatever the last one (or our own "switching to ..." /
    // "[exited]" notice) left on the screen, and its absolute cursor
    // addressing then paints into that instead of at its own prompt. Same
    // defect the WORKSPACE terminal had; see termFreshScreen. Reachable
    // here through /terminal, the "+" menu's terminal item and the CLI
    // sign-in flows, even though the Chat|Terminal toggle is hidden.
    let screenReady = false;
    let screenClearing = false;
    const queued = [];
    // loginNext (set by the chat "Sign in" button) launches the CLI's own
    // sign-in flow instead of its normal TUI, one time.
    const login = ai.loginNext ? "&login=1" : "";
    ai.loginNext = false;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
      `/api/ai/pty?agent=${encodeURIComponent(ai.agent)}${login}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = sendSize;
    ws.onmessage = (ev) => {
      // Same guard as the workspace terminal: a replaced socket's queued
      // frames must not interleave with the new agent's output.
      if (ai.ws !== ws) return;
      if (typeof ev.data === "string") {
        const m = JSON.parse(ev.data);
        if (m.type === "missing") {
          ai.term.write(`\r\n  ${label(ai.agent)} is not installed on this machine.\r\n` +
            "  Install it, sign in with your own subscription, then reopen:\r\n\r\n" +
            `    ${m.hint || ""}\r\n    ${ai.agent}\r\n`);
        } else if (m.type === "error") {
          ai.term.write(`\r\n  ${m.message}\r\n`);
        } else if (m.type === "exit") {
          ai.term.write(`\r\n  [${label(ai.agent)} exited - switch views to restart]\r\n`);
        }
      } else {
        // First bytes of the new session: clear the screen into the
        // scrollback before any of them are painted, and hold back frames
        // that land while that is in flight so none jumps ahead of the one
        // that started it.
        const frame = new Uint8Array(ev.data);
        if (screenReady) { ai.term.write(frame); return; }
        queued.push(frame);
        if (screenClearing) return;
        screenClearing = true;
        termFreshScreen(ai.term, () => {
          screenReady = true;
          for (const f of queued) ai.term.write(f);
          queued.length = 0;
        });
      }
    };
    ai.ws = ws;
  }

  /* ----- chat view ----- */

  // Providers whose sign-in the engine can drive on a hidden PTY (GUI-style
  // login card instead of the raw TUI). Mirrors AI_LOGIN on the server.
  const AIR_GUI_LOGIN = ["claude", "codex", "opencode"];

  // One-click CLI install: npm output streams into a progress card; when
  // it lands, status refresh flips the card to sign-in (or plain welcome).
  function startInstall() {
    if (ai.installing && ai.installing.ws) { try { ai.installing.ws.close(); } catch (e) { /* replacing */ } }
    const st = { agent: ai.agent, ws: null, line: "starting…", err: "" };
    ai.installing = st;
    ai.cardJump = true; // the card renders above the transcript (see chatRender)
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
      `/api/ai/install?agent=${encodeURIComponent(ai.agent)}`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "progress") {
        st.line = m.line || st.line;
      } else if (m.type === "ok") {
        // Only clear the card if this socket still owns it; a superseded
        // install's late "ok" must not blank a newer install's progress.
        if (ai.installing === st) ai.installing = null;
        session(st.agent).msgs.push({ kind: "note", text: `${label(st.agent)} installed.` });
        refreshStatus().then(chatRender);
      } else if (m.type === "error") {
        st.err = m.message || "install failed";
      }
      if (st.agent === ai.agent) chatRender();
    };
    ws.onclose = () => {
      // The final ok can race the close; a clean close with no error means
      // the install finished, so recheck reality instead of hanging.
      if (ai.installing === st && !st.err) {
        ai.installing = null;
        refreshStatus().then(chatRender);
      }
    };
    st.ws = ws;
    chatRender();
  }

  // The key-entry "Connect" card was deleted: users
  // connect every provider by logging into their own subscription, exactly
  // like the VS Code extensions; pasting platform keys is developer plumbing
  // that has no UI here. The backend /api/ai/key endpoint still honors a
  // previously saved key (it keeps working), and the account card offers the
  // one escape hatch: removing such a connection to fall back to the login.
  function removeKeyConnection() {
    fetch("/api/ai/key", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: ai.agent, key: "" }) })
      .then(() => {
        session(ai.agent).msgs.push({ kind: "note", text: "Connection removed." });
        refreshStatus().then(chatRender);
      });
  }

  function postCodexFullAccess(v) {
    fetch("/api/ai/settings", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codex_full_access: v }) })
      .then(() => {
        session("codex").msgs.push({ kind: "note", text: v
          ? "Full access enabled: ChatGPT commands now run without OpenAI's Windows sandbox on this PC."
          : "Full access disabled: ChatGPT commands use OpenAI's sandbox again." });
        refreshStatus().then(chatRender);
      });
  }

  // Account & usage: a real card, not a note buried at the bottom of a
  // long transcript.
  function buildAccountCard() {
    const meta = ai.meta[ai.agent] || {};
    const w = document.createElement("div");
    w.className = "air-login-card";
    const mode = meta.mode === "foundry" ? "Microsoft Foundry"
      : meta.mode === "api-key" ? "an API key" : "your own account";
    const who = meta.identity && meta.identity.email
      ? `yes, as <b>${aiEscape(meta.identity.email)}</b>` +
        (meta.identity.org ? ` (${aiEscape(meta.identity.org)})` : "")
      : (meta.authed === false ? "no" : meta.authed ? "yes" : "unknown");
    w.innerHTML = `<div class="air-w-name">${aiEscape(label(ai.agent))} · account &amp; usage</div>` +
      `<div class="air-w-sub">` +
      `Signed in: ${who}<br>` +
      `Connection: <b>${aiEscape(mode)}</b> (usage bills to it)<br>` +
      (ai.agent === "codex"
        ? `Command sandbox: <b>${meta.full_access ? "full access (OpenAI sandbox off)" : "OpenAI sandbox"}</b><br>`
        : "") +
      `Detailed usage lives in the agent's own terminal view.</div>`;
    if (meta.authed === false) {
      const b = document.createElement("button");
      b.className = "air-login";
      b.textContent = `Log in to ${label(ai.agent)}`;
      b.onclick = () => { ai.accountCard = null; startGuiLogin(); };
      w.appendChild(b);
    }
    if (meta.authed === true && AIR_GUI_LOGIN.includes(ai.agent)) {
      // Sign-out from where you signed in (it previously existed
      // only inside the raw terminal view). The engine drives the
      // CLI's own logout; the credential watcher then posts the
      // signed-out note, so no duplicate messaging here.
      const out = document.createElement("button");
      out.className = "air-login-alt as-btn";
      out.textContent = `Sign out of ${label(ai.agent)} on this machine`;
      out.onclick = async () => {
        out.disabled = true;
        out.textContent = "Signing out…";
        try {
          const r = await fetch("/api/ai/logout", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: ai.agent }),
          });
          if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
          ai.accountCard = null;
        } catch (e) {
          out.disabled = false;
          out.textContent = `Sign out failed: ${oneLine(e.message || e)}`;
          return;
        }
        refreshStatus().then(chatRender);
      };
      w.appendChild(out);
    }
    if (meta.mode && meta.mode !== "subscription") {
      const rem = document.createElement("button");
      rem.className = "air-login-alt as-btn";
      rem.textContent = "Remove this connection (back to your own login)";
      rem.onclick = () => { ai.accountCard = null; removeKeyConnection(); };
      w.appendChild(rem);
    }
    if (ai.agent === "codex") {
      const t = document.createElement("button");
      t.className = "air-login-alt as-btn";
      t.textContent = meta.full_access
        ? "Disable full access (restore OpenAI's sandbox)"
        : "Enable full access (fixes a broken Windows sandbox)";
      t.onclick = () => { ai.accountCard = null; postCodexFullAccess(!meta.full_access); };
      w.appendChild(t);
    }
    const close = document.createElement("button");
    close.className = "air-login-alt as-btn";
    close.textContent = "Close";
    close.onclick = () => { ai.accountCard = null; chatRender(); };
    w.appendChild(close);
    return w;
  }

  function buildInstallCard(st) {
    const w = document.createElement("div");
    w.className = "air-login-card";
    w.innerHTML = `<div class="air-w-name">${aiLogoHtml(st.agent)}Installing ${aiEscape(label(st.agent))}</div>` +
      `<div class="air-w-sub">${st.err
        ? `Install failed: ${aiEscape(st.err)}`
        : `Fetching it with npm on your machine. This usually takes under a minute.`}</div>` +
      (st.err ? "" : `<div class="air-install-line">${aiEscape(st.line)}</div>`);
    const btn = document.createElement("button");
    btn.className = st.err ? "air-login" : "air-login-alt as-btn";
    btn.textContent = st.err ? "Try again" : "Cancel";
    btn.onclick = () => {
      if (st.err) { startInstall(); return; }
      try { st.ws.close(); } catch (e) { /* closing */ }
      ai.installing = null;
      chatRender();
    };
    w.appendChild(btn);
    return w;
  }

  function startGuiLogin() {
    if (ai.login && ai.login.ws) { try { ai.login.ws.close(); } catch (e) { /* replacing */ } }
    const st = { agent: ai.agent, ws: null, url: "", codeWanted: false, err: "" };
    ai.login = st;
    ai.cardJump = true; // the card renders above the transcript (see chatRender)
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
      `/api/ai/login?agent=${encodeURIComponent(ai.agent)}`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "url") {
        st.url = m.url;
      } else if (m.type === "code_wanted") {
        st.codeWanted = true;
      } else if (m.type === "ok") {
        // Same ownership check as the install card: a replaced login flow's
        // late "ok" must not dismiss the one currently on screen.
        if (ai.login === st) ai.login = null;
        // The account still comes from AFTER the new login took (the engine
        // reads the CLI's own profile at the moment it detects the write,
        // and the CLI writes that profile before the credential file), so a
        // switch is still named correctly, but the confirmation no longer
        // waits on a status round trip. Older engines send no identity;
        // then fall back to naming it once the re-probe lands.
        const noteFor = (id) => `Signed in to ${label(st.agent)}` +
          (id && id.email ? ` as ${id.email}` : "") + `. You're set.`;
        if (m.identity !== undefined) {
          session(st.agent).msgs.push({ kind: "note", text: noteFor(m.identity) });
          refreshStatus().then(chatRender);
        } else {
          refreshStatus().then(() => {
            session(st.agent).msgs.push({ kind: "note",
              text: noteFor((ai.meta[st.agent] || {}).identity) });
            chatRender();
          });
        }
      } else if (m.type === "restored") {
        // The flow ended without a new login and the engine put the
        // previous credential back: cancelling a switch must never cost
        // the session.
        session(st.agent).msgs.push({ kind: "note",
          text: `Sign-in didn't complete; your previous ${label(st.agent)} ` +
                `login was kept.` });
        refreshStatus().then(chatRender);
      } else if (m.type === "error" || m.type === "missing") {
        st.err = m.message || m.hint || "sign-in failed";
      }
      if (st.agent === ai.agent) chatRender();
    };
    st.ws = ws;
    chatRender();
  }

  function chatConnect(agent) {
    const s = session(agent);
    if (s.ws && s.ws.readyState <= 1) return s;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
      `/api/ai/chat?agent=${encodeURIComponent(agent)}`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const last = s.msgs[s.msgs.length - 1];
      if (m.type === "missing") {
        // Mid-conversation the user needs an answer bubble; on a fresh
        // transcript stay silent so the install hero (logo + one-click
        // Install) renders instead of a plain text wall.
        if (s.msgs.length) s.msgs.push({ kind: "install", hint: m.hint || "" });
        refreshStatus().then(chatRender);
      } else if (m.type === "error") {
        s.busy = false;
        s.msgs.push({ kind: "error", text: m.message || "error" });
        // A model the plan does not include would fail every turn until the
        // user remembers /model default; revert for them instead.
        if (s.model && /selected model|not have access to it/i.test(m.message || "")) {
          s.msgs.push({ kind: "note",
            text: `"${s.model}" is not available here; model reset to Default. ` +
                  `Newer models often just need a CLI update (run ` +
                  `"${agent} update" in its Terminal view); otherwise it may ` +
                  `not be in your plan.` });
          s.model = "";
        }
      } else if (m.type === "turn_start") {
        s.busy = true;
      } else if (m.type === "checkpoint") {
        // Pin the pre-turn snapshot to this turn's user message: its hover
        // revert button restores the workspace to before the turn ran.
        const u = [...s.msgs].reverse().find((x) => x.kind === "user");
        if (u) u.checkpoint = m.id;
      } else if (m.type === "meta") {
        // The agent CLI's own id for this conversation. Persisting it is what
        // lets a reopened chat CONTINUE (openChat sends it back as "resume")
        // instead of coming back as a transcript the agent has forgotten.
        if (m.sid && s.sid !== m.sid) {
          s.sid = m.sid;
          if (s.ws) s.ws.__sidSynced = m.sid;  // already this connection's thread
          persistChat(agent);
        }
      } else if (m.type === "resumed") {
        // Server confirms which session the next turn will run against. A
        // failed resume must be visible: silently starting a fresh session
        // under an old transcript is how the agent ends up answering with no
        // idea what "it" refers to.
        if (!m.ok) {
          s.msgs.push({ kind: "note", text:
            "This chat has no saved session id, so the agent starts fresh here. " +
            "The transcript above is the record; it has not read it." });
          chatRender();
        }
      } else if (m.type === "text") {
        if (m.stream && last && last.kind === "text" && !last.done) {
          last.text += m.text;
        } else {
          s.msgs.push({ kind: "text", text: m.text, done: !m.stream });
        }
        // A broken Windows sandbox turns every ChatGPT command into this
        // failure; offer the consent-gated fix right where it happens.
        if (agent === "codex" && !s.sandboxOffered && !((ai.meta.codex || {}).full_access)
            && /windows sandbox/i.test(m.text)) {
          s.sandboxOffered = true;
          s.msgs.push({ kind: "sandbox_offer" });
        }
      } else if (m.type === "tool") {
        s.msgs.push({ kind: "tool", name: m.name || "tool", detail: m.detail || "" });
      } else if (m.type === "tool_start") {
        // Collapsible tool card, VS Code style; a result may arrive for the
        // same id later (upsert: codex re-announces on completion).
        const ex = m.id && s.msgs.find((x) => x.kind === "toolcard" && x.id === m.id);
        if (ex) {
          Object.assign(ex, { name: m.name || ex.name, detail: m.detail || ex.detail,
                              command: m.command || ex.command });
        } else {
          s.msgs.push({ kind: "toolcard", id: m.id || "", name: m.name || "tool",
                        detail: m.detail || "", command: m.command || "",
                        file: m.file || "", old: m.old || "", add: m.new || "",
                        status: "running", output: "", open: false });
        }
      } else if (m.type === "tool_result") {
        const card = [...s.msgs].reverse().find(
          (x) => x.kind === "toolcard" && x.id === m.id);
        if (card) {
          card.status = m.is_error ? "error" : "done";
          card.output = m.output || "";
        }
      } else if (m.type === "permission") {
        // The agent wants to do something risky: an Allow/Deny card, VS
        // Code style. The engine holds the tool call until the click.
        s.msgs.push({ kind: "permission", pid: m.pid, tool: m.tool || "tool",
                      detail: m.detail || "", status: "pending" });
      } else if (m.type === "turn_end") {
        s.busy = false;
        if (last && last.kind === "text") last.done = true;
      }
      // Archive at turn boundaries (and on errors), not per streamed delta.
      if (m.type === "turn_end" || m.type === "error") persistChat(agent);
      if (agent === ai.agent) chatRender();
    };
    ws.onclose = () => { if (s.ws === ws) { s.ws = null; s.busy = false; } };
    s.ws = ws;
    return s;
  }

  // The GUI sign-in progress card: shown whenever a login is running for
  // the current provider, whatever else is on screen.
  function buildLoginCard(st) {
    const w = document.createElement("div");
    w.className = "air-login-card";
    w.innerHTML = `<div class="air-w-name">${aiLogoHtml(st.agent)}${aiEscape(label(st.agent))} sign-in</div>` +
      `<div class="air-w-sub">${st.err
        ? `Sign-in did not complete: ${aiEscape(st.err)}`
        : `Complete the sign-in in your browser. This panel updates by itself once you're done.`}</div>`;
    if (!st.err && st.url) {
      const a = document.createElement("a");
      a.className = "air-login-alt";
      a.href = st.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Browser didn't open? Click here.";
      w.appendChild(a);
    }
    if (!st.err && st.codeWanted) {
      const row = document.createElement("div");
      row.className = "air-code";
      const inp = document.createElement("input");
      inp.placeholder = "Paste the code from the browser";
      const ok = document.createElement("button");
      ok.textContent = "Submit";
      ok.onclick = () => {
        if (st.ws && st.ws.readyState === 1 && inp.value.trim()) {
          st.ws.send(JSON.stringify({ type: "code", value: inp.value.trim() }));
        }
      };
      row.appendChild(inp);
      row.appendChild(ok);
      w.appendChild(row);
    }
    if (st.err) {
      const retry = document.createElement("button");
      retry.className = "air-login";
      retry.textContent = "Try again";
      retry.onclick = startGuiLogin;
      w.appendChild(retry);
    }
    const cancel = document.createElement("button");
    cancel.className = "air-login-alt as-btn";
    cancel.textContent = st.err ? "Use the terminal instead" : "Cancel";
    cancel.onclick = () => {
      if (st.ws && st.ws.readyState === 1) st.ws.send(JSON.stringify({ type: "cancel" }));
      try { st.ws.close(); } catch (e) { /* closing */ }
      ai.login = null;
      if (st.err) { ai.loginNext = true; setMode("term"); return; }
      // Cancelling mid-flow can leave the CLI signed OUT (its /login may
      // invalidate the old session before the new one completes; seen in
      // practice). Re-probe and say so rather
      // than letting the next message fail.
      refreshStatus().then(() => {
        if ((ai.meta[st.agent] || {}).authed === false) {
          session(st.agent).msgs.push({ kind: "note",
            text: `Cancelling left ${label(st.agent)} signed out on this ` +
                  `machine. Sign in to continue.` });
        }
        chatRender();
      });
    };
    w.appendChild(cancel);
    return w;
  }

  // LSE Assistant key card: the hosted assistant answered 401, so the LSE
  // API key is missing or wrong. Same store as the MARKETS connect form
  // (/api/config/lse_key); a save retries the message that hit the wall.
  function buildLseKeyCard() {
    const s = session("lse");
    const w = document.createElement("div");
    w.className = "air-login-card";
    w.innerHTML = `<div class="air-w-name">${aiLogoHtml("lse")}Connect your LSE API key</div>` +
      `<div class="air-w-sub">The assistant answers on your free LSE API ` +
      `key (the same one MARKETS uses). ` +
      // #api: land on the Databank section that mints the key, not the top
      // of the catalogue page (same target as the MARKETS connect form).
      `<a href="https://londonstrategicedge.com/data#api" target="_blank" ` +
      `rel="noopener">Get one here</a>, then paste it:</div>`;
    const row = document.createElement("div");
    row.className = "air-code";
    // a key box no browser offers to save (csSecretBox)
    const inp = csSecretBox(document.createElement("input"));
    inp.placeholder = "lse_live_...";
    const ok = document.createElement("button");
    ok.textContent = "Save";
    ok.onclick = async () => {
      const key = inp.value.trim();
      if (!key) return;
      ok.disabled = true;
      const r = await fetch("/api/config/lse_key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      }).catch(() => null);
      if (r && r.ok) {
        resetPricePollKey();
        s.needKey = false;
        state.lseConfigured = true;
        if (s.pending) { const t = s.pending; s.pending = null; lseSend(t); }
        else chatRender();
      } else {
        ok.disabled = false;
        s.msgs.push({ kind: "error", text: "could not save the key (engine away?)" });
        chatRender();
      }
    };
    row.appendChild(inp);
    row.appendChild(ok);
    w.appendChild(row);
    return w;
  }

  // A tool card carries Python when it is the strategy writer, or when the
  // text reads as Python anyway (the cloud names its tools its own way, so
  // the name alone cannot be trusted). Same test the chat fences use.
  function tcIsPy(m) {
    return m.name === "run_backtest" ||
      /(^|\n)\s*(import |from |def |class |trades\.append)/.test(m.command || "");
  }

  function chatRender() {
    const box = $("air-msgs");
    const s = session(ai.agent);
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.innerHTML = "";
    if (ai.login && ai.login.agent === ai.agent) {
      box.appendChild(buildLoginCard(ai.login));
    }
    if (ai.installing && ai.installing.agent === ai.agent) {
      box.appendChild(buildInstallCard(ai.installing));
    }
    if (ai.accountCard === ai.agent) {
      box.appendChild(buildAccountCard());
    }
    if (ai.agent === "lse" && s.needKey) {
      box.appendChild(buildLseKeyCard());
    }
    if (!s.msgs.length) {
      // Empty state, in priority order: install the CLI; log in (only when
      // the engine POSITIVELY knows the account is signed out); otherwise a
      // one-line welcome. Sign-in comes FIRST, before any chat. The LSE
      // Assistant has no install/login states, just its welcome.
      const meta = ai.meta[ai.agent] || {};
      const name = aiEscape(label(ai.agent));
      const w = document.createElement("div");
      w.id = "air-welcome";
      // Hero: the provider's logo in a soft tile, its name, one line of
      // copy, then the single primary action. Sign-in pages, not footnotes.
      // An empty sub renders no line at all (the LSE hero says what it
      // sees instead of describing itself, see below).
      const hero = (sub) => {
        w.innerHTML =
          `<div class="air-hero-logo">${aiLogoHtml(ai.agent)}</div>` +
          `<div class="air-hero-name">${name}</div>` +
          (sub ? `<div class="air-hero-sub">${sub}</div>` : "");
      };
      if (ai.agent === "lse") {
        if (!s.needKey) {
          // The first-show state was a small tile at the
          // top of an empty column with a sentence about itself. Now: the
          // mark and the name, sitting in the middle of the column (CSS
          // centres a lone #air-welcome), the FACT of what it sees (the
          // charted symbol and timeframe, no prose; nothing charted =
          // no line), and three real starts on that symbol, each a click
          // away from being sent. No filler copy: the placeholder already
          // says "/".
          hero("");
          const sym = state.symbol || "";
          const tf = state.timeframe || "";
          if (sym) {
            const c = document.createElement("div");
            c.className = "air-hero-ctx";
            c.textContent = [sym, tf].filter(Boolean).join("  ·  ");
            w.appendChild(c);
          }
          // Quantitative starts (not generic questions):
          // one on the account (the dock's balance / equity / margin /
          // positions ride in the context), one on rates, one technical
          // that ends in a real backtest.
          const starts = sym
            ? [`Risk-check my account: exposure, margin, open P&L`,
               `Where are 2y/10y yields, and what does the curve imply for ${sym}`,
               `Z-score mean reversion on ${sym}${tf ? " " + tf : ""}: build it and backtest it`]
            : [`Risk-check my account: exposure, margin, open P&L`,
               `Where are 2y/10y yields, and what is the curve saying`,
               `Build a z-score mean-reversion strategy and backtest it`];
          const list = document.createElement("div");
          list.className = "air-starts";
          for (const t of starts) {
            const b = document.createElement("button");
            b.className = "air-start";
            b.type = "button";
            b.innerHTML = `<span>${aiEscape(t)}</span><span class="air-start-go">&#8629;</span>`;
            // Same door as typing it: the composer's own send path (busy
            // guard, context push, screenshot, transcript persistence).
            b.onclick = () => { $("air-input").value = t; sendChat(); };
            list.appendChild(b);
          }
          w.appendChild(list);
        }
      } else if (meta.installed === false) {
        if (!(ai.installing && ai.installing.agent === ai.agent)) {
          hero(`${name} is not installed on this machine yet. One click ` +
            `puts it on this computer; you sign in with your own account.`);
          if (meta.installable) {
            const b = document.createElement("button");
            b.className = "air-login";
            b.textContent = `Install ${label(ai.agent)}`;
            b.onclick = startInstall;
            w.appendChild(b);
            const alt = document.createElement("div");
            alt.className = "air-hero-alt-sub";
            alt.innerHTML = `Or install it yourself:<pre>${aiEscape(meta.install || "")}</pre>`;
            w.appendChild(alt);
          } else {
            const pre = document.createElement("pre");
            pre.textContent = meta.install || "";
            w.appendChild(pre);
          }
        }
      } else if (meta.authed === false) {
        if (!(ai.login && ai.login.agent === ai.agent)) {
          hero(`Chat runs on your own ${name} account, on this machine. ` +
            `Log in once and you're set.`);
          const b = document.createElement("button");
          b.className = "air-login";
          b.textContent = `Log in to ${label(ai.agent)}`;
          b.onclick = startGuiLogin;
          w.appendChild(b);
          const alt = document.createElement("button");
          alt.className = "air-login-alt as-btn";
          alt.textContent = "Advanced: sign in via its terminal";
          alt.onclick = () => { ai.loginNext = true; setMode("term"); };
          w.appendChild(alt);
        }
      } else {
        const ident = meta.identity && meta.identity.email
          ? `your account <b>${aiEscape(meta.identity.email)}</b>` +
            (meta.identity.org ? ` (${aiEscape(meta.identity.org)})` : "")
          : "your own account";
        const via = meta.mode === "foundry" ? "Microsoft Foundry"
          : meta.mode === "api-key" ? "your API key" : ident;
        hero(`Running on your machine via ${via}. ` +
          `It can work on your strategies, run backtests, and analyze ` +
          `your data. Type <code>/</code> for commands.`);
      }
      box.appendChild(w);
    }
    for (const m of s.msgs) {
      const div = document.createElement("div");
      if (m.kind === "user") {
        div.className = "air-msg user";
        div.textContent = m.text;
        // A turn sent under a mode carries a small tag, so a transcript
        // reads which stance produced which answer (one-shot or standing).
        if (m.mode && aiModeById(m.mode)) {
          const tag = document.createElement("span");
          tag.className = "air-mode-tag";
          tag.textContent = aiModeById(m.mode).label;
          div.appendChild(tag);
        }
        if (m.checkpoint) {
          const rv = document.createElement("button");
          rv.className = "air-revert";
          rv.title = "Restore the workspace files to before this message";
          rv.innerHTML = "&#8630; Revert";
          rv.onclick = async () => {
            rv.disabled = true;
            const r = await fetch("/api/ai/revert", { method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: m.checkpoint }) }).catch(() => null);
            s.msgs.push({ kind: "note", text: r && r.ok
              ? "Workspace restored to before this message (the editor refreshes itself)."
              : "Could not revert (checkpoint expired?)" });
            chatRender();
          };
          div.appendChild(rv);
        }
      } else if (m.kind === "text") {
        div.className = "air-msg bot";
        const who = document.createElement("div");
        who.className = "air-who";
        who.innerHTML = aiLogoHtml(ai.agent) + aiEscape(label(ai.agent));
        div.appendChild(who);
        const body = document.createElement("div");
        aiMarkdownInto(body, m.text);
        div.appendChild(body);
        m.el = div; // the streaming turn patches this node in place (lsePaint)
      } else if (m.kind === "tool") {
        div.className = "air-tool";
        div.innerHTML = `<span class="air-tool-name">${aiEscape(m.name)}</span>` +
                        (m.detail ? ` <span class="air-tool-detail">${aiEscape(m.detail)}</span>` : "");
      } else if (m.kind === "toolcard") {
        div.className = "air-tc" + (m.open ? " open" : "");
        m.el = div; // a live LSE tool card streams its script into this node
        const head = document.createElement("button");
        head.className = "air-tc-head";
        head.innerHTML = `<span class="air-tc-chev">${m.open ? "&#9662;" : "&#9656;"}</span>` +
          `<span class="air-tool-name">${aiEscape(m.name)}</span>` +
          `<span class="air-tool-detail">${aiEscape(m.detail || "")}</span>` +
          `<span class="air-tc-status ${m.status}">${
            m.status === "running" ? "&#8943;" : m.status === "error" ? "failed" : "ok"}</span>`;
        head.onclick = () => { m.open = !m.open; chatRender(); };
        div.appendChild(head);
        if (m.open) {
          const body = document.createElement("div");
          body.className = "air-tc-body";
          if (m.old || m.add) {
            // Edits render as a mini diff straight from the tool input.
            if (m.file) {
              const f = document.createElement("div");
              f.className = "air-tc-file";
              f.textContent = m.file;
              body.appendChild(f);
            }
            if (m.old) {
              const d1 = document.createElement("pre");
              d1.className = "air-tc-del";
              d1.textContent = m.old;
              body.appendChild(d1);
            }
            if (m.add) {
              const d2 = document.createElement("pre");
              d2.className = "air-tc-add";
              d2.textContent = m.add;
              body.appendChild(d2);
            }
          } else if (m.command) {
            const c = document.createElement("pre");
            c.className = "air-tc-cmd";
            // The strategy being written is code, so it reads as code: the
            // same pyTokenHTML pass and .hl-* palette the IDE and the chat
            // fences use, so one strategy looks identical everywhere it
            // appears. Non-Python commands stay plain text.
            if (tcIsPy(m)) c.innerHTML = pyTokenHTML(m.command);
            else c.textContent = m.command;
            body.appendChild(c);
          }
          if (m.output) {
            const o = document.createElement("pre");
            o.className = "air-tc-out";
            o.textContent = m.output;
            body.appendChild(o);
          }
          if (!m.command && !m.output && !m.old && !m.add) {
            const n = document.createElement("div");
            n.className = "air-tc-none";
            n.textContent = "no captured output";
            body.appendChild(n);
          }
          div.appendChild(body);
        }
      } else if (m.kind === "permission") {
        div.className = "air-perm" + (m.status !== "pending" ? " settled" : "");
        div.innerHTML = `<div class="air-perm-head">${aiEscape(label(ai.agent))} wants to run:</div>` +
          `<div class="air-perm-what"><span class="air-tool-name">${aiEscape(m.tool)}</span> ` +
          `<span class="air-tool-detail">${aiEscape(m.detail)}</span></div>`;
        if (m.status === "pending") {
          const row = document.createElement("div");
          row.className = "air-perm-btns";
          const reply = (decision, always) => {
            m.status = decision === "allow" ? (always ? "always allowed" : "allowed") : "denied";
            if (s.ws && s.ws.readyState === 1) {
              s.ws.send(JSON.stringify({ type: "permission_reply", pid: m.pid,
                                         decision, always }));
            }
            chatRender();
          };
          const mk = (txt, cls, fn) => {
            const b = document.createElement("button");
            b.className = cls;
            b.textContent = txt;
            b.onclick = fn;
            row.appendChild(b);
          };
          mk("Allow", "air-perm-allow", () => reply("allow", false));
          mk("Always allow", "air-perm-always", () => reply("allow", true));
          mk("Deny", "air-perm-deny", () => reply("deny", false));
          div.appendChild(row);
        } else {
          const st = document.createElement("div");
          st.className = "air-perm-status";
          st.textContent = m.status;
          div.appendChild(st);
        }
      } else if (m.kind === "note") {
        div.className = "air-note";
        div.textContent = m.text;
      } else if (m.kind === "sandbox_offer") {
        div.className = "air-note";
        div.textContent = "ChatGPT's command sandbox is broken on this Windows machine, " +
          "so it cannot run commands or read files. ";
        const b = document.createElement("button");
        b.className = "air-signin";
        b.textContent = "Enable full access for ChatGPT on this PC";
        b.onclick = () => postCodexFullAccess(true);
        div.appendChild(b);
      } else if (m.kind === "error") {
        div.className = "air-msg err";
        div.textContent = m.text;
        const hint = document.createElement("div");
        hint.className = "air-err-hint";
        // Auth-shaped failures get a one-click path to the fix: the agent's
        // own terminal, where its native login flow (browser OAuth) runs.
        if (/401|403|auth|login|sign[- ]?in|credential|api.?key/i.test(m.text)) {
          const b = document.createElement("button");
          b.className = "air-signin";
          b.textContent = `Sign in to ${label(ai.agent)}`;
          b.onclick = AIR_GUI_LOGIN.includes(ai.agent)
            ? startGuiLogin
            : () => { ai.loginNext = true; setMode("term"); };
          hint.appendChild(b);
        } else {
          hint.textContent = "If this is a sign-in problem, open the Terminal view once and log in there.";
        }
        div.appendChild(hint);
      } else if (m.kind === "install") {
        div.className = "air-msg install";
        div.innerHTML = `${aiEscape(label(ai.agent))} is not installed on this machine. ` +
          `Install it, sign in with your own account, then reopen this panel:` +
          `<pre>${aiEscape(m.hint)}</pre>`;
      }
      box.appendChild(div);
    }
    if (s.busy) {
      const t = document.createElement("div");
      t.className = "air-typing";
      t.innerHTML = "<span></span><span></span><span></span>";
      box.appendChild(t);
    }
    $("air-stop").classList.toggle("hidden", !s.busy);
    $("air-send").classList.toggle("hidden", s.busy);
    // Cards (account, login, install) render ABOVE the transcript, so the
    // render that opens one must jump to the top or, from a long chat, the
    // card lands off-screen and the click looks dead.
    // One-shot flag, not a standing rule, so later re-renders
    // never yank the scrollbar away from the user.
    if (ai.cardJump) { ai.cardJump = false; box.scrollTop = 0; }
    else if (stick) box.scrollTop = box.scrollHeight;
  }

  // The composer placeholder names the active mode so a standing stance
  // is never invisible; the mode chip in the "/" menu shows it too.
  function renderModeHint() {
    const s = session(ai.agent);
    const m = aiModeById(s.mode);
    const inp = $("air-input");
    if (inp) inp.placeholder = m
      ? `${m.label} mode · ask anything, or / for commands…`
      : "Ask anything, or type / for commands…";
  }

  function setStance(id, quiet) {
    const s = session(ai.agent);
    const m = aiModeById(id);
    s.mode = m ? m.id : "";
    renderModeHint();
    if (!quiet) {
      s.msgs.push({ kind: "note", text: m
        ? `${m.label} mode on: ${m.desc}. Every turn carries it until /mode off.`
        : "mode off: plain assistant" });
      chatRender();
    }
  }

  // The panel's own slash commands run locally; anything else is a turn.
  function runSlash(text) {
    const s = session(ai.agent);
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const modeCmd = aiModeById(cmd.slice(1));
    if (modeCmd) {
      if (arg) {
        // One-shot: this turn in the stance, the session mode untouched.
        sendChat(arg, modeCmd);
        return;
      }
      setStance(modeCmd.id);
      return;
    }
    if (cmd === "/mode") {
      if (!arg) {
        s.msgs.push({ kind: "note", text: "Modes (the active one is marked): " +
          AIR_MODES.map((m) => (m.id === s.mode ? "[" : "") + "/" + m.id +
                        (m.id === s.mode ? "]" : "")).join("  ") +
          ". « /mode off » clears it." });
        chatRender();
      } else if (arg === "off" || arg === "clear" || arg === "default") {
        setStance("");
      } else if (aiModeById(arg)) {
        setStance(arg);
      } else {
        s.msgs.push({ kind: "note", text: `unknown mode ${arg}. Modes: ` +
          AIR_MODES.map((m) => "/" + m.id).join(" ") });
        chatRender();
      }
      return;
    }
    if (cmd === "/new") {
      newChat(); // archives the current conversation first (clock button)
    } else if (ai.agent === "lse" && (cmd === "/model" || cmd === "/terminal")) {
      s.msgs.push({ kind: "note",
        text: `${cmd} is for the local agent providers; Veron ` +
              `is hosted and chat-only (see /help)` });
    } else if (cmd === "/model") {
      if (arg === "default" || arg === "clear") {
        s.model = "";
        s.msgs.push({ kind: "note", text: "model reset to the provider's default" });
      } else if (arg) {
        s.model = arg;
        s.msgs.push({ kind: "note", text: `model set to ${arg} for ${label(ai.agent)} turns` });
      } else {
        s.msgs.push({ kind: "note", text: s.model
          ? `model: ${s.model} (« /model default » clears it)`
          : "usage: /model <name>, e.g. /model opus" });
      }
    } else if (ai.agent !== "lse" && cmd === "/update") {
      const agent = ai.agent;
      aiModelsRefresh(agent, true).then(() => {
        const live = aiLiveModels[agent];
        if (!live || !live.fresh) {
          noteTo(agent, `${cliName(agent)} could not be asked for its version. Is it installed?`);
        } else if (live.cli) {
          cliUpdate(agent, true);
        } else {
          noteTo(agent, `${cliName(agent)} is up to date` + (live.version ? ` (${live.version})` : "") + ".");
        }
      });
      return; // async: it renders itself
    } else if (ai.agent !== "lse" && cmd === "/autoupdate") {
      const live = aiLiveModels[ai.agent];
      if (arg === "on" || arg === "off") {
        setAutoUpdate(ai.agent, arg === "on");
        return; // async: it renders itself
      }
      s.msgs.push({ kind: "note", text:
        `The terminal ${live && live.auto === true ? "keeps" : "does not keep"} ${cliName(ai.agent)} ` +
        "up to date by itself. usage: /autoupdate on, /autoupdate off" });
    } else if (cmd === "/terminal") {
      setMode("term");
    } else if (cmd === "/help") {
      s.msgs.push({ kind: "note", text: ai.agent === "lse" ? LSE_HELP : AIR_HELP });
    } else if (cmd === "/usage" && ai.agent === "lse") {
      lseUsageNote();
      return; // async: it renders itself
    } else {
      s.msgs.push({ kind: "note", text: `unknown command ${cmd} (try /help)` });
    }
    chatRender();
  }

  /* ----- the "/" menu ----- */

  ai.menu = { view: "main", sel: 0, rows: [], datasets: null };

  function menuClose() {
    ai.menu.view = "main";
    ai.menu.sel = 0;
    $("air-slash").classList.add("hidden");
  }

  function menuInsertText(text) {
    const input = $("air-input");
    input.value = text;
    menuClose();
    input.focus();
  }

  function modelLabel() {
    const s = session(ai.agent);
    if (!s.model) return "Default";
    const known = modelsFor(ai.agent).find((m) => m.id === s.model);
    return known ? known.name : s.model;
  }

  // Rows for each menu view. {header} rows are section titles; action rows
  // carry id, label, optional right-hand value, check and desc.
  function menuRows() {
    const s = session(ai.agent);
    // The hosted assistant has no models, terminal, files or accounts to
    // manage, so its "/" menu is just the conversation actions.
    // Modes: every stance listed flat, the active one shaded (.on), at the
    // BOTTOM of the menu under Help (no submenu, list
    // them all, dark grey on the selected one). Clicking the active mode
    // again turns it off; /mode off does the same.
    const modeRows = () => [{ header: "Mode" }].concat(AIR_MODES.map((m) => ({
      id: "mode:" + m.id, label: m.label, desc: m.desc, on: (s.mode || "") === m.id,
    })));
    if (ai.agent === "lse") {
      return [
        { header: "Panel" },
        { id: "usage", label: "Usage today", desc: "messages used of your daily allowance" },
        { id: "clear", label: "Clear conversation" },
        { id: "help", label: "Help" },
      ].concat(modeRows());
    }
    if (ai.menu.view === "model") {
      return [{ header: "Select a model" }].concat(modelMenuRows(ai.agent).map((m) => ({
        id: "model:" + m.id, label: m.name, desc: m.desc, off: !!m.needsUpdate,
        check: !m.needsUpdate && (s.model || "") === m.id,
      })));
    }
    if (ai.menu.view === "effort") {
      return [{ header: "Effort" }].concat(AIR_EFFORTS.map((e) => ({
        id: "effort:" + e, label: e[0].toUpperCase() + e.slice(1),
        check: (s.effort || "default") === e,
      })));
    }
    if (ai.menu.view === "mention") {
      const rows = [{ header: "Mention" },
        // strategy.py is the file /api/ai/workspace writes (Python is the
        // strategy language); the label used to name the old
        // script file, which no longer exists in the workspace.
        { id: "mention:strategy", label: "strategy.py",
          desc: "the strategy in your backtest editor" }];
      for (const d of (ai.menu.datasets || [])) {
        rows.push({ id: "mention:data:" + (d.file || ""),
                    label: d.name || d.symbol || d.file,
                    desc: (d.kind || "") + (d.rows ? ` · ${d.rows} rows` : "") });
      }
      if (!(ai.menu.datasets || []).length) {
        rows.push({ header: "No imported datasets yet (MY DATA)" });
      }
      return rows;
    }
    const rows = [
      { header: "Context" },
      { id: "attach", label: "Attach file…", desc: "insert a file path for the agent to read" },
      { id: "mention", label: "Mention a dataset…", sub: true, desc: "your My Data imports" },
      { id: "clear", label: "Clear conversation" },
      { header: "Model" },
      { id: "model", label: "Switch model…", value: modelLabel(), sub: true },
    ];
    if (ai.agent === "claude") {
      rows.push({ id: "effort", label: "Effort",
                  value: (s.effort || "default"), sub: true });
    }
    if (AIR_CLI_NAME[ai.agent]) {
      const live = aiLiveModels[ai.agent];
      rows.push({ id: "autoupdate", label: `Keep ${AIR_CLI_NAME[ai.agent]} up to date`,
                  value: live && live.auto === true ? "On" : "Off" });
    }
    rows.push({ id: "account", label: "Account & usage…" });
    // Same affordance as the IDE extensions' "Switch account":
    // re-runs the CLI's own sign-in flow, which replaces the
    // stored account. Only for CLIs whose login the engine can launch.
    if (AIR_GUI_LOGIN.includes(ai.agent)) {
      rows.push({ id: "switch-account", label: "Switch account…",
                  desc: "sign " + label(ai.agent) + " into a different account" });
    }
    rows.push({ header: "Panel" });
    rows.push({ id: "terminal", label: "Open the agent's terminal", desc: "sign-in, approvals, its own slash commands" });
    rows.push({ id: "help", label: "Help" });
    return rows.concat(modeRows());
  }

  function menuRun(id) {
    const s = session(ai.agent);
    if (id === "attach") {
      menuClose();
      $("air-file").click();
    } else if (id === "mention") {
      ai.menu.view = "mention";
      ai.menu.sel = 1;
      ai.menu.datasets = null;
      fetch("/api/data").then((r) => r.json())
        .then((d) => { ai.menu.datasets = d; slashRender(true); })
        .catch(() => { ai.menu.datasets = []; slashRender(true); });
      slashRender(true);
    } else if (id === "clear") {
      menuInsertText("");
      runSlash("/new");
    } else if (id.startsWith("mode:")) {
      menuInsertText("");
      const pick = id.slice(5);
      setStance(pick === s.mode ? "" : pick);
    } else if (id === "model") {
      ai.menu.view = "model";
      ai.menu.sel = 1;
      slashRender(true);
      // Drawn at once from what the CLI last said, then asked again: a
      // model shipped since then appears while the menu is still open.
      modelsSync(ai.agent);
    } else if (id.startsWith("model:")) {
      const chosen = id.slice(6);
      if (chosen === "__custom") { menuInsertText("/model "); slashRender(); return; }
      if (chosen.startsWith("__update:")) {
        const row = modelMenuRows(ai.agent).find((m) => m.id === chosen);
        menuInsertText("");
        if (row && row.cliUpdate) {
          if (!row.busy) cliUpdate(ai.agent, true);
        } else if (row) {
          s.msgs.push({ kind: "note", text: modelUpdateNote(ai.agent, row) });
        }
        chatRender();
        return;
      }
      s.model = chosen;
      menuInsertText("");
      s.msgs.push({ kind: "note", text: `Model: ${modelLabel()}` });
      renderModelBtn(); // keep the header switcher in step with the "/" path
      chatRender();
    } else if (id === "effort") {
      ai.menu.view = "effort";
      ai.menu.sel = 1;
      slashRender(true);
    } else if (id.startsWith("effort:")) {
      const e = id.slice(7);
      s.effort = e === "default" ? "" : e;
      menuInsertText("");
      s.msgs.push({ kind: "note", text: `Effort: ${e}` });
      chatRender();
    } else if (id === "mention:strategy") {
      menuInsertText(((ai.paths || {}).workspace || "") + "/strategy.py ");
    } else if (id.startsWith("mention:data:")) {
      menuInsertText(((ai.paths || {}).data || "") + "/" + id.slice(13) + " ");
    } else if (id === "autoupdate") {
      menuInsertText("");
      const live = aiLiveModels[ai.agent];
      setAutoUpdate(ai.agent, !(live && live.auto === true));
    } else if (id === "account") {
      menuInsertText("");
      ai.accountCard = ai.agent;
      ai.cardJump = true;
      chatRender();
    } else if (id === "switch-account") {
      menuInsertText("");
      // In-panel sign-in card (hidden PTY drives the CLI's login and
      // surfaces the OAuth URL), never the raw TUI: dropping the user into
      // the terminal view here read as broken.
      // The driver only reports ok when the credentials file is REWRITTEN,
      // so running it while already signed in is exactly an account switch.
      startGuiLogin();
    } else if (id === "terminal") {
      menuInsertText("");
      setMode("term");
    } else if (id === "help") {
      menuInsertText("");
      runSlash("/help");
    } else if (id === "usage") {
      menuInsertText("");
      runSlash("/usage");
    }
  }

  function slashRender(force) {
    const menu = $("air-slash");
    const v = $("air-input").value;
    if (!force && (!v.startsWith("/") || v.includes("\n"))) { menuClose(); return; }
    let rows = menuRows();
    const q = v.startsWith("/") ? v.slice(1).trim().toLowerCase() : "";
    if (q && ai.menu.view === "main") {
      // typed filter: flat actionable rows whose label matches ("/aud"
      // narrows straight to the Audit mode row)
      rows = rows.filter((r) => r.id && r.label.toLowerCase().includes(q));
      if (!rows.length) { menu.classList.add("hidden"); return; }
    }
    ai.menu.rows = rows;
    if (!rows[ai.menu.sel] || !rows[ai.menu.sel].id) {
      ai.menu.sel = rows.findIndex((r) => r.id);
      if (ai.menu.sel < 0) ai.menu.sel = 0;
    }
    menu.innerHTML = "";
    rows.forEach((r, i) => {
      const div = document.createElement("div");
      if (r.header) {
        div.className = "air-menu-head";
        div.textContent = r.header;
      } else {
        div.className = "air-menu-item" + (i === ai.menu.sel ? " sel" : "") +
                        (r.on ? " on" : "") + (r.off ? " off" : "");
        div.innerHTML =
          `<span class="air-menu-label">${aiEscape(r.label)}</span>` +
          (r.desc ? `<span class="air-menu-desc">${aiEscape(r.desc)}</span>`
                  : `<span class="air-menu-flex"></span>`) +
          (r.value ? `<span class="air-menu-value">${aiEscape(r.value)}</span>` : "") +
          (r.check ? `<span class="air-menu-check">&#10003;</span>` : "") +
          (r.sub ? `<span class="air-menu-sub">&#8250;</span>` : "");
        // Hover must NOT rebuild the menu: replacing the DOM between the
        // user's mousedown and mouseup makes every click silently miss
        // (the click event needs both halves on the same element). Move
        // the highlight in place, and run the action on mousedown.
        div.onmouseenter = () => {
          ai.menu.sel = i;
          Array.from(menu.children).forEach((c, j) =>
            c.classList.toggle("sel", j === i));
        };
        div.onmousedown = (e) => { e.preventDefault(); menuRun(r.id); };
      }
      menu.appendChild(div);
    });
    menu.classList.remove("hidden");
    const selEl = menu.children[ai.menu.sel];
    if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
  }

  function menuMove(delta) {
    const rows = ai.menu.rows;
    let i = ai.menu.sel;
    for (let step = 0; step < rows.length; step += 1) {
      i = (i + delta + rows.length) % rows.length;
      if (rows[i] && rows[i].id) break;
    }
    ai.menu.sel = i;
    slashRender(true);
  }

  // `given`/`oneShot` come from runSlash for `/audit <text>`: the text is
  // already out of the composer and the stance applies to this turn only.
  async function sendChat(given, oneShot) {
    const input = $("air-input");
    const text = given != null ? String(given).trim() : input.value.trim();
    if (!text) return;
    if (given == null && text.startsWith("/")) {
      input.value = "";
      input.style.height = "";
      $("air-slash").classList.add("hidden");
      runSlash(text);
      return;
    }
    // The stance for this turn: the one-shot mode if given, else the
    // session's standing mode. Same brief on both channels below.
    const stance = oneShot || aiModeById(session(ai.agent).mode);
    if (ai.agent === "lse") {
      if (session("lse").busy) return; // keep the draft in the composer
      if (given == null) { input.value = ""; input.style.height = ""; }
      $("air-slash").classList.add("hidden");
      lseSend(text, stance);
      return;
    }
    const s = chatConnect(ai.agent);
    if (s.busy) return; // keep the draft in the composer
    if (given == null) { input.value = ""; input.style.height = ""; }
    $("air-slash").classList.add("hidden");
    s.msgs.push({ kind: "user", text, mode: stance ? stance.id : "" });
    persistChat(ai.agent); // a reload mid-turn keeps at least the question
    s.busy = true; // optimistic; the server echoes turn_start
    // The brokers' terms of this moment, which the account and screen map
    // below are cleaned by (SPEC 3.3).
    await brokerRowsFresh();
    // Sync the workspace (editor + current view) BEFORE firing, awaited but
    // capped: the engine stamps this turn's screen note from context.json,
    // so a stale write here would tell the agent the previous page.
    try {
      await Promise.race([pushWorkspace(),
                          new Promise((r) => setTimeout(r, 800))]);
    } catch (e) { /* context is best effort */ }
    // Vision: fresh window snapshot into the workspace so this turn's agent
    // sees the chart as it is NOW. Desktop shell only; capped so a capture
    // hiccup can never hold the send. 1500ms: a 4K window's PNG encode can
    // exceed the old 800ms cap, which silently shipped stale screenshots.
    // Not while the chart or the ticket shows a broker whose terms keep its
    // prices on this computer: a picture of them reproduces them. The engine
    // tells the agent why, and refuses the shell's capture itself too.
    const shotWithheld = aiCaptureWithheld(brokerPicker.rows, state.provider,
      (typeof tpb !== "undefined" && tpb) ? tpb.broker : "");
    if (!shotWithheld && window.lseShell && window.lseShell.capture) {
      try {
        const cap = await Promise.race([window.lseShell.capture(),
          new Promise((r) => setTimeout(() => r({ ok: false, error: "capture timeout" }), 1500))]);
        if (cap && cap.ok === false) console.warn("screen capture:", cap.error || "failed");
      } catch (e) { console.warn("screen capture:", e); }
    }
    const fire = () => {
      // Make sure THIS connection knows which thread to continue before the
      // turn goes out. openChat sends a resume too, but only if the socket
      // happened to be open at that moment; it also has to be re-sent after a
      // reconnect, since the session id lives in per-connection server state.
      // Missing it means a silent fresh session under an old transcript.
      if (s.sid && s.ws.__sidSynced !== s.sid) {
        // reset THEN resume, always in that order. An older engine
        // has no resume handler and would silently ignore it,
        // leaving whatever session that connection last held: the next turn
        // would continue the WRONG conversation under this chat's transcript.
        // The leading reset makes an old engine fall back to a fresh session
        // (its previous behaviour), while a current engine just has its sid
        // cleared and immediately set again.
        s.ws.send(JSON.stringify({ type: "reset" }));
        s.ws.send(JSON.stringify({ type: "resume", sid: s.sid }));
        s.ws.__sidSynced = s.sid;
      }
      // A local CLI takes only the turn text, so the mode brief rides as a
      // prefix; the transcript shows the user's own words (pushed above).
      const wire = stance ? `[${stance.brief}]\n\n${text}` : text;
      s.ws.send(JSON.stringify(
        { type: "user", text: wire, model: s.model || "", effort: s.effort || "",
          autonomy: autoLevel() }));
    };
    if (s.ws.readyState === 1) fire();
    else s.ws.addEventListener("open", fire, { once: true });
    chatRender();
  }

  /* Hosted LSE Assistant turn: POST /api/assistant (the engine proxies with
     the local LSE key), reply is an OpenAI-shaped SSE stream; deltas append
     live into the bot bubble. 401 = missing/bad key: the turn is unwound
     into s.pending and the key card renders instead. */
  async function lseSend(text, stance) {
    const s = session("lse");
    s.msgs.push({ kind: "user", text, mode: stance ? stance.id : "" });
    persistChat("lse"); // a reload mid-turn keeps at least the question
    const bot = { kind: "text", text: "", done: false };
    s.msgs.push(bot);
    s.busy = true;
    s.abort = new AbortController();
    // Live trace of the model's work while it "types nothing".
    // Measured on a strategy ask: 19 of 30 seconds pass before
    // the first visible character, and that time is the model calling
    // list_datasets / preview_dataset, WRITING THE STRATEGY inside its
    // run_backtest call, and the backtest running. Those frames already
    // reach the panel (lse_tool notes from the engine and the cloud;
    // lse_tool_delta argument deltas from the cloud) and
    // were dropped on the floor. Now each becomes a tool card ahead of the
    // answer: the card for a run_backtest call shows the script as it is
    // written; the card's status flips to ok when the next event arrives
    // (nothing reports "done" explicitly); every card collapses the moment
    // the answer starts so the transcript ends tidy.
    let draft = null;              // the tool card still receiving argument deltas
    let structural = false;        // a card was added/changed: full re-render
    const cardsBefore = () => s.msgs.slice(0, s.msgs.indexOf(bot))
      .filter((m) => m.kind === "toolcard" && m.lse);
    const settleRunning = () => {
      for (const c of cardsBefore()) {
        if (c.status === "running") { c.status = "ok"; structural = true; }
      }
    };
    const collapseAll = () => {
      for (const c of cardsBefore()) if (c.open) { c.open = false; structural = true; }
    };
    const addCard = (name, detail) => {
      const c = { kind: "toolcard", lse: true, id: "", name, detail,
                  status: "running", open: false };
      s.msgs.splice(s.msgs.indexOf(bot), 0, c);
      structural = true;
      return c;
    };
    // The arguments arrive as a JSON object typed one token at a time.
    // For run_backtest that is {"script": "..."}: pull the string out of
    // the unfinished JSON and unescape what is complete so far, so the
    // panel shows the strategy itself, not backslash-n soup.
    const draftScript = (raw) => {
      const m = /"script"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
      if (!m) return "";
      let body = m[1];
      if (/(^|[^\\])(\\\\)*\\$/.test(body)) body = body.slice(0, -1); // half an escape
      try { return JSON.parse('"' + body + '"'); } catch (e) { return ""; }
    };
    const attempts = {};           // tool name -> how many calls this turn
    const onToolDelta = (f) => {
      if (!draft || draft.name !== f.name || draft.sealed) {
        settleRunning();
        collapseAll();             // one open card at a time: the current one
        const n = (attempts[f.name] = (attempts[f.name] || 0) + 1);
        // A retried run reads as what it is (the model rewriting after a
        // failed or empty backtest), not as nine identical rows.
        const label = f.name === "run_backtest"
          ? (n === 1 ? "Writing the strategy..." : `Rewriting the strategy (attempt ${n})...`)
          : "Preparing...";
        draft = addCard(f.name, label);
        draft.open = f.name === "run_backtest";
        draft.raw = "";
        draft.attempt = n;
      }
      draft.raw += f.d || "";
      if (f.name === "run_backtest") {
        const script = draftScript(draft.raw);
        if (script) {
          draft.command = script;
          // Fast path: grow the open card's <pre> in place.
          const pre = !structural && draft.el && draft.el.querySelector(".air-tc-cmd");
          // Re-highlight the whole script each delta rather than appending:
          // the tail token is usually half-typed (an unclosed string, a
          // partial keyword), so only a full pass gets its colour right once
          // the next characters land.
          if (pre) { pre.innerHTML = pyTokenHTML(script); pre.scrollTop = pre.scrollHeight; }
          else structural = true;
        }
      }
    };
    const onToolNote = (f) => {
      // The engine (local tools) or the cloud (web tools) is about to run a
      // call. If it is the call whose arguments just streamed, the same card
      // carries on: label swaps to the action, script stays visible.
      if (draft && draft.name === f.name && !draft.sealed) {
        draft.sealed = true;
        draft.detail = (f.label || f.name) +
          (draft.attempt > 1 ? ` (attempt ${draft.attempt})` : "");
        draft.status = "running";
        structural = true;
        return;
      }
      settleRunning();
      addCard(f.name || "tool", f.label || f.name || "");
    };
    const box = $("air-msgs");
    const lsePaint = () => {
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      if (structural || !bot.el || !bot.el.isConnected) {
        structural = false;
        chatRender();
        return;
      }
      // Text-only delta: re-render just the answer bubble's body, not the
      // whole transcript (a full rebuild per network chunk made long chats
      // type visibly slower than the model streams).
      const nb = document.createElement("div");
      aiMarkdownInto(nb, bot.text);
      bot.el.replaceChild(nb, bot.el.lastElementChild);
      if (stick) box.scrollTop = box.scrollHeight;
    };
    chatRender();
    try {
      const history = s.msgs.slice(0, -1)
        .filter((m) => m.kind === "user" || m.kind === "text")
        .map((m) => ({ role: m.kind === "user" ? "user" : "assistant", content: m.text }));
      // Paper grounding for questions TYPED with a paper open: the engine
      // attaches the PDF's full text only when a USER message carries a
      // "Link:" line, which used to exist only via the reader's Ask AI
      // prefill. Append the open paper to the outgoing copy of this turn
      // (never the stored/displayed message) so "explain this paper",
      // typed straight into the panel, is grounded too. Wire-copy-only
      // also means old frozen sidecars get this for free: their engine
      // already scans user messages. Skip when the user's text already
      // names a link (the Ask AI path), so the paper is never doubled.
      const paper = aiOpenPaperNow();
      const lastMsg = history[history.length - 1];
      if (paper && lastMsg && lastMsg.role === "user"
          && !/^Link: https?:\/\//m.test(lastMsg.content)) {
        lastMsg.content += "\n\n[Attached by the terminal: the research " +
          "paper open on my screen]\n" + aiPaperLines(paper);
      }
      // The context below leaves out a broker's prices when its terms keep
      // them on this computer (SPEC 3.3), by the engine's rows of now.
      await brokerRowsFresh();
      const r = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: s.abort.signal,
        body: JSON.stringify({
          // The mode brief is its own system message: brue_cloud joins every
          // client system message into the prompt head (client_system), so
          // the stance lands next to the screen context with no server
          // change and old sidecars are unaffected.
          messages: [{ role: "system", content: aiContext() }]
            .concat(stance ? [{ role: "system", content: stance.brief }] : [])
            .concat(history),
        }),
      });
      if (!r.ok) {
        let detail = `assistant HTTP ${r.status}`;
        try { detail = (await r.json()).detail || detail; } catch (e) { /* keep */ }
        s.msgs.splice(s.msgs.length - 2, 2); // unwind the failed turn
        if (r.status === 401) {
          s.pending = text; // retried automatically after the key lands
          s.needKey = true;
        } else {
          s.msgs.push({ kind: "error", text: detail });
        }
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          try {
            const j = JSON.parse(d);
            if (j.error) { s.msgs.push({ kind: "error", text: j.error }); structural = true; }
            if (j.lse_usage) { ai.lseUsage = j.lse_usage; ai.lseUsageAt = Date.now(); continue; }
            if (j.lse_tool_delta) { onToolDelta(j.lse_tool_delta); continue; }
            if (j.lse_tool) { onToolNote(j.lse_tool); continue; }
            const delta = j.choices && j.choices[0].delta.content;
            if (delta) {
              if (!bot.text) { settleRunning(); collapseAll(); }
              bot.text += delta;
            }
          } catch (e) { /* partial line; next chunk completes it */ }
        }
        lsePaint();
      }
    } catch (e) {
      if (!(e && e.name === "AbortError")) {
        s.msgs.push({ kind: "error", text: oneLine(e) || "error" });
      }
    } finally {
      bot.done = true;
      settleRunning(); collapseAll(); // whatever was still "running" is over
      if (!bot.text && s.msgs.includes(bot)) {
        s.msgs.splice(s.msgs.indexOf(bot), 1); // empty bubble (aborted early)
      }
      s.busy = false;
      s.abort = null;
      persistChat("lse"); // turn boundary: archive the finished exchange
      chatRender();
    }
  }

  // File -> editor. The agent edited strategy.py: reflect it. The mtime
  // guard plus content compare keeps the editor's own pushes from echoing.
  async function pollStrategy() {
    if (!hasEditor()) return;
    try {
      const r = await fetch("/api/ai/strategy").then((x) => x.json());
      if (r.mtime && r.mtime !== ai.mtime) {
        if (ai.mtime && r.source != null && r.source !== $("bt-src").value) {
          $("bt-src").value = r.source;
          status(`strategy updated by ${label(ai.agent)}`);
        }
        ai.mtime = r.mtime;
      }
    } catch (e) { /* engine briefly away */ }
  }

  function pushWorkspace() {
    return fetch("/api/ai/workspace", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: workspaceBody() })
      .catch(() => {});
  }

  // Editor -> file, debounced, only while the rail is open.
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "bt-src" && !rail.classList.contains("hidden")) {
      clearTimeout(ai.push);
      ai.push = setTimeout(pushWorkspace, 1200);
    }
  });

  function ensureTerm() {
    if (ai.term) return;
    ai.term = new Terminal({
      fontSize: 12.5, cursorBlink: true, scrollback: 5000,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      theme: { background: themeVar("--bg", "#212121"),
               foreground: themeVar("--text", "#e6e8ea"),
               cursor: themeVar("--text", "#e6e8ea"),
               selectionBackground: themeVar("--edge", "#26282c") },
    });
    ai.fit = new FitAddon.FitAddon();
    ai.term.loadAddon(ai.fit);
    ai.term.open($("air-term"));
    ai.term.onData((d) => {
      if (ai.ws && ai.ws.readyState === 1) ai.ws.send(JSON.stringify({ type: "input", data: d }));
    });
    new ResizeObserver(() => {
      // Skip while collapsed: fitting xterm to the 30px strip would clamp it
      // to ~1 column and garble the buffer for the reopen.
      if (!rail.classList.contains("hidden") && !rail.classList.contains("collapsed") && ai.fit) { ai.fit.fit(); sendSize(); }
    }).observe($("air-term"));
  }

  // The Chat|Terminal toggle is hidden for EVERY agent (chat-only
  // panel). The term view itself stays, because agent
  // login flows still open it programmatically via setMode("term"); only
  // the manual toggle is gone. The autonomy selector shows for local agent
  // providers only (the hosted LSE Assistant has no tools to approve).
  function updateModeUi() {
    $("air-mode").classList.add("hidden");
    $("air-auto").classList.toggle("hidden", ai.agent === "lse");
    renderAuto();
    $("air-model").classList.toggle("hidden", ai.agent === "lse");
    renderModelBtn();
    renderToolsBar(); // the strip's list depends on the agent
    infoClose();
  }

  /* ----- LSE Assistant usage (/usage) -----
     Two sources, freshest wins: the engine's GET /api/assistant/usage
     (asks the LSE side for the key's count right now; an engine without
     the route answers 404) and the lse_usage frame the LSE side puts at the
     head of every reply stream (so a frozen older engine still yields a
     figure after the first message of the day). Nothing is invented: no
     figure yet = say so. */
  ai.lseUsage = null;
  ai.lseUsageAt = 0;
  async function lseUsageFetch() {
    try {
      const r = await fetch("/api/assistant/usage");
      if (r.ok) {
        const d = await r.json();
        if (d && d.ok) { ai.lseUsage = d; ai.lseUsageAt = Date.now(); return d; }
      }
    } catch (e) { /* fall through to the frame */ }
    return ai.lseUsage;
  }
  function lseUsageText(u) {
    if (!u) return null;
    const when = u.resets_at ? new Date(u.resets_at) : null;
    const reset = when && !isNaN(when)
      ? `resets ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    if (u.unlimited || u.cap < 0) return `Today: ${u.used} messages. No daily cap on this key.`;
    return `Today: ${u.used} of ${u.cap} messages used, ${u.remaining} left` +
           (reset ? ` (${reset}).` : ".");
  }
  async function lseUsageNote() {
    const s = session("lse");
    const u = await lseUsageFetch();
    const t = lseUsageText(u);
    s.msgs.push({ kind: "note", text: t
      ? t + (ai.lseUsageAt && !u.ok ? " (as of your last message)" : "")
      : "No usage figure yet: it arrives with your first reply of the day." });
    chatRender();
  }

  /* ----- the "i" beside the picker: free, allowance, what a message sends -- */
  // Looked up per call, not captured: updateModeUi (which closes this) can
  // run before this block during setup, and a const here would be in TDZ.
  function infoClose() {
    $("air-info-pop").classList.add("hidden");
    $("air-info-btn").classList.remove("active");
  }
  async function infoOpen() {
    const infoBtn = $("air-info-btn");
    const infoPop = $("air-info-pop");
    infoBtn.classList.add("active");
    infoPop.innerHTML = "";
    const title = document.createElement("div");
    title.className = "air-info-title";
    title.textContent = label("lse");
    infoPop.appendChild(title);
    const free = document.createElement("div");
    free.className = "air-info-free";
    free.textContent = "Free to use. Included with your free LSE data key: no charge, no card, no paid tier.";
    infoPop.appendChild(free);
    const rows = document.createElement("div");
    infoPop.appendChild(rows);
    const row = (k, v) => {
      const r = document.createElement("div");
      r.className = "air-info-row";
      r.innerHTML = `<span>${aiEscape(k)}</span><span>${aiEscape(v)}</span>`;
      rows.appendChild(r);
    };
    const u = ai.lseUsage;
    if (u) {
      row("Daily allowance", u.unlimited || u.cap < 0 ? "no cap" : `${u.cap} messages`);
      row("Used today", String(u.used));
    } else {
      row("Daily allowance", "shown by /usage");
    }
    row("Runs on", "LSE's own model server");
    const note = document.createElement("div");
    note.className = "air-info-note";
    note.textContent = "Each message sends your chat, what is on your screen, and the results of the tools it uses (dataset previews, backtest numbers, positions when asked).";
    infoPop.appendChild(note);
    infoPop.classList.remove("hidden");
    // Refresh the allowance in the background; repaint if it lands.
    const before = ai.lseUsageAt;
    lseUsageFetch().then(() => { if (ai.lseUsageAt !== before && !infoPop.classList.contains("hidden")) infoOpen(); });
  }
  $("air-info-btn").onclick = (e) => {
    e.stopPropagation();
    if ($("air-info-pop").classList.contains("hidden")) infoOpen(); else infoClose();
  };
  document.addEventListener("click", (e) => {
    const infoPop = $("air-info-pop");
    if (!infoPop.classList.contains("hidden") && !infoPop.contains(e.target)) infoClose();
  });

  /* ----- tool browser strip -----
     The bar under the header lists every native function the active agent
     can call. Local agents: /api/ai/tools serves the bridge's
     CAPABILITY_TOOLS verbatim. The LSE Assistant: /api/assistant/tools
     (its local tools, executed by this engine, plus the LSE side's web
     tools); an engine without that route gets the older fixed set. Click a
     chip for the tool's description + parameters. */
  ai.tools = [];
  ai.lseTools = [
    { name: "list_datasets", description: "The user's MY DATA library: every dataset's symbol, kind, timeframe, rows, columns and time range.", params: [] },
    { name: "preview_dataset", description: "First rows of one dataset with its column names.", params: ["symbol", "rows", "part"] },
    { name: "run_backtest", description: "Run a strategy script on the local backtest engine; returns the real stats or the exact error.", params: ["script", "symbol", "timeframe"] },
    { name: "read_guide", description: "A section of the terminal's built-in guide.", params: ["section"] },
    { name: "web_search", description: "Search the web (runs on the LSE side, in a sandbox).", params: ["query"] },
    { name: "fetch_url", description: "Read a web page, PDF or text/data file (LSE-side sandbox).", params: ["url"] },
    { name: "browse", description: "Open a page and follow links (LSE-side sandbox).", params: ["url"] },
  ];
  fetch("/api/ai/tools").then((r) => r.json()).then((d) => {
    ai.tools = (d && d.tools) || [];
    renderToolsBar();
  }).catch(() => {});
  fetch("/api/assistant/tools").then((r) => r.ok ? r.json() : null).then((d) => {
    if (d && Array.isArray(d.tools) && d.tools.length) { ai.lseTools = d.tools; renderToolsBar(); }
  }).catch(() => {});
  function renderToolsBar() {
    const strip = $("air-tools-strip");
    strip.innerHTML = "";
    for (const t of (ai.agent === "lse" ? ai.lseTools : ai.tools)) {
      const chip = document.createElement("button");
      chip.className = "air-tool-chip";
      chip.textContent = t.name;
      chip.onclick = (e) => { e.stopPropagation(); toolsOpen(t, chip); };
      strip.appendChild(chip);
    }
    updateToolsBar();
  }
  function updateToolsBar() {
    const list = ai.agent === "lse" ? ai.lseTools : ai.tools;
    $("air-tools").classList.toggle("hidden", !list.length);
    $("air-info").classList.toggle("hidden", ai.agent !== "lse");
  }
  function toolsClose() {
    $("air-tools-menu").classList.add("hidden");
    for (const el of $("air-tools-strip").children) el.classList.remove("active");
  }
  function toolsOpen(t, chip) {
    // Second click on the open chip folds the popover back up.
    const wasOpen = chip.classList.contains("active");
    toolsClose();
    if (wasOpen) return;
    chip.classList.add("active");
    const menu = $("air-tools-menu");
    menu.innerHTML = "";
    // textContent throughout: descriptions carry quotes and braces and must
    // never be parsed as HTML.
    const name = document.createElement("div");
    name.className = "air-tool-name";
    name.textContent = t.name;
    menu.appendChild(name);
    const desc = document.createElement("div");
    desc.className = "air-tool-desc";
    desc.textContent = t.description || "";
    menu.appendChild(desc);
    if ((t.params || []).length) {
      const p = document.createElement("div");
      p.className = "air-tool-params";
      p.textContent = t.params.join(", ");
      menu.appendChild(p);
    }
    menu.classList.remove("hidden");
  }
  // Same dismissal contract as every other popover in the rail.
  document.addEventListener("click", (e) => {
    const menu = $("air-tools-menu");
    if (!menu.classList.contains("hidden") && !menu.contains(e.target)) toolsClose();
  });

  /* ----- autonomy: Ask / Auto-edit / Full auto (VS Code agent style) -----
     Stored per provider in this browser. "ask" and "edits" route risky
     actions through the in-chat Allow/Deny cards (the engine's permission
     bridge); "full" runs the CLI's own skip-permissions mode and is
     consent-gated by a second confirming click the first time. */
  const AUTO_LEVELS = [
    { id: "ask", name: "Ask", desc: "Every risky action needs your Allow in this chat" },
    { id: "edits", name: "Auto-edit", desc: "File edits run freely; commands still ask" },
    { id: "full", name: "Full auto", desc: "No prompts at all; the agent acts on its own" },
  ];
  const autoLevel = () => {
    let v = "";
    try { v = localStorage.getItem("lset-air-auto-" + ai.agent) || ""; } catch (e) {}
    return AUTO_LEVELS.some((l) => l.id === v) ? v : "ask";
  };
  function renderAuto() {
    const cur = AUTO_LEVELS.find((l) => l.id === autoLevel());
    $("air-auto-btn").innerHTML =
      `<span class="air-auto-cur">${cur.name}</span><span class="air-caret">&#9662;</span>`;
  }
  function autoClose() { $("air-auto-menu").classList.add("hidden"); }
  function renderAutoMenu() {
    const menu = $("air-auto-menu");
    menu.innerHTML = "";
    for (const l of AUTO_LEVELS) {
      const row = document.createElement("button");
      row.className = "air-auto-row" + (l.id === autoLevel() ? " active" : "");
      const confirming = ai.autoConfirm === l.id;
      row.innerHTML = `<span class="air-auto-name">${confirming
        ? "Click again to confirm" : l.name}</span>` +
        `<span class="air-auto-desc">${confirming
          ? "Full auto = the agent runs commands and edits with no prompts"
          : l.desc}</span>`;
      row.onclick = (e) => {
        e.stopPropagation();
        let ok = true;
        if (l.id === "full") {
          try { ok = localStorage.getItem("lset-air-full-ok") === "1"; } catch (e2) {}
          if (!ok && ai.autoConfirm !== "full") {
            ai.autoConfirm = "full"; // first click arms, second confirms
            renderAutoMenu();
            return;
          }
          try { localStorage.setItem("lset-air-full-ok", "1"); } catch (e2) {}
        }
        ai.autoConfirm = null;
        try { localStorage.setItem("lset-air-auto-" + ai.agent, l.id); } catch (e2) {}
        renderAuto();
        autoClose();
      };
      menu.appendChild(row);
    }
  }
  $("air-auto-btn").onclick = (e) => {
    e.stopPropagation();
    histClose();
    setClose();
    modelClose();
    ai.autoConfirm = null;
    const menu = $("air-auto-menu");
    if (menu.classList.contains("hidden")) { renderAutoMenu(); menu.classList.remove("hidden"); }
    else autoClose();
  };

  /* ----- model switcher: the session's model at the top right -----
     One click from Fable to Sonnet etc.; the "/"
     menu's Switch model row stays as the keyboard path and both write the
     same session.model, so they can never disagree. Rows reuse the
     .air-auto-row classes: same look, no extra CSS to keep in sync. */
  function renderModelBtn() {
    $("air-model-btn").innerHTML =
      `<span class="air-model-cur">${aiEscape(modelLabel())}</span>` +
      `<span class="air-caret">&#9662;</span>`;
  }
  function modelClose() { $("air-model-menu").classList.add("hidden"); }
  function renderModelMenu() {
    const s = session(ai.agent);
    const menu = $("air-model-menu");
    menu.innerHTML = "";
    // Same rows as the "/" menu: the CLI's own models, the ones that need
    // a newer CLI, and the typed-name row for every provider.
    for (const m of modelMenuRows(ai.agent)) {
      const row = document.createElement("button");
      row.className = "air-auto-row" +
        (m.needsUpdate ? " needs-update" : (s.model || "") === m.id ? " active" : "");
      row.dataset.model = m.id;
      row.innerHTML = `<span class="air-auto-name">${aiEscape(m.name)}</span>` +
        `<span class="air-auto-desc">${aiEscape(m.desc || "")}</span>`;
      row.onclick = (e) => {
        e.stopPropagation();
        modelClose();
        if (m.id === "__custom") {
          const input = $("air-input");
          input.value = "/model ";
          input.focus();
          return;
        }
        if (m.cliUpdate) {
          if (!m.busy) cliUpdate(ai.agent, true);
          return;
        }
        if (m.needsUpdate) {
          s.msgs.push({ kind: "note", text: modelUpdateNote(ai.agent, m) });
          chatRender();
          return;
        }
        s.model = m.id;
        renderModelBtn();
      };
      menu.appendChild(row);
    }
  }
  $("air-model-btn").onclick = (e) => {
    e.stopPropagation();
    histClose();
    setClose();
    autoClose();
    const menu = $("air-model-menu");
    if (!menu.classList.contains("hidden")) { modelClose(); return; }
    renderModelMenu();
    menu.classList.remove("hidden");
    // The menu hangs from the button's right edge. A long provider name
    // pushes the button left and the menu's left edge out of the rail,
    // which cut the first letters off every row: keep it inside.
    menu.style.right = "0px";
    const cut = rail.getBoundingClientRect().left + 6 - menu.getBoundingClientRect().left;
    if (cut > 0) menu.style.right = -cut + "px";
    // Drawn at once from what the CLI last said, then asked again: a model
    // shipped since then appears while the menu is still open.
    modelsSync(ai.agent);
  };

  function setMode(mode) {
    if (mode === "term" && (ai.agent === "lse" || !window.Terminal)) mode = "chat";
    ai.mode = mode;
    $("air-mode-chat").classList.toggle("active", mode === "chat");
    $("air-mode-term").classList.toggle("active", mode === "term");
    $("air-md").classList.add("hidden"); // leaving the instruction editor
    $("air-chat").classList.toggle("hidden", mode !== "chat");
    $("air-term").classList.toggle("hidden", mode !== "term");
    if (mode === "term") {
      ensureTerm();
      ai.fit.fit();
      if (!ai.ws || ai.ws.readyState > 1 || ai.ptyAgent !== ai.agent ||
          ai.loginNext) ptyConnect();
      sendSize();
      ai.term.focus();
    } else {
      // Returning from the terminal: a sign-in may have just completed
      // there, so re-check auth state before painting the empty state.
      refreshStatus().then(chatRender);
      chatRender();
      $("air-input").focus();
    }
  }

  // The rail is a permanent fixture (no open/close buttons, like the left
  // sidebar); this runs once at setup to bring it live.
  function open() {
    rail.classList.remove("hidden");
    pushWorkspace();
    updateModeUi();
    setMode(ai.mode);
    if (!ai.poll) ai.poll = setInterval(pollStrategy, 2000);
  }

  // Switching provider: chat keeps one transcript+session per provider and
  // just swaps which one is on screen; the terminal view restarts its PTY
  // with the newly chosen agent (each is its own sign-in). Picking the LSE
  // Assistant forces the chat view (it has no terminal) and kills a live
  // PTY the same way closing the panel used to.
  function selectAgent(name) {
    if (name === ai.agent) { renderPicker(); return; }
    ai.agent = name;
    renderPicker();
    // Ask this provider's CLI for its models now, so the menu is already
    // current when it is first opened (and the CLI itself, where the user
    // turned that on).
    modelsSync(name);
    updateModeUi();
    renderModeHint(); // each provider keeps its own stance
    if (name === "lse") {
      if (ai.ws) { try { ai.ws.close(); } catch (err) { /* already down */ } ai.ws = null; }
      setMode("chat");
      chatRender();
      return;
    }
    chatConnect(name);
    if (ai.mode === "term") {
      ai.term.reset();
      ai.term.write(`\r\n  switching to ${label(ai.agent)}...\r\n`);
      ptyConnect();
      ai.fit.fit();
      sendSize();
      ai.term.focus();
    } else {
      chatRender();
    }
  }

  $("air-mode-chat").onclick = () => setMode("chat");
  $("air-mode-term").onclick = () => setMode("term");
  $("air-plus").onclick = () => {
    // Same menu as typing "/", VS Code style.
    const input = $("air-input");
    if ($("air-slash").classList.contains("hidden")) {
      if (!input.value.startsWith("/")) input.value = "/";
      input.focus();
      slashRender(true);
    } else {
      menuClose();
    }
  };
  $("air-send").onclick = () => sendChat();
  $("air-stop").onclick = () => {
    const s = session(ai.agent);
    if (ai.agent === "lse") {
      if (s.abort) s.abort.abort(); // cuts the SSE stream mid-turn
      return;
    }
    if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "stop" }));
  };
  $("air-input").addEventListener("keydown", (e) => {
    const menuOpen = !$("air-slash").classList.contains("hidden");
    if (menuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      menuMove(e.key === "ArrowDown" ? 1 : -1);
    } else if (menuOpen && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const row = ai.menu.rows[ai.menu.sel];
      if (row && row.id) menuRun(row.id);
      else sendChat();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    } else if (e.key === "Escape") {
      if (ai.menu.view !== "main") { ai.menu.view = "main"; ai.menu.sel = 0; slashRender(true); }
      else menuClose();
    }
  });
  // Attach file: a real file picker; in the desktop shell (Electron 31)
  // File.path carries the absolute path, which the agent can read itself.
  // Plain browsers only expose the name, still useful as a mention.
  $("air-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const input = $("air-input");
    input.value = (input.value ? input.value + " " : "") + (f.path || f.name) + " ";
    e.target.value = "";
    input.focus();
  });
  // Paste an image into the composer: saved into the agent workspace, its
  // path lands in the input so the agent (vision-capable CLIs) can Read it.
  $("air-input").addEventListener("paste", async (e) => {
    const item = [...(e.clipboardData?.items || [])].find(
      (i) => i.type && i.type.startsWith("image/"));
    if (!item || ai.agent === "lse") return;
    e.preventDefault();
    const blob = item.getAsFile();
    if (!blob || blob.size > 8 * 1024 * 1024) return;
    const b64 = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(",")[1] || "");
      fr.readAsDataURL(blob);
    });
    const r = await fetch("/api/ai/paste-image", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: b64 }) }).catch(() => null);
    if (r && r.ok) {
      const { path } = await r.json();
      const input = $("air-input");
      input.value = (input.value ? input.value + " " : "") +
        `[pasted image: ${path}] `;
      input.focus();
    }
  });

  $("air-input").addEventListener("input", (e) => {
    // Composer grows with its content like the VS Code chat box, capped.
    const el = e.target;
    el.style.height = "";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
    slashRender();
  });

  // Drag handle: resize the rail; the active section reflows automatically.
  // The .dragging class suspends the collapse width transition, which would
  // otherwise lag every mousemove.
  (function () {
    const handle = $("air-resize");
    if (!handle) return;
    let dragging = false;
    handle.addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); document.body.style.userSelect = "none"; rail.classList.add("dragging"); });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = Math.min(window.innerWidth * 0.7, Math.max(320, window.innerWidth - e.clientX));
      rail.style.width = w + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = ""; rail.classList.remove("dragging");
      if (ai.fit && !rail.classList.contains("hidden")) { ai.fit.fit(); sendSize(); }
    });
  })();

  // Collapse/expand: the rail folds to a slim reopen strip (the CSS owns the
  // animation; .collapsed owns the folded width). The user's drag-width is
  // held in ai.railW across the fold and restored on reopen, and the choice
  // sticks across launches via localStorage (replayed pre-paint at the
  // bottom of this file, so a collapsed rail never flashes open at boot).
  function setCollapsed(on) {
    if (on === rail.classList.contains("collapsed")) return;
    if (on) {
      ai.railW = rail.getBoundingClientRect().width;
      rail.style.width = "";           // hand the width to the .collapsed rule
      rail.classList.add("collapsed");
    } else {
      rail.classList.remove("collapsed");
      if (ai.railW) rail.style.width = ai.railW + "px";
      // Refit the terminal (or refocus chat) once the width animation lands;
      // fitting mid-animation would size xterm to a half-open rail.
      setTimeout(() => {
        if (rail.classList.contains("collapsed")) return; // re-folded meanwhile
        if (ai.mode === "term" && ai.fit) { ai.fit.fit(); sendSize(); }
        else $("air-input").focus();
      }, 240);
    }
    try { localStorage.setItem("lset-air-collapsed", on ? "1" : "0"); } catch (e) { /* best effort */ }
  }
  $("air-collapse").onclick = () => setCollapsed(true);
  $("air-expand").onclick = () => setCollapsed(false);

  open(); // permanent rail: live from boot on every tab
}

/* Run options shared by every mode. Dates are UTC (the engine treats
   YYYY-MM-DD as UTC midnight, so the value passes through untouched). */
function backtestOptions(mode) {
  const opts = {};
  if ($("bt-from").value) opts.from = $("bt-from").value;
  if ($("bt-to").value) opts.to = $("bt-to").value;
  if (mode === "run" && $("bt-ext").checked) opts.extended_stats = true;
  return opts;
}

function parseWfParams(text) {
  // "len=5:30:5, mult=1,2,3" -> {len: "5:30:5", mult: "1,2,3"}. Split on
  // commas ONLY when the next chunk contains '=', so value lists survive.
  const params = {};
  let current = null;
  for (const chunk of text.split(",")) {
    if (chunk.includes("=")) {
      const [name, v] = chunk.split("=");
      current = name.trim();
      params[current] = v.trim();
    } else if (current) {
      params[current] += "," + chunk.trim();
    }
  }
  return params;
}

function statTile(k, v, cls = "") {
  return `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
}

function fmtMoney(n) {
  const s = Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
  return (n >= 0 ? "" : "-") + "$" + Math.abs(s);
}

async function runBacktest() {
  const mode = $("bt-mode").value;
  status(mode === "run" ? "running backtest…" : `running ${mode}…`);
  $("bt-err").classList.add("hidden");
  // A `# run:` pin names a MY DATA dataset, so it only applies on the
  // userdata provider; on live providers the chart symbol stays in charge.
  const pin = dataProvider() === "userdata" ? pyRunPin($("bt-src").value) : null;
  const body = {
    engine: backtest.engine, provider: dataProvider(),
    symbol: (pin && pin.symbol) || state.symbol,
    // limit 0: every bar of a local dataset; the engine caps remote data.
    timeframe: state.timeframe, script: $("bt-src").value, limit: 0,
    options: backtestOptions(mode), datasets: attachedDatasets(),
  };
  let url = "/api/backtest";
  if (mode === "montecarlo") {
    url = "/api/backtest/montecarlo";
    body.runs = parseInt($("bt-mc-runs").value, 10) || 1000;
    body.seed = parseInt($("bt-mc-seed").value, 10) || 42;
  } else if (mode === "walkforward") {
    url = "/api/backtest/walkforward";
    body.params = parseWfParams($("bt-wf-params").value);
    body.folds = parseInt($("bt-wf-folds").value, 10) || 4;
    body.train = parseFloat($("bt-wf-train").value) || 0.7;
    if (!Object.keys(body.params).length) {
      $("bt-err").textContent =
        'Walk-forward needs a param grid, e.g. "len=5:30:5" with {{len}} in the script.';
      $("bt-err").classList.remove("hidden");
      status("walk-forward needs params");
      return;
    }
  }
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.status;
    try { detail = (await res.json()).detail || detail; } catch (e) { /* keep */ }
    $("bt-err").textContent = String(detail);
    $("bt-err").classList.remove("hidden");
    status(`${mode} failed`);
    return;
  }
  const data = await res.json();
  if (mode === "montecarlo") renderMonteCarlo(data);
  else if (mode === "walkforward") renderWalkforward(data);
  else renderBacktest(data);
}

const fmtNum = (n, d = 2) => (n == null || !isFinite(n)) ? "–" : Number(n).toFixed(d);

function quantShow(html) {
  $("bt-quant").innerHTML = html;
  $("bt-quant").classList.remove("hidden");
}

function renderMonteCarlo(mc) {
  $("bt-stats").innerHTML =
    statTile("Paths", mc.runs) +
    statTile("Trades/path", mc.tradesPerPath) +
    statTile("P(loss)", (mc.probLoss * 100).toFixed(1) + "%", mc.probLoss > 0.5 ? "neg" : "") +
    statTile("Risk of ruin", (mc.riskOfRuin * 100).toFixed(1) + "%", mc.riskOfRuin > 0 ? "neg" : "pos");
  const row = (label, p) =>
    `<tr><td>${label}</td><td>${fmtMoney(p.p5)}</td><td>${fmtMoney(p.p25)}</td>` +
    `<td>${fmtMoney(p.p50)}</td><td>${fmtMoney(p.p75)}</td><td>${fmtMoney(p.p95)}</td></tr>`;
  const dd = mc.maxDrawdownPct;
  quantShow(
    `<table class="qt"><thead><tr><th>Distribution</th><th>p5</th><th>p25</th>` +
    `<th>median</th><th>p75</th><th>p95</th></tr></thead><tbody>` +
    row("Final equity", mc.finalEquity) +
    `<tr><td>Max drawdown</td><td>${fmtNum(dd.p5)}%</td><td>${fmtNum(dd.p25)}%</td>` +
    `<td>${fmtNum(dd.p50)}%</td><td>${fmtNum(dd.p75)}%</td><td>${fmtNum(dd.p95)}%</td></tr>` +
    `</tbody></table>` +
    `<div class="qt-note">Reshuffles of the backtest's own trades (seed ${mc.seed}); ` +
    `base net ${fmtMoney(mc.baseNetProfit)}.</div>`);
  status(`monte carlo · ${mc.runs} paths · P(loss) ${(mc.probLoss * 100).toFixed(1)}%`);
}

function renderWalkforward(wf) {
  $("bt-stats").innerHTML =
    statTile("Folds", wf.folds.length) +
    statTile("Combos/fold", wf.combosPerFold) +
    statTile("OOS net", fmtMoney(wf.totalOosNetProfit),
             wf.totalOosNetProfit >= 0 ? "pos" : "neg") +
    statTile("OOS trades", wf.totalOosTrades) +
    statTile("Efficiency", fmtNum(wf.meanEfficiency),
             (wf.meanEfficiency || 0) >= 0.5 ? "pos" : "neg");
  const rows = wf.folds.map((f) => {
    const params = Object.entries(f.bestParams).map(([k, v]) => `${k}=${v}`).join(" ");
    return `<tr><td>${f.fold + 1}</td><td>${params}</td>` +
      `<td>${fmtMoney(f.trainNetProfit)}</td><td>${fmtMoney(f.oosNetProfit)}</td>` +
      `<td>${f.oosTrades}</td><td>${fmtNum(f.efficiency)}</td></tr>`;
  }).join("");
  quantShow(
    `<table class="qt"><thead><tr><th>Fold</th><th>Best params</th><th>IS net</th>` +
    `<th>OOS net</th><th>OOS trades</th><th>Eff.</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="qt-note">Params optimized in-sample per fold (metric: ${wf.metric}), ` +
    `replayed out-of-sample. Efficiency = per-bar OOS profit / per-bar IS profit.</div>`);
  status(`walk-forward · ${wf.folds.length} folds · OOS ${fmtMoney(wf.totalOosNetProfit)}`);
}

function renderBacktest(r) {
  $("bt-quant").classList.add("hidden");
  const ret = r.initial_capital ? (r.net_profit / r.initial_capital) * 100 : 0;
  const s = r.stats || {};
  const pos = (n) => (n >= 0 ? "pos" : "neg");
  let tiles =
    statTile("Net profit", fmtMoney(r.net_profit), pos(r.net_profit)) +
    statTile("Return", ret.toFixed(2) + "%", pos(ret)) +
    statTile("Final equity", fmtMoney(r.final_equity)) +
    statTile("Max DD", (s.maxDrawdownPct != null ? s.maxDrawdownPct.toFixed(2) + "%" : "–"), "neg") +
    statTile("Sharpe", s.sharpeRatio != null ? s.sharpeRatio.toFixed(2) : "–", pos(s.sharpeRatio || 0)) +
    // winRate arrives already as a percentage (e.g. 31.25), not a fraction.
    statTile("Win rate", s.winRate != null ? s.winRate.toFixed(1) + "%" : "–") +
    statTile("Trades", s.totalTrades != null ? s.totalTrades : r.trades.length) +
    statTile("Profit factor", s.profitFactor != null ? s.profitFactor.toFixed(2) : "–");
  // Risk block, present when the run was made with extended stats on.
  const x = s.extended;
  if (x) {
    tiles +=
      statTile("VaR 95", fmtNum(x.var95) + "%", "neg") +
      statTile("CVaR 95", fmtNum(x.cvar95) + "%", "neg") +
      statTile("Sortino", fmtNum(x.sortino), pos(x.sortino || 0)) +
      statTile("Calmar", fmtNum(x.calmar), pos(x.calmar || 0)) +
      statTile("Exposure", fmtNum(x.exposurePct, 1) + "%") +
      statTile("Avg hold", fmtNum(x.avgBarsHeld, 1) + " bars");
  }
  $("bt-stats").innerHTML = tiles;

  backtest.equitySeries.setData(r.equity_curve.map(([t, v]) => ({ time: t, value: v })));
  backtest.equityChart.timeScale().fitContent();

  // Trades are drawn by the ported engine as labelled position lines.
  // Same trades for the pro engine, which draws them as price lines rather
  // than bar markers, so a backtest is readable on either engine.
  state.trades = r.trades.map((t) => ({
    time: t.entry_ts,
    price: t.entry_price,
    side: t.direction === "long" ? "buy" : "sell",
    quantity: t.qty || 0,
    pnl: t.pnl,
  }));
  pushToChart();

  status(`backtest · ${r.trades.length} trades · net ${fmtMoney(r.net_profit)}`);
}

/* ---------- my data (own CSV imports) ---------- */

async function refreshDatasets() {
  const [list, folders, ws, nbs] = await Promise.all([
    fetch("/api/data").then((r) => r.json()).catch(() => []),
    fetch("/api/data/folders").then((r) => r.json()).catch(() => []),
    // Workspace strategies render in the library sidebar too (SCRIPTS
    // section), so "what can I backtest with" is one list, not two pages.
    fetch("/api/ws-files").then((r) => r.json()).catch(() => ({ files: [] })),
    // Notebooks ride the same refresh: the tree's NOTEBOOKS section
    // renders wherever the tree does. An engine without the
    // route, or hosted mode, yields an empty section, never an error.
    fetch("/api/notebooks").then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  state.datasetList = list;
  // The manifest is what tells the timeframe bar which bars an imported file
  // can actually serve, and it lands AFTER the provider switch has already
  // drawn that bar; redraw it now or the ladder stays fully enabled for a
  // dataset that cannot answer half of it.
  if (state.provider === "userdata") renderTimeframes();
  state.folderList = folders;
  // '.library' is the notebooks island's hidden storage (saved equations),
  // not a notebook anyone opens; the island filters it from its own lists
  // and this fetch must agree or the tree would show a ghost row.
  state.nbList = (Array.isArray(nbs) ? nbs : [])
    .filter((m) => (m.folder || "") !== ".library");
  state.wsFiles = ws.files || [];
  state.wsRoot = ws.root || "";
  state.dataRoot = ws.data_root || "";
  // The IDE surfaces keep their own file arrays for open/dup-check logic;
  // one fetch feeds all of them so the three explorers can never disagree.
  py.files = state.wsFiles;
  wsx.files = state.wsFiles;
  // Data may have changed under a cached preview; rebuild on next open.
  py.previewCache = {};
  renderDatasetAttach();
}

/* Refresh the shared stores and repaint every live copy of the library
   tree (watchlist sidebar + the WORKSPACE explorer). Rendering a hidden
   host is harmless and keeps the copies in sync for the next reveal. */
async function refreshLibraryAll() {
  await refreshDatasets();
  pyPruneTabs();
  renderDataSidebar();
  repaintLibraryTrees();
  if ($("wsx-root")) $("wsx-root").textContent = state.wsRoot || "";
}

/* Library icons: one glyph per row kind so a glance answers "folder,
   data file, or script?" without reading the name. */
const TREE_ICO = {
  upload: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V3.5"/><path d="M5.2 6 8 3.2 10.8 6"/><path d="M3 12.8h10"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 3.8h4.1l1.4 1.8h6.9v6.6H1.8z"/></svg>`,
  folderNew: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 3.8h4.1l1.4 1.8h6.9v6.6H1.8z"/><path d="M11 8.2v2.6"/><path d="M9.7 9.5h2.6"/></svg>`,
  data: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 1.8h6l3 3v9.4h-9z"/><path d="M9.5 1.8v3h3"/><path d="M5.6 11.6V9.4"/><path d="M8 11.6V7.8"/><path d="M10.4 11.6v-2.9"/></svg>`,
  script: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 4.8 3.2 8l3 3.2"/><path d="M9.8 4.8 12.8 8l-3 3.2"/></svg>`,
  // Database cylinder + pull-down arrow: the LSE databank import.
  lse: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="6.6" cy="3.6" rx="4.4" ry="1.8"/><path d="M2.2 3.6v6.6c0 1 1.9 1.8 4.4 1.8.5 0 1-.03 1.4-.09"/><path d="M11 3.6v3.1"/><path d="M12.6 8.6v4.2"/><path d="M10.8 11.1l1.8 1.9 1.8-1.9"/></svg>`,
  // Bound pad with a margin line: the NOTEBOOKS rows.
  notebook: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="2" width="9.6" height="12" rx="1.2"/><path d="M5.8 2v12"/><path d="M8 5.2h3.2"/><path d="M8 8h3.2"/><path d="M8 10.8h2.2"/></svg>`,
};

/* VS Code style file-type icons (the explorer must
   read like VS Code's, where the icon carries the type). Colors follow the
   Material icon theme: python two-tone, pink SQL cylinder,
   blue markdown arrow, yellow JSON braces, green table for price files,
   purple table for alternative-data series, grey doc for anything else.
   These are the one deliberate exception to the neutral-chrome rule. */
const FILE_ICO = {
  py: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#4b8bbe" d="M7.9 1.3c-2 0-3.1.9-3.1 2.3v1.7h3.3v.5H3.3c-1.4 0-2.2 1-2.2 2.7 0 1.7.8 2.7 2.2 2.7h1.3V9.3c0-1.3 1.1-2.4 2.4-2.4h3c1.1 0 2-.9 2-2V3.6c0-1.5-1.2-2.3-2.6-2.3H7.9zM7 2.5a.62.62 0 1 1 0 1.24A.62.62 0 0 1 7 2.5z"/><path fill="#ffd43b" d="M8.1 14.7c2 0 3.1-.9 3.1-2.3v-1.7H7.9v-.5h4.8c1.4 0 2.2-1 2.2-2.7 0-1.7-.8-2.7-2.2-2.7h-1.3v1.9c0 1.3-1.1 2.4-2.4 2.4H6c-1.1 0-2 .9-2 2v1.3c0 1.5 1.2 2.3 2.6 2.3h1.5zm.9-1.2a.62.62 0 1 1 0-1.24.62.62 0 0 1 0 1.24z"/></svg>`,
  sql: `<svg viewBox="0 0 16 16" width="16" height="16" fill="#ec407a"><ellipse cx="8" cy="3.4" rx="5" ry="2.1"/><path d="M3 5v3c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V5c-1 .9-2.9 1.5-5 1.5S4 5.9 3 5z"/><path d="M3 9.4v3.2c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V9.4c-1 .9-2.9 1.5-5 1.5s-4-.6-5-1.5z"/></svg>`,
  md: `<svg viewBox="0 0 16 16" width="16" height="16"><path fill="#42a5f5" d="M8 13 3.4 7.4h2.8V2.6h3.6v4.8h2.8z"/></svg>`,
  readme: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#90a4ae" stroke-width="1.3"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6" stroke-linecap="round"/><path d="M8 5v.1" stroke-linecap="round" stroke-width="1.8"/></svg>`,
  json: `<svg viewBox="0 0 16 16" width="16" height="16"><text x="8" y="12" text-anchor="middle" font-size="11" font-weight="700" fill="#fbc02d" font-family="monospace">{}</text></svg>`,
  table: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#8bc34a" stroke-width="1.2"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6.4h12M6.5 6.4V13M10.7 6.4V13"/></svg>`,
  series: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#a074c4" stroke-width="1.2"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6.4h12M6.5 6.4V13M10.7 6.4V13"/></svg>`,
  sheet: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#2e7d32" stroke-width="1.2"><rect x="2.5" y="2" width="11" height="12" rx="1"/><path d="M5.4 6.2l5.2 5.2M10.6 6.2l-5.2 5.2"/></svg>`,
  file: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#8a9199" stroke-width="1.2"><path d="M3.5 1.8h6l3 3v9.4h-9z"/><path d="M9.5 1.8v3h3"/></svg>`,
};

function libFileIcon(name) {
  const n = String(name || "").toLowerCase();
  if (/^readme(\.|$)/.test(n.split("/").pop())) return FILE_ICO.readme;
  const ext = n.slice(n.lastIndexOf(".") + 1);
  if (ext === "py") return FILE_ICO.py;
  if (ext === "sql") return FILE_ICO.sql;
  if (ext === "md") return FILE_ICO.md;
  if (ext === "json" || ext === "ipynb") return FILE_ICO.json;
  if (["csv", "tsv", "txt", "parquet", "pq", "feather"].includes(ext)) return FILE_ICO.table;
  if (["xlsx", "xls"].includes(ext)) return FILE_ICO.sheet;
  return FILE_ICO.file;
}

/* Folder icons: filled folder glyph, open variant when expanded, one colour
   for every folder. The colour used to be keyed off a hardcoded list of names
   (strategies/src blue, tests green, docs purple, data amber), copied from the
   VS Code Material theme. Removed: that theme also swaps the GLYPH
   per type, so colour there is a second cue on a visible distinction; here it
   was the only cue, keyed on a word list the user cannot see. The result was
   one blue folder among grey ones that looked like a state (selected? synced?)
   and meant nothing but a name match. "strategies" is only the preset name and
   users rename it freely, at which point the colour silently disappeared. */
const FOLDER_COLOR = "#90a4ae";
function libFolderIcon(name, open) {
  const c = FOLDER_COLOR;
  if (open) {
    return `<svg viewBox="0 0 16 16" width="16" height="16">` +
      `<path fill="${c}" opacity=".5" d="M1.7 3.2h4.4l1.4 1.5h6.8c.3 0 .5.2.5.5v1H3.6L1.2 12.4V3.7c0-.3.2-.5.5-.5z"/>` +
      `<path fill="${c}" d="M3.9 6.9h10.6c.3 0 .6.3.5.6l-1.4 4.9c-.1.2-.3.4-.5.4H2.1z"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" width="16" height="16">` +
    `<path fill="${c}" d="M1.7 3.2h4.4l1.4 1.5h6.8c.3 0 .5.2.5.5v7.1c0 .3-.2.5-.5.5H1.7a.5.5 0 0 1-.5-.5V3.7c0-.3.2-.5.5-.5z"/></svg>`;
}

/* Open one workspace strategy in the Python IDE, from anywhere. Mirrors
   the AI chat's "To strategy IDE" flow: rail click first so every other
   panel is put away by the one place that knows how. */
async function openScriptInIDE(path) {
  await openBacktest("py");
  if (path) await pyOpen(path);
}

/* ---------- the unified library tree ----------
   One library, everywhere: the watchlist sidebar on
   BACKTEST / MY DATA, the Algo Development explorer and the WORKSPACE
   explorer all render this same tree over the same two stores (/api/data
   datasets + /api/ws-files workspace files), instead of the three separate
   half-overlapping trees they used to be. ctx decides what a click means:
     charts - any non-IDE surface (MY DATA, ML, manual): dataset opens in
              Algo Development as the pinned dataset, file opens the IDE
              (the name is historical: it used to chart under the removed
              BACKTEST > CHARTS)
     py     - dataset becomes the backtest dataset, file opens in the editor
     wsx    - dataset click copies a load_data() snippet, file opens a tab
     nb     - the notebook page's rail: same as charts, and the NOTEBOOKS
              section is skipped because the island lists notebooks right
              above this tree */
function libCtx() {
  if (!$("pyide").classList.contains("hidden")) return "py";
  if (!$("wsx").classList.contains("hidden")) return "wsx";
  return "charts";
}

function renderDataSidebar() {
  renderLibraryTree($("watchlist"), libCtx());
}

/* Repaint the non-sidebar copies of the library tree: the WORKSPACE
   explorer, and the notebook page's rail, where the island renders its own
   notebook list and the shell fills #nb-lib with WORKSPACE + DATA (ctx "nb"
   skips the NOTEBOOKS section so the list is never shown twice). */
function repaintLibraryTrees() {
  if ($("wsx-lib")) renderLibraryTree($("wsx-lib"), "wsx");
  if ($("nb-lib")) renderLibraryTree($("nb-lib"), "nb");
}

/* The notebooks island announces its rail host once it exists (mount
   effect); fill it. On a cold landing straight onto the notebook page the
   shared stores may not be loaded yet, so do the full refresh, which ends
   by painting every live tree including this one. */
window.addEventListener("lse-nb-rail", () => {
  if (!$("nb-lib")) return;
  if (state.datasetList) renderLibraryTree($("nb-lib"), "nb");
  else refreshLibraryAll();
});

/* Last python-backtest result per script path, for the SCRIPTS chips.
   localStorage so it survives restarts without a server table. */
function btRunStats() {
  try { return JSON.parse(localStorage.getItem("lse.btRuns") || "{}"); }
  catch (e) { return {}; }
}

const fmtCount = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M"
  : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

function renderLibraryTree(el, ctx) {
  el.innerHTML = "";
  const list = state.datasetList || [];
  const head = document.createElement("div");
  head.className = "tree-head";
  head.innerHTML = `<span>LIBRARY</span>`;
  el.appendChild(head);
  // The toolbar is labeled buttons, not bare icons: "which tiny glyph is
  // new-folder" was a real usability complaint.
  // Import via LSE rides its own full-width row ABOVE the local-file actions:
  // it is the headline door to data, and a fourth
  // button in the shared row would not fit the sidebar width anyway.
  const lseRow = document.createElement("div");
  lseRow.className = "tree-actions";
  lseRow.innerHTML =
    `<button id="tree-lse" title="Browse the LSE databank and download available history into your library">` +
    `${TREE_ICO.lse}<span>Import via LSE Data</span></button>`;
  el.appendChild(lseRow);
  lseRow.querySelector("#tree-lse").onclick = () => openLsbModal();
  const bar = document.createElement("div");
  bar.className = "tree-actions";
  // "Upload", not "Data": the old label named the noun, not the action,
  // and users had to ask what the button did.
  bar.innerHTML =
    `<button id="tree-add-data" title="Upload a data file from this PC (CSV, Parquet, Excel, JSON)">${TREE_ICO.upload}<span>Upload</span></button>` +
    `<button id="tree-new-folder" title="New folder (use / to nest, e.g. Crypto/Alt)">${TREE_ICO.folderNew}<span>Folder</span></button>` +
    `<button id="tree-new-script" title="New Python strategy file, opens in the editor">${TREE_ICO.script}<span>Script</span></button>`;
  el.appendChild(bar);
  bar.querySelector("#tree-add-data").onclick = () => $("md-file").click();
  // One quiet line under the toolbar: the folder this library lives in on
  // this PC (workspace/ and data/ sit inside it). The display abbreviates
  // the home dir to ~ so the tail never gets ellipsis-clipped in a narrow
  // sidebar; the click copies the FULL path.
  const home = (state.wsRoot || "").replace(/[\\/]workspace$/, "");
  if (home) {
    const p = document.createElement("div");
    p.className = "tree-path";
    p.title = "Open folder";
    const disp = home.replace(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+|\/home\/[^/]+|\/Users\/[^/]+)/, "~");
    p.textContent = "Saved in " + disp;
    // Click opens the folder in the OS file manager.
    // If the engine can't (hosted mode, old engine without the endpoint),
    // fall back to copying the path so the click is never a dead end.
    p.onclick = async () => {
      try {
        const r = await fetch("/api/reveal", { method: "POST" });
        if (r.ok) return;
      } catch (e) { /* fall through to copy */ }
      try { navigator.clipboard.writeText(home); status("path copied"); }
      catch (e) { status(home); }
    };
    el.appendChild(p);
  }
  bar.querySelector("#tree-new-folder").onclick = async () => {
    // Ask where the folder goes: this button used to
    // silently target DATA, which read as "why did my folder land there".
    // The inline row carries a Workspace/Data toggle and physically moves
    // under the chosen section header, so the destination is visible
    // before the name is committed. Section headers always render when the
    // library is non-empty; on an empty library both anchors are null and
    // the row just sits at the end, the toggle still decides the backend.
    const wsHead = el.querySelector('.tree-section[data-sec="ws"]');
    const dataHead = el.querySelector('.tree-section[data-sec="data"]');
    const res = await treeInlineInput({
      parent: el, before: wsHead ? wsHead.nextSibling : null, folder: true,
      sections: [
        { sec: "ws", label: "Workspace",
          parent: el, before: wsHead ? wsHead.nextSibling : null },
        { sec: "data", label: "Data",
          parent: el, before: dataHead ? dataHead.nextSibling : null },
      ],
    });
    if (!res) return;
    if (res.sec === "data") {
      await fetch("/api/data/folders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: res.name }),
      });
      await refreshLibraryAll();
    } else {
      // Same local-until-first-file model as the WORKSPACE header's +.
      const clean = res.name.replace(/^\/+|\/+$/g, "");
      if (!clean) return;
      wsExtraSave([...wsExtraDirs(), clean]);
      renderDataSidebar();
      repaintLibraryTrees();
    }
  };
  bar.querySelector("#tree-new-script").onclick = async () => {
    // In the WORKSPACE tab a new file belongs to the wsx editor session;
    // everywhere else the file opens in the Algo Development editor.
    if (ctx === "wsx") { wsxNewFile(); return; }
    const head = el.querySelector('.tree-section[data-sec="ws"]');
    // Empty input, VS Code exact (no prefilled name).
    // Typing a bare name still gets .py because this button IS "Script".
    const name = await treeInlineInput({
      parent: el, before: head ? head.nextSibling : null,
    });
    if (!name) return;
    await openScriptInIDE(null);
    // Empty file, VS Code exact (no starter template; the
    // assistant panel already explains df/trades, the boilerplate was noise).
    await pyCreateFile(name.split("/").pop().includes(".") ? name : name + ".py", "");
    await refreshLibraryAll();
  };
  // LIBRARY head is also a drop target for "move to top level"
  makeDropTarget(head, "");

  if (!list.length && !(state.folderList || []).length && !(state.wsFiles || []).length) {
    const empty = document.createElement("div");
    empty.className = "empty-actions";
    empty.innerHTML = '<div class="md-empty">Library is empty. Pull history ' +
      'from the LSE databank, import a data file, or start a strategy script.</div>' +
      '<button id="empty-lse">Import via LSE Data</button>' +
      '<button id="empty-data">Upload a data file</button>' +
      '<button id="empty-folder2">New folder</button>' +
      '<button id="empty-script">New script</button>';
    el.appendChild(empty);
    empty.querySelector("#empty-lse").onclick = () => openLsbModal();
    empty.querySelector("#empty-data").onclick = () =>
      bar.querySelector("#tree-add-data").click();
    empty.querySelector("#empty-folder2").onclick = () =>
      bar.querySelector("#tree-new-folder").click();
    empty.querySelector("#empty-script").onclick = () =>
      bar.querySelector("#tree-new-script").click();
    return;
  }

  // Tree from BOTH dataset folder paths and explicitly created folders,
  // so empty folders exist the way an editor's explorer expects.
  state.dataTreeOpen = state.dataTreeOpen || {};
  const root = { folders: new Map(), items: [] };
  const nodeFor = (path) => {
    let node = root;
    for (const seg of path.split("/").filter(Boolean)) {
      if (!node.folders.has(seg)) node.folders.set(seg, { folders: new Map(), items: [] });
      node = node.folders.get(seg);
    }
    return node;
  };
  for (const f of state.folderList || []) nodeFor(f);
  for (const d of list) nodeFor(d.folder || "").items.push(d);

  const renderNode = (node, depth, pathPrefix) => {
    for (const name of [...node.folders.keys()].sort()) {
      const path = pathPrefix ? pathPrefix + "/" + name : name;
      const open = state.dataTreeOpen[path] !== false;
      const row = document.createElement("div");
      row.className = "tree-row tree-folder";
      row.style.paddingLeft = 8 + depth * 14 + "px";
      // VS Code folders: chevron + Material folder glyph + name.
      row.innerHTML = `<span class="tree-chevron${open ? " open" : ""}">&#9656;</span>` +
        `<span class="tree-ico">${libFolderIcon(name, open)}</span>` +
        `<span class="tree-name">${name}</span>` +
        `<span class="md-actions">` +
        `<button class="fl-add" data-path="${path}" title="Add data into this folder"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 11V3.5"/><path d="M5.2 6 8 3.2 10.8 6"/><path d="M3 12.8h10"/></svg></button>` +
        `<button class="fl-ren" data-path="${path}" title="Rename folder">&#9998;</button>` +
        `<button class="fl-del" data-path="${path}" title="Delete folder (contents move up)">&#10005;</button></span>`;
      row.onclick = (e) => {
        if (e.target.closest("button")) return;
        state.dataTreeOpen[path] = !open;
        renderLibraryTree(el, ctx);
      };
      makeDropTarget(row, path);
      // Right-click: the VS Code way to reach every folder operation.
      row.oncontextmenu = (e) => treeMenu(e, [
        { label: "New Folder", fn: () => dataNewSubfolder(path, row) },
        { label: "Add Data", fn: () => { importTargetFolder = path; $("md-file").click(); } },
        "-",
        { label: "Rename", fn: () => dataFolderRename(path, row) },
        { label: "Delete", danger: true, fn: () => dataFolderDelete(path) },
      ]);
      el.appendChild(row);
      if (open) renderNode(node.folders.get(name), depth + 1, path);
    }
    for (const d of node.items.sort((a, b) => (a.name || a.symbol).localeCompare(b.name || b.symbol))) {
      const series = (d.kind || "ohlcv") === "series";
      const row = document.createElement("div");
      // "Active" mirrors VS Code: a row lights
      // only while its TAB is the active one (data preview tab in the
      // Python IDE, charted symbol elsewhere). The backtest-dataset pick
      // is announced by the toolbar's "on <dataset>" label alone; a second
      // lit row read as two files being open.
      const active = ctx === "py" ? ("data:" + d.symbol) === py.active
        : ctx === "wsx" ? false : d.symbol === state.symbol;
      row.className = "tree-row" + (active ? " active" : "");
      row.style.paddingLeft = 8 + depth * 14 + 15 + "px";
      row.draggable = true;
      row.dataset.sym = d.symbol;
      row.ondragstart = (e) => {
        e.dataTransfer.setData("application/x-lse-dataset", d.symbol);
        e.dataTransfer.effectAllowed = "move";
      };
      // Single VS Code line: type icon, filename, then the manifest facts
      // (tf, size) right-aligned and dim. Everything else is tooltip.
      const meta = series
        ? (d.rows ? fmtCount(d.rows) + " rows" : "")
        : [d.timeframe, d.rows ? fmtCount(d.rows) : ""].filter(Boolean).join(" · ");
      row.title = [
        d.name && d.name !== d.symbol ? `${d.name} (${d.symbol})` : d.symbol,
        series ? `columns: ${(d.columns || []).join(", ")}` : `${d.timeframe || "?"} candles`,
        d.rows ? `${d.rows.toLocaleString()} ${series ? "rows" : "bars"}` : "",
        d.first_ts && d.last_ts ? `${isoDay(d.first_ts)} to ${isoDay(d.last_ts)}` : "",
        d.imported_at ? `imported ${isoDay(d.imported_at)}` : "",
        ctx === "py" ? "click: use as the backtest dataset"
          : ctx === "wsx" ? "click: copy a load_data() snippet"
          : series ? "" : "click: chart it",
      ].filter(Boolean).join("\n");
      row.innerHTML =
        `<span class="tree-ico">${series ? FILE_ICO.series : libFileIcon(d.file || d.symbol + (d.ext || ".csv"))}</span>` +
        `<span class="tree-name">${mlEsc(d.name || d.symbol)}<span class="tree-ext">${d.ext || ".csv"}</span></span>` +
        (meta ? `<span class="tree-meta">${mlEsc(meta)}</span>` : "") +
        `<span class="md-actions">` +
        `<button class="ds-ren" data-sym="${d.symbol}" title="Rename">&#9998;</button>` +
        `<button class="md-del" data-sym="${d.symbol}" title="Delete">&#10005;</button></span>`;
      row.onclick = (e) => {
        if (e.target.closest("button")) return;
        if (ctx === "wsx") {
          // The WORKSPACE editor has no chart surface; hand the file to the
          // session as code (the old MY DATA list's behavior).
          // Plain pandas: the terminal injects `df` for a backtest, but a
          // scratch script in the WORKSPACE editor loads the file itself.
          const snippet = `import pandas as pd\n` +
                          `df = pd.read_csv("${d.symbol}")`;
          try { navigator.clipboard.writeText(snippet); status("read_csv snippet copied"); }
          catch (err) { status(snippet); }
        } else if (series) {
          const useName = d.symbol.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
          status(`in a strategy: use ${useName} then ${useName}.${(d.columns || ["value"])[0]}`);
        } else if (ctx === "py") {
          // In the Python IDE a data file click answers "backtest on what?"
          // and shows the file itself (columns + a 100-row sample). If the
          // open strategy carries a `# run:` pin, the click retargets the
          // pin itself (visibly, in the code), keeping the file the only
          // authority on what RUN uses.
          pyRepin(d.symbol);
          pySetDataset(d.symbol);
          status(`backtest dataset: ${d.symbol}`);
          pyShowPreview(d);
        } else {
          // Outside the IDE (notebook rail, MY DATA, the ML and manual
          // pages) there is no chart of user files on screen any more
          // (BACKTEST > CHARTS was removed), so the click takes the
          // file to Algo Development as the pinned dataset, the same thing
          // a click means inside the IDE. User files never chart under
          // MARKETS (live data only).
          openBacktestDataset(d.symbol);
        }
      };
      row.oncontextmenu = (e) => treeMenu(e, [
        { label: "Rename", fn: () => datasetRename(d.symbol, row) },
        { label: "Delete", danger: true, fn: () => datasetDelete(d.symbol) },
      ]);
      el.appendChild(row);
    }
  };
  // Two labeled groups so data files and workspace files never read as one
  // undifferentiated list. WORKSPACE renders first: the code you are
  // working on sits above the data it runs on.
  // Workspace files are nested the way the editor explorers show them, so
  // all surfaces share one tree shape. Folder fold state lives in
  // wsx.closedDirs, shared with the editor so folds follow the user around.
  const wsFiles = state.wsFiles || [];
  // Section headers always render, each with a +:
  // the header + makes a folder in that domain, a folder's + makes files.
  // Headers only, no description rows: the per-section blurbs shipped
  // earlier were cut as filler.
  const section = (label, count, sec, addTitle) => {
    const lab = document.createElement("div");
    lab.className = "tree-section";
    // data-sec on the header itself so inline creation knows where to
    // slot its input row (right under the owning section).
    lab.dataset.sec = sec;
    lab.innerHTML = `${label}<span class="tree-count">${count}</span>` +
      `<button class="sec-add" data-sec="${sec}" title="${addTitle}">+</button>`;
    el.appendChild(lab);
  };
  {
    section("WORKSPACE", wsFiles.length, "ws", "New folder in the workspace");
    const runs = btRunStats();
    // The explorer highlights the ACTIVE TAB's file (VS Code), so a script
    // row only lights while a script tab is active.
    const activePath = ctx === "wsx" ? wsx.open
      : (py.active && !String(py.active).startsWith("data:") ? py.active : null);
    // Locally-created empty folders: the workspace API only knows folders
    // through file paths, so a fresh folder lives in localStorage until its
    // first file makes it real (then it prunes itself here).
    const extras = wsExtraDirs().filter((e) =>
      !wsFiles.some((f) => f.path.startsWith(e + "/")));
    wsExtraSave(extras);
    const renderWs = (prefix, depth) => {
      const here = wsFiles.filter((f) => f.path.startsWith(prefix));
      const dirs = new Set(), files = [];
      for (const f of here) {
        const rest = f.path.slice(prefix.length);
        const cut = rest.indexOf("/");
        if (cut === -1) files.push(f);
        else dirs.add(rest.slice(0, cut));
      }
      for (const e of extras) {
        if (!e.startsWith(prefix) || e === prefix.slice(0, -1)) continue;
        const rest = e.slice(prefix.length);
        if (!rest) continue;
        const cut = rest.indexOf("/");
        dirs.add(cut === -1 ? rest : rest.slice(0, cut));
      }
      for (const dname of [...dirs].sort()) {
        const dirPath = prefix + dname;
        const closed = !!wsx.closedDirs[dirPath];
        const row = document.createElement("div");
        row.className = "tree-row tree-folder";
        row.style.paddingLeft = 8 + depth * 14 + "px";
        row.innerHTML = `<span class="tree-chevron${closed ? "" : " open"}">&#9656;</span>` +
          `<span class="tree-ico">${libFolderIcon(dname, !closed)}</span>` +
          `<span class="tree-name">${mlEsc(dname)}</span>` +
          `<span class="md-actions">` +
          // VS Code hover pair: new-file + new-folder icons on every folder
          // row (the lone "+" hid folder creation behind
          // right-click; nesting folders must be one visible click).
          `<button class="ws-new" data-dir="${mlEsc(dirPath)}" title="New file in ${mlEsc(dname)}"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13"/><path d="M8 7.5v4M6 9.5h4"/></svg></button>` +
          `<button class="ws-newdir" data-dir="${mlEsc(dirPath)}" title="New folder in ${mlEsc(dname)}"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M8 8.5v3.4M6.3 10.2h3.4"/></svg></button></span>`;
        row.onclick = (e) => {
          if (e.target.closest("button")) return;
          wsx.closedDirs[dirPath] = !closed;
          renderLibraryTree(el, ctx);
        };
        // Right-click: workspace folders had NO rename/delete before this
        // menu existed (the row only carried a + button).
        row.oncontextmenu = (e) => treeMenu(e, [
          { label: "New File", fn: () => libNewWsFile(dirPath, ctx, row) },
          { label: "New Folder", fn: () => wsNewSubfolder(dirPath, row) },
          "-",
          { label: "Rename", fn: () => wsFolderRename(dirPath, row) },
          { label: "Delete", danger: true, fn: () => wsFolderDelete(dirPath) },
        ]);
        el.appendChild(row);
        if (!closed) renderWs(dirPath + "/", depth + 1);
      }
      for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
        const fname = f.path.slice(prefix.length);
        const isPy = f.path.endsWith(".py");
        const r = isPy ? runs[f.path] : null;
        const run = r && typeof r.net === "number" ? r : null;
        const row = document.createElement("div");
        row.className = "tree-row tree-script" + (f.path === activePath ? " active" : "");
        row.style.paddingLeft = 8 + depth * 14 + 15 + "px";
        row.innerHTML =
          `<span class="tree-ico">${libFileIcon(f.path)}</span>` +
          `<span class="tree-name" title="${mlEsc(f.path)}">${mlEsc(fname)}</span>` +
          (run ? `<span class="bt-chip ${run.net >= 0 ? "pos" : "neg"}" ` +
            `title="last backtest: ${run.trades} trades, net ${run.net.toFixed(2)}">` +
            `${run.net >= 0 ? "+" : ""}${fmtCount(Math.round(run.net))}</span>` : "") +
          `<span class="md-actions">` +
          `<button class="ws-ren" data-path="${mlEsc(f.path)}" title="Rename">&#9998;</button>` +
          `<button class="ws-del" data-path="${mlEsc(f.path)}" title="Delete">&#10005;</button></span>`;
        row.onclick = (e) => {
          if (e.target.closest("button")) return;
          if (ctx === "wsx") wsxOpen(f.path);
          else if (ctx === "py") pyOpen(f.path);
          else openScriptInIDE(f.path);
        };
        row.oncontextmenu = (e) => treeMenu(e, [
          { label: "Rename", fn: () => wsFileRename(f.path, row) },
          { label: "Delete", danger: true, fn: () => wsFileDelete(f.path) },
        ]);
        el.appendChild(row);
      }
    };
    renderWs("", 0);
  }
  section("DATA", list.length, "data", "New data folder");
  renderNode(root, 0, "");
  // NOTEBOOKS under WORKSPACE and DATA: the canvases
  // belong to the same library, so they are reachable from every copy of
  // this tree, not only from the WORKSPACE > NOTEBOOKS tab. Rows open the
  // notebook in that tab; the header + makes a new one there. Rename and
  // delete stay in the notebook page's own rail, which already has them.
  // ctx "nb" is that rail's own embedded copy: the island lists notebooks
  // right above this tree, so the section would be a duplicate there.
  if (ctx !== "nb") {
    const nbs = state.nbList || [];
    section("NOTEBOOKS", nbs.length, "nb", "New notebook");
    for (const nb of nbs) {
      const row = document.createElement("div");
      row.className = "tree-row tree-script";
      row.style.paddingLeft = 8 + 15 + "px";
      row.innerHTML = `<span class="tree-ico">${TREE_ICO.notebook}</span>` +
        `<span class="tree-name" title="${mlEsc(nb.name)}">${mlEsc(nb.name)}</span>`;
      row.onclick = () => openNotebookById(nb.id);
      el.appendChild(row);
    }
  }
  wireDatasetButtons();
}

/* The notebooks island rebroadcasts its list on every load and save; mirror
   it into the shared store and repaint the live trees, so the NOTEBOOKS
   section tracks creations, renames and deletions made on the notebook page
   without a poll. Repainting hidden hosts is the established cheap idiom
   (see refreshLibraryAll). */
window.addEventListener("lse-nb-list", (e) => {
  const next = Array.isArray(e.detail) ? e.detail : [];
  if (JSON.stringify(next) === JSON.stringify(state.nbList || [])) return;
  state.nbList = next;
  renderDataSidebar();
  repaintLibraryTrees();
});

/* Locally-created empty workspace folders (header +). The ws-files API has
   no mkdir; a folder becomes real when its first file is written, so until
   then the name lives here. */
function wsExtraDirs() {
  try { return JSON.parse(localStorage.getItem("lse.wsExtraDirs") || "[]"); }
  catch (e) { return []; }
}
function wsExtraSave(list) {
  try { localStorage.setItem("lse.wsExtraDirs", JSON.stringify([...new Set(list)])); }
  catch (e) { /* optional */ }
}

/* Context-menu "New Folder" inside an existing folder: inline input nested
   one level under the parent row. */
async function wsNewSubfolder(dirPath, row) {
  const name = await treeInlineInput({
    parent: row.parentElement, before: row.nextSibling, folder: true,
    padLeft: (parseInt(row.style.paddingLeft, 10) || 8) + 14 + "px",
  });
  if (!name) return;
  const clean = (dirPath + "/" + name).replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  wsExtraSave([...wsExtraDirs(), clean]);
  renderDataSidebar();
  repaintLibraryTrees();
}

async function dataNewSubfolder(path, row) {
  const name = await treeInlineInput({
    parent: row.parentElement, before: row.nextSibling, folder: true,
    padLeft: (parseInt(row.style.paddingLeft, 10) || 8) + 14 + "px",
  });
  if (!name) return;
  await fetch("/api/data/folders", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: path + "/" + name }),
  });
  await refreshLibraryAll();
}

/* VS Code-style inline naming. Creation and rename happen in an input row
   INSIDE the explorer tree, exactly where the file/folder will appear, not
   in a modal (a popup dialog reads as alien next to the
   VS Code-shaped tree). Enter commits, Escape cancels; clicking away
   commits only if the user actually typed something different from the
   prefill, so a stray click never creates the placeholder name.
   opts: parent + before (DOM placement), folder (folder look vs file look),
   depth or padLeft (indent), value / placeholder, selectStem (preselect the
   basename without extension, VS Code rename behavior),
   sections (optional destination toggle: [{sec, label, parent, before}],
   first entry preselected; picking one moves the row to that placement).
   Resolves the trimmed name, or null on cancel; with sections it resolves
   {name, sec} instead. */
function treeInlineInput(opts) {
  return new Promise((resolve) => {
    const row = document.createElement("div");
    row.className = "tree-row tree-inline";
    row.style.paddingLeft = opts.padLeft ||
      (8 + (opts.depth || 0) * 14 + (opts.folder ? 0 : 15) + "px");
    if (opts.folder) {
      const chev = document.createElement("span");
      chev.className = "tree-chevron";
      chev.innerHTML = "&#9656;";
      row.appendChild(chev);
    }
    const ico = document.createElement("span");
    ico.className = "tree-ico";
    const input = document.createElement("input");
    input.className = "tree-inline-input";
    input.spellcheck = false;
    input.value = opts.value || "";
    if (opts.placeholder) input.placeholder = opts.placeholder;
    // The icon tracks the typed extension live, like VS Code's input row:
    // generic grey doc until an extension appears, never a guessed type.
    const setIco = () => {
      ico.innerHTML = opts.folder ? libFolderIcon(input.value || "f", false)
        : libFileIcon(input.value);
    };
    setIco();
    input.oninput = setIco;
    row.appendChild(ico);
    row.appendChild(input);
    let chosen = opts.sections ? opts.sections[0].sec : null;
    if (opts.sections) {
      const secWrap = document.createElement("span");
      secWrap.className = "tree-inline-secs";
      for (const s of opts.sections) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tree-inline-sec" + (s.sec === chosen ? " on" : "");
        b.textContent = s.label;
        // mousedown, not click: a click would blur the input first, and
        // the blur handler would settle the promise before the choice
        // ever registered.
        b.onmousedown = (e) => {
          e.preventDefault();
          chosen = s.sec;
          for (const c of secWrap.children) c.classList.toggle("on", c === b);
          // Move the row under the chosen section header, so the user
          // sees exactly where the folder will appear before committing.
          s.parent.insertBefore(row, s.before || null);
          row.scrollIntoView({ block: "nearest" });
          input.focus();
        };
        secWrap.appendChild(b);
      }
      row.appendChild(secWrap);
    }
    opts.parent.insertBefore(row, opts.before || null);
    const initial = input.value;
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      row.remove();
      const name = v && v.trim() ? v.trim() : null;
      resolve(!name ? null : opts.sections ? { name, sec: chosen } : name);
    };
    input.onkeydown = (e) => {
      // Never let Enter/Escape reach the app's global hotkeys.
      e.stopPropagation();
      if (e.key === "Enter") finish(input.value);
      if (e.key === "Escape") finish(null);
    };
    input.onblur = () => finish(input.value !== initial ? input.value : null);
    input.focus();
    if (opts.selectStem) {
      const cut = initial.lastIndexOf("/") + 1;
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(cut, dot > cut ? dot : initial.length);
    } else {
      input.select();
    }
    row.scrollIntoView({ block: "nearest" });
  });
}

/* Inline rename of an existing tree row: the row itself turns into the
   input (hidden underneath), so the edit happens in place. */
function treeInlineEdit(row, value, folder) {
  row.style.display = "none";
  return treeInlineInput({
    parent: row.parentElement, before: row, padLeft: row.style.paddingLeft,
    value, folder, selectStem: !folder,
  }).then((v) => { row.style.display = ""; return v; });
}

/* New file inside a workspace folder (folder-row +). Opens in the editor
   that owns the surface the click came from. */
async function libNewWsFile(dir, ctx, anchorRow) {
  let name;
  if (anchorRow && anchorRow.parentElement) {
    // Inline input nested one level under the folder row that was clicked,
    // like VS Code's new-file box. The typed name is relative to that
    // folder; the folder prefix is implicit in where the input sits.
    const typed = await treeInlineInput({
      parent: anchorRow.parentElement, before: anchorRow.nextSibling,
      padLeft: (parseInt(anchorRow.style.paddingLeft, 10) || 8) + 29 + "px",
    });
    if (!typed) return;
    // Bare names still get .py: this workspace exists to hold strategies.
    name = (dir ? dir + "/" : "") +
      (typed.split("/").pop().includes(".") ? typed : typed + ".py");
  } else {
    name = await askText("New file (use / for folders)",
      (dir ? dir + "/" : "") + "my_strategy.py");
  }
  if (!name) return;
  // Empty file: no starter template, VS Code exact.
  const content = "";
  if (ctx === "wsx") {
    // Never silently clobber: an existing name gets a numbered sibling.
    let target = name;
    for (let n = 2; (state.wsFiles || []).some((f) => f.path === target); n += 1) {
      target = name.replace(/(\.\w+)?$/, `_${n}$1`);
    }
    const r = await fetch("/api/ws-files/write", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target, content }) });
    if (!r.ok) {
      let detail = r.status;
      try { detail = (await r.json()).detail || detail; } catch (e) { /* keep */ }
      status(`create failed: ${detail}`);
      return;
    }
    await refreshLibraryAll();
    await wsxOpen(target);
  } else if (ctx === "py") {
    await pyCreateFile(name, content);
  } else {
    await openScriptInIDE(null);
    await pyCreateFile(name, content);
  }
}

/* Workspace-file rename/delete shared by every library copy. Keeps both
   editors' state (open file, tabs, buffers) truthful about the move.
   Split into apply-cores (no prompts, no refresh) so the folder operations
   can loop them over many files with ONE question and ONE re-render. */
async function wsApplyRename(path, to) {
  const r = await fetch("/api/ws-files/rename", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, to }) });
  if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
  if (wsx.bufs[path]) { wsx.bufs[to] = wsx.bufs[path]; delete wsx.bufs[path]; }
  wsx.tabs = wsx.tabs.map((t) => (t === path ? to : t));
  if (wsx.open === path) wsx.open = to;
  if (py.open === path) py.open = to;
  py.tabs = py.tabs.map((t) => (t === path ? to : t));
  if (py.active === path) py.active = to;
}

async function wsApplyDelete(path) {
  await fetch("/api/ws-files/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }) });
  if (py.tabs.includes(path)) pyCloseTab(path);
  if (py.open === path) { py.open = null; pyIdeSetCode(""); }
  if (wsx.loaded) wsxCloseTab(path, true);
}

async function wsFileRename(path, row) {
  // In-place inline rename when the click came from a tree row; the full
  // path stays editable so a rename can also move the file.
  const to = row ? await treeInlineEdit(row, path, false)
    : await askText("Rename to", path);
  if (!to || to === path) return;
  try { await wsApplyRename(path, to); }
  catch (e) { status(`rename failed: ${e.message || e}`); return; }
  pyTabsSave();
  if (wsx.loaded) wsxRenderTabs();
  await refreshLibraryAll();
}

async function wsFileDelete(path) {
  if (!(await askConfirm(`Delete ${path}?`))) return;
  await wsApplyDelete(path);
  await refreshLibraryAll();
}

/* Workspace FOLDER rename/delete (context menu). The ws-files API only
   knows files, so both walk every file under the prefix. */
async function wsFolderRename(dirPath, row) {
  const to = row ? await treeInlineEdit(row, dirPath, true)
    : await askText("Rename folder", dirPath);
  if (!to || to === dirPath) return;
  const clean = to.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return;
  const moves = (state.wsFiles || []).filter((f) => f.path.startsWith(dirPath + "/"));
  try {
    for (const f of moves) {
      await wsApplyRename(f.path, clean + f.path.slice(dirPath.length));
    }
  } catch (e) { status(`rename failed: ${e.message || e}`); }
  wsExtraSave(wsExtraDirs().map((d) =>
    d === dirPath || d.startsWith(dirPath + "/") ? clean + d.slice(dirPath.length) : d));
  pyTabsSave();
  if (wsx.loaded) wsxRenderTabs();
  await refreshLibraryAll();
}

async function wsFolderDelete(dirPath) {
  const doomed = (state.wsFiles || []).filter((f) => f.path.startsWith(dirPath + "/"));
  const what = doomed.length
    ? `Delete ${dirPath} and its ${doomed.length} file(s)?` : `Delete ${dirPath}?`;
  if (!(await askConfirm(what))) return;
  for (const f of doomed) await wsApplyDelete(f.path);
  wsExtraSave(wsExtraDirs().filter((d) =>
    d !== dirPath && !d.startsWith(dirPath + "/")));
  await refreshLibraryAll();
}

/* Dataset + data-folder actions, shared by the hover buttons and the
   context menu. Deleting always confirms (the old hover X nuked a dataset
   with no question asked). */
async function datasetRename(sym, row) {
  const current = (state.datasetList || []).find((d) => d.symbol === sym);
  const name = row ? await treeInlineEdit(row, (current && current.name) || sym, false)
    : await askText("Rename dataset", (current && current.name) || sym);
  if (!name) return;
  await fetch(`/api/data/${encodeURIComponent(sym)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await refreshLibraryAll();
}

async function datasetDelete(sym) {
  if (!(await askConfirm(`Delete ${sym}?`))) return;
  await fetch(`/api/data/${encodeURIComponent(sym)}`, { method: "DELETE" });
  await refreshLibraryAll();
}

async function dataFolderRename(path, row) {
  const np = row ? await treeInlineEdit(row, path, true)
    : await askText("Rename folder", path);
  if (!np || np === path) return;
  await fetch("/api/data/folders", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, new_path: np }),
  });
  await refreshLibraryAll();
}

async function dataFolderDelete(path) {
  if (!(await askConfirm(`Delete folder "${path}"? Its datasets move up a level.`))) return;
  await fetch(`/api/data/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  await refreshLibraryAll();
}

/* VS Code-style right-click context menu for explorer rows. One menu at a
   time; a click anywhere else, Escape, or picking an item dismisses it.
   items: {label, fn, danger} or "-" for a separator. */
function treeMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const old = document.querySelector(".ctx-menu");
  if (old) old.remove();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  const onDown = (ev) => { if (!m.contains(ev.target)) close(); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  const close = () => {
    m.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
  for (const it of items) {
    if (it === "-") {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      m.appendChild(s);
      continue;
    }
    const r = document.createElement("div");
    r.className = "ctx-item" + (it.danger ? " danger" : "");
    r.textContent = it.label;
    r.onclick = () => { close(); it.fn(); };
    m.appendChild(r);
  }
  document.body.appendChild(m);
  // Clamp to the viewport so the menu never opens half off-screen.
  m.style.left = Math.min(e.clientX, window.innerWidth - m.offsetWidth - 4) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - m.offsetHeight - 4) + "px";
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
}

/* Explorer drag-and-drop: drop a dataset row on a folder row (or the
   LIBRARY head for top level) to move it. */
function makeDropTarget(elm, folderPath) {
  elm.ondragover = (e) => {
    if ([...e.dataTransfer.types].includes("application/x-lse-dataset")) {
      e.preventDefault();
      elm.classList.add("drop-hover");
    }
  };
  elm.ondragleave = () => elm.classList.remove("drop-hover");
  elm.ondrop = async (e) => {
    elm.classList.remove("drop-hover");
    const sym = e.dataTransfer.getData("application/x-lse-dataset");
    if (!sym) return;
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/data/${encodeURIComponent(sym)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folderPath }),
    });
    await refreshLibraryAll();
  };
}

function wireDatasetButtons() {
  for (const btn of document.querySelectorAll(".md-del")) {
    btn.onclick = () => datasetDelete(btn.dataset.sym);
  }
  for (const btn of document.querySelectorAll(".ws-ren")) {
    btn.onclick = () => wsFileRename(btn.dataset.path, btn.closest(".tree-row"));
  }
  for (const btn of document.querySelectorAll(".ws-del")) {
    btn.onclick = () => wsFileDelete(btn.dataset.path);
  }
  // Which editor owns a click depends on which copy of the tree it came
  // from: the WORKSPACE tab's explorer belongs to wsx, the sidebar to the
  // visible section.
  const ctxFor = (btn) => (btn.closest("#wsx-lib") ? "wsx" : libCtx());
  for (const btn of document.querySelectorAll(".ws-new")) {
    btn.onclick = () =>
      libNewWsFile(btn.dataset.dir, ctxFor(btn), btn.closest(".tree-row"));
  }
  for (const btn of document.querySelectorAll(".ws-newdir")) {
    btn.onclick = () =>
      wsNewSubfolder(btn.dataset.dir, btn.closest(".tree-row"));
  }
  for (const btn of document.querySelectorAll(".sec-add")) {
    btn.onclick = async () => {
      // The NOTEBOOKS + makes a notebook, not a folder: creation (and the
      // rename that follows) belongs to the notebook page's own rail.
      if (btn.dataset.sec === "nb") { openNotebookById("__new__"); return; }
      // Inline folder input right under the section header the + lives on.
      const lab = btn.closest(".tree-section");
      const name = await treeInlineInput({
        parent: lab.parentElement, before: lab.nextSibling, folder: true,
      });
      if (!name) return;
      if (btn.dataset.sec === "data") {
        await fetch("/api/data/folders", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: name }),
        });
        await refreshLibraryAll();
      } else {
        const clean = name.trim().replace(/^\/+|\/+$/g, "");
        if (!clean) return;
        wsExtraSave([...wsExtraDirs(), clean]);
        renderDataSidebar();
        repaintLibraryTrees();
      }
    };
  }
  for (const btn of document.querySelectorAll(".fl-add")) {
    btn.onclick = () => {
      importTargetFolder = btn.dataset.path;
      $("md-file").click();
    };
  }
  for (const btn of document.querySelectorAll(".ds-ren")) {
    btn.onclick = () => datasetRename(btn.dataset.sym, btn.closest(".tree-row"));
  }
  for (const btn of document.querySelectorAll(".fl-ren")) {
    btn.onclick = () => dataFolderRename(btn.dataset.path, btn.closest(".tree-row"));
  }
  for (const btn of document.querySelectorAll(".fl-del")) {
    btn.onclick = () => dataFolderDelete(btn.dataset.path);
  }
}

/* Alternative datasets attachable to a backtest run as `use` bindings. */
function renderDatasetAttach() {
  const series = (state.datasetList || []).filter((d) => (d.kind || "ohlcv") === "series");
  $("bt-datasets").innerHTML = series.length
    ? "Data: " + series.map((d) =>
        `<label class="bt-check"><input type="checkbox" class="bt-ds" value="${d.symbol}"> ${d.symbol}</label>`
      ).join(" ")
    : "";
}

function attachedDatasets() {
  return [...document.querySelectorAll(".bt-ds:checked")].map((c) => c.value);
}

/* VSCode-style instant import: a chosen or dropped file imports under its
   own file name immediately; rename/move happens in the library afterward. */
let importTargetFolder = "";

async function importFile(file) {
  $("md-err").classList.add("hidden");
  $("md-preview").classList.add("hidden");
  status(`importing ${file.name}…`);
  // multipart: works for ANY format (parquet/excel are binary); the engine's
  // decoder layer figures out what the file is.
  const form = new FormData();
  form.append("file", file);
  form.append("folder", importTargetFolder);
  const res = await fetch("/api/data/upload", { method: "POST", body: form });
  importTargetFolder = "";
  if (!res.ok) {
    let detail = res.status;
    try { detail = (await res.json()).detail || detail; } catch (e) { /* keep */ }
    status("import failed");
    return showMdError(String(detail));
  }
  const entry = await res.json();
  const kindLabel = entry.kind === "ohlcv"
    ? `${entry.timeframe || "?"} candles` : `alternative data (${(entry.columns || []).join(", ")})`;
  $("md-preview").textContent = `Imported ${entry.symbol}: ${entry.rows} rows, ${kindLabel}.`;
  $("md-preview").classList.remove("hidden");
  status(`imported ${entry.symbol}`);
  await refreshLibraryAll();
}

function setupMyData() {
  // Drag a CSV anywhere onto the terminal: instant import.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !/\.(csv|tsv|txt|parquet|pq|feather|xlsx|xls|json)$/i.test(f.name)) return;
    $("rail-data").click();
    await importFile(f);
  });
  // (no toolbar My Data button to wire: the MY DATA rail tab is the only door.)
  // Economic calendar: a React page mounted into its own section. MY DATA
  // stays the active rail tab because the calendar is one of its datasets.
  $("md-econcal").onclick = () => {
    $("mydata").classList.add("hidden");
    $("econcal").classList.remove("hidden");
    if (window.LSEEconCalendar) {
      window.LSEEconCalendar.mount($("econcal-root"), {
        onBack: () => {
          $("econcal").classList.add("hidden");
          $("mydata").classList.remove("hidden");
        },
      });
    }
  };
  fetch("/api/data/location").then((r) => r.json()).then((l) => {
    $("md-location").innerHTML =
      `Saved on this computer at <code>${l.path}</code> &middot; <a id="md-open-loc" href="#">open folder</a>`;
    $("md-open-loc").onclick = (e) => {
      e.preventDefault();
      fetch("/api/data/open-location", { method: "POST" });
    };
  }).catch(() => {});
  $("md-drop").onclick = () => $("md-file").click();
  $("md-file").onchange = async () => {
    const f = $("md-file").files[0];
    if (!f) return;
    await importFile(f);
    $("md-file").value = "";
  };
}

function showMdError(msg) {
  $("md-err").textContent = msg;
  $("md-err").classList.remove("hidden");
}

/* ---------- LSE databank import (library > Import via LSE) ----------
   Browse supported market candles and series, then download complete pages
   into the library. The modal shows the selection and import progress. */

const lsb = { meta: null, ref: [], usage: null, dataset: null, row: null,
              timer: null, seq: 0, tf: "1h", range: "max" };

// Range presets fill the date inputs so nobody types dd/mm/yyyy by hand.
// Day-based labels, not "1m/1w", so they can never be misread as the
// 1-minute/1-week TIMEFRAME chips sitting right above them.
const LSB_RANGES = [["max", "Max"], ["1y", "1y"], ["180d", "180d"],
                    ["90d", "90d"], ["30d", "30d"], ["7d", "7d"]];
const LSB_RANGE_DAYS = { "1y": 365, "180d": 180, "90d": 90, "30d": 30, "7d": 7 };

// Product names where the raw id reads wrong; everything else auto-humanizes.
const LSB_NAMES = {
  fx: "Forex", etf: "ETFs", index: "Indices", commodity: "Commodities",
  cot: "COT positioning", economics: "Economics",
  currency_index: "Currency index", fx_derivatives: "FX derivatives",
};
const lsbName = (id) => LSB_NAMES[id] ||
  (id.charAt(0).toUpperCase() + id.slice(1)).replace(/_/g, " ");
const lsbEsc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lsbFmtN = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(1) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n ?? "");
const lsbFmtB = (b) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB"
  : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB"
  : (b / 1024).toFixed(0) + " KB";
const lsbIsRef = (ds) => (lsb.meta?.reference || []).includes(ds);
const lsbIsCandle = (ds) => (lsb.meta?.candle_classes || []).includes(ds) ||
  (lsb.meta?.synth_candle_classes || []).includes(ds) || ds === "options";

async function openLsbModal() {
  $("lsb-modal").classList.remove("hidden");
  if (!lsb.meta) {
    let r;
    try { r = await fetch("/api/lse/databank"); } catch (e) { r = null; }
    if (!r || !r.ok) {
      $("lsb-body").classList.add("hidden");
      const hint = $("lsb-key-hint");
      hint.classList.remove("hidden");
      if (r && r.status !== 409 && r.status !== 404) {
        let detail = "";
        try { detail = (await r.json()).detail || ""; } catch (e) { /* keep */ }
        // The engine labels the error itself ("Databank: <service words>" for
        // a bad key or a quota, "Databank unreachable: ..." for transport
        // failures); only a body-less response needs a label here.
        hint.textContent = detail || `Databank unreachable (HTTP ${r.status})`;
      }
      return;
    }
    const d = await r.json();
    lsb.meta = d.meta || {};
    lsb.ref = d.reference || [];
    lsb.usage = d.usage;
    renderLsbSets();
    renderLsbQuota();
  }
  $("lsb-key-hint").classList.add("hidden");
  $("lsb-body").classList.remove("hidden");
  // Folder suggestions from the live folder list; default to an LSE folder
  // so pulls do not flood the library root.
  $("lsb-folders").innerHTML = (state.folderList || [])
    .map((f) => `<option value="${lsbEsc(f)}">`).join("");
  if (!$("lsb-folder").value) $("lsb-folder").value = "LSE";
  if (!lsb.dataset) {
    const first = (lsb.meta.candle_classes || [])[0];
    if (first) lsbPickSet(first);
  }
}

function renderLsbSets() {
  const el = $("lsb-sets");
  el.innerHTML = "";
  const m = lsb.meta;
  const groups = [
    ["MARKETS", [...(m.candle_classes || []), ...(m.synth_candle_classes || [])]],
    ["OPTIONS", (m.datasets || []).includes("options") ? ["options"] : []],
    ["SERIES", m.series_classes || []],
    ["REFERENCE", m.reference || []],
  ];
  for (const [title, ids] of groups) {
    if (!ids.length) continue;
    const head = document.createElement("div");
    head.className = "lsb-group";
    head.textContent = title;
    el.appendChild(head);
    for (const id of ids) {
      const row = document.createElement("div");
      row.className = "lsb-set";
      row.dataset.ds = id;
      const meta = lsb.ref.find((r) => r.dataset === id);
      row.innerHTML = `<span>${lsbEsc(lsbName(id))}</span>` +
        `<span>${meta ? lsbFmtN(meta.rows) : ""}</span>`;
      row.onclick = () => lsbPickSet(id);
      el.appendChild(row);
    }
  }
}

function renderLsbQuota() {
  const u = lsb.usage;
  if (!u || u.bytes_used_month == null) return;
  const cap = u.bytes_cap_month;
  $("lsb-quota").textContent = "Downloaded this month: " +
    lsbFmtB(u.bytes_used_month) +
    (cap > 0 ? " of " + lsbFmtB(cap) : "");
}

function lsbPickSet(ds) {
  lsb.dataset = ds;
  lsb.row = null;
  for (const n of document.querySelectorAll(".lsb-set"))
    n.classList.toggle("sel", n.dataset.ds === ds);
  $("lsb-search").value = "";
  // Timeframe applies to candle-capable classes only; series and reference
  // pulls are always the raw table.
  $("lsb-tf-wrap").style.display = lsbIsCandle(ds) ? "" : "none";
  if (lsbIsCandle(ds)) {
    const tfs = ds === "options" ? (lsb.meta.options_timeframes || [])
                                 : (lsb.meta.timeframes || []);
    const all = [...tfs];
    // The picked timeframe survives dataset hops when the new dataset offers
    // it; otherwise fall back to the 1h default.
    if (!all.includes(lsb.tf)) lsb.tf = all.includes("1h") ? "1h" : all[0];
    renderLsbTf(all);
  }
  lsbApplyBounds();
  lsbApplyRange();
  if (lsbIsRef(ds)) {
    const meta = lsb.ref.find((r) => r.dataset === ds);
    $("lsb-search").style.display = "none";
    $("lsb-list").innerHTML = `<div class="md-help" style="padding:8px">` +
      `One download, the whole dataset` +
      (meta ? `: ${lsbFmtN(meta.rows)} rows, ` +
        `${lsbEsc(String(meta.first).slice(0, 10))} to ` +
        `${lsbEsc(String(meta.last).slice(0, 10))}` : "") +
      `. Use the dates to cut it down.</div>`;
    setLsbDetail();
  } else {
    $("lsb-search").style.display = "";
    lsbSearchNow();
  }
}

/* The logo map for the databank list: the live LSE map when LSE is the
   active source, else the session's LSE fallback map (loaded once; the
   list redraws when it arrives while the modal is open). */
function lsbLogoMap() {
  if (state.provider === "lse" && state.logos && Object.keys(state.logos).length) return state.logos;
  if (state.logoFallback === null) {
    loadLogoFallback().then(() => {
      const modal = $("lsb-modal");
      if (modal && !modal.classList.contains("hidden")) lsbSearchNow();
    });
  }
  return state.logoFallback || {};
}

async function lsbSearchNow() {
  const seq = ++lsb.seq;
  const q = $("lsb-search").value.trim();
  const r = await fetch(`/api/lse/databank/catalog?dataset=` +
    `${encodeURIComponent(lsb.dataset)}&query=${encodeURIComponent(q)}&limit=400`);
  if (!r.ok || seq !== lsb.seq) return;
  const d = await r.json();
  const el = $("lsb-list");
  el.innerHTML = "";
  // Instrument art on every row, the same .wlogo tile
  // the watchlist and the ticket use: art from the LSE map (the databank is
  // the LSE symbol space), a monogram while it loads or when there is none
  // (series, bonds, options). The map is fetched once per session; when it
  // lands after this render the list redraws once.
  const logos = lsbLogoMap();
  const dark = document.documentElement.classList.contains("dark");
  for (const row of d.rows) {
    const n = document.createElement("div");
    n.className = "lsb-row";
    const lg = logos[row.symbol];
    const lsrc = lg ? String(dark ? lg.dark : lg.light).replace(/"/g, "&quot;") : "";
    n.innerHTML = `<span class="wlogo">` +
      (lsrc ? `<img src="${lsrc}" alt="" loading="lazy" onerror="this.remove()">` : "") +
      `<span class="winit">${logoInitial(row)}</span></span>` +
      `<span class="sym">${lsbEsc(row.symbol)}</span>` +
      `<span class="nm">${lsbEsc(row.name)}</span>` +
      `<span class="span">${row.years ? row.years + "y" : ""}</span>`;
    n.onclick = () => {
      lsb.row = row;
      for (const x of el.children) x.classList.toggle("sel", x === n);
      // Re-anchor the date presets to THIS instrument's coverage: "30d" means
      // its last recorded month, not the calendar's, so stale symbols still
      // pull data.
      lsbApplyBounds();
      lsbApplyRange();
      setLsbDetail();
    };
    el.appendChild(n);
  }
  if (d.rows.length < d.total) {
    const more = document.createElement("div");
    more.className = "md-help";
    more.style.padding = "6px 8px";
    more.textContent = `${d.rows.length} of ${d.total} shown; search to narrow.`;
    el.appendChild(more);
  }
  setLsbDetail();
}

function renderLsbTf(tfs) {
  const el = $("lsb-tf");
  el.innerHTML = "";
  for (const t of tfs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lsb-chip" + (t === lsb.tf ? " sel" : "");
    b.textContent = t;
    b.onclick = () => {
      lsb.tf = t;
      for (const x of el.children) x.classList.toggle("sel", x === b);
      setLsbDetail();
    };
    el.appendChild(b);
  }
}

function renderLsbRange() {
  const el = $("lsb-range");
  el.innerHTML = "";
  for (const [key, label] of LSB_RANGES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lsb-chip";
    b.dataset.r = key;
    b.textContent = label;
    b.onclick = () => {
      lsb.range = key;
      lsbApplyRange();
    };
    el.appendChild(b);
  }
}

// Bound the date pickers to the selection's real coverage so the calendar
// cannot offer days that have no data. Reference datasets carry their span in
// the /reference stats; instruments carry first_tick/last_tick.
function lsbApplyBounds() {
  const s = $("lsb-start"), e = $("lsb-end");
  let first = "", last = "";
  if (lsbIsRef(lsb.dataset)) {
    const m = lsb.ref.find((r) => r.dataset === lsb.dataset);
    first = m ? m.first : "";
    last = m ? m.last : "";
  } else if (lsb.row) {
    first = lsb.row.first_tick;
    last = lsb.row.last_tick;
  }
  const cut = (v) => (v ? String(v).slice(0, 10) : "");
  s.min = e.min = cut(first);
  s.max = e.max = cut(last);
}

function lsbApplyRange() {
  if (lsb.range) {
    const s = $("lsb-start"), e = $("lsb-end");
    if (lsb.range === "max") {
      s.value = e.value = ""; // empty dates = all history available at this interval
    } else {
      // Anchor to the selection's last data day when known, else today.
      const anchor = s.max ? new Date(s.max + "T00:00:00Z") : new Date();
      const from = new Date(anchor.getTime() -
        LSB_RANGE_DAYS[lsb.range] * 86400000);
      s.value = from.toISOString().slice(0, 10);
      e.value = ""; // open end = through the latest recorded day
    }
  }
  for (const n of $("lsb-range").children)
    n.classList.toggle("sel", n.dataset.r === lsb.range);
}

function setLsbDetail() {
  const info = $("lsb-info");
  const ready = lsbIsRef(lsb.dataset) || !!lsb.row;
  $("lsb-go").disabled = !ready;
  if (lsbIsRef(lsb.dataset)) {
    info.textContent = lsbName(lsb.dataset) +
      ": the full reference table as one file.";
  } else if (lsb.row) {
    const r = lsb.row;
    info.textContent = `${r.symbol}  ${r.name || ""}\n` +
      (r.ticks ? `${lsbFmtN(r.ticks)} recorded rows` : "") +
      (r.first_tick ? `, ${String(r.first_tick).slice(0, 10)} to ` +
        `${String(r.last_tick).slice(0, 10)}` : "") +
      "\nAvailability depends on the selected interval and your key. The To date includes that day.";
  } else {
    info.textContent = "Pick an instrument to see its history span.";
  }
}

function lsbWatch(jobId) {
  clearInterval(lsb.timer);
  const st = $("lsb-status");
  st.classList.remove("hidden", "err");
  st.textContent = "Reading available data";
  lsb.timer = setInterval(async () => {
    let job;
    try {
      const r = await fetch(`/api/lse/databank/import/${jobId}`);
      if (!r.ok) return;
      job = await r.json();
    } catch (e) { return; }
    if (job.status === "exporting" || job.status === "importing") {
      st.textContent = job.detail || job.status;
      return;
    }
    clearInterval(lsb.timer);
    $("lsb-go").disabled = false;
    if (job.status === "done") {
      st.textContent = `Imported ${job.entry.symbol}: ` +
        `${lsbFmtN(job.entry.rows)} rows` +
        (job.file_bytes ? ` (${lsbFmtB(job.file_bytes)} stored)` : "") + ".";
      status(`imported ${job.entry.symbol} from LSE`);
      await refreshLibraryAll();
    } else if (job.status === "saved") {
      st.textContent = `Saved as a file: ${job.path}\n(Not chartable as ` +
        `candles/series, so it stays Parquet. Open it from MY DATA's folder.)`;
      status("LSE download saved");
    } else {
      st.classList.add("err");
      st.textContent = "Import failed: " + (job.error || "unknown error");
    }
  }, 1200);
}

function setupLsbModal() {
  $("lsb-close").onclick = () => $("lsb-modal").classList.add("hidden");
  $("lsb-modal").onclick = (e) => {
    if (e.target === $("lsb-modal")) $("lsb-modal").classList.add("hidden");
  };
  let deb;
  $("lsb-search").oninput = () => {
    clearTimeout(deb);
    deb = setTimeout(lsbSearchNow, 180);
  };
  renderLsbRange();
  lsbApplyRange();
  // Touching a date by hand means a custom range: drop the chip selection and
  // stop re-anchoring on the next instrument pick.
  $("lsb-start").oninput = $("lsb-end").oninput = () => {
    lsb.range = null;
    for (const n of $("lsb-range").children) n.classList.remove("sel");
  };
  $("lsb-go").onclick = async () => {
    const body = {
      dataset: lsb.dataset,
      symbol: lsbIsRef(lsb.dataset) ? "" : (lsb.row && lsb.row.symbol) || "",
      timeframe: lsbIsCandle(lsb.dataset) ? lsb.tf : "1h",
      start: $("lsb-start").value, end: $("lsb-end").value,
      folder: $("lsb-folder").value.trim(),
    };
    $("lsb-go").disabled = true;
    const r = await fetch("/api/lse/databank/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = String(r.status);
      try { detail = (await r.json()).detail || detail; } catch (e) { /* keep */ }
      const st = $("lsb-status");
      st.classList.remove("hidden");
      st.classList.add("err");
      st.textContent = "Request failed: " + detail;
      $("lsb-go").disabled = false;
      return;
    }
    lsbWatch((await r.json()).job_id);
  };
}

/* ---------- user indicator editor ---------- */

const editor = { file: null, gutterLines: 0 };

/* Same two-layer highlighting as the workspace IDE / strategy editor
   (pyTokenHTML backdrop under a transparent-text textarea + line gutter).
   The Python tokenizer also colours .brue sources: comments, strings,
   numbers and calls are the same shapes, so the picker scripts read in
   the same palette as everything else. */
function edHighlight() {
  const src = $("ed-src").value;
  $("ed-hl-code").innerHTML = pyTokenHTML(src) + "\n";
  const lines = src.split("\n").length;
  if (editor.gutterLines !== lines) {
    editor.gutterLines = lines;
    let nums = "";
    for (let i = 1; i <= lines; i++) nums += `<div>${i}</div>`;
    $("ed-gutter").innerHTML = nums;
  }
  edSyncScroll();
}

function edSyncScroll() {
  const ta = $("ed-src"), hl = $("ed-hl");
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  $("ed-gutter").scrollTop = ta.scrollTop;
}

/* Every programmatic write goes through here so the backdrop can never
   disagree with the textarea. */
function edSetCode(code) {
  $("ed-src").value = code;
  edHighlight();
  // Every way code enters the editor (load, new, example) previews it.
  edSchedulePreview();
}

/* ----- live preview -----
   The draft runs on the charted symbol's candles ~0.7s after the last
   keystroke (POST /api/user-indicators/preview: nothing saved, picker
   untouched), so the author SEES the drawing before saving.
   Overlay output draws over candles, pane output in the strip
   below, the same split the real chart will use. On an error the message
   shows in the strip header and the last good drawing stays: a half-typed
   line must never blank the preview. */
function edSchedulePreview() {
  clearTimeout(editor.pvTimer);
  editor.pvTimer = setTimeout(edRunPreview, 700);
}

async function edRunPreview() {
  if ($("editor").classList.contains("hidden")) return;
  const msg = $("ed-pv-msg");
  if (!state.symbol || !state.provider) {
    msg.textContent = "chart a symbol first; the preview runs on its candles";
    return;
  }
  $("ed-pv-sym").textContent = `${state.symbol} ${state.timeframe}`;
  const seq = (editor.pvSeq = (editor.pvSeq || 0) + 1);
  let data;
  try {
    const r = await fetch("/api/user-indicators/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: $("ed-src").value,
        filename: $("ed-name").value.trim() || "preview.py",
        provider: state.provider, symbol: state.symbol,
        timeframe: state.timeframe, limit: 300,
      }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    if (seq === editor.pvSeq) msg.textContent = String(e.message || e);
    return;
  }
  if (seq !== editor.pvSeq) return; // superseded while typing continued
  msg.textContent = data.error || "";
  if (!Object.keys(data.indicators || {}).length) return; // keep last drawing
  edDrawPreview(data);
}

// Muted series palette: data ink, distinct without being loud.
const ED_PV_COLORS = ["#5b9bd5", "#d9a441", "#63b26a", "#b57bd5",
                      "#d16d6d", "#4fb3a9"];

function edDrawPreview(data) {
  // Rebuilt from scratch each run: at one render per typing pause this is
  // cheap and sidesteps all series bookkeeping.
  if (editor.pvPrice) { editor.pvPrice.remove(); editor.pvPrice = null; }
  if (editor.pvPane) { editor.pvPane.remove(); editor.pvPane = null; }
  const candles = data.candles.map((c) => ({
    time: c[0], open: c[1], high: c[2], low: c[3], close: c[4],
  }));
  const price = LightweightCharts.createChart($("ed-pv-price"), chartOpts());
  editor.pvPrice = price;
  price.addCandlestickSeries({
    upColor: "#26a69a", downColor: "#ef5350",
    wickUpColor: "#26a69a", wickDownColor: "#ef5350", borderVisible: false,
  }).setData(candles);
  let ci = 0;
  const paneSeries = [];
  for (const ind of Object.values(data.indicators)) {
    for (const [col, s] of Object.entries(ind.series)) {
      const pts = s.points.map((p) => ({ time: p[0], value: p[1] }));
      if (ind.overlay) {
        price.addLineSeries({
          color: ED_PV_COLORS[ci++ % ED_PV_COLORS.length], lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, title: col,
        }).setData(pts);
      } else {
        paneSeries.push({ col, s, pts });
      }
    }
  }
  // Unhide BEFORE creating the pane chart: autoSize needs a laid-out box.
  const paneEl = $("ed-pv-pane");
  paneEl.classList.toggle("hidden", !paneSeries.length);
  if (paneSeries.length) {
    const pane = LightweightCharts.createChart(paneEl, chartOpts());
    editor.pvPane = pane;
    for (const { col, s, pts } of paneSeries) {
      const opts = {
        color: ED_PV_COLORS[ci++ % ED_PV_COLORS.length],
        priceLineVisible: false, lastValueVisible: false, title: col,
      };
      (s.kind === "histogram" ? pane.addHistogramSeries(opts)
        : pane.addLineSeries({ ...opts, lineWidth: 1 })).setData(pts);
    }
    pane.timeScale().fitContent();
  }
  price.timeScale().fitContent();
}

// Starter files: complete, saveable sources that each teach one part of the
// contract (multi-line DataFrame, own pane, params form, styles hint, Brue).
// Loaded as UNSAVED drafts so trying one never overwrites a user's file.
const ED_EXAMPLES = [
  {
    file: "ema_cross.py", label: "EMA cross (two lines)",
    source: `"""Two EMAs on the price chart: a DataFrame return = one line per column."""

import pandas as pd

from lse_terminal import indicator


@indicator("ema_cross", title="EMA Cross",
           params={"fast": {"type": "int", "default": 9, "min": 1, "max": 200},
                   "slow": {"type": "int", "default": 21, "min": 2, "max": 500}})
def ema_cross(df, fast=9, slow=21):
    return pd.DataFrame({
        "fast": df["close"].ewm(span=fast, adjust=False).mean(),
        "slow": df["close"].ewm(span=slow, adjust=False).mean(),
    })
`,
  },
  {
    file: "my_rsi.py", label: "RSI (own pane)",
    source: `"""RSI from scratch. overlay=False gives the indicator its own pane."""

from lse_terminal import indicator


@indicator("my_rsi", title="My RSI", overlay=False,
           params={"length": {"type": "int", "default": 14, "min": 2, "max": 200}})
def my_rsi(df, length=14):
    delta = df["close"].diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / length, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / length, adjust=False).mean()
    return 100 - 100 / (1 + gain / loss)
`,
  },
  {
    file: "atr_bands.py", label: "ATR bands (high/low/close)",
    source: `"""Volatility bands: EMA middle, +/- ATR multiples above and below."""

import pandas as pd

from lse_terminal import indicator


@indicator("atr_bands", title="ATR Bands",
           params={"length": {"type": "int", "default": 20, "min": 2, "max": 200},
                   "mult": {"type": "float", "default": 2.0, "min": 0.5, "max": 10}})
def atr_bands(df, length=20, mult=2.0):
    mid = df["close"].ewm(span=length, adjust=False).mean()
    tr = pd.concat([df["high"] - df["low"],
                    (df["high"] - df["close"].shift()).abs(),
                    (df["low"] - df["close"].shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / length, adjust=False).mean()
    return pd.DataFrame({"upper": mid + mult * atr,
                         "middle": mid,
                         "lower": mid - mult * atr})
`,
  },
  {
    file: "vol_ratio.py", label: "Volume ratio (histogram)",
    source: `"""Volume vs its own average, drawn as a histogram via the styles= hint."""

from lse_terminal import indicator


@indicator("vol_ratio", title="Volume Ratio", overlay=False,
           styles={"vol_ratio": {"kind": "histogram"}},
           params={"length": {"type": "int", "default": 20, "min": 2, "max": 200}})
def vol_ratio(df, length=20):
    return df["volume"] / df["volume"].rolling(length).mean()
`,
  },
  {
    file: "brue_rsi.brue", label: "Brue script (RSI)",
    source: `# title: Brue RSI
# panel: below

# An indicator is a Brue script with no orders: every plot() becomes a
# chart line, the pragmas above set the picker name and where it draws.
plot(rsi(close, 14), title="rsi")
`,
  },
];

function openEditor() {
  $("editor").classList.remove("hidden");
  edRefreshList();
  // Never a blank page: an empty session opens on the template, ready to run.
  if (!editor.file && !$("ed-src").value.trim()) edNew("python");
  else edSchedulePreview();
  // The AI guides from the rail; make sure it is unfolded and on screen.
  const rail = document.getElementById("ai-rail");
  if (rail && rail.classList.contains("collapsed")) $("air-expand").click();
}

async function refreshSpecs() {
  state.indicatorSpecs = await fetch("/api/indicators").then((r) => r.json());
  renderIndicatorList();
  // Drop active indicators whose definition vanished (deleted/renamed).
  state.activeIndicators = state.activeIndicators.filter((i) =>
    state.indicatorSpecs.some((s) => s.name === i.name));
  renderActiveIndicators();
}

async function edRefreshList() {
  const items = await fetch("/api/user-indicators").then((r) => r.json());
  const list = $("ed-list");
  list.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "ed-item" + (it.file === editor.file ? " active" : "");
    row.innerHTML = `<span>${it.file}</span>` +
      (it.error ? `<span class="ed-broken" title="${it.error}">broken</span>`
                : `<span>${it.names.join(", ")}</span>`);
    row.onclick = () => edLoad(it.file);
    list.appendChild(row);
  }
}

async function edLoad(file) {
  const r = await fetch(`/api/user-indicators/${encodeURIComponent(file)}`);
  if (!r.ok) return;
  const body = await r.json();
  editor.file = file;
  $("ed-name").value = file;
  edSetCode(body.source);
  $("ed-err").classList.add("hidden");
  edRefreshList();
}

async function edNew(lang) {
  const t = await fetch("/api/user-indicators/template" +
    (lang === "brue" ? "?lang=brue" : "")).then((r) => r.json());
  editor.file = null;
  $("ed-name").value = lang === "brue" ? "my_indicator.brue" : "my_indicator.py";
  edSetCode(t.source);
  $("ed-err").classList.add("hidden");
  edRefreshList();
}

function setupEditor() {
  // Opened from the indicator browser's "create custom" row (the old
  // top-bar Edit button is gone).
  $("ed-close").onclick = () => $("editor").classList.add("hidden");

  // Reference column: opt-in via the header Docs toggle. Hidden by default
  // (it used to always be there, squeezing the code); the choice
  // persists like the theme does.
  const setDocs = (on) => {
    $("ed-help").classList.toggle("hidden", !on);
    $("ed-docs").classList.toggle("on", on);
    try { localStorage.setItem("lset-ed-docs", on ? "1" : "0"); } catch (e) { /* private mode */ }
  };
  setDocs(localStorage.getItem("lset-ed-docs") === "1");
  $("ed-docs").onclick = () => setDocs($("ed-help").classList.contains("hidden"));
  document.addEventListener("keydown", (e) => {
    // Escape closes only when typing in the editor itself (or nothing),
    // never while the focus is over in the assistant rail mid-chat.
    if (e.key === "Escape" && !$("editor").classList.contains("hidden") &&
        ($("editor").contains(document.activeElement) ||
         document.activeElement === document.body)) {
      $("editor").classList.add("hidden");
    }
  });

  // The editor's right edge follows the assistant rail's live width
  // (drag-resize and collapse both), so the AI pane is never covered.
  const rail = document.getElementById("ai-rail");
  const glue = () => {
    $("editor").style.right =
      (rail ? Math.round(rail.getBoundingClientRect().width) : 0) + "px";
  };
  if (rail && window.ResizeObserver) new ResizeObserver(glue).observe(rail);
  glue();

  $("ed-new").onclick = () => edNew("python");
  $("ed-new-brue").onclick = () => edNew("brue");

  // Keep the coloured backdrop and gutter glued to the textarea.
  $("ed-src").addEventListener("input", edHighlight);
  $("ed-src").addEventListener("scroll", edSyncScroll);
  // Typing re-previews after a 0.7s pause.
  $("ed-src").addEventListener("input", edSchedulePreview);

  // Example drafts: load into the editor unsaved, name prefilled.
  const exList = $("ed-examples");
  for (const ex of ED_EXAMPLES) {
    const row = document.createElement("div");
    row.className = "ed-item";
    row.innerHTML = `<span>${ex.label}</span>`;
    row.onclick = () => {
      editor.file = null;
      $("ed-name").value = ex.file;
      edSetCode(ex.source);
      $("ed-err").classList.add("hidden");
      edRefreshList();
    };
    exList.appendChild(row);
  }

  // Hands the current draft to the assistant in the rail: prefills the
  // composer with the code (and the last save error, if any) and leaves the
  // cursor at the end so the user states what they want before sending.
  $("ed-ask").onclick = () => {
    if (rail && rail.classList.contains("collapsed")) $("air-expand").click();
    const input = $("air-input");
    const err = $("ed-err").classList.contains("hidden")
      ? "" : "\nIt currently fails with:\n" + $("ed-err").textContent + "\n";
    input.value = "I'm writing a custom chart indicator in the indicator " +
      "editor (" + ($("ed-name").value.trim() || "unsaved") + ")." + err +
      "\nCurrent code:\n```\n" + $("ed-src").value + "\n```\n";
    input.dispatchEvent(new Event("input")); // composer autoresize
    input.focus();
  };

  $("ed-save").onclick = async () => {
    const file = $("ed-name").value.trim();
    if (!file) return;
    const resp = await fetch(`/api/user-indicators/${encodeURIComponent(file)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: $("ed-src").value }),
    });
    let r = null;
    try { r = await resp.json(); } catch (e) { /* non-JSON error body */ }
    // A refused save (hosted mode 403, server down) used to crash on the
    // missing success shape and show NOTHING; say what happened instead.
    if (!resp.ok) {
      $("ed-err").textContent = (r && r.detail) || `save failed (HTTP ${resp.status})`;
      $("ed-err").classList.remove("hidden");
      return;
    }
    editor.file = file;
    if (r.error) {
      $("ed-err").textContent = r.error;
      $("ed-err").classList.remove("hidden");
    } else {
      $("ed-err").classList.add("hidden");
      status(`saved ${file} -> ${r.names.join(", ")}`);
    }
    await refreshSpecs();
    await edRefreshList();
    await loadChart();
  };

  $("ed-delete").onclick = async () => {
    const file = $("ed-name").value.trim();
    if (!file) return;
    // Deleting removes the file from disk; one wrong click used to do it
    // silently, so it asks first (window.confirm is absent in the shell).
    if (!(await askConfirm(`Delete ${file}?`))) return;
    const resp = await fetch(`/api/user-indicators/${encodeURIComponent(file)}`, { method: "DELETE" });
    if (!resp.ok) {
      let r = null;
      try { r = await resp.json(); } catch (e) { /* non-JSON error body */ }
      $("ed-err").textContent = (r && r.detail) || `delete failed (HTTP ${resp.status})`;
      $("ed-err").classList.remove("hidden");
      return;
    }
    editor.file = null;
    await refreshSpecs();
    await loadChart();
    // Back to the template, never a blank page (same rule as openEditor).
    await edNew("python");
  };
}

/* ---------- boot ---------- */

/* In-app modal dialogs. window.prompt does not exist in the desktop shell
   (Electron), so anything needing text input uses these. */
function askText(title, def = "") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.innerHTML = `<div class="modal"><div class="modal-title"></div>` +
      `<input class="modal-input" spellcheck="false">` +
      `<div class="modal-row"><button class="modal-ok">OK</button>` +
      `<button class="modal-cancel">Cancel</button></div></div>`;
    wrap.querySelector(".modal-title").textContent = title;
    document.body.appendChild(wrap);
    const input = wrap.querySelector(".modal-input");
    input.value = def;
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector(".modal-ok").onclick = () => done(input.value.trim() || null);
    wrap.querySelector(".modal-cancel").onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    };
    wrap.onclick = (e) => { if (e.target === wrap) done(null); };
    input.focus();
    input.select();
  });
}

/* `okLabel` / `cancelLabel` name the two answers when OK and Cancel would not
   say what each one does (the live-money question: "Allow trading" or
   "Connect read-only"). Set as text, like the title. */
function askConfirm(title, okLabel, cancelLabel, terms) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.innerHTML = `<div class="modal"><div class="modal-title"></div>` +
      `<div class="modal-row"><button class="modal-ok">OK</button>` +
      `<button class="modal-cancel">Cancel</button></div></div>`;
    wrap.querySelector(".modal-title").textContent = title;
    // Arming a live connection: the broker's terms under the question, as
    // text, with the link to read them (SPEC 3.3). Nothing for a broker whose
    // terms say nothing, so every other question looks as it did.
    const tl = csTermsLine(terms);
    if (tl) {
      tl.classList.add("modal-terms");
      wrap.querySelector(".modal-title").after(tl);
    }
    if (okLabel) wrap.querySelector(".modal-ok").textContent = okLabel;
    if (cancelLabel) wrap.querySelector(".modal-cancel").textContent = cancelLabel;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelector(".modal-ok").onclick = () => done(true);
    wrap.querySelector(".modal-cancel").onclick = () => done(false);
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
  });
}

/* Manual backtesting (bar replay), the ported live-site backtester. Mounted
   on demand into #manual-backtest; unmounted whenever the user leaves so the
   replay loop is never running invisibly in the background. */
function closeManualBacktest() {
  if (window.LSEManualBacktest) window.LSEManualBacktest.unmount();
  $("manual-backtest").classList.add("hidden");
}

function openManualBacktest() {
  subrailMark("sub-bt-manual");
  $("charts").classList.add("hidden");
  $("manual-backtest").classList.remove("hidden");
  window.LSEManualBacktest.mount($("manual-backtest"), {
    // Default the replay source to the full LSE catalog when its key is
    // configured (what "pick any pair" means); the dialog's Data Source
    // selector can still switch to My Data or another vendor. Without a key,
    // fall back to whatever source the shell last used.
    provider: state.lseConfigured ? "lse" : dataProvider(),
    // Backing out of the setup dialog lands on Algo Development (the
    // default mode) rather than stranding the user on an empty pane.
    onExit: () => { openBacktest("py"); },
  });
}

/* ---------- assistant helpers ---------- */
/* The hosted LSE assistant now lives inside the AI rail as the "lse"
   provider (see setupAiPanel/lseSend); only the shared helpers remain
   here. */

function aiEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Minimal markdown shared by the hosted assistant and the AI rail chat:
   fenced blocks become <pre> with a copy button and, for python fences, a
   one-click send into the backtest editor; everything else stays escaped
   plain text. The models do not reliably tag their fences, so an untagged
   block that defines a Strategy subclass gets the editor button too. */
// Non-code chat text: light markdown so agent replies stop showing raw
// ## / ** / |---|. Input is pre-escaped; this
// only injects tags. The message div is white-space:pre-wrap, so block
// elements (headers, tables) swallow their trailing newline to avoid
// double spacing.
function aiMdText(txt) {
  const inline = (s) => s
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const lines = aiEscape(txt).split("\n");
  const segs = [];  // {html, block}
  let table = [];
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|")
    .map((c) => c.trim());
  const flushTable = () => {
    if (table.length < 2) {  // a lone | line is just text
      for (const l of table) segs.push({ html: inline(l), block: false });
      table = [];
      return;
    }
    let t = '<table class="air-md-table">';
    let first = true;
    for (const l of table) {
      if (/^[\s|:-]+$/.test(l)) continue;  // |---|---| separator row
      const tag = first ? "th" : "td";
      t += "<tr>" + cells(l).map((c) => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>";
      first = false;
    }
    segs.push({ html: t + "</table>", block: true });
    table = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) { table.push(line); continue; }
    flushTable();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      segs.push({ html: `<div class="air-md-h air-md-h${h[1].length}">${inline(h[2])}</div>`,
                  block: true });
    } else {
      segs.push({ html: inline(line), block: false });
    }
  }
  flushTable();
  let out = "";
  for (let i = 0; i < segs.length; i += 1) {
    out += segs[i].html;
    // newline only between two plain lines; blocks bring their own spacing
    if (i < segs.length - 1 && !segs[i].block && !segs[i + 1].block) out += "\n";
  }
  return out;
}

/* Chat code blocks in a language other than Python still deserve colour:
   one light pass for strings, comments and numbers, reusing the editor's
   VS Code token classes so chat and IDE read identically. */
function genTokenHTML(code, lang) {
  const hashCom = /^(sh|bash|shell|zsh|yaml|yml|toml|ini|r)$/.test(lang);
  const slashCom = /^(js|javascript|ts|typescript|jsx|tsx|json|c|cpp|h|java|rust|go|css)$/.test(lang);
  const re = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(#[^\n]*)|(\b\d+(?:\.\d+)?\b)/g;
  let html = "", last = 0, m;
  while ((m = re.exec(code))) {
    html += aiEscape(code.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) html += `<span class="hl-s">${aiEscape(m[0])}</span>`;
    else if (m[2] && slashCom) html += `<span class="hl-c">${aiEscape(m[0])}</span>`;
    else if (m[3] && hashCom) html += `<span class="hl-c">${aiEscape(m[0])}</span>`;
    else if (m[4]) html += `<span class="hl-n">${aiEscape(m[0])}</span>`;
    else html += aiEscape(m[0]);
  }
  return html + aiEscape(code.slice(last));
}

function aiMarkdownInto(div, content) {
  // Fence pairs matched explicitly. The old split()-and-mod-3 walk only
  // survived ONE fenced block per message: every close fence shifted the
  // phase, so in multi-block replies later prose was swallowed and code
  // blocks picked up the wrong language. (?:```|$) keeps the streaming
  // behavior where a still-open block renders as code mid-stream.
  const fence = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let html = "", last = 0, m;
  while ((m = fence.exec(content))) {
    html += aiMdText(content.slice(last, m.index));
    last = m.index + m[0].length;
    const lang = (m[1] || "").toLowerCase();
    const code = m[2];
    // Python is the strategy language now; python blocks (or ones that
    // read as python in unlabeled blocks) get the full editor
    // highlighter and a one-click send to the IDE.
    const isPy = lang === "python" || lang === "py" ||
      (!lang && /(^|\n)\s*(import |from |def |class |trades\.append)/.test(code));
    const body = isPy ? pyTokenHTML(code) : genTokenHTML(code, lang);
    html += `<pre data-lang="${lang}">${body}</pre>` +
            `<div class="ai-code-use"><button class="ai-copy">Copy</button>` +
            (isPy ? `<button class="ai-toeditor">To strategy IDE</button>` : "") +
            `</div>`;
  }
  html += aiMdText(content.slice(last));
  div.innerHTML = html;
  div.querySelectorAll(".ai-copy").forEach((b) => {
    b.onclick = () => navigator.clipboard.writeText(
      b.parentElement.previousElementSibling.textContent);
  });
  div.querySelectorAll(".ai-toeditor").forEach((b) => {
    b.onclick = async () => {
      let code = b.parentElement.previousElementSibling.textContent;
      // Pin the block to the dataset it was verified on before it becomes
      // a file: the model is told to write the `# run:` line itself, and
      // when it forgets, the engine's tested-run registry knows which
      // run_backtest vouched for this exact code and stamps the line on.
      // An engine without the endpoint (or an unknown block) just delivers
      // the code unchanged, which is the pre-pin behavior.
      let pin = pyRunPin(code);
      if (!pin) {
        try {
          const r = await fetch("/api/assistant/stamp", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ script: code }),
          });
          if (r.ok) {
            const s = await r.json();
            if (s.script) code = s.script;
            if (s.symbol) pin = { symbol: s.symbol, timeframe: s.timeframe };
          }
        } catch (e) { /* stamp is best-effort; the handoff must never break */ }
      }
      await openBacktest("py");
      // Chat snippets land as their own file, never overwriting the open
      // strategy silently, filed under what the strategy is rather than
      // an anonymous from_chat_N.
      await pyCreateFile("strategies/" + pyStrategyFileName(code, pin) + ".py", code);
      // Point the shared library pick at the pinned dataset too, so the
      // chip, the preview, and unpinned siblings all agree with what RUN
      // is about to do.
      if (pin && (state.datasetList || []).some((d) => d.symbol === pin.symbol)) {
        pySetDataset(pin.symbol);
      }
    };
  });
}

// What the user is looking at, read from the live nav state (rail tab +
// subrail tab), e.g. "ECONOMIC > CALENDAR". Shared by the agent-CLI
// workspace push AND the hosted LSE Assistant context below.
function aiViewNow() {
  const parts = [];
  const rb = document.querySelector(".rail-btn.active");
  if (rb) parts.push(rb.textContent.trim());
  const sub = $("subrail");
  const sb = sub && sub.querySelector(".subrail-btn.active");
  if (sb && !sub.classList.contains("hidden")) parts.push(sb.textContent.trim());
  return parts.join(" > ");
}

// The research paper on screen RIGHT NOW, or null. offsetParent covers the
// whole ancestor chain, so a paper left open behind another section does
// not count; readerItem alone is not enough because rsHideReader keeps it
// (deliberately, as "last read") after the reader closes.
function aiOpenPaperNow() {
  const rd = $("rs-reader");
  if (!rd || rd.offsetParent === null) return null;
  const it = rsState.readerItem;
  return it && it.link ? it : null;
}

// One shape for naming a paper to any model, everywhere (Ask AI prefill,
// hosted context, per-turn grounding). The "Link:" line is load-bearing:
// the engine's /api/assistant grounding regex keys on it to attach the
// PDF's extracted text, so never reword that line.
function aiPaperLines(it) {
  return "Title: " + (it.title || "") + "\n" +
         "Authors: " + ((it.authors || []).join(", ") || "n/a") + "\n" +
         "Source: " + (it.source || "") + " · " + (it.category || "") + "\n" +
         "Link: " + (it.link || "");
}

// The code in whichever editor is actually ON SCREEN. Every IDE has its own
// textarea (py-code / wsx-code / bt-src); reading only bt-src,
// the legacy backtest editor, leaves the Python IDE's code invisible to the
// assistant.
function aiVisibleEditorSrc() {
  // ml-code is the ML page's blueprint editor: it was missing from this
  // list, so on BACKTEST > MACHINE LEARNING the assistant answered "I can't
  // see which script you mean" to a user pointing at a screenful of code.
  for (const id of ["py-code", "wsx-code", "ml-code", "bt-src"]) {
    const el = $(id);
    if (el && el.offsetParent !== null && el.value && el.value.trim()) {
      return el.value.trim();
    }
  }
  return "";
}

/* The last real lines of an xterm buffer as plain text. This is how the
   assistant sees what a terminal PRINTED (tracebacks, exit codes, the run
   console's error text): the screen map carried every panel's state but no
   terminal output, so "look at the error message" was unanswerable
   (e.g. a failed RUN in the Python IDE). Reads from the last
   non-blank row backwards so a tall empty viewport does not eat the quota. */
function aiTermTail(term, maxLines, maxChars) {
  maxLines = maxLines || 40;
  maxChars = maxChars || 3000;
  try {
    if (!term || !term.buffer) return "";
    const buf = term.buffer.active;
    let end = buf.length - 1;
    while (end >= 0) {
      const l = buf.getLine(end);
      if (l && l.translateToString(true).trim()) break;
      end -= 1;
    }
    if (end < 0) return "";
    const lines = [];
    for (let i = Math.max(0, end - maxLines + 1); i <= end; i += 1) {
      const l = buf.getLine(i);
      lines.push(l ? l.translateToString(true) : "");
    }
    let out = lines.join("\n");
    if (out.length > maxChars) out = out.slice(-maxChars);
    return out;
  } catch (e) { return ""; }
}

/* The output of the terminal the user can actually SEE right now: the
   Python IDE's docked panel (its active tab) or the WORKSPACE terminal.
   Same visible-wins rule as aiVisibleEditorSrc. */
function aiVisibleTermTail() {
  const vis = (id) => { const el = $(id); return !!(el && el.offsetParent !== null); };
  try {
    if (typeof py === "object" && (py.terms || []).length && vis("py-term")) {
      const act = py.terms.find((t) => t.id === py.termActive)
        || py.terms[py.terms.length - 1];
      if (act) {
        return { where: `Python IDE terminal, "${act.name}" tab`,
                 tail: aiTermTail(act.term) };
      }
    }
    if (typeof wsx === "object" && wsx.term && vis("wsx-term")) {
      return { where: "WORKSPACE terminal", tail: aiTermTail(wsx.term) };
    }
  } catch (e) { /* the tail must never block the prompt */ }
  return null;
}

function aiContext() {
  // Live app state folded into the hosted assistant's system prompt. The
  // hosted bot has no screenshot and no tools; this text is ALL it knows
  // about the screen. The headline lines carry what the user is most
  // likely asking about; the screen map underneath is the SAME universal
  // AI_REGIONS map the CLI agents get (every panel, its live data), so
  // there is no page the hosted bot is blind on.
  let ctx = "CURRENT CONTEXT (live from the app):\n" +
            `- Page open right now: ${aiViewNow() || "unknown"}\n`;
  // The chart line only when a chart is actually on screen: as a headline
  // on every page it bleeds into answers (the chart symbol gets borrowed
  // as, say, an options chain's underlying). The screen map still
  // carries the chart region as visible:false for "what was I charting".
  const chartOn = (() => {
    const el = $("chart-wrap");
    return !!(el && el.offsetParent !== null);
  })();
  if (chartOn) ctx += `- Chart: ${state.symbol || "none"} @ ${state.timeframe}\n`;
  const open = (typeof py === "object" && py.open) ||
               (typeof wsx === "object" && wsx.open) || "";
  if (open) ctx += `- Strategy file open in the editor: ${open}\n`;
  const paper = aiOpenPaperNow();
  if (paper) {
    ctx += "- Research paper open in the reader right now:\n" +
           aiPaperLines(paper) + "\n";
  }
  try {
    if (typeof window.aiTerminalNow === "function") {
      const t = window.aiTerminalNow();
      const regions = (t.regions || [])
        .filter((r) => r.present)
        .map((r) => ({ id: r.id, label: r.label, visible: r.visible,
                       data: r.data }))
        // Visible panels lead: on the OPTIONS page the model described the
        // (hidden) chart and trade ticket as the page content because they
        // came first and carried richer data (seen in simulation).
        .sort((a, b) => (b.visible === true) - (a.visible === true));
      // Bounds, `more` (tool pointers) and the tool note are stripped: the
      // hosted bot has no tools to follow them with and no pixels for the
      // bounds to anchor. Cap so a fat region (last_runs, watchlists)
      // cannot eat the prompt.
      let map = JSON.stringify(regions);
      if (map.length > 6000) map = map.slice(0, 6000) + " …truncated";
      ctx += "\nScreen map, every panel of the terminal with its live " +
             "state as JSON. The user is LOOKING AT the visible:true " +
             "panels only; visible:false panels exist elsewhere in the " +
             "app and are NOT on screen, so never describe them as what " +
             "the user sees. These numbers are authoritative:\n" + map + "\n";
    }
  } catch (e) { /* the map must never block the prompt */ }
  const src = aiVisibleEditorSrc();
  if (src) {
    ctx += `- Editor content:\n\`\`\`\n${src.slice(0, 6000)}\n\`\`\``;
  }
  // Its own headline section, not only a screen-map field: the map JSON is
  // capped at 6000 chars, and an error the user is asking about must never
  // be the part that gets truncated away.
  const tt = aiVisibleTermTail();
  if (tt && tt.tail) {
    ctx += `\n- Terminal output (${tt.where}, the last lines the user sees, ` +
           "including any error text):\n```\n" + tt.tail + "\n```";
  }
  return ctx;
}

/* Take an imported dataset to BACKTEST > ALGO DEVELOPMENT: the IDE with
   that file as the pinned backtest dataset and its preview (columns + a
   100-row sample) open. This replaced BACKTEST > CHARTS (removed:
   a standalone chart page under BACKTEST makes no sense); every path
   that used to chart a user file there (library click outside the IDE, the
   assistant's show_chart) lands here instead, and user files still never
   appear under MARKETS (live data only). */
async function openBacktestDataset(symbol) {
  await openBacktest("py");
  const d = (state.datasetList || []).find((x) => x.symbol === symbol);
  if (!d) return;
  pyRepin(d.symbol);
  pySetDataset(d.symbol);
  pyShowPreview(d);
}

/* Last-used backtest mode, so the BACKTEST tab reopens where the user left
   off. localStorage failures (private mode, file://) must never break the
   tab, so both sides are guarded. */
function btSaveMode(mode) {
  try { localStorage.setItem("lse.btMode", mode); } catch (e) { /* optional */ }
}

/* Open the BACKTEST tab in a specific mode ("py" | "manual" | "ml"), or
   the last-used one when none is given ("charts", the retired mode, and
   any other stale saved value fall back to py). Algo Development is
   the first-launch default: the old "Choose how you
   want to test" chooser page cost a click on every entry and left the tab
   looking empty; the subrail already switches modes, so the chooser is
   retired and its card descriptions live on as subrail tooltips. */
async function openBacktest(mode) {
  if (!mode) {
    try { mode = localStorage.getItem("lse.btMode"); } catch (e) { /* optional */ }
  }
  if (!["py", "manual", "ml"].includes(mode)) mode = "py";
  for (const b of document.querySelectorAll(".rail-btn")) b.classList.remove("active");
  $("rail-backtest").classList.add("active");
  document.title = "Backtest · LSE Terminal";
  $("side").classList.remove("hidden");
  renderSubrail("backtest", null);
  // scrpage was missing from this sweep: SCREENER -> BACKTEST left the
  // screener section un-hidden underneath (two pages visible at once).
  for (const id of ["optpage", "news", "mydata", "econcal", "dataviz", "nbpage", "mlpage",
                    "pyide", "wsx", "charts", "backtest", "lse-connect",
                    "research", "guide", "scrpage"]) {
    $(id).classList.add("hidden");
  }
  closeManualBacktest();
  // Algo Development and ML run on the user's own imported files; flip the
  // source so those modes and the sidebar library inherit it. Manual backtest
  // is exempt: its setup dialog chooses the data source itself (the full LSE
  // catalog by default), so forcing My Data here would hide every hosted
  // instrument from the one mode meant to replay any pair.
  if (mode !== "manual" && state.provider !== "userdata") switchProvider("userdata");
  if (mode === "manual") {
    btSaveMode("manual");
    openManualBacktest();
  } else if (mode === "ml") {
    btSaveMode("ml");
    $("mlpage").classList.remove("hidden");
    await openML();
  } else {
    btSaveMode("py");
    $("pyide").classList.remove("hidden");
    await openPyIDE();
  }
}

/* ---------- Pro-terminal secondary bar (sub-sections per rail tab) ----
   MARKETS and BACKTEST each carry a row of sub-views under the main rail;
   sections without sub-views hide the strip. Sub-tab clicks route through
   the parent rail's own click first: that is the single reset point for
   every page section, so a sub-view can never leak a half-hidden surface
   from the tab the user came from. */
/* Entries without a `go` are PLACEHOLDERS (every section
   gets its bar now, the buttons come alive as features land): rendered
   quieter, click does nothing, tooltip says Coming soon. Rename/wire them
   here as the sections get built. */
const SUBRAIL = {
  markets: [
    { id: "sub-mk-charts", label: "PRICE & CHARTS",
      go: () => $("rail-markets").click() },
    { id: "sub-mk-options", label: "OPTIONS",
      go: () => { $("rail-markets").click(); showOptionsPage(); } },
    { id: "sub-mk-news", label: "NEWS",
      go: () => { $("rail-markets").click(); showNewsPage(); } },
    { id: "sub-mk-screener", label: "SCREENER",
      go: () => { $("rail-markets").click(); showScreenerPage(); } },
  ],
  // The retired chooser page's card descriptions live on here as tooltips,
  // so first-time discovery of what each mode is survives the removal.
  backtest: [
    { id: "sub-bt-py", label: "ALGO DEVELOPMENT",
      desc: "A VS Code style workspace: your strategy files, a code " +
        "editor, one-click backtests on any dataset you pick, and the AI " +
        "assistant working in the same folder.",
      go: () => openBacktest("py") },
    { id: "sub-bt-ml", label: "MACHINE LEARNING",
      desc: "Train 20 models (XGBoost, LSTM, GARCH, regime detection...) " +
        "on your imported data, on this machine's own CPU or GPU. Every " +
        "run is a small Python blueprint you or the AI assistant can edit " +
        "and rerun.",
      go: () => openBacktest("ml") },
    // (BACKTEST > CHARTS, the standalone chart of an imported file, was
    // removed: charts here exist to show a
    // backtest, not as a page of their own. A dataset click now lands in
    // Algo Development with the file pinned; see the library tree.)
    // Last on purpose: the hand-trading replay is the
    // odd one out next to the two code-and-data modes.
    { id: "sub-bt-manual", label: "MANUAL",
      desc: "Bar replay. Pick an instrument and a start date, step through " +
        "history candle by candle and trade it by hand, with stop loss, " +
        "take profit and a full session report.",
      go: () => openBacktest("manual") },
  ],
  econ: [
    { id: "sub-ec-cal", label: "CALENDAR",
      go: () => openEcon("calendar", "sub-ec-cal") },
    { id: "sub-ec-news", label: "NEWS",
      go: () => { $("rail-econ").click(); showNewsPage("econ"); } },
    { id: "sub-ec-indicators", label: "INDICATORS",
      desc: "Every national statistic the vault carries, by country and " +
        "category, with its full history.",
      go: () => openEcon("indicators", "sub-ec-indicators") },
    { id: "sub-ec-yields", label: "BOND YIELDS",
      desc: "Government bond yield curves back to 1990: a country's whole " +
        "curve today against a month and a year ago, or one tenor across " +
        "every country.",
      go: () => openEcon("yields", "sub-ec-yields") },
    { id: "sub-ec-banks", label: "CENTRAL BANKS",
      desc: "Policy rates with each bank's balance sheet, money supply and " +
        "reserves, plus its rate decision schedule.",
      go: () => openEcon("banks", "sub-ec-banks") },
  ],
  workspace: [
    { id: "sub-ws-ide", label: "IDE",
      go: () => $("rail-workspace").click() },
    // (dash/dash.js: boards of widgets the user codes against the
    // terminal's data, each in a sandboxed frame)
    { id: "sub-ws-dash", label: "DASHBOARD",
      desc: "Your own boards of widgets. A widget is a few lines of " +
        "JavaScript that reads the terminal's data (prices, bars, option " +
        "chains, economic series, your own files) and draws it.",
      go: () => openDash() },
    { id: "sub-ws-dataviz", label: "DATA VISUALISATION",
      go: () => openDataViz() },
    { id: "sub-ws-notebooks", label: "NOTEBOOK",
      desc: "An infinite canvas per notebook: write, drop photos in, draw " +
        "and highlight in colour, add arrows and shapes, and set maths in " +
        "real notation. Saved on this machine.",
      go: () => openNotebooks() },
  ],
  research: [
    { id: "sub-rs-articles", label: "ARTICLES",
      desc: "The newest quantitative finance research: arXiv q-fin " +
        "submissions plus NBER, BIS, Fed and ECB working papers, refreshed " +
        "server-side.",
      go: () => openResearch("articles") },
    { id: "sub-rs-models", label: "QUANT MODELS",
      desc: "Interactive visualisations of the standard quant models: " +
        "Monte Carlo, Black-Scholes, Heston, GARCH, Kalman filter, LSTM " +
        "and more, with live parameters.",
      go: () => openResearch("models") },
  ],
};

function renderSubrail(section, activeId) {
  const bar = $("subrail");
  const items = SUBRAIL[section];
  // WORKSPACE > DASHBOARD is the one page no section's own sweep hides: it
  // follows the lit sub-view, here and in subrailMark, the two places every
  // change of view passes through.
  if (typeof dashSyncView === "function") dashSyncView(items ? activeId : null);
  if (!items) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    aiPanelRefreshEmpty();
    viewSyncAddress();
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.id = it.id;
    b.className = "subrail-btn" + (it.id === activeId ? " active" : "")
      + (it.go ? "" : " soon");
    b.textContent = it.label;
    if (it.go) { b.onclick = it.go; if (it.desc) b.title = it.desc; }
    else b.title = "Coming soon";
    bar.appendChild(b);
  }
  aiPanelRefreshEmpty(); // the assistant's hero states the section it sees
  viewSyncAddress();
}

/* Highlight one sub-tab (or none) without rebuilding the bar. The mode
   openers call this so the bar stays truthful when a mode is entered from
   the chooser cards or from chat ("To strategy IDE"), not just from the
   bar itself. */
function subrailMark(activeId) {
  for (const b of document.querySelectorAll(".subrail-btn")) {
    b.classList.toggle("active", b.id === activeId);
  }
  if (typeof dashSyncView === "function") dashSyncView(activeId);
  aiPanelRefreshEmpty(); // the hero states the section it sees
  viewSyncAddress();
}

/* WORKSPACE > DATA VISUALISATION: a React island (chart builder for arbitrary
   tabular data). Lives under the workspace rail tab but swaps the IDE out for
   its own section, so it replicates the rail handler's hide-everything sweep
   rather than calling rail-workspace's click (which would mount the IDE and
   unfold the AI rail). */
function openDataViz() {
  for (const b of document.querySelectorAll(".rail-btn")) b.classList.remove("active");
  $("rail-workspace").classList.add("active");
  document.title = "Data Visualisation · LSE Terminal";
  $("side").classList.add("hidden");
  renderSubrail("workspace", "sub-ws-dataviz");
  // scrpage joined this sweep with openBacktest's (the same case:
  // SCREENER -> DATA VISUALISATION left the screener rendered underneath).
  for (const id of ["optpage", "news", "charts", "backtest", "mydata",
                    "econcal", "nbpage", "mlpage", "pyide", "wsx", "lse-connect",
                    "research", "guide", "scrpage"]) {
    $(id).classList.add("hidden");
  }
  closeManualBacktest();
  $("dataviz").classList.remove("hidden");
  if (window.LSEDataViz) window.LSEDataViz.mount($("dataviz-root"));
}

/* WORKSPACE > NOTEBOOKS: the infinite research canvas. Same chrome reset as
   openDataViz (one sub-view visible at a time), then hand the whole surface
   to the island, which owns its own rail, canvas and storage calls. */
function openNotebooks() {
  for (const b of document.querySelectorAll(".rail-btn")) b.classList.remove("active");
  $("rail-workspace").classList.add("active");
  document.title = "Notebook · LSE Terminal";
  $("side").classList.add("hidden");
  renderSubrail("workspace", "sub-ws-notebooks");
  for (const id of ["optpage", "news", "charts", "backtest", "mydata",
                    "econcal", "dataviz", "mlpage", "pyide", "wsx",
                    "lse-connect", "research", "guide", "scrpage"]) {
    $(id).classList.add("hidden");
  }
  closeManualBacktest();
  $("nbpage").classList.remove("hidden");
  if (window.LSENotebooks) window.LSENotebooks.mount($("nb-root"));
}

/* Open one specific notebook from the library tree. The id is parked on
   window because the island may not be mounted yet (its mount-effect reads
   it); the event covers the already-mounted case. "__new__" creates a fresh
   notebook instead of opening one. */
function openNotebookById(id) {
  window.__lseNbPending = id;
  openNotebooks();
  window.dispatchEvent(new Event("lse-nb-open"));
}

/* ---------- TERMINAL WALKTHROUGH: the built-in user guide (the
   tab was GUIDE, then HELP, then this; ids
   keep the gd/guide names) ----
   One document, guide.md next to this file, is the whole feature: this
   page renders it, and the engine hands the SAME file to every AI the
   terminal talks to (the hosted assistant's per-turn summary + read_guide
   tool, the CLI agents' GUIDE.md, /mcp). So "do you know how the terminal
   works?" is answered from the text a user can read here. Rendering is a
   small dedicated markdown pass (headings, paragraphs, lists, fences,
   tables, quotes, links) rather than the chat renderer, which is tuned for
   short answers and has no list or paragraph model; the contents column
   on the left is built from the ## / ### headings and follows the scroll. */
const gd = { md: null, loading: null, heads: [], spyBound: false, pin: null, pinSeen: false,
             hits: [], hitAt: -1, linksBound: false, hoverT: null, goTo: null };

/* Open the walkthrough AT one heading, by its id (gdSlug of its title): how
   a screen elsewhere in the app sends the reader to the part that answers
   them. The jump is made when the guide is drawn, which the first time is
   after guide.md has arrived (gdRender). */
function gdOpenAt(id) {
  gd.goTo = id;
  $("rail-guide").click();
}

function gdOpen() {
  if (gd.md !== null) { gdRender(); return; }
  if (gd.loading) return;
  // no-cache: the desktop app hot-deploys UI files, and a guide edit must
  // show on the next open, not after whatever the browser cached.
  gd.loading = fetch("/guide.md", { cache: "no-cache" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status))))
    .then((t) => { gd.md = t; gdRender(); })
    .catch((e) => {
      gd.goTo = null;
      $("gd-doc").innerHTML = '<div class="news-empty">The guide could not ' +
        "be loaded (" + aiEscape(String(e.message || e)) + ").</div>";
    })
    .finally(() => { gd.loading = null; });
}

/* Inline markdown: bold, code, links (external ones open outside the app;
   in-document #anchors scroll the reading column). Escaped first, so the
   guide can mention <tags> literally. */
function gdInline(s) {
  return aiEscape(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\((#[^)\s]+)\)/g, '<a href="$2" data-gd-anchor="$2">$1</a>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function gdSlug(title) {
  return "gd-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/* Colour coding: which hue a section id belongs to. Sub-sections inherit
   their parent's; anything not about one area stays neutral. */
const GD_TAB_IDS = { MARKETS: "gd-markets", BACKTEST: "gd-backtest", ECONOMIC: "gd-economic",
                     WORKSPACE: "gd-workspace", RESEARCH: "gd-research", "MY DATA": "gd-my-data" };
function gdHue(id) {
  const s = String(id || "");
  if (/^gd-markets|^gd-price|^gd-options|^gd-news|^gd-screener|^gd-trading|^gd-custom-indicators/.test(s)) return "markets";
  if (/^gd-backtest|^gd-algo|^gd-the-strategy-contract|^gd-machine-learning|^gd-manual/.test(s)) return "backtest";
  if (/^gd-my-data/.test(s)) return "data";
  if (/^gd-economic/.test(s)) return "econ";
  if (/^gd-workspace/.test(s)) return "workspace";
  if (/^gd-research/.test(s)) return "research";
  if (/^gd-the-assistant|^gd-the-lse-assistant|^gd-your-own-agent|^gd-ask-ai/.test(s)) return "assistant";
  if (/^gd-connections/.test(s)) return "connect";
  return "none";
}
function gdParentSlug(id, heads) {
  let parent = null;
  for (const h of heads) {
    if (h.level === 2) parent = h.id;
    if (h.id === id) return parent;
  }
  return null;
}

/* Cross-references (clickable blue links between
   sections). Every section title, tab name and glossary headword
   becomes a link target; the first mention of each in a section (or the
   first in the whole document for the generic single words) becomes a
   link to it. Headings, code, existing links and a term's own home are
   left alone. Text-node walk, so the markup around it is untouched. */
const GD_GENERIC = new Set(["assistant", "backtest", "brief", "candles", "dataset", "engine",
                            "kind", "library", "provider", "strategy", "timeframe", "workspace"]);
function gdEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function gdTermList(doc) {
  const terms = [];  // {pat, id, scope: "section" | "doc", ci, home}
  const add = (text, id, ci, home, scope) => {
    if (!text || text.length < 3) return;
    terms.push({ text, id, ci: !!ci, home, scope: scope || "section" });
  };
  // section titles
  // titles that are also everyday phrases would mislink ("The layout button")
  const NO_LINK = new Set(["The layout", "What the terminal is", "Common questions", "Glossary"]);
  doc.querySelectorAll("h2, h3").forEach((h) => {
    const title = h.textContent.replace(/^\s*[\d.]+\s*/, "").trim();
    const home = h.closest("section.gd-sec");
    if (!title || NO_LINK.has(title)) return;
    if (/\s/.test(title)) add(title, h.id, true, home);      // multiword: any case
    else add(title, h.id, false, home);                     // one word: exact case
  });
  // tab names -> sections
  for (const [tab, id] of Object.entries(GD_TAB_IDS)) {
    const el = document.getElementById(id);
    if (el) add(tab, id, false, el.closest("section.gd-sec"));
  }
  // glossary headwords (+ a few spellings)
  const gl = doc.querySelector('section[data-slug="gd-glossary"]');
  doc.querySelectorAll('section[data-slug="gd-glossary"] li').forEach((li) => {
    const b = li.querySelector("b"); if (!b) return;
    const head = b.textContent.trim();
    const bare = head.replace(/\s*\(.*?\)\s*$/, "").trim();
    const scope = GD_GENERIC.has(bare.toLowerCase()) ? "doc" : "section";
    add(bare, li.id, true, li, scope);
    if (/^Walk forward$/i.test(bare)) add("walk-forward", li.id, true, li);
    if (/^Pin line$/i.test(bare)) { add("pin lines", li.id, true, li); add("# run:", li.id, false, li); }
    if (/^Level 3 data$/i.test(bare)) add("Level 3", li.id, false, li);
    if (/^SETUP tag$/i.test(bare)) add("SETUP", li.id, false, li);
    if (/^Template$/i.test(bare)) { add("Templates", li.id, false, li); add("chart template", li.id, true, li); }
    if (/^Sample datasets$/i.test(bare)) add("samples", li.id, true, li);
    if (/^Starter strategies$/i.test(bare)) add("starters", li.id, true, li);
  });
  // longest first so "Strategy brief" beats "Strategy"
  terms.sort((a, b) => b.text.length - a.text.length);
  for (const t of terms) {
    t.re = new RegExp("(^|[^A-Za-z0-9_])(" + gdEsc(t.text) + ")(?![A-Za-z0-9_])", t.ci ? "i" : "");
  }
  return terms;
}
function gdAutolink(doc) {
  const terms = gdTermList(doc);
  const usedDoc = new Set();
  const skip = (n) => !!n.closest("h1, h2, h3, pre, code, a, .gd-num, table.gd-index, .gd-intro");
  doc.querySelectorAll("section.gd-sec").forEach((sec) => {
    const usedHere = new Set();
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim().length > 2 && !skip(n.parentElement)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (let tn of nodes) {
      let guard = 0;
      while (tn && tn.nodeValue && guard++ < 40) {
        let best = null;
        for (const t of terms) {
          if (t.home && t.home.contains(tn)) continue;
          if (usedHere.has(t.id) || (t.scope === "doc" && usedDoc.has(t.id))) continue;
          const m = t.re.exec(tn.nodeValue);
          if (!m) continue;
          const at = m.index + m[1].length;
          if (!best || at < best.at) best = { t, at, len: m[2].length };
        }
        if (!best) break;
        const { t, at, len } = best;
        const rest = tn.splitText(at);
        const after = rest.splitText(len);
        const a = document.createElement("a");
        a.className = "gd-xref"; a.href = "#" + t.id; a.dataset.gdAnchor = "#" + t.id;
        a.textContent = rest.nodeValue;
        rest.replaceWith(a);
        usedHere.add(t.id);
        if (t.scope === "doc") usedDoc.add(t.id);
        tn = after;
      }
    }
  });
}

/* Preview card for a cross-reference: the target's title and its first
   line (a glossary definition, or a section's opening paragraph). */
function gdHoverShow(a) {
  const id = (a.dataset.gdAnchor || "").slice(1);
  const el = document.getElementById(id);
  const main = $("gd-main");
  if (!el || !main) return;
  let title = "", body = "", kind = "";
  if (el.tagName === "LI") {
    kind = "glossary";
    title = (el.querySelector("b") || {}).textContent || "";
    body = (el.querySelector(".gd-def") || {}).textContent || "";
  } else {
    kind = el.tagName === "H3" ? "sub-section" : "section";
    title = el.textContent.replace(/^\s*[\d.]+\s*/, "").trim();
    let n = el.nextElementSibling;
    while (n && !/^(P|UL|OL|TABLE)$/.test(n.tagName)) n = n.nextElementSibling;
    body = n ? n.textContent : "";
  }
  body = body.replace(/\s+/g, " ").trim();
  if (body.length > 230) body = body.slice(0, 227).replace(/\s+\S*$/, "") + "…";
  let card = $("gd-hover");
  if (!card) {
    card = document.createElement("div"); card.id = "gd-hover";
    $("guide").appendChild(card);
  }
  card.innerHTML = `<div class="gd-hover-title"><span>${aiEscape(title)}</span>` +
    `<span class="gd-hover-kind">${kind}</span></div>` +
    `<div class="gd-hover-body">${aiEscape(body)}</div>`;
  card.classList.remove("hidden");
  const gr = $("guide").getBoundingClientRect(), r = a.getBoundingClientRect();
  card.style.left = Math.max(8, Math.min(r.left - gr.left, gr.width - card.offsetWidth - 12)) + "px";
  const below = r.bottom - gr.top + 8;
  card.style.top = (below + card.offsetHeight < gr.height - 8 ? below : r.top - gr.top - card.offsetHeight - 8) + "px";
}
function gdHoverHide() { const c = $("gd-hover"); if (c) c.classList.add("hidden"); }

function gdRender() {
  const lines = (gd.md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const heads = [];   // {id, level, title}
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push("<p>" + gdInline(para.join(" ")) + "</p>");
    para = [];
  };
  const isBlank = (l) => !l.trim();
  const listItem = (l) => l.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  const tableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  let sawH1 = false;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = (fence[1] || "").toLowerCase();
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;  // closing fence
      const code = body.join("\n");
      const html = (lang === "python" || lang === "py") ? pyTokenHTML(code)
        : genTokenHTML(code, lang);
      out.push(`<pre data-lang="${lang}"><code>${html}</code></pre>`);
      continue;
    }
    // headings
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      const title = h[2].trim();
      if (level === 1) {
        out.push("<h1>" + gdInline(title) + "</h1>");
        sawH1 = true;
      } else {
        const id = gdSlug(title);
        heads.push({ id, level, title });
        out.push(`<h${level} id="${id}">${gdInline(title)}</h${level}>`);
      }
      i += 1;
      continue;
    }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); out.push("<hr>"); i += 1; continue; }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, "")); i += 1;
      }
      out.push("<blockquote>" + gdInline(q.join(" ")) + "</blockquote>");
      continue;
    }
    // table
    if (tableRow(line)) {
      flushPara();
      const rows = [];
      while (i < lines.length && tableRow(lines[i])) { rows.push(lines[i]); i += 1; }
      let t = "<table>";
      let first = true;
      for (const r of rows) {
        if (/^[\s|:-]+$/.test(r)) continue;   // |---|---| separator
        const tag = first ? "th" : "td";
        t += "<tr>" + cells(r).map((c) => `<${tag}>${gdInline(c)}</${tag}>`).join("") + "</tr>";
        first = false;
      }
      out.push(t + "</table>");
      continue;
    }
    // lists (one nesting level by indentation; ordered vs unordered by marker)
    if (listItem(line)) {
      flushPara();
      const stack = [];  // [{indent, tag}]
      const closeTo = (indent) => {
        while (stack.length && stack[stack.length - 1].indent > indent) {
          out.push("</li></" + stack.pop().tag + ">");
        }
      };
      let openLi = false;
      while (i < lines.length) {
        const m = listItem(lines[i]);
        if (!m) {
          // a wrapped continuation line belongs to the current item
          if (!isBlank(lines[i]) && /^\s{2,}/.test(lines[i]) && openLi) {
            out.push(" " + gdInline(lines[i].trim())); i += 1; continue;
          }
          break;
        }
        const indent = m[1].length;
        const tag = /\d/.test(m[2]) ? "ol" : "ul";
        if (!stack.length || indent > stack[stack.length - 1].indent) {
          out.push("<" + tag + ">");
          stack.push({ indent, tag });
        } else {
          closeTo(indent);
          if (openLi) out.push("</li>");
        }
        out.push("<li>" + gdInline(m[3]));
        openLi = true;
        i += 1;
      }
      while (stack.length) out.push("</li></" + stack.pop().tag + ">");
      continue;
    }
    if (isBlank(line)) { flushPara(); i += 1; continue; }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  // The paragraph right under the title is the lede: set it quieter.
  let html = out.join("\n");
  if (sawH1) html = html.replace(/<\/h1>\n<p>/, '</h1>\n<p class="gd-lede">');
  gd.heads = heads;
  const doc = $("gd-doc");
  doc.innerHTML = html;
  // Group the flat stream into <section> per ## and <div.gd-subsec> per ###
  // (each carrying data-for = its heading id). Search counts hits per
  // heading through these wrappers; the glossary gets its dictionary
  // styling through its section's data-slug.
  // Every heading gets a number (sections 1..n, sub-sections n.m) shown as
  // a badge in the document and in front of its contents row, so a reader
  // can say "section 5.2" and find it in both places.
  const nums = {};
  (() => {
    const nodes = Array.from(doc.childNodes);
    const frag = document.createDocumentFragment();
    // the title block (h1, lede, tab index) is a card of its own
    const intro = document.createElement("section");
    intro.className = "gd-sec gd-intro";
    frag.appendChild(intro);
    let sec = null, sub = null, n2 = 0, n3 = 0;
    const badge = (h, label) => {
      const b = document.createElement("span");
      b.className = "gd-num"; b.textContent = label;
      h.insertBefore(b, h.firstChild);
    };
    for (const n of nodes) {
      const tag = n.nodeType === 1 ? n.tagName : "";
      if (tag === "H2") {
        n2 += 1; n3 = 0;
        nums[n.id] = String(n2);
        badge(n, String(n2).padStart(2, "0"));
        sec = document.createElement("section");
        sec.className = "gd-sec"; sec.dataset.for = n.id; sec.dataset.slug = n.id;
        frag.appendChild(sec); sub = null;
        sec.appendChild(n);
      } else if (tag === "H3" && sec) {
        n3 += 1;
        nums[n.id] = n2 + "." + n3;
        badge(n, n2 + "." + n3);
        sub = document.createElement("div");
        sub.className = "gd-subsec"; sub.dataset.for = n.id;
        sec.appendChild(sub); sub.appendChild(n);
      } else if (sub) sub.appendChild(n);
      else if (sec) sec.appendChild(n);
      else intro.appendChild(n);
    }
    if (!intro.childNodes.length) intro.remove();
    doc.innerHTML = "";
    doc.appendChild(frag);
    // Glossary entries: headword (the leading bold) + one definition cell,
    // so the two-column grid in CSS has exactly two items per row. Each
    // entry gets an id so cross-references can land on it.
    doc.querySelectorAll('section[data-slug="gd-glossary"] li').forEach((li) => {
      const first = li.firstElementChild;
      if (!first || first.tagName !== "B" || first !== li.firstChild) return;
      const def = document.createElement("span");
      def.className = "gd-def";
      while (first.nextSibling) def.appendChild(first.nextSibling);
      li.appendChild(def);
      // the headword's trailing full stop is prose punctuation; in a
      // two-column entry it reads as a stray dot
      first.textContent = first.textContent.replace(/\.\s*$/, "");
      li.id = "gd-term-" + gdSlug(first.textContent).slice(3);
    });
    // Colour coding: every section card carries the hue
    // of its area, badges and contents numbers follow (CSS reads data-hue).
    doc.querySelectorAll("section.gd-sec").forEach((sec) => {
      sec.dataset.hue = gdHue(sec.dataset.slug || "");
    });
    // The intro's tab index: a hue dot before each tab name, and the name
    // links to its section.
    const introTable = doc.querySelector("section.gd-intro table");
    if (introTable) {
      introTable.querySelectorAll("tr").forEach((tr) => {
        const td = tr.querySelector("td");
        if (!td) return;
        const tab = td.textContent.trim();
        const id = GD_TAB_IDS[tab];
        const hue = gdHue(id || "");
        const dot = document.createElement("span");
        dot.className = "gd-dot"; dot.dataset.hue = hue;
        if (id && document.getElementById(id)) {
          const a = document.createElement("a");
          a.className = "gd-xref"; a.href = "#" + id; a.dataset.gdAnchor = "#" + id;
          a.textContent = tab;
          td.textContent = ""; td.appendChild(dot); td.appendChild(a);
        } else {
          td.insertBefore(dot, td.firstChild);
        }
      });
    }
    gdAutolink(doc);
  })();
  // In-document links (authored anchors and generated cross-references)
  // scroll the reading column rather than the page; hovering one shows a
  // preview card of where it goes. Delegated, bound once.
  if (!gd.linksBound) {
    gd.linksBound = true;
    doc.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-gd-anchor]");
      if (!a) return;
      e.preventDefault();
      gdJump(a.getAttribute("data-gd-anchor").slice(1), true);
    });
    doc.addEventListener("mouseover", (e) => {
      const a = e.target.closest("a.gd-xref");
      if (!a) return;
      clearTimeout(gd.hoverT);
      gd.hoverT = setTimeout(() => gdHoverShow(a), 260);
    });
    doc.addEventListener("mouseout", (e) => {
      const a = e.target.closest("a.gd-xref");
      if (!a) return;
      clearTimeout(gd.hoverT);
      gdHoverHide();
    });
    $("gd-main").addEventListener("scroll", gdHoverHide, { passive: true });
  }
  // Contents column: a search box over the whole guide, then sections and
  // their sub-headings (each row carries a hit counter the search fills).
  const side = $("gd-side");
  side.innerHTML = "";
  const sw = document.createElement("div");
  sw.id = "gd-search-wrap";
  sw.innerHTML = '<input id="gd-search" placeholder="Search the guide&hellip;" ' +
    'spellcheck="false" autocomplete="off"><div id="gd-search-n"></div>';
  side.appendChild(sw);
  const head = document.createElement("div");
  head.className = "rs-nav-head"; head.textContent = "CONTENTS";
  side.appendChild(head);
  for (const hd of heads) {
    const b = document.createElement("button");
    b.className = "rs-nav" + (hd.level > 2 ? " gd-sub" : "");
    b.dataset.gdId = hd.id;
    b.innerHTML = "<span class=\"gd-n\"></span><span class=\"gd-t\"></span>" +
                  "<span class=\"rs-nav-n\"></span>";
    b.firstChild.textContent = nums[hd.id] || "";
    b.children[1].textContent = hd.title;
    b.dataset.hue = gdHue(hd.level === 2 ? hd.id : (gdParentSlug(hd.id, heads) || hd.id));
    b.onclick = () => gdJump(hd.id);
    side.appendChild(b);
  }
  gdSearchWire();
  if (!gd.spyBound) {
    gd.spyBound = true;
    $("gd-main").addEventListener("scroll", gdSpy, { passive: true });
  }
  gdSpy();
  gdGoToPending();
}

/* Opened at a heading (gdOpenAt): go there once the guide is drawn, and
   only once. */
function gdGoToPending() {
  if (!gd.goTo) return;
  const id = gd.goTo;
  gd.goTo = null;
  gdJump(id, true);
}

/* ---- Guide search: highlight every match in the document, count hits per
   contents row (rows with none go quiet), Enter / Shift+Enter walk the
   hits, Escape clears. Plain text-node walking, so headings, bullets,
   tables and code are all searchable and the markup underneath is left
   as it was. ---- */
function gdSearchWire() {
  const inp = $("gd-search");
  if (!inp) return;
  let t = null;
  inp.oninput = () => { clearTimeout(t); t = setTimeout(() => gdSearch(inp.value), 120); };
  inp.onkeydown = (e) => {
    if (e.key === "Escape") { inp.value = ""; gdSearch(""); inp.blur(); }
    else if (e.key === "Enter") { e.preventDefault(); gdSearchStep(e.shiftKey ? -1 : 1); }
  };
}

function gdSearchClear() {
  const doc = $("gd-doc");
  doc.querySelectorAll("mark.gd-hit").forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  doc.normalize();
  gd.hits = []; gd.hitAt = -1;
  for (const b of $("gd-side").querySelectorAll(".rs-nav")) {
    b.classList.remove("gd-quiet");
    const n = b.querySelector(".rs-nav-n"); if (n) n.textContent = "";
  }
  const st = $("gd-search-n"); if (st) st.textContent = "";
}

function gdSearch(q) {
  gdSearchClear();
  q = (q || "").trim();
  if (q.length < 2) return;
  const doc = $("gd-doc");
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.toLowerCase().includes(needle)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  const hits = [];
  for (const tn of texts) {
    const val = tn.nodeValue, low = val.toLowerCase();
    const frag = document.createDocumentFragment();
    let last = 0, i = low.indexOf(needle);
    while (i !== -1) {
      if (i > last) frag.appendChild(document.createTextNode(val.slice(last, i)));
      const m = document.createElement("mark");
      m.className = "gd-hit"; m.textContent = val.slice(i, i + q.length);
      frag.appendChild(m); hits.push(m);
      last = i + q.length; i = low.indexOf(needle, last);
    }
    if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
    tn.replaceWith(frag);
  }
  gd.hits = hits;
  for (const b of $("gd-side").querySelectorAll(".rs-nav")) {
    const id = b.dataset.gdId;
    const wrap = doc.querySelector('[data-for="' + id + '"]');
    const n = wrap ? wrap.querySelectorAll("mark.gd-hit").length : 0;
    b.classList.toggle("gd-quiet", n === 0);
    const c = b.querySelector(".rs-nav-n"); if (c) c.textContent = n ? String(n) : "";
  }
  const st = $("gd-search-n");
  if (st) st.textContent = hits.length ? hits.length + (hits.length === 1 ? " match" : " matches") + " · Enter to step" : "no matches";
  if (hits.length) gdSearchStep(1);
}

function gdSearchStep(dir) {
  if (!gd.hits || !gd.hits.length) return;
  if (gd.hitAt >= 0 && gd.hits[gd.hitAt]) gd.hits[gd.hitAt].classList.remove("current");
  gd.hitAt = (gd.hitAt + dir + gd.hits.length) % gd.hits.length;
  const m = gd.hits[gd.hitAt];
  m.classList.add("current");
  const main = $("gd-main");
  main.scrollTo({ top: gdTop(m, main) - main.clientHeight * 0.3, behavior: "smooth" });
  const st = $("gd-search-n");
  if (st) st.textContent = (gd.hitAt + 1) + " of " + gd.hits.length + " · Enter to step";
}

/* A heading's offset inside the scrolling column. offsetTop is not usable
   here: neither #gd-main nor #gd-doc is positioned, so it would measure
   against some outer ancestor. */
function gdTop(el, main) {
  return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
}

function gdJump(id, flash) {
  const el = document.getElementById(id);
  const main = $("gd-main");
  if (!el || !main) return;
  if (flash) {
    el.classList.remove("gd-flash"); void el.offsetWidth; el.classList.add("gd-flash");
    setTimeout(() => el.classList.remove("gd-flash"), 1700);
  }
  // The clicked row stays marked while its heading is on screen: the last
  // sections cannot reach the top of the column, so nearest-above alone
  // would mark an earlier heading the moment the scroll hits bottom.
  gd.pin = id;
  gd.pinSeen = false;
  gdMark(id);
  main.scrollTo({ top: gdTop(el, main) - 14, behavior: "smooth" });
}

function gdMark(id) {
  for (const b of $("gd-side").querySelectorAll(".rs-nav")) {
    b.classList.toggle("active", b.dataset.gdId === id);
  }
}

/* Mark the contents row of the heading nearest above the top of the
   reading column (or the pinned one from a contents click while it is
   still in view). */
function gdSpy() {
  const main = $("gd-main");
  if (!main || !gd.heads.length) return;
  if (gd.pin) {
    const pel = document.getElementById(gd.pin);
    const t = pel ? gdTop(pel, main) - main.scrollTop : -1;
    const inView = !!pel && t >= -20 && t < main.clientHeight - 20;
    if (inView) { gd.pinSeen = true; gdMark(gd.pin); return; }
    // Smooth scrolling fires scroll events all the way there: until the
    // pinned heading has been on screen once, we are still travelling.
    if (!gd.pinSeen && pel) { gdMark(gd.pin); return; }
    gd.pin = null;
  }
  const y = main.scrollTop + 40;
  let cur = gd.heads[0].id;
  for (const hd of gd.heads) {
    const el = document.getElementById(hd.id);
    if (el && gdTop(el, main) <= y) cur = hd.id; else break;
  }
  gdMark(cur);
}

/* ---------- RESEARCH: articles feed + quant models ----------
   One section (#research), two inner views, mirroring the ECONOMIC pattern:
   the rail button's own handler is the single chrome-reset point,
   rsShowView swaps the inner surface, the LSEQuantModels island mounts on
   demand. (A third "knowledge archive" view was deleted;
   see the index.html section comment before adding content views.) */
const rsState = { items: [], srcFilter: "ALL", catFilter: "ALL", q: "", hosted: null,
                  wired: false, readerUrl: null, readerSeq: 0 };

// Fixed presentation order for the pipeline's quant-theory categories
// (rsRenderSide shows only the ones present in the current feed).
const RS_CATS = ["Options & Volatility", "Portfolio & Factors",
                 "Microstructure & Trading", "Risk", "Machine Learning",
                 "Macro & Banking", "Digital Assets", "Methods & Computation"];

function openResearch(view) {
  $("rail-research").click();
  rsShowView(view || "articles");
}

/* One-time wiring for the reader chrome. Lazy (first rsShowView) so the
   listeners exist only once regardless of how the section is entered. */
function rsWireOnce() {
  if (rsState.wired) return;
  rsState.wired = true;
  $("rs-reader-back").onclick = rsHideReader;
  $("rs-search").oninput = () => {
    rsState.q = $("rs-search").value;
    rsRenderFeed();
  };
  // Same prefill pattern as the indicator editor's Ask AI: name the paper,
  // point the agent at read_research_paper for the full text, let the user
  // finish the sentence with what they want built.
  $("rs-reader-ai").onclick = () => {
    const it = rsState.readerItem || {};
    const rail = $("ai-rail");
    if (rail && rail.classList.contains("collapsed")) $("air-expand").click();
    const input = $("air-input");
    input.value = "I'm reading this paper in the RESEARCH tab:\n" +
      "Title: " + (it.title || "") + "\n" +
      "Authors: " + ((it.authors || []).join(", ") || "n/a") + "\n" +
      "Source: " + (it.source || "") + " · " + (it.category || "") + "\n" +
      "Link: " + (it.link || "") + "\n\n" +
      "Read the full text with read_research_paper on that link, then ";
    input.dispatchEvent(new Event("input"));
    input.focus();
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("research").classList.contains("hidden")
        && !$("rs-reader").classList.contains("hidden")) {
      rsHideReader();
    }
  });
  // Delegated title clicks: local app intercepts into the in-terminal
  // reader; hosted (or modifier-clicks, or unknown config) keeps the plain
  // external link, which always works.
  $("rs-articles-body").addEventListener("click", (e) => {
    const a = e.target.closest(".rs-title");
    if (!a || rsState.hosted !== false) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const it = rsState.items[Number(a.dataset.idx)];
    if (!it) return;
    e.preventDefault();
    rsOpenPaper(it);
  });
}

function rsShowView(view) {
  rsWireOnce();
  rsHideReader();
  subrailMark("sub-rs-" + view);
  $("rs-articles").classList.toggle("hidden", view !== "articles");
  $("rs-models").classList.toggle("hidden", view !== "models");
  document.title = (view === "models" ? "Quant Models" : "Research")
    + " · LSE Terminal";
  if (view === "articles") {
    rsLoadWire();
  } else if (view === "models") {
    if (window.LSEQuantModels) window.LSEQuantModels.mount($("rs-models-root"));
    else $("rs-models-root").textContent = "Chart bundle failed to load.";
  }
}

/* Live-first: /api/research/feed serves the public research_papers table
   (fresh on every pipeline run, no app update needed) and itself falls back
   to the shipped wire file when offline. The second fetch here covers OLD
   engines that predate the endpoint (the frozen sidecar copy): they 404 and
   the page reads the static file directly, exactly as before. */
function rsLoadWire() {
  fetch("/api/research/feed")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no feed endpoint"))))
    .catch(() => fetch("/assets/research/research_wire.json?t=" + Date.now())
      .then((r) => (r.ok ? r.json() : null)))
    .then((doc) => {
      if (!doc || !Array.isArray(doc.items)) return;
      rsState.items = doc.items;
      rsRenderSide();
      rsRenderFeed();
      $("rs-articles-meta").textContent = doc.items.length + " papers · " +
        (doc.live ? "live" : "updated " + (doc.generated || "").slice(0, 10));
    })
    .catch(() => { /* no wire at all: the terse empty state stands */ });
}

/* Left filter sidebar: LATEST on top, then the
   source and quant-theory groups, in the QUANT MODELS picker idiom. Counts
   per row so the sidebar states facts, not just labels. */
function rsRenderSide() {
  const host = $("rs-side");
  host.innerHTML = "";
  const apply = () => { rsRenderSide(); rsRenderFeed(); $("rs-main").scrollTop = 0; };
  const item = (label, count, active, onClick) => {
    const b = document.createElement("button");
    b.className = "rs-nav" + (active ? " active" : "");
    b.innerHTML = `<span>${aiEscape(label)}</span>` +
      (count != null ? `<span class="rs-nav-n">${count}</span>` : "");
    b.onclick = onClick;
    host.appendChild(b);
  };
  const header = (label) => {
    const h = document.createElement("div");
    h.className = "rs-nav-head";
    h.textContent = label;
    host.appendChild(h);
  };
  item("LATEST", rsState.items.length,
    rsState.srcFilter === "ALL" && rsState.catFilter === "ALL",
    () => { rsState.srcFilter = "ALL"; rsState.catFilter = "ALL"; apply(); });
  header("SOURCE");
  const srcs = [];
  for (const it of rsState.items) {
    if (it.source && !srcs.includes(it.source)) srcs.push(it.source);
  }
  for (const s of srcs.sort()) {
    const n = rsState.items.filter((it) => it.source === s).length;
    item(s, n, rsState.srcFilter === s,
      () => { rsState.srcFilter = rsState.srcFilter === s ? "ALL" : s; apply(); });
  }
  header("CATEGORY");
  for (const c of RS_CATS) {
    const n = rsState.items.filter((it) => it.category === c).length;
    if (!n) continue;
    item(c, n, rsState.catFilter === c,
      () => { rsState.catFilter = rsState.catFilter === c ? "ALL" : c; apply(); });
  }
}

/* Every interpolation is escaped: titles/abstracts/links are third-party
   feed content. aiEscape covers text nodes, optAttr the quoted hrefs.
   target=_blank hands the paper to the system browser via the shell. */
function rsRenderFeed() {
  const body = $("rs-articles-body");
  const q = rsState.q.trim().toLowerCase();
  const items = rsState.items.filter(
    (it) => (rsState.srcFilter === "ALL" || it.source === rsState.srcFilter)
         && (rsState.catFilter === "ALL" || it.category === rsState.catFilter)
         && (!q || (it.title + " " + (it.summary || "") + " "
                    + (it.authors || []).join(" ") + " " + (it.source || "")
                    + " " + (it.category || "")).toLowerCase().includes(q)));
  if (!items.length) {
    body.innerHTML = '<div class="news-empty">No papers match the filters.</div>';
    return;
  }
  body.innerHTML = items.map((it) => {
    const date = (it.published || "").slice(0, 10);
    const authors = (it.authors || []).join(", ");
    const cat = it.category
      ? `<span class="rs-cat">${aiEscape(it.category)}</span>` : "";
    // Each card's image is the paper's own first page (pipeline-rendered),
    // served from the api host; onerror hides it so an offline terminal
    // shows a clean text card, never a broken-image glyph.
    const thumb = it.thumb
      ? `<img class="rs-thumb" src="${optAttr("https://api.londonstrategicedge.com" + it.thumb)}" loading="lazy" alt="" onerror="this.style.display='none'">`
      : "";
    // data-idx points into rsState.items (not this filtered list) so the
    // reader click handler resolves the right paper under any filter.
    return `<article class="rs-card">
      ${thumb}
      <div class="rs-card-main">
      <div class="rs-card-top">
        <span class="rs-src">${aiEscape(it.source || "")}</span>
        <span class="rs-date">${aiEscape(date)}</span>${cat}
      </div>
      <a class="rs-title" data-idx="${rsState.items.indexOf(it)}" href="${optAttr(it.link || "#")}" target="_blank" rel="noopener noreferrer">${aiEscape(it.title || "")}</a>
      ${authors ? `<div class="rs-authors">${aiEscape(authors)}</div>` : ""}
      ${it.summary ? `<p class="rs-abs">${aiEscape(it.summary)}</p>` : ""}
      </div>
    </article>`;
  }).join("");
}

/* ---------- In-terminal paper reader ----------
   The engine downloads the publisher's PDF (user-machine egress, cached
   under the config dir) and the iframe shows it as a same-origin blob, so
   no publisher needs to allow framing. Any failure leaves the status line
   plus the always-present "Open in browser" link, never a dead pane. */
function rsOpenPaper(it) {
  rsState.readerItem = it; // the Ask AI prefill names this paper
  $("rs-articles").classList.add("hidden");
  $("rs-reader").classList.remove("hidden");
  $("rs-reader-src").textContent = it.source || "";
  $("rs-reader-title").textContent = it.title || "";
  $("rs-reader-ext").href = it.link || "#";
  const frame = $("rs-reader-frame");
  const status = $("rs-reader-status");
  frame.classList.add("hidden");
  frame.removeAttribute("src");
  status.classList.remove("hidden");
  let host = "";
  try { host = new URL(it.link).hostname; } catch (e) { /* status stays generic */ }
  status.textContent = "Fetching PDF" + (host ? " from " + host : "") + "…";
  if (rsState.readerUrl) { URL.revokeObjectURL(rsState.readerUrl); rsState.readerUrl = null; }
  const seq = ++rsState.readerSeq;
  fetch("/api/research/pdf?link=" + encodeURIComponent(it.link || ""))
    .then(async (r) => {
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || ("HTTP " + r.status));
      }
      return r.blob();
    })
    .then((b) => {
      if (seq !== rsState.readerSeq) return; // user moved on mid-fetch
      rsState.readerUrl = URL.createObjectURL(b);
      frame.src = rsState.readerUrl;
      frame.classList.remove("hidden");
      status.classList.add("hidden");
    })
    .catch((e) => {
      if (seq !== rsState.readerSeq) return;
      status.textContent = "No in-app copy (" + e.message + "). Use Open in browser.";
    });
}

function rsHideReader() {
  rsState.readerSeq++; // invalidate any in-flight fetch
  if (rsState.readerUrl) { URL.revokeObjectURL(rsState.readerUrl); rsState.readerUrl = null; }
  $("rs-reader-frame").removeAttribute("src");
  $("rs-reader").classList.add("hidden");
  $("rs-articles").classList.remove("hidden");
}

/* ECONOMIC sub-tabs (INDICATORS / BOND YIELDS / CENTRAL BANKS): open the
   section, then mount its React island straight into the named view.
   Deliberately delegates the section chrome to the rail button's own handler
   (active rail, window title, sidebar, the hide-everything-else sweep) instead
   of repeating it: that handler closes over wiring-scope helpers this
   top-level function cannot see. The remount is what carries the view; the
   page's own title effect names it. */
function openEcon(view, subId) {
  $("rail-econ").click();
  if (subId) subrailMark(subId);
  if (view && window.LSEEconCalendar) {
    window.LSEEconCalendar.mount($("econcal-root"), {
      onBack: () => $("rail-markets").click(),
      view: view,
    });
  }
}

/* ---------- MARKETS > Options: chain + flow tape ---------- */
const optState = { view: "chain", und: "", expiry: "", chainRows: [],
                   strikes: "auto", greeks: false, unds: [], logos: {},
                   rowH: 26, wired: false, seq: 0, paintKey: "",
                   flashPrev: null, flowTop: 0,
                   listRows: [], listShown: 0, filterTimer: null };

/* Attribute-context escape: aiEscape covers text nodes only (no quote
   escaping), so a name/ticker carrying a double quote would break out of a
   value="..."/title="..." attribute and mint its own attributes. Every
   options interpolation that lands inside a quoted attribute goes through
   this instead. */
function optAttr(s) {
  return aiEscape(String(s)).replace(/"/g, "&quot;");
}

/* Chain prefs persist like the watchlist price cache: reopening the
   terminal lands on the same underlying with the same layout. */
function optSavePrefs() {
  try {
    localStorage.setItem("lset-options", JSON.stringify({
      und: optState.und, strikes: optState.strikes, greeks: optState.greeks }));
  } catch (e) { /* quota/private mode: prefs just don't stick */ }
}
function optLoadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("lset-options")) || {};
    if (typeof p.und === "string") optState.und = p.und;
    // strikes: "auto" fits the window, "" shows all, else a fixed count.
    // A stored 30 was the old fixed DEFAULT, not a choice anyone made
    // against an auto option that did not exist yet; it upgrades to auto.
    if (p.strikes === "" || p.strikes === "auto" || Number(p.strikes) > 0) {
      optState.strikes = p.strikes === "" ? "" :
        (p.strikes === "auto" || Number(p.strikes) === 30) ? "auto" : Number(p.strikes);
    }
    optState.greeks = !!p.greeks;
  } catch (e) { /* corrupt entry: defaults stand */ }
}

function showOptionsPage() {
  subrailMark("sub-mk-options");
  document.title = "Options · LSE Terminal";
  // Full-page like ECONOMIC: the watchlist sidebar is chart context, and a
  // click there would silently swap the page back to charts anyway.
  $("side").classList.add("hidden");
  $("charts").classList.add("hidden");
  $("lse-connect").classList.add("hidden");
  $("optpage").classList.remove("hidden");
  optInit();
  optRefresh();
}

/* ---------- MARKETS > NEWS: the globe ---------------------------------
   The same detailed globe as the londonstrategicedge.com homepage hero,
   ported to the terminal's vanilla JS. Accurate coastlines, country borders
   and rivers (Natural Earth 50m) are projected onto a sphere through an
   orthographic projection; land is dotted from a land mask, city lights burn
   on top from the earth-at-night image, and the key financial cities are
   wired into a rotating "electricity" network with pulses along each link.

   Assets ship inside the app under /assets/globe (no CDN, offline
   product). Everything is precomputed once on first open; each frame is cheap
   trig. The blue is the VIZ, not chrome (steel #4a86c5, no neon); the news
   backdrop is always dark, so the globe uses the dark-tuned palette. */

const NEWS_STEEL = "#4a86c5"; // steel accent for the globe canvas only
// Key financial cities: the recognisable nodes of the network, labelled.
const NEWS_CITIES = [
  { name: "London", lat: 51.51, lon: -0.13 },
  { name: "New York", lat: 40.71, lon: -74.01 },
  { name: "Frankfurt", lat: 50.11, lon: 8.68 },
  { name: "Paris", lat: 48.86, lon: 2.35 },
  { name: "Zurich", lat: 47.37, lon: 8.54 },
  { name: "Dubai", lat: 25.2, lon: 55.27 },
  { name: "Mumbai", lat: 19.08, lon: 72.88 },
  { name: "Singapore", lat: 1.35, lon: 103.82 },
  { name: "Hong Kong", lat: 22.32, lon: 114.17 },
  { name: "Shanghai", lat: 31.23, lon: 121.47 },
  { name: "Tokyo", lat: 35.68, lon: 139.77 },
  { name: "Seoul", lat: 37.57, lon: 126.98 },
  { name: "Sydney", lat: -33.87, lon: 151.21 },
  { name: "Chicago", lat: 41.88, lon: -87.63 },
  { name: "Toronto", lat: 43.65, lon: -79.38 },
  { name: "Sao Paulo", lat: -23.55, lon: -46.63 },
];

// A sphere point precomputed as [cos(lat), sin(lat), sin(lon), cos(lon)].
const NEWS_D2R = Math.PI / 180;
function newsMk(lon, lat) {
  const la = lat * NEWS_D2R, lo = lon * NEWS_D2R;
  return [Math.cos(la), Math.sin(la), Math.sin(lo), Math.cos(lo)];
}

const newsGlobe = {
  started: false, built: false, raf: 0, canvas: null, ctx: null,
  W: 0, H: 0, cx: 0, cy: 0, Rg: 0, dpr: 1,
  // Zoom: Rg0 is the fit-the-panel radius, Rg = Rg0 * zoom. panX/panY offset
  // the disc centre so wheel-zoom can keep the point under the cursor put
  // (a plain centre-scaled zoom walks whatever you aimed at off-screen).
  Rg0: 0, zoom: 1, panX: 0, panY: 0,
  lon0: 0, tilt: 0, phase: 0, drag: null, ro: null,
  coast: [], rivers: [], borders: [], dots: [], power: [],
  dotsFine: [], powerFine: [], // half-spacing infill, drawn only when zoomed
  cityNodes: [], hubs: [], edges: [],
  hx: new Float32Array(0), hy: new Float32Array(0), hz: new Float32Array(0),
  // News wire: events plotted as pins. sp = sphere point; ex/ey/ez = last
  // projection (for click hit-testing). sel = focused event index. tLon/tTilt
  // = eased rotation target when focusing a pin, null when free.
  events: [], sel: -1, hl: -1, tLon: null, tTilt: null, wireLoaded: false,
  ex: new Float32Array(0), ey: new Float32Array(0), ez: new Float32Array(0),
};

// Decimate + convert a GeoJSON feature collection into projected line arrays.
function newsAddLines(geo, target) {
  if (!geo || !geo.features) return;
  // Only drop duplicate/near-duplicate source points here. The old aggressive
  // build-time decimation (0.0045) was sub-pixel at 1x but turned coastlines
  // into visible polygons once the globe could be zoomed, and the thrown-away
  // detail can never come back. Per-frame culling in newsStrokeLines does the
  // zoom-aware thinning instead, so 1x costs the same and 8x has real detail.
  const EPS2 = 0.0011 * 0.0011;
  for (const f of geo.features) {
    const g = f && f.geometry;
    if (!g) continue;
    const segs =
      g.type === "LineString" ? [g.coordinates] :
      g.type === "MultiLineString" ? g.coordinates :
      g.type === "Polygon" ? g.coordinates :
      g.type === "MultiPolygon" ? g.coordinates.flat() : [];
    for (const seg of segs) {
      const arr = [];
      let lx = 0, ly = 0, lz = 0, has = false;
      for (const c of seg) {
        const p = newsMk(c[0], c[1]);
        const X = p[0] * p[2], Y = p[1], Z = p[0] * p[3];
        if (!has || (X-lx)*(X-lx) + (Y-ly)*(Y-ly) + (Z-lz)*(Z-lz) > EPS2) {
          arr.push(p); lx = X; ly = Y; lz = Z; has = true;
        }
      }
      if (arr.length > 1) target.push(arr);
    }
  }
}

function newsResize() {
  const g = newsGlobe, r = g.canvas.getBoundingClientRect();
  g.dpr = Math.min(2, window.devicePixelRatio || 1);
  g.W = r.width; g.H = r.height;
  g.canvas.width = Math.round(g.W * g.dpr);
  g.canvas.height = Math.round(g.H * g.dpr);
  g.ctx = g.canvas.getContext("2d");
  if (g.ctx) g.ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
  g.Rg0 = Math.min(g.W, g.H) * 0.46;
  newsApplyView();
}

// Derive the drawn radius and disc centre from zoom + pan. Everything that
// paints reads g.cx/g.cy/g.Rg, so zoom and pan need no other change anywhere.
function newsApplyView() {
  const g = newsGlobe;
  g.Rg = g.Rg0 * g.zoom;
  // Never let the centre leave the disc: past that the sphere slides out of
  // the panel entirely and there is nothing left to grab or zoom back from.
  const lim = g.Rg * 0.9;
  g.panX = Math.max(-lim, Math.min(lim, g.panX));
  g.panY = Math.max(-lim, Math.min(lim, g.panY));
  g.cx = g.W / 2 + g.panX;
  g.cy = g.H / 2 + g.panY;
}

// Zoom by `mul` about the canvas point (px, py): the geography under the
// cursor stays under the cursor. Clamped at 1x (fits the panel) so the globe
// can never shrink into a dot, and at 6x, past which the 50m geometry and the
// land-dot grid are both out of detail.
const NEWS_ZOOM_MIN = 1, NEWS_ZOOM_MAX = 6;
const NEWS_FINE_ZOOM = 2.5; // above this the half-spacing dot infill is drawn
function newsZoomAt(mul, px, py) {
  const g = newsGlobe;
  const z = Math.max(NEWS_ZOOM_MIN, Math.min(NEWS_ZOOM_MAX, g.zoom * mul));
  if (z === g.zoom) return;
  const k = z / g.zoom;
  g.zoom = z;
  if (z === NEWS_ZOOM_MIN) {
    g.panX = 0; g.panY = 0; // back at fit: recentre, no stranded offset
  } else {
    g.panX = px - g.W / 2 - k * (px - g.cx);
    g.panY = py - g.H / 2 - k * (py - g.cy);
  }
  newsApplyView();
}

// Stroke a set of line arrays, front hemisphere only, for the current spin.
// Project a sphere point through the current spin (lon0) and tilt. Returns
// [Xf, Yf, Z]: Xf/Yf are screen factors (multiply by Rg, offset by centre),
// Z is depth after tilt (visible when Z > 0, and the shading depth). The tilt
// is a rotation about the horizontal screen axis, added so the globe can be
// dragged up/down (pole to pole), not only spun left/right.
function newsProj(p, sinL0, cosL0, sinT, cosT) {
  const dSin = p[2] * cosL0 - p[3] * sinL0;
  const zb = p[0] * (p[3] * cosL0 + p[2] * sinL0); // depth before tilt
  const yb = p[1];                                  // up before tilt
  return [p[0] * dSin, yb * cosT - zb * sinT, yb * sinT + zb * cosT];
}

// Segments shorter than ~1px on screen are dropped, which is what makes one
// full-detail geometry serve every zoom: at 1x roughly the same number of
// segments reach the canvas as the old build-time decimation produced, and
// zoomed in the extra points stop being culled and the coastline stays smooth.
// The projection is inlined (rather than newsProj) because this now walks
// ~76k points per layer per frame and an array per point would be all GC.
function newsStrokeLines(list, color, width, alpha, sinL0, cosL0, sinT, cosT) {
  const g = newsGlobe, ctx = g.ctx;
  if (!ctx) return;
  const cx = g.cx, cy = g.cy, Rg = g.Rg;
  const MIN2 = 1.0;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  for (let l = 0; l < list.length; l++) {
    const arr = list[l], n = arr.length;
    let started = false, lx = 0, ly = 0;
    for (let i = 0; i < n; i++) {
      const p = arr[i];
      const dSin = p[2] * cosL0 - p[3] * sinL0;
      const zb = p[0] * (p[3] * cosL0 + p[2] * sinL0);
      const yb = p[1];
      if (yb * sinT + zb * cosT <= 0) { started = false; continue; } // behind
      const sx = cx + Rg * (p[0] * dSin);
      const sy = cy - Rg * (yb * cosT - zb * sinT);
      if (!started) { ctx.moveTo(sx, sy); started = true; lx = sx; ly = sy; continue; }
      const dx = sx - lx, dy = sy - ly;
      // Keep the last point regardless, so a short line still gets drawn.
      if (dx*dx + dy*dy < MIN2 && i !== n - 1) continue;
      ctx.lineTo(sx, sy); lx = sx; ly = sy;
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function newsDraw() {
  const g = newsGlobe, ctx = g.ctx;
  if (!ctx) return;
  ctx.clearRect(0, 0, g.W, g.H);
  const cx = g.cx, cy = g.cy, Rg = g.Rg;
  const sinL0 = Math.sin(g.lon0), cosL0 = Math.cos(g.lon0);
  const sinT = Math.sin(g.tilt), cosT = Math.cos(g.tilt);

  // Faint sphere for volume (dark-tuned).
  const grd = ctx.createRadialGradient(cx - Rg*0.35, cy - Rg*0.35, Rg*0.1, cx, cy, Rg);
  grd.addColorStop(0, "rgba(140,160,172,0.16)");
  grd.addColorStop(0.72, "rgba(120,140,152,0.07)");
  grd.addColorStop(1, "rgba(150,175,190,0.18)");
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(cx, cy, Rg, 0, Math.PI*2); ctx.fill();

  // Crisp rim so the globe reads as a defined disc.
  ctx.strokeStyle = "rgba(175,197,210,0.62)";
  ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.arc(cx, cy, Rg, 0, Math.PI*2); ctx.stroke();

  // Land fill dots. Grow the dot with zoom (capped) and bring in the fine
  // infill set past NEWS_FINE_ZOOM, so the stipple density stays roughly
  // constant on screen instead of thinning out as the sphere magnifies.
  ctx.fillStyle = "#aeb9c4";
  const dotBase = 0.30, dotDepth = 0.42;
  // spread = how far apart the drawn dots are versus 1x, which is the zoom
  // halved once the fine infill joins in. Sizing off it keeps dot-to-gap the
  // same at every zoom: scale by raw zoom instead and 4x turns the land into
  // a heavy polka-dot pattern rather than the fine stipple it is at 1x.
  const fine = g.zoom >= NEWS_FINE_ZOOM;
  const spread = g.zoom / (fine ? 2 : 1);
  const dotSz = 1.2 * spread, dotOff = dotSz / 2;
  for (let pass = 0; pass < (fine ? 2 : 1); pass++) {
    const list = pass ? g.dotsFine : g.dots;
    for (let i = 0; i < list.length; i++) {
      const pr = newsProj(list[i], sinL0, cosL0, sinT, cosT);
      const z = pr[2];
      if (z <= 0) continue;
      const sx = cx + Rg * pr[0];
      const sy = cy - Rg * pr[1];
      // Zoomed in, most of the sphere is off-panel: cheaper to test than fill.
      if (sx < -dotSz || sy < -dotSz || sx > g.W + dotSz || sy > g.H + dotSz) continue;
      ctx.globalAlpha = dotBase + dotDepth * z;
      ctx.fillRect(sx - dotOff, sy - dotOff, dotSz, dotSz);
    }
  }
  ctx.globalAlpha = 1;

  // Rivers underneath, then borders and coastlines at one consistent weight.
  newsStrokeLines(g.rivers, "#5f7a8c", 0.5, 0.36, sinL0, cosL0, sinT, cosT);
  newsStrokeLines(g.borders, "#a9b5c2", 0.7, 0.66, sinL0, cosL0, sinT, cosT);
  newsStrokeLines(g.coast, "#a9b5c2", 0.75, 0.72, sinL0, cosL0, sinT, cosT);

  // City lights. Same spreading problem as the land dots, grown more gently
  // so the bright cores do not blob together when zoomed right in.
  const lightK = Math.sqrt(spread);
  ctx.fillStyle = NEWS_STEEL;
  for (let pass = 0; pass < (fine ? 2 : 1); pass++) {
    const list = pass ? g.powerFine : g.power;
    for (let i = 0; i < list.length; i++) {
      const t = list[i].t;
      const pr = newsProj(list[i].p, sinL0, cosL0, sinT, cosT);
      const z = pr[2];
      if (z <= 0) continue;
      const sx = cx + Rg * pr[0];
      const sy = cy - Rg * pr[1];
      if (sx < -8 || sy < -8 || sx > g.W + 8 || sy > g.H + 8) continue;
      ctx.globalAlpha = Math.min(1, 0.62 + 0.38 * t) * (0.5 + 0.5 * z);
      ctx.beginPath();
      ctx.arc(sx, sy, (0.95 + 1.85 * t) * lightK, 0, Math.PI*2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Project the network hubs once.
  for (let i = 0; i < g.hubs.length; i++) {
    const pr = newsProj(g.hubs[i], sinL0, cosL0, sinT, cosT);
    g.hz[i] = pr[2];
    if (pr[2] > 0) {
      g.hx[i] = cx + Rg * pr[0];
      g.hy[i] = cy - Rg * pr[1];
    }
  }

  // Wire the hubs, front hemisphere only, fading near the limb.
  ctx.strokeStyle = NEWS_STEEL; ctx.lineWidth = 0.9;
  for (let e = 0; e < g.edges.length; e++) {
    const a = g.edges[e][0], b = g.edges[e][1];
    if (g.hz[a] > 0 && g.hz[b] > 0) {
      ctx.globalAlpha = 0.5 * Math.min(1, g.hz[a]) * Math.min(1, g.hz[b]) + 0.14;
      ctx.beginPath();
      ctx.moveTo(g.hx[a], g.hy[a]); ctx.lineTo(g.hx[b], g.hy[b]);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Pulses running along each link.
  ctx.fillStyle = "#5a97d0";
  for (let e = 0; e < g.edges.length; e++) {
    const a = g.edges[e][0], b = g.edges[e][1];
    if (g.hz[a] <= 0 || g.hz[b] <= 0) continue;
    const f = (g.phase + e * 0.137) % 1;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(g.hx[a] + (g.hx[b]-g.hx[a])*f, g.hy[a] + (g.hy[b]-g.hy[a])*f, 1.2, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Glowing hub nodes.
  for (let i = 0; i < g.hubs.length; i++) {
    if (g.hz[i] <= 0) continue;
    const x = g.hx[i], y = g.hy[i];
    const R = 5 + 3 * (0.6 + 0.4 * Math.sin(g.phase * 6.2832 + i));
    const rg = ctx.createRadialGradient(x, y, 0, x, y, R);
    rg.addColorStop(0, "rgba(74,134,197,0.45)");
    rg.addColorStop(1, "rgba(74,134,197,0)");
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = NEWS_STEEL;
    ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Labelled key cities: front facing, faded with depth, de-collided. No
  // headline to dodge here (unlike the homepage), so every visible city shows.
  ctx.font = "600 9px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle"; ctx.textAlign = "left";
  try { ctx.letterSpacing = "0.6px"; } catch (e) { /* older canvas */ }
  const placed = [];
  const CAND = [[9,-9,1],[9,9,1],[-9,-9,-1],[-9,9,-1]];
  for (let i = 0; i < g.cityNodes.length; i++) {
    const z = g.hz[i];
    if (z <= 0.1) continue;
    const x = g.hx[i], y = g.hy[i];
    const name = g.cityNodes[i].name.toUpperCase();
    const tw = ctx.measureText(name).width;
    let lx = 0, ly = 0, dir = 1, rect = null;
    for (let ci = 0; ci < CAND.length; ci++) {
      const d = CAND[ci][2];
      const ax = x + CAND[ci][0] + (d < 0 ? -tw : 0);
      const ay = y + CAND[ci][1];
      const rr = [ax-3, ay-8, ax+tw+3, ay+8];
      let clash = false;
      for (let q = 0; q < placed.length; q++) {
        const bb = placed[q];
        if (rr[0] < bb[2] && rr[2] > bb[0] && rr[1] < bb[3] && rr[3] > bb[1]) { clash = true; break; }
      }
      if (!clash) { lx = ax; ly = ay; dir = d; rect = rr; break; }
    }
    if (!rect) continue;
    placed.push(rect);
    const a = Math.min(1, (z - 0.1) / 0.3);
    const nearX = dir < 0 ? lx + tw + 2 : lx - 2;
    ctx.globalAlpha = a * 0.5;
    ctx.strokeStyle = NEWS_STEEL; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nearX, ly); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.stroke();
    ctx.globalAlpha = a;
    ctx.fillStyle = NEWS_STEEL;
    ctx.beginPath(); ctx.arc(x, y, 1.9, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "#aab8c6";
    ctx.fillText(name, lx, ly);
  }
  ctx.globalAlpha = 1;
  try { ctx.letterSpacing = "0px"; } catch (e) { /* older canvas */ }

  // News event pins: where each story sits on the map. Warm gold markers with
  // a glow halo + expanding ping, deliberately distinct from the steel city
  // dots so the STORIES stand out. Store the projection for click hit-testing.
  // Selected and hovered pins grow and burn brighter.
  for (let i = 0; i < g.events.length; i++) {
    const pr = newsProj(g.events[i].sp, sinL0, cosL0, sinT, cosT);
    g.ex[i] = cx + Rg * pr[0]; g.ey[i] = cy - Rg * pr[1]; g.ez[i] = pr[2];
    if (pr[2] <= 0) continue;
    const x = g.ex[i], y = g.ey[i];
    const seld = (i === g.sel), hot = seld || (i === g.hl);
    const dep = 0.5 + 0.5 * pr[2];                   // depth fade
    const pulse = (g.phase + i * 0.097) % 1;         // staggered ping
    // Expanding ping ring.
    ctx.globalAlpha = (1 - pulse) * (seld ? 0.75 : 0.42) * dep;
    ctx.strokeStyle = "#f2b34e";
    ctx.lineWidth = seld ? 1.7 : 1.1;
    ctx.beginPath(); ctx.arc(x, y, 4 + pulse * (seld ? 17 : 11), 0, Math.PI*2); ctx.stroke();
    // Soft glow halo.
    const gr = hot ? (seld ? 16 : 13) : 9;
    const halo = ctx.createRadialGradient(x, y, 0, x, y, gr);
    halo.addColorStop(0, "rgba(242,179,78," + (0.55 * dep) + ")");
    halo.addColorStop(1, "rgba(242,179,78,0)");
    ctx.globalAlpha = 1; ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(x, y, gr, 0, Math.PI*2); ctx.fill();
    // Core.
    const cr = seld ? 4.4 : (hot ? 3.8 : 3.1);
    ctx.globalAlpha = 0.72 + 0.28 * pr[2];
    ctx.fillStyle = seld ? "#fff3d8" : "#ffd88f";
    ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = "#e79a2e"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI*2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Headline chip beside the selected pin (or the hovered one if none selected).
  const chipI = g.sel >= 0 ? g.sel : g.hl;
  if (chipI >= 0 && chipI < g.events.length && g.ez[chipI] > 0.05) {
    const e = g.events[chipI], x = g.ex[chipI], y = g.ey[chipI];
    ctx.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    let lab = e.headline;
    const maxw = 260;
    while (lab.length > 5 && ctx.measureText(lab).width > maxw) lab = lab.slice(0, -2);
    if (lab !== e.headline) lab = lab.slice(0, -1) + "…";
    const tw = ctx.measureText(lab).width;
    const bx = x + 12, by = y - 10;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "rgba(10,16,26,0.85)";
    ctx.fillRect(bx - 6, by - 12, tw + 12, 24);
    ctx.strokeStyle = "rgba(226,182,97,0.5)"; ctx.lineWidth = 1;
    ctx.strokeRect(bx - 6, by - 12, tw + 12, 24);
    ctx.fillStyle = "#eef2f6";
    ctx.fillText(lab, bx, by);
    ctx.globalAlpha = 1;
  }

  // Ease toward a focused event when one is picked; otherwise auto-spin.
  // Dragging always wins and cancels any focus glide.
  if (g.drag) {
    g.tLon = null; g.tTilt = null;
  } else if (g.tLon !== null) {
    g.lon0 += (g.tLon - g.lon0) * 0.12;
    g.tilt += (g.tTilt - g.tilt) * 0.12;
    // Focusing brings the pin to the disc centre, so glide any zoom pan back
    // to centred too, or a focused story can land outside the panel.
    if (g.panX || g.panY) {
      g.panX *= 0.85; g.panY *= 0.85;
      if (Math.abs(g.panX) < 0.5 && Math.abs(g.panY) < 0.5) { g.panX = 0; g.panY = 0; }
      newsApplyView();
    }
    if (Math.abs(g.tLon - g.lon0) < 0.002 && Math.abs(g.tTilt - g.tilt) < 0.002) {
      g.lon0 = g.tLon; g.tilt = g.tTilt; g.tLon = null; g.tTilt = null;
    }
  } else {
    g.lon0 += 0.0016;
  }
  g.phase = (g.phase + 0.004) % 1;
}

function newsTick() {
  const g = newsGlobe;
  // Event-driven pause: no repaint when the tab is hidden or the page is
  // off-screen (no CPU in a backgrounded terminal).
  if (document.hidden || $("news").classList.contains("hidden")) {
    g.raf = 0; g.started = false; return;
  }
  newsDraw();
  g.raf = requestAnimationFrame(newsTick);
}

// Grab to move freely: horizontal drag spins (lon0), vertical drag tilts the
// pole (tilt). Tilt is clamped to +/- 90 deg so you can look straight at either
// pole but the globe never flips upside down (which inverts the drag feel).
const NEWS_TILT_MAX = Math.PI / 2;
function newsWireDrag() {
  const g = newsGlobe, wrap = g.canvas.parentElement;
  g.canvas.addEventListener("pointerdown", (e) => {
    g.drag = { x: e.clientX, y: e.clientY, lon0: g.lon0, tilt: g.tilt, moved: 0 };
    wrap.classList.add("dragging");
    g.canvas.setPointerCapture(e.pointerId);
  });
  g.canvas.addEventListener("pointermove", (e) => {
    if (g.drag) {
      g.drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      // Divide by zoom: a pixel of drag must always move the surface the same
      // distance under the finger, otherwise a zoomed-in globe spins wildly.
      const rate = 0.006 / g.zoom;
      g.lon0 = g.drag.lon0 - (e.clientX - g.drag.x) * rate;
      g.tilt = Math.max(-NEWS_TILT_MAX, Math.min(NEWS_TILT_MAX,
        g.drag.tilt + (e.clientY - g.drag.y) * rate));
      return;
    }
    // Not dragging: hover-highlight the pin under the cursor and mirror it in
    // the feed, so mousing the globe lights up the matching headline too.
    const hit = newsPinAt(e);
    if (hit !== g.hl) {
      g.hl = hit; newsMarkFeed();
      g.canvas.style.cursor = hit >= 0 ? "pointer" : "grab";
    }
  });
  const end = (e) => {
    // A tap that barely moved is a click: hit-test the news pins and focus the
    // nearest one within reach, or clear the selection if the tap missed.
    if (g.drag && g.drag.moved < 5) newsHitTest(e);
    g.drag = null; wrap.classList.remove("dragging");
  };
  g.canvas.addEventListener("pointerup", end);
  g.canvas.addEventListener("pointercancel", () => { g.drag = null; wrap.classList.remove("dragging"); });

  // Wheel / trackpad-pinch zoom, anchored on the cursor. passive:false because
  // we must preventDefault: otherwise the wheel scrolls the page and a pinch
  // (which arrives as ctrlKey+wheel) zooms the whole Electron window instead
  // of the globe. deltaMode is normalised so a line/page-mode mouse does not
  // jump the whole range in one notch.
  g.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;        // lines
    else if (e.deltaMode === 2) d *= g.H;  // pages
    // Pinch deltas are small and continuous, wheel notches are coarse. One
    // notch is ~1.15x, so the full 1x..6x range is a dozen notches, not three.
    const k = e.ctrlKey ? 0.008 : 0.0012;
    const r = g.canvas.getBoundingClientRect();
    newsZoomAt(Math.exp(-d * k), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Double-click empty ocean to snap back to the fitted view. A double-click
  // on a pin still focuses it (the first click already did), so only reset
  // when the pointer is not over one.
  g.canvas.addEventListener("dblclick", (e) => {
    if (newsPinAt(e) >= 0) return;
    g.zoom = 1; g.panX = 0; g.panY = 0;
    newsApplyView();
  });
}

// The front-facing event pin nearest the pointer within 16px, or -1.
function newsPinAt(e) {
  const g = newsGlobe, r = g.canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  let best = -1, bestD = 16 * 16;
  for (let i = 0; i < g.events.length; i++) {
    if (g.ez[i] <= 0) continue;
    const dx = g.ex[i] - px, dy = g.ey[i] - py, d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Click hit-test: focus the pin under the pointer, else clear the selection.
function newsHitTest(e) {
  const hit = newsPinAt(e);
  if (hit >= 0) newsFocusEvent(hit, true);
  else { newsGlobe.sel = -1; newsMarkFeed(); }
}

// Escape helper for feed HTML (headlines/summaries are LLM output; source is a
// domain): text and attribute contexts both, so a stray quote/bracket can't
// break out. Our own pipeline is the source, but treat it as untrusted anyway.
function newsEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// GDELT seendate "20260705T170000Z" -> "3h ago".
function newsAgo(sd) {
  if (!sd || sd.length < 13) return "";
  const t = Date.UTC(+sd.slice(0,4), +sd.slice(4,6)-1, +sd.slice(6,8), +sd.slice(9,11), +sd.slice(11,13));
  const diff = (Date.now() - t) / 1000;
  if (diff < 3600) return Math.max(1, Math.round(diff/60)) + "m ago";
  if (diff < 86400) return Math.round(diff/3600) + "h ago";
  return Math.round(diff/86400) + "d ago";
}

// ---------- LSE NEWSROOM articles -----------------------------------------
// Our own written articles, stacked above the wire headlines. Same static-
// asset contract as the wire: /assets/news/articles.json + /assets/news/img.
const newsPosts = { list: [], open: "" };

// ISO timestamps (the posts carry timezone-aware isoformat), unlike the
// wire's GDELT compact form that newsAgo() parses.
function newsAgoIso(iso) {
  const t = Date.parse(iso || "");
  if (isNaN(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + "m ago";
  if (diff < 86400) return Math.round(diff / 3600) + "h ago";
  return Math.round(diff / 86400) + "d ago";
}

function newsApplyArticles(doc) {
  if (!doc || !Array.isArray(doc.posts)) return;
  newsPosts.list = doc.posts;
  newsRenderArticles();
}

// Static-file path, kept for engines that predate /api/news/feed (the frozen
// desktop sidecar until its next rebuild) and as the offline fallback.
function newsLoadArticles() {
  fetch("/assets/news/articles.json?t=" + Date.now())
    .then((r) => (r.ok ? r.json() : null))
    .then(newsApplyArticles)
    .catch(() => { /* no articles yet: the empty state stands */ });
}

/* Live-first: /api/news/feed serves the hourly wire + the
   newsroom posts from the LSE API, so a downloaded terminal sees the current
   headlines without any file ever being copied to it (the static files were
   only ever pushed to one PC). The engine itself falls back to the shipped
   files when offline; the catch here covers OLD engines that 404 the route,
   which then read the two static files exactly as before. */
function newsLoadFeed() {
  fetch("/api/news/feed")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no news feed endpoint"))))
    .then((doc) => { newsApplyWire(doc); newsApplyArticles(doc); })
    .catch(() => { newsLoadWire(); newsLoadArticles(); });
}

function newsRenderArticles() {
  const body = $("news-articles-body");
  if (!body) return;
  if (!newsPosts.list.length) {
    body.innerHTML = '<div class="news-empty">No articles yet.</div>';
    return;
  }
  let h = "";
  for (const p of newsPosts.list) {
    h += '<div class="news-item" data-slug="' + newsEsc(p.slug) + '">'
      + '<div class="news-thumb"><img loading="lazy" src="' + newsEsc(p.image || "") + '" alt=""'
      + ' onerror="this.parentNode.classList.add(\'noimg\')"></div>'
      + '<div class="news-b"><div class="nh">' + newsEsc(p.headline) + '</div>'
      + '<div class="ns">' + newsEsc(p.dek || "") + '</div>'
      + '<div class="nm">' + newsEsc((p.category || "").toUpperCase()) + ' &middot; '
      + newsEsc(newsAgoIso(p.published_at)) + '</div>'
      + '</div></div>';
  }
  body.innerHTML = h;
  for (const el of body.querySelectorAll(".news-item")) {
    el.addEventListener("click", () => newsOpenReader(el.dataset.slug));
  }
}

// Minimal markdown for the article body: escape everything, then allow the
// **bold** the writer prompt permits. Paragraphs split on blank lines.
function newsBodyHtml(md) {
  return String(md || "").split(/\n\s*\n/).map((p) =>
    "<p>" + newsEsc(p.trim()).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>") + "</p>"
  ).join("");
}

function newsOpenReader(slug) {
  const p = newsPosts.list.find((x) => x.slug === slug);
  if (!p) return;
  newsPosts.open = slug;
  $("news-reader-cat").textContent = p.category || "";
  $("news-reader-title").textContent = p.headline;
  let h = "<h1>" + newsEsc(p.headline) + "</h1>"
    + '<div class="nr-meta">' + newsEsc(newsAgoIso(p.published_at))
    + (p.symbols && p.symbols.length ? " &middot; " + newsEsc(p.symbols.join(" ")) : "")
    + "</div>";
  if (p.dek) h += '<p class="nr-dek">' + newsEsc(p.dek) + "</p>";
  if (p.image) {
    h += '<img class="nr-img" src="' + newsEsc(p.image) + '" alt=""'
      + ' onerror="this.style.display=\'none\'">';
    // Licence attribution is a condition of using the photo, so the credit
    // renders whenever the image does.
    const credit = newsEsc(p.image_credit || "");
    if (credit) {
      h += '<div class="nr-credit">' + (p.image_credit_url
        ? '<a href="' + newsEsc(p.image_credit_url) + '" target="_blank" rel="noopener noreferrer">' + credit + "</a>"
        : credit) + "</div>";
    }
  }
  h += '<div class="nr-body">' + newsBodyHtml(p.body_md) + "</div>";
  const srcs = (p.sources || []).map((s) =>
    '<a href="' + newsEsc(s.url) + '" target="_blank" rel="noopener noreferrer">'
    + newsEsc(s.name) + "</a>").join(" &middot; ");
  if (srcs) h += '<div class="nr-sources">Reporting: ' + srcs + "</div>";
  $("news-reader-body").innerHTML = h;
  $("news-reader-scroll").scrollTop = 0;
  $("news-globe-wrap").classList.add("hidden");
  $("news-feed").classList.add("hidden");
  $("news-reader").classList.remove("hidden");
}

function newsCloseReader() {
  newsPosts.open = "";
  $("news-reader").classList.add("hidden");
  $("news-globe-wrap").classList.remove("hidden");
  $("news-feed").classList.remove("hidden");
  // The globe canvas was display:none while reading; re-measure it.
  newsResize();
}

// Render the headline feed from the loaded wire.
function newsRenderFeed() {
  const g = newsGlobe, body = $("news-feed-body");
  if (!g.events.length) {
    body.innerHTML = '<div class="news-empty">No news source connected.</div>';
    return;
  }
  let h = "";
  for (let i = 0; i < g.events.length; i++) {
    const e = g.events[i];
    h += '<div class="news-item" data-i="' + i + '">'
      + '<div class="news-thumb"><img loading="lazy" src="' + newsEsc(e.image) + '" alt=""'
      + ' onerror="this.parentNode.classList.add(\'noimg\')"></div>'
      + '<div class="news-b"><div class="nh">' + newsEsc(e.headline) + '</div>'
      + '<div class="ns">' + newsEsc(e.summary) + '</div>'
      + '<div class="nm">' + newsEsc(e.source) + ' &middot; ' + newsEsc(newsAgo(e.seendate)) + '</div>'
      + '</div></div>';
  }
  body.innerHTML = h;
  for (const el of body.querySelectorAll(".news-item")) {
    const idx = +el.dataset.i;
    el.addEventListener("click", () => newsFocusEvent(idx, true));
    // Hovering a headline lights up its pin on the globe.
    el.addEventListener("mouseenter", () => { newsGlobe.hl = idx; newsMarkFeed(); });
    el.addEventListener("mouseleave", () => { if (newsGlobe.hl === idx) { newsGlobe.hl = -1; newsMarkFeed(); } });
  }
  newsMarkFeed();
}

// Reflect the selection in the feed (highlight + scroll into view).
function newsMarkFeed(scroll) {
  const body = $("news-feed-body");
  if (!body) return;
  for (const el of body.querySelectorAll(".news-item")) {
    const i = +el.dataset.i, on = (i === newsGlobe.sel);
    el.classList.toggle("sel", on);
    el.classList.toggle("hl", i === newsGlobe.hl && !on);
    if (on && scroll) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// Focus an event: select it, glide the globe so its pin faces the viewer, and
// sync the feed. fromFeed=true also scrolls the feed row into view.
function newsFocusEvent(i, fromFeed) {
  const g = newsGlobe;
  if (i < 0 || i >= g.events.length) return;
  g.sel = i;
  const e = g.events[i], D2R = Math.PI / 180;
  let diff = e.lon * D2R - g.lon0;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // shortest way round
  g.tLon = g.lon0 + diff;
  g.tTilt = Math.max(-NEWS_TILT_MAX, Math.min(NEWS_TILT_MAX, e.lat * D2R));
  newsMarkFeed(fromFeed);
}

// Fetch the wire (cache-busted) and plot it. Cheap enough to call on every
// open so the feed refreshes when the pipeline has produced newer events.
function newsApplyWire(doc) {
  const g = newsGlobe;
  if (!doc || !Array.isArray(doc.events)) return;
  g.events = doc.events.map((e) => Object.assign({}, e, { sp: newsMk(e.lon, e.lat) }));
  g.ex = new Float32Array(g.events.length);
  g.ey = new Float32Array(g.events.length);
  g.ez = new Float32Array(g.events.length);
  if (g.sel >= g.events.length) g.sel = -1;
  g.wireLoaded = true;
  newsRenderFeed();
}

function newsLoadWire() {
  fetch("/assets/news/news_wire.json?t=" + Date.now())
    .then((r) => (r.ok ? r.json() : null))
    .then(newsApplyWire)
    .catch(() => { /* no wire yet: feed keeps its empty state */ });
}

// Load the assets and precompute all geometry once. Fails silently to
// whatever loaded (a 404 just means that layer is absent, never a crash).
async function newsBuildGlobe() {
  const g = newsGlobe;
  const loadImg = (src) => new Promise((res) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
  const loadJson = (src) =>
    fetch(src).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  const [landImg, nightImg, coast, rivers, borders] = await Promise.all([
    loadImg("/assets/globe/earth-land.png"),
    loadImg("/assets/globe/earth-night.jpg"),
    loadJson("/assets/globe/ne_50m_coastline.geojson"),
    loadJson("/assets/globe/ne_50m_rivers_lake_centerlines.geojson"),
    loadJson("/assets/globe/ne_50m_admin_0_boundary_lines_land.geojson"),
  ]);
  newsAddLines(coast, g.coast);
  newsAddLines(rivers, g.rivers);
  newsAddLines(borders, g.borders);

  const read = (im) => {
    if (!im) return null;
    const c = document.createElement("canvas");
    c.width = im.width; c.height = im.height;
    const cc = c.getContext("2d");
    if (!cc) return null;
    cc.drawImage(im, 0, 0);
    return { data: cc.getImageData(0, 0, im.width, im.height).data, w: im.width, h: im.height };
  };
  const land = read(landImg), night = read(nightImg);

  // Sample land on a lat/lon grid; one dot per land cell, brighter "power"
  // dot where the night image burns above threshold.
  //
  // Sampled at HALF the drawn spacing, split into two sets: every other row
  // and column is the coarse set (the original 1.6 deg grid, what 1x draws),
  // the rest goes to the fine set which only joins in once zoomed past
  // NEWS_FINE_ZOOM. Dot spacing is fixed on the sphere, so without this a
  // zoomed-in continent thins out into scattered specks and stops reading as
  // land; drawing the fine set at 1x would just be 4x the fill for no visible
  // gain.
  const STEP = 0.8;
  let row = 0;
  for (let lat = -84; lat <= 84; lat += STEP, row++) {
    const lonStep = STEP / Math.max(0.25, Math.cos(lat * NEWS_D2R));
    let col = 0;
    for (let lon = -180; lon < 180; lon += lonStep, col++) {
      let isLand = true;
      if (land) {
        const mx = Math.min(land.w - 1, (((lon + 180) / 360) * land.w) | 0);
        const my = Math.min(land.h - 1, (((90 - lat) / 180) * land.h) | 0);
        isLand = land.data[(my * land.w + mx) * 4] > 128;
      }
      if (!isLand) continue;
      const coarse = (row % 2 === 0) && (col % 2 === 0);
      const p = newsMk(lon, lat);
      (coarse ? g.dots : g.dotsFine).push(p);
      if (night) {
        const mx = Math.min(night.w - 1, (((lon + 180) / 360) * night.w) | 0);
        const my = Math.min(night.h - 1, (((90 - lat) / 180) * night.h) | 0);
        const ni = (my * night.w + mx) * 4;
        const lum = 0.299*night.data[ni] + 0.587*night.data[ni+1] + 0.114*night.data[ni+2];
        if (lum > 14) (coarse ? g.power : g.powerFine).push({ p, t: Math.min(1, (lum - 14) / 150) });
      }
    }
  }

  // Network nodes = the labelled cities; wire each to its 3 nearest.
  g.cityNodes = NEWS_CITIES.map((c) => ({ name: c.name, sp: newsMk(c.lon, c.lat) }));
  for (const c of g.cityNodes) g.hubs.push(c.sp);
  const d2 = (a, b) => {
    const dx = a[0]*a[2] - b[0]*b[2], dy = a[1] - b[1], dz = a[0]*a[3] - b[0]*b[3];
    return dx*dx + dy*dy + dz*dz;
  };
  const eset = new Set();
  for (let i = 0; i < g.hubs.length; i++) {
    const near = [];
    for (let j = 0; j < g.hubs.length; j++) if (j !== i) near.push({ j, d: d2(g.hubs[i], g.hubs[j]) });
    near.sort((x, y) => x.d - y.d);
    for (let k = 0; k < Math.min(3, near.length); k++) {
      const j = near[k].j, lo = Math.min(i, j), hi = Math.max(i, j), key = lo*1000 + hi;
      if (!eset.has(key)) { eset.add(key); g.edges.push([lo, hi]); }
    }
  }
  g.hx = new Float32Array(g.hubs.length);
  g.hy = new Float32Array(g.hubs.length);
  g.hz = new Float32Array(g.hubs.length);
  g.built = true;
}

function showNewsPage(ctx) {
  // The same NEWS page is reachable from MARKETS and from ECONOMIC (news and
  // the economic calendar overlap), so mark whichever subrail it was opened
  // from and hide every other section regardless of the entry point.
  if (ctx === "econ") renderSubrail("econ", "sub-ec-news");
  else subrailMark("sub-mk-news");
  document.title = "News · LSE Terminal";
  // Full-page like OPTIONS: the watchlist is chart context, hide it.
  $("side").classList.add("hidden");
  $("charts").classList.add("hidden");
  $("optpage").classList.add("hidden");
  $("scrpage").classList.add("hidden");
  $("econcal").classList.add("hidden");
  $("dataviz").classList.add("hidden");
  $("nbpage").classList.add("hidden");
  $("mlpage").classList.add("hidden");
  $("pyide").classList.add("hidden");
  $("wsx").classList.add("hidden");
  $("mydata").classList.add("hidden");
  $("lse-connect").classList.add("hidden");
  $("research").classList.add("hidden");
  $("guide").classList.add("hidden");
  $("news").classList.remove("hidden");

  // Leaving and re-entering the page always lands on the list view; a stale
  // open reader from the previous visit would hide the globe silently.
  if (newsPosts.open) newsCloseReader();

  // Fetch + render the feed FIRST, before the globe's heavy synchronous build
  // (geojson parse + land sampling) can block the main thread. Live feed
  // first, static files behind it (see newsLoadFeed).
  newsLoadFeed();

  const g = newsGlobe;
  if (!g.canvas) {
    g.canvas = $("news-globe");
    newsResize();
    newsWireDrag();
    $("news-reader-back").addEventListener("click", newsCloseReader);
    // Re-measure on container resize (AI-rail toggle, window drag).
    if (window.ResizeObserver) {
      g.ro = new ResizeObserver(() => newsResize());
      g.ro.observe(g.canvas.parentElement);
    }
    // Restart the tick when the tab returns to the foreground.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !g.started && !$("news").classList.contains("hidden")) {
        g.started = true; g.raf = requestAnimationFrame(newsTick);
      }
    });
    // Fire the asset load; the arrays fill in when ready and the already
    // running loop picks them up. Starting the loop BEFORE the build (below)
    // paints the sphere + rim immediately, so the ~5s cold build reads as the
    // globe filling in rather than a blank panel.
    newsBuildGlobe();
  }
  newsResize();
  if (!g.started) { g.started = true; g.raf = requestAnimationFrame(newsTick); }
}

function optInit() {
  if (optState.wired) return;
  optState.wired = true;
  optLoadPrefs();
  $("opt-strikes").value = String(optState.strikes);
  $("opt-greeks").classList.toggle("active", optState.greeks);
  // Debounced: a keystroke re-filters 3.2k rows and repaints the rail, and at
  // typing speed the un-debounced version queued one of those per character.
  // A new query always restarts at the first chunk.
  $("opt-filter").addEventListener("input", () => {
    clearTimeout(optState.filterTimer);
    optState.filterTimer = setTimeout(() => optRenderList(false, true), 120);
  });
  ovWireHover();
  $("opt-expiry").onchange = async (e) => {
    optState.expiry = e.target.value;
    optRenderChain(optState.chainRows); // instant paint from the cached fetch
    // Refetch just this expiry: the all-expiries fetch is row-capped
    // upstream, so a dense chain can arrive with a far expiry truncated;
    // a single-expiry fetch never is. The seq token makes this fetch part
    // of the same freshness ordering as optRefresh: without it, a Refresh
    // or 30s poll landing mid-flight would be spliced over with these
    // older rows (identity checks alone cannot see that interleaving).
    const seq = ++optState.seq;
    const und = optState.und, exp = optState.expiry;
    try {
      const r = await fetch(`/api/options/chain?underlying=${encodeURIComponent(und)}` +
                            `&expiry=${encodeURIComponent(exp)}`);
      if (!r.ok) return;
      const rows = await r.json();
      if (seq === optState.seq && rows.length &&
          und === optState.und && exp === optState.expiry) {
        optState.chainRows = optState.chainRows
          .filter((x) => x.expiry !== exp).concat(rows);
        optRenderChain(optState.chainRows);
      }
    } catch (err) { /* the cached paint stays */ }
  };
  // Layout controls repaint from the cached fetch; nothing refetches.
  $("opt-strikes").onchange = (e) => {
    const v = e.target.value;
    optState.strikes = v === "" ? "" : v === "auto" ? "auto" : Number(v);
    optSavePrefs();
    // A width change can grow the board from fits-on-screen to hundreds of
    // rows; dropping the paint key makes the repaint re-centre the money.
    optState.paintKey = "";
    if (optState.view === "chain" && optState.und) optRenderChain(optState.chainRows);
  };
  $("opt-greeks").onclick = () => {
    optState.greeks = !optState.greeks;
    $("opt-greeks").classList.toggle("active", optState.greeks);
    optSavePrefs();
    if (optState.view === "chain" && optState.und) optRenderChain(optState.chainRows);
  };
  $("opt-type").onchange = () => optRefresh();
  $("opt-minprem").onchange = () => optRefresh();
  $("opt-view-chain").onclick = () => optSetView("chain");
  $("opt-view-flow").onclick = () => optSetView("flow");
  $("opt-refresh").onclick = () => optRefresh();
  // One delegated listener on the page covers every clickable symbol
  // (rail rows AND flow-tape syms): repaints never re-wire. A tape click
  // jumps to the chain; a rail click stays in whichever view is open, so
  // browsing symbols while watching the tape filters the tape.
  $("optpage").addEventListener("click", (e) => {
    const pick = e.target.closest("td[data-osel]");
    if (pick) { ovSelect(pick.getAttribute("data-osel")); return; }
    const el = e.target.closest("[data-opt-und]");
    if (!el) return;
    const fromTape = !!el.closest("#opt-body");
    optState.und = el.getAttribute("data-opt-und") || "";
    optState.expiry = "";
    ovClearSel(); // the picked contract belongs to the old board
    optSavePrefs();
    optMarkActive();
    if (fromTape && optState.view !== "chain") optSetView("chain"); // setView refreshes
    else optRefresh();
  });
  optLoadUnderlyings();
  // Quiet auto-refresh at the server's own cache cadence (15s); only while
  // the page is on screen and the window is visible, so a background
  // terminal never polls the chain for nobody.
  setInterval(() => {
    if (!$("optpage").classList.contains("hidden") && !document.hidden) {
      optRefresh(true);
    }
  }, 15000);
}

function optSetView(view) {
  optState.view = view;
  $("opt-view-chain").classList.toggle("active", view === "chain");
  $("opt-view-flow").classList.toggle("active", view === "flow");
  $("opt-expiry").classList.toggle("hidden", view !== "chain");
  $("opt-strikes").classList.toggle("hidden", view !== "chain");
  $("opt-greeks").classList.toggle("hidden", view !== "chain");
  $("opt-minprem").classList.toggle("hidden", view !== "flow");
  $("opt-type").classList.toggle("hidden", view !== "flow");
  optRefresh();
}

async function optLoadUnderlyings() {
  try {
    const r = await fetch("/api/options/underlyings");
    if (!r.ok) { optRenderList(); return; } // keyless: rail shows the hint
    optState.unds = await r.json();
  } catch (e) { /* rail falls back to its connect hint */ }
  optRenderList(true);
  // Company logos ride in after the list paints (same map the watchlist
  // uses); rows re-render once with images over their monogram fallbacks.
  try {
    const r = await fetch("/api/logos?provider=lse");
    if (r.ok) {
      optState.logos = await r.json();
      optRenderList();
    }
  } catch (e) { /* monograms stay */ }
}

/* The symbol rail: ALL (whole tape) pinned first, then every optionable
   underlying in the API's own most-active order, narrowed by the filter
   box. The API suffixes every name with " options"; that is chain-page
   noise, strip it for display. */
/* Rows per reveal in the symbol rail (same idea as the sidebar folders).
   The tape lists 3,186 optionable underlyings; rendering them all cost ~92ms
   per paint and ~19k DOM nodes, and since the filter box re-rendered on every
   keystroke, typing a ticker cost ~104ms a character (measured). */
const OPT_LIST_CHUNK = 150;

function optRenderList(firstLoad, resetChunk) {
  const list = $("opt-list");
  if (!optState.unds.length) {
    list.innerHTML = '<div class="opt-side-note">Connect your LSE key to list option symbols.</div>';
    return;
  }
  const q = ($("opt-filter").value || "").trim().toUpperCase();
  const rows = q
    ? optState.unds.filter((u) =>
        (u.symbol || "").toUpperCase().includes(q) ||
        (u.name || "").toUpperCase().includes(q))
    : optState.unds;
  optState.listRows = rows;
  if (resetChunk || !optState.listShown) optState.listShown = OPT_LIST_CHUNK;
  const shown = rows.slice(0, Math.min(optState.listShown, rows.length));
  // A repaint used to drop the rail back to the top, so picking a symbol from
  // deep in the tape lost your place in it. Restore the offset after the swap.
  const keepScroll = list.scrollTop;
  const name = (u) => (u.name || "").replace(/\s+options$/i, "");
  // Same logo treatment as the watchlist: image over a monogram, so every
  // row carries SOME mark and a missing logo never shows a broken glyph.
  const dark = document.documentElement.classList.contains("dark");
  const logo = (sym) => {
    const lg = optState.logos[sym];
    const src = lg ? optAttr(String(dark ? lg.dark : lg.light)) : "";
    return `<span class="wlogo">` +
      (src ? `<img src="${src}" alt="" loading="lazy" onerror="this.remove()">` : "") +
      `<span class="winit">${aiEscape((sym[0] || "").toUpperCase())}</span></span>`;
  };
  list.innerHTML =
    `<button class="opt-und-row${optState.und ? "" : " active"}" data-opt-und="">` +
    `<b>ALL</b><span>whole market</span></button>` +
    shown.map((u) =>
      `<button class="opt-und-row${u.symbol === optState.und ? " active" : ""}"` +
      ` data-opt-und="${optAttr(u.symbol)}" title="${optAttr(name(u))}">` +
      `${logo(u.symbol)}<b>${aiEscape(u.symbol)}</b>` +
      `<span>${aiEscape(name(u))}</span></button>`).join("") +
    (q && !rows.length ? '<div class="opt-side-note">No symbol matches.</div>' : "");
  list.scrollTop = keepScroll;
  optWireGrow();
  // Bring the restored symbol into view once on load; nearest-block keeps
  // later repaints from yanking a list the user is scrolling.
  if (firstLoad && optState.und) {
    // The restored symbol can sit past the first chunk; reveal up to it so
    // scrollIntoView has something to scroll to.
    const at = rows.findIndex((u) => u.symbol === optState.und);
    if (at >= optState.listShown) {
      optState.listShown = Math.ceil((at + 1) / OPT_LIST_CHUNK) * OPT_LIST_CHUNK;
      optRenderList(false);
    }
    const el = list.querySelector(".opt-und-row.active");
    if (el) el.scrollIntoView({ block: "nearest" });
  }
}

/* Reveal the next slice of the rail as its scroll nears the bottom. */
function optWireGrow() {
  const list = $("opt-list");
  if (list._optGrowWired) return;
  list._optGrowWired = true;
  list.addEventListener("scroll", () => {
    const rows = optState.listRows || [];
    if (optState.listShown >= rows.length) return;
    if (list.scrollTop + list.clientHeight < list.scrollHeight - 300) return;
    optState.listShown += OPT_LIST_CHUNK;
    optRenderList(false);
  });
}

/* Selection only: move the highlight instead of rebuilding 3,000 buttons.
   Picking a symbol used to re-render the whole rail (and, before the scroll
   restore above, throw the reader back to the top of the tape). */
function optMarkActive() {
  for (const b of $("opt-list").querySelectorAll(".opt-und-row")) {
    b.classList.toggle("active", (b.getAttribute("data-opt-und") || "") === optState.und);
  }
}

async function optRefresh(quiet) {
  const body = $("opt-body");
  const chain = optState.view === "chain";
  if (chain && !optState.und) {
    body.innerHTML = '<div class="opt-empty">Pick a symbol from the list to load its chain. ' +
      'The Flow tab needs no symbol: it sweeps the whole market.</div>';
    $("opt-viz").classList.add("hidden");
    $("opt-note").textContent = "";
    return;
  }
  if (!quiet) body.innerHTML = '<div class="opt-empty">Loading&hellip;</div>';
  const seq = ++optState.seq;
  const url = chain
    ? `/api/options/chain?underlying=${encodeURIComponent(optState.und)}`
    : `/api/options/flow?underlying=${encodeURIComponent(optState.und)}` +
      `&type=${encodeURIComponent($("opt-type").value)}` +
      `&min_premium=${$("opt-minprem").value || 0}&limit=300`;
  let rows;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      let msg = `request failed (HTTP ${r.status})`;
      try { msg = (await r.json()).detail || msg; } catch (e) { /* keep msg */ }
      throw new Error(msg);
    }
    rows = await r.json();
  } catch (e) {
    if (!quiet && seq === optState.seq) {
      // The upstream rejects non-ticker charsets (spaces, punctuation) with
      // a nested proxy error ("options request failed: [400] {...bad
      // underlying...}"); a fat-fingered symbol deserves the human version.
      // Every other error stays verbatim, it is real signal.
      const msg = String(e.message || e);
      body.innerHTML = `<div class="opt-empty">${aiEscape(
        /bad underlying/i.test(msg)
          ? `No options listed under "${optState.und}". Check the ticker symbol.`
          : msg)}</div>`;
      $("opt-viz").classList.add("hidden"); // stale analytics over an error lie
    }
    return;
  }
  if (seq !== optState.seq) return; // a newer request already painted
  if (chain) {
    optState.chainRows = rows;
    optRenderChain(rows, quiet);
  } else {
    optRenderFlow(rows, quiet);
  }
}

/* Cell formatters. "-" (plain hyphen) is the empty cell, matching the
   watchlist price board. */
function optNum(v, dp) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "-";
  const s = Number(v).toFixed(dp);
  // A tiny negative rounds to "-0.00"; show it unsigned.
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}
/* Strikes arrive as floats and can carry representation noise
   (504.99999999999994); 3dp covers every real strike increment. */
function optStrike(k) {
  return String(+Number(k).toFixed(3));
}
function optMoney(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
  return "$" + Math.round(n);
}
function optIv(v) {
  return (v === null || v === undefined) ? "-" : (Number(v) * 100).toFixed(1) + "%";
}
function optVol(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US");
}
/* "14:32:07" for today's stamps, "Jul 22, 14:32" for older ones: quiet
   contracts carry last trades that can be days old, and a bare clock time
   would silently pass them off as fresh. */
function optWhen(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "-";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString()
    : d.toLocaleString(undefined, { month: "short", day: "numeric",
                                    hour: "2-digit", minute: "2-digit" });
}
/* Days to expiry from the date itself: the row's stored dte is stamped at
   its last update and goes stale with it (see providers/lse.py). Ceil, not
   round: rounding the now->midnight delta relabels tomorrow as "today" for
   the whole second half of the UTC day. */
function optDte(expiry) {
  if (!expiry) return "-";
  const d = Math.ceil((Date.parse(expiry + "T00:00:00Z") - Date.now()) / 86400000);
  if (Number.isNaN(d)) return "-";
  return d <= 0 ? "today" : d + "d";
}

function optRenderChain(rows, quiet) {
  const body = $("opt-body");
  if (!rows || !rows.length) {
    if (quiet) return; // a silent poll never blanks a board someone is reading
    // Clear the expiry list too: left alone it keeps advertising the
    // PREVIOUS underlying's dates against this one's empty board.
    $("opt-expiry").innerHTML = "";
    optState.expiry = "";
    body.innerHTML = '<div class="opt-empty">No live contracts for this underlying.</div>';
    $("opt-viz").classList.add("hidden");
    $("opt-note").textContent = "";
    return;
  }
  const expiries = [...new Set(rows.map((r) => r.expiry))].filter(Boolean).sort();
  // A quiet 30s poll must never hijack the view: if the selected expiry is
  // absent from this fetch (0DTE rolling off intraday, or the upstream row
  // cap shuffling which expiries survive), keep the board the user is
  // reading instead of silently switching dates and re-centring the scroll.
  if (quiet && optState.expiry && !expiries.includes(optState.expiry)) return;
  const want = expiries.includes(optState.expiry) ? optState.expiry : expiries[0];
  optState.expiry = want;
  $("opt-expiry").innerHTML = expiries.map((e) =>
    `<option value="${e}"${e === want ? " selected" : ""}>${e} &middot; ${optDte(e)}</option>`).join("");
  const sub = rows.filter((r) => r.expiry === want);
  // Spot from the FRESHEST row in the whole chain: each row carries the
  // underlying price as of its own last update, and an untraded contract
  // can be weeks stale (a SPY row once said 749.98 against a real ~706).
  let spot = null, spotAt = "";
  for (const r of rows) {
    const at = String(r.updated_at || r.last_trade_at || "");
    if (r.underlying_price != null && at >= spotAt) {
      spot = r.underlying_price;
      spotAt = at;
    }
  }
  const byStrike = new Map();
  for (const r of sub) {
    const s = byStrike.get(r.strike) || {};
    s[r.contract_type === "call" ? "c" : "p"] = r;
    byStrike.set(r.strike, s);
  }
  let strikes = [...byStrike.keys()].sort((a, b) => a - b);
  // ATM window: the strike ladder trims to N strikes split around spot, so
  // a dense chain (SPY quotes hundreds of strikes) opens on the money, not
  // on strike 1. Trimming happens at render time from the cached fetch, so
  // the width control repaints instantly without refetching.
  let trimmed = 0;
  // Auto mode sizes the window to the board itself: as many strikes as the
  // container's height holds (measured row height, minus the two header
  // rows and the spot spine), so a full screen means a full board instead
  // of thirty rows floating over dead space.
  const autoN = Math.max(10, Math.floor(
    ($("opt-body").clientHeight - 44 - optState.rowH - 10) / optState.rowH));
  const N = optState.strikes === "auto" ? autoN : optState.strikes;
  if (N && strikes.length > N) {
    let at = strikes.findIndex((k) => spot != null && k >= spot);
    if (at < 0) at = spot == null ? Math.floor(strikes.length / 2) : strikes.length;
    const lo = Math.max(0, Math.min(at - Math.floor(N / 2), strikes.length - N));
    trimmed = strikes.length - N;
    strikes = strikes.slice(lo, lo + N);
  }
  const g = optState.greeks;
  const perSide = g ? 8 : 5;
  const width = perSide * 2 + 1;
  // Tick-flash: on a same-board quiet repaint, a price cell whose last
  // trade moved pulses once, so the 15s tick-over is visible instead of
  // deniable. Any board switch skips it (everything would flash).
  const key = `${optState.und}|${want}`;
  const prev = quiet && key === optState.paintKey ? optState.flashPrev : null;
  const moved = (side, k, r) => !!(prev && r &&
    prev.has(side + k) && prev.get(side + k) !== r.last_price);
  // The hover tooltip carries the OSI ticker and the last trade's own
  // stamp: an untraded wing quote can be days old, and the cell alone
  // would pass it off as live.
  const tip = (r) => r ? ` title="${optAttr(
    `${r.ticker || ""} · last trade ${optWhen(r.last_trade_at)}`)}"` : "";
  // Both walls read outward from the strike spine (delta innermost), the
  // classic chain layout; greeks slot between IV and delta when toggled.
  // Each side builds through a cell() helper so the flash class can land
  // on the price cell alone; data-osel is the payoff picker (rows only,
  // never the gap cells of a one-sided strike).
  const side = (which, r, itm, k) => {
    const t = tip(r);
    const osel = r ? ` data-osel="${which}:${k}"` : "";
    const cell = (v, extra) => {
      const c = [itm ? "opt-itm" : "", extra || ""].filter(Boolean).join(" ");
      return `<td${c ? ` class="${c}"` : ""}${osel}${t}>${v}</td>`;
    };
    const fl = moved(which, k, r) ? "opt-flash" : "";
    const last = cell(optNum(r && r.last_price, 2), fl);
    const vol = cell(optVol(r && r.volume_today));
    const prem = cell(r ? optMoney(r.premium_today) : "-");
    const iv = cell(optIv(r && r.iv));
    const dlt = cell(optNum(r && r.delta, 2));
    const gk = g ? [cell(optNum(r && r.vega, 2)), cell(optNum(r && r.theta, 2)),
                    cell(optNum(r && r.gamma, 4))] : [];
    return which === "c"
      ? last + vol + prem + iv + gk.join("") + dlt
      : dlt + gk.slice().reverse().join("") + iv + prem + vol + last;
  };
  const callSide = (r, itm, k) => side("c", r, itm, k);
  const putSide = (r, itm, k) => side("p", r, itm, k);
  const spotRowHtml =
    `<tr class="opt-spot-row"><td colspan="${width}">` +
    `${aiEscape(optState.und.toUpperCase())} ${optNum(spot, 2)}</td></tr>`;
  let html = '<table class="qt opt-chain"><thead><tr>' +
    `<th colspan="${perSide}" class="opt-call">CALLS</th><th class="opt-strike">STRIKE</th>` +
    `<th colspan="${perSide}" class="opt-put">PUTS</th></tr><tr>` +
    "<th>Last</th><th>Vol</th><th>Prem</th><th>IV</th>" +
    (g ? "<th>V</th><th>&Theta;</th><th>&Gamma;</th>" : "") + "<th>&Delta;</th>" +
    '<th class="opt-strike"></th>' +
    "<th>&Delta;</th>" + (g ? "<th>&Gamma;</th><th>&Theta;</th><th>V</th>" : "") +
    "<th>IV</th><th>Prem</th><th>Vol</th><th>Last</th>" +
    "</tr></thead><tbody>";
  // The spot spine drops between the strikes that bracket the underlying's
  // price, splitting the board into its ITM/OTM halves at a glance.
  let spotDone = spot == null;
  for (const k of strikes) {
    if (!spotDone && k > spot) { html += spotRowHtml; spotDone = true; }
    const { c, p } = byStrike.get(k);
    const callItm = spot != null && k < spot;
    const putItm = spot != null && k > spot;
    html += "<tr>" + callSide(c || null, callItm, k) +
      `<td class="opt-strike">${optStrike(k)}</td>` +
      putSide(p || null, putItm, k) + "</tr>";
  }
  if (!spotDone) html += spotRowHtml; // spot above every shown strike
  html += "</tbody></table>";
  // A new underlying or expiry centres the money; a repaint of the same
  // board (30s auto-refresh, width/greeks toggles) keeps the scroll, so
  // the tick-over never yanks the page back to the top. #opt-body is the
  // scroll container since the analytics column split #opt-main.
  const page = $("opt-body");
  const keep = page.scrollTop;
  body.innerHTML = html;
  // Next quiet repaint diffs against this paint's prices.
  optState.flashPrev = new Map(sub.map((r) =>
    [(r.contract_type === "call" ? "c" : "p") + r.strike, r.last_price]));
  // Auto fit runs on an estimated row height first; measure the real one
  // off this paint and repaint once if the fit changes (the flag makes a
  // second corrective pass impossible, so this can never loop).
  const row0 = body.querySelector(".opt-chain tbody tr:not(.opt-spot-row)");
  if (row0 && Math.abs(row0.offsetHeight - optState.rowH) >= 1) {
    optState.rowH = row0.offsetHeight;
    if (optState.strikes === "auto" && !optState.refit) {
      optState.refit = true;
      optRenderChain(rows, quiet);
      optState.refit = false;
      return;
    }
  }
  if (key !== optState.paintKey) {
    optState.paintKey = key;
    const spotRow = body.querySelector(".opt-spot-row");
    if (spotRow) {
      // Rects are viewport-relative: add the container's own live scroll
      // (the innerHTML swap may have clamped it) to get the row's true y.
      const y = spotRow.getBoundingClientRect().top -
                page.getBoundingClientRect().top + page.scrollTop;
      page.scrollTop = Math.max(0, y - page.clientHeight / 2);
    } else {
      page.scrollTop = 0;
    }
  } else {
    page.scrollTop = keep;
  }
  $("opt-note").textContent =
    `${optState.und.toUpperCase()}${spot != null ? " " + optNum(spot, 2) : ""} · ` +
    `${sub.length} contracts · ${expiries.length} expiries` +
    (trimmed ? ` · ${trimmed} strikes hidden` : "") +
    (spotAt ? ` · as of ${optWhen(spotAt)}` : "");
  // Analytics ride every chain paint, quiet ones included: the canvases
  // redraw in place and never touch the board's scroll.
  $("ov-smile-t").textContent = `IV SMILE · ${want}`;
  $("ov-volp-t").textContent = `VOLUME BY STRIKE · ${want}`;
  $("opt-viz").classList.remove("hidden");
  ovRender(rows, sub, spot);
}

function optRenderFlow(rows, quiet) {
  const body = $("opt-body");
  if (!rows || !rows.length) {
    if (quiet) return; // a silent poll never blanks a tape someone reads
    body.innerHTML = '<div class="opt-empty">No prints match these filters.</div>';
    $("opt-note").textContent = "";
    return;
  }
  // Prints that arrived since the last paint pulse once (quiet polls only;
  // a fresh view or filter change flashes nothing).
  const newest = Number(rows[0] && rows[0].id) || 0;
  const flashAfter = quiet ? optState.flowTop : Infinity;
  optState.flowTop = Math.max(optState.flowTop, newest);
  let html = '<table class="qt opt-tape"><thead><tr>' +
    "<th>Time</th><th>Sym</th><th>Type</th><th>Strike</th><th>Expiry</th>" +
    "<th>DTE</th><th>Price</th><th>Size</th><th>Premium</th><th>IV</th>" +
    "<th>&Delta;</th><th>Spot</th></tr></thead><tbody>";
  for (const r of rows) {
    const call = r.contract_type === "call";
    // Size prints louder as premium grows ($100k+, $1M+): weight only,
    // never a new colour; green/red stay reserved for call/put.
    const prem = Number(r.premium) || 0;
    const pcls = prem >= 1e6 ? ' class="opt-prem-xl"'
               : prem >= 1e5 ? ' class="opt-prem-l"' : "";
    html += `<tr${Number(r.id) > flashAfter ? ' class="opt-flash"' : ""}` +
      ` title="${optAttr(r.ticker || "")}">` +
      `<td>${optWhen(r.ts)}</td>` +
      `<td><button class="opt-sym" data-opt-und="${optAttr(r.underlying || "")}">` +
      `${aiEscape(r.underlying || "")}</button></td>` +
      `<td class="${call ? "opt-call" : "opt-put"}">${call ? "CALL" : "PUT"}</td>` +
      `<td>${optStrike(r.strike)}</td><td>${r.expiry || "-"}</td>` +
      `<td>${r.dte != null ? r.dte : "-"}</td>` +
      `<td>${optNum(r.last_price, 2)}</td>` +
      `<td>${optVol(r.volume)}</td>` +
      `<td${pcls}>${optMoney(r.premium)}</td><td>${optIv(r.iv)}</td>` +
      `<td>${optNum(r.delta, 2)}</td>` +
      `<td>${optNum(r.underlying_price, 2)}</td></tr>`;
  }
  html += "</tbody></table>";
  body.innerHTML = html;
  $("opt-viz").classList.add("hidden"); // analytics read the chain, not the tape
  $("opt-note").textContent = `${rows.length} prints, newest first` +
    (rows[0] && rows[0].ts ? ` · latest ${optWhen(rows[0].ts)}` : "");
}

/* ---------- Options analytics: canvas panels fed by the loaded chain ----------
   Every panel is derived client-side from rows already in optState.chainRows;
   nothing here fetches. Colors: calls wear --up and puts wear --down exactly
   as in the board and the tape (entity colors, validated CVD-separable and
   3:1 on the charcoal surface); axis text wears ink, never a series color. */

const ovPad = { l: 40, r: 10, t: 6, b: 16 };

/* Signed money for P/L surfaces: "-$546" / "+$1.2k". optMoney stays for
   the always-positive premium columns ("$-546" is not a number anyone
   prints). */
function ovMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  const s = n < 0 ? "-" : n > 0 ? "+" : "";
  return s + optMoney(Math.abs(n));
}

/* Size the bitmap to the CSS box times devicePixelRatio so 2px lines stay
   crisp; null when the panel is display:none (zero box, nothing to draw). */
function ovCtx(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function ovInk() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { up: v("--up"), down: v("--down"), dim: v("--dim"), text: v("--text"),
           edge: v("--edge"), title: v("--title"), strong: v("--line-strong") };
}

function ovFont() { return "9.5px " + getComputedStyle(document.body).fontFamily; }

function ovEmpty(c, ink, msg) {
  c.ctx.fillStyle = ink.dim; c.ctx.font = ovFont();
  c.ctx.textAlign = "center"; c.ctx.textBaseline = "middle";
  c.ctx.fillText(msg, c.w / 2, c.h / 2);
}

function ovGrid(ctx, w, ink, ticks) {
  ctx.strokeStyle = ink.edge; ctx.lineWidth = 1;
  ctx.fillStyle = ink.dim; ctx.font = ovFont();
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of ticks) {
    ctx.beginPath(); ctx.moveTo(ovPad.l, t.y); ctx.lineTo(w - ovPad.r, t.y); ctx.stroke();
    ctx.fillText(t.label, ovPad.l - 4, t.y);
  }
}

function ovVLine(ctx, ink, x, h, label) {
  ctx.save();
  ctx.strokeStyle = ink.strong; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, ovPad.t); ctx.lineTo(x, h - ovPad.b); ctx.stroke();
  ctx.restore();
  if (label) {
    ctx.fillStyle = ink.dim; ctx.font = ovFont();
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(label, x, h - 4);
  }
}

function ovXEnds(ctx, ink, w, h, left, right) {
  ctx.fillStyle = ink.dim; ctx.font = ovFont(); ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left"; ctx.fillText(left, ovPad.l, h - 4);
  ctx.textAlign = "right"; ctx.fillText(right, w - ovPad.r, h - 4);
}

/* IV smile for the selected expiry: call and put IV against strike. Wing
   junk (stale deep contracts print absurd IVs) is tamed by clamping the y
   range to the 5th..95th percentile band, so the smile keeps its shape. */
function ovDrawSmile(sub, spot) {
  const cv = $("ov-smile"), c = ovCtx(cv);
  if (!c) return;
  const ink = ovInk();
  // Liquidity ladder: the clean curve wants liquid strikes near the money
  // (single lottery prints carry stale-looking IVs that saw-tooth the
  // panel); thin names fall back to any traded strike in a wider band
  // rather than showing nothing.
  const collect = (minVol, band) => {
    const o = { c: [], p: [] };
    for (const r of sub) {
      if (spot != null && Math.abs(r.strike - spot) > spot * band) continue;
      if (!(r.volume_today >= minVol)) continue;
      if (r.iv > 0 && r.iv < 4 && r.strike != null) {
        o[r.contract_type === "call" ? "c" : "p"].push([r.strike, r.iv]);
      }
    }
    return o;
  };
  let pts = collect(5, 0.15);
  if (pts.c.length + pts.p.length < 8) pts = collect(1, 0.25);
  pts.c.sort((a, b) => a[0] - b[0]); pts.p.sort((a, b) => a[0] - b[0]);
  const all = pts.c.concat(pts.p);
  cv._ov = null;
  if (all.length < 3) return ovEmpty(c, ink, "not enough live IV points");
  const xs = all.map((d) => d[0]);
  const ys = all.map((d) => d[1]).sort((a, b) => a - b);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = ys[Math.floor(ys.length * 0.05)];
  const y1 = Math.max(ys[Math.min(ys.length - 1, Math.ceil(ys.length * 0.95))], y0 + 0.01);
  const { ctx, w, h } = c;
  const X = (k) => ovPad.l + (k - x0) / (x1 - x0 || 1) * (w - ovPad.l - ovPad.r);
  const Y = (v) => ovPad.t + (1 - (Math.min(Math.max(v, y0), y1) - y0) / (y1 - y0)) *
                   (h - ovPad.t - ovPad.b);
  const mid = (y0 + y1) / 2;
  ovGrid(ctx, w, ink, [
    { y: Y(y1), label: (y1 * 100).toFixed(0) + "%" },
    { y: Y(mid), label: (mid * 100).toFixed(0) + "%" },
    { y: Y(y0), label: (y0 * 100).toFixed(0) + "%" }]);
  if (spot != null && spot >= x0 && spot <= x1) ovVLine(ctx, ink, X(spot), h);
  const line = (arr, col) => {
    if (arr.length < 2) return;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.beginPath();
    arr.forEach((d, i) => { const x = X(d[0]), y = Y(d[1]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  };
  line(pts.c, ink.up); line(pts.p, ink.down);
  ovXEnds(ctx, ink, w, h, optStrike(x0), optStrike(x1));
  const byK = new Map();
  for (const d of pts.c) byK.set(d[0], { c: d[1] });
  for (const d of pts.p) byK.set(d[0], { ...(byK.get(d[0]) || {}), p: d[1] });
  cv._ov = { x0, x1, ks: [...byK.keys()].sort((a, b) => a - b), byK };
}

/* ATM IV per expiry, evenly spaced (dte-proportional spacing crushes the
   weeklies into an unreadable clump at the left edge). */
function ovDrawTerm(rows, spot) {
  const cv = $("ov-term"), c = ovCtx(cv);
  if (!c) return;
  const ink = ovInk();
  const exps = [...new Set(rows.map((r) => r.expiry))].filter(Boolean).sort();
  const series = [];
  for (const e of exps) {
    const er = rows.filter((r) => r.expiry === e && r.iv > 0 && r.iv < 4);
    if (!er.length || spot == null) continue;
    let best = null;
    for (const r of er) {
      if (!best || Math.abs(r.strike - spot) < Math.abs(best.strike - spot)) best = r;
    }
    const twin = er.find((r) => r.strike === best.strike &&
                                r.contract_type !== best.contract_type);
    series.push([e, twin ? (best.iv + twin.iv) / 2 : best.iv]);
  }
  cv._ov = null;
  if (series.length < 2) return ovEmpty(c, ink, "one expiry only");
  const ys = series.map((d) => d[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys, y0 + 0.005);
  const { ctx, w, h } = c;
  const X = (i) => ovPad.l + i / (series.length - 1) * (w - ovPad.l - ovPad.r);
  const Y = (v) => ovPad.t + (1 - (v - y0) / (y1 - y0)) * (h - ovPad.t - ovPad.b);
  const mid = (y0 + y1) / 2;
  ovGrid(ctx, w, ink, [
    { y: Y(y1), label: (y1 * 100).toFixed(1) + "%" },
    { y: Y(mid), label: (mid * 100).toFixed(1) + "%" },
    { y: Y(y0), label: (y0 * 100).toFixed(1) + "%" }]);
  ctx.strokeStyle = ink.title; ctx.lineWidth = 2; ctx.lineJoin = "round";
  ctx.beginPath();
  series.forEach((d, i) => { const x = X(i), y = Y(d[1]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = ink.title;
  series.forEach((d, i) => { ctx.beginPath();
    ctx.arc(X(i), Y(d[1]), 2.5, 0, Math.PI * 2); ctx.fill(); });
  // Ends labeled in days out, not sliced dates: "06-30" a year from now
  // would read as EARLIER than "07-24" without its year.
  ovXEnds(ctx, ink, w, h, optDte(series[0][0]), optDte(series[series.length - 1][0]));
  cv._ov = { series };
}

/* Today's traded volume per strike for the selected expiry, calls above the
   axis and puts mirrored below, the where-is-the-action view. */
function ovDrawVolp(sub, spot) {
  const cv = $("ov-volp"), c = ovCtx(cv);
  if (!c) return;
  const ink = ovInk();
  const byK = new Map();
  for (const r of sub) {
    const s = byK.get(r.strike) || { c: 0, p: 0 };
    s[r.contract_type === "call" ? "c" : "p"] += r.volume_today || 0;
    byK.set(r.strike, s);
  }
  // Traded strikes only, then trim the lottery-ticket tails: a single
  // 500-strike print on a 742 underlying would otherwise stretch the axis
  // until the real action compresses into a sliver. Keep the strikes
  // covering 99% of volume from each side.
  let ks = [...byK.keys()].filter((k) => {
    const s = byK.get(k); return s.c > 0 || s.p > 0;
  }).sort((a, b) => a - b);
  const vols = ks.map((k) => { const s = byK.get(k); return s.c + s.p; });
  const total = vols.reduce((a, b) => a + b, 0);
  let lo = 0, hi = ks.length - 1, cut = total * 0.01, acc = 0;
  while (lo < hi && acc + vols[lo] < cut) { acc += vols[lo]; lo++; }
  acc = 0;
  while (hi > lo && acc + vols[hi] < cut) { acc += vols[hi]; hi--; }
  ks = ks.slice(lo, hi + 1);
  const top = Math.max(...ks.map((k) => Math.max(byK.get(k).c, byK.get(k).p)), 0);
  cv._ov = null;
  if (!ks.length || top === 0) return ovEmpty(c, ink, "no volume today");
  const { ctx, w, h } = c;
  const midY = (ovPad.t + h - ovPad.b) / 2;
  const span = (h - ovPad.t - ovPad.b) / 2 - 2;
  const plotW = w - ovPad.l - ovPad.r;
  const band = plotW / ks.length;
  const barW = Math.max(1, Math.min(band - 2, 9));
  ovGrid(ctx, w, ink, [{ y: midY, label: "0" }]);
  ctx.fillStyle = ink.dim; ctx.font = ovFont();
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText(optVol(top), ovPad.l - 4, ovPad.t + 5);
  ks.forEach((k, i) => {
    const s = byK.get(k);
    const x = ovPad.l + band * i + (band - barW) / 2;
    if (s.c) { ctx.fillStyle = ink.up;
      const bh = Math.max(1, s.c / top * span);
      ctx.fillRect(x, midY - bh, barW, bh); }
    if (s.p) { ctx.fillStyle = ink.down;
      const bh = Math.max(1, s.p / top * span);
      ctx.fillRect(x, midY + 1, barW, bh); }
  });
  if (spot != null && ks.length > 1) {
    const i = ks.findIndex((k) => k >= spot);
    if (i > 0) ovVLine(ctx, ink, ovPad.l + band * i, h);
  }
  ovXEnds(ctx, ink, w, h, optStrike(ks[0]), optStrike(ks[ks.length - 1]));
  cv._ov = { ks, byK, band };
}

/* Long-one-contract payoff at expiry for the picked row: intrinsic minus
   the premium paid, times the 100 multiplier. The one options graph that
   answers "what did I just buy". */
function ovDrawPay() {
  const cv = $("ov-pay"), c = ovCtx(cv);
  if (!c) return;
  const ink = ovInk();
  const sel = optState.sel;
  cv._ov = null;
  if (!sel) { $("ov-pay-r").textContent =
    "Click a contract in the chain to see its payoff at expiry."; return; }
  const { row, side } = sel;
  const K = row.strike, prem = row.last_price, spot = optState.viz && optState.viz.spot;
  if (prem == null) { ovEmpty(c, ink, "no traded price on this contract");
    $("ov-pay-r").textContent = row.ticker || ""; return; }
  const anchor = spot != null ? spot : K;
  const lo = Math.min(K, anchor) * 0.85, hi = Math.max(K, anchor) * 1.15;
  const pl = (S) => ((side === "c" ? Math.max(S - K, 0) : Math.max(K - S, 0)) - prem) * 100;
  const y0 = Math.min(pl(lo), pl(hi), -prem * 100);
  const y1 = Math.max(pl(lo), pl(hi), 1);
  const { ctx, w, h } = c;
  const X = (S) => ovPad.l + (S - lo) / (hi - lo) * (w - ovPad.l - ovPad.r);
  const Y = (v) => ovPad.t + (1 - (v - y0) / (y1 - y0)) * (h - ovPad.t - ovPad.b);
  ovGrid(ctx, w, ink, [
    { y: Y(y1), label: ovMoney(y1) },
    { y: Y(0), label: "0" },
    { y: Y(y0), label: ovMoney(y0) }]);
  ctx.strokeStyle = ink.strong; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ovPad.l, Y(0)); ctx.lineTo(w - ovPad.r, Y(0)); ctx.stroke();
  if (spot != null && spot >= lo && spot <= hi) ovVLine(ctx, ink, X(spot), h);
  ctx.strokeStyle = side === "c" ? ink.up : ink.down;
  ctx.lineWidth = 2; ctx.lineJoin = "round";
  ctx.beginPath();
  const kink = X(K);
  ctx.moveTo(ovPad.l, Y(pl(lo))); ctx.lineTo(kink, Y(pl(K))); ctx.lineTo(w - ovPad.r, Y(pl(hi)));
  ctx.stroke();
  const be = side === "c" ? K + prem : K - prem;
  if (be >= lo && be <= hi) {
    ctx.fillStyle = ink.text;
    ctx.beginPath(); ctx.arc(X(be), Y(0), 3, 0, Math.PI * 2); ctx.fill();
  }
  ovXEnds(ctx, ink, w, h, optStrike(lo), optStrike(hi));
  const atSpot = spot != null ? ` · at spot ${ovMoney(pl(spot))}` : "";
  $("ov-pay-r").textContent =
    `BE ${optStrike(be)} · max loss ${optMoney(prem * 100)}${atSpot}`;
  cv._ov = { lo, hi, pl };
}

/* Tiles + all four panels from the freshest chain paint. */
function ovRender(rows, sub, spot) {
  optState.viz = { rows, sub, spot };
  let cvol = 0, pvol = 0, cprem = 0, pprem = 0;
  for (const r of sub) {
    if (r.contract_type === "call") { cvol += r.volume_today || 0; cprem += r.premium_today || 0; }
    else { pvol += r.volume_today || 0; pprem += r.premium_today || 0; }
  }
  $("ov-pcv").textContent = cvol ? (pvol / cvol).toFixed(2) : "-";
  $("ov-pcp").textContent = cprem ? (pprem / cprem).toFixed(2) : "-";
  $("ov-tp").textContent = optMoney(cprem + pprem);
  let atm = "-";
  if (spot != null) {
    const live = sub.filter((r) => r.iv > 0 && r.iv < 4);
    if (live.length) {
      let best = null;
      for (const r of live) {
        if (!best || Math.abs(r.strike - spot) < Math.abs(best.strike - spot)) best = r;
      }
      const twin = live.find((r) => r.strike === best.strike &&
                                    r.contract_type !== best.contract_type);
      atm = optIv(twin ? (best.iv + twin.iv) / 2 : best.iv);
    }
  }
  $("ov-atm").textContent = atm;
  ovDrawSmile(sub, spot);
  ovDrawTerm(rows, spot);
  ovDrawVolp(sub, spot);
  ovDrawPay();
}

/* Chain cell -> payoff selection. */
function ovSelect(spec) {
  const side = spec[0];
  const k = Number(spec.slice(2));
  const row = optState.chainRows.find((r) => r.expiry === optState.expiry &&
    r.strike === k && r.contract_type === (side === "c" ? "call" : "put"));
  if (!row) return;
  optState.sel = { row, side };
  $("ov-pay-t").textContent = "PAYOFF · " + (row.ticker || "");
  $("ov-pay-x").classList.remove("hidden");
  ovDrawPay();
}

function ovClearSel() {
  optState.sel = null;
  $("ov-pay-t").textContent = "PAYOFF";
  $("ov-pay-x").classList.add("hidden");
  ovDrawPay();
}

/* One hover wire per canvas: nearest data point writes the readout line
   under the panel (fixed-height, so nothing reflows). */
function ovWireHover() {
  const near = (arr, v) => arr.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
  const wire = (id, readId, fmt) => {
    const cv = $(id);
    cv.addEventListener("mousemove", (e) => {
      if (!cv._ov) return;
      const r = cv.getBoundingClientRect();
      const t = fmt(cv._ov, e.clientX - r.left, cv.clientWidth);
      if (t != null) $(readId).textContent = t;
    });
    cv.addEventListener("mouseleave", () => {
      if (id === "ov-pay") { ovDrawPay(); return; } // restore the BE summary
      $(readId).textContent = "";
    });
  };
  wire("ov-smile", "ov-smile-r", (d, mx, w) => {
    const k = near(d.ks, d.x0 + (mx - ovPad.l) / (w - ovPad.l - ovPad.r) * (d.x1 - d.x0));
    const s = d.byK.get(k) || {};
    return `K ${optStrike(k)} · C ${optIv(s.c)} · P ${optIv(s.p)}`;
  });
  wire("ov-term", "ov-term-r", (d, mx, w) => {
    const i = Math.round((mx - ovPad.l) / (w - ovPad.l - ovPad.r) * (d.series.length - 1));
    const p = d.series[Math.min(Math.max(i, 0), d.series.length - 1)];
    return p ? `${p[0]} · ${optIv(p[1])} · ${optDte(p[0])}` : null;
  });
  wire("ov-volp", "ov-volp-r", (d, mx) => {
    const i = Math.min(Math.max(Math.floor((mx - ovPad.l) / d.band), 0), d.ks.length - 1);
    const k = d.ks[i], s = d.byK.get(k);
    return s ? `K ${optStrike(k)} · C ${optVol(s.c)} · P ${optVol(s.p)}` : null;
  });
  wire("ov-pay", "ov-pay-r", (d, mx, w) => {
    const S = d.lo + (mx - ovPad.l) / (w - ovPad.l - ovPad.r) * (d.hi - d.lo);
    return `S ${optStrike(S)} · P/L ${ovMoney(d.pl(S))}`;
  });
  $("ov-pay-x").onclick = ovClearSel;
  // Redraw on window resize so the bitmaps track their CSS boxes.
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if ($("optpage").classList.contains("hidden")) return;
      // Auto-fit boards refit to the new height (which re-renders the
      // analytics too); anything else just redraws the canvases.
      if (optState.view === "chain" && optState.strikes === "auto" &&
          optState.und && optState.chainRows.length) {
        optRenderChain(optState.chainRows);
      } else if (optState.viz) {
        ovRender(optState.viz.rows, optState.viz.sub, optState.viz.spot);
      }
    }, 150);
  });
}

function setupRail() {
  const setActive = (id) => {
    for (const b of document.querySelectorAll(".rail-btn")) b.classList.remove("active");
    $(id).classList.add("active");
  };
  // The native title follows the active tab:
  // MARKETS restores the charted pair, other tabs name themselves, and
  // the ECONOMIC page refines its own further (country / open series).
  const setTitle = (text) => {
    document.title = text ? `${text} · LSE Terminal`
      : state.symbol ? `${state.symbol} ${state.timeframe} · LSE Terminal`
      : "LSE Terminal";
  };
  // The left sidebar is the watchlist on MARKETS and the file library on
  // BACKTEST / MY DATA, but ECONOMIC and MACHINE LEARNING have no use for
  // it; leaving it up there just shows stale pairs next to an unrelated
  // page (pairs only when a market view is selected).
  const setSidebar = (show) => $("side").classList.toggle("hidden", !show);
  $("rail-markets").onclick = () => {
    setActive("rail-markets");
    setTitle();
    setSidebar(true);
    // Sub-bar renders before the no-key early return below so the OPTIONS
    // sub-tab is reachable even while the connect form is up.
    renderSubrail("markets", "sub-mk-charts");
    $("optpage").classList.add("hidden");
    $("scrpage").classList.add("hidden");
    $("news").classList.add("hidden");
    $("backtest").classList.add("hidden");
    $("mydata").classList.add("hidden");
    $("econcal").classList.add("hidden");
    $("dataviz").classList.add("hidden");
    $("nbpage").classList.add("hidden");
    $("mlpage").classList.add("hidden");
    $("pyide").classList.add("hidden");
    $("wsx").classList.add("hidden");
    $("research").classList.add("hidden");
    $("guide").classList.add("hidden");
    closeManualBacktest();
    // MARKETS hosts live sources only: LSE and the user's own configured
    // vendors, never imported files. Without an LSE key (and no custom
    // source active) the tab IS the connect form; a user living off their
    // own vendor key is never locked out because the top-left key manager
    // (conn bar) lists custom sources and switches to them. The sidebar is
    // cleared explicitly: a visit to MY DATA/BACKTEST leaves the user's
    // library rendered there.
    // (marketsWantsKey: the same decision a source switch makes again, so
    // the view does not depend on whether this click or the boot's source
    // came first)
    if (marketsWantsKey()) {
      renderConnBar();
      const wl = $("watchlist");
      wl.innerHTML =
        '<div class="empty-actions"><div class="md-empty">' +
        'Live pairs appear here once your LSE API key is connected.</div></div>';
      $("charts").classList.add("hidden");
      $("lse-connect").classList.remove("hidden");
      $("lse-key").focus();
      return;
    }
    $("lse-connect").classList.add("hidden");
    $("charts").classList.remove("hidden");
    if (!isLiveSource(state.provider)) switchProvider("lse");
    else renderWatchlist();
  };
  // BACKTEST lands straight in a mode (last used, Algo Development by
  // default); openBacktest does the full section sweep itself.
  $("rail-backtest").onclick = () => { openBacktest(); };
  $("rail-data").onclick = async () => {
    setActive("rail-data");
    setTitle("My Data");
    setSidebar(true);
    renderSubrail(null);
    $("optpage").classList.add("hidden");
    $("scrpage").classList.add("hidden");
    $("news").classList.add("hidden");
    $("charts").classList.add("hidden");
    $("econcal").classList.add("hidden");
    $("dataviz").classList.add("hidden");
    $("nbpage").classList.add("hidden");
    $("mlpage").classList.add("hidden");
    $("pyide").classList.add("hidden");
    $("wsx").classList.add("hidden");
    $("lse-connect").classList.add("hidden");
    $("research").classList.add("hidden");
    $("guide").classList.add("hidden");
    closeManualBacktest();
    $("mydata").classList.remove("hidden");
    if (state.provider !== "userdata") switchProvider("userdata");
    await refreshLibraryAll();
  };
  // ECONOMIC is a top-level section (its own rail tab), not a MY DATA card.
  // The calendar page is self-contained; onBack returns to MARKETS since a
  // top-level tab has no parent section to fall back into.
  $("rail-econ").onclick = () => {
    setActive("rail-econ");
    setTitle("Economic Calendar");
    setSidebar(false);
    renderSubrail("econ", "sub-ec-cal");
    $("optpage").classList.add("hidden");
    $("scrpage").classList.add("hidden");
    $("news").classList.add("hidden");
    $("charts").classList.add("hidden");
    $("backtest").classList.add("hidden");
    $("mydata").classList.add("hidden");
    $("mlpage").classList.add("hidden");
    $("pyide").classList.add("hidden");
    $("wsx").classList.add("hidden");
    $("dataviz").classList.add("hidden");
    $("nbpage").classList.add("hidden");
    $("lse-connect").classList.add("hidden");
    $("research").classList.add("hidden");
    $("guide").classList.add("hidden");
    closeManualBacktest();
    $("econcal").classList.remove("hidden");
    if (window.LSEEconCalendar) {
      window.LSEEconCalendar.mount($("econcal-root"), {
        onBack: () => $("rail-markets").click(),
      });
    }
  };
  // WORKSPACE: the full IDE session (explorer + editor tabs + terminal,
  // with the AI rail alongside). The left watchlist sidebar stays hidden:
  // the explorer IS this page's sidebar.
  $("rail-workspace").onclick = () => {
    setActive("rail-workspace");
    setTitle("Workspace");
    setSidebar(false);
    renderSubrail("workspace", "sub-ws-ide");
    $("optpage").classList.add("hidden");
    $("scrpage").classList.add("hidden");
    $("news").classList.add("hidden");
    $("charts").classList.add("hidden");
    $("backtest").classList.add("hidden");
    $("mydata").classList.add("hidden");
    $("econcal").classList.add("hidden");
    $("dataviz").classList.add("hidden");
    $("nbpage").classList.add("hidden");
    $("mlpage").classList.add("hidden");
    $("pyide").classList.add("hidden");
    $("lse-connect").classList.add("hidden");
    $("research").classList.add("hidden");
    $("guide").classList.add("hidden");
    closeManualBacktest();
    $("wsx").classList.remove("hidden");
    // The session is explorer + editor + terminal + CHAT: a collapsed AI
    // rail defeats the point of the tab, so entering it unfolds the rail
    // (through its own button, so the stored preference updates too).
    if ($("ai-rail").classList.contains("collapsed")) $("air-expand").click();
    openWorkspace();
  };
  // RESEARCH: reading surfaces (latest-papers wire, quant models).
  // Full-page content, no watchlist; works hosted too (local wire file,
  // no key).
  $("rail-research").onclick = () => {
    setActive("rail-research");
    setTitle("Research");
    setSidebar(false);
    renderSubrail("research", "sub-rs-articles");
    $("optpage").classList.add("hidden");
    $("scrpage").classList.add("hidden");
    $("news").classList.add("hidden");
    $("charts").classList.add("hidden");
    $("backtest").classList.add("hidden");
    $("mydata").classList.add("hidden");
    $("econcal").classList.add("hidden");
    $("dataviz").classList.add("hidden");
    $("nbpage").classList.add("hidden");
    $("mlpage").classList.add("hidden");
    $("pyide").classList.add("hidden");
    $("wsx").classList.add("hidden");
    $("lse-connect").classList.add("hidden");
    $("guide").classList.add("hidden");
    closeManualBacktest();
    $("research").classList.remove("hidden");
    rsShowView("articles");
  };
  // TERMINAL WALKTHROUGH: the built-in user guide, a reading page
  // like RESEARCH. No sub-views (the contents column is the navigation),
  // no watchlist, works hosted (the document is a static file). Same
  // hide-everything sweep as its siblings; gdOpen fetches and renders
  // guide.md the first time and reuses it after.
  $("rail-guide").onclick = () => {
    setActive("rail-guide");
    setTitle("Terminal walkthrough");
    setSidebar(false);
    renderSubrail(null);
    $("optpage").classList.add("hidden");
    $("scrpage").classList.add("hidden");
    $("news").classList.add("hidden");
    $("charts").classList.add("hidden");
    $("backtest").classList.add("hidden");
    $("mydata").classList.add("hidden");
    $("econcal").classList.add("hidden");
    $("dataviz").classList.add("hidden");
    $("nbpage").classList.add("hidden");
    $("mlpage").classList.add("hidden");
    $("pyide").classList.add("hidden");
    $("wsx").classList.add("hidden");
    $("lse-connect").classList.add("hidden");
    $("research").classList.add("hidden");
    closeManualBacktest();
    $("guide").classList.remove("hidden");
    gdOpen();
  };
}

/* The MARKETS connect form. Saving is not enough: the key is proved against
   the live instrument catalog first, so a typo surfaces here as an error
   instead of later as a silently empty watchlist. */
function setupLseConnect() {
  // the form's key box: no browser offers to save it (csSecretBox; the
  // markup's own class masks it before this runs)
  csSecretBox($("lse-key"));
  const showErr = (msg) => {
    const e = $("lse-key-err");
    e.textContent = msg;
    e.classList.remove("hidden");
  };
  const connect = async () => {
    const key = $("lse-key").value.trim();
    if (!key) return;
    const btn = $("lse-connect-btn");
    btn.disabled = true;
    btn.textContent = "Connecting…";
    $("lse-key-err").classList.add("hidden");
    try {
      const r = await fetch("/api/config/lse_key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!r.ok) {
        // The engine now proves the key against the gate before storing it and
        // returns the reason in `detail`. Showing "HTTP 400" instead of that
        // sentence is what made a rejected key look like a broken app.
        let why = "";
        try { why = (await r.json())?.detail || ""; } catch { /* non-JSON body */ }
        throw new Error(why || `could not save the key (HTTP ${r.status})`);
      }
      resetPricePollKey();
      const probe = await fetch("/api/instruments?provider=lse&query=&limit=1");
      if (!probe.ok) {
        throw new Error("The LSE API rejected this key. Check for typos and try again.");
      }
      state.lseConfigured = true;
      state.providers = await fetch("/api/providers").then((x) => x.json());
      $("lse-key").value = "";
      // Load the catalog BEFORE showing the tab. state.provider is already
      // "lse" by now (boot switched to it, and its catalog call 502'd because
      // there was no key yet), so the rail handler takes its "already on a
      // live source" branch and only re-renders the watchlist: it would paint
      // the empty list from that failed boot load and stop. The user then sat
      // on a blank chart with an empty sidebar holding a perfectly good key.
      // switchProvider re-fetches the catalog, picks a symbol, draws the chart
      // and opens the stream, which is the whole point of having connected.
      await switchProvider("lse");
      $("rail-markets").click();
    } catch (e) {
      showErr(String(e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  };
  $("lse-connect-btn").onclick = connect;
  $("lse-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect();
  });
}

/* ── app updates ───────────────────────────────────────────────────────
   The header UPDATE button is the single surface for "am I on the latest
   build" (it replaced the corner download pill, which
   said the same thing in a second place). Two install paths sit behind it:

     - desktop app: the shell bridge (window.lseShell.update, preload.js)
       drives electron-updater. It downloads the release in the background
       and the button becomes the restart-and-install action.
     - pip / source runs: no updater, so the button opens the release
       download page and the user installs it the way they installed it.

   "Is there something newer" comes from the engine's /api/update/status
   (the release feed) in BOTH cases. Which version we are ON comes from the
   shell when there is one: an update replaces the installer, so the desktop
   app version is the honest answer there, not the python package's.

   The button is absent from the header unless a genuinely newer release
   exists. There is no "check for updates" click and
   no "up to date" state: the check runs on its own in the background, and
   the button appearing IS the answer. */
const appUpdate = { phase: "idle", current: "", latest: "", available: false,
                    download: "", pct: 0, shell: false };

function renderUpdateButton() {
  const b = $("update-btn");
  if (!b) return;
  // Nothing newer (or nothing known yet): no button at all.
  if (!appUpdate.available) { b.classList.add("hidden"); return; }
  const v = appUpdate.latest;
  let text = `UPDATE ${v}`;
  let title = appUpdate.shell
    ? `Install ${v} (you run ${appUpdate.current})`
    : `Download ${v} (you run ${appUpdate.current})`;
  if (appUpdate.phase === "downloading") {
    text = `UPDATE ${appUpdate.pct}%`; title = `Downloading ${v}`;
  } else if (appUpdate.phase === "ready") {
    text = "RESTART"; title = `${v} is downloaded. Click to restart into it.`;
  }
  b.textContent = text;
  b.title = title;
  b.classList.remove("hidden");
  // The dot marks work waiting, not work in progress.
  b.classList.toggle("pending", appUpdate.phase !== "downloading");
}

/* Background only: a release that lands while the terminal is open makes
   the button appear on the next pass. */
async function checkForUpdate() {
  if (appUpdate.phase === "downloading" || appUpdate.phase === "ready") return;
  try {
    const s = await fetch("/api/update/status").then((r) => r.json());
    appUpdate.current = s.current || appUpdate.current;
    appUpdate.latest = s.latest || "";
    appUpdate.available = !!s.update;
    appUpdate.download = s.download || "";
  } catch (e) { /* engine or feed away: keep the last known answer */ }
  const sh = window.lseShell && window.lseShell.update;
  if (sh) {
    try {
      const st = await sh.check();
      if (st && st.current) appUpdate.current = st.current;
      // supported:false = a build with no updater (mac, unsigned, or the dep
      // missing). Leave the feed's answer in place; the click downloads.
      if (st && st.supported) {
        appUpdate.shell = true;
        if (st.latest) appUpdate.latest = st.latest;
        appUpdate.available = !!st.available;
        if (st.phase && st.phase !== "idle") appUpdate.phase = st.phase;
      }
    } catch (e) { /* older shell without the bridge: download-link path */ }
  }
  renderUpdateButton();
}

/* The one update action, shared by the header button and any row that
   needs a newer build (a broker whose connector is not in this one). */
function startAppUpdate() {
  const sh = window.lseShell && window.lseShell.update;
  if (appUpdate.phase === "downloading") return;
  if (appUpdate.phase === "ready" && sh) { sh.install(); return; }
  if (appUpdate.available && appUpdate.shell && sh) {
    appUpdate.phase = "downloading";
    renderUpdateButton();
    sh.install();   // download now, or restart if it already finished
    return;
  }
  // pip / source / unsigned build, or the release feed has not been read
  // yet: hand them the installer page.
  window.open(appUpdate.download || "https://londonstrategicedge.com/terminal",
              "_blank", "noopener");
}

function setupUpdateButton(hosted) {
  const b = $("update-btn");
  if (!b) return;
  // The hosted site terminal is redeployed, never self-updated: nothing for
  // a visitor to install, so no button at all.
  if (hosted) { b.classList.add("hidden"); return; }
  const sh = window.lseShell && window.lseShell.update;
  if (sh && sh.onState) sh.onState((st) => {
    appUpdate.shell = !!st.supported;
    if (st.current) appUpdate.current = st.current;
    if (st.latest) appUpdate.latest = st.latest;
    appUpdate.available = !!st.available;
    appUpdate.pct = st.pct || 0;
    appUpdate.phase = st.phase || "idle";
    renderUpdateButton();
  });
  // The button only exists when there is an update, so a click is always
  // "do it", never "check".
  b.onclick = () => startAppUpdate();
  renderUpdateButton();
  checkForUpdate();
  // A terminal left open for days still notices a release the same day.
  setInterval(checkForUpdate, 3600 * 1000);
}

/* Live update: when the served UI files change on disk (dev sync or an
   update installed while the app is open), ui_version moves and the page
   reloads itself. Localhost polling is effectively free. */
function watchForUpdates(initialVersion) {
  let current = initialVersion;
  setInterval(async () => {
    try {
      const h = await fetch("/api/health").then((r) => r.json());
      if (current && h.ui_version && h.ui_version !== current) location.reload();
      current = h.ui_version;
    } catch (e) { /* engine briefly away; keep watching */ }
  }, 3000);
}

/* ── MACHINE LEARNING ──────────────────────────────────────────────────
   The ML Studio model catalog, trained locally. The engine exports the
   chosen dataset to a file and runs the training script as a subprocess on
   this machine (CUDA or Apple MPS auto-detected when torch sees a GPU);
   this page is
   only the workflow: pick model, pick data, set parameters, watch the log,
   read the results. */
const ml = {
  loaded: false, catalog: null, model: null, job: null, ws: null,
  hosted: false, symbolTimer: null,
  // LIBRARIES panel state: the last /api/ml/env payload, the
  // install in flight ({pkgs, status, t0}) and the click-away handler.
  env: null, installing: null, libsAway: null,
};

const mlEsc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function openML() {
  // Before the loaded-guard: re-entering ML must still light its sub-tab.
  subrailMark("sub-bt-ml");
  if (ml.loaded) return;
  ml.loaded = true;
  try {
    const cat = await fetch("/api/ml/models").then((r) => r.json());
    ml.catalog = cat;
    ml.hosted = !!cat.hosted;
    renderMLCatalog();
    renderMLHistory();
    setupMLConfig();
    // The GPU probe imports torch in a subprocess; do it after first paint
    // and never block the page on it.
    fetch("/api/ml/env").then((r) => r.json()).then(renderMLEnv).catch(() => {});
  } catch (e) {
    ml.loaded = false;
    $("ml-catalog").innerHTML = `<div class="md-empty">ML catalog failed to load: ${mlEsc(e)}</div>`;
  }
}

function renderMLEnv(env) {
  const bits = [];
  if (env.gpu && env.gpu.cuda) {
    bits.push(`<span class="ml-gpu on" title="PyTorch ${mlEsc(env.gpu.torch)}, CUDA ${mlEsc(env.gpu.cuda_version)}">` +
              `GPU · ${mlEsc(env.gpu.device)} (${Math.round((env.gpu.vram_mb || 0) / 1024)} GB)</span>`);
  } else if (env.gpu && env.gpu.mps) {
    // Apple Silicon: MPS has no VRAM figure (unified memory), so no GB suffix.
    bits.push(`<span class="ml-gpu on" title="PyTorch ${mlEsc(env.gpu.torch)}, Apple MPS backend">` +
              `GPU · ${mlEsc(env.gpu.device || "Apple Silicon (MPS)")}</span>`);
  } else if (env.gpu && env.gpu.torch) {
    bits.push('<span class="ml-gpu">CPU · no GPU device</span>');
  } else {
    bits.push('<span class="ml-gpu">CPU · torch not installed</span>');
  }
  const installed = Object.entries(env.deps || {}).filter(([, d]) => d.installed).length;
  const total = Object.keys(env.deps || {}).length;
  // The libraries count is a BUTTON: it opens the LIBRARIES panel
  // (what is installed, what a click downloads). "· install"
  // rides on it while anything is missing, so the door is not a mystery.
  bits.push(`<button class="ml-dep-count${installed < total ? " missing" : ""}" id="ml-libs-btn" ` +
            `title="Libraries: what is installed, what each model needs, one-click install">` +
            `${installed}/${total} libraries</button>`);
  $("ml-env").innerHTML = bits.join("");
  ml.env = env;
  $("ml-libs-btn").onclick = (e) => { e.stopPropagation(); mlToggleLibs(); };
  if (!$("ml-libs").classList.contains("hidden")) mlRenderLibs();
}

/* ── LIBRARIES panel ───────────────────────────────────────────────────
   Every optional library on one row: installed version (or not), the
   download record when the ML tab did the install (size, date), the models
   it unlocks, and an Install button. Live install progress lands on the
   row and in the model banner through the same mlInstall() below. Data:
   /api/ml/models deps (installed/version/models/installed_at/downloaded_mb)
   plus /api/ml/env (packages_dir); an older engine without the extra fields
   still gets a correct panel (unlocks computed here from the catalog). */
function mlDepsMerged() {
  const deps = Object.assign({}, (ml.catalog && ml.catalog.deps) || {});
  for (const [k, d] of Object.entries((ml.env && ml.env.deps) || {})) {
    deps[k] = Object.assign({}, deps[k] || {}, d);
  }
  // unlocks: from the catalog when the engine did not say
  for (const k of Object.keys(deps)) {
    if (!deps[k].models || !deps[k].models.length) {
      deps[k].models = ((ml.catalog && ml.catalog.models) || [])
        .filter((m) => (m.deps || []).includes(k)).map((m) => m.name);
    }
  }
  return deps;
}

function mlToggleLibs(force) {
  const panel = $("ml-libs");
  const open = force === undefined ? panel.classList.contains("hidden") : !!force;
  panel.classList.toggle("hidden", !open);
  const btn = $("ml-libs-btn");
  if (btn) btn.classList.toggle("open", open);
  if (open) {
    mlRenderLibs();
    // click-away closes it (bound once)
    if (!ml.libsAway) {
      ml.libsAway = (e) => {
        if (!$("ml-libs").contains(e.target) && e.target.id !== "ml-libs-btn") mlToggleLibs(false);
      };
      document.addEventListener("click", ml.libsAway);
    }
  }
}

function mlFmtWhen(ts) {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch (e) { return ""; }
}

function mlLibStatusText(name, d) {
  if (ml.installing && ml.installing.pkgs.includes(name)) return null;  // live line owns it
  if (d.installed) {
    const bits = ["Installed" + (d.version ? " " + d.version : "")];
    const mb = (x) => (x >= 1 ? Math.round(x) + " MB" : "< 1 MB");
    if (d.installed_at) {
      // its own wheel, and the whole click when dependencies came along
      if (d.run_mb && d.run_mb > (d.downloaded_mb || 0) + 0.5) {
        bits.push(`${mb(d.downloaded_mb || 0)}, ${mb(d.run_mb)} with its dependencies`);
      } else if (d.downloaded_mb || d.run_mb) {
        bits.push(mb(d.downloaded_mb || d.run_mb));
      }
      bits.push(mlFmtWhen(d.installed_at));
    } else {
      bits.push("came with the app or another library");
    }
    return bits.join(" · ");
  }
  return "Not installed";
}

function mlRenderLibs() {
  const panel = $("ml-libs");
  const deps = mlDepsMerged();
  const names = Object.keys(deps).sort((a, b) => {
    // missing first (that is what the panel is for), then alphabetical
    const ai = deps[a].installed ? 1 : 0, bi = deps[b].installed ? 1 : 0;
    return ai - bi || a.localeCompare(b);
  });
  const missing = names.filter((n) => !deps[n].installed);
  const busy = !!ml.installing;
  let html = '<div class="ml-libs-head"><span class="ml-libs-title">LIBRARIES</span>' +
    `<span class="ml-libs-sum">${names.length - missing.length} of ${names.length} installed` +
    (missing.length ? ` · ${missing.length} missing` : " · every model is ready") + "</span>" +
    '<span class="spacer"></span>' +
    (missing.length && !ml.hosted
      ? `<button id="ml-libs-all"${busy ? " disabled" : ""}>Install all missing (${missing.length})</button>`
      : "") + "</div>";
  for (const n of names) {
    const d = deps[n];
    const live = ml.installing && ml.installing.pkgs.includes(n) ? ml.installing.status : null;
    const st = live !== null ? live : mlLibStatusText(n, d);
    const cls = live !== null ? "busy" : d.installed ? "on" : "";
    const models = (d.models || []).join(", ");
    html += `<div class="ml-lib-row" data-lib="${mlEsc(n)}">` +
      `<span class="ml-lib-name">${mlEsc(n)}</span>` +
      `<span class="ml-lib-status ${cls}">${mlEsc(st || "")}</span>` +
      `<span class="ml-lib-models" title="${mlEsc(models)}">${mlEsc(models)}</span>` +
      (d.installed
        ? '<span class="ml-lib-done">ready</span>'
        : (ml.hosted ? "" : `<button class="ml-lib-act" data-lib="${mlEsc(n)}"${busy ? " disabled" : ""}>Install</button>`)) +
      "</div>";
  }
  const where = (ml.env && ml.env.packages_dir) || "";
  html += `<div class="ml-libs-foot" title="${mlEsc(where)}">` +
    (where ? "Installed into " + mlEsc(where) : "Installs go into the terminal's own Python.") + "</div>";
  panel.innerHTML = html;
  panel.querySelectorAll(".ml-lib-act").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); mlInstall([b.dataset.lib]); };
  });
  const all = $("ml-libs-all");
  if (all) all.onclick = (e) => { e.stopPropagation(); mlInstall(missing); };
}

/* Human line for one pip progress frame. */
function mlInstallLine(f) {
  if (f.stage === "download") {
    const who = f.package + (f.version ? " " + f.version : "");
    const size = f.size_mb >= 1 ? Math.round(f.size_mb) + " MB" : "< 1 MB";
    if (f.cached) return `Found ${who} in the download cache (${size})`;
    return `Downloading ${who} (${size})` + (f.total_mb ? ` · ${Math.round(f.total_mb)} MB so far` : "");
  }
  if (f.stage === "collect") return `Resolving ${f.package}…`;
  if (f.stage === "install") return `Installing ${f.count} package${f.count === 1 ? "" : "s"}…`;
  if (f.stage === "done") return "Installed: " + (f.packages || []).join(" ");
  // pip's own line, whole: a library row's cell cuts it with "…" and keeps
  // it as its tooltip (mlInstall)
  return oneLine(f.line);
}

/* One installer for the banner and the panel: streams pip through the
   engine, mirrors the human status into every place that shows it, then
   re-pulls the catalog + env so ready flags, tags, badge and rows all
   update at once. */
function mlInstall(pkgs) {
  pkgs = (pkgs || []).filter(Boolean);
  if (!pkgs.length || ml.installing) return;
  ml.installing = { pkgs, status: "Starting…", t0: Date.now() };
  const banner = $("ml-deps-warn"), btn = $("ml-install"), text = $("ml-deps-text");
  const bannerOwns = ml.model && !ml.model.ready &&
    (ml.model.deps || []).some((d) => pkgs.includes(d));
  const setStatus = (line) => {
    ml.installing.status = line;
    if (bannerOwns) { banner.classList.add("busy"); text.textContent = line; }
    for (const row of $("ml-libs").querySelectorAll(".ml-lib-row")) {
      if (pkgs.includes(row.dataset.lib)) {
        const st = row.querySelector(".ml-lib-status");
        st.textContent = line; st.className = "ml-lib-status busy";
        // the cell is one grid column: it cuts a long line with "…", and
        // the whole line is here
        st.title = line;
      }
    }
  };
  if (bannerOwns) { btn.disabled = true; btn.textContent = "Installing…"; }
  for (const b of $("ml-libs").querySelectorAll("button")) b.disabled = true;
  $("ml-log").textContent = "";
  $("ml-progress").classList.remove("hidden");
  const log = $("ml-log");
  const finish = async (ok, msg, okFrame) => {
    const cat = await fetch("/api/ml/models").then((r) => r.json()).catch(() => null);
    if (cat) { ml.catalog = cat; renderMLCatalog(); }
    const env = await fetch("/api/ml/env?refresh=1").then((r) => r.json()).catch(() => null);
    ml.installing = null;
    if (env) renderMLEnv(env);
    if (!$("ml-libs").classList.contains("hidden")) mlRenderLibs();
    if (ml.model && cat) {
      const fresh = cat.models.find((x) => x.key === ml.model.key);
      if (fresh) {
        ml.model = fresh;
        for (const c of document.querySelectorAll(".ml-model")) {
          if (c.dataset.key === fresh.key) c.classList.add("active");
        }
      }
    }
    if (bannerOwns) {
      btn.disabled = false; btn.textContent = "Install";
      banner.classList.remove("busy");
      if (ok) {
        const got = (okFrame && okFrame.packages) || pkgs.map((p) => ({ name: p }));
        const parts = got.map((p) => p.name + (p.version ? " " + p.version : ""));
        const run = okFrame && okFrame.run_mb ? okFrame.run_mb : 0;
        const extra = okFrame && okFrame.run_packages > got.length ? okFrame.run_packages - got.length : 0;
        const size = run ? ` (${run >= 1 ? Math.round(run) + " MB" : "< 1 MB"}` +
          (extra ? `, ${extra} dependenc${extra === 1 ? "y" : "ies"} included` : "") + ")" : "";
        text.textContent = `Installed ${parts.join(", ")}${size}. ` +
          (ml.model && ml.model.ready ? `${ml.model.name} is ready.` : "");
        banner.classList.add("done");
        $("ml-run").disabled = !(ml.model && ml.model.ready);
        setTimeout(() => {
          if (ml.model && ml.model.ready) banner.classList.add("hidden");
          banner.classList.remove("done");
        }, 4000);
      } else {
        text.textContent = msg;
        mlShowErr(msg);
      }
    } else if (!ok) {
      mlShowErr(msg);
    }
  };
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
    `/api/ml/install?packages=${encodeURIComponent(pkgs.join(","))}`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "progress") {
      log.textContent += (m.line || "") + "\n";
      log.scrollTop = log.scrollHeight;
      // stage frames only; a raw pip line without a stage would flicker
      // through the status faster than anyone reads it
      if (m.stage) setStatus(mlInstallLine(m));
      else if (ml.installing.status === "Starting…") setStatus("Preparing the download…");
    } else if (m.type === "ok") {
      finish(true, "", m);
    } else if (m.type === "error") {
      finish(false, m.message || "install failed");
    }
  };
  ws.onerror = () => { if (ml.installing) finish(false, "the install stream broke; try again"); };
}

function renderMLCatalog() {
  const host = $("ml-catalog");
  host.innerHTML = "";
  for (const cat of ml.catalog.categories) {
    const models = ml.catalog.models.filter((m) => m.category === cat.key);
    if (!models.length) continue;
    const group = document.createElement("div");
    group.className = "ml-cat";
    group.innerHTML = `<div class="ml-cat-title">${mlEsc(cat.label)}</div>`;
    for (const m of models) {
      const card = document.createElement("button");
      card.className = "ml-model" + (m.ready ? "" : " needs-deps");
      card.dataset.key = m.key;
      const missing = (m.deps || []).filter((d) => !((ml.catalog.deps || {})[d] || {}).installed);
      card.innerHTML =
        `<span class="ml-model-name">${mlEsc(m.name)}</span>` +
        (m.gpu ? '<span class="ml-tag" title="Uses your GPU when available">GPU</span>' : "") +
        (m.ready ? "" : `<span class="ml-tag dim" title="Needs ${mlEsc(missing.join(", ") || "libraries")} (not installed yet); one click installs it">SETUP</span>`);
      card.title = (m.description || "") + (m.ready ? "" : `\nNeeds: ${missing.join(", ")} (not installed yet)`);
      card.onclick = () => selectMLModel(m, card);
      group.appendChild(card);
    }
    host.appendChild(group);
  }
}

/* Blueprint editor highlighting: same two-layer scheme as the workspace
   IDE (pyTokenHTML + a coloured backdrop under a transparent-text
   textarea). Blueprints are always Python, so no extension check. */
function mlHighlight() {
  const src = $("ml-code").value;
  $("ml-hl-code").innerHTML = pyTokenHTML(src) + "\n";
  const lines = src.split("\n").length;
  if (ml.gutterLines !== lines) {
    ml.gutterLines = lines;
    let nums = "";
    for (let i = 1; i <= lines; i++) nums += `<div>${i}</div>`;
    $("ml-gutter").innerHTML = nums;
  }
  mlSyncScroll();
}

function mlSyncScroll() {
  const ta = $("ml-code"), hl = $("ml-hl");
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  $("ml-gutter").scrollTop = ta.scrollTop;
}

/* Every programmatic write goes through here so the backdrop can never
   disagree with the textarea. */
function mlSetCode(code) {
  $("ml-code").value = code;
  mlHighlight();
}

function setupMLConfig() {
  $("ml-run").onclick = runML;
  $("ml-stop").onclick = stopML;
  $("ml-install").onclick = installMLDeps;
  $("ml-ds-build").onclick = openDatasetBuilder;
  $("ml-ds-cancel").onclick = () => $("ml-ds-modal").classList.add("hidden");
  $("ml-ds-create").onclick = createMLDataset;
  $("ml-ds-source").onchange = mlDsSyncTf;
  $("ml-code").addEventListener("input", mlHighlight);
  $("ml-code").addEventListener("scroll", mlSyncScroll);
  // Picking a dataset rewrites the blueprint's dataset= line in place, so
  // the dropdown and the code never disagree.
  $("ml-ds-pick").onchange = () => {
    const name = $("ml-ds-pick").value;
    if (!name) return;
    const code = $("ml-code").value;
    if (/dataset=(["'])[^"']*\1/.test(code)) {
      mlSetCode(code.replace(/dataset=(["'])[^"']*\1/,
                             `dataset=${JSON.stringify(name)}`));
    }
  };
  refreshMLDatasets();
}

/* Datasets a blueprint can name: built ML datasets (features baked in)
   first, then plain chartable MY DATA imports. */
async function refreshMLDatasets() {
  let built = [], imports = [];
  try { built = await fetch("/api/ml/datasets").then((r) => r.json()); }
  catch (e) { /* older engine */ }
  try {
    imports = (await fetch("/api/data").then((r) => r.json()))
      .filter((d) => d.kind === "ohlcv");
  } catch (e) { /* empty library */ }
  const names = built.map((b) => b.name);
  for (const i of imports) if (!names.includes(i.symbol)) names.push(i.symbol);
  ml.datasets = names;
  ml.imports = imports;
  $("ml-ds-pick").innerHTML = '<option value="">insert dataset&hellip;</option>' +
    names.map((n) => `<option>${mlEsc(n)}</option>`).join("");
  $("ml-ds-source").innerHTML =
    imports.map((i) => `<option>${mlEsc(i.symbol)}</option>`).join("");
  mlDsSyncTf();
}

/* The builder's timeframe menu offers only what the chosen import can
   actually serve: its native bar size and clean multiples of it. The
   engine refuses anything finer (a daily file cannot yield hourly bars),
   so an impossible choice must never be selectable; before this, the
   default 1h on a daily sample failed the build with an opaque 502. */
const ML_DS_TFS = [["1s", 1], ["30s", 30], ["1m", 60], ["5m", 300],
                   ["15m", 900], ["30m", 1800], ["1h", 3600],
                   ["4h", 14400], ["1d", 86400], ["1w", 604800]];
function mlDsSyncTf() {
  const entry = (ml.imports || []).find((i) => i.symbol === $("ml-ds-source").value);
  const native = ML_DS_TFS.find(([t]) => t === (entry || {}).timeframe);
  const usable = native
    ? ML_DS_TFS.filter(([, s]) => s >= native[1] && s % native[1] === 0)
    // Unknown native resolution: keep the historic 1m..1d menu.
    : ML_DS_TFS.filter(([, s]) => s >= 60 && s <= 86400);
  const sel = $("ml-ds-tf");
  const prev = sel.value;
  sel.innerHTML = usable.map(([t]) => `<option>${t}</option>`).join("");
  sel.value = usable.some(([t]) => t === prev) ? prev : usable[0][0];
}

/* A model click writes its blueprint (the settings schema rendered as
   runnable code) into the editor. */
async function selectMLModel(m, card) {
  ml.model = m;
  for (const b of document.querySelectorAll(".ml-model")) b.classList.remove("active");
  if (card) card.classList.add("active");
  $("ml-empty").classList.add("hidden");
  $("ml-config").classList.remove("hidden");
  $("ml-results").classList.add("hidden");
  $("ml-progress").classList.add("hidden");
  $("ml-err").classList.add("hidden");
  $("ml-model-head").innerHTML =
    `<div class="ml-model-title">${mlEsc(m.name)}</div>` +
    `<div class="ml-model-desc">${mlEsc(m.description || "")}</div>`;

  if (!ml.datasets) await refreshMLDatasets();
  const ds = (ml.datasets && ml.datasets[0]) || "";
  try {
    const r = await fetch(`/api/ml/blueprint?model=${encodeURIComponent(m.key)}` +
                          `&dataset=${encodeURIComponent(ds)}`);
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    mlSetCode((await r.json()).code);
  } catch (e) {
    mlShowErr(String(e.message || e));
  }
  if (!ds) {
    mlShowErr("No datasets yet: import files in MY DATA, or use Build dataset.");
  }

  // Missing-library banner with one-click install (allowlisted server-side).
  const warn = $("ml-deps-warn");
  warn.classList.remove("busy", "done");
  if (!m.ready && !ml.hosted) {
    const missing = (m.deps || []).filter((d) => !(ml.catalog.deps[d] || {}).installed);
    // Plain words: what is missing, that it is not on this machine yet,
    // that one download fixes it, and who else benefits.
    const deps = mlDepsMerged();
    const others = [...new Set(missing.flatMap((d) => (deps[d] && deps[d].models) || []))]
      .filter((n) => n !== m.name);
    const have = (m.deps || []).filter((d) => (ml.catalog.deps[d] || {}).installed);
    $("ml-deps-text").textContent =
      `${m.name} needs ${missing.join(" and ")}, not installed on this computer yet` +
      (have.length ? ` (${have.join(", ")} already ${have.length === 1 ? "is" : "are"})` : "") +
      ". One download into the terminal's own Python" +
      (others.length ? `; ${others.slice(0, 4).join(", ")}${others.length > 4 ? " and more" : ""} use it too.` : ".");
    $("ml-install").textContent = missing.length === 1 ? `Install ${missing[0]}` : `Install ${missing.length} libraries`;
    $("ml-install").disabled = !!ml.installing;
    warn.classList.remove("hidden");
    $("ml-run").disabled = true;
  } else {
    warn.classList.add("hidden");
    $("ml-run").disabled = ml.hosted;
    if (ml.hosted) $("ml-run").textContent = "DOWNLOAD THE APP TO TRAIN";
  }
}

function mlShowErr(msg) {
  const e = $("ml-err");
  e.textContent = msg;
  e.classList.remove("hidden");
}

/* ── Dataset builder: MY DATA import -> named training dataset ── */
function openDatasetBuilder() {
  const fh = $("ml-ds-features");
  if (!fh.childElementCount && ml.catalog) {
    for (const f of ml.catalog.features || []) {
      if (["open", "high", "low", "close", "volume"].includes(f.id)) continue;
      const chip = document.createElement("label");
      chip.className = "ml-feat";
      chip.innerHTML = `<input type="checkbox" value="${mlEsc(f.id)}">` +
                       `<span>${mlEsc(f.label)}</span>`;
      fh.appendChild(chip);
    }
  }
  $("ml-ds-err").classList.add("hidden");
  mlDsSyncTf();
  $("ml-ds-modal").classList.remove("hidden");
}

async function createMLDataset() {
  const body = {
    name: $("ml-ds-name").value.trim(),
    source: $("ml-ds-source").value,
    timeframe: $("ml-ds-tf").value,
    bars: parseInt($("ml-ds-bars").value, 10) || 5000,
    features: [...$("ml-ds-features").querySelectorAll("input:checked")]
      .map((i) => i.value),
  };
  const err = $("ml-ds-err");
  err.classList.add("hidden");
  if (!body.name) { err.textContent = "Give the dataset a name."; err.classList.remove("hidden"); return; }
  if (!body.source) { err.textContent = "Import a price file in MY DATA first."; err.classList.remove("hidden"); return; }
  const btn = $("ml-ds-create");
  btn.disabled = true;
  btn.textContent = "BUILDING…";
  try {
    const r = await fetch("/api/ml/build-dataset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    const entry = await r.json();
    await refreshMLDatasets();
    $("ml-ds-modal").classList.add("hidden");
    // Point the open blueprint at the new dataset immediately.
    const code = $("ml-code").value;
    if (/dataset=(["'])[^"']*\1/.test(code)) {
      mlSetCode(code.replace(/dataset=(["'])[^"']*\1/,
                             `dataset=${JSON.stringify(entry.name)}`));
    }
  } catch (e) {
    err.textContent = String(e.message || e);
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "CREATE DATASET";
  }
}

async function runML() {
  const code = $("ml-code").value;
  if (!code.trim()) { mlShowErr("The blueprint is empty; pick a model on the left."); return; }
  $("ml-err").classList.add("hidden");
  $("ml-results").classList.add("hidden");
  const btn = $("ml-run");
  btn.disabled = true;
  btn.textContent = "STARTING…";
  try {
    const r = await fetch("/api/ml/run-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    const { job_id } = await r.json();
    ml.job = job_id;
    $("ml-log").textContent = "";
    $("ml-progress").classList.remove("hidden");
    $("ml-stop").classList.remove("hidden");
    btn.textContent = "TRAINING…";
    streamMLJob(job_id);
  } catch (e) {
    mlShowErr(String(e.message || e));
    btn.disabled = false;
    btn.textContent = "▶ RUN";
  }
}

function streamMLJob(jobId) {
  if (ml.ws) { try { ml.ws.close(); } catch (e) { /* replacing */ } }
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
    `/api/ml/jobs/${encodeURIComponent(jobId)}/stream`);
  ml.ws = ws;
  const log = $("ml-log");
  ws.onmessage = (ev) => {
    // A replaced stream (new job started) still delivers queued frames;
    // the old job's lines and its "end" must not touch the new job's UI.
    if (ml.ws !== ws) return;
    const m = JSON.parse(ev.data);
    if (m.type === "line") {
      log.textContent += m.line + "\n";
      log.scrollTop = log.scrollHeight;
    } else if (m.type === "end") {
      finishMLJob(m);
    } else if (m.type === "error") {
      mlShowErr(m.message);
    }
  };
  ws.onclose = () => { if (ml.ws === ws) ml.ws = null; };
}

function finishMLJob(m) {
  $("ml-stop").classList.add("hidden");
  const btn = $("ml-run");
  btn.disabled = false;
  btn.textContent = "▶ RUN";
  if (m.status === "done") {
    renderMLResults(m.results);
  } else if (m.status === "cancelled") {
    mlShowErr("Training stopped.");
  } else {
    mlShowErr(m.error || "training failed; see the log above");
  }
  renderMLHistory();
}

async function stopML() {
  if (!ml.job) return;
  try { await fetch(`/api/ml/jobs/${encodeURIComponent(ml.job)}/cancel`, { method: "POST" }); }
  catch (e) { /* job may have just finished */ }
}

/* Results are whatever JSON the training script emitted. Shapes vary per
   model, so the renderer is generic: top-level scalars (and one level of
   nested scalar objects, e.g. {metrics:{...}}) become stat tiles, arrays
   and deeper objects land in a collapsible raw view. */
function renderMLResults(results) {
  const host = $("ml-results");
  host.classList.remove("hidden");
  // A `pca3d` payload gets the dedicated interactive 3D view; hoist it (and
  // the scree data) out so the generic walker doesn't dump it as raw JSON.
  let pca = null, scree = null;
  if (results && !Array.isArray(results) && results.pca3d) {
    pca = results.pca3d;
    scree = results.explained_variance_pct || null;
    results = { ...results };
    delete results.pca3d;
    delete results.explained_variance_pct;
  }
  const tiles = [];
  const rest = {};
  const addTile = (k, v) => {
    const num = typeof v === "number" ? (Math.abs(v) >= 1000 ? v.toLocaleString() : +v.toFixed(6)) : v;
    tiles.push(`<div class="stat"><div class="k">${mlEsc(k.replace(/_/g, " "))}</div>` +
               `<div class="v">${mlEsc(num)}</div></div>`);
  };
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v === null || ["number", "string", "boolean"].includes(typeof v)) {
        if (tiles.length < 24) addTile(prefix ? `${prefix} ${k}` : k, v);
      } else if (!prefix && typeof v === "object" && !Array.isArray(v)
                 && Object.values(v).every((x) => x === null || typeof x !== "object")) {
        walk(v, k);
      } else {
        rest[prefix ? `${prefix}.${k}` : k] = v;
      }
    }
  };
  if (Array.isArray(results)) rest.results = results;
  else walk(results, "");
  host.innerHTML =
    '<div class="ml-block-title">RESULTS</div>' +
    (tiles.length ? `<div class="ml-stats">${tiles.join("")}</div>` : "") +
    (pca ? pcaViewHTML() : "") +
    (Object.keys(rest).length
      ? `<details class="ml-raw"><summary>Full output</summary><pre>${mlEsc(JSON.stringify(rest, null, 2))}</pre></details>`
      : "");
  if (pca) pcaViewInit(host.querySelector(".pca3d"), pca, scree);
}

/* ── PCA 3D FACTOR VIEW ────────────────────────────────────────────────
   Interactive 3D scatter for the PCA Factor Analysis model: every bar
   projected onto PC1/PC2/PC3, drag to rotate, scroll to zoom, hover for
   the bar behind each point. Hand-rolled canvas projection because the
   terminal ships no 3D library and the vendor dir stays lean on purpose. */

function pcaViewHTML() {
  return (
    '<div class="pca3d">' +
      '<div class="pca3d-main">' +
        '<div class="pca3d-wrap">' +
          '<canvas class="pca3d-canvas"></canvas>' +
          '<div class="pca3d-tip hidden"></div>' +
          '<div class="pca3d-hud">drag rotate &middot; scroll zoom</div>' +
        '</div>' +
        '<div class="pca3d-ctl">' +
          '<button type="button" class="pca3d-reset">Reset view</button>' +
          '<label><input type="checkbox" class="pca3d-scale"> True scale</label>' +
          '<label><input type="checkbox" class="pca3d-trail" checked> Trail</label>' +
        '</div>' +
      '</div>' +
      '<div class="pca3d-side">' +
        '<div class="pca3d-legend"></div>' +
        '<div class="pca3d-scree"></div>' +
        '<div class="pca3d-loads"></div>' +
      '</div>' +
    '</div>');
}

function pcaCssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [17 * parseInt(m[1][0], 16), 17 * parseInt(m[1][1], 16), 17 * parseInt(m[1][2], 16)];
  return [128, 128, 128];
}

function pcaMix(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t),
          Math.round(a[1] + (b[1] - a[1]) * t),
          Math.round(a[2] + (b[2] - a[2]) * t)];
}

function pcaViewInit(root, pca, scree) {
  if (!root || !pca || !Array.isArray(pca.points) || !pca.points.length) return;
  const canvas = root.querySelector(".pca3d-canvas");
  const wrap = root.querySelector(".pca3d-wrap");
  const tip = root.querySelector(".pca3d-tip");
  const ctx = canvas.getContext("2d");
  const pts = pca.points;               // [pc1, pc2, pc3, colorValue|null, epoch]
  const n = pts.length;
  const axes = pca.axes || [{ label: "PC1" }, { label: "PC2" }, { label: "PC3" }];
  const colorMeta = pca.color || { domain: [0, 1], diverging: false, label: "" };

  // Per-axis spread for the default normalized view. PC1's variance usually
  // dwarfs PC3's, so raw scores flatten to a pancake; normalizing each axis
  // shows the STRUCTURE while the axis labels keep the honest variance %.
  const std = [0, 1, 2].map((k) => {
    let s = 0, s2 = 0;
    for (const p of pts) { s += p[k]; s2 += p[k] * p[k]; }
    const m = s / n;
    return Math.sqrt(Math.max(s2 / n - m * m, 1e-12));
  });

  const view = { yaw: -0.65, pitch: 0.32, zoom: 1, trueScale: false,
                 trail: true, spin: true, hover: -1, proj: null };

  function colorOf(v, colors) {
    if (v === null || v === undefined) return null;
    const [lo, hi] = colorMeta.domain;
    if (colorMeta.diverging) {
      const lim = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
      const t = Math.max(-1, Math.min(1, v / lim));
      return t < 0 ? pcaMix(colors.mid, colors.down, -t) : pcaMix(colors.mid, colors.up, t);
    }
    const t = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
    return pcaMix(colors.mid, colors.up, t);
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const colors = {
      up: pcaCssColor("--up"), down: pcaCssColor("--down"),
      mid: pcaCssColor("--dim"), edge: pcaCssColor("--edge"),
      text: pcaCssColor("--text"),
    };
    const cx = w / 2, cy = h / 2;
    const scale = Math.min(w, h) * 0.33 * view.zoom;
    const f = 4;  // camera distance in normalized units; gentle perspective
    const cyaw = Math.cos(view.yaw), syaw = Math.sin(view.yaw);
    const cpit = Math.cos(view.pitch), spit = Math.sin(view.pitch);
    // Normalized: each axis scaled to ~3 sigma. True scale: every axis
    // shares PC1's sigma so relative variance is visible as elongation.
    const div = view.trueScale ? [std[0] * 3, std[0] * 3, std[0] * 3]
                               : [std[0] * 3, std[1] * 3, std[2] * 3];

    const project = (x, y, z) => {
      const rx = cyaw * x + syaw * z;
      const rz = -syaw * x + cyaw * z;
      const ry = cpit * y - spit * rz;
      const rz2 = spit * y + cpit * rz;
      const s = f / (f - rz2);
      return [cx + rx * s * scale, cy - ry * s * scale, rz2, s];
    };

    // Axis lines + labels (recessive chrome; data carries the color).
    ctx.lineWidth = 1;
    const axCol = `rgba(${colors.edge.join(",")},0.9)`;
    const labCol = `rgba(${colors.text.join(",")},0.75)`;
    ctx.font = "10px " + getComputedStyle(document.body).fontFamily;
    for (let k = 0; k < 3; k++) {
      const dir = [[1.25, 0, 0], [0, 1.25, 0], [0, 0, 1.25]][k];
      const a = project(-dir[0], -dir[1], -dir[2]);
      const b = project(dir[0], dir[1], dir[2]);
      ctx.strokeStyle = axCol;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      const lab = axes[k] ? `${axes[k].label}${axes[k].var_pct != null ? " " + axes[k].var_pct + "%" : ""}` : "";
      ctx.fillStyle = labCol;
      ctx.fillText(lab, b[0] + 4, b[1] + 3);
    }

    // Project all points, sort far-to-near so nearer points paint on top.
    const proj = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      proj[i] = project(p[0] / div[0], p[1] / div[1], p[2] / div[2]);
    }
    view.proj = proj;
    const order = proj.map((_, i) => i).sort((a, b) => proj[a][2] - proj[b][2]);

    // Chronological trail through factor space for the most recent bars:
    // where the market has just been, fading with age.
    if (view.trail && n > 2) {
      const trail = Math.min(100, n - 1);
      for (let i = n - trail; i < n; i++) {
        const a = proj[i - 1], b = proj[i];
        const age = (i - (n - trail)) / trail;
        ctx.strokeStyle = `rgba(${colors.text.join(",")},${(0.05 + 0.30 * age).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }

    for (const i of order) {
      const [sx, sy, depth, s] = proj[i];
      const rgb = colorOf(pts[i][3], colors);
      const alpha = rgb ? 0.30 + 0.55 * Math.max(0, Math.min(1, (s - 0.75) * 2)) : 0.18;
      ctx.fillStyle = `rgba(${(rgb || colors.mid).join(",")},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1.4, 2.4 * s), 0, 2 * Math.PI);
      ctx.fill();
    }
    if (view.hover >= 0 && view.hover < n) {
      const [sx, sy, , s] = proj[view.hover];
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${colors.text.join(",")},0.95)`;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(4, 3.2 * s), 0, 2 * Math.PI); ctx.stroke();
    }
  }

  // Slow spin sells the depth on first paint; stops at the first touch.
  (function spin() {
    if (!root.isConnected) return;
    if (view.spin) { view.yaw += 0.004; draw(); }
    requestAnimationFrame(spin);
  })();

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    view.spin = false;
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      view.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
      view.pitch = Math.max(-1.4, Math.min(1.4, drag.pitch + (e.clientY - drag.y) * 0.01));
      draw();
      return;
    }
    if (!view.proj) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bd = 100; // 10px hit radius, generous vs the 2-3px marks
    for (let i = 0; i < n; i++) {
      const dx = view.proj[i][0] - mx, dy = view.proj[i][1] - my;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best !== view.hover) {
      view.hover = best;
      if (best >= 0) {
        const p = pts[best];
        const when = new Date(p[4] * 1000);
        const cv = p[3] === null || p[3] === undefined
          ? "n/a (no forward window)"
          : (colorMeta.mode === "time" ? "" : `${p[3]}`);
        tip.innerHTML =
          `<div class="pca3d-tip-t">${mlEsc(when.toLocaleString())}</div>` +
          `<div>PC1 ${p[0]} &middot; PC2 ${p[1]} &middot; PC3 ${p[2]}</div>` +
          (colorMeta.mode !== "time" ? `<div>${mlEsc(colorMeta.label)}: ${mlEsc(cv)}</div>` : "");
        tip.style.left = Math.min(mx + 12, r.width - 170) + "px";
        tip.style.top = Math.max(my - 10, 4) + "px";
        tip.classList.remove("hidden");
      } else {
        tip.classList.add("hidden");
      }
      draw();
    } else if (best >= 0) {
      tip.style.left = Math.min(mx + 12, r.width - 170) + "px";
      tip.style.top = Math.max(my - 10, 4) + "px";
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  });
  canvas.addEventListener("pointerleave", () => {
    if (view.hover !== -1) { view.hover = -1; tip.classList.add("hidden"); draw(); }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.spin = false;
    view.zoom = Math.max(0.35, Math.min(4, view.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    draw();
  }, { passive: false });

  root.querySelector(".pca3d-reset").onclick = () => {
    view.yaw = -0.65; view.pitch = 0.32; view.zoom = 1; draw();
  };
  root.querySelector(".pca3d-scale").onchange = (e) => { view.trueScale = e.target.checked; draw(); };
  root.querySelector(".pca3d-trail").onchange = (e) => { view.trail = e.target.checked; draw(); };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(draw).observe(wrap);

  // Legend: what point color means, as a labeled gradient of the same ramp.
  const legend = root.querySelector(".pca3d-legend");
  {
    const colors = { up: pcaCssColor("--up"), down: pcaCssColor("--down"), mid: pcaCssColor("--dim") };
    const stops = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const v = colorMeta.domain[0] + (colorMeta.domain[1] - colorMeta.domain[0]) * t;
      stops.push(`rgb(${(colorOf(v, colors) || colors.mid).join(",")}) ${Math.round(t * 100)}%`);
    }
    const [lo, hi] = colorMeta.domain;
    const fmt = (v) => colorMeta.mode === "time"
      ? new Date(v * 1000).toLocaleDateString()
      : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    legend.innerHTML =
      `<div class="pca3d-legend-t">${mlEsc(colorMeta.label || "")}</div>` +
      `<div class="pca3d-legend-bar" style="background:linear-gradient(90deg,${stops.join(",")})"></div>` +
      `<div class="pca3d-legend-ends"><span>${mlEsc(fmt(lo))}</span>` +
      (colorMeta.diverging ? "<span>0</span>" : "") +
      `<span>${mlEsc(fmt(hi))}</span></div>`;
  }

  // Scree: variance per component; the three drawn axes get direct labels.
  const screeHost = root.querySelector(".pca3d-scree");
  if (scree && scree.length) {
    const max = Math.max(...scree, 1);
    screeHost.innerHTML =
      '<div class="pca3d-side-t">EXPLAINED VARIANCE</div>' +
      '<div class="pca3d-scree-row">' +
      scree.map((v, i) =>
        `<div class="pca3d-scree-col" title="PC${i + 1}: ${v}%">` +
          `<div class="pca3d-scree-val">${i < 3 ? Math.round(v) + "%" : ""}</div>` +
          `<div class="pca3d-scree-bar${i < 3 ? " on" : ""}" style="height:${Math.max(2, Math.round(34 * v / max))}px"></div>` +
          `<div class="pca3d-scree-k">${i + 1}</div>` +
        `</div>`).join("") +
      "</div>";
  }

  // Loadings: what each drawn component is made of, top drivers by weight.
  // Sign uses the product's up/down colors: polarity, not identity.
  const loadsHost = root.querySelector(".pca3d-loads");
  const L = pca.loadings;
  if (L && Array.isArray(L.features)) {
    const pcs = [["PC1", L.pc1], ["PC2", L.pc2], ["PC3", L.pc3]];
    loadsHost.innerHTML = pcs.map(([name, vec]) => {
      if (!Array.isArray(vec)) return "";
      const top = vec.map((v, i) => [i, v])
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
      const maxAbs = Math.abs(top[0][1]) || 1;
      return '<div class="pca3d-side-t">' + name + " DRIVERS</div>" +
        top.map(([i, v]) =>
          `<div class="pca3d-load"><span class="pca3d-load-f">${mlEsc(L.features[i])}</span>` +
          `<span class="pca3d-load-bar"><i class="${v < 0 ? "neg" : "pos"}" style="width:${Math.round(50 * Math.abs(v) / maxAbs)}%"></i></span>` +
          `<span class="pca3d-load-v">${v > 0 ? "+" : ""}${v.toFixed(2)}</span></div>`).join("");
    }).join("");
  }

  draw();
}

async function renderMLHistory() {
  let data;
  try { data = await fetch("/api/ml/jobs").then((r) => r.json()); }
  catch (e) { return; }
  const rows = [...(data.running || []), ...(data.history || [])].slice(0, 12);
  const host = $("ml-history");
  if (!rows.length) { host.className = "md-empty"; host.textContent = "No training runs yet."; return; }
  host.className = "";
  host.innerHTML = rows.map((j) =>
    `<button class="ml-hist-row" data-job="${mlEsc(j.id)}">` +
    `<span class="ml-hist-status ${mlEsc(j.status)}">${mlEsc(j.status.toUpperCase())}</span>` +
    `<span class="ml-hist-name">${mlEsc(j.model_name)}</span>` +
    `<span class="ml-hist-data">${mlEsc(j.dataset)}</span>` +
    `<span class="ml-hist-time">${new Date((j.finished || j.created) * 1000).toLocaleString()}</span>` +
    `</button>`).join("");
  for (const btn of host.querySelectorAll(".ml-hist-row")) {
    btn.onclick = async () => {
      try {
        const rec = await fetch(`/api/ml/jobs/${encodeURIComponent(btn.dataset.job)}`).then((r) => r.json());
        $("ml-empty").classList.add("hidden");
        if (rec.lines) {
          $("ml-log").textContent = rec.lines.join("\n");
          $("ml-progress").classList.remove("hidden");
        }
        if (rec.results) renderMLResults(rec.results);
        else if (rec.error) mlShowErr(rec.error);
      } catch (e) { /* record may have been pruned */ }
    };
  }
}

function installMLDeps() {
  if (!ml.model) return;
  const missing = (ml.model.deps || []).filter((d) => !(ml.catalog.deps[d] || {}).installed);
  if (!missing.length) return;
  mlInstall(missing);
}

/* ── STRATEGY BRIEF ─────────────────────────────────────────────────────
   BACKTEST > ALGO DEVELOPMENT read as a second copy of WORKSPACE > IDE.
   What makes it different is the assistant building strategies
   with the user, so on that page the assistant moves down and this panel
   sits at the top of the rail: pre-configured choices for the backtest
   they want, and one BUILD button that turns them into a precise request
   sent through the assistant's own composer path (aiPanelSend), so the
   normal test-before-deliver loop applies. Choices persist in
   localStorage; the panel shows only while #pyide is on screen (a
   MutationObserver on its class, same idea as the ticket's rail sync). */
const BB_OPTS = {
  approach: [
    ["trend", "Trend"], ["meanrev", "Mean reversion"], ["breakout", "Breakout"],
    ["momentum", "Momentum"], ["regime", "Regime filter"], ["pairs", "Pairs / spread"],
    ["ml", "Machine learning"], ["any", "Assistant's pick"]],
  direction: [["long", "Long only"], ["both", "Long & short"]],
  horizon: [["intraday", "Intraday"], ["days", "Days"], ["weeks", "Weeks"]],
  risk: [["stop", "Stop loss (ATR)"], ["target", "Take profit"], ["vol", "Vol-targeted size"]],
  costs: [["none", "No costs"], ["real", "Realistic costs"]],
  validate: [["wf", "Walk-forward"], ["mc", "Monte Carlo"]],
};
const BB_TEXT = {
  approach: { trend: "a trend-following strategy", meanrev: "a mean-reversion strategy",
    breakout: "a breakout strategy", momentum: "a momentum strategy",
    regime: "a strategy with a regime filter (trade only in the regime that suits it)",
    pairs: "a pairs / spread strategy against another dataset in my library",
    ml: "a strategy whose signal comes from a machine-learning model trained on the data",
    any: "the strategy you think fits this data best" },
  direction: { long: "long only", both: "long and short" },
  horizon: { intraday: "holding intraday (in and out within the day)",
    days: "holding for a few days", weeks: "holding for weeks" },
  risk: { stop: "an ATR-based stop loss", target: "a take-profit target",
    vol: "volatility-targeted position sizing" },
  costs: { none: "no commission or spread", real: "realistic costs (0.05% commission per side)" },
  validate: { wf: "a walk-forward (4 folds, sweep the main parameters, report per-fold out-of-sample results and efficiency)",
    mc: "a Monte Carlo on the trades (drawdown percentiles, risk of ruin)" },
};
const bb = { sel: null, folded: false, wired: false };

function bbLoad() {
  if (bb.sel) return bb.sel;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("lse.btBrief") || "null"); } catch (e) { /* fresh */ }
  bb.sel = Object.assign({ dataset: "", approach: "trend", direction: "both", horizon: "days",
                           risk: ["stop", "vol"], costs: "real", validate: ["wf", "mc"], notes: "" },
                         saved || {});
  try { bb.folded = localStorage.getItem("lse.btBriefFold") === "1"; } catch (e) { /* fresh */ }
  return bb.sel;
}

function bbSave() {
  try { localStorage.setItem("lse.btBrief", JSON.stringify(bb.sel)); } catch (e) { /* optional */ }
  try { localStorage.setItem("lse.btBriefFold", bb.folded ? "1" : "0"); } catch (e) { /* optional */ }
}

function bbSummary(sel) {
  const ds = sel.dataset || py.dataset || "";
  const parts = [ds, BB_OPTS.approach.find((o) => o[0] === sel.approach)?.[1],
                 sel.direction === "long" ? "long" : "long/short",
                 BB_OPTS.horizon.find((o) => o[0] === sel.horizon)?.[1]?.toLowerCase()];
  return parts.filter(Boolean).join(" · ");
}

/* The request the assistant receives. Plain sentences, every choice
   stated, ending with what to run and how to report, so the answer is a
   tested strategy with honest numbers rather than a sketch. */
function bbCompose(sel, mode) {
  const ds = sel.dataset || py.dataset || "";
  const d = (state.datasetList || []).find((x) => x.symbol === ds);
  const tf = d && d.timeframe ? ` ${d.timeframe}` : "";
  const risk = (sel.risk || []).map((k) => BB_TEXT.risk[k]).filter(Boolean);
  const val = (sel.validate || []).map((k) => BB_TEXT.validate[k]).filter(Boolean);
  const lines = [];
  if (mode === "improve" && py.open) {
    lines.push(`Improve the strategy open in my editor (${py.open}) so it becomes ` +
               `${BB_TEXT.approach[sel.approach] || "a better strategy"}` +
               (ds ? `, run on ${ds}${tf}` : "") + `, ${BB_TEXT.direction[sel.direction]}, ` +
               `${BB_TEXT.horizon[sel.horizon]}.`);
  } else {
    lines.push(`Build ${BB_TEXT.approach[sel.approach] || "a strategy"} on ${ds || "the dataset you think fits"}${tf}, ` +
               `${BB_TEXT.direction[sel.direction]}, ${BB_TEXT.horizon[sel.horizon]}.`);
  }
  lines.push(risk.length ? `Risk: ${risk.join(", ")}.` : "Risk: keep it simple, no stops beyond the exit rule.");
  lines.push(`Costs: ${BB_TEXT.costs[sel.costs] || BB_TEXT.costs.none}.`);
  lines.push("Keep the parameters few and standard; do not tune them to this history.");
  lines.push("Test it with run_backtest first" + (val.length ? `, then run ${val.join(" and ")}` : "") +
             ", and report the real numbers, plainly, including when it loses.");
  if (sel.notes && sel.notes.trim()) lines.push(sel.notes.trim());
  return lines.join(" ");
}

function bbChipRow(key, multi) {
  const sel = bbLoad();
  return `<div class="bb-chips" data-key="${key}">` + BB_OPTS[key].map(([v, label]) => {
    const on = multi ? (sel[key] || []).includes(v) : sel[key] === v;
    return `<button class="bb-chip${on ? " sel" : ""}" data-v="${v}">${label}</button>`;
  }).join("") + "</div>";
}

function btBriefRender() {
  const host = $("bt-brief");
  if (!host) return;
  const sel = bbLoad();
  const dsets = (state.datasetList || []).filter((d) => (d.kind || "ohlcv") !== "series");
  if (!sel.dataset || !dsets.some((d) => d.symbol === sel.dataset)) {
    sel.dataset = (py.dataset && dsets.some((d) => d.symbol === py.dataset)) ? py.dataset
      : (dsets[0] ? dsets[0].symbol : "");
  }
  host.classList.toggle("folded", bb.folded);
  host.innerHTML =
    '<div class="bb-head"><span class="bb-title">STRATEGY BRIEF</span>' +
    `<span class="bb-sum">${bb.folded ? mlEsc(bbSummary(sel)) : ""}</span>` +
    `<button class="bb-fold" title="${bb.folded ? "Show the brief" : "Fold the brief"}">${bb.folded ? "&#9662;" : "&#9652;"}</button></div>` +
    '<div class="bb-body">' +
    '<div class="bb-row"><span class="bb-lab">Trade</span><select id="bb-dataset">' +
      (dsets.length ? dsets.map((d) => `<option value="${mlEsc(d.symbol)}"${d.symbol === sel.dataset ? " selected" : ""}>` +
        `${mlEsc(d.symbol)}${d.timeframe ? " · " + mlEsc(d.timeframe) : ""}</option>`).join("")
        : '<option value="">no datasets yet: import one under MY DATA</option>') +
    "</select></div>" +
    `<div class="bb-row"><span class="bb-lab">Approach</span>${bbChipRow("approach", false)}</div>` +
    `<div class="bb-row"><span class="bb-lab">Side</span>${bbChipRow("direction", false)}</div>` +
    `<div class="bb-row"><span class="bb-lab">Hold</span>${bbChipRow("horizon", false)}</div>` +
    `<div class="bb-row"><span class="bb-lab">Risk</span>${bbChipRow("risk", true)}</div>` +
    `<div class="bb-row"><span class="bb-lab">Costs</span>${bbChipRow("costs", false)}</div>` +
    `<div class="bb-row"><span class="bb-lab">Validate</span>${bbChipRow("validate", true)}</div>` +
    '<div class="bb-row"><span class="bb-lab">Notes</span>' +
      `<input type="text" id="bb-notes" placeholder="anything else, e.g. only trade London hours" value="${mlEsc(sel.notes || "")}"></div>` +
    '<div class="bb-actions"><button class="bb-build" id="bb-build">Build it</button>' +
      (py.open ? `<button class="bb-alt" id="bb-improve" title="Apply the brief to ${mlEsc(py.open)}">Improve open file</button>` : "") +
      '<span class="bb-note" id="bb-note"></span></div>' +
    "</div>";
  host.querySelector(".bb-fold").onclick = () => { bb.folded = !bb.folded; bbSave(); btBriefRender(); };
  host.querySelectorAll(".bb-chips").forEach((row) => {
    const key = row.dataset.key;
    const multi = key === "risk" || key === "validate";
    row.querySelectorAll(".bb-chip").forEach((c) => {
      c.onclick = () => {
        if (multi) {
          const cur = new Set(sel[key] || []);
          if (cur.has(c.dataset.v)) cur.delete(c.dataset.v); else cur.add(c.dataset.v);
          sel[key] = [...cur];
        } else {
          sel[key] = c.dataset.v;
        }
        bbSave(); btBriefRender();
      };
    });
  });
  const dsel = $("bb-dataset");
  if (dsel) dsel.onchange = () => { sel.dataset = dsel.value; bbSave(); };
  const notes = $("bb-notes");
  if (notes) notes.oninput = () => { sel.notes = notes.value; bbSave(); };
  $("bb-build").onclick = () => bbSend("build");
  const imp = $("bb-improve");
  if (imp) imp.onclick = () => bbSend("improve");
}

function bbSend(mode) {
  const sel = bbLoad();
  if (!sel.dataset && !(state.datasetList || []).length) {
    $("bb-note").textContent = "import a dataset first";
    return;
  }
  const text = bbCompose(sel, mode);
  if (aiPanelSend(text)) {
    $("bb-note").textContent = "sent to the assistant";
    setTimeout(() => { const n = $("bb-note"); if (n) n.textContent = ""; }, 3000);
  } else {
    $("bb-note").textContent = "the assistant is not available here";
  }
}

/* Show the brief only while the Algo Development page is on screen. */
function btBriefSync() {
  const host = $("bt-brief");
  if (!host) return;
  const on = !$("pyide").classList.contains("hidden") && !(state.hosted);
  const was = !host.classList.contains("hidden");
  host.classList.toggle("hidden", !on);
  if (on && (!was || !host.childElementCount)) btBriefRender();
}

function btBriefInit() {
  if (bb.wired || !$("bt-brief") || !$("pyide")) return;
  bb.wired = true;
  new MutationObserver(btBriefSync).observe($("pyide"), { attributes: true, attributeFilter: ["class"] });
  btBriefSync();
}

/* ── ALGO DEVELOPMENT IDE (BACKTEST > Algo Development) ──────────────
   VS Code style: a real workspace folder of .py files (the AI agents work
   in the SAME directory), an editor with autosave, and one-click backtests
   through the python engine on any dataset the user picks. */
const py = { loaded: false, files: [], open: null, dirty: false,
             saveTimer: null, job: null, ws: null,
             // The docked terminal panel: instance list (VS Code style),
             // each {id, kind, host, term, fit, ws, name}.
             terms: [], termSeq: 0, termActive: null,
             // Backtest dataset: picked by clicking a data file in the
             // library (no toolbar dropdown).
             dataset: null,
             // VS Code tab bar: ids are script paths
             // or "data:SYMBOL" for dataset previews; persisted so the bar
             // survives restarts like an editor's session.
             tabs: [], active: null, tabsRestored: false, previewCache: {} };

function pyTabsSave() {
  try {
    localStorage.setItem("lse.pyTabs",
      JSON.stringify({ tabs: py.tabs, active: py.active }));
  } catch (e) { /* optional */ }
}

/* Strategy editor highlighting: same two-layer scheme as the workspace
   IDE and the ML blueprint (pyTokenHTML + coloured backdrop under a
   transparent-text textarea). Strategy files are always Python. */
function pyIdeHighlight() {
  const src = $("py-code").value;
  $("py-hl-code").innerHTML = pyTokenHTML(src) + "\n";
  const lines = src.split("\n").length;
  if (py.gutterLines !== lines) {
    py.gutterLines = lines;
    let nums = "";
    for (let i = 1; i <= lines; i++) nums += `<div>${i}</div>`;
    $("py-gutter").innerHTML = nums;
  }
  pyIdeSyncScroll();
}

function pyIdeSyncScroll() {
  const ta = $("py-code"), hl = $("py-hl");
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  $("py-gutter").scrollTop = ta.scrollTop;
}

/* Every programmatic write goes through here so the backdrop can never
   disagree with the textarea. */
function pyIdeSetCode(code) {
  $("py-code").value = code;
  pyIdeHighlight();
}

function pyTabLabel(id) {
  if (id.startsWith("data:")) {
    const sym = id.slice(5);
    const d = (state.datasetList || []).find((x) => x.symbol === sym);
    return (d ? (d.name || d.symbol) + (d.ext || ".csv") : sym);
  }
  return id.split("/").pop();
}

function renderPyTabs() {
  const host = $("py-tabs");
  if (!host) return;
  host.innerHTML = "";
  for (const id of py.tabs) {
    const tab = document.createElement("div");
    tab.className = "py-tab" + (id === py.active ? " active" : "");
    tab.title = id.startsWith("data:") ? id.slice(5) : id;
    const ico = id.startsWith("data:")
      ? FILE_ICO.table : libFileIcon(id);
    tab.innerHTML = `<span class="tree-ico">${ico}</span>` +
      `<span class="py-tab-name">${mlEsc(pyTabLabel(id))}</span>` +
      `<button class="py-tab-x" title="Close">&#10005;</button>`;
    tab.onclick = (e) => {
      if (e.target.closest(".py-tab-x")) return;
      pyActivateTab(id);
    };
    tab.querySelector(".py-tab-x").onclick = (e) => {
      e.stopPropagation();
      pyCloseTab(id);
    };
    host.appendChild(tab);
  }
}

function pyActivateTab(id) {
  if (id.startsWith("data:")) {
    const sym = id.slice(5);
    const d = (state.datasetList || []).find((x) => x.symbol === sym);
    if (!d) { pyCloseTab(id); return; }
    pyShowPreview(d);
  } else {
    pyOpen(id);
  }
}

function pyCloseTab(id) {
  const i = py.tabs.indexOf(id);
  if (i === -1) return;
  py.tabs.splice(i, 1);
  if (py.active === id) {
    py.active = py.tabs[Math.min(i, py.tabs.length - 1)] || null;
    if (py.active) {
      pyActivateTab(py.active);
    } else {
      // Nothing open: empty editor, like VS Code with every tab closed.
      py.open = null;
      pyIdeSetCode("");
      pyHidePreview();
    }
  }
  renderPyTabs();
  pyTabsSave();
  renderDataSidebar();
}

/* Make id the active tab (adding it if new) and repaint the bar. */
function pyTabActivated(id) {
  if (!py.tabs.includes(id)) py.tabs.push(id);
  py.active = id;
  renderPyTabs();
  pyTabsSave();
  // The explorer highlight follows the ACTIVE TAB (scripts and data
  // previews alike), so every activation repaints the sidebar.
  renderDataSidebar();
}

/* Drop tabs whose file or dataset no longer exists (rename, delete,
   re-import); called after every library refresh. */
function pyPruneTabs() {
  const ok = (id) => id.startsWith("data:")
    ? (state.datasetList || []).some((d) => d.symbol === id.slice(5))
    : (state.wsFiles || []).some((f) => f.path === id);
  const before = py.tabs.length;
  py.tabs = py.tabs.filter(ok);
  if (py.active && !ok(py.active)) {
    py.active = py.tabs[py.tabs.length - 1] || null;
    if (py.active) pyActivateTab(py.active);
    else { py.open = null; pyIdeSetCode(""); pyHidePreview(); }
  }
  if (py.tabs.length !== before) pyTabsSave();
  renderPyTabs();
}

function pySetDataset(sym) {
  py.dataset = sym || null;
  try { localStorage.setItem("lse.pyDataset", py.dataset || ""); } catch (e) { /* optional */ }
  // the STRATEGY BRIEF follows the IDE's dataset pick
  if (bb.sel && $("bt-brief") && !$("bt-brief").classList.contains("hidden")) {
    bb.sel.dataset = py.dataset || bb.sel.dataset; bbSave(); btBriefRender();
  }
  pyRefreshRunLabel();
}

/* The strategy's own `# run: SYMBOL [TF]` header line (mirrors
   backtest/contract.py parse_run_pin). The pin is the contract that keeps
   the assistant's tested numbers and the RUN button on the same dataset:
   from_chat_2 was delivered against EURUSD, ran on the ambient GOLD pick,
   and silently printed 0 trades. */
function pyRunPin(code) {
  for (const line of String(code || "").split("\n").slice(0, 12)) {
    const m = line.match(/^\s*#\s*run(?:-on)?\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    let sym = m[1], tf = null;
    const parts = sym.split(/\s+/);
    if (parts.length > 1 && /^\d+(s|m|min|h|d|w|mo)$/i.test(parts[parts.length - 1])) {
      tf = parts[parts.length - 1];
      sym = parts.slice(0, -1).join(" ");
    }
    return { symbol: sym, timeframe: tf };
  }
  return null;
}

/* Chat strategies used to land as from_chat.py / from_chat_2.py / ...,
   which told the user nothing once a few piled up. The filename now says
   what the strategy IS: the model's own `# name:` line wins (the head
   asks for one right under the `# run:` pin), else the pinned dataset
   plus the strategy family read off the code. The fallback is a pure
   heuristic, so a miss only costs a blander name; pyCreateFile still
   numbers collisions. */
function pyStrategyFileName(code, pin) {
  const slug = (s) => String(s || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  for (const line of String(code || "").split("\n").slice(0, 12)) {
    const m = line.match(/^\s*#\s*name\s*:\s*(.+?)\s*$/i);
    if (m && slug(m[1])) return slug(m[1]);
  }
  const c = String(code || "").toLowerCase();
  // Ordered most-specific first: named indicators beat generic building
  // blocks (every ATR/chandelier trail contains a rolling max, so a
  // crossover with a trail must not come out as "breakout"), and the
  // fast/slow param convention marks a crossover even when the MAs are
  // built from plain rolling means.
  const twoMa = /["'](fast|slow)["']/.test(c);
  const fam =
    /donchian/.test(c) ? "donchian_breakout" :
    /bollinger|bbands/.test(c) ? "bollinger" :
    /\brsi\b|_rsi|rsi_/.test(c) ? "rsi" :
    /macd/.test(c) ? "macd" :
    /supertrend/.test(c) ? "supertrend" :
    /kalman/.test(c) ? "kalman_trend" :
    /zscore|z_score|mean_rev|reversion/.test(c) ? "meanrev" :
    twoMa && /ewm\(span/.test(c) ? "ema_cross" :
    twoMa ? "sma_cross" :
    /rolling\([^)]*\)\.max\(|rolling\([^)]*\)\.min\(/.test(c) ? "breakout" :
    /ewm\(span/.test(c) ? "ema_cross" :
    /momentum|tsmom/.test(c) ? "momentum" :
    "strategy";
  const sym = pin ? slug(pin.symbol) : "";
  return (sym ? sym + "_" : "") + fam;
}

/* One writer for the "on X" chip: a pinned open strategy shows ITS dataset
   (what RUN will actually use), everything else shows the library pick. */
function pyRefreshRunLabel() {
  const lab = $("py-dataset-label");
  if (!lab) return;
  const pin = py.open ? pyRunPin($("py-code").value) : null;
  if (pin) lab.textContent = `on ${pin.symbol} · pinned`;
  else lab.textContent = py.dataset ? `on ${py.dataset}` : "pick a data file in the library";
}

/* A dataset click while a pinned strategy is open retargets the strategy:
   the `# run:` line is rewritten in place so the file stays the single
   source of truth (and the change is visible, saved, and committed to by
   the next RUN). Unpinned files keep the old shared-pick behavior. */
function pyRepin(sym) {
  if (!py.open || !sym) return;
  const code = $("py-code").value;
  const pin = pyRunPin(code);
  if (!pin || pin.symbol === sym) return;
  const lines = code.split("\n");
  for (let i = 0; i < Math.min(lines.length, 12); i += 1) {
    if (/^\s*#\s*run(?:-on)?\s*:/i.test(lines[i])) {
      lines[i] = `# run: ${sym}`;
      break;
    }
  }
  pyIdeSetCode(lines.join("\n"));
  py.dirty = true;
  clearTimeout(py.saveTimer);
  py.saveTimer = setTimeout(pySave, 800);
}

/* Dataset preview in the editor area: columns + up
   to 100 sample rows via the existing /api/data/{symbol}/rows endpoint
   (which serves the most recent 5000-row window for big files; the header
   states exactly what is shown). UI-only on purpose: the
   auto-deploy ships static files, not engine code, so this must work
   against the API an installed app already has. */
async function pyShowPreview(d) {
  py.previewSeq = (py.previewSeq || 0) + 1;
  const seq = py.previewSeq;
  pyTabActivated("data:" + d.symbol);
  const host = $("py-preview-table");
  $("py-edwrap").classList.add("hidden");
  $("py-preview").classList.remove("hidden");
  // Cache per symbol so switching back to a data tab is instant, like an
  // editor tab; cleared on every library refresh (re-imports invalidate).
  // The cache keeps the whole fetched window (up to the endpoint's 5000)
  // plus how many rows are revealed, so "Load more" is pure UI.
  const hit = py.previewCache[d.symbol];
  if (hit) { pyRenderPreview(d, hit); return; }
  $("py-preview-title").textContent = `${d.name || d.symbol}${d.ext || ".csv"}`;
  $("py-preview-more").classList.add("hidden");
  host.innerHTML = '<div class="md-empty">loading&hellip;</div>';
  let data = null;
  try {
    const r = await fetch(`/api/data/${encodeURIComponent(d.symbol)}/rows`);
    if (r.ok) data = await r.json();
  } catch (e) { /* handled below */ }
  if (seq !== py.previewSeq) return; // a newer click owns the pane
  if (!data || !data.ok || !(data.fields || []).length) {
    host.innerHTML = '<div class="md-empty">Could not read this file.</div>';
    return;
  }
  const cache = {
    cols: data.fields.map((f) => f.name),
    rows: data.rows || [],
    total: data.nrows || (data.rows || []).length,
    shown: Math.min(100, (data.rows || []).length),
  };
  py.previewCache[d.symbol] = cache;
  pyRenderPreview(d, cache);
}

function pyRenderPreview(d, c) {
  const host = $("py-preview-table");
  const fmt = (v) => (v === null || v === undefined) ? "" : String(v);
  const shown = c.rows.slice(0, c.shown);
  // Financial series windows keep the tail server-side, so a truncated
  // file's preview is its most recent rows; say so in the header.
  const windowNote = c.shown >= c.rows.length && c.rows.length < c.total
    ? ` · preview holds the most recent ${c.rows.length.toLocaleString()}` : "";
  $("py-preview-title").textContent =
    `${d.name || d.symbol}${d.ext || ".csv"} · ${c.cols.length} columns · ` +
    `showing ${shown.length.toLocaleString()} of ${c.total.toLocaleString()} rows${windowNote}`;
  host.innerHTML =
    `<table><thead><tr>${c.cols.map((col) => `<th>${mlEsc(col)}</th>`).join("")}</tr></thead>` +
    `<tbody>${shown.map((r) =>
      `<tr>${c.cols.map((col) => `<td>${mlEsc(fmt(r[col]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const more = $("py-preview-more");
  const left = c.rows.length - c.shown;
  if (left > 0) {
    more.textContent = `Load ${Math.min(400, left).toLocaleString()} more rows`;
    more.classList.remove("hidden");
    more.onclick = () => {
      c.shown = Math.min(c.shown + 400, c.rows.length);
      pyRenderPreview(d, c);
    };
  } else {
    more.classList.add("hidden");
  }
}

function pyHidePreview() {
  $("py-preview").classList.add("hidden");
  $("py-edwrap").classList.remove("hidden");
}

async function openPyIDE() {
  subrailMark("sub-bt-py");
  if (!py.loaded) {
    py.loaded = true;
    $("py-run").onclick = pyRun;
    $("py-stop").onclick = pyStop;
    // Terminal panel controls, VS Code layout: + spawns a shell, the
    // chevron menu picks the kind, the trash kills the active instance.
    $("py-term-new").onclick = () => pyTermShow(pyTermMake("shell").id);
    $("py-term-kind").onclick = (e) => {
      e.stopPropagation();
      $("py-term-menu").classList.toggle("hidden");
    };
    for (const b of $("py-term-menu").querySelectorAll("button")) {
      b.onclick = (e) => {
        e.stopPropagation();
        $("py-term-menu").classList.add("hidden");
        pyTermShow(pyTermMake(b.dataset.kind).id);
      };
    }
    document.addEventListener("click", () => $("py-term-menu").classList.add("hidden"));
    $("py-term-kill").onclick = () => {
      if (py.termActive != null) pyTermKill(py.termActive);
    };
    // One observer fits whichever instance is active; hidden panels are
    // skipped or xterm clamps to ~1 column.
    new ResizeObserver(() => {
      if ($("pyide").classList.contains("hidden")) return;
      const inst = py.terms.find((t) => t.id === py.termActive);
      if (inst) { inst.fit.fit(); pyTermSendSize(inst); }
    }).observe($("py-term"));
    pySashInit();
    // The preview's x closes its TAB (VS Code semantics), which also
    // brings back whatever tab is next.
    $("py-preview-close").onclick = () => {
      if (py.active && py.active.startsWith("data:")) pyCloseTab(py.active);
      else pyHidePreview();
    };
    // Autosave: the workspace is the source of truth the AI agents read,
    // so the editor never holds unsaved state for long.
    $("py-code").addEventListener("input", () => {
      pyIdeHighlight();
      py.dirty = true;
      clearTimeout(py.saveTimer);
      py.saveTimer = setTimeout(pySave, 800);
      // Hand-editing the `# run:` line must move the chip immediately;
      // a stale "on GOLD" over an EURUSD pin is the lie this chip exists
      // to prevent.
      pyRefreshRunLabel();
    });
    $("py-code").addEventListener("scroll", pyIdeSyncScroll);
  }
  // Every entry, not just the first: imports made since last visit must
  // show up in the dataset picker without a restart.
  await pyLoadDatasets();
  // The IDE has no explorer of its own anymore: the
  // library sidebar IS the explorer, so refresh it with this ctx active.
  await refreshLibraryAll();
  // Restore last session's tab bar once, after the file/dataset lists are
  // in so stale entries prune instead of 404ing.
  if (!py.tabsRestored) {
    py.tabsRestored = true;
    try {
      const saved = JSON.parse(localStorage.getItem("lse.pyTabs") || "null");
      if (saved && Array.isArray(saved.tabs)) {
        py.tabs = saved.tabs.filter((t) => typeof t === "string");
        py.active = typeof saved.active === "string" ? saved.active : null;
      }
    } catch (e) { /* fresh session */ }
    pyPruneTabs();
    if (py.active) pyActivateTab(py.active);
  }
  if (!py.tabs.length && py.files.length) {
    const first = py.files.find((f) => f.path.endsWith(".py")) || py.files[0];
    await pyOpen(first.path);
  }
  // The terminal only mounts once the section is on screen: xterm needs
  // real dimensions to size its rows/cols.
  pyTermEnsure();
  const active = py.terms.find((t) => t.id === py.termActive);
  if (active) { active.fit.fit(); pyTermSendSize(active); }
}

async function pyOpen(path) {
  if (py.dirty) await pySave();
  try {
    const r = await fetch(`/api/ws-files/read?path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    const d = await r.json();
    py.open = path;
    // Opening a script always brings the editor back over a data preview.
    pyHidePreview();
    pyIdeSetCode(d.content);
    py.dirty = false;
    pyTabActivated(path);
    // The chip follows the open file: a pinned strategy shows its own
    // dataset the moment it appears.
    pyRefreshRunLabel();
    // and the STRATEGY BRIEF's "Improve open file" button names it
    if (bb.sel && $("bt-brief") && !$("bt-brief").classList.contains("hidden")) btBriefRender();
  } catch (e) { pyShowErr(String(e.message || e)); }
}

/* The file changed on disk under the open editor (an agent edit, a revert).
   Disk wins: apply it without saving first, and cancel any pending autosave,
   which would otherwise write the pre-edit buffer back 800ms later and
   silently undo the agent's change. Content-equal reloads are no-ops so the
   cursor never jumps on echoes. */
async function pyReloadFromDisk(path) {
  try {
    const r = await fetch(`/api/ws-files/read?path=${encodeURIComponent(path)}`);
    if (!r.ok) return;
    const d = await r.json();
    if (py.open !== path || d.content === $("py-code").value) return;
    clearTimeout(py.saveTimer);
    py.dirty = false;
    pyIdeSetCode(d.content);
  } catch (e) { /* engine briefly away; the next change re-syncs */ }
}

async function pySave() {
  if (!py.open) return;
  py.dirty = false;
  try {
    await fetch("/api/ws-files/write", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: py.open, content: $("py-code").value }) });
  } catch (e) { py.dirty = true; }
}


async function pyCreateFile(path, content) {
  // Never silently clobber: an existing name gets a numbered sibling.
  let target = path;
  for (let n = 2; py.files.some((f) => f.path === target); n += 1) {
    target = path.replace(/(\.\w+)?$/, `_${n}$1`);
  }
  await fetch("/api/ws-files/write", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: target, content }) });
  await refreshLibraryAll();
  await pyOpen(target);
}

async function pyLoadDatasets() {
  let built = [], imports = [];
  try { built = await fetch("/api/ml/datasets").then((r) => r.json()); }
  catch (e) { /* none built yet */ }
  try {
    imports = (await fetch("/api/data").then((r) => r.json()))
      .filter((d) => d.kind === "ohlcv");
  } catch (e) { /* empty library */ }
  const names = built.map((b) => b.name);
  for (const i of imports) if (!names.includes(i.symbol)) names.push(i.symbol);
  // Keep the current pick while it exists; otherwise last session's pick,
  // otherwise the first available dataset, so BACKTEST always has a target
  // when the library isn't empty.
  let want = py.dataset;
  if (!want || !names.includes(want)) {
    try { want = localStorage.getItem("lse.pyDataset"); } catch (e) { want = null; }
  }
  if (!want || !names.includes(want)) want = names[0] || null;
  pySetDataset(want);
}

/* ── the docked terminal panel: VS Code semantics ─────────────────────
   Modeled on the VS Code terminal panel. Multiple
   instances live in one panel: PTY shells / Python REPLs the user types
   into (same /api/term/pty wire the WORKSPACE terminal speaks, served by
   every installed engine), plus one output-only "backtest" console RUN
   prints reports into, the way VS Code tasks get their own terminal.
   Tabs switch, + spawns a shell, the chevron menu picks the kind, the
   trash kills the active instance (killing the last leaves the panel
   empty; the next open or RUN spawns fresh, like VS Code). */

function pyTermMake(kind) {
  const id = ++py.termSeq;
  const host = document.createElement("div");
  host.className = "py-term-inst";
  $("py-term").appendChild(host);
  const isConsole = kind === "backtest";
  const term = new Terminal({
    // Same metrics as the WORKSPACE terminal so the two read as one tool.
    fontSize: 14, scrollback: 5000,
    cursorBlink: !isConsole, disableStdin: isConsole,
    fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: { background: themeVar("--bg", "#212121"),
             foreground: themeVar("--text", "#e6e8ea"),
             // The run console hides its caret: a block caret promises
             // typing that goes nowhere.
             cursor: themeVar(isConsole ? "--bg" : "--text",
                              isConsole ? "#212121" : "#e6e8ea"),
             selectionBackground: themeVar("--edge", "#26282c") },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const inst = { id, kind, host, term, fit, ws: null,
                 name: isConsole ? "backtest" : (kind === "python" ? "python" : "sh") };
  if (!isConsole) {
    term.onData((d) => {
      if (inst.ws && inst.ws.readyState === 1) {
        inst.ws.send(JSON.stringify({ type: "input", data: d }));
      }
    });
    pyTermSpawn(inst);
  }
  py.terms.push(inst);
  return inst;
}

function pyTermSpawn(inst) {
  // Same wire protocol as the WORKSPACE terminal: binary output frames,
  // JSON input/resize inbound, JSON error/exit outbound.
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
    `/api/term/pty?mode=${encodeURIComponent(inst.kind === "python" ? "python" : "shell")}`);
  ws.binaryType = "arraybuffer";
  inst.ws = ws;
  ws.onopen = () => {
    if (py.termActive === inst.id) { inst.fit.fit(); pyTermSendSize(inst); }
  };
  ws.onmessage = (ev) => {
    if (inst.ws !== ws) return;
    if (typeof ev.data === "string") {
      const m = JSON.parse(ev.data);
      if (m.type === "error") inst.term.write(`\r\n  ${m.message}\r\n`);
      else if (m.type === "exit") {
        inst.term.write("\r\n  \x1b[90m[exited - trash kills this terminal, + opens a new one]\x1b[0m\r\n");
      }
    } else {
      inst.term.write(new Uint8Array(ev.data));
    }
  };
}

function pyTermSendSize(inst) {
  if (inst.ws && inst.ws.readyState === 1) {
    inst.ws.send(JSON.stringify({ type: "resize",
                                  cols: inst.term.cols, rows: inst.term.rows }));
  }
}

function pyTermShow(id) {
  py.termActive = id;
  for (const t of py.terms) t.host.classList.toggle("hidden", t.id !== id);
  const inst = py.terms.find((t) => t.id === id);
  if (inst) {
    inst.fit.fit();
    pyTermSendSize(inst);
    if (inst.kind !== "backtest") inst.term.focus();
  }
  pyTermTabs();
}

function pyTermKill(id) {
  const i = py.terms.findIndex((t) => t.id === id);
  if (i < 0) return;
  const inst = py.terms[i];
  try { if (inst.ws) { const w = inst.ws; inst.ws = null; w.close(); } } catch (e) { /* dead */ }
  inst.term.dispose();
  inst.host.remove();
  py.terms.splice(i, 1);
  if (py.termActive === id) {
    const next = py.terms[i] || py.terms[i - 1];
    if (next) pyTermShow(next.id);
    else { py.termActive = null; pyTermTabs(); }
  } else {
    pyTermTabs();
  }
}

function pyTermTabs() {
  const host = $("py-term-tabs");
  host.innerHTML = "";
  for (const t of py.terms) {
    const b = document.createElement("button");
    b.className = "py-term-tab" + (t.id === py.termActive ? " active" : "");
    b.textContent = t.name;
    b.onclick = () => pyTermShow(t.id);
    host.appendChild(b);
  }
}

/* The run console: RUN's dedicated output terminal, created on first use
   and re-focused on every run, VS Code task style. */
function pyTermConsole() {
  let inst = py.terms.find((t) => t.kind === "backtest");
  if (!inst) inst = pyTermMake("backtest");
  pyTermShow(inst.id);
  return inst;
}

/* At least one live terminal when the IDE opens, like VS Code's panel. */
function pyTermEnsure() {
  if (!py.terms.length) pyTermShow(pyTermMake("shell").id);
}

function pySashInit() {
  // Same divider behaviour as the WORKSPACE terminal, own remembered height.
  const panel = $("py-panel");
  try {
    const h = parseInt(localStorage.getItem("lset-py-panel") || "", 10);
    if (h >= 90 && h <= window.innerHeight - 160) panel.style.height = h + "px";
  } catch (e) { /* storage disabled */ }
  $("py-sash").onmousedown = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = panel.offsetHeight;
    const move = (ev) => {
      const h = Math.min(Math.max(startH + (startY - ev.clientY), 90),
                         window.innerHeight - 160);
      panel.style.height = h + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { localStorage.setItem("lset-py-panel", String(panel.offsetHeight)); } catch (e) {}
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
}

function pyShowErr(msg) {
  pyTermConsole().term.write(`\x1b[31m${String(msg)}\x1b[0m\r\n`);
}

/* The single RUN button: a strategy file is a backtest, anything else is a
   plain Python script. The file's content decides, not a second button.
   A strategy is a file that leaves a `trades` list, which IS the contract
   since pybt was deleted. This used to test for a
   `class X(Strategy)` subclass instead: that API no longer exists, so from
   that day EVERY current strategy fell through to plain-script mode, where
   it computed trades, printed nothing, and the console showed a bare
   "[done]". The dead-API pattern is
   still matched so an old file gets a real engine error, not silence.
   The sniff is shared with the WORKSPACE IDE's RUN: the seeded starters
   sit in its tree too, and running one as a plain script dies on the
   injected names (NameError: params, formerly every fresh install's
   first click). */
function srcIsStrategy(src) {
  return /(^|\n)\s*trades\s*=/.test(src)
    || /\btrades\.append\s*\(/.test(src)
    || /class\s+\w+\s*\([^)]*Strategy[^)]*\)/.test(src);
}

function pyRun() {
  return srcIsStrategy($("py-code").value) ? pyBacktest() : pyRunFile();
}

async function pyBacktest() {
  if (!py.open) return;
  await pySave();
  // A pinned strategy runs on ITS dataset, whatever the library pick is;
  // a missing pinned dataset is a hard stop, because falling back to the
  // ambient pick is exactly the silent-wrong-dataset bug the pin exists
  // to kill.
  const pin = pyRunPin($("py-code").value);
  let dataset = py.dataset, pinned = false;
  if (pin) {
    if (!(state.datasetList || []).some((d) => d.symbol === pin.symbol)) {
      pyShowErr(`This strategy is pinned to "${pin.symbol}" (its # run: line), ` +
                `but MY DATA has no dataset with that name. Import it, or edit the # run: line.`);
      return;
    }
    dataset = pin.symbol;
    pinned = true;
  }
  if (!dataset) { pyShowErr("Import a price file first, then click it in the library to select it."); return; }
  // The file's native timeframe: no dropdown to second-guess it.
  const tf = ((state.datasetList || []).find((x) => x.symbol === dataset) || {}).timeframe || "1h";
  const btn = $("py-run");
  btn.disabled = true;
  // .running swaps the CSS play glyph for a spinner; the glyph lives in
  // ::before precisely so these label writes cannot wipe it.
  btn.classList.add("running");
  btn.textContent = "RUNNING";
  const t0 = performance.now();
  pyTermConsole().term.write(`\r\n\x1b[90m$\x1b[0m backtest ${py.open} \x1b[90mon\x1b[0m ${dataset} ${tf}${pinned ? " \x1b[90m(pinned)\x1b[0m" : ""}\r\n`);
  try {
    const r = await fetch("/api/backtest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: "python", provider: "userdata", symbol: dataset,
        timeframe: tf,
        script: $("py-code").value,
        // Always the engine maximum; the bars input was toolbar clutter.
        // Raised together with the server cap so a run covers the full
        // bundled samples, not their last 5000 bars.
        limit: 100000,
        options: { extended_stats: true },
      }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    const res = await r.json();
    pyTermReport(res, performance.now() - t0);
    renderPlotPanes("py-plots", res.plots);
    // Remember the run per script so the library's SCRIPTS chips show the
    // last result next to the file name.
    if (typeof res.net_profit === "number") {
      try {
        const runs = btRunStats();
        // The dataset is part of the result: "-10,193 over 87 trades" means
        // nothing without knowing what it ran on, and a blind read
        // correctly refused to assume the currently-selected one.
        runs[py.open] = { net: res.net_profit,
                          trades: (res.trades || []).length,
                          dataset, timeframe: tf, ts: Date.now() };
        localStorage.setItem("lse.btRuns", JSON.stringify(runs));
      } catch (e) { /* chips are optional */ }
      renderDataSidebar();
    }
  } catch (e) {
    pyShowErr(String(e.message || e));
  } finally {
    btn.disabled = false;
    btn.classList.remove("running");
    btn.textContent = "RUN";
  }
}

/* The text report a terminal backtester prints: trades first, then the
   equity sparkline and the stats block, so the numbers land at the bottom
   where the eye already is (a 100-trade list above scrolls away, the
   verdict does not). Writes to the BACKTEST run console unless a term is
   handed in (the WORKSPACE IDE prints into its own panel terminal). */
function pyTermReport(res, ms, term) {
  const t = term || pyTermConsole().term;
  const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", X = "\x1b[0m";
  const num = (v, dp = 2) => (typeof v === "number" && isFinite(v)
    ? v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : String(v));
  const pnlc = (v) => (v >= 0 ? G + "+" : R) + num(v) + X;
  const when = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");

  const trades = res.trades || [];
  for (const tr of trades) {
    const dir = tr.direction === "long" ? "LONG " : "SHORT";
    t.write(`  ${D}${dir}${X} ${when(tr.entry_ts)} @ ${tr.entry_price}` +
            `  ${D}->${X}  ${tr.exit_ts ? when(tr.exit_ts) : "open"} @ ${tr.exit_price ?? "-"}` +
            `  ${pnlc(tr.pnl)} ${D}(${(tr.pnl_pct ?? 0).toFixed(2)}%)${X}\r\n`);
  }
  if (!trades.length) t.write(`  ${D}no trades${X}\r\n`);

  // One-line block-character equity curve; a terminal's chart.
  const eq = (res.equity_curve || []).map((p) => p[1]);
  if (eq.length > 1) {
    const w = Math.min(72, Math.max(24, (t.cols || 80) - 12));
    let lo = Infinity, hi = -Infinity;
    for (const v of eq) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const blocks = "▁▂▃▄▅▆▇█";
    let line = "";
    for (let x = 0; x < w; x++) {
      const v = eq[Math.round(x * (eq.length - 1) / (w - 1))];
      line += blocks[hi > lo ? Math.round((v - lo) / (hi - lo) * 7) : 0];
    }
    t.write(`\r\n  ${D}equity${X}    ${line}\r\n`);
  }

  const s = res.stats || {};
  const pf = s.profitFactor === "__+Inf__" ? "inf" : num(s.profitFactor);
  const rows = [
    ["net profit", pnlc(res.net_profit)],
    ["final equity", num(res.final_equity)],
    ["trades", `${trades.length}  ${D}(${s.winningTrades ?? 0} win / ${s.losingTrades ?? 0} loss)${X}`],
    ["win rate", num(s.winRate) + "%"],
    ["profit factor", pf],
    ["max drawdown", `${num(s.maxDrawdown)}  ${D}(${num(s.maxDrawdownPct)}%)${X}`],
    ["sharpe", num(s.sharpeRatio)],
    ["avg trade", num(s.avgTrade)],
    ["avg win / loss", `${num(s.avgWin)} ${D}/${X} ${num(s.avgLoss)}`],
    ["largest win / loss", `${num(s.largestWin)} ${D}/${X} ${num(s.largestLoss)}`],
    ["consec wins / losses", `${s.maxConsecWins ?? 0} ${D}/${X} ${s.maxConsecLosses ?? 0}`],
  ];
  t.write("\r\n");
  for (const [k, v] of rows) t.write(`  ${D}${k.padEnd(22)}${X}${v}\r\n`);
  t.write(`  ${D}done in ${(ms / 1000).toFixed(1)}s${X}\r\n`);
}

/* Panes a strategy's `plots` dict declared: real charts (the same
   LightweightCharts the equity curve uses, ED_PV palette, autoSize), one
   small pane per key, in a strip between the editor and the terminal so
   the report and its diagrams land together. Engine side: runner.py
   _collect_plots returns each pane as [[ts, value], ...]. An engine older
   than the contract returns no `plots` and the strip stays hidden. */
function renderPlotPanes(hostId, plots) {
  const host = $(hostId);
  if (!host) return;
  for (const c of host._charts || []) { try { c.remove(); } catch (e) { /* gone */ } }
  host._charts = [];
  host.innerHTML = "";
  const names = Object.keys(plots || {}).filter((k) => (plots[k] || []).length);
  host.classList.toggle("hidden", !names.length);
  if (!names.length) return;
  let ci = 0;
  for (const name of names) {
    const pane = document.createElement("div");
    pane.className = "plot-pane";
    pane.innerHTML = `<div class="plot-cap">${mlEsc(name)}</div>` +
                     `<div class="plot-body"></div>`;
    // In the DOM before createChart: autoSize needs a laid-out box (same
    // lesson as the indicator-editor preview panes).
    host.appendChild(pane);
    const chart = LightweightCharts.createChart(
      pane.querySelector(".plot-body"), chartOpts());
    chart.addLineSeries({
      color: ED_PV_COLORS[ci++ % ED_PV_COLORS.length], lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
    }).setData(plots[name].map(([t, v]) => ({ time: t, value: v })));
    chart.timeScale().fitContent();
    host._charts.push(chart);
  }
}

async function pyRunFile() {
  if (!py.open) return;
  await pySave();
  const con = pyTermConsole();
  const started = performance.now();
  let printed = 0;   // a bare "[done]" never said whether anything ran
  con.term.write(`\r\n\x1b[90m$\x1b[0m python ${py.open}\r\n`);
  try {
    const r = await fetch("/api/ml/run-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: $("py-code").value }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    const { job_id } = await r.json();
    py.job = job_id;
    $("py-stop").classList.remove("hidden");
    if (py.ws) { try { py.ws.close(); } catch (e) { /* replacing */ } }
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
      `/api/ml/jobs/${encodeURIComponent(job_id)}/stream`);
    py.ws = ws;
    ws.onmessage = (ev) => {
      // Same as the ML stream: a superseded run's queued frames stay out.
      if (py.ws !== ws) return;
      const m = JSON.parse(ev.data);
      if (m.type === "line") {
        printed += 1;
        con.term.write(m.line + "\r\n");
      } else if (m.type === "end") {
        $("py-stop").classList.add("hidden");
        if (m.status !== "done") pyShowErr(m.error || "run failed; see output");
        else {
          // Say WHAT finished and whether it produced anything: a silent
          // "[done]" after a script that printed nothing reads like the
          // button did nothing at all.
          const secs = ((performance.now() - started) / 1000).toFixed(1);
          const what = printed
            ? `${printed} line${printed === 1 ? "" : "s"} of output`
            : "no output (the script printed nothing)";
          con.term.write(
            `\x1b[90m[${py.open} finished in ${secs}s, ${what}]\x1b[0m\r\n`);
        }
      } else if (m.type === "error") {
        pyShowErr(m.message);
      }
    };
    ws.onclose = () => { if (py.ws === ws) py.ws = null; };
  } catch (e) { pyShowErr(String(e.message || e)); }
}

async function pyStop() {
  if (!py.job) return;
  try { await fetch(`/api/ml/jobs/${encodeURIComponent(py.job)}/cancel`, { method: "POST" }); }
  catch (e) { /* already finished */ }
}

/* ---------- WORKSPACE: the full IDE tab ----------
   Explorer (workspace tree + MY DATA) | editor tabs | docked terminal, with
   the permanent AI rail alongside. Same folder as BACKTEST > Python
   Strategies and the AI agents (/api/ws-files), so every surface sees the
   same files; the terminal PTY (/api/term/pty) starts in that folder too. */

const wsx = {
  loaded: false, files: [], open: null,
  bufs: {},                    // path -> {content, dirty, timer}
  tabs: [],                    // open tab paths, in click order
  closedDirs: {},              // explorer folders the user folded
  // Shell by default: the panel should behave like
  // VS Code's integrated terminal; the Python REPL stays one dropdown away.
  term: null, fit: null, ws: null, mode: "shell",
  runReturn: null,             // mode to restart after a RUN session exits
};

async function openWorkspace() {
  if (!wsx.loaded) {
    wsx.loaded = true;
    $("wsx-run").onclick = wsxRun;
    $("wsx-term-restart").onclick = () => wsxConnect(wsx.mode);
    $("wsx-term-mode").onchange = (e) => wsxConnect(e.target.value);
    $("wsx-code").addEventListener("input", () => {
      const buf = wsx.bufs[wsx.open];
      if (!buf) return;
      buf.content = $("wsx-code").value;
      buf.dirty = true;
      wsxHighlight();
      wsxRenderTabs();
      clearTimeout(buf.timer);
      // Save the file that was edited, not whichever tab is open when the
      // debounce fires: switching tabs inside the 800ms window used to
      // leave the edited buffer dirty on disk (RUN and the AI agents then
      // read a stale file).
      const edited = wsx.open;
      buf.timer = setTimeout(() => wsxSave(edited), 800);
    });
    // The backdrop scrolls with the textarea, not by itself.
    $("wsx-code").addEventListener("scroll", wsxSyncScroll);
    wsxSashInit();
  }
  // The explorer is the shared library tree, same
  // component as the BACKTEST sidebar, rendered into this panel's host.
  await refreshLibraryAll();
  if (!wsx.open && wsx.files.length) {
    const first = wsx.files.find((f) => f.path.endsWith(".py")) || wsx.files[0];
    await wsxOpen(first.path);
  }
  // The PTY only starts once the panel is on screen: xterm needs real
  // dimensions to size the child terminal.
  if (!wsx.term) wsxEnsureTerm();
  if (wsx.fit) wsx.fit.fit();
  if (!wsx.ws) wsxConnect(wsx.mode);
}

/* ----- explorer -----
   The old wsx-only tree (wsxRefreshTree) and MY DATA list (wsxRenderData)
   were replaced by the shared library component; see
   renderLibraryTree, which renders into #wsx-lib with ctx "wsx". */

async function wsxNewFile() {
  // Inline input at the top of the WORKSPACE section of the wsx explorer,
  // VS Code style. (This replaced window.prompt, which does not exist in
  // the Electron shell, so the old path was dead on desktop.)
  const lib = $("wsx-lib");
  const head = lib && lib.querySelector('.tree-section[data-sec="ws"]');
  const typed = head
    ? await treeInlineInput({ parent: lib, before: head.nextSibling })
    : await askText("File name (folders with /)", "strategies/my_strategy.py");
  if (!typed) return;
  const name = typed.split("/").pop().includes(".") ? typed : typed + ".py";
  // Never silently clobber: an existing name gets a numbered sibling.
  let target = name;
  for (let n = 2; wsx.files.some((f) => f.path === target); n += 1) {
    target = name.replace(/(\.\w+)?$/, `_${n}$1`);
  }
  // Empty file: no starter template, VS Code exact.
  const body = "";
  fetch("/api/ws-files/write", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: target, content: body }) })
    .then((r) => r.ok ? null : r.json().then((d) => { throw new Error(d.detail); }))
    .then(async () => { await refreshLibraryAll(); await wsxOpen(target); })
    .catch((e) => wsxShowErr(String(e.message || e)));
}

/* ----- editor tabs ----- */

function wsxRenderTabs() {
  const host = $("wsx-tabs");
  host.innerHTML = "";
  for (const t of wsx.tabs) {
    const dirty = wsx.bufs[t] && wsx.bufs[t].dirty;
    const tab = document.createElement("div");
    tab.className = "wsx-tab" + (t === wsx.open ? " active" : "");
    tab.innerHTML = `<span class="wsx-tab-name">${mlEsc(t.split("/").pop())}</span>` +
                    `<button class="wsx-tab-x" title="Close">${dirty ? "&#9679;" : "&#215;"}</button>`;
    tab.title = t;
    tab.querySelector(".wsx-tab-name").onclick = () => wsxOpen(t);
    tab.querySelector(".wsx-tab-x").onclick = (e) => { e.stopPropagation(); wsxCloseTab(t); };
    host.appendChild(tab);
  }
}

async function wsxOpen(path) {
  if (!wsx.bufs[path]) {
    try {
      const r = await fetch(`/api/ws-files/read?path=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      wsx.bufs[path] = { content: (await r.json()).content, dirty: false, timer: null };
    } catch (e) { wsxShowErr(String(e.message || e)); return; }
  }
  wsx.open = path;
  if (!wsx.tabs.includes(path)) wsx.tabs.push(path);
  $("wsx-err").classList.add("hidden");
  $("wsx-empty").classList.add("hidden");
  $("wsx-code").classList.remove("hidden");
  $("wsx-hl").classList.remove("hidden");
  $("wsx-gutter").classList.remove("hidden");
  $("wsx-code").value = wsx.bufs[path].content;
  wsxHighlight();
  wsxSyncScroll();
  wsxRenderTabs();
  // The shared library tree is the explorer; repaint it so the active mark
  // follows the open tab.
  repaintLibraryTrees();
}

/* Same disk-wins reload for the WORKSPACE tab's buffers; see
   pyReloadFromDisk for why the pending autosave must be cancelled. */
async function wsxReloadFromDisk(path) {
  const buf = wsx.bufs[path];
  if (!buf) return;
  try {
    const r = await fetch(`/api/ws-files/read?path=${encodeURIComponent(path)}`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.content === buf.content) return;
    clearTimeout(buf.timer);
    buf.content = d.content;
    buf.dirty = false;
    if (wsx.open === path) {
      $("wsx-code").value = d.content;
      wsxHighlight();
      wsxSyncScroll();
    }
    wsxRenderTabs();
  } catch (e) { /* engine briefly away; the next change re-syncs */ }
}

async function wsxSave(path) {
  const buf = wsx.bufs[path];
  if (!buf || !buf.dirty) return;
  buf.dirty = false;
  try {
    await fetch("/api/ws-files/write", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: buf.content }) });
  } catch (e) { buf.dirty = true; }
  wsxRenderTabs();
}

function wsxCloseTab(path, deleted) {
  if (!deleted && wsx.bufs[path] && wsx.bufs[path].dirty) wsxSave(path);
  wsx.tabs = wsx.tabs.filter((t) => t !== path);
  delete wsx.bufs[path];
  if (wsx.open === path) {
    wsx.open = wsx.tabs[wsx.tabs.length - 1] || null;
    if (wsx.open) { wsxOpen(wsx.open); return; }
    $("wsx-code").classList.add("hidden");
    $("wsx-hl").classList.add("hidden");
    $("wsx-gutter").classList.add("hidden");
    $("wsx-code").value = "";
    $("wsx-empty").classList.remove("hidden");
  }
  wsxRenderTabs();
}

function wsxShowErr(msg) {
  const e = $("wsx-err");
  e.textContent = msg;
  e.classList.remove("hidden");
}

/* ----- syntax highlighting -----
   VS Code style colours without an editor dependency: the textarea's own
   text is transparent (caret stays visible) and #wsx-hl, a pre with
   identical font metrics sitting underneath, carries the coloured tokens.
   One regex pass; classes .hl-* get Dark+/Light+ colours in style.css. */

const WSX_PY_RE = new RegExp([
  /("""[\s\S]*?"""|'''[\s\S]*?''')/.source,                    // 1 triple string
  /([rbfuRBFU]{0,2}"(?:\\.|[^"\\\n])*"|[rbfuRBFU]{0,2}'(?:\\.|[^'\\\n])*')/.source, // 2 string
  /(#[^\n]*)/.source,                                          // 3 comment
  /(@[A-Za-z_][\w.]*)/.source,                                 // 4 decorator
  /\b(def|class)(\s+)([A-Za-z_]\w*)/.source,                   // 5 kw 6 ws 7 name
  /\b(if|elif|else|for|while|try|except|finally|with|as|return|yield|break|continue|pass|raise|import|from|assert|del|global|nonlocal|async|await|match|case)\b/.source, // 8 control kw
  /\b(and|or|not|in|is|lambda|None|True|False|self|cls)\b/.source, // 9 value kw
  /\b(\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?[jJ]?)\b/.source,      // 10 number
  /\b([A-Za-z_]\w*)(?=\s*\()/.source,                          // 11 call
].join("|"), "g");

const hlEsc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Python source -> token-wrapped HTML. Shared by every highlighted editor
   (workspace IDE #wsx-*, ML blueprint #ml-*); the .hl-* colours are the
   one palette in style.css, so all editors read identically. */
function pyTokenHTML(src) {
  let html = "", last = 0;
  for (let m; (m = WSX_PY_RE.exec(src)); ) {
    html += hlEsc(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] || m[2]) html += `<span class="hl-s">${hlEsc(m[0])}</span>`;
    else if (m[3]) html += `<span class="hl-c">${hlEsc(m[0])}</span>`;
    else if (m[4]) html += `<span class="hl-f">${hlEsc(m[0])}</span>`;
    else if (m[5]) html += `<span class="hl-kd">${hlEsc(m[5])}</span>${m[6]}` +
      `<span class="${m[5] === "class" ? "hl-t" : "hl-f"}">${hlEsc(m[7])}</span>`;
    else if (m[8]) html += `<span class="hl-kc">${hlEsc(m[0])}</span>`;
    else if (m[9]) html += `<span class="${m[9] === "self" || m[9] === "cls" ? "hl-v" : "hl-kd"}">${hlEsc(m[0])}</span>`;
    else if (m[10]) html += `<span class="hl-n">${hlEsc(m[0])}</span>`;
    else if (m[11]) html += `<span class="hl-f">${hlEsc(m[0])}</span>`;
    else html += hlEsc(m[0]);
  }
  return html + hlEsc(src.slice(last));
}

function wsxHighlight() {
  const src = $("wsx-code").value;
  const py = !!wsx.open && wsx.open.endsWith(".py");
  const html = py ? pyTokenHTML(src) : hlEsc(src);
  // Trailing newline so the backdrop is never one line shorter than the
  // textarea (which always shows a blank last line to type on).
  $("wsx-hl-code").innerHTML = html + "\n";
  // Line-number gutter: rebuilt only when the line COUNT changes (typing
  // within a line is the hot path and must not touch the DOM). split("\n")
  // matches the textarea's own rendering, including the empty last line a
  // trailing newline creates.
  const lines = src.split("\n").length;
  if (wsx.gutterLines !== lines) {
    wsx.gutterLines = lines;
    let nums = "";
    for (let i = 1; i <= lines; i++) nums += `<div>${i}</div>`;
    $("wsx-gutter").innerHTML = nums;
  }
  wsxSyncScroll();
}

function wsxSyncScroll() {
  const ta = $("wsx-code"), hl = $("wsx-hl");
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  // The gutter follows vertically only; it is a fixed strip the code slides
  // under horizontally, like VS Code's.
  $("wsx-gutter").scrollTop = ta.scrollTop;
}

/* ----- the terminal ----- */

function wsxEnsureTerm() {
  wsx.term = new Terminal({
    // 14 = VS Code's integrated-terminal default, and the same family the
    // editor above now uses, so the two panes read as one tool.
    fontSize: 14, cursorBlink: true, scrollback: 5000,
    fontFamily: 'Consolas, "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    theme: { background: themeVar("--bg", "#212121"),
             foreground: themeVar("--text", "#e6e8ea"),
             cursor: themeVar("--text", "#e6e8ea"),
             selectionBackground: themeVar("--edge", "#26282c") },
  });
  wsx.fit = new FitAddon.FitAddon();
  wsx.term.loadAddon(wsx.fit);
  wsx.term.open($("wsx-term"));
  wsx.term.onData((d) => {
    if (wsx.ws && wsx.ws.readyState === 1) wsx.ws.send(JSON.stringify({ type: "input", data: d }));
  });
  new ResizeObserver(() => {
    // Only while actually on screen; fitting a hidden panel would clamp
    // the child terminal to ~1 column.
    if (!$("wsx").classList.contains("hidden") &&
        !$("wsx-term").classList.contains("hidden") && wsx.fit) {
      wsx.fit.fit();
      wsxSendSize();
    }
  }).observe($("wsx-term"));
}

function wsxSendSize() {
  if (wsx.ws && wsx.ws.readyState === 1 && wsx.term) {
    wsx.ws.send(JSON.stringify({ type: "resize", cols: wsx.term.cols, rows: wsx.term.rows }));
  }
}

/* Hand a newly spawned PTY the blank screen it assumes it owns, WITHOUT
   throwing away what is on the panel. Shared by every panel that reuses one
   xterm across more than one PTY: the WORKSPACE terminal and the AI rail's
   terminal view.

   A PTY does not append to whatever the terminal happens to be showing: it
   owns the visible screen and addresses the cursor absolutely. ConPTY echoes
   a keystroke as ESC[<row>;<col>H<char>, where <row> counts from the top of
   ITS screen, which starts empty (verified on Windows: cmd.exe echoes
   "abc" as ESC[4;38Habc, row 4 being the prompt's row in ConPTY's own
   buffer). So when the shell comes back under a backtest report with
   keep=true, the report is still filling the screen the new session believes
   is blank, and every character typed is painted onto a report line, dozens
   of rows above the prompt the user is looking at. That is why the terminal
   could not be typed into after a run.

   The fix is the one a real terminal makes: scroll the screen into the
   SCROLLBACK, so the PTY's row 1 and the panel's row 1 are the same line
   again. Nothing is lost, and the viewport is parked back on what was there,
   which xterm leaves alone until the first keystroke (scrollOnUserInput
   snaps to the prompt then). So the previous output still reads as it does
   today and typing lands where the cursor is. */
function termFreshScreen(t, done) {
  // Defaulted, not assumed: these run inside xterm's write callbacks, and a
  // throw in one of those wedges the whole write queue, which reads as a
  // frozen terminal rather than as the mistake it is.
  const fin = typeof done === "function" ? done : () => {};
  if (!t) { fin(); return; }
  // A previous full-screen app (an agent TUI, a curses script) may have died
  // in the ALTERNATE buffer, which has no scrollback to scroll into. Put the
  // normal buffer back first, exactly as a terminal does when such a program
  // exits, so the incoming session lands on a screen with history behind it.
  const restore = t.buffer.active.type === "alternate" ? "\x1b[?1049l" : "";
  // Measured inside a write callback, not inline: xterm applies write() on a
  // later tick, so the cursor row read straight after one is still the
  // pre-report row and the screen would scroll by the wrong amount. The
  // no-op SGR reset is just a non-empty payload to hang the callback on.
  t.write(restore + "\x1b[0m", () => {
    const used = t.buffer.active.cursorY;   // rows of this screen holding output
    if (!used) { fin(); return; }
    // A newline on the last row scrolls the screen up one and pushes the top
    // line into the scrollback; `used` of them empty the screen without
    // dropping a line of it. Then home, where the PTY believes it is.
    t.write(`\x1b[${t.rows};1H${"\n".repeat(used)}\x1b[H`, () => {
      fin();
      t.scrollLines(-used);   // leave the previous output on screen, as before
    });
  });
}

function wsxConnect(mode, path, keep) {
  if (wsx.ws) { try { wsx.ws.close(); } catch (e) { /* replacing */ } }
  if (mode !== "run") { wsx.mode = mode; $("wsx-term-mode").value = mode; }
  // A restart or mode switch starts a fresh session, so start a fresh
  // screen too: the old session's prompt/echo would otherwise share lines
  // with the new banner (close() does not stop frames already queued, and
  // the new PTY writes at whatever column the old one left the cursor).
  // RUN and the run-return reconnect pass keep=true: their whole point is
  // leaving the previous output on screen, VS Code style.
  if (!keep && mode !== "run" && wsx.term) wsx.term.reset();
  // Those two keep-the-output paths hand the new PTY a screen that already
  // has text on it, which breaks its absolute cursor addressing; termFreshScreen
  // clears the screen into the scrollback instead. Deferred to the first frame
  // rather than done here so the report has finished painting and the row
  // count it scrolls by is the real one.
  let screenReady = !keep && mode !== "run";
  let screenClearing = false;
  const queued = [];
  const run = mode === "run" ? `&path=${encodeURIComponent(path)}` : "";
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_PREFIX}` +
    `/api/term/pty?mode=${encodeURIComponent(mode)}${run}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { if (wsx.fit) wsx.fit.fit(); wsxSendSize(); };
  ws.onmessage = (ev) => {
    // Frames from a superseded socket must never touch the terminal:
    // after a restart the old PTY's buffered output races the new one's
    // and the interleaving garbles the screen mid-line.
    if (wsx.ws !== ws) return;
    if (typeof ev.data === "string") {
      const m = JSON.parse(ev.data);
      if (m.type === "error") {
        wsx.term.write(`\r\n  ${m.message}\r\n`);
      } else if (m.type === "exit") {
        if (wsx.runReturn && wsx.ws === ws) {
          // A RUN session ended: drop back into the REPL/shell underneath
          // its output, like VS Code's run-file terminals.
          const back = wsx.runReturn;
          wsx.runReturn = null;
          wsx.term.write("\r\n");
          wsxConnect(back, null, true); // keep: run output stays visible
        } else if (wsx.ws === ws) {
          wsx.term.write("\r\n  [terminal exited - restart with ↻]\r\n");
        }
      }
    } else {
      // The new session's first bytes are the first moment the report is
      // guaranteed to have finished painting, so the screen is cleared into
      // the scrollback here rather than at connect time. Frames that land
      // while that is in flight wait their turn: writing one straight through
      // would put it on screen ahead of the frame that started the clear.
      const frame = new Uint8Array(ev.data);
      if (screenReady) { wsx.term.write(frame); return; }
      queued.push(frame);
      if (screenClearing) return;
      screenClearing = true;
      termFreshScreen(wsx.term, () => {
        screenReady = true;
        for (const f of queued) wsx.term.write(f);
        queued.length = 0;
      });
    }
  };
  ws.onmessage = ((inner) => (ev) => {
    if (typeof ev.data === "string") {
      const t = JSON.parse(ev.data).type;
      if (t === "exit" || t === "error") ws.handled = true;
    }
    inner(ev);
  })(ws.onmessage);
  ws.onclose = () => {
    // A close with no exit/error frame means the connection itself failed
    // (engine older than /api/term/pty, or the app restarted): say so, a
    // silently dead prompt reads as a hang.
    if (wsx.ws === ws && !ws.handled) {
      wsx.term.write("\r\n  [terminal disconnected - restart with ↻; if that fails, update the app]\r\n");
    }
  };
  wsx.ws = ws;
}

function wsxSashInit() {
  // Drag the divider to trade editor space for terminal space. Height is
  // remembered per machine; xterm refits via its ResizeObserver.
  const panel = $("wsx-panel");
  try {
    const h = parseInt(localStorage.getItem("lset-wsx-panel") || "", 10);
    if (h >= 90 && h <= window.innerHeight - 160) panel.style.height = h + "px";
  } catch (e) { /* storage disabled */ }
  $("wsx-sash").onmousedown = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = panel.offsetHeight;
    const move = (ev) => {
      const h = Math.min(Math.max(startH + (startY - ev.clientY), 90),
                         window.innerHeight - 160);
      panel.style.height = h + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { localStorage.setItem("lset-wsx-panel", String(panel.offsetHeight)); } catch (e) {}
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
}

/* ----- run ----- */
// (The toolbar backtest controls are gone:
// backtesting lives in the BACKTEST tab and the AI assistant's tools.)

/* Same routing as the BACKTEST editor's RUN (srcIsStrategy): the seeded
   starter strategies sit in this tab's tree too, and they read `params`
   and `df`, names only the backtest engine injects (backtest/runner.py).
   Run as a plain script, every one of them died on its first line with
   NameError: params, plus PyInstaller's "failed to execute sidecar_entry"
   banner on desktop, and that was a fresh install's first click. */
function wsxRun() {
  if (!wsx.open) { wsxShowErr("open a file first"); return; }
  if (!wsx.open.endsWith(".py")) { wsxShowErr("RUN executes .py files"); return; }
  const buf = wsx.bufs[wsx.open];
  return srcIsStrategy(buf ? buf.content : "") ? wsxBacktest() : wsxRunFile();
}

async function wsxRunFile() {
  if (!wsx.open) { wsxShowErr("open a file first"); return; }
  if (!wsx.open.endsWith(".py")) { wsxShowErr("RUN executes .py files"); return; }
  await wsxSave(wsx.open);
  wsx.runReturn = wsx.mode;
  wsxConnect("run", wsx.open);
}

async function wsxBacktest() {
  await wsxSave(wsx.open);
  // The dataset pick is shared with the BACKTEST tab (py.dataset, kept in
  // localStorage); a fresh install auto-picks the first bundled sample,
  // exactly what opening BACKTEST would do.
  if (!py.dataset) await pyLoadDatasets();
  // Same pin rule as the BACKTEST IDE: a `# run:` header outranks the
  // shared pick, and a missing pinned dataset stops the run rather than
  // silently running on the wrong data.
  const pin = pyRunPin((wsx.bufs[wsx.open] || {}).content || "");
  let dataset = py.dataset, pinned = false;
  if (pin) {
    if (!(state.datasetList || []).some((d) => d.symbol === pin.symbol)) {
      wsxShowErr(`This strategy is pinned to "${pin.symbol}" (its # run: line), ` +
                 `but MY DATA has no dataset with that name. Import it, or edit the # run: line.`);
      return;
    }
    dataset = pin.symbol;
    pinned = true;
  }
  if (!dataset) { wsxShowErr("Import a price file first, then click it in the library to select it."); return; }
  const tf = ((state.datasetList || []).find((x) => x.symbol === dataset) || {}).timeframe || "1h";
  if (!wsx.term) wsxEnsureTerm();
  const btn = $("wsx-run");
  btn.disabled = true;
  btn.textContent = "RUNNING";
  // RUN-session semantics for the panel's single terminal: pause the live
  // shell (a report interleaving with its prompt garbles both), print the
  // report, then bring the shell back underneath with keep=true.
  const back = wsx.mode;
  if (wsx.ws) { const w = wsx.ws; wsx.ws = null; try { w.close(); } catch (e) { /* replacing */ } }
  const t = wsx.term;
  const t0 = performance.now();
  t.write(`\r\n\x1b[90m$\x1b[0m backtest ${wsx.open} \x1b[90mon\x1b[0m ${dataset} ${tf}${pinned ? " \x1b[90m(pinned)\x1b[0m" : ""}\r\n`);
  try {
    const r = await fetch("/api/backtest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: "python", provider: "userdata", symbol: dataset,
        timeframe: tf,
        script: (wsx.bufs[wsx.open] || {}).content || "",
        // Engine maximum, same as the BACKTEST tab: a run covers the full
        // bundled samples, not their tail.
        limit: 100000,
        options: { extended_stats: true },
      }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
    const res = await r.json();
    pyTermReport(res, performance.now() - t0, t);
    renderPlotPanes("wsx-plots", res.plots);
    // Same last-run bookkeeping as the BACKTEST tab; the library chips key
    // on the workspace path, which both editors share.
    if (typeof res.net_profit === "number") {
      try {
        const runs = btRunStats();
        runs[wsx.open] = { net: res.net_profit,
                           trades: (res.trades || []).length,
                           dataset, timeframe: tf, ts: Date.now() };
        localStorage.setItem("lse.btRuns", JSON.stringify(runs));
      } catch (e) { /* chips are optional */ }
      renderDataSidebar();
    }
  } catch (e) {
    t.write(`\x1b[31m${String(e.message || e)}\x1b[0m\r\n`);
  } finally {
    btn.disabled = false;
    btn.textContent = "RUN";
    t.write("\r\n");
    wsxConnect(back, null, true);   // the shell returns; the report stays
  }
}

async function boot() {
  const [providers, config, indicatorSpecs, health] = await Promise.all([
    fetch("/api/providers").then((r) => r.json()),
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/indicators").then((r) => r.json()),
    fetch("/api/health").then((r) => r.json()),
  ]);
  watchForUpdates(health.ui_version);
  setupUpdateButton(!!config.hosted); // header UPDATE button; checks in the background
  // No dev chip: the brand wordmark it hung off is gone from the topline;
  // health.dev still distinguishes source runs
  // server-side, the UI just no longer badges it.
  state.providers = providers;
  state.indicatorSpecs = indicatorSpecs;
  state.lseConfigured = !!config.lse_configured;
  // Hosted terminals have no local broker hub (a connection is a
  // subprocess on the user's own machine), so the picker hides the
  // broker section there rather than listing rows that cannot connect.
  state.hosted = !!config.hosted;
  // Level 3 availability probe: needs the key flag above, so it lives in the
  // boot sequence rather than the rail's own top-level init.
  if (typeof l3Init === "function") try { l3Init(); } catch (e) { /* rail absent */ }

  setupIndicatorPanel();
  setupEditor();
  setupBacktest();
  setupAiPanel(!!config.hosted);
  // The research reader intercepts paper clicks only once this is known
  // false (local app); until then titles behave as plain external links.
  rsState.hosted = !!config.hosted;
  if (!config.hosted) uiEventsConnect();
  setupMyData();
  // The assistant context reads state.datasetList, which only library
  // surfaces populated: a session that never opened one sent the assistant
  // an empty library. Background load, so every page knows the real list.
  refreshDatasets().catch(() => {});
  setupLsbModal();
  setupRail();
  setupWindows(!!config.hosted);
  setupLseConnect();
  setupConnBar();
  setupLayouts();

  // The chart toolbar (symbol search, timeframes, chart type, indicator
  // buttons) belongs to the #charts surface only; on ECONOMIC / MACHINE
  // LEARNING / MY DATA / the backtest chooser it advertised controls that
  // did nothing. Mirroring #charts visibility with an
  // observer covers every show/hide path, including future ones, instead
  // of hand-toggling in each rail handler.
  const syncChartToolbar = () => {
    const off = $("charts").classList.contains("hidden");
    $("controls").classList.toggle("hidden", off);
    $("ind-active").classList.toggle("hidden", off);
    // The symbol/timeframe status readout is chart context too.
    $("status").classList.toggle("hidden", off);
  };
  new MutationObserver(syncChartToolbar)
    .observe($("charts"), { attributes: true, attributeFilter: ["class"] });
  syncChartToolbar();

  // Reopen the chart as it was left: the shell section carries the active
  // indicators (with params) and chart type. First run = SMA, as before.
  let shell = null;
  try {
    const body = await fetch("/api/workspace/shell").then((r) => r.ok ? r.json() : null);
    shell = body && body.value;
  } catch (e) { /* defaults below */ }
  state.activeIndicators = (shell && Array.isArray(shell.activeIndicators)
    ? shell.activeIndicators : [{ name: "sma" }])
    .filter((i) => i && state.indicatorSpecs.some((s) => s.name === i.name));
  // Stars survive a name that is momentarily unregistered (a broken user
  // file): keep the raw list, the renderer just won't show that row.
  state.favoriteIndicators = (shell && Array.isArray(shell.favoriteIndicators)
    ? shell.favoriteIndicators : []).filter((n) => typeof n === "string");
  if (shell && shell.chartType) {
    state.chartType = shell.chartType;
    $("chart-type").value = shell.chartType;
  }
  // Starred instruments per source. Only string lists survive the load: a
  // hand-edited file cannot break the sidebar.
  state.watchlists = {};
  if (shell && shell.watchlists && typeof shell.watchlists === "object") {
    for (const [prov, list] of Object.entries(shell.watchlists)) {
      if (Array.isArray(list)) {
        state.watchlists[prov] = list.filter((x) => typeof x === "string");
      }
    }
  }
  // The sidebar may have painted before this landed (the provider switch
  // and this load race at boot); a live source repaints to show the group.
  if (state.provider && state.provider !== "userdata") renderWatchlist();
  renderActiveIndicators();

  $("chart-type").onchange = (e) => {
    state.chartType = e.target.value;
    pushToChart();
    saveShellState();
  };

  // Chart colours & settings: opens the appearance dialog inside the mounted
  // chart (the site's own panels; edits persist to the workspace file).
  // One door: the Chart layout panel carries both tabs (colours + chart
  // behaviour). The short-lived two-button split was reverted;
  // openAppearance still accepts a view for the future.
  $("cs-open").onclick = () => {
    if (state.chartMounted && window.LSEChart && window.LSEChart.openAppearance) {
      window.LSEChart.openAppearance();
    } else {
      status("open a chart first");
    }
  };

  // The subplot pane strip belonged to the removed lightweight-charts view.
  // Engine indicators now draw on the chart itself (as precomputed
  // customIndicators), so the strip stays hidden while the picker stays live.
  const panesEl = $("panes");
  if (panesEl) panesEl.style.display = "none";

  if (config.hosted) {
    // Hosted terminal: no local file writes, no user Python, no key entry,
    // and no assistant (the proxy needs the user's own local key). The
    // MARKETS connect form can't save either, so it shows text only.
    $("ind-create").classList.add("hidden");
    // (the toolbar My Data button was removed; hiding the rail tab is enough)
    $("rail-data").classList.add("hidden");
    // WORKSPACE is file writes + a PTY, both denied on the shared host.
    $("rail-workspace").classList.add("hidden");
    // The AI rail itself is hidden by setupAiPanel(hosted).
    $("lse-keyline").classList.add("hidden");
    // No per-user keys on the shared site server, so no key manager either.
    $("conn-bar").classList.add("hidden");
  }
  // Light/dark toggle. A full reload on switch is deliberate: the React
  // islands (chart engine, calendar, manual backtest) read the html class
  // and the shell CSS vars once at mount, so live retheming would need every
  // island remounted; a reload restores the exact same view from the
  // workspace state anyway. The boot script in index.html replays the choice
  // before first paint.
  const themeBtn = $("theme-toggle");
  const isDarkTheme = () => document.documentElement.classList.contains("dark");
  // Emoji shows the mode a click switches TO: sun offers light, moon offers
  // dark (replaced the "Light"/"Dark" text label).
  themeBtn.textContent = isDarkTheme() ? "☀️" : "🌙";
  themeBtn.onclick = () => {
    try { localStorage.setItem("lset-theme", isDarkTheme() ? "light" : "dark"); } catch (e) {}
    location.reload();
  };

  // At most 20 watchlist calls/minute; the demo broker separately budgets 30.
  // Render primes share the same gate, leaving headroom even on a 60/min key.
  setInterval(pollPrices, PRICE_POLL_INTERVAL_MS);

  $("symbol").addEventListener("input", (e) => loadInstruments(e.target.value));
  // Enter takes the exact match, whatever case was typed, or else the first
  // suggestion (pickTypedSymbol). `change` is the same pick by another road:
  // an option chosen from the list, or the box left with text in it.
  $("symbol").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    pickTypedSymbol(e.target);
  });
  $("symbol").addEventListener("change", (e) => pickTypedSymbol(e.target));

  // Land on MARKETS: live LSE data when a key is set, otherwise the
  // connect-key form. The rail handler owns that branch.
  $("rail-markets").click();
  // the header is drawn whole now: a Connections sheet may hang from it
  csLand();
  // A window opened on a view (another monitor's window, a reload, the
  // desktop app bringing its windows back) goes to it.
  if (lseWin.view) {
    try { viewOpen(lseWin.view); } catch (e) { /* stays on MARKETS */ }
  }

  // (The old ?ai=open deep link is gone: the AI rail is permanent now.)
}

// Replay the saved assistant fold BEFORE first paint (this script tag is
// synchronous at the end of <body>), so a collapsed rail never flashes open
// while boot()'s fetches are in flight.
try {
  if (localStorage.getItem("lset-air-collapsed") === "1")
    $("ai-rail").classList.add("collapsed");
} catch (e) { /* storage disabled: start expanded */ }

// (a boot that failed lands too: the Connections screen does not wait on it)
boot().catch((e) => status(`boot failed: ${e}`)).finally(() => csLand());

/* ── trade panel (MARKETS right-rail): the demo-broker ticket ────────────── */
const tpx = { acct: null, timer: null, dockTab: "pos", fills: null, positions: [],
              orders: [],
              // an order out from the ticket (Buy and Sell held until its
              // answer); requests whose outcome is not known (tpxHold); and
              // the dock's closes and cancels out (one press, one request)
              placing: false, held: [], inflight: new Set(),
              // this page's own requests on their way (client_id -> what was
              // sent) and every client_id it sent (-> the record's read
              // number when its answer came; Infinity while it is out), and
              // the engine's record as last read (tpxFetchHeld)
              sending: new Map(), mine: new Map(), record: null, heldSeq: 0, heldApplied: 0 };

/* ── chart position overlays: interactive order lines on the pro chart ────
   Every open position on the charted symbol becomes an engine order line:
   click selects it, the SL/TP handles drag (released level POSTs to
   /api/sim/modify), the line's × closes. The chart engine already owns all
   the interaction; the shell only feeds lines and receives callbacks. */
function acdPushChartLines() {
  if (!window.LSEChart) return;
  // Broker symbols and chart symbols spell the same instrument differently
  // ("EURUSD" vs "EUR/USD"), so the match strips separators on both sides.
  // Exact-equal matching left broker positions invisible on the chart.
  const want = tpbBare(state.symbol);
  const lines = (tpx.positions || [])
    .filter((p) => tpbBare(p.symbol) === want)
    .map((p) => ({
      id: String(p.id),
      price: p.avg_price,
      side: p.qty > 0 ? "buy" : "sell",
      quantity: Math.abs(p.qty),
      pnl: p.unrealized_pnl == null ? undefined : p.unrealized_pnl,
      stopLoss: p.sl_price == null ? undefined : p.sl_price,
      takeProfit: p.tp_price == null ? undefined : p.tp_price,
    }));
  // SL/TP drag is offered only where it can land: the sim always takes it,
  // a broker only when its handshake declares orders.modify (SPEC 3: absent
  // from capabilities is absent from the broker; offering the handle and
  // eating the refusal is the forbidden silent path).
  const canModify = !tpbViaConnector() || !!(tpbCaps().orders || {}).modify;
  window.LSEChart.update({ positions: lines,
    onPositionModify: canModify ? acdModifyFromChart : undefined,
    onPositionClose: acdCloseFromChart });
}

async function acdModifyFromChart(id, sl, tp) {
  const p = (tpx.positions || []).find((x) => String(x.id) === String(id));
  if (!p || !tpx.acct) return;
  try {
    // One contract, two doors: the full desired bracket every time, null
    // clears a side. The broker door is SPEC order.modify via the hub.
    const r = tpbViaConnector()
      ? await fetch("/api/broker/modify", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ broker: tpb.broker,
            position_id: String(p.position_id || p.id),
            sl: sl == null ? null : sl, tp: tp == null ? null : tp }) })
      : await fetch("/api/sim/modify", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: tpx.acct.id, symbol: p.symbol,
            sl_price: sl == null ? null : sl, tp_price: tp == null ? null : tp }) });
    if (!r.ok) {
      // The broker's reason whole, as an order's is.
      const e = await r.json().catch(() => ({}));
      tpxSay(tpbPlainReason(String(e.detail || "SL/TP rejected")), "err");
    } else {
      tpxSay("SL/TP updated", "ok");
    }
  } catch (e) {
    tpxSay("SL/TP update failed", "err");
  }
  tpxRefreshPositions(); // re-pull so the line snaps to the accepted values
}

async function acdCloseFromChart(id) {
  const p = (tpx.positions || []).find((x) => String(x.id) === String(id));
  if (!p || !tpx.acct) return;
  await acdCloseFull(p);
}

/* ── account dock: the MT-style strip under the chart ──────────────────── */
// Currency is the ACCOUNT's denomination and is authoritative (SPEC 2): a
// dock that prefixes "$" to a GBP or USDT balance is wrong by an exchange
// rate on every number it shows. USD keeps the $ prefix; everything else is
// suffixed with its code, which needs no symbol table to be right.
const acdMoney = (v, ccy) => {
  if (v == null) return "–";
  const n = Number(v).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (!ccy || ccy === "USD") ? "$" + n : n + " " + ccy;
};
const acdPnl = (v) => v == null ? ""
  : (v >= 0 ? "+" : "") + Number(v).toFixed(2);

function acdRenderSummary() {
  const a = tpx.acct;
  if (!a) return;
  const ccy = a.currency;
  $("acd-balance").textContent = acdMoney(a.balance, ccy);
  $("acd-equity").textContent = acdMoney(a.equity, ccy);
  const up = $("acd-upnl");
  up.textContent = a.unrealized_pnl == null ? "–" : acdPnl(a.unrealized_pnl);
  up.className = "acd-v " + (a.unrealized_pnl > 0 ? "p-pos" : a.unrealized_pnl < 0 ? "p-neg" : "");
  $("acd-used").textContent = acdMoney(a.used_margin, ccy);
  $("acd-free").textContent = (a.equity != null && a.used_margin != null)
    ? acdMoney(a.equity - a.used_margin, ccy) : "–";
  $("acd-lev").textContent = a.leverage ? "1:" + a.leverage : "–";
}

// Blank the dock to a stated reason (broker switch in flight, nothing
// connected yet). Without this a switch left the PREVIOUS account's table
// under the NEW broker's name until the first poll landed.
function acdReset(note) {
  tpx.acct = null;
  tpx.positions = [];
  tpx.orders = [];
  tpx.fills = null;
  for (const id of ["acd-balance", "acd-equity", "acd-upnl", "acd-used",
                    "acd-free", "acd-lev"]) $(id).textContent = "–";
  $("acd-upnl").className = "acd-v";
  $("acd-body").innerHTML = note
    ? `<div class="acd-empty">${note}</div>` : "";
  acdPushChartLines();
}

function acdRenderPositions(poss) {
  const host = $("acd-body");
  host.innerHTML = "";
  if (!poss.length) {
    host.innerHTML = '<div class="acd-empty">No open positions</div>';
    return;
  }
  const t = document.createElement("table");
  t.className = "acd-table";
  t.innerHTML = "<thead><tr><th>Symbol</th><th>Side</th><th>Qty</th>" +
    "<th>Avg price</th><th>Price</th><th>P&amp;L</th><th></th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const p of poss) {
    const q = dockQuote(p.symbol);
    // marked at the closing side: bid exits a long, ask exits a short
    const cur = q ? (p.qty > 0 ? q.bid : q.ask) : null;
    const tr = document.createElement("tr");
    tr.className = "acd-row";
    tr.title = "Position actions";
    // left-click and right-click both drop the actions menu (show on chart,
    // partial closes, full close); the × cell stops propagation
    tr.onclick = (ev) => acdShowPosMenu(ev, p);
    tr.oncontextmenu = (ev) => acdShowPosMenu(ev, p);
    // p.symbol is the broker's own spelling of the instrument: escaped
    tr.innerHTML =
      `<td>${escHtml(p.symbol)}</td>` +
      `<td class="${p.qty > 0 ? "p-pos" : "p-neg"}">${p.qty > 0 ? "Buy" : "Sell"}</td>` +
      `<td>${Math.abs(p.qty)}</td>` +
      `<td>${acdPx(p.symbol, p.avg_price)}</td>` +
      `<td>${cur == null ? "–" : acdPx(p.symbol, cur)}</td>` +
      `<td class="${p.unrealized_pnl >= 0 ? "p-pos" : "p-neg"}">${acdPnl(p.unrealized_pnl)}</td>`;
    const td = document.createElement("td");
    const x = document.createElement("button");
    x.className = "acd-close";
    x.textContent = "×";
    x.title = "Close position";
    x.onclick = async (ev) => {
      ev.stopPropagation(); // the row click underneath selects, not closes
      await acdCloseFull(p);
    };
    td.appendChild(x);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  host.appendChild(t);
}

/* ── position row dropdown ─────────────────────────────────────────────────
   One shared menu, opened by left- OR right-click on a dock row. Partial
   closes are opposite-side market orders: the sim engine nets them into the
   position (margin gate skips risk-reducing orders) and rounds qty to the
   contract's qty_step server-side, so a fraction below the step comes back
   as a clear rejection rather than silently closing the wrong amount. */
let acdMenuEl = null;

function acdHideMenu() {
  if (acdMenuEl) { acdMenuEl.remove(); acdMenuEl = null; }
}
// the menu floats on document.body, so the dock's 5s re-render never kills
// it; dismissal has to be explicit (outside press or Escape)
document.addEventListener("mousedown", (e) => {
  if (acdMenuEl && !acdMenuEl.contains(e.target)) acdHideMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") acdHideMenu();
});

function acdSelectOnChart(p) {
  // A broker writes its own spelling ("EURUSD"); the chart speaks the
  // provider's ("EUR/USD"). Resolve through the instrument list, and stay
  // put when nothing matches rather than sending the chart somewhere it
  // cannot load a candle from.
  const want = tpbBare(p.symbol);
  if (tpbBare(state.symbol) !== want && typeof setSymbol === "function") {
    const hit = (state.instruments || []).find((i) => tpbBare(i.symbol) === want);
    setSymbol(hit ? hit.symbol : p.symbol);
  }
  // Deliberately NOT passing autoSelectPositionId: the chart treats a
  // selected position as "editing" and drops the SL/TP drafts plus the
  // Place/Cancel/Close toolbar onto the chart. Showing
  // is just navigation; the entry line and its qty@price tag render for
  // every position of the charted symbol anyway, and clicking that line
  // is still the way into edit mode when the user wants it.
}

// The same close or cancel pressed again while it is out is not a second one.
async function tpxOnce(key, fn) {
  if (tpx.inflight.has(key)) return;
  tpx.inflight.add(key);
  try { return await fn(); } finally { tpx.inflight.delete(key); }
}

// A close or cancel sent to the broker (asked again: `again`). True when it
// was answered; false when its outcome is not known (held, with "Ask again")
// or it was refused, both said on the ticket's line. `about` is what it is
// about: its instrument, and a cancel's order, kept with it while it is held
// (tpxHeldOverlap, tpxHeldName).
async function acdSend(kind, url, body, label, run, again, about) {
  const hold = (res, engine) => tpxHold({ kind, broker: body.broker,
    body: { ...body, client_id: (res && res.client_id) || body.client_id },
    ...(about || {}), engine: !!engine, words: res && res.detail, run,
    stillUnknown: !!again && !engine });
  let r, res;
  const answered = tpxSending(kind, body, about);
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                           body: JSON.stringify(body) });
  } catch (e) {
    answered();
    hold({ detail: String(e.message || e) }, true);
    return false;
  }
  answered();
  if (kind === "cancel" && (r.status === 404 || r.status === 405)) {
    // the cancel route is newer than the running engine (see tpxPlacePending)
    tpxSay("engine update needed for pending orders", "err");
    return false;
  }
  res = await readResult(r);
  // settled: answered, or refused by the broker for good (as tpbOrder)
  const settled = r.ok || (r.status === 400 && !res.retryable);
  if (!settled && res.unknown) {
    hold(res, false);
    return false;
  }
  // asked again on another account than its own: Switch back (tpxOtherAccount)
  if (again && tpxOtherAccount((tpx.held || []).find((x) => x.body.client_id === body.client_id)
                               || { broker: body.broker, body }, r.status, res)) return false;
  if (!settled && again) {
    tpxSay(tpbPlainReason(String(res.detail || r.status)), "err");
    return false;
  }
  tpxHeldDone(body.client_id);
  if (!r.ok) {
    tpxSay(tpbPlainReason(String(res.detail || r.status)), "err");
    return false;
  }
  tpxSay(label, "ok");
  return true;
}

// The close a dock or chart press asks for, settled against what is held:
// the same close of the position asks again, any other request on its
// instrument only on a yes (tpxHeldGate). Asked again by "Ask again",
// `again` is the held one. `symbol` is the position's instrument.
async function acdCloseSend(want, again, label, run, symbol) {
  await tpxOnce("close:" + want.position_id, async () => {
    let body = want;
    if (!again) {
      const go = await tpxHeldGate("close", want, "close", "Close it", symbol);
      if (!go) return;
      body = go.body;
      again = go.again;
    }
    tpxSetMsg(again ? "asking again…" : label.going);
    await acdSend("close", "/api/broker/close", body,
                  `${again ? "Asked again: " : ""}${label.done}`, run, !!again, { symbol });
    tpxRefreshAccount(); tpxRefreshPositions();
  });
}

async function acdClosePart(p, frac, again) {
  // (Asked again, it needs no account read yet: what was sent goes again.)
  if (!tpx.acct && !again) return;
  const qty = Math.abs(p.qty) * frac;
  if (tpbViaConnector()) {
    // SPEC position.close with qty. The broker validates the fraction
    // against its own qty_step and refuses a bad one in words; rounding
    // it here would be this panel silently closing a different amount
    // than the user chose. Asked again, exactly what was sent: the
    // position may already be smaller by it.
    const want = again ? { ...again.body } : { broker: tpb.broker,
      position_id: String(p.position_id || p.id), qty };
    const pct = Math.round(frac * 100);
    await acdCloseSend(want, again, { going: `closing ${pct}% of ${p.symbol}…`,
                                      done: `closed ${pct}% of ${p.symbol}` },
                       (h) => acdClosePart(p, frac, h), p.symbol);
    return;
  }
  tpxSetMsg(`closing ${Math.round(frac * 100)}% of ${p.symbol}…`);
  try {
    const side = p.qty > 0 ? "sell" : "buy"; // reduce, never flip
    const r = await fetch("/api/sim/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: tpx.acct.id, symbol: p.symbol, side, otype: "market", qty }),
    });
    const res = await readResult(r);
    if (!r.ok) throw new Error(res.detail || r.status);
    tpxSetMsg(res.status === "filled" ? `closed ${Math.round(frac * 100)}% of ${p.symbol}`
      : `${res.status}${res.reason ? ": " + res.reason : ""}`,
      res.status === "filled" ? "ok" : "err");
  } catch (e) {
    // the demo account's reason whole, as a broker's is
    tpxSetMsg(String(e.message || e), "err");
  }
  tpxRefreshAccount(); tpxRefreshPositions();
}

async function acdCloseFull(p, again) {
  if (!tpx.acct && !again) return;
  if (tpbViaConnector()) {
    const want = again ? { ...again.body } : { broker: tpb.broker,
      position_id: String(p.position_id || p.id) };
    // A close of part of the position asked again from here (one restored
    // from the engine's record, tpxRestoreHeld) says how much.
    const what = want.qty != null ? `${want.qty} of ${p.symbol}` : p.symbol;
    await acdCloseSend(want, again, { going: `closing ${what}…`, done: `closed ${what}` },
                       (h) => acdCloseFull(p, h), p.symbol);
    return;
  }
  try {
    await fetch(`/api/sim/close?account_id=${tpx.acct.id}&symbol=${encodeURIComponent(p.symbol)}`, { method: "POST" });
    tpxSetMsg(`closed ${p.symbol}`, "ok");
  } catch (e) {
    tpxSetMsg(String(e.message || e), "err");
  }
  tpxRefreshAccount(); tpxRefreshPositions();
}

// A held close's position as the dock lists it, or, when the dock does not
// (yet) list it, one named by what was sent: the close it is asked again is
// the request as it was sent either way.
function acdHeldPosition(h) {
  const id = String(h.body.position_id);
  return (tpx.positions || []).find((p) => String(p.position_id || p.id) === id)
    || { id, position_id: id, symbol: tpxHeldSymbol(h) || id };
}

// A held cancel's order as the Orders tab lists it, else one named by its id.
function acdHeldOrder(h) {
  const id = String(h.body.order_id);
  return (tpx.orders || []).find((o) => String(o.id) === id) || { id, symbol: tpxHeldSymbol(h) };
}

function acdShowPosMenu(ev, p) {
  ev.preventDefault(); // right-click must not open the browser menu
  acdHideMenu();
  const m = document.createElement("div");
  m.className = "acd-menu";
  const head = document.createElement("div");
  head.className = "acd-menu-head";
  head.textContent = `${p.symbol} · ${p.qty > 0 ? "Buy" : "Sell"} ${Math.abs(p.qty)}`;
  m.appendChild(head);
  const add = (label, cls, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = (e) => { e.stopPropagation(); acdHideMenu(); fn(); };
    m.appendChild(b);
  };
  add("Show on chart", "", () => acdSelectOnChart(p));
  const sep = document.createElement("div");
  sep.className = "acd-menu-sep";
  m.appendChild(sep);
  add("Close 25%", "", () => acdClosePart(p, 0.25));
  add("Close half", "", () => acdClosePart(p, 0.5));
  add("Close 75%", "", () => acdClosePart(p, 0.75));
  add("Close position", "danger", () => acdCloseFull(p));
  document.body.appendChild(m);
  // the dock hugs the bottom of the window, so the menu usually has no room
  // below the cursor: measure, then flip above / pull left as needed
  const r = m.getBoundingClientRect();
  let x = ev.clientX, y = ev.clientY;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height;
  // flip can still overflow on short windows: clamp both axes into view
  y = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - r.height - 8));
  x = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - r.width - 8));
  m.style.left = x + "px";
  m.style.top = y + "px";
  acdMenuEl = m;
}

async function acdRenderHistory() {
  // Which ledger this tab shows follows the ticket's trading path: the
  // connected broker's own fills through brue-connect, the hosted sim's
  // otherwise. It used to be hardwired to /api/sim/fills, which on the
  // broker path rendered one account's history under another account's
  // summary strip.
  if (tpbViaConnector()) {
    let fills;
    try {
      const r = await fetch(`/api/broker/fills?broker=${encodeURIComponent(tpb.broker)}`);
      if (!r.ok) {
        const e = await readResult(r);
        if (tpx.dockTab !== "hist") return;
        // The broker's words whole, on one line, without the protocol's code
        // word in front (tpbPlainReason), and as text: they are its words,
        // never markup on this page.
        const host = $("acd-body");
        host.innerHTML = "";
        const note = document.createElement("div");
        note.className = "acd-empty";
        note.textContent = "History unavailable: "
          + tpbPlainReason(String(e.detail || r.status).replace(/\s+/g, " ").trim());
        host.appendChild(note);
        return;
      }
      fills = await r.json();
    } catch (e) { return; }
    // SPEC Fill: time is UTC epoch ms; realized_pnl is present on ledgers
    // that carry it (lse-sim) and absent on plain order fills (paper), so
    // null renders as blank rather than a fabricated zero.
    tpx.fills = (fills || [])
      .map((f) => ({ ts: f.time, symbol: f.symbol, side: f.side,
                     qty: f.qty, price: f.price,
                     realized_pnl: f.realized_pnl == null ? null : f.realized_pnl }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 200);
  } else {
    if (!tpx.acct) return;
    try {
      const r = await fetch(`/api/sim/fills?account_id=${tpx.acct.id}&limit=100`);
      if (!r.ok) return;
      tpx.fills = await r.json();
    } catch (e) { return; }
  }
  if (tpx.dockTab !== "hist") return; // user moved on while fetching
  const host = $("acd-body");
  host.innerHTML = "";
  if (!(tpx.fills || []).length) {
    host.innerHTML = '<div class="acd-empty">No trades yet</div>';
    return;
  }
  const t = document.createElement("table");
  t.className = "acd-table";
  t.innerHTML = "<thead><tr><th>Time</th><th>Symbol</th><th>Side</th>" +
    "<th>Qty</th><th>Price</th><th>Realized P&amp;L</th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const f of tpx.fills) {
    const tr = document.createElement("tr");
    const when = f.ts ? new Date(f.ts).toLocaleString(undefined,
      { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    tr.innerHTML =
      `<td>${when}</td><td>${escHtml(f.symbol)}</td>` +
      `<td class="${f.side === "buy" ? "p-pos" : "p-neg"}">${f.side === "buy" ? "Buy" : "Sell"}</td>` +
      `<td>${escHtml(f.qty)}</td><td>${acdPx(f.symbol, f.price)}</td>` +
      `<td class="${f.realized_pnl > 0 ? "p-pos" : f.realized_pnl < 0 ? "p-neg" : ""}">` +
      `${f.realized_pnl == null ? "" : acdPnl(f.realized_pnl)}</td>`;
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  host.appendChild(t);
}

/* ── working (resting) orders: the dock's Orders tab ──────────────────────
   A resting order the trader cannot see or cancel is a trap, so the tab
   ships in the same change as the chart menu that creates them. Sim path
   lists /api/sim/orders; broker path lists SPEC orders.list through the
   hub, offered only where the handshake declares orders.pending. */
async function tpxRefreshOrders() {
  try {
    let orders = [];
    if (tpbViaConnector()) {
      if ((tpbCaps().orders || {}).pending) {
        const r = await fetch(`/api/broker/orders?broker=${encodeURIComponent(tpb.broker)}`);
        // 404 = an engine older than this UI (frozen desktop sidecar):
        // degrade to an empty list; placement is guarded separately.
        if (r.ok) orders = (await r.json()).map((o) => ({
          id: o.order_id, symbol: o.symbol, side: o.side,
          otype: o.type, qty: o.qty,
          // one display price per row: the trigger for a stop, the level
          // for a limit (SPEC puts both in `price`; stop_price is the
          // stop_limit trigger and the legacy alias)
          price: o.type === "limit" ? o.price : (o.stop_price || o.price),
        }));
      }
    } else {
      if (!tpx.acct) return;
      const r = await fetch(`/api/sim/orders?account_id=${tpx.acct.id}`);
      if (r.ok) orders = (await r.json()).map((o) => ({
        id: o.id, symbol: o.symbol, side: o.side, otype: o.otype,
        qty: o.qty,
        price: o.otype === "limit" ? o.limit_price : o.stop_price,
      }));
    }
    tpx.orders = orders;
    if (tpx.dockTab === "ord") acdRenderOrders(orders);
  } catch (e) { /* transient */ }
}

function acdRenderOrders(orders) {
  const host = $("acd-body");
  host.innerHTML = "";
  if (!orders.length) {
    host.innerHTML = '<div class="acd-empty">No working orders</div>';
    return;
  }
  const t = document.createElement("table");
  t.className = "acd-table";
  t.innerHTML = "<thead><tr><th>Symbol</th><th>Type</th><th>Side</th>" +
    "<th>Qty</th><th>Order price</th><th>Price</th><th></th></tr></thead>";
  const tb = document.createElement("tbody");
  for (const o of orders) {
    const q = dockQuote(o.symbol);
    // marked at the FILLING side: a buy order will deal at the ask, a sell
    // at the bid, so that is the distance the trader is watching
    const cur = q ? (o.side === "buy" ? q.ask : q.bid) : null;
    const tr = document.createElement("tr");
    tr.className = "acd-row";
    tr.innerHTML =
      `<td>${escHtml(o.symbol)}</td>` +
      `<td>${escHtml(o.otype)}</td>` +
      `<td class="${o.side === "buy" ? "p-pos" : "p-neg"}">${o.side === "buy" ? "Buy" : "Sell"}</td>` +
      `<td>${escHtml(o.qty)}</td>` +
      `<td>${o.price == null ? "–" : acdPx(o.symbol, o.price)}</td>` +
      `<td>${cur == null ? "–" : acdPx(o.symbol, cur)}</td>`;
    const td = document.createElement("td");
    const x = document.createElement("button");
    x.className = "acd-close";
    x.textContent = "×";
    x.title = "Cancel order";
    x.onclick = async (ev) => {
      ev.stopPropagation();
      await acdCancelOrder(o);
    };
    td.appendChild(x);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  host.appendChild(t);
}

async function acdCancelOrder(o, again) {
  if (tpbViaConnector()) {
    // The order's instrument goes beside its id: the engine keeps it with a
    // cancel whose answer has not come, so a page loaded later knows what
    // the cancel is about before its Orders tab has read the order.
    const want = again ? { ...again.body } : { broker: tpb.broker, order_id: String(o.id),
      ...(o.symbol != null && o.symbol !== "" ? { symbol: String(o.symbol) } : {}) };
    // An order the Orders tab does not list (a cancel restored from the
    // engine's record, acdHeldOrder) is named by its id.
    const what = o.side ? `${o.side} ${o.otype} @ ${o.price == null ? "" : acdPx(o.symbol, o.price)}`
      : `order ${want.order_id}`;
    await tpxOnce("cancel:" + want.order_id, async () => {
      let body = want;
      if (!again) {
        // The x on an order whose cancel may have been carried out is that
        // cancel asked again, under its client_id; any other request on
        // the order's instrument only on a yes (tpxHeldGate).
        const go = await tpxHeldGate("cancel", want, "cancel", "Cancel it", o.symbol);
        if (!go) return;
        body = go.body;
        again = go.again;
      }
      if (again) tpxSetMsg("asking again…");
      await acdSend("cancel", "/api/broker/order/cancel", body,
                    `${again ? "Asked again: " : ""}${what} cancelled`,
                    (h) => acdCancelOrder(o, h), !!again,
                    { symbol: o.symbol, order: o.side ? { side: o.side, otype: o.otype, price: o.price,
                                                          symbol: o.symbol } : null });
      tpxRefreshAccount(); tpxRefreshOrders();
    });
    return;
  }
  try {
    const r = await fetch("/api/sim/orders/cancel", { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: tpx.acct.id, order_id: o.id }) });
    // same old-engine shape as placement: 404/405 = the route is newer than
    // the running engine, and "Method Not Allowed" helps nobody
    if (r.status === 404 || r.status === 405) {
      throw new Error("engine update needed for pending orders");
    }
    const res = await readResult(r);
    if (!r.ok) throw new Error(res.detail || r.status);
    tpxSetMsg(`${o.side} ${o.otype} @ ${o.price == null ? "" : acdPx(o.symbol, o.price)} cancelled`, "ok");
  } catch (e) {
    tpxSetMsg(tpbPlainReason(String(e.message || e)), "err");
  }
  tpxRefreshAccount(); tpxRefreshOrders();
}

// Switch the dock to the Orders tab (also called after a resting placement:
// the order must land somewhere the trader can see it, and the dock opens on
// Positions, where a resting order by definition is not).
function acdShowOrdersTab() {
  tpx.dockTab = "ord";
  $("acd-tab-ord").classList.add("active");
  $("acd-tab-pos").classList.remove("active");
  $("acd-tab-hist").classList.remove("active");
  tpxRefreshOrders();
}

/* ── chart right-click trading ─────────────────────────────────────────────
   The chart's context menu (mount.tsx) offers Buy/Sell at market plus
   limit/stop at the clicked price, MT-style. The menu calls back through
   window.__lseShell so the qty box, the broker routing and the result
   message stay the ticket's; the menu hands over only intent. */
function tpxTradeInfo() {
  if (!tpxVisible() || !tpx.acct) return { available: false };
  const qty = parseFloat($("tpx-qty").value);
  // The sim engine deals limit and stop for every account, always. A broker
  // offers only what its handshake declares (SPEC 3): absent from
  // capabilities is absent from the broker, and a menu row that ends in a
  // broker error is the forbidden silent-guess path.
  let pendingTypes = ["limit", "stop"];
  if (tpbViaConnector()) {
    const o = tpbCaps().orders || {};
    pendingTypes = o.pending
      ? (o.pending_types || []).filter((t) => t === "limit" || t === "stop")
      : [];
  }
  // The instrument an order from the chart's menu is placed on, and the places
  // and tick it is placed at: the ticket's own instrument through a connector,
  // the chart's own symbol on the sim. The menu offers its order rows only when
  // the chart shows this instrument (a bare-symbol match), fills the form at
  // these places snapped to this tick (the chart source's only when none is
  // declared), and names it in every line it places; so a chart of one
  // instrument never trades another at the other's price.
  const spec = tpbViaConnector() ? tpbSpec() : null;
  const digits = spec && Number.isInteger(spec.digits) && spec.digits >= 0 && spec.digits <= 20 ? spec.digits : null;
  const tick = spec && spec.tick_size > 0 && isFinite(spec.tick_size) ? spec.tick_size : null;
  return { available: true, symbol: state.symbol,
           instrument: spec ? spec.symbol : state.symbol, digits, tick,
           qty: qty > 0 ? qty : null, pendingTypes };
}

async function tpxQuickOrder(side, otype, price, qty) {
  if (!otype || otype === "market") return tpxOrder(side);
  return tpxPlacePending(side, otype, price, qty);
}

async function tpxPlacePending(side, otype, price, qtyOverride, again, fresh) {
  if (!(price > 0)) { tpxSay("no price at cursor", "err"); return; }
  // The menu's order form carries its own size; absent (older bundle, or a
  // future caller that has none) the ticket's box stays the answer.
  const qty = qtyOverride > 0 ? qtyOverride : parseFloat($("tpx-qty").value);
  if (!(qty > 0)) { tpxSay("qty must be > 0", "err"); return; }
  // one order at a time from the ticket and its menu (tpxOrder)
  if (tpx.placing) return;
  tpxPlacing(true);
  let status, reason, placedOn = state.symbol;
  try {
    if (tpbViaConnector()) {
      let body;
      if (again) {
        body = { ...again.body };
      } else if (fresh) {
        // "Place as new" (tpxPlaceNew): what was sent, under a client_id of
        // its own, after the question it asked.
        body = { ...fresh, client_id: tpxNewClientId("") };
      } else {
        const spec = tpbSpec();
        if (!spec) throw new Error("no broker symbol");
        // As an order at market (tpbOrder): the same resting order again
        // while its outcome is not known is asked again under its
        // client_id; any other request on its instrument meanwhile only on
        // a yes.
        const go = await tpxHeldGate("pending",
          { broker: tpb.broker, symbol: spec.symbol, side, qty, type: otype, price },
          "", "Place it", spec.symbol);
        if (!go) return;
        body = go.body;
        again = go.again;
      }
      tpxSetMsg(again ? "asking again…" : "placing…");
      const hold = (res, engine) => tpxHold({ kind: "pending", broker: body.broker,
        body: { ...body, client_id: (res && res.client_id) || body.client_id },
        side: body.side, symbol: body.symbol, engine: !!engine, words: res && res.detail,
        stillUnknown: !!again && !engine,
        run: (h) => tpxPlacePending(h.side, h.body.type, h.body.price, h.body.qty, h) });
      // Its own endpoint, NOT a `type` field on /api/broker/order: an engine
      // older than this UI (frozen desktop sidecar) would drop the field and
      // fill a "Buy Limit" click at market. Here an old engine 404s instead.
      let r;
      const answered = tpxSending("pending", body, { side: body.side, symbol: body.symbol });
      try {
        r = await fetch("/api/broker/order/pending", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        answered();
        hold({ detail: String(e.message || e) }, true);
        return;
      }
      answered();
      // An engine older than this UI has no such route. That answers 404 or
      // 405, not only 404: an unrouted POST falls through to the engine's
      // static-file mount, and Starlette's StaticFiles refuses non-GET
      // methods with 405 "Method Not Allowed" (checked against :7788;
      // that exact string has shown up in the ticket).
      if (r.status === 404 || r.status === 405) {
        throw new Error("engine update needed for pending orders");
      }
      const res = await readResult(r);
      const settled = r.ok || (r.status === 400 && !res.retryable);
      if (!settled && res.unknown) {
        hold(res, false);
        return;
      }
      // asked again on another account than its own: Switch back (tpxOtherAccount)
      if (again && tpxOtherAccount(again, r.status, res)) return;
      if (!settled && again) {
        tpxSay(tpbPlainReason(String(res.detail || r.status)), "err");
        return;
      }
      tpxHeldDone(body.client_id);
      if (!r.ok) throw new Error(res.detail || r.status);
      status = res.status; reason = res.reason;
      placedOn = body.symbol;
    } else {
      tpxSetMsg("placing…");
      const body = { account_id: tpx.acct.id, symbol: state.symbol,
                     side, otype, qty };
      if (otype === "limit") body.limit_price = price;
      else body.stop_price = price;
      const r = await fetch("/api/sim/orders", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const res = await readResult(r);
      if (!r.ok) throw new Error(res.detail || r.status);
      status = res.status; reason = res.reason;
    }
    // The broker's reason, as the order at market's, is shown whole.
    if (status === "rejected") {
      tpxSay(tpbPlainReason(reason || "rejected"), "err");
    } else if (status === "filled") {
      // a marketable level fills straight away; say what actually happened
      tpxSay(`${again ? "Asked again: " : ""}${side} ${otype} ${qty} ${placedOn} filled`, "ok");
    } else {
      // sim says "working", a broker says "resting"/"accepted": all mean
      // the order is on the book at the asked level
      // The message prints the level; the order above SENT `price` untouched.
      tpxSay(`${again ? "Asked again: " : ""}${side} ${otype} ${qty} ${placedOn} @ ${acdPxLine(placedOn, price)} placed`, "ok");
      acdShowOrdersTab();
    }
  } catch (e) {
    tpxSay(tpbPlainReason(String(e.message || e)), "err");
  } finally {
    tpxPlacing(false);
    tpxRefreshAccount(); tpxRefreshPositions(); tpxRefreshOrders();
  }
}

function tpxVisible() {
  return !$("trade-panel").classList.contains("hidden");
}

function tpxSetMsg(text, cls) {
  const m = $("tpx-msg");
  m.textContent = text || "";
  m.className = cls || "";
  m.title = "";
  // a line of its own ("placing…"), not one tpxSay said: tpxResay leaves it
  tpx.lineSaid = false;
}

/* The ticket's logo tile next to the symbol (previously the logo
   only showed in the sidebar). Same art and the same monogram rule as a
   watchlist row: the active source's map first; when that misses and the
   ticket's symbols are LSE symbols (hosted relay, lse-sim), the LSE map,
   fetched lazily on the first miss. Any other broker's catalog is its own
   symbol space, where a same-string match could put the wrong company's
   art on an order, so it stays a monogram. */
function tpxSetLogo(symbol, name) {
  const tile = $("tpx-logo");
  if (!tile) return;
  const sym = symbol || "";
  let lg = state.logos[sym];
  const lseSpace = !tpbViaConnector() || tpb.broker === "lse-sim";
  if (!lg && sym && lseSpace) {
    if (state.logoFallback === null) loadLogoFallback();
    lg = (state.logoFallback || {})[sym];
  }
  const dark = document.documentElement.classList.contains("dark");
  const src = lg ? String(dark ? lg.dark : lg.light) : "";
  const cur = tile.querySelector("img");
  if (src && cur && cur.getAttribute("src") === src) return; // same art, no churn
  if (cur) cur.remove();
  tile.querySelector(".winit").textContent = sym ? logoInitial({ name, symbol: sym }) : "";
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove(); // monogram underneath takes over
    img.src = src;
    tile.appendChild(img);
  }
}

function tpxUpdateQuote() {
  if (!tpxVisible()) return;
  if (tpbViaConnector()) { tpbUpdateQuote(); return; }
  // the ticket names what it trades: pair + display name, same source as
  // the sidebar and the title bar
  $("tpx-sym").textContent = state.symbol || "–";
  const tpInst = catalogInstrument(state.symbol);
  $("tpx-name").textContent = tpInst && tpInst.name ? tpInst.name : "";
  tpxSetLogo(state.symbol, tpInst && tpInst.name);
  const q = state.quotes[state.symbol];
  if (!q) { $("tpx-bid").textContent = $("tpx-ask").textContent = "–"; $("tpx-spread").textContent = "–"; return; }
  $("tpx-bid").textContent = fmt(q.bid);
  $("tpx-ask").textContent = fmt(q.ask);
  $("tpx-spread").textContent = fmt(q.ask - q.bid);
  // symbol switches route through here (see loadCandles); the overlays must
  // swap to the new symbol's positions immediately, not on the next 5s poll
  acdPushChartLines();
}

async function tpxRefreshAccount() {
  if (tpb.adopting) return; // the ticket has not decided its broker yet
  if (tpbViaConnector()) return tpbRefreshAccount();
  try {
    const r = await fetch("/api/sim/accounts");
    if (!r.ok) throw new Error(await r.text());
    const accts = await r.json();
    if (!accts.length) return;
    tpx.acct = accts[0];
    $("tpx-acct-name").textContent = tpx.acct.name;
    $("tpx-equity").textContent = "$" + Number(tpx.acct.equity).toLocaleString(undefined, { maximumFractionDigits: 2 });
    acdRenderSummary();
    // A refresh that succeeds clears this function's own error line; one
    // transient failure used to leave it pinned for the whole session.
    const msg = $("tpx-msg");
    if (msg && /sim account unavailable|connect your LSE key/.test(msg.textContent)) tpxSetMsg("");
  } catch (e) {
    tpxSetMsg(state.lseConfigured ? "sim account unavailable" : "connect your LSE key to trade", "err");
  }
}

async function tpxRefreshPositions() {
  if (tpb.adopting) return; // the ticket has not decided its broker yet
  if (tpbViaConnector()) return tpbRefreshPositions();
  if (!tpx.acct) return;
  try {
    const r = await fetch(`/api/sim/positions?account_id=${tpx.acct.id}`);
    if (!r.ok) return;
    const poss = await r.json();
    // No open-position rows inside the ticket: they
    // doubled the dock's Positions tab and the height they took belongs to
    // the assistant below. The state still updates here because the chart
    // lines, the dock tables and the AI snapshot all read tpx.positions.
    tpx.positions = poss;
    acdPushChartLines();
    if (tpx.dockTab === "pos") acdRenderPositions(poss);
    else if (tpx.dockTab === "hist") acdRenderHistory();
    // dockTab "ord" repaints on its own poll; stomping it here would blank
    // the Orders table every 5 seconds
  } catch (e) { /* transient */ }
}

// A broker or sim endpoint can answer a 500 with a plain-text body ("Internal
// Server Error"), which r.json() would throw on, surfacing the parser's own
// "Unexpected token 'I'..." message to the trader instead of something useful.
// Read the body once as text and parse only if it is JSON; otherwise carry the
// text (or the status) as a detail the caller can show: whole, on one line.
async function readResult(r) {
  const t = await r.text();
  try { return t ? JSON.parse(t) : {}; }
  catch (e) { return { detail: (t.replace(/\s+/g, " ").trim() || ("HTTP " + r.status)) }; }
}

async function tpxOrder(side, again, fresh) {
  // One order at a time from the ticket: Buy and Sell are held from the
  // press until its answer is in, so a second press while one is out (or
  // the chart's menu meanwhile) is not a second order.
  if (tpx.placing) return;
  tpxPlacing(true);
  try {
    if (tpbViaConnector()) return await tpbOrder(side, again, fresh);
    if (!tpx.acct) { tpxSetMsg("no sim account", "err"); return; }
    const qty = parseFloat($("tpx-qty").value);
    if (!(qty > 0)) { tpxSetMsg("qty must be > 0", "err"); return; }
    const body = { account_id: tpx.acct.id, symbol: state.symbol, side, otype: "market", qty };
    const sl = parseFloat($("tpx-sl").value), tp = parseFloat($("tpx-tp").value);
    if (sl > 0) body.sl_price = sl;
    if (tp > 0) body.tp_price = tp;
    tpxSetMsg("placing…");
    try {
      const r = await fetch("/api/sim/orders", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const res = await readResult(r);
      if (!r.ok) throw new Error(res.detail || r.status);
      tpxSetMsg(res.status === "filled" ? `${side} ${qty} ${state.symbol} filled` : `${res.status}${res.reason ? ": " + res.reason : ""}`,
                res.status === "filled" ? "ok" : "err");
      tpxRefreshAccount(); tpxRefreshPositions();
    } catch (e) {
      // the demo account's reason whole, as a broker's is
      tpxSetMsg(String(e.message || e), "err");
    }
  } finally {
    tpxPlacing(false);
  }
}

function tpxPlacing(on) {
  tpx.placing = !!on;
  for (const id of ["tpx-buy", "tpx-sell", "tpx-again", "tpx-new", "tpx-show", "tpx-conn", "tpx-back"]) {
    const b = $(id);
    if (b) b.disabled = !!on;
  }
}

/* One press, one order. A double-click is two click events, the second with
   ev.detail 2: only the first one acts. A key press has detail 0. */
function tpxOnePress(ev) {
  return !(ev && ev.detail > 1);
}

/* ── an answer that was lost (SPEC 2) ────────────────────────────────────
   A broker can take an order, a close or a cancel and never answer it. The
   engine then says its outcome is not known (`unknown`), with the client_id
   it went under. Asked again under that client_id, the broker's own record
   answers and nothing is carried out twice; a new client_id is a new order.
   So each request the ticket and the dock send carries a client_id made
   here, and one whose outcome is not known is held: the ticket says so in
   full, keeps what was sent, and offers to ask again with it, and pressing
   the same order again asks again too. Nothing is sent again by itself:
   asking again is the user's own press. */
function tpxNewClientId(kind) {
  let hex = "";
  try {
    const b = new Uint8Array(6);
    crypto.getRandomValues(b);
    hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    hex = (Math.random().toString(16).slice(2) + "000000000000").slice(0, 12);
  }
  return "lset-" + (kind ? kind + "-" : "") + hex;
}

function tpxSameOrder(a, b) {
  return ["broker", "symbol", "side", "qty", "sl", "tp", "type", "price"]
    .every((k) => (a[k] == null ? null : a[k]) === (b[k] == null ? null : b[k]));
}

// Whether two requests of one kind are the same request, its client_id
// aside: an order (at market or resting) by everything it asks for, a close
// by its position and its size (none for the whole), a cancel by its order.
function tpxSameRequest(kind, a, b) {
  const v = (x) => (x == null ? null : String(x));
  if (kind === "close") {
    return a.broker === b.broker && v(a.position_id) === v(b.position_id)
      && (a.qty == null ? null : a.qty) === (b.qty == null ? null : b.qty);
  }
  if (kind === "cancel") return a.broker === b.broker && v(a.order_id) === v(b.order_id);
  return tpxSameOrder(a, b);
}

// The held requests a new one could repeat or overlap: every request held
// on that connection for the same instrument, whatever its kind (an order, a
// close and a cancel of one instrument all change one position). A request
// that names no instrument, as one closing everything on the connection
// would, overlaps every one held on it; so does a held request whose
// instrument is not known: the careful answer.
function tpxHeldOverlap(kind, body, symbol) {
  const want = symbol != null ? String(symbol) : (body.symbol != null ? String(body.symbol) : null);
  return tpxHeldFor(body.broker).filter((h) => {
    const at = tpxHeldSymbol(h);
    return at == null || want == null || at === want;
  });
}

// The instrument a held request is about: kept with it when it was sent;
// for one restored from the engine's record, an order's own, else its
// position's or its resting order's as the dock lists them, else a position
// whose id is an instrument of the broker's catalog. null when not known.
function tpxHeldSymbol(h) {
  if (h.symbol != null) return String(h.symbol);
  const b = h.body || {};
  if (b.symbol != null) return String(b.symbol);
  if (h.kind === "close") {
    const p = (tpx.positions || []).find((x) => String(x.position_id || x.id) === String(b.position_id));
    if (p && p.symbol != null) return String(p.symbol);
    if ((tpb.catalog || []).some((s) => s.symbol === String(b.position_id))) return String(b.position_id);
  }
  if (h.kind === "cancel") {
    const o = (tpx.orders || []).find((x) => String(x.id) === String(b.order_id));
    if (o && o.symbol != null) return String(o.symbol);
  }
  return null;
}

// A held request in words, for the question another request is asked:
// "The close of 1000 EUR_USD", "The order to buy 2000 EUR_USD".
function tpxHeldName(h) {
  const b = h.body || {};
  if (h.kind === "order") return `The order to ${b.side} ${b.qty} ${b.symbol}`;
  if (h.kind === "pending") {
    return `The ${b.side} ${b.type} order for ${b.qty} ${b.symbol} at ${acdPx(b.symbol, b.price)}`;
  }
  if (h.kind === "close") {
    const what = tpxHeldSymbol(h) || String(b.position_id);
    return b.qty != null ? `The close of ${b.qty} ${what}` : `The close of ${what}`;
  }
  const o = h.order || acdHeldOrder(h);
  if (!o || !o.side) {
    // an order the dock does not list (a cancel carried out is never listed
    // again): its instrument, when the request or the record kept it
    const at = tpxHeldSymbol(h);
    return `The cancel of order ${b.order_id}` + (at ? ` (${at})` : "");
  }
  return `The cancel of the ${o.side} ${o.otype} ${o.symbol} order`
    + (o.price == null ? "" : ` at ${acdPx(o.symbol, o.price)}`);
}

/* Before an order, a close or a cancel is sent. The same request held is
   asked again: what was sent, under its client_id, so it is carried out
   once. Any other request on the instrument of a held one goes only on a
   yes, under a client_id of its own, and a "no" says the held one again;
   `yes` names what is about to be sent ("Place it", "Close it"). A request
   still out from before this page was loaded (held as waiting) is never
   asked again from here: the same request pressed again is asked about as
   any other is. The question names the latest held request. Returns
   {body, again} to send, or null when nothing is to be sent. */
async function tpxHeldGate(kind, body, idKind, yes, symbol) {
  const held = tpxHeldOverlap(kind, body, symbol);
  const same = held.find((h) => !h.waiting && h.kind === kind && tpxSameRequest(kind, h.body, body));
  if (same) return { body: { ...same.body }, again: same };
  if (held.length) {
    const h = held[held.length - 1];
    const ok = await askConfirm(`${tpxHeldName(h)} may have been carried out. Send this as well?`, yes, "Not now");
    if (!ok) { tpxShowHeld(h); return null; }
  }
  return { body: { ...body, client_id: tpxNewClientId(idKind) }, again: null };
}

/* The ticket's line after an answer or a check. While a request of this
   broker is still held, the line goes on saying so after it: an answer that
   covered the warning is what made pressing again look safe. The answer
   keeps its own style (a fill reads as done), the warning after it is in
   the error style, and the broker's words about the held request stay the
   line's tooltip. With nothing held on the ticket's broker, a request held
   or out on another connected broker is said the same way, named by its
   broker, with Show (tpxHeldElse). */
function tpxSay(text, cls) {
  const held = tpxHeldFor(tpb.broker);
  const h = held.length ? held[held.length - 1] : tpxHeldElse();
  const said = String(text || "").trim();
  tpx.lineAnswer = said ? [String(text), cls || ""] : null;
  if (!h) {
    tpxSetMsg(text, cls);
    tpx.lineSaid = true;
    tpx.lineHeld = "";
    tpxRenderAgain();
    return;
  }
  if (!said) { tpxShowHeld(h); return; }
  const m = $("tpx-msg");
  tpxSetMsg("", "");
  const answer = document.createElement("span");
  answer.className = cls || "";
  answer.textContent = /[.!?…]$/.test(said) ? said : said + ".";
  const warning = document.createElement("span");
  warning.className = "err";
  warning.textContent = tpxHeldLine(h);
  m.append(answer, " ", warning);
  if (h.words) m.title = String(h.words);
  tpx.lineSaid = true;
  tpx.lineHeld = tpxHeldKey(h);
  tpxRenderAgain();
}

// What may have happened, in a sentence, whole. A request still out (held as
// waiting) is waiting for its broker's answer: one sent before this page was
// loaded says so, one of this page's own does not.
function tpxHeldText(h) {
  const row = (brokerPicker.rows || []).find((b) => b.broker === h.broker);
  const name = brokerDisplayName(row || { broker: h.broker });
  if (h.waiting) {
    return `${tpxHeldName(h)}${h.mine ? "" : " sent before this page was loaded"} is waiting for ${name}'s answer.`;
  }
  // The engine stopped before the broker's answer came (the record's
  // engine_stopped): said in the record's own words, which say so, not as
  // an answer that was lost.
  if (h.code === "engine_stopped" && String(h.words || "").trim()) return tpbPlainReason(String(h.words).trim());
  const who = h.engine ? "the terminal's engine" : name;
  const say = {
    order: ["The order may have been placed", "Positions", "placing it again"],
    pending: ["The order may have been placed", "Orders", "placing it again"],
    close: ["The close may have been carried out", "Positions", "closing it again"],
    cancel: ["The cancel may have been carried out", "Orders", "cancelling it again"],
  }[h.kind];
  return `${say[0]}: the answer from ${who} was lost. Check ${say[1]} before ${say[2]}.`;
}

// The held sentence as the ticket's line says it: a request of another broker
// than the ticket's is named by that broker ("<its name>: The close may have ...").
function tpxHeldLine(h) {
  if (h.broker === tpb.broker) return tpxHeldText(h);
  const row = (brokerPicker.rows || []).find((b) => b.broker === h.broker);
  return `${brokerDisplayName(row || { broker: h.broker })}: ${tpxHeldText(h)}`;
}

// Which held request a line names, to tell when that has changed (tpxLoadHeld).
function tpxHeldKey(h) {
  return h ? `${h.broker}\n${h.body.client_id}\n${h.waiting ? 1 : 0}` : "";
}

function tpxHeldFor(broker) {
  return (tpx.held || []).filter((h) => h.broker === broker);
}

function tpxHold(h) {
  if (!h.since) h.since = tpxNow();
  tpx.held = (tpx.held || []).filter((x) => x.body.client_id !== h.body.client_id);
  tpx.held.push(h);
  // a request of another broker than the ticket's (the ticket moved on while
  // it was out) is said as another broker's is
  if (h.broker === tpb.broker) tpxShowHeld(h);
  else tpxSay("", "");
}

function tpxShowHeld(h) {
  tpxSetMsg(tpxHeldLine(h), "err");
  // the broker's own words, whole, where the window keeps them
  const m = $("tpx-msg");
  if (m && h.words) m.title = String(h.words);
  tpx.lineSaid = true;
  tpx.lineAnswer = null;
  tpx.lineHeld = tpxHeldKey(h);
  tpxRenderAgain();
}

// Its outcome is known now: whatever it was, it is no longer held.
function tpxHeldDone(clientId) {
  tpx.held = (tpx.held || []).filter((x) => x.body.client_id !== clientId);
  if (tpx.otherAccount && tpx.otherAccount.client_id === clientId) tpx.otherAccount = null;
  tpxRenderAgain();
}

function tpxRenderAgain() {
  const b = $("tpx-again");
  if (!b) return;
  const all = tpxHeldFor(tpb.broker);
  // Ask again is for a request whose answer was lost; one still out
  // (waiting) has no answer to ask about yet
  const mine = all.filter((h) => !h.waiting);
  if (mine.length) b.classList.remove("hidden");
  else b.classList.add("hidden");
  // "Place as new" beside it, for the order Ask again asks about, once
  // asking again was answered that its fate is still not known.
  const n = $("tpx-new");
  if (n) {
    const h = mine[mine.length - 1];
    if (h && h.stillUnknown && (h.kind === "order" || h.kind === "pending")) n.classList.remove("hidden");
    else n.classList.add("hidden");
  }
  // While the line names a request of another broker (tpxSay): "Show" when
  // that broker is connected, "Connect" when it is not (tpxConnectHeld)
  const other = all.length ? null : tpxHeldElse();
  const on = !!other && tpxConnected(other.broker);
  const s = $("tpx-show");
  if (s) {
    if (other && on) s.classList.remove("hidden");
    else s.classList.add("hidden");
  }
  const c = $("tpx-conn");
  if (c) {
    if (other && !on) c.classList.remove("hidden");
    else c.classList.add("hidden");
  }
  // "Switch back", while Ask again of a request still held here was refused
  // because the profile is on another account than its own (tpxOtherAccount)
  const back = $("tpx-back");
  if (back) {
    const o = tpx.otherAccount;
    const want = !!o && !!o.account && o.broker === tpb.broker && mine.some((h) => h.body.client_id === o.client_id);
    if (want) back.classList.remove("hidden");
    else back.classList.add("hidden");
  }
}

// "Ask again": the latest held request of this broker whose answer was lost,
// sent again as it was (one still out has no answer to ask about yet).
async function tpxAskAgain() {
  const mine = tpxHeldFor(tpb.broker).filter((h) => !h.waiting);
  const h = mine[mine.length - 1];
  if (h) await h.run(h);
}

/* "Place as new": the order Ask again asks about, which asking again found
   still not known, placed again under a client_id of its own after a yes.
   The broker may yet carry out the first, so the first stays held, its
   warning on the line, until its own answer. */
async function tpxPlaceNew() {
  const mine = tpxHeldFor(tpb.broker).filter((h) => !h.waiting);
  const h = mine[mine.length - 1];
  if (!h || !h.stillUnknown || (h.kind !== "order" && h.kind !== "pending") || tpx.placing) return;
  const row = (brokerPicker.rows || []).find((b) => b.broker === h.broker);
  const ok = await askConfirm(`${brokerDisplayName(row || { broker: h.broker })} may still carry out the `
    + "first order. Place a new one as well?", "Place it", "Not now");
  if (!ok) { tpxShowHeld(h); return; }
  const fresh = { ...h.body };
  delete fresh.client_id;
  if (h.kind === "order") await tpxOrder(h.side, null, fresh);
  else await tpxPlacePending(h.side, fresh.type, fresh.price, fresh.qty, null, fresh);
}

/* ── the engine's record of this window's requests (GET /api/broker/held) ──
   The engine writes each request this window sends on one of the four
   routes before it hands it on ("out"), keeps one whose answer said its fate
   is not known ("unknown"; also one still out when an engine stopped), and
   for 120 s after an answer keeps what it was ("answered", in memory only).
   So a page that loads, or reconnects, can say what the one before it said,
   and hear an answer the one before it never got. For the ticket's broker:
   - "out", and not this page's own request on its way: held as waiting. The
     line says it is waiting for the broker's answer; there is no Ask again;
     any other request on its instrument asks first, and so does the same
     request pressed again (tpxHeldGate);
   - "unknown": held exactly as if its answer had just been lost (tpxHold):
     the warning, the record's words, Ask again;
   - "answered", for a request held as waiting: it goes, and its answer is
     said as this page says its own (tpxAnswered); any other is ignored;
   - a request held that the record listed and lists no longer goes.
   A request out or unknown on another connected broker is said on the line,
   named, with Show (tpxHeldElse). The record is read on load, after each
   connect or reconnect, and every 5 s with the account tick while its last
   answer listed anything out or unknown for a connected broker or the page
   holds anything (tpxHeldWatch). An engine without the route (404), an
   answer that is not one and no answer at all change nothing: the page goes
   on as before. */
async function tpxLoadHeld(broker) {
  if (state.hosted) return;            // no broker connections there
  const generation = tpb.generation;
  const read = await tpxFetchHeld();
  if (!read) return;
  tpxApplyHeld(read, broker, generation);
  // the line said again when the request it should name has changed (an
  // answer, a request gone, another broker's)
  const held = tpxHeldFor(tpb.broker);
  if (tpxHeldKey(held.length ? held[held.length - 1] : tpxHeldElse()) !== (tpx.lineHeld || "")) tpxResay();
}

// One read of the record: its entries (one per request, oldest first by
// "since") and the read's number; null when there is nothing to read (an
// older engine, a refusal, no answer, another shape), or when a read asked
// later was taken before this one was answered.
async function tpxFetchHeld() {
  const seq = tpx.heldSeq = (tpx.heldSeq || 0) + 1;
  let list;
  try {
    const r = await fetch("/api/broker/held");
    if (!r.ok) return null;
    list = (await readResult(r)).held;
  } catch (e) { return null; }
  if (!Array.isArray(list) || seq < (tpx.heldApplied || 0)) return null;
  tpx.heldApplied = seq;
  // one entry per (broker, client_id): out before unknown before answered
  const rank = { out: 3, unknown: 2, answered: 1 };
  const best = new Map();
  for (const e of list) {
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.broker !== "string" || !e.broker
        || typeof e.client_id !== "string" || !e.client_id) continue;
    const r = rank[e.state == null ? "unknown" : e.state];
    if (!r) continue;
    const key = e.broker + "\n" + e.client_id;
    const was = best.get(key);
    if (!was || r > was.r) best.set(key, { e, r });
  }
  const since = (e) => (typeof e.since === "string" ? e.since : "");
  tpx.record = [...best.values()].map((x) => x.e)
    .sort((a, b) => (since(a) < since(b) ? -1 : since(a) > since(b) ? 1 : 0));
  return { list: tpx.record, seq };
}

// What one read says to the ticket's broker (`broker` and `generation` as
// they were when it was asked: a switch meanwhile drops it). A request this
// page has out, or whose own answer came after the read was asked, is this
// page's own to say: the read does not touch it.
function tpxApplyHeld(read, broker, generation) {
  if (tpb.broker !== broker || tpb.generation !== generation) return;
  const { list, seq } = read;
  const own = (cid) => !!tpx.mine && tpx.mine.has(cid) && tpx.mine.get(cid) >= seq;
  const mine = list.filter((e) => e.broker === broker);
  const listed = new Set(mine.map((e) => e.client_id));
  // a request held that the record listed and lists no longer: gone
  for (const h of tpxHeldFor(broker)) {
    const cid = h.body.client_id;
    if (own(cid)) continue;
    if (listed.has(cid)) h.seen = true;
    else if (h.seen) tpx.held = tpx.held.filter((x) => x !== h);
  }
  // what is held now first, the answers last: an answer's words then stay on
  // the line, with what is still held after them (tpxSay)
  const answers = [];
  for (const e of mine) {
    if (own(e.client_id)) continue;
    const st = e.state == null ? "unknown" : e.state;
    const h = tpxHeldFor(broker).find((x) => x.body.client_id === e.client_id);
    if (st === "answered") {
      if (h && h.waiting) answers.push([h, e]);
      continue;
    }
    if (h && (st === "out") === !!h.waiting) continue;      // held as it is
    const got = tpxRestoreHeld(e, broker);
    if (!got) continue;
    got.seen = true;
    if (st === "out") { got.waiting = true; got.mine = !!tpx.mine && tpx.mine.has(e.client_id); }
    tpxHold(got);
  }
  for (const [h, e] of answers) tpxAnswered(h, e);
  tpxRenderAgain();
}

// A request held as waiting, answered (the record's "answered"): no longer
// held, and its answer said as this page says its own: the answer's words
// when it has any (without a code word in front), else what was carried out
// in the page's own words ("closed 1000 of EUR_USD"), and a refusal without
// words by its status; in the ok style when it was carried out, the error
// style when it was not. Then the account is read again.
function tpxAnswered(h, e) {
  tpxHeldDone(h.body.client_id);
  const words = e.detail == null ? "" : tpbPlainReason(String(e.detail).replace(/\s+/g, " ").trim());
  const ok = typeof e.ok === "boolean" ? e.ok : Number(e.status) >= 200 && Number(e.status) < 300;
  if (ok) tpxSay(words || tpxAnsweredText(h), "ok");
  else tpxSay(words || String(e.status == null ? "" : e.status), "err");
  tpxRefreshAccount(); tpxRefreshPositions();
  if (h.kind === "pending" || h.kind === "cancel") tpxRefreshOrders();
}

// A request carried out, in this page's own words for it: as it says a
// request restored from the record and asked again (acdCloseFull,
// acdCancelOrder, tpxPlacePending), and an order at market by what it asked.
function tpxAnsweredText(h) {
  const b = h.body || {};
  if (h.kind === "order") return `${b.side} ${b.qty} ${b.symbol} placed`;
  if (h.kind === "pending") return `${b.side} ${b.type} ${b.qty} @ ${acdPxLine(b.symbol, b.price)} placed`;
  if (h.kind === "close") {
    const what = tpxHeldSymbol(h) || String(b.position_id);
    return b.qty != null ? `closed ${b.qty} of ${what}` : `closed ${what}`;
  }
  const o = h.order || acdHeldOrder(h);
  return o && o.side ? `${o.side} ${o.otype} @ ${o.price == null ? "" : acdPx(o.symbol, o.price)} cancelled`
    : `order ${b.order_id} cancelled`;
}

// The ticket's line said again as it stands, when what it names has changed:
// its answer (what tpxSay said last), then whatever is held now. A line of
// the ticket's own making ("placing…", "connecting…") is left as it is.
function tpxResay() {
  const m = $("tpx-msg");
  if (!m || (!tpx.lineSaid && m.textContent)) return;
  const a = tpx.lineAnswer;
  tpxSay(a ? a[0] : "", a ? a[1] : "");
}

// Every request held, or out, on the brokers `want` accepts, oldest first
// ("since"): the page's holds; the record's entries out or unknown that the
// page neither holds nor says itself (its own requests on their way, or
// answered after the record's last read was asked); and, with `inFlight`,
// this page's own requests on their way.
function tpxHeldItems(want, inFlight) {
  const items = (tpx.held || []).filter((h) => want(h.broker));
  const have = new Set(items.map((h) => h.broker + "\n" + h.body.client_id));
  const seq = tpx.heldApplied || 0;
  for (const e of tpx.record || []) {
    const st = e.state == null ? "unknown" : e.state;
    if ((st !== "out" && st !== "unknown") || !want(e.broker)) continue;
    const key = e.broker + "\n" + e.client_id;
    if (have.has(key) || (!!tpx.mine && tpx.mine.has(e.client_id) && tpx.mine.get(e.client_id) >= seq)) continue;
    const h = tpxRestoreHeld(e, e.broker);
    if (!h) continue;
    if (st === "out") { h.waiting = true; h.mine = !!tpx.mine && tpx.mine.has(e.client_id); }
    have.add(key);
    items.push(h);
  }
  if (inFlight) {
    for (const s of (tpx.sending || new Map()).values()) {
      if (want(s.broker)) items.push({ ...s, waiting: true, mine: true });
    }
  }
  const since = (h) => String(h.since || "");
  return items.map((h, i) => [h, i])
    .sort((x, y) => (since(x[0]) < since(y[0]) ? -1 : since(x[0]) > since(y[0]) ? 1 : x[1] - y[1]))
    .map((x) => x[0]);
}

// The request the ticket's line names when nothing is held on its broker:
// the latest held or out on another broker, connected or not, or null. One
// of a connected broker is offered Show; one of a broker that is not
// connected (after an engine restart nothing is) is offered Connect
// (tpxRenderAgain).
function tpxHeldElse() {
  const items = tpxHeldItems((b) => b !== tpb.broker, false);
  return items.length ? items[items.length - 1] : null;
}

function tpxConnected(broker) {
  return (brokerPicker.rows || []).some((b) => b.broker === broker && b.connected);
}

// Whether the 5 s account tick reads the record again: while its last answer
// listed anything out or unknown for a connected broker, or the page holds
// anything.
function tpxHeldWatch() {
  if ((tpx.held || []).length) return true;
  return (tpx.record || []).some((e) => (e.state == null || e.state === "out" || e.state === "unknown")
                                        && tpxConnected(e.broker));
}

// A request of this page's on its way (acdSend, tpxPlacePending, tpbOrder):
// the record's "out" for it is this page's own, said by its own answer, not
// held as waiting. What it returns is called when its answer (or no answer
// at all) is in; a read asked after that is the record's to say.
function tpxSending(kind, body, about) {
  const cid = body && body.client_id;
  if (!cid) return () => {};
  if (!tpx.sending) tpx.sending = new Map();
  if (!tpx.mine) tpx.mine = new Map();
  tpx.sending.set(cid, { kind, broker: body.broker, body: { ...body }, ...(about || {}), since: tpxNow() });
  tpx.mine.set(cid, Infinity);
  return () => {
    tpx.sending.delete(cid);
    tpx.mine.set(cid, tpx.heldSeq || 0);
  };
}

// Now, as the record writes it: ISO-8601 UTC to the second.
function tpxNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// "Show": the ticket pointed at the broker whose held request the line names
// (tpxHeldElse); that broker's connect then holds it as usual (tpbSwitch).
async function tpxShowBroker() {
  const h = tpxHeldFor(tpb.broker).length ? null : tpxHeldElse();
  // a broker that is not connected is connected by Connect, which asks what
  // its card asks first (tpxConnectHeld), never by pointing the ticket at it
  if (!h || !tpxConnected(h.broker)) return;
  const sel = $("tpx-broker");
  if (sel) sel.value = h.broker;
  await tpbSwitch(h.broker);
}

/* Ask again refused by the engine because the broker's profile is now bound
   to another account than the one the request went out on (409
   held_other_account; the record keeps each request's account): the
   engine's words, which name both accounts, in the error style, the request
   still held after them, and "Switch back" (tpxSwitchBack). True when that
   was the answer. */
function tpxOtherAccount(h, status, res) {
  const detail = res && res.detail;
  const code = (res && res.code) || (detail && typeof detail === "object" ? detail.code : null);
  if (status !== 409 || code !== "held_other_account" || !h) return false;
  const rec = (tpx.record || []).find((e) => e && e.broker === h.broker && e.client_id === h.body.client_id);
  const account = h.account || (rec && typeof rec.account === "string" && rec.account ? rec.account : null)
    || (res && typeof res.account === "string" && res.account ? res.account : null);
  tpx.otherAccount = { broker: h.broker, client_id: h.body.client_id, account };
  const words = oneLine(typeof detail === "string" ? detail : (detail && detail.detail) || "");
  tpxSay(tpbPlainReason(words || "This request went out on another account of this broker."), "err");
  return true;
}

/* "Switch back": the broker's profile put back on the account the held
   request went out on, with confirm (the user has just chosen it), and the
   ticket on it; its connect holds the request again, and Ask again then
   works as usual. */
async function tpxSwitchBack() {
  const o = tpx.otherAccount;
  if (!o || !o.account || o.broker !== tpb.broker || tpx.placing) return;
  tpxPlacing(true);
  try {
    const r = await fetch("/api/broker/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker: o.broker, account_id: o.account, confirm: true }),
    });
    const res = await readResult(r);
    if (!r.ok) {
      tpxSay(tpbPlainReason(oneLine(typeof res.detail === "string" ? res.detail : r.status)), "err");
      return;
    }
    tpx.otherAccount = null;
    if (res.connected) {
      const sel = $("tpx-broker");
      if (sel) sel.value = o.broker;
      await tpbSwitch(o.broker);
    } else {
      tpxSay("", "");
    }
  } catch (e) {
    tpxSay(tpbPlainReason(String((e && e.message) || e)), "err");
  } finally {
    tpxPlacing(false);
    tpxRenderAgain();
    const screen = $("conn-screen");
    if (screen && !screen.classList.contains("hidden") && typeof refreshConnScreen === "function") refreshConnScreen();
  }
}

/* "Connect": the broker whose held request the line names is not connected
   (tpxHeldElse; after an engine restart nothing is). It is connected as its
   card's Connect does, through csConnect and pickBroker: the live-money
   question where its card asks it, the ticket put on it, and its connect
   holds the request again with Ask again (tpbSwitch and
   tpxLoadHeld). Its saved keys are used; a box with no saved value cannot be
   typed here, so its card is opened instead and nothing is sent. A refusal
   is said on the line in the broker's words (tpbSwitch) and on its card. */
async function tpxConnectHeld() {
  const h = tpxHeldFor(tpb.broker).length ? null : tpxHeldElse();
  if (!h || tpxConnected(h.broker)) return;
  const hub = (brokerPicker.rows || []).find((b) => b.broker === h.broker);
  const fields = (hub && Array.isArray(hub.credential_form) ? hub.credential_form : [])
    .filter((f) => f && f.key && f.type !== "none");
  const stored = hub && Array.isArray(hub.stored_credentials) ? new Set(hub.stored_credentials) : null;
  if (!hub || (stored && fields.some((f) => !stored.has(f.key)))) {
    connScreen.broker = h.broker;
    connScreen.brokerPinned = true;
    openConnScreen();
    return;
  }
  tpxPlacing(true);
  try {
    const out = await csConnect(h.broker, hub, {}, stored);
    if (out && out.ok === false) {
      connScreen.errors[h.broker] = { message: String(out.error || "the broker did not connect") };
    } else {
      delete connScreen.errors[h.broker];
      // with no LSE key, MARKETS follows to that broker's own source when
      // the boot put it on another for this (marketsBootSource)
      if (typeof marketsBootSource === "function") marketsBootSource();
    }
  } catch (e) {
    connScreen.errors[h.broker] = { message: String((e && e.message) || e) };
    tpxSay(tpbPlainReason(String((e && e.message) || e)), "err");
  } finally {
    tpxPlacing(false);
  }
}

/* Before a Disconnect, an Unlink or a Forget of a broker with anything out or
   held on it: "<the held sentence> Disconnect anyway?" ("Unlink anyway?",
   "Forget anyway?"), the sentence of its latest request, with "<verb>" and
   "Not now". The record is read first, so what is asked about is current.
   True when nothing is out or held there, or on a yes. */
async function tpxHeldAsk(broker, verb, yes) {
  const items = await tpxHeldOn(broker);
  if (!items.length) return true;
  return askConfirm(`${tpxHeldText(items[items.length - 1])} ${verb} anyway?`, yes || verb, "Not now");
}

// Everything out or held on one broker, oldest first, the record read first
// so what is asked about is current; this page's own requests on their way
// count. [] on the hosted terminal, which holds no broker connection.
async function tpxHeldOn(broker) {
  if (state.hosted) return [];
  await tpxLoadHeld(tpb.broker);
  return tpxHeldItems((b) => b === broker, true);
}

// One entry of the engine's record as the page holds a request whose answer
// was just lost; null when it is not a request of this connection's.
function tpxRestoreHeld(e, broker) {
  const routes = { "/api/broker/order": ["order", "order"], "/api/broker/order/pending": ["pending", "resting"],
                   "/api/broker/order/cancel": ["cancel", "cancel"], "/api/broker/close": ["close", "close"] };
  const k = e && typeof e === "object" ? routes[e.route] : null;
  const req = k ? e.request : null;
  if (!k || e.what !== k[1] || !req || typeof req !== "object" || Array.isArray(req)
      || e.broker !== broker || req.broker !== broker
      || typeof req.client_id !== "string" || !req.client_id) return null;
  const kind = k[0];
  const run = {
    order: (h) => tpxOrder(h.side, h),
    pending: (h) => tpxPlacePending(h.side, h.body.type, h.body.price, h.body.qty, h),
    close: (h) => acdCloseFull(acdHeldPosition(h), h),
    cancel: (h) => acdCancelOrder(acdHeldOrder(h), h),
  }[kind];
  // its instrument: the one the engine kept with it, else what was sent
  const at = typeof e.instrument === "string" && e.instrument ? e.instrument
    : (req.symbol == null ? undefined : String(req.symbol));
  return { kind, broker, body: { ...req }, side: req.side, symbol: at,
           engine: false, words: e.detail == null ? "" : String(e.detail), run,
           since: typeof e.since === "string" ? e.since : "",
           // the record's code ("engine_stopped": the engine stopped before
           // the answer came, said in the record's own words, tpxHeldText),
           // and the account the profile was bound to when it went out (an
           // Ask again on another account is refused, tpxSwitchBack)
           code: typeof e.code === "string" ? e.code : null,
           account: typeof e.account === "string" && e.account ? e.account : null };
}

// ── The trade ticket, through brue-connect ─────────────────────────────────
// The ticket, prices, positions and account all come from a broker's adapter,
// terms included. Nothing here knows a broker by name: NovaFX (the bundled
// fake broker) exists exactly to keep this path generic.
//
// "lse-hosted" is the HOSTED relay (/api/sim/*), not a broker: the hosted
// web terminal cannot spawn a local adapter, so it keeps its own path. Every
// other value is a broker behind brue-connect, including our own demo
// account, which the downloaded app reaches as the `lse-sim` broker. The
// sentinel used to be the string "lse-sim" itself, which now names that
// broker: two different things wearing one name.
// `adopting` covers the boot window before tpbSetup has decided which broker
// this ticket opens on. The dock refreshers stand down during it: the old
// behaviour let the 5s sim poll paint the demo account's numbers a beat
// before adoption flipped the ticket to a broker, leaving a summary strip
// from one account over a table from another (the reported "frozen
// balance" bug).
const tpb = { broker: "lse-hosted", catalog: [], quotes: {}, timer: null,
              ticks: 0, adopting: false, generation: 0, quoteError: "", quoteLine: "" };

function tpbViaConnector() { return tpb.broker !== "lse-hosted"; }

// Brokers write the same instrument differently ("EURUSD", "EUR/USD",
// "EUR_USD"). One normaliser for every place that has to match a broker
// symbol against a chart symbol; stripping only "/" matched brokers who use
// it and nobody else.
function tpbBare(x) {
  return String(x || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

// The connected broker's declared capabilities (SPEC 3), from its status row.
// {} until connected or when the row is stale, which reads as "cannot",
// never as "can": a feature offered on a guess ends as a broker error.
function tpbCaps() {
  const row = (brokerPicker.rows || []).find((b) => b.broker === tpb.broker);
  return (row && row.capabilities) || {};
}

// The quote cache the dock should price against: the broker's own feed when
// the ticket trades through brue-connect (its symbols are the BROKER's
// spellings), the site feed otherwise. Marked at the closing side by every
// caller: bid exits a long, ask exits a short.
function dockQuote(sym) {
  if (tpbViaConnector()) return (tpb.quotes || {})[sym] || null;
  return (state.quotes || {})[sym] || null;
}

function tpbSpec() {
  const sym = $("tpx-bsym").value;
  return tpb.catalog.find((s) => s.symbol === sym) || null;
}

// The decimals the ticket's BROKER declares for one of its instruments, or
// null: the practice account, or a symbol its catalog does not hold. The
// lookup is rebuilt when the catalog is replaced (a venue holds thousands of
// rows and the dock repaints every second).
function tpbDigits(symbol) {
  if (!tpbViaConnector()) return null;
  if (tpb.digitsOf !== tpb.catalog) {
    tpb.digitsMap = new Map((tpb.catalog || []).map((s) => [s.symbol, s.digits]));
    tpb.digitsOf = tpb.catalog;
  }
  const d = tpb.digitsMap.get(symbol);
  return Number.isInteger(d) && d >= 0 && d <= 20 ? d : null;
}
// A price in the dock, in History and in the ticket's messages: from the
// broker's digits (fmtPx) when the ticket trades through a connector and the
// catalog declares them, by magnitude (fmt) otherwise, at the places the
// instrument's current quote's size gives (quoteScale), so Avg and Price of
// one position read alike. fmt alone printed a 73154.662 fill as "73154.7"
// beside a message that said 73154.662.
function acdPx(symbol, p) {
  const d = tpbDigits(symbol);
  const by = quoteScale(dockQuote(symbol));
  return d == null ? fmt(p, by) : fmtPx(p, d, by);
}
// A price in a line that says an order was placed or filled: every place the
// broker declares for the instrument (toFixed(digits)), with no cut by size,
// so the line reads the level as it was sent or filled; an instrument that
// declares none is printed as the dock prints it (acdPx).
function acdPxLine(symbol, p) {
  const d = tpbDigits(symbol);
  const n = Number(p);
  return d == null || p == null || p === "" || !isFinite(n) ? acdPx(symbol, p) : n.toFixed(d);
}

async function tpbSetup() {
  const sel = $("tpx-broker");
  sel.innerHTML = "";
  const mk = (v, label) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label; sel.appendChild(o);
  };
  // Refreshers stand down until the adoption decision below has been made,
  // so the dock's first paint is the ticket's actual account rather than
  // whichever path answered first (see the tpb declaration).
  tpb.adopting = true;
  let switched = false, first = null;
  const firstGeneration = tpb.generation;
  try {
    // The hosted relay is offered ONLY where it is the only option. In the
    // downloaded app the same account is reached as a broker, through the
    // protocol, so there is one trading path in the code that matters.
    if (state.hosted) mk("lse-hosted", "LSE Demo (hosted)");
    try {
      const r = await fetch("/api/broker/list");
      if (r.ok) {
        // Same source as the connection picker, so the ticket and the top-left
        // call every broker by the name the broker itself gave.
        brokerPicker.rows = await r.json();
        for (const b of brokerPicker.rows) mk(b.broker, brokerDisplayName(b));
      }
    } catch (e) { /* hub unavailable: sim-only ticket */ }
    sel.onchange = () => tpbSwitch(sel.value);
    $("tpx-bsym").onchange = () => tpbInstrumentChanged();
    // The engine's record of this window's requests (tpxLoadHeld), read
    // before the ticket chooses its broker: a request still out, or whose
    // answer was lost, decides where it opens.
    if (!state.hosted) first = await tpxFetchHeld();
    // Adopt a connection the ENGINE already holds. Connections live in the
    // engine, not in this page, so a reload used to leave a broker connected
    // (and, for a live one, armed) with the ticket quietly showing LSE Demo.
    // A connection nobody can see is the worst state this panel can be in.
    // What this ticket opens on, decided explicitly rather than left to the
    // dropdown's first option. Removing the hosted row in the downloaded app
    // made the select show "Paper" while the ticket was still wired to the
    // hosted relay: the panel said one thing and traded another.
    const has = (name) => brokerPicker.rows.some((b) => b.broker === name);
    let want = tpb.broker;
    if (tpb.broker === "lse-hosted" && !state.hosted) {
      const connected = (n) => brokerPicker.rows.some((b) => b.broker === n && b.connected);
      // (1) a connected broker with a request out or held in the record,
      // the oldest first: the first connected row (the built-in simulator)
      // left a held request of another broker unseen after a reload;
      const held = ((first && first.list) || []).find((e) => (e.state == null || e.state === "out"
        || e.state === "unknown") && connected(e.broker));
      // (2) else the broker the ticket was on before the reload, while it is
      // still connected (the page works without the store);
      let before = null;
      try { before = localStorage.getItem("lse.ticket.broker"); } catch (e) { before = null; }
      const live = brokerPicker.rows.find((b) => b.connected);
      // (3) else an already-open connection, else our demo account when the
      // user has a key for it, else the built-in simulator, which needs
      // nothing at all. `ready` comes from the engine, which knows whether a
      // broker's prerequisites are met. Reading a UI flag here was an
      // ordering bug: this runs before the boot fetch that sets it, so the
      // key always looked absent.
      const ready = (n) => brokerPicker.rows.some((b) => b.broker === n && b.ready);
      want = (held && held.broker)
        || (before && connected(before) ? before : null)
        || (live && live.broker)
        || (ready("lse-sim") ? "lse-sim" : null)
        || (has("paper") ? "paper" : tpb.broker);
    }
    if (want !== tpb.broker) {
      sel.value = want;
      tpb.adopting = false; // the decision is made; tpbSwitch repaints
      switched = true;
      await tpbSwitch(want);
    } else if ([...sel.options].some((o) => o.value === tpb.broker)) {
      sel.value = tpb.broker;
    }
  } finally {
    if (tpb.adopting) {
      // No switch happened (hosted terminal, or the ticket keeps its
      // broker): repaint once now that refreshers are live again.
      tpb.adopting = false;
      tpxRefreshAccount(); tpxRefreshPositions();
    }
  }
  renderConnBar();
  // Requests whose answer was lost, or is still to come, before this page
  // loaded: the record read above, said for the ticket's broker (a switch
  // above read it again, after its connect).
  if (!switched && first) {
    tpxApplyHeld(first, tpb.broker, firstGeneration);
    tpxResay();
  }
  // With no LSE key, a request out or held puts MARKETS on the ticket
  // broker's own source, so the ticket and its line are on screen.
  marketsBootSource();
}

function tpbStop() {
  tpb.generation++;
  tpb.quotes = {};
  tpb.quoteError = "";
  tpb.quoteLine = "";
  if (tpb.timer) { clearInterval(tpb.timer); tpb.timer = null; }
}

/* The venue's own data source, when the engine registered one for it (a broker
   that serves bars + history; an order-entry-only FIX session has none). This
   is the name that puts the venue's whole catalog in the sidebar, which is the
   list the ticket sends the user to instead of carrying a dropdown of its own. */
function tpbSourceName() {
  if (!tpbViaConnector()) return "";
  const name = "broker:" + tpb.broker;
  return (state.providers || []).some((p) => p.name === name) ? name : "";
}

/* Put the sidebar on the venue the ticket trades, so its pairs are browsed the
   way every other pair list is: folders per asset class, revealed in chunks as
   you scroll, live prices, click to chart. Called from the ticket's instrument
   row. */
function tpbBrowseVenue() {
  const src = tpbSourceName();
  if (!src) return;                       // no source: the select is still shown
  if (state.provider === src) return;
  enterLiveSource(src);
}

/* The instrument dropdown carries the venue's whole catalog and stays on for
   every connected broker. It is the quick switch that leaves the chart
   where it is; the
   sidebar list the instrument row opens is the browse surface. Two ways in,
   deliberately, because they answer different questions. */
function tpbSyncBsymVisibility() {
  const bs = $("tpx-bsym");
  if (!bs) return;
  bs.classList.toggle("hidden", !tpbViaConnector());
  const row = $("tpx-symrow");
  if (row) {
    const browsable = !!tpbSourceName() && state.provider !== tpbSourceName();
    row.classList.toggle("tpx-browse", browsable);
    row.title = browsable
      ? "Browse this venue's pairs in the sidebar"
      : "";
  }
}

/* ── margin for the order in the box ────────────────────────────────────────
   What the typed size would lock up, what would be left, and how much of the
   account is committed once it is open. Every input is
   the VENUE's: contract size and margin rate off its own instrument terms, its
   own live price, its own account figures. Nothing here assumes a house
   convention, because the same rate means different money on a 100,000-unit FX
   lot, a 100-ounce metal contract and a 1-share equity CFD. */

/* The ONLY rate this ticket may use: the broker's own, arriving as
   `tick_value_account` (SPEC 4), which states one tick's value per contract in
   the ACCOUNT's currency next to `tick_value` in the instrument's. Their ratio
   is the broker's conversion for this instrument, at the rate it actually
   charges the client.

   SPEC 2 is explicit that the platform never derives this: it must not cross
   the venue's own tradable FX pair, because a broker's conversion rate and its
   quoted pair are allowed to differ, and a near-miss presented as the broker's
   number is worse than an honest foreign-currency one. An earlier version of
   this function did exactly that (mid of the venue's USDJPY-style pair) and
   was wrong by contract, not merely imprecise. Null here means "this venue did
   not say", and the caller then reports margin in the instrument's currency
   and names it. */
function tpbAccountFactor(spec) {
  if (!spec) return null;
  const tv = Number(spec.tick_value);
  const tva = Number(spec.tick_value_account);
  if (!(tv > 0) || !(tva > 0)) return null;
  return tva / tv;
}

/* The rate that applies to THIS notional. Brokers may step margin by position
   size (SPEC 4 `margin_tiers`: [{above_notional, margin_rate}]), so a flat
   read of `margin_rate` understates a large order on a tiered venue. */
function tpbMarginRate(spec, notional) {
  let rate = Number(spec.margin_rate);
  const tiers = Array.isArray(spec.margin_tiers) ? spec.margin_tiers : null;
  if (!tiers) return rate;
  for (const t of tiers.slice().sort(
    (a, b) => Number(a.above_notional || 0) - Number(b.above_notional || 0))) {
    if (notional >= Number(t.above_notional || 0) && Number(t.margin_rate) > 0) {
      rate = Number(t.margin_rate);
    }
  }
  return rate;
}

function tpxRenderMargin() {
  const box = $("tpx-margin");
  if (!box) return;
  const off = () => box.classList.add("hidden");
  // The hosted relay states no instrument terms, so there is nothing to
  // compute from; an empty block beats a made-up one.
  if (!tpbViaConnector()) return off();
  const spec = tpbSpec();
  const acct = tpx.acct || {};
  const qty = parseFloat($("tpx-qty").value);
  if (!spec || !(qty > 0)) return off();
  const csize = spec.contract_size == null ? 1 : Number(spec.contract_size);
  const q = dockQuote(spec.symbol);
  // Priced at the ask: the side is not chosen until the button is pressed, and
  // the dearer side is the one that must fit.
  const px = q && q.ask != null ? Number(q.ask)
    : (q && q.bid != null ? Number(q.bid) : null);
  if (!(csize > 0) || !(px > 0)) return off();
  box.classList.remove("hidden");

  const iccy = spec.quote_ccy || "";
  const accy = acct.currency || "";
  // Same currency needs no conversion; otherwise only the broker's own factor
  // will do (SPEC 2: the broker converts, the platform never does). fx null
  // means the venue never published one, so every money figure below stays in
  // the instrument's currency and says so.
  const fx = (!iccy || !accy || iccy === accy) ? 1 : tpbAccountFactor(spec);
  const conv = fx == null ? 1 : fx;
  const shown = fx == null ? iccy : (accy || iccy);
  // acdMoney puts the currency mark first, so a negative through it reads
  // "$-18,295"; the sign belongs in front of the money, not inside it.
  const money = (v) => (v < 0 ? "-" : "") + acdMoney(Math.abs(v) * conv, shown);
  box.title = fx == null
    ? `Figures in ${iccy}; this venue publishes no ${accy} conversion for this `
      + "instrument (tick_value_account), and we do not invent one"
    : "";

  // The size is named in the venue's own unit, because "quantity" is not a
  // word anyone deals in: a contract of many units is LOTS, a single-unit
  // equity is SHARES, anything else is UNITS.
  const cls = String(spec.asset_class || "").toLowerCase();
  const unit = csize > 1 ? "LOT"
    : (cls === "stock" || cls === "equity" || cls === "etf" ? "SHARE" : "UNIT");
  $("tpx-qtylab").textContent = unit + "S";
  $("tpx-unitlab").textContent = "1 " + unit;
  // What one of them IS: the contract's own units when the venue names a base
  // currency (1 lot = 100,000 EUR), otherwise what one costs.
  $("tpx-unit").textContent = spec.base_ccy
    ? Number(csize).toLocaleString(undefined, { maximumFractionDigits: 8 })
      + " " + spec.base_ccy
    : money(csize * px);

  const notional = qty * csize * px;             // in the instrument's quote ccy
  $("tpx-notional").textContent = money(notional);
  // One tick_size move, at this size, in money: the venue states it per
  // contract (tick_value), so the order's exposure per tick is that times the
  // size. Not derived from tick_size when the venue omits it: cross-currency
  // contracts break that identity, which is why the field exists.
  const tv = Number(spec.tick_value);
  $("tpx-tickval").textContent = tv > 0 ? money(tv * qty) : "–";

  const rate = tpbMarginRate(spec, notional);
  const req = notional * rate;                   // in the instrument's quote ccy
  if (!(rate > 0)) {
    // A venue that states no margin rate gets no margin figure invented for it.
    $("tpx-mreq").textContent = "–";
    $("tpx-mfree").textContent = "–";
    $("tpx-mused").textContent = "–";
    $("tpx-mfree").classList.remove("tpx-short");
    return;
  }
  $("tpx-mreq").textContent = money(req);
  // The account lines are account money. Without the broker's own rate they
  // cannot be stated at all: a yen account's free margin is yen, and the
  // margin above is not yen until the broker says what its rate is.
  if (fx == null) {
    $("tpx-mfree").textContent = "–";
    $("tpx-mused").textContent = "–";
    $("tpx-mfree").classList.remove("tpx-short");
    return;
  }
  const reqAcct = req * fx;
  const free = acct.free_margin;
  $("tpx-mfree").textContent = free == null ? "–"
    : (free - reqAcct < 0 ? "-" : "") + acdMoney(Math.abs(free - reqAcct), accy);
  const used = acct.used_margin, eq = acct.equity;
  $("tpx-mused").textContent = (eq > 0 && used != null)
    ? (((Number(used) + reqAcct) / Number(eq)) * 100).toFixed(1) + "%"
    : "–";
  // Not enough margin is a fact the ticket should state before the order is
  // sent, not after the broker refuses it.
  $("tpx-mfree").classList.toggle("tpx-short", free != null && free - reqAcct < 0);
}

/* Chart and ticket in step: an explicit pick (a sidebar row, the search box,
   the screener, a position's "show on chart") is how you choose what to
   trade, so the ticket follows the chart rather than sitting on whatever it
   was left on (which is how one screenshot showed US500 in the ticket under a
   EUR/JPY chart). Every source counts, not only the venue's own list:
   charting BTC/USD from the LSE sidebar once left the ticket on EUR/JPY,
   because this used to fire only on "broker:<venue>". The
   broker's spelling of the picked symbol is found the way tpbSwitch finds it
   at connect time (separators stripped: "EUR/USD" is "EURUSD" is "EUR_USD");
   an instrument this venue does not list leaves the ticket where it is,
   since there is nothing to trade it with. */
function tpbFollowChart(symbol) {
  if (!tpbViaConnector()) return;
  const bs = $("tpx-bsym");
  if (!bs) return;
  const want = tpbBare(symbol);
  if (!want || tpbBare(bs.value) === want) return;
  const hit = [...bs.options].find((o) => tpbBare(o.value) === want);
  if (!hit) return;
  bs.value = hit.value;
  tpbInstrumentChanged();
}

/* One routine for "the ticket now shows another instrument", whichever hand
   moved it (the dropdown or the chart): price it, show it, and drop the
   previous instrument's verdict from the message line. That line used to
   survive the switch, so a JPY refusal sat under a BTC/USD ticket as if it
   were about BTC/USD. */
function tpbInstrumentChanged() {
  // (A request still held is about the account, not the instrument: its
  // warning stays, tpxSay.)
  tpxSay("", "");
  tpbSubscribe(); tpbUpdateQuote(); tpbRefreshPositions();
}

/* Price the ticket and every open position using the broker's exact symbols.
   The dock marks positions from this cache too; subscribing only the chart
   left every other held instrument blank. The connector deduplicates these
   requests, so the positions poll can safely retry after a failed request. */
async function tpbSubscribe() {
  if (!tpbViaConnector()) return;
  const broker = tpb.broker, generation = tpb.generation;
  const signature = () => JSON.stringify([...new Set([$("tpx-bsym").value,
    ...(tpx.positions || []).map((p) => p.symbol)].filter(Boolean))]);
  const active = tpb.subscribeTask;
  if (active && active.broker === broker && active.generation === generation) {
    if (active.signature !== signature()) active.again = true;
    return active.promise;
  }
  const task = { broker, generation, signature: signature(), again: false };
  tpb.subscribeTask = task;
  task.promise = (async () => {
    do {
      task.again = false; task.signature = signature();
      await tpbSubscribeOnce(broker, generation);
    } while (task.again && tpb.broker === broker && tpb.generation === generation);
  })().finally(() => { if (tpb.subscribeTask === task) tpb.subscribeTask = null; });
  return task.promise;
}

async function tpbSubscribeOnce(broker, generation) {
  if (!tpbViaConnector() || tpb.broker !== broker || tpb.generation !== generation) return;
  const symbols = [...new Set([$("tpx-bsym").value,
    ...(tpx.positions || []).map((p) => p.symbol)].filter(Boolean))];
  if (!symbols.length) return;
  const current = () => tpb.broker === broker && tpb.generation === generation;
  // Said as every later line is (tpxSay): a request still held keeps its
  // warning, and its words, after the error. The line as said is kept, so
  // the recovery below clears only that line, not a later answer.
  const showError = (reason) => {
    if (!current()) return;
    // the reason whole, on one line, in words (tpbPlainReason)
    tpb.quoteError = "Prices unavailable: " + tpbPlainReason(String(reason).replace(/\s+/g, " ").trim());
    tpxSay(tpb.quoteError, "err");
    tpb.quoteLine = $("tpx-msg").textContent;
  };
  try {
    const r = await fetch("/api/broker/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker, symbols }),
    });
    const result = await r.json();
    if (!current()) return;
    if (!r.ok) { showError(result.detail || r.status); return; }
    if (result.refused && result.refused.length) {
      showError(result.refused.join(", ") + " (broker subscription limit; reconnect to reset)");
      return;
    }
    if (tpb.quoteError && $("tpx-msg").textContent === tpb.quoteLine) tpxSay("", "");
    tpb.quoteError = "";
    tpb.quoteLine = "";
  } catch (e) { showError("connection failed; retrying"); }
}

// A broker mid-login (SPEC 1.6 interactive auth): the engine spawned the
// adapter, the adapter waits on its loopback, and the user must finish the
// broker's OWN login page in a real browser. This opens that page (the
// engine runs on the user's machine, so the backend webbrowser.open lands on
// their default browser; window.open is the fallback, which the desktop
// shell routes to the external browser too) and then polls connect until the
// login lands. Connect doubles as the poll on the engine side: it never
// re-begins an attempt that is still fresh.
async function tpbAwaitBrokerLogin(broker) {
  let opened = null;
  try {
    // Opening the user's browser is the ENGINE's job and can be slow (or on
    // a headless host, hang). It must never hold up the poll that follows,
    // so it gets a deadline of its own.
    const ctl = new AbortController();
    const bail = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch("/api/broker/auth/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker }), signal: ctl.signal,
    });
    clearTimeout(bail);
    if (r.ok) opened = await r.json();
  } catch (e) { /* the poll below still carries the flow */ }
  if (opened && opened.url && !opened.opened) window.open(opened.url);
  // (through tpxSay: the wait can be minutes, and a held request's warning
  // stays after it)
  tpxSay("finish the login in your browser…");
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2500));
    const r = await fetch("/api/broker/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.status);
    const st = await r.json();
    if (st.connected) return st;
    if (st.needs_account) {
      // Logged in, and now the broker wants to know WHICH account. That
      // answer lives on the connections screen, so stop waiting and let the
      // caller repaint it. Waiting for `connected` here meant the chooser
      // was never reached: the loop span the full five minutes while the
      // question sat unasked.
      tpxSay("choose an account");
      return st;
    }
  }
  throw new Error("the broker login was not completed; connect again to retry");
}

async function tpbSwitch(broker) {
  tpbStop();
  tpb.broker = broker;
  // a refusal for another account was about the connection before this one
  // (Switch back goes through here too)
  tpx.otherAccount = null;
  // kept for the page loaded next (tpbSetup's (2)); the hosted relay is not a
  // broker to come back to. The page works without the store.
  if (broker !== "lse-hosted") {
    try { localStorage.setItem("lse.ticket.broker", broker); } catch (e) { /* no store: nothing kept */ }
  }
  tpxRenderAgain();   // a held request belongs to its own broker
  // The dock must never show one account's table under another account's
  // name while the switch is in flight; blank it with the reason.
  acdReset(tpbViaConnector() ? "connecting…" : "");
  tpbSyncBsymVisibility();
  if (!tpbViaConnector()) {
    // back to the hosted sim: restore the normal panel immediately
    tpxRefreshAccount(); tpxRefreshPositions(); tpxUpdateQuote();
    // a request still held on the broker the ticket left (a Disconnect
    // answered "anyway") is said again, named by that broker, with Connect
    tpxResay();
    renderConnBar();
    if (tpx.sync) tpx.sync();
    return { ok: true };
  }
  tpxSetMsg("connecting…");
  try {
    let r = await fetch("/api/broker/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broker }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || r.status);
    let st0 = await r.json();
    if (st0.auth_pending) st0 = await tpbAwaitBrokerLogin(broker) || st0;
    // What this broker's requests the engine still holds unanswered (a
    // window reloaded since, or one before it): said again from here on.
    await tpxLoadHeld(broker);
    if (st0.needs_account) {
      // No session until an account is picked, so there is no catalog to
      // read and nothing to subscribe to yet. (A held request's warning
      // stays after it, tpxSay.)
      tpxSay("choose an account in Connections");
      renderConnBar();
      return { ok: true, needsAccount: true };
    }
    r = await fetch(`/api/broker/catalog?broker=${encodeURIComponent(broker)}`);
    if (!r.ok) throw new Error("catalog unavailable");
    tpb.catalog = await r.json();
    const bs = $("tpx-bsym");
    bs.innerHTML = "";
    // Preselect the broker's spelling of the charted symbol. Brokers write the
    // same instrument differently ("EURUSD", "EUR/USD", "EUR_USD"), so the
    // comparison strips the separators rather than assuming one house style;
    // stripping only "/" matched brokers who use it and nobody else.
    const bare = (x) => String(x || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const want = bare(state.symbol);
    for (const s of tpb.catalog) {
      const o = document.createElement("option");
      o.value = s.symbol; o.textContent = s.symbol;
      if (bare(s.symbol) === want) o.selected = true;
      bs.appendChild(o);
    }
    tpxSay("", "");   // a request of this broker still held is said again
    // Connecting is what registers the venue as a data source, so the ticket
    // cannot know whether the sidebar can list its pairs until the provider
    // list is re-read. Without this the dropdown stayed visible on the first
    // connect and only corrected on the next repaint.
    try { await refreshProviders(); } catch (e) { /* keep the dropdown */ }
    tpbSyncBsymVisibility();
    tpb.ticks = 0;
    await tpbSubscribe();
    // 1s quote poll; account/positions ride every 5th tick. The hub cache
    // is fed by the adapter's event stream, this only reads it.
    tpb.timer = setInterval(async () => {
      if (!tpbViaConnector()) { tpbStop(); return; }
      const quoteBroker = tpb.broker, quoteGeneration = tpb.generation;
      try {
        const q = await fetch(`/api/broker/quotes?broker=${encodeURIComponent(quoteBroker)}`);
        if (q.ok) {
          const quotes = await q.json();
          if (tpb.broker !== quoteBroker || tpb.generation !== quoteGeneration) return;
          tpb.quotes = quotes; tpbUpdateQuote();
          if (tpx.dockTab === "pos") acdRenderPositions(tpx.positions || []);
        }
      } catch (e) { /* transient */ }
      if (tpb.ticks++ % 5 === 0) {
        tpbRefreshAccount(); tpbRefreshPositions();
        // the engine's record, while anything in it is out or held
        // (tpxHeldWatch): an answer that comes is said, a request that
        // goes is let go
        if (tpxHeldWatch()) tpxLoadHeld(tpb.broker);
      }
    }, 1000);
    tpbRefreshAccount(); tpbRefreshPositions(); tpbUpdateQuote();
    // the top-left now names this broker; refresh the list so it uses the
    // broker's own display name and its live instrument count
    try {
      const bl = await fetch("/api/broker/list");
      if (bl.ok) brokerPicker.rows = await bl.json();
    } catch (e2) { /* the slug is a fine fallback */ }
    renderConnBar();
    if (tpx.sync) tpx.sync();   // a connected broker shows the ticket (see sync)
    return { ok: true };
  } catch (e) {
    // The broker's refusal whole and in words, here as on the card that
    // asked: the protocol's code word in front ("unauthorized: ") is
    // dropped as the card drops it (tpbPlainReason). The caller still gets
    // the engine's detail as it was.
    const why = String(e.message || e);
    tpxSay(tpbPlainReason(why), "err");
    // No silent fallback to the hosted relay. Two trading paths that swap
    // under a failure is how a bug in one hides behind the other; the user
    // sees which broker refused and picks again. Hosted terminals have only
    // the relay, so there is nothing to fall back FROM there.
    if (state.hosted) {
      $("tpx-broker").value = "lse-hosted";
      tpbSwitch("lse-hosted");
    }
    // The reason goes back to whoever asked as well. The ticket line above
    // sits behind the Connections screen, so a card that pressed Connect and
    // got nothing back showed no error and a button that stayed disabled.
    try {
      const bl = await fetch("/api/broker/list");
      if (bl.ok) brokerPicker.rows = await bl.json();
    } catch (e2) { /* the caller still has the reason */ }
    if (tpx.sync) tpx.sync();
    return { ok: false, error: why };
  }
}

function tpbUpdateQuote() {
  const spec = tpbSpec();
  $("tpx-sym").textContent = spec ? spec.symbol : "–";
  $("tpx-name").textContent = spec && spec.name ? spec.name : "";
  tpxSetLogo(spec ? spec.symbol : "", spec && spec.name);
  const q = spec ? tpb.quotes[spec.symbol] : null;
  if (!q || q.bid == null) {
    $("tpx-bid").textContent = $("tpx-ask").textContent = "–";
    $("tpx-spread").textContent = "–";
    tpxRenderMargin();   // unpriced instrument: the block hides itself
    return;
  }
  // Declared digits: the chart's rule (fmtPx), the three numbers at one
  // size's places, so BUY and SELL read alike (toFixed(d) alone padded a
  // nine-digit venue to "73100.500000000"). None declared: at most five
  // decimals, trailing zeros trimmed down to two, as before.
  const d = spec && Number.isInteger(spec.digits) && spec.digits >= 0 && spec.digits <= 20 ? spec.digits : null;
  const by = Math.max(Math.abs(Number(q.bid)), Math.abs(Number(q.ask == null ? q.bid : q.ask)));
  const px = (v) => {
    if (d != null) return fmtPx(v, d, by);
    const s = fmtPx(v, 5, 1);
    return s.replace(/(\.\d\d\d*?)0+$/, "$1");
  };
  $("tpx-bid").textContent = px(q.bid);
  $("tpx-ask").textContent = px(q.ask);
  $("tpx-spread").textContent = px(q.ask - q.bid);
  // Margin moves with the price, so it is repainted on the same tick.
  tpxRenderMargin();
}

async function tpbRefreshAccount() {
  const broker = tpb.broker, generation = tpb.generation;
  try {
    const r = await fetch(`/api/broker/account?broker=${encodeURIComponent(broker)}`);
    if (!r.ok) return;
    const a = await r.json();
    if (tpb.broker !== broker || tpb.generation !== generation) return;
    const label = $("tpx-broker").selectedOptions[0];
    const name = a.label || (label ? label.textContent : tpb.broker);
    $("tpx-acct-name").textContent = name;
    $("tpx-equity").textContent = acdMoney(a.equity, a.currency);
    // Normalise the SPEC account.get shape into the ONE account object the
    // rest of the page reads (the dock summary, the AI snapshot). Before
    // this the dock was fed only by the sim path, so on the broker path it
    // kept whatever paint it last got, which is the reported frozen-balance
    // bug. Open P&L is equity minus balance, the
    // broker's own floating figure; account.get carries no leverage, and a
    // dash is the honest render for a number the broker never said.
    tpx.acct = {
      id: a.account_id != null ? a.account_id : "broker:" + tpb.broker,
      name, currency: a.currency || null,
      balance: a.balance, equity: a.equity,
      unrealized_pnl: (a.equity != null && a.balance != null)
        ? a.equity - a.balance : null,
      used_margin: a.margin_used, free_margin: a.margin_free,
      leverage: null,
    };
    acdRenderSummary();
    // Free margin and the used percentage are account figures; repaint the
    // ticket's margin block whenever they land, not only on a price tick.
    tpxRenderMargin();
  } catch (e) { /* transient */ }
}

async function tpbRefreshPositions() {
  const broker = tpb.broker, generation = tpb.generation;
  try {
    const r = await fetch(`/api/broker/positions?broker=${encodeURIComponent(broker)}`);
    if (!r.ok) return;
    const raw = await r.json();
    if (tpb.broker !== broker || tpb.generation !== generation) return;
    // Normalise SPEC positions (side + unsigned qty, sl/tp, position_id,
    // epoch-ms opened_at) into the sim shape (signed qty, sl_price/tp_price,
    // id, ISO opened_at) so the dock table, the chart lines and the AI
    // snapshot read ONE shape wherever the trade lives. position_id is kept
    // verbatim for the close/modify calls; SPEC says never assume it is
    // numeric or distinct from order ids.
    const poss = raw.map((p) => ({
      id: p.position_id,
      position_id: p.position_id,
      symbol: p.symbol,
      qty: p.side === "sell" ? -Math.abs(p.qty) : Math.abs(p.qty),
      avg_price: p.avg_price,
      sl_price: p.sl == null ? null : p.sl,
      tp_price: p.tp == null ? null : p.tp,
      // A stop the broker trails (SPEC 4): its level moves with the price.
      trail_points: p.trail_points || 0,
      unrealized_pnl: p.unrealized_pnl == null ? null : p.unrealized_pnl,
      opened_at: typeof p.opened_at === "number"
        ? new Date(p.opened_at).toISOString() : (p.opened_at || null),
    }));
    // Ticket rows removed here too: the dock is the one
    // positions surface; see the same note in tpxRefreshPositions.
    tpx.positions = poss;
    tpbSubscribe();
    acdPushChartLines();
    if (tpx.dockTab === "pos") acdRenderPositions(poss);
    else if (tpx.dockTab === "hist") acdRenderHistory();
    // dockTab "ord" repaints on its own poll; stomping it here would blank
    // the Orders table every 5 seconds
  } catch (e) { /* transient */ }
}

async function tpbOrder(side, again, fresh) {
  let body;
  if (again) {
    // Asked again: exactly what was sent, under the same client_id.
    body = { ...again.body };
  } else if (fresh) {
    // "Place as new" (tpxPlaceNew): what was sent, under a client_id of its
    // own, after the question it asked.
    body = { ...fresh, client_id: tpxNewClientId("") };
  } else {
    const spec = tpbSpec();
    if (!spec) { tpxSay("no broker symbol", "err"); return; }
    const qty = parseFloat($("tpx-qty").value);
    if (!(qty > 0)) { tpxSay("qty must be > 0", "err"); return; }
    body = { broker: tpb.broker, symbol: spec.symbol, side, qty };
    const sl = parseFloat($("tpx-sl").value), tp = parseFloat($("tpx-tp").value);
    if (sl > 0) body.sl = sl;
    if (tp > 0) body.tp = tp;
    // The same order pressed again while an earlier one's outcome is not
    // known is asked again under that one's client_id: it cannot be placed
    // twice. Any other request on its instrument meanwhile, an order at
    // market or resting, a close or a cancel, is placed only on a yes
    // (tpxHeldGate).
    const go = await tpxHeldGate("order", body, "", "Place it", body.symbol);
    if (!go) return;
    body = go.body;
    again = go.again;
  }
  const hold = (res, engine) => tpxHold({ kind: "order", broker: body.broker,
    body: { ...body, client_id: (res && res.client_id) || body.client_id },
    side: body.side, symbol: body.symbol, engine: !!engine, words: res && res.detail,
    stillUnknown: !!again && !engine,
    run: (h) => tpxOrder(h.side, h) });
  tpxSetMsg(again ? "asking again…" : "placing…");
  let r, res;
  const answered = tpxSending("order", body, { side: body.side, symbol: body.symbol });
  try {
    r = await fetch("/api/broker/order", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    res = await readResult(r);
  } catch (e) {
    // No answer from the engine at all: the order may have reached the broker.
    answered();
    hold({ detail: String(e.message || e) }, true);
    return;
  }
  answered();
  if (r.status === 403) {
    // The engine refused because this broker is real money and this
    // session was never allowed to trade it (SPEC 3). Shown whole, in the
    // engine's own words, with where to change it: cut at 80 characters
    // it read "…has not been armed. Cal" and told nobody what to do.
    tpxSay(tpbNotArmedText(res.detail), "err");
    return;
  }
  // Settled: answered, or refused by the broker for good. Anything else
  // leaves the outcome of an order asked about again as unknown as it was.
  const settled = r.ok || (r.status === 400 && !res.retryable);
  if (!settled && res.unknown) {
    hold(res, false);
    tpbRefreshPositions();
    return;
  }
  // asked again on another account than its own: Switch back (tpxOtherAccount)
  if (again && tpxOtherAccount(again, r.status, res)) return;
  if (!settled && again) {
    tpxSay(tpbPlainReason(res.detail || r.status), "err");
    return;
  }
  // What was sent under this client_id is known now. The broker's reason is
  // shown whole.
  tpxHeldDone(body.client_id);
  if (!r.ok) {
    tpxSay(tpbPlainReason(res.detail || r.status), "err");
    return;
  }
  const said = res.status === "filled"
    ? `${body.side} ${body.qty} ${body.symbol} filled @ ${res.fill && res.fill.price != null ? acdPxLine(body.symbol, res.fill.price) : ""}`
    : res.status + (res.reason ? ": " + res.reason : "");
  tpxSay((again ? "Asked again: " : "") + said, res.status === "filled" ? "ok" : "err");
  tpbRefreshAccount(); tpbRefreshPositions();
}

/* The engine's refusal of an order on an unarmed live broker, for the ticket.
   Its sentence is kept; the tail the connector writes for a programmer
   ("Call arm(reason) first.") is replaced by where a person does that. */
function tpbNotArmedText(detail) {
  // The detail leads with the connector's code word ("not_armed: ..."),
  // machine vocabulary the ticket drops everywhere else too (tpbPlainReason).
  const said = tpbPlainReason(detail || "this broker has not been armed for trading")
    .replace(/\s*Call arm\(reason\) first\.?\s*$/, "").replace(/[.\s]+$/, "");
  return `${said}. Allow trading for it in Connections.`;
}

/* A broker refusal reaches the ticket as "<code>: <message>" (the connector's
   error string leads with its protocol code word). The code word is machine
   vocabulary; the message already says it in words, so the ticket shows the
   words: "market_closed: market closed" reads "market closed". Only a single
   lowercase code-shaped token (the SPEC 6 set is all lowercase snake_case)
   followed by a colon is dropped, so a message that simply contains a colon
   ("no fx cross for JPY: this instrument ...") keeps its own text intact. */
function tpbPlainReason(text) {
  const t = String(text || "");
  const m = t.match(/^[a-z][a-z0-9_]*:\s+(\S.*)$/s);
  return m ? m[1] : t;
}

function setupTradePanel() {
  $("tpx-buy").onclick = (ev) => { if (tpxOnePress(ev)) tpxOrder("buy"); };
  $("tpx-sell").onclick = (ev) => { if (tpxOnePress(ev)) tpxOrder("sell"); };
  // Asks the broker again about a request whose answer was lost, under its
  // own client_id (tpxHold): answered from the broker's record, never twice.
  $("tpx-again").onclick = (ev) => { if (tpxOnePress(ev)) tpxAskAgain(); };
  // Places that order again as a new one, after a yes, once asking again
  // was answered that its fate is still not known (tpxPlaceNew).
  $("tpx-new").onclick = (ev) => { if (tpxOnePress(ev)) tpxPlaceNew(); };
  // Points the ticket at the broker whose held request the line names, which
  // then holds it as its own (tpxShowBroker).
  $("tpx-show").onclick = (ev) => { if (tpxOnePress(ev)) tpxShowBroker(); };
  // Connects the broker, not connected, whose held request the line names,
  // as its card's Connect does; that holds it again (tpxConnectHeld).
  $("tpx-conn").onclick = (ev) => { if (tpxOnePress(ev)) tpxConnectHeld(); };
  // Switches the broker back to the account a request went out on, when
  // Ask again was refused for another account (tpxSwitchBack).
  $("tpx-back").onclick = (ev) => { if (tpxOnePress(ev)) tpxSwitchBack(); };
  // One account door, not two. The ticket's own broker
  // select is hidden; the account line reports what the top-left connection
  // is bound to and opens that same screen to change it, so there is one
  // place where the key and the account are chosen.
  $("tpx-acct").onclick = () => openConnScreen();
  // The ticket's instrument line opens the venue's own pair list in the
  // sidebar. No-op when the sidebar already shows it, or
  // when the venue serves no candles and keeps its dropdown.
  $("tpx-symrow").onclick = () => tpbBrowseVenue();
  // Margin is a function of the size in the box, so it answers to typing
  // rather than waiting for the next price tick.
  $("tpx-qty").addEventListener("input", () => tpxRenderMargin());
  tpbSetup();
  // Dock height: drag the top edge, remembered per browser. Mouse-only on
  // purpose: the desktop app has no touch surface.
  const dock = $("acct-dock");
  try {
    const h = parseInt(localStorage.getItem("lset-acd-h"), 10);
    if (h >= 96) dock.style.height = h + "px";
  } catch (e) { /* storage disabled */ }
  $("acd-resize").onmousedown = (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = dock.getBoundingClientRect().height;
    const move = (ev) => {
      const h = Math.min(window.innerHeight * 0.6, Math.max(96, startH + (startY - ev.clientY)));
      dock.style.height = h + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try { localStorage.setItem("lset-acd-h", String(Math.round(dock.getBoundingClientRect().height))); } catch (e2) { /* best effort */ }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  $("acd-tab-pos").onclick = () => {
    tpx.dockTab = "pos";
    $("acd-tab-pos").classList.add("active");
    $("acd-tab-hist").classList.remove("active");
    $("acd-tab-ord").classList.remove("active");
    tpxRefreshPositions();
  };
  $("acd-tab-ord").onclick = () => acdShowOrdersTab();
  $("acd-tab-hist").onclick = () => {
    tpx.dockTab = "hist";
    $("acd-tab-hist").classList.add("active");
    $("acd-tab-pos").classList.remove("active");
    $("acd-tab-ord").classList.remove("active");
    acdRenderHistory();
  };
  // MARKETS > PRICE & CHARTS shows the ticket; every other surface hides it.
  // The rail check alone is not enough: OPTIONS/NEWS/SCREENER live under the
  // same MARKETS rail but are not trading surfaces, and the ticket floating
  // over the news globe looked like a leak. The charts
  // section's own visibility is the one signal every sub-page already
  // maintains, so gate on it rather than tracking sub-tab state separately.
  const sync = () => {
    // no ticket (and no account probing) before a live key is configured:
    // the login screen would otherwise log 401s on every visit.
    // A CONNECTED BROKER counts too. Someone who links their own broker and
    // has no LSE key could chart it and then had no ticket to trade it from:
    // the panel was gated on the key alone. Through a broker the ticket reads
    // that broker's account, so there is no keyless call to refuse.
    const viaBroker = tpbViaConnector() && (brokerPicker.rows || []).some(
      (b) => b.broker === tpb.broker && b.connected);
    const markets = $("rail-markets").classList.contains("active")
      && (!!state.lseConfigured || viaBroker)
      && !$("charts").classList.contains("hidden");
    $("trade-panel").classList.toggle("hidden", !markets);
    $("rw-stack").classList.toggle("hidden", !markets);
    $("acct-dock").classList.toggle("hidden", !markets);
    if (markets && !tpx.timer) {
      tpxRefreshAccount(); tpxRefreshPositions(); tpxUpdateQuote();
      tpx.timer = setInterval(() => {
        tpxRefreshAccount(); tpxRefreshPositions();
        // resting orders only repaint while their tab is showing; a working
        // order elsewhere is still re-fetched on tab entry and placement
        if (tpx.dockTab === "ord") tpxRefreshOrders();
      }, 5000);
    } else if (!markets && tpx.timer) {
      clearInterval(tpx.timer); tpx.timer = null;
    }
    // Widget refresh runs only while the stack is on screen; the guard
    // inside rwSetActive covers the first sync() call, which lands before
    // the widget section below this function has evaluated.
    rwSetActive(markets);
  };
  for (const id of ["rail-markets", "rail-backtest", "rail-mydata", "rail-econ", "rail-ml", "rail-workspace", "rail-research", "rail-guide"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => setTimeout(sync, 0));
  }
  // Sub-tab clicks (PRICE & CHARTS / OPTIONS / NEWS / SCREENER) swap the
  // visible section without necessarily passing through a rail handler, so
  // observe the bar itself. Delegated: renderSubrail rebuilds the buttons.
  const subbar = document.getElementById("subrail");
  if (subbar) subbar.addEventListener("click", () => setTimeout(sync, 0));
  // Connecting or disconnecting a broker changes the answer too (tpbSwitch,
  // brokerDisconnect), and neither is a rail click.
  tpx.sync = sync;
  sync();

  // The ticket/assistant resize sash is gone:
  // the position rows it existed to contain moved to the dock,
  // and a remembered drag height kept pinning the ticket taller than its
  // content, leaving a dead band under the margin block. The ticket is
  // content-sized and not user-resizable. The remembered height is removed
  // on every machine that stored one, so no old pin ever reapplies.
  try { localStorage.removeItem("lset-ticket-h"); } catch (e) { /* storage disabled */ }
}
try { setupTradePanel(); } catch (e) { console.error("trade panel init", e); }
try { btBriefInit(); } catch (e) { console.error("strategy brief init", e); }

/* ── Rail widgets ───────────────────────────────────────────────────────
   The strip between the ticket sash and the assistant went empty once the
   position rows moved to the dock, so it now hosts an optional widget
   stack: news wire, economic calendar, options board, quotes. Every card
   reads a route the engine already serves (UI-only feature, no engine
   change), and the + picker offers a card only after its route answers
   something other than 404/405, so a frozen older engine never advertises
   a card it cannot fill (the notebooks-tab lesson). Choices,
   order and per-card settings persist as the railWidgets key of the shell
   workspace section (saveShellState carries it; the engine's SECTIONS list
   is frozen into shipped builds, so a new section name would 404 there).
   var (not const): sync() in setupTradePanel calls rwSetActive before this
   section evaluates, and a const here would put that call in the TDZ. */
var RW_DEFS = {
  news:   { title: "NEWS",     probe: "/api/news/feed",                 every: 120, single: true },
  econ:   { title: "CALENDAR", probe: "/api/economic-calendar?limit=1", every: 300, single: true },
  opts:   { title: "OPTIONS",  probe: "/api/options/underlyings",       every: 30,  single: true },
  quotes: { title: "QUOTES",   probe: null,                             every: 5,   single: false },
};
var rw = { list: [], avail: {}, timer: null, due: {}, undList: null,
           optExpiry: null, optSym: null, loaded: false, prev: {} };

// The list lives inside the shell workspace section (see saveShellState:
// the engine's section list is frozen, so no new section name works on
// shipped builds). One debounced writer covers both.
function rwSave() { saveShellState(); }

async function rwAvailable(type) {
  if (type in rw.avail) return rw.avail[type];
  const def = RW_DEFS[type];
  if (!def.probe) { rw.avail[type] = true; return true; }
  try {
    const r = await fetch(def.probe);
    // 409 is "no key yet" and 5xx is a bad moment: the route EXISTS in both
    // cases. Only the frozen-engine signatures rule a card out: an unrouted
    // GET falls through to StaticFiles as 404 (POST as 405).
    rw.avail[type] = r.status !== 404 && r.status !== 405;
  } catch (e) { rw.avail[type] = false; }
  return rw.avail[type];
}

function rwSetActive(on) {
  if (!rw) return; // first sync() lands before this section evaluates
  if (on && !rw.timer) {
    rw.timer = setInterval(() => rwTick(false), 3000);
    rwTick(true);
  } else if (!on && rw.timer) {
    clearInterval(rw.timer); rw.timer = null;
  }
}

async function rwTick(force) {
  if (!rw || !rw.loaded || document.hidden) return;
  const stack = $("rw-stack");
  if (!stack || (stack.classList.contains("hidden") && !force)) return;
  const now = Date.now();
  for (let i = 0; i < rw.list.length; i++) {
    const w = rw.list[i];
    const def = RW_DEFS[w.type];
    const body = document.getElementById("rw-body-" + i);
    if (!def || !body) continue;
    const key = w.type + ":" + i;
    // the options card repaints early when the charted symbol moves
    const symMoved = w.type === "opts" && rw.optSym !== state.symbol;
    if (!force && !symMoved && rw.due[key] && now < rw.due[key]) continue;
    rw.due[key] = now + def.every * 1000;
    try {
      if (w.type === "news") await rwPaintNews(body);
      else if (w.type === "econ") await rwPaintEcon(body);
      else if (w.type === "opts") await rwPaintOpts(body);
      else if (w.type === "quotes") {
        // Not awaited: its prices come with the terminal's next budgeted
        // call (up to three seconds off), and the cards after it must not
        // wait for that. One paint per card at a time.
        if (!rw.busy) rw.busy = new Set();
        if (!rw.busy.has(key)) {
          rw.busy.add(key);
          rwPaintQuotes(body, w).catch(() => {}).finally(() => rw.busy.delete(key));
        }
      }
    } catch (e) { /* transient; the next tick repaints */ }
  }
}

function rwRenderStack() {
  const host = $("rw-stack");
  if (!host) return;
  host.innerHTML = "";
  const bar = document.createElement("div");
  bar.id = "rw-add";
  const plus = document.createElement("button");
  plus.textContent = "+";
  plus.title = "Add a widget";
  // The click must PROPAGATE: the assistant's popovers (the instruction
  // files menu among them) dismiss on a document-level click, and an early
  // stopPropagation here left an open one stuck on screen when the + was
  // clicked. The picker itself is safe from its
  // own opening click because its away-listener arms on the NEXT mousedown.
  plus.onclick = () => rwOpenPicker();
  bar.appendChild(plus);
  host.appendChild(bar);
  rw.list.forEach((w, i) => {
    const def = RW_DEFS[w.type];
    if (!def) return;
    const card = document.createElement("div");
    card.className = "rw-card";
    const head = document.createElement("div");
    head.className = "rw-head";
    head.draggable = true;
    const title = document.createElement("span");
    title.className = "rw-title";
    title.textContent = def.title;
    head.appendChild(title);
    if (w.type === "quotes") {
      const edit = document.createElement("button");
      edit.className = "rw-edit";
      edit.textContent = "edit";
      edit.title = "Set the symbols";
      edit.onclick = () => rwQuotesEdit(card, w);
      head.appendChild(edit);
    }
    const x = document.createElement("button");
    x.className = "rw-x";
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = () => { rw.list.splice(i, 1); rwSave(); rwRenderStack(); };
    head.appendChild(x);
    // Reorder by dragging the title row onto another card.
    head.ondragstart = (e) => e.dataTransfer.setData("text/rw", String(i));
    card.ondragover = (e) => {
      if (e.dataTransfer.types.includes("text/rw")) e.preventDefault();
    };
    card.ondrop = (e) => {
      const from = parseInt(e.dataTransfer.getData("text/rw"), 10);
      if (isNaN(from) || from === i) return;
      const [m] = rw.list.splice(from, 1);
      rw.list.splice(i, 0, m);
      rwSave(); rwRenderStack();
    };
    const body = document.createElement("div");
    body.className = "rw-body";
    body.id = "rw-body-" + i;
    card.appendChild(head);
    card.appendChild(body);
    host.appendChild(card);
  });
  rw.due = {}; // everything repaints on the next tick
  rwTick(true);
}

async function rwOpenPicker() {
  const old = document.getElementById("rw-menu");
  if (old) { old.remove(); return; }
  const menu = document.createElement("div");
  menu.id = "rw-menu";
  for (const [type, def] of Object.entries(RW_DEFS)) {
    if (def.single && rw.list.some((w) => w.type === type)) continue;
    if (!(await rwAvailable(type))) continue;
    const b = document.createElement("button");
    b.textContent = def.title;
    b.onclick = () => {
      menu.remove();
      rw.list.push({ type, cfg: type === "quotes" ? { symbols: [] } : {} });
      rwSave(); rwRenderStack();
    };
    menu.appendChild(b);
  }
  if (!menu.children.length) {
    const d = document.createElement("div");
    d.className = "rw-none";
    d.textContent = "all widgets added";
    menu.appendChild(d);
  }
  $("rw-stack").appendChild(menu);
  // Outside click or Escape dismisses, like every other popover.
  const away = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", away);
    document.removeEventListener("keydown", esc);
  };
  document.addEventListener("mousedown", away);
  document.addEventListener("keydown", esc);
}

// The wire stamps seendate compactly (20260819T193000Z); Date.parse gets
// first shot in case the format is ever already ISO.
function rwAgo(s) {
  if (!s) return "";
  let t = Date.parse(s);
  if (isNaN(t)) {
    const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})/);
    if (m) t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  }
  if (isNaN(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return mins + "m";
  if (mins < 1440) return Math.round(mins / 60) + "h";
  return Math.round(mins / 1440) + "d";
}

async function rwPaintNews(body) {
  const r = await fetch("/api/news/feed");
  if (!r.ok) { body.textContent = "news feed unavailable"; return; }
  const doc = await r.json();
  const evs = (doc.events || []).slice(0, 12);
  if (!evs.length) { body.textContent = "no headlines"; return; }
  let h = "";
  for (const e of evs) {
    h += `<div class="rw-row rw-link" data-url="${newsEsc(e.url || "")}">`
       + `<span class="rw-dim">${newsEsc(rwAgo(e.seendate))}</span>`
       + `<span class="rw-grow">${newsEsc(e.headline || "")}</span></div>`;
  }
  body.innerHTML = h;
  for (const el of body.querySelectorAll(".rw-link")) {
    el.onclick = () => { if (el.dataset.url) window.open(el.dataset.url, "_blank"); };
  }
}

async function rwPaintEcon(body) {
  const d0 = new Date();
  const start = d0.toISOString().slice(0, 10);
  const end = new Date(d0.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const r = await fetch(`/api/economic-calendar?start=${start}&end=${end}&order=asc&limit=200`);
  if (r.status === 409) { body.textContent = "add your free LSE key to load the calendar"; return; }
  if (!r.ok) { body.textContent = "calendar unavailable"; return; }
  const rows = await r.json();
  const now = Date.now();
  // The releases just past stay visible above the queue: the number that
  // just dropped is usually the one being traded.
  const past = rows.filter((e) => Date.parse(e.datetime) < now).slice(-4);
  const next = rows.filter((e) => Date.parse(e.datetime) >= now).slice(0, 14);
  if (!past.length && !next.length) { body.textContent = "no events in range"; return; }
  let h = "";
  for (const e of past.concat(next)) {
    const done = Date.parse(e.datetime) < now;
    const t = new Date(e.datetime);
    const hh = String(t.getHours()).padStart(2, "0") + ":" +
               String(t.getMinutes()).padStart(2, "0");
    const day = t.toLocaleDateString(undefined, { weekday: "short" });
    h += `<div class="rw-row${done ? " rw-past" : ""}">`
       + `<span class="rw-dim">${day} ${hh}</span>`
       + `<span class="rw-tag">${newsEsc(e.region_code || "")}</span>`
       + `<span class="rw-grow">${newsEsc(e.event || "")}</span>`
       + `<span class="rw-num">${newsEsc(done ? (e.actual || "") : (e.consensus || e.forecast || ""))}</span>`
       + `</div>`;
  }
  body.innerHTML = h;
}

async function rwPaintOpts(body) {
  if (!rw.undList) {
    const r = await fetch("/api/options/underlyings");
    if (r.status === 409) { body.textContent = "add your free LSE key to load options"; return; }
    if (!r.ok) { body.textContent = "options unavailable"; return; }
    const l = await r.json();
    rw.undList = new Set((Array.isArray(l) ? l : []).map((u) =>
      String(u.symbol || u.underlying || u).toUpperCase()));
  }
  if (rw.optSym !== state.symbol) { rw.optSym = state.symbol; rw.optExpiry = null; }
  const sym = String(state.symbol || "").toUpperCase();
  if (!rw.undList.has(sym)) {
    body.textContent = `no options for ${state.symbol || "this symbol"}`;
    return;
  }
  if (!rw.optExpiry) {
    // One full-chain read to learn the nearest expiry; the poll then stays
    // on that expiry's slice, which is a fraction of the size.
    const r = await fetch(`/api/options/chain?underlying=${encodeURIComponent(sym)}&limit=5000`);
    if (!r.ok) { body.textContent = "chain unavailable"; return; }
    const all = await r.json();
    const fut = all.filter((c) => c.dte >= 0);
    if (!fut.length) { body.textContent = "no listed expiries"; return; }
    rw.optExpiry = fut.reduce((a, b) => (a.dte <= b.dte ? a : b)).expiry;
  }
  const r = await fetch(`/api/options/chain?underlying=${encodeURIComponent(sym)}` +
                        `&expiry=${encodeURIComponent(rw.optExpiry)}&limit=5000`);
  if (!r.ok) { body.textContent = "chain unavailable"; return; }
  const rows = await r.json();
  if (!rows.length) { rw.optExpiry = null; body.textContent = "no contracts"; return; }
  const px = rows[0].underlying_price;
  const byStrike = new Map();
  for (const c of rows) {
    const s = byStrike.get(c.strike) || {};
    s[c.contract_type === "call" ? "c" : "p"] = c;
    byStrike.set(c.strike, s);
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  let at = 0;
  for (let i = 1; i < strikes.length; i++) {
    if (Math.abs(strikes[i] - px) < Math.abs(strikes[at] - px)) at = i;
  }
  const lo = Math.max(0, at - 3);
  const pick = strikes.slice(lo, lo + 7);
  let h = `<div class="rw-orow rw-oh"><span class="c">CALL</span>` +
          `<span class="k">${newsEsc(sym)} ${newsEsc(rw.optExpiry)}</span>` +
          `<span class="p">PUT</span></div>`;
  for (const s of pick) {
    const g = byStrike.get(s);
    h += `<div class="rw-orow${s === strikes[at] ? " rw-atm" : ""}">`
       + `<span class="c">${g.c && g.c.last_price != null ? fmt(g.c.last_price) : ""}</span>`
       + `<span class="k">${fmt(s)}</span>`
       + `<span class="p">${g.p && g.p.last_price != null ? fmt(g.p.last_price) : ""}</span>`
       + `</div>`;
  }
  body.innerHTML = h;
}

async function rwPaintQuotes(body, w) {
  const syms = (w.cfg.symbols || []).filter(Boolean).slice(0, 20);
  if (!syms.length) { body.textContent = "no symbols set; click edit"; return; }
  // Through the price desk: the card's symbols ride the terminal's one
  // budgeted call (pollPrices) and never make one of their own.
  const rows = await priceDeskPrices("lse", syms);
  if (rows === null) { body.textContent = "quotes unavailable"; return; }
  const by = new Map(rows.map((q) => [q.symbol, q]));
  let h = "";
  for (const s of syms) {
    const q = by.get(s);
    const cls = q && rw.prev[s] != null
      ? (q.price >= rw.prev[s] ? " rw-up" : " rw-down") : "";
    if (q) rw.prev[s] = q.price;
    h += `<div class="rw-row"><span class="rw-grow">${newsEsc(s)}</span>`
       + `<span class="rw-num${cls}">${q && q.price != null ? fmt(q.price) : "–"}</span></div>`;
  }
  body.innerHTML = h;
}

function rwQuotesEdit(card, w) {
  const body = card.querySelector(".rw-body");
  body.innerHTML = "";
  const inp = document.createElement("input");
  inp.className = "rw-syminput";
  inp.value = (w.cfg.symbols || []).join(", ");
  inp.placeholder = "EUR/USD, NVDA, XAU/USD";
  inp.spellcheck = false;
  const done = () => {
    w.cfg.symbols = inp.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
    rwSave(); rwRenderStack();
  };
  inp.onkeydown = (e) => { if (e.key === "Enter") done(); };
  inp.onblur = done;
  body.appendChild(inp);
  inp.focus();
}

async function rwSetup() {
  try {
    const r = await fetch("/api/workspace/shell");
    const doc = r.ok ? await r.json() : null;
    const v = doc && doc.value;
    if (v && Array.isArray(v.railWidgets)) {
      // Only known types survive the load: a hand-edited file cannot break
      // the stack, same law as the shell's watchlist load.
      rw.list = v.railWidgets.filter((x) => x && RW_DEFS[x.type])
        .map((x) => ({ type: x.type, cfg: x.cfg && typeof x.cfg === "object" ? x.cfg : {} }));
    }
  } catch (e) { /* fresh machine: empty stack */ }
  rw.loaded = true;
  rwRenderStack();
  // sync() may have run its first pass before this section evaluated; if
  // the ticket is already on screen the refresh loop starts now.
  if (!$("trade-panel").classList.contains("hidden")) rwSetActive(true);
}
try { rwSetup(); } catch (e) { console.error("rail widgets init", e); }

/* ── Level 3 (MBO) rail: order-by-order flow + per-price aggregation ────────
   The toolbar button exists only when /api/mbo/status says the key's plan
   has MBO access AND the charted symbol maps to a recorded contract, so
   ordinary keys never see the feature at all. While open, the rail polls a
   short sliding window (the vault door is REST-only for now; a push stream
   is the planned upgrade) and derives everything client-side:
   - summary: event rate + added vs pulled liquidity per side
   - aggregation: NEW/CHANGE/DELETE size netted per price level
   - tape: the raw newest-first event list. */
const l3 = { avail: false, map: {}, open: false, timer: null, busy: false,
             // rolling event buffer feeding the stacking heatmap: each 4s
             // poll appends only unseen events (seq-gated), evicted at 60s
             buf: [], lastSeq: 0 };
const L3_HEAT_WINDOW_S = 60;

function l3ResetBuffer() { l3.buf = []; l3.lastSeq = 0; }

async function l3Init() {
  if (!state.lseConfigured) return;
  try {
    const r = await fetch("/api/mbo/status");
    const d = await r.json();
    l3.avail = !!d.available;
    l3.map = d.symbols || {};
  } catch (e) { l3.avail = false; }
  l3SyncButton();
}

function l3Contract() {
  return l3.map[(state.symbol || "").toUpperCase()] || null;
}

function l3SyncButton() {
  const markets = $("rail-markets").classList.contains("active") && !!state.lseConfigured;
  const ok = markets && l3.avail && !!l3Contract();
  $("l3-open").classList.toggle("hidden", !ok);
  if (!ok) { if (l3.open) l3Close(); return; }
  // symbol switched while open: retarget the poll to the new contract
  if (l3.open && $("l3-contract").textContent !== l3Contract()) {
    $("l3-contract").textContent = l3Contract();
    l3ResetBuffer();
    l3Poll();
  }
}

function l3Open() {
  l3.open = true;
  l3ResetBuffer();
  $("l3-rail").classList.remove("hidden");
  $("l3-contract").textContent = l3Contract() || "";
  $("l3-heat").innerHTML = "";
  $("l3-tape").innerHTML = '<div id="l3-empty">Loading order flow&hellip;</div>';
  l3Poll();
  if (!l3.timer) l3.timer = setInterval(l3Poll, 2000);
}

function l3Close() {
  l3.open = false;
  $("l3-rail").classList.add("hidden");
  if (l3.timer) { clearInterval(l3.timer); l3.timer = null; }
}

async function l3Poll() {
  if (!l3.open || l3.busy || document.hidden) return;
  const sym = state.symbol;
  if (!l3Contract()) return;
  l3.busy = true;
  try {
    const r = await fetch(`/api/mbo/events?symbol=${encodeURIComponent(sym)}&seconds=4`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (l3.open && sym === state.symbol) l3Render(d);
  } catch (e) {
    if (l3.open) $("l3-tape").innerHTML =
      `<div id="l3-empty">Order flow unavailable: ${String(e.message || e)}</div>`;
  } finally { l3.busy = false; }
}

function l3Render(d) {
  const ev = d.events || [];
  const win = Math.max(1, new Date(d.end) - new Date(d.start)) / 1000;
  $("l3-win").textContent = `· last ${Math.round(win)}s`;
  // ── stacking heatmap: merge this poll into the rolling buffer ──
  // Polls overlap (4s window every 2s), so gate on the exchange sequence
  // number. A max seq far BELOW the watermark means the recorder restarted
  // and renumbered: start the buffer over rather than dropping everything.
  const fresh = ev.filter((e) => e.seq > l3.lastSeq);
  if (ev.length && !fresh.length && ev[ev.length - 1].seq < l3.lastSeq / 2) l3ResetBuffer();
  for (const e of ev) if (e.seq > l3.lastSeq) l3.buf.push(e);
  if (l3.buf.length) {
    l3.lastSeq = Math.max(l3.lastSeq, l3.buf[l3.buf.length - 1].seq);
    const cutoff = l3.buf[l3.buf.length - 1].ts - L3_HEAT_WINDOW_S;
    while (l3.buf.length && l3.buf[0].ts < cutoff) l3.buf.shift();
  }
  // Net resting size accumulated per price over the buffer: adds minus
  // pulls; only levels where size actually stuck (net > 0) are "stacked".
  const stack = new Map();
  for (const e of l3.buf) {
    if (e.price == null) continue;
    let s = stack.get(e.price);
    if (!s) { s = { net: 0, buy: 0, sell: 0 }; stack.set(e.price, s); }
    if (e.type === "NEW") s.net += e.size || 0;
    else if (e.type === "DELETE") s.net -= e.size || 0;
    (e.side === "BUY") ? (s.buy += 1) : (s.sell += 1);
  }
  const spanS = l3.buf.length
    ? Math.max(1, Math.round(l3.buf[l3.buf.length - 1].ts - l3.buf[0].ts)) : 0;
  $("l3-heat-win").textContent = spanS ? `· last ${spanS}s` : "";
  // ── the ladder: bucket scattered ticks into clean price zones ──
  // Nice-step bucketing (span/16 snapped up) turns the raw tick list into
  // readable zones; the old per-tick aggregation table folded into this.
  const pos = [...stack.entries()].filter(([, s]) => s.net > 0);
  if (!pos.length) {
    $("l3-heat").innerHTML =
      '<div id="l3-empty">No stacked size yet. Building the window&hellip;</div>';
  } else {
    // span from the middle 80% of levels: an hour-old drifted price at the
    // window edge must not force coarse buckets on the active zone
    const prices = pos.map(([p]) => p).sort((a, b) => a - b);
    const lo = prices[Math.floor(prices.length * 0.1)];
    const hi = prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.9))];
    const span = Math.max(hi - lo, prices[prices.length - 1] * 1e-5);
    const NICE = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500];
    const step = NICE.find((n) => span / n <= 13) || 1000;
    const buckets = new Map();
    for (const [p, s] of pos) {
      const b = Math.round(p / step) * step;
      let t = buckets.get(b);
      if (!t) { t = { net: 0, buy: 0, sell: 0 }; buckets.set(b, t); }
      t.net += s.net; t.buy += s.buy; t.sell += s.sell;
    }
    // live quote when we have one, else the newest order price in the
    // buffer: order activity tracks the market tick-for-tick, so the split
    // stays centered even before the quote feed warms up
    let quote = state.prices[state.symbol];
    if (quote == null) {
      for (let i = l3.buf.length - 1; i >= 0; i--) {
        if (l3.buf[i].price != null) { quote = l3.buf[i].price; break; }
      }
    }
    const all = [...buckets.entries()].sort((a, b) => b[0] - a[0]); // high->low
    // split at the live quote: asks above, bids at/below; keep the 8 zones
    // nearest the quote on each side so the ladder centers on the market
    const asks = quote != null ? all.filter(([p]) => p > quote).slice(-8) : [];
    const bids = quote != null ? all.filter(([p]) => p <= quote).slice(0, 8)
                               : all.slice(0, 14);
    const shown = [...asks, ...bids];
    const maxNet = Math.max(...shown.map(([, s]) => s.net), 1);
    const row = ([p, s], side) => {
      const cls = side || (s.buy >= s.sell ? "buy" : "sell");
      const w = Math.max(6, Math.round((s.net / maxNet) * 100));
      return `<div class="l3h-row"><span class="l3h-price">${String(+p.toFixed(4))}</span>` +
        `<span class="l3h-track"><span class="l3h-bar ${cls}" style="display:block;width:${w}%"></span></span>` +
        `<span class="l3h-size">${s.net}</span></div>`;
    };
    $("l3-heat").innerHTML =
      asks.map((x) => row(x, "sell")).join("") +
      (quote != null
        ? `<div class="l3h-mid"><span class="lbl">last</span><span>${fmt(quote)}</span></div>`
        : "") +
      bids.map((x) => row(x, quote != null ? "buy" : null)).join("");
  }
  if (!ev.length) {
    $("l3-tape").innerHTML =
      '<div id="l3-empty">No order events in the window. Market closed or quiet.</div>';
    return;
  }
  // ── tape: compact, newest first; glyphs instead of words ──
  const GLYPH = { NEW: "+", DELETE: "−", CHANGE: "~" };
  $("l3-tape").innerHTML = "<table>" + ev.slice(-25).reverse().map((e) => {
    const t = new Date(e.ts * 1000);
    const hh = t.toTimeString().slice(3, 8) + "." +
      String(t.getMilliseconds()).padStart(3, "0");
    const cls = e.side === "BUY" ? "l3-buy" : "l3-sell";
    return `<tr><td>${hh}</td><td class="l3-glyph">${GLYPH[e.type] || "?"}</td>` +
      `<td>${e.size}</td><td class="${cls}">${e.price ?? ""}</td></tr>`;
  }).join("") + "</table>";
}

try {
  $("l3-open").onclick = () => (l3.open ? l3Close() : l3Open());
  $("l3-close").onclick = l3Close;
  // same rail-tab observation pattern as the trade panel: MARKETS only
  for (const id of ["rail-markets", "rail-backtest", "rail-mydata", "rail-econ", "rail-ml", "rail-workspace", "rail-research", "rail-guide"]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => setTimeout(l3SyncButton, 0));
  }
  // No l3Init() here: it runs from the boot sequence once /api/config has
  // told us whether a key exists, and again after key entry.
} catch (e) { console.error("level3 rail init", e); }

/* ── sidebar fold: the watchlist column collapses to a slim strip ───────── */
function setSideCollapsed(on) {
  $("side").classList.toggle("collapsed", on);
  try { localStorage.setItem("lset-side-collapsed", on ? "1" : "0"); } catch (e) { /* best effort */ }
}
try {
  $("side-fold").onclick = () => setSideCollapsed(true);
  $("side-expand").onclick = () => setSideCollapsed(false);
  if (localStorage.getItem("lset-side-collapsed") === "1") setSideCollapsed(true);
} catch (e) { console.error("sidebar fold init", e); }

/* ── dock minimiser: fold the account dock to its summary strip ─────────── */
function setDockMin(on) {
  $("acct-dock").classList.toggle("min", on);
  const b = $("acd-min");
  b.innerHTML = on ? "&#9652;" : "&#9662;";
  b.title = on ? "Restore the positions table" : "Minimise to the summary strip";
  try { localStorage.setItem("lset-acd-min", on ? "1" : "0"); } catch (e) { /* best effort */ }
}
try {
  $("acd-min").onclick = () => setDockMin(!$("acct-dock").classList.contains("min"));
  if (localStorage.getItem("lset-acd-min") === "1") setDockMin(true);
} catch (e) { console.error("dock minimiser init", e); }

/* screen layout: reverted; superseded by the site's grid component (port in progress) */

/* mount the site's Layout picker into the top bar once the chart bundle is up */
(function mountLayoutBtn() {
  const el = document.getElementById("sl-slot");
  if (!el) return;
  if (window.LSEChart && typeof window.LSEChart.mountLayoutButton === "function") {
    try { window.LSEChart.mountLayoutButton(el); } catch (e) { console.error("layout button", e); }
    // Title follows the selected pane: re-derive it whenever the layout,
    // selection, or a pane's symbol changes.
    try { window.LSEChart.layoutStore.subscribe(() => { try { updateWindowTitle(); } catch (e) { /* pre-init */ } }); } catch (e) { /* bundle without layoutStore */ }
  } else {
    setTimeout(mountLayoutBtn, 250);
  }
})();

// The help panel's code template renders through the same tokenizer as the
// editors, so the reference reads as real code, not a grey slab (part of
// the ed-help redesign).
for (const el of document.querySelectorAll(".ed-help-code")) {
  el.innerHTML = pyTokenHTML(el.textContent);
}

/* ---------- MARKETS > SCREENER -----------------------------------------
   One sortable, filterable, virtualized table over the /api/screener
   snapshot (the engine's LSE provider revalidates upstream with ETag, so
   polling here is nearly free). Design rules that keep it glitch-free:
   rows render only for the visible window (~40 of 4.2k), row DOM is keyed
   by symbol and text nodes update in place, and the sort order NEVER
   changes under the user: re-sorting happens only on a header click or
   when a refresh lands while the pointer is outside the table. */
const scrState = {
  rows: [],            // raw snapshot rows
  columns: [],         // server manifest
  view: "overview",    // active column preset
  cls: "",             // asset-class filter ("" = all)
  q: "",               // symbol/name filter
  sort: { col: "dollar_volume", dir: -1 },
  matched: [],         // every row passing the class/search filter, sorted
  shown: [],           // the current page of `matched`: what the table lists
  page: 0,             // zero-based page index into `matched`
  timer: null,
  hover: false,        // pointer inside table: defer re-sorts
  pendingRows: null,   // refresh that arrived while hovering
  inited: false,
};

/* One page of rows. The table is paged rather than one 4.2k-row scroll:
   the virtualizer kept the DOM small either way, but a
   list with no end is not a list anyone reads. Any filter, search, sort or
   view change sends the reader back to page 1, because the row under their
   cursor is not the same row after a re-sort. */
const SCR_PAGE_SIZE = 100;

/* Column presets: named views over the manifest. Columns missing from the
   payload (future server additions or removals) drop out automatically. */
const SCR_VIEWS = {
  overview:    ["price", "change_24h_pct", "change_1w_pct", "change_1m_pct",
                "volume_today", "rel_volume", "market_cap", "rsi_14",
                "week52_high_dist_pct", "next_event_name"],
  performance: ["price", "change_1h_pct", "change_24h_pct", "change_1w_pct",
                "change_1m_pct", "change_3m_pct", "change_ytd_pct",
                "change_1y_pct", "gap_pct", "move_percentile"],
  technicals:  ["price", "rsi_14", "atr_pct", "realized_vol_20d", "bb_pctb",
                "sma20_dist_pct", "sma50_dist_pct", "sma200_dist_pct",
                "corr_spx_60d", "corr_btc_60d", "beta_spx_1y"],
  fundamentals:["price", "market_cap", "sector", "pe_ratio", "dividend_yield",
                "profit_margin", "revenue_ttm", "revenue_growth_yoy",
                "days_to_earnings", "eps_surprise_last_pct"],
  options:     ["price", "change_24h_pct", "opt_volume", "opt_pc_ratio",
                "opt_net_premium", "opt_atm_iv", "opt_iv_rank", "opt_skew",
                "opt_front_expiry_dte", "opt_biggest_print", "opt_max_pain"],
  positioning: ["price", "change_1w_pct", "cot_net_noncomm", "cot_net_change_1w",
                "cot_pct_long", "insider_buys_90d", "insider_sells_90d",
                "insider_net_notional_90d", "news_count_24h"],
  events:      ["price", "change_24h_pct", "next_event_name", "next_event_at",
                "next_event_impact", "event_risk_score", "macro_surprise_30d",
                "event_move_avg_pct", "days_to_earnings"],
};
const SCR_ROW_H = 26;

function showScreenerPage() {
  subrailMark("sub-mk-screener");
  document.title = "Screener · LSE Terminal";
  // Full-page like OPTIONS/NEWS: the watchlist is chart context, hide it.
  $("side").classList.add("hidden");
  $("charts").classList.add("hidden");
  $("optpage").classList.add("hidden");
  $("news").classList.add("hidden");
  $("lse-connect").classList.add("hidden");
  $("scrpage").classList.remove("hidden");
  scrInit();
  scrRefresh(true);
  if (scrState.timer) clearInterval(scrState.timer);
  // 30s matches the server snapshot TTL; hidden tab pauses the poll.
  scrState.timer = setInterval(() => {
    if (!document.hidden && !$("scrpage").classList.contains("hidden")) {
      scrRefresh(false);
    }
  }, 30000);
}

function scrInit() {
  if (scrState.inited) return;
  scrState.inited = true;
  $("scr-search").addEventListener("input", () => {
    scrState.q = $("scr-search").value.trim().toUpperCase();
    scrState.page = 0;   // a new filter is a new list; start at its top
    scrApply();
  });
  $("scr-prev").onclick = () => scrGoPage(-1);
  $("scr-next").onclick = () => scrGoPage(1);
  const body = $("scr-body");
  body.addEventListener("scroll", () => scrPaint());
  body.addEventListener("mouseenter", () => { scrState.hover = true; });
  body.addEventListener("mouseleave", () => {
    scrState.hover = false;
    if (scrState.pendingRows) {
      scrState.rows = scrState.pendingRows;
      scrState.pendingRows = null;
      scrApply();
    }
  });
  // Row click opens the profile card; the chart jump
  // lives on the card's button so both affordances stay one click deep.
  $("scr-rows").addEventListener("click", (e) => {
    const sym = e.target.closest(".scr-row")?.dataset.sym;
    if (!sym) return;
    const row = scrState.rows.find((r) => r.symbol === sym);
    if (row) scrShowCard(row);
  });
  $("scr-card-close").onclick = scrHideCard;
  $("scr-card-back").addEventListener("click", (e) => {
    if (e.target === $("scr-card-back")) scrHideCard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("scr-card-back").classList.contains("hidden")) {
      scrHideCard();
    }
  });
  $("scr-card-chart").onclick = async () => {
    const sym = $("scr-card-back").dataset.sym;
    scrHideCard();
    $("rail-markets").click();
    if (!sym) return;
    // This called selectSymbol(), which has never existed in this shell (dead
    // since the screener shipped): the button switched tabs and left the chart
    // on whatever pair was already open, the reported "Open chart does
    // nothing / glitches out" bug. The pick has to be
    // sequenced behind the rail click: MARKETS fires switchProvider() without
    // awaiting it, and that call ENDS by charting instruments[0], so a symbol
    // set before it resolves is overwritten a second later.
    await chartLseSymbol(sym);
  };
}

async function scrRefresh(first) {
  if (first) scrStatus("Loading the screener snapshot…");
  let d;
  try {
    const r = await fetch("/api/screener?provider=lse");
    if (r.status === 409) {
      scrStatus("The screener needs the LSE key. Set it under MY DATA > LSE.");
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    if (first) scrStatus(`Screener unavailable: ${e.message || e}`);
    return; // keep showing the last snapshot on refresh failures
  }
  scrStatus(null);
  scrState.columns = d.columns || [];
  if (scrState.hover && scrState.rows.length) {
    // Never resort under the pointer: hold the fresh rows until it leaves.
    scrState.pendingRows = d.data || [];
    scrUpdateVisibleCells(d.data || []);
  } else {
    scrState.rows = d.data || [];
    scrApply();
  }
}

function scrStatus(msg) {
  const el = $("scr-status");
  if (!msg) { el.classList.add("hidden"); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
}

/* Rebuild chips/preset buttons + filter + sort, then repaint. */
function scrApply() {
  const classes = [...new Set(scrState.rows.map((r) => r.asset_class))]
    .filter(Boolean).sort();
  const nav = $("scr-classes");
  nav.innerHTML = "";
  for (const c of ["", ...classes]) {
    const b = document.createElement("button");
    b.textContent = c === "" ? "ALL" : c.replace(/_/g, " ").toUpperCase();
    b.className = scrState.cls === c ? "active" : "";
    b.onclick = () => { scrState.cls = c; scrState.page = 0; scrApply(); };
    nav.appendChild(b);
  }
  const views = $("scr-views");
  views.innerHTML = "";
  for (const v of Object.keys(SCR_VIEWS)) {
    const b = document.createElement("button");
    b.textContent = v.toUpperCase();
    b.className = scrState.view === v ? "active" : "";
    b.onclick = () => { scrState.view = v; scrState.page = 0; scrApply(); };
    views.appendChild(b);
  }

  let rows = scrState.rows;
  if (scrState.cls) rows = rows.filter((r) => r.asset_class === scrState.cls);
  if (scrState.q) {
    const q = scrState.q;
    rows = rows.filter((r) => r.symbol.toUpperCase().includes(q) ||
      (r.name || "").toUpperCase().includes(q));
  }
  const { col, dir } = scrState.sort;
  rows = rows.slice().sort((a, b) => {
    const x = a[col], y = b[col];
    if (x == null && y == null) return 0;
    if (x == null) return 1;          // nulls last regardless of direction
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string") {
      return String(x).localeCompare(String(y)) * dir;
    }
    return (x - y) * dir;
  });
  scrState.matched = rows;
  // Clamp: a filter that shrinks the result set must not strand the reader
  // on a page that no longer exists.
  const pages = Math.max(1, Math.ceil(rows.length / SCR_PAGE_SIZE));
  if (scrState.page > pages - 1) scrState.page = pages - 1;
  const from = scrState.page * SCR_PAGE_SIZE;
  scrState.shown = rows.slice(from, from + SCR_PAGE_SIZE);
  $("scr-count").textContent =
    `${rows.length.toLocaleString()} / ${scrState.rows.length.toLocaleString()}`;
  scrPager(from, pages);
  scrHeader();
  $("scr-spacer").style.height = `${scrState.shown.length * SCR_ROW_H}px`;
  $("scr-rows").innerHTML = "";   // full repaint: order changed by user action
  $("scr-body").scrollTop = 0;    // a new page starts at its first row
  scrPaint(true);
}

/* Pager readout + button state. Rows are indexed from the whole filtered
   set, so the label answers "where am I in the 4,189", not "where am I in
   this page". */
function scrPager(from, pages) {
  const total = scrState.matched.length;
  const to = from + scrState.shown.length;
  $("scr-range").textContent = total
    ? `${(from + 1).toLocaleString()}-${to.toLocaleString()} of ${total.toLocaleString()}`
      + `   ·   page ${scrState.page + 1}/${pages}`
    : "no matches";
  $("scr-prev").disabled = scrState.page <= 0;
  $("scr-next").disabled = scrState.page >= pages - 1;
}

function scrGoPage(delta) {
  const pages = Math.max(1, Math.ceil(scrState.matched.length / SCR_PAGE_SIZE));
  const next = Math.min(pages - 1, Math.max(0, scrState.page + delta));
  if (next === scrState.page) return;
  scrState.page = next;
  scrApply();
}

function scrCols() {
  const want = ["symbol", "name", ...SCR_VIEWS[scrState.view]];
  const byCol = Object.fromEntries(scrState.columns.map((c) => [c.col, c]));
  return want.map((c) => byCol[c]).filter(Boolean);
}

function scrHeader() {
  const head = $("scr-thead");
  head.innerHTML = "";
  for (const c of scrCols()) {
    const b = document.createElement("button");
    b.className = "scr-th scr-" + c.fmt +
      (scrState.sort.col === c.col ? " sorted" : "");
    b.textContent = c.label +
      (scrState.sort.col === c.col ? (scrState.sort.dir < 0 ? " ↓" : " ↑") : "");
    if (c.description) b.title = c.description;
    b.onclick = () => {
      scrState.sort = scrState.sort.col === c.col
        ? { col: c.col, dir: -scrState.sort.dir }
        // Numbers first show biggest-first; text sorts A-Z.
        : { col: c.col, dir: c.fmt === "text" ? 1 : -1 };
      scrState.page = 0;   // page 3 of the old order means nothing in the new
      scrApply();
    };
    head.appendChild(b);
  }
}

function scrFmt(v, fmt) {
  if (v == null) return "";
  switch (fmt) {
    case "px": return v >= 1000 ? v.toLocaleString(undefined,
      { maximumFractionDigits: 2 }) : String(+v.toPrecision(6));
    case "pct": return `${v > 0 ? "+" : ""}${(+v).toFixed(2)}%`;
    case "int": return (+v).toLocaleString();
    case "cap": {
      const a = Math.abs(v);
      const s = a >= 1e12 ? (v / 1e12).toFixed(2) + "T"
        : a >= 1e9 ? (v / 1e9).toFixed(2) + "B"
        : a >= 1e6 ? (v / 1e6).toFixed(1) + "M"
        : a >= 1e3 ? (v / 1e3).toFixed(1) + "K" : (+v).toFixed(0);
      return s;
    }
    case "date": return String(v).slice(0, 10);
    case "dt": return String(v).slice(5, 16).replace("T", " ");
    case "num": return typeof v === "number"
      ? String(+v.toPrecision(4)) : String(v);
    default: return String(v);
  }
}

/* Paint the visible window. Existing row divs are reused in place: with a
   stable order, scrolling and refreshes only touch text nodes. */
function scrPaint(force) {
  const body = $("scr-body");
  const rowsEl = $("scr-rows");
  const cols = scrCols();
  const top = body.scrollTop;
  const first = Math.max(0, Math.floor(top / SCR_ROW_H) - 8);
  const last = Math.min(scrState.shown.length,
    Math.ceil((top + body.clientHeight) / SCR_ROW_H) + 8);
  const seen = new Set();
  for (let i = first; i < last; i++) {
    const r = scrState.shown[i];
    seen.add(r.symbol);
    let el = force ? null : rowsEl.querySelector(
      `.scr-row[data-sym="${CSS.escape(r.symbol)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "scr-row";
      el.dataset.sym = r.symbol;
      for (const c of cols) {
        const cell = document.createElement("span");
        cell.className = "scr-td scr-" + c.fmt;
        el.appendChild(cell);
      }
      // The symbol cell carries the instrument's logo tile (platform CDN;
      // set once per row since row identity is the symbol) + a text span
      // the paint loop updates, so refreshes never touch the <img>.
      const c0 = el.children[0];
      c0.classList.add("scr-symcell");
      const src = scrLogoSrc(r);
      c0.innerHTML = `<span class="slogo">`
        + (src ? `<img src="${src.replace(/"/g, "&quot;")}" alt="" loading="lazy" onerror="this.remove()">` : "")
        + `<span class="sinit">${logoInitial(r)}</span></span>`
        + `<span class="ssym"></span>`;
      rowsEl.appendChild(el);
    }
    el.style.transform = `translateY(${i * SCR_ROW_H}px)`;
    const cells = el.children;
    for (let j = 0; j < cols.length; j++) {
      const c = cols[j];
      const v = r[c.col];
      const txt = c.col === "market_open" ? (v ? "●" : "") : scrFmt(v, c.fmt);
      if (j === 0) {
        const t = cells[0].querySelector(".ssym");
        if (t && t.textContent !== txt) t.textContent = txt;
        continue;
      }
      if (cells[j].textContent !== txt) cells[j].textContent = txt;
      if (c.fmt === "pct" || c.col === "opt_net_premium"
          || c.col === "macro_surprise_30d" || c.col === "cot_net_noncomm") {
        cells[j].classList.toggle("up", v > 0);
        cells[j].classList.toggle("dn", v < 0);
      }
    }
  }
  // Drop rows scrolled out of the window so the DOM stays ~50 nodes.
  for (const el of [...rowsEl.children]) {
    if (!seen.has(el.dataset.sym)) el.remove();
  }
}

/* A refresh arrived while the pointer is in the table: update the numbers
   of the rows on screen (keyed by symbol) without touching the order. */
function scrUpdateVisibleCells(fresh) {
  const by = new Map(fresh.map((r) => [r.symbol, r]));
  for (let i = 0; i < scrState.shown.length; i++) {
    const nu = by.get(scrState.shown[i].symbol);
    if (nu) scrState.shown[i] = nu;
  }
  scrState.rows = scrState.rows.map((r) => by.get(r.symbol) || r);
  scrPaint();
}

/* ---------- screener profile card ------------------------------------- */
const SCR_SITE = "https://londonstrategicedge.com";
/* Stock art is read from the platform's own master store rather than the
   website copy: the published site tree can lag the master, and a missing
   file there is NOT a 404, it falls through to the SPA index, so the
   browser would download HTML per logo and then fail to decode it. Only
   stocks/ is redirected: crypto, forex, commodity and index art lives ONLY
   in the published copy, so sending those to the master store would break
   art that works today. */
const SCR_MASTER_LOGOS = "https://api.londonstrategicedge.com/logos/";

function scrLogoSrc(r) {
  const dark = document.documentElement.classList.contains("dark");
  const p = (dark ? r.logo_dark : r.logo_light) || r.logo_light || r.logo_dark;
  if (!p) return "";
  if (p.startsWith("http")) return p;
  const stock = p.match(/^\/market_photos\/stocks\/(.+)$/);
  return stock ? SCR_MASTER_LOGOS + stock[1] : SCR_SITE + p;
}

/* The fallback mark under a logo. symbol[0] is meaningless on the exchanges
   whose tickers are numeric (005930.KS, 9984.T, 0001.HK): every Asian row
   rendered an identical "0" tile, which is what the whole screener looked
   like while the art above was missing. The company NAME's first letter is
   the mark a reader can actually use (Samsung -> S). */
function logoInitial(r) {
  const s = String(r.name || r.symbol || "").trim();
  const ch = (s.match(/[A-Za-z0-9]/) || [""])[0];
  return ch.toUpperCase();
}

function scrHideCard() {
  $("scr-card-back").classList.add("hidden");
}

function scrShowCard(r) {
  const back = $("scr-card-back");
  back.dataset.sym = r.symbol;
  const src = scrLogoSrc(r);
  $("scr-card-logo").innerHTML = (src
    ? `<img src="${src.replace(/"/g, "&quot;")}" alt="" onerror="this.remove()">` : "")
    + `<span>${logoInitial(r)}</span>`;
  $("scr-card-name").textContent = r.name || r.symbol;
  $("scr-card-sym").textContent = r.symbol
    + (r.asset_class ? " · " + r.asset_class.replace(/_/g, " ") : "");
  const line = [r.sector, r.industry].filter(Boolean).join(" · ");
  const where = [r.exchange, r.country].filter(Boolean).join(" · ");
  $("scr-card-sector").textContent = [line, where].filter(Boolean).join("  |  ");
  // Key stats: reuse the grid's own formatter so the card never disagrees
  // with the table. Empty fields simply do not render.
  const stats = [
    ["Price", scrFmt(r.price, "px")],
    ["24h", scrFmt(r.change_24h_pct, "pct")],
    ["1y", scrFmt(r.change_1y_pct, "pct")],
    ["Mkt cap", scrFmt(r.market_cap, "cap")],
    ["P/E", scrFmt(r.pe_ratio, "num")],
    ["Beta", scrFmt(r.beta, "num")],
    ["Div yield", scrFmt(r.dividend_yield, "pct")],
    ["Rev TTM", scrFmt(r.revenue_ttm, "cap")],
    ["Employees", scrFmt(r.employees, "int")],
    ["IPO", scrFmt(r.ipo_date, "date")],
    ["Next earnings", scrFmt(r.next_earnings_date, "date")],
    ["CEO", r.ceo || ""],
  ].filter(([, v]) => v !== "" && v != null);
  $("scr-card-stats").innerHTML = stats.map(([k, v]) =>
    `<div class="scr-kv"><span>${k}</span><b>${String(v)
      .replace(/</g, "&lt;")}</b></div>`).join("");
  const d = $("scr-card-desc");
  d.textContent = r.description || "";
  d.classList.toggle("hidden", !r.description);
  const w = $("scr-card-web");
  if (r.website) {
    w.href = r.website;
    w.textContent = r.website.replace(/^https?:\/\/(www\.)?/, "");
    w.classList.remove("hidden");
  } else {
    w.classList.add("hidden");
  }
  back.classList.remove("hidden");
}
