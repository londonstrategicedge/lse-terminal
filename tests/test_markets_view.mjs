// What MARKETS shows on a page just loaded with no LSE key: the key form, or
// the charts with the ticket and the dock. The shipped functions are cut
// out of app.js by name and run in node:vm with a few elements.
//
// Guarded against: the rail's test (no key and the source not a live one)
// running while the source is still being chosen at boot. The same engine
// and the same page then show the key form on two loads and the charts on a
// third; after a reload with a request held, its warning sits on a ticket
// that is off screen until the user presses Use on its broker's card.
//
// What is pinned:
//   1. The view is decided from what is known, and decided again whenever
//      the source changes while MARKETS's own page is up, so it does not
//      depend on which came first. With no key: the key form unless the
//      source is one of the user's own (a vendor key, a broker's source);
//      with a key: the charts.
//   2. With no key, once the ticket has chosen its broker and the engine's
//      record is read: a request out or held (on any broker) puts MARKETS
//      on the ticket broker's own source, so the ticket and its line are on
//      screen. Nothing held: the key form, as on a first run.
//   3. Never on another tab: a user who has moved on is left there.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test, done, settle, element } from './ticket_page.mjs';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
function cut(name) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  return src.slice(start + 1, src.indexOf('\n}\n', start) + 2);
}

function page({ key = false, providers = [], record = [], ticket = 'paper', rail = 'rail-markets' } = {}) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || element('div', id));
  for (const id of ['lse-connect', 'optpage', 'scrpage', 'news']) $(id).classList.add('hidden');
  for (const id of ['rail-markets', 'rail-backtest', 'rail-data']) $(id);
  $(rail).classList.add('active');
  $('lse-key').focus = () => {};
  const c = {
    $, els, String, Array, Object, JSON, Promise, Math, Number, Set,
    state: { provider: null, providers: [{ name: 'lse', timeframes: ['1h'] }, ...providers], lseConfigured: key,
             hosted: false, timeframe: '1h', instruments: [], groupsOpen: {} },
    tpb: { broker: ticket }, tpx: { record, synced: 0, sync() { c.tpx.synced += 1; } },
    brokerPicker: { rows: [{ broker: ticket, connected: true }] },
    switched: [],
    syncPricePollBudget() {}, loadPriceCache() {}, renderTimeframes() {}, loadInstruments: async () => {},
    loadLogos() {}, renderWatchlist() {}, loadChart: async () => {}, connectStream() {}, tpbFollowChart() {},
    renderConnBar() {}, tfOffered: () => [], tfNearest: (t) => t,
    isBrokerSource: (n) => String(n || '').startsWith('broker:'),
  };
  vm.createContext(c);
  for (const n of ['runSwitchProvider', 'isLiveSource', 'tpbViaConnector', 'tpbSourceName', 'enterLiveSource',
                   'marketsWantsKey', 'marketsMainShowing', 'marketsDecide', 'marketsBootSource']) {
    if (src.includes('\nfunction ' + n + '(') || src.includes('\nasync function ' + n + '(')) vm.runInContext(cut(n), c);
  }
  // switchProvider as the page has it: one switch at a time, recorded
  c.switchProvider = (name) => { c.switched.push(name); return c.runSwitchProvider(name); };
  c.view = () => (c.$('charts').classList.contains('hidden') ? 'key form'
    : c.$('lse-connect').classList.contains('hidden') ? 'charts' : 'both');
  return c;
}
// the rail's own decision, as its handler makes it at the click
const railClick = (c) => (typeof c.marketsDecide === 'function' ? c.marketsDecide()
  : (!c.state.lseConfigured && !c.isLiveSource(c.state.provider)
      ? (c.$('charts').classList.add('hidden'), c.$('lse-connect').classList.remove('hidden'))
      : (c.$('lse-connect').classList.add('hidden'), c.$('charts').classList.remove('hidden'))));

await test('1. no key: the same view whichever comes first, the rail\'s click or the source', async () => {
  const a = page();
  railClick(a);                                  // the click while the source is still null
  await a.runSwitchProvider('lse');              // then the boot's source
  await settle();
  const b = page();
  await b.runSwitchProvider('lse');              // the source first
  railClick(b);                                  // then the click
  await settle();
  assert.equal(a.view(), b.view(), `the click first: ${a.view()}; the source first: ${b.view()}`);
  assert.equal(a.view(), 'key form', 'no key and no source of the user\'s own: the key form');
});

await test('1. a key: the charts; a source of the user\'s own: the charts with no key', async () => {
  const a = page({ key: true });
  await a.runSwitchProvider('lse'); railClick(a); await settle();
  assert.equal(a.view(), 'charts');
  const b = page({ providers: [{ name: 'broker:my-oanda', broker: true, timeframes: ['1h'] }] });
  railClick(b);
  await b.runSwitchProvider('broker:my-oanda');
  await settle();
  assert.equal(b.view(), 'charts');
});

await test('2. no key, a request held: MARKETS opens on the ticket broker\'s source, the ticket on screen', async () => {
  const c = page({ providers: [{ name: 'broker:paper', broker: true, timeframes: ['1h'] }],
                   record: [{ broker: 'my-oanda', client_id: 'lset-close-e84c991719b8', state: 'unknown' }] });
  railClick(c);
  assert.equal(c.view(), 'key form');
  await c.runSwitchProvider('lse');               // the boot's fallback source
  c.marketsBootSource();                          // the ticket chose its broker; the record is read
  await settle();
  assert.deepEqual(c.switched, ['broker:paper'], 'the ticket broker\'s own source');
  assert.equal(c.view(), 'charts');
  assert.ok(c.tpx.synced > 0, 'the ticket is shown with it');
  // and the rail's click afterwards keeps it
  railClick(c);
  assert.equal(c.view(), 'charts');
});

await test('2. no key, nothing held: the key form, as on a first run', async () => {
  const c = page({ providers: [{ name: 'broker:paper', broker: true, timeframes: ['1h'] }],
                   record: [{ broker: 'my-oanda', client_id: 'lset-close-e84c991719b8', state: 'answered' }] });
  railClick(c);
  await c.runSwitchProvider('lse');
  if (typeof c.marketsBootSource === 'function') c.marketsBootSource();
  await settle();
  assert.deepEqual(c.switched, []);
  assert.equal(c.view(), 'key form');
});

await test('3. a user on another tab is left there', async () => {
  const c = page({ rail: 'rail-backtest', providers: [{ name: 'broker:paper', broker: true, timeframes: ['1h'] }],
                   record: [{ broker: 'my-oanda', client_id: 'lset-close-e84c991719b8', state: 'unknown' }] });
  c.$('rail-markets').classList.remove('active');
  c.$('charts').classList.add('hidden');
  await c.runSwitchProvider('userdata');
  c.marketsBootSource();
  await settle();
  assert.deepEqual(c.switched, [], 'no source switched under BACKTEST');
  assert.ok(c.$('charts').classList.contains('hidden') && c.$('lse-connect').classList.contains('hidden'),
            'neither MARKETS page shown on another tab');
});

await test('1. the rail\'s handler and the boot use the one decision', () => {
  const at = src.indexOf('$("rail-markets").onclick = () => {');
  const body = src.slice(at, src.indexOf('\n  };', at));
  assert.ok(/marketsWantsKey\(\)/.test(body), 'the handler decides by marketsWantsKey');
  assert.ok(/marketsBootSource\(\)/.test(cut('tpbSetup')), 'tpbSetup asks once the ticket has chosen');
  assert.ok(/marketsDecide\(\)/.test(cut('runSwitchProvider')), 'a source switch decides again');
});

done('test_markets_view.mjs');
