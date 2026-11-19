// A broker's terms (Brue Connect SPEC 3.3) on the page. Same method as the
// other .mjs tests here: the functions are cut out of app.js (and the shell's
// main.js) by name and run in node:vm against stand-ins, so what is tested is
// the shipped text.
//
// What is pinned:
//   1. THE ROW AND THE ARMING QUESTION show the engine's sentence (the
//      summary with its full stop, or the terminal's own words), else the
//      summary, as TEXT (never markup), with the link to the
//      terms only when it is https. Nothing for a broker whose terms say
//      nothing, so its row and its question look as they did.
//   2. WHAT THE ASSISTANTS READ (the screen map and the account, for the
//      hosted assistant and the agent CLIs): a connection whose broker keeps
//      its prices on this computer has them taken out, with the reason in
//      their place, and so do the figures marked to them (a position's
//      unrealised P/L, the account's equity, open P/L and margin), which give
//      them back; the account's own record stays. A broker the page has no
//      row for is treated as withholding. Without terms, the very same object.
//   3. THE TICKET'S DOOR for an assistant is closed, with the sentence, on a
//      live connection whose broker has every order placed by hand.
//   4. NO SCREENSHOT is taken while such a broker's prices are on screen, by
//      the page or by the desktop shell, which asks the engine first.
//   5. NOTHING SCHEDULED: every call that moves money on a broker is made from
//      a click handler, and arming from the one consent function.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const shell = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');

function cut(text, name) {
  let start = text.indexOf('async function ' + name + '(');
  if (start < 0) start = text.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  const end = text.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return text.slice(start, end + 2);
}
const fn = (name) => cut(src, name);
function load(names, ctx = {}) {
  vm.createContext(ctx);
  for (const n of names) {
    vm.runInContext(n.startsWith('const ') ? src.match(new RegExp('^' + n + '[^\\n]*;', 'm'))[0] : fn(n), ctx);
  }
  return ctx;
}

// ── a stand-in for the page: elements that hold text, never markup ─────────
function makeDoc() {
  const mkText = (t) => ({ tagName: '#text', children: [], textContent: String(t) });
  const mk = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], className: '', dataset: {}, parent: null,
      _text: '', href: '', target: '', rel: '',
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set innerHTML(v) { throw new Error('markup was set: ' + v); },
      appendChild(ch) { ch.parent = this; this.children.push(ch); return ch; },
      append(...chs) { for (const ch of chs) this.appendChild(typeof ch === 'string' ? mkText(ch) : ch); },
      classList: null,
    };
    const s = new Set();
    el.classList = { add: (...n) => n.forEach((x) => s.add(x)), contains: (n) => s.has(n) || el.className.split(' ').includes(n),
                     remove: (...n) => n.forEach((x) => s.delete(x)) };
    return el;
  };
  return { createElement: mk, createTextNode: mkText };
}
const walk = (el, out = []) => { out.push(el); for (const c of el.children || []) walk(c, out); return out; };

const LICENCE = 'Fixture Markets licenses its prices to you alone, for use on this computer.';
const WITHHELD = "Withheld under Fixture Markets' terms: " + LICENCE;
const BY_HAND = "Not sent: under Fixture Markets' terms each order on a live account is placed by the user, in the terminal's own window.";
const ROWS = [
  { broker: 'local', connected: true,
    terms: { data_local_only: true, orders_by_hand_only: false, summary: LICENCE,
             url: 'https://fixture.example/legal/api-licence', said: LICENCE, withheld: WITHHELD } },
  { broker: 'live', connected: true,
    terms: { data_local_only: false, orders_by_hand_only: true, said: 'x', by_hand: BY_HAND } },
  { broker: 'demo', connected: true,      // paper: the engine sets no by_hand
    terms: { data_local_only: false, orders_by_hand_only: true, said: 'y' } },
  { broker: 'plain', connected: true, terms: { data_local_only: false, orders_by_hand_only: false } },
];

// ── 1. the row, and the question that arms a live connection ──────────────
{
  const doc = makeDoc();
  const c = load(['csTermsLine'], { document: doc, String, RegExp });
  for (const none of [null, undefined, 'x', {}, { data_local_only: false, orders_by_hand_only: false }]) {
    assert.equal(c.csTermsLine(none), null, 'a broker whose terms say nothing has no line');
  }
  const line = c.csTermsLine({ data_local_only: true, summary: '<b>yours</b> & "only"',
                               url: 'https://fixture.example/terms' });
  assert.equal(line.className, 'cs-terms');
  assert.equal(line.children[0].tagName, 'SPAN');
  assert.equal(line.children[0].textContent, '<b>yours</b> & "only"');   // as text
  const a = walk(line).find((e) => e.tagName === 'A');
  assert.equal(a.href, 'https://fixture.example/terms');
  assert.equal(a.textContent, 'Read the terms');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener');
  // the engine's sentence before the raw summary: it carries the full stop
  const both = c.csTermsLine({ data_local_only: true, summary: 'Prices are yours alone',
                               said: 'Prices are yours alone.' });
  assert.equal(both.children[0].textContent, 'Prices are yours alone.');
  // the engine's own sentence when the broker gave no summary
  const said = c.csTermsLine({ data_local_only: true, said: "Fixture's terms keep its prices on this computer." });
  assert.equal(said.children[0].textContent, "Fixture's terms keep its prices on this computer.");
  assert.ok(!walk(said).some((e) => e.tagName === 'A'), 'no address, no link');
  // a link only to https, and nothing that breaks out of an attribute
  for (const url of ['http://fixture.example/t', 'javascript:alert(1)', 'https://a b', 'https://x"onmouseover=1',
                     'mailto:legal@fixture.example', 'data:text/html,x']) {
    const l = c.csTermsLine({ summary: 'S', url });
    assert.ok(!walk(l).some((e) => e.tagName === 'A'), url);
  }
}
{
  // askConfirm: the line under the question when there are terms, nothing otherwise
  const doc = makeDoc();
  const made = [];
  const mkWrap = () => {
    const w = doc.createElement('div');
    Object.defineProperty(w, 'innerHTML', { set(v) {
      // our own template, the only markup here: a modal holding the title and the buttons
      const modal = doc.createElement('div'); modal.className = 'modal';
      const title = doc.createElement('div'); title.className = 'modal-title';
      const row = doc.createElement('div'); row.className = 'modal-row';
      const ok = doc.createElement('button'); ok.className = 'modal-ok';
      const no = doc.createElement('button'); no.className = 'modal-cancel';
      row.append(ok, no); modal.append(title, row); w.appendChild(modal);
      title.after = (n) => { const kids = modal.children; n.parent = modal; kids.splice(kids.indexOf(title) + 1, 0, n); };
    } });
    w.querySelector = (sel) => walk(w).find((e) => e.className === sel.slice(1));
    w.remove = () => {};
    made.push(w);
    return w;
  };
  let first = true;
  const page = { body: { appendChild() {} },
    createElement: (t) => { if (first && t === 'div') { first = false; return mkWrap(); } return doc.createElement(t); } };
  const c = load(['csTermsLine', 'askConfirm'], { document: page, String, RegExp, Promise });
  const asked = c.askConfirm('Fixture Markets reports a LIVE account. Allow trading?', 'Allow trading', 'Not now',
                             ROWS[0].terms);
  const modal = made[0].children[0];
  assert.deepEqual(modal.children.map((e) => e.className), ['modal-title', 'cs-terms', 'modal-row']);
  assert.ok(modal.children[1].classList.contains('modal-terms'));
  assert.equal(modal.children[1].children[0].textContent, LICENCE);
  assert.equal(walk(modal.children[1]).find((e) => e.tagName === 'A').href, 'https://fixture.example/legal/api-licence');
  walk(modal).find((e) => e.className === 'modal-ok').onclick();
  assert.equal(await asked, true);
  // every other question, and a broker without terms: as before
  first = true; made.length = 0;
  c.askConfirm('Delete x?');
  assert.deepEqual(made[0].children[0].children.map((e) => e.className), ['modal-title', 'modal-row']);
  first = true; made.length = 0;
  c.askConfirm('Plain reports a LIVE account.', 'Allow trading', 'Not now', ROWS[3].terms);
  assert.deepEqual(made[0].children[0].children.map((e) => e.className), ['modal-title', 'modal-row']);
}
{
  // the three arming questions pass the connection's terms, and the rows draw the line under the header
  assert.match(fn('pickBroker'), /askConfirm\(brokerLiveQuestion\(b\), "Allow trading", "Connect read-only", b\.terms\)/);
  assert.match(fn('pickBroker'), /"Allow trading", "Stay read-only", row\.terms\)/);
  assert.match(fn('csBrokerCard'), /"Allow trading", "Not now", hub\.terms\)/);
  assert.match(fn('csBrokerRow'), /wrap\.appendChild\(head\);\s*(\/\/[^\n]*\n\s*)*const terms = csTermsLine\(hub && hub\.terms\);\s*if \(terms\) wrap\.appendChild\(terms\);/);
  assert.match(fn('csExampleRow'), /wrap\.appendChild\(head\);\s*(\/\/[^\n]*\n\s*)*const terms = csTermsLine\(x\.terms\);\s*if \(terms\) wrap\.appendChild\(terms\);\s*if \(!open\) return wrap;/);
  // a hello that changes the terms repaints the screen
  assert.match(fn('csSignature'), /b\.terms \? \[b\.terms\.said \|\| b\.terms\.summary/);
  // the dropdown row's tooltip says them, and is unchanged without them
  const c = load(['brokerIdentity', 'brokerTooltip'], { String });
  const base = { broker: 'plain', identity: { display_name: 'Plain' }, registered: true };
  assert.equal(c.brokerTooltip({ ...base, terms: ROWS[3].terms }), c.brokerTooltip(base));
  assert.ok(c.brokerTooltip({ ...base, terms: ROWS[0].terms }).split('\n').includes(LICENCE));
}

{
  // A listed row's card names the credential its boxes ask for (the row's
  // key_name, else "API key"), in its first line and its link, and shows the
  // row's own keys_help (one row's says who may not use its broker's API) as text.
  const mkEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], className: '', dataset: {}, _text: '',
      href: '', target: '', rel: '', type: '', value: '', alt: '', src: '', disabled: false,
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set innerHTML(v) { throw new Error('markup was set: ' + v); },
      appendChild(ch) { this.children.push(ch); return ch; },
      append(...chs) { for (const ch of chs) this.appendChild(ch); },
      addEventListener() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    return el;
  };
  const ctx = { document: { createElement: mkEl }, connScreen: { errors: {}, broker: '' }, String, Array,
    Object, RegExp, csTermsLine: () => null, csDraft: () => '', csDraftSet() {}, csDraftDrop() {},
    renderConnScreen() {}, csNativeConnect() {} };
  load(['csSecretBox', 'csExampleKey', 'csExampleRow'], ctx);
  // the help and its link words, shared with the linked card (when the page has them)
  for (const n of ['csKeysHelp', 'csKeyLinkWords']) if (src.includes('function ' + n + '(')) load([n], ctx);
  const notes = (x) => walk(ctx.csExampleRow(x, true)).filter((e) => e.className === 'cs-note')
    .map((e) => e.textContent);
  const oanda = { key: 'oanda', name: 'OANDA', key_name: 'API token',
    form: [{ key: 'token', label: 'API token', type: 'password' }],
    keys_help: 'Copy the token: OANDA does not keep it. OANDA does not offer this API to residents of the EU.',
    keys_url: 'https://hub.oanda.com/tpa/personal_token' };
  const [what, help] = notes(oanda);
  assert.equal(what, 'Connect your own OANDA account with your own API token. It is kept on this computer '
    + 'and handed only to the OANDA connector running here.');
  assert.equal(help, oanda.keys_help + ' Get your API token at hub.oanda.com/tpa/personal_token');
  // a row that names nothing: "API key", as before
  const [what2, help2] = notes({ key: 'other', name: 'Other', form: [{ key: 'api_key', label: 'API key' }],
    keys_help: 'Make a key.', keys_url: 'https://other.example/keys/' });
  assert.match(what2, /^Connect your own Other account with your own API key\. /);
  assert.equal(help2, 'Make a key. Get your API key at other.example/keys');
  // a name of several words: its link names the credential, not its last word
  const [what3, help3] = notes({ key: 'ids', name: 'Ids', key_name: 'API key ID',
    form: [{ key: 'api_key', label: 'API key ID' }], keys_help: 'Make one.', keys_url: 'https://ids.example/' });
  assert.match(what3, /^Connect your own Ids account with your own API key ID\. /);
  assert.equal(help3, 'Make one. Get your API key ID at ids.example');
}

// ── 2. what the assistants are given ──────────────────────────────────────
const TERMS_FNS = ['isBrokerSource', 'brokerTermsOf', 'termsWithheld', 'termsByHand',
  'const AI_ACCOUNT_KEEP =', 'const AI_POSITION_KEEP =', 'aiWithholdAccount', 'aiWithholdChart', 'aiTradeDoor', 'aiCaptureWithheld'];
{
  const c = load(TERMS_FNS, { String, Object, Array });
  assert.equal(c.termsWithheld(ROWS, 'local'), WITHHELD);
  assert.equal(c.termsWithheld(ROWS, 'plain'), '');
  assert.equal(c.termsWithheld(ROWS, 'lse-hosted'), '');
  assert.equal(c.termsWithheld(ROWS, ''), '');
  assert.equal(c.termsWithheld(ROWS, 'nobody-knows'), 'Withheld: the terms of this connection are not known here yet.');
  assert.equal(c.termsWithheld([{ broker: 'old', terms: { data_local_only: true } }], 'old'),
               "Withheld under this broker's terms, which keep its prices on this computer.");

  const acct = { name: 'x', balance: 10000, equity: 10001, open_pnl: 1, used_margin: 22, leverage: 30,
    currency: 'USD', starting_balance: 10000, market_value: 1101,
    positions: [{ symbol: 'EURUSD', side: 'long', qty: 0.01, avg_price: 1.1, price: 1.2, bid: 1.2, ask: 1.21,
                  price_ts: '2026-11-14T15:00:00Z', price_synthetic: false, unrealized_pnl: 1, sl_price: 1.0,
                  tp_price: null, opened_at: '2026-11-14T14:00:00Z' }] };
  const before = JSON.stringify(acct);
  const out = c.aiWithholdAccount(acct, c.termsWithheld(ROWS, 'local'));
  const p = out.positions[0];
  assert.deepEqual([p.price, p.bid, p.ask, p.price_ts, p.price_synthetic], [null, null, null, null, null]);
  // marked to the price, so with qty and avg_price it gives the price back
  assert.equal(p.unrealized_pnl, null);
  assert.deepEqual([p.symbol, p.side, p.qty, p.avg_price, p.sl_price, p.tp_price, p.opened_at],
                   ['EURUSD', 'long', 0.01, 1.1, 1.0, null, '2026-11-14T14:00:00Z']);
  assert.deepEqual([out.equity, out.open_pnl, out.used_margin, out.market_value], [null, null, null, null]);
  assert.deepEqual([out.name, out.balance, out.leverage, out.currency, out.starting_balance],
                   ['x', 10000, 30, 'USD', 10000]);
  assert.equal(out.prices_withheld, WITHHELD);
  assert.equal(JSON.stringify(acct), before, 'the page\'s own account is not changed');
  // a stop the broker trails moves with the price; one the user set stays
  const trail = c.aiWithholdAccount({ positions: [
    { symbol: 'A', sl_price: 1.05, trail_points: 25 }, { symbol: 'B', sl_price: 1.0, trail_points: 0 }] }, WITHHELD);
  assert.deepEqual(trail.positions.map((p) => [p.sl_price, p.trail_points]), [[null, 25], [1.0, 0]]);
  // ...and the trailed one says so: a null sl_price alone reads as "no stop set"
  assert.equal(trail.positions[0].withheld,
               "The level of a stop the broker trails withheld under Fixture Markets' terms: " + LICENCE);
  assert.equal('withheld' in trail.positions[1], false);
  const unknown = c.aiWithholdAccount({ positions: [{ symbol: 'A', sl_price: 1.05, trail_points: 25 }] },
                                      c.termsWithheld(ROWS, 'nobody-knows'));
  assert.equal(unknown.positions[0].withheld,
               'The level of a stop the broker trails withheld: the terms of this connection are not known here yet.');
  // a failed snapshot stays one: its error and note, and no invented book
  const failed = c.aiWithholdAccount({ error: 'TypeError: x', note: 'call get_positions' }, WITHHELD);
  assert.deepEqual([failed.error, failed.note, 'positions' in failed, failed.prices_withheld],
                   ['TypeError: x', 'call get_positions', false, WITHHELD]);
  // without terms: the very same object, nothing added
  assert.equal(c.aiWithholdAccount(acct, c.termsWithheld(ROWS, 'plain')), acct);
  assert.equal(c.aiWithholdAccount(null, WITHHELD), null);

  const chart = { symbol: 'EURUSD', timeframe: '1h', last_close: 1.2, bid: 1.2, ask: 1.21, bars_loaded: 5 };
  const ch = c.aiWithholdChart(chart, WITHHELD);
  assert.deepEqual([ch.last_close, ch.bid, ch.ask, ch.symbol, ch.bars_loaded], [null, null, null, 'EURUSD', 5]);
  assert.equal(ch.prices_withheld, WITHHELD);
  assert.equal(c.aiWithholdChart(chart, ''), chart);

  // ── 3. the ticket's door ──
  const more = ['any other broker: POST /api/broker/order'];
  assert.deepEqual([...c.aiTradeDoor(ROWS, 'live', more)], [BY_HAND]);   // (a copy: vm arrays are another realm's)
  assert.equal(c.aiTradeDoor(ROWS, 'demo', more), more, 'paper: as before');
  assert.equal(c.aiTradeDoor(ROWS, 'plain', more), more);
  assert.equal(c.aiTradeDoor(ROWS, 'lse-hosted', more), more);

  // ── 4. the page's own screenshot ──
  assert.equal(c.aiCaptureWithheld(ROWS, 'broker:local', 'lse-hosted'), WITHHELD);
  assert.equal(c.aiCaptureWithheld(ROWS, 'lse', 'local'), WITHHELD);
  assert.equal(c.aiCaptureWithheld(ROWS, 'lse', 'lse-hosted'), '');
  assert.equal(c.aiCaptureWithheld(ROWS, 'broker:plain', 'plain'), '');
  assert.equal(c.aiCaptureWithheld(ROWS, 'userdata', 'live'), '');
}
{
  // ...and where the page uses them: the map's chart, its account dock (through
  // aiAccountBuild), its ticket door, the capture before a chat turn, and a
  // fresh read of the rows before either assistant's context is built
  const chartRegion = src.slice(src.indexOf('{ id: "chart-wrap"'), src.indexOf('{ id: "acct-dock"'));
  assert.match(chartRegion, /termsWithheld\(brokerPicker\.rows, String\(state\.provider\)\.slice\("broker:"\.length\)\)/);
  assert.match(chartRegion, /return aiWithholdChart\(\{/);
  const acctBuild = src.slice(src.indexOf('const aiAccountBuild = () => {'), src.indexOf('/* ── the screen map'));
  assert.match(acctBuild, /return aiWithholdAccount\(\{[\s\S]*\}, termsWithheld\(brokerPicker\.rows, dockBroker\)\);/);
  assert.match(acctBuild, /trail_points: p\.trail_points \|\| 0,/);
  const ticket = src.slice(src.indexOf('{ id: "trade-panel"'), src.indexOf('{ id: "pyide"'));
  assert.match(ticket, /moreNow: \(more\) => aiTradeDoor\(brokerPicker\.rows,/);
  const build = src.slice(src.indexOf('const aiTerminalBuild = () => {'), src.indexOf('const workspaceBody = () =>'));
  assert.match(build, /more = spec\.moreNow\(spec\.more\)/);
  const turn = src.slice(src.indexOf('s.busy = true; // optimistic'), src.indexOf('const fire = () => {'));
  assert.ok(turn.indexOf('await brokerRowsFresh()') < turn.indexOf('pushWorkspace()'));
  assert.match(turn, /const shotWithheld = aiCaptureWithheld\(brokerPicker\.rows, state\.provider,/);
  assert.match(turn, /if \(!shotWithheld && window\.lseShell && window\.lseShell\.capture\)/);
  const hosted = src.slice(src.indexOf('async function lseSend('), src.indexOf('messages: [{ role: "system", content: aiContext() }]'));
  assert.match(hosted, /await brokerRowsFresh\(\);\s*const r = await fetch\("\/api\/assistant"/);
}
{
  // A stop the broker trails, from the broker's row to what the assistants
  // read: tpbRefreshPositions carries trail_points into the dock's positions,
  // aiAccountBuild's mapping carries it into the account, and aiWithholdAccount
  // then holds the stop's level back. Without either line the trailed level
  // would reach the hosted assistant and context.json.
  const c = { tpb: { broker: 'local', generation: 0, quotes: {} }, tpx: { positions: [], dockTab: 'pos' },
    String, Object, Array, JSON, Math, Date,
    async fetch() { return { ok: true, json: async () => [
      { position_id: 'p1', symbol: 'GBPUSD', side: 'buy', qty: 0.01, avg_price: 1.3,
        sl: 1.3175, trail_points: 25, unrealized_pnl: 2.0, opened_at: 1794680000000 },
      { position_id: 'p2', symbol: 'EURUSD', side: 'buy', qty: 0.01, avg_price: 1.1,
        sl: 1.05, unrealized_pnl: 1.0, opened_at: 1794680000000 }] }; },
    tpbSubscribe() {}, acdPushChartLines() {}, acdRenderPositions() {}, acdRenderHistory() {},
    dockQuote() { return { bid: 1.32, ask: 1.3201, ts: 1794680000000 }; } };
  load(['const AI_ACCOUNT_KEEP', 'const AI_POSITION_KEEP', 'aiWithholdAccount', 'tpbRefreshPositions'], c);
  await c.tpbRefreshPositions();
  assert.deepEqual(c.tpx.positions.map((p) => [p.sl_price, p.trail_points]), [[1.3175, 25], [1.05, 0]]);
  const from = src.indexOf('const poss = (tpx.positions || []).map((p) => {');
  const to = src.indexOf('    });\n', from);
  assert.ok(from > 0 && to > from, "aiAccountBuild's position mapping");
  const poss = vm.runInContext('(' + src.slice(from + 'const poss = '.length, to + '    })'.length) + ')', c);
  const sent = c.aiWithholdAccount({ name: 'x', balance: 10000, positions: poss }, WITHHELD);
  assert.deepEqual(sent.positions.map((p) => [p.sl_price, p.trail_points]), [[null, 25], [1.05, 0]]);
  assert.ok(sent.positions[0].withheld.startsWith('The level of a stop the broker trails withheld'));
}
{
  // brokerRowsFresh: the engine's rows of now, and the rows held when it does not answer
  const ctx = { state: { hosted: false }, brokerPicker: { rows: ['old'] }, Promise, Array, setTimeout,
                fetch: async () => ({ ok: true, json: async () => [{ broker: 'new' }] }) };
  load(['brokerRowsFresh'], ctx);
  await ctx.brokerRowsFresh();
  assert.deepEqual(ctx.brokerPicker.rows, [{ broker: 'new' }]);
  ctx.fetch = async () => { throw new Error('engine away'); };
  await ctx.brokerRowsFresh();
  assert.deepEqual(ctx.brokerPicker.rows, [{ broker: 'new' }]);
}

// ── 4. the desktop shell asks the engine before every snapshot ─────────────
{
  const run = async (answer) => {
    const removed = [];
    let captured = 0;
    const http = { get(opts, cb) {
      const req = { on(ev, f) { this['_' + ev] = f; return this; }, destroy() {} };
      setImmediate(() => {
        if (answer === 'down') return req._error(new Error('ECONNREFUSED'));
        const res = { statusCode: answer.status, setEncoding() {}, on(ev, f) { this['_' + ev] = f; } };
        cb(res);
        if (answer.body !== undefined) res._data(JSON.stringify(answer.body));
        res._end();
      });
      assert.equal(opts.path, '/api/ai/capture-allowed');
      assert.equal(opts.host, '127.0.0.1');
      return req;
    } };
    const ctx = { http, currentPort: 7799, Promise, JSON, setImmediate, String,
      AI_WS: '/ai', path: { join: (...p) => p.join('/') },
      fs: { rmSync: (p) => removed.push(p), mkdirSync() {}, writeFileSync() {}, renameSync() {} },
      win: { webContents: { capturePage: async () => { captured += 1; return { toPNG: () => 'png' }; } } } };
    vm.createContext(ctx);
    vm.runInContext(cut(shell, 'captureAllowed'), ctx);
    vm.runInContext(cut(shell, 'captureToWorkspace'), ctx);
    const out = JSON.parse(JSON.stringify(await ctx.captureToWorkspace()));
    return { out, removed, captured };
  };
  let r = await run({ status: 200, body: { allowed: false, reason: 'Screenshot withheld under X\'s terms: Y.' } });
  assert.deepEqual(r.out, { ok: false, withheld: true, error: "Screenshot withheld under X's terms: Y." });
  assert.equal(r.captured, 0);
  assert.deepEqual(r.removed, ['/ai/chart.png']);
  r = await run({ status: 200, body: { allowed: true } });
  assert.deepEqual([r.out.ok, r.captured, r.removed.length], [true, 1, 0]);
  r = await run({ status: 404, body: { detail: 'Not Found' } });       // an engine from before the rule
  assert.deepEqual([r.out.ok, r.captured], [true, 1]);
  r = await run('down');                                               // no answer: no snapshot this time
  assert.deepEqual([r.out.ok, r.captured], [false, 0]);
  r = await run({ status: 500, body: {} });
  assert.deepEqual([r.out.ok, r.captured], [false, 0]);
}

// ── 5. nothing on the page sends a broker order by itself ──────────────────
{
  const moving = ['/api/broker/order', '/api/broker/order/pending', '/api/broker/order/cancel',
                  '/api/broker/close', '/api/broker/modify'];
  const allowed = new Set(['tpbOrder', 'acdClosePart', 'acdCloseFull', 'acdModifyFromChart',
                           'acdCancelOrder', 'tpxPlacePending', 'acdSend', 'acdCloseSend']);
  const fnAt = (index) => {
    const head = src.lastIndexOf('\nasync function ', index);
    const head2 = src.lastIndexOf('\nfunction ', index);
    const at = Math.max(head, head2);
    return src.slice(at + 1, src.indexOf('(', at)).replace(/^async /, '').replace(/^function /, '');
  };
  const owners = (route) => {
    const out = [];
    // a route is sent from a fetch of its literal, or handed to the dock's sender
    const re = new RegExp('(fetch\\(\\s*|acdSend\\("[a-z]+", )"' + route.replace(/\//g, '\\/') + '"', 'g');
    let m;
    while ((m = re.exec(src))) out.push(fnAt(m.index));
    return out;
  };
  for (const route of moving) {
    for (const who of owners(route)) assert.ok(allowed.has(who), `${route} is sent from ${who}`);
  }
  // the dock's sender fetches only the url it is handed, and only the dock's
  // close and cancel hand it one
  assert.match(fn('acdSend'), /r = await fetch\(url, /);
  const senders = [...src.matchAll(/await acdSend\(/g)].map((m) => fnAt(m.index));
  assert.deepEqual([...new Set(senders)].sort(), ['acdCancelOrder', 'acdCloseSend']);
  // ...the close's own sender only from the dock's two closes
  const closers = [...src.matchAll(/await acdCloseSend\(/g)].map((m) => fnAt(m.index));
  assert.deepEqual([...new Set(closers)].sort(), ['acdCloseFull', 'acdClosePart']);
  assert.deepEqual(owners('/api/broker/arm'), ['brokerArm']);
  // and each of those is reached from a click, the chart's own menu or its drag handle
  assert.match(src, /\$\("tpx-buy"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxOrder\("buy"\); \};/);
  // asking again is a click too: the ticket's "Ask again" button, never a timer
  assert.match(src, /\$\("tpx-again"\)\.onclick = \(ev\) => \{ if \(tpxOnePress\(ev\)\) tpxAskAgain\(\); \};/);
  assert.equal([...src.matchAll(/(?<!function )tpxAskAgain\(\)/g)].length, 1,
               'asked again from the button alone');
  // the chart menu's form hands its own size on (tests/test_chart_menu_units.mjs)
  assert.match(src, /quickOrder: \(side, otype, price, units\) => tpxQuickOrder\(side, otype, price, units\),/);
  assert.match(src, /onPositionModify: canModify \? acdModifyFromChart : undefined,/);
}

console.log('test_broker_terms.mjs: ok');
