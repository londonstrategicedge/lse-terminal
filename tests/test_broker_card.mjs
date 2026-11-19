// A broker's own card on the Connections screen (csBrokerCard), the page's
// half. Same method as the other .mjs tests here: the shipped functions are
// cut out of app.js by name and run in node:vm, here against a small fake
// DOM, so what is tested is the shipped text.
//
// What is pinned:
//   1. a profile linked from a row this terminal lists keeps that row's help
//      with its boxes (where to make the key and, on one row, who may not use
//      its broker's API), whole, as text, until it is connected; a profile
//      of the user's own adapter has none;
//   2. a refusal is shown whole, in the broker's words;
//   3. the link reads "Get your <key name> at <link>": the name exactly as
//      the row gives it, its words and their case ("Get your API token at
//      ...", "Get your One-time password at ..."), but for a leading "your",
//      "a", "an" or "the" in any case, which is dropped ("Your API key" reads
//      "Get your API key at ..."); a row that names nothing is the API key;
//   4. what the adapter printed (the engine's `printed`) is on the card, as
//      text, folded: while it is connected and after a run that ended with
//      no failure to show, its fold open across repaints; a failed connect
//      shows its own lines under its sentence instead, once;
//   5. new lines are put on the card where it is, at the watch tick, without
//      repainting the screen: an adapter that prints as it runs no longer
//      throws away the account preview (the first of the chooser's two
//      clicks) every few seconds. What it printed is not in the repaint's
//      signature.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');

function cut(name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return src.slice(start, end + 2);
}

// ── a fake DOM: elements with children, classes, text and a class selector
function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, _text: '', _cls: new Set(),
    disabled: false, value: '', placeholder: '', type: '', href: '', target: '', rel: '', src: '', alt: '',
    open: false, title: '', onclick: null, ontoggle: null, listeners: {},
    get className() { return [...this._cls].join(' '); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html || ''; },
    appendChild(ch) { this.children.push(ch); return ch; },
    append(...chs) { for (const ch of chs) this.appendChild(typeof ch === 'string' ? text(ch) : ch); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector(sel) { return find(this, sel)[0] || null; },
    querySelectorAll(sel) { return find(this, sel); },
    remove() {},
  };
  e.classList = { add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c), contains: (c) => e._cls.has(c) };
  return e;
}
const text = (t) => ({ tagName: '#text', children: [], textContent: String(t), _cls: new Set(), className: '' });
function walk(e, out = []) { out.push(e); for (const ch of e.children || []) walk(ch, out); return out; }
function find(e, sel) {
  const all = walk(e).slice(1);
  if (sel.startsWith('.')) return all.filter((x) => x._cls && x._cls.has(sel.slice(1)));
  return all.filter((x) => x.tagName === sel.toUpperCase());
}
const shown = (e) => !(e._cls && e._cls.has('hidden'));

const FNS = ['brokerIdentity', 'brokerDisplayName', 'brokerIsPaper', 'brokerLiveQuestion', 'csExampleLogo',
  'csFailText', 'tpbPlainReason', 'csEmptyFields', 'csMissingFields', 'csListWords', 'csNeedsUpdate',
  'csDraft', 'csBrokerCard'];
const HELPERS = ['csListedRow', 'csKeysHelp', 'csKeyLinkWords', 'oneLine', 'readResult', 'csSwitchAccount',
  'csSecretBox'];

function page(examples) {
  const c = {
    document: { createElement: el }, String, Array, Object, Number, Set, JSON, RegExp, Math, Promise,
    connScreen: { errors: {}, notes: {}, keysOpen: {}, keyDrafts: {}, examples, origin: '', printedOpen: {} },
    state: { providers: [], provider: 'lse' },
    csEsc: (s) => String(s ?? ''),
    $: () => null, askConfirm: async () => false, brokerArm: async () => false,
    refreshConnScreen: async () => {}, renderConnBar() {}, renderConnScreen() {}, csForgetKeys() {},
    startAppUpdate() {}, csConnect: async () => ({}), closeConnScreen() {}, enterLiveSource() {},
    brokerDisconnect: async () => {}, refreshProviders: async () => {}, csUnlinkBroker() {},
    csDraftDrop() {}, csDraftSet() {}, tpbSwitch: async () => ({}),
    // the account switch reads the record first (csSwitchAccount): nothing held here
    tpxHeldOn: async () => [], tpxHeldText: () => '',
    fetch: async (url, init) => { c.fetched = { url, body: init && init.body };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; },
  };
  vm.createContext(c);
  for (const n of FNS) vm.runInContext(cut(n), c);
  for (const n of HELPERS) if (src.includes('function ' + n + '(')) vm.runInContext(cut(n), c);
  return c;
}

const HELP = 'Sign in to the Fixture Markets hub, then Tools, API, Generate. Copy the token: it is shown once. '
  + 'Fixture Markets does not offer this API to residents of the EU (Fixture Markets EU) or to clients of '
  + 'Fixture Markets Global.';
const LISTED = { key: 'fixture', name: 'Fixture Markets', key_name: 'API token', keys_help: HELP,
                 keys_url: 'https://hub.fixture.example/tokens/', form: [{ key: 'token', label: 'API token', type: 'password' }] };
const REFUSAL = 'Fixture Markets refused this API token on its practice host (https://api-practice.fixture.example). '
  + 'A token made on a practice (demo) login works only on practice, and one made on a live login only on '
  + 'live: check that it is the token Fixture Markets showed for this login and that it has not been revoked. '
  + 'Fixture Markets does not offer its API to clients of Fixture Markets EU (EU residents) or Fixture Markets Global.';
const LINKED = { broker: 'my-fixture', label: 'my-fixture', registered: true, example: 'fixture', connected: false,
                 identity: { display_name: 'Fixture Markets', mode: 'paper' },
                 credential_form: [{ key: 'token', label: 'API token', type: 'password' }],
                 stored_credentials: ['token'], command_preview: ['python3', 'fixture_adapter.py'] };
const notes = (card) => walk(card).filter((e) => e._cls && e._cls.has('cs-note') && shown(e)).map((e) => e.textContent);

// ── 1, 2. the linked card keeps its listed row's help, and a refusal whole ──
{
  const c = page([LISTED]);
  const refused = { ...LINKED, last_error: { message: 'unauthorized: ' + REFUSAL, at: 1 } };
  const card = c.csBrokerCard(null, refused, { headless: true });
  assert.ok(notes(card).includes(HELP + ' Get your API token at hub.fixture.example/tokens'), notes(card).join(' | '));
  const link = find(card, 'a').find((a) => a.textContent.startsWith('Get your API token at'));
  assert.equal(link.href, 'https://hub.fixture.example/tokens/');
  assert.deepEqual([link.target, link.rel], ['_blank', 'noopener']);
  const err = find(card, '.cs-err')[0];
  assert.ok(shown(err));
  assert.equal(err.textContent, REFUSAL, 'the refusal whole, its last sentence included');
  // the help is said before the boxes it is about
  const all = walk(card);
  const at = all.findIndex((e) => e.textContent === HELP + ' Get your API token at hub.fixture.example/tokens');
  assert.ok(at >= 0 && at < all.findIndex((e) => e._cls && e._cls.has('cs-form')), 'help before the form');
  // connected, it has done its job: not repeated
  const on = c.csBrokerCard(null, { ...LINKED, connected: true }, { headless: true });
  assert.ok(!notes(on).some((t) => t.includes('residents of the EU')), notes(on).join(' | '));
  // a profile of the user's own adapter, or one whose row is no longer listed: none
  for (const hub of [{ ...LINKED, example: undefined }, { ...LINKED, example: 'gone' }]) {
    assert.ok(!notes(c.csBrokerCard(null, hub, { headless: true })).some((t) => t.includes('residents')));
  }
  // the broker's text is text: a help holding markup is not markup
  const odd = page([{ ...LISTED, keys_help: '<img src=x onerror=alert(1)> Copy it.' }]);
  const card2 = odd.csBrokerCard(null, LINKED, { headless: true });
  assert.ok(notes(card2).includes('<img src=x onerror=alert(1)> Copy it. Get your API token at hub.fixture.example/tokens'));
  assert.ok(!walk(card2).some((e) => e.tagName === 'IMG' && e.src === 'x'));
  // a keys address that is not https is not a link
  const plain = page([{ ...LISTED, keys_url: 'http://hub.fixture.example/tokens/' }]);
  assert.ok(!find(plain.csBrokerCard(null, LINKED, { headless: true }), 'a').some((a) => a.textContent.startsWith('Get')));
}

// ── 3. the link's words for a credential's name ────────────────────────────
{
  const c = page([LISTED]);
  const words = (key_name) => {
    c.connScreen.examples = [{ ...LISTED, key_name }];
    const card = c.csBrokerCard(null, LINKED, { headless: true });
    return find(card, 'a').map((a) => a.textContent).find((t) => t.startsWith('Get ')) || '';
  };
  const at = ' at hub.fixture.example/tokens';
  // the names a row can give: each exactly as the row gives it (its words and
  // their case), but for a leading "your", "a", "an" or "the" in any case,
  // which the sentence already says
  for (const [name, said] of [
    ['One-time password', 'One-time password'], ['Unlock code', 'Unlock code'], ['RSA key', 'RSA key'],
    ['SSH key', 'SSH key'], ['HMAC secret', 'HMAC secret'], ['MT5 login', 'MT5 login'], ['NSE key', 'NSE key'],
    ['Hourly token', 'Hourly token'], ['Euro account token', 'Euro account token'], ['API token', 'API token'],
    ['API key', 'API key'], ['API key ID', 'API key ID'], ['Access token', 'Access token'],
    ['API token ', 'API token'], ['  Login   email ', 'Login email'], ['OAuth token', 'OAuth token'],
    // proper nouns keep their capitals (a firm's name is not put in lower case)
    ['Kraken API key', 'Kraken API key'], ['Google Authenticator code', 'Google Authenticator code'],
    ['Saxo OpenAPI token', 'Saxo OpenAPI token'], ['Interactive Brokers token', 'Interactive Brokers token'],
    ['One-Time Password', 'One-Time Password'], ['IBKR Flex token', 'IBKR Flex token'],
    ['eToro API key', 'eToro API key'], ['iPhone passcode', 'iPhone passcode'], ['refresh_token', 'refresh_token'],
    // a leading article goes, in any case (never "Get your your API key")
    ['Your API key', 'API key'], ['your API token', 'API token'], ['YOUR access token', 'access token'],
    ['The API token', 'API token'], ['the Kraken API key', 'Kraken API key'], ['A one-time password', 'one-time password'],
    ['An access code', 'access code'], ['an RSA key', 'RSA key'], ['  Your   API key ', 'API key'],
    // only a whole leading word: these keep every letter
    ['API', 'API'], ['Theta key', 'Theta key'], ['Annual token', 'Annual token'], ['Thekey', 'Thekey'],
    ['Yourtoken', 'Yourtoken'], ['Access key', 'Access key'], ['ANY key', 'ANY key'],
  ]) {
    assert.equal(words(name), 'Get your ' + said + at, name);
  }
  // a name that is only an article is no name: the API key its boxes say
  for (const name of ['Your', 'the ', ' A ']) assert.equal(words(name), 'Get your API key' + at, name);
  // a row that names nothing is the API key its boxes say
  assert.equal(words(''), 'Get your API key' + at);
  assert.equal(words(undefined), 'Get your API key' + at);
}

// ── 3b. a connected card's Disconnect asks first while anything is held ─────
// (the question itself, and the dropdown row's x, Unlink and Forget keys, are
// in tests/test_ticket_reload.mjs; tpxHeldAsk answers for it here)
{
  const c = page([LISTED]);
  const asked = [], gone = [];
  c.tpxHeldAsk = async (broker, verb) => { asked.push([broker, verb]); return c.heldYes; };
  c.brokerDisconnect = async (b) => { gone.push(b); };
  const card = c.csBrokerCard(null, { ...LINKED, connected: true }, { headless: true });
  const off = find(card, 'button').find((b) => b.textContent === 'Disconnect');
  assert.ok(off, 'a connected card has its Disconnect');
  c.heldYes = false;                                   // Not now
  await off.onclick();
  assert.deepEqual([asked, gone, off.disabled], [[['my-fixture', 'Disconnect']], [], false], 'Not now: not disconnected');
  c.heldYes = true;                                    // Disconnect (or nothing held: no question)
  await off.onclick();
  assert.deepEqual([asked.length, gone], [2, ['my-fixture']]);
}

// ── 4. what the adapter printed ────────────────────────────────────────────
{
  const c = page([LISTED]);
  const lines = 'terms fixture (Fixture Markets): account read; EURUSD bid 1.0851 ask 1.0853\n<b>not markup</b>';
  const folds = (card) => find(card, 'details').filter((d) => d._cls.has('cs-printed'));
  const on = c.csBrokerCard(null, { ...LINKED, connected: true, printed: lines }, { headless: true });
  assert.equal(folds(on).length, 1, 'a connected card folds what its adapter printed');
  const fold = folds(on)[0];
  assert.equal(find(fold, 'summary')[0].textContent, 'Lines the adapter printed');
  assert.equal(find(fold, '.cs-errtail')[0].textContent, lines, 'whole, as text');
  assert.ok(!walk(fold).some((e) => e.tagName === 'B'));
  assert.equal(fold.open, false, 'folded: the evidence, not the news');
  fold.open = true;
  fold.listeners.toggle();
  assert.equal(folds(c.csBrokerCard(null, { ...LINKED, connected: true, printed: lines }, { headless: true }))[0].open,
               true, 'open across a repaint');
  // a run that ended (disconnected, or the adapter died) with nothing failed: still there
  assert.equal(folds(c.csBrokerCard(null, { ...LINKED, printed: lines }, { headless: true })).length, 1);
  // a failed connect shows its own lines under its sentence, and not twice
  const failed = c.csBrokerCard(null, { ...LINKED, printed: lines,
    last_error: { message: 'x_fixture_account: the account could not be read', stderr: lines, at: 2 } },
    { headless: true });
  assert.equal(folds(failed).length, 0);
  assert.equal(find(failed, '.cs-errtail').filter(shown).length, 1);
  // nothing printed: no fold shown (it waits, hidden, for the first line)
  assert.equal(folds(c.csBrokerCard(null, { ...LINKED, connected: true }, { headless: true })).filter(shown).length, 0);
}
// ── 5. new lines at the watch tick: in place, the account preview kept ─────
{
  // the screen's repaint signature leaves out what was printed
  const ctx = { brokerPicker: { rows: [{ ...LINKED, connected: true, printed: 'a' }] },
    connScreen: { examples: [], dir: [], notes: {}, errors: {}, keysOpen: {}, addError: null },
    state: { lseConfigured: true }, JSON, String, Array };
  vm.createContext(ctx);
  vm.runInContext(cut('brokerIdentity') + cut('csSignature'), ctx);
  const before = ctx.csSignature();
  ctx.brokerPicker.rows[0].printed = 'a\nb';
  assert.equal(ctx.csSignature(), before, 'a new line is not a repaint');
  ctx.brokerPicker.rows[0].connected = false;
  assert.notEqual(ctx.csSignature(), before, 'what the row shows still is');
}
for (const first of ['starting; EURUSD bid 1.0851 ask 1.0853', '']) {
  // a connected card with two accounts, one previewed (the chooser's first
  // click); a watch tick then brings new lines from the adapter
  const c = page([LISTED]);
  const hub = { ...LINKED, connected: true, account_id: 'fx-1', printed: first,
                accounts: [{ id: 'fx-1', label: 'Main', mode: 'demo' }, { id: 'fx-2', label: 'Second', mode: 'demo' }] };
  c.brokerPicker = { rows: [hub] };
  const card = c.csBrokerCard(null, hub, { headless: true });
  // (the one in use is disabled: nothing to decide; its markup is innerHTML, which this DOM does not parse)
  const other = find(card, '.cs-acct').find((b) => !b.disabled && b.innerHTML.includes('fx-2'));
  assert.ok(other && typeof other.onclick === 'function', 'the account that is not in use can be chosen');
  other.onclick();                                   // first click: the preview
  const preview = () => find(card, '.cs-acct-preview').length;
  assert.equal(preview(), 1, 'previewed');
  const body = el('div');
  body.appendChild(card);
  Object.defineProperty(body, 'childElementCount', { get: () => body.children.length });
  for (const n of ['brokerIdentity', 'csSignature', 'renderConnScreen', 'csPrintedRefresh']) {
    if (src.includes('function ' + n + '(')) vm.runInContext(cut(n), c);
  }
  c.state = { lseConfigured: true, providers: [], provider: 'lse', hosted: false };
  c.connScreen = { ...c.connScreen, dir: [], addError: null, sig: '' };
  c.$ = (id) => (id === 'cs-body' ? body : null);
  c.connScreen.sig = c.csSignature();
  hub.printed = first + (first ? '\n' : '') + 'account read; EURUSD bid 1.0852 ask 1.0854';
  c.renderConnScreen();                              // the watch tick
  assert.equal(body.children[0], card, 'the screen was not rebuilt');
  assert.equal(preview(), 1, 'the preview survives the tick');
  const fold = find(card, 'details').find((d) => d._cls.has('cs-printed'));
  assert.ok(fold && shown(fold), 'the lines are on the card');
  assert.equal(find(fold, '.cs-errtail')[0].textContent, hub.printed, 'all of them, as text');
  await other.onclick();                             // the second click switches, as it would have
  assert.ok(c.fetched && c.fetched.url === '/api/broker/account', JSON.stringify(c.fetched || null));
}

// ── the guide says what the card does ──────────────────────────────────────
{
  const guide = fs.readFileSync(new URL('../lse_terminal/ui/static/guide.md', import.meta.url), 'utf8');
  const bullet = guide.split('\n').find((l) => l.startsWith('- **Connecting.**'));
  for (const piece of ["the reason is shown on the card in the broker's own words, whole",
                       "keeps that row's note on making its key beside its boxes",
                       'under "Lines the adapter printed"',
                       "that card is where they are kept: the terminal's own log gets a line saying so instead"]) {
    assert.ok(bullet.includes(piece), 'the Connecting bullet does not say: ' + piece);
  }
  // who may not use a broker's API is said of the listed rows whose note says
  // it, and of no other (the engine's EXAMPLES, read as text)
  const hub = fs.readFileSync(new URL('../lse_terminal/engine/broker_hub.py', import.meta.url), 'utf8');
  const ex = hub.slice(hub.indexOf('\nEXAMPLES = {'));
  const rows = [...ex.matchAll(/"name": "([^"]+)",[\s\S]*?"keys_help": ((?:"(?:[^"\\]|\\.)*"\s*)+)/g)]
    .map((m) => ({ name: m[1], help: [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((q) => q[1]).join('') }));
  assert.ok(rows.length >= 3, JSON.stringify(rows));
  const says = rows.filter((r) => /does not offer|may not use/.test(r.help)).map((r) => r.name);
  assert.deepEqual(says, ['OANDA'], 'the rows whose note says who may not use the API');
  assert.ok(bullet.includes("A broker linked from a row we list keeps that row's note on making its key beside "
                            + "its boxes (OANDA's note also says who may not use its API)."), bullet);
  assert.ok(!bullet.includes('including who may not use its API'), 'said of every listed row');
}

console.log('test_broker_card.mjs: ok');
