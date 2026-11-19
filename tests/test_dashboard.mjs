// WORKSPACE > DASHBOARD (ui/static/dash/dash.js): the bridge a widget's
// sandboxed frame reaches data through, the stored boards, the frame's
// document, and the shipped examples.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const dashSrc = fs.readFileSync(new URL('../lse_terminal/ui/static/dash/dash.js', import.meta.url), 'utf8');
const widgetSrc = fs.readFileSync(new URL('../lse_terminal/ui/static/dash/widget.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../lse_terminal/ui/static/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../lse_terminal/ui/static/dash/dash.css', import.meta.url), 'utf8');
const resources = JSON.parse(fs.readFileSync(new URL('../desktop/release/0.1.10/resources.json', import.meta.url), 'utf8'));
const plain = (v) => JSON.parse(JSON.stringify(v));

function page(answers = {}) {
  const fetched = [];
  const c = {
    fetched, desk: [], state: { symbol: 'EUR/USD', timeframe: '1h', provider: 'lse' },
    window: {}, document: { hidden: false, getElementById: () => null, documentElement: { classList: { contains: () => true } } },
    getComputedStyle: () => ({ getPropertyValue: () => '', fontFamily: 'sans-serif' }),
    priceDeskPrices: async (provider, symbols) => { c.desk.push([provider, [...symbols]]); return symbols.map((s) => ({ symbol: s, price: 1 })); },
    fetch: async (url) => {
      fetched.push(url);
      const path = url.split('?')[0];
      const a = Object.prototype.hasOwnProperty.call(answers, path) ? answers[path] : { status: 200, body: [] };
      return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
    },
    URLSearchParams, encodeURIComponent, JSON, Promise, Math, Number, String, Object, Array, Date, Map, Set, Error,
    setTimeout, clearTimeout, setInterval: () => 0, console,
  };
  vm.createContext(c);
  vm.runInContext(dashSrc + '\n;globalThis.__t = { dash, DASH_CALLS, DASH_EXAMPLES, DASH_REFERENCE, DASH_BLANK, DASH_EVERY, ' +
    'DASH_CALLS_PER_WIDGET, DASH_CALLS_PER_BOARD, DASH_CODE_MAX, dashCall, dashClean, dashSrcdoc, dashFrameCss };', c);
  return c;
}
const rec = () => ({ calls: [] });
const rejects = async (p, re) => { let e = null; try { await p; } catch (x) { e = x; } assert.ok(e, 'expected a refusal'); assert.match(String(e.message), re); };

// ── what a widget may ask: a fixed list of reads, LSE data and the user's own files ──
{
  const c = page({ '/api/candles': { status: 200, body: { candles: [[1795032000, 1, 2, 0.5, 1.5, 9]] } } });
  const t = c.__t;
  assert.deepEqual(Object.keys(t.DASH_CALLS).sort(), ['calendar', 'candles', 'chart', 'instruments', 'macro.catalog', 'macro.series',
    'mydata.list', 'mydata.rows', 'news', 'options.chain', 'options.flow', 'options.underlyings', 'prices', 'screener']);
  // every request the bridge can make is a GET of a read-only data route
  assert.ok(!/method:\s*["'](POST|PUT|DELETE)/.test(dashSrc.slice(dashSrc.indexOf('const DASH_CALLS = {'), dashSrc.indexOf('// One answer for everyone'))));
  const paths = [...dashSrc.slice(dashSrc.indexOf('const DASH_CALLS = {'), dashSrc.indexOf('// One answer for everyone')).matchAll(/"(\/api\/[a-z\-\/]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(paths)].sort(), ['/api/candles', '/api/data', '/api/data/', '/api/economic-calendar', '/api/instruments',
    '/api/macro/catalog', '/api/macro/series', '/api/news/feed', '/api/options/chain', '/api/options/flow', '/api/options/underlyings', '/api/screener']);
  for (const banned of ['/api/broker', '/api/sim', '/api/config', '/api/ai', '/api/algo', '/api/backtest', '/api/ws-files', '/api/term'])
    assert.ok(!paths.some((p) => p.startsWith(banned)), banned);

  const bars = plain(await t.dashCall(rec(), 'candles', { symbol: 'EUR/USD', timeframe: '1h', limit: 3 }));
  assert.deepEqual(bars, [{ t: 1795032000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }]);
  assert.match(c.fetched[0], /^\/api\/candles\?provider=lse&symbol=EUR%2FUSD&timeframe=1h&limit=3$/);
  await t.dashCall(rec(), 'candles', { symbol: 'GOLD', source: 'mydata' });
  assert.match(c.fetched[1], /provider=userdata&symbol=GOLD/);
  // a broker's prices are not a widget's to read, by any spelling
  for (const source of ['broker:oanda', 'broker', 'demo', 'userdata', 'LSE', '', 7, {}])
    await rejects(t.dashCall(rec(), 'candles', { symbol: 'EUR_USD', source }), /LSE data and your own files/);
  assert.equal(c.fetched.length, 2, 'a refused source reached the engine');
  await rejects(t.dashCall(rec(), 'candles', {}), /needs a symbol/);
  // limits are clamped, never passed through
  await t.dashCall(rec(), 'candles', { symbol: 'X', limit: 999999 });
  assert.match(c.fetched[2], /limit=5000$/);
  // a call that is not on the list, however it is spelled
  for (const m of ['broker.order', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', null, 5])
    await rejects(t.dashCall(rec(), m, {}), /no data call named/);
  // prices go through the terminal's one budgeted call, never a request of their own
  const before = c.fetched.length;
  const rows = plain(await t.dashCall(rec(), 'prices', ['EUR/USD', 'AAPL']));
  assert.deepEqual(rows.map((r) => r.symbol), ['EUR/USD', 'AAPL']);
  assert.deepEqual(plain(c.desk), [['lse', ['EUR/USD', 'AAPL']]]);
  assert.equal(c.fetched.length, before);
  assert.deepEqual(plain(await t.dashCall(rec(), 'chart')), { symbol: 'EUR/USD', timeframe: '1h', source: 'lse' });
  c.state.provider = 'broker:oanda';
  assert.equal((await t.dashCall(rec(), 'chart')).source, 'broker');
  console.log('Bridge: 14 read-only calls, LSE data and My Data only, limits clamped, unknown calls refused.');
}

// ── the engine's own words reach the widget; a wide catalogue is cut to what was asked ──
{
  const cat = [];
  for (let i = 0; i < 3000; i++) cat.push({ dataset: i % 2 ? 'bonds' : 'economics', symbol: 'S' + i, name: 'Series ' + i, category: 'c', country: i % 3 ? 'US' : 'GB' });
  const c = page({ '/api/economic-calendar': { status: 409, body: { detail: 'LSE API key not set. Add your free key to load the economic calendar.' } },
                   '/api/macro/catalog': { status: 200, body: cat },
                   '/api/news/feed': { status: 502, body: null } });
  const t = c.__t;
  await rejects(t.dashCall(rec(), 'calendar', {}), /LSE API key not set/);
  await rejects(t.dashCall(rec(), 'news'), /The data call failed \(502\)/);
  const us = await t.dashCall(rec(), 'macro.catalog', { dataset: 'bonds', country: 'us' });
  assert.equal(us.length, 200); assert.ok(us.every((r) => r.dataset === 'bonds' && r.country === 'US'));
  assert.equal((await t.dashCall(rec(), 'macro.catalog', { search: 'series 1234' })).length, 1);
  assert.equal((await t.dashCall(rec(), 'macro.catalog', { limit: 99999 })).length, 2000);
  assert.equal(c.fetched.filter((u) => u.startsWith('/api/macro/catalog')).length, 1, 'the catalogue was read more than once');
}

// ── one widget cannot spend the key's allowance; equal asks share one request ──
{
  const c = page({ '/api/options/chain': { status: 200, body: [] } });
  const t = c.__t;
  const one = rec(), two = rec();
  await Promise.all([t.dashCall(one, 'options.chain', { underlying: 'SPY' }), t.dashCall(two, 'options.chain', { underlying: 'SPY' })]);
  assert.equal(c.fetched.length, 1, 'two widgets on one chain made two requests');
  for (let i = 2; i <= t.DASH_CALLS_PER_WIDGET; i++) await t.dashCall(one, 'options.chain', { underlying: 'S' + i });
  await rejects(t.dashCall(one, 'options.chain', { underlying: 'ONE-TOO-MANY' }), /40 times in a minute/);
  assert.ok(!c.fetched.some((u) => u.includes('ONE-TOO-MANY')));
  await t.dashCall(two, 'options.chain', { underlying: 'OTHER' });          // another widget still may
  const many = [];
  for (let k = 0; k < 6; k++) many.push(rec());
  let refused = 0;
  for (const r of many) for (let i = 0; i < 30; i++) { try { await t.dashCall(r, 'chart'); } catch (e) { refused++; assert.match(e.message, /160 times in a minute between them/); } }
  assert.ok(refused > 0, 'the board as a whole has no ceiling');
  console.log('Allowances: 40 asks a minute per widget, 160 per board, equal asks answered by one request.');
}

// ── stored boards: whatever the file holds is made safe to draw ──
{
  const t = page().__t;
  const empty = plain(t.dashClean(null));
  assert.equal(empty.boards.length, 1); assert.equal(empty.current, empty.boards[0].id); assert.deepEqual(empty.boards[0].widgets, []);
  const messy = plain(t.dashClean({ current: 'gone', boards: [
    { id: 'b1', name: 'A', widgets: [{ id: 'w1', title: 'T', code: 'x', w: 99, h: -4, every: 7 }, 'junk', null,
                                     { id: 'w1', title: 5, code: 'y'.repeat(t.DASH_CODE_MAX + 10), w: 'six', h: 6, every: 60 }] },
    'junk', { id: 'b1', name: '', widgets: 'no' }] }));
  assert.equal(messy.boards.length, 2); assert.equal(messy.current, 'b1');
  const [w1, w2] = messy.boards[0].widgets;
  assert.deepEqual([w1.w, w1.h, w1.every], [12, 3, 0]);
  assert.deepEqual([w2.w, w2.h, w2.every, w2.title], [6, 6, 60, '5']); assert.equal(w2.code.length, t.DASH_CODE_MAX);
  assert.notEqual(w2.id, 'w1'); assert.notEqual(messy.boards[1].id, 'b1'); assert.equal(messy.boards[1].name, 'Board');
}

// ── the frame: sandboxed, no network, and no text of the user's can leave its script ──
{
  const t = page().__t;
  const evil = 'ui.text("</script><script>parent.postMessage({steal:1},"*")</script>"); // <!-- </SCRIPT > ';
  const doc = t.dashSrcdoc(evil, widgetSrc);
  const scripts = doc.split(/<script>/i).length - 1;
  assert.equal(scripts, 2, 'the user\'s text opened a script of its own');
  assert.equal(doc.split(/<\/script/i).length - 1, 2, 'the user\'s text closed a script');
  const boot = /window\.__LSE_BOOT=(.*?);<\/script>/s.exec(doc)[1];
  assert.equal(vm.runInNewContext('(' + boot + ')').code, evil.replace('\\u2028', ' '));
  assert.match(doc, /Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:"/);
  assert.match(dashSrc, /frame\.setAttribute\("sandbox", "allow-scripts"\)/);
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(dashSrc));
  // the page takes a frame's word only from a frame it made, and only from the sandbox's null origin
  assert.match(dashSrc, /e\.origin !== "null"/);
  assert.match(dashSrc, /rec\.frame\.contentWindow === source/);
  // the runtime inside the frame never reaches for the page or the network
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|localStorage|document\.cookie|window\.top|parent\.document)\b/.test(widgetSrc));
  console.log('Frame: sandbox="allow-scripts", its own no-network policy, and the user\'s text cannot break out of its script.');
}

// ── the examples and the reference are real: every example runs, every call it makes exists ──
{
  const t = page().__t;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const chain = [];
  for (const e of ['2026-11-18', '2026-11-20', '2026-12-18']) for (const k of [700, 730]) for (const ty of ['call', 'put'])
    chain.push({ ticker: 'SPY', underlying: 'SPY', strike: k, expiry: e, contract_type: ty, last_price: 1, volume_today: '10', premium_today: 500 });
  const data = {
    'candles': Array.from({ length: 300 }, (_, i) => ({ t: 1795000000 + i * 3600, open: 1, high: 1.1, low: 0.9, close: 1 + i / 1000, volume: 0 })),
    'prices': [{ symbol: 'EUR/USD', price: 1.09756, bid: 1.0974, ask: 1.09768, ts: '2026-11-18T23:40:48Z' }],
    'options.chain': chain,
    'options.flow': [{ ts: '2026-11-18T21:14:59Z', underlying: 'SPY', strike: 731, expiry: '2026-11-19', contract_type: 'call', volume: 1, premium: 374 }],
    'macro.catalog': [{ dataset: 'bonds', symbol: 'US10Y', name: 'United States 10Y yield', country: 'US', country_name: 'United States', last: '2026-11-13', last_value: 5.139 },
                      { dataset: 'bonds', symbol: 'US3M', name: 'United States 3M yield', country: 'US', country_name: 'United States', last: '2026-11-13', last_value: 4.9 }],
    'macro.series': [{ symbol: 'cpi_yoy', date: '2026-09-01', value: 3.7 }, { symbol: 'cpi_yoy', date: '2026-08-01', value: 3.4 }],
    'calendar': [{ datetime: '2026-11-18T12:00:00Z', event: 'MBA Mortgage Applications', actual: '-2.3%', consensus: null, previous: '6.2%' }],
  };
  const drawn = () => { const log = []; const ui = new Proxy({}, { get: (_, name) => (name === 'compact' || name === 'format'
      ? (v) => String(v) : (...args) => { if (name === 'row') args[0](); log.push(String(name)); return {}; }) }); return { ui, log }; };
  const names = new Set(Object.keys(t.DASH_CALLS));
  const lseFor = (asked) => { const call = (m) => (...a) => { asked.push(m); assert.ok(names.has(m), m + ' is not a bridge call'); return Promise.resolve(plain(data[m] || [])); };
    return { candles: call('candles'), prices: call('prices'), instruments: call('instruments'), chart: call('chart'),
             options: { underlyings: call('options.underlyings'), chain: call('options.chain'), flow: call('options.flow') },
             macro: { catalog: call('macro.catalog'), series: call('macro.series') }, calendar: call('calendar'),
             screener: call('screener'), news: call('news'), mydata: { list: call('mydata.list'), rows: call('mydata.rows') } }; };
  assert.equal(t.DASH_EXAMPLES.length, 7);
  assert.equal(t.DASH_EXAMPLES[0].key, 'putcall', 'the put/call ratio leads the examples');
  for (const ex of [...t.DASH_EXAMPLES, { key: 'blank', title: 'blank', code: t.DASH_BLANK, w: 6, h: 6, every: 60 }]) {
    const asked = [], d = drawn();
    await new AsyncFunction('lse', 'ui', 'el', ex.code)(lseFor(asked), d.ui, {});
    assert.ok(asked.length >= 1, ex.key + ' read no data');
    assert.ok(d.log.length >= 1, ex.key + ' drew nothing');
    assert.ok(ex.w >= 3 && ex.w <= 12 && ex.h >= 3 && ex.h <= 14, ex.key + ' size');
    assert.ok(t.DASH_EVERY.some(([s]) => s === ex.every), ex.key + ' refresh period');
    assert.ok(!/[—]/.test(ex.code + (ex.about || '')), ex.key + ' wording');
  }
  // the put/call example's arithmetic on a chain of known volumes: 6 puts and 6 calls of 10 each
  { const d = drawn(); const nums = []; d.ui.number = (v, o) => { nums.push([v, o.label]); return {}; };
    const ui = new Proxy(d.ui, { get: (target, name) => (name === 'number' ? (v, o) => { nums.push([v, o.label]); return {}; } : target[name]) });
    await new AsyncFunction('lse', 'ui', 'el', t.DASH_EXAMPLES[0].code)(lseFor([]), ui, {});
    assert.deepEqual(nums, [[1, 'SPY put/call by volume'], [1, 'Put/call by premium']]); }
  // what the runtime offers is what the reference names, and the other way round
  const offered = [...widgetSrc.slice(widgetSrc.indexOf('var lse = {'), widgetSrc.indexOf('/* ── formatting')).matchAll(/call\("([a-z.]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(offered)].sort(), [...names].sort(), 'the frame offers a call the bridge lacks, or lacks one it has');
  const refText = JSON.stringify(t.DASH_REFERENCE);
  for (const m of names) assert.ok(refText.includes('lse.' + m + '('), 'the reference does not list lse.' + m);
  for (const h of ['number', 'line', 'bars', 'share', 'table', 'row', 'text', 'canvas']) {
    assert.ok(new RegExp('\\b' + h + ': function').test(widgetSrc), 'ui.' + h + ' is not in the runtime');
    assert.ok(refText.includes('ui.' + h + '('), 'the reference does not list ui.' + h);
  }
  console.log('Examples: all 7 and the blank run against the bridge\'s calls; the reference and the runtime agree.');
}

// ── the page carries it, and the build packages it ──
{
  assert.match(html, /<section id="dash" class="hidden"><\/section>/);
  assert.ok(html.indexOf('<script src="./dash/dash.js">') > html.indexOf('<script src="./app.js">'));
  assert.match(html, /<link rel="stylesheet" href="\.\/dash\/dash\.css">/);
  for (const f of ['dash.css', 'dash.js', 'widget.js']) assert.ok(resources.includes('lse_terminal/ui/static/dash/' + f), f + ' is not packaged');
  // black and white: no green, and nothing under 12px, in the dashboard's own rules or in a widget's frame
  const frameCss = page().__t.dashFrameCss({ text: '#e8e8e8', dim: '#b0b0b0', edge: '#3a3a3a', bg: '#2a2a2a', up: '#21b3a4', down: '#f0426c', err: '#f87171', mono: 'monospace', font: 'sans-serif' });
  for (const [name, text] of [['dash.css', css], ['frame css', frameCss]]) {
    for (const m of text.matchAll(/font(?:-size)?:\s*([0-9.]+)px/g)) assert.ok(Number(m[1]) >= 12, name + ' has text at ' + m[1] + 'px');
    for (const m of text.matchAll(/font:\s*(?:\d+\s+)?([0-9.]+)px/g)) assert.ok(Number(m[1]) >= 12, name + ' has text at ' + m[1] + 'px');
  }
  for (const m of css.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    assert.ok(!(g > r + 30 && g > b + 30), 'dash.css has a green: #' + m[1]);
  }
  assert.ok(!/var\(--(up|logo-up|ohlcv)/.test(css), 'dash.css borrows a green token');
  console.log('Page and build: the section, its files in the packaged list, no green and nothing under 12px.');
}
