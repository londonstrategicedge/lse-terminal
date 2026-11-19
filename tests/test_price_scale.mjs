// One instrument, one number of places, on every surface of the page. Same
// method as the other .mjs tests here: the shipped functions are cut out of
// app.js by name and run in node:vm against stand-ins.
//
// Near a power of ten an instrument printed different places on different
// surfaces, and from tick to tick: the chart and the ticket "9999.80", the
// sidebar, the fill lines, the dock's Price and History "9999.800", Avg
// 10000.10 beside Price 9999.800. The ticket chose its places by one size,
// its quote's max(bid, ask); everything else by each value's own size.
//
// What is pinned:
//   1. the sidebar's price and spread (fmtQuote, spreadText), the dock's
//      positions and orders, History and the dock's prices in the ticket's
//      lines (acdPx) choose their places by one size per instrument: its
//      current max(bid, ask), as the ticket does, else the value itself;
//      so a bid below a power of ten beside an ask above it, and a tick that
//      crosses it, keep one number of places;
//   2. a placed or filled line shows every place the instrument declares
//      (no cut at about seven significant figures); one that declares none
//      is printed as the dock prints it;
//   3. fmtPx's comment says what it does.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');

function fn(name, optional) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  if (start < 0 && optional) return '';
  assert.ok(start >= 0, 'app.js has no function ' + name);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start + 1, end + 2);
}
function line(startsWith) {
  const start = src.indexOf('\n' + startsWith);
  assert.ok(start >= 0, 'app.js has no line starting ' + startsWith);
  return src.slice(start + 1, src.indexOf('\n', start + 1));
}
// A name ending in "?" is loaded when the page has it.
function load(names, ctx) {
  vm.createContext(ctx);
  for (const n of names) {
    if (n.startsWith('const ')) vm.runInContext(line(n), ctx);
    else if (n.endsWith('?')) vm.runInContext(fn(n.slice(0, -1), true), ctx);
    else vm.runInContext(fn(n), ctx);
  }
  return ctx;
}
const results = [];
async function test(name, f) {
  try { await f(); results.push(true); console.log('ok    ' + name); }
  catch (e) { results.push(false); console.log('FAIL  ' + name + '\n        ' + String(e.message || e).split('\n').slice(0, 12).join('\n        ')); }
}

// a small DOM that keeps what was written: a row's cells are read back from
// the markup it was given
function el(tag = 'div') {
  return { tagName: tag.toUpperCase(), children: [], _html: '', _text: '', className: '', title: '', onclick: null,
           set innerHTML(v) { this._html = String(v); this.children = []; }, get innerHTML() { return this._html; },
           set textContent(v) { this._text = String(v); this.children = []; },
           get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
           appendChild(c) { this.children.push(c); return c; } };
}
const cells = (row) => [...row._html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
function rows(host) {
  const table = host.children.find((c) => c.tagName === 'TABLE');
  const body = table ? table.children.find((c) => c.tagName === 'TBODY') : null;
  return body ? body.children.map(cells) : [];
}

// the venues' declarations: a metal at three places, two coins at nine
const DECLARED = { XAU_USD: 3, 'DOGE/USD': 9, 'ETH/USD': 9, 'BTC/USD': 9, EUR_USD: 5 };
const PRICE_FNS = ['const fmt =', 'const fmtSpread =', 'const decOf =', 'pipSize', 'fmtPx', 'quoteScale?',
                   'srcDigits', 'fmtQuote', 'spreadText'];

// ── 1. the sidebar ─────────────────────────────────────────────────────────
await test('the sidebar: XAU_USD at 9999.80 / 10000.10 prints the places the ticket prints', () => {
  const c = load(PRICE_FNS, { state: { digitsBySym: { ...DECLARED }, catBySym: {}, quotes: {} },
                              Number, Math, isFinite, String });
  c.state.quotes.XAU_USD = { bid: 9999.8, ask: 10000.1 };
  assert.equal(c.fmtQuote('XAU_USD', 9999.8), '9999.80');               // was 9999.800
  assert.equal(c.spreadText('XAU_USD', c.state.quotes.XAU_USD), 'spread: 0.30');
  // the next tick crosses ten thousand: the same places
  c.state.quotes.XAU_USD = { bid: 10000.0, ask: 10000.3 };
  assert.equal(c.fmtQuote('XAU_USD', 10000.0), '10000.00');
  c.state.quotes.XAU_USD = { bid: 9999.7, ask: 10000.0 };
  assert.equal(c.fmtQuote('XAU_USD', 9999.7), '9999.70');
  // both sides below it: three places, as the ticket prints them
  c.state.quotes.XAU_USD = { bid: 9990.5, ask: 9990.8 };
  assert.equal(c.fmtQuote('XAU_USD', 9990.5), '9990.500');
  assert.equal(c.spreadText('XAU_USD', c.state.quotes.XAU_USD), 'spread: 0.300');
  // no quote: the value's own size, as before
  delete c.state.quotes.XAU_USD;
  assert.equal(c.fmtQuote('XAU_USD', 9999.8), '9999.800');
});
await test('the sidebar: DOGE/USD across 0.1 and ETH/USD across 1,000 keep one number of places', () => {
  const c = load(PRICE_FNS, { state: { digitsBySym: { ...DECLARED }, catBySym: {}, quotes: {} },
                              Number, Math, isFinite, String });
  const ticks = (sym, list) => list.map(([bid, ask]) => {
    c.state.quotes[sym] = { bid, ask };
    return [c.fmtQuote(sym, bid), c.spreadText(sym, c.state.quotes[sym])];
  });
  // DOGE: the bid printed 0.09998000 (eight places) and the next tick 0.1000200 (seven)
  assert.deepEqual(ticks('DOGE/USD', [[0.09998, 0.10002], [0.10001, 0.10005], [0.09999, 0.10003]]),
    [['0.0999800', 'spread: 0.0000400'], ['0.1000100', 'spread: 0.0000400'], ['0.0999900', 'spread: 0.0000400']]);
  assert.deepEqual(ticks('DOGE/USD', [[0.09990, 0.09994]]), [['0.09990000', 'spread: 0.00004000']]);
  // ETH: 999.9500 then 1000.020
  assert.deepEqual(ticks('ETH/USD', [[999.95, 1000.05], [1000.02, 1000.12], [999.9, 1000.0]]),
    [['999.950', 'spread: 0.100'], ['1000.020', 'spread: 0.100'], ['999.900', 'spread: 0.100']]);
  assert.deepEqual(ticks('ETH/USD', [[998.1, 998.3]]), [['998.1000', 'spread: 0.2000']]);
});

// ── 1. the dock, History, and the dock's prices in the ticket's lines ───────
function dock(quotes) {
  const host = el();
  const c = load(['const fmt =', 'fmtPx', 'quoteScale?', 'tpbDigits', 'dockQuote', 'acdPx', 'acdPxLine?',
                  'acdRenderPositions', 'acdRenderOrders', 'acdRenderHistory', 'tpbPlainReason', 'readResult'], {
    $: (id) => (id === 'acd-body' ? host : el()), document: { createElement: (t) => el(t) },
    tpb: { broker: 'my-oanda', catalog: Object.entries(DECLARED).map(([symbol, digits]) => ({ symbol, digits })),
           quotes },
    tpx: { dockTab: 'pos', fills: null },
    tpbViaConnector: () => true, escHtml: (s) => String(s), acdPnl: (v) => (v == null ? '' : String(v)),
    acdShowPosMenu() {}, acdCloseFull() {}, acdCancelOrder() {},
    fills: [], fetch: async () => ({ ok: true, status: 200, json: async () => c.fills, text: async () => '' }),
    Number, Math, Map, isFinite, String, JSON, Date, encodeURIComponent });
  c.host = host;
  return c;
}
await test('the dock: Avg and Price of one XAU_USD position share their places', () => {
  const c = dock({ XAU_USD: { bid: 9999.8, ask: 10000.1 } });
  assert.equal(c.acdPx('XAU_USD', 9999.8), '9999.80');
  assert.equal(c.acdPx('XAU_USD', 10000.1), '10000.10');
  c.acdRenderPositions([{ id: 'XAU_USD', symbol: 'XAU_USD', qty: 2, avg_price: 10000.1, unrealized_pnl: -0.6 },
                        { id: 'XAU_USD-s', symbol: 'XAU_USD', qty: -1, avg_price: 9999.8, unrealized_pnl: -0.3 }]);
  // Symbol, Side, Qty, Avg price, Price (the long marked at the bid, the short at the ask)
  assert.deepEqual(rows(c.host).map((r) => r.slice(3, 5)), [['10000.10', '9999.80'], ['9999.80', '10000.10']]);
  c.acdRenderOrders([{ id: 'o1', symbol: 'XAU_USD', side: 'buy', otype: 'limit', qty: 1, price: 9990.5 }]);
  // Order price and Price (a buy is marked at the ask): one size, the quote's
  assert.deepEqual(rows(c.host).map((r) => r.slice(4, 6)), [['9990.50', '10000.10']]);
});
await test('History: fills of one instrument share their places', async () => {
  const c = dock({ XAU_USD: { bid: 9999.8, ask: 10000.1 }, 'ETH/USD': { bid: 999.95, ask: 1000.05 } });
  c.tpx.dockTab = 'hist';
  c.fills = [{ time: 2, symbol: 'XAU_USD', side: 'sell', qty: 1, price: 9999.8 },
             { time: 1, symbol: 'XAU_USD', side: 'buy', qty: 2, price: 10000.1 },
             { time: 0, symbol: 'ETH/USD', side: 'buy', qty: 0.5, price: 999.95 }];
  await c.acdRenderHistory();
  assert.deepEqual(rows(c.host).map((r) => r[4]), ['9999.80', '10000.10', '999.950']);
});
await test('an instrument that declares no places: one scale too, by the page\'s own rule', () => {
  // the sidebar (fmt by size: 1 place from 1000, 2 from 10, else 4)
  const s = load(PRICE_FNS, { state: { digitsBySym: {}, catBySym: {}, quotes: {} }, Number, Math, isFinite, String });
  s.state.quotes.PLAIN = { bid: 999.9, ask: 1000.1 };
  assert.equal(s.fmtQuote('PLAIN', 999.9), '999.9');                    // was 999.90 beside 1000.1
  s.state.quotes.PLAIN = { bid: 9.995, ask: 10.005 };
  assert.equal(s.fmtQuote('PLAIN', 9.98), '9.98');                      // was 9.9800
  delete s.state.quotes.PLAIN;
  assert.equal(s.fmtQuote('PLAIN', 999.9), '999.90', 'no quote: its own size');
  // the dock
  const c = dock({ PLAIN: { bid: 999.9, ask: 1000.1 } });
  assert.deepEqual([c.acdPx('PLAIN', 999.9), c.acdPx('PLAIN', 1000.1)], ['999.9', '1000.1']);
});
await test('the dock with no quote for an instrument: the value\'s own size, as before', () => {
  const c = dock({});
  assert.equal(c.acdPx('XAU_USD', 9999.8), '9999.800');
  assert.equal(c.acdPx('XAU_USD', 10000.1), '10000.10');
  assert.equal(c.acdPx('DOGE/USD', 0.09998), '0.09998000');
});

// ── 2. placed and filled lines: every declared place ───────────────────────
await test('a placed or filled line shows the instrument\'s declared places, whole', async () => {
  const sent = [], said = [];
  const els = { 'tpx-qty': { value: '1' }, 'tpx-sl': { value: '' }, 'tpx-tp': { value: '' } };
  let answer = null, spec = { symbol: 'XAU_USD', digits: 3 };
  const c = load(['const fmt =', 'fmtPx', 'quoteScale?', 'tpbDigits', 'dockQuote', 'acdPx', 'acdPxLine?',
    'tpbPlainReason', 'tpbOrder', 'tpxPlacePending', 'tpxPlacing', 'tpxNewClientId', 'tpxSameOrder',
    'tpxSameRequest', 'tpxHeldFor', 'tpxHeldDone', 'tpxRenderAgain', 'tpxHeldOverlap', 'tpxHeldSymbol',
    'tpxHeldGate', 'tpxSay', 'tpxHeldElse?', 'tpxHeldItems?', 'tpxConnected?', 'tpxSending?', 'tpxNow?'], {
    $: (id) => els[id],
    tpb: { broker: 'my-oanda', catalog: Object.entries(DECLARED).map(([symbol, digits]) => ({ symbol, digits })),
           quotes: { XAU_USD: { bid: 9999.8, ask: 10000.1 } } },
    tpx: { acct: { id: 'a' }, held: [], placing: false, positions: [], orders: [] }, state: { symbol: 'XAU_USD' },
    brokerPicker: { rows: [] },
    tpbViaConnector: () => true, tpbSpec: () => spec,
    tpxSetMsg: (m, k) => said.push([m, k]), tpbNotArmedText: (d) => String(d),
    readResult: async (r) => r.json(), acdShowOrdersTab() {},
    tpbRefreshAccount() {}, tpbRefreshPositions() {},
    tpxRefreshAccount() {}, tpxRefreshPositions() {}, tpxRefreshOrders() {},
    fetch: async (url, o) => { sent.push([url, JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => answer }; },
    crypto: { getRandomValues: (b) => b }, Uint8Array,
    parseFloat, JSON, String, Number, Math, Map, Set, Error, isFinite, Array, Object, Promise, Date });
  answer = { status: 'filled', fill: { price: 9999.8 } };
  await c.tpbOrder('sell');
  assert.deepEqual(said.at(-1), ['sell 1 XAU_USD filled @ 9999.800', 'ok']);           // as the venue declares it
  els['tpx-qty'].value = '2';
  answer = { status: 'filled', fill: { price: 10000.1 } };
  await c.tpbOrder('buy');
  assert.deepEqual(said.at(-1), ['buy 2 XAU_USD filled @ 10000.100', 'ok']);           // was 10000.10, beside 9999.800
  // a coin at nine: no cut at seven significant figures
  spec = { symbol: 'DOGE/USD', digits: 9 };
  els['tpx-qty'].value = '100';
  answer = { status: 'filled', fill: { price: 0.09998 } };
  await c.tpbOrder('buy');
  assert.deepEqual(said.at(-1), ['buy 100 DOGE/USD filled @ 0.099980000', 'ok']);
  spec = { symbol: 'BTC/USD', digits: 9 };
  answer = { status: 'resting' };
  await c.tpxPlacePending('buy', 'limit', 73154.66238472031, 0.5);
  assert.deepEqual(said.at(-1), ['buy limit 0.5 BTC/USD @ 73154.662384720 placed', 'ok']);   // was 73154.66
  assert.equal(sent.at(-1)[1].price, 73154.66238472031, 'what is sent is the number, never the text');
  // an instrument that declares nothing: as the dock prints it
  spec = { symbol: 'PLAIN' };
  els['tpx-qty'].value = '3';
  answer = { status: 'filled', fill: { price: 12.3456 } };
  await c.tpbOrder('buy');
  assert.deepEqual(said.at(-1), ['buy 3 PLAIN filled @ 12.35', 'ok']);
});

// ── 3. fmtPx's comment ─────────────────────────────────────────────────────
await test('fmtPx\'s comment says what it does, and claims nothing it does not', () => {
  const at = src.indexOf('\nfunction fmtPx(');
  const from = src.lastIndexOf('\n', src.lastIndexOf('\n', at) - 1);
  let start = at;
  // the comment lines right above it, as one text
  for (let i = src.lastIndexOf('\n', at - 1); i > 0 && src.slice(i + 1, i + 3) === '//'; i = src.lastIndexOf('\n', i - 1)) start = i;
  assert.ok(from > 0 && start < at, 'fmtPx has a comment');
  const said = src.slice(start, at).split('\n').map((l) => l.replace(/^\/\/ ?/, '').trim()).join(' ').replace(/\s+/g, ' ');
  for (const claim of ['so the ticket, the sidebar and the fills show an instrument at the places its chart labels do',
                       'never fewer than two', 'Never the exponent form']) {
    assert.ok(!said.includes(claim), 'the comment still says: ' + claim);
  }
  for (const says of ['max(2, 6 - floor(log10(size)))', '`scale`', 'No zero is trimmed', 'quoteScale',
                      'fewer than two only when fewer are declared']) {
    assert.ok(said.includes(says), 'the comment does not say: ' + says);
  }
});

const bad = results.filter((r) => !r).length;
if (bad) { console.log(`test_price_scale.mjs: ${bad} of ${results.length} blocks FAILED`); process.exitCode = 1; }
else console.log(`test_price_scale.mjs: ok (${results.length} blocks)`);
