// What a connected broker's data looks like on the page. Same method as the
// other .mjs tests here: cut the function under test out of app.js by name
// and run it in node:vm against hand-made stubs, so what is tested is the
// shipped text.
//
// What is pinned, and why it matters:
//   1. PRICES. A venue declares how many decimals it quotes an instrument to
//      (`digits`). One venue declares nine for crypto, and the ticket printed
//      "73100.500000000". Wherever the page prints a broker's price or
//      spread it prints by the chart's rule (tests/test_chart_price_digits.mjs
//      holds the two alike): that many decimals where a price of its size
//      can use them (about seven significant figures), else what it can
//      use, never fewer than two, and no zero trimmed, so every label of an
//      instrument shows the same places; a spread at its price's places. A
//      line that says an order was placed or filled shows every declared
//      place (tests/test_price_scale.mjs holds one instrument's places across
//      the page). What an order SENDS is never the printed text.
//   2. A FAILED CANDLE LOAD says so in the chart area, in the source's own
//      words, with a Retry, and the previous instrument's bars leave the
//      screen. A page shorter than the one asked for is drawn, once.
//   3. ENTER IN THE SYMBOL BOX takes the exact match whatever case was
//      typed, or else the first suggestion, instead of charting the text.
//   4. A CHART THAT IS LOADING shows no bar of the instrument before it, and
//      leaves nothing of it for a tick to build on.
//   5. A BROKER'S SHORT PAGE is asked for again twice at most while it
//      grows; a chart the user has moved or zoomed is not redrawn under them.
//   6. THE LATEST TEXT TYPED WINS: a suggestion answer for an earlier text
//      is dropped.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');

function fn(name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'app.js has no function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return src.slice(start, end + 2);
}
// A one-line definition ("const fmt = ...;"), cut by how it starts.
function line(startsWith) {
  const start = src.indexOf('\n' + startsWith);
  assert.ok(start >= 0, 'app.js has no line starting ' + startsWith);
  return src.slice(start + 1, src.indexOf('\n', start + 1));
}
function load(names, ctx = {}) {
  vm.createContext(ctx);
  for (const n of names) vm.runInContext(n.startsWith('const ') ? line(n) : fn(n), ctx);
  return ctx;
}
const tick = () => new Promise((r) => setImmediate(r));

// ── 1. prices ─────────────────────────────────────────────────────────────
const PRICE_FNS = ['const fmt =', 'const fmtSpread =', 'const decOf =', 'pipSize',
  'fmtPx', 'quoteScale', 'srcDigits', 'fmtQuote', 'fmtLevel', 'spreadText'];
{
  const c = load(PRICE_FNS, { state: { digitsBySym: {}, catBySym: {} }, Number, Math, isFinite, String });

  // the three numbers of the fault: a spread at its price's places
  assert.equal(c.fmtPx(73100.5, 9), '73100.50');
  assert.equal(c.fmtPx(73116.6, 9), '73116.60');
  assert.equal(c.fmtPx(73116.6 - 73100.5, 9, 73116.6), '16.10');
  assert.equal(c.fmtPx(0.0000189, 9), '0.000018900');
  // cut to what a price of its size can use, as the chart cuts it
  assert.equal(c.fmtPx(73154.662, 9), '73154.66');
  assert.equal(c.fmtPx(0.123456789, 9), '0.1234568');
  // every price of an instrument at its places, as the chart prints them:
  // BUY 1.28040 beside SELL 1.28022, not 1.2804
  assert.equal(c.fmtPx(1.08512, 5), '1.08512');
  assert.equal(c.fmtPx(1.085, 5), '1.08500');
  assert.equal(c.fmtPx(1.2804, 5), '1.28040');
  assert.equal(c.fmtPx(1.1, 5), '1.10000');
  assert.equal(c.fmtPx(3, 5), '3.00000');
  // at most the declared decimals, never more
  assert.equal(c.fmtPx(187.456789, 2), '187.46');
  assert.equal(c.fmtPx(187.4, 2), '187.40');
  assert.equal(c.fmtPx(187.4, 1), '187.4');
  assert.equal(c.fmtPx(5012.6, 0), '5013');
  // never the exponent form, however small
  assert.equal(c.fmtPx(0.00000002, 9), '0.000000020');
  assert.equal(c.fmtPx(2e-8, 9), '0.000000020');
  assert.equal(c.fmtPx(1e-12, 9), '0.000000000');
  // not a price: nothing printed, never "NaN"
  for (const bad of [null, undefined, '', 'abc', NaN, Infinity]) assert.equal(c.fmtPx(bad, 9), '');
  // a price that arrives as text is still a price
  assert.equal(c.fmtPx('73100.5', 9), '73100.50');
  // the rule itself, over many values: no more decimals than declared, as
  // many as about seven significant figures of the price allow, never fewer
  // than two, none trimmed; the same number as rounding to those places
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 4000; i++) {
    const digits = Math.floor(rnd() * 10);
    const value = Math.pow(10, Math.floor(rnd() * 12) - 7) * (1 + rnd() * 9);
    const out = c.fmtPx(value, digits);
    assert.ok(/^\d+(\.\d+)?$/.test(out), `${value} at ${digits} printed ${out}`);
    const dec = out.includes('.') ? out.split('.')[1].length : 0;
    const fits = Math.max(2, 6 - Math.floor(Math.log10(value)));
    assert.equal(dec, Math.min(digits, fits), `${value} at ${digits} printed ${out}`);
    assert.equal(Number(out), Number(value.toFixed(dec)));
  }

  // the sidebar: from the source's digits when it declares them
  c.state.digitsBySym = { 'BONK/USD': 9, 'BTC/USD': 9, AAPL: 2, BAD1: '9', BAD2: 2.5, BAD3: -1, BAD4: 99 };
  assert.equal(c.fmtQuote('BONK/USD', 0.0000189), '0.000018900'); // was "0.0000"
  assert.equal(c.fmtQuote('BTC/USD', 73100.5), '73100.50');
  assert.equal(c.fmtQuote('AAPL', 187.4), '187.40');
  // a source that declares none keeps the page's own rule, unchanged
  assert.equal(c.fmtQuote('EUR/USD', 1.08512), '1.0851');
  assert.equal(c.fmtQuote('ES.F', 5012.25), '5012.3');
  // a declared value that is not a count of decimals is not believed
  for (const s of ['BAD1', 'BAD2', 'BAD3', 'BAD4']) {
    assert.equal(c.srcDigits(s), null);
    assert.equal(c.fmtQuote(s, 12.3456), '12.35');
  }
  assert.equal(c.srcDigits('AAPL'), 2);
  delete c.state.digitsBySym;                      // before the first catalog
  assert.equal(c.fmtQuote('AAPL', 187.4), '187.40');
  c.state.digitsBySym = { 'BONK/USD': 9, 'BTC/USD': 9, AAPL: 2, EURUSD: 5 };

  // the spread under a sidebar price
  assert.equal(c.spreadText('BONK/USD', { bid: 0.00001888, ask: 0.0000189 }), 'spread: 0.000000020'); // was "2e-8"
  assert.equal(c.spreadText('BTC/USD', { bid: 73100.5, ask: 73116.6 }), 'spread: 16.10');
  assert.equal(c.spreadText('AAPL', { bid: 187.4, ask: 187.42 }), 'spread: 0.02');
  assert.equal(c.spreadText('AAPL', { bid: 187.4, ask: 187.4 }), '');
  assert.equal(c.spreadText('AAPL', null), '');
  // undeclared: exactly what it printed before
  assert.equal(c.spreadText('ES.F', { bid: 5012, ask: 5012.25 }), 'spread: 0.25');
  assert.equal(c.spreadText('XYZ', { bid: 10, ask: 26.1 }), 'spread: 16.10');
  // FX rows of a source that says "forex" keep pips
  c.state.catBySym = { 'EUR/USD': 'forex' };
  assert.equal(c.spreadText('EUR/USD', { bid: 1.08500, ask: 1.08512 }), 'spread: 1.2 pips');

  // a level read off the chart: the digits, but no pixel noise
  assert.equal(c.fmtLevel('BTC/USD', 73154.66238472031), '73154.66');
  assert.equal(c.fmtLevel('BONK/USD', 0.000018923456), '0.000018923');   // fmt printed "0.0000"
  assert.equal(c.fmtLevel('AAPL', 187.4567), '187.46');
  assert.equal(c.fmtLevel('EURUSD', 1.085123), '1.08512');
  assert.equal(c.fmtLevel('ES.F', 5012.26), '5012.3');                  // undeclared: the page's rule
  assert.equal(c.fmtLevel('BTC/USD', 0), '0.0000');
}

// the dock and the ticket's messages: the ticket BROKER's digits
{
  let via = true;
  const c = load(['const fmt =', 'fmtPx', 'quoteScale', 'tpbDigits', 'dockQuote', 'acdPx'], {
    tpb: { catalog: [{ symbol: 'BTC/USD', digits: 9 }, { symbol: 'AAPL', digits: 2 },
                     { symbol: 'NODIGITS' }, { symbol: 'TEXT', digits: 'nine' }], quotes: {} },
    state: { quotes: {} }, tpbViaConnector: () => via, Number, Math, Map, isFinite });
  assert.equal(c.acdPx('BTC/USD', 73154.662), '73154.66');        // the dock read 73154.7; the chart 73,154.66
  assert.equal(c.acdPx('BTC/USD', 73100.5), '73100.50');
  assert.equal(c.acdPx('AAPL', 187.456), '187.46');
  assert.equal(c.acdPx('NODIGITS', 73154.662), '73154.7');        // undeclared: the page's rule
  assert.equal(c.acdPx('TEXT', 73154.662), '73154.7');
  assert.equal(c.acdPx('UNLISTED', 12.3456), '12.35');
  // another broker's catalog replaces the lookup
  c.tpb.catalog = [{ symbol: 'BTC/USD', digits: 1 }];
  assert.equal(c.acdPx('BTC/USD', 73154.662), '73154.7');
  assert.equal(c.acdPx('AAPL', 5187.456), '5187.5');              // no longer listed: the page's rule
  // the practice account is not a connector: its prices are untouched
  c.tpb.catalog = [{ symbol: 'BTC/USD', digits: 9 }];
  via = false;
  assert.equal(c.acdPx('BTC/USD', 73154.662), '73154.7');
}

// the ticket's three numbers
{
  const el = {};
  const $ = (id) => (el[id] = el[id] || { textContent: '' });
  let spec = { symbol: 'BTC/USD', name: 'Bitcoin', digits: 9 };
  const c = load(['fmtPx', 'tpbUpdateQuote'], {
    $, tpbSpec: () => spec, tpxSetLogo() {}, tpxRenderMargin() {},
    tpb: { quotes: { 'BTC/USD': { bid: 73100.5, ask: 73116.6 }, EURUSD: { bid: 1.085, ask: 1.08512 },
                     AAPL: { bid: 187.4, ask: 187.42 }, QUIET: {} } },
    Number, Math, isFinite });
  c.tpbUpdateQuote();
  assert.equal(el['tpx-bid'].textContent, '73100.50');       // was 73100.500000000
  assert.equal(el['tpx-ask'].textContent, '73116.60');       // was 73116.600000000
  assert.equal(el['tpx-spread'].textContent, '16.10');       // was 16.100000000
  spec = { symbol: 'AAPL', digits: 2 };
  c.tpbUpdateQuote();
  assert.deepEqual([el['tpx-bid'].textContent, el['tpx-ask'].textContent, el['tpx-spread'].textContent],
    ['187.40', '187.42', '0.02']);
  spec = { symbol: 'EURUSD' };                               // no digits declared: five, as before
  c.tpbUpdateQuote();
  assert.deepEqual([el['tpx-bid'].textContent, el['tpx-ask'].textContent, el['tpx-spread'].textContent],
    ['1.085', '1.08512', '0.00012']);
  spec = { symbol: 'EURUSD', digits: 5 };                    // declared: every number at its five places
  c.tpbUpdateQuote();
  assert.deepEqual([el['tpx-bid'].textContent, el['tpx-ask'].textContent, el['tpx-spread'].textContent],
    ['1.08500', '1.08512', '0.00012']);
  // one size for the three: a bid below a power of ten beside an ask above it
  c.tpb.quotes.XAU = { bid: 9999.9, ask: 10000.15 };
  spec = { symbol: 'XAU', digits: 3 };
  c.tpbUpdateQuote();
  assert.deepEqual([el['tpx-bid'].textContent, el['tpx-ask'].textContent, el['tpx-spread'].textContent],
    ['9999.90', '10000.15', '0.25']);
  spec = { symbol: 'QUIET', digits: 9 };                     // no quote yet
  c.tpbUpdateQuote();
  assert.deepEqual([el['tpx-bid'].textContent, el['tpx-ask'].textContent, el['tpx-spread'].textContent],
    ['–', '–', '–']);
}

// what an order SENDS is the number, never the printed text
{
  const sent = [], said = [];
  const el = { 'tpx-qty': { value: '0.001' }, 'tpx-sl': { value: '' }, 'tpx-tp': { value: '73999.123456789' } };
  let answer = { status: 'filled', fill: { price: 73154.662 } };
  const c = load(['const fmt =', 'fmtPx', 'quoteScale', 'tpbDigits', 'dockQuote', 'acdPx', 'acdPxLine',
    'tpbPlainReason', 'tpbOrder', 'tpxPlacePending',
    'tpxPlacing', 'tpxNewClientId', 'tpxSameOrder', 'tpxHeldFor', 'tpxHeldDone', 'tpxRenderAgain',
    'tpxSameRequest', 'tpxHeldOverlap', 'tpxHeldGate', 'tpxSay', 'tpxHeldElse', 'tpxHeldItems', 'tpxSending',
    'tpxNow'], {
    $: (id) => el[id],
    tpb: { broker: 'alp', catalog: [{ symbol: 'BTC/USD', digits: 9 }], quotes: {} },
    tpx: { acct: { id: 'a' }, held: [], placing: false }, state: { symbol: 'BTC/USD' },
    tpbViaConnector: () => true, tpbSpec: () => ({ symbol: 'BTC/USD', digits: 9 }),
    tpxSetMsg: (m, k) => said.push([m, k]), tpbNotArmedText: (d) => String(d),
    readResult: async (r) => r.json(), acdShowOrdersTab() {},
    tpbRefreshAccount() {}, tpbRefreshPositions() {},
    tpxRefreshAccount() {}, tpxRefreshPositions() {}, tpxRefreshOrders() {},
    fetch: async (url, o) => { sent.push([url, JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => answer }; },
    parseFloat, JSON, String, Number, Math, Map, Set, Error, isFinite, Date });
  // each order also carries the client_id made for it (SPEC 2), and nothing else
  const asSent = ([url, body]) => {
    const { client_id: cid, ...rest } = body;
    assert.match(cid, /^lset-[0-9a-f]{12}$/);
    return [url, rest];
  };

  await c.tpbOrder('buy');
  assert.deepEqual(asSent(sent[0]), ['/api/broker/order',
    { broker: 'alp', symbol: 'BTC/USD', side: 'buy', qty: 0.001, tp: 73999.123456789 }]);
  // a filled or placed line: every place the venue declares (no cut at
  // seven significant figures; the dock and the ticket still cut)
  assert.deepEqual(said.at(-1), ['buy 0.001 BTC/USD filled @ 73154.662000000', 'ok']);
  answer = { status: 'filled', fill: { price: 73100.5 } };
  await c.tpbOrder('sell');
  assert.deepEqual(said.at(-1), ['sell 0.001 BTC/USD filled @ 73100.500000000', 'ok']);
  answer = { status: 'filled' };                              // a fill with no price reported
  await c.tpbOrder('sell');
  assert.deepEqual(said.at(-1), ['sell 0.001 BTC/USD filled @ ', 'ok']);

  // a level clicked on the chart goes out exactly as clicked
  const clicked = 73154.66238472031;
  answer = { status: 'resting' };
  await c.tpxPlacePending('buy', 'limit', clicked, 0.5);
  assert.deepEqual(asSent(sent.at(-1)), ['/api/broker/order/pending',
    { broker: 'alp', symbol: 'BTC/USD', side: 'buy', qty: 0.5, type: 'limit', price: clicked }]);
  assert.equal(sent.at(-1)[1].price, clicked);
  assert.deepEqual(said.at(-1), ['buy limit 0.5 BTC/USD @ 73154.662384720 placed', 'ok']);
}

// the source's rows carry their digits into the page (loadInstruments)
{
  const rows = [{ symbol: 'AAPL', name: 'Apple', category: 'Stocks', digits: 2 },
                { symbol: 'BTC/USD', name: 'Bitcoin', category: 'Crypto', digits: 9 },
                { symbol: 'PLAIN', name: 'No digits', category: 'Stocks' }];
  let answer = rows, hold = null;
  const options = { innerHTML: '' };
  const c = load(['loadInstruments'], {
    state: { provider: 'broker:alp', lseConfigured: false }, encodeURIComponent, setTimeout,
    fetch: async () => { if (hold) await hold; return { ok: true, json: async () => answer, headers: { get: () => '3' } }; },
    $: () => options, renderWatchlist() {}, status() {}, chartPushDigits() {}, Number, String });
  await c.loadInstruments('');
  assert.deepEqual({ ...c.state.digitsBySym }, { AAPL: 2, 'BTC/USD': 9 });
  // a search answer adds what it found and returns the list it offered,
  // the exact symbol first whatever its place in the source's answer
  answer = [{ symbol: 'AAPB', name: 'b' }, { symbol: 'XAAP', name: 'x' }, { symbol: 'AAP', name: 'a', digits: 3 }];
  const ranked = await c.loadInstruments('aap');
  assert.deepEqual([...ranked].map((i) => i.symbol), ['AAP', 'AAPB', 'XAAP']);
  assert.deepEqual({ ...c.state.digitsBySym }, { AAPL: 2, 'BTC/USD': 9, AAP: 3 });
  assert.equal(c.state.suggest.provider, 'broker:alp');
  assert.equal(c.state.suggest.query, 'aap');
  assert.deepEqual([...c.state.suggest.items].map((i) => i.symbol), ['AAP', 'AAPB', 'XAAP']);
  // an answer that lands after the source was switched belongs to nobody
  let release; hold = new Promise((r) => (release = r));
  answer = [{ symbol: 'OLD', name: 'old source', digits: 7 }];
  const late = c.loadInstruments('old');
  c.state.provider = 'lse';
  hold = null; release(); await late;
  assert.equal(c.state.digitsBySym.OLD, undefined);
  assert.equal(c.state.suggest.query, 'aap');
  // a fresh catalog starts the lookup again
  c.state.provider = 'broker:alp';
  answer = [{ symbol: 'ONLY', name: 'only', category: 'Stocks', digits: 4 }];
  await c.loadInstruments('');
  assert.deepEqual({ ...c.state.digitsBySym }, { ONLY: 4 });
}

// ── 2. a failed candle load ───────────────────────────────────────────────
function chartFixture(over = {}) {
  const c = {
    state: { provider: 'broker:alp', symbol: 'AAPL', timeframe: '1h', instruments: [],
             watchlists: {}, chartMounted: true, prices: {}, quotes: {}, priceTimes: {},
             candleData: [{ time: 3600, open: 1, high: 2, low: 1, close: 2, volume: 0 }],
             lastBar: { time: 3600, open: 1, high: 2, low: 1, close: 2 },
             engineIndicators: { sma: {} }, candleKey: 'broker:alp|AAPL|1h', ...over.state },
    said: [], notes: [], pushed: [], urls: [], loading: 0, stops: 0, watches: [],
    updateWindowTitle() {}, indicatorQuery: () => '',
    status(m) { c.said.push(m); },
    pushToChart() { c.pushed.push(c.state.candleData.length); },
    recoverUnavailableSymbol: () => false,
    chartNote(kind, detail) { c.notes.push([kind, detail]); },
    chartNoteLoading() { c.loading++; },
    chartGrowStop() { c.stops++; },
    chartGrowWatch(seq, want, url, asked, got) { c.watches.push([want, url, asked, got]); },
    // what the real tick handler needs (it is run against a load in flight)
    savePriceCache() {}, document: { querySelectorAll: () => [] }, CSS: { escape: (s) => s },
    TF_SECONDS: { '1m': 60, '1h': 3600, '4h': 14400 }, TICK_MAX_BARS: 1000, decOf: () => 2,
    fetch: over.fetch, encodeURIComponent, String, Date, Math,
  };
  const realFetch = c.fetch;
  c.fetch = async (u) => { c.urls.push(u); return realFetch(u); };
  vm.createContext(c);
  for (const n of ['loadChart', 'sourcePriceTime', 'acceptPriceTime', 'onTick']) vm.runInContext(fn(n), c);
  return c;
}
const bars = (n) => Array.from({ length: n }, (_, i) => [1000 + i * 3600, 1, 2, 1, 2, 5]);
const SLOW = 'candles failed: internal: Alpaca was too slow to page 5000 bars; ask for fewer';
{
  // another instrument's bars are on screen and the new one's request fails
  let c = chartFixture({ state: { symbol: 'BTC/USD' },
    fetch: async () => ({ ok: false, status: 502, json: async () => ({ detail: SLOW }) }) });
  await c.loadChart();
  assert.equal(c.state.candleData.length, 0);                 // nothing stale left
  assert.equal(c.state.lastBar, null);                      // and no tick can build on it
  assert.deepEqual({ ...c.state.engineIndicators }, {});
  assert.equal(c.state.candleKey, '');
  assert.deepEqual(c.pushed, [0, 0]);                       // told at the start, and again on failing
  assert.deepEqual(c.notes, [['loading', ''], ['fail', SLOW]]);   // the chart area says why
  assert.equal(c.said.at(-1), 'error: ' + SLOW);            // the header still does
  assert.equal(c.urls.length, 1);                           // and nothing asked again
  assert.deepEqual(c.watches, []);                          // a failed load is not watched

  // the same instrument's own bars: a failed reload is still a failed load
  c = chartFixture({ fetch: async () => ({ ok: false, status: 502, json: async () => ({ detail: SLOW }) }) });
  await c.loadChart();
  assert.equal(c.state.candleData.length, 0);
  assert.equal(c.state.lastBar, null);                      // nor a bar for a tick to build on
  assert.equal(c.state.candleKey, '');
  assert.deepEqual(c.notes, [['fail', SLOW]]);
  assert.deepEqual(c.pushed, [0]);
  assert.equal(c.loading, 1);

  // an answer with no JSON: the status code is the detail
  c = chartFixture({ fetch: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) });
  await c.loadChart();
  assert.deepEqual(c.notes, [['fail', 500]]);
  assert.equal(c.state.candleData.length, 0);

  // the engine itself does not answer: a failed load, not a rejection
  c = chartFixture({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await c.loadChart();
  assert.equal(c.notes.length, 1);
  assert.equal(c.notes[0][0], 'fail');
  assert.match(String(c.notes[0][1]), /engine did not answer \(Failed to fetch\)/);
  assert.match(c.said.at(-1), /^error: the Terminal's engine did not answer/);
  assert.equal(c.state.candleData.length, 0);

  // an INDICATOR failed over this chart's own bars (400): the bars are right
  c = chartFixture({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ detail: 'period must be > 0' }) }) });
  await c.loadChart();
  assert.equal(c.state.candleData.length, 1);
  assert.equal(c.state.lastBar.close, 2);
  assert.deepEqual(c.notes, []);
  assert.deepEqual(c.pushed, []);
  assert.equal(c.said.at(-1), 'error: period must be > 0');
  // ...but not over another instrument's bars
  c = chartFixture({ state: { symbol: 'BTC/USD' },
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ detail: 'period must be > 0' }) }) });
  await c.loadChart();
  assert.equal(c.state.candleData.length, 0);
  assert.deepEqual(c.notes, [['loading', ''], ['fail', 'period must be > 0']]);
  // ...nor another timeframe's
  c = chartFixture({ state: { timeframe: '4h' },
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ detail: 'x' }) }) });
  await c.loadChart();
  assert.equal(c.state.candleData.length, 0);
  assert.equal(c.notes.at(-1)[0], 'fail');

  // a failure that lands after a newer pick touches nothing
  let release; const held = new Promise((r) => (release = r));
  let n = 0;
  c = chartFixture({ state: { symbol: 'SLOWONE' }, fetch: async () => (++n === 1
    ? { ok: false, status: 502, json: () => held }
    : { ok: true, json: async () => ({ candles: bars(3) }) }) });
  const old = c.loadChart();
  await tick();
  c.state.symbol = 'AAPL';
  await c.loadChart();
  release({ detail: SLOW });
  await old;
  assert.equal(c.state.candleData.length, 3);
  assert.equal(c.state.candleKey, 'broker:alp|AAPL|1h');
  assert.deepEqual(c.notes, [['loading', ''], ['loading', ''], ['', '']]);
  assert.deepEqual(c.pushed, [0, 0, 3]);

  // FEWER bars than the 5000 asked for: drawn as they are
  c = chartFixture({ state: { symbol: 'NEWLY' }, fetch: async () => ({ ok: true, json: async () => ({ candles: bars(37) }) }) });
  await c.loadChart();
  assert.match(c.urls[0], /[?&]limit=5000(&|$)/);
  assert.equal(c.urls.length, 1);
  assert.equal(c.state.candleData.length, 37);
  assert.equal(c.state.candleData[0].time, 1000);           // oldest first, as sent
  assert.equal(c.state.lastBar.time, 1000 + 36 * 3600);
  assert.deepEqual(c.pushed, [0, 37]);
  assert.deepEqual(c.notes, [['loading', ''], ['', '']]);   // no note left: not an error
  assert.equal(c.said.at(-1), '');
  assert.equal(c.state.candleKey, 'broker:alp|NEWLY|1h');
  // the load itself asks once; what may be asked again is handed to the
  // watch, with this load's own request and how many of how many came back
  assert.deepEqual(c.watches, [['broker:alp|NEWLY|1h', c.urls[0], 5000, 37]]);
  await tick(); await tick();
  assert.equal(c.urls.length, 1);
  // one bar is still a chart
  c = chartFixture({ fetch: async () => ({ ok: true, json: async () => ({ candles: bars(1) }) }) });
  await c.loadChart();
  assert.deepEqual(c.notes, [['', '']]);

  // no bars at all: said in the chart area, without the word "error"
  c = chartFixture({ fetch: async () => ({ ok: true, json: async () => ({ candles: [] }) }) });
  await c.loadChart();
  assert.deepEqual(c.notes, [['empty', '']]);
  assert.equal(c.said.at(-1), '');
  assert.equal(c.urls.length, 1);
  assert.deepEqual(c.watches.map((w) => w.slice(2)), [[5000, 0]]);
  // the tick tape starts empty on a quiet symbol by design
  c = chartFixture({ state: { provider: 'lse', timeframe: 'tick' },
    fetch: async () => ({ ok: true, json: async () => ({ candles: [] }) }) });
  await c.loadChart();
  assert.deepEqual(c.notes, [['loading', ''], ['', '']]);
}

// a chart that is LOADING: nothing of the instrument before it
{
  const gate = () => { let release; const p = new Promise((r) => (release = r)); return { p, release }; };
  const answer = (g, n) => async () => { await g.p; return { ok: true, json: async () => ({ candles: bars(n), indicators: { ema: {} } }) }; };

  // another instrument is picked while AAPL's bars are on screen
  let g = gate();
  let c = chartFixture({ state: { symbol: 'BTC/USD' }, fetch: answer(g, 5) });
  let p = c.loadChart();
  // at once, with the request only just sent
  assert.equal(c.urls.length, 1);
  assert.equal(c.state.candleData.length, 0);               // AAPL's bars are off
  assert.equal(c.state.lastBar, null);
  assert.deepEqual({ ...c.state.engineIndicators }, {});
  assert.equal(c.state.candleKey, '');
  assert.deepEqual(c.pushed, [0]);                          // the chart was told
  assert.deepEqual(c.notes, [['loading', '']]);             // and its area says what is loading
  assert.equal(c.stops, 1);                                 // the last load's re-asks are over
  // a tick of the NEW instrument arrives meanwhile: there is no bar of the
  // old one for it to be drawn onto, and none is made
  c.onTick({ symbol: 'BTC/USD', price: 73000, ts: 3700 });
  c.onTick({ symbol: 'BTC/USD', price: 73010, ts: 7300 });
  assert.equal(c.state.candleData.length, 0);
  assert.equal(c.state.lastBar, null);
  assert.deepEqual(c.pushed, [0]);
  assert.equal(c.state.prices['BTC/USD'], 73010);           // (the sidebar and ticket still get it)
  g.release(); await p;
  assert.equal(c.state.candleData.length, 5);
  assert.equal(c.state.lastBar.time, 1000 + 4 * 3600);
  assert.deepEqual(c.pushed, [0, 5]);
  assert.deepEqual(c.notes, [['loading', ''], ['', '']]);   // drawn: the note goes
  assert.equal(c.state.candleKey, 'broker:alp|BTC/USD|1h');

  // the TIMEFRAME changes on the same instrument
  g = gate();
  c = chartFixture({ state: { timeframe: '4h' }, fetch: answer(g, 5) });
  p = c.loadChart();
  assert.equal(c.state.candleData.length, 0);
  assert.equal(c.state.lastBar, null);
  assert.deepEqual(c.notes, [['loading', '']]);
  c.onTick({ symbol: 'AAPL', price: 190, ts: 3700 });       // an hourly bar must not take a 4h tick
  assert.equal(c.state.candleData.length, 0);
  g.release(); await p;
  assert.equal(c.state.candleData.length, 5);

  // the SOURCE changes under the same symbol and timeframe
  g = gate();
  c = chartFixture({ state: { provider: 'broker:other' }, fetch: answer(g, 5) });
  p = c.loadChart();
  assert.equal(c.state.candleData.length, 0);
  assert.deepEqual(c.notes, [['loading', '']]);
  g.release(); await p;

  // the SAME chart again (an indicator added, Retry): its bars are right and
  // stay on screen, ticks keep building on them, and there is no loading note
  g = gate();
  c = chartFixture({ fetch: answer(g, 5) });
  p = c.loadChart();
  assert.equal(c.state.candleData.length, 1);
  assert.equal(c.state.lastBar.close, 2);
  assert.deepEqual(c.pushed, []);
  assert.deepEqual(c.notes, []);
  assert.equal(c.loading, 1);                               // (a note already up would say "loading")
  assert.equal(c.stops, 1);
  c.onTick({ symbol: 'AAPL', price: 3, ts: 3700 });
  assert.equal(c.state.lastBar.close, 3);
  assert.deepEqual(c.pushed, [1]);
  g.release(); await p;
  assert.equal(c.state.candleData.length, 5);

  // a chart that is not up yet has no bars to take off, and is not mounted
  // empty ahead of the load that starts it
  g = gate();
  c = chartFixture({ state: { symbol: 'BTC/USD', chartMounted: false }, fetch: answer(g, 5) });
  p = c.loadChart();
  assert.deepEqual(c.pushed, []);
  assert.deepEqual(c.notes, [['loading', '']]);
  assert.equal(c.state.candleData.length, 0);
  g.release(); await p;
  assert.deepEqual(c.pushed, [5]);
  // the very first load of a session
  g = gate();
  c = chartFixture({ state: { candleData: undefined, lastBar: undefined, candleKey: undefined, chartMounted: false }, fetch: answer(g, 5) });
  p = c.loadChart();
  assert.equal(c.state.candleData.length, 0);
  assert.deepEqual(c.pushed, []);
  g.release(); await p;
  assert.equal(c.state.candleData.length, 5);
}

// the note's words
{
  const c = load(['tpbPlainReason', 'chartSourceName', 'chartFailReason', 'chartNoteText'], {
    state: { providers: [{ name: 'broker:alpaca', title: 'Alpaca (paper trading)' }, { name: 'lse', title: 'LSE' }] },
    String });
  assert.equal(c.chartFailReason(SLOW), 'Alpaca was too slow to page 5000 bars; ask for fewer');
  assert.equal(c.chartFailReason('candles failed: internal: Alpaca could not be reached: TimeoutError: The read operation timed out'),
    'Alpaca could not be reached: TimeoutError: The read operation timed out');
  // a message that merely contains a colon keeps all of its own text
  assert.equal(c.chartFailReason('candles failed: no fx cross for JPY: this instrument cannot be charted'),
    'no fx cross for JPY: this instrument cannot be charted');
  assert.equal(c.chartFailReason('candles failed: [404] 0001.HK has no candle data'), '[404] 0001.HK has no candle data');
  assert.equal(c.chartFailReason('GOLD was imported as 30m; cannot serve 1m'), 'GOLD was imported as 30m; cannot serve 1m');
  assert.equal(c.chartFailReason(502), 'The engine answered 502 and gave no reason.');
  assert.equal(c.chartFailReason(''), 'No reason was given.');
  assert.equal(c.chartFailReason(null), 'No reason was given.');
  assert.equal(c.chartSourceName('broker:alpaca'), 'Alpaca (paper trading)');
  assert.equal(c.chartSourceName('broker:mine'), 'mine');
  assert.equal(c.chartSourceName(''), 'the source');

  const n = { kind: 'fail', detail: SLOW, symbol: 'BTC/USD', timeframe: '1h', source: 'Alpaca (paper trading)' };
  assert.deepEqual({ ...c.chartNoteText(n) }, {
    title: 'Could not load BTC/USD (1h) from Alpaca (paper trading)',
    detail: 'Alpaca was too slow to page 5000 bars; ask for fewer', retry: true });
  assert.deepEqual({ ...c.chartNoteText({ ...n, kind: 'empty' }) }, {
    title: 'Alpaca (paper trading) returned no candles for BTC/USD (1h)', detail: '', retry: true });
  assert.deepEqual({ ...c.chartNoteText({ ...n, kind: 'loading' }) }, {
    title: 'Loading BTC/USD (1h)…', detail: '', retry: false });
}

// the note on the page: text only, a Retry that loads again, single chart only
{
  const mk = (tag) => {
    const classes = new Set();
    return {
      tag, children: [], className: '', dataset: {}, _text: '',
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text; },
      set innerHTML(v) { throw new Error('markup was set on the chart note'); },
      appendChild(ch) { this.children.push(ch); return ch; },
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
                   contains: (name) => classes.has(name) },
    };
  };
  const note = mk('div'), wrap = mk('div');
  note.classList.toggle('hidden', true);
  let layout = '1x1', subs = [], loads = 0;
  const c = load(['tpbPlainReason', 'chartSourceName', 'chartFailReason', 'chartNoteText',
                  'chartNotePaint', 'chartNote', 'chartNoteLoading', 'chartDigitsPayload', 'pushToChart'], {
    state: { provider: 'broker:alpaca', symbol: 'BTC/USD', timeframe: '1h', candleData: [],
             providers: [{ name: 'broker:alpaca', title: 'Alpaca (paper trading)' }], quotes: {} },
    $: (id) => (id === 'chart-note' ? note : id === 'chart-wrap' ? wrap : mk('div')),
    document: { createElement: mk },
    window: { LSEChart: { layoutStore: { get: () => ({ layout }), subscribe: (f) => subs.push(f) },
                          mount() {}, update() {} } },
    loadChart: () => { loads++; }, String });
  vm.runInContext('const chartNoteState = { kind: "", detail: "", symbol: "", timeframe: "", source: "", watching: false };', c);
  // the page's own declaration is that same shape
  assert.ok(src.includes('const chartNoteState = { kind: "", detail: "", symbol: "", timeframe: "",'));

  const HOSTILE = 'candles failed: internal: <img src=x onerror=alert(1)> said the venue';
  c.chartNote('fail', HOSTILE);
  assert.equal(note.classList.contains('hidden'), false);
  assert.equal(note.dataset.kind, 'fail');
  // the chart's own floating controls go with its bars: the mount is hidden
  assert.equal(wrap.classList.contains('noted'), true);
  assert.deepEqual(note.children.map((x) => [x.tag, x.className, x.textContent]), [
    ['div', 'cn-title', 'Could not load BTC/USD (1h) from Alpaca (paper trading)'],
    ['div', 'cn-detail', '<img src=x onerror=alert(1)> said the venue'],   // text, not an element
    ['button', '', 'Retry']]);
  const retry = note.children[2];
  assert.equal(retry.id, 'chart-retry');
  retry.onclick();
  assert.equal(loads, 1);
  // the note follows the layout: it never covers the multi-chart panes
  assert.equal(subs.length, 1);
  layout = '2x2'; subs[0]();
  assert.equal(note.classList.contains('hidden'), true);
  assert.equal(wrap.classList.contains('noted'), false);     // the panes are not hidden
  layout = '1x1'; subs[0]();
  assert.equal(note.classList.contains('hidden'), false);
  assert.equal(wrap.classList.contains('noted'), true);
  c.chartNote('fail', HOSTILE);
  assert.equal(subs.length, 1);                              // subscribed once

  // the next load in flight replaces the old reason; no note, nothing to say
  c.state.symbol = 'AAPL';
  c.chartNoteLoading();
  assert.deepEqual(note.children.map((x) => [x.tag, x.textContent]), [['div', 'Loading AAPL (1h)…']]);
  c.chartNote('', '');
  assert.equal(note.classList.contains('hidden'), true);
  assert.equal(wrap.classList.contains('noted'), false);     // and the chart is back
  assert.deepEqual(note.children, []);
  c.chartNoteLoading();
  assert.equal(note.classList.contains('hidden'), true);

  // an empty answer
  c.chartNote('empty', '');
  assert.deepEqual(note.children.map((x) => [x.tag, x.textContent]), [
    ['div', 'Alpaca (paper trading) returned no candles for AAPL (1h)'], ['button', 'Retry']]);

  // bars arriving by another road (the live tick tape) end a note...
  c.chartNote('fail', 'candles failed: nope');
  c.state.candleData = [];
  c.pushToChart();
  assert.equal(note.classList.contains('hidden'), false);   // no bars: it stays
  c.state.candleData = [{ time: 1, open: 1, high: 1, low: 1, close: 1 }];
  c.pushToChart();
  assert.equal(note.classList.contains('hidden'), true);
  // ...but not the word that a load is in flight
  c.chartNote('loading', '');
  c.pushToChart();
  assert.equal(note.classList.contains('hidden'), false);
}

// a switch of source: the ticket follows the chart before the candles are waited for
{
  let release; const held = new Promise((r) => (release = r));
  const order = [];
  const c = load(['runSwitchProvider', 'tfOffered', 'tfNearest', 'tfMinutes'], {
    state: { provider: 'lse', symbol: 'EUR/USD', instruments: [], prices: { old: 1 }, logos: { old: 1 } },
    syncPricePollBudget() {}, loadPriceCache() {}, renderTimeframes() {}, loadLogos() {},
    // MARKETS's page decided again (another section of the page; not up here)
    marketsMainShowing: () => false, marketsDecide() {}, marketsWantsKey: () => false,
    renderWatchlist() { order.push('sidebar'); },
    loadInstruments: async () => { c.state.instruments = [{ symbol: 'BTC/USD' }, { symbol: 'AAP' }]; },
    loadChart: async () => { order.push('load starts for ' + c.state.symbol); await held; order.push('candles drawn'); },
    connectStream() { order.push('stream'); },
    tpbFollowChart(s) { order.push('ticket -> ' + s); },
  });
  const p = c.runSwitchProvider('broker:alp');
  await tick(); await tick();
  // the candles have not come yet, and the ticket is already on the instrument
  assert.deepEqual(order, ['sidebar', 'ticket -> BTC/USD', 'load starts for BTC/USD']);
  release(); await p;
  assert.deepEqual(order, ['sidebar', 'ticket -> BTC/USD', 'load starts for BTC/USD', 'candles drawn', 'stream', 'ticket -> BTC/USD']);
}

// ── a broker's short page, asked for again ─────────────────────────────────
function growFixture(over = {}) {
  let now = 0, id = 0;
  const timers = new Map();
  const handlers = {};
  const classes = new Set(['hidden']);
  const c = {
    state: { provider: 'broker:alp', symbol: 'BTC/USD', timeframe: '1h', loadSeq: 7,
             candleKey: 'broker:alp|BTC/USD|1h', chartMounted: true, engineIndicators: { first: {} },
             candleData: Array.from({ length: 86 }, (_, i) => ({ time: 1000 + i * 3600 })),
             lastBar: { time: 1000 + 85 * 3600 }, ...over.state },
    pushed: [], asked: [], unmounts: 0, layout: '1x1', subs: [],
    pushToChart() { c.pushed.push([c.state.candleData.length, c.state.chartMounted]); c.state.chartMounted = true; },
    host: { addEventListener(ev, f, opts) { (handlers[ev] = handlers[ev] || []).push([f, opts]); } },
    more: { textContent: '', title: '', onclick: null,
            classList: { toggle(n, on) { if (on) classes.add(n); else classes.delete(n); }, contains: (n) => classes.has(n) } },
    $: (id) => (id === 'chart-pro' ? c.host : id === 'chart-more' ? c.more : null),
    window: { LSEChart: { unmount() { c.unmounts++; },
                          layoutStore: { get: () => ({ layout: c.layout }), subscribe: (f) => c.subs.push(f) } } },
    fetch: async (u) => { c.asked.push([now, u]); return over.answer(c.asked.length, c); },
    setTimeout(f, ms) { timers.set(++id, { at: now + ms, f }); return id; },
    clearTimeout(t) { timers.delete(t); },
    Date: { now: () => now }, Math, Array, String,
  };
  c.handlers = handlers;
  c.shown = () => !classes.has('hidden');
  c.due = () => [...timers.values()].map((x) => x.at).sort((a, b) => a - b);
  c.advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const e = [...timers].sort((x, y) => x[1].at - y[1].at)[0];
      if (!e || e[1].at > end) break;
      now = e[1].at; timers.delete(e[0]); e[1].f();
      for (let i = 0; i < 8; i++) await tick();
    }
    now = end;
  };
  vm.createContext(c);
  vm.runInContext(fn('isBrokerSource'), c);
  vm.runInContext('const CHART_REASK_MS = [8000, 25000]; const chartGrow = { timer: null, held: null, shown: 0, touched: false, series: "BTC/USD|1h", listening: false, watching: false };', c);
  for (const n of ['chartGrowTouched', 'chartGrowPaint', 'chartGrowApply', 'chartGrowShow', 'chartGrowStop', 'chartGrowWatch']) vm.runInContext(fn(n), c);
  c.grow = () => vm.runInContext('chartGrow', c);
  c.watch = (got, asked = 5000) => c.chartGrowWatch(7, 'broker:alp|BTC/USD|1h', '/api/candles?the=same', asked, got);
  return c;
}
const pageOf = (n) => ({ ok: true, json: async () => ({ candles: bars(n), indicators: { ['over' + n]: {} } }) });
{
  // the page's own numbers are the ones under test
  assert.ok(src.includes('const CHART_REASK_MS = [8000, 25000];'));
  assert.ok(src.includes('const chartGrow = { timer: null, held: null, shown: 0, touched: false,'));

  // 86 of 5000 from a broker: asked again at 8 s, and at 25 s, while it grows
  let c = growFixture({ answer: (n) => pageOf(n === 1 ? 300 : 900) });
  c.watch(86);
  assert.deepEqual(c.due(), [8000]);
  await c.advance(7999);
  assert.deepEqual(c.asked, []);                             // not before its time
  await c.advance(1);
  assert.deepEqual(c.asked, [[8000, '/api/candles?the=same']]);   // the SAME request
  assert.equal(c.state.candleData.length, 300);              // drawn: nobody had touched the chart
  assert.equal(c.state.candleData[0].time, 1000);
  assert.equal(c.state.lastBar.time, 1000 + 299 * 3600);
  assert.deepEqual(Object.keys(c.state.engineIndicators), ['over300']);   // indicators are the longer page's
  assert.deepEqual(c.pushed, [[300, true]]);                 // redrawn in place: no remount
  assert.equal(c.unmounts, 0);
  assert.equal(c.shown(), false);                            // nothing held, no button
  assert.deepEqual(c.due(), [25000]);                        // 25 s after the first page, not after this one
  await c.advance(17000);
  assert.deepEqual(c.asked.map((a) => a[0]), [8000, 25000]);
  assert.equal(c.state.candleData.length, 900);
  assert.deepEqual(c.due(), []);                             // and never a third time
  await c.advance(600000);
  assert.equal(c.asked.length, 2);

  // a re-ask that brings no more than before ends it
  c = growFixture({ answer: () => pageOf(86) });
  c.watch(86);
  await c.advance(8000);
  assert.equal(c.asked.length, 1);
  assert.deepEqual(c.pushed, []);                            // nothing redrawn
  assert.equal(c.state.candleData.length, 86);
  assert.deepEqual(c.due(), []);
  // ...so does one that brings fewer, or fails, or never answers
  for (const answer of [() => pageOf(40), () => ({ ok: false, status: 502, json: async () => ({ detail: 'slow' }) }),
                        () => { throw new TypeError('Failed to fetch'); }, () => ({ ok: true, json: async () => ({}) })]) {
    c = growFixture({ answer });
    c.watch(86);
    await c.advance(8000);
    assert.equal(c.asked.length, 1);
    assert.equal(c.state.candleData.length, 86);             // the bars on screen are untouched
    assert.deepEqual(c.pushed, []);
    assert.deepEqual(c.due(), []);
  }
  // growth, then none: the second re-ask is the last either way
  c = growFixture({ answer: () => pageOf(300) });
  c.watch(86);
  await c.advance(30000);
  assert.equal(c.asked.length, 2);
  assert.deepEqual(c.pushed, [[300, true]]);                 // drawn once; the second brought no more
  // a re-ask that fills the page: nothing is shorter than asked any more
  c = growFixture({ answer: () => pageOf(5000) });
  c.watch(86);
  await c.advance(8000);
  assert.equal(c.state.candleData.length, 5000);
  assert.deepEqual(c.due(), []);
  await c.advance(60000);
  assert.equal(c.asked.length, 1);

  // an empty first page is a short page: the venue may have had nothing yet
  c = growFixture({ state: { candleData: [], lastBar: null }, answer: () => pageOf(150) });
  c.watch(0);
  await c.advance(8000);
  assert.equal(c.state.candleData.length, 150);

  // a FULL first page is not asked for again
  c = growFixture({ answer: () => pageOf(5000) });
  c.watch(5000);
  assert.deepEqual(c.due(), []);
  // nor any page of a source that is not a broker
  for (const provider of ['lse', 'userdata', 'demo', 'custom:mine']) {
    c = growFixture({ state: { provider, candleKey: provider + '|BTC/USD|1h' }, answer: () => pageOf(900) });
    c.chartGrowWatch(7, provider + '|BTC/USD|1h', '/api/candles?the=same', 5000, 86);
    assert.deepEqual(c.due(), [], provider);
    await c.advance(60000);
    assert.deepEqual(c.asked, [], provider);
  }

  // the instrument, timeframe or source changed before the re-ask: not asked
  c = growFixture({ answer: () => pageOf(300) });
  c.watch(86);
  c.state.loadSeq = 8;                                       // any newer load
  await c.advance(30000);
  assert.deepEqual(c.asked, []);
  c = growFixture({ answer: () => pageOf(300) });
  c.watch(86);
  c.state.candleKey = '';                                    // these bars are no longer on screen
  await c.advance(30000);
  assert.deepEqual(c.asked, []);
  // ...or while the re-ask was in flight: its answer is not drawn
  let release; let held = new Promise((r) => (release = r));
  c = growFixture({ answer: async () => { await held; return pageOf(300); } });
  c.watch(86);
  const flying = c.advance(8000);
  await tick();
  c.state.loadSeq = 8;
  release(); await flying;
  assert.equal(c.asked.length, 1);
  assert.equal(c.state.candleData.length, 86);
  assert.deepEqual(c.pushed, []);
  assert.deepEqual(c.due(), []);
  // a new chart load stops the wait outright (loadChart calls this first)
  c = growFixture({ answer: () => pageOf(300) });
  c.watch(86);
  c.chartGrowStop();
  assert.deepEqual(c.due(), []);
  await c.advance(30000);
  assert.deepEqual(c.asked, []);
}

// what the user is looking at does not move
{
  let c = growFixture({ answer: (n) => pageOf(n === 1 ? 300 : 900) });
  c.watch(86);
  // the chart is listened to for the user taking hold of it, once
  assert.deepEqual(Object.keys(c.handlers).sort(), ['pointerdown', 'touchstart', 'wheel']);
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
    assert.equal(c.handlers[ev].length, 1);
    assert.equal(c.handlers[ev][0][1].capture, true);        // before the chart can swallow it
    assert.equal(c.handlers[ev][0][1].passive, true);        // and without slowing its scroll
  }
  c.watch(86);
  assert.equal(c.handlers.wheel.length, 1);
  assert.equal(c.subs.length, 1);

  // the user zooms (a wheel over the chart) before the longer page arrives
  c.handlers.wheel[0][0]();
  await c.advance(8000);
  assert.equal(c.asked.length, 1);                           // one wait, though the watch was started twice
  assert.equal(c.state.candleData.length, 86);               // NOT redrawn under them
  assert.equal(c.state.lastBar.time, 1000 + 85 * 3600);
  assert.deepEqual(Object.keys(c.state.engineIndicators), ['first']);
  assert.deepEqual(c.pushed, []);
  assert.equal(c.shown(), true);                             // the bars wait behind the button
  assert.equal(c.more.textContent, '214 older bars have arrived · Show');
  assert.match(c.more.title, /moved or zoomed/);
  // the second re-ask still runs, and the button counts what is waiting now
  await c.advance(17000);
  assert.equal(c.asked.length, 2);
  assert.equal(c.state.candleData.length, 86);
  assert.equal(c.more.textContent, '814 older bars have arrived · Show');
  // in a multi-chart layout the button steps aside, and comes back
  c.layout = '2x2'; c.subs[0]();
  assert.equal(c.shown(), false);
  c.layout = '1x1'; c.subs[0]();
  assert.equal(c.shown(), true);
  // Show: the held page is drawn on a chart mounted afresh (back on its newest bars)
  c.more.onclick();
  assert.equal(c.unmounts, 1);
  assert.deepEqual(c.pushed, [[900, false]]);                // pushed to a chart that was not mounted: a fresh one
  assert.equal(c.state.candleData.length, 900);
  assert.equal(c.state.lastBar.time, 1000 + 899 * 3600);
  assert.deepEqual(Object.keys(c.state.engineIndicators), ['over900']);
  assert.equal(c.shown(), false);
  assert.equal(c.grow().held, null);
  assert.equal(c.grow().touched, false);                     // a fresh chart follows its newest bar again
  c.more.onclick();                                          // nothing held: nothing happens
  assert.equal(c.unmounts, 1);

  // each way of taking hold of the chart holds the redraw
  for (const ev of ['pointerdown', 'touchstart', 'wheel']) {
    c = growFixture({ answer: () => pageOf(300) });
    c.watch(86);
    c.handlers[ev][0][0]();
    await c.advance(8000);
    assert.equal(c.state.candleData.length, 86, ev);
    assert.equal(c.shown(), true, ev);
    assert.equal(c.more.textContent, '214 older bars have arrived · Show');
  }
  // one older bar reads as one
  c = growFixture({ answer: () => pageOf(87) });
  c.watch(86);
  c.handlers.wheel[0][0]();
  await c.advance(8000);
  assert.equal(c.more.textContent, '1 older bar has arrived · Show');

  // held bars are dropped when another load starts; the mark that the chart
  // was touched lasts as long as the instrument and timeframe do
  c = growFixture({ answer: () => pageOf(300) });
  c.watch(86);
  c.handlers.pointerdown[0][0]();
  await c.advance(8000);
  assert.equal(c.shown(), true);
  c.chartGrowStop();                                         // the same chart reloads (an indicator added)
  assert.equal(c.shown(), false);
  assert.equal(c.grow().held, null);
  assert.equal(c.grow().touched, true);                      // the view is still where the user put it
  c.state.timeframe = '4h';
  c.chartGrowStop();                                         // another timeframe: the chart follows again
  assert.equal(c.grow().touched, false);
  c.handlers.pointerdown[0][0]();
  c.state.symbol = 'AAPL';
  c.chartGrowStop();                                         // another instrument
  assert.equal(c.grow().touched, false);
  c.handlers.pointerdown[0][0]();
  c.state.provider = 'broker:other';
  c.chartGrowStop();                                         // only the source: the chart keeps its view
  assert.equal(c.grow().touched, true);
}

// ── 3. Enter in the symbol box ────────────────────────────────────────────
{
  const c = load(['symbolChoice'], { String });
  const S = (...names) => names.map((symbol) => ({ symbol }));
  // the exact symbol, whatever case was typed, wherever it sits in the list
  assert.equal(c.symbolChoice('aapl', S('AAPB', 'AAPL', 'AAPLX'), []), 'AAPL');
  assert.equal(c.symbolChoice(' AaPl ', S('AAPL'), []), 'AAPL');
  assert.equal(c.symbolChoice('btc/usd', S('BTC/USDT', 'BTC/USD'), []), 'BTC/USD');
  // the source's own spelling comes back, not the typed one
  assert.equal(c.symbolChoice('ES.F', S('es.f'), []), 'es.f');
  // exact in the sidebar's catalog beats a merely-first suggestion
  assert.equal(c.symbolChoice('f', S('FB', 'FORD'), S('X', 'F')), 'F');
  // no exact match: the first suggestion
  assert.equal(c.symbolChoice('aap', S('AAPB', 'AAPL'), S('ZZZ')), 'AAPB');
  // nothing to take
  assert.equal(c.symbolChoice('zzzz', [], S('AAPL')), '');
  assert.equal(c.symbolChoice('zzzz', null, null), '');
  assert.equal(c.symbolChoice('', S('AAPL'), S('AAPL')), '');
  assert.equal(c.symbolChoice('   ', S('AAPL'), []), '');
  assert.equal(c.symbolChoice(null, S('AAPL'), []), '');
  // an exact-only question (no suggestions passed) never falls to "first"
  assert.equal(c.symbolChoice('aap', null, S('AAPB', 'AAPL')), '');
}
function pickFixture(over = {}) {
  const c = {
    state: { provider: 'broker:alp', instruments: [], suggest: null, ...over.state },
    picked: [], said: [], asked: [], blurs: 0,
    setSymbol(s) { c.picked.push(s); },
    status(m) { c.said.push(m); },
    loadInstruments: async (q) => { c.asked.push(q); return over.answer ? over.answer(q, c) : []; },
    String, Array,
  };
  c.input = { value: over.typed,
    // a real box fires `change` when it is left with new text in it
    blur() { c.blurs++; c.pickTypedSymbol(c.input); } };
  vm.createContext(c);
  vm.runInContext(fn('isBrokerSource'), c);
  vm.runInContext(fn('symbolChoice'), c);
  vm.runInContext('const symPick = { seq: 0, settling: false };', c);
  vm.runInContext(fn('pickTypedSymbol'), c);
  return c;
}
{
  const S = (...names) => names.map((symbol) => ({ symbol }));
  assert.ok(src.includes('const symPick = { seq: 0, settling: false };'));

  // the fault: "aapl" typed, AAPL offered first, Enter
  let c = pickFixture({ typed: 'aapl', state: { suggest: { provider: 'broker:alp', query: 'aapl', items: S('AAPL', 'AAPLX') } } });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['AAPL']);                     // not "aapl"
  assert.equal(c.input.value, 'AAPL');
  assert.deepEqual(c.asked, []);                            // already in hand: at once
  assert.equal(c.blurs, 1);                                 // and the blur's `change` did not pick twice

  // in the sidebar's catalog
  c = pickFixture({ typed: 'btc/usd', state: { instruments: S('AAPL', 'BTC/USD') } });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['BTC/USD']);
  assert.deepEqual(c.asked, []);

  // beyond the sidebar's page: the source is asked for this exact text
  c = pickFixture({ typed: 'aapl', answer: () => S('AAPL', 'AAPLX'),
    state: { suggest: { provider: 'broker:alp', query: 'aa', items: S('AA', 'AAL') } } });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.asked, ['aapl']);
  assert.deepEqual(c.picked, ['AAPL']);

  // no exact match: the first suggestion
  c = pickFixture({ typed: 'aap', answer: () => S('AAPB', 'AAPL') });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['AAPB']);
  assert.equal(c.input.value, 'AAPB');

  // a list offered by ANOTHER source is not this source's
  c = pickFixture({ typed: 'aapl', answer: () => [],
    state: { suggest: { provider: 'lse', query: 'aapl', items: S('AAPL') } } });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, []);
  assert.deepEqual(c.said, ['no instrument matches "aapl"']);

  // nothing matches on a broker: said, and nothing is charted
  c = pickFixture({ typed: 'zzzz', answer: () => [] });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, []);
  assert.deepEqual(c.said, ['no instrument matches "zzzz"']);
  assert.equal(c.input.value, 'zzzz');
  // the search itself failed on a broker: nothing charted, nothing claimed
  c = pickFixture({ typed: 'zzzz', answer: () => undefined });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, []);
  assert.deepEqual(c.said, []);
  c = pickFixture({ typed: 'zzzz', answer: () => { throw new Error('offline'); } });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, []);

  // LSE: the exact match and the first suggestion the same way...
  c = pickFixture({ typed: 'aapl', state: { provider: 'lse' }, answer: () => S('AAPL', 'AAPL.L') });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['AAPL']);
  c = pickFixture({ typed: 'eur', state: { provider: 'lse' }, answer: () => S('EUR/USD', 'EUR/GBP') });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['EUR/USD']);
  // ...and a spelling its catalogue does not list still goes through as typed
  c = pickFixture({ typed: 'OLDALIAS', state: { provider: 'lse' }, answer: () => [] });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['OLDALIAS']);
  c = pickFixture({ typed: 'OLDALIAS', state: { provider: 'lse' }, answer: () => undefined });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual(c.picked, ['OLDALIAS']);

  // an empty box takes nothing
  c = pickFixture({ typed: '   ' });
  await c.pickTypedSymbol(c.input);
  assert.deepEqual([c.picked, c.asked, c.blurs], [[], [], 0]);

  // the answer arrives after the user typed on: this pick is void
  let release; let held = new Promise((r) => (release = r));
  c = pickFixture({ typed: 'aap', answer: async () => { await held; return S('AAPB'); } });
  let p = c.pickTypedSymbol(c.input);
  c.input.value = 'aapl';
  release(); await p;
  assert.deepEqual(c.picked, []);
  // ...or after the source was switched
  held = new Promise((r) => (release = r));
  c = pickFixture({ typed: 'aap', answer: async () => { await held; return S('AAPB'); } });
  p = c.pickTypedSymbol(c.input);
  c.state.provider = 'lse';
  release(); await p;
  assert.deepEqual(c.picked, []);
  // two Enters: only the later one picks
  held = new Promise((r) => (release = r));
  let call = 0;
  c = pickFixture({ typed: 'aap', answer: async () => { if (++call === 1) await held; return S('AAPB'); } });
  const first = c.pickTypedSymbol(c.input);
  await c.pickTypedSymbol(c.input);
  release(); await first;
  assert.deepEqual(c.picked, ['AAPB']);
  // ...even when the later one found nothing and the box still holds the text
  held = new Promise((r) => (release = r));
  call = 0;
  c = pickFixture({ typed: 'aap', answer: async () => { if (++call === 1) { await held; return S('AAPB'); } return []; } });
  const earlier = c.pickTypedSymbol(c.input);
  await c.pickTypedSymbol(c.input);
  release(); await earlier;
  assert.deepEqual(c.picked, []);
  assert.deepEqual(c.said, ['no instrument matches "aap"']);
}

// the latest text typed wins: an answer for an earlier text is dropped
{
  const box = { value: '' };
  const options = { innerHTML: '' };
  const said = [];
  const gates = {};
  const answers = {
    aap: [{ symbol: 'AAP', name: 'Advance Auto Parts', digits: 2 }, { symbol: 'AAPB', name: 'b' }, { symbol: 'AAPD', name: 'd' }],
    aapl: [{ symbol: 'AAPLX', name: 'x' }, { symbol: 'AAPL', name: 'Apple', digits: 2 }],
  };
  let renders = 0;
  const c = load(['loadInstruments'], {
    state: { provider: 'broker:alp', lseConfigured: false }, encodeURIComponent, setTimeout,
    fetch: async (url) => {
      const q = new URL(url, 'http://x').searchParams.get('query');
      if (gates[q]) await gates[q];
      const a = answers[q];
      return a === 'fail' ? { ok: false, status: 502 } : { ok: true, json: async () => a || [], headers: { get: () => null } };
    },
    $: (id) => (id === 'symbol' ? box : options), renderWatchlist() { renders++; },
    status(m) { said.push(m); }, chartPushDigits() {}, Number, String });
  const offered = () => [...options.innerHTML.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);

  // "aap" is asked first and answered LAST
  let release; gates.aap = new Promise((r) => (release = r));
  box.value = 'aap';
  const early = c.loadInstruments('aap');
  box.value = 'aapl';
  const late = await c.loadInstruments('aapl');
  assert.deepEqual(offered(), ['AAPL', 'AAPLX']);
  assert.deepEqual([...late].map((i) => i.symbol), ['AAPL', 'AAPLX']);
  release();
  assert.equal(await early, undefined);                      // dropped, whole
  assert.deepEqual(offered(), ['AAPL', 'AAPLX']);            // the list still answers "aapl" (was AAP, AAPB, AAPD)
  assert.equal(c.state.suggest.query, 'aapl');               // and so does what Enter would take
  assert.equal(c.state.digitsBySym.AAP, undefined);
  delete gates.aap;

  // the box was emptied before the answer came: nothing is offered for it
  gates.aap = new Promise((r) => (release = r));
  box.value = 'aap';
  const gone = c.loadInstruments('aap');
  box.value = '';
  release(); await gone;
  assert.deepEqual(offered(), ['AAPL', 'AAPLX']);
  assert.equal(c.state.suggest.query, 'aapl');
  delete gates.aap;

  // a search that FAILED for an earlier text says nothing either
  answers.zz = 'fail';
  gates.zz = new Promise((r) => (release = r));
  box.value = 'zz';
  const failed = c.loadInstruments('zz');
  box.value = 'aapl';
  release(); await failed;
  assert.deepEqual(said, []);
  // ...while one that failed for the text in the box does
  box.value = 'zz';
  await c.loadInstruments('zz');
  assert.deepEqual(said, ['instrument load failed']);

  // the answer for the text in the box is taken, spaces aside
  box.value = '  aap ';
  await c.loadInstruments('aap');
  assert.deepEqual(offered(), ['AAP', 'AAPB', 'AAPD']);
  box.value = 'aap';
  await c.loadInstruments(' aap ');
  assert.equal(c.state.suggest.query, ' aap ');

  // the sidebar's own load has no text to match: the box is not consulted
  box.value = 'whatever is being typed';
  answers[''] = [{ symbol: 'ONLY', name: 'only', category: 'Stocks' }];
  await c.loadInstruments('');
  assert.equal(renders, 1);
  assert.equal(c.state.instruments.length, 1);
  // a page with no such box (and the other tests' stand-in for one) still lists
  const bare = load(['loadInstruments'], {
    state: { provider: 'broker:alp', lseConfigured: false }, encodeURIComponent, setTimeout,
    fetch: async () => ({ ok: true, json: async () => answers.aapl, headers: { get: () => null } }),
    $: () => options, renderWatchlist() {}, status() {}, chartPushDigits() {}, Number, String });
  options.innerHTML = '';
  await bare.loadInstruments('aapl');
  assert.deepEqual(offered(), ['AAPL', 'AAPLX']);
}

// the box is wired to it: Enter and `change` both resolve the text first
{
  assert.ok(/\$\("symbol"\)\.addEventListener\("keydown", \(e\) => \{\s*if \(e\.key !== "Enter" \|\| e\.isComposing\) return;\s*e\.preventDefault\(\);\s*pickTypedSymbol\(e\.target\);\s*\}\);/.test(src));
  assert.ok(src.includes('$("symbol").addEventListener("change", (e) => pickTypedSymbol(e.target));'));
  // the line that charted the typed text verbatim is gone
  assert.ok(!src.includes('setSymbol(e.target.value.trim())'));
}

console.log('broker display: prices from digits; a failed load says so; Enter resolves the text; a loading chart shows no old bars; a short page is re-asked without moving the view; the latest text typed wins.');
