"""One press of Connect connects a broker whose cold handshake guessed its
account (Brue Connect SPEC 6, `reconnect`).

An adapter answers `hello` before it has read anything (SPEC 3.1), so it may
state its account's currency and model by a guess. When the session it opens
shows the guess was wrong, it remembers what it read and refuses the connect
with `reconnect`: start it again, and its next hello says the truth. The
kit's Connector does that by itself inside the connect, once, and the engine
connects through it (BrokerHub.connect: hello, the account gate, reconcile).

What is pinned here, through the engine's routes:
  - the listed row linked with a one-account practice token whose account is
    not the guess: one press of Connect answers 200, connected, on the
    account the second process read; the card never shows the refusal's
    words; the engine's own access log holds one POST /api/broker/connect;
    and the stand-in, which allows two new connections a second, refused
    none of the two processes' connections;
  - a login that reaches several accounts, none chosen, still waits on its
    chooser with no session opened, and connects on the account chosen;
  - the same with a fixture adapter, which needs no stand-in beside the kit;
  - an adapter whose process started again asks again: a 400 in plain words,
    on the card too, and two processes, never a third;
  - the process started again has its stderr drained and kept for the card
    as the first one's is: the hub hands the kit's on_start its tail, and
    with a kit from before on_start it drains the one process as before.

No broker's API is called: the brokers are the kit's stand-in on 127.0.0.1
and fixture adapters (tests/data).
"""
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_broker_terms import (WIN_GET, WIN_POST, _free_port, add_profile,  # noqa: F401
                               call, client, home, wait_for)
from test_order_answer_lost import _kit_standin

RECONNECT = Path(__file__).resolve().parent / "data" / "reconnect_adapter.py"
JSON_WIN = {**WIN_POST, "Content-Type": "application/json"}
# The refusal's own words, which the card must never show after one press.
REFUSAL = ("handshake said", "now remembered", "reconnect, and the handshake",
           "x_oanda_reconnect", "x_reconnect")


@pytest.fixture()
def logged_engine(home):
    """The engine on a real loopback port with its access log kept, as the
    desktop shell keeps the engine's log: one line per request, its status.
    Stopped, and its adapters with it."""
    import uvicorn
    from lse_terminal.engine.server import create_app
    app = create_app()
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="info",
        access_log=True, lifespan="on"))
    lines = []

    class Keep(logging.Handler):
        def emit(self, record):
            lines.append(record.getMessage())

    keep = Keep()
    access = logging.getLogger("uvicorn.access")
    access.addHandler(keep)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "the engine did not start"
    base = f"http://127.0.0.1:{port}"
    yield SimpleNamespace(base=base, hub=app.state.broker_hub, access=lines,
                          win_get={"Sec-Fetch-Site": "same-origin"},
                          win_post={"Sec-Fetch-Site": "same-origin",
                                    "Origin": base})
    server.should_exit = True
    t.join(15)
    app.state.broker_hub.shutdown()
    access.removeHandler(keep)


def _standin(division):
    fake_oanda = _kit_standin("fake_oanda")
    if fake_oanda is None:
        pytest.skip("the kit's stand-in is not beside this kit (a wheel install)")
    return fake_oanda.FakeOanda(division=division).start()


def _card(rows, broker):
    return next(r for r in rows if r["broker"] == broker)


def _relearning(name, *extra):
    """A profile of the user's own: the fixture adapter, its state folder."""
    from brueconnect import registry
    registry.add(name, argv=[sys.executable, str(RECONNECT), *extra],
                 description=name)
    return Path(registry.state_dir(name))


def _starts(state: Path) -> int:
    try:
        return (state / "count").stat().st_size
    except FileNotFoundError:
        return 0


# ── the listed row, on the kit's stand-in ─────────────────────────────────

def test_one_press_connects_the_listed_row_whose_hello_guessed(logged_engine, monkeypatch):
    fake = _standin("us")
    e = logged_engine
    try:
        monkeypatch.setenv("OANDA_REST_URL", fake.rest_url)
        monkeypatch.setenv("OANDA_STREAM_URL", fake.stream_url)
        aid = fake.account_ids[0]
        st, out = call(e.base, "/api/broker/link", "POST",
                       {"name": "my-oanda", "example": "oanda"}, headers=e.win_post)
        assert st == 200, out
        st, out = call(e.base, "/api/broker/credentials", "POST",
                       {"broker": "my-oanda", "values": {"token": fake.token},
                        "merge": True}, headers=e.win_post)
        assert st == 200, out
        fake.requests(clear=True)
        st, row = call(e.base, "/api/broker/connect", "POST", {"broker": "my-oanda"},
                       headers=e.win_post)
        assert st == 200, row
        assert row["connected"] is True and not row.get("needs_account"), row
        assert (row["identity"]["account_currency"],
                row["identity"]["account_model"]) == ("USD", "netting")
        assert row.get("account_id") == aid
        # the card, as the page reads it
        st, rows = call(e.base, "/api/broker/list", headers=e.win_get)
        assert st == 200
        card = _card(rows, "my-oanda")
        assert card["connected"] is True and "last_error" not in card, card
        said = json.dumps(card)
        for words in REFUSAL:
            assert words not in said, words
        st, acct = call(e.base, "/api/broker/account?broker=my-oanda", headers=e.win_get)
        assert st == 200 and acct["currency"] == "USD", acct
        # the engine's own record of that press: one connect, answered 200
        posts = [ln for ln in e.access if '"POST /api/broker/connect ' in ln]
        assert len(posts) == 1, e.access
        assert posts[0].rstrip().endswith('" 200'), posts
        # the catalog was read once, by the process started again: the first
        # refused after its accounts and summary, before any catalog
        opened = [r for r in fake.requests()
                  if r["host"] == "rest" and r["path"].endswith("/instruments")]
        assert len(opened) == 1, opened
        assert [r for r in fake.requests() if r["method"] != "GET"] == []
        # and the broker refused none of their connections (it allows two
        # new ones a second from one address), the streams' included
        time.sleep(2.5)
        refused = [r["path"] for r in fake.requests()
                   if r["status"] == 0 and not r.get("authorized")]
        assert refused == [], refused
    finally:
        try:
            e.hub.disconnect("my-oanda")
        except Exception:  # noqa: BLE001
            pass
        fake.stop()


def test_a_login_with_several_accounts_still_waits_on_its_chooser(client, monkeypatch):
    fake = _standin("uk")
    try:
        monkeypatch.setenv("OANDA_REST_URL", fake.rest_url)
        monkeypatch.setenv("OANDA_STREAM_URL", fake.stream_url)
        r = client.post("/api/broker/link", json={"name": "my-oanda", "example": "oanda"},
                        headers=JSON_WIN)
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/credentials", headers=WIN_POST, json={
            "broker": "my-oanda", "values": {"token": fake.token}, "merge": True})
        assert r.status_code == 200, r.text
        fake.requests(clear=True)
        r = client.post("/api/broker/connect", json={"broker": "my-oanda"}, headers=WIN_POST)
        assert r.status_code == 200, r.text
        row = r.json()
        assert row.get("needs_account") is True and row["connected"] is False, row
        assert len(row["accounts"]) == 3
        # nothing but the accounts was asked: no session was opened
        asked = {q["path"].split("?")[0] for q in fake.requests()}
        assert all(p == "/v3/accounts" or p.endswith("/summary") for p in asked), asked
        # the hedging account in USD, which the cold guess is not: one press
        r = client.post("/api/broker/account", headers=WIN_POST,
                        json={"broker": "my-oanda", "account_id": fake.account_ids[1]})
        assert r.status_code == 200, r.text
        row = r.json()
        assert row["connected"] is True, row
        assert (row["identity"]["account_currency"],
                row["identity"]["account_model"]) == ("USD", "hedging")
    finally:
        try:
            client.hub.disconnect("my-oanda")
        except Exception:  # noqa: BLE001
            pass
        fake.stop()


# ── a fixture adapter, which needs no stand-in ────────────────────────────

def test_one_press_connects_an_adapter_that_asks_to_be_started_again(client):
    state = _relearning("relearn")
    r = client.post("/api/broker/connect", json={"broker": "relearn"}, headers=WIN_POST)
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["connected"] is True and row["identity"]["account_currency"] == "USD", row
    assert _starts(state) == 2
    card = _card(client.get("/api/broker/list", headers=WIN_GET).json(), "relearn")
    assert "last_error" not in card
    said = json.dumps(card)
    for words in REFUSAL:
        assert words not in said, words


def test_an_adapter_that_asks_again_once_started_again_is_refused_in_plain_words(client):
    state = _relearning("relearn", "--forgets")
    r = client.post("/api/broker/connect", json={"broker": "relearn"}, headers=WIN_POST)
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert "Relearn Markets" in detail and "not started a third time" in detail, detail
    assert _starts(state) == 2
    time.sleep(1.0)
    assert _starts(state) == 2
    card = _card(client.get("/api/broker/list", headers=WIN_GET).json(), "relearn")
    assert card["connected"] is False
    assert "not started a third time" in card["last_error"]["message"], card


def test_the_process_started_again_is_drained_and_its_lines_kept(client):
    """Its second process writes 300,000 characters to stderr before it
    answers its catalog read: a pipe nobody reads holds 64 KB."""
    state = _relearning("relearn", "--chatter", "300000")
    r = client.post("/api/broker/connect", json={"broker": "relearn"}, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is True
    assert _starts(state) == 2

    def printed():
        card = _card(client.get("/api/broker/list", headers=WIN_GET).json(), "relearn")
        text = (card.get("printed") or "").rstrip()
        return text if text.endswith("process 2 wrote its lines") else None

    assert wait_for(printed, timeout=10), printed()


def test_with_a_kit_from_before_on_start_the_one_process_is_drained(client, monkeypatch):
    """A kit without Connector.on_start starts no process by itself: the hub
    attaches its tail to the process it started, as it always did."""
    from brueconnect import Connector, ConnectorError
    from lse_terminal.engine import broker_hub

    class Older(Connector):
        on_start = None

    monkeypatch.setattr(broker_hub, "_load_connector", lambda d: (Older, ConnectorError))
    add_profile("plain", extra=("--say-start",))
    r = client.post("/api/broker/connect", json={"broker": "plain"}, headers=WIN_POST)
    assert r.status_code == 200, r.text

    def printed():
        card = _card(client.get("/api/broker/list", headers=WIN_GET).json(), "plain")
        return "starting" in (card.get("printed") or "")

    assert wait_for(printed, timeout=10)
