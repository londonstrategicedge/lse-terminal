// The ticket's line while a request whose answer was lost is held, and the
// refusals it shows. The shipped functions are cut out of app.js by name and
// run in node:vm (tests/ticket_page.mjs); tpbSwitch, tpbInstrumentChanged and
// the quote subscription are loaded for real, not stubbed.
//
// What is pinned:
//   1. While a request is held, every later line keeps the warning after it,
//      with the broker's words as its tooltip and Ask again under it: a quote
//      subscription that fails (no answer, refused, over the broker's limit),
//      also right after an instrument switch, and its recovery; an instrument
//      switch; a reconnect, one that stops at the account chooser included;
//      the chart's SL/TP change, accepted or refused.
//   2. An answer keeps its own style before the warning: a fill or "Asked
//      again: closed ..." reads as done, the warning that follows as a
//      warning.
//   3. Refusals are shown whole and in words: a connect refused on the
//      ticket's line without the protocol's code word, the chart's SL/TP
//      refusal, and the hosted demo account's refusals of an order, a close
//      and a cancel.
import { page, line, settle, test, done, unknownAnswer, LOST } from './ticket_page.mjs';
import assert from 'node:assert/strict';

const HELD = 'The order may have been placed: the answer from OANDA was lost. Check Positions before placing it again.';
const HELD_CLOSE = 'The close may have been carried out: the answer from OANDA was lost. '
  + 'Check Positions before closing it again.';
// a connect refusal of 393 characters, its last sentence the one that matters
const REFUSAL_WORDS = 'OANDA refused this API token on its practice host (127.0.0.1). A token made on a practice '
  + '(demo) login works only on practice, and one made on a live login only on live: check that it is the token '
  + 'OANDA showed for this login and that it has not been revoked. OANDA does not offer its v20 API to clients of '
  + 'OANDA TMS Brokers (EU residents) or OANDA Global Markets.';
const REFUSAL = 'unauthorized: ' + REFUSAL_WORDS;
const LONG_SIM = 'insufficient margin: this order needs 41,250.00 USD of margin and the account has 12,004.17 USD '
  + 'free; close a position or lower the size, then place it again (the demo account keeps the same rules)';

// a connected broker: connect, its catalog, the subscription, the list, and
// (an engine with the held-requests route) nothing held
function connected(c, over = {}) {
  c.route = (url, method, body) => {
    for (const [k, v] of Object.entries(over)) if (url.startsWith(k)) return typeof v === 'function' ? v(url, body) : v;
    if (url === '/api/broker/connect') return { status: 200, body: { connected: true } };
    if (url.startsWith('/api/broker/catalog')) return { status: 200, body: [{ symbol: 'EUR_USD', digits: 5 },
                                                                            { symbol: 'GBP_USD', digits: 5 }] };
    if (url === '/api/broker/subscribe') return { status: 200, body: { subscribed: body.symbols, refused: [] } };
    if (url === '/api/broker/list') return { status: 200, body: c.brokerPicker.rows };
    if (url === '/api/broker/held') return { status: 404, body: { detail: 'Not Found' } };
    return undefined;
  };
}
async function holdAnOrder(c) {
  c.route = null;
  c.answers.push((u, b) => unknownAnswer(b.client_id));
  await c.tpxOrder('buy');
  assert.deepEqual(line(c).held, ['order']);
}
const isHeld = (c, lead) => {
  const l = line(c);
  const want = lead ? [[lead, l.parts[0] && l.parts[0][1]], [HELD, 'err']] : [];
  assert.equal(l.text, lead ? lead + ' ' + HELD : HELD, JSON.stringify(l));
  if (lead) assert.deepEqual(l.parts, want);
  assert.equal(l.title, LOST, 'the broker\'s words stay the tooltip');
  assert.equal(l.again, true, 'Ask again stays');
  return l;
};

// ── 1. the quote subscription fails while a request is held, and recovers ──
for (const [label, answer, said] of [
  ['no answer', new TypeError('Failed to fetch'), 'Prices unavailable: connection failed; retrying.'],
  ['refused', { status: 502, body: { detail: 'quotes.subscribe timed out' } }, 'Prices unavailable: quotes.subscribe timed out.'],
  ['over the limit', { status: 200, body: { subscribed: [], refused: ['EUR_USD'] } },
   'Prices unavailable: EUR_USD (broker subscription limit; reconnect to reset).'],
]) {
  await test(`a quote subscription ${label} while an order is held keeps the warning`, async () => {
    const c = page();
    await holdAnOrder(c);
    c.answers.push(answer);
    await c.tpbSubscribeOnce('my-oanda', c.tpb.generation);
    const l = isHeld(c, said);
    assert.deepEqual(l.parts[0], [said, 'err']);
    // and when it recovers, the warning alone, as before the error
    c.answers.push({ status: 200, body: { subscribed: ['EUR_USD'], refused: [] } });
    await c.tpbSubscribeOnce('my-oanda', c.tpb.generation);
    isHeld(c);
    assert.equal(line(c).cls, 'err');
  });
}
await test('nothing held: a failed subscription says so, its recovery clears it', async () => {
  const c = page();
  c.answers.push(new TypeError('Failed to fetch'));
  await c.tpbSubscribeOnce('my-oanda', c.tpb.generation);
  assert.deepEqual([line(c).text, line(c).cls], ['Prices unavailable: connection failed; retrying', 'err']);
  c.answers.push({ status: 200, body: { subscribed: ['EUR_USD'], refused: [] } });
  await c.tpbSubscribeOnce('my-oanda', c.tpb.generation);
  assert.deepEqual([line(c).text, line(c).again], ['', false]);
});

// ── 1. an instrument switch, with the subscription answering or failing ────
await test('an instrument switch while an order is held keeps the warning (tpbInstrumentChanged)', async () => {
  const c = page();
  await holdAnOrder(c);
  c.$('tpx-msg').textContent = 'placing…';           // whatever the line said before the switch
  connected(c);
  c.$('tpx-bsym').value = 'GBP_USD';
  c.tpbInstrumentChanged();
  await settle();
  isHeld(c);
  assert.ok(c.sent.some((s) => s.url === '/api/broker/subscribe'), 'the new instrument is priced');
});
await test('an instrument switch whose subscription fails keeps the warning after the error', async () => {
  const c = page();
  await holdAnOrder(c);
  connected(c, { '/api/broker/subscribe': new TypeError('Failed to fetch') });
  c.$('tpx-bsym').value = 'GBP_USD';
  c.tpbInstrumentChanged();
  await settle();
  isHeld(c, 'Prices unavailable: connection failed; retrying.');
});
await test('nothing held: an instrument switch drops the previous instrument\'s verdict', async () => {
  const c = page();
  c.$('tpx-msg').textContent = 'the market is closed';
  connected(c);
  c.$('tpx-bsym').value = 'GBP_USD';
  c.tpbInstrumentChanged();
  await settle();
  assert.deepEqual([line(c).text, line(c).again], ['', false]);
});

// ── 1. a reconnect (tpbSwitch) ──────────────────────────────────────────────
await test('a reconnect while an order is held says the warning again once connected (tpbSwitch)', async () => {
  const c = page();
  await holdAnOrder(c);
  connected(c);
  const out = await c.tpbSwitch('my-oanda');
  assert.equal(out.ok, true);
  isHeld(c);
  assert.ok(c.sent.some((s) => s.url.startsWith('/api/broker/catalog')), 'it read the catalog');
});
await test('a reconnect that stops at the account chooser keeps the warning after its words', async () => {
  const c = page();
  await holdAnOrder(c);
  connected(c, { '/api/broker/connect': { status: 200, body: { connected: false, needs_account: true } } });
  const out = await c.tpbSwitch('my-oanda');
  assert.equal(out.needsAccount, true);
  const l = isHeld(c, 'choose an account in Connections.');
  assert.deepEqual(l.parts[0], ['choose an account in Connections.', '']);
});
// ── 1. a broker's own login in the browser, and its account chooser ────────
// (tpbAwaitBrokerLogin: the wait can be minutes; both lines go through
// tpxSay.) The line is read as the user sees it while the login is awaited
// (at the poll), and once the broker asks which account (at the read that
// follows).
await test('the login wait while an order is held keeps the warning after its words', async () => {
  const c = page();
  await holdAnOrder(c);
  const seen = {};
  let polls = 0;
  connected(c, {
    '/api/broker/connect': () => {
      polls += 1;
      if (polls === 1) return { status: 200, body: { connected: false, auth_pending: true } };
      seen.waiting = line(c);
      return { status: 200, body: { connected: false, needs_account: true } };
    },
    '/api/broker/auth/open': { status: 200, body: { url: 'https://login.example/', opened: true } },
    '/api/broker/held': () => { seen.choose = line(c); return { status: 404, body: { detail: 'Not Found' } }; },
  });
  const out = await c.tpbSwitch('my-oanda');
  assert.equal(out.needsAccount, true);
  assert.ok(seen.waiting && seen.choose, 'both lines were read: ' + JSON.stringify(seen));
  assert.deepEqual(seen.waiting.parts, [['finish the login in your browser…', ''], [HELD, 'err']]);
  assert.deepEqual([seen.waiting.title, seen.waiting.again], [LOST, true]);
  assert.deepEqual(seen.choose.parts, [['choose an account.', ''], [HELD, 'err']]);
  assert.deepEqual([seen.choose.title, seen.choose.again], [LOST, true]);
  isHeld(c, 'choose an account in Connections.');
});
await test('nothing held: the login wait and the chooser are said alone', async () => {
  const c = page();
  const seen = {};
  let polls = 0;
  connected(c, {
    '/api/broker/connect': () => {
      polls += 1;
      if (polls === 1) return { status: 200, body: { connected: false, auth_pending: true } };
      seen.waiting = line(c);
      return { status: 200, body: { connected: false, needs_account: true } };
    },
    '/api/broker/auth/open': { status: 200, body: { url: 'https://login.example/', opened: true } },
    '/api/broker/held': () => { seen.choose = line(c); return { status: 404, body: { detail: 'Not Found' } }; },
  });
  await c.tpbSwitch('my-oanda');
  assert.deepEqual([seen.waiting.text, seen.waiting.parts, seen.waiting.again],
                   ['finish the login in your browser…', [], false]);
  assert.deepEqual([seen.choose.text, seen.choose.parts, seen.choose.again], ['choose an account', [], false]);
});
await test('nothing held: the chooser line is said alone', async () => {
  const c = page();
  connected(c, { '/api/broker/connect': { status: 200, body: { connected: false, needs_account: true } } });
  await c.tpbSwitch('my-oanda');
  assert.deepEqual([line(c).text, line(c).again], ['choose an account in Connections', false]);
});

// ── 3. a connect refused: whole, in words, on the ticket's line ────────────
await test('a refused connect is shown whole on the ticket\'s line, without its code word', async () => {
  const c = page();
  connected(c, { '/api/broker/connect': { status: 400, body: { detail: REFUSAL } } });
  const out = await c.tpbSwitch('my-oanda');
  assert.equal(out.ok, false);
  assert.equal(out.error, REFUSAL, 'the card that asked gets the engine\'s detail as it was');
  assert.deepEqual([line(c).text, line(c).cls], [REFUSAL_WORDS, 'err']);
  assert.ok(REFUSAL_WORDS.length > 300 && line(c).text.endsWith('OANDA Global Markets.'));
});
await test('a refused reconnect while an order is held: the refusal whole, then the warning', async () => {
  const c = page();
  await holdAnOrder(c);
  connected(c, { '/api/broker/connect': { status: 400, body: { detail: REFUSAL } } });
  await c.tpbSwitch('my-oanda');
  isHeld(c, REFUSAL_WORDS);
  assert.deepEqual(line(c).parts[0], [REFUSAL_WORDS, 'err']);
});

// ── 1-3. the chart's SL/TP change ───────────────────────────────────────────
await test('the chart\'s SL/TP change while an order is held: accepted, its words, then the warning', async () => {
  const c = page();
  await holdAnOrder(c);
  c.tpx.positions = [{ id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 }];
  c.answers.push({ status: 200, body: {} });
  await c.acdModifyFromChart('EUR_USD', 1.2, 1.3);
  const l = isHeld(c, 'SL/TP updated.');
  assert.deepEqual(l.parts[0], ['SL/TP updated.', 'ok'], 'the change reads as done');
});
await test('the chart\'s SL/TP refusal is shown whole, in words', async () => {
  const long = 'invalid_stops: the stop loss 1.20000 is closer to the market than OANDA allows for EUR_USD; the '
    + 'nearest it takes is 1.26000, which is 500 points away, and nothing was changed';
  const words = long.slice('invalid_stops: '.length);
  const c = page();
  c.tpx.positions = [{ id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 }];
  c.answers.push({ status: 400, body: { detail: long } });
  await c.acdModifyFromChart('EUR_USD', 1.2, null);
  assert.deepEqual([line(c).text, line(c).cls], [words, 'err']);
  // while an order is held: the refusal whole, then the warning
  await holdAnOrder(c);
  c.answers.push({ status: 400, body: { detail: long } });
  await c.acdModifyFromChart('EUR_USD', 1.2, null);
  isHeld(c, words + '.');
});

// ── 2. an answer in its own style, then the warning ─────────────────────────
await test('a fill while an order is held reads as a fill, then the warning as a warning', async () => {
  const c = page();
  await holdAnOrder(c);
  c.$('tpx-qty').value = '500';
  c.answer = true;
  c.answers.push({ status: 200, body: { status: 'filled', fill: { price: 1.1 } } });
  await c.tpxOrder('buy');
  const l = isHeld(c, 'buy 500 EUR_USD filled @ 1.1.');
  assert.deepEqual(l.parts, [['buy 500 EUR_USD filled @ 1.1.', 'ok'], [HELD, 'err']]);
});
await test('"Asked again: closed ..." while another request is held reads as done', async () => {
  const c = page();
  const p = { id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 };
  await holdAnOrder(c);
  c.answer = true;                                  // the close is another request on that instrument
  c.answers.push((u, b) => unknownAnswer(b.client_id));
  await c.acdClosePart(p, 0.5);
  assert.deepEqual(line(c).held, ['order', 'close']);
  c.answers.push({ status: 200, body: {} });
  await c.tpxAskAgain();                            // asks about the close, the latest
  assert.deepEqual(line(c).held, ['order']);
  const l = isHeld(c, 'Asked again: closed 50% of EUR_USD.');
  assert.deepEqual(l.parts, [['Asked again: closed 50% of EUR_USD.', 'ok'], [HELD, 'err']]);
});
await test('a refusal while a close is held: both in the error style', async () => {
  const c = page();
  const p = { id: 'EUR_USD', position_id: 'EUR_USD', symbol: 'EUR_USD', qty: 2000 };
  c.answers.push((u, b) => unknownAnswer(b.client_id));
  await c.acdClosePart(p, 0.5);
  c.$('tpx-bsym').value = 'GBP_USD';                 // another instrument: no question
  c.answers.push({ status: 400, body: { detail: 'market_closed: the market is closed' } });
  await c.tpxOrder('sell');
  const l = line(c);
  assert.deepEqual(l.parts, [['the market is closed.', 'err'], [HELD_CLOSE, 'err']]);
  assert.equal(l.title, LOST);
});

// ── 3. the cuts that were left: whole, on one line, in words ────────────────
// A body that is not JSON (a proxy's page, a traceback), the History tab's
// error and the quote error's reason were cut at 120, 120 and 160 characters.
const LONG_TEXT = 'upstream connect error or disconnect/reset before headers. retried and the latest reset reason: '
  + 'connection termination\n  while the broker\'s gateway at 127.0.0.1 was restarting: try again in a minute, '
  + 'or reconnect the broker in Connections if it does not come back';
const LONG_ONE_LINE = LONG_TEXT.replace(/\s+/g, ' ');
const LONG_CODED = 'market_data_unavailable: the broker gave no fills for this account because its history service '
  + 'answered 503 three times in a row; the fills are still on the broker\'s own record and the tab shows them as '
  + 'soon as that service answers again';
const LONG_WORDS = LONG_CODED.slice('market_data_unavailable: '.length);
await test('a body that is not JSON is read whole, on one line (readResult)', async () => {
  const c = page();
  assert.ok(LONG_TEXT.length > 200 && LONG_TEXT.includes('\n'));
  const r = { status: 502, text: async () => LONG_TEXT };
  // (read as the page's own object: compared by its fields)
  const read = async (x) => ({ ...(await c.readResult(x)) });
  assert.deepEqual(await read(r), { detail: LONG_ONE_LINE });
  assert.deepEqual(await read({ status: 504, text: async () => '' }), {}, 'an empty body is no words');
  assert.deepEqual(await read({ status: 504, text: async () => '<html>\n<b>504</b>\n</html>' }),
                   { detail: '<html> <b>504</b> </html>' });
  assert.deepEqual(await read({ status: 502, text: async () => ' \n ' }), { detail: 'HTTP 502' },
                   'a body of nothing but spaces says its status');
  // as the ticket says it: a refusal whose body is not JSON, whole
  c.answers.push({ status: 502, body: LONG_TEXT });
  c.$('tpx-bsym').value = 'GBP_USD';
  await c.tpxOrder('sell');
  assert.deepEqual([line(c).text, line(c).cls], [LONG_ONE_LINE, 'err']);
});
await test('the History tab\'s error is shown whole, in words, as text', async () => {
  const c = page({ more: ['acdRenderHistory'] });
  c.tpx.dockTab = 'hist';
  c.answers.push({ status: 502, body: { detail: LONG_CODED } });
  await c.acdRenderHistory();
  const body = c.$('acd-body');
  assert.equal(body.textContent, 'History unavailable: ' + LONG_WORDS);
  assert.ok(LONG_WORDS.length > 120);
  // the broker's words are never markup on the page
  c.answers.push({ status: 502, body: { detail: 'bad_request: <img src=x onerror=alert(1)> refused' } });
  await c.acdRenderHistory();
  assert.equal(body.textContent, 'History unavailable: <img src=x onerror=alert(1)> refused');
  assert.equal(body.innerHTML, '', 'no markup was written from the words');
  // a body that is not JSON: whole, one line
  c.answers.push({ status: 502, body: LONG_TEXT });
  await c.acdRenderHistory();
  assert.equal(body.textContent, 'History unavailable: ' + LONG_ONE_LINE);
});
await test('the quote error\'s reason is shown whole, in words', async () => {
  const c = page();
  c.answers.push({ status: 502, body: { detail: LONG_CODED } });
  await c.tpbSubscribeOnce('my-oanda', c.tpb.generation);
  assert.deepEqual([line(c).text, line(c).cls], ['Prices unavailable: ' + LONG_WORDS, 'err']);
  // and while a request is held: the reason whole, on one line, then the warning
  await holdAnOrder(c);
  c.answers.push({ status: 502, body: { detail: LONG_TEXT } });
  await c.tpbSubscribeOnce('my-oanda', c.tpb.generation);
  isHeld(c, 'Prices unavailable: ' + LONG_ONE_LINE + '.');
});

// ── 3. the hosted demo account's refusals, whole ────────────────────────────
for (const [what, run] of [
  ['an order', async (c) => { c.answers.push({ status: 400, body: { detail: LONG_SIM } }); await c.tpxOrder('buy'); }],
  ['a part close', async (c) => {
    c.answers.push({ status: 400, body: { detail: LONG_SIM } });
    await c.acdClosePart({ id: 'p1', symbol: 'EURUSD', qty: 2000 }, 0.5);
  }],
  ['a whole close', async (c) => { c.answers.push(new Error(LONG_SIM)); await c.acdCloseFull({ id: 'p1', symbol: 'EURUSD', qty: 2000 }); }],
  ['a cancel', async (c) => {
    c.answers.push({ status: 400, body: { detail: LONG_SIM } });
    await c.acdCancelOrder({ id: 'o1', side: 'buy', otype: 'limit', price: 1.05, symbol: 'EURUSD' });
  }],
]) {
  await test(`the hosted demo account's refusal of ${what} is shown whole`, async () => {
    const c = page();
    c.tpb.broker = 'lse-hosted';
    await run(c);
    assert.equal(line(c).cls, 'err');
    assert.ok(line(c).text.endsWith('(the demo account keeps the same rules)'), line(c).text);
    assert.ok(line(c).text.length > 120);
  });
}

done('test_ticket_line.mjs');
