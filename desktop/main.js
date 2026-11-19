// LSE Terminal desktop shell: a native window around the local terminal
// engine. The shell owns the engine sidecar's lifecycle:
// spawn on a free localhost port, wait for /api/health, show the window,
// kill the sidecar on quit. No browser chrome, single instance, window
// bounds remembered across runs.
//
// More than one window: the terminal can be spread over monitors. The main
// window is the app (closing it closes everything); the page's NEW WINDOW
// button, or a Ctrl-click on one of its tabs, asks for another window on the
// same engine, showing the view it names. Every window's place and view is
// remembered and comes back at the next launch.
const { app, BrowserWindow, Menu, dialog, shell, nativeTheme, ipcMain, screen } = require("electron");

// The native Windows title bar follows the OS theme and shipped white, which
// clashed with the near-black app chrome. Pro-terminal black top bar: pin
// the frame to dark regardless of the OS setting. The page's own light/dark
// toggle is class-driven (html.dark + localStorage), not media-query driven,
// so forcing prefers-color-scheme dark here does not affect the in-app theme.
nativeTheme.themeSource = "dark";

// The UI comes from the local sidecar over HTTP; Chromium's disk cache can
// otherwise keep serving a PREVIOUS install's files after an update (it
// survives reinstalls because the cache lives in userData). Locally served
// bytes are free; never cache them.
app.commandLine.appendSwitch("disable-http-cache");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Release channel, stamped into package.json at build time (extraMetadata
// in build-win.ps1 / build-mac.sh). The demo channel is LSE DEMO TERMINAL:
// the same code as a separate app that lives next to the public install,
// so it gets its own window title and its own engine config folder (key,
// workspace, imports, chats), never the public app's.
const CHANNEL = (() => { try { return require("./package.json").lseChannel || "public"; } catch { return "public"; } })();
const IS_DEMO = CHANNEL === "demo";
const APP_TITLE = IS_DEMO ? "LSE Demo Terminal" : "LSE Terminal";
// Same path the engine's config_dir() resolves on every OS; the demo app
// hands its own folder to the engine through LSE_TERMINAL_CONFIG_DIR.
const CONFIG_DIR = path.join(os.homedir(), ".config", IS_DEMO ? "lse-terminal-demo" : "lse-terminal");

let sidecar = null;
let win = null;                 // the main window
const extras = new Map();       // id ("w2", "w3", ...) -> the other windows
const MAX_EXTRA_WINDOWS = 8;
let stateSaved = false;         // the closing-down save is made once

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

// window-state.json: the main window's bounds at the top level (as every
// earlier version wrote them, so an older shell still reads its own part),
// plus `maximized` and `windows`, one {id, x, y, width, height, maximized,
// view} per other window open when the app closed.
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return s && typeof s === "object" ? s : { width: 1440, height: 900 };
  } catch { return { width: 1440, height: 900 }; }
}

function allWindows() {
  return [win, ...extras.values()].filter((w) => w && !w.isDestroyed());
}

// A maximized window is remembered by the bounds it returns to, so it comes
// back maximized on the same monitor and restores to the size it had.
function boundsOf(w) {
  const b = w.isMaximized() || w.isFullScreen() ? w.getNormalBounds() : w.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// The view a window shows: the page keeps it in its own address (?view=).
function viewOf(w) {
  try { return new URL(w.webContents.getURL()).searchParams.get("view") || ""; }
  catch { return ""; }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const state = { ...boundsOf(win), maximized: win.isMaximized(), windows: [] };
    for (const [id, w] of extras) {
      if (w.isDestroyed()) continue;
      state.windows.push({ id, ...boundsOf(w), maximized: w.isMaximized(), view: viewOf(w) });
    }
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch { /* best effort */ }
}

// The arrangement is written as it changes (a window moved, resized, opened
// or closed, a view changed), a moment after the change, and once more as
// the app closes. It must not hang on the main window's `close` event
// alone: a window can go without one (a close that starts inside the page,
// a renderer that dies), and the arrangement of the last hour would go
// with it.
let saveTimer = null;
function scheduleSave() {
  if (stateSaved || app.isQuitting) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!stateSaved && !app.isQuitting) saveWindowState();
  }, 400);
}

// Is enough of these bounds on a monitor that is connected now? A window
// remembered on a monitor since unplugged must not open where nobody can
// reach it.
function onScreen(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= 200 && h >= 120;
  });
}

// Remembered bounds made safe to open at: the remembered place when it is
// still on a monitor, else only the size (the OS then centres the window).
function placed(saved) {
  const size = (v, lo, fallback) => (Number.isFinite(v) ? Math.max(lo, Math.min(16000, Math.round(v))) : fallback);
  const width = size(saved && saved.width, 980, 1440), height = size(saved && saved.height, 600, 900);
  const at = { x: Math.round(saved && saved.x), y: Math.round(saved && saved.y), width, height };
  return onScreen(at) ? at : { width, height };
}

// Where a new window goes: filling a monitor that has none of the
// terminal's windows yet (the reason to open one), else a step down and
// right of the window it was opened from.
function newWindowBounds(opener) {
  const used = new Set(allWindows().map((w) => screen.getDisplayMatching(w.getBounds()).id));
  const free = screen.getAllDisplays().find((d) => !used.has(d.id));
  if (free) {
    const a = free.workArea;
    const width = Math.min(1440, a.width), height = Math.min(900, a.height);
    return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2),
             width, height, maximized: true };
  }
  const from = opener && !opener.isDestroyed() ? boundsOf(opener) : { x: 80, y: 80, width: 1440, height: 900 };
  const a = screen.getDisplayMatching(from).workArea;
  const width = Math.min(from.width, a.width), height = Math.min(from.height, a.height);
  let x = from.x + 36, y = from.y + 36;
  if (x + width > a.x + a.width) x = a.x;
  if (y + height > a.y + a.height) y = a.y;
  return { x, y, width, height };
}

// The address a window loads: the main window is the plain page; another
// window names itself and its view, and the page opens on that view.
function windowUrl(id, view) {
  const q = new URLSearchParams();
  if (id !== "main") q.set("win", id);
  if (view) q.set("view", view);
  const qs = q.toString();
  return `http://127.0.0.1:${currentPort}/` + (qs ? "?" + qs : "");
}

// Dev override: a ~/.lse-terminal-dev.json file ({"command": ..., "args":
// [...], "cwd": ...}) makes the shell run the engine from SOURCE instead of
// the frozen bundle, so code synced to that source tree goes live without a
// rebuild. Delete the file to return to the packaged engine.
function devConfig() {
  try {
    const p = path.join(require("os").homedir(), ".lse-terminal-dev.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

// Packaged: resources/sidecar/lset-server/<exe> (PyInstaller onedir).
// Dev tree: prefer a local frozen build in desktop/sidecar, else the venv.
function sidecarCommand() {
  const dev = devConfig();
  if (dev && dev.command) {
    return { cmd: dev.command, args: dev.args || [], cwd: dev.cwd, dev: true };
  }
  const exe = process.platform === "win32" ? "lset-server.exe" : "lset-server";
  const packaged = path.join(process.resourcesPath, "sidecar", "lset-server", exe);
  if (app.isPackaged) return { cmd: packaged, args: [] };
  const devFrozen = path.join(__dirname, "sidecar", "lset-server", exe);
  if (fs.existsSync(devFrozen)) return { cmd: devFrozen, args: [] };
  const devLset = path.join(__dirname, "..", ".venv", "bin", "lset");
  return { cmd: devLset, args: [] };
}

// macOS only: an app launched from Finder inherits launchd's minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), NOT the PATH the user sees in Terminal.
// The engine resolves several tools by name through it: the AI panel's
// `claude` and `codex` binaries, and the real python3 that broker adapters
// are spawned with. Without this, a Homebrew / npm-global / ~/.local/bin
// install is invisible to the downloaded app while working perfectly from a
// shell, which reads as "the app says Claude is not installed" with no clue
// why. Windows and Linux GUI launches already inherit the user's PATH, so
// this is darwin-only.
function fixMacPath() {
  if (process.platform !== "darwin") return;
  const parts = [];
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    // -lc, not -ilc: a LOGIN shell sources .zprofile / .bash_profile, which
    // is where Homebrew's shellenv line lands, without the interactive rc
    // files that can prompt or hang. Bounded by a timeout so a broken shell
    // profile can never delay the app's boot.
    const out = require("child_process").execFileSync(
      shell, ["-lc", "printf %s \"$PATH\""],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    // FIRST, ahead of what we inherited: the dedup below keeps the first
    // occurrence of each entry, so the user's own ordering wins. That
    // matters because the launchd PATH leads with /usr/bin, where the
    // /usr/bin/python3 Command Line Tools shim (3.9) sits; a Homebrew
    // python3 must outrank it exactly as it does in the user's Terminal.
    parts.push(...out.split(":").filter(Boolean));
  } catch { /* no login-shell PATH: the known homes below still apply */ }
  parts.push(...(process.env.PATH || "").split(":").filter(Boolean));
  // Union in the usual homes regardless, so a missing or unusual shell
  // profile still leaves a working PATH rather than the launchd minimum.
  parts.push("/opt/homebrew/bin", "/usr/local/bin",
             path.join(require("os").homedir(), ".local", "bin"),
             "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  process.env.PATH = [...new Set(parts)].join(":");
}

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1000 }, (res) => {
        if (res.statusCode === 200) return resolve();
        res.resume();
        retry();
      }).on("error", retry).on("timeout", function () { this.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error("engine did not start in time"));
      setTimeout(poll, 250);
    };
    poll();
  });
}

// Preferred engine port. Not guaranteed: anything can already be sitting on
// 7799 (a leftover engine from a session that died without cleanup, or an
// unrelated program), and the engine exits immediately on a bind failure.
// That turned into a 5-crash loop and a fatal "stopped repeatedly (code 1)"
// dialog, so the shell now probes for a genuinely free port
// before every spawn instead of assuming 7799.
const PREFERRED_PORT = 7799;
let currentPort = PREFERRED_PORT;
let engineRestarts = 0;

// The engine's stdout/stderr used to go into an unread pipe, which made every
// crash blind (the reopened-app dialog carried only an exit code). Keep the
// full output in userData/engine.log (fresh each app session) and a tail in
// memory for the error dialogs.
let engineOut = "";
let engineLogStream = null;
const engineLogPath = () => path.join(app.getPath("userData"), "engine.log");

function recordEngineOutput(chunk) {
  const s = String(chunk);
  engineOut = (engineOut + s).slice(-65536);
  if (!engineLogStream) {
    try { engineLogStream = fs.createWriteStream(engineLogPath(), { flags: "w" }); }
    catch { engineLogStream = false; } // unwritable userData: keep the in-memory tail only
  }
  if (engineLogStream) engineLogStream.write(s);
}

function engineOutTail() {
  const t = engineOut.trim();
  return t ? `\n\nEngine output (also in ${engineLogPath()}):\n${t.slice(-800)}` : "";
}

// Find a port we can actually bind, starting at the preferred one. If every
// candidate is taken (wildly unlikely), fall back to the start port so the
// spawn still happens and the bind error lands in engine.log.
function findFreePort(start, tries) {
  return new Promise((resolve) => {
    const attempt = (port, left) => {
      const probe = net.createServer();
      probe.once("error", () => {
        probe.close();
        if (left > 1) attempt(port + 1, left - 1); else resolve(start);
      });
      probe.once("listening", () => probe.close(() => resolve(port)));
      probe.listen(port, "127.0.0.1");
    };
    attempt(start, tries);
  });
}

// Auto-update: releases live at terminal.londonstrategicedge.com/releases/
// (the generic provider URL in package.json "publish"; electron-builder
// bakes it into resources/app-update.yml). electron-updater cache-busts
// latest.yml itself and the origin serves it Cache-Control: no-store, so a
// new release is seen on the very next check, never a stale cached copy.
// Downloads happen in the background; the user picks restart-now or
// next-quit (autoInstallOnAppQuit), so an update can never block work.
let autoUpdater = null;   // null = this build has no updater (dev, mac, no dep)
// Mirrored to the page so the header's UPDATE button can BE the restart
// action instead of the app interrupting with a modal.
const updateState = { phase: "idle", pct: 0, latest: "", available: false };

function sendUpdateState() {
  for (const w of allWindows()) w.webContents.send("lse-update-state", updateSnapshot());
}

function updateSnapshot() {
  return { ...updateState, current: app.getVersion(), supported: !!autoUpdater };
}

function setupAutoUpdate() {
  if (!app.isPackaged) return; // dev runs update from source instead
  // macOS updates run through Squirrel.Mac, which only accepts a signed app
  // and needs latest-mac.yml on the feed; both hold since the Developer ID
  // signed + notarized builds, so mac now checks like Windows does. The
  // 'error' handler below keeps a missing feed or an offline check harmless.
  try { ({ autoUpdater } = require("electron-updater")); }
  catch (e) { autoUpdater = null; return; } // build without the dep: plain app
  // Private-shelf builds bake a requestHeaders block into app-update.yml
  // (the X-LSE-Feed token nginx maps to auth off). electron-updater only
  // adopts requestHeaders when setFeedURL() is called with an options
  // object; the block in the on-disk yml is never read, so every check
  // went out bare and the shelf answered 401 (seen in the origin log for
  // every launch). Lift the block onto the updater ourselves. The yml is
  // two-level and written by electron-builder, so a line parser is enough;
  // any failure here leaves the headers unset, which is the public-feed case.
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    const headers = {};
    let inBlock = false;
    for (const line of yml.split(/\r?\n/)) {
      if (/^requestHeaders:\s*$/.test(line)) { inBlock = true; continue; }
      if (inBlock) {
        const m = /^\s+([^:\s][^:]*):\s*(.+?)\s*$/.exec(line);
        if (m) { headers[m[1]] = m[2].replace(/^["']|["']$/g, ""); continue; }
        inBlock = false;
      }
    }
    if (Object.keys(headers).length) autoUpdater.requestHeaders = headers;
  } catch (e) { /* no yml or unreadable: public feed needs no headers */ }
  // A failed check must never take the app down; offline is normal. The
  // button just stays on whatever it last knew.
  autoUpdater.on("error", () => {
    // A failed check or a download that dies mid-way both go back to idle,
    // so the next check can start; "downloading" used to stick for good.
    if (updateState.phase === "checking" || updateState.phase === "downloading") updateState.phase = "idle";
    sendUpdateState();
  });
  // Updates apply themselves, no click required to stay current:
  // a newer build on the feed is downloaded in the background as soon as the
  // check sees it, and installs on the next quit/launch without anyone
  // clicking. The header still shows the progress and turns into RESTART so
  // a user who wants it now can take it now; clicking is optional, not
  // required.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    updateState.available = true;
    updateState.latest = info.version || "";
    // autoDownload is on, so "available" immediately means "downloading".
    updateState.phase = "downloading";
    sendUpdateState();
  });
  autoUpdater.on("update-not-available", () => {
    updateState.available = false;
    updateState.phase = "idle";
    sendUpdateState();
  });
  autoUpdater.on("download-progress", (p) => {
    updateState.phase = "downloading";
    updateState.pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
    sendUpdateState();
  });
  // No modal here: the header button turns into RESTART and the user picks
  // the moment. If they never click, autoInstallOnAppQuit lands it anyway.
  autoUpdater.on("update-downloaded", (info) => {
    updateState.available = true;
    updateState.latest = info.version || updateState.latest;
    updateState.phase = "ready";
    updateState.pct = 100;
    sendUpdateState();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline is fine */ });
  check();
  // Long-running terminals still pick updates up the same day.
  setInterval(check, 4 * 3600 * 1000);
}

// The header UPDATE button's two calls. check() is also how the page learns
// the SHELL's version: the installer is what an update replaces, so the
// electron app version, not the python package's, is "what you run" here.
ipcMain.handle("lse-update-check", () => {
  if (autoUpdater && updateState.phase !== "downloading" && updateState.phase !== "ready") {
    autoUpdater.checkForUpdates().catch(() => {});
  }
  return updateSnapshot();
});

ipcMain.handle("lse-update-install", () => {
  if (!autoUpdater) return { ok: false, reason: "unsupported" };
  if (updateState.phase === "ready") {
    // (true, true) = silent NSIS install + relaunch; the default would
    // open the assisted-install wizard (oneClick: false) mid-restart.
    app.isQuitting = true;
    autoUpdater.quitAndInstall(true, true);
    return { ok: true, action: "restart" };
  }
  // Not downloaded yet: a check starts the background download (autoDownload)
  // and the progress events drive the button to RESTART.
  autoUpdater.checkForUpdates().catch(() => {});
  return { ok: true, action: "download" };
});

// Spawn the engine sidecar. If it dies while the app is open, restart it in
// place (up to a cap) instead of killing the whole window. A one-off engine
// hiccup should never close the app the user is working in.
function spawnSidecar() {
  const { cmd, args, cwd, dev } = sidecarCommand();
  // [shell] lines interleave the shell's own lifecycle into engine.log; a
  // crash that produces no engine output at all (spawn failure, instant
  // death) still leaves evidence of what was attempted.
  recordEngineOutput(`[shell] spawn attempt ${engineRestarts}: ${cmd} port=${currentPort}\n`);
  sidecar = spawn(cmd, [...args, "--no-browser", "--port", String(currentPort)], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: cwd || undefined,
    env: { ...process.env, ...(dev ? { LSE_TERMINAL_DEV: "1" } : {}),
           // The engine reads the channel too (the demo app fetches the
           // staging directory, see broker_hub.DIRECTORY_URL).
           LSE_TERMINAL_CHANNEL: CHANNEL,
           ...(IS_DEMO ? { LSE_TERMINAL_CONFIG_DIR: CONFIG_DIR } : {}) },
  });
  sidecar.on("error", (e) => recordEngineOutput(`[shell] spawn error: ${e}\n`));
  // Drain the pipes: an unread pipe can fill and stall the engine, and the
  // output is the only evidence when it dies.
  sidecar.stdout.on("data", recordEngineOutput);
  sidecar.stderr.on("data", recordEngineOutput);
  sidecar.on("exit", async (code) => {
    recordEngineOutput(`[shell] engine exited code=${code}\n`);
    sidecar = null;
    if (app.isQuitting || !win) return;
    if (engineRestarts < 5) {
      engineRestarts += 1;
      // Back off before respawning: an instant respawn races the dying
      // predecessor for its still-held socket, which used to burn all 5
      // attempts on bind errors within a second.
      await new Promise((r) => setTimeout(r, 500 * engineRestarts));
      if (app.isQuitting || !win) return;
      currentPort = await findFreePort(currentPort, 20);
      spawnSidecar();
      // Point every window at the restarted engine (the port may have
      // moved), each back on the view it showed.
      waitForHealth(currentPort, 30000)
        .then(() => { for (const w of allWindows()) w.loadURL(windowUrl(w.lseId, viewOf(w))).catch(() => {}); })
        .catch(() => {});
    } else {
      dialog.showErrorBox(APP_TITLE,
        `The terminal engine stopped repeatedly (code ${code}). ` +
        `Please reopen the app.${engineOutTail()}`);
      app.quit();
    }
  });
}

// Vision (Phase 3): snapshot this window into the agent workspace so the
// AI panel's agents can literally see the chart the user sees. The UI asks
// for a fresh capture right before each agent turn (preload.js bridge);
// one is also taken shortly after boot so a first turn never finds nothing.
const AI_WS = path.join(CONFIG_DIR, "ai-workspace");

// Whether the engine allows a snapshot now. A broker's terms can keep its
// prices on this computer (Brue Connect SPEC 3.3), and a picture of the window
// reproduces them, so while such a broker may be on screen the engine says no,
// with the sentence why, and removes any older snapshot itself. An engine from
// before the rule answers 404 and the shell captures as it always did; an
// engine that does not answer gets no snapshot this time.
function captureAllowed() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: currentPort,
                           path: "/api/ai/capture-allowed", timeout: 1500 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode === 404) return resolve({ allowed: true });
        if (res.statusCode !== 200) return resolve({ allowed: false, reason: `engine answered ${res.statusCode}` });
        try {
          const d = JSON.parse(body);
          resolve({ allowed: d.allowed === true, reason: d.reason || "" });
        } catch (e) {
          resolve({ allowed: false, reason: "engine answer unreadable" });
        }
      });
    });
    req.on("error", () => resolve({ allowed: false, reason: "engine not answering" }));
    req.on("timeout", () => { req.destroy(); resolve({ allowed: false, reason: "engine not answering" }); });
  });
}

async function captureToWorkspace(target) {
  // The window that asked (the one whose assistant is about to answer);
  // the main window for the snapshot taken at boot.
  const open = (w) => !!w && !(typeof w.isDestroyed === "function" && w.isDestroyed());
  const shot = open(target) ? target : win;
  if (!open(shot)) return { ok: false };
  const gate = await captureAllowed();
  if (!gate.allowed) {
    // Nothing written. An older snapshot is removed too, so no agent reads a
    // picture the terms keep on this computer.
    try { fs.rmSync(path.join(AI_WS, "chart.png"), { force: true }); } catch (e) { /* nothing there */ }
    return { ok: false, withheld: true, error: gate.reason };
  }
  try {
    const img = await shot.webContents.capturePage();
    fs.mkdirSync(AI_WS, { recursive: true });
    // Write-then-rename: an agent reading mid-capture must never see a
    // half-written PNG.
    const tmp = path.join(AI_WS, "chart.png.tmp");
    fs.writeFileSync(tmp, img.toPNG());
    fs.renameSync(tmp, path.join(AI_WS, "chart.png"));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
ipcMain.handle("lse-capture", (event) => captureToWorkspace(BrowserWindow.fromWebContents(event.sender)));

// One window of the terminal. `id` is "main" or an extra's name.
function makeWindow(id, bounds) {
  const b = bounds || {};
  const w = new BrowserWindow({
    ...(Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x, y: b.y } : {}),
    width: b.width || 1440,
    height: b.height || 900,
    minWidth: 980,
    minHeight: 600,
    title: APP_TITLE,
    // Window/taskbar icon for unpackaged (dev) runs and Linux; packaged
    // Windows builds take the icon from the exe (electron-builder build/
    // resources), where this option is redundant but harmless.
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: "#18181b",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false,
                      preload: path.join(__dirname, "preload.js") },
  });
  w.lseId = id;
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) w.on(ev, scheduleSave);
  // the page keeps its view in its address (?view=): a change of view is a
  // same-page navigation
  w.webContents.on("did-navigate-in-page", scheduleSave);
  w.webContents.on("did-navigate", scheduleSave);
  // The page names itself "... · LSE Terminal" in document.title; the demo
  // app rewrites that so the title bar and taskbar say which app this is.
  w.on("page-title-updated", (e, title) => {
    if (!IS_DEMO) return;
    e.preventDefault();
    w.setTitle(title.replace(/LSE Terminal/g, APP_TITLE));
  });
  // The terminal's own page asked for (window.open of the engine's root):
  // another window of the terminal. Everything else (docs, key signup, a
  // paper) opens in the user's real browser, as before.
  w.webContents.setWindowOpenHandler(({ url }) => {
    let own = null;
    try {
      const u = new URL(url);
      if (u.protocol === "http:" && u.hostname === "127.0.0.1" &&
          Number(u.port) === currentPort && u.pathname === "/") own = u;
    } catch { /* not an address: the browser gets to say so */ }
    if (own) openExtra(own.searchParams.get("view") || "", w);
    else shell.openExternal(url);
    return { action: "deny" };
  });
  // A renderer that dies (Chromium CHECK, OOM, GPU reset) used to leave the
  // shell standing with an empty black window until someone relaunched the
  // app; seen twice on macOS 26 with Electron 31 (SIGTRAP on CrRendererMain
  // while idle). Reload the page instead: the engine sidecar is untouched, so
  // the terminal is back in about a second. Backed off so a renderer that
  // dies on every load cannot spin the CPU.
  let rendererRestarts = 0;
  w.webContents.on("render-process-gone", (_e, details) => {
    recordEngineOutput(`[shell] renderer gone (${id}): ${details.reason} (exit ${details.exitCode}); reloading\n`);
    if (details.reason === "clean-exit" || w.isDestroyed()) return;
    const delay = Math.min(30000, 1000 * 2 ** rendererRestarts++);
    setTimeout(() => { if (!w.isDestroyed()) w.webContents.reload(); }, delay);
  });
  w.webContents.on("did-finish-load", () => { rendererRestarts = 0; });
  return w;
}

// Another window, on `view`. `saved` is a remembered window being brought
// back; otherwise the window is new and placed by newWindowBounds.
function openExtra(view, opener, saved) {
  if (extras.size >= MAX_EXTRA_WINDOWS) return null;
  let id = saved && typeof saved.id === "string" && /^w[0-9]{1,3}$/.test(saved.id) && !extras.has(saved.id)
    ? saved.id : "";
  for (let n = 2; !id; n++) if (!extras.has("w" + n)) id = "w" + n;
  const b = saved ? { ...placed(saved), maximized: !!saved.maximized } : newWindowBounds(opener);
  const w = makeWindow(id, b);
  extras.set(id, w);
  recordEngineOutput(`[shell] window ${id} opened on ${view || "markets"}\n`);
  w.on("closed", () => {
    extras.delete(id);
    // Closed by the user while the app runs on: it is not brought back.
    if (!stateSaved && !app.isQuitting) saveWindowState();
  });
  w.once("ready-to-show", () => {
    if (b.maximized) w.maximize();
    w.show();
    scheduleSave();
  });
  w.loadURL(windowUrl(id, typeof view === "string" ? view.slice(0, 80) : "")).catch(() => {});
  return w;
}

// The page's NEW WINDOW button and its Ctrl-clicked tabs (preload.js).
ipcMain.handle("lse-window-open", (event, view) => {
  const w = openExtra(typeof view === "string" ? view : "", BrowserWindow.fromWebContents(event.sender));
  return { ok: !!w, reason: w ? "" : "limit" };
});

async function start() {
  recordEngineOutput(`[shell] boot: version=${app.getVersion()} packaged=${app.isPackaged} appPath=${app.getAppPath()}\n`);
  // Before the first spawn: the sidecar inherits this process's env, so the
  // PATH repair has to land before anything is launched from it.
  fixMacPath();
  recordEngineOutput(`[shell] PATH=${process.env.PATH}\n`);
  currentPort = await findFreePort(PREFERRED_PORT, 20);
  spawnSidecar();
  const port = currentPort;

  const saved = loadWindowState();
  win = makeWindow("main", placed(saved));
  win.on("close", () => {
    // Closing the main window closes the app: remember every window first,
    // while the others are still open.
    if (!stateSaved) { saveWindowState(); stateSaved = true; }
  });
  win.on("closed", () => {
    win = null;
    app.isQuitting = true;
    for (const w of [...extras.values()]) { if (!w.isDestroyed()) w.destroy(); }
  });

  try {
    // Generous first-boot window: a cold frozen engine (pyarrow/pandas load)
    // can take a while on a slow disk; do not give up early and quit.
    await waitForHealth(port, 90000);
  } catch (e) {
    dialog.showErrorBox(APP_TITLE,
      `The terminal engine failed to start: ${e.message}${engineOutTail()}`);
    app.quit();
    return;
  }
  await win.webContents.session.clearCache();
  await win.loadURL(windowUrl("main", ""));
  if (saved.maximized) win.maximize();
  win.show();
  // The other windows, where they were and on the views they showed.
  for (const other of (Array.isArray(saved.windows) ? saved.windows : []).slice(0, MAX_EXTRA_WINDOWS)) {
    if (other && typeof other === "object") {
      openExtra(typeof other.view === "string" ? other.view : "", win, other);
    }
  }
  setTimeout(() => captureToWorkspace(win), 6000); // first snapshot once the chart is up
  setupAutoUpdate();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(start);
}

app.on("before-quit", () => {
  // Quit from the taskbar or an update: remember the windows while they are
  // all still open (the main window's own close does the same).
  if (!stateSaved) { saveWindowState(); stateSaved = true; }
  app.isQuitting = true;
});
app.on("will-quit", () => { if (sidecar) sidecar.kill(); });
app.on("window-all-closed", () => app.quit());
