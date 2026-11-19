// The desktop shell with more than one window (desktop/main.js), run here
// against a stand-in for Electron: where a new window goes, what is
// remembered and brought back, what the main window's closing does, and
// that every window follows the engine across a restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const mainSrc = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const preloadSrc = fs.readFileSync(new URL('../desktop/preload.js', import.meta.url), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const D1 = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const D2 = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

async function boot({ displays = [D1], state = null, channel = 'demo' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lse-shell-'));
  const stateFile = path.join(dir, 'window-state.json');
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  const t = { dir, stateFile, windows: [], external: [], handlers: {}, quit: 0, spawns: [], displays, timers: [], timerId: 0 };
  // the shell's short timers (its debounced save): run those due, as time passing would
  t.settle = async () => { for (let i = 0; i < 4; i++) { const due = t.timers.filter((x) => x.ms <= 1000); t.timers = t.timers.filter((x) => x.ms > 1000); for (const x of due) x.f(); await tick(); } };
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts; this.destroyed = false; this.shown = false; this.maximized = false; this.loads = [];
      this.bounds = { x: opts.x ?? 100, y: opts.y ?? 100, width: opts.width, height: opts.height };
      this.placedByOs = opts.x === undefined;
      const w = this;
      this.webContents = Object.assign(new EventEmitter(), {
        url: '', opener: null, sent: [],
        setWindowOpenHandler(fn) { this.opener = fn; }, getURL() { return this.url; },
        send(ch, v) { this.sent.push([ch, v]); }, reload() { w.loads.push('reload'); },
        session: { clearCache: async () => {} },
        capturePage: async () => ({ toPNG: () => Buffer.from('png of ' + w.lseId) }),
      });
      t.windows.push(this);
    }
    static fromWebContents(wc) { return t.windows.find((w) => w.webContents === wc) || null; }
    loadURL(url) { this.loads.push(url); this.webContents.url = url; setImmediate(() => { this.emit('ready-to-show'); this.webContents.emit('did-navigate'); }); return Promise.resolve(); }
    show() { this.shown = true; } maximize() { this.maximized = true; } isMaximized() { return this.maximized; }
    isFullScreen() { return false; } isMinimized() { return false; } restore() {} focus() { this.focused = true; } setTitle(v) { this.title = v; }
    getBounds() { return this.maximized ? { ...t.displays[0].workArea, ...this.maxOn } : { ...this.bounds }; }
    getNormalBounds() { return { ...this.bounds }; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    close() { if (this.destroyed) return; this.emit('close'); this.destroy(); }   // the user's X
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, getPath: () => dir, getVersion: () => '0.1.10', getAppPath: () => dir,
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), quit() { t.quit++; app.emit('before-quit'); },
  });
  const electron = { app, BrowserWindow, Menu: {}, dialog: { showErrorBox: (a, b) => { t.errorBox = b; } },
    shell: { openExternal: (u) => t.external.push(u) }, nativeTheme: {},
    ipcMain: { handle: (name, fn) => { t.handlers[name] = fn; } },
    screen: { getAllDisplays: () => t.displays,
      getDisplayMatching: (b) => t.displays.find((d) => b.x >= d.workArea.x && b.x < d.workArea.x + d.workArea.width) || t.displays[0] } };
  const fakes = {
    electron,
    child_process: { spawn: (cmd, args) => { const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.killed = true; }, args }); t.spawns.push(p); return p; },
                     execFileSync: () => '' },
    http: { get: (o, cb) => { const req = new EventEmitter(); req.destroy = () => {};
      setImmediate(() => { const res = new EventEmitter(); res.statusCode = o.path === '/api/health' ? 200 : 404; res.resume = () => {}; res.setEncoding = () => {};
        cb(res); setImmediate(() => res.emit('end')); }); return req; } },
    net: { createServer: () => { const s = new EventEmitter(); s.listen = () => setImmediate(() => s.emit('listening')); s.close = (cb) => { if (cb) cb(); }; return s; } },
    // a home of the test's own: the shell keeps the assistant's snapshot under ~/.config
    path, fs, os: { ...os, homedir: () => dir }, './package.json': { lseChannel: channel }, 'electron-updater': {},
  };
  const sandbox = { require: (n) => { if (!(n in fakes)) throw new Error('unexpected require ' + n); return fakes[n]; },
    __dirname: dir, process: { platform: 'win32', resourcesPath: dir, env: { PATH: '' } }, console, Buffer, URL, URLSearchParams, Promise, JSON, Math, Number, String, Object, Array, Set, Map, Date,
    setTimeout: (f, ms) => { const id = ++t.timerId; t.timers.push({ id, f, ms }); return id; }, setInterval: () => 0,
    clearTimeout: (id) => { t.timers = t.timers.filter((x) => x.id !== id); } };
  vm.createContext(sandbox);
  vm.runInContext(mainSrc, sandbox);
  await tick();
  t.app = app; t.live = () => t.windows.filter((w) => !w.destroyed);
  t.saved = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  t.open = async (from, view) => { const out = plain(await t.handlers['lse-window-open']({ sender: from.webContents }, view)); await tick(); return out; };
  return t;
}

// ── a first launch is one window, as it always was ──
{
  const t = await boot();
  assert.equal(t.windows.length, 1);
  const main = t.windows[0];
  assert.deepEqual(main.loads, ['http://127.0.0.1:7799/']);
  assert.equal(main.shown, true); assert.equal(main.lseId, 'main');
  assert.deepEqual([main.opts.width, main.opts.height, main.opts.minWidth], [1440, 900, 980]);
  assert.equal(main.opts.webPreferences.contextIsolation, true); assert.equal(main.opts.webPreferences.nodeIntegration, false);
  main.close(); await tick();
  assert.equal(t.quit >= 0, true);
  assert.deepEqual(t.saved().windows, []);
  console.log('One window: the plain page on the engine, isolated, remembered on close.');
}

// ── a new window goes to the monitor that has none, filling it; the next steps off its opener ──
{
  const t = await boot({ displays: [D1, D2] });
  const main = t.windows[0];
  assert.deepEqual(await t.open(main, 'workspace/sub-ws-dash'), { ok: true, reason: '' });
  const w2 = t.windows[1];
  assert.equal(w2.lseId, 'w2');
  assert.deepEqual(w2.loads, ['http://127.0.0.1:7799/?win=w2&view=workspace%2Fsub-ws-dash']);
  assert.ok(w2.bounds.x >= D2.workArea.x && w2.bounds.x + w2.bounds.width <= D2.workArea.x + D2.workArea.width, 'not on the free monitor');
  assert.equal(w2.maximized, true); assert.equal(w2.shown, true);
  w2.maxOn = { x: D2.workArea.x };
  assert.equal(w2.opts.webPreferences.preload, main.opts.webPreferences.preload);
  await t.open(w2, 'econ/sub-ec-yields');
  const w3 = t.windows[2];
  assert.equal(w3.lseId, 'w3'); assert.equal(w3.maximized, false);
  assert.deepEqual([w3.bounds.x - w2.bounds.x, w3.bounds.y - w2.bounds.y], [36, 36]);
  // the page moved on in window 2; then the user closes the main window
  w2.webContents.url = 'http://127.0.0.1:7799/?win=w2&view=workspace%2Fsub-ws-ide';
  main.close(); await tick();
  assert.ok(t.windows.every((w) => w.destroyed), 'closing the main window left a window open');
  const s = t.saved();
  assert.deepEqual([s.x, s.y, s.width, s.height, s.maximized], [100, 100, 1440, 900, false]);
  assert.deepEqual(s.windows.map((w) => [w.id, w.view, w.maximized]),
    [['w2', 'workspace/sub-ws-ide', true], ['w3', 'econ/sub-ec-yields', false]]);

  // ── the next launch brings every window back where it was ──
  const again = await boot({ displays: [D1, D2], state: s });
  assert.deepEqual(again.windows.map((w) => w.lseId), ['main', 'w2', 'w3']);
  assert.deepEqual(again.windows[1].loads, ['http://127.0.0.1:7799/?win=w2&view=workspace%2Fsub-ws-ide']);
  assert.deepEqual(again.windows[2].loads, ['http://127.0.0.1:7799/?win=w3&view=econ%2Fsub-ec-yields']);
  assert.equal(again.windows[1].maximized, true);
  assert.deepEqual(again.windows[1].bounds, w2.bounds);
  // ── with the second monitor unplugged, a window remembered there opens where it can be reached ──
  const moved = await boot({ displays: [D1], state: s });
  assert.equal(moved.windows[1].placedByOs, true, 'a window was opened on a monitor that is gone');
  assert.equal(moved.windows[0].placedByOs, false);
  console.log('Two monitors: placed on the free one, remembered with its view, brought back, and moved when the monitor is gone.');
}

// ── the arrangement is kept as it changes, so a main window that goes WITHOUT a close event loses nothing ──
{
  const t = await boot({ displays: [D1, D2] });
  const main = t.windows[0];
  await t.open(main, 'workspace/sub-ws-dash'); await t.settle();
  assert.deepEqual(t.saved().windows.map((w) => [w.id, w.view]), [['w2', 'workspace/sub-ws-dash']], 'a new window was not written down');
  // the page changes its view (a same-page navigation), the user moves the main window
  t.windows[1].webContents.url = 'http://127.0.0.1:7799/?win=w2&view=research%2Fsub-rs-models';
  t.windows[1].webContents.emit('did-navigate-in-page');
  main.bounds = { x: 300, y: 200, width: 1500, height: 880 }; main.emit('move'); main.emit('resize');
  await t.settle();
  assert.deepEqual([t.saved().x, t.saved().width, t.saved().windows[0].view], [300, 1500, 'research/sub-rs-models']);
  // the main window is gone with no `close` (a close begun inside the page): everything closes, nothing is forgotten
  main.destroy(); await tick(); await t.settle();
  assert.ok(t.windows.every((w) => w.destroyed));
  assert.deepEqual(t.saved().windows.map((w) => [w.id, w.view]), [['w2', 'research/sub-rs-models']]);
  const again = await boot({ displays: [D1, D2], state: t.saved() });
  assert.deepEqual(again.windows.map((w) => w.lseId), ['main', 'w2']);
  assert.equal(again.windows[1].loads[0], 'http://127.0.0.1:7799/?win=w2&view=research%2Fsub-rs-models');
  console.log('The arrangement is written as it changes: a main window that goes without a close event loses nothing.');
}

// ── a window the user closes is not brought back; the app runs on ──
{
  const t = await boot({ displays: [D1, D2] });
  const main = t.windows[0];
  await t.open(main, 'workspace'); await t.open(main, 'research');
  t.windows[1].close(); await tick();
  assert.equal(t.quit, 0); assert.equal(main.destroyed, false);
  assert.deepEqual(t.saved().windows.map((w) => w.id), ['w3']);
  // its name is free again
  await t.open(main, 'markets');
  assert.deepEqual(t.live().map((w) => w.lseId), ['main', 'w3', 'w2']);
  // quitting from the taskbar remembers all that are open
  t.app.quit(); await tick();
  assert.deepEqual(t.saved().windows.map((w) => w.id).sort(), ['w2', 'w3']);
}

// ── window.open: the terminal's own page is another window; everything else is the user's browser ──
{
  const t = await boot();
  const main = t.windows[0];
  assert.deepEqual(plain(main.webContents.opener({ url: 'http://127.0.0.1:7799/?win=w9x&view=markets%2Fsub-mk-options' })), { action: 'deny' });
  await tick();
  assert.deepEqual(t.windows[1].loads, ['http://127.0.0.1:7799/?win=w2&view=markets%2Fsub-mk-options']);
  for (const url of ['https://londonstrategicedge.com/data', 'http://127.0.0.1:7799/api/research/pdf?id=1', 'http://127.0.0.1:9999/',
                     'http://localhost:7799/', 'https://127.0.0.1:7799/', 'not a url']) {
    assert.deepEqual(plain(main.webContents.opener({ url })), { action: 'deny' });
  }
  assert.equal(t.windows.length, 2, 'an address that is not the terminal\'s page opened a window');
  assert.equal(t.external.length, 6);
  // a new window answers window.open the same way
  t.windows[1].webContents.opener({ url: 'https://github.com/londonstrategicedge/lse-terminal' });
  assert.equal(t.external.length, 7);
  console.log('window.open: the terminal\'s own page opens a window; six other addresses went to the browser.');
}

// ── a ceiling on windows, and a view's text is not trusted ──
{
  const t = await boot();
  const main = t.windows[0];
  for (let i = 0; i < 8; i++) assert.equal((await t.open(main, 'markets')).ok, true);
  assert.deepEqual(await t.open(main, 'markets'), { ok: false, reason: 'limit' });
  assert.equal(t.live().length, 9);
  t.windows[3].close(); await tick();
  const out = await t.open(main, 'x'.repeat(500) + '&win=main#');
  assert.equal(out.ok, true);
  const url = new URL(t.windows.at(-1).loads[0]);
  assert.equal(url.searchParams.get('win'), 'w4'); assert.equal(url.searchParams.get('view').length, 80);
  assert.deepEqual(plain(await t.handlers['lse-window-open']({ sender: main.webContents }, { toString() { throw new Error('x'); } })), { ok: false, reason: 'limit' });
}

// ── a remembered state from an older shell, or a damaged one, still opens the app ──
for (const state of [{ x: 40, y: 50, width: 1200, height: 800 }, { width: 5, height: 5 }, [1, 2], 'text', { x: 'a', windows: 'no' },
                     { x: 10, y: 10, width: 1300, height: 800, windows: [null, 7, { id: '../x', view: 5, x: 1e9, y: 1e9 }, { id: 'w2' }, { id: 'w2' }] }]) {
  const t = await boot({ state });
  assert.equal(t.errorBox, undefined);
  assert.equal(t.windows[0].shown, true);
  assert.ok(t.windows[0].opts.width >= 980 && t.windows[0].opts.height >= 600);
  assert.ok(t.windows.every((w) => /^(main|w[0-9]+)$/.test(w.lseId)));
  assert.equal(new Set(t.windows.map((w) => w.lseId)).size, t.windows.length, 'two windows share a name');
}
{
  const old = await boot({ state: { x: 40, y: 50, width: 1200, height: 800 } });
  assert.deepEqual([old.windows[0].opts.x, old.windows[0].opts.y, old.windows[0].opts.width], [40, 50, 1200]);
}

// ── every window follows the engine across a restart, each on its view ──
{
  const t = await boot({ displays: [D1, D2] });
  const main = t.windows[0];
  await t.open(main, 'workspace/sub-ws-dash');
  main.webContents.url = 'http://127.0.0.1:7799/?view=econ%2Fsub-ec-cal';
  t.spawns[0].emit('exit', 1);
  for (let i = 0; i < 6; i++) { const due = t.timers.splice(0); for (const x of due) x.f(); await tick(); }   // the restart's back-off and the health wait
  assert.equal(t.spawns.length, 2, 'the engine was not started again');
  assert.equal(main.loads.at(-1), 'http://127.0.0.1:7799/?view=econ%2Fsub-ec-cal');
  assert.equal(t.windows[1].loads.at(-1), 'http://127.0.0.1:7799/?win=w2&view=workspace%2Fsub-ws-dash');
  // a snapshot for the assistant is of the window that asked
  const shot = await t.handlers['lse-capture']({ sender: t.windows[1].webContents });
  assert.equal(shot.ok, true);
  const png = path.join(t.dir, '.config', 'lse-terminal-demo', 'ai-workspace', 'chart.png');
  assert.equal(fs.readFileSync(png, 'utf8'), 'png of w2');
  console.log('Engine restart: every window reloads on its own view; a snapshot is of the window that asked.');
}

// ── the bridge the page calls ──
assert.match(preloadSrc, /openWindow: \(view\) => ipcRenderer\.invoke\("lse-window-open", String\(view \|\| ""\)\)/);
assert.match(mainSrc, /ipcMain\.handle\("lse-window-open"/);
console.log('Shell windows: all scenarios pass.');
