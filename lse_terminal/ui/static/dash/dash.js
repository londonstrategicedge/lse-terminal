/* WORKSPACE > DASHBOARD: boards of widgets the user codes.

   A widget is a title, a size, a refresh period and JavaScript. Its code
   runs in a sandboxed frame (dash/widget.js is what runs in there) and
   reaches data only by asking this page, which answers from a fixed list of
   read-only calls (DASH_CALLS): LSE data and the user's own files. It gets
   no engine route, no key, no order and no broker's prices: a broker's
   terms can keep its prices with the terminal's own chart and ticket, so
   the bridge has no call that reads one.

   Boards live in the "dashboards" workspace section (engine/workspace.py),
   shared by every window of the terminal; a window that shows the
   dashboard reads it again when another window saves it.

   Loaded after app.js, whose helpers it uses: $, status, state,
   priceDeskPrices, renderSubrail, closeManualBacktest, lseWin. */

const DASH_COLS = 12;          // the board's grid
const DASH_ROW_PX = 56;        // one row of height
const DASH_GAP_PX = 12;
const DASH_MIN_W = 3, DASH_MIN_H = 3, DASH_MAX_H = 14;
const DASH_CODE_MAX = 60000;   // characters of one widget's code
const DASH_EVERY = [[0, "Off"], [5, "5 seconds"], [15, "15 seconds"], [30, "30 seconds"],
                    [60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"]];
// What one widget, and the whole board, may ask of the data in a minute. A
// loop written by mistake must not spend the key's allowance.
const DASH_CALLS_PER_WIDGET = 40;
const DASH_CALLS_PER_BOARD = 160;

/* The examples offered on an empty board and under Examples. Each is a
   working widget against real data; the user's own start as a copy. */
const DASH_EXAMPLES = [
  { key: "putcall", title: "Put/call ratio", w: 6, h: 7, every: 60,
    about: "Calls against puts for one underlying: today's volume and premium, then the ratio by expiry.",
    code: `// Put/call ratio of one underlying, from today's option chain.
const symbol = "SPY";

const chain = await lse.options.chain(symbol);
let callVol = 0, putVol = 0, callPrem = 0, putPrem = 0;
const byExpiry = new Map();
for (const c of chain) {
  const volume = Number(c.volume_today) || 0;
  const premium = Number(c.premium_today) || 0;
  const put = c.contract_type === "put";
  if (put) { putVol += volume; putPrem += premium; }
  else { callVol += volume; callPrem += premium; }
  const e = byExpiry.get(c.expiry) || { call: 0, put: 0 };
  e[put ? "put" : "call"] += volume;
  byExpiry.set(c.expiry, e);
}

ui.row(() => {
  ui.number(callVol ? putVol / callVol : null,
    { label: symbol + " put/call by volume", decimals: 2 });
  ui.number(callPrem ? putPrem / callPrem : null,
    { label: "Put/call by premium", decimals: 2 });
});
ui.share([
  { label: "Calls", value: callVol, tone: "up" },
  { label: "Puts", value: putVol, tone: "down" },
]);
ui.text("Put/call by expiry", { dim: true, small: true });
ui.bars([...byExpiry].sort().slice(0, 14).map(([expiry, v]) =>
  ({ label: expiry.slice(5), value: v.call ? v.put / v.call : 0 })), { decimals: 2 });
` },
  { key: "price", title: "Price", w: 6, h: 6, every: 60,
    about: "The last price of one instrument over its recent bars.",
    code: `// One instrument's recent bars.
const symbol = "EUR/USD", timeframe = "1h";

const bars = await lse.candles({ symbol, timeframe, limit: 300 });
const first = bars[0], last = bars[bars.length - 1];
const change = (last.close / first.close - 1) * 100;
ui.number(last.close, {
  label: symbol + " · " + timeframe,
  sub: (change >= 0 ? "+" : "") + change.toFixed(2) + "% over " + bars.length + " bars",
  tone: change >= 0 ? "up" : "down",
});
ui.line(bars, { area: true });
` },
  { key: "watch", title: "Quotes", w: 4, h: 6, every: 5,
    about: "Bid, ask and spread for a list of your own.",
    code: `// Live quotes for a list of symbols.
const symbols = ["EUR/USD", "GBP/USD", "USD/JPY", "BTC/USD", "AAPL", "NVDA"];

const quotes = await lse.prices(symbols);
ui.table(quotes.map((q) => ({
  symbol: q.symbol,
  bid: q.bid,
  ask: q.ask,
  spread: q.bid != null && q.ask != null ? q.ask - q.bid : null,
})), { columns: [
  { key: "symbol", label: "Symbol" },
  { key: "bid", label: "Bid" },
  { key: "ask", label: "Ask" },
  { key: "spread", label: "Spread" },
] });
` },
  { key: "curve", title: "Yield curve", w: 6, h: 6, every: 900,
    about: "A country's government bond yields across maturities.",
    code: `// A country's yield curve from the bond yields the terminal carries.
const country = "US";

const rows = await lse.macro.catalog({ dataset: "bonds", country });
const months = (s) => {
  const m = /(\\d+)([MY])$/.exec(s);
  return m ? Number(m[1]) * (m[2] === "Y" ? 12 : 1) : 0;
};
const curve = rows
  .map((r) => ({ label: r.symbol.replace(country, ""), value: r.last_value, m: months(r.symbol) }))
  .filter((r) => r.m && r.value != null)
  .sort((a, b) => a.m - b.m);
ui.text(rows[0].country_name + " government yields, percent, " + rows[0].last, { dim: true, small: true });
ui.bars(curve, { decimals: 2 });
` },
  { key: "series", title: "Economic series", w: 6, h: 6, every: 900,
    about: "One economic statistic over time, here US inflation.",
    code: `// One economic series over time. Find a symbol with:
//   await lse.macro.catalog({ country: "US", search: "inflation" })
const symbol = "cpi_yoy";

const rows = await lse.macro.series(symbol, { order: "desc", limit: 240 });
rows.reverse();
const last = rows[rows.length - 1];
ui.number(last.value, { label: "US inflation rate, year on year", suffix: "%", sub: last.date });
ui.line(rows.map((r) => ({ t: r.date, v: r.value })), { decimals: 1 });
` },
  { key: "flow", title: "Options flow", w: 6, h: 7, every: 30,
    about: "The largest option trades as they print.",
    code: `// The largest option trades by premium.
const flow = await lse.options.flow({ min_premium: 250000, limit: 40 });

ui.table(flow.map((t) => ({
  time: (t.ts || "").slice(11, 19),
  contract: t.underlying + " " + t.strike + (t.contract_type === "put" ? "P" : "C") + " " + t.expiry.slice(5),
  size: t.volume,
  premium: t.premium,
  side: t.contract_type,
})), { columns: [
  { key: "time", label: "Time, UTC" },
  { key: "contract", label: "Contract" },
  { key: "size", label: "Size", align: "right" },
  { key: "premium", label: "Premium", align: "right", format: (v) => ui.compact(v) },
  { key: "side", label: "Side", tone: (v) => (v === "put" ? "down" : "up") },
] });
` },
  { key: "calendar", title: "Releases", w: 6, h: 6, every: 300,
    about: "The economic calendar from today, for one region.",
    code: `// The economic calendar from today onward.
const region = "US";

const today = new Date().toISOString().slice(0, 10);
const rows = await lse.calendar({ region, start: today, limit: 30 });
ui.table(rows.map((r) => ({
  when: r.datetime.slice(5, 16).replace("T", " "),
  event: r.event,
  actual: r.actual,
  consensus: r.consensus,
  previous: r.previous,
})), { columns: [
  { key: "when", label: "UTC" },
  { key: "event", label: "Release" },
  { key: "actual", label: "Actual", align: "right" },
  { key: "consensus", label: "Consensus", align: "right" },
  { key: "previous", label: "Previous", align: "right" },
] });
` },
];

const DASH_BLANK = `// Read data with lse, draw with ui. The reference is on the right.
const bars = await lse.candles({ symbol: "EUR/USD", timeframe: "1h", limit: 200 });
ui.line(bars);
`;

/* The reference shown beside the editor, and in the walkthrough: one row
   per call, the signature as code and one line on what it answers. */
const DASH_REFERENCE = [
  ["Data", [
    ["await lse.candles({ symbol, timeframe, limit, start, end, source })",
     "Bars, oldest first: {t, open, high, low, close, volume}, t in seconds. source is \"lse\" (the default) or \"mydata\" for an imported file."],
    ["await lse.prices([symbols])", "Latest {symbol, price, bid, ask, ts} for up to 50 symbols."],
    ["await lse.instruments(query, limit)", "Instruments matching a search: {symbol, name, category}."],
    ["await lse.chart()", "What this window's chart shows: {symbol, timeframe, source}."],
    ["await lse.options.underlyings()", "The underlyings with option data: {symbol, name}."],
    ["await lse.options.chain(underlying, { type, expiry })",
     "Every contract of an underlying: strike, expiry, contract_type, last_price, volume_today, premium_today, iv and the Greeks."],
    ["await lse.options.flow({ underlying, type, min_premium, limit })", "Option trades, newest first."],
    ["await lse.macro.catalog({ dataset, country, search, limit })",
     "Economic series (dataset \"economics\") and bond yields (\"bonds\") with their last value."],
    ["await lse.macro.series(symbol, { dataset, start, end, order, limit })", "One series: {date, value}."],
    ["await lse.calendar({ region, event, start, end, order, limit })", "Economic calendar releases."],
    ["await lse.screener({ where, sort, desc, limit })", "The screener's rows, filtered and sorted."],
    ["await lse.news()", "The news wire: {events, posts}."],
    ["await lse.mydata.list()", "Your imported datasets."],
    ["await lse.mydata.rows(name)", "One imported dataset: {fields, rows}."],
  ]],
  ["Drawing", [
    ["ui.number(value, { label, sub, decimals, prefix, suffix, tone })", "One figure. tone is \"up\" or \"down\"."],
    ["ui.line(data, { area, decimals, min, max })",
     "A line chart of bars, [t, v] pairs, {t, v} points or plain numbers. Several lines: [{ name, data }]."],
    ["ui.bars(items, { horizontal, decimals, compact })", "Bars of {label, value, tone}."],
    ["ui.share([{ label, value, tone }])", "The parts of a whole on one bar."],
    ["ui.table(rows, { columns, limit })", "A table. A column is a key or {key, label, align, decimals, format, tone}."],
    ["ui.row(() => { ... })", "Puts what is drawn inside side by side."],
    ["ui.text(words, { dim, small })", "A line of words."],
    ["ui.canvas((ctx, width, height) => { ... })", "A canvas to draw on by hand."],
    ["el", "The widget's own element, for anything else. ui.theme holds the terminal's colours."],
  ]],
];

const dash = {
  loaded: false, loading: null, unsupported: false, saveError: "",
  doc: { version: 1, current: "", boards: [] },
  saveT: null, recs: new Map(), runtime: null, bound: false, tickT: null,
  edit: null, stale: false, cache: new Map(), boardCalls: [], seq: 0,
};

function dashId(prefix) {
  dash.seq += 1;
  return prefix + Date.now().toString(36) + dash.seq.toString(36) +
    Math.random().toString(36).slice(2, 6);
}

function dashClamp(n, lo, hi, fallback) {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// The stored document, made safe to draw whatever a hand edit left in it.
function dashClean(value) {
  const doc = { version: 1, current: "", boards: [] };
  const src = value && typeof value === "object" && Array.isArray(value.boards) ? value.boards : [];
  const seen = new Set();
  for (const b of src.slice(0, 40)) {
    if (!b || typeof b !== "object") continue;
    let id = typeof b.id === "string" && b.id ? b.id.slice(0, 40) : dashId("b");
    if (seen.has(id)) id = dashId("b");
    seen.add(id);
    const widgets = [];
    for (const w of (Array.isArray(b.widgets) ? b.widgets : []).slice(0, 60)) {
      if (!w || typeof w !== "object") continue;
      let wid = typeof w.id === "string" && w.id ? w.id.slice(0, 40) : dashId("w");
      if (seen.has(wid)) wid = dashId("w");
      seen.add(wid);
      widgets.push({
        id: wid,
        title: String(w.title == null ? "Widget" : w.title).slice(0, 80) || "Widget",
        code: String(w.code == null ? "" : w.code).slice(0, DASH_CODE_MAX),
        w: dashClamp(w.w, DASH_MIN_W, DASH_COLS, 6),
        h: dashClamp(w.h, DASH_MIN_H, DASH_MAX_H, 6),
        every: DASH_EVERY.some(([s]) => s === Number(w.every)) ? Number(w.every) : 0,
      });
    }
    doc.boards.push({ id, name: String(b.name == null ? "Board" : b.name).slice(0, 40) || "Board", widgets });
  }
  if (!doc.boards.length) doc.boards.push({ id: dashId("b"), name: "My dashboard", widgets: [] });
  const cur = value && typeof value.current === "string" ? value.current : "";
  doc.current = doc.boards.some((b) => b.id === cur) ? cur : doc.boards[0].id;
  return doc;
}

function dashBoard() {
  return dash.doc.boards.find((b) => b.id === dash.doc.current) || dash.doc.boards[0];
}

async function dashLoad() {
  if (dash.loaded) return;
  if (dash.loading) return dash.loading;
  dash.loading = (async () => {
    let value = null;
    try {
      const r = await fetch("/api/workspace/dashboards");
      // An engine older than this page has no such section (its list is
      // frozen into the build): the board works, and says it cannot keep.
      if (r.status === 404) dash.unsupported = true;
      else if (r.ok) value = (await r.json()).value;
    } catch (e) { dash.saveError = "The dashboard could not be read; changes may not be kept."; }
    dash.doc = dashClean(value);
    dash.loaded = true;
    dash.loading = null;
  })();
  return dash.loading;
}

function dashSave() {
  if (dash.unsupported) return;
  if (dash.saveT) clearTimeout(dash.saveT);
  dash.saveT = setTimeout(async () => {
    dash.saveT = null;
    try {
      const r = await fetch("/api/workspace/dashboards", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dash.doc),
      });
      if (r.status === 404) dash.unsupported = true;
      dash.saveError = r.ok ? "" : "The dashboard could not be saved (" + r.status + ").";
    } catch (e) { dash.saveError = "The dashboard could not be saved; the engine did not answer."; }
    dashNote();
  }, 350);
}

/* Another window saved the boards: show them, unless this window is in the
   middle of editing a widget (then when the editor closes). */
async function dashRemoteChanged() {
  if (!dash.loaded) return;
  if (dash.edit || dash.saveT) { dash.stale = true; return; }
  try {
    const r = await fetch("/api/workspace/dashboards");
    if (!r.ok) return;
    const next = dashClean((await r.json()).value);
    next.current = next.boards.some((b) => b.id === dash.doc.current) ? dash.doc.current : next.current;
    if (JSON.stringify(next) === JSON.stringify(dash.doc)) return;
    dash.doc = next;
    if (dashVisible()) dashRender();
  } catch (e) { /* the next save or open reads it */ }
}

function dashVisible() {
  const el = document.getElementById("dash");
  return !!el && !el.classList.contains("hidden");
}

/* ── the frame ─────────────────────────────────────────────────────── */
function dashTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  return {
    text: v("--text", "#e8e8e8"), dim: v("--dim", "#b0b0b0"), edge: v("--edge", "#3a3a3a"),
    bg: v("--panel", "#2a2a2a"), up: v("--up", "#21b3a4"), down: v("--down", "#f0426c"),
    err: v("--err", "#f87171"), mono: v("--mono", "ui-monospace, Consolas, monospace"),
    font: getComputedStyle(document.body).fontFamily || "sans-serif",
    dark: document.documentElement.classList.contains("dark"),
  };
}

function dashFrameCss(t) {
  return `
html,body{height:100%;margin:0}
body{background:${t.bg};color:${t.text};font:14px/1.45 ${t.font};overflow:hidden}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:${t.edge} transparent}
#root{height:100%}
.w-out{height:100%;display:flex;flex-direction:column;gap:10px;padding:12px 14px 12px;overflow:auto}
.w-empty{color:${t.dim};font-size:13px;padding:14px}
.w-text{font-size:14px}.w-text.dim{color:${t.dim}}.w-text.small{font-size:12px}
.w-row{display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end}
.w-num-label{color:${t.dim};font-size:12px;margin-bottom:2px}
.w-num-value{font-size:30px;line-height:1.15;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.w-num-sub{color:${t.dim};font-size:13px;margin-top:2px;font-variant-numeric:tabular-nums}
.w-chart{flex:1 1 140px;min-height:120px;position:relative}
.w-chart canvas{position:absolute;inset:0;display:block}
.w-table{flex:1 1 auto;min-height:0;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th{position:sticky;top:0;background:${t.bg};color:${t.dim};font-size:12px;font-weight:600;text-align:left;padding:6px 10px 6px 0;border-bottom:1px solid ${t.edge};white-space:nowrap}
td{padding:6px 10px 6px 0;border-bottom:1px solid ${t.edge};white-space:nowrap}
th.r,td.r{text-align:right;padding:6px 0 6px 10px}
.w-hbars{display:flex;flex-direction:column;gap:6px}
.w-hbar{display:grid;grid-template-columns:minmax(60px,30%) 1fr auto;gap:10px;align-items:center;font-size:13px}
.w-hbar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.w-hbar-track{height:8px;background:${t.edge};border-radius:2px;overflow:hidden;display:block}
.w-hbar-fill{display:block;height:100%}
.w-hbar-value{font-variant-numeric:tabular-nums}
.w-share-bar{display:flex;height:10px;border-radius:2px;overflow:hidden;background:${t.edge}}
.w-share-bar span{display:block;height:100%}
.w-share-key{display:flex;gap:18px;flex-wrap:wrap;margin-top:6px;font-size:13px;font-variant-numeric:tabular-nums}
.w-share-item i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
.w-err-title{font-size:14px;font-weight:600;color:${t.err}}
.w-err{margin:0;color:${t.err};font:12px/1.5 ${t.mono};white-space:pre-wrap;word-break:break-word}
`;
}

async function dashRuntime() {
  if (dash.runtime !== null) return dash.runtime;
  const r = await fetch("./dash/widget.js", { cache: "no-cache" });
  if (!r.ok) throw new Error("the widget runtime did not load (" + r.status + ")");
  dash.runtime = await r.text();
  return dash.runtime;
}

/* One widget's whole document. The code travels as JSON inside a script
   (every "<" escaped, so no text of the user's can close the tag), and the
   frame's own policy lets it load nothing from anywhere: its data comes
   through the bridge or not at all. */
function dashSrcdoc(code, runtime) {
  const theme = dashTheme();
  // "<" so no text of the user's can close the script tag; the two line
  // separators JSON allows inside a string, which old script parsers do not.
  const boot = JSON.stringify({ code: String(code || ""), theme })
    .replace(/</g, "\\u003c")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; " +
    "script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:\">" +
    "<style>" + dashFrameCss(theme) + "</style></head><body><div id=\"root\"></div>" +
    "<script>window.__LSE_BOOT=" + boot + ";</" + "script>" +
    "<script>" + runtime.replace(/<\/script/gi, "<\\/script") + "</" + "script></body></html>";
}

/* Start (or restart) a widget's frame inside `host`. rec is what the bridge
   knows the frame by: its window, its widget, its status line. */
function dashFrameStart(host, widget, onStatus) {
  const old = host.querySelector("iframe");
  if (old) { dash.recs.delete(old.__rec && old.__rec.key); old.remove(); }
  const frame = document.createElement("iframe");
  frame.className = "dash-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", widget.title || "Widget");
  const rec = { key: dashId("f"), frame, widget, onStatus, calls: [], nextAt: 0, status: "loading" };
  frame.__rec = rec;
  dash.recs.set(rec.key, rec);
  host.appendChild(frame);
  dashRuntime().then((runtime) => {
    if (!frame.isConnected) return;
    frame.srcdoc = dashSrcdoc(widget.code, runtime);
    rec.nextAt = widget.every ? Date.now() + widget.every * 1000 : 0;
  }).catch((e) => onStatus("error", String(e.message || e)));
  return rec;
}

function dashFrameRun(rec) {
  try { rec.frame.contentWindow.postMessage({ lse: 1, run: 1 }, "*"); } catch (e) { /* frame gone */ }
  if (rec.widget.every) rec.nextAt = Date.now() + rec.widget.every * 1000;
}

function dashRecOf(source) {
  for (const rec of dash.recs.values()) {
    if (!rec.frame.isConnected) { dash.recs.delete(rec.key); continue; }
    if (rec.frame.contentWindow === source) return rec;
  }
  return null;
}

/* ── the bridge: what a widget may ask ─────────────────────────────── */
async function dashGet(path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const qs = q.toString();
  let r;
  try { r = await fetch(path + (qs ? "?" + qs : "")); }
  catch (e) { throw new Error("The terminal's engine did not answer."); }
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const detail = body && body.detail;
    throw new Error(typeof detail === "string" && detail ? detail : "The data call failed (" + r.status + ").");
  }
  return body;
}

function dashStr(v, max) { return v == null ? "" : String(v).slice(0, max || 80); }
function dashInt(v, lo, hi, fallback) { return dashClamp(v, lo, hi, fallback); }

// method -> {ttl seconds the answer may be shared for, run(args)}
const DASH_CALLS = {
  "candles": { ttl: 5, run: async (a) => {
    a = a || {};
    const source = a.source === "mydata" ? "userdata" : a.source == null || a.source === "lse" ? "lse" : null;
    if (!source) {
      throw new Error("Widgets read LSE data and your own files: source is \"lse\" or \"mydata\". " +
        "A broker's prices stay with the chart and the ticket.");
    }
    if (!a.symbol) throw new Error("lse.candles needs a symbol.");
    const body = await dashGet("/api/candles", {
      provider: source, symbol: dashStr(a.symbol, 60), timeframe: dashStr(a.timeframe || "1h", 8),
      limit: dashInt(a.limit, 1, 5000, 500), start: dashStr(a.start, 40), end: dashStr(a.end, 40) });
    return (body.candles || []).map((c) => (
      { t: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
  } },
  "prices": { ttl: 0, run: async (a) => {
    const symbols = (Array.isArray(a) ? a : a && Array.isArray(a.symbols) ? a.symbols : [])
      .map((s) => dashStr(s, 60)).filter(Boolean).slice(0, 50);
    if (!symbols.length) return [];
    const rows = await priceDeskPrices("lse", symbols);
    if (rows === null) throw new Error("Prices are unavailable at the moment.");
    return rows;
  } },
  "instruments": { ttl: 30, run: (a) => dashGet("/api/instruments", {
    provider: "lse", query: dashStr(a && a.query, 60), limit: dashInt(a && a.limit, 1, 500, 50) }) },
  "chart": { ttl: 0, run: async () => ({
    symbol: state.symbol || null, timeframe: state.timeframe || null,
    source: state.provider === "lse" ? "lse" : state.provider === "userdata" ? "mydata" : "broker" }) },
  "options.underlyings": { ttl: 60, run: () => dashGet("/api/options/underlyings") },
  "options.chain": { ttl: 15, run: (a) => {
    if (!a || !a.underlying) throw new Error("lse.options.chain needs an underlying, such as \"SPY\".");
    return dashGet("/api/options/chain", { underlying: dashStr(a.underlying, 20),
      type: dashStr(a.type, 8), expiry: dashStr(a.expiry, 12), limit: dashInt(a.limit, 1, 5000, 5000) });
  } },
  "options.flow": { ttl: 10, run: (a) => dashGet("/api/options/flow", {
    underlying: dashStr(a && a.underlying, 20), type: dashStr(a && a.type, 8),
    min_premium: Number(a && a.min_premium) > 0 ? Number(a.min_premium) : "",
    limit: dashInt(a && a.limit, 1, 1000, 300) }) },
  "macro.catalog": { ttl: 60, run: async (a) => {
    a = a || {};
    // 15,000 rows in all: read once, and hand a widget only what it asks for.
    const all = await dashShared("macro.catalog.all", 300, () => dashGet("/api/macro/catalog"));
    const dataset = dashStr(a.dataset, 20).toLowerCase(), country = dashStr(a.country, 4).toUpperCase();
    const search = dashStr(a.search, 60).toLowerCase();
    const out = [];
    const limit = dashInt(a.limit, 1, 2000, 200);
    for (const r of all) {
      if (dataset && String(r.dataset).toLowerCase() !== dataset) continue;
      if (country && String(r.country).toUpperCase() !== country) continue;
      if (search && !(String(r.name) + " " + String(r.symbol) + " " + String(r.category)).toLowerCase().includes(search)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  } },
  "macro.series": { ttl: 60, run: (a) => {
    if (!a || !a.symbol) throw new Error("lse.macro.series needs a symbol from lse.macro.catalog.");
    return dashGet("/api/macro/series", { symbol: dashStr(a.symbol, 60), dataset: dashStr(a.dataset, 20),
      start: dashStr(a.start, 30), end: dashStr(a.end, 30),
      order: a.order === "desc" ? "desc" : "asc", limit: dashInt(a.limit, 1, 5000, 1000) });
  } },
  "calendar": { ttl: 60, run: (a) => dashGet("/api/economic-calendar", {
    region: dashStr(a && a.region, 8), event: dashStr(a && a.event, 80),
    start: dashStr(a && a.start, 30), end: dashStr(a && a.end, 30),
    released: a && a.released ? 1 : 0, order: a && a.order === "desc" ? "desc" : "asc",
    limit: dashInt(a && a.limit, 1, 1000, 100) }) },
  "screener": { ttl: 30, run: async (a) => {
    a = a || {};
    const snap = await dashShared("screener.all", 30, () => dashGet("/api/screener", { provider: "lse" }));
    let rows = Array.isArray(snap.data) ? snap.data : [];
    const where = a.where && typeof a.where === "object" ? a.where : null;
    if (where) rows = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    if (typeof a.sort === "string" && a.sort) {
      const k = a.sort, sign = a.desc ? -1 : 1;
      rows = rows.filter((r) => r[k] != null).sort((x, y) => (x[k] > y[k] ? 1 : x[k] < y[k] ? -1 : 0) * sign);
    }
    return { as_of: snap.as_of, count: rows.length, columns: snap.columns,
             data: rows.slice(0, dashInt(a.limit, 1, 5000, 200)) };
  } },
  "news": { ttl: 60, run: () => dashGet("/api/news/feed") },
  "mydata.list": { ttl: 15, run: async () => (await dashGet("/api/data")).map((d) => ({
    name: d.symbol, title: d.name, kind: d.kind, timeframe: d.timeframe, rows: d.rows,
    first: d.first_ts, last: d.last_ts, folder: d.folder })) },
  "mydata.rows": { ttl: 30, run: (a) => {
    if (!a || !a.name) throw new Error("lse.mydata.rows needs a dataset's name from lse.mydata.list.");
    return dashGet("/api/data/" + encodeURIComponent(dashStr(a.name, 120)) + "/rows");
  } },
};

// One answer for everyone who asks the same thing within its lifetime
// (several widgets on one chain make one request).
function dashShared(key, ttlSeconds, make) {
  const now = Date.now();
  const hit = dash.cache.get(key);
  if (hit && now - hit.at < ttlSeconds * 1000) return hit.promise;
  const promise = Promise.resolve().then(make);
  dash.cache.set(key, { at: now, promise });
  promise.catch(() => { if (dash.cache.get(key) && dash.cache.get(key).promise === promise) dash.cache.delete(key); });
  if (dash.cache.size > 80) {
    for (const [k, v] of dash.cache) { if (now - v.at > 300000) dash.cache.delete(k); }
  }
  return promise;
}

async function dashCall(rec, method, args) {
  const def = Object.prototype.hasOwnProperty.call(DASH_CALLS, method) ? DASH_CALLS[method] : null;
  if (!def) throw new Error("There is no data call named " + String(method).slice(0, 40) + ".");
  const now = Date.now();
  rec.calls = rec.calls.filter((t) => now - t < 60000);
  dash.boardCalls = dash.boardCalls.filter((t) => now - t < 60000);
  if (rec.calls.length >= DASH_CALLS_PER_WIDGET) {
    throw new Error("This widget asked for data " + DASH_CALLS_PER_WIDGET +
      " times in a minute. Ask less often, or lengthen its refresh.");
  }
  if (dash.boardCalls.length >= DASH_CALLS_PER_BOARD) {
    throw new Error("The dashboard's widgets asked for data " + DASH_CALLS_PER_BOARD +
      " times in a minute between them. Lengthen their refresh.");
  }
  rec.calls.push(now); dash.boardCalls.push(now);
  if (!def.ttl) return def.run(args);
  let key;
  try { key = method + "\n" + JSON.stringify(args === undefined ? null : args); }
  catch (e) { throw new Error("The call's arguments must be plain values."); }
  return dashShared(key, def.ttl, () => def.run(args));
}

function dashOnMessage(e) {
  const d = e.data;
  if (!d || d.lse !== 1 || e.origin !== "null") return;
  const rec = dashRecOf(e.source);
  if (!rec) return;
  if (d.status) {
    rec.status = String(d.status);
    rec.onStatus(rec.status, typeof d.message === "string" ? d.message : "");
    return;
  }
  if (typeof d.call !== "number") return;
  const reply = (msg) => {
    try { rec.frame.contentWindow.postMessage(Object.assign({ lse: 1, reply: d.call }, msg), "*"); }
    catch (err) { /* the frame went away before its answer */ }
  };
  dashCall(rec, d.method, d.args).then(
    (value) => reply({ ok: true, value }),
    (err) => reply({ ok: false, error: String((err && err.message) || err).slice(0, 400) }));
}

function dashBind() {
  if (dash.bound) return;
  dash.bound = true;
  window.addEventListener("message", dashOnMessage);
  // Refresh what is due, only while the board is on screen.
  dash.tickT = setInterval(() => {
    if (document.hidden || !dashVisible()) return;
    const now = Date.now();
    for (const rec of dash.recs.values()) {
      if (!rec.frame.isConnected) { dash.recs.delete(rec.key); continue; }
      if (rec.widget.every && rec.nextAt && now >= rec.nextAt && rec.status !== "running") dashFrameRun(rec);
    }
  }, 1000);
}

/* ── the page ──────────────────────────────────────────────────────── */
function dashEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function dashButton(text, cls, onclick, title) {
  const b = dashEl("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = onclick;
  return b;
}

function dashNote() {
  const n = document.getElementById("dash-note");
  if (!n) return;
  const words = dash.unsupported
    ? "This terminal's engine is older than its page and cannot keep a dashboard. Update the app to save your widgets."
    : dash.saveError;
  n.textContent = words || "";
  n.classList.toggle("hidden", !words);
}

async function dashOpen() {
  dashBind();
  const host = $("dash");
  if (!dash.loaded) {
    host.textContent = "";
    host.appendChild(dashEl("div", "dash-loading", "Loading your dashboard…"));
    await dashLoad();
  }
  if (dashVisible()) dashRender();
}

function dashRender() {
  const host = $("dash");
  host.textContent = "";
  dash.recs.clear();
  const board = dashBoard();

  const bar = dashEl("div", "dash-bar");
  const tabs = dashEl("div", "dash-boards");
  for (const b of dash.doc.boards) {
    const t = dashButton(b.name, "dash-board" + (b.id === board.id ? " on" : ""), () => {
      if (dash.doc.current === b.id) return;
      dash.doc.current = b.id; dashSave(); dashRender();
    }, b.id === board.id ? "Double-click to rename" : "");
    if (b.id === board.id) t.ondblclick = () => dashRenameBoard(b);
    tabs.appendChild(t);
  }
  tabs.appendChild(dashButton("+ Board", "dash-board dash-board-add", () => {
    const b = { id: dashId("b"), name: "Board " + (dash.doc.boards.length + 1), widgets: [] };
    dash.doc.boards.push(b); dash.doc.current = b.id; dashSave(); dashRender();
    dashRenameBoard(b);
  }, "Add another board"));
  bar.appendChild(tabs);
  const actions = dashEl("div", "dash-actions");
  if (dash.doc.boards.length > 1 || board.widgets.length) {
    actions.appendChild(dashButton("Delete board", "dash-btn quiet", () => dashDeleteBoard(board)));
  }
  actions.appendChild(dashButton("Examples", "dash-btn", () => dashExamples()));
  actions.appendChild(dashButton("Add widget", "dash-btn act", () => dashEdit(null)));
  bar.appendChild(actions);
  host.appendChild(bar);

  const note = dashEl("div", "dash-note hidden");
  note.id = "dash-note";
  host.appendChild(note);

  const body = dashEl("div", "dash-body");
  host.appendChild(body);
  if (!board.widgets.length) {
    body.appendChild(dashEmpty());
  } else {
    const grid = dashEl("div", "dash-grid");
    grid.id = "dash-grid";
    for (const w of board.widgets) grid.appendChild(dashCard(w));
    body.appendChild(grid);
  }
  dashNote();
}

function dashRenameBoard(b) {
  const tab = [...document.querySelectorAll(".dash-board.on")][0];
  if (!tab) return;
  const input = dashEl("input", "dash-board-name");
  input.value = b.name; input.maxLength = 40;
  input.setAttribute("aria-label", "Board name");
  tab.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (keep && name && name !== b.name) { b.name = name; dashSave(); }
    dashRender();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

function dashDeleteBoard(board) {
  const n = board.widgets.length;
  const words = n ? "Delete the board \"" + board.name + "\" and its " + n + " widget" + (n === 1 ? "" : "s") + "?"
                  : "Delete the board \"" + board.name + "\"?";
  if (!window.confirm(words)) return;
  dash.doc.boards = dash.doc.boards.filter((b) => b.id !== board.id);
  dash.doc = dashClean(dash.doc);
  dashSave(); dashRender();
}

function dashExampleRows(onPick) {
  const list = dashEl("div", "dash-examples");
  for (const ex of DASH_EXAMPLES) {
    const row = dashEl("div", "dash-example");
    const words = dashEl("div", "dash-example-words");
    words.appendChild(dashEl("div", "dash-example-name", ex.title));
    words.appendChild(dashEl("div", "dash-example-about", ex.about));
    row.appendChild(words);
    row.appendChild(dashButton("Add", "dash-btn", () => onPick(ex)));
    list.appendChild(row);
  }
  return list;
}

function dashAddExample(ex) {
  dashBoard().widgets.push({ id: dashId("w"), title: ex.title, code: ex.code, w: ex.w, h: ex.h, every: ex.every });
  dashSave(); dashRender();
}

function dashEmpty() {
  const box = dashEl("div", "dash-empty");
  box.appendChild(dashEl("h2", null, "Build your own dashboard"));
  box.appendChild(dashEl("p", null,
    "A widget is a few lines of JavaScript that reads the terminal's data and draws it: prices, " +
    "bars, option chains, economic series, the calendar, your own files. Add an example and change " +
    "it, or write one from nothing."));
  box.appendChild(dashExampleRows(dashAddExample));
  const blank = dashEl("div", "dash-example");
  const words = dashEl("div", "dash-example-words");
  words.appendChild(dashEl("div", "dash-example-name", "Your own widget"));
  words.appendChild(dashEl("div", "dash-example-about", "An editor with a live preview and the list of what a widget can call."));
  blank.appendChild(words);
  blank.appendChild(dashButton("Write one", "dash-btn act", () => dashEdit(null)));
  box.appendChild(blank);
  return box;
}

function dashExamples() {
  const old = document.getElementById("dash-pick");
  if (old) { old.remove(); return; }
  const sheet = dashEl("div", "dash-pick");
  sheet.id = "dash-pick";
  const head = dashEl("div", "dash-pick-head");
  head.appendChild(dashEl("div", "dash-pick-title", "Examples"));
  head.appendChild(dashButton("Close", "dash-btn quiet", () => sheet.remove()));
  sheet.appendChild(head);
  sheet.appendChild(dashExampleRows((ex) => { sheet.remove(); dashAddExample(ex); }));
  $("dash").appendChild(sheet);
}

function dashTimeNow() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function dashCard(w) {
  const card = dashEl("div", "dash-card");
  card.dataset.id = w.id;
  card.style.gridColumn = "span " + w.w;
  card.style.gridRow = "span " + w.h;

  const head = dashEl("div", "dash-card-head");
  head.draggable = true;
  const title = dashEl("div", "dash-card-title", w.title);
  const state_ = dashEl("div", "dash-card-state", "");
  head.appendChild(title);
  head.appendChild(state_);
  const frameHost = dashEl("div", "dash-card-body");
  let rec = null;
  const onStatus = (status, message) => {
    state_.classList.toggle("err", status === "error");
    if (status === "error") { state_.textContent = "Stopped"; state_.title = message || ""; }
    else if (status === "ok") { state_.textContent = "Updated " + dashTimeNow(); state_.title = ""; }
    else if (status === "running") { state_.textContent = "Updating…"; }
  };
  head.appendChild(dashButton("↻", "dash-icon", () => { if (rec) dashFrameRun(rec); }, "Run again now"));
  head.appendChild(dashButton("Edit", "dash-card-btn", () => dashEdit(w), "Edit this widget's code"));
  head.appendChild(dashButton("×", "dash-icon", () => {
    if (!window.confirm("Remove the widget \"" + w.title + "\"?")) return;
    const b = dashBoard();
    b.widgets = b.widgets.filter((x) => x.id !== w.id);
    dashSave(); dashRender();
  }, "Remove"));
  card.appendChild(head);
  card.appendChild(frameHost);

  // Reorder: drag a title onto another widget to take its place.
  head.ondragstart = (e) => { e.dataTransfer.setData("text/lse-dash", w.id); e.dataTransfer.effectAllowed = "move"; };
  card.ondragover = (e) => {
    if ([...e.dataTransfer.types].includes("text/lse-dash")) { e.preventDefault(); card.classList.add("drop"); }
  };
  card.ondragleave = () => card.classList.remove("drop");
  card.ondrop = (e) => {
    card.classList.remove("drop");
    const from = e.dataTransfer.getData("text/lse-dash");
    if (!from || from === w.id) return;
    e.preventDefault();
    const b = dashBoard();
    const i = b.widgets.findIndex((x) => x.id === from);
    if (i < 0) return;
    const [moved] = b.widgets.splice(i, 1);
    b.widgets.splice(b.widgets.findIndex((x) => x.id === w.id), 0, moved);
    dashSave(); dashRender();
  };

  // Resize: drag the corner; the widget snaps to the board's columns and rows.
  const grip = dashEl("div", "dash-grip");
  grip.title = "Drag to resize";
  grip.onpointerdown = (e) => {
    e.preventDefault();
    const grid = document.getElementById("dash-grid");
    if (!grid) return;
    grip.setPointerCapture(e.pointerId);
    const colPx = (grid.clientWidth - DASH_GAP_PX * (DASH_COLS - 1)) / DASH_COLS + DASH_GAP_PX;
    const rowPx = DASH_ROW_PX + DASH_GAP_PX;
    const x0 = e.clientX, y0 = e.clientY, w0 = w.w, h0 = w.h;
    grid.classList.add("resizing");   // frames stop taking the pointer
    const move = (ev) => {
      const nw = dashClamp(w0 + (ev.clientX - x0) / colPx, DASH_MIN_W, DASH_COLS, w0);
      const nh = dashClamp(h0 + (ev.clientY - y0) / rowPx, DASH_MIN_H, DASH_MAX_H, h0);
      if (nw !== w.w || nh !== w.h) {
        w.w = nw; w.h = nh;
        card.style.gridColumn = "span " + nw; card.style.gridRow = "span " + nh;
      }
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      grid.classList.remove("resizing");
      if (w.w !== w0 || w.h !== h0) dashSave();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  card.appendChild(grip);

  rec = dashFrameStart(frameHost, w, onStatus);
  return card;
}

/* ── the editor ────────────────────────────────────────────────────── */
function dashReferencePane() {
  const pane = dashEl("div", "dash-ref");
  pane.appendChild(dashEl("div", "dash-ref-title", "What a widget can call"));
  for (const [group, rows] of DASH_REFERENCE) {
    pane.appendChild(dashEl("div", "dash-ref-group", group));
    for (const [sig, about] of rows) {
      const row = dashEl("div", "dash-ref-row");
      row.appendChild(dashEl("code", null, sig));
      row.appendChild(dashEl("div", "dash-ref-about", about));
      pane.appendChild(row);
    }
  }
  pane.appendChild(dashEl("div", "dash-ref-note",
    "A widget reads LSE data and your own files. It cannot place orders, read keys or read a broker's prices, " +
    "and it loads nothing from the internet."));
  return pane;
}

function dashEdit(widget) {
  if (dash.edit) return;
  const isNew = !widget;
  const draft = widget
    ? { id: widget.id, title: widget.title, code: widget.code, w: widget.w, h: widget.h, every: widget.every }
    : { id: dashId("w"), title: "My widget", code: DASH_BLANK, w: 6, h: 6, every: 60 };
  const sheet = dashEl("div", "dash-editor");
  sheet.id = "dash-editor";
  dash.edit = { sheet, rec: null };

  const bar = dashEl("div", "dash-editor-bar");
  const titleBox = dashEl("label", "dash-field");
  titleBox.appendChild(dashEl("span", null, "Title"));
  const title = dashEl("input");
  title.value = draft.title; title.maxLength = 80;
  titleBox.appendChild(title);
  const everyBox = dashEl("label", "dash-field");
  everyBox.appendChild(dashEl("span", null, "Refresh"));
  const every = dashEl("select");
  for (const [secs, words] of DASH_EVERY) {
    const o = dashEl("option", null, words);
    o.value = String(secs);
    if (secs === draft.every) o.selected = true;
    every.appendChild(o);
  }
  everyBox.appendChild(every);
  bar.appendChild(titleBox);
  bar.appendChild(everyBox);
  const acts = dashEl("div", "dash-actions");
  const state_ = dashEl("div", "dash-editor-state", "");
  acts.appendChild(state_);
  acts.appendChild(dashButton("Cancel", "dash-btn quiet", () => close(false)));
  acts.appendChild(dashButton("Run", "dash-btn", () => run(), "Run the code in the preview (Ctrl+Enter)"));
  acts.appendChild(dashButton(isNew ? "Add to board" : "Save", "dash-btn act", () => close(true)));
  bar.appendChild(acts);
  sheet.appendChild(bar);

  const panes = dashEl("div", "dash-editor-panes");
  const left = dashEl("div", "dash-editor-code");
  const code = dashEl("textarea");
  code.value = draft.code;
  code.spellcheck = false;
  code.setAttribute("autocapitalize", "off");
  code.setAttribute("autocomplete", "off");
  code.setAttribute("aria-label", "Widget code");
  left.appendChild(code);
  const right = dashEl("div", "dash-editor-side");
  const preview = dashEl("div", "dash-editor-preview");
  const error = dashEl("pre", "dash-editor-error hidden");
  right.appendChild(preview);
  right.appendChild(error);
  right.appendChild(dashReferencePane());
  panes.appendChild(left);
  panes.appendChild(right);
  sheet.appendChild(panes);

  const onStatus = (status, message) => {
    state_.classList.toggle("err", status === "error");
    state_.textContent = status === "error" ? "Stopped" : status === "ok" ? "Ran " + dashTimeNow()
      : status === "running" ? "Running…" : "";
    error.textContent = status === "error" ? message : "";
    error.classList.toggle("hidden", status !== "error");
  };
  const run = () => {
    const shown = { id: draft.id, title: title.value, code: code.value.slice(0, DASH_CODE_MAX), every: 0 };
    dash.edit.rec = dashFrameStart(preview, shown, onStatus);
  };
  const close = (keep) => {
    if (!dash.edit) return;
    const changed = code.value !== draft.code || title.value !== draft.title || Number(every.value) !== draft.every;
    if (!keep && changed && !window.confirm("Discard your changes to this widget?")) return;
    if (keep) {
      if (code.value.length > DASH_CODE_MAX) {
        onStatus("error", "The code is longer than a widget can hold (" + DASH_CODE_MAX + " characters).");
        return;
      }
      const b = dashBoard();
      const saved = { id: draft.id, title: title.value.trim() || "Widget", code: code.value,
                      w: draft.w, h: draft.h, every: Number(every.value) || 0 };
      const i = b.widgets.findIndex((x) => x.id === draft.id);
      if (i >= 0) b.widgets[i] = saved; else b.widgets.push(saved);
      dashSave();
    }
    dispose();
    if (dash.stale && !keep) { dash.stale = false; dashRemoteChanged(); } else { dash.stale = false; dashRender(); }
  };
  const dispose = () => {
    document.removeEventListener("keydown", keys, true);
    sheet.remove();
    dash.edit = null;
  };
  dash.edit.dispose = dispose;
  const keys = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); run(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close(false); }
  };
  document.addEventListener("keydown", keys, true);
  // Tab indents; Shift+Tab is left to move the focus out.
  code.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const a = code.selectionStart, b = code.selectionEnd;
    code.setRangeText("  ", a, b, "end");
  });

  $("dash").appendChild(sheet);
  code.focus();
  run();
}

/* WORKSPACE > DASHBOARD, opened like its sibling sub-views: the same
   hide-everything sweep, then this page. dashSyncView (called by app.js on
   every section or sub-view change) hides it again when the view moves on. */
function openDash() {
  for (const b of document.querySelectorAll(".rail-btn")) b.classList.remove("active");
  $("rail-workspace").classList.add("active");
  document.title = "Dashboard · LSE Terminal";
  $("side").classList.add("hidden");
  for (const id of ["optpage", "news", "charts", "backtest", "mydata", "econcal", "dataviz",
                    "nbpage", "mlpage", "pyide", "wsx", "lse-connect", "research", "guide", "scrpage"]) {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  }
  closeManualBacktest();
  renderSubrail("workspace", "sub-ws-dash");
  dashOpen();
}

function dashSyncView(activeId) {
  const el = document.getElementById("dash");
  if (!el) return;
  const on = activeId === "sub-ws-dash";
  if (!on && dash.edit) {
    // the view moved away under an open editor: close it without a question
    dash.edit.dispose();
  }
  el.classList.toggle("hidden", !on);
}
