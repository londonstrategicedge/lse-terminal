// Bridge for the shell powers the page needs: snapshotting this window into
// the agent workspace (Phase 3 vision), and driving the app updater behind
// the header's UPDATE button. Nothing else of Electron is exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lseShell", {
  capture: () => ipcRenderer.invoke("lse-capture"),
  // Another window of the terminal on `view` ("workspace", "markets/sub-mk-
  // options", ...), for a second monitor. The shell places and remembers it.
  openWindow: (view) => ipcRenderer.invoke("lse-window-open", String(view || "")),
  update: {
    // Returns {supported, current, latest, available, phase, pct}. supported
    // is false on builds with no updater (mac, dev, no dep), where the page
    // offers the release download instead.
    check: () => ipcRenderer.invoke("lse-update-check"),
    // Restarts into a downloaded update, or starts the download if it has
    // not run yet; progress arrives on the state channel.
    install: () => ipcRenderer.invoke("lse-update-install"),
    onState: (cb) => ipcRenderer.on("lse-update-state", (_e, s) => cb(s)),
  },
});
