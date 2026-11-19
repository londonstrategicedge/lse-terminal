// Switching a broker's account while a request is out or held on it, and
// asking again on the account a request went out on. The shipped functions
// are cut out of app.js by name and run in node:vm (tests/ticket_page.mjs),
// with a fetch that answers as the engine would.
//
// Guarded against: a close held on one account, the account switched on the
// broker's card with no question, and Ask again sending the same close on
// the other account, which closes a position the user never
// asked to close. The contract: each entry of the engine's record
// keeps the account it went out on; the engine refuses an account switch
// while anything is out or unknown unless it says "confirm": true (409
// held_requests), and refuses an Ask again on another account (409
// held_other_account), naming both accounts.
//
// What is pinned:
//   1. The card's switch (the chooser's second click) while anything of
//      that broker is out or held asks first: "<the held sentence> Switch
//      account anyway?" with Switch and Not now. Not now sends nothing;
//      Switch sends the switch with "confirm": true.
//   2. Nothing held as far as the page knows: the switch goes without
//      confirm; an engine that answers 409 held_requests is asked about the
//      same way, in its own words ("<its sentence> Switch account
//      anyway?"), and Switch sends it again with confirm.
//   3. Ask again answered 409 held_other_account: the engine's words in the
//      error style, the request still held, and "Switch back", which puts
//      the profile back on the account the request went out on (from the
//      record) with confirm and the ticket on it; Ask again then works as
//      usual.
//   4. A source whose timeframes include 30m gets a 30m button, in its
//      place by length; a timeframe the new source does not list is not
//      asked of it (the nearest it lists is taken).
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { page, line, settle, test, done, element, cut } from './ticket_page.mjs';

const CLOSE = { broker: 'my-oanda', position_id: 'EUR_USD', qty: 1000, client_id: 'lset-close-af8d6ccba323' };
const LOST_DETAIL = 'internal: OANDA did not answer (TimeoutError)';
const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';
const entry = (state, more = {}) => ({ broker: 'my-oanda', client_id: CLOSE.client_id, route: '/api/broker/close',
  what: 'close', request: CLOSE, since: '2026-11-15T07:13:44Z', state, instrument: null,
  detail: state === 'unknown' ? LOST_DETAIL : null, code: state === 'unknown' ? 'internal' : null,
  account: '101-004-7240139-001', ...more });
const OTHER = 'This close went out on account …-001; OANDA is now on account …-003. '
  + 'Switch back to …-001 to ask again.';
const ENGINE_HELD = 'The close of 1000 EUR_USD may have been carried out: its answer was lost.';

function loaded(more = []) {
  const c = page({ more: ['csSwitchAccount', 'tpxSwitchBack', 'tpxOtherAccount', ...more],
                   ctx: { refreshConnScreen: async () => {}, connScreen: { errors: {} } } });
  c.record = [];
  c.bound = '101-004-7240139-001';
  c.brokerPicker.rows = [{ broker: 'my-oanda', identity: { display_name: 'OANDA', mode: 'paper' }, connected: true }];
  c.accountAnswers = [];
  c.route = (url, method, body) => {
    if (url === '/api/broker/held') return { status: 200, body: { held: c.record } };
    if (url === '/api/broker/list') return { status: 200, body: c.brokerPicker.rows };
    if (url === '/api/broker/connect') return { status: 200, body: { connected: true } };
    if (url === '/api/broker/account' && method === 'POST') {
      const a = c.accountAnswers.shift();
      if (a) return a;
      c.bound = body.account_id;
      return { status: 200, body: { broker: 'my-oanda', connected: true, account_id: body.account_id } };
    }
    if (url.startsWith('/api/broker/catalog')) return { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 }] };
    if (url === '/api/broker/subscribe') return { status: 200, body: { subscribed: body.symbols, refused: [] } };
    if (url.startsWith('/api/broker/quotes')) return { status: 200, body: {} };
    return undefined;
  };
  return c;
}
const switches = (c) => c.sent.filter((s) => s.method === 'POST' && s.url === '/api/broker/account').map((s) => s.body);
const asked = (c) => c.asked.map((a) => [a.text, a.ok, a.no]);
async function held(c) {
  c.record = [entry('unknown')];
  await c.tpbSwitch('my-oanda');
  await settle();
  assert.deepEqual([line(c).text, line(c).again], [HELD_CLOSE, true], 'the close is held');
}

await test('1. a close held: the switch asks first; Not now sends nothing', async () => {
  const c = loaded();
  await held(c);
  c.answer = false;
  const out = await c.csSwitchAccount('my-oanda', '101-004-7240139-003');
  assert.equal(out, null, 'nothing switched');
  assert.deepEqual(asked(c), [[HELD_CLOSE + ' Switch account anyway?', 'Switch', 'Not now']]);
  assert.deepEqual(switches(c), []);
});

await test('1. a close held: Switch sends the switch with confirm', async () => {
  const c = loaded();
  await held(c);
  c.answer = true;
  const out = await c.csSwitchAccount('my-oanda', '101-004-7240139-003');
  assert.ok(out && out.connected);
  assert.deepEqual(switches(c), [{ broker: 'my-oanda', account_id: '101-004-7240139-003', confirm: true }]);
});

await test('1. a request of this page on its way counts as well', async () => {
  const c = loaded();
  await c.tpbSwitch('my-oanda');
  c.tpxSending('close', CLOSE, { symbol: 'EUR_USD' });
  c.answer = false;
  await c.csSwitchAccount('my-oanda', '101-004-7240139-003');
  assert.equal(c.asked.length, 1);
  assert.ok(c.asked[0].text.endsWith(' Switch account anyway?'), c.asked[0].text);
  assert.deepEqual(switches(c), []);
});

await test('2. nothing held: no question, no confirm; the engine\'s 409 held_requests is asked in its words', async () => {
  const c = loaded();
  await c.tpbSwitch('my-oanda');
  c.accountAnswers.push({ status: 409, body: { detail: ENGINE_HELD, code: 'held_requests' } });
  c.answer = true;
  const out = await c.csSwitchAccount('my-oanda', '101-004-7240139-003');
  assert.ok(out && out.connected);
  assert.deepEqual(asked(c), [[ENGINE_HELD + ' Switch account anyway?', 'Switch', 'Not now']]);
  assert.deepEqual(switches(c), [{ broker: 'my-oanda', account_id: '101-004-7240139-003' },
                                 { broker: 'my-oanda', account_id: '101-004-7240139-003', confirm: true }]);
  // and Not now leaves it at the one refused
  const d = loaded();
  await d.tpbSwitch('my-oanda');
  d.accountAnswers.push({ status: 409, body: { detail: ENGINE_HELD, code: 'held_requests' } });
  d.answer = false;
  assert.equal(await d.csSwitchAccount('my-oanda', '101-004-7240139-003'), null);
  assert.equal(switches(d).length, 1);
});

await test('3. Ask again on another account: the engine\'s words, Switch back, then Ask again as usual', async () => {
  const c = loaded();
  await held(c);
  c.answer = true;
  await c.csSwitchAccount('my-oanda', '101-004-7240139-003');     // switched anyway
  await settle();
  // Ask again: refused, the close sent on -001 and the profile now on -003
  c.route = ((base) => (url, method, body) => (url === '/api/broker/close'
    ? (c.bound === '101-004-7240139-001'
        ? { status: 200, body: { status: 'filled' } }
        : { status: 409, body: { detail: OTHER, code: 'held_other_account' } })
    : base(url, method, body)))(c.route);
  await c.tpxAskAgain();
  await settle();
  assert.deepEqual(line(c).parts, [[OTHER, 'err'], [HELD_CLOSE, 'err']], 'its words, the close still held after them');
  assert.equal(c.tpx.held.length, 1);
  assert.ok(!c.$('tpx-back').classList.contains('hidden'), 'Switch back is offered');
  await c.tpxSwitchBack();
  await settle();
  assert.deepEqual(switches(c).at(-1), { broker: 'my-oanda', account_id: '101-004-7240139-001', confirm: true });
  assert.ok(c.$('tpx-back').classList.contains('hidden'), 'Switch back has done its job');
  assert.deepEqual([line(c).text, line(c).again], [HELD_CLOSE, true], 'held again, on the account it went out on');
  await c.tpxAskAgain();
  await settle();
  const closes = c.sent.filter((s) => s.url === '/api/broker/close');
  assert.deepEqual(closes.map((s) => s.body), [CLOSE, CLOSE], 'the same body under the same client_id, both times');
  assert.equal(c.tpx.held.length, 0, 'answered: no longer held');
});

// ── 1. the card's chooser goes through that switch ──────────────────────────
function cardEl(tag) {
  const e = { tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, _cls: new Set(), _text: '',
    disabled: false, onclick: null, title: '', value: '', type: '', placeholder: '', listeners: {},
    get className() { return [...this._cls].join(' '); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((x) => x.textContent || '').join(''); },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html || ''; },
    appendChild(ch) { this.children.push(ch); return ch; },
    append(...chs) { for (const ch of chs) this.appendChild(typeof ch === 'string' ? cardEl('#text') : ch); },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector(sel) { return all(this).find((x) => x._cls.has(sel.replace(/^\./, ''))) || null; },
    querySelectorAll(sel) { return sel === 'button' ? all(this).filter((x) => x.tagName === 'BUTTON')
      : all(this).filter((x) => x._cls.has(sel.replace(/^\./, ''))); },
    remove() {} };
  e.classList = { add: (x) => e._cls.add(x), remove: (x) => e._cls.delete(x), contains: (x) => e._cls.has(x),
                  toggle: (x, on) => (on ? e._cls.add(x) : e._cls.delete(x)) };
  return e;
}
function all(e, out = []) { for (const ch of e.children || []) { out.push(ch); all(ch, out); } return out; }
await test('1. the card\'s chooser: its second click is the switch that asks first', async () => {
  const fns = ['brokerIdentity', 'brokerDisplayName', 'brokerIsPaper', 'csExampleLogo', 'csFailText',
               'tpbPlainReason', 'csEmptyFields', 'csMissingFields', 'csListWords', 'csNeedsUpdate', 'csDraft',
               'csBrokerCard', 'oneLine', 'csListedRow', 'csKeysHelp', 'csKeyLinkWords', 'csSecretBox'];
  const c = { document: { createElement: cardEl }, String, Array, Object, Number, Set, JSON, RegExp, Math, Promise,
    connScreen: { errors: {}, notes: {}, keysOpen: {}, keyDrafts: {}, examples: [], origin: '', printedOpen: {},
                  acctPreview: {} },
    state: { providers: [], provider: 'lse' }, csEsc: (s) => String(s ?? ''), $: () => null,
    askConfirm: async () => false, brokerArm: async () => false, refreshConnScreen: async () => {},
    renderConnBar() {}, renderConnScreen() {}, csForgetKeys() {}, startAppUpdate() {}, csConnect: async () => ({}),
    closeConnScreen() {}, enterLiveSource() {}, brokerDisconnect: async () => {}, refreshProviders: async () => {},
    csUnlinkBroker() {}, csDraftDrop() {}, csDraftSet() {}, tpbSwitch: async () => ({}), tpxHeldAsk: async () => true,
    posted: [], switched: [],
    fetch: async (url, init) => { c.posted.push([url, init && init.body]); return { ok: true, status: 200,
      json: async () => ({ connected: true }), text: async () => '{"connected": true}' }; },
    csSwitchAccount: async (key, id) => { c.switched.push([key, id]); return { connected: true }; } };
  vm.createContext(c);
  const src = (await import('./ticket_page.mjs')).src;
  for (const n of fns) if (src.includes('\nfunction ' + n + '(') || src.includes('\nasync function ' + n + '(')) {
    vm.runInContext(cut(n), c);
  }
  const hub = { broker: 'my-oanda', registered: true, connected: true, identity: { display_name: 'OANDA', mode: 'paper' },
                mode: 'paper', account_id: '101-004-7240139-001', stored_credentials: ['token'],
                credential_form: [{ key: 'token', label: 'API token', type: 'password' }],
                accounts: [{ id: '101-004-7240139-001', label: 'Primary', mode: 'demo' },
                           { id: '101-004-7240139-003', label: 'Hedging', mode: 'demo' }] };
  const card = c.csBrokerCard(null, hub, { headless: true });
  const other = all(card).find((x) => x.tagName === 'BUTTON' && x._cls.has('cs-acct') && !x._cls.has('inuse'));
  assert.ok(other, 'the account not in use is a button');
  await other.onclick();          // preview
  await other.onclick();          // commit
  assert.deepEqual(c.switched, [['my-oanda', '101-004-7240139-003']], 'the switch that asks first');
  assert.deepEqual(c.posted.filter((p) => p[0] === '/api/broker/account'), [], 'nothing posted around it');
});

// ── 4. timeframes ───────────────────────────────────────────────────────────
function tfPage(providers, provider, timeframe) {
  const nav = element('nav', 'timeframes');
  const c = { state: { providers, provider, timeframe, symbol: 'EURUSD' }, $: () => nav, nav,
              document: { createElement: (t) => element(t) }, Number, String, Math, RegExp, Array, Object,
              loadChart() { c.loaded = (c.loaded || 0) + 1; }, datasetTf: () => '' };
  vm.createContext(c);
  for (const n of ['renderTimeframes', 'tfMinutes', 'tfOffered', 'tfNearest']) vm.runInContext(cut(n), c);
  return c;
}
await test('4. a source listing 30m gets a 30m button, in its place by length', () => {
  const c = tfPage([{ name: 'broker:my-capitalcom', timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '30m'] }],
                   'broker:my-capitalcom', '1h');
  c.renderTimeframes();
  assert.deepEqual(c.nav.children.map((b) => b.textContent), ['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
  const b30 = c.nav.children.find((b) => b.textContent === '30m');
  b30.onclick();
  assert.equal(c.state.timeframe, '30m');
  assert.equal(c.loaded, 1, 'pressed, it charts 30m');
  // a source listing no 30m has no such button
  const d = tfPage([{ name: 'broker:my-oanda', timeframes: ['1m', '5m', '15m', '1h', '4h', '1d'] }], 'broker:my-oanda', '1h');
  d.renderTimeframes();
  assert.ok(!d.nav.children.some((b) => b.textContent === '30m'));
});
await test('4. a timeframe the source does not list is not asked of it: the nearest it lists', () => {
  const c = tfPage([], '', '30m');
  assert.equal(c.tfNearest('30m', ['1m', '5m', '15m', '1h', '4h', '1d']), '1h', 'between 15m and 1h: the longer');
  assert.equal(c.tfNearest('2h', ['1m', '1h', '4h']), '4h', 'as near as 1h: the longer');
  assert.equal(c.tfNearest('3h', ['1m', '1h', '4h']), '4h');
  assert.equal(c.tfNearest('90m', ['1m', '1h', '4h']), '1h');
  assert.equal(c.tfNearest('30m', ['tick', '30m']), '30m');
  assert.equal(c.tfNearest('tick', ['1m', '5m']), '1m', 'a tick chart on a source without one: its finest');
  assert.deepEqual([...c.tfOffered({ timeframes: ['tick', '1h', '30m', '1m'] })], ['tick', '1m', '30m', '1h']);
});

done('test_account_switch.mjs');
