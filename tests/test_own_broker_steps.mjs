// "+ Add your own broker": the card's instructions, its two links, this
// computer's test command, and the walkthrough's numbered steps. Same method
// as the other .mjs tests here: the functions are cut out of app.js by name
// and run in node:vm against a small stand-in for the page, so what is tested
// is the shipped text.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
const guide = fs.readFileSync(new URL('../lse_terminal/ui/static/guide.md', import.meta.url), 'utf8');

function fn(name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'app.js has no function ' + name);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'no end found for ' + name);
  return src.slice(start, end + 2);
}
function constLine(name) {
  const m = src.match(new RegExp('^const ' + name + ' = [^\\n]*;', 'm'));
  assert.ok(m, 'app.js has no const ' + name);
  return m[0];
}

// ── nothing sends a user to a project that does not exist ──────────────────
assert.ok(!src.includes('pip install brue-connect'), 'app.js still says pip install brue-connect');
assert.ok(!guide.includes('pip install brue-connect'), 'guide.md still says pip install brue-connect');
assert.ok(!/pip\s+install\s+brue-connect/i.test(src + guide));
// the kit's examples are rows of their own, not a list above the form
assert.ok(!guide.includes('Ready to link'), 'guide.md still describes "Ready to link"');

// ── a stand-in for the page: elements that hold text, never markup ─────────
function makeDoc() {
  const mk = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], className: '', id: '', dataset: {}, style: {},
      attrs: {}, listeners: {}, _text: '', value: '', disabled: false,
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set innerHTML(v) { throw new Error('markup was set on the add-your-own-broker card: ' + v); },
      appendChild(ch) { this.children.push(ch); return ch; },
      append(...chs) { for (const ch of chs) this.children.push(typeof ch === 'string' ? mkText(ch) : ch); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
      focus() {},
      classList: {
        _s: new Set(),
        add(...n) { n.forEach((x) => this._s.add(x)); },
        remove(...n) { n.forEach((x) => this._s.delete(x)); },
        contains(n) { return this._s.has(n); },
        toggle(n, on) { if (on === undefined ? !this._s.has(n) : on) this._s.add(n); else this._s.delete(n); },
      },
    };
    el.classList = { ...el.classList, _s: new Set() };
    return el;
  };
  const mkText = (t) => ({ tagName: '#text', children: [], textContent: t });
  return { createElement: mk, createTextNode: mkText };
}
function walk(el, out = []) {
  out.push(el);
  for (const c of el.children || []) walk(c, out);
  return out;
}
const byText = (root, text) => walk(root).find((e) => e.tagName !== '#text' && e._text === text);
const byId = (root, id) => walk(root).find((e) => e.id === id);
const devSteps = (root) => walk(root).filter((e) => e.className === 'cs-devsteps')[0].children.map((li) => li._text);
const devNote = (root) => { const n = walk(root).find((e) => e.className === 'cs-devnote');
  return { text: n.textContent, code: n.children.filter((x) => x.tagName === 'CODE').map((x) => x._text) }; };

const POSIX = "BRUE_CRED_API_KEY=practice BRUE_CRED_API_SECRET=practice PYTHONPATH='/opt/my kit' /usr/bin/python3 -m brueconnect.conformance.run --adapter \"/usr/bin/python3 my_broker_adapter.py\"";
const WINDOWS = "$env:BRUE_CRED_API_KEY = 'practice'; $env:BRUE_CRED_API_SECRET = 'practice'; $env:PYTHONPATH = 'C:\\Program Files\\LSE Terminal\\resources\\brue-sdk'; & 'C:\\Python312\\python.exe' -m brueconnect.conformance.run --adapter \"'C:\\Python312\\python.exe' my_broker_adapter.py\"";
const GUIDE = (over = {}) => ({ platform: 'linux', python: '/usr/bin/python3', python_version: '3.12.3',
  python_ok: true, sdk: '/opt/my kit', file: 'my_broker_adapter.py', template: true,
  commands: { posix: POSIX, windows: WINDOWS }, ...over });

function card(ownGuide, { fetchAnswer = null } = {}) {
  const calls = { render: [], closed: 0, guideAt: [], fetched: [], copied: [], selected: 0 };
  const ctx = {
    String, JSON, Array, Object, Set, Promise, setTimeout: (f) => f(),
    document: makeDoc(),
    navigator: { platform: 'Linux x86_64',
                 clipboard: { writeText: async (t) => { calls.copied.push(t); } } },
    window: { getSelection: () => ({ selectAllChildren: () => { calls.selected += 1; } }) },
    connScreen: { addOpen: true, addBusy: false, linkOld: false, addError: null, addFocus: '',
                  addDraft: { name: '', path: '', args: '' }, ownGuide, dir: [] },
    brokerPicker: { rows: [] },
    renderConnScreen: (force) => calls.render.push(force),
    closeConnScreen: () => { calls.closed += 1; },
    gdOpenAt: (id) => calls.guideAt.push(id),
    startAppUpdate: () => {},
    csSubmitLink: () => {},
    fetch: async (url) => {
      calls.fetched.push(url);
      if (fetchAnswer instanceof Error) throw fetchAnswer;
      return fetchAnswer || { ok: false, json: async () => ({}) };
    },
    calls,
  };
  vm.createContext(ctx);
  vm.runInContext(constLine('CS_GUIDE_ID'), ctx);
  for (const n of ['csSlug', 'csSplitArgs', 'csCleanPath', 'csValidateOwnBroker', 'csTakenIds',
                   'csLoadOwnGuide', 'csTestHelp', 'csCopyCommand', 'csTestBlock', 'csAddBrokerRow']) {
    vm.runInContext(fn(n), ctx);
  }
  ctx.row = ctx.csAddBrokerRow();
  return ctx;
}

// ── the card, on a Linux engine with Python 3.12 ──────────────────────────
{
  const c = card(GUIDE());
  const root = c.row;
  // the row says what it is for; the card is three numbered steps, each a title, a sentence and its action
  assert.equal(byId(root, 'cs-add-open').children.find((e) => e.className === 'cs-addheadmid')
    .children.map((e) => e._text).join(' | '),
    "Add your own broker | Connect a broker we don't list, with your own API keys.");
  const stepEls = walk(root).filter((e) => String(e.className).split(' ')[0] === 'cs-step');
  assert.deepEqual(stepEls.map((li) => li.children[0]._text), ['1', '2', '3']);
  // the step you are on is marked; nothing is done yet
  assert.deepEqual(stepEls.map((li) => li.className), ['cs-step current', 'cs-step', 'cs-step']);
  assert.deepEqual(walk(root).filter((e) => e.className === 'cs-steptitle').map((e) => e._text),
    ['Get the starter adapter', 'Add it to the terminal', 'Connect']);
  assert.deepEqual(walk(root).filter((e) => e.className === 'cs-steptext').map((e) => e._text), [
    'A starter file that links the terminal to a broker. It runs on practice prices straight away, so you can try ' +
      'every step before it is set up for your broker.',
    'Name it and point the terminal at the file. The terminal runs the file once to check it before adding it.',
    'It appears in your list of brokers above. Open it, type your API key and secret, and press Connect. Until the ' +
      'file is set up for your broker it only uses practice prices, so any key works for a test.']);
  // the developers' test is folded at the foot, closed until opened, and stays as the user left it
  const dev = byId(root, 'cs-dev');
  assert.equal(dev.tagName, 'DETAILS');
  assert.equal(dev.open, false);
  assert.equal(dev.children[0]._text, 'For developers: test your adapter on this computer');
  assert.ok(walk(dev).some((e) => e.id === 'cs-test-cmd'), 'the test command is inside the fold');
  dev.open = true; dev.ontoggle();
  assert.equal(c.connScreen.devOpen, true);
  // the two links
  const how = byText(root, 'Read the step-by-step guide');
  assert.ok(how && how.tagName === 'A', 'no "Read the step-by-step guide" link');
  assert.equal(how.href, '#gd-add-your-own-broker');
  let prevented = 0;
  how.onclick({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(c.calls.closed, 1, 'the Connections screen is closed first');
  assert.deepEqual(c.calls.guideAt, ['gd-add-your-own-broker'], 'the walkthrough opens at the section');
  // step 1's action makes the file in the user's own folder; the download stays as the browser's way
  assert.equal(byId(root, 'cs-add-make')._text, 'Create my starter adapter');
  const dl = byText(root, 'or download it');
  assert.ok(dl && dl.tagName === 'A', 'no "or download it" link');
  assert.equal(dl.href, '/api/broker/template');
  assert.equal(dl.getAttribute('download'), 'my_broker_adapter.py');
  assert.equal(dl.target, undefined, 'the download stays in this window (the shell hands new windows to the browser)');
  // the test command for this platform, with its Copy
  const cmd = byId(root, 'cs-test-cmd');
  assert.equal(cmd.tagName, 'CODE');
  assert.equal(cmd._text, POSIX);
  const copy = byId(root, 'cs-test-copy');
  assert.equal(copy._text, 'Copy');
  copy.onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.calls.copied, [POSIX]);
  // the window named so it is not read as this app, how to reach the folder,
  // and which file name the command expects
  assert.deepEqual(devSteps(root), ['Open a shell window in the folder with the file.',
    'Copy the command, paste it there and press Enter.', 'It passed if the last line ends with 0 fail.']);
  assert.deepEqual(devNote(root), { text: "It tests the file named my_broker_adapter.py in that folder. Each key box reaches the file as BRUE_CRED_ and the box's key in capitals: if you change the file's key boxes, change those names in the command (a username box is BRUE_CRED_USERNAME). Adapters run here with Python 3.12.3.",
    code: ['my_broker_adapter.py', 'BRUE_CRED_', 'BRUE_CRED_USERNAME'] });
  assert.ok(!byId(root, 'cs-test-none'));
  // the form: a broker name, the adapter file, and the arguments folded under "More options"
  assert.deepEqual(walk(root).filter((e) => e.className === 'cs-fieldlabel').map((e) => e._text),
    ['Broker name', 'Adapter file', 'Arguments']);
  assert.equal(walk(root).find((e) => e.className === 'cs-more').children[0]._text, 'More options');
  assert.ok(walk(root).some((e) => e._text === 'Step 1 fills this in. Downloaded the file instead? Paste its full path here.'));
  assert.equal(byId(root, 'cs-add-go')._text, 'Test and add');
  // placeholders that fit the starter, and the NAME hint says it becomes an ID
  const ph = Object.fromEntries(walk(root).filter((e) => e.dataset && e.dataset.csField).map((e) => [e.dataset.csField, e.placeholder]));
  assert.equal(ph.path, 'No file yet');
  // Test and add waits, faded, until both boxes have something in them
  assert.equal(byId(root, 'cs-add-go').disabled, true);
  assert.equal(ph.args, 'none needed for the starter adapter');
  assert.equal(byId(root, 'cs-add-id')._text, 'Shown in your list of brokers.');
  assert.equal(ph.name, 'e.g. Acme Markets');
  assert.ok(byText(root, 'Cancel'));
  // the facts were in hand: nothing was asked of the engine
  assert.deepEqual(c.calls.fetched, []);
  // nowhere on the card: the old pip line
  assert.ok(!root.textContent.includes('pip'), root.textContent);
}

// ── macOS and Windows: each its own shell ─────────────────────────────────
{
  const mac = card(GUIDE({ platform: 'darwin' }));
  assert.equal(byId(mac.row, 'cs-test-cmd')._text, POSIX);
  assert.equal(devSteps(mac.row)[0], "Open the Mac's own Terminal app (Applications, then Utilities), type cd, " +
    "a space and the folder's path, and press Enter.");
  assert.equal(devNote(mac.row).text, "It tests the file named my_broker_adapter.py in that folder. Each key box reaches the file as BRUE_CRED_ and the box's key in capitals: if you change the file's key boxes, change those names in the command (a username box is BRUE_CRED_USERNAME). Adapters run here with Python 3.12.3.");
  const win = card(GUIDE({ platform: 'win32', python: 'C:\\Python312\\python.exe' }));
  assert.equal(byId(win.row, 'cs-test-cmd')._text, WINDOWS);
  assert.equal(devSteps(win.row)[0], 'In File Explorer, open the folder with the file, right-click inside it and ' +
    'choose \u201cOpen in Terminal\u201d (Windows 10: Shift + right-click, \u201cOpen PowerShell window here\u201d).');
  assert.ok(devNote(win.row).text.endsWith(' The keys it sets stay in that PowerShell window until you close it. ' +
    'Adapters run here with Python 3.12.3.'));
  // where the file is: each system's own way to copy a file's path
  assert.ok(walk(win.row).some((e) => e._text ===
    'Step 1 fills this in. Downloaded the file instead? In File Explorer, right-click it, choose \u201cCopy as path\u201d and paste it here.'));
  assert.ok(walk(mac.row).some((e) => e._text ===
    'Step 1 fills this in. Downloaded the file instead? In Finder, hold Option, right-click it, choose \u201cCopy as Pathname\u201d and paste it here.'));
  byId(win.row, 'cs-test-copy').onclick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(win.calls.copied, [WINDOWS]);
}

// ── no Python, or one too old: said plainly, and no command ───────────────
{
  const none = card(GUIDE({ python: null, python_version: null, python_ok: false, commands: null }));
  assert.equal(byId(none.row, 'cs-test-none')._text,
    'Testing an adapter needs Python 3.10 or newer, and none was found on this computer. ' +
    'Install it, then restart the terminal.');
  assert.ok(!byId(none.row, 'cs-test-cmd') && !byId(none.row, 'cs-test-copy'));
  const winNone = card(GUIDE({ platform: 'win32', python: null, python_version: null, python_ok: false, commands: null }));
  assert.equal(byId(winNone.row, 'cs-test-none')._text,
    'Testing an adapter needs Python 3.10 or newer, and none was found on this computer. ' +
    'Install it with "Add python.exe to PATH" ticked, then restart the terminal.');
  const old = card(GUIDE({ python_version: '3.9.6', python_ok: false, commands: null }));
  assert.equal(byId(old.row, 'cs-test-none')._text,
    'Testing an adapter needs Python 3.10 or newer. The Python this terminal found is 3.9.6.');
  // still the steps and the file, whatever this computer lacks
  assert.ok(byText(none.row, 'Read the step-by-step guide') && byId(none.row, 'cs-add-make'));
}

// ── "Create my starter adapter": the engine makes it, the card fills in the path and moves on ──
{
  const made = { path: '/home/u/LSE Terminal/brokers/my_broker_adapter.py', folder: '/home/u/LSE Terminal/brokers', existing: false };
  const c = card(GUIDE(), { fetchAnswer: { ok: true, json: async () => made } });
  await byId(c.row, 'cs-add-make').onclick();
  assert.deepEqual(c.calls.fetched, ['/api/broker/template/save']);
  assert.deepEqual({ ...c.connScreen.addSaved }, made);
  assert.equal(c.connScreen.addDraft.path, made.path, 'the path is filled in for the user');
  const row = c.csAddBrokerRow();
  const steps = walk(row).filter((e) => String(e.className).split(' ')[0] === 'cs-step');
  assert.deepEqual(steps.map((li) => [li.className, li.children[0]._text]),
    [['cs-step done', '\u2713'], ['cs-step current', '2'], ['cs-step', '3']]);
  assert.equal(byId(row, 'cs-add-saved').children.map((e) => e._text).join(' '), 'Saved to: ' + made.path);
  // with the file there and a name typed, Test and add can be pressed
  const nameBox = walk(row).find((e) => e.dataset && e.dataset.csField === 'name');
  nameBox.value = 'Acme Markets'; nameBox.oninput();
  assert.equal(byId(row, 'cs-add-go').disabled, false);
  assert.equal(byId(row, 'cs-add-reveal')._text, 'Open folder');
  assert.ok(walk(row).some((e) => e._text === 'Filled in for you: the file step 1 created.'));
  assert.equal(walk(row).find((e) => e.dataset && e.dataset.csField === 'path').value, made.path);
  // a path the user typed is theirs: creating the file does not overwrite it
  const c2 = card(GUIDE(), { fetchAnswer: { ok: true, json: async () => made } });
  c2.connScreen.addDraft.path = 'C:\\mine\\adapter.py';
  await byId(c2.row, 'cs-add-make').onclick();
  assert.equal(c2.connScreen.addDraft.path, 'C:\\mine\\adapter.py');
  // the browser's way, "or download it", counts as step 1 done too
  const c3 = card(GUIDE());
  byId(c3.row, 'cs-add-template').listeners.click[0]();
  assert.equal(c3.connScreen.addDownloaded, true);
  assert.equal(walk(c3.csAddBrokerRow()).filter((e) => String(e.className).split(' ')[0] === 'cs-step')[0].className, 'cs-step done');
}

// ── a kit without the starter: no link to a file that is not there ────────
{
  const c = card(GUIDE({ template: false }));
  assert.ok(!byId(c.row, 'cs-add-make') && !byId(c.row, 'cs-add-template'));
  assert.ok(byText(c.row, "This terminal's kit has no starter adapter. Update the terminal."));
  assert.ok(byText(c.row, 'Read the step-by-step guide'));
}

// ── first opening: the engine is asked once, and the card repaints ────────
{
  const g = GUIDE();
  const c = card(undefined, { fetchAnswer: { ok: true, json: async () => g } });
  assert.ok(byText(c.row, "Reading this computer's Python…"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.calls.fetched, ['/api/broker/own-guide']);
  assert.deepEqual(c.connScreen.ownGuide, g);
  assert.deepEqual(c.calls.render, [true]);
  c.csAddBrokerRow();                        // a repaint does not ask again
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.calls.fetched, ['/api/broker/own-guide']);
  assert.equal(byId(c.csAddBrokerRow(), 'cs-test-cmd')._text, POSIX);
}
// an engine that did not answer: said, and asked again when the card reopens
{
  const c = card(undefined, { fetchAnswer: new Error('engine away') });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual({ ...c.connScreen.ownGuide }, { failed: true });   // made in the page's realm
  const row = c.csAddBrokerRow();
  assert.equal(byId(row, 'cs-test-none')._text,
    "The terminal's engine did not say how to test an adapter here. Close this card and open it again.");
  const head = byId(row, 'cs-add-open');
  head.onclick({ stopPropagation() {} });    // closed
  assert.deepEqual({ ...c.connScreen.ownGuide }, { failed: true });   // made in the page's realm
  head.onclick({ stopPropagation() {} });    // opened again
  assert.equal(c.connScreen.ownGuide, undefined);
}

// ── the walkthrough opens AT the section ──────────────────────────────────
{
  const clicks = [];
  const jumps = [];
  const ctx = { gd: { goTo: null }, $: (id) => ({ click: () => clicks.push(id) }),
                gdJump: (id, flash) => jumps.push([id, flash]) };
  vm.createContext(ctx);
  for (const n of ['gdSlug', 'gdOpenAt', 'gdGoToPending']) vm.runInContext(fn(n), ctx);
  vm.runInContext(constLine('CS_GUIDE_ID'), ctx);
  const sent = vm.runInContext('CS_GUIDE_ID', ctx);   // a const is not a property of the context
  // the id the card sends is the one the guide's heading gets
  assert.equal(sent, 'gd-add-your-own-broker');
  assert.equal(ctx.gdSlug('Add your own broker'), sent);
  ctx.gdOpenAt(sent);
  assert.deepEqual(clicks, ['rail-guide']);
  assert.equal(ctx.gd.goTo, 'gd-add-your-own-broker');
  ctx.gdGoToPending();                       // what the draw does at its end
  assert.deepEqual(jumps, [['gd-add-your-own-broker', true]]);
  assert.equal(ctx.gd.goTo, null);
  ctx.gdGoToPending();                       // the next draw does not jump again
  assert.equal(jumps.length, 1);
  assert.ok(fn('gdRender').includes('gdGoToPending();'), 'gdRender no longer makes the pending jump');
  // a failed fetch of the guide does not leave a jump waiting
  assert.ok(/\.catch\(\(e\) => \{\s*gd\.goTo = null;/.test(fn('gdOpen')));
}

// ── the walkthrough's steps ───────────────────────────────────────────────
{
  const heads = [...guide.matchAll(/^(#{2,3}) (.*)$/gm)].map((m) => m[2].trim());
  assert.equal(heads.filter((h) => h === 'Add your own broker').length, 1, 'one heading "Add your own broker"');
  const lines = guide.split('\n');
  const at = lines.indexOf('### Add your own broker');
  assert.ok(at > lines.indexOf('## Connections and keys'), 'the steps sit under Connections and keys');
  const next = lines.findIndex((l, i) => i > at && /^#{1,3} /.test(l));
  const sec = lines.slice(at, next).join('\n');
  // six numbered steps, one after another (the guide's list needs no blank between them)
  const steps = lines.slice(at, next).filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(steps.map((l) => l.match(/^(\d+)\. \*\*([^*]+)\*\*/).slice(1)), [
    ['1', 'Get the starter adapter.'], ['2', 'Try it as it is.'], ['3', 'Make it yours.'],
    ['4', 'Test it.'], ['5', 'After you edit the file.'], ['6', 'Unlink.']]);
  const first = lines.indexOf(steps[0]);
  assert.deepEqual(lines.slice(first, first + 6), steps);
  // what it needs, and the words the card and the starter use
  for (const piece of ['Python 3.10 or newer', 'API keys', 'API documentation',
                       '"+ Add your own broker"', '"Create my starter adapter"', '`LSE Terminal/brokers`', '"Open folder"', '"or download it"', '`my_broker_adapter.py`',
                       'Test and add', 'Connect, then Use', 'practice prices made inside the file',
                       '`# YOUR BROKER:`', '`mode = "paper"`', '`mode = "live"`', 'Allow trading',
                       'places and closes orders', '`0 fail`',
                       'Disconnect and Connect', 'need not be unlinked', 'moved or been renamed',
                       // changed key boxes, and the file's name (demo keys only)
                       'change `credential_form`', 'the row shows the new ones after that Connect',
                       'rename it first', 'only demo ones',
                       // for a first-time user
                       'the control at the top left', 'Show in folder', 'becomes the broker\'s ID',
                       '"Add it to the terminal"', 'Copy as path', 'nothing under "More options"', 'For developers: test your adapter on this computer', '`BRUE_CRED_` and the box\'s key in capitals',
                       '`BRUE_CRED_USERNAME`', 'change those names in the command to match',
                       'a line marked SKIP is a test that does not apply',
                       'deletes the keys saved for it', 'leaves your file alone']) {
    assert.ok(sec.includes(piece), 'the steps do not say ' + piece);
  }
  // step 4 itself names the variables, as delivered and after the boxes change
  const step4 = steps.find((l) => l.startsWith('4. **Test it.**'));
  for (const piece of ['`BRUE_CRED_API_KEY` and `BRUE_CRED_API_SECRET`', '`BRUE_CRED_USERNAME` and `BRUE_CRED_PASSWORD`']) {
    assert.ok(step4.includes(piece), 'step 4 does not say ' + piece);
  }
  // the card's own label is the one the guide names
  assert.ok(src.includes('devSum.textContent = "For developers: test your adapter on this computer";'));
  // the BROKERS bullet in today's order: shipped rows first, yours, then the door
  const brokers = lines.find((l) => l.startsWith('- **BROKERS.**'));
  const order = ['ships an adapter for', 'you linked yourself', '"+ Add your own broker"'].map((p) => brokers.indexOf(p));
  assert.ok(order.every((x) => x > 0) && order[0] < order[1] && order[1] < order[2], brokers);
}

// ── the "Real money" bullet says what pickBroker does ─────────────────────
{
  const money = guide.split('\n').find((l) => l.startsWith('- **Real money.**'));
  for (const piece of ['asks before it can trade', 'when you press Connect', 'paper when it last connected',
                       'asks as soon as it has connected', '"Stay read-only"',
                       // a login that reaches several accounts, none chosen (pickBroker's `choosing`)
                       'A login that reaches several accounts, none chosen yet, is not asked then',
                       'Once you choose one, its card says whether that account is live and offers Allow trading',
                       'a login that turns out to reach one account asks as soon as it has connected',
                       // the card behind the question after the connect (pickBroker's repaint)
                       'the card behind it already shows the connection as it is']) {
    assert.ok(money.includes(piece), 'the Real money bullet does not say ' + piece);
  }
  assert.ok(!money.includes('asks before it connects'), money);
  // (the question also carries the broker's terms since SPEC 3.3: `, row.terms)`)
  assert.ok(fn('pickBroker').includes('"Allow trading", "Stay read-only"'));
}

// ── Disconnect keeps its row open, so "Disconnect, then Connect" (step 5) needs no second click on the row
{
  const card = fn('csBrokerCard');
  const at = card.indexOf('off.textContent = "Disconnect";');
  assert.ok(at > 0, 'no Disconnect button');
  const handler = card.slice(at, card.indexOf('actions.appendChild(off);', at));
  assert.ok(/connScreen\.broker = key;\s*connScreen\.brokerPinned = true;\s*await refreshConnScreen\(\);/.test(handler), handler);
}

// ── Use goes to MARKETS: from the walkthrough (where these steps are read) the chart is not left beside it
assert.ok(fn('csBrokerCard').includes('use.onclick = () => { closeConnScreen(); enterLiveSource(src.name); $("rail-markets").click(); };'),
  'Use no longer brings MARKETS forward');

// ── a listed broker wears its own logo, unlinked and linked; the empty "Upcoming" line is gone ──
assert.ok(/if \(x\.logo\) \{[\s\S]*?img\.src = String\(x\.logo\)/.test(fn('csExampleRow')), 'the shipped row draws its logo');
assert.ok(fn('csBrokerRow').includes('const exLogo = own ? csExampleLogo(e) : "";'), 'a linked example keeps its logo');
{
  const ctx = { connScreen: { examples: [{ key: 'alpaca', logo: 'data:image/svg+xml;base64,QQ==' }] }, String };
  vm.createContext(ctx);
  vm.runInContext(fn('csExampleLogo'), ctx);
  assert.equal(ctx.csExampleLogo({ hub: { example: 'alpaca' } }), 'data:image/svg+xml;base64,QQ==');
  assert.equal(ctx.csExampleLogo({ hub: { example: null } }), '');
  assert.equal(ctx.csExampleLogo({ hub: {} }), '');
}
assert.ok(!src.includes('csComingSoonRow'), 'the empty Upcoming line is back');

console.log('test_own_broker_steps: ok');
