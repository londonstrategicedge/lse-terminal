// A request held on a broker that is NOT connected, and one the engine left
// unknown because it stopped. The shipped functions are cut out of app.js by
// name and run in node:vm (tests/ticket_page.mjs), with a fetch that answers
// as the engine would.
//
// After an engine restart the new engine connects nothing. Guarded against:
// a page that opens on the simulator and says nothing about a close held on
// a listed broker until the user presses Connect on that broker's card; and
// an entry the engine marked engine_stopped said on the line as "the answer
// from <the broker> was lost" while its tooltip says the Terminal had
// stopped.
//
// What is pinned:
//   1. A held entry ("out" or "unknown") of a broker that is not connected is
//      on the ticket's line as "<its display name>: <the held sentence>",
//      with a Connect button (no Show, no Ask again).
//   2. Connect connects that broker as its card's Connect does (csConnect,
//      then pickBroker): the ticket is put on it, and its connect holds the
//      request again with Ask again, which sends the same body under the
//      same client_id. A broker whose saved keys do not cover its boxes is
//      not connected blind: its card is opened instead, nothing sent.
//   3. An "unknown" entry whose code is engine_stopped is said in the
//      record's own words ("The Terminal stopped before the broker's answer
//      came ..."), on the ticket's broker and on another's, not the
//      lost-answer words.
//   4. A held entry of a connected broker other than the ticket's keeps Show.
//   5. Disconnecting the ticket's broker while a close is held on it leaves
//      the close named on the line with Connect.
import assert from 'node:assert/strict';
import { page, line, settle, test, done, element, src } from './ticket_page.mjs';

const STOPPED = "The Terminal stopped before the broker's answer came, so it may have been carried out: "
  + 'check Positions before sending it again.';
const CLOSE = { broker: 'my-oanda', position_id: 'EUR_USD', qty: 1000, client_id: 'lset-close-e84c991719b8' };
const entry = (state, more = {}) => ({ broker: 'my-oanda', client_id: CLOSE.client_id, route: '/api/broker/close',
  what: 'close', request: CLOSE, since: '2026-11-15T07:13:44Z', state, instrument: null,
  detail: state === 'unknown' ? STOPPED : null, code: state === 'unknown' ? 'engine_stopped' : null,
  account: '101-004-7240139-001', ...more });
const OANDA = (more = {}) => ({ broker: 'my-oanda', registered: true, example: 'oanda', connected: false,
  identity: { display_name: 'OANDA', mode: 'paper' }, mode: 'paper',
  credential_form: [{ key: 'token', label: 'API token', type: 'password' }], stored_credentials: ['token'], ...more });
const ROWS = (oanda = {}) => [
  { broker: 'paper', identity: { display_name: 'Paper simulator', mode: 'paper' }, connected: true, ready: true },
  OANDA(oanda),
];
const store = (init = {}) => { const kept = { ...init };
  return { kept, getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } }; };
const FNS = ['tpbSetup', 'pickBroker', 'csConnect', 'brokerIsPaper', 'brokerDisconnect']
  .concat(src.includes('\nasync function tpxConnectHeld(') ? ['tpxConnectHeld'] : []);

function loaded(rows = ROWS(), ls = store({ 'lse.ticket.broker': 'my-oanda' })) {
  const c = page({ more: FNS, ctx: { localStorage: ls, closeConnMenu() {}, renderConnScreen() {},
    opened: [], openConnScreen() { c.opened.push(c.connScreen.broker); },
    connScreen: { errors: {}, notes: {}, keysOpen: {}, broker: null, brokerPinned: false },
    brokerArm: async () => false, brokerLiveQuestion: () => 'live?',
    // (a page without the ticket line's Connect: pressing it does nothing)
    tpxConnectHeld: async () => {} } });
  c.tpb.broker = 'lse-hosted';
  c.tpx.held = [];
  c.record = [];
  c.brokerPicker.rows = rows;
  for (const b of rows) { const o = element('option'); o.value = b.broker; c.$('tpx-broker').appendChild(o); }
  c.route = (url, method, body) => {
    if (url === '/api/broker/held') return { status: 200, body: { held: c.record } };
    if (url === '/api/broker/list') return { status: 200, body: c.brokerPicker.rows.map((r) => ({ ...r })) };
    if (url === '/api/broker/connect') {
      const r = c.brokerPicker.rows.find((x) => x.broker === body.broker);
      if (r) r.connected = true;
      return { status: 200, body: { broker: body.broker, connected: true } };
    }
    if (url === '/api/broker/disconnect') {
      const r = c.brokerPicker.rows.find((x) => x.broker === body.broker);
      if (r) r.connected = false;
      return { status: 200, body: { broker: body.broker, connected: false } };
    }
    if (url.startsWith('/api/broker/catalog')) return { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 }] };
    if (url === '/api/broker/subscribe') return { status: 200, body: { subscribed: body.symbols, refused: [] } };
    if (url.startsWith('/api/broker/quotes')) return { status: 200, body: {} };
    return undefined;
  };
  return c;
}
const shown = (c, id) => !c.$(id).classList.contains('hidden');
const buttons = (c) => ({ again: shown(c, 'tpx-again'), show: shown(c, 'tpx-show'), connect: shown(c, 'tpx-conn') });
const posts = (c, url) => c.sent.filter((s) => s.method === 'POST' && s.url === url);

await test('1, 3. after an engine restart: the held close of OANDA, not connected, is named with Connect', async () => {
  const c = loaded();
  c.record = [entry('unknown')];
  await c.tpbSetup();
  await settle();
  assert.equal(c.tpb.broker, 'paper', 'the new engine connected nothing: the ticket is on the simulator');
  assert.deepEqual([line(c).text, line(c).cls], ['OANDA: ' + STOPPED, 'err']);
  assert.deepEqual(buttons(c), { again: false, show: false, connect: true });
});

await test('2. Connect connects OANDA as its card does, and the close is held again with Ask again', async () => {
  const c = loaded();
  c.record = [entry('unknown')];
  await c.tpbSetup();
  await settle();
  await c.tpxConnectHeld();
  await settle();
  assert.deepEqual(posts(c, '/api/broker/connect').map((s) => s.body.broker), ['paper', 'my-oanda']);
  assert.equal(c.tpb.broker, 'my-oanda', 'the ticket is put on it');
  assert.deepEqual([line(c).text, line(c).cls], [STOPPED, 'err'], 'the record\'s own words, its broker the ticket\'s');
  assert.deepEqual(buttons(c), { again: true, show: false, connect: false });
  c.answers.push({ status: 200, body: { status: 'filled' } });
  c.route = ((base) => (url, method, body) => (url === '/api/broker/close' ? undefined : base(url, method, body)))(c.route);
  await c.tpxAskAgain();
  await settle();
  const sent = posts(c, '/api/broker/close');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, CLOSE, 'the same body under the same client_id');
});

await test('2. saved keys that do not cover the boxes: its card is opened, nothing sent', async () => {
  const c = loaded(ROWS({ stored_credentials: [] }));
  c.record = [entry('unknown')];
  await c.tpbSetup();
  await settle();
  await c.tpxConnectHeld();
  await settle();
  assert.deepEqual(posts(c, '/api/broker/connect').map((s) => s.body.broker), ['paper'], 'OANDA is not connected blind');
  assert.deepEqual(c.opened, ['my-oanda'], 'its card is opened');
  assert.equal(c.connScreen.brokerPinned, true);
});

await test('1. an entry still out on a broker not connected: waiting, named, with Connect', async () => {
  const c = loaded();
  c.record = [entry('out')];
  await c.tpbSetup();
  await settle();
  assert.deepEqual([line(c).text, line(c).cls],
    ['OANDA: The close of 1000 EUR_USD sent before this page was loaded is waiting for OANDA\'s answer.', 'err']);
  assert.deepEqual(buttons(c), { again: false, show: false, connect: true });
});

await test('3. engine_stopped on the ticket\'s own broker: the record\'s words, not the lost-answer words', async () => {
  const c = loaded(ROWS({ connected: true }));
  c.record = [entry('unknown')];
  await c.tpbSetup();
  await settle();
  assert.equal(c.tpb.broker, 'my-oanda');
  assert.deepEqual([line(c).text, line(c).cls, line(c).title], [STOPPED, 'err', STOPPED]);
  assert.deepEqual(buttons(c), { again: true, show: false, connect: false });
  // an entry whose answer was lost keeps the lost-answer words
  const d = loaded(ROWS({ connected: true }));
  d.record = [entry('unknown', { code: 'internal', detail: 'internal: OANDA did not answer (TimeoutError)' })];
  await d.tpbSetup();
  await settle();
  assert.equal(line(d).text, 'The close may have been carried out: the answer from OANDA was lost. '
    + 'Check Positions before closing it again.');
});

await test('4. a held entry of another CONNECTED broker keeps Show', async () => {
  const c = loaded(ROWS({ connected: true }), store({ 'lse.ticket.broker': 'paper' }));
  // the record lists the close only after the ticket chose its broker, and
  // the ticket is put back on the simulator: the close is another's
  c.record = [];
  await c.tpbSetup();
  await settle();
  c.record = [entry('unknown')];
  c.tpb.broker = 'paper';
  await c.tpxLoadHeld('paper');
  await settle();
  assert.deepEqual([line(c).text, line(c).cls], ['OANDA: ' + STOPPED, 'err']);
  assert.deepEqual(buttons(c), { again: false, show: true, connect: false });
});

await test('5. the ticket\'s broker disconnected while a close is held: the close is named with Connect', async () => {
  const c = loaded(ROWS({ connected: true }));
  c.record = [entry('unknown', { code: 'internal', detail: 'internal: lost' })];
  await c.tpbSetup();
  await settle();
  assert.equal(c.tpb.broker, 'my-oanda');
  await c.brokerDisconnect('my-oanda');
  await settle();
  assert.deepEqual([line(c).text, line(c).cls], ['OANDA: The close may have been carried out: the answer from '
    + 'OANDA was lost. Check Positions before closing it again.', 'err']);
  assert.deepEqual(buttons(c), { again: false, show: false, connect: true });
});

done('test_held_elsewhere.mjs');
