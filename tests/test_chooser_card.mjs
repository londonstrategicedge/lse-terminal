// A broker's card while its login waits on the account chooser, and the
// account list a linked row shows before Connect. The shipped functions are
// cut out of app.js by name and run in node:vm against a small fake DOM.
//
// Guarded against, on a demo login: after Connect on a login that reaches
// several accounts, an adapter kept running, logged in, for up to an hour
// while the card shows only the chooser, with no Disconnect and no Cancel;
// and a row connected before listing the accounts it knew as buttons, so
// that a click on one right after Connect is lost when Connect repaints the
// card (or read as a choice of account).
//
// What is pinned:
//   1. A card waiting on its chooser offers Cancel. Cancel lets the pending
//      connection go (POST /api/broker/disconnect on that row, until the
//      engine has a route of its own for it), and the card then reads as
//      linked, not connected: Connect, no chooser, "Not connected".
//   2. Before Connect (not connected, nothing asked), the accounts the row
//      knew are shown as information, not as buttons: a click on one is not
//      a choice, and while Connect is on its way nothing there is a control.
//      The chooser's buttons come when the engine asks (needs_account).
//   3. The chooser's first click (the preview) survives a repaint of the
//      screen, so the second click is the choice it was.
//   4. Connected, the accounts stay the switch they were (buttons).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test, done } from './ticket_page.mjs';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
function cut(name) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  return src.slice(start + 1, src.indexOf('\n}\n', start) + 2);
}
const has = (name) => src.includes('\nfunction ' + name + '(') || src.includes('\nasync function ' + name + '(');

function el(tag) {
  const e = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, _text: '', _cls: new Set(),
    disabled: false, value: '', placeholder: '', type: '', title: '', onclick: null, listeners: {}, href: '',
    get className() { return [...this._cls].join(' '); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); },
    set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, ''); this.children = []; },
    get innerHTML() { return this._html || ''; },
    appendChild(ch) { this.children.push(ch); return ch; },
    append(...chs) { for (const ch of chs) this.appendChild(typeof ch === 'string' ? el('#text') : ch); },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector(sel) { return find(this, sel)[0] || null; },
    querySelectorAll(sel) { return find(this, sel); },
    remove() {},
  };
  e.classList = { add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c), contains: (c) => e._cls.has(c),
                  toggle: (c, on) => (on === undefined ? (e._cls.has(c) ? e._cls.delete(c) : e._cls.add(c)) : on ? e._cls.add(c) : e._cls.delete(c)) };
  return e;
}
function walk(e, out = []) { out.push(e); for (const ch of e.children || []) walk(ch, out); return out; }
function find(e, sel) {
  const all = walk(e).slice(1);
  if (sel.startsWith('.')) return all.filter((x) => x._cls && x._cls.has(sel.slice(1)));
  return all.filter((x) => x.tagName === sel.toUpperCase());
}

const FNS = ['brokerIdentity', 'brokerDisplayName', 'brokerIsPaper', 'csExampleLogo', 'csFailText', 'tpbPlainReason',
  'csEmptyFields', 'csMissingFields', 'csListWords', 'csNeedsUpdate', 'csDraft', 'csBrokerCard'];
const OPTIONAL = ['csListedRow', 'csKeysHelp', 'csKeyLinkWords', 'oneLine', 'csCancelPending', 'csSecretBox'];

function page() {
  const c = {
    document: { createElement: el }, String, Array, Object, Number, Set, JSON, RegExp, Math, Promise,
    connScreen: { errors: {}, notes: {}, keysOpen: {}, keyDrafts: {}, examples: [], origin: '', printedOpen: {},
                  acctPreview: {}, broker: null, brokerPinned: false },
    state: { providers: [], provider: 'lse' }, csEsc: (s) => String(s ?? ''), $: () => null,
    askConfirm: async () => false, brokerArm: async () => false,
    refreshes: 0, refreshConnScreen: async () => { c.refreshes += 1; }, renderConnBar() {}, renderConnScreen() {},
    csForgetKeys() {}, startAppUpdate() {}, closeConnScreen() {}, enterLiveSource() {}, refreshProviders: async () => {},
    csUnlinkBroker() {}, csDraftDrop() {}, csDraftSet() {}, tpbSwitch: async () => ({}), tpxHeldAsk: async () => true,
    switched: [], csSwitchAccount: async (k, id) => { c.switched.push([k, id]); return { connected: true }; },
    connected: [], csConnect: async (k) => { c.connected.push(k); return {}; },
    sent: [], disconnected: [],
    brokerDisconnect: async (k) => { c.disconnected.push(k); },
    fetch: async (url, init) => { c.sent.push([url, init && init.body]); return { ok: true, status: 200,
      json: async () => ({}), text: async () => '{}' }; },
  };
  vm.createContext(c);
  for (const n of FNS) vm.runInContext(cut(n), c);
  for (const n of OPTIONAL) if (has(n)) vm.runInContext(cut(n), c);
  return c;
}
const ACCTS = [{ id: '101-004-7240139-001', label: 'Primary', mode: 'demo', balance: 100000, currency: 'USD' },
               { id: '101-004-7240139-003', label: 'Hedging', mode: 'demo', balance: 50000, currency: 'USD' }];
const HUB = (more = {}) => ({ broker: 'my-oanda', registered: true, example: 'oanda', connected: false,
  identity: { display_name: 'OANDA', mode: 'paper' }, mode: 'paper', stored_credentials: ['token'],
  credential_form: [{ key: 'token', label: 'API token', type: 'password' }], ...more });
const buttons = (card) => find(card, 'button').map((b) => b.textContent.trim());
const acctButtons = (card) => find(card, 'button').filter((b) => b._cls.has('cs-acct'));

await test('1. a card waiting on its chooser offers Cancel', () => {
  const c = page();
  const card = c.csBrokerCard(null, HUB({ needs_account: true, accounts: ACCTS }), { headless: true });
  assert.equal(acctButtons(card).length, 2, 'the chooser');
  assert.ok(buttons(card).includes('Cancel'), buttons(card).join(' | '));
  assert.ok(!buttons(card).includes('Connect'), 'no Connect beside the chooser');
});

await test('1. Cancel lets the pending connection go, and the card reads as linked', async () => {
  const c = page();
  const card = c.csBrokerCard(null, HUB({ needs_account: true, accounts: ACCTS }), { headless: true });
  const cancel = find(card, 'button').find((b) => b.textContent.trim() === 'Cancel');
  await cancel.onclick();
  assert.deepEqual(c.disconnected, ['my-oanda'], 'the pending row is let go through the disconnect route');
  assert.ok(c.refreshes >= 1, 'the screen is read again');
  // as the engine lists the row after it: not connected, nothing asked
  const after = c.csBrokerCard(null, HUB({ accounts: ACCTS }), { headless: true });
  assert.ok(buttons(after).includes('Connect'), buttons(after).join(' | '));
  assert.ok(!buttons(after).includes('Cancel'));
  assert.equal(acctButtons(after).length, 0, 'no chooser');
});

await test('2. before Connect the accounts a row knew are information, not buttons', async () => {
  const c = page();
  const card = c.csBrokerCard(null, HUB({ accounts: ACCTS, account_id: '101-004-7240139-001' }), { headless: true });
  assert.equal(acctButtons(card).length, 0, 'no account is a button before the engine asks');
  const rows = find(card, '.cs-acct');
  assert.equal(rows.length, 2, 'both are listed');
  assert.ok(rows.every((r) => r.tagName !== 'BUTTON' && !r.onclick), 'none is a control');
  assert.ok(card.textContent.includes('Used last'), 'the bound one is marked as used last, not in use');
  assert.ok(!card.textContent.includes('In use'));
  // Connect pressed: while it is on its way the list is still no control
  const go = find(card, 'button').find((b) => b.textContent.trim() === 'Connect');
  const p = go.onclick();
  assert.equal(go.textContent, 'Connecting…');
  assert.equal(acctButtons(card).length, 0);
  await p;
});

await test('3. the chooser\'s first click survives a repaint', async () => {
  const c = page();
  const hub = HUB({ needs_account: true, accounts: ACCTS });
  const card = c.csBrokerCard(null, hub, { headless: true });
  const hedging = acctButtons(card).find((b) => b.textContent.includes('Hedging'));
  await hedging.onclick();                                // the preview
  assert.equal(find(card, '.cs-acct-preview').length, 1);
  const again = c.csBrokerCard(null, hub, { headless: true });   // the screen repainted
  const kept = acctButtons(again).find((b) => b.textContent.includes('Hedging'));
  assert.ok(kept._cls.has('chosen'), 'still previewed after the repaint');
  assert.equal(find(again, '.cs-acct-preview').length, 1);
  await kept.onclick();                                   // the second click
  assert.deepEqual(c.switched, [['my-oanda', '101-004-7240139-003']], 'the choice it was');
});

await test('4. connected, the accounts stay the switch they were', () => {
  const c = page();
  const card = c.csBrokerCard(null, HUB({ connected: true, accounts: ACCTS, account_id: '101-004-7240139-001' }),
                              { headless: true });
  assert.equal(acctButtons(card).length, 2);
  assert.ok(card.textContent.includes('In use'));
});

done('test_chooser_card.mjs');
