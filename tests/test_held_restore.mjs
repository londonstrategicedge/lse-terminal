// Requests whose answer was lost, read back from the engine (GET
// /api/broker/held) when the page loads and after each connect or reconnect,
// so a reloaded window says what the one before it was saying. The shipped
// functions are cut out of app.js by name and run in node:vm
// (tests/ticket_page.mjs), with a fetch that answers as the engine would.
//
// What is pinned (the held-requests contract, the page's half):
//   1. after a connect or a reconnect (tpbSwitch), and on load (tpbSetup), the
//      page asks GET /api/broker/held and restores each entry of the active
//      connection's broker exactly as if its answer had just been lost: the
//      warning on the line, the answer's words as its tooltip, Ask again;
//      oldest first, so Ask again asks about the latest, as it would have;
//   2. a restored request asked again is the request the page sent, verbatim,
//      under its client_id: by Ask again, and by the same request pressed
//      again; any other request on that instrument asks first (the held
//      gate), one for another instrument does not;
//   3. an entry of another broker, a malformed entry, and one the page holds
//      already are left alone;
//   4. an engine without the route (404), an answer that is not JSON, one of
//      another shape, and no answer at all are ignored: the page behaves as
//      it did before the route existed.
import assert from 'node:assert/strict';
import { page, line, settle, test, done, cut } from './ticket_page.mjs';
import vm from 'node:vm';

const DETAIL_ORDER = 'internal: Not known yet whether OANDA carried out the order: OANDA did not answer '
  + '(TimeoutError). It is NOT sent again: asking again with the same client_id is safe, and is answered from '
  + "OANDA's own record (watched for 120 s after the answer was lost).";
const DETAIL_CLOSE = 'internal: Not known yet whether OANDA carried out the close: OANDA did not answer (TimeoutError).';
const HELD = 'The order may have been placed: the answer from OANDA was lost. Check Positions before placing it again.';
const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';
const ORDER = { broker: 'my-oanda', symbol: 'EUR_USD', side: 'buy', qty: 2000, client_id: 'lset-0a1b2c3d4e5f' };
const CLOSE = { broker: 'my-oanda', position_id: 'EUR_USD', qty: 1000, client_id: 'lset-close-09586a88cde2' };
const RESTING = { broker: 'my-oanda', symbol: 'GBP_USD', side: 'sell', qty: 500, type: 'limit', price: 1.3125,
                  client_id: 'lset-5a5a5a5a5a5a' };
const CANCEL = { broker: 'my-oanda', order_id: 'o7', client_id: 'lset-cancel-777777777777' };
const entry = (route, what, request, detail, since) => ({ broker: request.broker, client_id: request.client_id,
  route, what, request, since, detail, code: 'internal' });
const E_ORDER = entry('/api/broker/order', 'order', ORDER, DETAIL_ORDER, '2026-11-15T07:12:01Z');
const E_CLOSE = entry('/api/broker/close', 'close', CLOSE, DETAIL_CLOSE, '2026-11-15T07:13:44Z');
const E_RESTING = entry('/api/broker/order/pending', 'resting', RESTING, DETAIL_ORDER, '2026-11-15T07:14:00Z');
const E_CANCEL = entry('/api/broker/order/cancel', 'cancel', CANCEL, DETAIL_CLOSE, '2026-11-15T07:15:00Z');

function engine(c, held, over = {}) {
  c.heldAsked = 0;
  c.route = (url, method, body) => {
    for (const [k, v] of Object.entries(over)) if (url.startsWith(k)) return typeof v === 'function' ? v(url, body) : v;
    if (url === '/api/broker/held') { c.heldAsked += 1; return typeof held === 'function' ? held() : held; }
    if (url === '/api/broker/connect') return { status: 200, body: { connected: true } };
    if (url.startsWith('/api/broker/catalog')) return { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 },
                                                                            { symbol: 'GBP_USD', digits: 5 }] };
    if (url === '/api/broker/subscribe') return { status: 200, body: { subscribed: body.symbols, refused: [] } };
    if (url === '/api/broker/list') return { status: 200, body: c.brokerPicker.rows };
    return undefined;
  };
}
const ok = (held) => ({ status: 200, body: { held } });

// ── 1. after a reconnect: restored, oldest first, said as if just lost ─────
await test('after a reconnect, the engine\'s held requests of that broker are restored as if just lost', async () => {
  const c = page();
  const other = { ...E_ORDER, broker: 'my-alp', request: { ...ORDER, broker: 'my-alp', client_id: 'lset-ffffffffffff' },
                  client_id: 'lset-ffffffffffff' };
  engine(c, ok([E_ORDER, other, E_CLOSE]));
  const out = await c.tpbSwitch('my-oanda');
  assert.equal(out.ok, true);
  assert.equal(c.heldAsked, 1, 'asked once, after the connect');
  assert.equal(c.sent.find((s) => s.url === '/api/broker/held').method, 'GET');
  assert.deepEqual(c.tpx.held.map((h) => [h.kind, h.broker, h.body.client_id]),
                   [['order', 'my-oanda', ORDER.client_id], ['close', 'my-oanda', CLOSE.client_id]]);
  // the latest's warning, its words the tooltip, Ask again
  assert.deepEqual([line(c).text, line(c).cls, line(c).title, line(c).again],
                   [HELD_CLOSE, 'err', DETAIL_CLOSE, true]);
  assert.equal(c.sent.filter((s) => s.method === 'POST' && s.url !== '/api/broker/connect'
                               && s.url !== '/api/broker/subscribe').length, 0, 'nothing is sent by itself');
});

// ── 2. asked again: verbatim, under its client_id ──────────────────────────
await test('Ask again on a restored close sends the request as it was sent, then the order\'s turn', async () => {
  const c = page();
  engine(c, ok([E_ORDER, E_CLOSE]));
  await c.tpbSwitch('my-oanda');
  c.route = null;
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();
  const asked = c.sent.at(-1);
  assert.deepEqual([asked.url, asked.body], ['/api/broker/close', CLOSE]);
  assert.deepEqual(line(c).parts, [['Asked again: closed 1000 of EUR_USD.', 'ok'], [HELD, 'err']]);
  assert.equal(line(c).title, DETAIL_ORDER);
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.27719 } } });
  await c.tpxAskAgain();
  assert.deepEqual([c.sent.at(-1).url, c.sent.at(-1).body], ['/api/broker/order', ORDER]);
  assert.deepEqual([line(c).text, line(c).cls, line(c).again], ['Asked again: buy 2000 EUR_USD filled @ 1.27719', 'ok', false]);
  assert.equal(c.tpx.held.length, 0);
});
await test('the same order pressed again after the reload is asked again under its client_id', async () => {
  const c = page();
  engine(c, ok([E_ORDER]));
  await c.tpbSwitch('my-oanda');
  c.route = null;
  c.$('tpx-qty').value = '2000';
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.2771 } } });
  await c.tpxOrder('buy');
  assert.equal(c.asked.length, 0, 'the same order is not a question');
  assert.deepEqual(c.sent.at(-1).body, ORDER);
});
await test('another request on that instrument asks first; another instrument does not', async () => {
  const c = page();
  engine(c, ok([E_CLOSE]));
  await c.tpbSwitch('my-oanda');
  c.route = null;
  c.tpx.positions = [{ id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 }];
  c.answer = false;
  await c.tpxOrder('sell');                         // EUR_USD, 1000
  assert.deepEqual(c.asked.map((a) => [a.text, a.ok, a.no]),
                   [['The close of 1000 EUR_USD may have been carried out. Send this as well?', 'Place it', 'Not now']]);
  assert.ok(!c.sent.some((s) => s.url === '/api/broker/order'), 'not sent without a yes');
  c.$('tpx-bsym').value = 'GBP_USD';
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.31 } } });
  await c.tpxOrder('sell');
  assert.equal(c.asked.length, 1, 'no question for another instrument');
  assert.equal(c.sent.at(-1).body.symbol, 'GBP_USD');
});
await test('a restored resting order and cancel are asked again on their own routes, verbatim', async () => {
  const c = page();
  engine(c, ok([E_RESTING, E_CANCEL]));
  await c.tpbSwitch('my-oanda');
  assert.deepEqual(c.tpx.held.map((h) => h.kind), ['pending', 'cancel']);
  c.route = null;
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();
  assert.deepEqual([c.sent.at(-1).url, c.sent.at(-1).body], ['/api/broker/order/cancel', CANCEL]);
  assert.equal(line(c).parts[0][0], 'Asked again: order o7 cancelled.');
  c.answers.push({ status: 200, body: { status: 'resting', order_id: 'o9' } });
  await c.tpxAskAgain();
  assert.deepEqual([c.sent.at(-1).url, c.sent.at(-1).body], ['/api/broker/order/pending', RESTING]);
  assert.equal(line(c).text, 'Asked again: sell limit 500 GBP_USD @ 1.3125 placed');
});

// ── 2. a restored request's instrument ─────────────────────────────────────
// A restored cancel is about the instrument the engine kept with it (the
// symbol the page sends beside the order id): another instrument goes
// without a question even before the Orders tab has read the order. A
// restored close is about its position's instrument as the dock lists it.
await test('a restored cancel is about the entry\'s instrument, with the Orders tab not read yet', async () => {
  for (const [what, e] of [
    ['the entry\'s instrument', { ...E_CANCEL, instrument: 'AUD_USD' }],
    ['the symbol sent beside its order id', { ...E_CANCEL, request: { ...CANCEL, symbol: 'AUD_USD' } }],
  ]) {
    const c = page();
    engine(c, ok([e]), { '/api/broker/catalog': { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 },
      { symbol: 'GBP_USD', digits: 5 }, { symbol: 'AUD_USD', digits: 5 }] } });
    await c.tpbSwitch('my-oanda');
    c.route = null;
    assert.deepEqual(c.tpx.orders, [], what + ': the Orders tab has not read the order');
    assert.equal(c.tpxHeldSymbol(c.tpx.held[0]), 'AUD_USD', what);
    c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
    await c.tpxOrder('buy');                         // EUR_USD: another instrument
    assert.equal(c.asked.length, 0, what + ': no question for another instrument');
    c.$('tpx-bsym').value = 'AUD_USD';
    c.answer = false;
    await c.tpxOrder('buy');
    assert.equal(c.asked.length, 1, what + ': its own instrument asks');
    assert.equal(c.sent.filter((s) => s.url === '/api/broker/order').length, 1, what + ': the AUD_USD buy is not sent');
  }
});
await test('a restored close\'s instrument is its position\'s, as the dock lists it', async () => {
  const c = page();
  // a hedging account: the position's id is the broker's trade id, no instrument
  const close = { broker: 'my-oanda', position_id: 'T123', qty: 500, client_id: 'lset-close-0123456789ab' };
  engine(c, ok([entry('/api/broker/close', 'close', close, DETAIL_CLOSE, '2026-11-15T07:16:00Z')]));
  await c.tpbSwitch('my-oanda');
  c.route = null;
  c.tpx.positions = [{ id: 'T123', position_id: 'T123', symbol: 'GBP_USD', qty: 1500 }];
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  await c.tpxOrder('buy');                           // EUR_USD
  assert.equal(c.asked.length, 0, 'EUR_USD is another instrument than the close\'s GBP_USD');
  c.$('tpx-bsym').value = 'GBP_USD';
  c.answer = false;
  await c.tpxOrder('sell');
  assert.deepEqual(c.asked.map((a) => a.text), ['The close of 500 GBP_USD may have been carried out. Send this as well?']);
});

// ── 3. left alone ─────────────────────────────────────────────────────────
await test('a malformed entry, or one the page holds already, is left alone', async () => {
  const c = page();
  const bad = [
    { ...E_ORDER, route: '/api/broker/modify', client_id: 'lset-111111111111',
      request: { ...ORDER, client_id: 'lset-111111111111' } },
    { ...E_ORDER, request: { ...ORDER, client_id: undefined }, client_id: 'lset-222222222222' },
    { ...E_ORDER, request: 'not an object' },
    { ...E_ORDER, what: 'close' },                    // its words say another route
    null, 'x', 7,
  ];
  const mine = { kind: 'order', broker: 'my-oanda', body: { ...ORDER }, side: 'buy', engine: false,
                 words: 'the page\'s own words', run() {} };
  c.tpx.held = [mine];
  engine(c, ok([...bad, E_ORDER]));
  await c.tpbSwitch('my-oanda');
  assert.equal(c.tpx.held.length, 1);
  assert.equal(c.tpx.held[0], mine, 'the page\'s own entry is kept as it was');
  assert.equal(line(c).title, 'the page\'s own words');
});
await test('only the active connection\'s entries; a switch meanwhile drops the answer', async () => {
  const c = page();
  let release;
  engine(c, () => new Promise((r) => { release = () => r(ok([E_ORDER])); }));
  const out = c.tpbSwitch('my-oanda');
  await settle();
  c.tpb.broker = 'paper';                           // the user moved on before the answer came
  c.tpb.generation += 1;
  release();
  await out;
  assert.equal(c.tpx.held.length, 0);
});

// ── 4. an older engine, a bad answer, no answer: as before ──────────────────
for (const [what, answer] of [
  ['404 (an engine without the route)', { status: 404, body: { detail: 'Not Found' } }],
  ['an answer that is not JSON', { status: 200, body: '<html>oops</html>' }],
  ['JSON of another shape', { status: 200, body: { held: 'none' } }],
  ['a list, not an object', { status: 200, body: [E_ORDER] }],
  ['no answer at all', new TypeError('Failed to fetch')],
  ['a 403 (not the window)', { status: 403, body: { detail: 'only the terminal window' } }],
]) {
  await test(`${what} is ignored: the page connects as before`, async () => {
    const c = page();
    engine(c, answer);
    const out = await c.tpbSwitch('my-oanda');
    assert.equal(out.ok, true);
    assert.equal(c.heldAsked, 1);
    assert.deepEqual([c.tpx.held.length, line(c).text, line(c).again], [0, '', false]);
  });
}

// ── 1. on load ─────────────────────────────────────────────────────────────
await test('on load the page asks for them too (tpbSetup), and restores the adopted connection\'s', async () => {
  const c = page({ more: ['tpbSetup'] });
  c.tpb.broker = 'lse-hosted';
  c.tpbSetupRows = [{ broker: 'my-oanda', connected: true, identity: { display_name: 'OANDA' } }];
  engine(c, ok([E_ORDER]), { '/api/broker/list': () => ({ status: 200, body: c.tpbSetupRows }) });
  await c.tpbSetup();
  assert.equal(c.tpb.broker, 'my-oanda');
  assert.ok(c.heldAsked >= 1);
  assert.deepEqual(c.tpx.held.map((h) => h.body.client_id), [ORDER.client_id], 'restored once');
  assert.deepEqual([line(c).text, line(c).title, line(c).again], [HELD, DETAIL_ORDER, true]);
});
await test('on load with nothing to adopt, the page still asks, and an older engine changes nothing', async () => {
  const c = page({ more: ['tpbSetup'] });
  c.tpb.broker = 'lse-hosted';
  engine(c, { status: 404, body: { detail: 'Not Found' } }, { '/api/broker/list': { status: 200, body: [] } });
  await c.tpbSetup();
  assert.equal(c.tpb.broker, 'lse-hosted');
  assert.equal(c.heldAsked, 1);
  assert.equal(c.tpx.held.length, 0);
});
await test('a hosted terminal, which has no broker connections, does not ask', async () => {
  const c = page({ more: ['tpbSetup'] });
  c.tpb.broker = 'lse-hosted';
  c.state.hosted = true;
  engine(c, ok([E_ORDER]), { '/api/broker/list': { status: 200, body: [] } });
  await c.tpbSetup();
  assert.deepEqual([c.tpb.broker, c.heldAsked, c.tpx.held.length], ['lse-hosted', 0, 0]);
});

done('test_held_restore.mjs');
