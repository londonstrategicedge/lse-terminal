"""A broker's terms (Brue Connect SPEC 3.3), acted on by the terminal.

A broker adapter may declare, in its handshake, that the broker's terms keep
its market data on the user's computer (data_local_only) and that every order
on a live account is placed by the user (orders_by_hand_only). Our own listing
of a broker (an EXAMPLES row, a directory row) may say the same. The stricter
of the two applies, flag by flag, and the listing holds before the first hello
and when a hello fails.

What is pinned here, path by path:
  - the listing: merged flag by flag, held before hello and through a failed
    one, by marker and by file;
  - the engine's price routes (candles, prices, quotes, the stream, the
    indicator preview, the backtests) refuse a PROGRAM a data_local_only
    connection's market data with the sentence, and serve the terminal's own
    window; positions keep the account's record and lose the price;
  - the one tool dispatcher (/mcp and the panel chats' /api/ai/tool-run)
    withholds or refuses, with the sentence;
  - the hosted assistant's tool results carry none of it;
  - context.json, the brief and the screenshot;
  - code run for the assistant (run_python) cannot read it either;
  - browse does not read a page that ends on this machine;
  - orders on a live orders_by_hand_only connection come from the window
    alone, always-allow never covers one, no assistant tool places one, the
    strategy runner runs the kit's paper adapter only;
  - and a connection with no terms behaves exactly as before, on every path.

No broker's API, no AI and no hosted service is called: the brokers are the
kit's paper engine (tests/data/terms_adapter.py), the hosted assistant is a
fake on loopback, and the hosted sim relay points at a dead loopback port.
"""
import json
import os
import re
import socket
import stat
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

FIXTURE = Path(__file__).resolve().parent / "data" / "terms_adapter.py"
LICENCE = {"data_local_only": True,
           "summary": "Fixture Markets licenses its prices to you alone, for "
                      "use on this computer.",
           "url": "https://fixture.example/legal/api-licence"}
BY_HAND = {"orders_by_hand_only": True,
           "summary": "Each order on a live Fixture Markets account is placed "
                      "by you.",
           "url": "https://fixture.example/legal/terms"}
BOTH = {**LICENCE, "orders_by_hand_only": True}
WIN_GET = {"Sec-Fetch-Site": "same-origin"}
WIN_POST = {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1"}


# ── the sandbox ───────────────────────────────────────────────────────────

@pytest.fixture()
def home(tmp_path, monkeypatch):
    """Every test its own broker registry, config and AI workspace; no key;
    the hosted sim relay and the directory pointed at dead loopback ports."""
    from lse_terminal.engine import broker_hub
    monkeypatch.setenv("BRUE_CONNECT_HOME", str(tmp_path / "brue-connect"))
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.delenv("LSE_API_KEY", raising=False)
    monkeypatch.setenv("LSE_SIM_API", "http://127.0.0.1:9")
    monkeypatch.setattr(broker_hub, "DIRECTORY_URL", "http://127.0.0.1:9/none")
    return tmp_path


def add_profile(name, *, terms=None, mode="paper", extra=()):
    """A broker of the user's own: the fixture adapter, declaring `terms`."""
    from brueconnect import registry
    argv = [sys.executable, str(FIXTURE), "--mode", mode]
    if terms is not None:
        argv += ["--terms", json.dumps(terms)]
    registry.add(name, argv=argv + list(extra), description=name)


@pytest.fixture()
def client(home):
    from lse_terminal.engine.server import create_app
    app = create_app()
    c = TestClient(app, base_url="http://127.0.0.1")
    c.hub = app.state.broker_hub
    yield c
    app.state.broker_hub.shutdown()


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture()
def engine(home):
    """The engine on a real loopback port, because the tools call it over
    HTTP the way they do in the app. Stopped, and its adapters with it."""
    import uvicorn
    from lse_terminal.engine.server import create_app
    app = create_app()
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning",
        access_log=False, lifespan="on"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "the engine did not start"
    base = f"http://127.0.0.1:{port}"
    yield SimpleNamespace(base=base, port=port, app=app,
                          hub=app.state.broker_hub, home=home,
                          win_get={"Sec-Fetch-Site": "same-origin"},
                          win_post={"Sec-Fetch-Site": "same-origin",
                                    "Origin": base})
    server.should_exit = True
    t.join(15)
    app.state.broker_hub.shutdown()


def call(base, path, method="GET", body=None, headers=None, timeout=90):
    """One request as a program makes it (urllib: no Origin, no
    Sec-Fetch-Site), every byte read. (status, parsed body)."""
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"} if body is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(base + path, data=data, headers=h,
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")


def mcp(base, name, args=None):
    """A tool call through /mcp, as any local MCP client makes it."""
    st, out = call(base, "/mcp", "POST", {
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": args or {}}})
    assert st == 200, out
    res = out["result"]
    return bool(res.get("isError")), res["content"][0]["text"]


def connect(c, name):
    r = c.post("/api/broker/connect", json={"broker": name})
    assert r.status_code == 200, r.text
    return r.json()


def wait_for(fn, timeout=10.0, step=0.1):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


# ── reading and merging the terms ─────────────────────────────────────────

def test_terms_are_read_as_the_kit_reads_them_and_fail_closed():
    from lse_terminal.engine.broker_hub import clean_terms
    none = {"data_local_only": False, "orders_by_hand_only": False}
    assert clean_terms(None) == none
    assert clean_terms({}) == none
    assert clean_terms({"data_local_only": False, "orders_by_hand_only": None}) == none
    # A restriction misspelt is a restriction.
    for odd in ("false", 0, "", [], "no"):
        assert clean_terms({"data_local_only": odd})["data_local_only"] is True
    assert clean_terms("data_local_only") == {"data_local_only": True,
                                              "orders_by_hand_only": True}
    got = clean_terms({**LICENCE, "url": "http://fixture.example/x"})
    assert got["summary"] == LICENCE["summary"] and "url" not in got


def test_without_the_kits_sanitiser_the_same_rule_holds(monkeypatch):
    """A kit from before 1.11 has no sanitize_terms: the terminal applies the
    same fail-closed rule itself."""
    from brueconnect import protocol
    from lse_terminal.engine.broker_hub import clean_terms
    monkeypatch.delattr(protocol, "sanitize_terms")
    assert clean_terms(None) == {"data_local_only": False, "orders_by_hand_only": False}
    assert clean_terms({"data_local_only": "false"})["data_local_only"] is True
    assert clean_terms(7) == {"data_local_only": True, "orders_by_hand_only": True}
    got = clean_terms({**BY_HAND, "url": "javascript:alert(1)"})
    assert got["orders_by_hand_only"] is True and "url" not in got
    assert got["summary"] == BY_HAND["summary"]


def test_the_stricter_applies_flag_by_flag_and_a_summary_speaks_for_every_flag():
    from lse_terminal.engine.broker_hub import clean_terms, merge_terms, terms_said
    listing = clean_terms(LICENCE)
    said = clean_terms(BY_HAND)
    got = merge_terms(listing, said)
    assert got["data_local_only"] is True and got["orders_by_hand_only"] is True
    # Neither source's summary speaks for both restrictions, so there is none,
    # and the terminal's own sentence names each.
    assert "summary" not in got and got["url"] == LICENCE["url"]
    assert terms_said("Fixture Markets", got) == (
        "Fixture Markets' terms keep its prices on this computer and have you "
        "place each order on a live account yourself.")
    # A source that sets every flag in force gives the summary; with both in
    # force the user reads it, then the terminal's sentence naming each.
    got = merge_terms(clean_terms({"data_local_only": True}), clean_terms(BOTH))
    assert (got["summary"], got["url"]) == (LICENCE["summary"], LICENCE["url"])
    assert terms_said("Fixture Markets", got) == (
        LICENCE["summary"] + " Fixture Markets' terms keep its prices on this "
        "computer and have you place each order on a live account yourself.")
    covers = {"data_local_only": True, "orders_by_hand_only": True,
              "summary": "Our prices are yours alone and every live order is "
                         "placed by you"}
    assert terms_said("Fixture Markets", clean_terms(covers)).startswith(
        "Our prices are yours alone and every live order is placed by you. "
        "Fixture Markets' terms keep")
    # A handshake cannot lower what the listing sets.
    assert merge_terms(listing, clean_terms({"data_local_only": False}))["data_local_only"] is True
    # A summary keeps its own url, or none: never another source's.
    got = merge_terms(clean_terms({"data_local_only": True, "summary": "Mine."}),
                      clean_terms({"data_local_only": True, "url": "https://x.example/t"}))
    assert got["summary"] == "Mine." and "url" not in got
    assert merge_terms(None, None) == {"data_local_only": False, "orders_by_hand_only": False}


def test_a_listed_summary_that_names_both_restrictions_is_said_once(home, listed):
    """With both restrictions in force the row reads the summary, then the
    terminal's clause naming each, because a summary may speak of only one.
    A listing whose summary names both says so (`terms_cover`); then the row
    says them once, in the broker's words, before the profile is linked and
    after. Only that listing's own summary is believed to name both: a
    summary from elsewhere, or one the listing says names one, still gets the
    clause."""
    from lse_terminal.engine import broker_hub as bh
    clause = (" Fixture Markets' terms keep its prices on this computer and have "
              "you place each order on a live account yourself.")
    names_both = ("Fixture Markets' prices stay on this computer, and each order on a "
                  "live account is placed by you.")
    both = bh.clean_terms({**BOTH, "summary": names_both})
    assert bh.terms_said("Fixture Markets", both, covers=bh.TERMS_FLAGS) == names_both
    assert bh.terms_said("Fixture Markets", both) == names_both + clause
    assert bh.terms_said("Fixture Markets", both,
                         covers=("data_local_only",)) == names_both + clause
    # one restriction in force: its summary alone, with or without the word
    assert bh.terms_said("Fixture Markets", bh.clean_terms(LICENCE),
                         covers=("data_local_only",)) == LICENCE["summary"]
    hub = _hub(home)
    try:
        listed["terms"] = {**BOTH, "summary": names_both}
        listed["terms_cover"] = bh.TERMS_FLAGS
        ex = [x for x in hub.examples() if x["key"] == "fixture"][0]
        assert ex["terms"]["said"] == names_both
        hub.link("my-fixture", example="fixture", test=False)
        assert hub.terms_row("my-fixture")["said"] == names_both
        # the listing says its summary names the prices only: the clause follows
        listed["terms"] = dict(BOTH)
        listed["terms_cover"] = ("data_local_only",)
        assert hub.terms_row("my-fixture")["said"] == LICENCE["summary"] + clause
        ex = [x for x in hub.examples() if x["key"] == "fixture"][0]
        assert ex["terms"]["said"] == LICENCE["summary"] + clause
        # the shipped row whose summary names both says them once
        rows = {x["key"]: x for x in hub.examples()}
        cap = bh.EXAMPLES["capitalcom"]["terms"]["summary"]
        assert rows["capitalcom"]["terms"]["said"] == cap
        hub.link("my-capitalcom", example="capitalcom", test=False)
        assert hub.terms_row("my-capitalcom")["said"] == cap
        assert hub.terms_row("my-capitalcom")["data_local_only"] is True
        assert hub.terms_row("my-capitalcom")["orders_by_hand_only"] is True
    finally:
        hub.shutdown()


def test_a_summary_not_the_listings_own_still_gets_the_clause(client, listed):
    """The listing's word that its summary names both restrictions
    (terms_cover) speaks for that summary alone. A listing with the word and
    no summary of its own leaves the summary in force to the adapter's hello,
    which may name only one restriction (here the orders): the terminal's
    clause naming each still follows it, or the prices go unsaid."""
    from lse_terminal.engine import broker_hub as bh
    clause = (" Fixture Markets' terms keep its prices on this computer and have "
              "you place each order on a live account yourself.")
    listed["terms"] = {"data_local_only": True, "orders_by_hand_only": True, "url": LICENCE["url"]}
    listed["terms_cover"] = bh.TERMS_FLAGS
    hello = {"data_local_only": True, "orders_by_hand_only": True, "summary": BY_HAND["summary"]}
    listed["args"] = ("--mode", "live", "--terms", json.dumps(hello))
    client.hub.link("my-fixture", example="fixture")          # its hello is answered
    t = client.hub.terms_row("my-fixture")
    assert t["summary"] == BY_HAND["summary"]
    assert t["said"] == BY_HAND["summary"] + clause
    assert _rows(client, WIN_GET)["my-fixture"]["terms"]["said"] == BY_HAND["summary"] + clause


def test_a_long_name_is_cut_without_a_space_before_its_possessive(home):
    """A broker's name is cut at 40 characters in the sentences; a cut that
    lands on a space leaves none before the possessive."""
    from lse_terminal.engine.broker_hub import _plain, by_hand_text
    cut = _plain("Northwind Global Markets Holdings Group Ltd", 40)
    assert cut == "Northwind Global Markets Holdings Group"
    assert " 's" not in by_hand_text(cut) and "Group's terms" in by_hand_text(cut)
    hub = _hub(home)
    add_profile("longname", terms=BY_HAND, mode="live",
                extra=("--display", "Northwind Global Markets Holdings Group Ltd"))
    hub.probe("longname")
    assert hub.terms_name("longname") == "Northwind Global Markets Holdings Group"
    assert " 's" not in hub.by_hand_refusal("longname")
    hub.shutdown()


@pytest.fixture()
def listed(monkeypatch):
    """A broker of our own listing (an EXAMPLES row) whose adapter is the
    fixture: the shape a listed broker's row takes."""
    from lse_terminal.engine import broker_hub
    row = {"label": "Fixture Markets (test)", "name": "Fixture Markets",
           "about": "A listed test broker.", "keys_url": "", "keys_help": "",
           "form": (), "path": ("adapters", "fixture", "terms_adapter.py"),
           "args": ("--mode", "live"), "terms": dict(LICENCE)}
    monkeypatch.setitem(broker_hub.EXAMPLES, "fixture", row)
    real = broker_hub.BrokerHub._example_path

    def _example_path(self, key):
        return FIXTURE if key == "fixture" else real(self, key)

    monkeypatch.setattr(broker_hub.BrokerHub, "_example_path", _example_path)
    return row


def _hub(home):
    from lse_terminal.engine import broker_hub
    return broker_hub.BrokerHub(broker_hub.connect_base(None),
                                identity_cache=home / "ids.json")


def test_the_listing_holds_before_the_first_hello(home, listed):
    hub = _hub(home)
    try:
        hub.link("my-fixture", example="fixture", test=False)  # never run
        t = hub.status_one("my-fixture")["terms"]
        assert t["data_local_only"] is True and t["orders_by_hand_only"] is False
        assert t["summary"] == LICENCE["summary"] and t["url"] == LICENCE["url"]
        assert t["said"] == LICENCE["summary"]
        assert t["withheld"] == ("Withheld under Fixture Markets' terms: "
                                 + LICENCE["summary"])
        # the row before it is linked carries the listing's terms too
        ex = [x for x in hub.examples() if x["key"] == "fixture"][0]
        assert ex["terms"]["data_local_only"] is True
        assert ex["terms"]["said"] == LICENCE["summary"]
    finally:
        hub.shutdown()


def test_listing_and_memory_hold_when_hello_fails(home, listed, monkeypatch):
    """The listing says the prices stay here; the adapter's own hello adds
    that orders are by hand. Then the same command fails its hello: both
    still hold, from the listing and from what the last hello said."""
    flag = home / "broken"
    listed["args"] = ("--mode", "live", "--terms", json.dumps(BY_HAND),
                      "--fail-if-exists", str(flag))
    hub = _hub(home)
    try:
        hub.link("my-fixture", example="fixture")             # hello answered
        t = hub.terms_of("my-fixture")
        assert t["data_local_only"] is True and t["orders_by_hand_only"] is True
        # neither source's words speak for both, so the terminal's do
        assert "summary" not in t
        assert hub.terms_row("my-fixture")["said"] == (
            "Fixture Markets' terms keep its prices on this computer and have "
            "you place each order on a live account yourself.")
        assert hub.by_hand("my-fixture") is True              # live, by hand
        flag.write_text("x")
        with pytest.raises(Exception):
            hub.connect("my-fixture")                          # hello fails now
        assert "my-fixture" not in hub.conns
        t = hub.terms_of("my-fixture")
        assert t["data_local_only"] is True and t["orders_by_hand_only"] is True
        # and a new engine (a restart) still knows them, from its cache
        hub2 = _hub(home)
        try:
            t2 = hub2.terms_of("my-fixture")
            assert t2["data_local_only"] is True and t2["orders_by_hand_only"] is True
        finally:
            hub2.shutdown()
    finally:
        hub.shutdown()


def test_a_handshake_cannot_lower_the_listing(home, listed):
    listed["args"] = ("--mode", "paper", "--terms",
                      json.dumps({"data_local_only": False}))
    hub = _hub(home)
    try:
        hub.link("my-fixture", example="fixture")
        hub.connect("my-fixture")
        assert hub._live_terms(hub.conns["my-fixture"])["data_local_only"] is False
        assert hub.terms_of("my-fixture")["data_local_only"] is True
    finally:
        hub.shutdown()


def test_a_profile_linked_by_its_file_keeps_the_listed_terms(home, listed):
    """Linked through "Add your own broker" by the path of a file our listing
    names: the same broker, the same listed terms, no marker needed."""
    add_profile("by-path")
    hub = _hub(home)
    try:
        assert hub._listed_key("by-path") == "fixture"
        assert hub.terms_of("by-path")["data_local_only"] is True
        add_profile("elsewhere", extra=("--seed", "9"))
        hub._rebuild_registry()
        assert hub._listed_key("elsewhere") == "fixture"      # same file, other args
    finally:
        hub.shutdown()


def test_a_directory_row_can_carry_terms(home):
    hub = _hub(home)
    try:
        hub.apply_directory({"brokers": [{"key": "paper", "label": "Paper"}],
                             "providers": []})
        assert hub.terms_of("paper")["data_local_only"] is False
        hub.apply_directory({"brokers": [{"key": "paper", "label": "Paper",
                                          "terms": {"data_local_only": True}}],
                             "providers": []})
        assert hub.terms_of("paper")["data_local_only"] is True
    finally:
        hub.shutdown()


def test_the_listed_rows_and_status_rows_carry_terms_over_http(client, listed):
    rows = {x["key"]: x for x in client.get("/api/broker/examples").json()}
    assert rows["fixture"]["terms"]["data_local_only"] is True
    assert rows["fixture"]["terms"]["said"] == LICENCE["summary"]
    # that listed broker's market data is the account holder's alone (its terms)
    assert rows["alpaca"]["terms"]["data_local_only"] is True
    assert rows["alpaca"]["terms"]["orders_by_hand_only"] is False
    assert rows["alpaca"]["terms"]["said"].startswith("Alpaca licenses its market data")
    add_profile("own", terms=BOTH, mode="live")
    client.post("/api/broker/probe", json={"broker": "own"})
    row = {b["broker"]: b for b in client.get("/api/broker/list").json()}["own"]
    assert row["terms"]["data_local_only"] is True
    assert row["terms"]["orders_by_hand_only"] is True
    assert row["terms"]["summary"] == LICENCE["summary"]
    assert row["terms"]["by_hand"].startswith("Not sent: under Fixture Markets' terms")


# ── the engine's own price routes ─────────────────────────────────────────

def test_the_price_routes_refuse_a_program_and_serve_the_window(client):
    add_profile("local", terms=LICENCE)
    connect(client, "local")
    why = "Withheld under Fixture Markets' terms: " + LICENCE["summary"]
    src = "provider=broker:local&symbol=EURUSD&timeframe=1m&limit=20"

    r = client.get(f"/api/candles?{src}")
    assert r.status_code == 403 and r.json()["detail"] == "EURUSD candles " + why[0].lower() + why[1:]
    r = client.get(f"/api/candles?{src}", headers=WIN_GET)
    assert r.status_code == 200 and r.json()["candles"]

    r = client.get("/api/prices?provider=broker:local&symbols=EURUSD")
    assert r.status_code == 403 and LICENCE["summary"] in r.json()["detail"]
    assert r.json()["detail"].startswith("Prices withheld under Fixture Markets' terms")
    assert client.get("/api/prices?provider=broker:local&symbols=EURUSD",
                      headers=WIN_GET).status_code == 200

    client.post("/api/broker/subscribe", json={"broker": "local", "symbols": ["EURUSD"]},
                headers=WIN_POST)
    r = client.get("/api/broker/quotes?broker=local")
    assert r.status_code == 403 and LICENCE["summary"] in r.json()["detail"]
    q = wait_for(lambda: client.get("/api/broker/quotes?broker=local",
                                    headers=WIN_GET).json().get("EURUSD"))
    assert q and q["bid"] is not None

    prev = {"source": "from lse_terminal.contracts import indicator\n",
            "filename": "x.py", "provider": "broker:local", "symbol": "EURUSD",
            "timeframe": "1m", "limit": 60}
    r = client.post("/api/user-indicators/preview", json=prev)
    assert r.status_code == 403 and LICENCE["summary"] in r.json()["detail"]
    r = client.post("/api/user-indicators/preview", json=prev, headers=WIN_POST)
    assert r.status_code == 200 and r.json()["candles"]

    bt = {"engine": "python", "provider": "broker:local", "symbol": "EURUSD",
          "timeframe": "1m", "script": "trades = []\n"}
    r = client.post("/api/backtest", json=bt)
    assert r.status_code == 403
    assert r.json()["detail"].startswith("Backtest results on EURUSD withheld")
    r = client.post("/api/backtest", json=bt, headers=WIN_POST)
    assert r.status_code == 200, r.text                    # the user's own run
    r = client.post("/api/backtest/montecarlo", json=bt)
    assert r.status_code == 403 and LICENCE["summary"] in r.json()["detail"]
    assert client.post("/api/backtest/montecarlo", json=bt,
                       headers=WIN_POST).status_code != 403
    wf = {**bt, "params": {"n": "1,2"}}
    r = client.post("/api/backtest/walkforward", json=wf)
    assert r.status_code == 403 and LICENCE["summary"] in r.json()["detail"]
    assert client.post("/api/backtest/walkforward", json=wf,
                       headers=WIN_POST).status_code != 403

    # A browser saying it came from elsewhere, or a typed address, is not
    # the terminal's window.
    for h in ({"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": "cross-site"},
              {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:1"}):
        assert client.get(f"/api/candles?{src}", headers=h).status_code == 403


def test_positions_keep_the_account_record_and_lose_the_price(client):
    add_profile("local", terms=LICENCE)
    connect(client, "local")
    r = client.post("/api/broker/order", json={"broker": "local", "symbol": "EURUSD",
                                               "side": "buy", "qty": 0.01})
    assert r.status_code == 200, r.text                  # paper, not by hand
    full = wait_for(lambda: client.get("/api/broker/positions?broker=local",
                                       headers=WIN_GET).json())
    assert full and "current_price" in full[0]           # the window sees it all
    rows = client.get("/api/broker/positions?broker=local").json()
    assert rows and "current_price" not in rows[0]
    for k in ("position_id", "symbol", "side", "qty", "avg_price"):
        assert k in rows[0]
    # unrealised P/L is marked to the price: with qty and avg_price it gives it back
    assert "unrealized_pnl" not in rows[0] and "unrealized_pnl" in full[0]
    held, why = rows[0]["withheld"].split(" withheld under ", 1)
    assert {"current_price", "unrealized_pnl"} <= set(held.split(", "))
    assert why == "Fixture Markets' terms: " + LICENCE["summary"]
    # the account: its balance is its own record; equity and margin are marked
    # to the positions' prices, so a program does not get them
    acct = client.get("/api/broker/account?broker=local").json()
    assert acct["balance"] is not None and "equity" not in acct
    assert "equity" in acct["withheld"].split(" withheld under ", 1)[0].split(", ")
    assert "equity" in client.get("/api/broker/account?broker=local",
                                  headers=WIN_GET).json()      # the window: all of it


def test_a_programs_catalog_carries_no_figure_worked_out_from_a_price(client):
    """A broker may state an instrument's minimum stop as a share of its price
    and hand it on in points of it, which with the tick size gives the price
    back; the tick's value in the account's currency is converted at the
    broker's own rate; and an adapter may add fields of its own, the price
    among them. On a data_local_only connection a program gets each
    instrument as its contract, SPEC 4's fields that no price moves, and the
    sentence naming what was held back; the window gets every field; a
    connection without terms is as before."""
    for b, terms in (("local", LICENCE), ("plain", None)):
        add_profile(b, terms=terms, extra=("--marked-catalog",))
        connect(client, b)
    marked = {"stops_level_points", "tick_value_account", "x_snapshot_mid"}
    win = {r["symbol"]: r for r in client.get("/api/broker/catalog?broker=local",
                                              headers=WIN_GET).json()}
    assert win and all(marked <= set(r) for r in win.values())
    rows = client.get("/api/broker/catalog?broker=local").json()
    assert sorted(r["symbol"] for r in rows) == sorted(win)
    for r in rows:
        assert not marked & set(r), r
        held, why = r["withheld"].split(" withheld under ", 1)
        assert set(held.split(", ")) == marked
        assert why == "Fixture Markets' terms: " + LICENCE["summary"]
        # everything else is the window's row, unchanged
        assert {k: v for k, v in r.items() if k != "withheld"} == {
            k: v for k, v in win[r["symbol"]].items() if k not in marked}
    for k in ("symbol", "name", "digits", "tick_size", "tick_value", "lot_step",
              "min_qty", "max_qty", "contract_size", "margin_rate", "sessions",
              "tradable", "trade_mode"):
        assert k in rows[0], k
    plain = client.get("/api/broker/catalog?broker=plain").json()
    assert plain and all(marked <= set(r) and "withheld" not in r for r in plain)


def test_an_instruments_objects_keep_the_records_own_keys():
    """The record is SPEC 4's InstrumentSpec all the way down. Inside the
    objects an instrument carries (its fees, sessions, early closes, margin
    tiers and dividend) only their own keys stay: an adapter can nest a key
    of its own there as easily as beside them, the spread or the price among
    them. A value of the wrong shape (an object where a figure goes, a
    figure where a list goes) is not the record either. What is left out is
    named by its path."""
    from lse_terminal.engine.broker_hub import PRICED_FIELDS, instrument_record_only
    spec = {
        "symbol": "EURUSD", "name": "Euro vs US Dollar", "digits": 5, "tick_size": 0.00001,
        "stops_level_points": 12, "tick_value_account": 0.92, "x_snapshot_mid": 1.0851,
        "fees": {"commission_per_lot": 0, "mode": "none", "rate": 0, "min": 0, "x_spread": 0.00012},
        "sessions": [{"days": [1, 2, {"x_bid": 1.0851}], "open": "00:00", "close": "24:00",
                      "tz": "UTC", "x_note": "opened at 1.0851"}],
        "early_closes": [{"date": "2026-12-24", "close": "18:00", "tz": "UTC",
                          "x_why": "last 1.0851"}, "1.0851"],
        "margin_tiers": [{"above_notional": 0, "margin_rate": 0.05, "x_margin_per_unit": 0.054}],
        "dividend": {"ex_date": "2026-12-01", "amount_per_share": 0.5, "x_yield_pct": 0.46},
        "holidays": ["2026-12-25", {"x_mid": 1.0851}],
        "swap_long": {"x_mid": 1.0851}}
    kept, dropped = instrument_record_only(spec)
    assert kept == {
        "symbol": "EURUSD", "name": "Euro vs US Dollar", "digits": 5, "tick_size": 0.00001,
        "fees": {"commission_per_lot": 0, "mode": "none", "rate": 0, "min": 0},
        "sessions": [{"days": [1, 2], "open": "00:00", "close": "24:00", "tz": "UTC"}],
        "early_closes": [{"date": "2026-12-24", "close": "18:00", "tz": "UTC"}],
        "margin_tiers": [{"above_notional": 0, "margin_rate": 0.05}],
        "dividend": {"ex_date": "2026-12-01", "amount_per_share": 0.5},
        "holidays": ["2026-12-25"]}
    # the figures a broker may work out from a price are withheld when it is
    # not known that this one does not (the careful default)
    assert set(PRICED_FIELDS) == {"stops_level_points", "tick_value_account"}
    assert dropped == sorted([
        "dividend.x_yield_pct", "early_closes", "early_closes.x_why", "fees.x_spread",
        "holidays", "margin_tiers.x_margin_per_unit", "sessions.days", "sessions.x_note",
        "stops_level_points", "swap_long", "tick_value_account", "x_snapshot_mid"])
    # a broker whose listing says its adapter sends them as fixed figures keeps them
    kept, dropped = instrument_record_only(spec, priced=())
    assert (kept["stops_level_points"], kept["tick_value_account"]) == (12, 0.92)
    assert not {"stops_level_points", "tick_value_account"} & set(dropped)
    kept, dropped = instrument_record_only(spec, priced=("stops_level_points",))
    assert "stops_level_points" not in kept and kept["tick_value_account"] == 0.92
    # null is a value of its own (a flat margin rate, no dividend); the input is untouched
    kept, dropped = instrument_record_only({"symbol": "X", "margin_tiers": None, "dividend": None,
                                            "expires_at": None})
    assert (kept, dropped) == ({"symbol": "X", "margin_tiers": None, "dividend": None,
                                "expires_at": None}, [])
    assert spec["fees"]["x_spread"] == 0.00012 and spec["sessions"][0]["x_note"]
    assert instrument_record_only("not a row") == ({}, [])


def test_a_programs_catalog_withholds_what_a_price_gives_and_keeps_what_is_fixed(
        client, listed):
    """End to end, as a program reads the catalog of a data_local_only
    connection. Keys an adapter nests in an instrument's objects reach no
    program, and the row names them. A figure that can be worked out from a
    price (a minimum stop stated as a share of it, a tick's value at the
    broker's rate) is withheld only where it may have been: a broker our
    listing says sends it as a fixed figure keeps it for the program, which
    would otherwise read a missing minimum stop as SPEC's 0, no minimum at
    all; a broker we do not know withholds it, and the row says so. The
    window gets every key."""
    add_profile("local", terms=LICENCE, extra=("--nested-extra", "--fixed-stops", "3"))
    connect(client, "local")
    win = {r["symbol"]: r for r in client.get("/api/broker/catalog?broker=local",
                                              headers=WIN_GET).json()}
    rows = client.get("/api/broker/catalog?broker=local").json()
    assert rows and sorted(r["symbol"] for r in rows) == sorted(win)
    for r in rows:
        w = win[r["symbol"]]
        assert w["fees"]["x_spread"] > 0 and w["dividend"]["x_yield_pct"] > 0
        assert w["stops_level_points"] == 3
        assert set(r["fees"]) <= {"commission_per_lot", "mode", "rate", "min"}
        assert [set(s) for s in r["sessions"]] == [{"days", "open", "close", "tz"}
                                                    for _ in w["sessions"]]
        assert r["early_closes"] == [{"date": "2026-12-24", "close": "18:00", "tz": "UTC"}]
        assert r["margin_tiers"] == [{"above_notional": 0, "margin_rate": 0.05}]
        assert r["dividend"] == {"ex_date": "2026-12-01", "amount_per_share": 0.5}
        assert "stops_level_points" not in r
        held, why = r["withheld"].split(" withheld under ", 1)
        want = {"dividend.x_yield_pct", "early_closes.x_why", "fees.x_spread",
                "margin_tiers.x_margin_per_unit", "stops_level_points"}
        if w["sessions"]:
            want.add("sessions.x_note")
        assert set(held.split(", ")) == want, r["withheld"]
        assert why == "Fixture Markets' terms: " + LICENCE["summary"]
    # a broker of our own listing that says its adapter's minimum stop is a
    # fixed figure: the program has it, and nothing is said withheld
    listed["args"] = ("--mode", "live", "--fixed-stops", "3")
    listed["priced"] = ()
    json_win = {**WIN_POST, "Content-Type": "application/json"}
    r = client.post("/api/broker/link", json={"name": "my-fixture", "example": "fixture"},
                    headers=json_win)
    assert r.status_code == 200, r.text
    connect(client, "my-fixture")
    rows = client.get("/api/broker/catalog?broker=my-fixture").json()
    assert rows and all(r["stops_level_points"] == 3 and "withheld" not in r for r in rows), rows[0]
    # ...and the same listing saying nothing of how its figures are made, or
    # naming a field that is not one of them (a slip of ours): withheld
    for priced in (None, ("stops_level_point",)):
        if priced is None:
            del listed["priced"]
        else:
            listed["priced"] = priced
        rows = client.get("/api/broker/catalog?broker=my-fixture").json()
        assert rows and all("stops_level_points" not in r for r in rows), priced
        assert all(r["withheld"].startswith("stops_level_points withheld under Fixture Markets' "
                                            "terms") for r in rows), priced


def test_each_listed_row_says_which_figures_its_adapter_works_out_from_a_price(home):
    """Our listing says, per broker, which of SPEC 4's figures its adapter
    works out from a price (`priced`); the rest are fixed and reach a
    program. Held against the adapters' own code where the kit ships them:
    one states its minimum stop as a share of the price at the moment the
    catalog is built, the other two state a fixed number of points, and none
    sends a tick's value in the account's currency."""
    from lse_terminal.engine import broker_hub as bh
    assert {k: ex.get("priced") for k, ex in bh.EXAMPLES.items()} == {
        "alpaca": (), "oanda": (), "capitalcom": ("stops_level_points",)}
    for key, ex in bh.EXAMPLES.items():
        assert set(ex["priced"]) <= set(bh.PRICED_FIELDS), key
    hub = _hub(home)
    try:
        texts = {k: hub._example_path(k) for k in bh.EXAMPLES}
    finally:
        hub.shutdown()
    if not all(texts.values()):
        pytest.skip("the kit's listed adapters are not beside this kit")
    texts = {k: p.read_text() for k, p in texts.items()}
    assert re.search(r'"stops_level_points": 0,', texts["oanda"])
    assert re.search(r'"stops_level_points": 1\}', texts["alpaca"])
    assert re.search(r'"stops_level_points": stops_points,', texts["capitalcom"])
    assert re.search(r"dist = rule_distance\(smin, mid\)", texts["capitalcom"])
    assert not any("tick_value_account" in t for t in texts.values())


def test_the_stream_refuses_a_program_and_streams_to_the_window(client):
    add_profile("local", terms=LICENCE)
    connect(client, "local")
    path = "/api/ws?provider=broker:local&symbols=EURUSD"
    with client.websocket_connect(path, headers={"host": "127.0.0.1"}) as ws:
        msg = ws.receive_json()
    assert msg["type"] == "error"
    assert msg["message"].startswith("Live prices withheld under Fixture Markets' terms")
    with client.websocket_connect(path, headers={"host": "127.0.0.1",
                                                 "origin": "http://127.0.0.1"}) as ws:
        msg = ws.receive_json()
    assert msg["type"] == "tick" and msg["symbol"] == "EURUSD"


# ── the tool dispatcher, through /mcp ─────────────────────────────────────

def _order(e, broker, headers=None):
    st, out = call(e.base, "/api/broker/order", "POST",
                   {"broker": broker, "symbol": "EURUSD", "side": "buy",
                    "qty": 0.01}, headers=headers)
    assert st == 200, out


def _priced(e, broker):
    """Subscribe the held symbol as the dock does, and wait for its quote."""
    st, _ = call(e.base, "/api/broker/subscribe", "POST",
                 {"broker": broker, "symbols": ["EURUSD"]}, headers=e.win_post)
    assert st == 200
    assert wait_for(lambda: call(e.base, f"/api/broker/quotes?broker={broker}",
                                 headers=e.win_get)[1].get("EURUSD"))


def test_get_positions_reports_the_account_and_withholds_its_prices(engine):
    add_profile("local", terms=LICENCE)
    add_profile("plain")
    for b in ("local", "plain"):
        assert call(engine.base, "/api/broker/connect", "POST", {"broker": b})[0] == 200
        _order(engine, b)
        _priced(engine, b)
    err, text = mcp(engine.base, "get_positions")
    assert not err, text
    accts = {a["broker"]: a for a in json.loads(text)["accounts"]}
    local, plain = accts["local"], accts["plain"]
    assert local["prices_withheld"] == ("Current prices, open P/L, equity and margin "
                                        "withheld under Fixture Markets' terms: "
                                        + LICENCE["summary"])
    assert local["account"]["balance"] is not None        # the account's own
    assert "equity" not in local["account"]               # marked to the prices
    assert "unrealized_pnl" not in local["positions"][0]
    assert local["positions"] and local["positions"][0]["price"] is None
    assert "current_price" not in local["positions"][0]
    assert local["positions"][0]["avg_price"] is not None
    # a broker without terms: as before, the price and every field it sent
    assert "prices_withheld" not in plain
    assert isinstance(plain["positions"][0]["price"], float)
    assert "current_price" in plain["positions"][0]


def test_candles_and_the_backtest_tools_refuse_with_the_terms(engine):
    add_profile("local", terms=LICENCE)
    add_profile("plain")
    for b in ("local", "plain"):
        assert call(engine.base, "/api/broker/connect", "POST", {"broker": b})[0] == 200
    err, text = mcp(engine.base, "get_candles",
                    {"provider": "broker:local", "symbol": "EURUSD", "timeframe": "1m"})
    assert err and "EURUSD candles withheld under Fixture Markets' terms" in text
    assert LICENCE["summary"] in text
    err, text = mcp(engine.base, "get_candles",
                    {"provider": "broker:plain", "symbol": "EURUSD", "timeframe": "1m"})
    assert not err and json.loads(text)["candles"]
    # the chart's own provider, from context.json, when none is given
    call(engine.base, "/api/ai/workspace", "POST",
         {"script": "", "provider": "broker:local", "symbol": "EURUSD", "timeframe": "1m"})
    err, text = mcp(engine.base, "get_candles", {})
    assert err and LICENCE["summary"] in text
    bt = {"provider": "broker:local", "symbol": "EURUSD", "timeframe": "1m",
          "script": "trades = []\n"}
    for name, extra in (("run_backtest", {}), ("run_montecarlo", {}),
                        ("run_walkforward", {"params": {"n": "1,2"}})):
        err, text = mcp(engine.base, name, {**bt, **extra})
        assert err and LICENCE["summary"] in text, (name, text)
        assert "results on EURUSD withheld" in text


def test_code_run_for_the_assistant_cannot_read_the_prices(engine):
    """run_python's code is a program like any other: the engine's price
    routes answer it with the sentence, not the prices."""
    add_profile("local", terms=LICENCE)
    add_profile("plain")
    for b in ("local", "plain"):
        assert call(engine.base, "/api/broker/connect", "POST", {"broker": b})[0] == 200
    code = ("import json, urllib.request, urllib.error\n"
            f"for b in ('local', 'plain'):\n"
            f"    u = '{engine.base}/api/candles?provider=broker:' + b + '&symbol=EURUSD&timeframe=1m&limit=5'\n"
            "    try:\n"
            "        r = urllib.request.urlopen(u, timeout=30)\n"
            "        print(b, r.status, len(json.loads(r.read())['candles']))\n"
            "    except urllib.error.HTTPError as e:\n"
            "        print(b, e.code, json.loads(e.read())['detail'])\n")
    err, text = mcp(engine.base, "run_python", {"code": code})
    assert not err, text
    out = json.loads(text)["stdout"]
    assert ("local 403 EURUSD candles withheld under Fixture Markets' terms: "
            + LICENCE["summary"]) in out
    assert re.search(r"^plain 200 \d+$", out, re.M), out


# ── the panel chats' door and the approval bridge ─────────────────────────

@pytest.fixture()
def chat(engine, monkeypatch):
    """An open chat panel (claude), so the engine holds its approval channel:
    a stand-in `claude` on PATH that is never asked a turn."""
    bindir = engine.home / "bin"
    bindir.mkdir()
    fake = bindir / "claude"
    fake.write_text("#!/bin/sh\nexit 0\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    from websockets.sync.client import connect as ws_connect
    with ws_connect(f"ws://127.0.0.1:{engine.port}/api/ai/chat?agent=claude") as ws:
        cfgdir = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"])
        found = wait_for(lambda: list(cfgdir.glob("approve-*.json")), timeout=10)
        assert found, "the chat did not open its approval channel"
        args = json.loads(found[0].read_text())["mcpServers"]["lse_terminal"]["args"]
        token = args[args.index("--engine-token") + 1]
        yield SimpleNamespace(ws=ws, token=token)


def test_the_panel_chats_use_the_same_door(engine, chat):
    add_profile("local", terms=LICENCE)
    assert call(engine.base, "/api/broker/connect", "POST", {"broker": "local"})[0] == 200
    _order(engine, "local")
    st, out = call(engine.base, "/api/ai/tool-run", "POST",
                   {"token": chat.token, "name": "get_candles",
                    "args": {"provider": "broker:local", "symbol": "EURUSD"}})
    assert st == 403 and LICENCE["summary"] in out["detail"]
    st, out = call(engine.base, "/api/ai/tool-run", "POST",
                   {"token": chat.token, "name": "get_positions", "args": {}})
    assert st == 200                    # plain text, which is the tool's JSON
    acct = [a for a in out["accounts"] if a["broker"] == "local"][0]
    assert acct["prices_withheld"] and acct["positions"][0]["price"] is None


def _ask(engine, chat, command):
    """Send one approval request in the background, as the bridge does, and
    return (thread, result holder)."""
    holder = {}

    def run():
        holder["r"] = call(engine.base, "/api/ai/approve-request", "POST",
                           {"token": chat.token, "tool_name": "Bash",
                            "input": {"command": command}}, timeout=60)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, holder


def test_always_allow_never_covers_an_order_on_a_live_by_hand_connection(engine, chat):
    cfgdir = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"])
    conf = cfgdir / "config.json"
    data = json.loads(conf.read_text()) if conf.exists() else {}
    data["ai_always_allow"] = [{"tool": "Bash", "prefix": "curl"}]
    conf.write_text(json.dumps(data))
    order = (f"curl -X POST {engine.base}/api/broker/order -H 'Content-Type: "
             "application/json' -d '{\"broker\": \"live\", \"symbol\": \"EURUSD\", "
             "\"side\": \"buy\", \"qty\": 0.01}'")
    # no such connection: the user's "always" covers it, exactly as before
    t, h = _ask(engine, chat, order)
    t.join(20)
    assert h["r"][1]["behavior"] == "allow"
    add_profile("live", terms=BY_HAND, mode="live")
    assert call(engine.base, "/api/broker/connect", "POST", {"broker": "live"})[0] == 200
    # a command that is not an order still rides the rule
    t, h = _ask(engine, chat, "curl https://example.com/notes.txt")
    t.join(20)
    assert h["r"][1]["behavior"] == "allow"
    # the order: the card is shown, every time
    t, h = _ask(engine, chat, order)
    card = None
    deadline = time.time() + 20
    while time.time() < deadline and card is None:
        msg = json.loads(chat.ws.recv(timeout=20))
        if msg.get("type") == "permission":
            card = msg
    assert card and card["tool"] == "Bash" and "/api/broker/order" in card["detail"]
    chat.ws.send(json.dumps({"type": "permission_reply", "pid": card["pid"],
                             "decision": "deny"}))
    t.join(20)
    assert h["r"][1]["behavior"] == "deny"


# ── the hosted assistant ──────────────────────────────────────────────────

class _FakeAssistant(BaseHTTPRequestHandler):
    """The hosted assistant's protocol, on loopback: the first round asks the
    terminal for two local tools, the second answers. Records every body."""
    seen: list = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).seen.append(body)
        msgs = body.get("messages") or []
        if not any(m.get("role") == "tool" for m in msgs):
            frame = {"lse_round": {"tool_calls": [
                {"id": "c1", "name": "get_positions", "arguments": "{}"},
                {"id": "c2", "name": "get_candles", "arguments": json.dumps(
                    {"provider": "broker:local", "symbol": "EURUSD", "timeframe": "1m"})}]}}
        else:
            frame = {"choices": [{"delta": {"content": "Here is what I can see."}}]}
        out = ("data: " + json.dumps(frame) + "\n\ndata: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def test_the_hosted_assistant_is_sent_no_broker_prices(engine, monkeypatch):
    from lse_terminal.engine import server as srv
    fake = ThreadingHTTPServer(("127.0.0.1", 0), _FakeAssistant)
    _FakeAssistant.seen = []
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(srv, "ASSISTANT_URL",
                            f"http://127.0.0.1:{fake.server_address[1]}/assistant")
        monkeypatch.setenv("LSE_API_KEY", "lse_test_not_a_real_key")
        add_profile("local", terms=LICENCE)
        assert call(engine.base, "/api/broker/connect", "POST", {"broker": "local"})[0] == 200
        _order(engine, "local")
        req = urllib.request.Request(
            engine.base + "/api/assistant", method="POST",
            headers={"Content-Type": "application/json"},
            data=json.dumps({"messages": [{"role": "user", "content": "How is my trade?"}]}).encode())
        with urllib.request.urlopen(req, timeout=120) as r:
            stream = r.read().decode()
        assert "Here is what I can see." in stream
        assert len(_FakeAssistant.seen) == 2
        tools = {m["tool_call_id"]: m["content"]
                 for m in _FakeAssistant.seen[1]["messages"] if m.get("role") == "tool"}
        pos = json.loads(tools["c1"])
        acct = [a for a in pos["accounts"] if a["broker"] == "local"][0]
        assert acct["prices_withheld"].endswith(LICENCE["summary"])
        assert acct["positions"][0]["price"] is None
        assert '"current_price":' not in tools["c1"]          # no such field
        assert "withheld under Fixture Markets' terms" in acct["positions"][0]["withheld"]
        assert LICENCE["summary"] in json.loads(tools["c2"])["error"]
        assert '"candles"' not in tools["c2"]
    finally:
        fake.shutdown()


# ── what the agent CLIs read, and the screenshot ──────────────────────────

def _page_context(provider, dock):
    """The account and screen map as the page sends them, prices in."""
    acct = {"name": "x", "balance": 10000, "equity": 10001,
            "positions": [{"symbol": "EURUSD", "side": "long", "qty": 0.01,
                           "avg_price": 1.1, "price": 1.2, "bid": 1.2, "ask": 1.21,
                           "price_ts": "2026-11-14T15:00:00Z", "price_synthetic": False,
                           "unrealized_pnl": 1.0, "sl_price": 1.0, "tp_price": None,
                           "trail_points": 0},
                          {"symbol": "GBPUSD", "side": "long", "qty": 0.01,
                           "avg_price": 1.3, "price": 1.32, "bid": 1.32, "ask": 1.33,
                           "unrealized_pnl": 2.0, "sl_price": 1.3175, "tp_price": None,
                           "trail_points": 25}]}
    terminal = {"regions": [
        {"id": "chart-wrap", "data": {"symbol": "EURUSD", "last_close": 1.2,
                                      "bid": 1.2, "ask": 1.21, "bars_loaded": 9}},
        {"id": "acct-dock", "data": {"tab": "positions", "broker": dock,
                                     "account": json.loads(json.dumps(acct))}},
        {"id": "trade-panel", "more": ["any other broker: POST /api/broker/order"],
         "data": {"symbol": "EURUSD"}}]}
    return {"script": "", "provider": provider, "symbol": "EURUSD",
            "timeframe": "1m", "view": "MARKETS", "account": acct,
            "terminal": terminal}


def test_context_json_and_the_brief_withhold_and_say_why(client):
    add_profile("both", terms=BOTH, mode="live")
    connect(client, "both")
    ai = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"]) / "ai-workspace"
    ai.mkdir(parents=True, exist_ok=True)
    (ai / "chart.png").write_bytes(b"\x89PNG old")
    r = client.post("/api/ai/workspace", json=_page_context("broker:both", "both"))
    assert r.status_code == 200
    ctx = json.loads((ai / "context.json").read_text())
    pos = ctx["account"]["positions"][0]
    assert [pos[k] for k in ("price", "bid", "ask", "price_ts")] == [None] * 4
    assert (pos["avg_price"], pos["qty"], ctx["account"]["balance"]) == (1.1, 0.01, 10000)
    # the figures marked to the price go with it
    assert pos["unrealized_pnl"] is None and ctx["account"]["equity"] is None
    # a stop the user set stays; a stop the broker trails moves with the price,
    # and the position says its level is held back (a null stop reads as none)
    assert pos["sl_price"] == 1.0 and "withheld" not in pos
    trailed = ctx["account"]["positions"][1]
    assert trailed["sl_price"] is None and trailed["trail_points"] == 25
    assert trailed["withheld"] == (
        "The level of a stop the broker trails withheld under Fixture Markets' "
        "terms, which keep its prices on this computer.")
    # both restrictions in force: the reason for the prices in the terminal's
    # words, since one source's summary may speak of only one of them
    assert ctx["account"]["prices_withheld"] == (
        "Current prices, open P/L, equity and margin withheld under Fixture "
        "Markets' terms, which keep its prices on this computer.")
    regions = {x["id"]: x for x in ctx["terminal"]["regions"]}
    chart = regions["chart-wrap"]["data"]
    assert (chart["last_close"], chart["bid"], chart["ask"]) == (None, None, None)
    assert chart["prices_withheld"].startswith("Chart prices withheld")
    assert regions["acct-dock"]["data"]["account"]["positions"][0]["price"] is None
    docked = regions["acct-dock"]["data"]["account"]["positions"][1]
    assert docked["sl_price"] is None and docked["withheld"] == trailed["withheld"]
    assert regions["trade-panel"]["more"] == [
        "Not sent: under Fixture Markets' terms each order on a live account "
        "is placed by the user, in the terminal's own window."]
    assert any(s.startswith("Screenshot withheld") for s in ctx["withheld"])
    assert not (ai / "chart.png").exists()
    brief = (ai / "CLAUDE.md").read_text()
    assert "## A broker's terms" in brief
    assert ("Fixture Markets' terms keep its prices on this computer and have "
            "you place each order on a live account yourself.") in brief
    assert ("places every order in the terminal's own window (the ticket, the "
            "positions, the chart): the engine refuses an order") in brief
    assert (ai / "AGENTS.md").read_text() == brief
    # a failed snapshot stays one: its error and note, and no invented book
    sent = _page_context("broker:both", "both")
    sent["account"] = {"error": "TypeError: x", "note": "account snapshot failed; call get_positions"}
    assert client.post("/api/ai/workspace", json=sent).status_code == 200
    acct = json.loads((ai / "context.json").read_text())["account"]
    assert (acct["error"], acct["note"]) == ("TypeError: x", sent["account"]["note"])
    assert "positions" not in acct and acct["prices_withheld"]


def test_the_screenshot_is_withheld_while_such_prices_may_be_on_screen(client):
    add_profile("local", terms=LICENCE)
    connect(client, "local")
    ai = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"]) / "ai-workspace"
    ai.mkdir(parents=True, exist_ok=True)
    # nothing pushed yet (the shell's first snapshot at boot): withheld
    (ai / "chart.png").write_bytes(b"\x89PNG")
    out = client.get("/api/ai/capture-allowed").json()
    assert out["allowed"] is False and out["reason"].startswith("Screenshot withheld")
    assert not (ai / "chart.png").exists()
    # the broker charted, or in the dock: withheld
    for provider, dock in (("broker:local", "lse-hosted"), ("lse", "local")):
        client.post("/api/ai/workspace", json=_page_context(provider, dock))
        assert client.get("/api/ai/capture-allowed").json()["allowed"] is False
    # on screen: the LSE chart and the hosted demo; the broker only connected
    client.post("/api/ai/workspace", json=_page_context("lse", "lse-hosted"))
    assert client.get("/api/ai/capture-allowed").json() == {"allowed": True}
    # disconnected: nothing of it can be on screen
    client.post("/api/ai/workspace", json=_page_context("broker:local", "local"))
    client.post("/api/broker/disconnect", json={"broker": "local"})
    assert client.get("/api/ai/capture-allowed").json() == {"allowed": True}


# ── the agent's browse tool ───────────────────────────────────────────────

def test_browse_does_not_read_a_page_that_lands_on_this_machine(monkeypatch):
    """A public page that sends the browser on to this machine (the terminal's
    own page shows a broker's prices) is not read."""
    from lse_terminal.engine import webtools
    state = {"url": "http://127.0.0.1:7799/"}
    reads = []

    class Page:
        @property
        def url(self):
            return state["url"]

        def goto(self, *a, **k):
            pass

        def wait_for_load_state(self, *a, **k):
            pass

        def title(self):
            reads.append("title")
            return "LSE Terminal"

        def content(self):
            reads.append("content")
            return "<p>EURUSD 1.08974 / 1.08994</p>"

        def eval_on_selector_all(self, *a):
            reads.append("links")
            return []

    class Browser:
        def new_page(self, **k):
            return Page()

        def close(self):
            pass

    class PW:
        class chromium:
            @staticmethod
            def launch(**k):
                return Browser()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    mod = types.ModuleType("playwright.sync_api")
    mod.sync_playwright = PW
    pkg = types.ModuleType("playwright")
    pkg.sync_api = mod
    monkeypatch.setitem(sys.modules, "playwright", pkg)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", mod)
    out = webtools.browse("https://93.184.216.34/start")
    assert reads == [], reads                             # nothing of it was read
    assert "1.08974" not in json.dumps(out) and "text" not in out
    assert out["error"].startswith("the page went on to http://127.0.0.1:7799/, "
                                   "which web tools do not read")
    state["url"] = "https://93.184.216.34/next"           # stays public: read
    out = webtools.browse("https://93.184.216.34/start")
    assert out["title"] == "LSE Terminal" and "1.08974" in out["text"]


# ── orders on a live orders_by_hand_only connection ───────────────────────

def test_a_live_by_hand_connection_takes_orders_from_the_window_only(client):
    add_profile("live", terms=BY_HAND, mode="live")
    connect(client, "live")
    no = ("Not sent: under Fixture Markets' terms each order on a live "
          "account is placed by the user, in the terminal's own window.")
    # a program cannot give the consent that lets an order through
    r = client.post("/api/broker/arm", json={"broker": "live", "armed": True})
    assert r.status_code == 403 and r.json()["detail"] == no
    r = client.post("/api/broker/arm", json={"broker": "live", "armed": True},
                    headers=WIN_POST)
    assert r.status_code == 200 and r.json()["armed"] is True
    order = {"broker": "live", "symbol": "EURUSD", "side": "buy", "qty": 0.01}
    r = client.post("/api/broker/order", json=order)
    assert r.status_code == 403 and r.json()["detail"] == no
    r = client.post("/api/broker/order", json=order, headers=WIN_POST)
    assert r.status_code == 200 and r.json()["status"] == "filled"   # the ticket
    pid = r.json()["fill"]["position_id"]
    pend = {**order, "type": "limit", "price": 1.0}
    assert client.post("/api/broker/order/pending", json=pend).status_code == 403
    for path, body in (("/api/broker/modify", {"broker": "live", "position_id": pid,
                                                "sl": None, "tp": None}),
                       ("/api/broker/order/cancel", {"broker": "live", "order_id": "x"}),
                       ("/api/broker/close", {"broker": "live", "position_id": pid})):
        r = client.post(path, json=body)
        assert r.status_code == 403 and r.json()["detail"] == no, path
    r = client.post("/api/broker/modify", json={"broker": "live", "position_id": pid,
                                                "sl": None, "tp": None}, headers=WIN_POST)
    assert r.status_code == 200, r.text                  # the chart's drag handle
    r = client.post("/api/broker/close", json={"broker": "live", "position_id": pid},
                    headers=WIN_POST)
    assert r.status_code == 200, r.text                  # the dock's close
    # taking consent back is open to anyone
    r = client.post("/api/broker/arm", json={"broker": "live", "armed": False})
    assert r.status_code == 200 and r.json()["armed"] is False


def test_a_login_that_reaches_several_accounts_says_so_before_it_connects(client):
    """A live login that reaches several accounts has no account to ask about
    until one is chosen, so Connect cannot ask "allow trading?" of it. The
    row says, from the adapter's own hello, that the login reaches several,
    before any connect. Connecting then asks which account, and the bound
    connection is live and read-only until the user allows trading."""
    add_profile("multi", terms=BY_HAND, mode="live", extra=("--multi-accounts",))
    add_profile("single", terms=BY_HAND, mode="live")
    for b in ("multi", "single"):
        assert client.post("/api/broker/probe", json={"broker": b}).status_code == 200
    rows = _rows(client, WIN_GET)
    assert rows["multi"]["connected"] is False and rows["multi"]["accounts_multi"] is True
    assert "accounts_multi" not in rows["single"]
    r = client.post("/api/broker/connect", json={"broker": "multi"}, headers=WIN_POST)
    assert r.status_code == 200 and r.json()["needs_account"] is True
    assert r.json()["connected"] is False and r.json()["accounts_multi"] is True
    r = client.post("/api/broker/account", json={"broker": "multi", "account_id": "fx-2"},
                    headers=WIN_POST)
    row = r.json()
    assert (row["connected"], row["armed"], row["mode"]) == (True, False, "live")
    assert row["account_id"] == "fx-2" and row["accounts_multi"] is True


def test_a_profile_remembered_before_its_accounts_were_is_asked_again(home, monkeypatch):
    """A profile linked by the build before this one is remembered without
    whether its login reaches several accounts. That is not the same as one
    account: its row says it is not known (null), and a probe does not stop
    at the remembered name but asks the adapter once, after which it is
    remembered either way. A login known to reach one account is not asked
    again."""
    from lse_terminal.engine.server import create_app
    add_profile("multi", terms=BY_HAND, mode="live", extra=("--multi-accounts",))
    add_profile("single", terms=BY_HAND, mode="live")
    first = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        for b in ("multi", "single"):
            assert first.post("/api/broker/probe", json={"broker": b}).status_code == 200
    finally:
        first.app.state.broker_hub.shutdown()
    cache = home / "cfg" / "broker_identity.json"
    d = json.loads(cache.read_text())
    assert d["brokers"]["multi"]["multi"] is True and d["brokers"]["single"]["multi"] is False
    for rec in d["brokers"].values():
        rec.pop("multi", None)                     # what the build before it kept
    cache.write_text(json.dumps(d))
    again = TestClient(create_app(), base_url="http://127.0.0.1")
    try:
        hub = again.app.state.broker_hub
        rows = _rows(again, WIN_GET)
        for b in ("multi", "single"):
            assert rows[b]["identity"]["display_name"] and rows[b]["mode"] == "live"
            assert rows[b]["accounts_multi"] is None, rows[b]   # not known, not "one"
        spawned = []
        real = hub._new_connector
        monkeypatch.setattr(hub, "_new_connector", lambda b: spawned.append(b) or real(b))
        r = again.post("/api/broker/probe", json={"broker": "multi"}, headers=WIN_POST)
        assert r.status_code == 200 and r.json()["accounts_multi"] is True
        r = again.post("/api/broker/probe", json={"broker": "single"}, headers=WIN_POST)
        assert r.status_code == 200 and "accounts_multi" not in r.json()
        assert spawned == ["multi", "single"]
        # known now, either way: a probe stops at the remembered answer
        for b in ("multi", "single"):
            assert again.post("/api/broker/probe", json={"broker": b}).status_code == 200
        assert spawned == ["multi", "single"]
        assert json.loads(cache.read_text())["brokers"]["single"]["multi"] is False
    finally:
        again.app.state.broker_hub.shutdown()


def test_on_paper_a_by_hand_connection_trades_as_before(client):
    add_profile("demo", terms=BY_HAND, mode="paper")
    connect(client, "demo")
    row = {b["broker"]: b for b in client.get("/api/broker/list").json()}["demo"]
    assert row["terms"]["orders_by_hand_only"] is True
    assert "by_hand" not in row["terms"]                 # paper: not bound
    assert row["terms"]["said"] == BY_HAND["summary"]     # still shown
    r = client.post("/api/broker/order", json={"broker": "demo", "symbol": "EURUSD",
                                               "side": "buy", "qty": 0.01})
    assert r.status_code == 200 and r.json()["status"] == "filled"


# ── no order tool, and the strategy runner ────────────────────────────────

def test_no_assistant_tool_places_an_order(client):
    from lse_terminal.engine.approve_bridge import CAPABILITY_TOOLS
    hosted = [t["name"] for t in client.get("/api/assistant/tools").json()["tools"]]
    names = [t["name"] for t in CAPABILITY_TOOLS] + hosted
    trading = re.compile(r"order|close|flatten|modify|cancel|buy|sell|trade|^arm", re.I)
    assert names and not [n for n in names if trading.search(n)], names


def test_the_strategy_runner_only_runs_the_kits_paper_adapter(client, monkeypatch):
    seen = []

    class Proc:
        returncode = None

        def poll(self):
            return None

    def popen(cmd, *a, **k):
        seen.append(list(cmd))
        return Proc()

    monkeypatch.setattr(subprocess, "Popen", popen)
    add_profile("live", terms=BY_HAND, mode="live")
    r = client.post("/api/algo/start", json={"script": "x", "symbol": "EURUSD",
                                             "broker": "live", "adapter": "python3 x.py"})
    assert r.status_code == 200, r.text
    cmd = seen[-1]
    adapter = cmd[cmd.index("--adapter") + 1]
    assert re.search(r"adapters[/\\]paper[/\\]paper_adapter\.py' --tick-ms 200$|"
                     r"adapters[/\\]paper[/\\]paper_adapter\.py --tick-ms 200$", adapter)
    # Nothing of the live profile is passed on. The folders the command names
    # (the kit's, the interpreter's, this test's config) are left out of the
    # check: a kit kept under a folder named "...live..." is not that profile.
    from lse_terminal.engine.broker_hub import connect_base
    words = " ".join(cmd)
    for folder in sorted({str(connect_base(None)), sys.executable,
                          os.environ["LSE_TERMINAL_CONFIG_DIR"]}, key=len, reverse=True):
        words = words.replace(folder, "")
    assert "--broker" not in cmd and "live" not in words.replace("live_driver", "")


# ── a connection with no terms behaves exactly as before ──────────────────

def test_connections_without_terms_behave_exactly_as_before(client):
    """The paper adapter, a user's own adapter that declares nothing, and the
    LSE demo account (unconnectable here: no key): every path as before."""
    add_profile("mine")
    for b in ("paper", "mine"):
        connect(client, b)
    rows = {b["broker"]: b for b in client.get("/api/broker/list").json()}
    for b in ("paper", "mine", "lse-sim"):
        assert rows[b]["terms"] == {"data_local_only": False,
                                    "orders_by_hand_only": False}, b
    for b in ("paper", "mine"):
        src = f"provider=broker:{b}&symbol=EURUSD&timeframe=1m&limit=20"
        assert client.get(f"/api/candles?{src}").status_code == 200
        assert client.get(f"/api/prices?provider=broker:{b}&symbols=EURUSD").status_code == 200
        assert client.post("/api/broker/subscribe", json={"broker": b, "symbols": ["EURUSD"]}).status_code == 200
        assert wait_for(lambda: client.get(f"/api/broker/quotes?broker={b}").json().get("EURUSD"))
        r = client.post("/api/broker/order", json={"broker": b, "symbol": "EURUSD",
                                                   "side": "buy", "qty": 0.01})
        assert r.status_code == 200 and r.json()["status"] == "filled"
        full = client.get(f"/api/broker/positions?broker={b}").json()
        assert full and "withheld" not in full[0]
        with client.websocket_connect(f"/api/ws?provider=broker:{b}&symbols=EURUSD",
                                      headers={"host": "127.0.0.1"}) as ws:
            assert ws.receive_json()["type"] == "tick"
        bt = {"engine": "python", "provider": f"broker:{b}", "symbol": "EURUSD",
              "timeframe": "1m", "script": "trades = []\n"}
        assert client.post("/api/backtest", json=bt).status_code == 200
    assert "current_price" in client.get("/api/broker/positions?broker=mine").json()[0]
    # the LSE demo account: refused for being unconnected, as before, not for terms
    assert client.get("/api/broker/quotes?broker=lse-sim").status_code == 409
    assert client.post("/api/broker/order", json={"broker": "lse-sim", "symbol": "EURUSD",
                                                  "side": "buy", "qty": 1}).status_code == 409
    # what the agents read is what the page sent, the screenshot stays
    ai = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"]) / "ai-workspace"
    ai.mkdir(parents=True, exist_ok=True)
    (ai / "chart.png").write_bytes(b"\x89PNG")
    sent = _page_context("broker:mine", "mine")
    client.post("/api/ai/workspace", json=sent)
    ctx = json.loads((ai / "context.json").read_text())
    assert ctx["account"] == sent["account"] and ctx["terminal"] == sent["terminal"]
    assert "withheld" not in ctx
    assert "## A broker's terms" not in (ai / "CLAUDE.md").read_text()
    assert (ai / "chart.png").exists()
    assert client.get("/api/ai/capture-allowed").json() == {"allowed": True}


def test_without_terms_the_tools_answer_as_before(engine):
    add_profile("mine")
    assert call(engine.base, "/api/broker/connect", "POST", {"broker": "mine"})[0] == 200
    _order(engine, "mine")
    _priced(engine, "mine")
    err, text = mcp(engine.base, "get_positions")
    acct = [a for a in json.loads(text)["accounts"] if a["broker"] == "mine"][0]
    assert not err and "prices_withheld" not in acct
    assert isinstance(acct["positions"][0]["price"], float)
    err, text = mcp(engine.base, "get_candles", {"provider": "broker:mine",
                                                 "symbol": "EURUSD", "timeframe": "1m"})
    assert not err and json.loads(text)["candles"]
    err, text = mcp(engine.base, "run_backtest", {"provider": "broker:mine", "symbol": "EURUSD",
                                                  "timeframe": "1m", "script": "trades = []\n"})
    assert not err and "trades: 0" in text


# ── the kit's own rule (Brue Connect 1.11) and the terminal's word ─────────

def test_the_kit_arms_a_live_by_hand_connection_only_on_the_terminals_word(client):
    """The kit refuses arm() on a live orders_by_hand_only connection unless
    the platform says every order it sends is the user's own (SPEC 3.3). The
    terminal says so only from its own window, where it is true."""
    from brueconnect.client import NotArmed
    add_profile("live", terms=BY_HAND, mode="live")
    connect(client, "live")
    conn = client.hub.conns["live"]
    with pytest.raises(NotArmed):
        conn.arm("a program arming the kit's connector itself")
    assert conn.armed is False
    r = client.post("/api/broker/arm", json={"broker": "live", "armed": True},
                    headers=WIN_POST)
    assert r.status_code == 200 and r.json()["armed"] is True
    assert conn.armed_for == "armed from the terminal"


def test_an_older_kit_is_armed_with_the_reason_alone():
    """A kit from before the by_hand word: BrokerHub.arm on a live by-hand
    connection calls its arm(reason) with the reason alone."""
    from lse_terminal.engine import broker_hub
    from brueconnect import Connector

    class Old:
        armed_for = None

        def arm(self, reason):
            self.armed_for = reason
            return reason

        @property
        def armed(self):
            return self.armed_for is not None

    old = Old()
    hub = SimpleNamespace(_require=lambda b: None, _conn=lambda b: old,
                          terms_of=lambda b: {"data_local_only": False,
                                              "orders_by_hand_only": True})
    out = broker_hub.BrokerHub.arm(hub, "live", True, "the user's own click")
    assert out == {"broker": "live", "armed": True,
                   "reason": "the user's own click"}
    assert broker_hub._arm_takes_by_hand(old) is False
    assert broker_hub._arm_takes_by_hand(Connector(["true"])) is True


def test_every_listed_row_states_its_adapters_terms():
    """A listed row is drawn before its adapter has ever run, so its terms
    are written in EXAMPLES; the adapter declares its own in hello. The two
    must say the same, or the row tells the user one thing and the
    connection does another."""
    import importlib
    from brueconnect import protocol
    from brueconnect.adapter import Adapter
    from lse_terminal.engine import broker_hub
    for key, ex in broker_hub.EXAMPLES.items():
        mod = importlib.import_module(
            "brueconnect." + ".".join(ex["path"])[: -len(".py")])
        classes = [c for c in vars(mod).values()
                   if isinstance(c, type) and issubclass(c, Adapter)
                   and c is not Adapter and c.__module__ == mod.__name__]
        assert classes, key
        declared = protocol.sanitize_terms(classes[0].terms or None)
        listed = broker_hub.clean_terms(ex.get("terms"))
        assert listed == declared, key


def test_the_alpaca_row_keeps_its_prices_on_this_computer():
    from lse_terminal.engine import broker_hub
    t = broker_hub.clean_terms(broker_hub.EXAMPLES["alpaca"]["terms"])
    assert t["data_local_only"] is True and t["orders_by_hand_only"] is False
    assert t["url"].startswith("https://files.alpaca.markets/")
    assert broker_hub.withheld_text("Alpaca", t, "AAPL candles") == (
        "AAPL candles withheld under Alpaca's terms: Alpaca licenses its market "
        "data for your own personal, non-commercial use, so its prices stay on "
        "this computer.")


def test_checkpoints_keep_no_copy_of_the_screens_prices(engine, chat):
    """context.json carries the screen's prices and is written again from the
    page before every turn: no checkpoint keeps it, a revert never restores
    it, and one an earlier build left in a checkpoint goes at the next turn."""
    ai = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"]) / "ai-workspace"
    ai.mkdir(parents=True, exist_ok=True)
    old = ai / ".checkpoints" / "0ldbuild"
    old.mkdir(parents=True)
    (old / "context.json").write_text('{"terminal": {"bid": 1.08931}}')
    (old / "strategy.py").write_text("trades = []\n")
    (ai / "context.json").write_text('{"now": true}')
    (ai / "strategy.py").write_text("x = 1\n")
    chat.ws.send(json.dumps({"type": "user", "text": "hello"}))
    cid, deadline = None, time.time() + 30
    while cid is None and time.time() < deadline:
        m = json.loads(chat.ws.recv(timeout=30))
        if m.get("type") == "checkpoint":
            cid = m["id"]
    assert cid, "the turn made no checkpoint"
    made = ai / ".checkpoints" / cid
    assert (made / "strategy.py").read_text() == "x = 1\n"
    assert not (made / "context.json").exists()
    assert not (old / "context.json").exists()        # the earlier build's copy
    assert (old / "strategy.py").exists()              # its user files stay
    # a checkpoint that still holds one (copied in by hand, say) is not
    # restored over the page's own
    (old / "context.json").write_text('{"terminal": {"bid": 1.08931}}')
    status, body = call(engine.base, "/api/ai/revert", "POST", {"id": "0ldbuild"})
    assert status == 200 and "context.json" not in body["restored"], body
    assert "strategy.py" in body["restored"]
    assert (ai / "context.json").read_text() == '{"now": true}'


# ── a broker's own words, and a stop the broker trails ─────────────────────

def test_a_brokers_refusal_reaches_a_program_without_its_figures(client):
    """The paper engine refuses an order too big for the account with
    'insufficient_margin: need N, free F', and N gives the ask back. On a
    data_local_only connection a program gets the code and the terms; the
    window, whose ticket shows the reason, gets the broker's words."""
    add_profile("local", terms=LICENCE)
    add_profile("plain")
    for b in ("local", "plain"):
        connect(client, b)
    big = {"symbol": "EURUSD", "side": "buy", "qty": 500}
    r = client.post("/api/broker/order", json={"broker": "local", **big})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == ("insufficient_margin: The broker's reason withheld "
                                  "under Fixture Markets' terms: " + LICENCE["summary"])
    r = client.post("/api/broker/order", json={"broker": "local", **big},
                    headers=WIN_POST)
    assert r.status_code == 400 and "need" in r.json()["detail"]   # the ticket's
    r = client.post("/api/broker/order", json={"broker": "plain", **big})
    assert r.status_code == 400 and "need" in r.json()["detail"]   # no terms: as before
    assert client.get("/api/broker/positions?broker=local").json() == []
    # The same on every route that relays the broker's reason: a resting
    # order too big (paper prices it at the ask), a change or close of a
    # position that is not there, a cancel paper does not do.
    reason = "The broker's reason withheld under Fixture Markets' terms: " + LICENCE["summary"]
    for path, body, code, words in (
            ("/api/broker/order/pending", {"symbol": "EURUSD", "side": "buy", "qty": 500,
                                           "type": "limit", "price": 1.0},
             "insufficient_margin", "need"),
            ("/api/broker/modify", {"position_id": "nope", "sl": 1.0, "tp": None},
             "not_found", "no such position"),
            ("/api/broker/close", {"position_id": "nope"}, "not_found", "no such position"),
            ("/api/broker/order/cancel", {"order_id": "nope"}, "unsupported", "not supported")):
        r = client.post(path, json={"broker": "local", **body})
        assert (r.status_code, r.json()["detail"]) == (400, f"{code}: {reason}"), path
        r = client.post(path, json={"broker": "local", **body}, headers=WIN_POST)
        assert r.status_code == 400 and words in r.json()["detail"], (path, r.text)
        r = client.post(path, json={"broker": "plain", **body})
        assert r.status_code == 400 and words in r.json()["detail"], (path, r.text)


def _rows(c, headers=None):
    return {x["broker"]: x for x in c.get("/api/broker/list", headers=headers or {}).json()}


def test_a_programs_rows_carry_none_of_the_adapters_words(client, tmp_path):
    """An adapter's session detail, a failed connect's message and the lines
    it printed are its own words, and they can carry its prices ("last bid
    1.0908", "the positions are worth ..."). On a data_local_only connection
    a program reading the rows, or a read or a connect that fails, gets the
    error code and the sentence; the window, whose Connections card shows
    them, gets the words; a connection without terms is as before."""
    sick = tmp_path / "account.fails"
    for b, terms in (("local", LICENCE), ("plain", None)):
        add_profile(b, terms=terms, extra=("--degrade", "--fail-account", str(sick)))
        r = client.post("/api/broker/connect", json={"broker": b}, headers=WIN_POST)
        assert r.status_code == 200, r.text
    words = "The broker's own words withheld under Fixture Markets' terms: " + LICENCE["summary"]
    reason = "The broker's reason withheld under Fixture Markets' terms: " + LICENCE["summary"]
    rows, wrows = _rows(client), _rows(client, WIN_GET)
    assert rows["local"]["session"] == {"state": "degraded", "detail": words}
    assert "last bid" in wrows["local"]["session"]["detail"]
    assert "last bid" in rows["plain"]["session"]["detail"]
    # a read that fails
    sick.write_text("x")
    r = client.get("/api/broker/account?broker=local")
    assert (r.status_code, r.json()["detail"]) == (400, "x_fixture_account: " + reason)
    r = client.get("/api/broker/account?broker=local", headers=WIN_GET)
    assert r.status_code == 400 and "while EURUSD was" in r.json()["detail"]
    r = client.get("/api/broker/account?broker=plain")
    assert r.status_code == 400 and "while EURUSD was" in r.json()["detail"]
    # a connect that fails after its account read, and the rows after it
    for b in ("local", "plain"):
        client.post("/api/broker/disconnect", json={"broker": b}, headers=WIN_POST)
    r = client.post("/api/broker/connect", json={"broker": "local"})
    assert (r.status_code, r.json()["detail"]) == (400, "x_fixture_account: " + reason)
    r = client.post("/api/broker/connect", json={"broker": "plain"})
    assert r.status_code == 400 and "while EURUSD was" in r.json()["detail"]
    rows, wrows = _rows(client), _rows(client, WIN_GET)
    failed = rows["local"]["last_error"]
    assert (failed["message"], failed["stderr"]) == ("x_fixture_account: " + words, words)
    assert isinstance(failed["at"], int) and "session" not in rows["local"]
    assert "EURUSD bid" in wrows["local"]["last_error"]["stderr"]
    assert "while EURUSD was" in wrows["local"]["last_error"]["message"]
    assert "EURUSD bid" in rows["plain"]["last_error"]["stderr"]
    r = client.post("/api/broker/probe", json={"broker": "local"})
    assert r.status_code == 200 and r.json()["last_error"] == failed
    # The first connect of a profile whose terms come with that connect's own
    # hello: decided after the call, so this one is withheld too.
    add_profile("fresh", terms=LICENCE, extra=("--fail-account", str(sick)))
    r = client.post("/api/broker/connect", json={"broker": "fresh"})
    assert (r.status_code, r.json()["detail"]) == (400, "x_fixture_account: " + reason)
    assert _rows(client)["fresh"]["last_error"]["stderr"] == words
    # The login's accounts: the account's own record (SPEC 4's names) only.
    acct = {"id": "a1", "label": "Main", "currency": "USD", "mode": "paper",
            "balance": 100.0, "selected": True, "equity": 101.5, "nav": 101.5}
    client.hub.account_lists["local"] = [dict(acct)]
    client.hub.account_lists["plain"] = [dict(acct)]
    kept = {k: v for k, v in acct.items() if k not in ("equity", "nav")}
    assert _rows(client)["local"]["accounts"] == [kept]
    assert _rows(client, WIN_GET)["local"]["accounts"] == [acct]
    assert _rows(client)["plain"]["accounts"] == [acct]


def test_a_programs_own_connect_carries_none_of_the_adapters_words(client):
    """A program's own connect that succeeds answers with the broker's row,
    and on a data_local_only connection that row's session detail is the
    sentence, not the adapter's words ("last bid ..."). The window's own
    connect, and a connection without terms, get the words."""
    for b, terms in (("local", LICENCE), ("plain", None)):
        add_profile(b, terms=terms, extra=("--degrade",))
    words = "The broker's own words withheld under Fixture Markets' terms: " + LICENCE["summary"]
    r = client.post("/api/broker/connect", json={"broker": "local"})
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is True
    assert r.json()["session"] == {"state": "degraded", "detail": words}
    r = client.post("/api/broker/connect", json={"broker": "local"}, headers=WIN_POST)
    assert r.status_code == 200 and "last bid" in r.json()["session"]["detail"]
    r = client.post("/api/broker/connect", json={"broker": "plain"})
    assert r.status_code == 200 and "last bid" in r.json()["session"]["detail"]


def test_a_programs_account_choice_that_fails_carries_the_code_and_the_sentence(
        client, tmp_path):
    """Choosing the account reconnects the broker; when that connect's account
    read fails, a program on a data_local_only connection gets the error code
    and the sentence, not the adapter's reason ("while EURUSD was ...")."""
    sick = tmp_path / "account.fails"
    for b, terms in (("local", LICENCE), ("plain", None)):
        add_profile(b, terms=terms, extra=("--fail-account", str(sick)))
        connect(client, b)
    reason = "The broker's reason withheld under Fixture Markets' terms: " + LICENCE["summary"]
    sick.write_text("x")
    r = client.post("/api/broker/account", json={"broker": "local", "account_id": ""})
    assert (r.status_code, r.json()["detail"]) == (400, "x_fixture_account: " + reason)
    r = client.post("/api/broker/account", json={"broker": "local", "account_id": ""},
                    headers=WIN_POST)
    assert r.status_code == 400 and "while EURUSD was" in r.json()["detail"]
    r = client.post("/api/broker/account", json={"broker": "plain", "account_id": ""})
    assert r.status_code == 400 and "while EURUSD was" in r.json()["detail"]


def test_a_programs_account_choice_that_succeeds_carries_none_of_the_adapters_words(client):
    """The other half of the account route: a choice that succeeds answers
    with the broker's row, reconnected on the chosen account, and on a
    data_local_only connection a program's row says the sentence where the
    adapter's session detail quotes the last bid. The window, and a
    connection without terms, get the words."""
    for b, terms in (("local", LICENCE), ("plain", None)):
        add_profile(b, terms=terms, extra=("--degrade",))
        connect(client, b)
    words = "The broker's own words withheld under Fixture Markets' terms: " + LICENCE["summary"]
    r = client.post("/api/broker/account", json={"broker": "local", "account_id": ""})
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is True
    assert r.json()["session"] == {"state": "degraded", "detail": words}
    r = client.post("/api/broker/account", json={"broker": "local", "account_id": ""},
                    headers=WIN_POST)
    assert r.status_code == 200 and "last bid" in r.json()["session"]["detail"]
    r = client.post("/api/broker/account", json={"broker": "plain", "account_id": ""})
    assert r.status_code == 200 and "last bid" in r.json()["session"]["detail"]


def test_a_data_local_adapters_printed_lines_stay_off_the_engines_own_log(
        client, tmp_path, monkeypatch):
    """What a linked adapter prints is kept for its Connections card and also
    written to the engine's own stderr, which the desktop shell keeps in a
    file (engine.log). An adapter's lines can quote its prices ("EURUSD bid
    ..."), so for a data_local_only connection they are kept for the card
    only, and the engine's stderr says where they are instead. A connection
    without terms writes them through as before."""
    import io
    log = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True)
    monkeypatch.setattr(sys, "stderr", log)
    seen = lambda: log.buffer.getvalue().decode("utf-8", "replace")  # noqa: E731
    sick = tmp_path / "account.fails"
    for b, terms, shown in (("local", LICENCE, "Fixture Markets"),
                            ("plain", None, "Plain Markets")):
        add_profile(b, terms=terms, extra=("--fail-account", str(sick), "--display", shown))
        connect(client, b)
    sick.write_text("x")
    for b in ("local", "plain"):
        assert client.get(f"/api/broker/account?broker={b}", headers=WIN_GET).status_code == 400
    assert wait_for(lambda: "(Plain Markets): account read; EURUSD bid" in seen())
    assert wait_for(lambda: "[local] " in seen())
    out = seen()
    assert "(Fixture Markets): account read" not in out, out
    note = [line for line in out.splitlines() if line.startswith("[local] ")]
    assert note == [("[local] Lines this adapter printed withheld under Fixture Markets' "
                     "terms: " + LICENCE["summary"] + " Its Connections card shows them.")]
    # the window's card still has them: a connect that fails shows its tail
    client.post("/api/broker/disconnect", json={"broker": "local"}, headers=WIN_POST)
    r = client.post("/api/broker/connect", json={"broker": "local"}, headers=WIN_POST)
    assert r.status_code == 400
    tail = _rows(client, WIN_GET)["local"]["last_error"]["stderr"]
    assert "(Fixture Markets): account read; EURUSD bid" in tail
    assert "(Fixture Markets): account read" not in seen()


def _stderr_capture(monkeypatch):
    import io
    log = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", write_through=True)
    monkeypatch.setattr(sys, "stderr", log)
    return lambda: log.buffer.getvalue().decode("utf-8", "replace")


def test_a_connected_adapters_printed_lines_are_on_its_card(client, monkeypatch):
    """The engine's own log (engine.log) says a data_local_only adapter's
    lines are on its Connections card, and they are, for a session that
    connected too: the window's row carries what the adapter printed while
    connected, after it is disconnected, and after it dies mid-session and is
    connected again, the earlier run's lines kept before the new run's. A
    program reading the rows gets the sentence in their place; a connection
    without terms has its lines on its row and in the log, as before."""
    seen = _stderr_capture(monkeypatch)
    for b, terms, shown in (("local", LICENCE, "Fixture Markets"),
                            ("plain", None, "Plain Markets")):
        add_profile(b, terms=terms, extra=("--say-account", "--display", shown))
        connect(client, b)
    for b in ("local", "plain"):
        assert client.get(f"/api/broker/account?broker={b}", headers=WIN_GET).status_code == 200
    line = "(Fixture Markets): account read; EURUSD bid"
    printed = lambda: _rows(client, WIN_GET)["local"].get("printed") or ""  # noqa: E731
    assert wait_for(lambda: line in printed()), _rows(client, WIN_GET)["local"]
    assert _rows(client, WIN_GET)["local"]["connected"] is True
    assert wait_for(lambda: "(Plain Markets): account read; EURUSD bid" in seen())
    assert line not in seen()
    notes = [x for x in seen().splitlines() if x.startswith("[local] ")]
    assert notes == [("[local] Lines this adapter printed withheld under Fixture Markets' "
                      "terms: " + LICENCE["summary"] + " Its Connections card shows them.")]
    words = "The broker's own words withheld under Fixture Markets' terms: " + LICENCE["summary"]
    assert _rows(client)["local"]["printed"] == words                    # a program
    assert "(Plain Markets): account read" in _rows(client)["plain"]["printed"]
    # reading the rows does not wait on a live adapter's lines: its stderr
    # never ends while it runs (a wait for it cost a second a connection)
    took = []
    for _ in range(3):
        t0 = time.monotonic()
        _rows(client, WIN_GET)
        took.append(time.monotonic() - t0)
    assert sorted(took)[1] < 0.8, took
    # disconnected: still on the card
    client.post("/api/broker/disconnect", json={"broker": "local"}, headers=WIN_POST)
    row = _rows(client, WIN_GET)["local"]
    assert row["connected"] is False and line in row["printed"]
    # a session that dies: no failure to show, and what it printed is still there
    connect(client, "local")
    proc = client.hub.conns["local"].proc
    proc.kill()
    proc.wait(10)
    assert wait_for(lambda: not _rows(client, WIN_GET)["local"]["connected"])
    row = _rows(client, WIN_GET)["local"]
    assert "last_error" not in row and line in row["printed"]
    # ...and connected again, the run that died is kept before the new one
    connect(client, "local")
    assert client.get("/api/broker/account?broker=local", headers=WIN_GET).status_code == 200
    assert wait_for(lambda: printed().count(line) >= 2), printed()
    assert line not in seen()
    assert _rows(client)["local"]["printed"] == words


def test_a_listed_or_declared_data_local_adapters_lines_stay_off_the_log_while_it_is_linked(
        client, listed, monkeypatch, tmp_path):
    """Linking runs the adapter once, before the profile exists. For a row
    of our listing whose terms keep its prices on this computer, its lines
    stay off the engine's log from the first byte, as they do once it is a
    profile; for an adapter of the user's own, from its hello, which says
    its terms. Either way they are on its card."""
    seen = _stderr_capture(monkeypatch)
    listed["args"] = ("--mode", "live", "--say-start", "--say-bye")
    json_win = {**WIN_POST, "Content-Type": "application/json"}
    r = client.post("/api/broker/link", json={"name": "my-fixture", "example": "fixture"},
                    headers=json_win)
    assert r.status_code == 200, r.text
    assert wait_for(lambda: "closing; EURUSD bid" in (
        _rows(client, WIN_GET)["my-fixture"].get("printed") or ""))
    row = _rows(client, WIN_GET)["my-fixture"]
    assert "(Fixture Markets): starting; EURUSD bid" in row["printed"]
    assert "EURUSD bid" not in seen(), seen()
    # an adapter of the user's own whose hello declares the terms
    own = tmp_path / "own_adapter.py"
    own.write_text(FIXTURE.read_text())
    r = client.post("/api/broker/link", headers=json_win, json={
        "name": "own-local", "python_file": str(own),
        "args": ["--terms", json.dumps(LICENCE), "--say-bye"]})
    assert r.status_code == 200, r.text
    assert wait_for(lambda: "closing; EURUSD bid" in (
        _rows(client, WIN_GET)["own-local"].get("printed") or ""))
    assert "EURUSD bid" not in seen(), seen()
    assert "[own-local] Lines this adapter printed withheld" in seen()


def test_a_failure_that_may_quote_the_adapter_is_withheld_too(client, monkeypatch):
    """A 502 is the kit's own words when the adapter is gone or silent, kept;
    any other may quote what the adapter sent, and is withheld like a 400."""
    from brueconnect.client import Disconnected
    add_profile("local", terms=LICENCE)
    add_profile("plain")
    for b in ("local", "plain"):
        connect(client, b)

    def odd(broker):
        raise ValueError("could not convert string to float: '1.08976 (bid)'")

    monkeypatch.setattr(client.hub, "catalog", odd)
    r = client.get("/api/broker/catalog?broker=local")
    assert (r.status_code, r.json()["detail"]) == (
        502, "The broker's reason withheld under Fixture Markets' terms: " + LICENCE["summary"])
    r = client.get("/api/broker/catalog?broker=local", headers=WIN_GET)
    assert r.status_code == 502 and "1.08976" in r.json()["detail"]
    r = client.get("/api/broker/catalog?broker=plain")
    assert r.status_code == 502 and "1.08976" in r.json()["detail"]

    def gone(broker):
        raise Disconnected("adapter not running")

    monkeypatch.setattr(client.hub, "catalog", gone)
    r = client.get("/api/broker/catalog?broker=local")
    assert (r.status_code, r.json()["detail"]) == (502, "adapter not running")


def test_a_stop_the_broker_trails_is_not_a_level_the_user_set():
    from lse_terminal.engine.broker_hub import record_only
    kept, dropped = record_only({"position_id": "p1", "symbol": "EURUSD",
                                 "side": "buy", "qty": 1, "avg_price": 1.08,
                                 "sl": 1.0895, "trail_points": 20,
                                 "unrealized_pnl": 3, "current_price": 1.0915})
    assert "sl" not in kept and kept["trail_points"] == 20
    assert {"sl", "unrealized_pnl", "current_price"} <= set(dropped)
    kept, dropped = record_only({"position_id": "p2", "sl": 1.07, "trail_points": 0})
    assert kept["sl"] == 1.07 and dropped == []        # a stop the user set stays
