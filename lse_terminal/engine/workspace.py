"""Durable chart workspace: ~/.config/lse-terminal/workspace.json.

Holds everything the user builds up inside the chart - drawings (per symbol),
saved layouts, chart settings, indicator setups, drawing-tool shortcuts and the
watchlist.

Why a file and not browser storage: the terminal is an app people download and
run, so their work has to survive a browser cache clear, a reinstall and a
machine move, and it has to be copyable/backup-able like any other document.
localStorage fails all of those (the shell already ships a cache-buster because
stale browser state caused real bugs).

Layout is one JSON document of independent top-level sections. Each section is
read and written whole; sections never merge across each other, so a corrupt or
unknown section can be dropped without taking the rest of the workspace with it.

More than one window. The terminal can be open in several windows at once (a
second monitor), and every window reads a section once, keeps its own copy in
memory and writes the whole section back. Written as sent, the window that
saves last would erase what another window saved since it last read: a
trendline drawn on the other monitor, a starred instrument. So a window that
names itself (the page sends X-LSE-Window with every request, see index.html)
has its write merged three ways: `base` is what that window last read or
wrote, `mine` is what it sends now, `theirs` is what the file holds. Only what
the window itself changed is taken from it; the rest stays as the file has
it. A caller that names no window, or one the engine has not seen read the
section, is written as sent, exactly as before.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

from lse_terminal.engine import config

# Sections the API will accept. An allowlist rather than free-form keys so a
# bug (or a malicious page on the same origin) cannot grow the file unbounded
# with junk top-level keys.
SECTIONS = frozenset({
    "settings",            # chart appearance settings
    "settings_templates",  # saved appearance presets
    "drawing_shortcuts",   # keyboard shortcuts for drawing tools
    "watchlist",           # symbols pinned in the sidebar
    "layouts",             # saved chart layouts
    "drawings",            # per-symbol drawings, keyed "provider:symbol"
    "indicators",          # per-symbol indicator configuration
    "tools",               # drawing-tool defaults + favourites
    "backtests",           # saved manual-backtest sessions (bar replay)
    "econcal",             # economic calendar view preferences
    "shell",               # shell session state: active indicators + chart type
    "dataviz",             # data visualisation prefs (palette, last chart type)
    "dashboards",          # WORKSPACE > DASHBOARD: the user's boards of coded widgets
})

# One writer at a time: a read-merge-write must not interleave with another
# window's. Reads take it too, so a view is never recorded from a half-made
# write.
_LOCK = threading.RLock()

# (window, section) -> the value that window last read or wrote: its own
# belief of what the file holds. Kept in memory only: after an engine restart
# a window is unknown until it reads again, and is written as sent meanwhile.
_VIEWS: "OrderedDict[tuple[str, str], object]" = OrderedDict()
_VIEWS_KEPT = 256
_MISSING = object()


def path() -> Path:
    return config.config_dir() / "workspace.json"


def load() -> dict:
    try:
        data = json.loads(path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    # A hand-edited file that is valid JSON but not an object would break every
    # caller's .get(); treat it as empty rather than raising on every request.
    return data if isinstance(data, dict) else {}


def save(doc: dict) -> None:
    d = config.config_dir()
    d.mkdir(parents=True, exist_ok=True)
    target = path()
    # Atomic replace: a crash or a full disk mid-write must not truncate an
    # existing workspace. Write a sibling temp file, fsync, then rename.
    fd, tmp = tempfile.mkstemp(dir=str(d), prefix=".workspace-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, target)
    except BaseException:
        # Leave the previous file untouched on any failure.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _remember(window: str, section: str, value) -> None:
    key = (window, section)
    _VIEWS[key] = copy.deepcopy(value)
    _VIEWS.move_to_end(key)
    while len(_VIEWS) > _VIEWS_KEPT:
        _VIEWS.popitem(last=False)


def _by_id(rows) -> dict | None:
    """A list of records that each carry a distinct `id`, as a dict in the
    list's order; None for any other list (which is then taken whole)."""
    if not isinstance(rows, list):
        return None
    out = {}
    for row in rows:
        if not isinstance(row, dict):
            return None
        rid = row.get("id")
        if not isinstance(rid, (str, int)) or isinstance(rid, bool) or rid in out:
            return None
        out[rid] = row
    return out


def merge3(base, mine, theirs, depth: int = 4):
    """What to store when a window sends `mine`, last knew `base`, and the
    file now holds `theirs`.

    - What the window did not change keeps the file's value.
    - What nobody else changed takes the window's value.
    - Where both changed: objects are merged key by key, lists of records
      with ids record by record, and anything else takes the window's value
      (it is the one the user just acted in).
    - Something this window removed is removed, unless another window changed
      it meanwhile: a change is kept over a removal made without seeing it.
    """
    if mine == base:
        return theirs
    if theirs == base:
        return mine
    if depth > 0:
        if isinstance(mine, dict) and isinstance(theirs, dict):
            b = base if isinstance(base, dict) else {}
            return _merge_keys(b, mine, theirs, depth)
        m, t = _by_id(mine), _by_id(theirs)
        if m is not None and t is not None:
            b = _by_id(base) or {}
            return list(_merge_keys(b, m, t, depth).values())
    return mine


def _merge_keys(base: dict, mine: dict, theirs: dict, depth: int) -> dict:
    out = {}
    # The window's own order first, then what only the file has.
    for k in [*mine, *(k for k in theirs if k not in mine)]:
        b = base.get(k, _MISSING)
        m = mine.get(k, _MISSING)
        t = theirs.get(k, _MISSING)
        if m is _MISSING:
            # not in what this window sends: it removed it (b present), or
            # never had it (another window added it)
            if b is _MISSING or t != b:
                out[k] = t
        elif t is _MISSING:
            # gone from the file: another window removed it; keep it only
            # when this window added or changed it
            if b is _MISSING or m != b:
                out[k] = m
        elif b is _MISSING:
            out[k] = m if m == t else merge3(None, m, t, depth - 1)
        else:
            out[k] = merge3(b, m, t, depth - 1)
    return out


def get(section: str, window: str | None = None):
    with _LOCK:
        value = load().get(section)
        if window:
            _remember(window, section, value)
        return value


def put(section: str, value, window: str | None = None):
    """Store a section; returns what was stored (the merge, for a known
    window whose copy was behind the file)."""
    with _LOCK:
        doc = load()
        stored = value
        if window:
            base = _VIEWS.get((window, section), _MISSING)
            if base is not _MISSING:
                stored = merge3(base, value, doc.get(section))
        doc[section] = stored
        save(doc)
        if window:
            # the window's belief is what IT sent, not the merge: its memory
            # does not hold what the other windows added
            _remember(window, section, value)
        return stored
