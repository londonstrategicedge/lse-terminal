// The engine's record of the window's requests, in each of its states, as the
// page reads it (GET /api/broker/held): the held-requests contract, the
// page's half. The shipped functions are cut out of app.js by name and run in
// node:vm (tests/ticket_page.mjs), with a fetch that answers as the engine
// would, and the ticket's 1 s timer driven by hand.
//
// What is pinned:
//   1. "out" (the engine wrote it before handing the request on, and no
//      answer has come): for the ticket's broker, one this page does not
//      itself have in flight is held as waiting. The line says that the
//      request sent before this page was loaded is waiting for the broker's
//      answer; there is no Ask again; any other request on its instrument
//      asks first, and so does the same request pressed
//      again; Not now says the waiting line again. This page's own request
//      in flight is not held by it.
//   2. "unknown" is held as a lost answer is: the warning, the record's words
//      as the tooltip, Ask again.
//   3. "answered" (kept by the engine for 120 s): a waiting request answered
//      lets the hold go and says the answer in its own style, as if this
//      page's own request had been answered: a close carried out reads
//      "closed 1000 of EUR_USD" in the ok style, a refusal in its words in
//      the error style. Any other answered entry is ignored.
//   4. The transitions: out to answered ok, out to answered refused, out to
//      unknown, unknown to gone (a held request the record listed and lists
//      no longer goes).
//   5. The checks on what is read: a read answered after the broker or the
//      generation changed is dropped; one answered after a later read was
//      applied is dropped; one asked before this page's own answer came is
//      not applied to that request.
//   6. The record is read every 5 s, with the account tick, only while its
//      last answer listed anything out or unknown for a connected broker or
//      the page holds anything.
//   7. A reload while a request is out: 4 s after Close half; the
//      reloaded page shows it waiting; Close half again asks first; when the
//      answer comes its words show and nothing else is sent.
//   A 404, an answer that is not JSON and no answer at all change nothing
//   (tests/test_held_restore.mjs).
import assert from 'node:assert/strict';
import { page, line, settle, test, done, unknownAnswer, LOST } from './ticket_page.mjs';

const CLOSE = { broker: 'my-oanda', position_id: 'EUR_USD', qty: 1000, client_id: 'lset-close-11e3a7df97e1' };
const ORDER = { broker: 'my-oanda', symbol: 'EUR_USD', side: 'buy', qty: 2000, client_id: 'lset-0a1b2c3d4e5f' };
const CANCEL = { broker: 'my-oanda', order_id: '10', symbol: 'AUD_USD', client_id: 'lset-cancel-a9846a36f71e' };
const DETAIL = 'internal: Not known yet whether OANDA carried out the close: it did not answer (TimeoutError). '
  + 'It is NOT sent again: asking again with the same client_id is safe, and is answered from OANDA\'s own record '
  + '(watched for 120 s after the answer was lost).';
const STOPPED = 'engine_stopped: The Terminal stopped before the broker\'s answer came, so it may have been carried '
  + 'out: check Positions before sending it again.';
const ROUTES = { close: ['/api/broker/close', 'close'], order: ['/api/broker/order', 'order'],
                 pending: ['/api/broker/order/pending', 'resting'], cancel: ['/api/broker/order/cancel', 'cancel'] };
const ent = (kind, request, state, more = {}) => ({ broker: request.broker, client_id: request.client_id,
  route: ROUTES[kind][0], what: ROUTES[kind][1], request, since: '2026-11-15T17:31:31Z', state,
  instrument: request.symbol == null ? null : request.symbol, detail: null, code: null, ...more });
const WAITING = 'The close of 1000 EUR_USD sent before this page was loaded is waiting for OANDA\'s answer.';
const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';
const P = () => ({ id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 });

// an engine: connect, catalog, subscribe, list, and its record as `c.record`
function engine(c, over = {}) {
  c.record = []; c.heldAsked = 0; c.heldAnswer = null;
  c.route = (url, method, body) => {
    for (const [k, v] of Object.entries(over)) if (url.startsWith(k)) return typeof v === 'function' ? v(url, body) : v;
    if (url === '/api/broker/held') {
      c.heldAsked += 1;
      if (c.heldAnswer) return c.heldAnswer();
      return { status: 200, body: { held: c.record } };
    }
    if (url === '/api/broker/connect') return { status: 200, body: { connected: true } };
    if (url.startsWith('/api/broker/catalog')) return { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 },
      { symbol: 'GBP_USD', digits: 5 }, { symbol: 'AUD_USD', digits: 5 }] };
    if (url === '/api/broker/subscribe') return { status: 200, body: { subscribed: body.symbols, refused: [] } };
    if (url === '/api/broker/list') return { status: 200, body: c.brokerPicker.rows };
    if (url.startsWith('/api/broker/quotes')) return { status: 200, body: {} };
    return undefined;
  };
}
// a page whose ticket's 1 s timer is kept, to be driven tick by tick
function ticking(opts = {}) {
  const c = page({ ...opts, ctx: { ...(opts.ctx || {}),
    setInterval: (fn, ms) => { c.timers.push({ fn, ms }); return c.timers.length; } } });
  c.timers = [];
  return c;
}
// one 1 s tick of the ticket's timer; the account tick is every 5th from the first
async function tickOnce(c) { await c.timers.at(-1).fn(); await settle(); }
async function accountTick(c) { for (let i = 0; i < 5; i++) await tickOnce(c); }
const posts = (c, url) => c.sent.filter((s) => s.method === 'POST' && (!url || s.url === url));

// ── 1. out: held as waiting ─────────────────────────────────────────────────
await test('out, not in flight here: held as waiting, the line says so, no Ask again', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  assert.deepEqual(c.tpx.held.map((h) => [h.kind, h.body.client_id, !!h.waiting]), [['close', CLOSE.client_id, true]]);
  assert.deepEqual([line(c).text, line(c).cls, line(c).again, line(c).placeNew], [WAITING, 'err', false, false]);
  assert.equal(posts(c, '/api/broker/close').length, 0, 'nothing is sent by itself');
});
await test('out: another request on its instrument asks first; the same request pressed again asks too', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  c.tpx.positions = [P()];
  c.answer = false;
  await c.tpxOrder('sell');                                    // another request on EUR_USD
  await c.acdClosePart(P(), 0.5);                              // the same close of 1000, pressed again
  assert.deepEqual(c.asked.map((a) => [a.text, a.ok, a.no]), [
    ['The close of 1000 EUR_USD may have been carried out. Send this as well?', 'Place it', 'Not now'],
    ['The close of 1000 EUR_USD may have been carried out. Send this as well?', 'Close it', 'Not now']]);
  assert.equal(posts(c, '/api/broker/close').length + posts(c, '/api/broker/order').length, 0, 'Not now sends nothing');
  assert.deepEqual([line(c).text, line(c).again], [WAITING, false], 'Not now says the waiting line again');
  // a yes is a request of its own, under its own client_id
  c.answer = true;
  c.answers.push({ status: 200, body: {} });
  c.route = null;
  await c.acdClosePart(P(), 0.5);
  const sent = posts(c, '/api/broker/close').at(-1);
  assert.notEqual(sent.body.client_id, CLOSE.client_id);
  assert.match(sent.body.client_id, /^lset-close-[0-9a-f]{12}$/);
  // another instrument goes without a question
  c.$('tpx-bsym').value = 'GBP_USD';
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.31 } } });
  await c.tpxOrder('buy');
  assert.equal(c.asked.length, 3);
});
await test('out, this page\'s own request in flight: not held by it; a read asked before its answer is not applied to it', async () => {
  const c = ticking();
  engine(c);
  await c.tpbSwitch('my-oanda');
  let release;
  const base = c.route;
  c.route = (url, method, body) => (url === '/api/broker/close'
    ? new Promise((ok) => { release = () => ok({ status: 200, body: {} }); }) : base(url, method, body));
  c.tpx.positions = [P()];
  const out = c.acdClosePart(P(), 0.5);
  await settle();
  const cid = posts(c, '/api/broker/close')[0].body.client_id;
  c.record = [ent('close', { ...CLOSE, client_id: cid }, 'out')];      // the engine wrote it before handing it on
  const asked = c.heldAsked;
  await c.tpxLoadHeld('my-oanda');                                     // a read while it is in flight
  assert.equal(c.heldAsked, asked + 1);
  assert.equal(c.tpx.held.length, 0, 'its own request in flight is not held as waiting');
  assert.equal(line(c).text, 'closing 50% of EUR_USD…');
  // a read asked now and answered after the close's own answer has come
  let late;
  c.heldAnswer = () => new Promise((ok) => {
    late = () => ok({ status: 200, body: { held: [ent('close', { ...CLOSE, client_id: cid }, 'out')] } }); });
  const stale = c.tpxLoadHeld('my-oanda');
  await settle();
  release();
  await out;
  assert.deepEqual([line(c).text, line(c).cls], ['closed 50% of EUR_USD', 'ok']);
  late();
  await stale;
  assert.equal(c.tpx.held.length, 0, 'a read asked before its answer does not hold it again');
  assert.deepEqual([line(c).text, line(c).cls], ['closed 50% of EUR_USD', 'ok']);
});

// ── 2. unknown: held as a lost answer ───────────────────────────────────────
// (an entry the engine left unknown because it stopped, code
// engine_stopped, is said on the line in the record's own words, its
// code word dropped, not as an answer that was lost: test_held_elsewhere.mjs)
await test('unknown: held with the record\'s words as its tooltip and Ask again', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'unknown', { detail: STOPPED, code: 'engine_stopped' })];
  await c.tpbSwitch('my-oanda');
  assert.deepEqual([line(c).text, line(c).cls, line(c).title, line(c).again],
                   [STOPPED.replace(/^engine_stopped: /, ''), 'err', STOPPED, true]);
  c.route = null;
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();
  assert.deepEqual([c.sent.at(-1).url, c.sent.at(-1).body], ['/api/broker/close', CLOSE], 'asked again verbatim');
  assert.equal(c.tpx.held.length, 0);
});

// ── 3, 4. the transitions ───────────────────────────────────────────────────
await test('out to answered ok: the hold goes and the answer reads as done', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  c.record = [ent('close', CLOSE, 'answered', { ok: true, status: 200 })];
  await accountTick(c);
  assert.deepEqual([line(c).text, line(c).cls, line(c).again, c.tpx.held.length],
                   ['closed 1000 of EUR_USD', 'ok', false, 0]);
  assert.equal(posts(c, '/api/broker/close').length, 0, 'nothing else is sent');
});
await test('out to answered refused: the hold goes and the refusal reads in its words', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  c.record = [ent('close', CLOSE, 'answered', { ok: false, status: 400, code: 'market_closed',
                                                detail: 'market_closed: EUR_USD is not trading now' })];
  await accountTick(c);
  assert.deepEqual([line(c).text, line(c).cls, line(c).again, c.tpx.held.length],
                   ['EUR_USD is not trading now', 'err', false, 0]);
});
await test('out to unknown: held as a lost answer, with the record\'s words and Ask again', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  assert.equal(line(c).again, false);
  c.record = [ent('close', CLOSE, 'unknown', { detail: DETAIL, code: 'internal' })];
  await accountTick(c);
  assert.deepEqual(c.tpx.held.map((h) => [h.body.client_id, !!h.waiting]), [[CLOSE.client_id, false]]);
  assert.deepEqual([line(c).text, line(c).title, line(c).again], [HELD_CLOSE, DETAIL, true]);
});
await test('unknown to gone: a held request the record no longer lists goes', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'unknown', { detail: DETAIL, code: 'internal' })];
  await c.tpbSwitch('my-oanda');
  assert.equal(line(c).again, true);
  c.record = [];                                               // unlinked or forgotten, or settled elsewhere
  await accountTick(c);
  assert.deepEqual([c.tpx.held.length, line(c).text, line(c).again], [0, '', false]);
  // a request this page holds whose record it has never seen is kept (an
  // engine without the record, or one the engine never got)
  c.route = null;
  c.answers.push(new TypeError('Failed to fetch'));
  await c.tpxOrder('buy');
  assert.equal(c.tpx.held.length, 1);
  engine(c);
  await c.tpxLoadHeld('my-oanda');
  assert.equal(c.tpx.held.length, 1, 'never listed: not let go');
});
await test('answered, for a request this page does not hold as waiting: ignored', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('order', ORDER, 'answered', { ok: true, status: 200 })];
  await c.tpbSwitch('my-oanda');
  assert.deepEqual([c.tpx.held.length, line(c).text], [0, '']);
  // held as unknown (its own lost answer): an answered entry does not let it go
  c.route = null;
  c.answers.push((u, b) => unknownAnswer(b.client_id));
  await c.tpxOrder('buy');
  const cid = c.tpx.held[0].body.client_id;
  engine(c);
  c.record = [ent('order', { ...ORDER, qty: 1000, client_id: cid }, 'answered', { ok: true, status: 200 })];
  await c.tpxLoadHeld('my-oanda');
  assert.deepEqual([c.tpx.held.length, line(c).again], [1, true]);
});
await test('a cancel and a resting order answered while waiting read as the page\'s own', async () => {
  const c = ticking();
  engine(c);
  const RESTING = { broker: 'my-oanda', symbol: 'GBP_USD', side: 'sell', qty: 500, type: 'limit', price: 1.3125,
                    client_id: 'lset-5a5a5a5a5a5a' };
  c.record = [ent('pending', RESTING, 'out'), { ...ent('cancel', CANCEL, 'out'), since: '2026-11-15T17:32:00Z' }];
  await c.tpbSwitch('my-oanda');
  // (its instrument, which the record kept, names it beside its order id)
  assert.equal(line(c).text, 'The cancel of order 10 (AUD_USD) sent before this page was loaded is waiting for OANDA\'s answer.');
  c.record = [ent('pending', RESTING, 'out'),
              { ...ent('cancel', CANCEL, 'answered', { ok: true, status: 200 }), since: '2026-11-15T17:32:00Z' }];
  await accountTick(c);
  assert.deepEqual(line(c).parts, [['order 10 cancelled.', 'ok'],
    ['The sell limit order for 500 GBP_USD at 1.3125 sent before this page was loaded is waiting for OANDA\'s answer.', 'err']]);
  c.record = [ent('pending', RESTING, 'answered', { ok: true, status: 200 })];
  await accountTick(c);
  assert.deepEqual([line(c).text, line(c).cls], ['sell limit 500 @ 1.3125 placed', 'ok']);
});

await test('one read that answers a waiting request and holds a newer one: the answer stays, the warning after it', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  const NEWER = { broker: 'my-oanda', symbol: 'GBP_USD', side: 'sell', qty: 500, client_id: 'lset-bbbbbbbbbbbb' };
  c.record = [ent('close', CLOSE, 'answered', { ok: true, status: 200 }),
              { ...ent('order', NEWER, 'unknown', { detail: DETAIL }), since: '2026-11-15T17:40:00Z' }];
  await accountTick(c);
  assert.deepEqual(line(c).parts, [['closed 1000 of EUR_USD.', 'ok'],
    ['The order may have been placed: the answer from OANDA was lost. Check Positions before placing it again.', 'err']]);
  assert.deepEqual([line(c).again, c.tpx.held.map((h) => h.body.client_id)], [true, [NEWER.client_id]]);
});

// ── 5. the checks on what is read ───────────────────────────────────────────
await test('a read answered after a switch is dropped (the generation check)', async () => {
  const c = ticking();
  engine(c);
  await c.tpbSwitch('my-oanda');
  c.record = [ent('close', CLOSE, 'out')];
  let release;
  c.heldAnswer = () => new Promise((ok) => { release = () => ok({ status: 200, body: { held: c.record } }); });
  const read = c.tpxLoadHeld('my-oanda');
  await settle();
  c.tpb.generation += 1;                                        // a reconnect meanwhile
  release();
  await read;
  assert.equal(c.tpx.held.length, 0);
});
await test('a read answered after a later read was applied is dropped', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpbSwitch('my-oanda');
  let first;
  c.heldAnswer = () => new Promise((ok) => { first = () => ok({ status: 200, body: { held: [ent('close', CLOSE, 'out')] } }); });
  const older = c.tpxLoadHeld('my-oanda');
  await settle();
  c.heldAnswer = null;
  c.record = [ent('close', CLOSE, 'answered', { ok: true, status: 200 })];
  await c.tpxLoadHeld('my-oanda');                              // the later read: answered
  assert.deepEqual([c.tpx.held.length, line(c).text], [0, 'closed 1000 of EUR_USD']);
  first();                                                      // the older one, still "out", comes last
  await older;
  assert.deepEqual([c.tpx.held.length, line(c).text], [0, 'closed 1000 of EUR_USD'], 'not held again');
});
await test('one key in two states: out wins over unknown, unknown over answered', async () => {
  const c = ticking();
  engine(c);
  c.record = [ent('close', CLOSE, 'answered', { ok: false, status: 400 }),
              ent('close', CLOSE, 'unknown', { detail: DETAIL })];
  await c.tpbSwitch('my-oanda');
  assert.deepEqual([c.tpx.held.length, line(c).again, line(c).title], [1, true, DETAIL]);
});

// ── 6. the 5 s read ─────────────────────────────────────────────────────────
await test('the record is read with the account tick only while something is out, unknown or held', async () => {
  const c = ticking();
  engine(c);
  c.brokerPicker.rows = [{ broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true },
                         { broker: 'my-alp', identity: { display_name: 'Alpaca' }, connected: false }];
  await c.tpbSwitch('my-oanda');
  const asked0 = c.heldAsked;
  await accountTick(c); await accountTick(c);
  assert.equal(c.heldAsked, asked0, 'nothing listed, nothing held: no read');
  // an entry out for a connected broker: read every account tick (every 5th second), not every second
  c.record = [ent('close', CLOSE, 'out')];
  await c.tpxLoadHeld('my-oanda');
  const asked1 = c.heldAsked;
  for (let i = 0; i < 4; i++) await tickOnce(c);
  assert.equal(c.heldAsked, asked1 + 1, 'one read in the first account tick');
  await accountTick(c);
  assert.equal(c.heldAsked, asked1 + 2, 'and one in the next');
  // answered and let go: nothing listed out or unknown, nothing held: the reads stop
  c.record = [ent('close', CLOSE, 'answered', { ok: true, status: 200 })];
  await accountTick(c);
  const asked2 = c.heldAsked;
  await accountTick(c); await accountTick(c);
  assert.equal(c.heldAsked, asked2, 'only answered entries: no read');
  // an entry of a broker that is not connected does not keep it reading
  c.record = [ent('order', { ...ORDER, broker: 'my-alp', client_id: 'lset-aaaaaaaaaaaa' }, 'unknown')];
  await c.tpxLoadHeld('my-oanda');
  const asked3 = c.heldAsked;
  await accountTick(c);
  assert.equal(c.heldAsked, asked3, 'not connected: no read');
  // the page holds something (its own lost answer): read
  c.record = [];
  c.route = null;
  c.answers.push((u, b) => unknownAnswer(b.client_id));
  await c.tpxOrder('buy');
  engine(c);
  const asked4 = c.heldAsked;
  await accountTick(c);
  assert.equal(c.heldAsked, asked4 + 1, 'the page holds something: read');
});

// ── 7. a reload while a request is out ──────────────────────────────────────
await test('a reload 4 s after Close half: waiting, Close half again asks first, the answer comes, nothing else is sent', async () => {
  // the page before the reload: Close half sent, its answer not in yet
  const before = ticking();
  engine(before);
  await before.tpbSwitch('my-oanda');
  before.tpx.positions = [P()];
  before.route = ((base) => (url, method, body) => (url === '/api/broker/close' ? new Promise(() => {}) : base(url, method, body)))(before.route);
  before.acdClosePart(P(), 0.5);
  await settle();
  const first = posts(before, '/api/broker/close')[0].body;
  assert.deepEqual({ ...first, client_id: 'x' }, { broker: 'my-oanda', position_id: 'EUR_USD', qty: 1000, client_id: 'x' });
  // 4 s later the page reloads: a new page, the engine's record says "out"
  const c = ticking({ more: ['tpbSetup'] });
  c.tpb.broker = 'lse-hosted';
  c.brokerPicker.rows = [{ broker: 'paper', identity: { display_name: 'Paper simulator' }, connected: true, ready: true },
                         { broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true }];
  engine(c);
  c.record = [ent('close', first, 'out')];
  await c.tpbSetup();
  assert.equal(c.tpb.broker, 'my-oanda', 'the ticket opens on the broker with the request out');
  assert.deepEqual([line(c).text, line(c).again], [WAITING, false]);
  // Close half again asks first; Not now
  c.tpx.positions = [P()];
  c.answer = false;
  await c.acdClosePart(P(), 0.5);
  assert.deepEqual(c.asked.map((a) => a.text), ['The close of 1000 EUR_USD may have been carried out. Send this as well?']);
  assert.equal(posts(c, '/api/broker/close').length, 0);
  // the answer comes: the engine's record has it answered
  c.record = [ent('close', first, 'answered', { ok: true, status: 200 })];
  await accountTick(c);
  assert.deepEqual([line(c).text, line(c).cls, line(c).again, c.tpx.held.length],
                   ['closed 1000 of EUR_USD', 'ok', false, 0]);
  await accountTick(c);
  assert.equal(posts(c, '/api/broker/close').length, 0, 'nothing else is sent');
  assert.deepEqual(posts(c).map((s) => s.url).filter((u) => u !== '/api/broker/connect' && u !== '/api/broker/subscribe'), []);
});

done('test_held_states.mjs');
