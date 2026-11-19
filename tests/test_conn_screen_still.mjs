// The Connections screen holds still while it is first read. The shipped
// functions are cut out of app.js by name and run in node:vm; the rows'
// own builders are stood in for by rows that carry only their names, and
// the engine's examples answer (GET /api/broker/examples) comes when the
// test lets it.
//
// Guarded against: a first paint with no listed rows, which come 34 to 67 ms
// later ABOVE the linked rows and "Add your own broker" and push them about
// 190 px down, so a click aimed at one control lands on another (another
// account's preview among them).
//
// What is pinned:
//   1. The first paint gives the listed rows their places from the last
//      examples this page knew: in memory, else kept in localStorage. Every
//      row painted then is at the same place once the answer has come.
//   2. With none known, the rows below the listed ones wait for the first
//      answer: nothing is painted where a listed row will come, and no row
//      is painted that would then be moved.
//   3. Every read and write of the store is in a try: a store that throws
//      is a store with nothing in it, and the screen still paints.
//   4. An answer is kept for the next page, and a later answer that lists
//      the same rows moves nothing.
//   5. Measured in a browser: on the real page in headless Chrome, no listed
//      row moves on the screen from its first paint until after the answer
//      and the rows below it have come, whatever size the rows below make
//      the sheet; with none known, what is painted first holds still too.
//      (A sheet centred on the screen grows when the rows below come,
//      centres itself again, and every listed row moves up about 50 px.)
//   6. The sheet hangs below the header at every window height from 700 to
//      1300 px, and below a taller header (the chart's toolbar under its
//      second row), hung again when the window changes size; it stays on
//      the screen, and when it does not scroll its rows have as much room on
//      the right as on the left. (Hung at 6vh, on windows about 860 to
//      1200 px tall its top runs across the header's second row, and the
//      scroll bar's room it keeps leaves 23 px on the left and 33 px on the
//      right.)
//   7. A sheet opened before boot has drawn the header's second row hangs
//      below that row once it is drawn, and no row moves.
//   8. A quick press on a row whose down comes before a rebuild of the body
//      and whose up after it is taken once, on the row pressed: across the
//      engine's first answers, across the directory's, and on a listed row
//      the engine's answer shows linked. (A renderConnScreen that throws the
//      row away under the press leaves the up to land on its rebuilt twin,
//      and no click is made.)
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test, done, settle } from './ticket_page.mjs';

const src = fs.readFileSync(new URL('../lse_terminal/ui/static/app.js', import.meta.url), 'utf8');
function cut(name) {
  let start = src.indexOf('\nasync function ' + name + '(');
  if (start < 0) start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'no function ' + name);
  return src.slice(start + 1, src.indexOf('\n}\n', start) + 2);
}
const has = (n) => src.includes('\nfunction ' + n + '(') || src.includes('\nasync function ' + n + '(');

function node(tag, label) {
  return { tagName: tag, label, children: [], dataset: {}, className: '', textContent: label || '',
           appendChild(ch) { this.children.push(ch); return ch; }, querySelectorAll() { return []; } };
}
const EXAMPLES = [{ key: 'oanda', name: 'OANDA' }, { key: 'alpaca', name: 'Alpaca' }, { key: 'capitalcom', name: 'Capital.com' }];
const ROWS = [{ broker: 'paper', connected: true }, { broker: 'my-own', registered: true, connected: false }];

function screen(store) {
  const body = node('DIV', 'cs-body');
  Object.defineProperty(body, 'innerHTML', { set() { body.children = []; } });
  Object.defineProperty(body, 'childElementCount', { get: () => body.children.length });
  body.contains = () => false;
  body.parentElement = { scrollTop: 0 };
  const shut = { classList: { contains: () => false, remove() {}, add() {} } };
  let release;
  const c = {
    String, Array, Object, Number, JSON, Set, Promise, Math, RegExp,
    document: { activeElement: null, addEventListener() {}, createElement: (t) => node(t.toUpperCase(), '') },
    $: (id) => (id === 'cs-body' ? body : shut),
    brokerPicker: { rows: ROWS.map((r) => ({ ...r })) },
    state: { hosted: false, lseConfigured: true, providers: [] },
    connScreen: { dir: [], origin: '', broker: null, brokerPinned: false, pickOpen: false, sig: '', printedOpen: {},
                  acctPreview: {}, examples: [], linkOld: false, addOpen: false, addBusy: false, addFocus: '',
                  addDraft: { name: '', path: '', args: '' }, addError: null, ownGuide: undefined, notes: {},
                  errors: {}, keysOpen: {}, keyDrafts: {} },
    LSE_DEMO_KEYS: new Set(['lse-sim']),
    localStorage: store,
    csSection: (t) => node('SECTION', 'section:' + t),
    csLseCard: () => node('DIV', 'lse'),
    csExampleRow: (x) => node('DIV', 'listed:' + x.key),
    csBrokerRow: (e) => node('DIV', 'row:' + e.key),
    csAddBrokerRow: () => node('DIV', 'add'),
    csInquireFoot: () => node('DIV', 'inquire'),
    csPrintedRefresh() {}, csDraftDrop() {}, connScreenWatch() {}, csHang() {}, csGutter() {},
    brokerIdentity: (b) => (b && b.identity) || {},
    refreshProviders: async () => {},
    fetch: async (url) => {
      if (url === '/api/broker/list') return { ok: true, status: 200, json: async () => c.brokerPicker.rows };
      if (url === '/api/broker/examples') {
        await new Promise((r) => { release = r; });
        return { ok: true, status: 200, json: async () => c.answer };
      }
      if (url === '/api/directory') return { ok: false, status: 404, json: async () => null };
      return { ok: false, status: 404, json: async () => null };
    },
    answer: EXAMPLES,
  };
  vm.createContext(c);
  for (const n of ['csSignature', 'renderConnScreen', 'csBrokerEntries', 'csExampleKey', 'openConnScreen',
                   'refreshConnScreen', 'csExamplesKept', 'csExamplesKeep']) {
    if (has(n)) vm.runInContext(cut(n), c);
  }
  c.release = () => release && release();
  // a row by its name; the line said while the list is read as "wait"
  c.paint = () => body.children.map((ch) => ch.label || (/\bcs-wait\b/.test(ch.className) ? 'wait' : ch.className));
  return c;
}
function store(init = {}, broken = false) {
  const kept = { ...init };
  return { kept, getItem: (k) => { if (broken) throw new Error('denied'); return k in kept ? kept[k] : null; },
           setItem: (k, v) => { if (broken) throw new Error('denied'); kept[k] = String(v); } };
}
// every label painted first is at the same index once the answer has come
function stillness(first, after) {
  first.forEach((label, i) => {
    if (label === 'wait') return;     // a placeholder is the one thing replaced
    assert.equal(after[i], label, `"${label}" moved from ${i} to ${after.indexOf(label)}: ${first} -> ${after}`);
  });
}

await test('1. the listed rows have their places at the first paint, from the store', async () => {
  const c = screen(store({ 'lse.cs.examples': JSON.stringify(EXAMPLES) }));
  const opened = c.openConnScreen();
  await settle(5);
  const first = c.paint();
  assert.ok(['listed:oanda', 'listed:alpaca', 'listed:capitalcom'].every((l) => first.includes(l)), first.join(' '));
  c.release();
  await opened;
  await settle(5);
  const after = c.paint();
  assert.ok(after.includes('add') && after.includes('row:my-own'), after.join(' '));
  stillness(first, after);
});

await test('1. a second opening in the same page: from memory', async () => {
  const c = screen(store());
  let opened = c.openConnScreen();
  await settle(5); c.release(); await opened; await settle(5);
  const before = c.paint();
  c.connScreen.sig = '';
  opened = c.openConnScreen();
  await settle(5);
  stillness(c.paint(), before);
  c.release(); await opened;
});

await test('2. none known: the rows below wait for the first answer', async () => {
  const c = screen(store());
  const opened = c.openConnScreen();
  await settle(5);
  const first = c.paint();
  assert.ok(!first.includes('add') && !first.includes('row:my-own') && !first.includes('inquire'),
            'nothing painted that the listed rows would push down: ' + first.join(' '));
  c.release();
  await opened;
  await settle(5);
  const after = c.paint();
  assert.ok(after.includes('listed:oanda') && after.includes('add'), after.join(' '));
  stillness(first, after);
});

await test('3. a store that throws is a store with nothing in it', async () => {
  const c = screen(store({}, true));
  const opened = c.openConnScreen();
  await settle(5);
  const first = c.paint();
  assert.ok(first.length > 0 && !first.includes('add'), first.join(' '));
  c.release();
  await opened;
  await settle(5);
  assert.ok(c.paint().includes('add'));
});

await test('4. an answer is kept for the next page; the same rows again move nothing', async () => {
  const s = store();
  const c = screen(s);
  const opened = c.openConnScreen();
  await settle(5); c.release(); await opened; await settle(5);
  assert.deepEqual(JSON.parse(s.kept['lse.cs.examples']).map((x) => x.key), ['oanda', 'alpaca', 'capitalcom']);
  const next = screen(s);                       // the page loaded again
  const opened2 = next.openConnScreen();
  await settle(5);
  const first = next.paint();
  assert.ok(first.includes('listed:oanda'), first.join(' '));
  next.release(); await opened2; await settle(5);
  stillness(first, next.paint());
  // a kept value that is not a list of rows is not used
  const odd = screen(store({ 'lse.cs.examples': '{"oanda": 1}' }));
  const o3 = odd.openConnScreen();
  await settle(5);
  assert.ok(!odd.paint().some((l) => String(l).startsWith('listed:')), 'no rows from a value that is not a list');
  odd.release(); await o3;
});

// ── 5. measured in a browser ───────────────────────────────────────────────
// The real page (index.html, app.js, style.css), served from this folder on
// 127.0.0.1, in headless Chrome over its debugging pipe. Its engine is
// answered in the page: fetch is stood in for, the boot's reads answered as a
// new engine answers them, the examples answer held until the block lets it
// come, anything else refused. Chrome resolves no name but 127.0.0.1, and its
// profile is made under TMPDIR (keep TMPDIR short: Chrome cannot start when
// its socket's path passes 108 bytes).

// The listed rows as the engine answers them (GET /api/broker/examples),
// without their logos: a row with none has the same 36px tile.
const LISTED = [
  { key: 'alpaca', label: 'Alpaca (paper trading)', name: 'Alpaca',
    about: 'US stocks, ETFs and crypto, on your own Alpaca paper account.',
    keys_url: 'https://app.alpaca.markets/',
    keys_help: 'Sign in to Alpaca, switch to your Paper account, then API Keys, Generate New Key. '
      + 'Copy both: the secret is shown once.',
    form: [{ key: 'api_key', label: 'API key ID', type: 'text' },
           { key: 'api_secret', label: 'API secret key', type: 'password' }],
    args: ['--paper'],
    terms: { data_local_only: true, orders_by_hand_only: false,
             summary: 'Alpaca licenses its market data for your own personal, non-commercial use, so its '
               + 'prices stay on this computer.',
             url: 'https://files.alpaca.markets/disclosures/library/TermsAndConditions.pdf',
             said: 'Alpaca licenses its market data for your own personal, non-commercial use, so its '
               + 'prices stay on this computer.' } },
  { key: 'oanda', label: 'OANDA (demo account)', name: 'OANDA',
    about: 'Forex, metals, index, commodity and bond CFDs, on your own OANDA demo account.',
    keys_url: 'https://hub.oanda.com/tpa/personal_token',
    keys_help: 'Sign in to the OANDA HUB. If you also have a live account, switch to demo with the dropdown '
      + 'next to your profile name. Then Tools, API, Generate. Copy the token: OANDA does not keep it.',
    form: [{ key: 'token', label: 'API token', type: 'password' }],
    args: ['--paper'], key_name: 'API token',
    terms: { data_local_only: true, orders_by_hand_only: false,
             summary: "OANDA's prices are licensed to you alone and stay on this computer; OANDA's licence asks "
               + 'that a strategy be tested on practice first and watched while it runs on a live account.',
             url: 'https://legal.oanda.com/?code=api_licence_agreement&language=en',
             said: "OANDA's prices are licensed to you alone and stay on this computer; OANDA's licence asks "
               + 'that a strategy be tested on practice first and watched while it runs on a live account.' } },
  { key: 'capitalcom', label: 'Capital.com (demo account)', name: 'Capital.com',
    about: 'Share, index, forex and commodity CFDs, on your own Capital.com demo account.',
    keys_url: 'https://capital.com/trading/platform/',
    keys_help: 'Log in to Capital.com, turn on Settings > Two-Factor Authentication, then Settings > API '
      + 'integrations > Generate API key.',
    form: [{ key: 'api_key', label: 'API key', type: 'password' },
           { key: 'identifier', label: 'Login email', type: 'text' },
           { key: 'password', label: 'API key password', type: 'password' }],
    args: ['--paper'],
    terms: { data_local_only: true, orders_by_hand_only: true,
             summary: "Capital.com's prices are for your own trading and stay on this computer, and on a live "
               + 'account its terms have you place each order yourself.',
             url: 'https://capital.com/en-gb/terms-and-policies',
             said: "Capital.com's prices are for your own trading and stay on this computer, and on a live "
               + 'account its terms have you place each order yourself.' } },
];
// What a new engine answers the page's boot and the screen's other reads.
const ENGINE = {
  '/api/config': { lse_configured: false, hosted: false },
  '/api/health': { ok: true, version: 'test', ui_version: 1, dev: false },
  '/api/indicators': [],
  '/api/providers': [
    { name: 'userdata', title: 'My Data', timeframes: ['1m', '1h', '1d'], capabilities: ['candles', 'search'],
      configured: true, custom: false, broker: false },
    { name: 'demo', title: 'Demo (synthetic)', timeframes: ['1m', '1h', '1d'],
      capabilities: ['candles', 'quote', 'search', 'stream'], configured: true, custom: false, broker: false },
    { name: 'lse', title: 'London Strategic Edge', timeframes: ['1m', '1h', '1d'],
      capabilities: ['candles', 'search', 'stream'], configured: false, custom: false, broker: false }],
  '/api/broker/list': [
    { broker: 'paper', label: 'Paper (built-in simulator)', registered: false, unlinked: false, connected: false,
      identity: {}, armed: false, fresh: false, credential_form: [], stored_credentials: [],
      terms: { data_local_only: false, orders_by_hand_only: false }, ready: true, accounts_multi: null }],
  '/api/broker/held': { held: [] },
};
const ENGINE_IN_PAGE = `(() => {
  const ENGINE = ${JSON.stringify(ENGINE)};
  const LISTED = ${JSON.stringify(LISTED)};
  // What a block asks of this engine, kept for the tab: a data key set (key),
  // the boot's shell read held (holdShell), the broker list (list) and its
  // answer held with the examples answer (holdList), the directory (dir) and
  // its answer held (holdDir).
  let opts = {};
  try { opts = JSON.parse(sessionStorage.getItem('cs.page') || '{}') || {}; } catch (e) { opts = {}; }
  const hold = () => { let go; const p = new Promise((ok) => { go = ok; }); return [p, () => go()]; };
  const [held, release] = hold(), [shellHeld, shellGo] = hold(), [dirHeld, dirGo] = hold();
  window.__csRelease = release;
  window.__shellRelease = shellGo;
  window.__dirRelease = dirGo;
  const answer = (body, status) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(String((input && input.url) || input), location.href);
    if (url.origin !== location.origin) return answer(null, 404);
    if (url.pathname === '/api/broker/examples') { await held; return answer(LISTED, 200); }
    if (url.pathname === '/api/config' && opts.key) return answer({ ...ENGINE['/api/config'], lse_configured: true }, 200);
    if (url.pathname === '/api/workspace/shell' && opts.holdShell) { await shellHeld; return answer(null, 404); }
    if (url.pathname === '/api/broker/list' && (opts.list || opts.holdList)) {
      if (opts.holdList) await held;
      return answer(opts.list || ENGINE['/api/broker/list'], 200);
    }
    if (url.pathname === '/api/directory' && opts.dir) {
      if (opts.holdDir) await dirHeld;
      return answer(opts.dir, 200);
    }
    return Object.hasOwn(ENGINE, url.pathname) ? answer(ENGINE[url.pathname], 200) : answer(null, 404);
  };
  // nothing on this screen is read from a live socket
  window.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {}
    addEventListener() {} removeEventListener() {} };
  window.EventSource = class { constructor() { this.readyState = 2; } close() {}
    addEventListener() {} removeEventListener() {} };
})();`;
// Every frame while the screen is open: each child of its body, its box,
// and whether the sheet is at its height cap (it scrolls).
const SAMPLE = `(() => {
  window.__csFrames = [];
  const tick = () => {
    const sc = document.getElementById('conn-screen'), body = document.getElementById('cs-body');
    const card = document.getElementById('cs-card');
    if (sc && !sc.classList.contains('hidden') && body && body.children.length) {
      window.__csFrames.push({ capped: card.scrollHeight > card.clientHeight + 1,
        kids: [...body.children].map((e) => { const r = e.getBoundingClientRect();
          return { cls: String(e.className), key: e.dataset.example || '',
                   top: r.top, left: r.left, width: r.width, height: r.height }; }) });
    }
    if (!window.__csStop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

function chrome() {
  for (const p of [process.env.LSE_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
                   '/usr/bin/chromium', '/usr/bin/chromium-browser',
                   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// The page's own folder, as the engine serves it; nothing under /api/.
function serve() {
  const root = fileURLToPath(new URL('../lse_terminal/ui/static/', import.meta.url));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
                  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
  const srv = http.createServer((req, res) => {
    let p = '/api/';
    try { p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (e) { /* refused below */ }
    const f = path.join(root, p === '/' ? 'index.html' : p);
    if (p.startsWith('/api/') || !f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

// Chrome's DevTools protocol over its pipe: fd 3 in, fd 4 out, each message
// a JSON text ended by a NUL.
async function browse(exe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${dir}/profile`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--metrics-recording-only', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir } });
  let said = '';
  proc.stderr.on('data', (d) => { said = (said + d).slice(-2000); });
  const waiting = new Map();
  let buf = '', n = 0;
  proc.stdio[4].setEncoding('utf8');
  proc.stdio[4].on('data', (chunk) => {
    buf += chunk;
    for (let k = buf.indexOf('\0'); k >= 0; k = buf.indexOf('\0')) {
      const msg = JSON.parse(buf.slice(0, k));
      buf = buf.slice(k + 1);
      const w = msg.id && waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      if (msg.error) w.no(new Error(msg.error.message || JSON.stringify(msg.error))); else w.ok(msg.result);
    }
  });
  const exited = new Promise((ok) => proc.on('exit', ok));
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++n;
    waiting.set(id, { ok, no });
    proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    setTimeout(() => { if (waiting.delete(id)) no(new Error(`${method}: no answer; Chrome said: ${said}`)); }, 30000);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const on = (method, params) => send(method, params, sessionId);
  await on('Page.enable');
  await on('Runtime.enable');
  await on('Page.addScriptToEvaluateOnNewDocument', { source: ENGINE_IN_PAGE });
  const js = async (expression) => {
    const r = await on('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('in the page: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };
  const until = async (expression, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await js(expression); } catch (e) { /* the page is changing */ }
      if (v) return v;
      if (Date.now() - t0 > ms) {
        let why = '';
        try { why = await js("(document.getElementById('status') || {}).textContent || ''"); } catch (e) { /* none */ }
        throw new Error(`waited ${ms} ms for ${expression}; the page's status: ${why}`);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  return {
    js, until, on,
    async load(url) {
      await js('window.__csGone = true').catch(() => {});
      await on('Page.navigate', { url });
      await until("!window.__csGone && document.readyState === 'complete'"
                  + " && !!(document.getElementById('conn-bar') || {}).onclick");
    },
    // a press at the middle of an element, as a person presses it
    async press(id) {
      const at = await js(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await on('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await on('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
      }
    },
    // the middle of the first element a selector finds
    centre: (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})
      .getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`),
    // a press's down and its up, sent apart
    async down(at) {
      await on('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
      await on('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 });
    },
    up: (at) => on('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 }),
    async close() {
      try { await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]); } catch (e) { /* gone */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      proc.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// What moved: each element painted, from the frame it was first painted in
// to every later one (a listed row by its key; the rest by its class and
// place among its like; the line said while the list is read is replaced,
// and is not one of them). Each element's first move of each side, once.
function moves(frames) {
  const first = new Map(), out = new Map();
  frames.forEach((f, n) => {
    const seen = {};
    for (const k of f.kids) {
      if (/\bcs-wait\b/.test(k.cls)) continue;
      seen[k.cls] = (seen[k.cls] || 0) + 1;
      const id = k.key ? 'listed row ' + k.key : `"${k.cls}" #${seen[k.cls]}`;
      if (!first.has(id)) { first.set(id, [n, k]); continue; }
      const [n0, k0] = first.get(id);
      for (const side of ['top', 'left', 'width', 'height']) {
        if (Math.abs(k[side] - k0[side]) > 0.5 && !out.has(id + side)) {
          out.set(id + side, `${id}: ${side} ${k0[side].toFixed(1)} at frame ${n0} -> ${k[side].toFixed(1)} at frame ${n}`);
        }
      }
    }
  });
  return [...out.values()];
}

// A page loaded afresh at a size, with the listed rows kept or not and what
// the block asks of its engine (ENGINE_IN_PAGE's opts).
async function fresh(page, base, { width, height, kept, opts = {} }) {
  await page.on('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.load(base);
  await page.js((kept ? `localStorage.setItem('lse.cs.examples', ${JSON.stringify(JSON.stringify(LISTED))});`
                      : "localStorage.removeItem('lse.cs.examples');")
                + `sessionStorage.setItem('cs.page', ${JSON.stringify(JSON.stringify(opts))}); true`);
  await page.load(base);                       // a page just loaded
}

async function opened(page, base, { width, height, kept, opts = {}, before }) {
  await fresh(page, base, { width, height, kept, opts });
  if (before) await before();
  await page.js(SAMPLE);
  await page.press('conn-bar');                // a quick open: the answer is held
  await page.until('window.__csFrames.length >= 6');
  await page.js('window.__csRelease()');
  await page.until("(window.__csFrames.at(-1) || { kids: [] }).kids.some((k) => /\\bcs-add\\b/.test(k.cls))");
  await new Promise((r) => setTimeout(r, 400));
  await page.js('window.__csStop = true');
  return page.js('window.__csFrames');
}

// The sheet against the header: the header's bottom, the sheet's top and
// foot, the window's height, whether the sheet scrolls, and its rows' room
// on the left and on the right.
const GEOMETRY = `(() => {
  const head = document.querySelector('body > header').getBoundingClientRect();
  const card = document.getElementById('cs-card'), c = card.getBoundingClientRect();
  const rows = [...document.querySelectorAll('#cs-body > .cs-brow')].map((r) => r.getBoundingClientRect());
  return { header: head.bottom, top: c.top, bottom: c.bottom, height: innerHeight, rows: rows.length,
           scrolls: card.scrollHeight > card.clientHeight + 1,
           left: Math.min(...rows.map((r) => r.left)) - c.left,
           right: c.right - Math.max(...rows.map((r) => r.right)) };
})()`;
// What is wrong with where the sheet hangs: its top not below the header's
// bottom and the rule under it, its foot off the window, or, when it does not
// scroll, more room on one side of its rows than on the other.
function hung(g, where) {
  const out = [];
  if (!(g.top >= g.header + 1)) {
    out.push(`${where}: the sheet's top ${g.top.toFixed(1)} is not below the header's bottom ${g.header.toFixed(1)}`);
  }
  if (g.bottom > g.height + 0.5) out.push(`${where}: the sheet's foot ${g.bottom.toFixed(1)} is off the window (${g.height})`);
  if (!g.scrolls && Math.abs(g.left - g.right) > 0.5) {
    out.push(`${where}: the rows' room is ${g.left.toFixed(1)} px on the left and ${g.right.toFixed(1)} px on the right`);
  }
  return out;
}

// Every click on a row's head (by the row it was on) and every rebuild of
// the screen's body.
const PRESSES = `(() => {
  window.__csClicks = []; window.__csRebuilds = 0;
  document.addEventListener('click', (e) => {
    const h = e.target && e.target.closest && e.target.closest('#cs-body .cs-bhead');
    const r = h && h.closest('.cs-brow');
    if (h) window.__csClicks.push(r ? (r.dataset.example || r.dataset.broker) : '?');
  }, true);
  new MutationObserver((ms) => { if (ms.some((m) => m.removedNodes.length)) window.__csRebuilds += 1; })
    .observe(document.getElementById('cs-body'), { childList: true });
  return true;
})()`;
// A directory that lists one simulated venue, and an engine whose list holds
// a profile linked from a listed row.
const DIRECTORY = { v: 1, origin: '', brokers: [{ key: 'northgate', label: 'Northgate (sim)',
  tagline: 'FIX 4.4 demo venue, no key entry required', endpoint: { host: '127.0.0.1', port: 9, tls: false },
  extra: {} }] };
const LINKED = [...ENGINE['/api/broker/list'], {
  broker: 'my-oanda', label: 'OANDA (demo account)', registered: true, unlinked: false, connected: false,
  example: 'oanda', identity: { display_name: 'OANDA' }, armed: false, fresh: false, mode: 'paper',
  credential_form: [{ key: 'token', label: 'API token', type: 'password' }], stored_credentials: [],
  command_preview: ['python3', '/opt/kit/brueconnect/adapters/oanda/oanda_adapter.py', '--paper'],
  terms: { ...LISTED[1].terms }, ready: true, accounts_multi: null }];

// A quick press on a listed row's head, its down before a rebuild of the
// body and its up after it: across the engine's first answers ("answer"),
// or across the directory's ("directory"). What was opened, and which rows
// the clicks were on.
async function pressAcross(page, base, { target, across, opts = {} }) {
  await fresh(page, base, { width: 1600, height: 1000, kept: true, opts });
  await page.js(PRESSES);
  await page.press('conn-bar');
  const head = `#cs-body .cs-brow[data-example="${target}"] .cs-bhead`;
  await page.until(`!!document.querySelector(${JSON.stringify(head)})`);
  if (across === 'directory') {                 // the first answers come before the press
    await page.js('window.__csRelease()');
    await page.until("!!document.querySelector('#cs-body .cs-add')");
  }
  const at = await page.centre(head);
  const before = await page.js('window.__csRebuilds');
  await page.down(at);
  if (across === 'answer') {
    await page.js('window.__csRelease()');
    await page.until('connScreen.loaded === true');
  } else {
    await page.js('window.__dirRelease()');
    await page.until('(connScreen.dir || []).length > 0');
  }
  await new Promise((r) => setTimeout(r, 150));  // the rebuild it asks for has had its time
  const during = (await page.js('window.__csRebuilds')) - before;
  await page.up(at);
  await page.until("!!document.querySelector('#cs-body .cs-add')");
  await new Promise((r) => setTimeout(r, 300));
  return { during, ...(await page.js(`({ open: [...document.querySelectorAll('#cs-body .cs-brow.open')]
    .map((r) => r.dataset.example || r.dataset.broker), clicks: window.__csClicks,
    rows: [...document.querySelectorAll('#cs-body .cs-brow')].map((r) => r.dataset.example || r.dataset.broker) })`)) };
}

const CHROME = chrome();
if (!CHROME) {
  console.log('SKIP  5 to 8. measured in a browser: no Chrome found (set LSE_TEST_CHROME to its path)');
} else {
  await test('5. measured in a browser: no listed row moves from its first paint, at any size of the sheet', async () => {
    const srv = await serve();
    const base = `http://127.0.0.1:${srv.address().port}/`;
    const page = await browse(CHROME);
    try {
      const keys = LISTED.map((x) => x.key);
      const listedIn = (f) => f.kids.filter((k) => k.key).map((k) => k.key);
      const has = (f, cls) => f.kids.some((k) => new RegExp('\\b' + cls + '\\b').test(k.cls));
      const found = [];
      // a window where the sheet stays under its cap;
      // and a shorter one, where the rows below take the sheet past its cap
      for (const height of [1000, 800]) {
        const frames = await opened(page, base, { width: 1600, height, kept: true });
        const first = frames[0], last = frames.at(-1);
        assert.deepEqual(listedIn(first), keys, 'the first paint has the listed rows');
        assert.ok(has(first, 'cs-wait') && !has(first, 'cs-add'), 'the rows below wait at the first paint');
        assert.ok(has(last, 'cs-add') && !has(last, 'cs-wait'), 'the rows below came');
        if (height === 800) assert.ok(!first.capped && last.capped, 'the rows below took the sheet past its cap');
        for (const m of moves(frames)) found.push(`1600x${height}: ${m}`);
      }
      // none known (the first open): what is painted first holds still
      const frames = await opened(page, base, { width: 1600, height: 1000, kept: false });
      assert.deepEqual(listedIn(frames[0]), [], 'nothing where a listed row will come');
      assert.deepEqual(listedIn(frames.at(-1)), keys);
      for (const m of moves(frames)) found.push(`none known: ${m}`);
      assert.deepEqual(found, [], 'moved after its first paint:\n' + found.join('\n'));
    } finally {
      await page.close();
      srv.close();
    }
  });

  await test('6. the sheet hangs below the header at every height from 700 to 1300 px, its rows with equal room', async () => {
    const srv = await serve();
    const base = `http://127.0.0.1:${srv.address().port}/`;
    const page = await browse(CHROME);
    try {
      const found = [], seen = [];
      for (const height of [700, 760, 800, 860, 900, 960, 1000, 1080, 1140, 1200, 1300]) {
        const frames = await opened(page, base, { width: 1600, height, kept: true });
        for (const m of moves(frames)) found.push(`1600x${height}: ${m}`);
        const g = await page.js(GEOMETRY);
        seen.push(g);
        found.push(...hung(g, `1600x${height}`));
      }
      // the header with its second row, the listed rows and the rows below on the sheet
      assert.ok(seen.every((g) => g.header > 70 && g.rows >= 4), JSON.stringify(seen));
      // a taller header: the chart's toolbar under its second row
      // (shown by a rule of this test's own: without a key the page shows no chart, and its toolbar with it)
      const frames = await opened(page, base, { width: 1280, height: 860, kept: true, before: () => page.js(
        "document.head.insertAdjacentHTML('beforeend', '<style>header #controls.hidden { display: flex !important; }"
        + "</style>'); true") });
      const tall = await page.js(GEOMETRY);
      assert.ok(tall.header > seen[0].header + 20, `the toolbar made the header taller: ${JSON.stringify(tall)}`);
      for (const m of moves(frames)) found.push(`1280x860 with the toolbar: ${m}`);
      found.push(...hung(tall, '1280x860 with the toolbar'));
      // the window made shorter and taller while the sheet is open
      await opened(page, base, { width: 1600, height: 1000, kept: true });
      for (const height of [1300, 700, 1000]) {
        await page.on('Emulation.setDeviceMetricsOverride', { width: 1600, height, deviceScaleFactor: 1, mobile: false });
        await page.until(`innerHeight === ${height}`);
        await page.js('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))');
        found.push(...hung(await page.js(GEOMETRY), `resized to 1600x${height}`));
      }
      assert.deepEqual(found, [], '\n' + found.join('\n'));
    } finally {
      await page.close();
      srv.close();
    }
  });

  await test("7. a sheet opened before boot has drawn the header's second row hangs below it; no row moves", async () => {
    const srv = await serve();
    const base = `http://127.0.0.1:${srv.address().port}/`;
    const page = await browse(CHROME);
    try {
      // with a data key the section boot lands on draws a chart, and its toolbar
      // stays under the header's second row: the header grows by that row
      await fresh(page, base, { width: 1600, height: 1000, kept: true, opts: { holdShell: true, key: true } });
      assert.ok(await page.js("document.getElementById('subrail').classList.contains('hidden')"),
                'the header had not its second row when the sheet was asked for');
      const asked = await page.js("document.querySelector('body > header').getBoundingClientRect().bottom");
      await page.js(SAMPLE);
      await page.press('conn-bar');
      await new Promise((r) => setTimeout(r, 150));
      await page.js('window.__shellRelease()');      // boot lands: the header's second row comes
      await page.until("!document.getElementById('subrail').classList.contains('hidden')");
      await page.until('window.__csFrames.length >= 6');
      await page.js('window.__csRelease()');
      await page.until("(window.__csFrames.at(-1) || { kids: [] }).kids.some((k) => /\\bcs-add\\b/.test(k.cls))");
      await new Promise((r) => setTimeout(r, 400));
      await page.js('window.__csStop = true');
      const frames = await page.js('window.__csFrames');
      const g = await page.js(GEOMETRY);
      assert.ok(g.header > asked + 20, `the header grew once boot landed: ${asked} -> ${g.header}`);
      const found = [...moves(frames).map((m) => 'moved: ' + m), ...hung(g, 'boot held')];
      assert.deepEqual(found, [], '\n' + found.join('\n'));
    } finally {
      await page.close();
      srv.close();
    }
  });

  await test('8. a quick press across a rebuild of the body is taken once, on the row pressed', async () => {
    const srv = await serve();
    const base = `http://127.0.0.1:${srv.address().port}/`;
    const page = await browse(CHROME);
    try {
      const got = {
        answer: await pressAcross(page, base, { target: 'oanda', across: 'answer' }),
        directory: await pressAcross(page, base, { target: 'alpaca', across: 'directory',
                                                   opts: { dir: DIRECTORY, holdDir: true } }),
        // the page's broker list comes with the examples answer: the row is first
        // painted from the kept examples, as not set up
        linked: await pressAcross(page, base, { target: 'oanda', across: 'answer',
                                                opts: { list: LINKED, holdList: true } }),
      };
      const said = JSON.stringify(got);
      assert.deepEqual({ open: got.answer.open, clicks: got.answer.clicks }, { open: ['oanda'], clicks: ['oanda'] }, said);
      assert.deepEqual({ open: got.directory.open, clicks: got.directory.clicks },
                       { open: ['alpaca'], clicks: ['alpaca'] }, said);
      assert.ok(got.directory.rows.includes('northgate'), "the directory's row came: " + said);
      // pressed as a listed row not set up; the engine's answer shows it linked: that row opens
      assert.deepEqual({ open: got.linked.open, clicks: got.linked.clicks }, { open: ['my-oanda'], clicks: ['oanda'] }, said);
      assert.ok(got.linked.rows.includes('my-oanda') && !got.linked.rows.includes('oanda'), said);
    } finally {
      await page.close();
      srv.close();
    }
  });
}

done('test_conn_screen_still.mjs');
