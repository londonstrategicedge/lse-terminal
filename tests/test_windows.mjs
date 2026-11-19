// More than one window of the terminal on one engine (ui/static/app.js).
// Two page contexts share what two real windows share: localStorage, a
// BroadcastChannel, Web Locks and the clock. Held here:
//  - the price board is asked once per three seconds in ALL, whatever the
//    number of windows, and every window's rows are priced by that call;
//  - a 429's wait holds every window;
//  - symbols a widget asks for ride the same call (priceDeskPrices);
//  - view ids, and which window carries out an assistant's navigation.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };

function world() {
  let now = 1_000_000, id = 0;
  const timers = new Map(), store = new Map(), channels = [], locks = new Map(), calls = [];
  const w = { calls, store, locks, respond: null };
  w.now = () => now;
  const t0 = now;
  // the calls made inside the first minute (a call due exactly at its end belongs to the next)
  w.inMinute = () => calls.filter((c) => c.at < t0 + 60000);
  w.advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; timers.delete(next[0]); next[1].f();
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    }
    now = end;
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  w.window = (name, visible) => {
    const c = {
      name, visible, paints: [], state: { provider: 'lse', symbol: 'CHARTED', prices: {}, quotes: {}, priceTimes: {} },
      document: { hidden: false, querySelectorAll: () => [] }, performance: { now: () => now },
      Date: { now: () => now }, statusEl: { textContent: '' },
      visibleWatchSymbols() { return c.visible; }, $: () => c.statusEl, status(v) { c.statusEl.textContent = v; },
      paintBoardPrice(r) { c.paints.push(r.symbol); }, savePriceCache() {},
      encodeURIComponent, Number, Math, JSON, Promise, Map, Set, Array, String, Object,
      setTimeout(f, ms) { timers.set(++id, { at: now + Math.max(0, ms || 0), f }); return id; },
      clearTimeout(t) { timers.delete(t); },
      localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
                      removeItem: (k) => store.delete(k) },
      BroadcastChannel: class {
        constructor(n) { this.n = n; this.onmessage = null; channels.push(this); }
        postMessage(data) {
          const copy = JSON.parse(JSON.stringify(data));
          for (const ch of channels) if (ch !== this && ch.n === this.n && ch.onmessage) ch.onmessage({ data: copy });
        }
      },
      navigator: { locks: {
        async request(lockName, opts, fn) {
          if (locks.get(lockName)) return fn(null);
          locks.set(lockName, c.name);
          try { return await fn({ name: lockName }); } finally { locks.delete(lockName); }
        },
        async query() { return { held: [...locks.keys()].map((n) => ({ name: n })) }; },
      } },
      fetch: async (u) => {
        const symbols = decodeURIComponent(/symbols=([^&]*)/.exec(u)[1]).split(',');
        calls.push({ at: now, by: name, symbols });
        if (w.respond) return w.respond(symbols);
        return { ok: true, status: 200, headers: { get: () => null },
                 json: async () => symbols.map((s) => ({ symbol: s, price: 1 })) };
      },
    };
    vm.createContext(c);
    vm.runInContext(cut('let statusMessage =', 'const fmt ='), c);
    vm.runInContext(cut('const PRICE_POLL_INTERVAL_MS =', '\nfunction connectStream()'), c);
    return c;
  };
  return w;
}

// Both windows poll on their own 3 s interval and on render primes; the board is asked once per 3 s in all.
{
  const w = world();
  const a = w.window('A', ['EUR/USD', 'GBP/USD']), b = w.window('B', ['BTC/USD', 'AAPL']);
  for (let ms = 0; ms < 60000; ms += 50) { await a.pollPrices(); await b.pollPrices(); await w.advance(50); }
  const n = w.inMinute().length;
  assert.ok(n <= 20, `two windows asked ${n} times in a minute`);
  assert.ok(n >= 18, `the shared gate starved the windows: ${n} calls`);
  assert.ok(w.calls.slice(1).every((c, i) => c.at - w.calls[i].at >= 3000), 'two calls closer than 3 s');
  // every call after the first carries the other window's rows, and both windows are painted
  const later = w.calls.slice(2);
  assert.ok(later.every((c) => ['EUR/USD', 'GBP/USD', 'BTC/USD', 'AAPL'].every((s) => c.symbols.includes(s))),
    'a call left out the other window\'s symbols');
  for (const [win, own] of [[a, ['EUR/USD', 'GBP/USD']], [b, ['BTC/USD', 'AAPL']]]) {
    for (const s of own) assert.ok(win.paints.filter((x) => x === s).length >= 15, `${win.name} was painted ${s} too rarely`);
  }
  console.log(`Two windows: ${n} calls in a minute, each priced by the other's call.`);
}

// One window alone behaves as before: its own 20 a minute.
{
  const w = world();
  const a = w.window('A', ['EUR/USD']);
  for (let ms = 0; ms < 60000; ms += 50) { await a.pollPrices(); await w.advance(50); }
  assert.equal(w.inMinute().length, 20, 'one window alone keeps its 20 a minute');
}

// Four windows: still one call per 3 s.
{
  const w = world();
  const wins = ['A', 'B', 'C', 'D'].map((n, i) => w.window(n, ['S' + i]));
  for (let ms = 0; ms < 60000; ms += 100) { for (const x of wins) await x.pollPrices(); await w.advance(100); }
  assert.ok(w.inMinute().length <= 20, `four windows asked ${w.inMinute().length} times`);
  for (const [i, x] of wins.entries()) assert.ok(x.paints.filter((s) => s === 'S' + i).length >= 12, `window ${x.name} starved`);
  console.log(`Four windows: ${w.inMinute().length} calls in a minute.`);
}

// A 429 in one window holds every window for the board's Retry-After.
{
  const w = world();
  const a = w.window('A', ['EUR/USD']), b = w.window('B', ['BTC/USD']);
  w.respond = () => ({ ok: false, status: 429, headers: { get: () => '30' }, json: async () => ({ detail: 'limit' }) });
  await a.pollPrices();
  assert.equal(w.calls.length, 1);
  assert.match(a.statusEl.textContent, /retrying in 30s/);
  w.respond = null;
  for (let ms = 0; ms < 29000; ms += 500) { await a.pollPrices(); await b.pollPrices(); await w.advance(500); }
  assert.equal(w.calls.length, 1, 'a window asked inside the 429 wait');
  await w.advance(2000); await a.pollPrices(); await b.pollPrices(); await w.advance(100);
  assert.ok(w.calls.length >= 2, 'no window asked after the wait');
  console.log('A 429 holds every window, then one asks again.');
}

// A widget's symbols (priceDeskPrices) ride the watchlist's call; with no watchlist on screen the desk asks at the gate.
{
  const w = world();
  const a = w.window('A', ['EUR/USD']);
  await a.pollPrices();                                  // t0: the watchlist's call
  const got = a.priceDeskPrices('lse', ['NVDA', 'TSLA']);
  for (let ms = 0; ms < 4000; ms += 100) { await a.pollPrices(); await w.advance(100); }
  const rows = await got;
  assert.deepEqual(Array.from(rows, (r) => r.symbol).sort(), ['NVDA', 'TSLA']);
  assert.equal(w.calls.length, 2, 'the widget made a call of its own');
  assert.deepEqual(w.calls[1].symbols, ['EUR/USD', 'NVDA', 'TSLA']);
  // fresh rows answer without a call
  const before = w.calls.length;
  assert.equal((await a.priceDeskPrices('lse', ['NVDA'])).length, 1);
  assert.equal(w.calls.length, before);

  const w2 = world();
  const b = w2.window('B', []);                          // WORKSPACE: no watchlist on screen
  const p = b.priceDeskPrices('lse', ['NVDA']);
  await w2.advance(200);
  assert.equal((await p).length, 1);
  assert.equal(w2.calls.length, 1);
  // ten widgets asking every second for a minute: still at most one call per 3 s
  for (let ms = 0; ms < 60000; ms += 1000) {
    for (let k = 0; k < 10; k++) b.priceDeskPrices('lse', ['W' + k], 0).catch(() => {});
    await w2.advance(1000);
  }
  assert.ok(w2.calls.length <= 22, `widgets asked the board ${w2.calls.length} times in a minute`);
  assert.ok(w2.calls.slice(1).every((c, i) => c.at - w2.calls[i].at >= 3000));
  console.log(`Widgets ride the one call: ${w2.calls.length} calls in a minute for ten widgets asking every second.`);
}

// A widget in one window is served by the watchlist poll of another.
{
  const w = world();
  const a = w.window('A', ['EUR/USD']), b = w.window('B', []);
  await a.pollPrices();
  const p = b.priceDeskPrices('lse', ['XAU/USD']);
  for (let ms = 0; ms < 4000; ms += 100) { await a.pollPrices(); await w.advance(100); }
  assert.deepEqual(Array.from(await p, (r) => r.symbol), ['XAU/USD']);
  assert.ok(w.calls.every((c) => c.by === 'A') || w.calls.length <= 2, 'the widget\'s window made extra calls');
  assert.ok(w.calls.slice(1).every((c, i) => c.at - w.calls[i].at >= 3000));
}

// ── view ids and the window that navigates ──────────────────────────────
function pageWith(els, extra = {}) {
  const byId = new Map(els.map((e) => [e.id, e]));
  const c = {
    window: { __lseWin: extra.win || { id: 'main', token: 'main.aaaa', view: '' } },
    document: {
      getElementById: (id) => byId.get(id) || null,
      querySelector: (sel) => {
        if (sel === '.rail-btn.active') return els.find((e) => e.cls.has('rail-btn') && e.cls.has('active')) || null;
        if (sel === '#subrail .subrail-btn.active') return els.find((e) => e.cls.has('subrail-btn') && e.cls.has('active')) || null;
        return null;
      },
    },
    SUBRAIL: extra.SUBRAIL || {}, localStorage: extra.localStorage, navigator: extra.navigator || {},
    Object, String, RegExp, Promise, JSON,
  };
  vm.createContext(c);
  vm.runInContext(cut('const lseWin =', '// The address follows the view'), c);
  vm.runInContext(cut('function winMarkActive()', '/* Another window saved a workspace section'), c);
  return c;
}
const el = (id, ...cls) => ({ id, cls: new Set(cls), clicked: 0,
  classList: { contains(n) { return this._e.cls.has(n); } },
  click() { this.clicked++; } });
const mk = (id, ...cls) => { const e = el(id, ...cls); e.classList._e = e; return e; };
{
  const went = [];
  const rail = { markets: mk('rail-markets', 'rail-btn'), workspace: mk('rail-workspace', 'rail-btn', 'active'),
                 guide: mk('rail-guide', 'rail-btn'), hidden: mk('rail-data', 'rail-btn', 'hidden') };
  const sub = mk('sub-ws-dash', 'subrail-btn', 'active');
  const SUBRAIL = { workspace: [{ id: 'sub-ws-ide', go: () => went.push('ide') }, { id: 'sub-ws-dash', go: () => went.push('dash') },
                                { id: 'sub-ws-soon' }],
                    markets: [{ id: 'sub-mk-options', go: () => went.push('options') }] };
  const c = pageWith([...Object.values(rail), sub], { SUBRAIL });
  assert.equal(c.viewId(), 'workspace/sub-ws-dash');
  assert.equal(c.viewOfTab(rail.markets), 'markets');
  assert.equal(c.viewOfTab(mk('sub-mk-options', 'subrail-btn')), 'markets/sub-mk-options');
  assert.equal(c.viewOfTab(mk('sub-ws-soon', 'subrail-btn')), '', 'a placeholder tab is no view');
  assert.equal(c.viewOpen('workspace/sub-ws-dash'), true); assert.deepEqual(went, ['dash']);
  assert.equal(c.viewOpen('markets/sub-mk-options'), true); assert.deepEqual(went, ['dash', 'options']);
  assert.equal(c.viewOpen('guide'), true); assert.equal(rail.guide.clicked, 1);
  // a sub-view this build does not have falls back to its section; unknown or hidden sections go nowhere
  assert.equal(c.viewOpen('markets/sub-mk-gone'), true); assert.equal(rail.markets.clicked, 1);
  for (const bad of ['', 'nope', 'data', '../etc', 'markets/<script>', 'workspace/sub-ws-dash/extra', 'constructor'])
    assert.equal(c.viewOpen(bad), false, bad);
  assert.equal(went.length, 2);
  console.log('View ids: read from the lit tabs, opened by the tabs\' own handlers, junk refused.');
}
{
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let held = [];
  const nav = { locks: { query: async () => ({ held: held.map((n) => ({ name: n })) }) } };
  const main = pageWith([], { win: { id: 'main', token: 'main.aaaa' }, localStorage: ls, navigator: nav });
  const second = pageWith([], { win: { id: 'w2', token: 'w2.bbbb' }, localStorage: ls, navigator: nav });
  held = ['lset-win:main.aaaa', 'lset-win:w2.bbbb'];
  // nobody used a window yet: the main window
  assert.deepEqual([await main.winTakesNavigation(), await second.winTakesNavigation()], [true, false]);
  second.winMarkActive();                                 // the user works in window 2
  assert.deepEqual([await main.winTakesNavigation(), await second.winTakesNavigation()], [false, true]);
  main.winMarkActive();
  assert.deepEqual([await main.winTakesNavigation(), await second.winTakesNavigation()], [true, false]);
  // the window last used was closed without clearing its mark: the main window takes over
  second.winMarkActive(); held = ['lset-win:main.aaaa'];
  assert.equal(await main.winTakesNavigation(), true);
  // exactly one window answers in every arrangement
  held = ['lset-win:w2.bbbb', 'lset-win:w3.cccc']; store.clear();
  const third = pageWith([], { win: { id: 'w3', token: 'w3.cccc' }, localStorage: ls, navigator: nav });
  assert.deepEqual([await second.winTakesNavigation(), await third.winTakesNavigation()], [true, false]);
  console.log('An assistant\'s navigation is carried out by one window: the one last used, else the main window.');
}
