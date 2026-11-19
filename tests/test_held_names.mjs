// How a held request is named in the question another request asks. The
// shipped functions are cut out of app.js by name and run in node:vm
// (tests/ticket_page.mjs).
//
// The case: after a reload, a held cancel of order 7 is restored from the
// engine's record with its instrument (AUD_USD). Named by its order id
// alone, the question a Buy of AUD_USD asks reads "The cancel of order 7
// may have been carried out. Send this as well?". The order was cancelled at
// the broker, so the Orders tab never lists it and its side, type and price
// are not known; its instrument is.
//
// What is pinned:
//   1. A restored cancel whose order the dock does not list is named by its
//      order id and its instrument: "The cancel of order 7 (AUD_USD) may have
//      been carried out. Send this as well?"; with no instrument known, by
//      its order id alone, as before.
//   2. One whose order the dock lists is named by that order, as before.
import assert from 'node:assert/strict';
import { page, test, done } from './ticket_page.mjs';

const CANCEL = { broker: 'my-oanda', order_id: '7', symbol: 'AUD_USD', client_id: 'lset-cancel-0a1b2c3d4e5f' };
const entry = (request, more = {}) => ({ broker: 'my-oanda', client_id: request.client_id,
  route: '/api/broker/order/cancel', what: 'cancel', request, since: '2026-11-15T09:00:00Z', state: 'unknown',
  instrument: 'AUD_USD', detail: 'internal: the answer was lost', code: 'internal', ...more });
const asked = (c) => c.asked.map((a) => a.text);

function restored(e) {
  const c = page();
  c.tpb.catalog = [{ symbol: 'EUR_USD', digits: 5 }, { symbol: 'AUD_USD', digits: 5 }];
  const h = c.tpxRestoreHeld(e, 'my-oanda');
  assert.ok(h, 'the entry is a request of this connection');
  c.tpxHold(h);
  return c;
}

await test('1. a restored cancel the dock does not list is named by its order id and its instrument', async () => {
  const c = restored(entry(CANCEL));
  c.answer = false;
  const go = await c.tpxHeldGate('order', { broker: 'my-oanda', symbol: 'AUD_USD', side: 'buy', qty: 100 },
                                 '', 'Place it', 'AUD_USD');
  assert.equal(go, null, 'Not now sends nothing');
  assert.deepEqual(asked(c), ['The cancel of order 7 (AUD_USD) may have been carried out. Send this as well?']);
});

await test('1. with no instrument known it is named by its order id alone', async () => {
  const req = { broker: 'my-oanda', order_id: '7', client_id: 'lset-cancel-0a1b2c3d4e5f' };
  const c = restored(entry(req, { instrument: null }));
  c.answer = false;
  await c.tpxHeldGate('order', { broker: 'my-oanda', symbol: 'AUD_USD', side: 'buy', qty: 100 },
                      '', 'Place it', 'AUD_USD');
  assert.deepEqual(asked(c), ['The cancel of order 7 may have been carried out. Send this as well?']);
});

await test('2. one whose order the dock lists is named by that order', async () => {
  const c = restored(entry(CANCEL));
  c.tpx.orders = [{ id: '7', symbol: 'AUD_USD', side: 'buy', otype: 'limit', price: 0.69 }];
  c.answer = false;
  await c.tpxHeldGate('order', { broker: 'my-oanda', symbol: 'AUD_USD', side: 'buy', qty: 100 },
                      '', 'Place it', 'AUD_USD');
  assert.deepEqual(asked(c), ['The cancel of the buy limit AUD_USD order at 0.69 may have been carried out. '
                              + 'Send this as well?']);
});

done('test_held_names.mjs');
