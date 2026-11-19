"""The models the user's own agent CLI offers, asked of the CLI itself.

The panel's model menu used to be a list typed into the page. Providers ship
models more often than this app ships builds, so the list aged: the newest
models were missing and a row could name one the provider had withdrawn. Each
CLI already knows what its account can run, so this module asks it.

- Codex prints its catalogue as JSON (`codex debug models`), refreshed from
  OpenAI for the signed-in account. The same catalogue is kept in
  `models_cache.json` under the Codex home, and is read when the command
  cannot be run.
- Claude Code answers the `initialize` control request of its stream-json
  mode with its own model menu, and with the models that need a newer Claude
  Code. No prompt is sent and nothing is spent.

A CLI lists only the models it knows. One that is behind its provider's
newest release cannot offer the newest models, and does not reliably say so,
so the answer also carries the CLI's own version beside the newest published
one (the npm registry's `latest`, where both CLIs are published), and the
menu tells the user when an update is waiting.

Nothing here raises. A CLI that is missing, slow, signed out or changed gives
`{"ok": False, ...}` and the page keeps its built-in list.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

# A listing is a menu, not a turn: it must never hold the panel up.
TIMEOUT = 12.0

# A model id goes into the CLI's argv on the next turn, so only plain names
# are passed on: letters, digits and the punctuation the providers use
# ("gpt-6.1-terra", "opus[1m]", "claude-fable-5-2").
_ID_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$")

_INIT = json.dumps({"type": "control_request", "request_id": "lse-models",
                    "request": {"subtype": "initialize"}}) + "\n"

_CLAUDE_FLAGS = ["-p", "--input-format", "stream-json",
                 "--output-format", "stream-json", "--verbose"]

# Where each CLI is published, what the user calls it, and how it updates
# itself. `claude update` and `codex update` are the CLIs' own commands.
CLI = {
    "claude": {"package": "@anthropic-ai/claude-code", "name": "Claude Code",
               "update": "claude update"},
    "codex": {"package": "@openai/codex", "name": "Codex",
              "update": "codex update"},
}
_LATEST_TTL_OK = 6 * 3600   # releases come daily at most
_LATEST_TTL_FAIL = 600      # offline: do not wait on the registry every time
_latest_cache: dict = {}

DEFAULT_ROW = {
    "claude": {"id": "", "name": "Default (recommended)",
               "desc": "Whatever your plan uses out of the box"},
    "codex": {"id": "", "name": "Default (recommended)",
              "desc": "Codex picks the model for you"},
}


def _text(value, cap: int) -> str:
    return " ".join(str(value or "").split())[:cap]


def _fail(agent: str, error: str) -> dict:
    return {"ok": False, "agent": agent, "source": "", "models": [],
            "unavailable": [], "error": _text(error, 300)}


def _kill(proc) -> None:
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (OSError, ProcessLookupError):
        pass


def _run(argv, stdin_text, env, cwd, timeout):
    """Run a CLI to its end and return (exit code, stdout, stderr).

    Its own process group on POSIX, so a timeout takes the children with it;
    no console window on Windows, where the engine has none to share.
    """
    extra = ({"start_new_session": True} if os.name == "posix" else
             {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)})
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, cwd=cwd, **extra)
    try:
        out, err = proc.communicate((stdin_text or "").encode("utf-8"),
                                    timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(proc)
        try:
            proc.communicate(timeout=2)
        except (subprocess.TimeoutExpired, OSError, ValueError):
            pass
        raise
    return (proc.returncode, out.decode("utf-8", "replace"),
            err.decode("utf-8", "replace"))


# ── Codex ────────────────────────────────────────────────────────────────

def parse_codex(doc) -> list[dict]:
    """The rows of Codex's own picker, in its order.

    `visibility: "list"` marks the models Codex shows; the others are its
    internal ones (review, reserve). `priority` is the picker's order.
    """
    models = doc.get("models") if isinstance(doc, dict) else doc
    found = []
    for model in models if isinstance(models, list) else []:
        if not isinstance(model, dict):
            continue
        if model.get("visibility", "list") != "list":
            continue
        slug = str(model.get("slug") or "").strip()
        if not _ID_OK.match(slug):
            continue
        priority = model.get("priority")
        if isinstance(priority, bool) or not isinstance(priority, (int, float)):
            priority = float("inf")
        found.append((priority, len(found), {
            "id": slug,
            "name": _text(model.get("display_name"), 80) or slug,
            "desc": _text(model.get("description"), 200),
        }))
    found.sort(key=lambda item: (item[0], item[1]))
    rows, seen = [], set()
    for _priority, _order, row in found:
        if row["id"] not in seen:
            seen.add(row["id"])
            rows.append(row)
    return rows


def _codex_home(env) -> Path:
    home = (env or os.environ).get("CODEX_HOME")
    return Path(home).expanduser() if home else Path.home() / ".codex"


def codex_models(argv, *, env=None, cwd=None, timeout=TIMEOUT, run=_run) -> dict:
    error = ""
    try:
        code, out, err = run(list(argv) + ["debug", "models"], None, env, cwd,
                             timeout)
        try:
            rows = parse_codex(json.loads(out))
        except ValueError:
            rows = []
        if rows:
            return {"ok": True, "agent": "codex", "source": "cli",
                    "models": [dict(DEFAULT_ROW["codex"])] + rows,
                    "unavailable": [], "error": ""}
        error = (err or out or f"codex debug models exited {code}").strip()[-300:]
    except subprocess.TimeoutExpired:
        error = "codex did not answer in time"
    except OSError as exc:
        error = f"could not start codex: {exc}"
    # An older Codex has no `debug models`; every Codex that has run a turn
    # keeps the catalogue it last fetched.
    try:
        cache = json.loads((_codex_home(env) / "models_cache.json")
                           .read_text(encoding="utf-8"))
        rows = parse_codex(cache)
    except (OSError, ValueError):
        rows = []
    if rows:
        return {"ok": True, "agent": "codex", "source": "cache",
                "models": [dict(DEFAULT_ROW["codex"])] + rows,
                "unavailable": [], "error": ""}
    return _fail("codex", error or "codex listed no models")


# ── Claude Code ──────────────────────────────────────────────────────────

def parse_claude(response) -> tuple[list[dict], list[dict]]:
    """Claude Code's menu and its update-gated models, from the inner
    `response` of the handshake's control_response."""
    if not isinstance(response, dict):
        return [], []
    def listed(key):
        value = response.get(key)
        return value if isinstance(value, list) else []

    rows, seen = [], set()
    for model in listed("models"):
        if not isinstance(model, dict):
            continue
        value = str(model.get("value") or "").strip()
        if not _ID_OK.match(value):
            continue  # no value, or not a plain model name
        # "default" is Claude Code's word for "no --model flag".
        model_id = "" if value == "default" else value
        if model_id in seen:
            continue
        seen.add(model_id)
        rows.append({"id": model_id,
                     "name": _text(model.get("displayName"), 80) or value,
                     "desc": _text(model.get("description"), 200)})
    # Claude Code can list two models under one display name (a pinned
    # version beside the family row); the id tells them apart.
    names = [row["name"] for row in rows]
    for row in rows:
        if row["id"] and names.count(row["name"]) > 1:
            row["name"] = _text(f"{row['name']} ({row['id']})", 80)
    unavailable = []
    for model in listed("unavailable_models"):
        if not isinstance(model, dict):
            continue
        name = _text(model.get("displayName"), 80)
        if name.endswith(" (disabled)"):
            name = name[: -len(" (disabled)")]
        if name:
            unavailable.append({"name": name,
                                "desc": _text(model.get("description"), 200)})
    return rows, unavailable


def _claude_response(stdout: str):
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            frame = json.loads(line)
        except ValueError:
            continue
        if not isinstance(frame, dict) or frame.get("type") != "control_response":
            continue
        outer = frame.get("response")
        if isinstance(outer, dict) and isinstance(outer.get("response"), dict):
            return outer["response"]
    return None


def claude_models(argv, *, env=None, cwd=None, account_args=(),
                  timeout=TIMEOUT, run=_run) -> dict:
    error = ""
    # --strict-mcp-config: a menu must not start the user's MCP servers. A
    # Claude Code that does not know the flag exits at once, and the bare
    # form is tried.
    for extra in (["--strict-mcp-config"], []):
        try:
            code, out, err = run(list(argv) + _CLAUDE_FLAGS + list(account_args)
                                 + extra, _INIT, env, cwd, timeout)
        except subprocess.TimeoutExpired:
            return _fail("claude", "claude did not answer in time")
        except OSError as exc:
            return _fail("claude", f"could not start claude: {exc}")
        rows, unavailable = parse_claude(_claude_response(out))
        if rows:
            if not any(row["id"] == "" for row in rows):
                rows.insert(0, dict(DEFAULT_ROW["claude"]))
            return {"ok": True, "agent": "claude", "source": "cli",
                    "models": rows, "unavailable": unavailable, "error": ""}
        error = (err or out or f"claude exited {code}").strip()[-300:]
    return _fail("claude", error or "claude listed no models")


# ── Is the CLI itself current? ───────────────────────────────────────────

_VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def _version(text) -> str:
    match = _VERSION.search(str(text or ""))
    return match.group(0) if match else ""


def _newer(latest: str, installed: str) -> bool:
    a, b = _VERSION.search(latest or ""), _VERSION.search(installed or "")
    if not a or not b:
        return False
    return tuple(map(int, a.groups())) > tuple(map(int, b.groups()))


def installed_version(argv, *, env=None, cwd=None, run=_run) -> str:
    """`claude --version` prints "2.1.241 (Claude Code)", `codex --version`
    "codex-cli 0.144.6": the first x.y.z is the version."""
    try:
        _code, out, err = run(list(argv) + ["--version"], None, env, cwd, 8)
    except (subprocess.TimeoutExpired, OSError):
        return ""
    return _version(out) or _version(err)


def _fetch_latest(package: str) -> str:
    """The newest published version: one small GET to the registry the CLIs
    are installed from. It carries nothing about the user."""
    request = urllib.request.Request(
        f"https://registry.npmjs.org/{package}/latest",
        headers={"User-Agent": "lse-terminal", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=4) as response:
        return _version(json.loads(response.read(200_000)).get("version"))


def latest_version(agent: str, *, fetch=None, now=time.time) -> str:
    package = (CLI.get(agent) or {}).get("package")
    if not package:
        return ""
    cached = _latest_cache.get(agent)
    if cached and now() - cached[0] < (_LATEST_TTL_OK if cached[1] else _LATEST_TTL_FAIL):
        return cached[1]
    try:
        version = (fetch or _fetch_latest)(package)
    except Exception:  # offline, blocked, changed: no verdict, never an error
        version = ""
    _latest_cache[agent] = (now(), version)
    return version


def cli_state(agent: str, argv, *, env=None, cwd=None, run=_run, fetch=None) -> dict:
    """The installed CLI's version beside the newest published one."""
    info = CLI.get(agent) or {}
    installed = installed_version(argv, env=env, cwd=cwd, run=run)
    latest = latest_version(agent, fetch=fetch) if installed else ""
    return {"name": info.get("name", agent), "installed": installed,
            "latest": latest, "outdated": _newer(latest, installed),
            "update": info.get("update", "")}


# ── Bringing the CLI up to date ──────────────────────────────────────────

# Each CLI updates itself with its own command, which knows how it was
# installed (npm, the native installer, a standalone package). Both were run
# with their input closed, from old versions: no question asked, a few
# seconds, exit 0.
UPDATE_TIMEOUT = 300.0
_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def update_cli(agent: str, argv, *, env=None, cwd=None, run=_run,
               timeout=UPDATE_TIMEOUT) -> dict:
    """Run `<cli> update` unattended. `changed` says whether the version
    moved; a CLI its updater leaves where it is counts as ok, unchanged."""
    out = {"ok": False, "changed": False, "before": "", "after": "",
           "error": "", "output": ""}
    if agent not in CLI:
        out["error"] = "this provider has no updater"
        return out
    out["before"] = out["after"] = installed_version(argv, env=env, cwd=cwd, run=run)
    try:
        code, stdout, stderr = run(list(argv) + ["update"], None, env, cwd, timeout)
    except subprocess.TimeoutExpired:
        out["error"] = "the update did not finish in time"
        return out
    except OSError as exc:
        out["error"] = f"could not start the update: {exc}"
        return out
    text = _ANSI.sub("", (stdout or "") + "\n" + (stderr or ""))
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    out["output"] = "\n".join(lines)[-600:]
    out["after"] = installed_version(argv, env=env, cwd=cwd, run=run) or out["before"]
    out["changed"] = _newer(out["after"], out["before"])
    if code == 0:
        out["ok"] = True
    else:
        out["error"] = _text(lines[-1] if lines else f"the update exited {code}", 300)
    return out


# ── Entry ────────────────────────────────────────────────────────────────

def list_models(agent: str, argv, *, env=None, cwd=None, account_args=(),
                timeout=TIMEOUT) -> dict:
    """`argv` starts the CLI the way the engine starts it for a turn."""
    try:
        if agent == "codex":
            out = codex_models(argv, env=env, cwd=cwd, timeout=timeout)
        elif agent == "claude":
            out = claude_models(argv, env=env, cwd=cwd,
                                account_args=account_args, timeout=timeout)
        else:
            return _fail(agent, "this provider cannot list its models")
    except Exception as exc:  # a menu never takes the engine down
        out = _fail(agent, f"{type(exc).__name__}: {exc}")
    try:
        out["cli"] = cli_state(agent, argv, env=env, cwd=cwd)
    except Exception:
        out["cli"] = None
    return out
