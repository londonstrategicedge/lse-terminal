"""The approval bridge's config (approve-<token>.json) appears whole.

A panel chat with the claude agent writes a one-line MCP config into the
terminal's config folder and launches the CLI with it; the test fixture that
opens such a chat (test_broker_terms.chat) reads it the moment it appears.
Written with a plain write_text it would exist, empty, for as long as the
write takes, and a reader could find it so (a fixture reading it then fails
at setup). Pinned here: it is written to a temporary file in the same folder,
whose name no reader of approve-*.json matches, synced, and renamed into
place, so under its own name it is only ever the whole file; and it is the
owner's alone (mode 0600: it carries the engine token the bridge uses).

The engine runs in this process (test_broker_terms.engine), so an audit hook
sees every file it opens and renames. Nothing here reaches the network; the
claude CLI is a stand-in on PATH that is never asked a turn.
"""
import fnmatch
import json
import os
import stat
import sys
from pathlib import Path

from test_broker_terms import engine, home, wait_for  # noqa: F401 - fixtures

_SEEN = []
_WATCH = {"dir": None}


def _hook(event, args):
    folder = _WATCH["dir"]
    if folder is None:
        return
    try:
        if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
            path = Path(os.fsdecode(args[0]))
            if path.parent.resolve() == folder:
                mode, flags = args[1], args[2] or 0
                writes = (any(ch in str(mode) for ch in "wax+") if mode is not None
                          else bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT)))
                _SEEN.append(("open", path.name, writes))
        elif event == "os.rename":
            _SEEN.append(("rename", os.fsdecode(args[0]), os.fsdecode(args[1])))
    except Exception:  # noqa: BLE001 - a hook never fails the call it watches
        pass


sys.addaudithook(_hook)


def test_the_approval_config_is_written_whole_and_renamed_into_place(engine, monkeypatch):
    bindir = engine.home / "bin"
    bindir.mkdir()
    fake = bindir / "claude"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    from websockets.sync.client import connect as ws_connect
    cfgdir = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"]).resolve()
    cfgdir.mkdir(parents=True, exist_ok=True)
    _SEEN.clear()
    _WATCH["dir"] = cfgdir
    try:
        with ws_connect(f"ws://127.0.0.1:{engine.port}/api/ai/chat?agent=claude"):
            found = wait_for(lambda: list(cfgdir.glob("approve-*.json")), timeout=10)
            assert found, "the chat did not open its approval channel"
            data = json.loads(found[0].read_text())          # whole, the first time read
            assert set(data["mcpServers"]) == {"lse_approver", "lse_terminal"}
            args = data["mcpServers"]["lse_terminal"]["args"]
            assert args[args.index("--bridge-role") + 1] == "tools"
            mode = stat.S_IMODE(found[0].stat().st_mode)
    finally:
        _WATCH["dir"] = None
    name = found[0].name
    wrote = [s for s in _SEEN if s[0] == "open" and s[1] == name and s[2]]
    assert not wrote, f"{name} was opened for writing under its own name: {_SEEN}"
    into = [s for s in _SEEN if s[0] == "rename" and Path(s[2]).name == name]
    assert len(into) == 1, _SEEN
    src = Path(into[0][1])
    assert src.parent.resolve() == cfgdir, into
    assert not fnmatch.fnmatch(src.name, "approve-*.json"), src.name
    assert not src.exists()
    if os.name == "posix":
        assert mode == 0o600, oct(mode)
    # the chat closed: its config is gone, and no temporary file is left
    assert wait_for(lambda: not list(cfgdir.glob("*approve-*")), timeout=10), \
        list(cfgdir.iterdir())
