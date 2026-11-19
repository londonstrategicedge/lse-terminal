"""Add your own broker: linking an adapter from the app, and what it needs.

Linking stores a command that the engine then spawns as the user on every
connect. So the rules pinned here are the ones with a cost when they break:

* nothing is stored unless the adapter answered a handshake, and a failure
  says why in the adapter's own words;
* the link routes are refused to every page but the terminal's own window,
  and to the hosted terminal altogether;
* a stored key is never deleted by a blank box, never returned by any
  route, and never shown in an error;
* real money is never reached unarmed, for a linked broker as for any other.

Every test runs against a throwaway config directory AND a throwaway
brue-connect home, and no test touches the network: the adapters are small
Python files written into the test's own directory.
"""
import json
import os
import shutil
import stat
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine import broker_hub
from lse_terminal.engine.server import create_app

# A complete small broker, written the way a user would write one: it imports
# brueconnect and does NOT touch sys.path, so it only starts when the engine
# made that import resolve. It records how it was spawned (argument list,
# which brueconnect it got, the NAMES of the credentials in its environment)
# in its private state directory, which is how these tests see inside a spawn.
ADAPTER = r'''
import json, os, sys, time
import brueconnect
from brueconnect import Adapter, AdapterError

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("BRUE_BROKER_STATE", "")
# A refusal as long as a real broker's, with what matters last.
LONG_REFUSAL = ("My Own Broker refused this API key on its practice host "
                "(https://api.practice.own.example). A key made on a practice (demo) "
                "login works only on practice, and one made on a live login only on "
                "live: check that it is the key My Own Broker showed for this login "
                "and that it has not been revoked. My Own Broker does not offer this "
                "API to residents of the EU or to clients of its overseas arm.")
if STATE:
    with open(os.path.join(STATE, "spawn.json"), "w") as fh:
        json.dump({"argv": sys.argv[1:], "sdk": brueconnect.__file__,
                   "python": sys.executable,
                   "pythonpath": os.environ.get("PYTHONPATH"),
                   "sdk_env": os.environ.get("BRUE_CONNECT_SDK"),
                   "cred": {k: len(v) for k, v in os.environ.items()
                            if k.startswith("BRUE_CRED_")},
                   "extra": os.environ.get("OWN_SETTING")}, fh)


def spec(symbol, name, cls):
    return {"symbol": symbol, "name": name, "asset_class": cls,
            "base_ccy": "X", "quote_ccy": "USD", "digits": 2,
            "tick_size": 0.01, "lot_step": 1, "min_qty": 1, "max_qty": 1000,
            "contract_size": 1, "margin_rate": 0.1,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


CATALOG = [spec("F", "Ford Motor Co", "equity"),
           spec("FA", "First Aid Corp", "equity"),
           spec("AAAF", "Triple A Fund", "equity"),
           spec("XFX", "Cross Effects", "equity"),
           spec("ZED", "Zeta Fund", "equity"),
           spec("BTC/USD", "Bitcoin", "crypto"),
           spec("HOSTILE", 'Markup <i>probe</i> & "quoted" name', "equity")]
if "--big" in sys.argv:
    n = int(sys.argv[sys.argv.index("--big") + 1])
    CATALOG += [spec("S%05d" % i, "Stock %d" % i, "equity") for i in range(n)]


class Own(Adapter):
    name, version, broker = "own", "0.1", "own test broker"
    mode = "live" if "--live" in sys.argv else "paper"
    credential_form = [
        {"key": "api_key_id", "label": "API key ID", "type": "text"},
        {"key": "api_secret", "label": "API secret", "type": "password"}]

    def __init__(self):
        super().__init__()
        self.positions = {}
        self.n = 0

    def broker_info(self):
        return {"display_name": "My Own Broker", "tagline": "a test venue"}

    def capabilities(self):
        return {"orders": {"market": True, "partial_close": False},
                "data": {"quotes": True, "bars": True, "history": True},
                "flatten_all": True}

    def on_first_call(self):
        secret = os.environ.get("BRUE_CRED_API_SECRET", "")
        if os.path.exists(os.path.join(HERE, "die.flag")):
            # a badly behaved adapter: dies, and prints a key on the way out
            sys.stderr.write("Traceback: boom from the adapter, key=%s\n" % secret)
            sys.stderr.flush()
            os._exit(3)
        if "--need-key" in sys.argv and not secret:
            raise AdapterError("unauthorized", "the API secret is missing")
        if "--long-refusal" in sys.argv:
            raise AdapterError("unauthorized", LONG_REFUSAL)
        if "--huge-refusal" in sys.argv:
            raise AdapterError("unauthorized", "x" * 50000)

    def handle_catalog_list(self, params):
        return {"instruments": CATALOG}

    def handle_account_get(self, params):
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": list(self.positions.values())}

    def handle_order_place(self, params):
        self.n += 1
        oid, pid = "o%d" % self.n, "p%d" % self.n
        self.positions[pid] = {
            "position_id": pid, "client_id": params["client_id"],
            "symbol": params["symbol"], "side": params["side"],
            "qty": params["qty"], "avg_price": 10.0, "sl": None, "tp": None,
            "unrealized_pnl": 0.0, "opened_at": 0}
        self.emit("order.filled", {
            "client_id": params["client_id"], "order_id": oid,
            "position_id": pid, "symbol": params["symbol"],
            "side": params["side"], "qty": params["qty"], "price": 10.0,
            "fees": 0.0, "time": int(time.time() * 1000)})
        return {"order_id": oid, "status": "accepted"}

    def handle_position_close(self, params):
        p = self.positions.pop(params["position_id"], None)
        if p is None:
            raise AdapterError("not_found", "no such position")
        self.emit("position.closed", {
            "position_id": p["position_id"], "client_id": p["client_id"],
            "qty": p["qty"], "price": 10.0, "realized_pnl": 0.0,
            "reason": "manual", "time": int(time.time() * 1000)})
        return {}

    def handle_flatten_all(self, params):
        n = len(self.positions)
        self.positions.clear()
        return {"closed": n}

    def handle_history_fills(self, params):
        return {"fills": []}

    def handle_bars_history(self, params):
        n = min(int(params.get("count") or 10), 50)
        now = int(time.time() * 1000) // 60000 * 60000
        return {"bars": [[now - (n - i) * 60000, 10.0, 11.0, 9.0, 10.5, 100]
                         for i in range(n)]}

    def handle_quotes_subscribe(self, params):
        for s in params.get("symbols", []):
            self.emit("quote", {"symbol": s, "bid": 9.99, "ask": 10.01,
                                "time": int(time.time() * 1000)})
        return {}

    def handle_quotes_unsubscribe(self, params):
        return {}


Own().run()
'''

FORM = [{"key": "api_key_id", "label": "API key ID", "type": "text"},
        {"key": "api_secret", "label": "API secret", "type": "password"}]

# Obviously fake values, used to prove no route ever hands a stored one back.
SECRET = "s3cr3t-value-0002"
KEY_ID = "PKTESTVALUE0001"


# What the fleet directory "returns" in a test: nothing, unless a test sets it.
DIRECTORY = {"d": None}


def write_adapter(folder: Path, name="my_adapter.py", source=ADAPTER) -> str:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(textwrap.dedent(source))
    return str(path)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A sandbox for everything a link writes: the terminal's config, the
    brue-connect registry and every profile's state directory. No directory
    is fetched, so the test never reaches the network."""
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("BRUE_CONNECT_HOME", str(tmp_path / "brue-home"))
    monkeypatch.delenv("LSE_API_KEY", raising=False)
    monkeypatch.delenv("BRUE_CONNECT_PYTHON", raising=False)
    monkeypatch.setattr(broker_hub, "fetch_directory",
                        lambda cache: DIRECTORY["d"])
    monkeypatch.setitem(DIRECTORY, "d", None)
    # Every test here gets a fresh config directory, and a fresh one makes
    # create_app copy the bundled sample datasets into it (about 1.5 s each
    # time). Nothing in this file reads them.
    from lse_terminal.providers import userdata
    monkeypatch.setattr(userdata, "seed_samples", lambda: None)
    return tmp_path


@pytest.fixture()
def client(home):
    c = TestClient(create_app(), base_url="http://127.0.0.1")
    yield c
    c.app.state.broker_hub.shutdown()


@pytest.fixture()
def adapter(home):
    # A directory with a space in it, on purpose: the path travels as one
    # argument of a list and must arrive as one.
    return write_adapter(home / "my adapters")


def hub_of(client):
    return client.app.state.broker_hub


def rows(client):
    return {b["broker"]: b for b in client.get("/api/broker/list").json()}


def registry_file(home):
    path = home / "brue-home" / "brokers.json"
    return json.loads(path.read_text()) if path.exists() else None


def spawn_record(home, name):
    return json.loads(
        (home / "brue-home" / "state" / name / "spawn.json").read_text())


def link(client, name="mine", **body):
    return client.post("/api/broker/link", json={"name": name, **body})


# ── linking a file ─────────────────────────────────────────────────────────

def test_link_a_python_file(client, home, adapter):
    """The whole point: one request turns a .py file into a broker row that
    names itself, says what it runs and asks for its own keys."""
    r = link(client, python_file=adapter, args=["--tick", "two words"],
             description="My desk", env={"OWN_SETTING": "{state}/cfg"})
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["broker"] == "mine" and row["registered"] is True
    assert row["tested"] is True
    assert row["label"] == "My desk"
    # its own name and mode, from the handshake the link ran
    assert row["identity"]["display_name"] == "My Own Broker"
    assert row["identity"]["mode"] == "paper" and row["mode"] == "paper"
    assert row["connected"] is False          # a link opens no session
    # the form comes from the adapter itself (SPEC 3.2), nothing is stored yet
    assert row["credential_form"] == FORM
    assert row["stored_credentials"] == []
    # what will run: this interpreter, the file as ONE argument, its arguments
    assert row["command_preview"] == [sys.executable, adapter, "--tick",
                                      "two words"]
    # stored as a list with the bare interpreter word, so it survives a
    # Python upgrade and a Windows path
    prof = registry_file(home)["brokers"]["mine"]
    assert prof["argv"] == ["python3", adapter, "--tick", "two words"]
    assert prof["env"] == {"OWN_SETTING": "{state}/cfg"}
    assert prof["description"] == "My desk"
    assert rows(client)["mine"]["identity"]["display_name"] == "My Own Broker"
    # the adapter was really spawned with those arguments and that env
    rec = spawn_record(home, "mine")
    assert rec["argv"] == ["--tick", "two words"]
    assert rec["extra"].endswith("/state/mine/cfg")


def test_a_linked_broker_connects_charts_and_trades(client, adapter):
    assert link(client, python_file=adapter).status_code == 200
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is True
    assert r.json()["data_source"] == "broker:mine"
    names = [p["name"] for p in client.get("/api/providers").json()]
    assert "broker:mine" in names
    candles = client.get("/api/candles", params={
        "provider": "broker:mine", "symbol": "BTC/USD", "timeframe": "1m",
        "limit": 20}).json()["candles"]
    assert len(candles) == 20
    # paper: no arming asked or needed
    o = client.post("/api/broker/order", json={
        "broker": "mine", "symbol": "F", "side": "buy", "qty": 1})
    assert o.status_code == 200 and o.json()["status"] == "filled", o.text
    pos = client.get("/api/broker/positions", params={"broker": "mine"}).json()
    assert [p["symbol"] for p in pos] == ["F"]
    assert client.post("/api/broker/close", json={
        "broker": "mine", "position_id": pos[0]["position_id"]}).is_success
    assert client.get("/api/broker/positions",
                      params={"broker": "mine"}).json() == []


def test_a_pasted_path_in_quotes_is_accepted(client, adapter):
    """Windows "Copy as path" hands the user the path wrapped in quotes."""
    r = link(client, python_file=f'"{adapter}"')
    assert r.status_code == 200, r.text
    assert r.json()["command_preview"][1] == adapter


# ── a link that fails stores nothing ───────────────────────────────────────

STOPPED = ("The file stopped before it answered the terminal. "
           "The last lines it printed are below.")
BROKEN = {
    "syntax": ("def broken(:\n", "SyntaxError"),
    "import": ("import a_module_that_does_not_exist_anywhere\n",
               "ModuleNotFoundError"),
    "exits": ("import sys\nsys.stderr.write('my own last words\\n')\n"
              "sys.exit(4)\n", "my own last words"),
    # Not an adapter at all: a script that prints (to stdout, which is the
    # protocol's pipe) and ends. The card showed no line of it, and said
    # "internal: adapter disconnected".
    "prints": ("print('hello from a script that is not an adapter')\n",
               "hello from a script that is not an adapter"),
    "both": ("import sys\nprint('to stdout first')\n"
             "raise SystemExit('and then it fell over')\n",
             "to stdout first\nand then it fell over"),
}


@pytest.mark.parametrize("kind", sorted(BROKEN))
def test_a_broken_adapter_is_not_stored_and_says_why(client, home, kind):
    """"internal: adapter disconnected" told the author nothing, and the
    traceback went to a log file. The answer now says in plain words that
    the file stopped, and carries the last lines it printed: what it wrote
    to stdout that was not the protocol, then the end of its stderr. Nothing
    at all is stored."""
    source, printed = BROKEN[kind]
    path = write_adapter(home / "bad", source=source)
    r = link(client, python_file=path)
    assert r.status_code == 400
    body = r.json()
    assert body["detail"] == STOPPED
    assert printed in body["stderr"]
    assert registry_file(home) is None
    assert "mine" not in rows(client)
    assert not (home / "brue-home" / "state" / "mine").exists()
    assert "mine" not in json.dumps(hub_of(client)._remembered)


def test_a_file_that_prints_nothing_and_ends_is_told_what_an_adapter_does(
        client, home):
    path = write_adapter(home / "bad", source="x = 1\n")
    r = link(client, python_file=path)
    assert r.status_code == 400
    assert r.json()["detail"] == (
        "The file stopped before it answered the terminal. It printed "
        "nothing. An adapter keeps running until the terminal closes it: "
        "check that this is the adapter file.")
    assert r.json()["stderr"] == ""
    assert registry_file(home) is None


def test_with_a_kit_that_keeps_no_stdout_it_does_not_claim_nothing_was_printed(
        client, home, monkeypatch):
    """A Connector from before stray_lines cannot see stdout, so the card
    must not say the file printed nothing."""
    from brueconnect import Connector, ConnectorError

    class OldKit(Connector):
        def __getattribute__(self, name):
            if name == "stray_lines":
                raise AttributeError(name)
            return super().__getattribute__(name)
    monkeypatch.setattr(broker_hub, "_load_connector",
                        lambda _dir: (OldKit, ConnectorError))
    path = write_adapter(home / "bad", source="x = 1\n")
    r = link(client, python_file=path)
    assert r.status_code == 400
    assert r.json()["detail"] == (
        "The file stopped before it answered the terminal. It printed no "
        "error. An adapter keeps running until the terminal closes it: "
        "check that this is the adapter file.")


def test_an_adapter_that_never_answers_is_refused_in_bounded_time(
        client, home, monkeypatch):
    monkeypatch.setattr(broker_hub, "_HELLO_TIMEOUT_S", 1.0)
    path = write_adapter(home / "bad", source="""
        import sys, time
        sys.stderr.write("still thinking\\n"); sys.stderr.flush()
        time.sleep(60)
    """)
    import time
    t0 = time.time()
    r = link(client, python_file=path)
    assert r.status_code == 400
    assert "did not answer within 1 seconds" in r.json()["detail"]
    assert "still thinking" in r.json()["stderr"]
    assert time.time() - t0 < 8
    assert registry_file(home) is None


def test_an_adapter_speaking_another_protocol_is_refused(client, home):
    path = write_adapter(home / "bad", source="""
        import json, sys
        for line in sys.stdin:
            m = json.loads(line)
            sys.stdout.write(json.dumps({"v": 1, "id": m["id"], "type": "res",
                                         "result": {"protocol": 2}}) + "\\n")
            sys.stdout.flush()
    """)
    r = link(client, python_file=path)
    assert r.status_code == 400
    assert "refused the handshake" in r.json()["detail"]
    assert "protocol version mismatch" in r.json()["detail"]
    assert registry_file(home) is None


def test_the_route_cannot_be_told_to_skip_the_test(client, home):
    """`test: false` in a request body does not switch the handshake off;
    only a fixture calling the hub directly can store something unstartable."""
    path = write_adapter(home / "bad", source="def broken(:\n")
    assert link(client, python_file=path, test=False).status_code == 400
    assert registry_file(home) is None
    row = hub_of(client).link("mine", python_file=path, test=False)
    assert row["tested"] is False and row["registered"] is True
    # ...and when it is then connected, the failure is kept for its card
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 400
    failed = rows(client)["mine"]["last_error"]
    assert "adapter disconnected" in failed["message"]
    assert "SyntaxError" in failed["stderr"]


# ── names, paths, arguments, environment ───────────────────────────────────

@pytest.mark.parametrize("name", [
    "", "a", "A1", "Mine", "my broker", "a.b", ".hidden", "..", "../x", "a/b",
    "a\\b", "..\\..\\x", "C:x", "-ab", "_ab", "a" * 33, "ab\n", " ab", None,
    7, ["ab"], {"n": 1}])
def test_a_bad_id_is_refused(client, home, adapter, name):
    r = link(client, name=name, python_file=adapter)
    assert r.status_code == 400
    assert "lower case letters" in r.json()["detail"]
    assert registry_file(home) is None
    assert not (home / "brue-home" / "state").exists()


@pytest.mark.parametrize("name", [
    "paper", "novafx", "lse-sim",      # the engine's own bundled brokers
    "paper-fast", "lse-hosted",        # names the Connections screen hides
    "northgate", "meridian",           # venues whose adapter is bundled
    "listed-venue"])                   # a broker the fleet directory lists
def test_an_id_the_terminal_owns_is_refused(home, adapter, name):
    """A profile under one of these names would be ignored or shadowed by
    the engine's own entry, so it is refused instead of silently unused."""
    DIRECTORY["d"] = {"v": 1, "providers": [], "brokers": [
        {"key": "listed-venue", "label": "Listed Venue"}]}
    c = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        c.get("/api/directory")       # applies the directory to the hub
        r = link(c, name=name, python_file=adapter)
        assert r.status_code == 409, r.text
        assert "already knows" in r.json()["detail"]
        assert registry_file(home) is None
    finally:
        c.app.state.broker_hub.shutdown()


def test_linking_the_same_id_twice_is_refused(client, home, adapter):
    assert link(client, python_file=adapter).status_code == 200
    before = registry_file(home)
    other = write_adapter(home / "other")
    r = link(client, python_file=other, args=["--live"])
    assert r.status_code == 409
    assert "already linked" in r.json()["detail"]
    assert registry_file(home) == before          # the first link is intact


def test_an_id_already_in_the_registry_file_is_refused(client, home, adapter):
    """Also one the engine is not showing: a profile written by the kit's
    command line under a name the engine runs itself is still the user's."""
    from brueconnect import registry
    registry.add("by-cli", argv=["python3", adapter])
    assert link(client, name="by-cli", python_file=adapter).status_code == 409


@pytest.mark.parametrize("path,why", [
    (None, "Give the path"), ("", "Give the path"), (7, "Give the path"),
    ("relative/adapter.py", "full path"),
    ("adapter.py", "full path"),
    ("/no/such/place/adapter.py", "No file at"),
    ("{dir}", "ending in .py"),                    # a directory
    ("{dir}/notes.txt", "ending in .py"),
    ("{file}\nrm -rf", "cannot be used"),
    ("/x" * 2000 + ".py", "cannot be used")])
def test_a_bad_path_is_refused(client, home, adapter, path, why):
    (home / "my adapters" / "notes.txt").write_text("x")
    if isinstance(path, str):
        path = path.replace("{dir}", str(home / "my adapters")).replace(
            "{file}", adapter)
    r = link(client, python_file=path)
    assert r.status_code == 400
    assert why in r.json()["detail"]
    assert registry_file(home) is None


@pytest.mark.parametrize("args", [
    "--paper", {"a": 1}, ["ok", 7], ["ok", None], ["line\nbreak"],
    ["nul\x00"], ["x" * 2049], ["a"] * 31])
def test_bad_arguments_are_refused(client, home, adapter, args):
    r = link(client, python_file=adapter, args=args)
    assert r.status_code == 400 and "rgument" in r.json()["detail"]
    assert registry_file(home) is None


@pytest.mark.parametrize("env,why", [
    (["A=B"], "must be an object"),
    ({"lower": "x"}, "not a usable environment name"),
    ({"1X": "x"}, "not a usable environment name"),
    ({"A B": "x"}, "not a usable environment name"),
    ({"A=B": "x"}, "not a usable environment name"),
    ({"OK": 7}, "not plain text"),
    ({"OK": "two\nlines"}, "not plain text"),
    ({"OK": "x" * 1025}, "not plain text"),
    # the platform's own channel to an adapter is not a profile's to set
    ({"BRUE_BROKER_STATE": "/tmp/elsewhere"}, "set by the terminal"),
    ({"BRUE_CRED_API_SECRET": "x"}, "set by the terminal"),
    ({"BRUE_ACCOUNT_ID": "x"}, "set by the terminal"),
    ({"BRUE_CONNECT_EXAMPLE": "alpaca"}, "set by the terminal"),
    ({"LSE_API_KEY": "x"}, "set by the terminal"),
    ({f"K{i}": "v" for i in range(33)}, "at most 32")])
def test_bad_environment_is_refused(client, home, adapter, env, why):
    r = link(client, python_file=adapter, env=env)
    assert r.status_code == 400, r.text
    assert why in r.json()["detail"]
    assert registry_file(home) is None


@pytest.mark.parametrize("extra", [
    {"command": "rm -rf /"}, {"argv": ["sh", "-c", "id"]},
    {"interpreter": "/bin/sh"}, {"replace": True}])
def test_a_field_the_route_does_not_know_is_refused_not_ignored(
        client, home, adapter, extra):
    r = link(client, python_file=adapter, **extra)
    assert r.status_code == 400 and "unknown field" in r.json()["detail"]
    assert registry_file(home) is None


def test_a_body_that_is_not_a_json_object_is_refused(client):
    for raw in (b"[1, 2]", b'"name"', b"{not json", b"\xff\xfe"):
        r = client.post("/api/broker/link", content=raw,
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400, raw
    big = json.dumps({"name": "mine", "description": "x" * 70000}).encode()
    assert client.post("/api/broker/link", content=big, headers={
        "Content-Type": "application/json"}).status_code == 413


def test_the_description_is_plain_text_and_short(client, home, adapter):
    r = link(client, python_file=adapter,
             description="My\tdesk\n<b>bold</b>\x07" + "x" * 200)
    assert r.status_code == 200
    label = r.json()["label"]
    assert label.startswith("My desk <b>bold</b>") and len(label) == 80
    assert "\n" not in label and "\x07" not in label


# ── examples shipped with the kit ──────────────────────────────────────────

def test_no_example_is_offered_when_the_kit_does_not_ship_its_file(client, home):
    """An example whose file is not in the running kit (an older kit, or a
    build that left the adapter out) is not offered and cannot be linked."""
    hub = hub_of(client)
    # A kit directory that holds no adapters at all, whatever the kit under
    # test ships: the condition is made here, not assumed of the checkout.
    hub.adapter_base = home / "kit-without-examples" / "brueconnect"
    (hub.adapter_base / "adapters").mkdir(parents=True)
    assert not (hub.adapter_base / "adapters" / "alpaca"
                / "alpaca_adapter.py").exists()
    assert client.get("/api/broker/examples").json() == []
    r = link(client, name="my-alpaca", example="alpaca")
    assert r.status_code == 404
    assert "not part of this terminal's kit" in r.json()["detail"]
    assert link(client, name="my-x", example="no-such").status_code == 404
    assert registry_file(home) is None


def stand_in_kit(home, folder="kit"):
    """A package directory holding only the example's file: a stand-in for
    the real adapter, at the path the hub's table names."""
    base = home / folder / "brueconnect"
    write_adapter(base / "adapters" / "alpaca", name="alpaca_adapter.py")
    return base


def test_an_example_is_offered_and_linked_in_one_request(client, home):
    hub = hub_of(client)
    hub.adapter_base = stand_in_kit(home)
    path = str(hub.adapter_base / "adapters" / "alpaca" / "alpaca_adapter.py")
    got = client.get("/api/broker/examples").json()
    assert [(x["key"], x["label"], x["args"]) for x in got] == [
        ("alpaca", "Alpaca (paper trading)", ["--paper"])]
    # what the Connections screen draws before the example is linked
    assert got[0]["name"] == "Alpaca" and got[0]["about"]
    assert got[0]["keys_url"].startswith("https://") and got[0]["keys_help"]
    assert got[0]["form"] == [dict(f) for f in broker_hub.EXAMPLES["alpaca"]["form"]]
    r = link(client, name="my-alpaca", example="alpaca")
    assert r.status_code == 200, r.text
    row = r.json()
    # an ordinary profile of the user's own: registered, unlinkable, its own
    # keys from its own handshake; not a listing of ours
    assert row["registered"] is True and row["example"] == "alpaca"
    assert row["label"] == "Alpaca (paper trading)"
    assert row["credential_form"] == FORM
    assert row["command_preview"] == [sys.executable, path, "--paper"]
    prof = registry_file(home)["brokers"]["my-alpaca"]
    assert prof["argv"] == ["python3", path, "--paper"]
    assert prof["env"] == {"BRUE_CONNECT_EXAMPLE": "alpaca"}
    assert spawn_record(home, "my-alpaca")["argv"] == ["--paper"]
    assert client.post("/api/broker/unlink",
                       json={"name": "my-alpaca"}).status_code == 200


def test_every_example_row_asks_for_what_its_adapter_reads():
    """An example's row is drawn from EXAMPLES before its adapter has ever run,
    so its key boxes are written there; the adapter reads the fields of its
    own credential_form (SPEC 3.2). The two must be the same boxes, or a user
    types a key into a box the adapter never reads."""
    import importlib
    adapter_base = pytest.importorskip("brueconnect.adapter").Adapter
    for key, ex in broker_hub.EXAMPLES.items():
        mod = importlib.import_module(
            "brueconnect." + ".".join(ex["path"])[: -len(".py")])
        forms = [c.credential_form for c in vars(mod).values()
                 if isinstance(c, type) and issubclass(c, adapter_base)
                 and c is not adapter_base and getattr(c, "credential_form", None)]
        assert forms, key
        assert [dict(f) for f in ex["form"]] == [dict(f) for f in forms[0]], key


def test_an_example_is_linked_by_its_key_alone(client, home, adapter):
    hub_of(client).adapter_base = stand_in_kit(home)
    for extra in ({"python_file": adapter}, {"args": ["--live"]},
                  {"env": {"A": "b"}}):
        r = link(client, name="my-alpaca", example="alpaca", **extra)
        assert r.status_code == 400, extra
        assert "by its key alone" in r.json()["detail"]
    assert registry_file(home) is None


def test_an_example_link_survives_the_app_moving(client, home):
    """The stored path names a file inside the app. After a reinstall
    somewhere else the profile still starts, because the file is found again
    by its example key in the kit that is running now."""
    hub = hub_of(client)
    hub.adapter_base = stand_in_kit(home, "kit")
    assert link(client, name="my-alpaca", example="alpaca").status_code == 200
    old = registry_file(home)["brokers"]["my-alpaca"]["argv"][1]
    hub.adapter_base = stand_in_kit(home, "moved to here")
    shutil.rmtree(home / "kit")
    assert not os.path.exists(old)
    new = str(hub.adapter_base / "adapters" / "alpaca" / "alpaca_adapter.py")
    assert rows(client)["my-alpaca"]["command_preview"][1] == new
    r = client.post("/api/broker/connect", json={"broker": "my-alpaca"})
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is True


# ── unlink ─────────────────────────────────────────────────────────────────

def test_unlink_disconnects_first_then_removes(client, home, adapter,
                                               monkeypatch):
    """The order is the rule. Removed first, a session (or a login still
    waiting on the user) could no longer be reached to be closed."""
    from brueconnect import registry
    assert link(client, python_file=adapter).status_code == 200
    assert client.post("/api/broker/connect",
                       json={"broker": "mine"}).is_success
    hub = hub_of(client)
    proc = hub.conns["mine"].proc
    order = []
    real_disconnect, real_remove = hub.disconnect, registry.remove

    def disconnect(name):
        order.append(("disconnect", name, name in registry.load()["brokers"]))
        return real_disconnect(name)

    def remove(name):
        order.append(("remove", name, name in hub.conns))
        return real_remove(name)

    monkeypatch.setattr(hub, "disconnect", disconnect)
    monkeypatch.setattr(registry, "remove", remove)
    r = client.post("/api/broker/unlink", json={"name": "mine"})
    assert r.status_code == 200, r.text
    assert r.json() == {"broker": "mine", "unlinked": True, "removed": True,
                        "forgot": False}
    # disconnected while the profile still existed; removed once nothing ran
    assert order == [("disconnect", "mine", True), ("remove", "mine", False)]
    assert proc.poll() is not None                 # the adapter is gone
    assert "mine" not in rows(client)
    assert registry_file(home)["brokers"] == {}
    assert "broker:mine" not in [p["name"]
                                 for p in client.get("/api/providers").json()]
    assert "mine" not in hub._remembered           # its cached name too


def test_unlink_keeps_the_keys_unless_asked_to_forget(client, home, adapter):
    creds = home / "brue-home" / "state" / "mine" / "platform_credentials.json"
    assert link(client, python_file=adapter).status_code == 200
    client.post("/api/broker/credentials", json={
        "broker": "mine", "values": {"api_key_id": KEY_ID,
                                     "api_secret": SECRET}})
    assert client.post("/api/broker/unlink",
                       json={"name": "mine"}).json()["forgot"] is False
    assert creds.exists()
    # relinking the same ID finds them, and says so by NAME only
    r = link(client, python_file=adapter)
    assert r.json()["stored_credentials"] == ["api_key_id", "api_secret"]
    assert SECRET not in r.text and KEY_ID not in r.text
    r = client.post("/api/broker/unlink", json={"name": "mine", "forget": True})
    assert r.json()["forgot"] is True
    assert not creds.exists()
    assert link(client, python_file=adapter).json()["stored_credentials"] == []


@pytest.mark.parametrize("name", ["paper", "lse-sim", "novafx", "nobody", ""])
def test_only_a_broker_the_user_linked_can_be_unlinked(client, name):
    r = client.post("/api/broker/unlink", json={"name": name})
    assert r.status_code == 404
    assert "not a broker you linked" in r.json()["detail"]
    assert "paper" in rows(client)


def test_a_packaged_profile_is_not_listed_as_linked_by_the_user(
        client, monkeypatch):
    """The kit may ship a built-in profile this engine does not run itself
    (a branch of the kit for one listed broker adds one). It must not appear
    as a row the user linked: they did not, and it could not be unlinked."""
    from brueconnect import registry
    real = registry.load

    def load():
        reg = real()
        reg["brokers"]["shipped-venue"] = {
            "command": "python3 /nowhere/x.py", "env": {},
            "description": "ships with the kit", "builtin": True}
        return reg

    monkeypatch.setattr(registry, "load", load)
    assert "shipped-venue" not in rows(client)
    assert client.post("/api/broker/unlink",
                       json={"name": "shipped-venue"}).status_code == 404


# ── the guard on the three routes ──────────────────────────────────────────

HOST = "127.0.0.1:27790"
GUARDED = [("post", "/api/broker/link", {"name": "zz"}),
           ("post", "/api/broker/unlink", {"name": "zz"}),
           ("get", "/api/broker/examples", None),
           # read-only, but the second names folders on this machine
           ("get", "/api/broker/template", None),
           ("get", "/api/broker/own-guide", None)]


def call(client, method, path, body, headers=None, raw=None):
    headers = {"Host": HOST, **(headers or {})}
    if method == "get":
        return client.get(path, headers=headers)
    if raw is not None:
        return client.post(path, content=raw, headers=headers)
    return client.post(path, json=body, headers=headers)


def reached(response) -> bool:
    """Did the request get past the guard and into the route?"""
    return response.status_code not in (403, 415)


@pytest.mark.parametrize("method,path,body", GUARDED)
@pytest.mark.parametrize("origin,allowed", [
    (None, True),                              # a native client: no Origin
    ("http://127.0.0.1:27790", True),          # the terminal's own window
    ("HTTP://127.0.0.1:27790", True),
    ("http://127.0.0.1:3000", False),          # another program's page
    ("http://127.0.0.1", False),               # same host, no port
    ("http://localhost:27790", False),         # same machine, other name
    ("https://127.0.0.1:27790", False),        # other scheme
    ("http://127.0.0.1:27790/", False),        # not an origin at all
    ("http://127.0.0.1:27790.evil.example", False),
    ("http://evil.example", False),            # refused engine-wide already
    ("null", False),                           # sandboxed frame, file://
    ("", False)])                              # present and empty
def test_only_the_terminals_own_window_reaches_a_link_route(
        client, method, path, body, origin, allowed):
    """These routes decide what program runs on the machine, so the Origin
    must be the engine's own: scheme, host AND port. The engine-wide guard
    lets any loopback origin through; these routes do not."""
    headers = {} if origin is None else {"Origin": origin}
    r = call(client, method, path, body, headers)
    assert reached(r) is allowed, (origin, r.status_code, r.text)
    if not allowed:
        assert r.status_code == 403


@pytest.mark.parametrize("method,path,body", GUARDED)
@pytest.mark.parametrize("site,allowed", [
    ("same-origin", True), ("none", True),
    ("same-site", False), ("cross-site", False), ("anything-else", False)])
def test_a_browser_that_says_the_request_crossed_sites_is_believed(
        client, method, path, body, site, allowed):
    r = call(client, method, path, body, {"Sec-Fetch-Site": site,
                                          "Origin": "http://" + HOST})
    assert reached(r) is allowed, (site, r.status_code)


@pytest.mark.parametrize("path", ["/api/broker/link", "/api/broker/unlink"])
@pytest.mark.parametrize("ctype,allowed", [
    ("application/json", True),
    ("application/json; charset=utf-8", True),
    ("Application/JSON", True),
    (None, False),                 # a typeless body: a "simple" request
    ("text/plain", False),         # what a cross-site form can send
    ("application/x-www-form-urlencoded", False),
    ("multipart/form-data; boundary=x", False),
    ("application/jsonx", False)])
def test_a_link_body_must_be_declared_json(client, path, ctype, allowed):
    """A page cannot send application/json across origins without a
    preflight, so demanding the type means a form post or a typeless blob
    can never be dressed up as one of these requests."""
    headers = {} if ctype is None else {"Content-Type": ctype}
    r = call(client, "post", path, None, headers, raw=b'{"name": "zz"}')
    assert reached(r) is allowed, (ctype, r.status_code, r.text)
    if not allowed:
        assert r.status_code == 415


def test_a_refused_link_request_stores_nothing(client, home, adapter):
    body = json.dumps({"name": "mine", "python_file": adapter}).encode()
    for headers in ({"Origin": "http://127.0.0.1:3000",
                     "Content-Type": "application/json"},
                    {"Content-Type": "text/plain"},
                    {"Sec-Fetch-Site": "cross-site",
                     "Content-Type": "application/json"}):
        r = call(client, "post", "/api/broker/link", None, headers, raw=body)
        assert r.status_code in (403, 415)
    assert registry_file(home) is None
    assert not (home / "brue-home" / "state" / "mine").exists()


# ── the same origin rule on the older routes that move money, keys or code ──
# A page served by some OTHER program on this machine (another local port)
# used to reach all of these: the engine-wide guard compares the Origin's
# hostname and ignores its port. With live arming reachable from the screen,
# that meant such a page could arm a connected live broker and trade it. They
# now ask for the engine's own origin, like the link routes. What must NOT
# change: the terminal's own page (same origin), every native client (no
# Origin at all: the agent CLIs, the approval bridge, the assistant's tools,
# curl), and the hosted terminal's refusal, which still comes first.

OWN_WINDOW = "this action is only available from the terminal's own window"

# Every body here is VALID for its route (so the handler is entered and the
# rule is what answers) and HARMLESS when the rule lets it through: an unknown
# broker, an unknown provider, an empty script. Nothing is spawned or traded.
NOBODY = {"broker": "nobody"}
MONEY_AND_CODE = [
    # the broker routes that change something
    ("/api/broker/connect", NOBODY),
    ("/api/broker/disconnect", NOBODY),
    ("/api/broker/probe", NOBODY),
    ("/api/broker/credentials", {**NOBODY, "values": {"api_secret": "x"}}),
    ("/api/broker/account", {**NOBODY, "account_id": "A1"}),
    ("/api/broker/auth/open", NOBODY),
    ("/api/broker/arm", {**NOBODY, "armed": True}),
    ("/api/broker/subscribe", {**NOBODY, "symbols": ["X"]}),
    ("/api/broker/order", {**NOBODY, "symbol": "X", "side": "buy", "qty": 1}),
    ("/api/broker/order/pending", {**NOBODY, "symbol": "X", "side": "buy",
                                   "qty": 1, "type": "limit", "price": 1.0}),
    ("/api/broker/order/cancel", {**NOBODY, "order_id": "o1"}),
    ("/api/broker/close", {**NOBODY, "position_id": "p1"}),
    ("/api/broker/modify", {**NOBODY, "position_id": "p1", "sl": 1.0}),
    # the routes that run the user's code
    ("/api/backtest", {"provider": "nope", "symbol": "X", "script": "x = 1"}),
    ("/api/backtest/montecarlo", {"provider": "nope", "symbol": "X",
                                  "script": "x = 1"}),
    ("/api/backtest/walkforward", {"provider": "nope", "symbol": "X",
                                   "script": "x = 1"}),
    ("/api/user-indicators/preview", {"source": "x = 1", "provider": "nope",
                                      "symbol": "X"}),
    ("/api/user-indicators/probe.txt", {"source": "x = 1"}),
    ("/api/ml/run-code", {"code": "   "}),
    ("/api/ml/train", {"model_key": "nope", "provider": "userdata",
                       "symbol": "X"}),
    ("/api/algo/start", {"script": "   "}),
    ("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"}),
    ("/api/ai/tool-run", {"token": "no-such-token", "name": "x"}),
]
OLDER = pytest.mark.parametrize("path,body", MONEY_AND_CODE,
                                ids=[p for p, _ in MONEY_AND_CODE])


def refused_as_foreign(r) -> bool:
    """Was this the own-window refusal (and not some other 403: a bad
    tool-run token is a 403 of its own, from inside the route)?"""
    if r.status_code != 403:
        return False
    try:
        return r.json().get("detail") == OWN_WINDOW
    except ValueError:
        return False


@OLDER
def test_the_terminals_own_page_still_reaches_it(client, path, body):
    r = client.post(path, json=body, headers={
        "Host": HOST, "Origin": "http://" + HOST,
        "Sec-Fetch-Site": "same-origin"})
    assert not refused_as_foreign(r), (path, r.status_code, r.text)
    # and it really got in: the route's own answer, not a guard's
    assert r.status_code != 415


@OLDER
def test_a_native_client_with_no_origin_still_reaches_it(client, path, body):
    """The agent CLIs, the approval bridge and the assistant's own tools
    call these over plain HTTP with no Origin header. They must keep
    working exactly as before."""
    r = client.post(path, json=body, headers={"Host": HOST})
    assert not refused_as_foreign(r), (path, r.status_code, r.text)


@OLDER
@pytest.mark.parametrize("origin", [
    "http://127.0.0.1:3000",       # another program's page, another port
    "http://localhost:27790",      # this machine under another name
    "http://127.0.0.1",            # same host, no port
    "https://127.0.0.1:27790"])    # another scheme
def test_a_page_on_another_local_origin_is_refused(client, path, body, origin):
    r = client.post(path, json=body, headers={"Host": HOST, "Origin": origin})
    assert refused_as_foreign(r), (path, origin, r.status_code, r.text)


@OLDER
def test_a_request_the_browser_says_crossed_sites_is_refused(client, path, body):
    for site in ("cross-site", "same-site"):
        r = client.post(path, json=body, headers={
            "Host": HOST, "Origin": "http://" + HOST, "Sec-Fetch-Site": site})
        assert refused_as_foreign(r), (path, site, r.status_code)


@OLDER
def test_the_hosted_terminal_refuses_it_first_as_before(home, monkeypatch,
                                                       path, body):
    """Hosted mode is unchanged: the hosted refusal, whatever the origin.
    (There the public domain is the legitimate origin, so the own-origin rule
    must never be what answers.)"""
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        for headers in ({}, {"Origin": "http://127.0.0.1:3000"},
                        {"Origin": "https://terminal.example"}):
            r = hosted.post(path, json=body, headers=headers)
            assert r.status_code == 403, (path, headers, r.status_code)
            assert "hosted terminal" in r.json()["detail"]
    finally:
        hosted.app.state.broker_hub.shutdown()


def test_a_page_on_another_port_cannot_arm_or_trade_a_live_broker(client, adapter):
    """The case the rule exists for, end to end: a live broker is connected
    and armed by the user; a page from another local port tries every money
    route. Nothing it sends reaches the broker."""
    assert link(client, python_file=adapter, args=["--live"]).status_code == 200
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    foreign = {"Host": HOST, "Origin": "http://127.0.0.1:3000"}
    order = {"broker": "mine", "symbol": "F", "side": "buy", "qty": 1}
    # it cannot arm it
    r = client.post("/api/broker/arm", json={"broker": "mine", "armed": True},
                    headers=foreign)
    assert refused_as_foreign(r)
    assert rows(client)["mine"]["armed"] is False
    # the user arms it, from the terminal's own window
    own = {"Host": HOST, "Origin": "http://" + HOST}
    assert client.post("/api/broker/arm", json={"broker": "mine"},
                       headers=own).json()["armed"] is True
    assert client.post("/api/broker/order", json=order, headers=own).status_code == 200
    pid = client.get("/api/broker/positions",
                     params={"broker": "mine"}).json()[0]["position_id"]
    # armed or not, the other page still cannot trade, close, change keys,
    # disarm, or drop the session
    for path, body in [
            ("/api/broker/order", order),
            ("/api/broker/order/pending", {**order, "type": "limit", "price": 1}),
            ("/api/broker/close", {"broker": "mine", "position_id": pid}),
            ("/api/broker/modify", {"broker": "mine", "position_id": pid, "sl": 1}),
            ("/api/broker/arm", {"broker": "mine", "armed": False}),
            ("/api/broker/credentials", {"broker": "mine", "values": {}}),
            ("/api/broker/disconnect", {"broker": "mine"})]:
        assert refused_as_foreign(client.post(path, json=body, headers=foreign)), path
    row = rows(client)["mine"]
    assert row["connected"] is True and row["armed"] is True
    assert [p["position_id"] for p in client.get(
        "/api/broker/positions", params={"broker": "mine"}).json()] == [pid]


def test_reading_routes_are_as_they_were(client):
    """Only what changes something was tightened. The read-only broker
    routes keep the engine-wide rule, which this pins: a page on another
    local port still gets the list, and a cross-site page is still refused
    engine-wide."""
    other_port = {"Host": HOST, "Origin": "http://127.0.0.1:3000"}
    assert client.get("/api/broker/list", headers=other_port).status_code == 200
    assert client.get("/api/providers", headers=other_port).status_code == 200
    assert client.get("/api/broker/list", headers={
        "Host": HOST, "Origin": "http://evil.example"}).status_code == 403


# The websockets that run a program. Each entry: the path, and a way to be
# let in that spawns nothing (the route's OWN early refusal: a missing file,
# an unknown agent, no packages named). ai/pty and ai/chat have no such
# input, so the test makes their agent binary "not installed" instead.
SOCKETS = [
    ("/api/term/pty?mode=run&path=no_such_file.py", "error"),
    ("/api/ai/install?agent=no-such-agent", "error"),
    ("/api/ai/login?agent=no-such-agent", "error"),
    ("/api/ml/install?packages=", "error"),
    ("/api/ai/pty?agent=claude", "missing"),
    ("/api/ai/chat?agent=claude", "missing"),
]
SOCKET = pytest.mark.parametrize("path,first", SOCKETS,
                                 ids=[p.split("?")[0] for p, _ in SOCKETS])


def first_message(client, path, headers):
    with client.websocket_connect(path, headers=headers) as ws:
        return ws.receive_json()


@SOCKET
@pytest.mark.parametrize("headers", [
    {"host": HOST, "origin": "http://" + HOST},      # the terminal's own page
    {"host": HOST},                                   # a native client
], ids=["own-origin", "no-origin"])
def test_a_code_running_socket_still_opens_for_its_own_callers(
        client, monkeypatch, path, first, headers):
    import shutil
    monkeypatch.setattr(shutil, "which", lambda *a, **k: None)
    msg = first_message(client, path, headers)
    assert msg["type"] == first, msg
    assert msg.get("message") != OWN_WINDOW        # the route answered, not the rule


@SOCKET
@pytest.mark.parametrize("origin", ["http://127.0.0.1:3000",
                                    "http://localhost:27790"])
def test_a_code_running_socket_is_refused_to_another_local_origin(
        client, monkeypatch, path, first, origin):
    """A websocket handshake always carries Origin, so for a browser this is
    exact: a shell, an agent or an installer cannot be opened by a page that
    this engine did not serve."""
    import shutil
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.setattr(shutil, "which", lambda *a, **k: None)
    with client.websocket_connect(path, headers={"host": HOST,
                                                 "origin": origin}) as ws:
        assert ws.receive_json() == {"type": "error", "message": OWN_WINDOW}
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 4403


@SOCKET
def test_a_code_running_socket_in_the_hosted_terminal_is_as_it_was(
        home, monkeypatch, path, first):
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        for headers in ({"host": "127.0.0.1"},
                        {"host": "127.0.0.1", "origin": "https://terminal.example"}):
            msg = first_message(hosted, path, headers)
            assert msg["type"] == "error" and msg["message"] != OWN_WINDOW
            assert "hosted" in msg["message"] or "local app" in msg["message"]
    finally:
        hosted.app.state.broker_hub.shutdown()


def test_the_read_only_stream_socket_is_as_it_was(client):
    """/api/ws only streams prices; it keeps the engine-wide rule."""
    with client.websocket_connect(
            "/api/ws?provider=demo&symbols=DEMO:BTC",
            headers={"host": HOST, "origin": "http://127.0.0.1:3000"}) as ws:
        assert ws.receive_json()["type"] == "tick"


@pytest.mark.parametrize("method,path,body", GUARDED)
def test_the_hosted_terminal_offers_none_of_it(home, monkeypatch, method,
                                               path, body):
    """A shared server must never run a visitor's program. Refused first,
    before the request's type or origin is even looked at."""
    monkeypatch.setenv("LSE_TERMINAL_HOSTED", "1")
    hosted = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        r = (hosted.get(path) if method == "get"
             else hosted.post(path, json=body))
        assert r.status_code == 403
        assert "hosted terminal" in r.json()["detail"]
        if method == "post":
            r = hosted.post(path, content=b"not even json",
                            headers={"Content-Type": "text/plain"})
            assert r.status_code == 403
    finally:
        hosted.app.state.broker_hub.shutdown()


# ── stored keys ────────────────────────────────────────────────────────────

def cred(client, values, **more):
    return client.post("/api/broker/credentials",
                       json={"broker": "mine", "values": values, **more})


def test_a_blank_box_never_deletes_a_stored_key(client, home, adapter):
    """Pressing Connect with a field left empty used to wipe its value. With
    `merge` the engine writes what was typed and keeps the rest."""
    assert link(client, python_file=adapter).status_code == 200
    r = cred(client, {"api_key_id": KEY_ID, "api_secret": SECRET}, merge=True)
    assert r.json() == {"broker": "mine",
                        "stored": ["api_key_id", "api_secret"]}
    # the user reopens the card and connects with both boxes empty
    for blank in ({"api_key_id": "", "api_secret": ""}, {}, {"api_secret": None}):
        r = cred(client, blank, merge=True)
        assert r.json()["stored"] == ["api_key_id", "api_secret"]
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    assert spawn_record(home, "mine")["cred"] == {
        "BRUE_CRED_API_KEY_ID": len(KEY_ID), "BRUE_CRED_API_SECRET": len(SECRET)}
    # typing one field replaces that one and keeps the other
    cred(client, {"api_secret": "a-new-secret", "api_key_id": ""}, merge=True)
    client.post("/api/broker/connect", json={"broker": "mine"})
    assert spawn_record(home, "mine")["cred"] == {
        "BRUE_CRED_API_KEY_ID": len(KEY_ID),
        "BRUE_CRED_API_SECRET": len("a-new-secret")}


def test_forgetting_keys_is_explicit(client, home, adapter):
    assert link(client, python_file=adapter).status_code == 200
    cred(client, {"api_key_id": KEY_ID, "api_secret": SECRET})
    assert rows(client)["mine"]["stored_credentials"] == ["api_key_id",
                                                          "api_secret"]
    # the explicit action: an empty object WITHOUT merge
    assert cred(client, {}).json()["stored"] == []
    assert rows(client)["mine"]["stored_credentials"] == []
    assert not (home / "brue-home" / "state" / "mine"
                / "platform_credentials.json").exists()


def test_saving_nothing_keeps_a_session_and_saving_a_key_ends_it(client, adapter):
    """New keys must take effect, so a session opened with the old ones is
    closed. A form submitted empty changed nothing and closes nothing."""
    assert link(client, python_file=adapter).status_code == 200
    cred(client, {"api_secret": SECRET}, merge=True)
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    cred(client, {"api_secret": ""}, merge=True)
    assert rows(client)["mine"]["connected"] is True
    cred(client, {"api_secret": "another"}, merge=True)
    assert rows(client)["mine"]["connected"] is False


def test_no_route_returns_a_stored_value(client, home, adapter):
    """Names only, everywhere: the list, the link answer, the credentials
    answer, the connect answer, the cache file. And 0600 on disk."""
    assert link(client, python_file=adapter,
                env={"OWN_SETTING": "a-profile-env-value"}).status_code == 200
    seen = [cred(client, {"api_key_id": KEY_ID, "api_secret": SECRET}).text,
            cred(client, {"api_secret": ""}, merge=True).text,
            client.get("/api/broker/list").text,
            client.post("/api/broker/probe", json={"broker": "mine"}).text,
            client.post("/api/broker/connect", json={"broker": "mine"}).text,
            client.get("/api/broker/list").text,
            client.post("/api/broker/disconnect", json={"broker": "mine"}).text,
            (home / "cfg" / "broker_identity.json").read_text()]
    for text in seen:
        assert SECRET not in text and KEY_ID not in text
        # the command preview shows arguments, never the profile's env values
        assert "a-profile-env-value" not in text
    path = home / "brue-home" / "state" / "mine" / "platform_credentials.json"
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700


def test_merge_still_works_with_a_kit_from_before_it(client, home, adapter,
                                                    monkeypatch):
    """A pip install can pair this engine with an older brue-connect whose
    set_credentials has no `merge`. The blank box must not delete there
    either."""
    from brueconnect import registry
    real = registry.set_credentials
    monkeypatch.setattr(registry, "set_credentials",
                        lambda name, values: real(name, values))
    monkeypatch.delattr(registry, "stored_credentials")
    assert link(client, python_file=adapter).status_code == 200
    cred(client, {"api_key_id": KEY_ID, "api_secret": SECRET})
    r = cred(client, {"api_secret": "newer", "api_key_id": ""}, merge=True)
    assert r.json()["stored"] == ["api_key_id", "api_secret"]
    assert registry.credential_env("mine") == {
        "BRUE_CRED_API_KEY_ID": KEY_ID, "BRUE_CRED_API_SECRET": "newer"}
    assert rows(client)["mine"]["stored_credentials"] == ["api_key_id",
                                                          "api_secret"]


# ── what a failed connect leaves on the card ───────────────────────────────

def test_a_failed_connect_is_remembered_with_the_adapters_own_words(
        client, home, adapter):
    assert link(client, python_file=adapter, args=["--need-key"]).status_code == 200
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 400
    assert r.json()["detail"] == "unauthorized: the API secret is missing"
    row = rows(client)["mine"]
    assert row["connected"] is False
    assert row["last_error"]["message"] == "unauthorized: the API secret is missing"
    # typing the key clears it, and the next connect works
    cred(client, {"api_secret": SECRET}, merge=True)
    assert "last_error" not in rows(client)["mine"]
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    assert "last_error" not in rows(client)["mine"]


def _adapter_text(name):
    """A string the test adapter defines, as the adapter has it."""
    src = textwrap.dedent(ADAPTER)
    start = src.index(name + " = (")
    ns = {}
    exec(src[start:src.index(")\n", start) + 1], ns)  # noqa: S102 - our own text
    return ns[name]


def test_a_long_refusal_reaches_the_card_whole(client, home, adapter):
    """A broker's refusal can run long and say last what matters most: who
    may not use its API. The connect's answer, which the card that pressed
    Connect shows, and the engine's record of the failure, which the card
    is redrawn from, keep it whole. Both were cut at 300 characters, in the
    middle of that sentence. A refusal that is not a sentence but a dump is
    still bounded."""
    words = _adapter_text("LONG_REFUSAL")
    assert len("unauthorized: " + words) > 300 and words.endswith("its overseas arm.")
    assert link(client, python_file=adapter, args=["--long-refusal"]).status_code == 200
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 400
    assert r.json()["detail"] == "unauthorized: " + words
    assert rows(client)["mine"]["last_error"]["message"] == "unauthorized: " + words
    assert link(client, "huge", python_file=adapter, args=["--huge-refusal"]).status_code == 200
    r = client.post("/api/broker/connect", json={"broker": "huge"})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail.startswith("unauthorized: xxx") and len(detail) == broker_hub.WORDS_CHARS
    assert rows(client)["huge"]["last_error"]["message"] == detail


def test_a_changed_key_form_reaches_the_card_even_when_its_connect_fails(
        client, home, adapter):
    """An author changes the key boxes in the file (most
    brokers want other boxes than the starter's), saves, then Disconnects
    and Connects as the guide says. The adapter refuses that connect for
    the NEW boxes being empty, and the card used to keep drawing the OLD
    ones, which the file no longer reads: it could never connect again.
    What the handshake declared is kept at the handshake now, so the card
    draws the new boxes, its own name with them, and the next connect
    with them typed in works."""
    assert link(client, python_file=adapter).status_code == 200
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    assert client.post("/api/broker/disconnect", json={"broker": "mine"}).is_success
    src = Path(adapter).read_text()
    new = (src.replace(
        '{"key": "api_secret", "label": "API secret", "type": "password"}]',
        '{"key": "username", "label": "Username", "type": "text"},\n'
        '        {"key": "password", "label": "Password", "type": "password"}]')
        .replace('if "--need-key" in sys.argv and not secret:',
                 'if not os.environ.get("BRUE_CRED_PASSWORD"):')
        .replace('"the API secret is missing"', '"the Password box is empty"')
        .replace('"display_name": "My Own Broker"', '"display_name": "Acme"'))
    assert new.count("BRUE_CRED_PASSWORD") == 1 and "Acme" in new
    Path(adapter).write_text(new)
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 400
    assert r.json()["detail"] == "unauthorized: the Password box is empty"
    row = rows(client)["mine"]
    assert row["connected"] is False
    assert [f["key"] for f in row["credential_form"]] == [
        "api_key_id", "username", "password"]
    assert row["identity"]["display_name"] == "Acme"
    # ...and it is what a restarted engine draws too (the cache on disk)
    again = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        assert [f["key"] for f in rows(again)["mine"]["credential_form"]] == [
            "api_key_id", "username", "password"]
    finally:
        again.app.state.broker_hub.shutdown()
    cred(client, {"username": "me", "password": "pw-0001"}, merge=True)
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is True


def test_an_adapter_that_prints_a_key_does_not_get_it_onto_the_screen(
        client, home, adapter):
    """The stderr tail is shown to help the author. A stored credential
    value inside it is taken out first."""
    assert link(client, python_file=adapter).status_code == 200
    cred(client, {"api_secret": SECRET}, merge=True)
    flag = Path(adapter).parent / "die.flag"
    flag.write_text("")
    r = client.post("/api/broker/connect", json={"broker": "mine"})
    assert r.status_code == 400 and "adapter disconnected" in r.json()["detail"]
    listing = client.get("/api/broker/list").text
    failed = rows(client)["mine"]["last_error"]
    assert "boom from the adapter, key=[hidden]" in failed["stderr"]
    assert SECRET not in listing
    flag.unlink()
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    assert "last_error" not in rows(client)["mine"]
    # what its runs printed stays on its card (`printed`), and the key stays
    # out of it after the keys are forgotten, when nothing would find it
    assert "boom from the adapter, key=[hidden]" in rows(client)["mine"]["printed"]
    client.post("/api/broker/disconnect", json={"broker": "mine"})
    assert client.post("/api/broker/credentials", json={"broker": "mine", "values": {}}).is_success
    assert SECRET not in client.get("/api/broker/list").text


# ── the rows a card is drawn from ──────────────────────────────────────────

def test_the_form_is_remembered_so_it_can_be_drawn_before_any_spawn(
        home, adapter):
    """A platform must not handshake a broker to redraw a list (SPEC 3.1),
    so the form the link learned is kept with the broker's name."""
    first = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        assert link(first, python_file=adapter).status_code == 200
    finally:
        first.app.state.broker_hub.shutdown()
    record = home / "brue-home" / "state" / "mine" / "spawn.json"
    record.unlink()
    again = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        row = rows(again)["mine"]
        assert row["credential_form"] == FORM
        assert row["identity"]["display_name"] == "My Own Broker"
        assert not record.exists(), "listing a broker must not run it"
    finally:
        again.app.state.broker_hub.shutdown()


def test_a_tampered_cache_cannot_put_a_hostile_form_on_screen(home, adapter):
    first = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        assert link(first, python_file=adapter).status_code == 200
    finally:
        first.app.state.broker_hub.shutdown()
    cache = home / "cfg" / "broker_identity.json"
    d = json.loads(cache.read_text())
    d["brokers"]["mine"]["credential_form"] = [
        {"key": "ok_key", "label": "L" * 500, "type": "text", "value": "x"},
        {"key": "../../etc/passwd", "label": "path", "type": "text"},
        {"key": "sel", "label": "s", "type": "select"}, "junk"]
    cache.write_text(json.dumps(d))
    again = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        assert rows(again)["mine"]["credential_form"] == [
            {"key": "ok_key", "label": "L" * 40, "type": "text"}]
    finally:
        again.app.state.broker_hub.shutdown()


def test_a_listed_brokers_form_comes_from_its_directory_row(home):
    """Where the fleet directory knows a broker's fields, the listing wins;
    the engine relays it in the hub row so the page has one place to read."""
    DIRECTORY["d"] = {"v": 1, "providers": [], "brokers": [
        {"key": "paper", "label": "Paper Listed", "credential_form": [
            {"key": "token", "label": "Token", "type": "password",
             "help": "from your dashboard"}, "junk", {"label": "no key"}]},
        {"key": "novafx", "label": "Nova"}]}
    c = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        c.get("/api/directory")
        r = rows(c)
        assert r["paper"]["credential_form"] == [
            {"key": "token", "label": "Token", "type": "password",
             "help": "from your dashboard"}]
        # a row with no form of its own: nothing to type, until a handshake
        # says otherwise
        assert r["novafx"]["credential_form"] == []
        assert "command_preview" not in r["paper"]     # ours, not linked
        assert r["paper"]["stored_credentials"] == []
    finally:
        c.app.state.broker_hub.shutdown()


# ── which Python, and where brueconnect is found ───────────────────────────

def test_a_bare_python_word_becomes_the_engines_choice():
    py = broker_hub.adapter_python()
    for word in ("python", "python3", "PYTHON3", "python.exe", "Python3.exe"):
        assert broker_hub.resolve_interpreter([word, "/a b/x.py", "--p"]) == [
            py, "/a b/x.py", "--p"]
    # a path the user wrote is their own environment and is left alone
    for own in ("/usr/bin/python3", "./python3", r"C:\Py312\python.exe",
                "/opt/venv/bin/python", "node", "python3.12"):
        argv = [own, "/x.py"]
        assert broker_hub.resolve_interpreter(argv) == argv
    assert broker_hub.resolve_interpreter([]) == []


def test_the_clean_sdk_directory_is_found_only_when_it_is_one(tmp_path):
    base = tmp_path / "_internal" / "brueconnect"
    base.mkdir(parents=True)
    assert broker_hub.sdk_dir(base) is None
    (tmp_path / "_internal" / "brue-sdk").mkdir()
    assert broker_hub.sdk_dir(base) is None            # empty: not an SDK
    pkg = tmp_path / "_internal" / "brue-sdk" / "brueconnect"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    assert broker_hub.sdk_dir(base) == tmp_path / "_internal" / "brue-sdk"
    assert broker_hub.sdk_dir(None) is None


def test_which_import_path_each_kind_of_adapter_is_given(home):
    hub = broker_hub.BrokerHub(broker_hub.connect_base(None))
    parent = str(hub.base.parent)
    foreign = "/somewhere/else/bin/python3"
    assert hub.sdk is None, "a checkout has no clean directory"

    def env_for(interpreter, own, start=None):
        env = dict(start or {})
        hub._sdk_env(env, interpreter, own)
        return env

    # no clean directory (a checkout, a pip install):
    #   a bundled adapter gets the package's parent, as it always did
    assert env_for(foreign, own=False)["PYTHONPATH"] == parent
    #   the user's adapter under THIS interpreter gets it too
    assert env_for(sys.executable, own=True)["PYTHONPATH"] == parent
    #   under an interpreter of their own choosing it is NOT handed ours...
    env = env_for(foreign, own=True, start={"PYTHONPATH": "/their/own"})
    assert env["PYTHONPATH"] == "/their/own"
    assert "PYTHONPATH" not in env_for(foreign, own=True)
    #   ...but is always told where the SDK is, to opt in
    assert env["BRUE_CONNECT_SDK"] == parent
    # an existing PYTHONPATH is kept behind ours, never dropped
    assert env_for(sys.executable, own=True, start={"PYTHONPATH": "/keep"})[
        "PYTHONPATH"] == parent + os.pathsep + "/keep"

    # with a clean directory (the desktop build): that, for every adapter
    hub.sdk = Path("/app/_internal/brue-sdk")
    for interpreter, own in ((foreign, True), (foreign, False),
                             (sys.executable, True)):
        env = env_for(interpreter, own)
        assert env["PYTHONPATH"] == "/app/_internal/brue-sdk"
        assert env["BRUE_CONNECT_SDK"] == "/app/_internal/brue-sdk"
    hub.shutdown()


def test_an_adapter_anywhere_on_disk_can_import_brueconnect(
        client, home, adapter, monkeypatch):
    """The defect that made every user adapter die on its first line in the
    desktop app: a registered profile was spawned with no import path. The
    engine's own environment here has none, as the desktop engine's has."""
    monkeypatch.delenv("PYTHONPATH", raising=False)
    hub = hub_of(client)
    assert link(client, python_file=adapter).status_code == 200
    rec = spawn_record(home, "mine")
    assert rec["python"] == sys.executable
    assert rec["pythonpath"].split(os.pathsep)[0] == str(hub.base.parent)
    assert rec["sdk_env"] == str(hub.base.parent)
    assert Path(rec["sdk"]).parent == hub.base
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success


def test_with_a_clean_sdk_directory_every_adapter_runs_from_it(
        home, adapter, monkeypatch):
    """The desktop layout: brue-sdk/ beside the package. Bundled adapters are
    spawned FROM the clean copy (each puts its own grandparent directory on
    sys.path, and that must not be the app's _internal), and a linked one
    imports brueconnect from it."""
    monkeypatch.delenv("PYTHONPATH", raising=False)
    real = broker_hub.connect_base(None)
    clean = home / "_internal" / "brue-sdk"
    clean.mkdir(parents=True)
    try:
        os.symlink(real, clean / "brueconnect", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks here")
    monkeypatch.setattr(broker_hub, "sdk_dir", lambda base: clean)
    hub = broker_hub.BrokerHub(real)
    try:
        assert hub.sdk == clean and hub.adapter_base == clean / "brueconnect"
        cmd = hub.registry["paper"]["cmd"]
        assert cmd[1] == str(clean / "brueconnect" / "adapters" / "paper"
                             / "paper_adapter.py")
        assert hub.connect("paper")["connected"] is True
        hub.link("mine", python_file=adapter)
        rec = spawn_record(home, "mine")
        assert rec["pythonpath"] == str(clean)
        assert rec["sdk"] == str(clean / "brueconnect" / "__init__.py")
    finally:
        hub.shutdown()


def test_a_frozen_engine_with_no_python_runs_adapters_through_itself(
        home, adapter, monkeypatch):
    """Dev-mode emulation of the frozen fallback. On a machine with no Python
    3.10+ the desktop engine cannot borrow an interpreter, so adapters are
    run by the engine's own (`lset-server --run-script file.py`) instead of
    by a spawn that can only fail. Here `python -m lse_terminal.cli` stands
    in for the frozen binary; a real frozen build is NOT exercised by this.
    """
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(broker_hub, "_borrowed_python",
                        lambda: (None, "python3"))
    reentry = [sys.executable, "-m", "lse_terminal.cli"]
    monkeypatch.setattr(broker_hub, "_engine_reentry", lambda: list(reentry))
    broker_hub.adapter_python.cache_clear()
    try:
        assert broker_hub.python_available() is False
        assert broker_hub.python_argv("/a/x.py", ["--n", "1"]) == [
            *reentry, "--run-script", "/a/x.py", "--n", "1"]
        assert broker_hub.resolve_interpreter(["python3", "/a/x.py", "-v"]) == [
            *reentry, "--run-script", "/a/x.py", "-v"]
        # `python3 -m pkg` has no file to hand over; left for the spawn to fail
        assert broker_hub.resolve_interpreter(["python3", "-m", "pkg"])[0] == "python3"
        hub = broker_hub.BrokerHub(broker_hub.connect_base(None))
        try:
            # a bundled adapter
            assert hub.registry["paper"]["cmd"][:4] == [*reentry, "--run-script"]
            assert hub.connect("paper")["connected"] is True
            hub.order("paper", "EURUSD", "buy", 0.01)
            # and the user's own, linked and tested through the same re-entry
            row = hub.link("mine", python_file=adapter, args=["--tick", "1"])
            assert row["identity"]["display_name"] == "My Own Broker"
            assert row["command_preview"] == [*reentry, "--run-script",
                                              adapter, "--tick", "1"]
            assert spawn_record(home, "mine")["argv"] == ["--tick", "1"]
            assert hub.connect("mine")["connected"] is True
        finally:
            hub.shutdown()
    finally:
        monkeypatch.undo()
        broker_hub.adapter_python.cache_clear()
    assert broker_hub.adapter_python() == sys.executable


def test_a_frozen_engine_with_a_python_borrows_it(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(broker_hub, "_borrowed_python",
                        lambda: ("/found/python3", "/found/python3"))
    broker_hub.adapter_python.cache_clear()
    try:
        assert broker_hub.python_available() is True
        assert broker_hub.python_argv("/a/x.py") == ["/found/python3", "/a/x.py"]
        assert broker_hub.resolve_interpreter(["python", "/a/x.py"]) == [
            "/found/python3", "/a/x.py"]
    finally:
        monkeypatch.undo()
        broker_hub.adapter_python.cache_clear()


# ── real money ─────────────────────────────────────────────────────────────

def test_a_linked_live_broker_takes_no_order_until_it_is_armed(client, adapter):
    """SPEC section 3, for a broker the user linked themselves: its handshake
    says `live`, so the engine refuses every mutating call until the user's
    decision has been carried to it, and a reconnect is a new decision."""
    r = link(client, python_file=adapter, args=["--live"])
    assert r.status_code == 200
    # known to be real money from the link's handshake, before any connect
    assert r.json()["mode"] == "live" and r.json()["identity"]["mode"] == "live"
    row = client.post("/api/broker/connect", json={"broker": "mine"}).json()
    assert row["connected"] is True and row["mode"] == "live"
    assert row["armed"] is False                   # connecting arms nothing
    order = {"broker": "mine", "symbol": "F", "side": "buy", "qty": 1}
    refused = client.post("/api/broker/order", json=order)
    assert refused.status_code == 403
    assert "has not been armed" in refused.json()["detail"]
    assert client.get("/api/broker/positions",
                      params={"broker": "mine"}).json() == []
    # reading the account is not trading it
    assert client.get("/api/broker/account",
                      params={"broker": "mine"}).status_code == 200
    armed = client.post("/api/broker/arm", json={"broker": "mine",
                                                 "armed": True})
    assert armed.json()["armed"] is True
    assert rows(client)["mine"]["armed"] is True
    placed = client.post("/api/broker/order", json=order)
    assert placed.status_code == 200 and placed.json()["status"] == "filled"
    pid = client.get("/api/broker/positions",
                     params={"broker": "mine"}).json()[0]["position_id"]
    # the decision dies with the connection
    client.post("/api/broker/disconnect", json={"broker": "mine"})
    client.post("/api/broker/connect", json={"broker": "mine"})
    assert rows(client)["mine"]["armed"] is False
    assert client.post("/api/broker/order", json=order).status_code == 403
    assert client.post("/api/broker/close", json={
        "broker": "mine", "position_id": pid}).status_code == 403


def test_arming_needs_a_connection_and_a_known_broker(client, adapter):
    assert link(client, python_file=adapter, args=["--live"]).status_code == 200
    assert client.post("/api/broker/arm",
                       json={"broker": "mine"}).status_code == 409
    assert client.post("/api/broker/arm",
                       json={"broker": "nobody"}).status_code == 404


# ── a big catalog, honestly ────────────────────────────────────────────────

def test_search_puts_the_exact_symbol_first(client, adapter):
    """A venue with thousands of instruments has hundreds whose symbol merely
    contains "F". The one called F must not be cut off behind them."""
    assert link(client, python_file=adapter).status_code == 200
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success

    def search(q, limit=30):
        return [i["symbol"] for i in client.get("/api/instruments", params={
            "provider": "broker:mine", "query": q, "limit": limit}).json()]

    # exact, then symbols that start with it, then contain it, then by name
    assert search("f") == ["F", "FA", "AAAF", "XFX", "ZED"]
    assert search("F", limit=1) == ["F"]
    assert search("fa") == ["FA"]
    assert search("ford") == ["F"]                 # found by its name
    assert search("btc/") == ["BTC/USD"]
    assert search("no-such-thing") == []
    # with no query the sidebar's grouped order is unchanged
    full = client.get("/api/instruments", params={
        "provider": "broker:mine", "query": "", "limit": 5000}).json()
    assert [i["category"] for i in full] == ["Crypto"] + ["Equities"] * 6
    assert [i["symbol"] for i in full][1:] == sorted(
        ["F", "FA", "AAAF", "XFX", "ZED", "HOSTILE"])


def test_a_cut_catalog_says_how_much_it_left_out(client, adapter):
    assert link(client, python_file=adapter, args=["--big", "6000"]).status_code == 200
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    r = client.get("/api/instruments", params={
        "provider": "broker:mine", "query": "", "limit": 5000})
    assert len(r.json()) == 5000                   # the sidebar's bound
    assert r.headers["X-Total-Count"] == "6007"    # what the venue holds
    # a source that cannot count sends no header, and the body is unchanged
    demo = client.get("/api/instruments", params={"provider": "demo",
                                                  "query": "btc"})
    assert "X-Total-Count" not in demo.headers
    assert demo.json()[0]["symbol"] == "DEMO:BTC"


# ── what the page prints from: digits, a short page, a failed page ─────────

def test_a_broker_row_says_how_many_decimals_its_price_has(client, home):
    """The page prints a venue's prices from the decimals the venue declares
    (SPEC InstrumentSpec.digits). A row says so only when the declared value
    is a count of decimals; rows of sources that declare none are unchanged."""
    source = ADAPTER.replace(
        'spec("BTC/USD", "Bitcoin", "crypto"),',
        'dict(spec("BTC/USD", "Bitcoin", "crypto"), digits=9),'
    ).replace(
        'spec("ZED", "Zeta Fund", "equity"),',
        'dict(spec("ZED", "Zeta Fund", "equity"), digits="2"),'
    ).replace(
        'spec("XFX", "Cross Effects", "equity"),',
        'dict(spec("XFX", "Cross Effects", "equity"), digits=2.5),'
    ).replace(
        'spec("AAAF", "Triple A Fund", "equity"),',
        'dict(spec("AAAF", "Triple A Fund", "equity"), digits=True),'
    ).replace(
        'spec("FA", "First Aid Corp", "equity"),',
        'dict(spec("FA", "First Aid Corp", "equity"), digits=-1),'
    ).replace(
        'spec("F", "Ford Motor Co", "equity"),',
        'dict(spec("F", "Ford Motor Co", "equity"), digits=4.0),')
    assert source.count("digits=") == 6
    path = write_adapter(home / "my adapters", source=source)
    assert link(client, python_file=path).status_code == 200
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success
    full = {i["symbol"]: i for i in client.get("/api/instruments", params={
        "provider": "broker:mine", "query": "", "limit": 5000}).json()}
    assert full["BTC/USD"] == {"symbol": "BTC/USD", "name": "Bitcoin",
                               "category": "Crypto", "live": True, "digits": 9}
    # JSON has one kind of number: a venue that writes 4.0 means four
    assert full["F"]["digits"] == 4 and isinstance(full["F"]["digits"], int)
    assert full["HOSTILE"]["digits"] == 2
    # text, a fraction, a flag, a negative: not a count of decimals, so the
    # row says nothing and the page keeps its own rule for that instrument
    for symbol in ("ZED", "XFX", "AAAF", "FA"):
        assert set(full[symbol]) == {"symbol", "name", "category", "live"}
    # a search answer carries them the same way
    found = client.get("/api/instruments", params={
        "provider": "broker:mine", "query": "btc", "limit": 30}).json()
    assert found[0]["symbol"] == "BTC/USD" and found[0]["digits"] == 9
    # the ticket's own catalog still holds the venue's rows as it sent them
    catalog = {r["symbol"]: r for r in client.get(
        "/api/broker/catalog", params={"broker": "mine"}).json()}
    assert catalog["BTC/USD"]["digits"] == 9
    # a source that declares no digits keeps the four keys every client reads
    demo = client.get("/api/instruments", params={"provider": "demo",
                                                  "query": "btc"}).json()
    assert set(demo[0]) == {"symbol", "name", "category", "live"}


@pytest.mark.parametrize("raw,expected", [
    (9, 9), (0, 0), (20, 20), (2.0, 2),
    (21, None), (-1, None), (2.5, None), ("2", None), (None, None),
    (True, None), (False, None), (float("nan"), None), (float("inf"), None),
    ([2], None)])
def test_only_a_count_of_decimals_is_believed(raw, expected):
    assert broker_hub._price_digits(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    (0.00001, 5), (0.001, 3), (0.01, 2), (0.25, 2), (0.1, 1), (0.5, 1), (1, 0),
    (5.0, 0), (1e-9, 9), (0.0000000001, 10),
    (0, None), (-0.01, None), (1e-13, None), (True, None), ("0.01", None),
    (float("nan"), None), (float("inf"), None), (None, None)])
def test_a_tick_size_gives_its_decimals(raw, expected):
    assert broker_hub._tick_digits(raw) == expected


def test_an_instrument_that_declares_no_digits_prints_to_its_tick_size():
    """A venue's row that leaves its digits out still states its tick size, and
    a price on that grid has the tick's decimals: the chart and the sidebar
    print it so. A row that declares digits keeps them, and one whose digits
    are not a count of decimals still says nothing (the page's own rule)."""
    from types import SimpleNamespace
    hub = SimpleNamespace(conns={"v": object()}, catalog=lambda b: [
        {"symbol": "TICK", "tick_size": 0.0001},
        {"symbol": "BOTH", "digits": 2, "tick_size": 0.0001},
        {"symbol": "BAD", "digits": 2.5, "tick_size": 0.0001},
        {"symbol": "NONE"}])
    got = {i.symbol: i.meta.get("digits")
           for i in broker_hub.BrokerProvider(hub, "v").search("", 10)}
    assert got == {"TICK": 4, "BOTH": 2, "BAD": None, "NONE": None}


def test_the_instruments_route_itself_believes_only_a_count_of_decimals():
    """The route serves every source, including ones a user configured, so it
    checks what a source put in an instrument's meta instead of trusting it.
    The route is run on its own, the way tests/test_current_catalog.py does."""
    import ast
    from types import SimpleNamespace
    from fastapi import HTTPException
    path = Path(__file__).resolve().parents[1] / "lse_terminal/engine/server.py"
    nodes = [n for n in ast.walk(ast.parse(path.read_text()))
             if isinstance(n, ast.FunctionDef) and n.name == "instruments"]
    assert len(nodes) == 1
    nodes[0].decorator_list = []
    kinds = {"NINE": 9, "ZERO": 0, "TWENTY": 20, "TEXT": "2", "FRACTION": 2.5,
             "FLAG": True, "NEGATIVE": -1, "HUGE": 21, "ABSENT": None}
    items = [SimpleNamespace(symbol=s, name=s, category="X",
                             meta={} if d is None else {"digits": d})
             for s, d in kinds.items()]
    env = {"HTTPException": HTTPException,
           "reg": SimpleNamespace(get=lambda name: SimpleNamespace(
               search=lambda query, limit=50: items))}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), env)
    rows = {r["symbol"]: r for r in env["instruments"]("any", "", 50, False)}
    assert {s: r.get("digits") for s, r in rows.items()} == {
        "NINE": 9, "ZERO": 0, "TWENTY": 20, "TEXT": None, "FRACTION": None,
        "FLAG": None, "NEGATIVE": None, "HUGE": None, "ABSENT": None}
    for symbol in ("TEXT", "FRACTION", "FLAG", "NEGATIVE", "HUGE", "ABSENT"):
        assert set(rows[symbol]) == {"symbol", "name", "category", "live"}


def test_a_short_page_of_bars_is_an_answer_and_a_failed_one_says_why(client, home):
    """The chart asks for 5000 bars. A venue that holds fewer returns what it
    holds, oldest first, and that is the answer. A venue that fails answers
    502 with its own sentence, which the page shows in the chart area."""
    source = ADAPTER.replace(
        '        n = min(int(params.get("count") or 10), 50)\n',
        '        if params["symbol"] == "ZED":\n'
        '            raise AdapterError("internal", "the venue was too slow to'
        ' page %d bars; ask for fewer" % params["count"])\n'
        '        if params["symbol"] == "FA":\n'
        '            return {"bars": []}\n'
        '        n = min(int(params.get("count") or 10), 37)\n')
    assert "too slow" in source
    path = write_adapter(home / "my adapters", source=source)
    assert link(client, python_file=path).status_code == 200
    assert client.post("/api/broker/connect", json={"broker": "mine"}).is_success

    def candles(symbol):
        return client.get("/api/candles", params={
            "provider": "broker:mine", "symbol": symbol, "timeframe": "1m",
            "limit": 5000})

    short = candles("F")
    assert short.status_code == 200
    bars = short.json()["candles"]
    assert len(bars) == 37                          # fewer than asked, no error
    assert [b[0] for b in bars] == sorted(b[0] for b in bars)   # oldest first
    assert bars[0][0] < 10 ** 11                    # epoch seconds, as every source
    empty = candles("FA")
    assert empty.status_code == 200 and empty.json()["candles"] == []
    failed = candles("ZED")
    assert failed.status_code == 502
    assert failed.json()["detail"] == ("candles failed: internal: the venue was"
                                       " too slow to page 5000 bars; ask for fewer")
    # the symbol goes to the venue as it was asked for: the page resolves a
    # typed "f" to "F" before it asks (the adapter here answers any spelling)
    assert candles("F").status_code == 200


# ── the starter adapter and this computer's test command ──────────────────
# "+ Add your own broker" offers the kit's starter adapter as a file to save
# (GET /api/broker/template) and shows the one command that tests it here
# (GET /api/broker/own-guide). The command is pasted into a shell as it is,
# so it is run here as a shell runs it, from a folder whose name has spaces.

import shlex as _shlex
import subprocess as _subprocess

STARTER = b"# a stand-in for the kit's starter adapter\r\nprint('\xc2\xa3 practice')\n"


def kit_with_starter(home, folder="kit", body=STARTER):
    base = home / folder / "brueconnect"
    (base / "templates").mkdir(parents=True)
    (base / "templates" / "my_broker_adapter.py").write_bytes(body)
    return base


def test_the_starter_adapter_is_a_file_to_save_byte_for_byte(client, home):
    hub_of(client).base = kit_with_starter(home, "a kit")
    r = client.get("/api/broker/template")
    assert r.status_code == 200
    assert r.content == STARTER                    # not re-encoded, not re-lined
    assert r.headers["content-type"] == "text/x-python; charset=utf-8"
    assert (r.headers["content-disposition"]
            == 'attachment; filename="my_broker_adapter.py"')
    assert client.get("/api/broker/own-guide").json()["template"] is True


@pytest.mark.parametrize("kit", ["without the file", "not installed"])
def test_a_kit_without_the_starter_says_to_update(client, home, kit):
    hub = hub_of(client)
    if kit == "not installed":
        hub.base = None
    else:
        hub.base = home / "old kit" / "brueconnect"
        (hub.base / "adapters").mkdir(parents=True)
    r = client.get("/api/broker/template")
    assert r.status_code == 404
    assert r.json()["detail"] == ("This terminal's kit has no starter adapter. "
                                  "Update the terminal.")
    g = client.get("/api/broker/own-guide").json()
    assert g["template"] is False
    if kit == "not installed":
        assert g["sdk"] is None and g["commands"] is None


# A suite and an adapter that only say what they were given: the suite
# records its arguments, environment and folder and runs the --adapter
# command the way the real one does (shlex, POSIX rules); the adapter says
# where it ran and which brueconnect it imported.
FAKE_SUITE = r'''
import json, os, shlex, subprocess, sys
args = sys.argv[1:]
adapter = shlex.split(args[args.index("--adapter") + 1])
child = subprocess.run(adapter, capture_output=True, text=True)
with open(os.environ["SUITE_RECORD"], "w") as fh:
    json.dump({"args": args, "adapter": adapter, "cwd": os.getcwd(),
               "pythonpath": os.environ.get("PYTHONPATH"),
               "keys": {k: v for k, v in os.environ.items()
                        if k.startswith("BRUE_CRED_")},
               "child": child.stdout, "child_err": child.stderr}, fh)
'''
FAKE_STARTER = r'''
import json, os, sys
import brueconnect
print(json.dumps({"argv": sys.argv, "cwd": os.getcwd(),
                  "sdk": brueconnect.__file__}))
'''


def sdk_with_fake_suite(folder: Path) -> Path:
    (folder / "brueconnect" / "conformance").mkdir(parents=True)
    (folder / "brueconnect" / "__init__.py").write_text("")
    (folder / "brueconnect" / "conformance" / "__init__.py").write_text("")
    (folder / "brueconnect" / "conformance" / "run.py").write_text(FAKE_SUITE)
    return folder


def python_with_a_space(home) -> Path:
    folder = home / "my python 3"
    folder.mkdir()
    py = folder / "python3"
    py.symlink_to(sys.executable)
    return py


@pytest.mark.parametrize("shell", ["sh", "bash", "dash"])
def test_the_posix_test_command_runs_as_printed_from_the_saved_folder(
        client, home, monkeypatch, shell):
    if shutil.which(shell) is None:
        pytest.skip(f"no {shell} here")
    py = python_with_a_space(home)
    monkeypatch.setattr(broker_hub, "adapter_python", lambda: str(py))
    sdk = sdk_with_fake_suite(home / "brue sdk")
    hub_of(client).sdk = sdk
    g = client.get("/api/broker/own-guide").json()
    # the facts the card shows
    assert g["python"] == str(py)
    assert g["python_version"] == "%d.%d.%d" % sys.version_info[:3]
    assert g["python_ok"] is True
    assert g["sdk"] == str(sdk)
    assert g["platform"] == sys.platform and g["file"] == "my_broker_adapter.py"
    saved = home / "saved it here"
    saved.mkdir()
    (saved / "my_broker_adapter.py").write_text(FAKE_STARTER)
    record = home / "suite.json"
    env = {**os.environ, "SUITE_RECORD": str(record)}
    env.pop("PYTHONPATH", None)                  # the command must bring its own
    done = _subprocess.run([shell, "-c", g["commands"]["posix"]], cwd=saved,
                           env=env, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    got = json.loads(record.read_text())
    assert got["args"][:2] == ["--adapter", f"{_shlex.quote(str(py))} my_broker_adapter.py"]
    assert got["adapter"] == [str(py), "my_broker_adapter.py"]
    assert got["cwd"] == str(saved)
    assert got["pythonpath"] == str(sdk)
    assert got["keys"] == {"BRUE_CRED_API_KEY": "practice",
                           "BRUE_CRED_API_SECRET": "practice"}
    child = json.loads(got["child"])
    assert child["argv"] == ["my_broker_adapter.py"] and child["cwd"] == str(saved)
    assert child["sdk"].startswith(str(sdk) + os.sep)     # the terminal's SDK


@pytest.mark.parametrize("python,sdk", [
    ("/usr/bin/python3", "/opt/kit"),
    ("/Users/Jo Smith/.venv/bin/python3",
     "/Applications/LSE Terminal.app/Contents/Resources/brue-sdk"),
    ("/home/o'brien/py $HOME `x` \\ \"q\" !1/python3", "/s d/k's $x"),
])
def test_the_posix_command_keeps_every_path_one_word(python, sdk):
    words = _shlex.split(broker_hub.conformance_command_posix(python, sdk))
    assert words[:3] == ["BRUE_CRED_API_KEY=practice",
                         "BRUE_CRED_API_SECRET=practice", "PYTHONPATH=" + sdk]
    assert words[3:7] == [python, "-m", "brueconnect.conformance.run", "--adapter"]
    assert _shlex.split(words[7]) == [python, "my_broker_adapter.py"]
    assert len(words) == 8


def powershell_hands_over(line: str):
    """What Windows PowerShell 5.1 does with the card's line, for the forms
    the line uses: statements split by `;`, `$env:NAME = '...'`, and
    `& '...' args`; '...' strings (a quote inside written twice, the
    typographic ones too) and "..." strings (a backtick escapes the next
    character; an unescaped $ would be a variable, so it fails here). Then
    how 5.1 hands arguments to a program: one holding a space is wrapped in
    double quotes with NOTHING inside escaped, and the program's C runtime
    splits that command line again (MSVC rules). Returns (env, argv)."""
    single = "'\u2018\u2019\u201a\u201b"
    double = '"\u201c\u201d\u201e'
    statements, words, i = [], [], 0
    while i < len(line):
        ch = line[i]
        if ch == ";":
            statements.append(words)
            words, i = [], i + 1
        elif ch.isspace():
            i += 1
        elif ch in single:
            out, i = "", i + 1
            while True:
                if line[i] in single and i + 1 < len(line) and line[i + 1] in single:
                    out, i = out + line[i], i + 2
                elif line[i] in single:
                    i += 1
                    break
                else:
                    out, i = out + line[i], i + 1
            words.append(out)
        elif ch in double:
            out, i = "", i + 1
            while line[i] not in double:
                if line[i] == "`":
                    out, i = out + line[i + 1], i + 2
                    continue
                assert line[i] != "$", "an unescaped $ in a double-quoted string"
                out, i = out + line[i], i + 1
            words.append(out)
            i += 1
        else:
            j = i
            while j < len(line) and not line[j].isspace() and line[j] != ";":
                j += 1
            words.append(line[i:j])
            i = j
    statements.append(words)
    env, argv = {}, None
    for st in statements:
        if st and st[0].startswith("$env:"):
            assert st[1] == "=" and len(st) == 3, st
            env[st[0][5:]] = st[2]
        elif st and st[0] == "&":
            assert argv is None
            # 5.1: a word with a space is wrapped in quotes, nothing escaped
            assert not any('"' in w for w in st[2:]), "5.1 would mangle a quote"
            cmdline = " ".join('"' + w + '"' if (" " in w or not w) else w
                               for w in st[1:])
            argv = msvc_split(cmdline)
        else:
            raise AssertionError(f"a statement this check does not know: {st}")
    return env, argv


def msvc_split(cmdline: str) -> list:
    """A command line as a program built with the Microsoft C runtime reads
    it (python.exe does): whitespace splits outside quotes; 2n backslashes
    before a quote are n and the quote toggles; 2n+1 are n and a literal
    quote; backslashes before anything else are themselves."""
    out, cur, quoted, have, i = [], "", False, False, 0
    while i < len(cmdline):
        ch = cmdline[i]
        if ch == "\\":
            n = 0
            while i < len(cmdline) and cmdline[i] == "\\":
                n, i = n + 1, i + 1
            if i < len(cmdline) and cmdline[i] == '"':
                cur += "\\" * (n // 2)
                if n % 2:
                    cur, i = cur + '"', i + 1
            else:
                cur += "\\" * n
            have = True
            continue
        if ch == '"':
            quoted, have, i = not quoted, True, i + 1
            continue
        if ch in " \t" and not quoted:
            if have:
                out.append(cur)
            cur, have, i = "", False, i + 1
            continue
        cur, have, i = cur + ch, True, i + 1
    if have:
        out.append(cur)
    return out


@pytest.mark.parametrize("python,sdk", [
    (r"C:\Users\Jo\AppData\Local\Programs\Python\Python312\python.exe",
     r"C:\Program Files\LSE Terminal\resources\brue-sdk"),
    (r"C:\Program Files\Python312\python.exe",
     r"C:\Users\Jo Smith\AppData\Local\Programs\LSE Terminal\resources\brue-sdk"),
    (r"C:\Users\Jo O'Brien\py $x `y\python.exe", r"C:\Users\Jo O'Brien\k’s sdk"),
    ("C:/forward/slashes ok/python.exe", "C:/sdk"),
])
def test_the_powershell_command_reaches_python_whole(python, sdk):
    env, argv = powershell_hands_over(
        broker_hub.conformance_command_powershell(python, sdk))
    assert env == {"BRUE_CRED_API_KEY": "practice",
                   "BRUE_CRED_API_SECRET": "practice", "PYTHONPATH": sdk}
    assert argv[:4] == [python, "-m", "brueconnect.conformance.run", "--adapter"]
    # and the suite, splitting --adapter by its own (POSIX) rules, starts
    # exactly this
    assert _shlex.split(argv[4]) == [python, "my_broker_adapter.py"]
    assert len(argv) == 5


def test_the_card_gets_both_forms_with_this_machines_paths(client, home,
                                                           monkeypatch):
    py = python_with_a_space(home)
    monkeypatch.setattr(broker_hub, "adapter_python", lambda: str(py))
    hub_of(client).sdk = home / "brue sdk"
    g = client.get("/api/broker/own-guide").json()
    env, argv = powershell_hands_over(g["commands"]["windows"])
    assert env["PYTHONPATH"] == str(home / "brue sdk")
    assert argv[0] == str(py)
    assert _shlex.split(argv[4]) == [str(py), "my_broker_adapter.py"]


def test_no_python_means_no_command_and_says_so(client, monkeypatch):
    """Frozen on a machine with no Python 3.10+, an adapter would be run by
    the engine's own bundle: no Python a user can test with, so none is
    named and no command is offered (the card says why)."""
    monkeypatch.setattr(broker_hub, "python_available", lambda: False)
    g = client.get("/api/broker/own-guide").json()
    assert g["python"] is None and g["python_version"] is None
    assert g["python_ok"] is False and g["commands"] is None


def test_a_python_older_than_3_10_gets_no_command(client, monkeypatch):
    monkeypatch.setattr(broker_hub, "_interpreter_version",
                        lambda path: (3, 9, 6))
    g = client.get("/api/broker/own-guide").json()
    assert g["python"] == sys.executable
    assert g["python_version"] == "3.9.6"
    assert g["python_ok"] is False and g["commands"] is None


def test_nothing_tells_a_user_to_pip_install_brue_connect():
    """There is no `brue-connect` on PyPI. Nothing a user can read may send
    them to it: the engine's messages, the page and the walkthrough."""
    root = Path(broker_hub.__file__).resolve().parents[1]
    for rel in ("engine/broker_hub.py", "engine/server.py",
                "ui/static/app.js", "ui/static/guide.md"):
        text = (root / rel).read_text(encoding="utf-8")
        assert "pip install brue-connect" not in text, rel


def test_alpacas_row_carries_alpacas_own_logo():
    """The first listed row is recognisable at a glance. The shipped row
    draws its broker's own mark (its favicon, the yellow disc), inline, and
    the examples route hands it to the Connections screen."""
    import base64
    from lse_terminal.engine import broker_hub as bh
    logo = bh.EXAMPLES["alpaca"]["logo"]
    assert logo.startswith("data:image/svg+xml;base64,")
    svg = base64.b64decode(logo.split(",", 1)[1]).decode("utf-8")
    assert svg.startswith("<svg") and "#FCD72B" in svg and 'fill="#111111"' in svg
    assert "<script" not in svg.lower() and "foreignobject" not in svg.lower()
    hub = bh.BrokerHub.__new__(bh.BrokerHub)
    hub._example_path = lambda key: "x"
    rows = bh.BrokerHub.examples(hub)
    assert [r["key"] for r in rows] == ["alpaca", "oanda", "capitalcom"]
    assert rows[0]["logo"] == logo


def test_the_two_other_listed_rows_carry_their_brokers_own_marks():
    """The second listed row draws its broker's symbol in its own colours,
    and the third draws its broker's favicon unaltered (that square mark is
    published only as PNG and WebP), inline, and the examples route hands
    both on."""
    import base64
    import hashlib
    import re
    from lse_terminal.engine import broker_hub as bh
    o = bh.EXAMPLES["oanda"]["logo"]
    assert o.startswith("data:image/svg+xml;base64,")
    svg = base64.b64decode(o.split(",", 1)[1]).decode("utf-8")
    assert svg.startswith("<svg") and "#00D37E" in svg and "#00214A" in svg
    assert "<script" not in svg.lower() and "foreignobject" not in svg.lower()
    assert not re.search(r"\son[a-z]+\s*=|href|style", svg, re.I)
    c = bh.EXAMPLES["capitalcom"]["logo"]
    assert c.startswith("data:image/png;base64,")
    png = base64.b64decode(c.split(",", 1)[1])
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert hashlib.sha256(png).hexdigest() == (
        "5caeac9e1a35ae9e6e18b82bad2d9fb063fc5e11735185b310da17076c9bd548")
    hub = bh.BrokerHub.__new__(bh.BrokerHub)
    hub._example_path = lambda key: "x"
    rows = {r["key"]: r for r in bh.BrokerHub.examples(hub)}
    assert rows["oanda"]["logo"] == o and rows["capitalcom"]["logo"] == c
    for key in ("oanda", "capitalcom"):
        assert rows[key]["args"] == ["--paper"]
        assert rows[key]["keys_url"].startswith("https://") and rows[key]["keys_help"]
        assert rows[key]["about"].endswith("demo account.")


def test_the_oanda_row_says_who_cannot_use_its_api_and_names_its_token():
    """That broker does not offer its API to residents of the EU or to the
    clients of its overseas arm, and the adapter cannot tell where a user
    lives, so the row says it beside the key form. Its one box is the API
    token, and the card's words name the same thing."""
    from lse_terminal.engine import broker_hub as bh
    hub = bh.BrokerHub.__new__(bh.BrokerHub)
    hub._example_path = lambda key: "x"
    rows = {r["key"]: r for r in bh.BrokerHub.examples(hub)}
    oanda = rows["oanda"]
    assert oanda["keys_help"].endswith(
        "OANDA does not offer this API to residents of the EU (OANDA TMS "
        "Brokers) or to clients of OANDA Global Markets.")
    assert [f["label"] for f in oanda["form"]] == ["API token"]
    assert oanda["key_name"] == "API token"
    # a row that names nothing keeps "API key", which its boxes say
    for key in ("alpaca", "capitalcom"):
        assert "key_name" not in rows[key]
        assert any("API key" in f["label"] for f in rows[key]["form"])


def test_the_connections_screen_has_no_green():
    """The Connections screen is black and white. No rule of the
    Connections screen names a green, as a colour or through a variable, in
    either theme; the one green left is the LSE mark's own up candle (.lg-up,
    the brand), and a broker's logo, which is an image."""
    import colorsys
    import re
    root = Path(broker_hub.__file__).resolve().parents[1]
    css = (root / "ui/static/style.css").read_text(encoding="utf-8")
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)

    def greens(text):
        found = []
        for m in re.finditer(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b"
                             r"|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", text):
            if m.group(1):
                h = m.group(1) if len(m.group(1)) == 6 else "".join(c * 2 for c in m.group(1))
                r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
            else:
                r, g, b = (int(m.group(i)) for i in (2, 3, 4))
            hue, light, sat = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
            if 75 <= hue * 360 <= 165 and sat >= .2 and .08 <= light <= .95:
                found.append(m.group(0))
        return found

    tokens = re.findall(r"(--cs-[\w-]+)\s*:\s*([^;]+);", css)
    assert len(tokens) >= 20, tokens
    assert not [(k, v) for k, v in tokens if greens(v)]
    rules = [(s.strip(), body) for s, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css)
             if re.search(r"[#.](cs|inq)-", s)]
    assert len(rules) > 50
    bad = [(sel[:80], greens(body) + re.findall(r"var\(--(?:up|logo-up|ohlcv-[\w-]+)\)", body))
           for sel, body in rules if ".lg-up" not in sel]
    assert not [b for b in bad if b[1]], [b for b in bad if b[1]]


# ── "Create my starter adapter" and "Open folder": nobody types a path ──

@pytest.fixture()
def own_home(home, monkeypatch):
    """The user's home folder, where the starter is created, inside the sandbox."""
    h = home / "user-home"
    h.mkdir()
    monkeypatch.setattr(broker_hub.Path, "home", classmethod(lambda cls: h))
    return h


def test_create_puts_the_starter_in_the_users_own_folder_and_says_where(client, own_home):
    r = client.post("/api/broker/template/save", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    dest = own_home / "LSE Terminal" / "brokers" / "my_broker_adapter.py"
    assert body == {"path": str(dest), "folder": str(dest.parent), "existing": False}
    assert dest.read_bytes() == hub_of(client).template_path().read_bytes()
    assert not (dest.parent / "my_broker_adapter.py.part").exists()


def test_create_never_overwrites_the_users_own_edits(client, own_home):
    client.post("/api/broker/template/save", json={})
    dest = own_home / "LSE Terminal" / "brokers" / "my_broker_adapter.py"
    dest.write_text("# my broker, edited\n")
    r = client.post("/api/broker/template/save", json={})
    assert r.status_code == 200 and r.json()["existing"] is True
    assert dest.read_text() == "# my broker, edited\n"


def test_create_answers_only_the_terminals_own_window(client, own_home):
    # no declared JSON body: refused, and nothing written
    assert client.post("/api/broker/template/save", content=b"{}").status_code == 415
    assert client.post("/api/broker/template/save", json={},
                       headers={"Origin": "http://evil.example"}).status_code == 403
    assert not (own_home / "LSE Terminal").exists()


@pytest.mark.parametrize("platform, expect", [
    ("win32", lambda f: f'explorer /select,"{f}"'),
    ("darwin", lambda f: ["open", "-R", str(f)]),
    ("linux", lambda f: ["xdg-open", str(f.parent)]),
])
def test_open_folder_opens_only_the_saved_starter(client, own_home, monkeypatch, platform, expect):
    assert client.post("/api/broker/template/reveal", json={}).status_code == 404   # nothing saved yet
    client.post("/api/broker/template/save", json={})
    opened = []
    import subprocess
    monkeypatch.setattr(subprocess, "Popen", lambda cmd, **kw: opened.append(cmd))
    monkeypatch.setattr(broker_hub.sys, "platform", platform)
    r = client.post("/api/broker/template/reveal", json={"path": "C:\\Windows\\System32"})  # a path from the page is ignored
    assert r.status_code == 200, r.text
    dest = own_home / "LSE Terminal" / "brokers" / "my_broker_adapter.py"
    assert opened == [expect(dest)]
