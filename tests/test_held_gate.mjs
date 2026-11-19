// Another request while one whose answer was lost is held, and placing an
// order again when asking again is still not answered. The shipped functions
// are cut out of app.js by name and run in node:vm (tests/ticket_page.mjs).
//
// What is pinned:
//   1. While a request whose answer was lost is held on a connection, any
//      other order (at market or resting), close or cancel on that
//      connection for the same instrument is sent only after a yes. The
//      question names the held request ("... may have been carried out.
//      Send this as well?"), with a yes that names what is about to be sent
//      ("Place it", "Close it", "Cancel it") and "Not now"; "Not now" sends
//      nothing and says the held request again. A request for another
//      instrument goes without a question; one that closes everything on the
//      connection asks while anything is held on it. The same request
//      pressed again is asked again under its client_id, with no question.
//      The cases: Buy 2000, Close half (its answer lost), Sell 1000 asks;
//      a close held, then a stop from the chart's menu; a cancel held, then
//      an order at market.
//   2. When asking again (Ask again, or the same order pressed again) is
//      answered that its fate is still not known, the line offers "Place as
//      new" beside Ask again. It asks "<broker> may still carry out the
//      first order. Place a new one as well?" ("Place it" / "Not now"); a yes
//      sends the same order under a new client_id, and the first stays
//      held, its warning on the line, until its own answer.
//   3. The guide's bullet says exactly this.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { page, line, test, done, unknownAnswer, LOST, STILL, src } from './ticket_page.mjs';

const P = () => ({ id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 });
const HELD = 'The order may have been placed: the answer from OANDA was lost. Check Positions before placing it again.';
const HELD_PENDING = 'The order may have been placed: the answer from OANDA was lost. Check Orders before placing it again.';
const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';
const HELD_CANCEL = 'The cancel may have been carried out: the answer from OANDA was lost. '
  + 'Check Orders before cancelling it again.';
const lost = (c) => c.answers.push((u, b) => unknownAnswer(b.client_id));
const filled = (c, price = 1.1) => c.answers.push({ status: 200, body: { status: 'filled', fill: { price } } });
const asked = (c) => c.asked.map((a) => [a.text, a.ok, a.no]);
const posts = (c) => c.sent.filter((s) => s.method === 'POST').map((s) => s.url);

// ── 1. Buy 2000; Close half, its answer lost; Sell 1000 ─────────────────────
await test('a close held, then Sell 1000 of that instrument from the ticket asks first', async () => {
  const c = page();
  c.$('tpx-qty').value = '2000';
  filled(c, 1.27719);
  await c.tpxOrder('buy');
  c.tpx.positions = [P()];
  lost(c);
  await c.acdClosePart(P(), 0.5);                    // Close half: 1000, its answer lost
  assert.deepEqual(line(c).held, ['close']);
  c.$('tpx-qty').value = '1000';
  c.answer = false;                                  // Not now
  await c.tpxOrder('sell');
  assert.deepEqual(posts(c), ['/api/broker/order', '/api/broker/close'], 'the Sell is not sent without a yes');
  assert.deepEqual(asked(c), [['The close of 1000 EUR_USD may have been carried out. Send this as well?',
                               'Place it', 'Not now']]);
  assert.deepEqual([line(c).text, line(c).title, line(c).again], [HELD_CLOSE, LOST, true],
                   'Not now says the held close again');
  c.answer = true;                                   // Place it
  filled(c, 1.27705);
  await c.tpxOrder('sell');
  const sell = c.sent.at(-1);
  assert.deepEqual([sell.url, sell.body.side, sell.body.qty], ['/api/broker/order', 'sell', 1000]);
  assert.notEqual(sell.body.client_id, c.sent[1].body.client_id, 'a request of its own');
  assert.deepEqual(line(c).held, ['close'], 'the close is still held');
});

// ── 1. a close held, then a stop from the chart's menu ─────────────────────
await test('a close held, then a resting order of that instrument from the chart asks first', async () => {
  const c = page();
  lost(c);
  await c.acdCloseFull(P());
  c.answer = false;
  await c.tpxQuickOrder('sell', 'stop', 1.05);
  assert.deepEqual(posts(c), ['/api/broker/close']);
  assert.deepEqual(asked(c), [['The close of EUR_USD may have been carried out. Send this as well?',
                               'Place it', 'Not now']]);
  c.answer = true;
  c.answers.push({ status: 200, body: { order_id: 'o1', status: 'resting' } });
  await c.tpxQuickOrder('sell', 'stop', 1.05);
  assert.equal(c.sent.at(-1).url, '/api/broker/order/pending');
});

// ── 1. a cancel held, then an order at market ───────────────────────────────
await test('a cancel held, then an order at market of that instrument asks first', async () => {
  const c = page();
  const o = { id: 'o7', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EUR_USD' };
  c.tpx.orders = [o];
  lost(c);
  await c.acdCancelOrder(o);
  assert.equal(line(c).text, HELD_CANCEL);
  c.answer = false;
  await c.tpxOrder('buy');
  assert.deepEqual(posts(c), ['/api/broker/order/cancel']);
  assert.deepEqual(asked(c), [['The cancel of the buy limit EUR_USD order at 1.05 may have been carried out. '
                               + 'Send this as well?', 'Place it', 'Not now']]);
});

// ── 1. every kind against every kind, on one instrument ─────────────────────
await test('an order held: a close or a cancel of that instrument asks first, each with its own yes', async () => {
  const c = page();
  lost(c);
  await c.tpxOrder('buy');
  c.answer = false;
  await c.acdClosePart(P(), 0.25);
  await c.acdCancelOrder({ id: 'o9', side: 'sell', otype: 'limit', price: 1.3, symbol: 'EUR_USD' });
  assert.deepEqual(posts(c), ['/api/broker/order']);
  const q = 'The order to buy 1000 EUR_USD may have been carried out. Send this as well?';
  assert.deepEqual(asked(c), [[q, 'Close it', 'Not now'], [q, 'Cancel it', 'Not now']]);
  assert.equal(line(c).text, HELD);
});
await test('a resting order held: another order, a close, a cancel of that instrument ask first', async () => {
  const c = page();
  lost(c);
  await c.tpxPlacePending('buy', 'limit', 1.2495, 2000);
  assert.equal(line(c).text, HELD_PENDING);
  c.answer = false;
  await c.tpxOrder('sell');
  await c.acdCloseFull(P());
  await c.acdCancelOrder({ id: 'o9', side: 'sell', otype: 'limit', price: 1.3, symbol: 'EUR_USD' });
  assert.deepEqual(posts(c), ['/api/broker/order/pending']);
  const q = 'The buy limit order for 2000 EUR_USD at 1.2495 may have been carried out. Send this as well?';
  assert.deepEqual(asked(c), [[q, 'Place it', 'Not now'], [q, 'Close it', 'Not now'], [q, 'Cancel it', 'Not now']]);
});
await test('a close held: another close of the position asks; a close of another position does not', async () => {
  const c = page();
  lost(c);
  await c.acdClosePart(P(), 0.5);
  c.answer = false;
  await c.acdClosePart(P(), 0.25);
  await c.acdCloseFull(P());
  assert.equal(c.asked.length, 2);
  assert.deepEqual(c.asked.map((a) => a.ok), ['Close it', 'Close it']);
  c.answers.push({ status: 200, body: {} });
  await c.acdCloseFull({ id: 'GBP_USD', position_id: 'GBP_USD', symbol: 'GBP_USD', qty: 500 });
  assert.equal(c.asked.length, 2, 'no question for another instrument');
  assert.equal(c.sent.at(-1).body.position_id, 'GBP_USD');
});

// ── 1. the question names the latest held request ───────────────────────────
await test('two held on one instrument: the question names the latest', async () => {
  const c = page();
  lost(c);
  await c.tpxOrder('buy');                           // the order to buy 1000 EUR_USD, held first
  c.answer = true;                                   // a close of that instrument, on a yes
  lost(c);
  await c.acdClosePart(P(), 0.5);                    // the close of 1000 EUR_USD, held second
  assert.deepEqual(line(c).held, ['order', 'close']);
  c.answer = false;
  await c.tpxPlacePending('sell', 'limit', 1.3, 500);
  assert.deepEqual(asked(c).at(-1), ['The close of 1000 EUR_USD may have been carried out. Send this as well?',
                                     'Place it', 'Not now'], 'the latest held, not the first');
  assert.deepEqual([line(c).text, line(c).again], [HELD_CLOSE, true], 'Not now says the latest again');
});

// ── 1. a cancel carries its order's instrument ──────────────────────────────
await test('a cancel is sent with its order\'s symbol beside the order id', async () => {
  const c = page();
  c.answers.push({ status: 200, body: {} });
  await c.acdCancelOrder({ id: 'o7', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EUR_USD' });
  const { client_id: cid, ...rest } = c.sent.at(-1).body;
  assert.deepEqual([c.sent.at(-1).url, rest], ['/api/broker/order/cancel',
                                               { broker: 'my-oanda', order_id: 'o7', symbol: 'EUR_USD' }]);
  assert.match(cid, /^lset-cancel-[0-9a-f]{12}$/);
  // an order whose instrument is not known is cancelled by its id alone
  c.answers.push({ status: 200, body: {} });
  await c.acdCancelOrder({ id: 'o8' });
  const { client_id: cid2, ...rest2 } = c.sent.at(-1).body;
  assert.deepEqual(rest2, { broker: 'my-oanda', order_id: 'o8' });
  // and asked again, exactly what was sent: the symbol with it
  lost(c);
  await c.acdCancelOrder({ id: 'o9', side: 'sell', otype: 'stop', price: 1.2, symbol: 'GBP_USD' });
  const first = c.sent.at(-1).body;
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();
  assert.deepEqual(c.sent.at(-1).body, first);
  assert.equal(first.symbol, 'GBP_USD');
});

// ── 1. other instruments go without a question ──────────────────────────────
await test('a request for another instrument goes without a question, whatever is held', async () => {
  for (const hold of ['order', 'close', 'cancel', 'pending']) {
    const c = page();
    lost(c);
    if (hold === 'order') await c.tpxOrder('buy');
    if (hold === 'close') await c.acdCloseFull(P());
    if (hold === 'cancel') await c.acdCancelOrder({ id: 'o7', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EUR_USD' });
    if (hold === 'pending') await c.tpxPlacePending('buy', 'limit', 1.05, 1000);
    c.$('tpx-bsym').value = 'GBP_USD';
    filled(c);
    await c.tpxOrder('buy');
    c.answers.push({ status: 200, body: { status: 'resting' } });
    await c.tpxPlacePending('sell', 'limit', 1.4, 500);
    c.answers.push({ status: 200, body: {} });
    await c.acdCloseFull({ id: 'GBP_USD', position_id: 'GBP_USD', symbol: 'GBP_USD', qty: 500 });
    c.answers.push({ status: 200, body: {} });
    await c.acdCancelOrder({ id: 'o8', side: 'sell', otype: 'stop', price: 1.2, symbol: 'GBP_USD' });
    assert.equal(c.asked.length, 0, hold + ' held: ' + JSON.stringify(asked(c)));
    assert.equal(c.sent.filter((s) => s.method === 'POST').length, 5, hold);
    assert.equal(c.tpx.held.length, 1, hold + ': the first is still held');
  }
});
await test('one that closes everything on the connection asks while anything is held on it', async () => {
  const c = page();
  assert.equal(typeof c.tpxHeldOverlap, 'function');
  lost(c);
  await c.acdCancelOrder({ id: 'o7', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EUR_USD' });
  const all = c.tpxHeldOverlap('flatten', { broker: 'my-oanda' });
  assert.deepEqual(all.map((h) => h.kind), ['cancel']);
  assert.deepEqual(c.tpxHeldOverlap('flatten', { broker: 'another' }), [], 'only on that connection');
  c.answer = false;
  assert.equal(await c.tpxHeldGate('flatten', { broker: 'my-oanda' }, 'close', 'Close all'), null);
  assert.deepEqual(asked(c), [['The cancel of the buy limit EUR_USD order at 1.05 may have been carried out. '
                               + 'Send this as well?', 'Close all', 'Not now']]);
});

// ── 1. the same request again: asked again, no question ─────────────────────
await test('the same order, close or cancel pressed again is asked again under its client_id', async () => {
  const c = page();
  lost(c);
  await c.tpxOrder('buy');
  lost(c);
  await c.acdClosePart({ id: 'GBP_USD', position_id: 'GBP_USD', symbol: 'GBP_USD', qty: 600 }, 0.5);
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  await c.tpxOrder('buy');
  c.answers.push({ status: 200, body: {} });
  await c.acdClosePart({ id: 'GBP_USD', position_id: 'GBP_USD', symbol: 'GBP_USD', qty: 600 }, 0.5);
  assert.equal(c.asked.length, 0);
  assert.equal(c.sent[2].body.client_id, c.sent[0].body.client_id);
  assert.equal(c.sent[3].body.client_id, c.sent[1].body.client_id);
  assert.equal(c.tpx.held.length, 0);
});

// ── 2. Place as new ─────────────────────────────────────────────────────────
const STILL_ANSWER = (cid) => unknownAnswer(cid, STILL);
await test('a first lost answer offers Ask again, not Place as new', async () => {
  const c = page();
  lost(c);
  await c.tpxOrder('buy');
  assert.deepEqual([line(c).again, line(c).placeNew], [true, false]);
});
for (const how of ['Ask again', 'the same order pressed again']) {
  await test(`asked again (${how}) and still not known: Place as new beside Ask again`, async () => {
    const c = page();
    lost(c);
    await c.tpxOrder('buy');
    const first = { ...c.sent[0].body };
    c.answers.push((u, b) => STILL_ANSWER(b.client_id));
    if (how === 'Ask again') await c.tpxAskAgain(); else await c.tpxOrder('buy');
    assert.equal(c.sent[1].body.client_id, first.client_id, 'asked again under its client_id');
    assert.deepEqual([line(c).text, line(c).again, line(c).placeNew], [HELD, true, true]);
    assert.equal(line(c).title, STILL, 'its latest words are the tooltip');
    // Not now: nothing sent, the first still held
    c.answer = false;
    await c.tpxPlaceNew();
    assert.deepEqual(asked(c), [['OANDA may still carry out the first order. Place a new one as well?',
                                 'Place it', 'Not now']]);
    assert.equal(c.sent.length, 2);
    // Place it: the same order, a new client_id; the first stays held
    c.answer = true;
    filled(c, 1.1002);
    await c.tpxPlaceNew();
    const again = c.sent[2];
    assert.equal(again.url, '/api/broker/order');
    const { client_id: cid, ...rest } = again.body;
    const { client_id: cid0, ...rest0 } = first;
    assert.deepEqual(rest, rest0, 'the same order');
    assert.match(cid, /^lset-[0-9a-f]{12}$/);
    assert.notEqual(cid, cid0, 'under a new client_id');
    assert.deepEqual(c.tpx.held.map((h) => h.body.client_id), [cid0], 'the first stays held');
    assert.deepEqual(line(c).parts, [['buy 1000 EUR_USD filled @ 1.1002.', 'ok'], [HELD, 'err']]);
    assert.deepEqual([line(c).title, line(c).again], [STILL, true]);
    // until its own answer
    c.answers.push({ status: 200, body: { status: 'filled', client_id: cid0, fill: { price: 1.1 } } });
    await c.tpxAskAgain();
    assert.equal(c.sent[3].body.client_id, cid0);
    assert.deepEqual([line(c).text, line(c).cls, line(c).again, line(c).placeNew],
                     ['Asked again: buy 1000 EUR_USD filled @ 1.1', 'ok', false, false]);
  });
}
await test('a resting order asked again and still not known: Place as new places it again', async () => {
  const c = page();
  lost(c);
  await c.tpxPlacePending('buy', 'limit', 1.05, 700);
  c.answers.push((u, b) => STILL_ANSWER(b.client_id));
  await c.tpxAskAgain();
  assert.deepEqual([line(c).again, line(c).placeNew], [true, true]);
  c.answer = true;
  c.answers.push({ status: 200, body: { order_id: 'o2', status: 'resting' } });
  await c.tpxPlaceNew();
  const [a, b] = [c.sent[0].body, c.sent[2].body];
  assert.equal(c.sent[2].url, '/api/broker/order/pending');
  assert.deepEqual([b.side, b.type, b.price, b.qty, b.symbol], [a.side, a.type, a.price, a.qty, a.symbol]);
  assert.notEqual(b.client_id, a.client_id);
  assert.deepEqual(c.tpx.held.map((h) => h.body.client_id), [a.client_id]);
  assert.deepEqual(line(c).parts, [['buy limit 700 EUR_USD @ 1.05 placed.', 'ok'], [HELD_PENDING, 'err']]);
});
await test('a close asked again and still not known is not offered as a new order', async () => {
  const c = page();
  lost(c);
  await c.acdCloseFull(P());
  c.answers.push((u, b) => STILL_ANSWER(b.client_id));
  await c.tpxAskAgain();
  assert.deepEqual([line(c).again, line(c).placeNew], [true, false]);
});
await test('Place as new is a press of its own button, one press one order', () => {
  assert.match(src, /\$\("tpx-new"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxPlaceNew\(\); \};/);
  const html = fs.readFileSync(new URL('../lse_terminal/ui/static/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="tpx-new" class="hidden" type="button"[^>]*>Place as new<\/button>/);
  assert.ok(html.indexOf('id="tpx-new"') > html.indexOf('id="tpx-again"'), 'beside Ask again');
});

// ── 3. the guide ────────────────────────────────────────────────────────────
await test('the guide\'s bullet says what the ticket does, and nothing more', () => {
  const guide = fs.readFileSync(new URL('../lse_terminal/ui/static/guide.md', import.meta.url), 'utf8');
  const lost = guide.split('\n').find((l) => l.startsWith('- **An answer that was lost.**'));
  assert.ok(lost, 'the guide has no bullet on a lost answer');
  for (const piece of [
    'While it is held, any other order (at market or at a level), close or cancel on that connection for the same '
      + 'instrument is sent only after you say yes; one for another instrument goes without a question.',
    'If asking again about an order is answered that it is still not known, the ticket also offers **Place as new**',
    'the same order again under a new client_id, and the first stays held, its warning on the line, until its own answer.',
  ]) assert.ok(lost.includes(piece), 'the bullet does not say: ' + piece + '\n' + lost);
  for (const gone of ['or another close of that position, is sent only after you confirm it', 'close-all', 'flatten']) {
    assert.ok(!lost.includes(gone), 'the bullet still says: ' + gone);
  }
});

done('test_held_gate.mjs');
