// An order, close or cancel whose answer is lost (SPEC 2), on the page. Same
// method as the other .mjs tests here: the shipped functions are cut out of
// app.js by name and run in node:vm against stand-ins.
//
// What is pinned:
//   1. Buy and Sell are held from a press until its answer is in, so a
//      second press while one is out sends nothing, and the second click of
//      a double-click is not an order.
//   2. Each order carries a client_id made on the page. An answer whose
//      outcome is not known ("unknown") is said in full ("may have been
//      placed ... Check Positions before placing it again"), the broker's
//      own words kept whole beside it, and "Ask again" is offered.
//   3. The user's second click on the same order asks
//      again under the first one's client_id; so does "Ask again"; the
//      outcome, once known, is said and the order is no longer held; a new
//      order then has a client_id of its own.
//   4. A different order on the instrument of one that may have been placed
//      is sent only on a yes. No answer from the engine at all is held the
//      same way.
//   5. A close and a cancel are held and asked again exactly as they were
//      sent, and a second press while one is out sends nothing.
//   6. A close, a cancel and a resting order (the chart's menu) behave as an
//      order does: the same one pressed again asks again under its client_id
//      and is carried out once; another close of a position whose close may
//      have been carried out, or any other order on the instrument of an
//      order that may have been placed (market or resting, either way
//      round), is sent only on a yes (tests/test_held_gate.mjs has every
//      kind against every kind); a resting order whose answer was lost is
//      held, one at a time with the ticket's own; and a refusal is shown
//      whole.
//   7. While a request's outcome is not known, a later answer does not cover
//      the warning: the line says both, the answer in its own style and the
//      warning in the error style, and "Ask again" stays.
//   8. The second click of a double-click is not an order even when the first
//      one's answer is already in.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');

function cut(name, optional) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  if (start < 0 && optional) return '';
  assert.ok(start >= 0, 'no function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return src.slice(start, end + 2);
}

const FNS = ['readResult', 'tpxSetMsg', 'tpbSpec', 'tpbPlainReason', 'tpbNotArmedText', 'brokerIdentity',
  'brokerDisplayName', 'tpxOrder', 'tpxPlacing', 'tpxOnePress', 'tpxNewClientId', 'tpxSameOrder',
  'tpxHeldText', 'tpxHeldFor', 'tpxHold', 'tpxShowHeld', 'tpxHeldDone', 'tpxRenderAgain', 'tpxAskAgain',
  'tpbOrder', 'tpxOnce', 'acdSend', 'acdClosePart', 'acdCloseFull', 'acdCancelOrder', 'tpxPlacePending',
  'tpxQuickOrder'];
// The helpers the rules above are written with (loaded when the page has them).
const HELPERS = ['tpxSameRequest', 'tpxHeldOverlap', 'tpxHeldGate', 'tpxSay', 'acdCloseSend',
  'tpxHeldSymbol', 'tpxHeldName', 'acdHeldOrder', 'acdHeldPosition', 'tpxHeldLine', 'tpxHeldKey', 'tpxFetchHeld', 'tpxApplyHeld', 'tpxAnswered', 'tpxAnsweredText', 'tpxResay',
  'tpxHeldItems', 'tpxHeldElse', 'tpxConnected', 'tpxHeldWatch', 'tpxSending', 'tpxNow', 'tpxShowBroker', 'tpxHeldAsk',
  'oneLine', 'tpxHeldOn', 'tpxOtherAccount'];

const LOST = "internal: OANDA did not answer (TimeoutError); whether OANDA carried it out is not known yet. "
  + "It is NOT sent again: asking again with the same client_id is safe, and is answered from OANDA's own "
  + 'record (watched for 120 s after the answer was lost).';
const HELD = 'The order may have been placed: the answer from OANDA was lost. Check Positions before placing it again.';
const HELD_PENDING = 'The order may have been placed: the answer from OANDA was lost. Check Orders before placing it again.';
const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';

// An element that holds text or parts (the line's answer and its warning,
// tpxSay), with classes.
function node(id) {
  const cls = new Set(id === 'tpx-again' || id === 'tpx-new' ? ['hidden'] : []);
  return { id, value: '', _text: '', children: [], title: '', disabled: false, onclick: null,
    get className() { return [...cls].join(' '); },
    set className(v) { cls.clear(); for (const k of String(v).split(/\s+/).filter(Boolean)) cls.add(k); },
    get textContent() { return this._text + this.children.map((ch) => (typeof ch === 'string' ? ch : ch.textContent)).join(''); },
    set textContent(v) { this._text = String(v ?? ''); this.children = []; },
    append(...chs) { this.children.push(...chs); },
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) } };
}
function page() {
  const els = {};
  const el = (id) => (els[id] = els[id] || node(id));
  el('tpx-qty').value = '1000'; el('tpx-sl').value = ''; el('tpx-tp').value = ''; el('tpx-bsym').value = 'EUR_USD';
  const c = {
    $: el, els, JSON, String, Number, Math, parseFloat, Error, Object, Array, Promise, Set, Map, Uint8Array, Date,
    document: { createElement: () => node('') },
    crypto: { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0; return b; } },
    tpb: { broker: 'my-oanda', catalog: [{ symbol: 'EUR_USD', digits: 5 }] },
    tpx: { acct: { id: 'a' }, placing: false, held: [], inflight: new Set(), positions: [] },
    brokerPicker: { rows: [{ broker: 'my-oanda', identity: { display_name: 'OANDA' } }] },
    state: { symbol: 'EUR_USD' },
    tpbViaConnector: () => true,
    acdPx: (s, p) => String(p), acdPxLine: (s, p) => String(p),
    refreshed: 0, ordersTab: 0,
    tpbRefreshAccount() {}, tpbRefreshPositions() { c.refreshed += 1; },
    tpxRefreshAccount() {}, tpxRefreshPositions() {}, tpxRefreshOrders() {},
    acdShowOrdersTab() { c.ordersTab += 1; },
    asked: [], answer: false,
    async askConfirm(text, ok, no) { c.asked.push({ text, ok, no }); return c.answer; },
    sent: [], answers: [],
    // Each request is answered from `answers`, in order. A function there is
    // called with the request and may return a promise the test resolves.
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      c.sent.push({ url, body, buyHeld: el('tpx-buy').disabled, sellHeld: el('tpx-sell').disabled });
      let a = c.answers.shift();
      if (typeof a === 'function') a = await a(url, body);
      if (a instanceof Error) throw a;
      return { ok: a.status < 300, status: a.status, text: async () => JSON.stringify(a.body) };
    },
  };
  vm.createContext(c);
  for (const n of FNS) vm.runInContext(cut(n), c);
  for (const n of HELPERS) vm.runInContext(cut(n, true), c);
  return c;
}
const msg = (c) => ({ text: c.$('tpx-msg').textContent, cls: c.$('tpx-msg').className, title: c.$('tpx-msg').title });
// the line's two parts, each in its own style (tpxSay while a request is held)
const parts = (c) => c.$('tpx-msg').children.filter((ch) => typeof ch !== 'string').map((ch) => [ch.textContent, ch.className]);
const againShown = (c) => !c.$('tpx-again').classList.contains('hidden');
const unknownAnswer = (cid) => ({ status: 400, body: { detail: LOST, code: 'internal', retryable: true,
                                                       unknown: true, client_id: cid } });

// ── 1-3. a second click on the same order ──────────────────────────────────
{
  const c = page();
  let release;
  c.answers.push((url, body) => new Promise((ok) => { release = () => ok(unknownAnswer(body.client_id)); }));
  const first = c.tpxOrder('buy');                 // press 1: out
  await new Promise((r) => setImmediate(r));
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].buyHeld, true, 'Buy is held while the order is out');
  assert.equal(c.sent[0].sellHeld, true, 'and so is Sell');
  await c.tpxOrder('buy');                         // a press while it is out: nothing sent
  await c.tpxOrder('sell');
  assert.equal(c.sent.length, 1, 'a second press while one is out sends no second order');
  release();
  await first;
  const cid = c.sent[0].body.client_id;
  assert.match(cid, /^lset-[0-9a-f]{12}$/);
  assert.deepEqual({ ...c.sent[0].body }, { broker: 'my-oanda', symbol: 'EUR_USD', side: 'buy', qty: 1000, client_id: cid });
  assert.deepEqual(msg(c), { text: HELD, cls: 'err', title: LOST }, 'said whole, the broker\'s words kept whole');
  assert.equal(againShown(c), true, '"Ask again" is offered');
  assert.equal(c.$('tpx-buy').disabled, false, 'Buy is free again once the answer is in');
  assert.ok(c.refreshed >= 1, 'the positions are read again, where the order may show');

  // the user's second click, the same order: asked again, the same client_id
  c.answers.push(unknownAnswer(cid));
  await c.tpxOrder('buy');
  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[1].body.client_id, cid, 'the second click is the same order asked again');
  assert.deepEqual(msg(c).text, HELD);
  assert.equal(c.asked.length, 0, 'the same order is not a question');

  // "Ask again", after the broker carried it out: the outcome, said once
  c.answers.push({ status: 200, body: { order_id: '5', client_id: cid, status: 'filled',
                                        fill: { client_id: cid, qty: 1000, price: 1.1001 } } });
  await c.tpxAskAgain();
  assert.equal(c.sent[2].body.client_id, cid);
  assert.deepEqual({ ...c.sent[2].body }, { ...c.sent[0].body });
  assert.deepEqual(msg(c), { text: 'Asked again: buy 1000 EUR_USD filled @ 1.1001', cls: 'ok', title: '' });
  assert.equal(againShown(c), false, 'known now: no longer held');
  assert.equal(c.tpx.held.length, 0);

  // a new press after that is a new order, with a client_id of its own
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  await c.tpxOrder('buy');
  assert.notEqual(c.sent[3].body.client_id, cid);
  assert.equal(c.sent.length, 4, 'one order and its two askings, then one new order');
}
{
  // the second click of a double-click is not an order (setupTradePanel's handler)
  const line = src.match(/\$\("tpx-buy"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxOrder\("buy"\); \};/);
  assert.ok(line, "the Buy button's handler");
  assert.match(src, /\$\("tpx-sell"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxOrder\("sell"\); \};/);
  assert.match(src, /\$\("tpx-again"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxAskAgain\(\); \};/);
  const c = page();
  vm.runInContext(line[0], c);
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  c.$('tpx-buy').onclick({ detail: 1 });
  c.$('tpx-buy').onclick({ detail: 2 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.sent.length, 1, 'one gesture, one order');
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  c.$('tpx-buy').onclick({ detail: 0 });            // a key press
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.sent.length, 2);
}

// ── 4. a different order meanwhile; no answer from the engine at all ─────
{
  const c = page();
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.tpxOrder('buy');
  const cid = c.sent[0].body.client_id;
  c.$('tpx-qty').value = '500';                     // a different order
  c.answer = false;
  await c.tpxOrder('buy');
  assert.equal(c.sent.length, 1, 'not sent without a yes');
  assert.equal(c.asked[0].text, 'The order to buy 1000 EUR_USD may have been carried out. Send this as well?');
  assert.deepEqual([c.asked[0].ok, c.asked[0].no], ['Place it', 'Not now']);
  assert.equal(msg(c).text, HELD, 'the held order is said again');
  c.answer = true;
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  await c.tpxOrder('buy');
  assert.equal(c.sent.length, 2);
  assert.notEqual(c.sent[1].body.client_id, cid, 'a different order is a new order');
  assert.equal(c.tpx.held.length, 1, 'and the earlier one is still held');
  // its fill does not cover the warning about the one still held (7)
  assert.deepEqual([msg(c).text, msg(c).title], ['buy 500 EUR_USD filled @ 1.1. ' + HELD, LOST]);
  assert.deepEqual(parts(c), [['buy 500 EUR_USD filled @ 1.1.', 'ok'], [HELD, 'err']]);
  assert.equal(againShown(c), true);
}
{
  const c = page();
  c.answers.push(new TypeError('Failed to fetch'));
  await c.tpxOrder('sell');
  const cid = c.sent[0].body.client_id;
  assert.equal(msg(c).text, 'The order may have been placed: the answer from the terminal\'s engine was lost. '
    + 'Check Positions before placing it again.');
  assert.equal(againShown(c), true);
  c.answers.push({ status: 400, body: { detail: 'market_closed: the market is closed' } });
  await c.tpxAskAgain();
  assert.equal(c.sent[1].body.client_id, cid, 'asked again under the client_id it was sent with');
  assert.deepEqual([msg(c).text, msg(c).cls], ['the market is closed', 'err'], 'a final answer, said');
  assert.equal(c.tpx.held.length, 0);
}

{
  // Asked again, and not answered (the engine lost the connection, or the
  // broker asks to be asked later): its outcome is as unknown as before, so it
  // stays held with "Ask again", the reason said. Only an answer, or the
  // broker's final refusal, settles it.
  const c = page();
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.tpxOrder('buy');
  const cid = c.sent[0].body.client_id;
  c.answers.push({ status: 409, body: { detail: "broker 'my-oanda' is not connected" } });
  await c.tpxAskAgain();
  // the reason, and that the order is still held (7)
  assert.equal(msg(c).text, "broker 'my-oanda' is not connected. " + HELD);
  assert.deepEqual(parts(c), [["broker 'my-oanda' is not connected.", 'err'], [HELD, 'err']]);
  assert.equal(c.tpx.held.length, 1); assert.equal(againShown(c), true);
  c.answers.push({ status: 400, body: { detail: 'rate_limited: ask in a moment', code: 'rate_limited',
                                        retryable: true, unknown: false, client_id: cid } });
  await c.tpxAskAgain();
  assert.equal(msg(c).text, 'ask in a moment. ' + HELD);
  assert.equal(c.tpx.held.length, 1, 'a retryable refusal of asking again settles nothing');
  // the broker's final word: not carried out, said whole, no longer held
  const final = 'x_oanda_not_carried_out: The order ' + cid + ' (buy 1000 EUR_USD) was not carried out: '
    + "OANDA's answer was lost and OANDA's record shows nothing of it 120 s later.";
  c.answers.push({ status: 400, body: { detail: final } });
  await c.tpxAskAgain();
  assert.equal(c.sent.at(-1).body.client_id, cid);
  assert.equal(msg(c).text, final.slice('x_oanda_not_carried_out: '.length));
  assert.equal(c.tpx.held.length, 0); assert.equal(againShown(c), false);
  // a new order's own retryable refusal (nothing placed) holds nothing
  c.answers.push({ status: 400, body: { detail: 'rate_limited: slow down', code: 'rate_limited',
                                        retryable: true, unknown: false, client_id: 'x' } });
  await c.tpxOrder('buy');
  assert.equal(c.tpx.held.length, 0);
}

// ── 5. a close and a cancel ───────────────────────────────────────────────
{
  const c = page();
  const p = { id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 };
  let release;
  c.answers.push((url, body) => new Promise((ok) => { release = () => ok(unknownAnswer(body.client_id)); }));
  const first = c.acdClosePart(p, 0.5);
  await new Promise((r) => setImmediate(r));
  await c.acdClosePart(p, 0.5);                     // the same close pressed again while out
  assert.equal(c.sent.length, 1, 'a second press while the close is out sends nothing');
  release();
  await first;
  const sent = c.sent[0];
  assert.equal(sent.url, '/api/broker/close');
  assert.match(sent.body.client_id, /^lset-close-[0-9a-f]{12}$/);
  assert.equal(sent.body.qty, 1000);
  assert.equal(msg(c).text, 'The close may have been carried out: the answer from OANDA was lost. '
    + 'Check Positions before closing it again.');
  p.qty = 1000;                                     // it was carried out: the position is smaller
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();
  assert.deepEqual({ ...c.sent[1].body }, { ...sent.body }, 'asked again exactly as sent, not 50% of what is left');
  assert.deepEqual([msg(c).text, msg(c).cls], ['Asked again: closed 50% of EUR_USD', 'ok']);
  assert.equal(c.tpx.held.length, 0);
}
{
  const c = page();
  const o = { id: 'o7', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EUR_USD' };
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.acdCancelOrder(o);
  assert.equal(c.sent[0].url, '/api/broker/order/cancel');
  assert.match(c.sent[0].body.client_id, /^lset-cancel-[0-9a-f]{12}$/);
  assert.equal(msg(c).text, 'The cancel may have been carried out: the answer from OANDA was lost. '
    + 'Check Orders before cancelling it again.');
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();
  assert.equal(c.sent[1].body.client_id, c.sent[0].body.client_id);
  assert.deepEqual([msg(c).text, msg(c).cls], ['Asked again: buy limit @ 1.05 cancelled', 'ok']);
  // a refusal is said whole, as the broker gave it
  c.answers.push({ status: 400, body: { detail: 'not_resting: the order o7 already filled at 1.05 and cannot be cancelled now' } });
  await c.acdCancelOrder(o);
  assert.equal(msg(c).text, 'the order o7 already filled at 1.05 and cannot be cancelled now');
}

// ── 6. a close pressed again, a different close, a cancel pressed again ─────
{
  // The trap: the close's answer is lost and the dock still shows
  // the whole position, so the user presses Close half again. That press is
  // the same close, asked again under its client_id: one close, not two.
  const c = page();
  const p = { id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 };
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.acdClosePart(p, 0.5);
  const first = { ...c.sent[0].body };
  assert.equal(msg(c).text, HELD_CLOSE);
  c.answers.push({ status: 200, body: {} });
  await c.acdClosePart(p, 0.5);
  assert.equal(c.sent.length, 2);
  assert.deepEqual({ ...c.sent[1].body }, first, 'the same close, asked again under its client_id');
  assert.equal(c.asked.length, 0, 'the same close is not a question');
  assert.deepEqual([msg(c).text, msg(c).cls], ['Asked again: closed 50% of EUR_USD', 'ok']);
  assert.equal(c.tpx.held.length, 0); assert.equal(againShown(c), false);
  // the whole close the same way (the dock's x, the chart's close)
  const d = page();
  d.answers.push((url, body) => unknownAnswer(body.client_id));
  await d.acdCloseFull(p);
  d.answers.push({ status: 200, body: {} });
  await d.acdCloseFull(p);
  assert.deepEqual(d.sent.map((s) => s.body.client_id), [d.sent[0].body.client_id, d.sent[0].body.client_id]);
  assert.equal(d.asked.length, 0);
  assert.deepEqual([msg(d).text, msg(d).cls], ['Asked again: closed EUR_USD', 'ok']);
}
{
  // Another close of a position whose close may have been carried out is
  // sent only on a yes, under a client_id of its own; its answer does not
  // cover the warning (7). A close of another position is not about it.
  const c = page();
  const p = { id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 };
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.acdClosePart(p, 0.5);
  c.answer = false;
  await c.acdClosePart(p, 0.25);
  assert.equal(c.sent.length, 1, 'not sent without a yes');
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0].text, 'The close of 1000 EUR_USD may have been carried out. Send this as well?');
  assert.deepEqual([c.asked[0].ok, c.asked[0].no], ['Close it', 'Not now']);
  assert.equal(msg(c).text, HELD_CLOSE, 'the held close is said again');
  await c.acdCloseFull(p);                           // the x on the same row: another close
  assert.equal(c.sent.length, 1); assert.equal(c.asked.length, 2);
  c.answer = true;
  c.answers.push({ status: 200, body: {} });
  await c.acdClosePart(p, 0.25);
  assert.equal(c.sent.length, 2);
  assert.notEqual(c.sent[1].body.client_id, c.sent[0].body.client_id, 'a different close is a new close');
  assert.equal(c.sent[1].body.qty, 500);
  assert.equal(c.tpx.held.length, 1, 'the first close is still held');
  assert.equal(msg(c).text, 'closed 25% of EUR_USD. ' + HELD_CLOSE);
  assert.deepEqual(parts(c), [['closed 25% of EUR_USD.', 'ok'], [HELD_CLOSE, 'err']]);
  assert.equal(againShown(c), true);
  const q = { id: 'GBP_USD', position_id: 'GBP_USD', symbol: 'GBP_USD', qty: 500 };
  c.answers.push({ status: 200, body: {} });
  await c.acdCloseFull(q);
  assert.equal(c.sent.length, 3); assert.equal(c.asked.length, 3, 'no question for another position');
  assert.equal(msg(c).text, 'closed GBP_USD. ' + HELD_CLOSE);
}
{
  // the x on an order whose cancel may have been carried out: the same
  // cancel, asked again under its client_id
  const c = page();
  const o = { id: 'o7', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EUR_USD' };
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.acdCancelOrder(o);
  c.answers.push({ status: 200, body: {} });
  await c.acdCancelOrder(o);
  assert.equal(c.sent[1].body.client_id, c.sent[0].body.client_id);
  assert.equal(c.asked.length, 0);
  assert.deepEqual([msg(c).text, msg(c).cls], ['Asked again: buy limit @ 1.05 cancelled', 'ok']);
}

// ── 6. a resting order from the chart's menu ───────────────────────────────
{
  const c = page();
  let release;
  c.answers.push((url, body) => new Promise((ok) => { release = () => ok(unknownAnswer(body.client_id)); }));
  const first = c.tpxPlacePending('buy', 'limit', 1.05, 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].url, '/api/broker/order/pending');
  assert.equal(c.sent[0].buyHeld, true, 'the ticket is held while it is out');
  // one order at a time from the ticket and its menu: nothing while it is out
  await c.tpxPlacePending('buy', 'limit', 1.05, 1000);
  await c.tpxPlacePending('sell', 'stop', 1.04, 500);
  await c.tpxOrder('buy');
  assert.equal(c.sent.length, 1, 'a press while a resting order is out sends nothing');
  release();
  await first;
  const cid = c.sent[0].body.client_id;
  assert.match(cid, /^lset-[0-9a-f]{12}$/);
  assert.deepEqual({ ...c.sent[0].body }, { broker: 'my-oanda', symbol: 'EUR_USD', side: 'buy', qty: 1000,
                                            type: 'limit', price: 1.05, client_id: cid });
  // its answer lost: held, said whole, "Ask again" offered
  assert.deepEqual(msg(c), { text: HELD_PENDING, cls: 'err', title: LOST });
  assert.equal(againShown(c), true);
  assert.deepEqual(c.tpx.held.map((h) => h.kind), ['pending']);
  // the same resting order again: asked again under its client_id, no question
  c.answers.push(unknownAnswer(cid));
  await c.tpxPlacePending('buy', 'limit', 1.05, 1000);
  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[1].body.client_id, cid);
  assert.equal(c.asked.length, 0);
  assert.equal(c.tpx.held.length, 1);
  // a different resting order, or an order at market, only on a yes
  c.answer = false;
  await c.tpxPlacePending('buy', 'limit', 1.04, 1000);
  await c.tpxOrder('sell');
  assert.equal(c.sent.length, 2, 'not sent without a yes');
  const heldLimit = 'The buy limit order for 1000 EUR_USD at 1.05 may have been carried out. Send this as well?';
  assert.deepEqual(c.asked.map((a) => [a.text, a.ok, a.no]), [
    [heldLimit, 'Place it', 'Not now'],
    [heldLimit, 'Place it', 'Not now']]);
  assert.equal(msg(c).text, HELD_PENDING);
  // "Ask again", answered: placed, said once, no longer held
  c.answers.push({ status: 200, body: { order_id: 'o1', client_id: cid, status: 'resting' } });
  await c.tpxAskAgain();
  assert.deepEqual({ ...c.sent[2].body }, { ...c.sent[0].body });
  assert.deepEqual([msg(c).text, msg(c).cls], ['Asked again: buy limit 1000 EUR_USD @ 1.05 placed', 'ok']);
  assert.equal(c.tpx.held.length, 0); assert.equal(againShown(c), false);
  // a yes places the different one, under a client_id of its own
  c.answers.push({ status: 200, body: { order_id: 'o2', status: 'resting' } });
  await c.tpxPlacePending('buy', 'limit', 1.04, 1000);
  assert.equal(c.sent.length, 4);
  assert.notEqual(c.sent[3].body.client_id, cid);
}
{
  // a held order at market, then a limit from the chart's menu: a question
  const c = page();
  c.answers.push((url, body) => unknownAnswer(body.client_id));
  await c.tpxOrder('buy');
  c.answer = false;
  await c.tpxQuickOrder('buy', 'limit', 1.05);
  assert.equal(c.sent.length, 1);
  assert.deepEqual(c.asked.map((a) => a.text),
                   ['The order to buy 1000 EUR_USD may have been carried out. Send this as well?']);
  c.answer = true;
  c.answers.push({ status: 200, body: { order_id: 'o3', status: 'resting' } });
  await c.tpxQuickOrder('buy', 'limit', 1.05);
  assert.equal(c.sent.at(-1).url, '/api/broker/order/pending');
  assert.equal(msg(c).text, 'buy limit 1000 EUR_USD @ 1.05 placed. ' + HELD, 'and the warning stays');
  assert.deepEqual(parts(c), [['buy limit 1000 EUR_USD @ 1.05 placed.', 'ok'], [HELD, 'err']]);
}
{
  // no answer from the engine at all is held the same way
  const c = page();
  c.answers.push(new TypeError('Failed to fetch'));
  await c.tpxPlacePending('sell', 'stop', 1.04, 500);
  assert.equal(msg(c).text, "The order may have been placed: the answer from the terminal's engine was lost. "
    + 'Check Orders before placing it again.');
  assert.equal(againShown(c), true);
}
{
  // a refusal on the resting path is shown whole, as the market path's is
  const long = 'invalid_stops: the limit price 1.05000 is closer to the market than the broker allows for '
    + 'EUR_USD; the nearest it takes is 1.04900, which is 10 points away, and the order was not placed';
  const words = long.slice('invalid_stops: '.length);
  const c = page();
  c.answers.push({ status: 400, body: { detail: long } });
  await c.tpxPlacePending('buy', 'limit', 1.05, 1000);
  assert.deepEqual([msg(c).text, msg(c).cls], [words, 'err']);
  const r = page();
  r.answers.push({ status: 200, body: { status: 'rejected', order_id: 'o9', reason: words } });
  await r.tpxPlacePending('buy', 'limit', 1.05, 1000);
  assert.deepEqual([msg(r).text, msg(r).cls], [words, 'err']);
}

// ── 8. the second click of a double-click, after a fast answer ────────────
{
  const line = src.match(/\$\("tpx-buy"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxOrder\("buy"\); \};/);
  const c = page();
  vm.runInContext(line[0], c);
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  c.$('tpx-buy').onclick({ detail: 1 });
  await new Promise((r) => setTimeout(r, 20));      // the first one's answer is in
  assert.equal(c.$('tpx-buy').disabled, false);
  c.$('tpx-buy').onclick({ detail: 2 });            // then the gesture's second click
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.sent.length, 1, 'one gesture, one order, however fast the answer');
}

// ── the guide's bullet says what the ticket and the dock do ────────────────
{
  const guide = fs.readFileSync(new URL('../lse_terminal/ui/static/guide.md', import.meta.url), 'utf8');
  const lost = guide.split('\n').find((l) => l.startsWith('- **An answer that was lost.**'));
  assert.ok(lost, 'the guide has no bullet on a lost answer');
  for (const piece of ['BUY and SELL, and the chart menu\'s orders, wait while an order is out',
                       'Pressing the same order, close or cancel again asks again too',
                       'any other order (at market or at a level), close or cancel on that connection for the '
                       + 'same instrument is sent only after you say yes',
                       'The warning stays on the ticket\'s line, after any later answer']) {
    assert.ok(lost.includes(piece), 'the bullet does not say: ' + piece);
  }
  assert.ok(!lost.includes('a different order meanwhile is placed only after you confirm it'), lost);
}

console.log('test_order_retry.mjs: ok');
