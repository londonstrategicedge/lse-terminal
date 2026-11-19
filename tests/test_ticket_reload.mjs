// The ticket after a reload, and what is held on a broker the ticket is not
// on. The shipped functions are cut out of app.js by name and run in node:vm
// (tests/ticket_page.mjs), with a fetch that answers as the engine would.
//
// The case: a ticket that adopts the first connected row after a reload, the
// built-in paper one, does not show a held close of another broker until the
// user disconnects and connects that broker again.
//
// What is pinned:
//   1. On load the ticket opens on (1) a connected broker with an entry "out"
//      or "unknown" in the engine's record, oldest first; else (2) the broker
//      the ticket was on before the reload, kept by the page in localStorage
//      under lse.ticket.broker, if it is still connected; else (3) the rule
//      before: an open connection, the demo account, the simulator. Every
//      read and write of the store is in a try: the page works without it.
//   2. A held ("out" or "unknown") entry of a connected broker that is not
//      the ticket's is on the ticket's line as "<the broker's name>: <the
//      held sentence>", after any answer, with a Show button that points the
//      ticket at that broker, which then holds it as usual.
//   3. Disconnect, Unlink or Forget of a broker with anything out or held on
//      it asks first: "<the held sentence> Disconnect anyway?" (Disconnect /
//      Not now), "... Unlink anyway?", "... Forget anyway?"; Not now does
//      nothing. Nothing out or held: no question.
//   4. The guide's bullet says what a reload and a Disconnect do.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { page, line, settle, test, done, src, cut, element } from './ticket_page.mjs';
import vm from 'node:vm';

const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';
const CLOSE = { broker: 'my-oanda', position_id: 'EUR_USD', qty: 1000, client_id: 'lset-close-11e3a7df97e1' };
const ORDER = { broker: 'my-alp', symbol: 'AAPL', side: 'buy', qty: 5, client_id: 'lset-0a1b2c3d4e5f' };
const DETAIL = 'internal: Not known yet whether OANDA carried out the close: it did not answer (TimeoutError).';
const ent = (route, what, request, state, since, more = {}) => ({ broker: request.broker,
  client_id: request.client_id, route, what, request, since, state,
  instrument: request.symbol == null ? null : request.symbol, detail: null, code: null, ...more });
const E_CLOSE = (state, since = '2026-11-15T07:13:44Z', more = {}) =>
  ent('/api/broker/close', 'close', CLOSE, state, since, { detail: state === 'unknown' ? DETAIL : null, ...more });
const E_ORDER = (state, since = '2026-11-15T07:12:01Z') => ent('/api/broker/order', 'order', ORDER, state, since);
const ROWS = () => [
  { broker: 'paper', identity: { display_name: 'Paper simulator' }, connected: true, ready: true },
  { broker: 'my-alp', identity: { display_name: 'Alpaca' }, connected: true },
  { broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true },
  { broker: 'my-gone', identity: { display_name: 'Gone' }, connected: false },
];
function store(init = {}, broken = false) {
  const kept = { ...init };
  return { kept, getItem: (k) => { if (broken) throw new Error('denied'); return k in kept ? kept[k] : null; },
           setItem: (k, v) => { if (broken) throw new Error('denied'); kept[k] = String(v); } };
}
function engine(c, rows = ROWS()) {
  c.record = []; c.heldAsked = 0;
  c.brokerPicker.rows = rows;
  c.route = (url, method, body) => {
    if (url === '/api/broker/held') { c.heldAsked += 1; return { status: 200, body: { held: c.record } }; }
    if (url === '/api/broker/list') return { status: 200, body: c.brokerPicker.rows };
    if (url === '/api/broker/connect') return { status: 200, body: { connected: true } };
    if (url.startsWith('/api/broker/catalog')) return { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 },
      { symbol: 'GBP_USD', digits: 5 }, { symbol: 'AAPL', digits: 2 }] };
    if (url === '/api/broker/subscribe') return { status: 200, body: { subscribed: body.symbols, refused: [] } };
    if (url.startsWith('/api/broker/quotes')) return { status: 200, body: {} };
    if (url === '/api/broker/disconnect') return { status: 200, body: { connected: false } };
    return undefined;
  };
}
function loaded(ls, more = []) {
  const c = page({ more: ['tpbSetup', ...more], ctx: ls === undefined ? {} : { localStorage: ls } });
  c.tpb.broker = 'lse-hosted';
  // the ticket's broker select, as tpbSetup fills it
  for (const b of ROWS()) { const o = element('option'); o.value = b.broker; c.$('tpx-broker').appendChild(o); }
  return c;
}
const posts = (c, url) => c.sent.filter((s) => s.method === 'POST' && s.url === url);

// ── 1. where the ticket opens ───────────────────────────────────────────────
await test('(1) a connected broker with an entry out or unknown, oldest first', async () => {
  const c = loaded(store({ 'lse.ticket.broker': 'paper' }));
  engine(c);
  c.record = [ent('/api/broker/order', 'order', { ...ORDER, broker: 'my-gone', client_id: 'lset-111111111111' },
                  'unknown', '2026-11-15T07:00:00Z'),                        // older, but not connected
              ent('/api/broker/close', 'close', { ...CLOSE, client_id: 'lset-close-0a0a0a0a0a0a' }, 'answered',
                  '2026-11-15T07:05:00Z', { ok: true, status: 200 }),                  // older, but answered
              E_CLOSE('unknown', '2026-11-15T07:13:44Z'), E_ORDER('out', '2026-11-15T07:12:01Z')];
  await c.tpbSetup();
  assert.equal(c.tpb.broker, 'my-alp', 'the oldest out or unknown of a connected broker: the order on my-alp');
  assert.equal(c.$('tpx-broker').value, 'my-alp');
  assert.deepEqual(c.tpx.held.map((h) => [h.broker, h.kind, !!h.waiting]), [['my-alp', 'order', true]]);
  // the other connected broker's held close is on the line, named, with Show
  assert.ok(line(c).text.startsWith('The order to buy 5 AAPL sent before this page was loaded is waiting'), line(c).text);
  const c2 = loaded(store());
  engine(c2);
  c2.record = [E_CLOSE('unknown', '2026-11-15T07:13:44Z'), E_ORDER('unknown', '2026-11-15T07:20:00Z')];
  await c2.tpbSetup();
  assert.equal(c2.tpb.broker, 'my-oanda', 'the close is the older now');
  assert.deepEqual([line(c2).text, line(c2).again], [HELD_CLOSE, true]);
});
await test('(2) the broker the ticket was on before the reload, if it is still connected', async () => {
  const c = loaded(store({ 'lse.ticket.broker': 'my-oanda' }));
  engine(c);
  await c.tpbSetup();
  assert.equal(c.tpb.broker, 'my-oanda', 'not the first connected row (paper)');
  for (const [what, ls] of [['not connected any more', store({ 'lse.ticket.broker': 'my-gone' })],
                            ['never listed', store({ 'lse.ticket.broker': 'nobody' })],
                            ['nothing kept', store()],
                            ['a store that throws', store({ 'lse.ticket.broker': 'my-oanda' }, true)],
                            ['no store at all', undefined]]) {
    const d = loaded(ls);
    engine(d);
    await d.tpbSetup();
    assert.equal(d.tpb.broker, 'paper', what + ': the rule before (the first open connection)');
  }
});
await test('(3) the rule before: an open connection, else the demo account, else the simulator', async () => {
  const c = loaded(store());
  engine(c, [{ broker: 'paper', connected: false }, { broker: 'lse-sim', ready: true, connected: false }]);
  await c.tpbSetup();
  assert.equal(c.tpb.broker, 'lse-sim');
  const d = loaded(store());
  engine(d, [{ broker: 'paper', connected: false }]);
  await d.tpbSetup();
  assert.equal(d.tpb.broker, 'paper');
});
await test('the ticket\'s broker is kept under lse.ticket.broker, and a store that throws changes nothing', async () => {
  const ls = store();
  const c = loaded(ls);
  engine(c);
  await c.tpbSwitch('my-oanda');
  assert.equal(ls.kept['lse.ticket.broker'], 'my-oanda');
  await c.tpbSwitch('lse-hosted');                              // the hosted relay is not a broker to come back to
  assert.equal(ls.kept['lse.ticket.broker'], 'my-oanda');
  const d = loaded(store({}, true));
  engine(d);
  const out = await d.tpbSwitch('my-oanda');
  assert.equal(out.ok, true, 'a store that throws: the switch goes on');
  assert.equal(d.tpb.broker, 'my-oanda');
  assert.ok(src.includes('"lse.ticket.broker"'), 'the key the page keeps it under');
});

// ── 2. another connected broker's held request on the line, with Show ───────
await test('a held entry of another connected broker: "<name>: <held sentence>", Show, after any answer', async () => {
  const c = loaded(store());
  engine(c);
  c.record = [E_CLOSE('unknown')];
  await c.tpbSwitch('paper');
  assert.deepEqual([line(c).text, line(c).cls, line(c).title, line(c).again],
                   ['OANDA: ' + HELD_CLOSE, 'err', DETAIL, false]);
  assert.equal(c.$('tpx-show').classList.contains('hidden'), false, 'Show is offered');
  // an answer on the ticket's own broker: its words, then the other's warning
  c.route = ((base) => (url, method, body) => (url === '/api/broker/order'
    ? { status: 200, body: { status: 'filled', fill: { price: 1.09 } } } : base(url, method, body)))(c.route);
  await c.tpxOrder('buy');
  assert.deepEqual(line(c).parts, [['buy 1000 EUR_USD filled @ 1.09.', 'ok'], ['OANDA: ' + HELD_CLOSE, 'err']]);
  // Show points the ticket at that broker, which holds it as usual
  await c.tpxShowBroker();
  assert.equal(c.tpb.broker, 'my-oanda');
  assert.equal(c.$('tpx-broker').value, 'my-oanda');
  assert.deepEqual([line(c).text, line(c).title, line(c).again], [HELD_CLOSE, DETAIL, true]);
  assert.equal(c.$('tpx-show').classList.contains('hidden'), true, 'nothing of another broker to show now');
  assert.match(src, /\$\("tpx-show"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxShowBroker\(\); \};/);
  const html = fs.readFileSync(new URL('../lse_terminal/ui/static/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="tpx-show" class="hidden" type="button"[^>]*>Show<\/button>/);
});
await test('another broker\'s request still out: named and waiting; its answer clears the line', async () => {
  const c = loaded(store());
  engine(c);
  c.record = [E_CLOSE('out')];
  await c.tpbSwitch('paper');
  assert.equal(line(c).text, 'OANDA: The close of 1000 EUR_USD sent before this page was loaded is waiting for '
    + 'OANDA\'s answer.');
  c.record = [E_CLOSE('answered', '2026-11-15T07:13:44Z', { ok: true, status: 200 })];
  await c.tpxLoadHeld('paper');
  assert.deepEqual([line(c).text, c.$('tpx-show').classList.contains('hidden')], ['', true]);
  // a broker that is not connected is named too, with Connect in place of
  // Show (tests/test_held_elsewhere.mjs)
  c.record = [ent('/api/broker/order', 'order', { ...ORDER, broker: 'my-gone', client_id: 'lset-222222222222' },
                  'unknown', '2026-11-15T07:30:00Z')];
  await c.tpxLoadHeld('paper');
  assert.deepEqual([line(c).text, c.$('tpx-show').classList.contains('hidden'),
                    c.$('tpx-conn').classList.contains('hidden')],
    ['Gone: The order may have been placed: the answer from Gone was lost. Check Positions before placing it again.',
     true, false]);
});

// ── 3. Disconnect, Unlink, Forget ask first ─────────────────────────────────
await test('the question before a Disconnect, an Unlink or a Forget: the held sentence, then "<verb> anyway?"', async () => {
  const c = loaded(store());
  engine(c);
  c.record = [E_CLOSE('unknown')];
  await c.tpbSwitch('my-oanda');
  for (const verb of ['Disconnect', 'Unlink', 'Forget']) {
    c.answer = false;
    assert.equal(await c.tpxHeldAsk('my-oanda', verb), false, verb + ': Not now');
    assert.deepEqual(c.asked.at(-1), { text: HELD_CLOSE + ' ' + verb + ' anyway?', ok: verb, no: 'Not now' });
    c.answer = true;
    assert.equal(await c.tpxHeldAsk('my-oanda', verb), true, verb + ': yes');
  }
  const n = c.asked.length;
  assert.equal(await c.tpxHeldAsk('my-alp', 'Disconnect'), true, 'nothing held on it: no question');
  assert.equal(c.asked.length, n);
  // a request out (this page's own, in flight) counts as well
  let release;
  c.route = ((base) => (url, method, body) => (url === '/api/broker/order'
    ? new Promise((ok) => { release = () => ok({ status: 200, body: { status: 'filled', fill: { price: 190 } } }); })
    : base(url, method, body)))(c.route);
  await c.tpbSwitch('my-alp');
  c.$('tpx-bsym').value = 'AAPL';
  const out = c.tpxOrder('buy');
  await settle();
  c.answer = false;
  assert.equal(await c.tpxHeldAsk('my-alp', 'Disconnect'), false);
  assert.equal(c.asked.at(-1).text, 'The order to buy 1000 AAPL is waiting for Alpaca\'s answer. Disconnect anyway?');
  release();
  await out;
  // and a request another page left out, from the record
  c.record = [E_ORDER('out')];
  assert.equal(await c.tpxHeldAsk('my-alp', 'Unlink'), false);
  assert.equal(c.asked.at(-1).text,
               'The order to buy 5 AAPL sent before this page was loaded is waiting for Alpaca\'s answer. Unlink anyway?');
});
function screen(c, fns) {
  for (const n of fns) vm.runInContext(cut(n), c);
  return c;
}
await test('the dropdown row\'s x, Unlink and Forget keys ask first, and Not now does nothing', async () => {
  const c = loaded(store());
  engine(c);
  c.record = [E_CLOSE('unknown')];
  await c.tpbSwitch('my-oanda');
  const did = [];
  Object.assign(c, {
    brokerSubline: () => '', brokerIsPaper: () => false, brokerTooltip: () => '', pickBroker() {},
    refreshBrokerRows: async () => {}, connScreen: { errors: {}, notes: {}, keysOpen: {} }, csDraftDrop() {},
    refreshConnScreen: async () => {}, renderConnScreen() {}, refreshProviders: async () => {}, enterLiveSource() {},
    tpbSwitch: async (b) => { did.push(['switch', b]); return { ok: true }; },
  });
  screen(c, ['brokerDisconnect', 'brokerRow', 'csUnlinkBroker', 'csForgetKeys']);
  const row = c.brokerRow({ broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true });
  const x = row.children.find((ch) => ch.tagName === 'BUTTON');
  c.answer = false;
  await x.onclick({ stopPropagation() {} });
  await c.csUnlinkBroker('my-oanda', { broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true });
  await c.csForgetKeys('my-oanda', 'OANDA');
  assert.deepEqual(c.asked.slice(-3).map((a) => [a.text, a.ok, a.no]), [
    [HELD_CLOSE + ' Disconnect anyway?', 'Disconnect', 'Not now'],
    [HELD_CLOSE + ' Unlink anyway?', 'Unlink', 'Not now'],
    [HELD_CLOSE + ' Forget anyway?', 'Forget', 'Not now']]);
  for (const url of ['/api/broker/disconnect', '/api/broker/unlink', '/api/broker/credentials']) {
    assert.equal(posts(c, url).length, 0, 'Not now: nothing sent to ' + url);
  }
  // a yes goes on: the Disconnect, and the Unlink's and the Forget's own questions after it
  c.answer = true;
  await x.onclick({ stopPropagation() {} });
  assert.equal(posts(c, '/api/broker/disconnect').length, 1);
  const n = c.asked.length;
  c.answer = (text) => text.endsWith('anyway?');               // yes to the first, Cancel to the action's own
  await c.csUnlinkBroker('my-oanda', { broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true });
  await c.csForgetKeys('my-oanda', 'OANDA');
  assert.deepEqual(c.asked.slice(n).map((a) => a.ok), ['Unlink', 'Unlink', 'Forget', 'Forget keys']);
  // nothing held on the broker: only the action's own question, as before
  c.tpx.held = []; c.record = [];
  await c.tpxLoadHeld(c.tpb.broker);
  const m = c.asked.length;
  c.answer = false;
  await c.csUnlinkBroker('my-alp', { broker: 'my-alp', identity: { display_name: 'Alpaca' }, connected: true });
  assert.deepEqual(c.asked.slice(m).map((a) => a.ok), ['Unlink']);
  c.answer = true;
  await row.children.find((ch) => ch.tagName === 'BUTTON').onclick({ stopPropagation() {} });
  assert.equal(c.asked.length, m + 1, 'no question before a Disconnect with nothing held');
});

// ── 4. the guide ────────────────────────────────────────────────────────────
await test('the guide\'s bullet says what a reload and a Disconnect do', () => {
  const guide = fs.readFileSync(new URL('../lse_terminal/ui/static/guide.md', import.meta.url), 'utf8');
  const lost = guide.split('\n').find((l) => l.startsWith('- **An answer that was lost.**'));
  assert.ok(lost, 'the guide has no bullet on a lost answer');
  for (const piece of [
    'After a reload the ticket opens on a connected broker with a request still out or held',
    'waiting for that broker\'s answer',
    '**Show**',
    '**Disconnect** asks first while anything is out or held on that broker',
  ]) assert.ok(lost.includes(piece), 'the bullet does not say: ' + piece + '\n' + lost);
});

done('test_ticket_reload.mjs');
