// "Add your own broker", the page's half. Same method as the other .mjs tests
// here: cut the function under test out of app.js by name and run it in
// node:vm against hand-made stubs, so what is tested is the shipped text.
//
// What is pinned, and why it matters:
//   1. text from a data source never becomes markup (a broker's catalog is
//      third-party text, and now anyone can write the adapter that sends it);
//   2. real money: Connect asks, arms only on a yes and only after a
//      successful connect, and a "no" leaves the broker connected read-only;
//   3. a blank key box is never sent, so it can never delete a stored key;
//   4. the form's own checks, the ID a name is saved under, the argument
//      split, and the sentence a too-big catalog shows.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');

function fn(name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'app.js has no function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return src.slice(start, end + 2);
}
function load(names, ctx = {}) {
  vm.createContext(ctx);
  for (const n of names) vm.runInContext(fn(n), ctx);
  return ctx;
}
// Every element a piece of markup would create, as [tag, attribute names].
// A tolerant reader on purpose: it sees a tag wherever a browser would.
function tags(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*>/g)) {
    out.push([m[1].toLowerCase(),
      [...m[2].matchAll(/\s+([^\s=>]+)(?:="[^"]*")?/g)].map((a) => a[1].toLowerCase()).sort()]);
  }
  return out;
}

// ── 1. catalog text is text ───────────────────────────────────────────────
const HOSTILE = 'Markup <i>probe</i> & "quoted" name';
{
  const c = load(['escHtml', 'wlRowHtml']);
  assert.equal(c.escHtml(HOSTILE),
    'Markup &lt;i&gt;probe&lt;/i&gt; &amp; &quot;quoted&quot; name');
  assert.equal(c.escHtml(null), '');
  assert.equal(c.escHtml(12.5), '12.5');
  assert.equal(c.escHtml("it's"), 'it&#39;s');

  const plain = { initial: 'M', price: '10.50', spread: '0.02' };
  const html = c.wlRowHtml({ symbol: 'HOSTILE', name: HOSTILE }, plain);
  // exactly the row's own elements: no <i>, nothing the name brought with it
  assert.deepEqual(tags(html).map((t) => t[0]),
    ['span', 'span', 'span', 'span', 'span', 'span', 'span', 'button']);
  // the one element that carries the name in an attribute has only that
  // attribute and its class: the quotes in the name did not open new ones
  // (this is the exact defect: title="Markup <i>probe</i> & " quoted" name")
  const wsym = tags(html).find((t) => t[1].includes('title') && t[0] === 'span' && t[1].length === 2);
  assert.deepEqual(wsym, ['span', ['class', 'title']]);
  assert.ok(html.includes('title="Markup &lt;i&gt;probe&lt;/i&gt; &amp; &quot;quoted&quot; name"'));
  assert.ok(html.includes('<span class="wname">Markup &lt;i&gt;probe&lt;/i&gt; &amp; &quot;quoted&quot; name</span>'));
  assert.ok(!html.includes('<i>'));

  // a symbol is third-party text too
  const sym = c.wlRowHtml({ symbol: 'A"><img src=x onerror=alert(1)>', name: '' }, plain);
  assert.ok(!tags(sym).some((t) => t[0] === 'img'));
  assert.ok(sym.includes('A&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));

  // and so is the address of a logo: it stays ONE attribute value
  const logo = c.wlRowHtml({ symbol: 'X', name: 'X' },
    { ...plain, logo: 'https://l.example/x.png" onerror="alert(1)' });
  const img = tags(logo).find((t) => t[0] === 'img');
  assert.deepEqual(img[1], ['alt', 'loading', 'onerror', 'src']);
  assert.ok(logo.includes('src="https://l.example/x.png&quot; onerror=&quot;alert(1)"'));
  // price and spread cells are escaped as well, whatever a feed puts there
  const cell = c.wlRowHtml({ symbol: 'X', name: 'X' }, { ...plain, price: '<b>1</b>', spread: '"' });
  assert.ok(cell.includes('&lt;b&gt;1&lt;/b&gt;') && !cell.includes('<b>'));

  // an ordinary row still reads as it always did
  const ok = c.wlRowHtml({ symbol: 'EUR/USD', name: 'Euro / US Dollar' },
    { initial: 'E', price: '1.0850', spread: '0.8', fav: true, stale: true });
  assert.ok(ok.includes('<span class="wsym" title="Euro / US Dollar">EUR/USD<span class="wname">Euro / US Dollar</span></span>'));
  assert.ok(ok.includes('<span class="wprice stale">1.0850</span><span class="wspread">0.8</span>'));
  assert.ok(ok.includes('class="wstar on" title="Remove from watchlist"'));
  assert.ok(c.wlRowHtml({ symbol: 'OLD', name: '' }, { ...plain, hist: true }).includes('class="whist"'));
}

// the folder head, the dock tables: the templates themselves must go through
// the escape (a row builder cannot be cut out of its function, so the source
// text is what is checked)
for (const piece of ['`${escHtml(g.cat)}<span class="wcount">', '`<td>${escHtml(p.symbol)}</td>`',
  '<td>${escHtml(f.symbol)}</td>', '`<td>${escHtml(o.symbol)}</td>`', '`<td>${escHtml(o.otype)}</td>`']) {
  assert.ok(src.includes(piece), 'expected an escaped template: ' + piece);
}
for (const raw of ['<td>${p.symbol}</td>', '<td>${f.symbol}</td>', '<td>${o.symbol}</td>',
  '${ins.name}</span>', 'value="${i.symbol}">${i.name}', '`${g.cat}<span']) {
  assert.ok(!src.includes(raw), 'an unescaped template is back: ' + raw);
}

// ── the search list: escaped, exact symbol first; the total for the sidebar
{
  const start = src.indexOf('async function loadInstruments('), end = src.indexOf('\n}\n', start) + 2;
  const mk = (rows, total) => {
    const options = { innerHTML: '' };
    const c = { state: { provider: 'broker:mine', lseConfigured: false }, encodeURIComponent, setTimeout,
      fetch: async () => ({ ok: true, json: async () => rows,
        headers: total === undefined ? undefined : { get: (h) => (h === 'X-Total-Count' ? total : null) } }),
      $: () => options, renderWatchlist: () => {}, chartPushDigits: () => {},
      status: () => { throw Error('unexpected failure'); }, options };
    vm.createContext(c); vm.runInContext(src.slice(start, end), c);
    return c;
  };
  const rows = [{ symbol: 'AAAF', name: 'Triple A' }, { symbol: 'FA', name: 'First Aid' },
    { symbol: 'XFX', name: 'Cross' }, { symbol: 'F', name: HOSTILE }, { symbol: 'ZED', name: 'Zeta Fund' }];
  let c = mk(rows);
  await c.loadInstruments('f');
  const opts = tags(c.options.innerHTML);
  assert.deepEqual(opts.map((t) => t[0]), ['option', 'option', 'option', 'option', 'option']);
  assert.ok(opts.every((t) => t[1].length === 1 && t[1][0] === 'value'));
  // exact, then starts-with, then contains, then the rest in arrival order
  assert.deepEqual([...c.options.innerHTML.matchAll(/value="([^"]*)"/g)].map((m) => m[1]),
    ['F', 'FA', 'AAAF', 'XFX', 'ZED']);
  assert.ok(c.options.innerHTML.includes('<option value="F">Markup &lt;i&gt;probe&lt;/i&gt; &amp; &quot;quoted&quot; name</option>'));
  c = mk([{ symbol: 'A"><script>1</script>', name: null }]);
  await c.loadInstruments('a');
  assert.deepEqual(tags(c.options.innerHTML), [['option', ['value']]]);

  // the sidebar load keeps the source's own count, when it sent one
  c = mk(rows, '13575'); await c.loadInstruments();
  assert.equal(c.state.instrumentsTotal, 13575);
  assert.equal(c.state.instruments.length, 5);
  c = mk(rows, null); await c.loadInstruments(); assert.equal(c.state.instrumentsTotal, 0);
  c = mk(rows); await c.loadInstruments(); assert.equal(c.state.instrumentsTotal, 0);   // no headers at all
  c = mk(rows, 'junk'); await c.loadInstruments(); assert.equal(c.state.instrumentsTotal, 0);
}
{
  const c = load(['wlCutNote']);
  assert.equal(c.wlCutNote(5000, 13575, 5000), 'showing 5,000 of 13,575; search for the rest');
  assert.equal(c.wlCutNote(5000, 0, 5000), 'showing the first 5,000; search for the rest');
  assert.equal(c.wlCutNote(5000, 5000, 5000), '');     // the whole catalog, exactly a page
  assert.equal(c.wlCutNote(120, 120, 5000), '');
  assert.equal(c.wlCutNote(120, 0, 5000), '');
  assert.equal(c.wlCutNote(15037, 0, 0), '');          // LSE: never cut, no bound to hit
}

// ── 2. real money: ask, connect, arm only on a yes ────────────────────────
function picker({ answer = true, connectOk = true, after = {}, armOk = true, probe = null, screen = false } = {}) {
  const c = { asked: [], calls: [], switched: [], events: [], tpb: { broker: 'lse-hosted' },
    brokerPicker: { rows: [] }, document: { createElement: () => ({}) },
    // the Connections screen, open (`screen`) or not, and its repaint
    $: (id) => (id === 'conn-screen' && screen ? { classList: { contains: (k) => k !== 'hidden' } } : null),
    renderConnScreen(force) {
      const row = c.brokerPicker.rows.find((r) => r.broker === 'mine') || {};
      c.events.push(['paint', !!force, !!row.connected]);
    },
    closeConnMenu() {}, renderConnBar() {}, Array, String, JSON,
    async askConfirm(text, ok, cancel) { c.events.push(['ask', cancel]); c.asked.push({ text, ok, cancel }); return answer; },
    async fetch(url, o) {
      c.calls.push(url);
      if (url === '/api/broker/probe') return { ok: !!probe, json: async () => probe };
      if (url === '/api/broker/arm') {
        assert.deepEqual(JSON.parse(o.body), { broker: 'mine', armed: true });
        return { ok: armOk, json: async () => ({ armed: armOk }) };
      }
      throw Error('unexpected request ' + url);
    },
    async tpbSwitch(broker) {
      c.switched.push(broker);
      c.events.push(['switch']);
      if (!connectOk) return { ok: false, error: 'unauthorized: the API key was rejected by the broker' };
      c.tpb.broker = broker;
      c.brokerPicker.rows = [{ broker, connected: true, armed: false, mode: 'live', ...after }];
      return after.needs_account ? { ok: true, needsAccount: true } : { ok: true };
    } };
  return load(['brokerIdentity', 'brokerDisplayName', 'brokerIsPaper', 'brokerLiveQuestion',
    'brokerArm', 'pickBroker'], c);
}
const live = { broker: 'mine', label: 'mine', identity: { display_name: 'My Live Broker', mode: 'live' } };
const paper = { broker: 'mine', label: 'mine', identity: { display_name: 'My Paper Broker', mode: 'paper' } };
{
  // paper never asks and is never armed
  let c = picker({ after: { mode: 'paper' } });
  let out = await c.pickBroker(paper);
  assert.equal(c.asked.length, 0);
  assert.deepEqual(c.calls, []);
  assert.deepEqual({ ...out }, { ok: true, connected: true, armed: false, needsAccount: false, readOnly: false });

  // live, and the user says yes: asked once in the screen's own sentence,
  // connected, THEN armed
  c = picker({ answer: true });
  out = await c.pickBroker(live);
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0].text,
    'My Live Broker reports a LIVE account. Orders sent here may be real. Connect and allow trading?');
  assert.deepEqual([c.asked[0].ok, c.asked[0].cancel], ['Allow trading', 'Connect read-only']);
  assert.deepEqual(c.switched, ['mine']);
  assert.deepEqual(c.calls, ['/api/broker/arm']);
  assert.equal(out.armed, true); assert.equal(out.readOnly, false);

  // live, and the user says no: still connected, read-only, NOTHING armed
  c = picker({ answer: false });
  out = await c.pickBroker(live);
  assert.equal(c.asked.length, 1);
  assert.deepEqual(c.switched, ['mine']);
  assert.deepEqual(c.calls, []);
  assert.deepEqual({ ...out }, { ok: true, connected: true, armed: false, needsAccount: false, readOnly: true });

  // yes, but the connect failed: nothing is armed and the reason comes back
  c = picker({ answer: true, connectOk: false });
  out = await c.pickBroker(live);
  assert.deepEqual(c.calls, []);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'unauthorized: the API key was rejected by the broker');

  // yes, but the engine did not arm it: reported as read-only, not as armed
  c = picker({ answer: true, armOk: false });
  out = await c.pickBroker(live);
  assert.equal(out.armed, false); assert.equal(out.readOnly, true);

  // a mode nobody has asked about is asked about (one cold handshake), and
  // what comes back decides: live is confirmed, paper is not
  c = picker({ answer: false, probe: live });
  out = await c.pickBroker({ broker: 'mine', label: 'mine', identity: {} });
  assert.deepEqual(c.calls, ['/api/broker/probe']);
  assert.equal(c.asked.length, 1); assert.equal(out.readOnly, true);
  c = picker({ probe: paper, after: { mode: 'paper' } });
  await c.pickBroker({ broker: 'mine', label: 'mine', identity: {} });
  assert.equal(c.asked.length, 0);
  // unprobeable stays unknown, and unknown is NOT paper: asked, as "mode"
  c = picker({ answer: false, probe: null, after: { mode: undefined } });
  out = await c.pickBroker({ broker: 'mine', label: 'mine', identity: {} });
  assert.equal(c.asked.length, 1);
  assert.match(c.asked[0].text, /reports mode "unknown"\. Orders sent here may be real\./);
  assert.equal(out.readOnly, true);

  // A login that reaches several accounts with none bound is NOT asked at
  // connect (its mode belongs to the account about to be chosen) and is
  // never armed by connecting.
  for (const row of [{ ...live, accounts: [{ id: 'a' }, { id: 'b' }] }, { ...live, needs_account: true }]) {
    c = picker({ answer: true, after: { connected: false, needs_account: true } });
    out = await c.pickBroker(row);
    assert.equal(c.asked.length, 0); assert.deepEqual(c.calls, []);
    assert.equal(out.needsAccount, true); assert.equal(out.connected, false);
  }
  // ...but ONLY then. A single-account live broker with nothing stored is
  // asked (the defect: it never was, and so could never be armed).
  c = picker({ answer: true });
  await c.pickBroker({ ...live, accounts: [{ id: 'only' }] });
  assert.equal(c.asked.length, 1); assert.deepEqual(c.calls, ['/api/broker/arm']);
  // A login whose own hello said it reaches several accounts, never yet
  // connected and with none bound, is not asked at Connect either: its answer
  // could not be honoured, and it used to be dropped once the chooser came
  // up (the card then asked again). Nothing is armed by connecting.
  c = picker({ answer: true, after: { connected: false, needs_account: true } });
  out = await c.pickBroker({ ...live, accounts_multi: true });
  assert.equal(c.asked.length, 0); assert.deepEqual(c.calls, []);
  assert.equal(out.needsAccount, true); assert.equal(out.connected, false);
  // ...and when its login turned out to reach one account, bound by the
  // engine, the question is asked once, after the connect, about the live
  // account now in use; a yes arms it then, a no leaves it read-only.
  c = picker({ answer: true });
  out = await c.pickBroker({ ...live, accounts_multi: true });
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0].text, 'mine reports a LIVE account. Orders sent here may be real. Allow trading?');
  assert.deepEqual([c.asked[0].ok, c.asked[0].cancel], ['Allow trading', 'Stay read-only']);
  assert.deepEqual(c.switched, ['mine']); assert.deepEqual(c.calls, ['/api/broker/arm']);
  assert.equal(out.armed, true);
  c = picker({ answer: false });
  out = await c.pickBroker({ ...live, accounts_multi: true });
  assert.equal(c.asked.length, 1); assert.deepEqual(c.calls, []); assert.equal(out.readOnly, true);
  // a bound account is a known one: asked at Connect, as before
  c = picker({ answer: true });
  await c.pickBroker({ ...live, accounts_multi: true, account_id: 'fx-2' });
  assert.equal(c.asked.length, 1); assert.match(c.asked[0].text, /Connect and allow trading\?$/);
  // A live login never bound whose row does not know whether it reaches
  // several accounts (null: remembered by an earlier build) is asked first,
  // with one cold handshake, so Connect asks nothing it cannot honour.
  c = picker({ answer: true, probe: { ...live, accounts_multi: true },
               after: { connected: false, needs_account: true } });
  out = await c.pickBroker({ ...live, accounts_multi: null });
  assert.deepEqual(c.calls, ['/api/broker/probe']);
  assert.equal(c.asked.length, 0); assert.equal(out.needsAccount, true);
  // ...one that turns out to reach one account is asked at Connect, as before
  c = picker({ answer: true, probe: { ...live } });
  await c.pickBroker({ ...live, accounts_multi: null });
  assert.deepEqual(c.calls, ['/api/broker/probe', '/api/broker/arm']);
  assert.equal(c.asked.length, 1); assert.match(c.asked[0].text, /Connect and allow trading\?$/);
  // ...and one that cannot be asked takes the careful path: asked at Connect
  c = picker({ answer: false, probe: null });
  await c.pickBroker({ ...live, accounts_multi: null });
  assert.deepEqual(c.calls, ['/api/broker/probe']); assert.equal(c.asked.length, 1);
  // nothing is probed when it is known, bound, connected, or paper
  for (const row of [{ ...live }, { ...live, accounts_multi: true }, { ...live, accounts_multi: null, account_id: 'a' },
                     { ...live, accounts_multi: null, connected: true }]) {
    c = picker({ answer: false, after: { connected: false, needs_account: true } });
    await c.pickBroker(row);
    assert.ok(!c.calls.includes('/api/broker/probe'), JSON.stringify(row));
  }
  c = picker({ after: { mode: 'paper' } });
  await c.pickBroker({ ...paper, accounts_multi: null });
  assert.deepEqual(c.calls, []); assert.equal(c.asked.length, 0);
  // While the question after the connect is up, the Connections screen behind
  // it says what is so: repainted from the engine's row, connected, live and
  // read-only, before the question is asked. It said "Not connected" with a
  // "Connecting…" button until the answer came.
  c = picker({ answer: false, screen: true });
  await c.pickBroker({ ...live, accounts_multi: true });
  assert.deepEqual(c.events, [['switch'], ['paint', true, true], ['ask', 'Stay read-only']]);
  c = picker({ answer: false, after: { mode: 'live' }, screen: true });
  await c.pickBroker(paper);                          // remembered as paper, connected live
  assert.deepEqual(c.events, [['switch'], ['paint', true, true], ['ask', 'Stay read-only']]);
  c = picker({ answer: false });                      // the screen is not open: nothing to repaint
  await c.pickBroker({ ...live, accounts_multi: true });
  assert.deepEqual(c.events.map((e) => e[0]), ['switch', 'ask']);
  c = picker({ answer: false, screen: true });        // asked before connecting: as before
  await c.pickBroker(live);
  assert.deepEqual(c.events.map((e) => e[0]), ['ask', 'switch']);

  // "yes" to a broker remembered as live that turns out paper arms nothing
  c = picker({ answer: true, after: { mode: 'paper' } });
  out = await c.pickBroker(live);
  assert.deepEqual(c.calls, []); assert.equal(out.readOnly, false);
  // remembered as paper, connects as live (its file was set to "live" since
  // the last connect, as the walkthrough's step 3 says for real money): it was
  // not asked before connecting, so it is asked as soon as it is connected,
  // read-only until then. A "no" stays read-only and arms nothing...
  c = picker({ answer: false, after: { mode: 'live' } });
  out = await c.pickBroker(paper);
  assert.equal(c.asked.length, 1);
  assert.equal(c.asked[0].text, 'mine reports a LIVE account. Orders sent here may be real. Allow trading?');
  assert.deepEqual([c.asked[0].ok, c.asked[0].cancel], ['Allow trading', 'Stay read-only']);
  assert.deepEqual(c.switched, ['mine']);                 // asked AFTER the connect
  assert.deepEqual(c.calls, []); assert.equal(out.readOnly, true); assert.equal(out.armed, false);
  // ...and a "yes" arms it, once, after the connect
  c = picker({ answer: true, after: { mode: 'live' } });
  out = await c.pickBroker(paper);
  assert.equal(c.asked.length, 1); assert.deepEqual(c.calls, ['/api/broker/arm']);
  assert.equal(out.armed, true); assert.equal(out.readOnly, false);
  // a live broker that was asked before connecting is not asked twice
  c = picker({ answer: true });
  await c.pickBroker(live);
  assert.equal(c.asked.length, 1);
  // a failed connect of a broker remembered as paper asks nothing
  c = picker({ connectOk: false });
  out = await c.pickBroker(paper);
  assert.equal(c.asked.length, 0); assert.equal(out.ok, false);
}
{
  const c = load(['tpbPlainReason', 'tpbNotArmedText']);
  // exactly what the engine answers a 403 with: the code word, the SDK's
  // sentence, and its hint for a programmer
  assert.equal(c.tpbNotArmedText("not_armed: order.place refused: this broker reports mode 'live' and has not been armed. Call arm(reason) first."),
    "order.place refused: this broker reports mode 'live' and has not been armed. Allow trading for it in Connections.");
  assert.equal(c.tpbNotArmedText("order.place refused: this broker reports mode 'live' and has not been armed. Call arm(reason) first."),
    "order.place refused: this broker reports mode 'live' and has not been armed. Allow trading for it in Connections.");
  assert.match(c.tpbNotArmedText(''), /has not been armed for trading\. Allow trading for it in Connections\.$/);
  const row = { broker: 'mine', connected: true, armed: false, identity: { display_name: 'My Live Broker', mode: 'live' } };
  const b = load(['brokerIdentity', 'brokerDisplayName', 'activeBrokerLabel'],
    { tpb: { broker: 'mine' }, brokerPicker: { rows: [row] }, String });
  assert.equal(b.activeBrokerLabel(), 'My Live Broker (LIVE, read-only)');
  row.armed = true; assert.equal(b.activeBrokerLabel(), 'My Live Broker (LIVE)');
  row.identity.mode = 'paper'; assert.equal(b.activeBrokerLabel(), 'My Live Broker');
}

// ── 3. a blank box is never sent ──────────────────────────────────────────
function connector() {
  const c = { posts: [], picked: [], Object, JSON,
    async fetch(url, o) { c.posts.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({}) }; },
    async pickBroker(hub) { c.picked.push(hub.broker); return { ok: true }; } };
  return load(['csConnect'], c);
}
const box = (v) => ({ value: v });
{
  // an engine that reports stored field names: only what was typed, merged
  let c = connector();
  await c.csConnect('mine', { broker: 'mine' }, { api_key_id: box(''), api_secret: box('  new-secret ') }, new Set(['api_key_id', 'api_secret']));
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts)), [{ url: '/api/broker/credentials',
    body: { broker: 'mine', values: { api_secret: 'new-secret' }, merge: true } }]);
  assert.deepEqual(c.picked, ['mine']);
  // every box left empty: NOTHING is posted, the stored keys are untouched
  c = connector();
  await c.csConnect('mine', { broker: 'mine' }, { api_key_id: box(''), api_secret: box('   ') }, new Set(['api_key_id']));
  assert.deepEqual(c.posts, []); assert.deepEqual(c.picked, ['mine']);
  c = connector();
  await c.csConnect('mine', { broker: 'mine' }, { api_key_id: box('') }, new Set());
  assert.deepEqual(c.posts, []);
  // an engine from before any of this (no stored names, no merge): the old post, unchanged
  c = connector();
  await c.csConnect('mine', { broker: 'mine' }, { api_key_id: box(''), api_secret: box('s') }, null);
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts[0].body)), { broker: 'mine', values: { api_key_id: '', api_secret: 's' } });
  // a refused save is an error on the card, and nothing is connected
  c = connector();
  c.fetch = async () => ({ ok: false, json: async () => ({ detail: 'unknown broker' }) });
  await assert.rejects(c.csConnect('mine', { broker: 'mine' }, { k: box('v') }, new Set()), /unknown broker/);
  assert.deepEqual(c.picked, []);
}
// Forget keys is the one explicit delete: an empty object WITHOUT merge.
assert.match(fn('csForgetKeys'), /body: JSON\.stringify\(\{ broker: key, values: \{\} \}\)/);
assert.ok(!/merge/.test(fn('csForgetKeys').replace(/\/\/.*$/gm, '')));

// ── 4. the form ───────────────────────────────────────────────────────────
{
  const c = load(['csSlug', 'csSplitArgs', 'csCleanPath', 'csValidateOwnBroker', 'csModeWords']);
  for (const [typed, id] of [['My Broker', 'my-broker'], ['  Alpaca (paper)  ', 'alpaca-paper'],
    ['IBKR_live', 'ibkr_live'], ['--weird--', 'weird'], ['a/b\\c..d', 'a-b-c-d'], ['Ünïcode FX', 'n-code-fx'],
    ['x'.repeat(40), 'x'.repeat(32)], ['a' + '-'.repeat(40) + 'b', 'a-b'], ['9 lives', '9-lives'],
    ['', ''], ['!!!', ''], [null, '']]) {
    assert.equal(c.csSlug(typed), id, JSON.stringify(typed));
  }
  // Whatever is typed, the ID never holds a character that could leave the
  // state folder, and it is either one the engine and the registry accept or
  // too short, which the form refuses before asking (below).
  for (const typed of ['My Broker', 'Ünïcode FX', 'a/b\\c..d', '..\\..\\xy', 'C:x', 'x'.repeat(80), 'A B C D E',
    '..\\..\\x', '../../etc/passwd', '.hidden', 'a\nb', 'con.txt', '%2e%2e%2f']) {
    const id = c.csSlug(typed);
    assert.match(id, /^[a-z0-9_-]*$/, JSON.stringify(typed));
    if (id.length >= 2) assert.match(id, /^[a-z0-9][a-z0-9_-]{1,31}$/, JSON.stringify(typed));
  }
  assert.equal(c.csSlug('..\\..\\x'), 'x');
  assert.equal(c.csValidateOwnBroker({ name: '..\\..\\x', path: '/a.py', args: '' }, new Set()).field, 'name');
  assert.deepEqual([...c.csSplitArgs('--paper  --label "two words" 7')], ['--paper', '--label', 'two words', '7']);
  assert.deepEqual([...c.csSplitArgs('   ')], []);
  assert.deepEqual([...c.csSplitArgs('--empty ""')], ['--empty', '']);
  assert.equal(c.csCleanPath(' "C:\\Users\\Jo Smith\\my adapter.py" '), 'C:\\Users\\Jo Smith\\my adapter.py');
  assert.equal(c.csCleanPath("'/home/me/a.py'"), '/home/me/a.py');
  assert.equal(c.csCleanPath('/home/me/a.py'), '/home/me/a.py');
  assert.equal(c.csCleanPath('"'), '"');

  const taken = new Set(['paper', 'lse-sim', 'mine']);
  const v = (d) => c.csValidateOwnBroker({ name: '', path: '', args: '', ...d }, taken);
  assert.equal(v({ path: '/a.py' }).field, 'name');
  assert.equal(v({ name: '!', path: '/a.py' }).field, 'name');
  assert.match(v({ name: 'Mine', path: '/a.py' }).message, /"mine" is already in use/);
  assert.match(v({ name: 'Paper', path: '/a.py' }).message, /already in use/);
  assert.equal(v({ name: 'New one' }).field, 'path');
  assert.match(v({ name: 'New one', path: '/home/me/adapter.txt' }).message, /ending in \.py/);
  assert.equal(v({ name: 'New one', path: '/a.py', args: Array(31).fill('x').join(' ') }).field, 'args');
  assert.equal(v({ name: 'New one', path: '"C:\\Users\\me\\My Adapter.PY"', args: '--paper' }), null);

  assert.equal(c.csModeWords('paper'), 'paper trading');
  assert.equal(c.csModeWords('live'), 'a LIVE account: real money');
  assert.equal(c.csModeWords(''), 'mode "unknown", treated as real money');
  assert.equal(c.csModeWords('demo'), 'mode "demo", treated as real money');
}
// An engine from before this feature: 404 or 405 means "update the terminal",
// while this engine's own 404 (an example its kit does not hold) is an answer.
{
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const mk = (r) => load(['readResult', 'csLinkBroker'], { JSON, String, fetch: async () => { if (r instanceof Error) throw r; return r; } });
  let out = await mk(reply(405, { detail: 'Method Not Allowed' })).csLinkBroker({ name: 'x1' });
  assert.equal(out.update, true); assert.match(out.message, /Update the terminal to add your own broker/);
  out = await mk(reply(404, { detail: 'Not Found' })).csLinkBroker({ name: 'x1' });
  assert.equal(out.update, true);
  out = await mk(reply(404, { detail: "That example is not part of this terminal's kit. Update the terminal to use it.", stderr: '' })).csLinkBroker({ name: 'x1', example: 'alpaca' });
  assert.ok(!out.update); assert.match(out.message, /not part of this terminal's kit/);
  out = await mk(reply(400, { detail: 'The adapter stopped before answering (internal: adapter disconnected).', stderr: 'Traceback\nSyntaxError: invalid syntax' })).csLinkBroker({ name: 'x1' });
  assert.equal(out.ok, false); assert.equal(out.stderr, 'Traceback\nSyntaxError: invalid syntax');
  assert.match(out.message, /stopped before answering/);
  out = await mk(new Error('network')).csLinkBroker({ name: 'x1' });
  assert.match(out.message, /engine did not answer/);
  out = await mk(reply(200, { broker: 'x1', registered: true })).csLinkBroker({ name: 'x1' });
  assert.equal(out.ok, true); assert.equal(out.row.broker, 'x1');
}
// The repaint guard must see everything a card shows, or a failed connect
// leaves a stale card behind (the dead-button defect).
{
  const row = { broker: 'mine', connected: false, identity: { display_name: 'Mine' }, armed: false,
    stored_credentials: [], credential_form: [] };
  const c = load(['brokerIdentity', 'csSignature'], { brokerPicker: { rows: [row] }, JSON,
    state: { lseConfigured: false }, connScreen: { dir: [], broker: '', pickOpen: false, examples: [],
      addOpen: false, addBusy: false, linkOld: false, addError: null, notes: {}, errors: {}, keysOpen: {} } });
  const base = c.csSignature();
  const differs = (change, undo) => { change(); assert.notEqual(c.csSignature(), base); undo(); assert.equal(c.csSignature(), base); };
  differs(() => { row.last_error = { message: 'x', at: 5 }; }, () => { delete row.last_error; });
  differs(() => { row.armed = true; }, () => { row.armed = false; });
  differs(() => { row.mode = 'live'; }, () => { delete row.mode; });
  differs(() => { row.stored_credentials = ['api_secret']; }, () => { row.stored_credentials = []; });
  differs(() => { row.identity.display_name = 'Other'; }, () => { row.identity.display_name = 'Mine'; });
  differs(() => { c.connScreen.addOpen = true; }, () => { c.connScreen.addOpen = false; });
  differs(() => { c.connScreen.errors.mine = { message: 'refused' }; }, () => { delete c.connScreen.errors.mine; });
  differs(() => { c.connScreen.examples = [{ key: 'alpaca' }]; }, () => { c.connScreen.examples = []; });
}

// ── 5. key-box drafts: what is typed survives a repaint, and only a repaint ──
// The screen rebuilds its body whenever a row changes and on a timer, which
// makes new, empty inputs. What was typed into a broker's key boxes used to
// vanish with the old ones. It is now kept in connScreen.keyDrafts, put back
// by every rebuild, and dropped when it is submitted, when the user closes
// the card or the screen, when the keys are forgotten, and on unlink.
{
  const mk = () => load(['csDraft', 'csDraftSet', 'csDraftDrop'], { connScreen: { keyDrafts: {} }, Object, String });
  let c = mk();
  assert.equal(c.csDraft('mine', 'api_key'), '');                  // nothing typed yet
  c.csDraftSet('mine', 'api_key', 'PK-TYPED');
  c.csDraftSet('mine', 'api_secret', '  spaces kept as typed ');   // a draft is the box's text, untouched
  c.csDraftSet('other', 'token', 'T');
  assert.equal(c.csDraft('mine', 'api_key'), 'PK-TYPED');
  assert.equal(c.csDraft('mine', 'api_secret'), '  spaces kept as typed ');
  assert.equal(c.csDraft('other', 'token'), 'T');
  assert.equal(c.csDraft('mine', 'token'), '');                    // one broker's box is not another's
  // "the rebuild": a new card asks for the same names and gets the same text
  assert.deepEqual(['api_key', 'api_secret'].map((f) => c.csDraft('mine', f)), ['PK-TYPED', '  spaces kept as typed ']);
  // clearing a box clears its draft, and an emptied broker leaves nothing behind
  c.csDraftSet('mine', 'api_key', '');
  assert.equal(c.csDraft('mine', 'api_key'), '');
  assert.deepEqual(Object.keys(c.connScreen.keyDrafts.mine), ['api_secret']);
  c.csDraftSet('mine', 'api_secret', '');
  assert.ok(!('mine' in c.connScreen.keyDrafts));
  c.csDraftSet('nobody', 'x', '');                                 // clearing what was never typed is nothing
  assert.ok(!('nobody' in c.connScreen.keyDrafts));
  c.csDraftSet('mine', 'n', 12345); assert.equal(c.csDraft('mine', 'n'), '12345');
  c.csDraftSet('mine', 'n', null); assert.equal(c.csDraft('mine', 'n'), '');
  // dropping one broker's drafts (submitted, card closed, unlinked) leaves the others
  c.csDraftSet('mine', 'api_key', 'A'); c.csDraftSet('other', 'token', 'T');
  c.csDraftDrop('mine');
  assert.equal(c.csDraft('mine', 'api_key'), ''); assert.equal(c.csDraft('other', 'token'), 'T');
  // dropping everybody's (the screen was closed)
  c.csDraftDrop();
  assert.deepEqual(Object.keys(c.connScreen.keyDrafts), []);

  // Memory only: the draft functions touch nothing but connScreen.keyDrafts.
  const body = fn('csDraft') + fn('csDraftSet') + fn('csDraftDrop');
  assert.ok(!/localStorage|sessionStorage|indexedDB|cookie|fetch\(|XMLHttpRequest|postMessage/.test(body));
  // ...and nothing else in the page writes a draft anywhere: every use of the
  // store is one of these names (the functions, the state's own field, a read
  // for the "Left empty" line, and the pruning of brokers that are gone).
  const uses = src.split('\n').filter((l) => l.includes('keyDrafts') && !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'));
  for (const l of uses) {
    assert.ok(/connScreen\.keyDrafts(\[broker\]|\[key\]| = \{\}|\)\)|\[k\])|keyDrafts: \{\}|Object\.keys\(connScreen\.keyDrafts\)/.test(l), 'unexpected use of the draft store: ' + l.trim());
    assert.ok(!/Storage|JSON\.stringify|fetch\(/.test(l), 'a draft must never be stored or sent: ' + l.trim());
  }
  // the repaint guard does not serialise drafts either (it does serialise notes and errors)
  assert.ok(!fn('csSignature').includes('keyDrafts'));
}
// Every key box is built from its draft, writes back on each keystroke, and
// carries the name the rebuild restores focus and caret by. (The card builder
// cannot be cut out and run without a DOM, so its text is what is pinned.)
for (const piece of ['inp.value = csDraft(key, f.key);', 'inp.oninput = () => csDraftSet(key, f.key, inp.value);',
  'inp.dataset.csField = "cred:" + key + ":" + f.key;', '.find((el) => el.dataset.csField === want);',
  'again.setSelectionRange(caret[0], caret[1])']) {
  assert.ok(src.includes(piece), 'expected in the card builder: ' + piece);
}
// A stored key is never written into a box: the only thing assigned to a key
// box's value is its draft.
assert.equal((fn('csBrokerCard').match(/inp\.value = /g) || []).length, 1);
// The form is on screen whenever there is something to type; no press of
// Connect merely reveals it (that press sent nothing and read as a dead button).
assert.ok(src.includes('const showForm = !connected && realFields.length > 0\n    && (!allStored || !!connScreen.keysOpen[key]);'));
assert.ok(!src.includes('form.classList.remove("hidden");\n        connScreen.keysOpen[key] = true;'));
assert.ok(!fn('csBrokerCard').includes('connScreen.sig = "";'), 'the line that forced a rebuild under the typist is back');
// Drafts are dropped only AFTER csConnect has handed them over, never before.
{
  const card = fn('csBrokerCard');
  const sent = card.indexOf('const out = await csConnect(key, hub, showForm ? inputs : {}, stored);');
  const dropped = card.indexOf('csDraftDrop(key);', sent);
  assert.ok(sent > 0 && dropped > sent && dropped - sent < 700);
  assert.equal(card.slice(0, sent).includes('csDraftDrop('), false, 'a draft is dropped before it was submitted');
}
// Closing the screen, closing a card, forgetting keys and unlinking drop them.
{
  const hidden = { classList: { add() {} } };
  // The screen is hidden, not removed: its key boxes are still in the
  // document. Closing must empty THEM too and make the next opening rebuild,
  // or the abandoned text is back on screen.
  const boxes = [{ value: 'half-typed key' }, { value: 'half-typed secret' }];
  let asked = '';
  let c = load(['csDraftDrop', 'closeConnScreen'], { connScreen: { sig: 'as-painted', keyDrafts: { mine: { api_key: 'A' }, other: { t: 'T' } } },
    $: () => hidden, document: { querySelectorAll: (sel) => { asked = sel; return boxes; } } });
  c.closeConnScreen();
  assert.deepEqual(Object.keys(c.connScreen.keyDrafts), []);
  assert.deepEqual(boxes.map((b) => b.value), ['', '']);
  assert.equal(asked, '#cs-body input[data-cred]');     // the key boxes, and only them
  assert.notEqual(c.connScreen.sig, 'as-painted');

  const row = fn('csBrokerRow');
  assert.match(row, /head\.onclick = \(ev\) => \{[\s\S]{0,400}csDraftDrop\(\);[\s\S]{0,80}renderConnScreen\(true\);/);

  const stubs = () => ({ JSON, String, state: { provider: 'lse', lastDataProvider: 'lse' }, tpb: { broker: 'lse-hosted' },
    connScreen: { keyDrafts: { mine: { api_key: 'A', api_secret: 'B' }, other: { t: 'T' } }, notes: {}, errors: {}, keysOpen: { mine: true }, broker: 'mine' },
    brokerDisplayName: () => 'Mine', async brokerDisconnect() {}, async refreshProviders() {}, enterLiveSource() {},
    async refreshConnScreen() {}, renderConnScreen() {}, async readResult(r) { return r.body || {}; },
    // nothing out or held on the broker: its own question is the only one (tests/test_ticket_reload.mjs)
    async tpxHeldAsk() { return true; } });
  // unlink confirmed: this broker's drafts go, the other's stay
  c = load(['csDraftDrop', 'csUnlinkBroker'], { ...stubs(), askConfirm: async () => true, fetch: async () => ({ ok: true, status: 200 }) });
  await c.csUnlinkBroker('mine', { broker: 'mine', connected: false });
  assert.deepEqual(JSON.parse(JSON.stringify(c.connScreen.keyDrafts)), { other: { t: 'T' } });
  // unlink cancelled at the question: nothing typed is lost
  c = load(['csDraftDrop', 'csUnlinkBroker'], { ...stubs(), askConfirm: async () => false, fetch: async () => { throw Error('must not be asked'); } });
  await c.csUnlinkBroker('mine', { broker: 'mine', connected: false });
  assert.equal(c.connScreen.keyDrafts.mine.api_secret, 'B');
  // unlink refused by the engine: the broker is still there, and so is what was typed
  c = load(['csDraftDrop', 'csUnlinkBroker'], { ...stubs(), askConfirm: async () => true, fetch: async () => ({ ok: false, status: 409, body: { detail: 'busy' } }) });
  await c.csUnlinkBroker('mine', { broker: 'mine', connected: false });
  assert.equal(c.connScreen.keyDrafts.mine.api_key, 'A');
  assert.equal(c.connScreen.errors.mine.message, 'busy');
  // forget keys confirmed: stored keys are deleted and the unsubmitted text with them
  c = load(['csDraftDrop', 'csForgetKeys'], { ...stubs(), askConfirm: async () => true, fetch: async () => ({ ok: true, status: 200 }) });
  await c.csForgetKeys('mine', 'Mine');
  assert.deepEqual(JSON.parse(JSON.stringify(c.connScreen.keyDrafts)), { other: { t: 'T' } });
  c = load(['csDraftDrop', 'csForgetKeys'], { ...stubs(), askConfirm: async () => false, fetch: async () => { throw Error('must not be asked'); } });
  await c.csForgetKeys('mine', 'Mine');
  assert.equal(c.connScreen.keyDrafts.mine.api_key, 'A');
}
// ── Connect names what is missing ─────────────────────────────────────────
{
  const c = load(['csMissingFields', 'csEmptyFields', 'csListWords'], { String });
  // a LISTING's form: fields it marks required
  const listed = [{ key: 'login', label: 'Login', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', required: true },
    { key: 'server', label: 'Server', type: 'text' },
    { key: 'note', label: 'Note', type: 'text', required: false }];
  const names = (fs) => Array.from(fs, (f) => f.label);
  assert.deepEqual(names(c.csMissingFields(listed, {}, new Set())), ['Login', 'Password']);
  assert.deepEqual(names(c.csMissingFields(listed, { login: 'me', password: '   ' }, new Set())), ['Password']);   // spaces are not a value
  assert.deepEqual(names(c.csMissingFields(listed, { login: '' }, new Set(['login', 'password']))), []);           // saved counts
  assert.deepEqual(names(c.csMissingFields(listed, { login: 'me' }, new Set(['password']))), []);
  assert.deepEqual(names(c.csMissingFields(listed, {}, null)), ['Login', 'Password']);                             // an engine that cannot say what is saved
  // a form an ADAPTER declared (SPEC 3.2) has no required flag: it never
  // blocks, because an adapter may fall back to a demo account without keys
  const own = [{ key: 'api_key', label: 'API key ID', type: 'text' }, { key: 'api_secret', label: 'API secret key', type: 'password' }];
  assert.deepEqual(names(c.csMissingFields(own, {}, new Set())), []);
  // ...only a real `true` counts; a string or a number in a row does not make a field required
  assert.deepEqual(names(c.csMissingFields([{ key: 'a', label: 'A', required: 'true' }, { key: 'b', label: 'B', required: 1 }], {}, new Set())), []);
  // what the card names beside a refusal: every box with nothing typed and nothing saved
  assert.deepEqual(names(c.csEmptyFields(own, {}, new Set())), ['API key ID', 'API secret key']);
  assert.deepEqual(names(c.csEmptyFields(own, { api_key: 'PK' }, new Set())), ['API secret key']);
  assert.deepEqual(names(c.csEmptyFields(own, { api_key: ' ' }, new Set(['api_secret']))), ['API key ID']);
  assert.deepEqual(names(c.csEmptyFields(own, {}, new Set(['api_key', 'api_secret']))), []);
  assert.deepEqual(names(c.csEmptyFields(null, {}, null)), []);
  assert.equal(c.csListWords([]), ''); assert.equal(c.csListWords(['A']), 'A');
  assert.equal(c.csListWords(['A', 'B']), 'A and B'); assert.equal(c.csListWords(['A', 'B', 'C']), 'A, B and C');
  // the sentence the card shows, and that nothing is sent when it does
  const card = fn('csBrokerCard');
  assert.ok(card.includes('`${names} ${missing.length > 1 ? "are" : "is"} required. `'));
  const stop = card.indexOf('if (missing.length) {'), send = card.indexOf('await csConnect(key, hub');
  assert.ok(stop > 0 && send > stop && /return;\s*\}\s*on\.disabled = true;/.test(card.slice(stop, send)));
  assert.ok(card.includes('errEmpty.textContent = "Left empty: " + empty.map((f) => f.label || f.key).join(", ") + ".";'));
}

// ── a failed connect reads as a sentence, not a code word ──────────────────
{
  const c = load(['tpbPlainReason', 'csFailText'], { String });
  assert.equal(c.csFailText("unauthorized: The API secret box is empty: type your API secret in this broker's row and press Connect.", ''),
    "The API secret box is empty: type your API secret in this broker's row and press Connect.");
  assert.equal(c.csFailText('internal: adapter disconnected', 'File "x.py", line 3\nSyntaxError: invalid syntax'),
    'The adapter stopped. The last lines it printed are below.');
  assert.equal(c.csFailText('internal: adapter disconnected', ''), 'The adapter stopped without saying why.');
  assert.equal(c.csFailText('internal: adapter disconnected', null), 'The adapter stopped.');
  // the page's own sentences, and anything not led by a code word, are as they were
  assert.equal(c.csFailText('API key is required. Type it, then press Connect.', ''), 'API key is required. Type it, then press Connect.');
  assert.equal(c.csFailText('catalog unavailable', ''), 'catalog unavailable');
  // drawn so, both from the engine's record and where Connect itself failed
  const card = fn('csBrokerCard');
  assert.ok(card.includes('err.textContent = csFailText(failed.message, more);'));
  assert.ok(card.includes('err.textContent = csFailText(connScreen.errors[key].message, null);'));
  assert.ok(!/err\.textContent = (failed\.message|connScreen\.errors\[key\]\.message);/.test(card));
}

console.log('Own broker UI: catalog text stays text; live money is asked, armed only on yes, read-only on no; blank key boxes are never sent; typed keys survive repaints and are dropped when submitted or put away; form checks hold.');
