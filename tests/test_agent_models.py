"""The model menu is asked of the user's own CLI (engine/agent_models.py).

The fixtures in data/agent_models are the model fields of real answers:
Claude Code 2.1.218 (signed in) and 2.1.326, Codex 0.161.0's catalogue for a
signed-in ChatGPT account and 0.169.0's built-in one.
"""

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine import agent_models as am
from lse_terminal.engine.server import create_app

DATA = Path(__file__).parent / "data" / "agent_models"


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """No test asks the real registry which CLI version is newest."""
    def offline(package):
        raise OSError("tests do not use the network")
    monkeypatch.setattr(am, "_fetch_latest", offline)
    am._latest_cache.clear()
    yield
    am._latest_cache.clear()


def _fixture(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def _ids(rows):
    return [row["id"] for row in rows]


# ── what each CLI says, turned into menu rows ────────────────────────────

def test_codex_rows_are_its_picker_rows_in_its_order():
    rows = am.parse_codex(_fixture("codex_0.161.0_account_catalogue.json"))
    assert _ids(rows) == ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra",
                          "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol",
                          "gpt-5.6-terra", "gpt-5.6-luna"]
    # Codex's internal models (visibility "hide") are not offered.
    assert "gpt-reserve" not in _ids(rows) and "codex-auto-review" not in _ids(rows)
    # The words are Codex's own.
    assert rows[0]["name"] == "GPT-6.1 Terra"
    assert rows[0]["desc"].startswith("Efficient model")


def test_codex_built_in_catalogue_parses_the_same_way():
    rows = am.parse_codex(_fixture("codex_0.169.0_bundled_catalogue.json"))
    assert _ids(rows)[0] == "gpt-6.1-sol"          # priority 1
    assert "gpt-daybreak-blue-latest" not in _ids(rows)
    assert len(rows) == 9


def test_codex_rows_refuse_what_is_not_a_plain_model_name():
    doc = {"models": [
        {"slug": "good-1", "display_name": "Good", "visibility": "list", "priority": 2},
        {"slug": "bad & calc.exe", "display_name": "Bad", "visibility": "list", "priority": 1},
        {"slug": "", "display_name": "Empty", "visibility": "list"},
        {"slug": "good-1", "display_name": "Twice", "visibility": "list", "priority": 3},
        "not a model",
        {"slug": "no-priority", "visibility": "list"},
    ]}
    rows = am.parse_codex(doc)
    assert _ids(rows) == ["good-1", "no-priority"]
    assert rows[1]["name"] == "no-priority"         # no display name: the id
    assert am.parse_codex({"models": "nonsense"}) == []
    assert am.parse_codex(None) == []


def test_claude_rows_from_an_older_claude_code():
    inner = _fixture("claude_code_2.1.218_initialize.json")["response"]["response"]
    rows, unavailable = am.parse_claude(inner)
    # "default" is Claude Code's word for no --model flag.
    assert _ids(rows) == ["", "opus[1m]", "claude-fable-5[1m]",
                          "claude-fable-5-2", "sonnet", "haiku"]
    assert rows[0]["name"] == "Default (recommended)"
    # Two models under one display name are told apart by their id.
    assert rows[2]["name"] == "Fable (claude-fable-5[1m])"
    assert rows[3]["name"] == "Fable (claude-fable-5-2)"
    assert rows[4]["name"] == "Sonnet"
    # What this Claude Code cannot run until it is updated, in its own words.
    assert unavailable == [
        {"name": "Fable 5.1", "desc": "Update to 2.1.255+ to use Fable 5.1"},
        {"name": "Opus 5.5", "desc": "Update to 2.1.280+ to use Opus 5.5"},
    ]


def test_claude_rows_from_the_newest_claude_code():
    inner = _fixture("claude_code_2.1.326_initialize.json")["response"]["response"]
    rows, unavailable = am.parse_claude(inner)
    assert _ids(rows) == ["", "opus", "fable", "sonnet", "haiku"]
    assert "Opus 5.5" in rows[1]["desc"]
    assert unavailable == []


def test_claude_rows_survive_a_changed_answer():
    assert am.parse_claude(None) == ([], [])
    assert am.parse_claude({"models": "x", "unavailable_models": 3}) == ([], [])
    rows, _ = am.parse_claude({"models": [
        {"value": "ok-model", "displayName": "OK"},
        {"value": "$(rm -rf ~)", "displayName": "Nope"},
        {"displayName": "No value"},
        42,
    ]})
    assert _ids(rows) == ["ok-model"]


# ── asking the CLI ───────────────────────────────────────────────────────

def _runner(answers, calls):
    """A stand-in for the subprocess: each call takes the next answer."""
    def run(argv, stdin_text, env, cwd, timeout):
        calls.append({"argv": list(argv), "stdin": stdin_text})
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer
    return run


def test_codex_is_asked_for_its_catalogue():
    calls = []
    doc = json.dumps(_fixture("codex_0.161.0_account_catalogue.json"))
    out = am.codex_models(["codex"], run=_runner([(0, doc, "")], calls))
    assert calls[0]["argv"] == ["codex", "debug", "models"]
    assert out["ok"] and out["source"] == "cli"
    assert _ids(out["models"])[:2] == ["", "gpt-6.1-terra"]
    assert out["models"][0]["name"] == "Default (recommended)"


def test_codex_falls_back_to_the_catalogue_it_cached(tmp_path):
    (tmp_path / "models_cache.json").write_text(
        json.dumps(_fixture("codex_0.161.0_account_catalogue.json")))
    env = {"CODEX_HOME": str(tmp_path)}
    # An older Codex without `debug models`:
    out = am.codex_models(["codex"], env=env, run=_runner(
        [(2, "", "error: unrecognized subcommand 'models'")], []))
    assert out["ok"] and out["source"] == "cache"
    assert _ids(out["models"])[1] == "gpt-6.1-terra"
    # One that hangs:
    out = am.codex_models(["codex"], env=env, run=_runner(
        [subprocess.TimeoutExpired("codex", 12)], []))
    assert out["ok"] and out["source"] == "cache"


def test_codex_that_cannot_answer_says_so(tmp_path):
    out = am.codex_models(["codex"], env={"CODEX_HOME": str(tmp_path)},
                          run=_runner([(1, "not json", "boom")], []))
    assert out == {"ok": False, "agent": "codex", "source": "", "models": [],
                   "unavailable": [], "error": "boom"}


def test_claude_is_asked_with_the_handshake_and_no_prompt():
    calls = []
    answer = json.dumps(_fixture("claude_code_2.1.326_initialize.json"))
    out = am.claude_models(["claude"], account_args=["--settings", "{}"],
                           run=_runner([(0, answer + "\n", "")], calls))
    assert out["ok"] and out["source"] == "cli"
    assert _ids(out["models"]) == ["", "opus", "fable", "sonnet", "haiku"]
    argv = calls[0]["argv"]
    assert argv[:2] == ["claude", "-p"]
    assert "--strict-mcp-config" in argv and "--settings" in argv
    sent = json.loads(calls[0]["stdin"])
    assert sent["type"] == "control_request"
    assert sent["request"] == {"subtype": "initialize"}   # nothing else: no prompt


def test_claude_without_the_mcp_flag_is_asked_again_bare():
    calls = []
    answer = json.dumps(_fixture("claude_code_2.1.218_initialize.json"))
    out = am.claude_models(["claude"], run=_runner(
        [(1, "", "error: unknown option '--strict-mcp-config'"),
         (0, "some banner\n" + answer + "\n", "")], calls))
    assert out["ok"] and len(calls) == 2
    assert "--strict-mcp-config" in calls[0]["argv"]
    assert "--strict-mcp-config" not in calls[1]["argv"]
    assert out["unavailable"][1]["name"] == "Opus 5.5"


def test_claude_that_hangs_is_not_asked_twice():
    calls = []
    out = am.claude_models(["claude"], run=_runner(
        [subprocess.TimeoutExpired("claude", 12)], calls))
    assert not out["ok"] and len(calls) == 1
    assert out["error"] == "claude did not answer in time"


def test_claude_without_a_default_row_gets_one():
    answer = json.dumps({"type": "control_response", "response": {
        "subtype": "success", "response": {"models": [
            {"value": "opus", "displayName": "Opus", "description": "x"}]}}})
    out = am.claude_models(["claude"], run=_runner([(0, answer, "")], []))
    assert _ids(out["models"]) == ["", "opus"]


def test_an_unknown_provider_and_a_crash_are_answers_not_errors(monkeypatch):
    assert am.list_models("gemini", ["gemini"])["ok"] is False

    def boom(*args, **kwargs):
        raise RuntimeError("surprise")
    monkeypatch.setattr(am, "codex_models", boom)
    monkeypatch.setattr(am, "cli_state", boom)
    out = am.list_models("codex", ["codex"])
    assert out["ok"] is False and "surprise" in out["error"]
    assert out["cli"] is None                      # the version check failing changes nothing else


# ── is the CLI itself current? ───────────────────────────────────────────

def test_versions_are_read_from_what_each_cli_prints():
    for printed, want in (("2.1.241 (Claude Code)\n", "2.1.241"),
                          ("codex-cli 0.144.6\n", "0.144.6"),
                          ("no version here", "")):
        calls = []
        got = am.installed_version(["cli"], run=_runner([(0, printed, "")], calls))
        assert got == want and calls[0]["argv"] == ["cli", "--version"]
    assert am.installed_version(["cli"], run=_runner([subprocess.TimeoutExpired("cli", 8)], [])) == ""
    assert am.installed_version(["cli"], run=_runner([OSError("gone")], [])) == ""


def test_newer_compares_numbers_not_text():
    assert am._newer("2.1.326", "2.1.241")
    assert am._newer("0.10.2", "0.9.10")           # 10 > 9, though "1" < "9" as text
    assert not am._newer("0.169.0", "0.169.0")
    assert not am._newer("0.144.6", "0.169.0")     # a pre-release ahead of the registry is not "behind"
    assert not am._newer("", "1.0.0") and not am._newer("1.0.0", "") and not am._newer("1.0.0", "junk")


def test_newest_published_version_is_asked_once_and_kept():
    asked = []

    def fetch(package):
        asked.append(package)
        return "0.169.0"
    clock = [1000.0]
    for _ in range(3):
        assert am.latest_version("codex", fetch=fetch, now=lambda: clock[0]) == "0.169.0"
    assert asked == ["@openai/codex"]
    clock[0] += 7 * 3600                           # past six hours: asked again
    am.latest_version("codex", fetch=fetch, now=lambda: clock[0])
    assert asked == ["@openai/codex", "@openai/codex"]
    assert am.latest_version("gemini", fetch=fetch) == ""


def test_an_unreachable_registry_is_no_verdict_and_is_not_retried_at_once():
    asked = []

    def down(package):
        asked.append(package)
        raise OSError("offline")
    clock = [1000.0]
    assert am.latest_version("claude", fetch=down, now=lambda: clock[0]) == ""
    assert am.latest_version("claude", fetch=down, now=lambda: clock[0]) == ""
    assert len(asked) == 1
    clock[0] += 601
    am.latest_version("claude", fetch=down, now=lambda: clock[0])
    assert len(asked) == 2


def test_cli_state_says_when_an_update_is_waiting():
    behind = am.cli_state("codex", ["codex"], run=_runner([(0, "codex-cli 0.144.6", "")], []),
                          fetch=lambda package: "0.169.0")
    assert behind == {"name": "Codex", "installed": "0.144.6", "latest": "0.169.0",
                      "outdated": True, "update": "codex update"}
    am._latest_cache.clear()
    current = am.cli_state("claude", ["claude"], run=_runner([(0, "2.1.326 (Claude Code)", "")], []),
                           fetch=lambda package: "2.1.326")
    assert current["outdated"] is False and current["name"] == "Claude Code"
    am._latest_cache.clear()
    offline = am.cli_state("claude", ["claude"], run=_runner([(0, "2.1.218 (Claude Code)", "")], []))
    assert offline["installed"] == "2.1.218" and offline["latest"] == "" and offline["outdated"] is False


# ── the engine's route, with real processes ──────────────────────────────

posix_only = pytest.mark.skipif(os.name != "posix",
                                reason="the stand-in CLIs are shell scripts")


def _fake_cli(bin_dir, name, body):
    path = bin_dir / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


@pytest.fixture()
def rail(tmp_path, monkeypatch):
    """An engine whose PATH holds stand-in `claude` and `codex` programs
    that answer from the real fixtures and count how often they are run."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    counts = tmp_path / "counts"
    _fake_cli(bin_dir, "codex", f"""
if [ "$1" = "--version" ]; then echo "codex-cli 0.144.6"; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  echo codex >> "{counts}"
  cat "{DATA / 'codex_0.161.0_account_catalogue.json'}"
  exit 0
fi
if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 2
""")
    _fake_cli(bin_dir, "claude", f"""
if [ "$1" = "--version" ]; then echo "2.1.218 (Claude Code)"; exit 0; fi
echo claude >> "{counts}"
read -r line
case "$line" in
  *control_request*initialize*) tr -d '\\n' < "{DATA / 'claude_code_2.1.218_initialize.json'}"; echo ;;
  *) echo "unexpected input" >&2; exit 3 ;;
esac
""")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin")
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("BRUE_CONNECT_HOME", str(tmp_path / "brue-connect"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    # The registry's answer: Codex has moved on, this Claude Code is the newest.
    monkeypatch.setattr(am, "_fetch_latest", lambda package: {
        "@openai/codex": "0.169.0", "@anthropic-ai/claude-code": "2.1.218"}[package])
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    client.runs = lambda: (counts.read_text().split() if counts.exists() else [])
    client.bin_dir = bin_dir
    return client


@posix_only
def test_route_lists_each_providers_own_models(rail):
    codex = rail.get("/api/ai/models", params={"agent": "codex"}).json()
    assert codex["ok"] and codex["agent"] == "codex" and codex["source"] == "cli"
    assert _ids(codex["models"]) == ["", "gpt-6.1-terra", "gpt-6.1-sol",
                                     "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
                                     "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
    assert codex["unavailable"] == [] and codex["fetched_at"] > 0

    claude = rail.get("/api/ai/models", params={"agent": "claude"}).json()
    assert claude["ok"] and claude["source"] == "cli"
    assert _ids(claude["models"]) == ["", "opus[1m]", "claude-fable-5[1m]",
                                      "claude-fable-5-2", "sonnet", "haiku"]
    assert [m["name"] for m in claude["unavailable"]] == ["Fable 5.1", "Opus 5.5"]


@posix_only
def test_route_says_when_the_cli_itself_is_behind(rail):
    codex = rail.get("/api/ai/models", params={"agent": "codex"}).json()
    assert codex["cli"] == {"name": "Codex", "installed": "0.144.6", "latest": "0.169.0",
                            "outdated": True, "update": "codex update",
                            # never chosen, nothing tried, no update running
                            "auto": None, "tried": "", "updating": False}
    claude = rail.get("/api/ai/models", params={"agent": "claude"}).json()
    assert claude["cli"]["installed"] == "2.1.218" and claude["cli"]["outdated"] is False


@posix_only
def test_route_keeps_an_answer_and_asks_again_when_told(rail):
    for _ in range(3):
        assert rail.get("/api/ai/models", params={"agent": "codex"}).json()["ok"]
    assert rail.runs() == ["codex"]                      # asked once, kept
    rail.get("/api/ai/models", params={"agent": "codex", "refresh": 1})
    assert rail.runs() == ["codex", "codex"]


@posix_only
def test_route_forgets_the_list_when_the_account_changes(rail):
    rail.get("/api/ai/models", params={"agent": "claude"})
    assert rail.runs() == ["claude"]
    # Removing a saved key is one of the places the sign-in cache is cleared.
    assert rail.post("/api/ai/key", json={"agent": "claude", "key": "",
                                          "mode": "api-key"}).status_code == 200
    rail.get("/api/ai/models", params={"agent": "claude"})
    assert rail.runs() == ["claude", "claude"]


@posix_only
def test_route_says_when_a_provider_is_not_installed_or_cannot_answer(rail):
    (rail.bin_dir / "claude").unlink()
    out = rail.get("/api/ai/models", params={"agent": "claude"}).json()
    assert out["ok"] is False and out["error"] == "not installed" and out["models"] == []

    _fake_cli(rail.bin_dir, "codex", "echo 'not a catalogue'; exit 0\n")
    out = rail.get("/api/ai/models", params={"agent": "codex"}).json()
    assert out["ok"] is False and out["models"] == []


def test_route_refuses_an_unknown_provider(rail):
    assert rail.get("/api/ai/models", params={"agent": "lse"}).status_code == 404
    assert rail.get("/api/ai/models").status_code == 404


def test_route_is_refused_from_another_origin(rail):
    # It starts a program as the user, so only the terminal's own window may ask.
    r = rail.get("/api/ai/models", params={"agent": "codex"},
                 headers={"Origin": "http://127.0.0.1:9999"})
    assert r.status_code == 403
    r = rail.get("/api/ai/models", params={"agent": "codex"},
                 headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    assert rail.runs() == []


def test_route_is_refused_in_the_hosted_terminal(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    assert hosted.get("/api/ai/models", params={"agent": "codex"}).status_code == 403


# ── bringing the CLI up to date ──────────────────────────────────────────

def test_update_runs_the_clis_own_updater_and_reads_the_version_twice():
    calls = []
    out = am.update_cli("codex", ["codex"], run=_runner([
        (0, "codex-cli 0.144.6", ""),
        (0, "Updating Codex via `npm install -g @openai/codex`...\n\x1b[32mUpdate ran successfully!\x1b[0m\n", ""),
        (0, "codex-cli 0.169.0", "")], calls))
    assert [c["argv"] for c in calls] == [["codex", "--version"], ["codex", "update"], ["codex", "--version"]]
    assert calls[1]["stdin"] is None                # unattended: nothing typed into it
    assert out["ok"] and out["changed"] and out["before"] == "0.144.6" and out["after"] == "0.169.0"
    assert out["error"] == "" and "\x1b" not in out["output"] and "Update ran successfully!" in out["output"]


def test_update_that_changes_nothing_or_fails_says_so():
    same = am.update_cli("claude", ["claude"], run=_runner([
        (0, "2.1.326 (Claude Code)", ""), (0, "Claude Code is up to date", ""),
        (0, "2.1.326 (Claude Code)", "")], []))
    assert same["ok"] and not same["changed"] and same["after"] == "2.1.326"

    failed = am.update_cli("codex", ["codex"], run=_runner([
        (0, "codex-cli 0.144.6", ""), (1, "", "npm error code EPERM\nnpm error operation not permitted"),
        (0, "codex-cli 0.144.6", "")], []))
    assert not failed["ok"] and not failed["changed"] and failed["after"] == "0.144.6"
    assert failed["error"] == "npm error operation not permitted"

    slow = am.update_cli("codex", ["codex"], run=_runner([
        (0, "codex-cli 0.144.6", ""), subprocess.TimeoutExpired("codex", 300)], []))
    assert not slow["ok"] and slow["error"] == "the update did not finish in time" and slow["after"] == "0.144.6"

    assert am.update_cli("gemini", ["gemini"])["error"] == "this provider has no updater"


@pytest.fixture()
def updatable(tmp_path, monkeypatch):
    """An engine whose stand-in `codex` and `claude` keep their version in
    a file and really move it when their `update` command is run."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    versions = {"codex": tmp_path / "codex.version", "claude": tmp_path / "claude.version"}
    versions["codex"].write_text("0.144.6\n")
    versions["claude"].write_text("2.1.241\n")
    broken = tmp_path / "update-is-broken"
    updates = tmp_path / "updates"
    _fake_cli(bin_dir, "codex", f"""
if [ "$1" = "--version" ]; then echo "codex-cli $(cat "{versions['codex']}")"; exit 0; fi
if [ "$1" = "update" ]; then
  echo codex >> "{updates}"
  if [ -f "{broken}" ]; then echo "npm error code EPERM" >&2; exit 1; fi
  echo 0.169.0 > "{versions['codex']}"; echo "Update ran successfully! Please restart Codex."; exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then cat "{DATA / 'codex_0.161.0_account_catalogue.json'}"; exit 0; fi
if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 2
""")
    _fake_cli(bin_dir, "claude", f"""
if [ "$1" = "--version" ]; then echo "$(cat "{versions['claude']}") (Claude Code)"; exit 0; fi
if [ "$1" = "update" ]; then
  echo claude >> "{updates}"
  echo 2.1.326 > "{versions['claude']}"; echo "Successfully updated from 2.1.241 to version 2.1.326"; exit 0
fi
read -r line
tr -d '\\n' < "{DATA / 'claude_code_2.1.326_initialize.json'}"; echo
""")
    _fake_cli(bin_dir, "npm", 'echo "added 2 packages in 4s"; exit 0\n')
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin")
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("BRUE_CONNECT_HOME", str(tmp_path / "brue-connect"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.delenv("LSE_TERMINAL_HOSTED", raising=False)
    monkeypatch.setattr(am, "_fetch_latest", lambda package: {
        "@openai/codex": "0.169.0", "@anthropic-ai/claude-code": "2.1.326"}[package])
    client = TestClient(create_app(), base_url="http://127.0.0.1")
    client.versions = versions
    client.broken = broken
    client.updates = lambda: (updates.read_text().split() if updates.exists() else [])
    client.chosen = lambda: json.loads((tmp_path / "config" / "config.json").read_text()).get("ai_auto_update") \
        if (tmp_path / "config" / "config.json").exists() else None
    client.cli = lambda agent: client.get("/api/ai/models", params={"agent": agent}).json()["cli"]
    return client


@posix_only
def test_nothing_is_updated_before_the_user_has_chosen(updatable):
    assert updatable.cli("codex")["outdated"] is True and updatable.cli("codex")["auto"] is None
    r = updatable.post("/api/ai/update", json={"agent": "codex"})          # the page's own, unasked
    assert r.status_code == 403
    assert updatable.updates() == [] and updatable.versions["codex"].read_text().strip() == "0.144.6"
    assert not updatable.chosen()


@posix_only
def test_the_users_own_update_updates_and_turns_on_keeping_it_current(updatable):
    r = updatable.post("/api/ai/update", json={"agent": "codex", "asked": True}).json()
    assert r["ok"] and r["changed"] and r["before"] == "0.144.6" and r["after"] == "0.169.0"
    assert r["cli"]["outdated"] is False and r["cli"]["auto"] is True and r["cli"]["tried"] == ""
    assert updatable.chosen() == {"codex": True}                          # this CLI only, not Claude's
    after = updatable.cli("codex")                                         # the list was asked again
    assert after["installed"] == "0.169.0" and after["outdated"] is False and after["auto"] is True
    assert updatable.cli("claude")["auto"] is None

    # From then on the page may update it by itself.
    updatable.versions["codex"].write_text("0.150.0\n")
    r = updatable.post("/api/ai/update", json={"agent": "codex"}).json()
    assert r["ok"] and r["before"] == "0.150.0" and r["after"] == "0.169.0"
    assert updatable.updates() == ["codex", "codex"]


@posix_only
def test_a_failed_update_leaves_the_cli_and_is_not_tried_again_by_itself(updatable):
    updatable.broken.write_text("x")
    r = updatable.post("/api/ai/update", json={"agent": "codex", "asked": True}).json()
    assert r["ok"] is False and r["changed"] is False and r["error"] == "npm error code EPERM"
    assert r["after"] == "0.144.6" and updatable.versions["codex"].read_text().strip() == "0.144.6"
    assert not updatable.chosen()                                          # a failed update turns nothing on
    cli = updatable.cli("codex")
    assert cli["outdated"] is True and cli["tried"] == "0.169.0"           # the page will not retry 0.169.0
    assert updatable.get("/api/ai/models", params={"agent": "codex"}).json()["ok"]   # it still lists its models


@posix_only
def test_no_update_while_that_provider_is_answering(updatable):
    updatable.app.state.ai_cli_turns["codex"] = 1
    r = updatable.post("/api/ai/update", json={"agent": "codex", "asked": True})
    assert r.status_code == 409 and updatable.updates() == []
    updatable.app.state.ai_cli_turns["codex"] = 0
    assert updatable.post("/api/ai/update", json={"agent": "codex", "asked": True}).json()["ok"]


@posix_only
def test_the_setting_can_be_turned_on_and_off(updatable):
    assert updatable.post("/api/ai/auto-update", json={"agent": "claude", "enabled": True}).json()["auto"] is True
    assert updatable.cli("claude")["auto"] is True
    r = updatable.post("/api/ai/update", json={"agent": "claude"}).json()   # unasked, now allowed
    assert r["ok"] and r["after"] == "2.1.326"
    assert updatable.post("/api/ai/auto-update", json={"agent": "claude", "enabled": False}).json()["auto"] is False
    updatable.versions["claude"].write_text("2.1.241\n")
    assert updatable.post("/api/ai/update", json={"agent": "claude"}).status_code == 403
    # The user's own update still works, and their "off" is not for the terminal to undo... but an
    # update they ask for is the same choice as the first one: it turns keeping it current back on.
    assert updatable.post("/api/ai/update", json={"agent": "claude", "asked": True}).json()["ok"]
    assert updatable.chosen()["claude"] is True


@posix_only
def test_what_the_install_button_installs_is_kept_current_from_the_start(updatable):
    with updatable.websocket_connect("/api/ai/install?agent=codex",
                                     headers={"host": "127.0.0.1"}) as ws:   # the local-only guard reads Host
        while ws.receive_json()["type"] != "ok":
            pass
    assert updatable.chosen() == {"codex": True}
    assert updatable.post("/api/ai/update", json={"agent": "codex"}).json()["ok"]   # unasked, allowed

    # A user who said no keeps their no through a reinstall.
    updatable.post("/api/ai/auto-update", json={"agent": "codex", "enabled": False})
    with updatable.websocket_connect("/api/ai/install?agent=codex",
                                     headers={"host": "127.0.0.1"}) as ws:   # the local-only guard reads Host
        while ws.receive_json()["type"] != "ok":
            pass
    assert updatable.chosen() == {"codex": False}


def test_update_routes_are_refused_from_elsewhere(updatable, tmp_path, monkeypatch):
    for path, body in (("/api/ai/update", {"agent": "codex", "asked": True}),
                       ("/api/ai/auto-update", {"agent": "codex", "enabled": True})):
        assert updatable.post(path, json=body, headers={"Origin": "http://127.0.0.1:9999"}).status_code == 403
        assert updatable.post(path, json={**body, "agent": "lse"}).status_code == 404
    assert updatable.updates() == [] and not updatable.chosen()
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    assert hosted.post("/api/ai/update", json={"agent": "codex", "asked": True}).status_code == 403
    assert hosted.post("/api/ai/auto-update", json={"agent": "codex", "enabled": True}).status_code == 403
