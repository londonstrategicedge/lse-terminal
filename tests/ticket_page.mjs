// The ticket and the dock's shipped functions, cut out of app.js by name and
// run in node:vm against a small DOM and a fetch that answers as a test says.
// A helper for the tests/test_*.mjs that drive the ticket's line, not a test.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');

export function cut(name, optional) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  if (start < 0 && optional) return '';
  assert.ok(start >= 0, 'no function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return src.slice(start + 1, end + 2);
}

// ── a small DOM: elements with children, classes, text, a title, a value ──
export function element(tag = 'div', id = '') {
  const cls = new Set();
  const e = {
    id, tagName: String(tag).toUpperCase(), children: [], _text: '', title: '', disabled: false,
    onclick: null, selected: false, dataset: {}, style: {}, _value: '',
    get className() { return [...cls].join(' '); },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) cls.add(c); },
    get textContent() { return this._text + this.children.map((ch) => ch.textContent).join(''); },
    set textContent(v) { this._text = String(v ?? ''); this.children = []; },
    set innerHTML(v) { this._text = ''; this.children = []; this._value = ''; this._chosen = undefined; },
    get innerHTML() { return this._text; },
    // a select's value: the one set, while it names an option; else its
    // selected option's; else its first option's (as a browser's select)
    get value() {
      if (this.tagName !== 'SELECT') return this._value;
      const opts = this.options;
      if (this._chosen !== undefined && opts.some((o) => o.value === this._chosen)) return this._chosen;
      const o = opts.find((ch) => ch.selected) || opts[0];
      return o ? o.value : '';
    },
    set value(v) { if (this.tagName === 'SELECT') this._chosen = String(v); else this._value = v; },
    get options() { return this.children.filter((ch) => ch.tagName === 'OPTION'); },
    get selectedOptions() { const o = this.options.find((x) => x.value === this.value); return o ? [o] : []; },
    appendChild(ch) {
      this.children.push(ch);
      if (this.tagName === 'SELECT' && ch.selected) this._chosen = undefined;
      return ch;
    },
    append(...chs) { for (const ch of chs) this.appendChild(typeof ch === 'string' ? textNode(ch) : ch); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    remove() {},
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
    },
  };
  return e;
}
function textNode(t) {
  return { tagName: '#text', children: [], textContent: String(t), className: '', classList: { contains: () => false } };
}

export const LOST = "internal: OANDA did not answer (TimeoutError); whether OANDA carried it out is not known yet. "
  + "It is NOT sent again: asking again with the same client_id is safe, and is answered from OANDA's own "
  + 'record (watched for 120 s after the answer was lost).';
// A listed row's adapter in the kit, asked again before the broker's record
// shows the request (its answer that the request is not in the record yet),
// as the engine passes it on.
export const STILL = "internal: Not known yet whether OANDA carried out the earlier order: the earlier request "
  + "under this client_id is not in OANDA's record yet. It is NOT sent again: asking again with the same "
  + "client_id is safe, and is answered from OANDA's own record (watched for 120 s after the answer was lost).";
export const unknownAnswer = (cid, detail = LOST) => ({ status: 400, body: { detail, code: 'internal',
                                                                           retryable: true, unknown: true,
                                                                           client_id: cid } });

// Every function of the ticket, the dock and the connection that these tests
// drive, loaded for real; the rest of the page stubbed, recorded.
export const TICKET_FNS = ['readResult', 'tpxSetMsg', 'tpbSpec', 'tpbPlainReason', 'tpbNotArmedText',
  'brokerIdentity', 'brokerDisplayName', 'tpxOrder', 'tpxPlacing', 'tpxOnePress', 'tpxNewClientId',
  'tpxSameOrder', 'tpxHeldText', 'tpxHeldFor', 'tpxHold', 'tpxShowHeld', 'tpxHeldDone', 'tpxRenderAgain',
  'tpxAskAgain', 'tpbOrder', 'tpxOnce', 'acdSend', 'acdClosePart', 'acdCloseFull', 'acdCancelOrder',
  'tpxPlacePending', 'tpxQuickOrder', 'acdModifyFromChart', 'tpbInstrumentChanged', 'tpbSubscribe',
  'tpbSubscribeOnce', 'tpbSwitch', 'tpbStop', 'tpbViaConnector', 'tpbAwaitBrokerLogin', 'tpbBare'];
// Loaded when the page has them.
export const TICKET_HELPERS = ['tpxSameRequest', 'tpxHeldOverlap', 'tpxHeldGate', 'tpxSay', 'acdCloseSend',
  'tpxHeldSymbol', 'tpxHeldName', 'tpxPlaceNew', 'tpxLoadHeld', 'tpxRestoreHeld', 'acdHeldOrder',
  'acdHeldPosition', 'tpxHeldLine', 'tpxHeldKey', 'tpxFetchHeld', 'tpxApplyHeld', 'tpxAnswered', 'tpxAnsweredText', 'tpxResay',
  'tpxHeldItems', 'tpxHeldElse', 'tpxConnected', 'tpxHeldWatch', 'tpxSending', 'tpxNow', 'tpxShowBroker', 'tpxHeldAsk',
  'oneLine', 'tpxHeldOn', 'tpxOtherAccount'];

export function page(opts = {}) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || element(id === 'tpx-bsym' || id === 'tpx-broker' ? 'select' : 'div', id));
  for (const id of ['tpx-again', 'tpx-new', 'tpx-show', 'tpx-conn', 'tpx-back']) $(id).classList.add('hidden');
  $('tpx-qty').value = '1000'; $('tpx-sl').value = ''; $('tpx-tp').value = '';
  const bs = $('tpx-bsym');
  for (const s of ['EUR_USD', 'GBP_USD']) { const o = element('option'); o.value = s; o.textContent = s; bs.appendChild(o); }
  bs.value = 'EUR_USD';
  const c = {
    $, els, JSON, String, Number, Math, parseFloat, Error, TypeError, Object, Array, Promise, Set, Map,
    Uint8Array, RegExp, Date, isFinite,
    document: { createElement: (tag) => element(tag), createTextNode: textNode },
    crypto: { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0; return b; } },
    tpb: { broker: 'my-oanda', catalog: [{ symbol: 'EUR_USD', digits: 5 }, { symbol: 'GBP_USD', digits: 5 }],
           quotes: {}, timer: null, ticks: 0, adopting: false, generation: 0, quoteError: '' },
    tpx: { acct: { id: 'a' }, placing: false, held: [], inflight: new Set(), positions: [], orders: [] },
    brokerPicker: { rows: [{ broker: 'my-oanda', identity: { display_name: 'OANDA' }, connected: true }] },
    state: { symbol: 'EUR_USD', hosted: false },
    acdPx: (s, p) => String(p), acdPxLine: (s, p) => String(p),
    refreshed: 0, ordersTab: 0, intervals: [], resets: [],
    tpbRefreshAccount() {}, tpbRefreshPositions() { c.refreshed += 1; }, tpbUpdateQuote() {},
    tpxRefreshAccount() {}, tpxRefreshPositions() {}, tpxRefreshOrders() {}, tpxUpdateQuote() {},
    acdShowOrdersTab() { c.ordersTab += 1; }, acdReset(note) { c.resets.push(note); },
    tpbSyncBsymVisibility() {}, renderConnBar() {}, refreshProviders: async () => {},
    // MARKETS's page at boot (marketsBootSource): another section of the page
    marketsBootSource() {},
    setInterval: (fn, ms) => { c.intervals.push(ms); return 1; }, clearInterval() {},
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), AbortController,
    window: { open() {} },
    asked: [], answer: false,
    async askConfirm(text, ok, no) { c.asked.push({ text, ok, no }); return typeof c.answer === 'function' ? c.answer(text) : c.answer; },
    sent: [],
    // Each request is answered by `route` (url, method, body) when a test sets
    // one, else from `answers` in order. An answer is {status, body}, an
    // Error (thrown: no answer at all), or a promise of either.
    answers: [], route: null,
    async fetch(url, init = {}) {
      const body = init.body ? JSON.parse(init.body) : null;
      c.sent.push({ url, method: init.method || 'GET', body, buyHeld: $('tpx-buy').disabled });
      let a = c.route ? c.route(url, init.method || 'GET', body) : undefined;
      if (a === undefined) a = c.answers.shift();
      if (typeof a === 'function') a = a(url, body);
      a = await a;
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error('the test gave no answer for ' + url);
      const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
      return { ok: a.status < 300, status: a.status, text: async () => text, json: async () => JSON.parse(text) };
    },
    ...(opts.ctx || {}),
  };
  vm.createContext(c);
  for (const n of TICKET_FNS) vm.runInContext(cut(n), c);
  for (const n of TICKET_HELPERS) vm.runInContext(cut(n, true), c);
  for (const n of opts.more || []) vm.runInContext(cut(n), c);
  return c;
}

// The ticket's line as a user reads it: its words, its style, its tooltip,
// each part in its own style, and the two buttons under it.
export function line(c) {
  const m = c.$('tpx-msg');
  return { text: m.textContent, cls: m.className, title: m.title,
           parts: m.children.filter((ch) => ch.tagName !== '#text').map((ch) => [ch.textContent, ch.className]),
           again: !c.$('tpx-again').classList.contains('hidden'),
           placeNew: !c.$('tpx-new').classList.contains('hidden'),
           held: c.tpx.held.map((h) => h.kind) };
}

export const tick = () => new Promise((r) => setImmediate(r));
export const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

// Each block runs on its own and is reported, so one run shows every part
// that fails; the file fails when any block does.
const results = [];
export async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log('ok    ' + name);
  } catch (e) {
    results.push([name, false]);
    const msg = String((e && e.message) || e).split('\n').slice(0, 14).join('\n        ');
    console.log('FAIL  ' + name + '\n        ' + msg);
  }
}
export function done(file) {
  const bad = results.filter((r) => !r[1]);
  if (bad.length) {
    console.log(`${file}: ${bad.length} of ${results.length} blocks FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`${file}: ok (${results.length} blocks)`);
  }
}
