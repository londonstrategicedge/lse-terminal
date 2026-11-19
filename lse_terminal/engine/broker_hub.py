"""Broker connections: the terminal side of brue-connect.

One hub, many named brokers. Every broker is just an adapter command
speaking the brue-connect protocol; connecting spawns the adapter and
runs the SPEC section 7 reconciliation, after which the broker is the
source of truth for catalog, account and positions. This is THE trading
door of the terminal: onboarded external brokers and our own demo broker
all come through here, which is why the bundled fake broker (NovaFX)
exists: it keeps the generic path honest, because nothing in this file
may ever special-case a broker name.

Local-mode only (spawns subprocesses), same rule as the algo runner.
"""
from __future__ import annotations

import json
import math
import os
import re
import shlex
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

# The data-provider contract, for offering a connected broker as a source the
# markets page can read (BrokerProvider, at the foot of this file).
from lse_terminal.contracts import (CANDLE_COLUMNS, Instrument, NotSupported,
                                    Provider, Quote)

# The dynamic connection directory: which brokers and LSE-shipped data
# sources exist is decided by OUR API at runtime, not baked into the
# installed version. Adding or delisting a connection is a server-side
# change that reaches every online terminal on its next refresh. Fail-open by design: no network -> cached copy -> local
# built-ins, so an offline user never loses their terminal. User-owned
# sources (custom API keys, userdata) are never gated by this.
DIRECTORY_URL = os.environ.get(
    "LSE_DIRECTORY_URL", "https://api.londonstrategicedge.com/sim/directory")
# The demo channel is the staging app: it sees brokers still marked dev in
# the directory (include_dev=1), so a partner can be checked there before its
# row reaches every public terminal. The shell says which channel this is.
if (os.environ.get("LSE_TERMINAL_CHANNEL") == "demo"
        and "LSE_DIRECTORY_URL" not in os.environ):
    DIRECTORY_URL += "?include_dev=1"
DIRECTORY_REFRESH_S = 6 * 3600
# How long a login waiting on its account chooser is kept before it is
# dropped unanswered (its adapter stopped, the pending entry forgotten).
PENDING_CHOICE_S = 600


def fetch_directory(cache_path: Path) -> dict | None:
    try:
        req = urllib.request.Request(
            DIRECTORY_URL, headers={"User-Agent": "lse-terminal"})
        with urllib.request.urlopen(req, timeout=4) as r:
            d = json.loads(r.read())
        if not isinstance(d, dict) or "brokers" not in d:
            raise ValueError("malformed directory")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(d))
        return d
    except Exception:
        try:
            return json.loads(cache_path.read_text())
        except Exception:
            return None


def connect_base(checkout: Path | None = None) -> Path:
    """Locate the brueconnect package and return its directory.

    A user install resolves the installed wheel (brueconnect is a real
    dependency, present on every machine the terminal runs on); a dev
    checkout (LSE_BRUE_CONNECT_DIR, or a sibling checkout) wins when present
    because its root is pushed onto sys.path first. Raises ImportError
    when neither exists; callers surface that as "install brue-connect".
    """
    if (checkout and (checkout / "brueconnect").is_dir()
            and str(checkout) not in sys.path):
        sys.path.insert(0, str(checkout))
    import brueconnect  # noqa: PLC0415
    return Path(brueconnect.__file__).resolve().parent


def _load_connector(connect_dir: Path):
    connect_base(connect_dir)
    from brueconnect import Connector, ConnectorError  # noqa: PLC0415
    return Connector, ConnectorError


# The adapters and the brueconnect package they import both declare
# requires-python >= 3.10, so anything older is not a candidate however it
# is named.
_MIN_ADAPTER_PY = (3, 10)


def _python_version_ok(path: str) -> bool:
    """True if `path` is a real interpreter of at least _MIN_ADAPTER_PY.

    Asking the binary itself is the only reliable test, because the name on
    disk says nothing about what is behind it: macOS ships /usr/bin/python3
    as a Command Line Tools shim pinned at 3.9 (below what the adapters
    need), and Windows ships WindowsApps stubs that are not Python at all.
    """
    import subprocess  # noqa: PLC0415
    try:
        out = subprocess.run(
            [path, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"],
            capture_output=True, text=True, timeout=10)
    except Exception:
        return False  # not executable, not there, or it hung
    if out.returncode != 0:
        return False
    try:
        major, minor = (int(x) for x in out.stdout.strip().split(".")[:2])
    except ValueError:
        return False
    return (major, minor) >= _MIN_ADAPTER_PY


@lru_cache(maxsize=1)
def _borrowed_python() -> tuple:
    """The FROZEN build's search for a Python on the user's machine.

    Returns (a verified interpreter or None, the best-looking name). Cached:
    the search shells out to every candidate, and the answer cannot change
    within a run.
    """
    override = os.environ.get("BRUE_CONNECT_PYTHON")
    if override:
        # The user named one. Taken at their word, as it always was.
        return override, override
    import shutil  # noqa: PLC0415
    candidates: list[str] = []
    if sys.platform == "darwin":
        # Named BEFORE the PATH search on purpose. A Finder-launched .app
        # inherits launchd's minimal PATH, so a Homebrew or python.org
        # interpreter can be installed and still be invisible to which();
        # and the /usr/bin/python3 that IS always on that PATH pops the
        # "install the command line developer tools" dialog when the tools
        # are absent, which would block this search behind a modal the user
        # never asked for. Finding a real Python first avoids touching it.
        candidates += [p for p in (
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            str(Path.home() / ".local" / "bin" / "python3"),
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
        ) if os.path.isfile(p)]
    for name in ("python3", "python"):
        found = shutil.which(name)
        # Windows ships fake python3.exe/python.exe stubs in WindowsApps
        # that open the Microsoft Store instead of running the script; one
        # of those "interpreters" is how every adapter died instantly on
        # the first frozen build that spawned them.
        if found and "windowsapps" not in found.lower():
            candidates.append(found)
    for path in candidates:
        if _python_version_ok(path):
            return path, path
    # Nothing usable. The best-looking name is still reported, for the
    # caller that has no other way to run a file (see python_argv).
    return None, (candidates[0] if candidates else "python3")


@lru_cache(maxsize=1)
def adapter_python() -> str:
    """The interpreter that runs adapter subprocesses.

    In a normal install this process IS a Python, so sys.executable is
    right. In the FROZEN desktop sidecar sys.executable is the lset-server
    binary: handing that an adapter .py would just boot a second engine, so
    the frozen build must borrow a real Python from the machine
    (BRUE_CONNECT_PYTHON overrides the search).
    """
    if not getattr(sys, "frozen", False):
        return sys.executable
    found, name = _borrowed_python()
    return found or name


def python_available() -> bool:
    """False only in a frozen build on a machine with no Python 3.10+."""
    if not getattr(sys, "frozen", False):
        return True
    return _borrowed_python()[0] is not None


def _engine_reentry() -> list[str]:
    """The command that re-enters this engine's own bundled interpreter.

    Frozen, sys.executable is lset-server, and `lset-server --run-script
    file.py args` runs a Python file inside it (cli.py), which is how the
    workspace terminal and the ML jobs already run scripts on a machine
    with no Python. A function so a source checkout can stand in for the
    frozen binary in tests (`python -m lse_terminal.cli`).
    """
    return [sys.executable]


def python_argv(script, args=()) -> list[str]:
    """The argv that runs a Python adapter FILE on this machine.

    A real Python when there is one. Frozen on a machine without one, the
    engine's own interpreter through --run-script rather than a spawn that
    can only fail: the adapter then imports what the bundle holds (and
    brueconnect is in it), not what the user has installed.
    """
    if not python_available():
        return [*_engine_reentry(), "--run-script", str(script), *args]
    return [adapter_python(), str(script), *args]


_BARE_PYTHON = ("python", "python3", "python.exe", "python3.exe")


def resolve_interpreter(argv: list[str]) -> list[str]:
    """A linked profile's argv with a bare `python3` turned into OUR Python.

    "Add your own broker" stores the interpreter as the bare word, so the
    profile survives a Python upgrade and means the same thing in a source
    install (this interpreter) and a frozen one (the borrowed interpreter,
    with the WindowsApps stub and the macOS 3.9 shim already filtered out).
    A path the user wrote themselves is their choice of environment and is
    left exactly as it is.
    """
    argv = list(argv)
    if not argv or argv[0].lower() not in _BARE_PYTHON:
        return argv
    if (not python_available() and len(argv) >= 2
            and not argv[1].startswith("-")):
        return [*_engine_reentry(), "--run-script", *argv[1:]]
    return [adapter_python(), *argv[1:]]


# A directory that holds ONLY the brueconnect package, beside the package the
# engine itself imports. The desktop build ships one (a data line in both
# PyInstaller specs) because the directory the frozen engine imports from,
# _internal, also holds the app's own numpy, pandas and, on Windows, the
# bundled Python's extension modules; put on another interpreter's path it
# can shadow that interpreter's own. An adapter gets this one instead.
SDK_DIRNAME = "brue-sdk"
EXAMPLE_ENV = "BRUE_CONNECT_EXAMPLE"


def sdk_dir(base: Path | None) -> Path | None:
    if base is None:
        return None
    clean = base.parent / SDK_DIRNAME
    return clean if (clean / "brueconnect" / "__init__.py").is_file() else None


def _same_interpreter(path: str) -> bool:
    """Is `path` the interpreter this engine runs on? Compared as written
    (no symlink resolution): a venv's python and the system python it links
    to are one binary and two different environments."""
    try:
        a = os.path.normcase(os.path.abspath(path))
        b = os.path.normcase(os.path.abspath(sys.executable))
    except (TypeError, ValueError):
        return False
    return a == b


# The starter a user begins a broker of their own from: one file inside the
# kit, offered by the Connections screen as a download. As delivered it runs
# on practice prices made inside the file, with no network, so it can be
# added, connected and tested before it is pointed at any broker.
TEMPLATE_PARTS = ("templates", "my_broker_adapter.py")
TEMPLATE_NAME = TEMPLATE_PARTS[-1]
# Where "Create my starter adapter" puts it: a folder of the user's own, outside
# every install, so their edits outlive each update of the terminal.
OWN_BROKERS_DIR = ("LSE Terminal", "brokers")


def own_brokers_dir() -> Path:
    return Path.home().joinpath(*OWN_BROKERS_DIR)
# The starter's two key boxes (its credential_form: api_key, api_secret) as
# the terminal hands them over at spawn. Its practice prices accept any value
# that is not empty and refuse an empty one, so a test run is given these,
# as the terminal gives it what the user typed.
STARTER_TEST_KEYS = (("BRUE_CRED_API_KEY", "practice"),
                     ("BRUE_CRED_API_SECRET", "practice"))
_SUITE_MODULE = "brueconnect.conformance.run"


@lru_cache(maxsize=8)
def _interpreter_version(path: str):
    """(major, minor, micro) of the Python at `path`, or None when it does
    not run. Asked of the binary itself, for the reason _python_version_ok
    gives; cached, as the answer cannot change within a run."""
    if _same_interpreter(path):
        return tuple(sys.version_info[:3])
    import subprocess  # noqa: PLC0415
    try:
        out = subprocess.run(
            [path, "-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"],
            capture_output=True, text=True, timeout=10)
        if out.returncode != 0:
            return None
        return tuple(int(x) for x in out.stdout.strip().split(".")[:3])
    except Exception:  # noqa: BLE001 - not there, not runnable, hung, garbled
        return None


def conformance_command_posix(python: str, sdk: str,
                              file: str = TEMPLATE_NAME) -> str:
    """The line for sh, bash or zsh that runs the kit's conformance suite on
    `file` in the current folder, with the Python and the SDK the terminal
    gives an adapter.

    The suite splits --adapter by POSIX shell rules (shlex), so the adapter
    command is quoted for those rules first, then for the shell it is typed
    into: in double quotes when nothing in it is special there (the common
    case, and the readable one), else in single quotes, where nothing is.
    """
    adapter = shlex.join([python, file])
    if re.search(r'[\\"$`!]', adapter):
        adapter_arg = shlex.quote(adapter)
    else:
        adapter_arg = '"' + adapter + '"'
    keys = " ".join(f"{k}={shlex.quote(v)}" for k, v in STARTER_TEST_KEYS)
    return (f"{keys} PYTHONPATH={shlex.quote(sdk)} {shlex.quote(python)} "
            f"-m {_SUITE_MODULE} --adapter {adapter_arg}")


def _ps_literal(text: str) -> str:
    """A PowerShell single-quoted string. Nothing inside one is special but
    the quote itself, written twice; PowerShell also takes the typographic
    single quotes for quotes, so those are doubled too."""
    return "'" + re.sub("(['‘’‚‛])", r"\1\1", text) + "'"


def _shlex_word(text: str) -> str:
    """`text` as one word for the suite's shlex, written without a double
    quote: bare when nothing in it is special, else in single quotes (where
    a backslash is kept as it is), a quote inside written '\\''."""
    if text and not re.search(r"[^\w@%+=:,./-]", text, re.ASCII):
        return text
    return "'" + text.replace("'", "'\\''") + "'"


def conformance_command_powershell(python: str, sdk: str,
                                   file: str = TEMPLATE_NAME) -> str:
    """The same command for Windows PowerShell (5.1 and 7).

    The adapter command holds no double quote at all: Windows PowerShell 5.1
    does not escape one inside an argument it hands to a program, so the
    program would receive it cut in pieces. Each path is one shlex word in
    single quotes instead (_shlex_word), and the whole is a PowerShell
    double-quoted string, whose own special characters ($, the backtick and
    the double quotes) are escaped with a backtick.
    """
    adapter = _shlex_word(python) + " " + _shlex_word(file)
    adapter_arg = '"' + re.sub('([`$"“”„])', r"`\1", adapter) + '"'
    keys = "; ".join(f"$env:{k} = {_ps_literal(v)}" for k, v in STARTER_TEST_KEYS)
    return (f"{keys}; $env:PYTHONPATH = {_ps_literal(sdk)}; "
            f"& {_ps_literal(python)} -m {_SUITE_MODULE} --adapter {adapter_arg}")


# Adapters that ship INSIDE the brueconnect package and that a user may link
# with one click. Linking one makes an ordinary user-registered profile: the
# user's own connection with the user's own keys, not a listing of ours. An
# entry is offered only when its file exists in the kit this engine runs.
#
# Each one is also a row of its own on the Connections screen before it is
# linked, so a user finds where to enter the key without first opening "Add
# your own broker": its name, one line on what it deals, the boxes its key
# form asks for and where a user makes that key. `form` is the adapter's own
# credential_form (SPEC 3.2), written here because the row is drawn before the
# adapter is ever run; a test holds the two equal.
#
# `terms` is the broker's terms as our listing states them (SPEC 3.3), the
# shape a handshake carries: {"data_local_only": True,
# "orders_by_hand_only": True, "summary": "<one sentence>", "url": "https://..."}.
# Optional. When present it holds before the adapter is ever run and when its
# hello fails, and the stricter of it and the adapter's own handshake applies,
# flag by flag (BrokerHub.terms_of). A row whose broker restricts nothing
# leaves it out.
# Each listed row's own mark, inline, so its row draws it with no request and
# offline. Where each was fetched, and what was changed in it, is said on its
# row below (EXAMPLES, beside `logo`).
ALPACA_LOGO = ("data:image/svg+xml;base64,"
               "PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgdmlld0JveD0iMCAwIDUxMiA1MTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxjaXJjbGUgY3g9IjI1NiIgY3k9IjI1NiIgcj0iMjU0IiBmaWxsPSIjMTExMTExIi8+CjxwYXRoIGQ9Ik0xNzguMjM2IDQ5OS45MjRMMTk4LjYxNCAyODYuNjY4SDE5Ni43NzVDMTgwLjU3NCAyODYuNjY4IDE2Ny4yMSAyODAuODUzIDE1NC44NDUgMjcwLjM4OEMxNDIuNDggMjU5LjkyMyAxMzQuMzAxIDI0NS4zMDggMTMxLjc5NiAyMjkuMTk0TDE3MC4wNDggMjA0LjQ0NlYyMDQuMTE0QzE3MC4wNDggMTg3LjM0NCAxNzYuNTYzIDE3MS4wNjQgMTg4LjI1NCAxNTguOTM1QzE5OS45NDUgMTQ2LjgwNiAyMTUuODEzIDEzOS41MDMgMjMyLjY4OCAxMzguODM3SDI0NC4wNDZWOTguOTc0M0MyNTIuMDY4IDk4Ljk3NDMgMjU5LjkxNCAxMDEuNzk0IDI2Ni4wOTcgMTA3LjExQzI3Mi4yOCAxMTIuMjU5IDI3Ni4yOSAxMTkuNTcxIDI3Ny43ODggMTI3LjU0SDI3OC4yODdWOTguODA4QzI4NC4zMDMgOTguODA4IDI5MC4zMTEgMTAwLjQ3MiAyOTUuNDk1IDEwMy40NThDMzAwLjY3OSAxMDYuNDQ0IDMwNS4wMTQgMTEwLjkyOCAzMDguMDI3IDExNi4yNDRDMzExLjAzIDEyMS41NTkgMzEyLjUzNyAxMjcuNTQgMzEyLjM3IDEzMy41MTNDMzEyLjIwNCAxMzkuNDk0IDMxMC41MzEgMTQ1LjQ3NSAzMDcuMzYxIDE1MC42MjRDMzE3LjU1NSAxNTcuMjcxIDMyNi4wNjcgMTY2LjU3MSAzMzEuOTE2IDE3Ny4zNjlDMzM3Ljc2NiAxODguMTY3IDM0MC43NyAyMDAuMjg3IDM0MC43NyAyMTIuNTgyVjQ3MC4wMThDMzQwLjc3IDQ3MS4wMTYgMzQwLjkzNiA0NzIuMTgxIDM0MS4xMDMgNDczLjE3MUMzNDEuOTM1IDQ3Ni44MjIgMzQ0LjEwNiA0NzkuMTUyIDM0NC45NDcgNDgwLjE1QzM0OS4xMjQgNDg0LjYzNCAzNTQuNzk5IDQ4NS40NjYgMzU3LjY0NSA0ODUuOTY1QzM2My45OTQgNDg2Ljk2MyAzNjkuMDAzIDQ4NS40NjYgMzcxLjg0MSA0ODQuMzAxQzQ1NS4wMjYgNDQyLjExOCA1MTEuOTkxIDM1NS41ODcgNTExLjk5MSAyNTUuOTNDNTEyIDExNC41OTcgMzk3LjQwMyAwLjAwMDE4MDk1OCAyNTYuMDg4IDAuMDAwMTgwOTU4QzExNC41OTcgLTAuMTY2MjA2IDAgMTE0LjQzMSAwIDI1NS45MzlDMCAzNzAuMjEyIDc1LjAwNTcgNDY3LjA0MSAxNzguMjM2IDQ5OS45MjRaTTIwNS40NzEgMjI0LjIySDIyMS4xNzNDMjI1LjM1IDIyNC4yMiAyMjkuMTk0IDIyMi41NTYgMjMyLjE5OCAyMTkuNTdDMjM1LjAzNSAyMTYuNTg0IDIzNi43MDggMjEyLjU5MSAyMzYuNzA4IDIwOC40NEgyMTMuOTkyQzIxMS45ODYgMjA4LjQ0IDIwOS45ODEgMjA5LjI3MiAyMDguNDc1IDIxMC43NkMyMDYuOTY4IDIxMi4yNDkgMjA2LjEzNiAyMTQuMjQ2IDIwNi4xMzYgMjE2LjI0MkwyMDUuNDcxIDIyNC4yMTFWMjI0LjIyWiIgZmlsbD0iI0ZDRDcyQiIvPgo8L3N2Zz4K")

OANDA_LOGO = ("data:image/svg+xml;base64,"
              "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1NTgiIGhlaWdodD0iNTU4IiB2aWV3Qm94PSIwIDAgNTU4IDU1OCI+Cjx0aXRsZT5PQU5EQTwvdGl0bGU+CjxyZWN0IHdpZHRoPSI1NTgiIGhlaWdodD0iNTU4IiByeD0iNjkuNzUiIGZpbGw9IiMwMDIxNEEiLz4KPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOTMgOTUpIj4KPHBvbHlnb24gZmlsbD0iI0ZGRkZGRiIgcG9pbnRzPSI4NS42LDI2NC42IDI5LDI2NC42IDAsMTU0LjMgNTYuNiwxNTQuMyIvPgo8cG9seWdvbiBmaWxsPSIjMDBEMzdFIiBwb2ludHM9IjMyNi41LDE2OS45IDI2OS45LDE2OS45IDMxNS40LDAgMzcyLDAiLz4KPHBvbHlnb24gZmlsbD0iIzAwRDM3RSIgcG9pbnRzPSIyMTIuOCw4NC45IDE2NC45LDI2My42IDEzNywzNjggMTkyLjksMzY4IDE5My42LDM2OCAyNjkuNCw4NC45Ii8+Cjxwb2x5Z29uIGZpbGw9IiNGRkZGRkYiIHBvaW50cz0iMTQ2LjcsMTk2LjEgOTAuMSwxOTYuMSAxMzUuNywzNjggMTM2LjQsMzY4IDE5Mi45LDM2OCIvPgo8L2c+Cjwvc3ZnPgo=")
CAPITALCOM_LOGO = ("data:image/png;base64,"
                   "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")

EXAMPLES = {
    "alpaca": {"label": "Alpaca (paper trading)",
               "name": "Alpaca",
               # Alpaca's own mark: its favicon, files.alpaca.markets/webassets/
               # favicon.svg (fetched 2026-11-12), the yellow disc and the head it is
               # cut from, with a black disc set behind it so the head reads black on
               # a light page as on a dark one (the cut-out alone took the page's
               # colour: white on light).
               "logo": ALPACA_LOGO,
               "about": "US stocks, ETFs and crypto, on your own Alpaca paper account.",
               "keys_url": "https://app.alpaca.markets/",
               "keys_help": "Sign in to Alpaca, switch to your Paper account, then API Keys, "
                            "Generate New Key. Copy both: the secret is shown once.",
               "form": ({"key": "api_key", "label": "API key ID", "type": "text"},
                        {"key": "api_secret", "label": "API secret key", "type": "password"}),
               # Alpaca's market data is the account holder's alone: its Terms and
               # Conditions ("exclusively for personal and noncommercial access and
               # use"; not "transmitted ... to any other computer, server ... for any
               # commercial enterprise") and Customer Agreement section 30. The
               # adapter's own handshake says the same; a test holds the two equal.
               "terms": {"data_local_only": True,
                         "summary": "Alpaca licenses its market data for your own personal, "
                                    "non-commercial use, so its prices stay on this computer.",
                         "url": "https://files.alpaca.markets/disclosures/library/"
                                "TermsAndConditions.pdf"},
               # Its adapter works out none of its catalog's figures from a price:
               # a share's minimum stop is a fixed 1 point (Alpaca refuses a stop
               # nearer than $0.01), and it sends no tick value in the account's
               # currency (BrokerHub.priced_fields; a test holds it to the adapter).
               "priced": (),
               # The chart periods its adapter serves (its TIMEFRAMES table,
               # 30m as 30Min; a test holds the two equal).
               "timeframes": ("1m", "5m", "15m", "30m", "1h", "4h", "1d"),
               "path": ("adapters", "alpaca", "alpaca_adapter.py"),
               "args": ("--paper",)},
    "oanda": {"label": "OANDA (demo account)",
              "name": "OANDA",
              # OANDA's own mark: the four polygons of its symbol, point for point and
              # in its own colours (white #FFFFFF, green #00D37E) from the logo on
              # www.oanda.com (oanda-logo.370e04d3507d.svg, fetched 2026-11-14), on the
              # navy #00214A of its light-ground logo, laid out as its own app icon.
              "logo": OANDA_LOGO,
              "about": "Forex, metals, index, commodity and bond CFDs, on your own OANDA demo account.",
              "keys_url": "https://hub.oanda.com/tpa/personal_token",
              "keys_help": "Sign in to the OANDA HUB. If you also have a live account, switch to demo "
                           "with the dropdown next to your profile name. Then Tools, API, Generate. "
                           "Copy the token: OANDA does not keep it. OANDA does not offer this API "
                           "to residents of the EU (OANDA TMS Brokers) or to clients of OANDA "
                           "Global Markets.",
              # What the card calls the one thing it asks for: its box is the token.
              "key_name": "API token",
              "form": ({"key": "token", "label": "API token", "type": "password"},),
              # OANDA's API licence (April 2026, 4.3(d), 18.1, 18.2, 18.6) licenses its
              # prices to the account holder alone; it keeps no order by hand. The
              # adapter's own handshake says the same; a test holds the two equal.
              "terms": {"data_local_only": True,
                        "summary": "OANDA's prices are licensed to you alone and stay on this "
                                   "computer; OANDA's licence asks that a strategy be tested on "
                                   "practice first and watched while it runs on a live account.",
                        "url": "https://legal.oanda.com/?code=api_licence_agreement&language=en"},
              # Its adapter works out none of its catalog's figures from a price:
              # the minimum stop is a fixed 0, and no tick value in the account's
              # currency is sent (BrokerHub.priced_fields; a test holds it).
              "priced": (),
              # The chart periods its adapter serves (its TIMEFRAMES table,
              # 30m as M30; a test holds the two equal).
              "timeframes": ("1m", "5m", "15m", "30m", "1h", "4h", "1d"),
              "path": ("adapters", "oanda", "oanda_adapter.py"),
              "args": ("--paper",)},
    "capitalcom": {"label": "Capital.com (demo account)",
                   "name": "Capital.com",
                   # Capital.com's own mark, the gold "C" on its dark ground: its
                   # favicon, static.capital.com/favicon-v2/favicon-96x96.png (fetched
                   # 2026-11-14), unaltered. Capital.com publishes this square mark only
                   # as PNG and WebP.
                   "logo": CAPITALCOM_LOGO,
                   "about": "Share, index, forex and commodity CFDs, on your own Capital.com "
                            "demo account.",
                   "keys_url": "https://capital.com/trading/platform/",
                   "keys_help": "Log in to Capital.com, turn on Settings > Two-Factor "
                                "Authentication, then Settings > API integrations > Generate "
                                "API key. Set a Custom password (a new one, not your login "
                                "password) and copy the key: it is shown only once and lasts a "
                                "year by default.",
                   "form": ({"key": "api_key", "label": "API key", "type": "password"},
                            {"key": "identifier", "label": "Login email", "type": "text"},
                            {"key": "password", "label": "API key password", "type": "password"}),
                   # Capital.com's terms (UK T&C, September 2024, 3.1 and 9(g); EU T&C 8.1
                   # and 8.26.1) keep its prices for the account holder's own trading and
                   # have each order on a live account placed by the user. The adapter's own
                   # handshake says the same; a test holds the two equal.
                   "terms": {"data_local_only": True, "orders_by_hand_only": True,
                             "summary": "Capital.com's prices are for your own trading and stay "
                                        "on this computer, and on a live account its terms have "
                                        "you place each order yourself.",
                             "url": "https://capital.com/en-gb/terms-and-policies"},
                   # Its summary names both restrictions, so the row says them once.
                   "terms_cover": ("data_local_only", "orders_by_hand_only"),
                   # Its adapter states an instrument's minimum stop in points of the
                   # price at the moment the catalog is built when Capital.com gives
                   # it as a percentage, so that figure is withheld from a program;
                   # its other figures are fixed (BrokerHub.priced_fields).
                   "priced": ("stops_level_points",),
                   # The chart periods its adapter serves (its TIMEFRAMES
                   # table, 30m as MINUTE_30; a test holds the two equal).
                   "timeframes": ("1m", "5m", "15m", "30m", "1h", "4h", "1d"),
                   "path": ("adapters", "capitalcom", "capitalcom_adapter.py"),
                   "args": ("--paper",)},
}

# What a linked profile may be called, and what it may not.
_LINK_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{1,31}")
_ENV_NAME = re.compile(r"[A-Z_][A-Z0-9_]{0,63}")
# Names the Connections screen hides or the engine keeps for itself.
_RESERVED_NAMES = frozenset({"lse-hosted", "paper-fast"})
_MAX_ARGS = 30
_MAX_ARG_CHARS = 2048
_MAX_ENV = 32
_MAX_ENV_CHARS = 1024
_HELLO_TIMEOUT_S = 8.0
# An adapter's own words about a refusal or a failure (a connect refused, a
# handshake refused, an answer lost) are kept whole for the window: a broker
# can put what matters most last, such as who may not use its API. Past this
# many characters it is not a sentence but a dump, and only that is cut.
WORDS_CHARS = 2000


class LinkError(Exception):
    """A link or unlink request that cannot be carried out.

    `status` is its HTTP shape; `stderr` is the tail of what the adapter
    wrote before it failed, when it was run.
    """

    def __init__(self, message: str, status: int = 400, stderr: str = ""):
        super().__init__(message)
        self.status = status
        self.stderr = stderr


class _StderrTail:
    """The last words of an adapter: its stderr, kept and passed on.

    The connector inherits stderr by default, which sends an adapter's
    traceback to the engine's log where the person who just pressed Connect
    will never see it. For a user's own adapter the hub takes the pipe
    instead: every byte is still written through to the engine's stderr, and
    the last few KB are kept so a failure can show them.

    Except for a connection whose broker's terms keep its prices on this
    computer (SPEC 3.3): its adapter's lines can quote them ("EURUSD bid
    ..."), and the engine's stderr is kept in a file (the desktop shell's
    engine.log). Its lines are then kept for the Connections card only (its
    row's `printed`, BrokerHub.printed_lines, while it is connected and after
    the run ends), and the engine's stderr gets one line saying so. `quiet`
    says which: called at each chunk, since the terms can come with the
    adapter's first hello, it returns that line's sentence, or None to write
    the bytes through.
    """

    LIMIT = 4096

    def __init__(self, quiet=None, name: str = ""):
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._thread = None
        self._quiet = quiet
        self._name = name
        self._noted = False

    def _held_back(self):
        """The sentence when this adapter's lines stay off the engine's
        stderr, else None."""
        if self._quiet is None:
            return None
        try:
            return self._quiet()
        except Exception:  # noqa: BLE001 - cannot tell: keep them off
            return ("Lines this adapter printed withheld: its broker's terms "
                    "could not be read, so its prices stay on this computer.")

    def attach(self, proc) -> None:
        stream = getattr(proc, "stderr", None)
        if stream is None:
            return
        # Bytes, not text: one undecodable byte must not end the pump.
        raw = getattr(stream, "buffer", stream)

        def pump():
            try:
                while True:
                    chunk = (raw.read1(4096) if hasattr(raw, "read1")
                             else raw.read(4096))
                    if not chunk:
                        return
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8", "replace")
                    with self._lock:
                        self._buf += chunk
                        if len(self._buf) > self.LIMIT:
                            del self._buf[:-self.LIMIT]
                    why = self._held_back()
                    if why is not None:
                        # Kept above for the card; once, where they would be.
                        if self._noted:
                            continue
                        self._noted = True
                        chunk = (f"[{self._name}] {why} Its Connections card "
                                 "shows them.\n").encode("utf-8", "replace")
                    try:
                        out = getattr(sys.stderr, "buffer", None)
                        if out is not None:
                            out.write(chunk)
                            out.flush()
                        else:
                            sys.stderr.write(chunk.decode("utf-8", "replace"))
                    except Exception:  # noqa: BLE001 - a closed log is no reason
                        pass           # to stop draining the adapter
            except Exception:  # noqa: BLE001 - pipe closed under us
                return

        self._thread = threading.Thread(target=pump, daemon=True)
        self._thread.start()

    def text(self, wait: float = 1.0) -> str:
        if self._thread is not None:
            self._thread.join(wait)
        with self._lock:
            data = bytes(self._buf)
        return data.decode("utf-8", "replace").strip()


# Bundled adapters, keyed by registry name. External brokers onboard by
# appearing here (a user config entry) with their own adapter command;
# the hub itself treats every entry identically. Adapters ship INSIDE the
# brueconnect package, so their files exist wherever the package does.
def builtin_brokers(base: Path) -> dict:
    return {
        "paper": {
            "label": "Paper (built-in simulator)",
            "cmd": python_argv(base / "adapters" / "paper" / "paper_adapter.py",
                               ["--tick-ms", "200", "--warmup-bars", "30"]),
        },
        "novafx": {
            "label": "NovaFX (fictional demo broker)",
            "cmd": python_argv(base / "adapters" / "novafx" / "novafx_adapter.py",
                               ["--tick-ms", "200", "--warmup-bars", "30"]),
        },
        # Our own demo account, behind the same contract as everyone else's
        # broker. It is listed here rather than special-cased anywhere: the
        # point of the adapter is that this row is ordinary.
        "lse-sim": {
            "label": "LSE Demo Account",
            "cmd": python_argv(base / "adapters" / "lse_sim" / "lse_sim_adapter.py"),
            # The user's own key, from the terminal's config, passed as env so
            # it never travels in a protocol message (SPEC 8.5).
            "needs_lse_key": True,
        },
    }


# Sim brokers whose adapter ships inside the brueconnect package and whose
# public endpoint is announced by the hosted broker directory. Each entry names the
# bundled adapter file and how to turn a directory endpoint into the env that
# adapter reads, so the same adapter code the conformance trial certified runs
# unchanged, just pointed at the public host instead of loopback. A broker
# joins this map only once its adapter is bundled AND verified end to end over
# the public endpoint; listing one whose adapter is not here just means the
# directory shows it but this terminal cannot spawn it (handled like any
# listed-but-not-installed broker), never a broken connect.
def _http_base(ep: dict) -> str:
    scheme = "https" if ep.get("tls") else "http"
    return f"{scheme}://{ep['host']}:{ep['port']}"


def _ws_base(ep: dict) -> str:
    scheme = "wss" if ep.get("tls") else "ws"
    return f"{scheme}://{ep['host']}:{ep['port']}"


def _addr(ep: dict) -> str:
    # Raw TCP venues (FIX, the binary link, gRPC) dial host:port, not a URL.
    return f"{ep['host']}:{ep['port']}"


SIM_ADAPTERS = {
    # Northgate deals FIX 4.4 on a raw socket; the adapter dials host:port and
    # runs the whole session layer itself (logon, sequence numbers,
    # heartbeats, resend) with nothing but `socket`.
    "northgate": {
        "path": ("adapters", "northgate", "northgate_adapter.py"),
        "env": lambda ep, extra: {"NORTHGATE_ADDR": _addr(ep)},
    },
    # Sable Point is gRPC, implemented down to HTTP/2 frames, HPACK and the
    # protobuf wire format in pure stdlib, because grpcio is absent from most
    # machines this ships to and a pip dependency would make the broker
    # unconnectable for those users.
    "sablepoint": {
        "path": ("adapters", "sablepoint", "sablepoint_adapter.py"),
        "env": lambda ep, extra: {"SABLEPOINT_ADDR": _addr(ep)},
    },
    # Helix is signed REST on one port and a websocket feed on another, so the
    # feed port comes from the directory row's extra rather than being guessed
    # (it is not simply REST+1 by contract, only by today's coincidence).
    "helix": {
        "path": ("adapters", "helix", "helix_adapter.py"),
        "env": lambda ep, extra: {
            "HELIX_BASE_URL": _http_base(ep),
            "HELIX_WS_URL": "{}://{}:{}".format(
                "wss" if ep.get("tls") else "ws", ep["host"],
                extra.get("ws_port") or (int(ep["port"]) + 1)),
        },
    },
    "quantex": {
        "path": ("adapters", "quantex", "quantex_adapter.py"),
        "env": lambda ep, extra: {"QUANTEX_ADDR": _addr(ep)},
    },
    "vertex": {
        "path": ("adapters", "vertex", "vertex_adapter.py"),
        "env": lambda ep, extra: {"VERTEX_WS_URL": _ws_base(ep)},
    },
    "pemberton": {
        "path": ("adapters", "pemberton", "pemberton_adapter.py"),
        "env": lambda ep, extra: {"PEMBERTON_BASE_URL": _http_base(ep)},
    },
    "atlas": {
        "path": ("adapters", "atlas", "atlas_adapter.py"),
        "env": lambda ep, extra: {"ATLAS_BASE_URL": _http_base(ep)},
    },
    "meridian": {
        "path": ("adapters", "meridian", "meridian_adapter.py"),
        # MERIDIAN_AUTH=login: a human sits at this terminal, so Meridian is
        # connected with the interactive "Log in with Meridian" flow (the
        # user's own account) rather than machine self-registration (a fresh
        # anonymous account per state dir). Headless users of the same
        # adapter (conformance, bots) simply do not set it.
        "env": lambda ep, extra: {"MERIDIAN_BASE_URL": _http_base(ep),
                                  "MERIDIAN_AUTH": "login"},
    },
}


def directory_env(key: str, extra: dict) -> dict:
    """Fixed, documented demo settings a directory row hands its adapter.

    Some staged venues issue one fixed demo login in their documentation
    (a FIX CompID and user, a demo token) and ask nothing of the user. Those
    ride the row's `extra.env`, so the terminal carries no per-broker
    credential code and a row that says "no key entry required" is true.
    Guarded: only this broker's own names (NORTHGATE_* for northgate),
    string values, capped, so a row can never reach PATH, PYTHONPATH or
    another broker's process. The user's own typed BRUE_CRED_* still win
    inside adapters that read both.
    """
    env = extra.get("env") if isinstance(extra, dict) else None
    if not isinstance(env, dict):
        return {}
    prefix = re.sub(r"[^A-Z0-9]", "_", str(key).upper()) + "_"
    out = {}
    for k, v in env.items():
        if (isinstance(k, str) and isinstance(v, str) and k.startswith(prefix)
                and re.fullmatch(r"[A-Z0-9_]{1,64}", k) and len(v) <= 256):
            out[k] = v
    return out


def directory_brokers(base: Path, directory: dict | None, skip=()) -> dict:
    """Spawnable entries for directory-listed brokers whose adapter is bundled.

    The directory row carries the public endpoint; the SIM_ADAPTERS map carries
    how this build reaches that broker's adapter and what env feeds it the
    endpoint. A listed broker with no bundled adapter, or a bundled adapter file
    that is missing from this install, is skipped here and simply does not gain
    a connect action, exactly like any broker listed upstream but absent
    locally.
    """
    out: dict = {}
    for b in (directory or {}).get("brokers", []):
        key, ep = b.get("key"), b.get("endpoint")
        spec = SIM_ADAPTERS.get(key)
        if key in skip or not key or not ep or spec is None:
            continue
        adapter = base.joinpath(*spec["path"])
        if not adapter.is_file():
            continue
        out[key] = {
            "label": b.get("label") or key,
            "cmd": python_argv(adapter),
            # The endpoint is public config, not a secret, so it rides env like
            # any other adapter knob; the broker's own credentials (if its
            # credential_form asks for any) still land only in its 700 state dir.
            "endpoint_env": {**spec["env"](ep, b.get("extra") or {}),
                             **directory_env(key, b.get("extra") or {})},
        }
    return out


def registry_brokers(skip=()) -> dict:
    """Profiles the USER registered, from the brue-connect registry.

    This is the open-source door: `brueconnect add mybroker --command ...`
    and the broker appears in this terminal's connection picker on the next
    read, with no change here and no server-side listing. Nothing about it is
    second class; it goes through the same hub as ours.

    `skip` is the set of names we already run ourselves (the registry ships
    its own entries for the bundled adapters, and we run those with
    terminal-tuned arguments). Passed in rather than written here, because
    naming a broker in this file is the one thing it must never do.
    """
    try:
        from brueconnect import registry  # noqa: PLC0415
        reg = registry.load()
    except Exception:
        return {}
    out = {}
    for name, prof in (reg.get("brokers") or {}).items():
        # `builtin`: a profile that ships inside the brueconnect package
        # rather than in the user's own file. The bundled adapters this
        # terminal runs are in `skip`; any OTHER one the package ships is
        # not something the user linked, and listing it here would show
        # "linked by you" on a row they never added. Such an adapter is
        # offered through EXAMPLES instead, as a link the user chooses.
        if name in skip or prof.get("builtin") or not prof.get("command"):
            continue
        # What it will run, as a list: the registry's own answer (an argv
        # stored as a list, else its command string split).
        try:
            argv = (registry.profile_argv(prof)
                    if hasattr(registry, "profile_argv")
                    else shlex.split(prof["command"]))
        except Exception:  # noqa: BLE001 - an unreadable command still lists
            argv = None
        env = prof.get("env") if isinstance(prof.get("env"), dict) else {}
        out[name] = {"label": prof.get("description") or name,
                     "cmd": None,  # resolved at spawn, so {state} expands
                     # kept for identity fingerprinting only; the registry
                     # remains the authority on how to actually spawn it
                     "command": (shlex.join(prof["argv"]) if prof.get("argv")
                                 else prof["command"]),
                     "argv": argv,
                     # set when it was linked from EXAMPLES (see link())
                     "example": env.get(EXAMPLE_ENV) or None,
                     "registered": True}
    return out


def _clean_form(raw) -> list:
    """A handshake credential form (SPEC 3.2) by the SDK's own sanitiser.

    Empty with a brue-connect from before the form existed: there is then no
    rule to apply, and an unsanitised form is not one to draw.
    """
    try:
        from brueconnect import protocol  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return []
    fn = getattr(protocol, "sanitize_credential_form", None)
    return fn(raw) if fn else []


def _plain(value, limit: int) -> str:
    """One line of visible text: control characters out, capped. The cap
    leaves no space at the end ("...Holdings Group's terms", never
    "...Holdings Group 's")."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", "".join(
        " " if (ord(ch) < 32 or ord(ch) == 127) else ch
        for ch in value)).strip()[:limit].rstrip()


# --- the broker's terms (SPEC 3.3) ----------------------------------------
# What the broker's own agreement with its customer lets the terminal do with
# a connection. Two flags, and each one only takes something away:
#   data_local_only      the broker's market data (quotes, bars, history, the
#                        current price in positions) is shown and used on this
#                        computer, in the charts, the ticket, the dock and the
#                        user's own strategies, and is never handed to anything
#                        that sends it off the computer: an AI model, hosted
#                        or the user's own, our servers, a file made to share.
#   orders_by_hand_only  on a connection that is not paper, every order,
#                        close, modify and cancel follows the user's own action
#                        for that one order: the ticket, the dock, the chart.
# They come from the broker's own handshake and from our listing of it
# (EXAMPLES below, or a hosted directory row), and the STRICTER of the two
# applies, flag by flag. The listing holds before the first hello and when a
# hello fails, so a listed broker is never less restricted for being broken.
TERMS_FLAGS = ("data_local_only", "orders_by_hand_only")
TERMS_SUMMARY_CHARS = 200
# A position's fields that are the account's own record (SPEC 4, Position;
# SPEC 3.3): its size, side, entry price, the levels the user set, and the
# charges already booked (swap, commission). For a data_local_only connection
# nothing else is handed on: a current price or a market value is market
# data, and the unrealised P/L is marked to the current price, so with the
# size and the entry price it gives that price back.
POSITION_RECORD_FIELDS = frozenset({
    "position_id", "client_id", "symbol", "side", "qty", "avg_price", "sl",
    "tp", "trail_points", "swap", "commission", "opened_at", "from_order"})
# The account's own record (SPEC 4, account.get): its balance, its currency
# and its names. Equity, margin in use and free margin are marked to the
# current prices of its positions, so for a data_local_only connection they
# are withheld with them.
ACCOUNT_RECORD_FIELDS = frozenset({"balance", "currency", "account_id",
                                   "label"})
# An Order and a Fill as SPEC 4 names their fields (orders.list,
# history.fills): the account's own record of what it asked for and what was
# done, its prices among them (the levels set, the price it filled at). A
# fill keeps its booked money: its fees, and the realised P/L, swap and
# commission some adapters add to one (the figures SPEC 5's position.closed
# books), which give back no price the fill does not already state. For a
# data_local_only connection a program gets these and nothing else: a field
# an adapter adds beside them, its own x_ field or another, may carry a
# current price. An order's `reason` is the broker's own words, said as the
# sentence for a program (server._record_rows). Three more are kept, none of
# them a price: an order's trailing distance and its OCO group (what
# order.place was given, SPEC 4), and a fill's reason_detail, the broker's own
# word for why it happened (SPEC 5's position.closed names it).
ORDER_RECORD_FIELDS = frozenset({
    "order_id", "client_id", "symbol", "type", "side", "qty", "filled_qty",
    "remaining_qty", "price", "stop_price", "sl", "tp", "expiry", "expires_at",
    "state", "placed_at", "done_at", "fill_price", "reason", "trail_points",
    "oco_group"})
FILL_RECORD_FIELDS = frozenset({
    "fill_id", "order_id", "position_id", "client_id", "symbol", "side", "qty",
    "price", "fees", "time", "realized_pnl", "swap", "commission",
    "reason_detail"})
# What is held back from an account and its positions, in a sentence.
MARKED_TO_PRICE = "Current prices, open P/L, equity and margin"
# An instrument as the broker's contract for it (SPEC 4, InstrumentSpec):
# what it is, how it is dealt and charged, and when, with the shape of each
# of its objects. For a data_local_only connection a program gets this record
# only, all the way down: a key an adapter adds beside the fields, or inside
# one of the objects (its fees, sessions, early closes, margin tiers and
# dividend), is left out, and so is a value of another shape (an object where
# a figure goes), so a field added later is withheld by default at every
# level. A field's shape is "figure" (a string, number, true or false), a
# list of a shape, or an object of named fields; null is a value of its own
# (no margin tiers, no dividend, no expiry).
_FIGURE = "figure"


def _record_object(*figures, **shaped) -> tuple:
    return ("object", {**{k: _FIGURE for k in figures}, **shaped})


def _record_list(of) -> tuple:
    return ("list", of)


INSTRUMENT_RECORD = {
    **{k: _FIGURE for k in (
        "symbol", "name", "asset_class", "base_ccy", "quote_ccy", "digits",
        "tick_size", "tick_value", "tick_value_account", "lot_step",
        "min_qty", "max_qty", "min_notional", "contract_size", "margin_rate",
        "margin_maintenance_rate", "tradable", "shortable", "trade_mode",
        "stops_level_points", "swap_long", "swap_short", "swap_mode",
        "swap_3day_dow", "expires_at", "successor")},
    "margin_tiers": _record_list(_record_object("above_notional", "margin_rate")),
    "sessions": _record_list(_record_object("open", "close", "tz",
                                            days=_record_list(_FIGURE))),
    "holidays": _record_list(_FIGURE),
    "early_closes": _record_list(_record_object("date", "close", "tz")),
    "fees": _record_object("commission_per_lot", "mode", "rate", "min"),
    "dividend": _record_object("ex_date", "amount_per_share"),
}
INSTRUMENT_RECORD_FIELDS = frozenset(INSTRUMENT_RECORD)
# Two of SPEC 4's figures a broker may work out from a price. The minimum stop
# distance (stops_level_points) may be stated as a share of the price and
# handed on in points of it, so that with the tick size it gives the price
# back; a tick's value in the account's currency (tick_value_account) is
# converted at the broker's own rate. Each is withheld from a program on a
# data_local_only connection unless our listing says that broker's adapter
# sends it as a fixed figure (EXAMPLES `priced`, BrokerHub.priced_fields):
# a fixed figure gives no price back, and a program that finds the minimum
# stop missing reads SPEC's default, 0, which says there is none.
PRICED_FIELDS = ("stops_level_points", "tick_value_account")


def _no_terms() -> dict:
    return {f: False for f in TERMS_FLAGS}


def _all_terms() -> dict:
    return {f: True for f in TERMS_FLAGS}


def clean_terms(raw) -> dict:
    """A statement of a broker's terms, safe to act on and to show. Never
    raises. Always both flags, as booleans.

    By the kit's own sanitiser (protocol.sanitize_terms, SPEC 3.3), so the
    terminal reads a handshake exactly as the SDK does. A kit from before
    1.11 has none, and the same rule is written out here: absent, false or
    null is false; anything else is TRUE; terms that are not an object set
    both. A restriction that cannot be read is a restriction.
    """
    fn = None
    try:
        from brueconnect import protocol  # noqa: PLC0415
        fn = getattr(protocol, "sanitize_terms", None)
    except Exception:  # noqa: BLE001 - no kit: the rule below
        fn = None
    if fn is not None:
        try:
            out = fn(raw)
        except Exception:  # noqa: BLE001 - it says it never raises
            out = None
        if (isinstance(out, dict)
                and all(isinstance(out.get(f), bool) for f in TERMS_FLAGS)):
            return dict(out)
        return _all_terms()
    if raw is None:
        return _no_terms()
    if not isinstance(raw, dict):
        return _all_terms()
    out = {f: (f in raw and raw[f] is not None and raw[f] is not False)
           for f in TERMS_FLAGS}
    summary = _plain(raw.get("summary"), TERMS_SUMMARY_CHARS)
    if summary:
        out["summary"] = summary
    url = raw.get("url")
    if isinstance(url, str) and re.fullmatch(r"https://\S{1,192}", url.strip()):
        out["url"] = url.strip()
    return out


def merge_terms(*parts) -> dict:
    """The stricter of several statements of one broker's terms, flag by
    flag (SPEC 3.3): a flag any part sets is set. Each part is a cleaned
    terms dict, or None for a source that said nothing.

    The summary comes from the first part in the order given that sets every
    flag the merge sets, so a summary shown alone never leaves out a
    restriction in force. With both in force, terms_said follows it with the
    terminal's own clause naming each, unless the summary is our listing's
    own and the listing says it names both (terms_cover); then it is said
    alone. When no part sets every flag there is no summary, and the
    terminal's own sentence names each one. A url stays with its own summary;
    only when there is no summary does the first part that has a url give it.
    """
    out = _no_terms()
    parts = [p for p in parts if isinstance(p, dict)]
    for p in parts:
        for f in TERMS_FLAGS:
            if p.get(f):
                out[f] = True
    for p in parts:
        if p.get("summary") and all(p.get(f) for f in TERMS_FLAGS if out[f]):
            out["summary"] = p["summary"]
            if p.get("url"):
                out["url"] = p["url"]
            break
    if "summary" not in out:
        for p in parts:
            if p.get("url"):
                out["url"] = p["url"]
                break
    return out


def _sentence(text: str) -> str:
    t = str(text or "").strip()
    return t if not t or t.endswith((".", "!", "?")) else t + "."


def _possessive(name: str) -> str:
    """"Northwind's", "Example.com's", but "Fixture Markets'": a name ending
    in s takes the apostrophe alone."""
    name = str(name or "")
    return name + ("'" if name[-1:] in ("s", "S") else "'s")


def terms_said(name: str, terms: dict, covers=()) -> str:
    """The terms in plain words. With one restriction in force, the broker's
    own summary when it gave one (merge_terms took it from a source that
    sets that flag), else a sentence of ours. With both, the summary when
    there is one, then the terminal's own sentence naming each: a summary
    may speak of only one, and the user must read both. `covers` names the
    restrictions the summary itself is known to name (our listing says so,
    terms_cover); when it names both, the summary is said alone, so the row
    does not say each restriction twice. Empty for a broker whose terms
    restrict nothing."""
    data = terms.get("data_local_only")
    hand = terms.get("orders_by_hand_only")
    whose = _possessive(name)
    if data and hand:
        both = (f"{whose} terms keep its prices on this computer and have "
                "you place each order on a live account yourself.")
        if terms.get("summary"):
            if set(TERMS_FLAGS) <= set(covers or ()):
                return _sentence(terms["summary"])
            return f"{_sentence(terms['summary'])} {both}"
        return both
    if terms.get("summary"):
        return _sentence(terms["summary"])
    if data:
        return f"{whose} terms keep its prices on this computer."
    if hand:
        return (f"{whose} terms have you place each order on a live account "
                "yourself.")
    return ""


def withheld_text(name: str, terms: dict, what: str = "") -> str:
    """Why a data_local_only connection's market data is not handed on, in
    one plain sentence that names the broker's terms: its summary, else a
    sentence of ours. `what` names what was held back ("EURUSD candles")."""
    lead = f"{what} withheld" if what else "Withheld"
    whose = _possessive(name)
    # With both restrictions in force the summary may be about the orders,
    # so the reason for the prices is given in the terminal's own words.
    if terms.get("summary") and not terms.get("orders_by_hand_only"):
        return f"{lead} under {whose} terms: {_sentence(terms['summary'])}"
    return f"{lead} under {whose} terms, which keep its prices on this computer."


def by_hand_text(name: str) -> str:
    """Why an order that is not the user's own action is not sent to an
    orders_by_hand_only connection that is not paper. Read by assistants and
    programs, so it names the user, and the window every user action comes
    from (the ticket, the positions, the chart)."""
    return (f"Not sent: under {_possessive(name)} terms each order on a live "
            "account is placed by the user, in the terminal's own window.")


def _arm_takes_by_hand(c) -> bool:
    """Whether this kit's Connector.arm() takes the platform's by_hand word
    (Brue Connect 1.11's rule for orders_by_hand_only, SPEC 3.3)."""
    import inspect  # noqa: PLC0415
    try:
        return "by_hand" in inspect.signature(c.arm).parameters
    except (TypeError, ValueError):
        return False


def record_only(position) -> tuple:
    """A position as the account's own record (POSITION_RECORD_FIELDS), and
    the names of the fields left out. A stop the broker trails (a non-zero
    trail_points, SPEC 4) is moved by the broker from the price, so its
    level is not one the user set: with the distance it gives back the best
    price since entry, and it is left out. The distance itself stays."""
    if not isinstance(position, dict):
        return {}, []
    keep = POSITION_RECORD_FIELDS
    if position.get("trail_points"):
        keep = POSITION_RECORD_FIELDS - {"sl"}
    kept = {k: v for k, v in position.items() if k in keep}
    return kept, sorted(k for k in position if k not in keep)


def row_record_only(row, fields) -> tuple:
    """An order or a fill as the account's own record (ORDER_RECORD_FIELDS,
    FILL_RECORD_FIELDS), and the names of the fields left out."""
    if not isinstance(row, dict):
        return {}, []
    kept = {k: v for k, v in row.items() if k in fields}
    return kept, sorted(k for k in row if k not in fields)


def priced_names(row, dropped) -> list:
    """Of the fields left out of a record, those a withheld line names: the
    ones whose value can carry a price. A null, true or false carries none,
    so it is left out without a line saying a price was held back."""
    if not isinstance(row, dict):
        return []
    return [k for k in dropped
            if not (row.get(k) is None or isinstance(row.get(k), bool))]


def account_record_only(account) -> tuple:
    """An account as its own record (ACCOUNT_RECORD_FIELDS), and the names of
    the fields left out."""
    if not isinstance(account, dict):
        return {}, []
    kept = {k: v for k, v in account.items() if k in ACCOUNT_RECORD_FIELDS}
    return kept, sorted(k for k in account if k not in ACCOUNT_RECORD_FIELDS)


def fate_unknown(error) -> bool:
    """Whether a mutating call that failed with `error` may still have been
    carried out (SPEC 2): the kit gave up waiting for its answer (the request
    was written, no answer came in time), or the adapter says it does not
    know yet (code internal, retryable: the broker took it and its answer was
    lost). Asking again under the same client_id is then answered from the
    broker's own record, never carried out twice. A refusal, a request never
    sent, and a final answer are known."""
    if isinstance(error, TimeoutError):
        return True
    if not getattr(error, "retryable", False):
        return False
    code = getattr(error, "effective_code", None) or getattr(error, "code", None)
    return code == "internal"


# Which of a profile's values are taken out of its adapter's words
# (BrokerHub._secrets, _redact): the rule, with its one closed list of mode
# words and its secret-worded parts.
#   - A stored credential (what the row's key form saved) is taken out
#     wherever it appears when it is HIDDEN_MIN or more characters, whatever
#     it looks like. A shorter one never is: taken out of every word that
#     holds it, one or two characters garble the adapter's words (a digit
#     taken out of every price).
#   - A value of the profile's own env is taken out when
#     (a) its name is secret-worded (secret_name: a part of it, plural,
#         numbered or glued to another word, is a secret word), and the
#         value is HIDDEN_MIN or more characters and not one of MODE_WORDS
#         as it is written (AUTH_MODE=password and a sign-in mode such as
#         login are kept; PASSWORD=swordfish is not: a rule that kept every
#         value of lower-case letters here would show a secret of lower-case
#         letters);
#     (b) whatever its name, it looks like a key (_looks_like_key), judged
#         before any rule that keeps a plain word or a number, unless it is
#         an address, a host and a port and nothing else (_ADDRESS), which
#         is judged as that address in a URL is;
#     (c) of a URL: its userinfo, its query's values (one under a key that
#         is secret-worded judged as in (a)), and each part of its path of
#         20 or more characters of [A-Za-z0-9_-] (_url_secrets).
#   - Anything else is kept: a plain word, a number, a path, an address, a
#     URL without those parts. Env holds the adapter's settings as well as
#     its keys, and its words name those settings. Every value the terminal
#     itself gives its own rows' adapters (EXAMPLES, SIM_ADAPTERS) is such a
#     setting, and a test holds each one kept.
HIDDEN_MIN = 4
SECRET_WORDS = frozenset(
    "KEY APIKEY SECRET TOKEN PASS PASSWORD PASSWD PASSPHRASE PASSCODE PASSKEY PWD PW PIN "
    "AUTH CRED CREDS CREDENTIAL CREDENTIALS COOKIE SESSION SID PRIVATE SIGN SIGNATURE "
    "MNEMONIC SEED OTP TOTP BEARER JWT WEBHOOK DSN".split())
# The secret words of five letters or more that make a part secret-worded at
# either end of it, glued to another word (APISECRET, SECRETKEY, ACCESSTOKEN,
# PRIVATEKEY, PASSWORDS). A shorter one counts only as the whole part, plural
# or numbered (KEYS, PIN2): inside a longer word it is no secret (PING holds
# PIN, MONKEY holds KEY, BYPASS, PASSIVE and COMPASS hold PASS, CREDIT holds
# CRED).
SECRET_ENDS = frozenset(
    "SECRET TOKEN PASSWORD PASSWD PASSCODE PASSKEY PASSPHRASE PRIVATE SESSION CREDENTIAL "
    "SIGNATURE BEARER COOKIE MNEMONIC".split())
# Glued words that hold a short secret word and are secret wherever they
# stand in a part (XAPIKEYID, MYSESSIONIDS), and the one header's name.
SECRET_INSIDE = ("AUTHTOKEN", "APIKEY", "SESSIONID")
SECRET_PART = "AUTHORIZATION"
# The one closed list of the words a setting under a secret-worded name may
# say and be kept (how to sign in, which kind of account, which form, on or
# off): never a secret. A word joins it only with its case in the rule's test
# (tests/test_hidden_words_rule.py). Those shorter than HIDDEN_MIN are kept
# by the floor anyway.
MODE_WORDS = frozenset(
    "password passwd passphrase token oauth oauth2 basic bearer digest hmac apikey key "
    "cookie session header query body none off on true false yes no paper practice demo "
    "live sandbox test prod production default auto manual plain rsa ed25519 sha256 "
    "utc login register signin signup sso oidc saml device interactive refresh".split())
# A name's parts: split at "_", "-" and ".", and where a lower-case letter
# meets a capital ("myApiKey" is my, Api, Key).
_NAME_SPLIT = re.compile(r"[_.\-]+|(?<=[a-z])(?=[A-Z])")
_PLAIN_WORD = re.compile(r"[^\W\d_]+(?:[-_.'][^\W\d_]+)*")
_NUMBER = re.compile(r"[+-]?(?:\d+(?:,\d{3})*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
# A path: where it starts says so (its folder, home, here, a share, a drive,
# or the profile's own state folder before it is expanded).
_PATH = re.compile(r"/|~|\.{1,2}[/\\]|\\\\|[A-Za-z]:[\\/]|\{state\}")
_KEY_CHARS = re.compile(r"[A-Za-z0-9+/=_-]{20,}")
_SECRET_PATH_PART = re.compile(r"[A-Za-z0-9_-]{20,}")
_URL = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
# An address: a host and a port and nothing else, as a directory row's
# endpoint is handed to a venue's adapter (_addr): a host name whose last
# label is letters, localhost, or an IPv4 address. A URL's host and port are
# never taken out, and the same address without its scheme is not either.
_HOST_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_ADDRESS = re.compile(
    rf"(?:localhost|(?:\d{{1,3}}\.){{3}}\d{{1,3}}|(?:{_HOST_LABEL}\.)+[A-Za-z]{{2,63}})"
    r":(\d{1,5})")


def _address(value: str) -> bool:
    """Whether a value is a host and a port (1 to 65535) and nothing else."""
    m = _ADDRESS.fullmatch(value)
    return bool(m) and 0 < int(m.group(1)) <= 65535


def name_parts(name) -> list:
    """The parts of an env name or a query key, as secret_name reads them."""
    return [p for p in _NAME_SPLIT.split(str(name or "")) if p]


def _secret_part(part) -> bool:
    """Whether one part of a name is secret-worded (secret_name)."""
    p = str(part).upper()
    bare = p.rstrip("0123456789")
    for form in {p, bare, bare[:-1] if bare.endswith("S") else bare}:
        if form and (form in SECRET_WORDS or form == SECRET_PART
                     or any(form.startswith(w) or form.endswith(w) for w in SECRET_ENDS)
                     or any(w in form for w in SECRET_INSIDE)):
            return True
    return False


def secret_name(name) -> bool:
    """Whether a name is secret-worded: one of its parts, in any case, with a
    trailing plural S or trailing digits taken off, is one of SECRET_WORDS
    (LOGIN_PW, KEYS, PASSWORD2); or begins or ends with one of SECRET_ENDS
    (APISECRET, SECRETKEY, ACCESSTOKEN); or is AUTHORIZATION; or holds one
    of SECRET_INSIDE (XAPIKEYID). A short secret word inside a longer word is
    none: PING_INTERVAL_S, BYPASS, PASSIVE, COMPASS and CREDIT_LIMIT are
    plain."""
    return any(_secret_part(p) for p in name_parts(name))


def _word_or_number(value: str) -> bool:
    return bool(_PLAIN_WORD.fullmatch(value) or _NUMBER.fullmatch(value))


def _mode_word(value: str) -> bool:
    """Whether a value is one of MODE_WORDS as it is written ("password",
    never "Password" or "password1")."""
    return value in MODE_WORDS


def _looks_like_key(value: str) -> bool:
    """12 or more characters with both letters and digits and no space, or
    20 or more characters of [A-Za-z0-9+/=_-]."""
    if (len(value) >= 12 and not any(ch.isspace() for ch in value)
            and any(ch.isalpha() for ch in value) and any(ch.isdigit() for ch in value)):
        return True
    return bool(_KEY_CHARS.fullmatch(value))


def _query_value_hidden(key: str, value: str) -> bool:
    """A query value is a URL's secret unless it is short, or a plain word
    or a number under a key that is not secret (a page, a tier, a mode); under
    a secret-worded key (secret_name: accesstoken, passcode) only a mode word
    (MODE_WORDS) is kept, as for an env name."""
    if len(value) < HIDDEN_MIN:
        return False
    if secret_name(key) and not _mode_word(value):
        return True
    return _looks_like_key(value) or not _word_or_number(value)


def _url_secrets(value: str):
    """Of a URL, what is secret in it, as written and decoded: its userinfo
    (and its password alone), its query's values (_query_value_hidden), and
    each part of its path of 20 or more characters of [A-Za-z0-9_-] (a
    webhook's address is its secret). None when `value` is not a URL."""
    if not _URL.match(value):
        return None
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return []
    out = []
    if "@" in parts.netloc:
        info = parts.netloc.rsplit("@", 1)[0]
        out += [info, urllib.parse.unquote(info)]
        pw = info.partition(":")[2]
        out += [pw, urllib.parse.unquote(pw)]
    for piece in parts.query.split("&"):
        key, _, raw = piece.partition("=")
        key = urllib.parse.unquote_plus(key)
        for v in (raw, urllib.parse.unquote_plus(raw)):
            if _query_value_hidden(key, v):
                out.append(v)
    for part in parts.path.split("/"):
        for v in (part, urllib.parse.unquote(part)):
            if _SECRET_PATH_PART.fullmatch(v):
                out.append(v)
    return list(dict.fromkeys(v for v in out if len(v) >= HIDDEN_MIN))


def env_hidden(name, value) -> list:
    """What of one env entry of a profile is taken out of its adapter's
    words, by the rule above: the whole value under a secret name (a) or when
    it looks like a key and is no address (b); of a URL, its secret parts
    (c). Nothing of a value shorter than HIDDEN_MIN."""
    if not isinstance(value, str) or len(value) < HIDDEN_MIN:
        return []
    out = []
    if secret_name(name) and not _mode_word(value):
        out.append(value)
    url = _url_secrets(value)
    if url is not None:
        out += url
    elif not _PATH.match(value) and not _address(value) and _looks_like_key(value):
        out.append(value)
    return list(dict.fromkeys(out))


def caps_of(c, part: str | None = None) -> dict:
    """A connection's hello's capabilities (SPEC 3), or one part of them
    ("data", "orders", "accounts"...): {} when the hello lacks it or sends
    anything but an object for it (null, a list, a string). What is absent
    from capabilities is absent from the broker, however it is said."""
    hello = getattr(c, "handshake", None)
    caps = hello.get("capabilities") if isinstance(hello, dict) else None
    if not isinstance(caps, dict):
        return {}
    if part is None:
        return caps
    got = caps.get(part)
    return got if isinstance(got, dict) else {}


def cap_flag(c, part: str, name: str) -> bool:
    """One capability flag of a connection's hello, read as SPEC 3 says flags
    are said: true only when it is the boolean true. A flag said as a string
    ("false", or "true"), a number or anything else is absent, and what is
    absent from capabilities is absent from the broker."""
    return caps_of(c, part).get(name) is True


# A client_id as the routes take one back (server._client_id_of).
_CLIENT_ID_RE = re.compile(r"[A-Za-z0-9][!-~]{0,127}")


def new_client_id(kind: str, ref=None, qty=None) -> str:
    """A new request's client_id (SPEC 2), for `kind` "order", "cancel" or
    "close": an order's `lset-<12 hex>`; a cancel's `cancel-<order id>-<8
    hex>` and a close's `close-<position id>-<qty or all>-<8 hex>`, which name
    what they act on in the adapter's own log. One that the routes could not
    take back (an id with a space in it, or too long) is `lset-<kind>-<12
    hex>` instead, so whoever is given it can ask again with it."""
    if kind == "cancel":
        cid = f"cancel-{ref}-{uuid.uuid4().hex[:8]}"
    elif kind == "close":
        cid = f"close-{ref}-{qty or 'all'}-{uuid.uuid4().hex[:8]}"
    else:
        cid = f"lset-{uuid.uuid4().hex[:12]}"
    if not _CLIENT_ID_RE.fullmatch(cid):
        cid = f"lset-{kind}-{uuid.uuid4().hex[:12]}"
    return cid


def _note_attempt(error, client_id: str) -> None:
    """Tag a failed mutating call with what asking again needs: the
    client_id it went under, and whether its fate is known. The engine's
    route reads both (server._hub_call)."""
    try:
        error.client_id = client_id
        error.fate_unknown = fate_unknown(error)
        if isinstance(error, TimeoutError):
            error.retryable = True
    except Exception:  # noqa: BLE001 - an exception that takes no attributes
        pass


_LEFT_OUT = object()


def _record_shaped(value, shape, path: str, dropped: set):
    """`value` kept to `shape` (INSTRUMENT_RECORD), or _LEFT_OUT. What is
    left out is added to `dropped` by its path: "fees.x_spread" for a key of
    an object, the list's own path for an item of the wrong shape."""
    if value is None:
        return None
    if shape == _FIGURE:
        if isinstance(value, (str, int, float, bool)):
            return value
        dropped.add(path)
        return _LEFT_OUT
    kind, inner = shape
    if kind == "list":
        if not isinstance(value, list):
            dropped.add(path)
            return _LEFT_OUT
        out = []
        for item in value:
            kept = _record_shaped(item, inner, path, dropped)
            if kept is not _LEFT_OUT:
                out.append(kept)
        return out
    if not isinstance(value, dict):
        dropped.add(path)
        return _LEFT_OUT
    out = {}
    for k, v in value.items():
        if k not in inner:
            dropped.add(f"{path}.{k}")
            continue
        kept = _record_shaped(v, inner[k], f"{path}.{k}", dropped)
        if kept is not _LEFT_OUT:
            out[k] = kept
    return out


def instrument_record_only(spec, priced=PRICED_FIELDS) -> tuple:
    """An instrument as the broker's contract for it (INSTRUMENT_RECORD, all
    the way down), less `priced`, the figures this broker may work out from a
    price (BrokerHub.priced_fields); and the paths of what was left out,
    sorted. The input is not changed."""
    if not isinstance(spec, dict):
        return {}, []
    dropped: set = set()
    kept = {}
    for k, v in spec.items():
        if k not in INSTRUMENT_RECORD or k in priced:
            dropped.add(k)
            continue
        shaped = _record_shaped(v, INSTRUMENT_RECORD[k], k, dropped)
        if shaped is not _LEFT_OUT:
            kept[k] = shaped
    return kept, sorted(dropped)


class BrokerHub:
    def __init__(self, connect_dir: Path, identity_cache: Path | None = None):
        self.connect_dir = connect_dir
        try:
            # The brueconnect package dir: where bundled adapters live, for
            # both the builtins and the directory-listed sim brokers.
            self.base = connect_base(connect_dir)
            # Where adapter FILES are run from, and what goes on their
            # import path: the clean SDK directory when this install has one
            # (see SDK_DIRNAME), else the package the engine imports. Bundled
            # adapters put their own grandparent directory first on sys.path,
            # so running the clean copy is also what keeps _internal off it.
            self.sdk = sdk_dir(self.base)
            self.adapter_base = (self.sdk / "brueconnect" if self.sdk
                                 else self.base)
            self._installed = builtin_brokers(self.adapter_base)
        except ImportError:
            # no wheel and no checkout: an empty broker list, never a crash
            self.base = None
            self.sdk = None
            self.adapter_base = None
            self._installed = {}
        self.directory: dict | None = None
        self.conns: dict[str, object] = {}
        self.quotes: dict[str, dict[str, dict]] = {}
        # Quote ownership belongs to a connection generation. The display
        # replaces its ticket/held-position set; provider readers remain
        # additive and must not lose a shared symbol on a chart switch.
        self._quote_owners: dict[str, dict] = {}
        # Brokers mid-login (SPEC 1.6 interactive auth): the adapter is
        # spawned and waiting on its loopback for the user to finish the
        # broker's own login page. broker -> {"c", "url", "expires"}. Kept
        # OUT of self.conns: a half-authenticated adapter must never answer
        # quotes/orders paths as if it were a connection.
        self.pending_auth: dict[str, dict] = {}
        # Last known account list per broker, so a CONNECTED broker can still
        # show you every account the login reaches and mark the one in use.
        # Read once per connect rather than per status poll: the picker needs
        # the list, not a live balance feed for accounts nobody is trading.
        self.account_lists: dict[str, list] = {}
        self.lock = threading.RLock()
        # One lock per broker for spawning, so a probe of a slow broker never
        # blocks quotes or an order on a different one, and two probes of the
        # SAME broker cannot both spawn its adapter (which for a broker that
        # opens an account on first run means two accounts).
        self._spawn_locks: dict[str, threading.Lock] = {}
        # Last handshake identity per broker, so the picker can show a
        # broker's own name BEFORE it is connected. Without this the first
        # paint of the menu can only show the profile name, and every row
        # would change under the user's cursor on connect.
        self._identity_cache = identity_cache
        self._remembered: dict[str, dict] = self._load_identities()
        # Why the last connect or probe of a broker failed, until the next
        # attempt: {"message", "stderr", "at"}. Shown on the broker's card,
        # which otherwise loses the reason on its next repaint.
        self.last_errors: dict[str, dict] = {}
        # What each profile's ended adapter processes printed, kept across
        # its runs for the window's Connections card (status_one `printed`,
        # with the live process's lines after them): a data_local_only
        # adapter's lines go nowhere else, and the engine's own log says the
        # card shows them. One record per run, {"text", "held"}: `held` is
        # the sentence when that run's lines were held under the terms in
        # force for it, else None, so a program is never given the lines of
        # a run that was held, whatever the terms are when it reads them
        # (printed_lines). The last few KB, the latest last.
        self._printed_runs: dict[str, list] = {}
        # Where in a connection's events each order's first attempt began:
        # (broker, client_id) -> (connector, mark). Asking again under the
        # same client_id looks from there, so an outcome that arrived in
        # between (the fill of an order whose answer was lost) is found.
        self._order_marks: dict = {}
        self.registry: dict = {}
        self._rebuild_registry()

    def _rebuild_registry(self):
        """The visible broker set: what we ship, what the directory allows,
        plus whatever the user linked themselves.

        Built whole and rebound in one statement. Mutating the live dict in
        place let a concurrent list_brokers() iterate a half-built registry.

        The user's own registry is re-read here rather than cached, so a
        broker linked with `brueconnect add` while the terminal is running
        shows up on the next look instead of after a restart. It is one small
        JSON file; a menu that is right is worth a stat and a read.
        """
        reg = dict(self._installed)
        if self.directory:
            listed = {b["key"]: b for b in self.directory.get("brokers", [])
                      if isinstance(b, dict) and b.get("key")}
            reg = {}
            for k, v in self._installed.items():
                if k in listed:
                    reg[k] = {**v, "label": listed[k].get("label") or v["label"]}
                elif v.get("needs_lse_key"):
                    # Our own demo account rides the user's LSE key; it is not
                    # a third-party broker listing, so it is absent from the
                    # public directory. Filtering it out here would drop the
                    # BUILTIN too and orphan the ticket's demo path: the ticket
                    # would fall back to paper while the account dock kept
                    # painting a demo account it could no longer reach.
                    # Directory rows govern third-party brokers; a key-gated
                    # builtin is governed by the key.
                    reg[k] = dict(v)
        # Fleet-listed brokers whose adapter we bundle (endpoint from the
        # directory). Added BEFORE the user registry, and both use
        # setdefault, so a listed bundled broker wins over a user's own
        # profile of the same name. link() therefore refuses those names
        # rather than store a profile that would never be used.
        if self.adapter_base is not None:
            for name, entry in directory_brokers(
                    self.adapter_base, self.directory,
                    skip=set(self._installed)).items():
                reg.setdefault(name, entry)
        for name, entry in registry_brokers(skip=set(self._installed)).items():
            reg.setdefault(name, entry)
        # A directory broker this build cannot spawn: its adapter shipped in a
        # newer release than the one running (or is not bundled at all). It
        # is listed anyway, as a row that says so, because a broker that
        # silently never appears teaches the user nothing; "update to use it"
        # does. No command, so nothing here can ever try to start it.
        if self.directory:
            for b in self.directory.get("brokers", []):
                k = b.get("key") if isinstance(b, dict) else None
                if k and k not in reg:
                    reg[k] = {"label": b.get("label") or k,
                              "update_required": True}
        # A broker holding a live connection stays listed even if the hosted
        # directory dropped it or the user unlinked its profile. The session is
        # real either way, and delisting it stranded the adapter: it vanished
        # from the picker, so nothing could offer to close it, and disconnect
        # refused it as an unknown broker. It leaves the list when it is
        # disconnected, not before.
        for name in list(self.conns):
            if name not in reg:
                prev = self.registry.get(name) or {}
                reg[name] = {**prev, "label": prev.get("label") or name,
                             "unlinked": True}
        self.registry = reg

    # == remembered identity =============================================
    # Cached against the adapter command that produced it. A profile whose
    # command changed is a different broker wearing an old name, and showing
    # the previous broker's name for it is the one mistake a connection
    # picker must never make.
    CACHE_VERSION = 2

    def _load_identities(self) -> dict:
        if self._identity_cache is None:
            return {}
        try:
            d = json.loads(self._identity_cache.read_text())
        except Exception:
            return {}
        if not isinstance(d, dict) or d.get("v") != self.CACHE_VERSION:
            return {}  # a cache is disposable; re-learn rather than guess
        entries = d.get("brokers")
        return entries if isinstance(entries, dict) else {}

    def _fingerprint(self, broker: str) -> str:
        """What this profile points at right now, as a comparable string."""
        entry = self.registry.get(broker) or {}
        cmd = entry.get("cmd")
        return " ".join(cmd) if cmd else str(entry.get("command", ""))

    def identity_of(self, broker: str) -> dict:
        rec = self._remembered.get(broker) or {}
        if rec.get("cmd") != self._fingerprint(broker):
            return {}
        ident = rec.get("identity")
        return ident if isinstance(ident, dict) else {}

    def form_of(self, broker: str) -> list:
        """The credential form this broker's own handshake declared (SPEC
        3.2), remembered with its identity so the connect form can be drawn
        before anything is spawned. Sanitised again on the way out of the
        cache: the file is on disk and this text is bound for a screen."""
        rec = self._remembered.get(broker) or {}
        if rec.get("cmd") != self._fingerprint(broker):
            return []
        return _clean_form(rec.get("credential_form"))

    def _forget(self, broker: str):
        with self.lock:
            if self._remembered.pop(broker, None) is not None:
                self._save_identities()

    def _remember(self, broker: str, identity: dict, form=None, terms=None,
                  multi=None):
        with self.lock:
            rec = {"cmd": self._fingerprint(broker), "identity": identity}
            form = _clean_form(form)
            if form:
                rec["credential_form"] = form
            # The terms the handshake declared (SPEC 3.3), kept with the
            # identity so they still hold when a later hello fails: a broker
            # that said its prices stay on this computer is not believed to
            # have changed its mind by an adapter that will not start.
            if terms is not None:
                rec["terms"] = clean_terms(terms)
            # Whether its login can reach several accounts (SPEC 1.7), so the
            # Connections screen knows before any connect that the account,
            # and so whether it is live, is still to be chosen. Kept either
            # way: a record without it (an earlier build's) is not known.
            if multi is not None:
                rec["multi"] = bool(multi)
            self._remembered[broker] = rec
            self._save_identities()

    @staticmethod
    def _accounts_multi(c) -> bool:
        """Whether this connection's hello said its login can reach several
        accounts (capabilities.accounts.multi, SPEC 1.7)."""
        return cap_flag(c, "accounts", "multi")

    def remembered_multi(self, broker: str) -> bool | None:
        """Whether this profile's last hello said its login can reach
        several accounts: True or False, or None when that is not known (no
        hello remembered, its command changed since, or a record kept by a
        build from before it was remembered)."""
        rec = self._remembered.get(broker) or {}
        if rec.get("cmd") != self._fingerprint(broker) or not isinstance(rec.get("multi"), bool):
            return None
        return rec["multi"]

    def _save_identities(self):
        with self.lock:
            if self._identity_cache is None:
                return
            try:
                self._identity_cache.parent.mkdir(parents=True, exist_ok=True)
                tmp = self._identity_cache.with_suffix(".tmp")
                tmp.write_text(json.dumps(
                    {"v": self.CACHE_VERSION, "brokers": self._remembered},
                    indent=1))
                tmp.replace(self._identity_cache)
            except OSError:
                pass  # a picker that forgets a name is not worth an error

    # == the broker's terms (SPEC 3.3) ===================================
    # Unlike the identity above, these are acted on: every path that would
    # send a connection's market data off the computer, or send it an order
    # nobody placed, asks terms_of() first.
    def _listed_key(self, broker: str) -> str | None:
        """The EXAMPLES key this profile was linked from, or None.

        By the marker a link from the row leaves (its `example`), else by
        the adapter file itself: a profile that runs one of the kit's listed
        adapters, linked by its path through "Add your own broker", is the
        same broker and keeps the same listed terms.
        """
        entry = self.registry.get(broker) or {}
        key = entry.get("example")
        if isinstance(key, str) and key in EXAMPLES:
            return key
        argv = entry.get("argv") if entry.get("registered") else None
        if not isinstance(argv, list):
            return None
        for word in argv[:3]:
            if not isinstance(word, str) or not word.lower().endswith(".py"):
                continue
            try:
                p = Path(word).resolve()
            except (OSError, ValueError, RuntimeError):
                continue
            for k in EXAMPLES:
                listed = self._example_path(k)
                if listed is not None and listed.resolve() == p:
                    return k
        return None

    def listed_terms(self, broker: str) -> dict | None:
        """The terms OUR listing gives this broker: its EXAMPLES row's, and
        a hosted directory row's when that carries any. None when no listing
        of ours says anything about it."""
        parts = []
        key = self._listed_key(broker)
        if key is not None and "terms" in EXAMPLES[key]:
            parts.append(clean_terms(EXAMPLES[key]["terms"]))
        row = self._directory_row(broker)
        if row is not None and "terms" in row:
            parts.append(clean_terms(row.get("terms")))
        return merge_terms(*parts) if parts else None

    @staticmethod
    def _live_terms(c) -> dict:
        """What a connection's handshake declared, cleaned. The kit's own
        Connector.terms when it has one (1.11), else the handshake read here
        by the same rule."""
        t = getattr(c, "terms", None)
        if isinstance(t, dict) and all(isinstance(t.get(f), bool)
                                       for f in TERMS_FLAGS):
            return dict(t)
        return clean_terms((getattr(c, "handshake", None) or {}).get("terms"))

    def remembered_terms(self, broker: str) -> dict | None:
        """The terms this profile's last hello declared, or None when it has
        never answered one (or its command changed since)."""
        rec = self._remembered.get(broker) or {}
        if rec.get("cmd") != self._fingerprint(broker) or "terms" not in rec:
            return None
        return clean_terms(rec.get("terms"))

    def terms_of(self, broker: str) -> dict:
        """What this connection's broker's terms let the terminal do: the
        stricter of our listing and the broker's own handshake, flag by flag.
        Always both flags.

        The handshake is the live one while connected, else the one
        remembered from the last hello. So the listing holds before the
        first hello, and listing and memory both hold when a hello fails.
        """
        c = self.conns.get(broker)
        if c is not None and getattr(c, "alive", False):
            said = self._live_terms(c)
        else:
            said = self.remembered_terms(broker)
        return merge_terms(self.listed_terms(broker), said)

    def data_local(self, broker: str) -> bool:
        """True when this connection's market data stays on this computer."""
        return bool(self.terms_of(broker)["data_local_only"])

    def by_hand(self, broker: str) -> bool:
        """True when every mutating call to this connection must be the
        user's own action for that one order: its terms say so, and its mode
        is not paper. An unknown mode is not paper."""
        if not self.terms_of(broker)["orders_by_hand_only"]:
            return False
        try:
            return not self.is_paper(broker)
        except Exception:  # noqa: BLE001 - cannot tell: the careful answer
            return True

    def terms_name(self, broker: str) -> str:
        """What to call the broker in a sentence about its terms: our
        listing's name, else the broker's own, else the profile's."""
        key = self._listed_key(broker)
        if key is not None:
            ex = EXAMPLES[key]
            name = _plain(ex.get("name") or ex.get("label") or key, 40)
            if name:
                return name
        c = self.conns.get(broker)
        alive = c is not None and getattr(c, "alive", False)
        ident = c.identity() if alive else self.identity_of(broker)
        name = _plain((ident or {}).get("display_name"), 40)
        if name and name != "unnamed broker":
            return name
        return _plain((self.registry.get(broker) or {}).get("label"), 40) or broker

    def withheld(self, broker: str, what: str = "") -> str:
        """The sentence a refused or withheld piece of this connection's
        market data carries."""
        return withheld_text(self.terms_name(broker), self.terms_of(broker), what)

    def priced_fields(self, broker: str) -> tuple:
        """Which of SPEC 4's figures that a broker may work out from a price
        (PRICED_FIELDS) this broker's adapter may: they are withheld from a
        program on a data_local_only connection, and the others it sends as
        fixed figures are kept. Our listing says which for the brokers it
        lists (an EXAMPLES row's `priced`, written from the adapter we ship).
        For any other broker, or a listing naming a field that is not one of
        them, it is not known, and all of them are."""
        key = self._listed_key(broker)
        ex = EXAMPLES.get(key) if key is not None else None
        said = ex.get("priced") if ex else None
        if isinstance(said, (tuple, list)) and all(f in PRICED_FIELDS for f in said):
            return tuple(said)
        return PRICED_FIELDS

    def _summary_covers(self, broker: str, terms: dict) -> tuple:
        """The restrictions our listing says its summary names (an EXAMPLES
        row's terms_cover), when the summary in force is that listing's own.
        A summary from anywhere else is not known to name any."""
        key = self._listed_key(broker)
        ex = EXAMPLES.get(key) if key is not None else None
        if not ex or not terms.get("summary"):
            return ()
        if clean_terms(ex.get("terms")).get("summary") != terms["summary"]:
            return ()
        return tuple(f for f in ex.get("terms_cover", ()) if f in TERMS_FLAGS)

    def by_hand_refusal(self, broker: str) -> str:
        return by_hand_text(self.terms_name(broker))

    def timeframes_of(self, broker: str):
        """The chart periods this profile's broker source offers: those our
        listing says its adapter serves (an EXAMPLES row's `timeframes`,
        written from the adapter we ship), or None for the provider
        contract's own when no listing of ours says (a user's own adapter)."""
        key = self._listed_key(broker)
        ex = EXAMPLES.get(key) if key is not None else None
        said = ex.get("timeframes") if ex else None
        return list(said) if isinstance(said, (tuple, list)) and said else None

    def terms_row(self, broker: str) -> dict:
        """What a status row says about the terms: both flags, the summary
        and its url when there are any, `said` (the terms in one sentence,
        for the Connections screen), and the sentence each restriction in
        force is refused with: `withheld` for the prices, `by_hand` for an
        order that is not the user's own."""
        t = self.terms_of(broker)
        out = dict(t)
        name = self.terms_name(broker)
        said = terms_said(name, t, self._summary_covers(broker, t))
        if said:
            out["said"] = said
        if t["data_local_only"]:
            out["withheld"] = withheld_text(name, t)
        if self.by_hand(broker):
            out["by_hand"] = by_hand_text(name)
        return out

    def connected_terms(self) -> list:
        """(broker, terms_row) for every live connection."""
        return [(b, self.terms_row(b)) for b, c in list(self.conns.items())
                if getattr(c, "alive", False)]

    def _spawn_lock(self, broker: str) -> threading.Lock:
        with self.lock:
            return self._spawn_locks.setdefault(broker, threading.Lock())

    def apply_directory(self, directory: dict | None):
        """Filter the installed adapters by the remote directory.

        Directory present: only brokers it lists appear, and its labels win.
        Directory absent (offline, no cache): every installed adapter shows.
        An entry the directory lists but we don't have installed is skipped.

        The directory gates OUR shipped adapters only. A broker the user
        registered themselves is theirs, on their machine, and is never
        filtered by our listing: the whole premise is that they do not need
        our permission to connect their own broker.
        """
        self.directory = directory
        self._rebuild_registry()

    def _require(self, broker: str):
        if broker not in self.registry:
            # Re-read before refusing: the name may have been registered
            # since the last look, and "unknown broker" for one the user just
            # linked is the wrong answer.
            self._rebuild_registry()
        if broker not in self.registry:
            raise KeyError(f"unknown broker {broker!r}")

    def _conn(self, broker: str):
        c = self.conns.get(broker)
        if c is None or not c.alive:
            raise LookupError(f"broker {broker!r} not connected")
        return c

    # == lifecycle =======================================================
    def blocked(self, broker: str) -> str | None:
        """Why this broker cannot be connected yet, or None.

        Asked BEFORE spawning, so a platform can say "needs your LSE key" on
        the row instead of letting the user click and read a failure. One
        source of truth: _new_connector raises with this same sentence.
        """
        entry = self.registry.get(broker) or {}
        if entry.get("update_required"):
            return "update the terminal to use this broker"
        if entry.get("needs_lse_key"):
            from . import config as cfg  # noqa: PLC0415
            if not cfg.get_lse_api_key():
                return "needs your LSE API key"
        return None

    def _new_connector(self, broker: str):
        """An unstarted connector for a broker, however it is configured."""
        Connector, _ = _load_connector(self.connect_dir)
        entry = self.registry[broker]
        if entry.get("update_required"):
            raise LookupError(f"{entry['label']}: {self.blocked(broker)}")
        from brueconnect import registry  # noqa: PLC0415
        if not entry.get("cmd"):
            # A registered profile: the registry owns its command, env and
            # private state directory, so `{state}` expands and the broker's
            # credentials stay in a 700 directory of its own. Two things are
            # ours to add, because the registry cannot know them: which
            # Python a bare `python3` means in this install, and where
            # `import brueconnect` is found by an adapter that lives
            # anywhere on the user's disk.
            argv, env, _ = registry.resolve(broker)
            argv = self._linked_argv(entry, argv)
            self._sdk_env(env, argv[0], own=True)
            return self._tailed(Connector, argv, env, broker)
        # A bundled adapter. It gets the same private state directory a
        # registered profile gets, because "where does this broker keep its
        # things" should have one answer regardless of who shipped it.
        env = dict(os.environ)
        env["BRUE_BROKER_STATE"] = registry.state_dir(broker)
        # Whatever the user typed into this broker's credential form, as
        # BRUE_CRED_* (SPEC 8.5). Env at spawn, never a protocol message,
        # and read from a 0600 file on this machine only. Registered profiles
        # get the same treatment inside registry.resolve().
        env.update(registry.credential_env(broker))
        # Which of the login's accounts this process deals on (SPEC 1.7).
        # Bundled adapters build their env here rather than through
        # registry.resolve(), so without this the user's pick was stored,
        # shown, and then silently ignored: every process bound itself to the
        # login's primary.
        env.update(registry.account_env(broker))
        # The spawned adapter imports brueconnect too. A python-installed
        # terminal resolves it like we did, but the adapter's interpreter is
        # NOT this process (see adapter_python), so give it the package's
        # directory explicitly; without this the frozen desktop build spawns
        # adapters that die on their first import.
        self._sdk_env(env, entry["cmd"][0], own=False)
        # A directory-listed broker points its bundled adapter at the public
        # endpoint the directory announced (host:port env); everything else
        # about spawning it is identical to any other bundled adapter.
        env.update(entry.get("endpoint_env") or {})
        if entry.get("needs_lse_key"):
            why = self.blocked(broker)
            if why:
                raise LookupError(f"{entry['label']} {why}; add it in the "
                                  "connection menu first")
            # The user's key, from their own config, as environment. Never a
            # protocol message (SPEC 8.5), and never written to the registry.
            from . import config as cfg  # noqa: PLC0415
            env["LSE_API_KEY"] = cfg.get_lse_api_key() or ""
        return Connector(list(entry["cmd"]), env=env)

    # == spawning a linked adapter =========================================
    def _sdk_env(self, env: dict, interpreter: str, own: bool) -> None:
        """Make `import brueconnect` resolve in the adapter about to start.

        With a clean SDK directory (the desktop build): that directory, for
        every adapter. Without one (a checkout, a pip install): a bundled
        adapter gets the package's parent as it always did; a user's own
        adapter gets it only when it runs under THIS interpreter, where that
        directory is already this environment's own. A different interpreter
        the user chose is never handed our site-packages. BRUE_CONNECT_SDK
        always names the directory, so such an adapter can opt in with one
        sys.path.append of its own.
        """
        if self.base is None:
            return
        target = self.sdk or self.base.parent
        env.setdefault("BRUE_CONNECT_SDK", str(target))
        if self.sdk is None and own and not _same_interpreter(interpreter):
            return
        env["PYTHONPATH"] = os.pathsep.join(
            [str(target)]
            + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))

    def _example_path(self, key) -> Path | None:
        ex = EXAMPLES.get(key) if isinstance(key, str) else None
        if ex is None or self.adapter_base is None:
            return None
        path = self.adapter_base.joinpath(*ex["path"])
        return path if path.is_file() else None

    def _linked_argv(self, entry: dict, argv: list[str]) -> list[str]:
        """The argv a linked profile is spawned with in THIS install."""
        # A profile linked from EXAMPLES names a file inside the app. Its
        # stored path is right on the day it was linked; the app can be
        # moved or reinstalled since, so the file is found again by its
        # example key whenever this kit still ships it.
        path = self._example_path(entry.get("example"))
        if path is not None:
            argv = ["python3", str(path),
                    *EXAMPLES[entry["example"]]["args"]]
        return resolve_interpreter(argv)

    def _tailed(self, Connector, argv: list[str], env: dict, broker: str = "",
                listed: dict | None = None):
        """A connector for a user's own adapter, with its stderr kept.
        `listed` is our listing's row ({"name", "terms"}) for a link's test
        spawn of a listed adapter, before the profile exists."""
        import subprocess  # noqa: PLC0415
        try:
            c = Connector(list(argv), env=env, stderr=subprocess.PIPE)
        except TypeError:
            # A brue-connect from before `stderr`: connect as before, with
            # the adapter's stderr in the engine's log only.
            return Connector(list(argv), env=env)
        c.stderr_tail = _StderrTail(
            quiet=lambda: self._lines_held(broker, c, listed), name=broker)
        # Every process the connector starts is drained: a connect starts the
        # adapter again by itself when it answers `reconnect` (SPEC 6), and
        # that process has a pipe of its own, which fills and stops it if
        # nobody reads it. A kit from before on_start starts none by itself:
        # _start drains its one process.
        on_start = getattr(c, "on_start", None)
        if callable(on_start):
            on_start(c.stderr_tail.attach)
        return c

    def _lines_held(self, broker: str, c=None, listed: dict | None = None,
                    what: str = "Lines this adapter printed"):
        """Why this adapter's printed lines stay off the engine's stderr, or
        None (_StderrTail): its profile's broker's terms keep its prices on
        this computer; or, while a link tests it before the profile exists,
        the terms our listing gives it (from its first byte) or its own
        hello's (once answered: what it prints before that cannot be known
        to be held). `what` leads the sentence."""
        if broker and self.data_local(broker):
            return self.withheld(broker, what)
        if isinstance(listed, dict):
            t = clean_terms(listed.get("terms"))
            if t["data_local_only"]:
                return withheld_text(_plain(listed.get("name"), 40) or broker, t, what)
        if c is not None and getattr(c, "handshake", None):
            t = self._live_terms(c)
            if t["data_local_only"]:
                ident = c.identity() or {}
                return withheld_text(_plain(ident.get("display_name"), 40) or broker, t, what)
        return None

    @staticmethod
    def _start(c) -> None:
        """Spawn, and start draining stderr when this connector keeps it
        (through its on_start, for each process it starts; _tailed)."""
        c.start()
        tail = getattr(c, "stderr_tail", None)
        if tail is not None and not callable(getattr(c, "on_start", None)):
            tail.attach(c.proc)

    def _redact(self, broker: str, text: str, secrets=None) -> str:
        """`text` with the VALUES this profile keeps taken out: its stored
        credentials and its own env's values (_secrets).

        An adapter should never print a key (SPEC 8.5), and the tail of its
        stderr is about to be shown on screen; this is for the one that
        does it anyway. `secrets` is given by a caller that already holds
        the values (reading them here creates the profile's state
        directory, which a failed link must not leave behind).
        """
        if not text:
            return ""
        if secrets is None:
            secrets = self._secrets(broker)
        # A value shorter than HIDDEN_MIN is never taken out: one or two
        # characters taken out of every word that holds them garble the words.
        secrets = sorted({v for v in secrets if isinstance(v, str) and len(v) >= HIDDEN_MIN},
                         key=len, reverse=True)
        if not secrets:
            return text
        # One pass, the longest first: a value inside a longer one, or inside
        # a "[hidden]" put in already, is never taken out a second time.
        return re.sub("|".join(re.escape(v) for v in secrets), "[hidden]", text)

    def redact(self, broker: str, text) -> str:
        """An adapter's words with the values its profile keeps taken out,
        for the engine's routes that answer them (server._said). Run before
        any cut, so a value is never left half shown."""
        return self._redact(broker, text if isinstance(text, str) else str(text or ""))

    def _secrets(self, broker: str) -> list:
        """The values this profile keeps that no caller is shown: its stored
        credentials (SPEC 8.5), whatever they look like (_redact keeps one
        shorter than HIDDEN_MIN), and those values of its own env that are
        secrets by the rule above (_env_values), which its adapter is given
        and its row never shows (command_preview leaves them out)."""
        out = []
        try:
            from brueconnect import registry  # noqa: PLC0415
            out += list(registry.credential_env(broker).values())
        except Exception:  # noqa: BLE001
            return out
        if not (self.registry.get(broker) or {}).get("registered"):
            return out
        try:
            prof = (registry.load().get("brokers") or {}).get(broker) or {}
            env = prof.get("env") if isinstance(prof.get("env"), dict) else {}
            state = (registry.state_dir(broker)
                     if any("{state}" in str(v) for v in env.values()) else "")
        except Exception:  # noqa: BLE001 - an unreadable profile: its keys only
            return out
        return out + self._env_values(env, state)

    @staticmethod
    def _env_values(env, state: str = "") -> list:
        """What of a profile's own env is taken out of its adapter's words,
        as given and as its adapter gets it ({state} expanded): each value
        that is a secret by its name or its look (env_hidden). Not the
        terminal's own entries (BRUE_*, which a profile sent by the page
        cannot set: they mark what the kit ships)."""
        out = []
        for k, v in (env or {}).items():
            if not isinstance(v, str) or str(k).startswith("BRUE_"):
                continue
            out += env_hidden(k, v)
            if state and "{state}" in v:
                out += env_hidden(k, v.replace("{state}", state))
        return list(dict.fromkeys(out))

    @staticmethod
    def _printed(c, wait: float = 1.0) -> str:
        """The last lines an adapter printed, for its card: what it wrote to
        stdout that was not the protocol (a print() left in it, or a file
        that is not an adapter; a kit from before Connector.stray_lines
        keeps none), then the end of its stderr, where a traceback lives.
        `wait` is how long to let an ended process's last bytes drain; a
        live one's are read as they stand (0), since its pump never ends."""
        try:
            out = "\n".join(getattr(c, "stray_lines", None) or ())
        except RuntimeError:  # added to while it was read: leave it out
            out = ""
        tail = getattr(c, "stderr_tail", None)
        err = tail.text(wait) if tail else ""
        return "\n".join(x for x in (out, err) if x)

    def _retire(self, broker: str, c, listed: dict | None = None,
                secrets=None) -> None:
        """Keep what an ended adapter process printed for its card, after
        what its profile's earlier runs printed (status_one `printed`), and
        whether its lines were held under the terms in force for this run
        (_lines_held; `listed` and `secrets` are a link's test spawn's, for
        a profile not stored yet). Once per process; a process that printed
        nothing adds nothing."""
        if c is None or getattr(c, "_lse_retired", False):
            return
        try:
            c._lse_retired = True
        except Exception:  # noqa: BLE001 - a connector that takes no attribute
            pass
        text = self._printed(c)
        if not text or not broker:
            return
        # The keys stored now taken out now: they may be forgotten later.
        text = self._redact(broker, text, secrets)
        # (In the words server._row_for gives a program for `printed`.)
        try:
            held = self._lines_held(broker, c, listed, "The broker's own words")
        except Exception:  # noqa: BLE001 - cannot tell: held
            held = ("The broker's own words withheld: its broker's terms "
                    "could not be read, so its prices stay on this computer.")
        with self.lock:
            runs = self._printed_runs.setdefault(broker, [])
            runs.append({"text": text, "held": held})
            self._trim_runs(runs)

    @staticmethod
    def _trim_runs(runs: list) -> None:
        """The runs' lines kept to their last _StderrTail.LIMIT characters,
        joined as they are shown: the oldest run goes first, or its start."""
        over = sum(len(r["text"]) + 1 for r in runs) - 1 - _StderrTail.LIMIT
        while over > 0 and runs:
            first = runs[0]
            if len(runs) > 1 and len(first["text"]) + 1 <= over:
                over -= len(first["text"]) + 1
                runs.pop(0)
            else:
                first["text"] = first["text"][over:]
                over = 0

    def printed_held(self, broker: str) -> bool:
        """Whether a run of this profile whose lines are kept was held."""
        with self.lock:
            return any(r.get("held") for r in self._printed_runs.get(broker, ()))

    def printed_lines(self, broker: str, program: bool = False) -> str:
        """The last lines this profile's adapter printed, its ended runs'
        then the live process's (or a dead one not yet closed), with the
        values its profile keeps taken out; "" when it printed none. For a
        program (`program`), a run whose lines were held under the terms in
        force for it is that sentence instead (server._row_for)."""
        with self.lock:
            runs = [dict(r) for r in self._printed_runs.get(broker, ())]
        c = self.conns.get(broker)
        if c is not None and not getattr(c, "_lse_retired", False):
            now = self._printed(c, wait=0)
            if now:
                runs.append({"text": now, "held": (
                    self._lines_held(broker, c, what="The broker's own words")
                    if program else None)})
        parts = []
        for r in runs:
            part = (r.get("held") or r["text"]) if program else r["text"]
            if part and not (r.get("held") and parts and parts[-1] == part):
                parts.append(part)
        lines = "\n".join(parts)
        return self._redact(broker, lines)[-1500:] if lines else ""

    def _note_failure(self, broker: str, c, error) -> None:
        """Remember why a connect or probe failed, for the broker's card."""
        stderr = self._redact(broker, self._printed(c))[-1500:]
        rec = {"message": self._redact(broker, str(error))[:WORDS_CHARS],
               "at": int(time.time())}
        if stderr:
            rec["stderr"] = stderr
        self.last_errors[broker] = rec

    def connect(self, broker: str) -> dict:
        self._require(broker)
        # A chooser left unanswered past its expiry is dropped here too, so a
        # fresh Connect starts the login over rather than polling a stale
        # logged-in session.
        self._reap_expired_pending(broker)
        with self._spawn_lock(broker):
            with self.lock:
                c = self.conns.pop(broker, None)
                if c is not None and c.alive:
                    self.conns[broker] = c
                    return self.status_one(broker)
            if c is not None:
                # A dead-but-not-buried connection from a crashed adapter.
                # Overwriting the slot without closing it left the old process
                # unreachable if it was hung rather than gone. What it printed
                # before it died stays on its card.
                try:
                    c.close()
                except Exception:
                    pass
                self._retire(broker, c)
            # A login already in flight? Poll it rather than spawning a
            # second adapter: connect() doubles as the "is the user done on
            # the broker's page yet" poll, so it must be safe to call every
            # couple of seconds without abandoning the attempt each time.
            pending = self.pending_auth.get(broker)
            if pending is not None:
                c = pending["c"]
                if not c.alive:
                    self.pending_auth.pop(broker, None)
                else:
                    st = c.request("auth.status", {})
                    if st.get("authenticated"):
                        if pending.get("accounts") and not self._chosen(broker):
                            # Logged in, waiting on which account. Hold the
                            # question open until it is answered.
                            return self.status_one(broker)
                        # Logged in and settled: retire the chooser. The
                        # session that actually trades is spawned below, bound
                        # to the account, because the account is fixed before
                        # the process exists (SPEC 1.7).
                        self.pending_auth.pop(broker, None)
                        try:
                            c.close()
                        except Exception:
                            pass
                        self._retire(broker, c)
                        c = None
                    else:
                        if time.time() >= pending["expires"] - 10:
                            # The attempt timed out (or is about to); a fresh
                            # begin gets a fresh loopback and url, so the
                            # button the user eventually clicks always works.
                            b = c.request("auth.begin", {})
                            pending["url"] = b.get("url")
                            pending["expires"] = time.time() + float(
                                b.get("expires_in") or 300)
                        # Still waiting on the human. Only this branch
                        # returns: a chooser that has been retired must fall
                        # through and spawn the bound session below.
                        return self.status_one(broker)
            # The spawn and handshake happen OUTSIDE the hub lock: connecting
            # to a real broker is a login over the network, and holding the
            # lock across it froze every other broker's quotes and orders.
            # The per-broker spawn lock still makes this one exclusive.
            self.last_errors.pop(broker, None)
            c = self._new_connector(broker)
            try:
                # hello is cold (SPEC 3.1), so the capability check costs the
                # broker nothing. THE ACCOUNT GATE LIVES HERE, on the path
                # every connect takes, not only after a fresh login: with a
                # stored token the adapter would otherwise bind the login's
                # PRIMARY and open a session on it, which is how a user ends
                # up trading a live account they never chose. An adapter that
                # answers reconcile's reads `reconnect` (SPEC 6) is started
                # again by the kit inside reconcile, once; _adopt then keeps
                # what that process's hello said.
                self._start(c)
                c.hello()
                # What the adapter just said about itself, its key form
                # included, is kept NOW, as probe() keeps it, and not only
                # once the connect succeeds: an adapter whose author changed
                # its key boxes refuses the first connect for the new boxes
                # being empty, and the card must then draw those boxes
                # rather than the ones the file no longer reads. Its terms
                # too, so they hold if the rest of this connect fails.
                self._remember(broker, c.identity(),
                               getattr(c, "credential_form", None),
                               self._live_terms(c), self._accounts_multi(c))
                gate = self._account_gate(broker, c)
                if gate is not None:
                    return gate
                c.reconcile()
            except BaseException as e:
                if getattr(e, "code", None) == "auth_required" and c.alive:
                    # Not a failure: the broker wants its USER, not better
                    # machinery (SPEC 1.6). Keep the adapter alive on its
                    # loopback and hand the UI the url to open.
                    b = c.request("auth.begin", {})
                    self.pending_auth[broker] = {
                        "c": c, "url": b.get("url"),
                        "expires": time.time() + float(
                            b.get("expires_in") or 300)}
                    return self.status_one(broker)
                # A failed connect used to leave the adapter process running:
                # nothing had stored it, so nothing could ever close it, and
                # every retry against a flaky broker leaked another login.
                try:
                    c.close()
                except Exception:
                    pass
                # After the close, so a dying adapter's last line is in it.
                if isinstance(e, Exception):
                    self._note_failure(broker, c, e)
                self._retire(broker, c)
                raise
            return self._adopt(broker, c)

    def _adopt(self, broker: str, c) -> dict:
        """Post-handshake bookkeeping for a connection that is now real."""
        if self._accounts_multi(c):
            try:
                self.account_lists[broker] = (
                    c.request("accounts.list", {}).get("accounts") or [])
            except Exception:  # noqa: BLE001 - the connection is fine either
                pass           # way; the picker just shows what it last knew
        self._remember(broker, c.identity(),
                       getattr(c, "credential_form", None),
                       self._live_terms(c), self._accounts_multi(c))
        with self.lock:
            # one live quote cache per broker, fed by the event stream
            self.quotes[broker] = {}

        def _on_quote(data, _b=broker):
            # Fetched, not indexed: this runs on the adapter's reader
            # thread and disconnect() removes the cache, so a tick landing
            # during teardown would raise (silently, inside the client's
            # handler loop) on every quote until the pipe closed.
            cache = self.quotes.get(_b)
            if cache is not None:
                cache[data.get("symbol")] = {
                    "bid": data.get("bid"), "ask": data.get("ask"),
                    "time": data.get("time")}
        c.on("quote", _on_quote)
        # NOTHING is subscribed here. Connecting used to subscribe to the
        # broker's entire catalog, which is fine for a five-instrument
        # simulator and absurd for a real one: our own demo broker deals
        # 4,189, so a connect would have asked its price board for every
        # symbol on earth to populate a panel showing one. The ticket asks
        # for what it displays, through subscribe() below.
        with self.lock:
            self.conns[broker] = c
        return self.status_one(broker)

    def set_credentials(self, broker: str, values: dict,
                        merge: bool = False) -> dict:
        """Store the user's own broker credentials for this profile.

        They live in the profile's private state directory on THIS machine
        and reach the adapter as environment at spawn; they never travel to
        us, never enter a protocol message, and are never returned by any
        endpoint. A connected broker is disconnected so the next connect
        actually uses the new key rather than the session opened with the old
        one.

        Without `merge` the values REPLACE what was stored (an empty object
        forgets every key). With `merge` only the non-blank values given are
        written and everything else stored is kept: a form submitted with a
        box left empty must never delete the key behind it.
        """
        self._require(broker)
        from brueconnect import registry  # noqa: PLC0415
        if not merge:
            stored = registry.set_credentials(broker, values)
        else:
            typed = {str(k): str(v) for k, v in (values or {}).items()
                     if v is not None and str(v) != ""}
            if not typed:
                # Nothing typed: nothing changes, and a live session opened
                # with the stored keys is left running.
                return {"broker": broker,
                        "stored": self._stored_fields(broker)}
            try:
                stored = registry.set_credentials(broker, typed, merge=True)
            except TypeError:
                # A brue-connect from before `merge`: lay the typed values
                # over the stored file ourselves and write the whole set.
                held = {}
                try:
                    held = json.loads(Path(
                        registry.state_dir(broker),
                        "platform_credentials.json").read_text())
                except Exception:  # noqa: BLE001 - nothing stored yet
                    pass
                if not isinstance(held, dict):
                    held = {}
                stored = registry.set_credentials(broker, {**held, **typed})
        self.last_errors.pop(broker, None)
        if broker in self.conns or broker in self.pending_auth:
            self.disconnect(broker)
        return {"broker": broker, "stored": stored}

    @staticmethod
    def _stored_fields(broker: str) -> list:
        """NAMES of the credential fields stored for a broker. Never values."""
        try:
            from brueconnect import registry  # noqa: PLC0415
            fn = getattr(registry, "stored_credentials", None)
            if fn is not None:
                return list(fn(broker))
            # Older brue-connect: the names as they appear in the spawn
            # environment, which is the only read it offers.
            return sorted(k[len("BRUE_CRED_"):].lower()
                          for k in registry.credential_env(broker))
        except Exception:  # noqa: BLE001 - a row must never fail on this
            return []

    # == linking a broker of the user's own ================================
    def examples(self) -> list[dict]:
        """Adapters inside the running kit that can be linked in one click,
        with what the Connections screen shows before one is linked: the
        broker's name, a line on what it deals, its key form and where a user
        makes that key, and its terms when our listing states any."""
        out = []
        for key, ex in EXAMPLES.items():
            if self._example_path(key) is None:
                continue
            row = {"key": key, "label": ex["label"],
                   "name": ex.get("name") or ex["label"],
                   "about": ex.get("about", ""),
                   "logo": ex.get("logo", ""),
                   "keys_url": ex.get("keys_url", ""),
                   "keys_help": ex.get("keys_help", ""),
                   "form": [dict(f) for f in ex.get("form", ())],
                   "args": list(ex["args"])}
            if ex.get("key_name"):
                # what the card calls the credential its boxes ask for
                row["key_name"] = ex["key_name"]
            if "terms" in ex:
                t = clean_terms(ex["terms"])
                said = terms_said(_plain(row["name"], 40) or key, t,
                                  ex.get("terms_cover", ()))
                if said:
                    t["said"] = said
                row["terms"] = t
            out.append(row)
        return out

    def template_path(self) -> Path | None:
        """The kit's starter adapter, when the running kit ships it."""
        if self.base is None:
            return None
        path = self.base.joinpath(*TEMPLATE_PARTS)
        return path if path.is_file() else None

    def save_template(self) -> dict:
        """Put the kit's starter adapter in the user's own folder
        (~/LSE Terminal/brokers/my_broker_adapter.py) and say where, so the
        Connections card can fill in its path: nobody has to find a download
        or type a path. A file already there is the user's, perhaps edited:
        it is kept exactly as it is. Nothing from the page decides the path."""
        src = self.template_path()
        if src is None:
            raise LookupError("this terminal's kit has no starter adapter")
        folder = own_brokers_dir()
        folder.mkdir(parents=True, exist_ok=True)
        dest = folder / TEMPLATE_NAME
        existing = dest.exists()
        if not existing:
            part = folder / (TEMPLATE_NAME + ".part")
            part.write_bytes(src.read_bytes())
            part.replace(dest)
        return {"path": str(dest), "folder": str(folder), "existing": existing}

    def reveal_template(self) -> dict:
        """Show the starter adapter in the system's file manager: that file,
        or its folder, and never a path from the page."""
        folder = own_brokers_dir()
        dest = folder / TEMPLATE_NAME
        target = dest if dest.is_file() else folder
        if not target.exists():
            raise LookupError("nothing saved yet")
        import subprocess  # noqa: PLC0415
        if sys.platform == "win32":
            # One string: explorer reads /select,"<path>" itself.
            subprocess.Popen(f'explorer /select,"{target}"' if target.is_file()
                             else f'explorer "{target}"')
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)] if target.is_file()
                             else ["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(folder)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"opened": str(target)}

    def own_guide(self) -> dict:
        """This machine's facts for a broker of the user's own: the Python
        that runs an adapter linked from the app (resolved exactly as a
        linked profile's bare `python3` is), its version, the folder named to
        the adapter as BRUE_CONNECT_SDK, the platform, and the command that
        tests the starter adapter from the folder it was saved in."""
        argv = resolve_interpreter(["python3", TEMPLATE_NAME])
        # Frozen on a machine without Python the adapter is run by the
        # engine's own bundle (--run-script): no Python a user can run a
        # test with, so none is named.
        python = argv[0] if argv[1:] == [TEMPLATE_NAME] else None
        version = _interpreter_version(python) if python else None
        sdk = (str(self.sdk or self.base.parent)
               if self.base is not None else None)
        ok = bool(version) and tuple(version[:2]) >= _MIN_ADAPTER_PY
        out = {"platform": sys.platform,
               "python": python,
               "python_version": ".".join(str(x) for x in version)
                                 if version else None,
               "python_ok": ok,
               "sdk": sdk,
               "file": TEMPLATE_NAME,
               "template": self.template_path() is not None,
               "commands": None}
        if ok and sdk:
            out["commands"] = {
                "posix": conformance_command_posix(python, sdk),
                "windows": conformance_command_powershell(python, sdk)}
        return out

    def _directory_row(self, broker: str) -> dict | None:
        for b in (self.directory or {}).get("brokers", []):
            if isinstance(b, dict) and b.get("key") == broker:
                return b
        return None

    def _reserved(self, name: str) -> bool:
        """Names a linked profile cannot take: ours, a listed broker's, or
        one the screen hides. A profile under such a name would be ignored
        or shadowed (see _rebuild_registry), which is worse than a refusal."""
        if name in _RESERVED_NAMES or name in self._installed:
            return True
        if name in SIM_ADAPTERS:
            return True
        return self._directory_row(name) is not None

    @staticmethod
    def _check_python_file(path) -> str:
        if not isinstance(path, str) or not path.strip():
            raise LinkError("Give the path to the adapter's .py file.")
        path = path.strip()
        # Windows "Copy as path" wraps the path in double quotes.
        if len(path) >= 2 and path[0] == path[-1] and path[0] in "\"'":
            path = path[1:-1].strip()
        if len(path) > _MAX_ARG_CHARS or any(ch in path for ch in "\x00\r\n"):
            raise LinkError("That path cannot be used.")
        path = os.path.expanduser(path)
        if not os.path.isabs(path):
            raise LinkError("Give the full path to the adapter file "
                            "(it must start at the drive or root).")
        if not path.lower().endswith(".py"):
            raise LinkError("The adapter must be a Python file ending in .py.")
        if not os.path.isfile(path):
            raise LinkError(f"No file at {path}.")
        return path

    @staticmethod
    def _check_args(args) -> list[str]:
        if args is None:
            return []
        if not isinstance(args, (list, tuple)) or len(args) > _MAX_ARGS:
            raise LinkError(f"Arguments must be a list of at most {_MAX_ARGS}.")
        out = []
        for a in args:
            if (not isinstance(a, str) or len(a) > _MAX_ARG_CHARS
                    or any(ch in a for ch in "\x00\r\n")):
                raise LinkError("An argument is not plain text, or is too long.")
            out.append(a)
        return out

    @staticmethod
    def _check_env(env) -> dict:
        if env is None:
            return {}
        if not isinstance(env, dict) or len(env) > _MAX_ENV:
            raise LinkError(f"Environment must be an object of at most "
                            f"{_MAX_ENV} NAME: value pairs.")
        out = {}
        for k, v in env.items():
            if not isinstance(k, str) or not _ENV_NAME.fullmatch(k):
                raise LinkError(f"{str(k)[:40]!r} is not a usable environment "
                                "name (capital letters, digits and _).")
            # The platform's own channel to the adapter (state directory,
            # typed credentials, account pin, the SDK path) and the user's
            # LSE key are not a profile's to set.
            if k.startswith("BRUE_") or k == "LSE_API_KEY":
                raise LinkError(f"{k} is set by the terminal and cannot be "
                                "given here.")
            if (not isinstance(v, str) or len(v) > _MAX_ENV_CHARS
                    or any(ch in v for ch in "\x00\r\n")):
                raise LinkError(f"The value of {k} is not plain text, or is "
                                "too long.")
            out[k] = v
        return out

    def _test_spawn(self, name: str, entry: dict, argv: list[str],
                    profile_env: dict) -> tuple:
        """Run the adapter once and handshake it, exactly as a connect would
        spawn it. Returns (identity, credential form, terms, whether its
        login can reach several accounts). Stores nothing."""
        from brueconnect import registry  # noqa: PLC0415
        Connector, _ = _load_connector(self.connect_dir)
        state_root = Path(registry.home()) / "state" / name
        existed = state_root.exists()
        sdir = registry.state_dir(name)
        env = dict(os.environ)
        for k, v in profile_env.items():
            env[k] = v.replace("{state}", sdir)
        env["BRUE_BROKER_STATE"] = sdir
        # Keys stored under this ID by an earlier link of it: handed to the
        # adapter as a connect would, and kept to strip from anything shown.
        held = registry.credential_env(name)
        env.update(held)
        env.update(registry.account_env(name))
        # What is taken out of anything shown: those keys, and the values of
        # the env it is linked with (the profile does not exist yet, so
        # _secrets cannot read them).
        secrets = list(held.values()) + self._env_values(profile_env, sdir)
        spawn = self._linked_argv(entry, argv)
        self._sdk_env(env, spawn[0], own=True)
        ex = EXAMPLES.get(entry.get("example")) if entry.get("example") else None
        listed = ({"name": ex.get("name") or ex.get("label"), "terms": ex["terms"]}
                  if ex and "terms" in ex else None)
        c = self._tailed(Connector, spawn, env, name, listed)
        failure = None
        try:
            self._start(c)
            c.hello(timeout=_HELLO_TIMEOUT_S)
            return (c.identity(), getattr(c, "credential_form", None),
                    self._live_terms(c), self._accounts_multi(c))
        except BaseException as e:  # noqa: BLE001 - reported below
            failure = e
            # Do not wait out a polite goodbye from something that failed
            # its first line: end it, so the tail below is complete.
            try:
                if c.proc is not None:
                    c.proc.kill()
                    c.proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                pass
            if not isinstance(e, Exception):
                raise
        finally:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
            if failure is None:
                # Linked: what it printed is its card's, as a connect's is,
                # held or not under our listing's terms and its own hello's.
                # (A refused link's lines go back with its refusal.)
                self._retire(name, c, listed, secrets)
            if failure is not None and not existed:
                # Nothing is stored on failure, the state directory this
                # test made included (only when it is still empty).
                try:
                    state_root.rmdir()
                except OSError:
                    pass
        # (Nothing below may read the registry for this ID again: every such
        # read re-creates the state directory that was just removed.)
        stderr = self._redact(name, self._printed(c), secrets)[-1500:]
        said = self._redact(name, str(failure), secrets)[:WORDS_CHARS]
        # A program linking a row whose terms keep its prices on this
        # computer (our listing's, or its own hello's) gets the sentence in
        # place of the adapter's words: what it printed, and the reason it
        # gave (server._link_refusal). The window gets them whole.
        kept = self._lines_held(name, c, listed, "The broker's own words")
        program = None
        if isinstance(failure, TimeoutError):
            msg = (f"The adapter did not answer within "
                   f"{_HELLO_TIMEOUT_S:g} seconds ({said}).")
        elif isinstance(failure, OSError):
            msg = f"The adapter could not be started: {said}"
        elif "disconnected" in said or "not running" in said:
            # The file ran and ended without one answer: not an adapter, or
            # one that stopped on an error. Said in a trader's words; the
            # lines it printed, stdout and stderr, go under it.
            # (A kit from before stray_lines cannot see its stdout, so there
            # "nothing" would claim too much.)
            nothing = ("It printed nothing. " if hasattr(c, "stray_lines")
                       else "It printed no error. ")
            msg = ("The file stopped before it answered the terminal. "
                   + ("The last lines it printed are below." if stderr else
                      nothing + "An adapter keeps running until the "
                      "terminal closes it: check that this is the adapter "
                      "file."))
        else:
            msg = f"The adapter refused the handshake: {said}"
            if kept:
                head = said.split(":", 1)[0].strip()
                code = head if re.fullmatch(r"[a-z][a-z0-9_]{0,39}", head) else ""
                program = ("The adapter refused the handshake: "
                           + (f"{code}: {kept}" if code else kept))
        if "No module named 'brueconnect'" in stderr:
            # (There is no `brue-connect` to pip install: the SDK is the
            # folder this terminal names in BRUE_CONNECT_SDK, and the
            # starter's first lines put it on the path.)
            tip = (" It could not import brueconnect. Start from the "
                   "starter adapter: its first lines find brueconnect in "
                   "the folder this terminal gives it.")
            msg += tip
            program = (program + tip) if program else None
        err = LinkError(msg, 400, stderr)
        if kept:
            err.withheld = {"detail": program or msg,
                            "stderr": kept if stderr else ""}
        raise err

    def link(self, name, python_file=None, args=None, description="",
             env=None, example=None, test: bool = True) -> dict:
        """Link an adapter of the user's own as a broker.

        Either a Python file anywhere on this machine (`python_file`, with
        optional `args`, `env` and `description`) or one of the kit's
        EXAMPLES by key. The adapter is run once and handshaken BEFORE
        anything is stored, so what lands in the registry is known to start,
        and its own name, mode and credential form are known from the first
        paint. On any failure nothing is stored and the LinkError carries the
        adapter's own error and the tail of its stderr. (`test=False` is for
        fixtures that must register something unstartable.)
        """
        if self.base is None:
            raise LinkError("This terminal was installed without its broker "
                            "kit (brueconnect). Update or reinstall the "
                            "terminal.", 503)
        from brueconnect import registry  # noqa: PLC0415
        if not isinstance(name, str) or not _LINK_NAME.fullmatch(name):
            raise LinkError("The ID may use lower case letters, digits, - "
                            "and _ (2 to 32 characters, starting with a "
                            "letter or digit).")
        entry: dict = {}
        if example is not None:
            if python_file or args or env:
                raise LinkError("Link an example by its key alone.")
            path = self._example_path(example)
            if path is None:
                raise LinkError("That example is not part of this terminal's "
                                "kit. Update the terminal to use it.", 404)
            ex = EXAMPLES[example]
            argv = ["python3", str(path), *ex["args"]]
            # The marker is what lets a later spawn find the file again if
            # the app moves (see _linked_argv). BRUE_* is ours to set; a
            # profile sent by the page cannot (see _check_env).
            profile_env = {EXAMPLE_ENV: example}
            description = ex["label"]
            entry = {"example": example}
        else:
            path = self._check_python_file(python_file)
            # The bare word, not today's interpreter path: resolved at each
            # spawn (resolve_interpreter), so a Python upgrade or a move
            # between a source install and the desktop app does not break it.
            argv = ["python3", path, *self._check_args(args)]
            profile_env = self._check_env(env)
        description = _plain(description, 80)
        with self._spawn_lock(name):
            self._rebuild_registry()
            if self._reserved(name):
                raise LinkError(f"The ID {name!r} belongs to a broker this "
                                "terminal already knows. Choose another.", 409)
            try:
                known = registry.load().get("brokers") or {}
            except Exception as e:  # noqa: BLE001
                raise LinkError(f"The broker registry cannot be read: {e}", 409)
            mine = known.get(name)
            if name in self.registry or (mine and not mine.get("builtin")):
                raise LinkError(f"A broker with the ID {name!r} is already "
                                "linked. Unlink it first, or choose another "
                                "ID.", 409)
            identity, form, terms, multi = ({}, None, None, False)
            if test:
                identity, form, terms, multi = self._test_spawn(
                    name, entry, argv, profile_env)
            try:
                try:
                    registry.add(name, argv=argv, env=profile_env,
                                 description=description)
                except TypeError:
                    # brue-connect from before argv lists: its one string
                    # form, quoted so it splits back into exactly this list.
                    registry.add(name, shlex.join(argv), profile_env,
                                 description)
            except Exception as e:  # noqa: BLE001 - RegistryError, OSError
                self._printed_runs.pop(name, None)   # its test's lines with it
                raise LinkError(f"The broker could not be saved: {e}", 400)
            self.last_errors.pop(name, None)
            self._rebuild_registry()
            if identity:
                self._remember(name, identity, form, terms, multi)
            out = self.status_one(name)
            out["tested"] = bool(test)
            return out

    def unlink(self, name: str, forget: bool = False) -> dict:
        """Remove a broker the user linked. Never one of ours.

        Disconnect FIRST, then remove the profile. In the other order a
        login still waiting on the user becomes unreachable: once the
        profile is gone nothing lists the name, so nothing can close its
        adapter. The profile's private state directory is left in place
        (relinking the same ID finds its keys again) unless `forget`, which
        also deletes the stored credentials and the account choice.
        """
        from brueconnect import registry  # noqa: PLC0415
        self._rebuild_registry()
        entry = self.registry.get(name) or {}
        if not entry.get("registered"):
            raise KeyError(f"{name!r} is not a broker you linked")
        with self._spawn_lock(name):
            self.disconnect(name)
            try:
                removed = registry.remove(name)
            except Exception as e:  # noqa: BLE001
                raise LinkError(f"The broker could not be removed: {e}", 409)
            if forget:
                registry.set_credentials(name, {})
                registry.set_account(name, "")
            self._forget(name)
            self.account_lists.pop(name, None)
            self.last_errors.pop(name, None)
            self._printed_runs.pop(name, None)
            self._rebuild_registry()
        return {"broker": name, "unlinked": True, "removed": bool(removed),
                "forgot": bool(forget)}

    def _chosen(self, broker: str) -> str:
        from brueconnect import registry  # noqa: PLC0415
        return registry.get_account(broker)

    def bound_account(self, broker: str):
        """The id of the account this profile is bound to (SPEC 1.7), or None
        when it has none: a login that reaches one account, or a broker with
        no account to choose. What a held request is kept against, so an Ask
        again on another account than the one it went out on is refused."""
        return self._chosen(broker) or None

    def _account_gate(self, broker: str, c):
        """None to carry on connecting, or a status asking which account.

        A broker whose login reaches one account answers itself: that is not
        a choice, so it is bound silently and the user never sees a chooser
        they had no decision to make.
        """
        from brueconnect import registry  # noqa: PLC0415
        multi = cap_flag(c, "accounts", "multi")
        if not multi or self._chosen(broker):
            return None
        rows = (c.request("accounts.list", {}).get("accounts") or [])
        self.account_lists[broker] = rows
        if len(rows) == 1:
            registry.set_account(broker, rows[0].get("id"))
            return None
        # The chooser holds a logged-in session open while it waits for the
        # user to pick an account. Left unanswered it is dropped after ten
        # minutes (_reap_expired_pending), down from an hour, so a session
        # nobody chose is not kept open; the disconnect route cancels it at
        # once (the card's own way out).
        self.pending_auth[broker] = {
            "c": c, "url": None, "accounts": rows,
            "expires": time.time() + PENDING_CHOICE_S}
        return self.status_one(broker)

    def choose_account(self, broker: str, account_id: str) -> dict:
        """Bind this profile to one of the login's accounts.

        The choice is stored, any live session is dropped, and the next
        connect spawns a process bound to it. Switching account is therefore
        a new process by construction, never a swap underneath open positions
        (SPEC 1.7).
        """
        self._require(broker)
        from brueconnect import registry  # noqa: PLC0415
        registry.set_account(broker, account_id)
        if broker in self.conns or broker in self.pending_auth:
            self.disconnect(broker)
        return self.connect(broker)

    def auth_url(self, broker: str) -> str | None:
        """The url the user's browser must visit to finish connecting, if a
        login is pending. The server's auth/open endpoint reads this instead
        of trusting a url from the page (nothing the frontend sends decides
        what gets opened)."""
        pending = self.pending_auth.get(broker)
        return pending["url"] if pending else None

    def _reap_expired_pending(self, broker: str) -> bool:
        """Drop this broker's account chooser if it has waited unanswered past
        its expiry (PENDING_CHOICE_S): stop its adapter and forget the pending
        entry, so a logged-in session nobody chose is not kept open. The
        10-minute backstop for the disconnect route's own cancel; called where
        the card is read (list_brokers) and before a fresh connect."""
        with self.lock:
            pending = self.pending_auth.get(broker)
            if (pending is None or not pending.get("accounts")
                    or time.time() < pending.get("expires", 0)):
                return False
            self.pending_auth.pop(broker, None)
            try:
                pending["c"].close()
            except Exception:
                pass
            self._retire(broker, pending["c"])
        return True

    def disconnect(self, broker: str) -> dict:
        self._require(broker)
        with self.lock:
            c = self.conns.pop(broker, None)
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
                self._retire(broker, c)
            # An abandoned login dies with the disconnect too, so "disconnect"
            # always means "nothing of this broker is running any more".
            pending = self.pending_auth.pop(broker, None)
            if pending is not None:
                try:
                    pending["c"].close()
                except Exception:
                    pass
                self._retire(broker, pending["c"])
            self.quotes.pop(broker, None)
            self._quote_owners.pop(broker, None)
        # Arming needs no cleanup: it lives on the Connector, which just went
        # away, so a reconnect to real money is a fresh decision by
        # construction rather than by remembering to forget.
        return {"broker": broker, "connected": False}

    # == arming ==========================================================
    # The rule itself lives in brueconnect.Connector: one definition of "real
    # money", one enforcement point, one way to consent, shared with the
    # strategy runner and the brue package. This is the HTTP shape of it, and
    # nothing more.
    def is_paper(self, broker: str) -> bool:
        c = self.conns.get(broker)
        if c is not None:
            return c.is_paper
        # Not connected: judge on what it said last time, through the SDK's own
        # comparison so this file never spells out what counts as paper.
        # Silence therefore reads as real money, not as safe.
        Connector, _ = _load_connector(self.connect_dir)
        return Connector.mode_is_paper(self.identity_of(broker).get("mode"))

    def arm(self, broker: str, armed: bool = True,
            reason: str = "armed from the terminal") -> dict:
        self._require(broker)   # an unknown name is a 404, not a 409
        c = self._conn(broker)  # and arming needs a connection to arm
        if armed:
            # A broker whose terms keep live orders by hand (SPEC 3.3): the
            # kit arms such a connection only on the platform's word that
            # every order it sends follows the user's own action. That is
            # true here: the engine's arm and order routes take such a
            # connection's calls from the terminal's own window only (the
            # ticket, the dock, the chart), and refuse every program. A kit
            # from before that rule takes the reason alone.
            if (self.terms_of(broker).get("orders_by_hand_only")
                    and _arm_takes_by_hand(c)):
                c.arm(reason, by_hand=True)
            else:
                c.arm(reason)
        else:
            c.disarm()
        return {"broker": broker, "armed": c.armed, "reason": c.armed_for}

    # == views ===========================================================
    def status_one(self, broker: str) -> dict:
        self._require(broker)
        c = self.conns.get(broker)
        alive = c is not None and c.alive
        entry = self.registry[broker]
        # `broker` (the profile name the user chose) is the identity and is
        # always present; `identity` is the broker's own words about itself,
        # live if connected and last-seen otherwise, and is display only.
        # SPEC 3.1 forbids reading behaviour out of it, so nothing below this
        # line may branch on it.
        identity = c.identity() if alive else self.identity_of(broker)
        out = {"broker": broker, "label": entry["label"],
               "registered": bool(entry.get("registered")),
               "unlinked": bool(entry.get("unlinked")),
               "connected": alive,
               "identity": identity,
               "armed": bool(alive and c.armed),
               "fresh": alive}
        try:
            from brueconnect import registry  # noqa: PLC0415
            acct = registry.get_account(broker)
            if acct:
                out["account_id"] = acct
        except Exception:  # noqa: BLE001 - a picker row must never fail on this
            pass
        # What the user must type before connecting (field names, labels and
        # types; never a value). The fleet directory's row when it has one:
        # a listing knows its broker's fields before any handshake. Else the
        # form the adapter's own handshake declared (SPEC 3.2), live when
        # connected and remembered otherwise, which is the only source a
        # broker the user linked themselves has.
        row = self._directory_row(broker)
        listed = row.get("credential_form") if row else None
        if isinstance(listed, list):
            out["credential_form"] = [f for f in listed if isinstance(f, dict)
                                      and isinstance(f.get("key"), str)]
        else:
            out["credential_form"] = (
                _clean_form(getattr(c, "credential_form", None)) if alive
                else self.form_of(broker))
        # Which of them already hold a value on this machine. NAMES only, so
        # the form can say "saved" instead of showing an empty box.
        out["stored_credentials"] = self._stored_fields(broker)
        # What the broker's terms let the terminal do (SPEC 3.3), and the
        # sentences the screen shows and every refusal carries. Unlike
        # `identity`, this IS branched on, by the engine first: the page uses
        # it to say why, never as the only gate.
        out["terms"] = self.terms_row(broker)
        if entry.get("registered"):
            # What will be run, for a profile the user linked: the argument
            # list as it is spawned here. Never the profile's env values.
            try:
                argv = entry.get("argv")
                out["command_preview"] = (
                    self._linked_argv(entry, argv) if argv
                    else [str(entry.get("command", ""))])
            except Exception:  # noqa: BLE001 - a row must never fail on this
                out["command_preview"] = [str(entry.get("command", ""))]
            if entry.get("example"):
                out["example"] = entry["example"]
        failed = self.last_errors.get(broker)
        if failed and not alive:
            out["last_error"] = dict(failed)
        # What its adapter printed, for its card: while it is connected, and
        # after a run that ended (disconnected, or died), the latest last.
        # The window's alone on a data_local_only connection (server._row_for).
        printed = self.printed_lines(broker)
        if printed:
            out["printed"] = printed
        blocked = self.blocked(broker)
        out["ready"] = blocked is None
        if blocked:
            out["blocked"] = blocked
        if entry.get("update_required"):
            out["update_required"] = True
        pending = self.pending_auth.get(broker)
        # The account list travels with the row whether connected or not, so
        # the card can always show which account is in use and what else this
        # login reaches, rather than hiding the choice behind a button.
        known = self.account_lists.get(broker)
        if known:
            out["accounts"] = known
        # A login that can reach several accounts, said by its own hello
        # (live, or the last one remembered): until one is bound there is no
        # account to ask "allow trading?" about. Not known is said as null,
        # not as one account: the page asks the adapter first (a probe).
        multi = self._accounts_multi(c) if alive else self.remembered_multi(broker)
        if multi:
            out["accounts_multi"] = True
        elif multi is None:
            out["accounts_multi"] = None
        if pending is not None and not alive:
            # Mid-login: the adapter waits on its loopback for the user to
            # finish the broker's page. The url is the whole story the UI
            # needs (it renders the "Log in with <broker>" button from this).
            rows = pending.get("accounts")
            if rows:
                # Logged in, waiting on which account. The url is deliberately
                # NOT offered here: the login is done, and showing it again
                # would invite a second, pointless trip to the browser.
                out["needs_account"] = True
                out["accounts"] = rows
            else:
                out["auth_pending"] = True
                out["auth_url"] = pending["url"]
        if alive:
            out["broker_name"] = c.handshake.get("broker")
            out["mode"] = c.handshake.get("mode")
            out["symbols"] = sorted(list(c.catalog))
            # What this broker can DO, verbatim from its handshake, so the UI
            # can offer only what exists (SPEC 3: absent from capabilities is
            # absent from the broker; offering it anyway and eating the error
            # is the forbidden silent path). Unlike `identity` this is meant
            # to be branched on.
            out["capabilities"] = caps_of(c)
            # A broker that says it is degraded gets to say so in the UI. It
            # is the one thing a user cannot work out for themselves: a capped
            # stream looks exactly like a quiet market.
            sess = getattr(c, "session_state", None)
            if isinstance(sess, dict) and sess.get("state") != "connected":
                # its detail is the adapter's own words: the values its
                # profile keeps taken out, as from its printed lines
                if isinstance(sess.get("detail"), str):
                    sess = dict(sess, detail=self._redact(broker, sess["detail"]))
                out["session"] = sess
        elif identity.get("mode"):
            # remembered from the last connect, so a live venue is still
            # flagged as live in the menu before anything is spawned
            out["mode"] = identity["mode"]
        return out

    def list_brokers(self) -> list[dict]:
        self._rebuild_registry()  # a broker linked a moment ago is listed now
        # The card is read on a poll, so an account chooser left unanswered
        # past its expiry is dropped here, with no action from the user.
        for b in list(self.pending_auth):
            self._reap_expired_pending(b)
        return [self.status_one(b) for b in list(self.registry)]

    def probe(self, broker: str, force: bool = False) -> dict:
        """Learn what a broker calls itself, as cheaply as it can be learned.

        Spawns the adapter, sends `hello`, remembers the answer and shuts it
        down. At the protocol level that is the whole conversation: nothing is
        subscribed, no account is read, no order path is touched.

        What it costs at the BROKER depends on the adapter, and it is not
        nothing: an adapter that authenticates in its startup path logs in
        before it can answer anything, so drawing a menu row can cost a
        session (measured on our own reference venue: one auth, one account
        read, one stream). Hence once per broker, cached, and never repeated
        while the answer still stands. SPEC 3.1 asks adapters to keep `hello`
        answerable cold for exactly this reason.
        """
        self._require(broker)
        with self._spawn_lock(broker):
            c = self.conns.get(broker)
            if c is not None and c.alive:
                return self.status_one(broker)
            # Re-checked inside the lock: three tabs opening the menu at once
            # used to spawn three adapters, and for a broker that opens an
            # account on first run that is three accounts. A name remembered
            # without whether its login reaches several accounts (an earlier
            # build's record) is asked once more, so Connect knows.
            if (not force and self.identity_of(broker).get("display_name")
                    and self.remembered_multi(broker) is not None):
                return self.status_one(broker)
            self.last_errors.pop(broker, None)
            c = self._new_connector(broker)
            failure = None
            try:
                self._start(c)
                c.hello(timeout=_HELLO_TIMEOUT_S)
                self._remember(broker, c.identity(),
                               getattr(c, "credential_form", None),
                               self._live_terms(c), self._accounts_multi(c))
            except Exception as e:
                failure = e
                raise
            finally:
                try:
                    c.close()
                except Exception:
                    pass
                if failure is not None:
                    self._note_failure(broker, c, failure)
                self._retire(broker, c)
        return self.status_one(broker)

    def catalog(self, broker: str) -> list[dict]:
        c = self._conn(broker)
        # The broker told us its terms changed but did not send the new ones,
        # so re-read before answering rather than handing back what we know is
        # out of date (SPEC 5). Done here, on a request thread, because the
        # event arrives on the reader thread and cannot make requests.
        if getattr(c, "catalog_stale", False):
            try:
                c.refresh_catalog()
            except Exception:
                pass  # stale beats nothing; the flag stays set and we retry
        # Snapshot first. The reader thread deletes symbols from this dict when
        # the broker delists or expires one, so reading it in two steps could
        # sort a key and then fail to find it.
        cat = dict(c.catalog)
        return [cat[s] for s in sorted(cat)]

    def connector(self, broker: str):
        """The live connection for a broker, for callers that need to speak
        the protocol directly (the data provider's candle reads). Raises the
        same way every other accessor does when the broker is not connected.
        """
        return self._conn(broker)

    def account(self, broker: str) -> dict:
        c = self._conn(broker)
        return c.request("account.get")

    def positions(self, broker: str) -> list[dict]:
        c = self._conn(broker)
        return c.request("positions.list").get("positions", [])

    def _quote_owner_state(self, broker: str) -> dict:
        """One lock and ownership record per actual connector generation."""
        with self.lock:
            c = self._conn(broker)
            state = self._quote_owners.get(broker)
            if state is None or state["connector"] is not c:
                state = {"connector": c, "lock": threading.RLock(),
                         "display": set(), "shared": set(c.subscribed)}
                self._quote_owners[broker] = state
            return state

    def _quote_owner_connection(self, broker: str, state: dict):
        c = state["connector"]
        if self._conn(broker) is not c:
            raise LookupError(f"broker {broker!r} connection changed")
        # Preserve subscriptions made outside this display's ownership.
        state["shared"].update(set(c.subscribed) - state["display"])
        return c

    def subscribe(self, broker: str, symbols: list[str]) -> dict:
        """Add provider/other-reader claims; preserve the existing additive API.

        BrokerProvider's board and quote readers share this connection with
        the ticket. Recording an overlapping claim is necessary even when
        Connector.subscribe deduplicates it and sends no protocol request.
        """
        state = self._quote_owner_state(broker)
        with state["lock"]:
            c = self._quote_owner_connection(broker, state)
            if not cap_flag(c, "data", "quotes"):
                return {"subscribed": [], "refused": [], "quotes": False}
            wanted = list(dict.fromkeys(s for s in symbols if s))
            try:
                out = c.subscribe(wanted)
            finally:
                # Partial success remains a claim; refused/invalid symbols
                # never become phantom claims that poison later requests.
                state["shared"].update(set(wanted) & set(c.subscribed))
            if self._conn(broker) is not c:
                raise LookupError(f"broker {broker!r} connection changed")
            out["quotes"] = True
            return out

    # A window that has not asked for this long has closed, or left the page
    # that shows a ticket: its claims are given up at the next window's ask.
    # A window asks after every positions refresh (5 s), so this is nine
    # missed asks, and a window throttled in the background comes back with
    # its next one.
    DISPLAY_CLAIM_TTL_S = 45.0

    def subscribe_display(self, broker: str, symbols: list[str],
                          display: str = "") -> dict:
        """Replace only one display's ticket plus held-position subscription.

        Provider and pre-existing unowned subscriptions are protected. Drop
        obsolete display-only symbols before adding, so a long sequence of
        chart selections cannot consume the broker's concurrent-symbol cap.
        The caller receives refused symbols and must display that limitation.

        `display` names the window that asks (the terminal can be open in
        several). Each window's claim is kept apart and the union is what
        the broker streams, so a second window's ticket does not end the
        first one's prices. One window, or a caller that names none, is the
        single display it always was.
        """
        state = self._quote_owner_state(broker)
        with state["lock"]:
            c = self._quote_owner_connection(broker, state)
            if not cap_flag(c, "data", "quotes"):
                return {"subscribed": [], "refused": [], "quotes": False}
            mine = list(dict.fromkeys(s for s in symbols if s))
            claims = state.setdefault("displays", {})
            now = time.monotonic()
            for name in [n for n, d in claims.items()
                         if n != display and now - d["seen"] > self.DISPLAY_CLAIM_TTL_S]:
                del claims[name]
            # This window's symbols first: at the broker's cap they are the
            # ones that fit, and the refusal the caller shows is its own.
            others = [s for n, d in claims.items() if n != display
                      for s in sorted(d["symbols"])]
            wanted = list(dict.fromkeys([*mine, *others]))
            drop = state["display"] - set(wanted) - state["shared"]
            if drop:
                # On a failed unsubscribe keep the old ownership so a retry
                # can finish cleanup; never report a successful replacement.
                c.unsubscribe(sorted(drop))
            state["display"].intersection_update(c.subscribed)
            try:
                out = c.subscribe(wanted)
            finally:
                # Track only actual accepted display claims after any partial
                # failure. Shared claims remain independently protected.
                state["display"] = set(wanted) & set(c.subscribed)
                claims[display] = {"symbols": set(mine) & set(c.subscribed),
                                   "seen": now}
            if self._conn(broker) is not c:
                raise LookupError(f"broker {broker!r} connection changed")
            if others:
                # another window's symbol that did not fit is that window's
                # to be told, at its own ask
                own = set(mine)
                out["refused"] = [s for s in out.get("refused", []) if s in own]
                out["subscribed"] = [s for s in out.get("subscribed", []) if s in own]
            out["quotes"] = True
            return out

    def latest_quotes(self, broker: str) -> dict:
        self._conn(broker)  # raises if not connected
        # A COPY. The adapter's reader thread adds a key to this dict for
        # every new symbol it sees, and handing the live dict to the response
        # serialiser raised "dictionary keys changed during iteration" mid
        # response (reproduced against fastapi's encoder). One shallow copy
        # per poll is enough: the per-symbol dicts are replaced wholesale by
        # the quote handler, never mutated in place.
        return dict(self.quotes.get(broker, {}))

    # == trading =========================================================
    ORDER_MARKS_KEPT = 256

    def _order_since(self, broker: str, c, client_id: str) -> int:
        """Where to look in this connection's events for what became of the
        order under `client_id`: from its first attempt on this connection,
        so asking again finds an outcome that arrived in between."""
        now = c.mark()
        marks = self.__dict__.setdefault("_order_marks", {})
        with self.lock:
            seen = marks.get((broker, client_id))
            if seen is not None and seen[0] is c:
                return seen[1]
            marks[(broker, client_id)] = (c, now)
            while len(marks) > self.ORDER_MARKS_KEPT:
                marks.pop(next(iter(marks)))
        return now

    @staticmethod
    def _order_event(c, name: str, mine, timeout: float, since: int):
        """The order's event from `since`; from now when the events since
        then have left the connection's history (asked again long after)."""
        try:
            return c.wait_event(name, predicate=mine, timeout=timeout,
                                since=since)
        except TimeoutError:
            raise
        except Exception as e:  # noqa: BLE001 - only the overrun is ours
            if getattr(e, "code", None) != "event_window_overrun":
                raise
            return c.wait_event(name, predicate=mine, timeout=timeout,
                                since=c.mark())

    def order(self, broker: str, symbol: str, side: str, qty: float,
              sl=None, tp=None, otype: str = "market",
              price=None, stop_price=None, client_id=None) -> dict:
        c = self._conn(broker)
        # The client_id is the platform's guard against a second execution
        # (SPEC 2): a new one for a new order; for an order asked for again
        # after its answer was lost, the one its first attempt went under,
        # which the adapter answers from the broker's own record.
        client_id = client_id or new_client_id("order")
        params = {"client_id": client_id, "symbol": symbol,
                  "side": side, "qty": qty}
        pending = otype and otype != "market"
        if pending:
            # SPEC 4: limit and stop both carry their level in `price`;
            # stop_limit is the only type with a distinct `stop_price`. The
            # level is duplicated into `stop_price` for a plain stop because
            # deployed adapters read it as a documented alias (quantex docs
            # 6.1), and one field name must not decide whether an order rests.
            params["type"] = otype
            if price is not None:
                params["price"] = price
            if otype == "stop" and stop_price is None:
                stop_price = price
            if stop_price is not None:
                params["stop_price"] = stop_price
        if sl:
            params["sl"] = sl
        if tp:
            params["tp"] = tp
        mark = self._order_since(broker, c, client_id)
        try:
            res = c.request("order.place", params)
        except Exception as e:
            _note_attempt(e, client_id)
            raise
        out = {"order_id": res.get("order_id"), "client_id": client_id,
               "status": res.get("status") or "accepted"}
        # acceptance is transport-level (SPEC); the outcome is an event.
        # Wait briefly for the fill so the ticket can answer like the sim
        # path does; a slow broker just leaves status "accepted". The
        # rejected check is a history scan from `mark`, so a reject that
        # raced the fill wait cannot be missed. A pending order RESTS by
        # definition, so it gets only the reject scan: waiting 5s for a fill
        # that is not supposed to happen would freeze the ticket on every
        # placement. `mark` is the first attempt's, so an order asked for
        # again finds a fill that came in after its answer was lost.
        mine = lambda d: d.get("client_id") == client_id  # noqa: E731
        if pending:
            try:
                rej = self._order_event(c, "order.rejected", mine, 0.5, mark)
                out["status"] = "rejected"
                out["reason"] = rej.get("reason")
            except TimeoutError:
                pass
            return out
        try:
            out["fill"] = self._order_event(c, "order.filled", mine, 5.0, mark)
            out["status"] = "filled"
        except TimeoutError:
            try:
                rej = self._order_event(c, "order.rejected", mine, 0.1, mark)
                out["status"] = "rejected"
                out["reason"] = rej.get("reason")
            except TimeoutError:
                pass
        return out

    def orders_list(self, broker: str) -> list[dict]:
        """Resting (working) orders, for the dock's Orders tab.

        Empty-not-error on brokers without resting orders: a market-only
        broker has nothing to list, and SPEC 3 says orders.list may be
        unanswerable (orders.can_list false), in which case the caller's
        order view is degraded rather than broken.
        """
        c = self._conn(broker)
        # pending only when it is true itself; can_list is true by SPEC's
        # default, so only a false itself says there is no list
        if not cap_flag(c, "orders", "pending") or caps_of(c, "orders").get("can_list") is False:
            return []
        orders = c.request("orders.list", {"state": "resting"}).get("orders", [])
        # Belt and braces: some adapters answer state filters loosely, and a
        # filled/cancelled row painted as working would invite a cancel that
        # can only fail.
        return [o for o in orders if o.get("state") in (None, "resting")]

    def cancel_order(self, broker: str, order_id: str, client_id=None) -> dict:
        c = self._conn(broker)
        # A client_id per cancel the user asks for. A cancel asked for again
        # after its answer was lost carries the one its first attempt went
        # under (the route's answer gave it), so the adapter replays the
        # original outcome instead of erroring on the already-gone order
        # (SPEC 2, the same shape as position.close below).
        cid = client_id or new_client_id("cancel", order_id)
        try:
            return c.request("order.cancel",
                             {"order_id": order_id, "client_id": cid})
        except Exception as e:
            _note_attempt(e, cid)
            raise

    def close_position(self, broker: str, position_id: str, qty=None,
                       client_id=None) -> dict:
        c = self._conn(broker)
        # A client_id so a close asked for again after a dropped response is
        # idempotent (SPEC 2): it carries the one its first attempt went under
        # (the route's answer gave it), and the adapter returns the original
        # outcome instead of closing a second time. A deliberate later close
        # of the same position and size has an id of its own, so it is a new
        # request, not a swallowed replay.
        cid = client_id or new_client_id("close", position_id, qty)
        params = {"position_id": position_id, "client_id": cid}
        if qty:
            params["qty"] = qty
        try:
            return c.request("position.close", params)
        except Exception as e:
            _note_attempt(e, cid)
            raise

    def modify_position(self, broker: str, position_id: str,
                        sl=None, tp=None) -> dict:
        """SL/TP on an open position (SPEC `order.modify`).

        Callers pass the FULL desired bracket every time; None clears that
        side, exactly the sim engine's /sim/modify contract, so the chart's
        drag handles speak one language on both paths. Do not "optimise" to
        omit an unchanged side: omitted and null mean different things to the
        adapter, and a partial message would clear whichever side the caller
        thought it was leaving alone.
        """
        c = self._conn(broker)
        return c.request("order.modify",
                         {"position_id": position_id, "sl": sl, "tp": tp})

    def fills(self, broker: str, from_ms=None, to_ms=None) -> list[dict]:
        """The broker's own fill ledger (SPEC `history.fills`), for the
        account dock's History tab. Times are UTC epoch ms end to end; the
        window params pass through untranslated because inventing a local
        timezone here is how two terminals disagree about the same ledger.
        """
        c = self._conn(broker)
        params = {}
        if from_ms is not None:
            params["from"] = int(from_ms)
        if to_ms is not None:
            params["to"] = int(to_ms)
        return c.request("history.fills", params).get("fills", [])

    def shutdown(self):
        with self.lock:
            for b in list(self.conns) + list(self.pending_auth):
                self.disconnect(b)


# --- a connected broker, offered as a DATA source -------------------------
# Lives here rather than in providers/ because it is broker code: a thin
# window onto the hub above, holding no venue knowledge of its own.

_CATEGORY_LABELS = {
    "fx": "Forex", "forex": "Forex", "currency": "Forex",
    "crypto": "Crypto", "equity": "Equities", "stock": "Equities",
    "index": "Indices", "metal": "Metals", "commodity": "Commodities",
    "future": "Futures", "bond": "Bonds", "option": "Options",
}


def _category_label(raw) -> str:
    """A venue's asset_class as a display-ready folder name.

    The sidebar renders whatever a provider returns with no source-specific
    rules of its own (Provider.search's presentation contract), so the
    translation from a venue's vocabulary to a human label happens here.
    """
    key = str(raw or "").strip().lower()
    return _CATEGORY_LABELS.get(key) or key.replace("_", " ").title() or "Instruments"


# The forms a chart window's start and end are taken in, as a refusal names
# them (server's /api/candles, BrokerProvider.candles).
WINDOW_FORMS = ("a time in ISO 8601 (2026-11-15T09:30:00Z, 2026-11-15T10:30:00+01:00, "
                "or 2026-11-15 for its midnight UTC; a time with no zone is UTC) or in "
                "epoch seconds (1794738600)")


def window_seconds(value, which: str = "start"):
    """A chart window's start or end as whole epoch seconds, or None when it
    is not given. Taken as ISO 8601 or as epoch seconds (WINDOW_FORMS); a
    start inside a second is the next whole second, an end the one before,
    since a bar is in the window when its time is. Raises ValueError in
    plain words naming the forms for anything else."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    sec = None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        sec = float(value)
    elif isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"[+-]?\d+(?:\.\d+)?", s):
            sec = float(s)
        else:
            try:
                dt = datetime.fromisoformat(s[:-1] + "+00:00" if s[-1:] in "Zz" else s)
            except ValueError:
                dt = None
            if dt is not None:
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                sec = dt.timestamp()
    if sec is None or not math.isfinite(sec):
        raise ValueError(f"{which} must be {WINDOW_FORMS}; {str(value)[:60]!r} is neither.")
    whole = math.ceil(sec) if which == "start" else math.floor(sec)
    try:
        datetime.fromtimestamp(whole, timezone.utc)
    except (OverflowError, OSError, ValueError):
        raise ValueError(f"{which} must be {WINDOW_FORMS}; {str(value)[:60]!r} is "
                         "not a time a chart has.") from None
    return int(whole)


def window_iso(sec):
    """Whole epoch seconds as the ISO 8601 time every source takes, or None."""
    if sec is None:
        return None
    return datetime.fromtimestamp(sec, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _price_digits(raw):
    """The decimals a venue declares for an instrument's price, or None.

    A catalog row is the adapter's own text: anything that is not a whole
    number of decimals a price can have is treated as not declared, so the
    page falls back to its own rule instead of printing from a bad value.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    # The range first: it also turns away NaN and the infinities, which
    # int() below cannot take (Python's json reads a bare Infinity).
    if not 0 <= raw <= 20 or raw != int(raw):
        return None
    return int(raw)


def _tick_digits(raw):
    """The decimals of a tick size (0.00001 has 5, 0.25 has 2, 1 has 0), or
    None: a price on that grid has that many. For an instrument whose row
    leaves its digits out."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    if not (math.isfinite(raw) and raw > 0):
        return None
    for d in range(13):
        scaled = raw * 10 ** d
        whole = round(scaled)
        if whole >= 1 and abs(scaled - whole) <= 1e-6 * scaled:
            return d
    return None


class BrokerProvider(Provider):
    """A connected broker as the markets page's data source.

    When you execute on a venue, that venue's prices are the ones you should
    be looking at while you execute, so a connected broker can drive the
    watchlist and the chart.

    It deliberately does NOT drive backtests or research. A venue keeps a
    shallow slice of history next to the LSE archive, so letting the broker
    take those over would quietly shrink every backtest to whatever that venue
    happens to retain: the silent degradation this platform exists to refuse.
    The split is enforced by the caller (the markets page follows the active
    source, research asks for the data source), not by this class.

    Only offered for a broker that can actually serve candles. One whose
    handshake declares no bars/history (an order-entry-only FIX session)
    stays trade-only rather than becoming a data source with a permanently
    empty chart.
    """

    is_broker = True

    def __init__(self, hub, broker: str, label: str = "", timeframes=None):
        self.hub = hub
        self.broker = broker
        # Namespaced, so a venue can never collide with a data vendor's name
        # and the UI can tell the two apart from the name alone.
        self.name = f"broker:{broker}"
        self.title = label or broker
        if timeframes:
            self.timeframes = list(timeframes)

    def configured(self) -> bool:
        # A disconnected broker is not a source you can read; the picker greys
        # it rather than failing at the first candle request.
        return self.broker in self.hub.conns

    @staticmethod
    def _rank(q: str, sym: str, name: str):
        """How well an instrument answers a search, or None for not at all.

        0 the symbol IS the query, 1 it starts with it, 2 it contains it,
        3 only the name contains it. A venue with thousands of instruments
        has hundreds whose symbol merely contains "F"; the one called F must
        not be cut off behind them.
        """
        if not q:
            return 0
        s = sym.upper()
        if s == q:
            return 0
        if s.startswith(q):
            return 1
        if q in s:
            return 2
        if q in name.upper():
            return 3
        return None

    def total(self, query: str = "") -> int:
        """How many instruments answer `query` before any limit is applied,
        so a caller that asked for a bounded page can say what it left out."""
        q = str(query or "").strip().upper()
        return sum(1 for r in self.hub.catalog(self.broker)
                   if self._rank(q, str(r.get("symbol") or ""),
                                 str(r.get("name") or "")) is not None)

    def search(self, query: str = "", limit: int = 50) -> list:
        rows = self.hub.catalog(self.broker)
        q = str(query or "").strip().upper()
        out = []
        for r in rows:
            sym = str(r.get("symbol") or "")
            name = str(r.get("name") or "")
            rank = self._rank(q, sym, name)
            if rank is None:
                continue
            out.append((rank, Instrument(
                symbol=sym, name=name,
                category=_category_label(r.get("asset_class")),
                provider=self.name,
                # An untradable instrument still charts. The ticket decides
                # what may be dealt, and hiding these would make the venue
                # look smaller than it is.
                # digits: how many decimals this venue quotes the instrument
                # to, so the sidebar and the chart print its prices the way
                # the ticket does; a row that leaves them out is printed to
                # its tick size.
                meta={"live": True, "tradable": bool(r.get("tradable", True)),
                      "digits": (_price_digits(r.get("digits")) if "digits" in r
                                 else _tick_digits(r.get("tick_size")))})))
        if q:
            # A search answer is a ranked list (it feeds the search box, not
            # the folders): the exact symbol first, then symbols that start
            # with the query, then the rest, so the cut below keeps the best.
            out.sort(key=lambda t: (t[0], t[1].symbol))
        else:
            # The whole catalog, for the sidebar: contiguous groups in a
            # stable order, because it renders arrival order verbatim, one
            # folder per category.
            out.sort(key=lambda t: (t[1].category, t[1].symbol))
        return [i for _, i in out][:limit]

    # A venue's bars answer holds CLOSED bars only, so the period now forming
    # is missing: a chart opened at 16:40 on hour bars drew the 16:00 bar from
    # its first tick, a stub opening at 16:40's price. For periods of up to
    # four hours that bar is built here from the venue's own closed minute
    # bars inside it, and the stream carries it on from there.
    FORMING_FROM_1M = {"5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400}

    def candles(self, symbol: str, timeframe: str, limit: int = 500,
                start=None, end=None):
        import pandas as pd  # noqa: PLC0415 - matches the other providers
        from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415
        conn = self.hub.connector(self.broker)
        # Only the newest page has a forming bar; a page of the past has none.
        width = (self.FORMING_FROM_1M.get(timeframe)
                 if start is None and end is None else None)
        minutes = pool = None
        if width:
            # Asked beside the main page, not after it, so the chart waits
            # for the slower of the two rather than for both.
            pool = ThreadPoolExecutor(max_workers=1)
            minutes = pool.submit(conn.request, "bars.history",
                                  {"symbol": symbol, "timeframe": "1m",
                                   "count": width // 60})
        try:
            res = conn.request(
                "bars.history", {"symbol": symbol, "timeframe": timeframe,
                                 "count": int(limit)})
        finally:
            if pool is not None:
                pool.shutdown(wait=False)
        bars = res.get("bars") or []
        if not bars:
            return pd.DataFrame(columns=CANDLE_COLUMNS)
        df = pd.DataFrame([list(b[:6]) for b in bars], columns=CANDLE_COLUMNS)
        # The protocol speaks epoch MILLISECONDS; every provider hands the
        # chart epoch SECONDS. Getting this wrong puts the candles 55,000
        # years out rather than failing loudly, so it is done once, here.
        df["ts"] = pd.to_numeric(df["ts"], errors="coerce") // 1000
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.dropna(subset=["ts", "open", "high", "low", "close"])
        # The window in either form a caller has it in: an ISO 8601 time
        # (the route's) or epoch seconds (window_seconds).
        start_s, end_s = window_seconds(start, "start"), window_seconds(end, "end")
        if start_s is not None:
            df = df[df["ts"] >= start_s]
        if end_s is not None:
            df = df[df["ts"] <= end_s]
        df = df[CANDLE_COLUMNS].sort_values("ts").reset_index(drop=True)
        if minutes is not None and len(df):
            try:
                row = self._forming(minutes.result(timeout=10), width,
                                    int(df["ts"].iloc[-1]))
            except Exception:  # noqa: BLE001 - the closed bars stand alone;
                row = None     # the stream still draws the bar from its ticks
            if row is not None:
                df = pd.concat([df, pd.DataFrame([row], columns=CANDLE_COLUMNS)],
                               ignore_index=True)
        return df

    @staticmethod
    def _forming(res: dict, width: int, last_closed: int, now=None):
        """The bar of the period now forming, [ts, o, h, l, c, v] in seconds,
        from the venue's closed minute bars inside it, or None.

        Its start is the chart's own bucket (app.js onTick: ts floored to the
        period), so the stream's ticks land in this bar. Only made when the
        venue's periods line up with those buckets (the last closed bar is a
        whole number of periods before it); a venue whose day starts at New
        York's midnight, say, keeps the bar to the ticks.
        """
        now = time.time() if now is None else now
        begin = int(now // width * width)
        if begin <= last_closed or (begin - last_closed) % width:
            return None
        rows = []
        for b in res.get("bars") or []:
            try:
                t = int(b[0]) // 1000
                o, h, low, c = (float(b[i]) for i in (1, 2, 3, 4))
                v = float(b[5] or 0) if len(b) > 5 else 0.0
            except (TypeError, ValueError, IndexError):
                continue
            if begin <= t < begin + width and all(map(math.isfinite, (o, h, low, c))):
                rows.append((t, o, h, low, c, v))
        if not rows:
            return None
        rows.sort()
        return [begin, rows[0][1], max(r[2] for r in rows),
                min(r[3] for r in rows), rows[-1][4], sum(r[5] for r in rows)]

    def _board(self, symbols: list) -> dict:
        """Tell the venue what is on screen, then read the hub's live cache.

        Subscribing here rather than in the UI keeps this provider's contract
        identical to a vendor's: the caller asks for prices and the source
        arranges whatever it needs in order to answer.
        """
        try:
            self.hub.subscribe(self.broker, [s for s in symbols if s])
        except Exception:  # noqa: BLE001 - a broker with no quote stream
            pass           # still has whatever its last snapshot left behind
        return self.hub.latest_quotes(self.broker)

    def prices(self, symbols: list) -> list:
        cache = self._board(symbols)
        out = []
        for s in symbols:
            row = self._row(s, cache.get(s))
            if row is not None:
                out.append(row)
        return out

    @staticmethod
    def _row(symbol: str, q):
        if not q:
            return None
        bid, ask = q.get("bid"), q.get("ask")
        # The price shown is the bid; with no bid, the one side there is.
        # Every price the terminal shows is the bid, so a broker's row, its
        # quote and its live bar agree with each other.
        if bid is not None:
            price = float(bid)
        elif ask is not None:
            price = float(ask)
        else:
            return None
        # Broker protocol time is UTC epoch milliseconds, not local receipt
        # time. Missing/invalid source time remains unknown on the board.
        stamp = q.get("time")
        valid_time = (isinstance(stamp, (int, float)) and not isinstance(stamp, bool)
                      and math.isfinite(stamp) and stamp > 0)
        return {"symbol": symbol, "price": price, "bid": bid, "ask": ask,
                "ts": stamp if valid_time else None}

    def quote(self, symbol: str):
        row = self._row(symbol, self._board([symbol]).get(symbol))
        if row is None:
            raise NotSupported(f"{self.title} has no quote for {symbol}")
        if row["ts"] is None:
            raise NotSupported(f"{self.title} quote for {symbol} has no source timestamp")
        return Quote(symbol=symbol, price=row["price"], ts=row["ts"] / 1000.0,
                     bid=row["bid"], ask=row["ask"])

    # How often stream() looks at the hub's quote cache. A venue quotes less
    # often than this (one listed adapter polls every 1.5 s), so a quote
    # reaches the chart within a quarter of a second of arriving.
    STREAM_LOOK_SEC = 0.25

    async def stream(self, symbols: list[str]):
        """Ticks from the broker's own quotes, for the chart's live bar.

        A venue's bars answer holds CLOSED bars only, so without this a
        broker chart stood on its last finished bar while the ticket quoted
        the market (a listed broker's paper account at the US open of
        2026-11-11: the AAPL chart at 347.13, the ticket at 351.97/352.33).
        The chart builds the forming bar from these ticks as it does for
        every streaming source (app.js onTick). One tick per new quote: the price is the bid, as on the
        watchlist row (_row); ts is the broker's own time in SECONDS, as the
        contract says (the chart buckets it by the timeframe). A quote with
        no source time is not sent: stamping it with the time it arrived
        would put an old price into the current bar.
        """
        import asyncio  # noqa: PLC0415 - only the stream needs it
        wanted = list(dict.fromkeys(s for s in symbols if s))
        if not wanted:
            return
        # Subscribing speaks to the adapter and waits for its answer, so it
        # runs off the event loop. A broker that is not connected raises
        # LookupError here, which the websocket reports to the chart.
        out = await asyncio.to_thread(self.hub.subscribe, self.broker, wanted)
        if not out.get("quotes"):
            # No quote stream at this venue: the same quiet capability answer
            # the chart already knows ("does not stream"), not a fault.
            raise NotSupported(f"{self.title} does not stream")
        sent: dict = {}
        while True:
            # A copy; raises LookupError once the broker disconnects, which
            # ends the stream and tells the chart.
            cache = self.hub.latest_quotes(self.broker)
            for s in wanted:
                q = cache.get(s)
                # The hub replaces a symbol's dict on every quote, so a new
                # object is a new quote.
                if q is None or q is sent.get(s):
                    continue
                sent[s] = q
                row = self._row(s, q)
                if row is None or row["ts"] is None:
                    continue
                yield {"symbol": s, "price": row["price"], "bid": row["bid"],
                       "ask": row["ask"], "ts": row["ts"] / 1000.0}
            await asyncio.sleep(self.STREAM_LOOK_SEC)
