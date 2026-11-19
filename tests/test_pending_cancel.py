"""A connection waiting on its account chooser can be cancelled, and is
dropped after ten minutes if it is not (lse_terminal/engine/broker_hub.py).

A login that reaches several accounts holds a logged-in session open while it
waits for the user to pick one (pending_auth). Pinned here:
  - the disconnect route cancels a pending row: its adapter is stopped and the
    pending entry dropped (the card's button posts to
    POST /api/broker/disconnect);
  - a chooser left unanswered is dropped after ten minutes (PENDING_CHOICE_S),
    with no action from the user, where the card is read (list_brokers) and
    before a fresh connect.

One listed row's adapter holds a logged-in session (POST /session) and ends
it cleanly when it is stopped: the engine closes an adapter gracefully
(Connector.close sends "bye"), and that adapter's bye handler logs out
(DELETE /session). Stopped without the bye (a killed process) it would not;
the engine always stops it with the bye, so a cancelled login leaves no
session open at the venue. Its stand-in counts its live sessions.

The brokers are the kit's paper engine with two accounts (tests/data/
terms_adapter.py --multi-accounts) and one listed row's own stand-in on
127.0.0.1. Nothing here reaches a broker.
"""
import time

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    LICENCE, WIN_GET, WIN_POST, add_profile, client, home, wait_for)

WIN_JSON = {**WIN_POST, "Content-Type": "application/json"}


def _pending_chooser(client):
    """A two-account paper broker connected far enough to wait on its account
    chooser; returns its pending connection."""
    add_profile("mb", terms=LICENCE, extra=("--multi-accounts",))
    r = client.post("/api/broker/connect", json={"broker": "mb"}, headers=WIN_POST)
    assert r.status_code == 200 and r.json().get("needs_account") is True, r.text
    pending = client.hub.pending_auth.get("mb")
    assert pending is not None and pending["c"].alive, "no pending login"
    return pending["c"]


# ── the disconnect route cancels a pending row ──────────────────────────────

def test_the_disconnect_route_cancels_a_pending_account_chooser(client, home):
    """POST /api/broker/disconnect on a row waiting on its account chooser
    stops the adapter and drops the pending entry; the card then waits on
    nothing."""
    conn = _pending_chooser(client)
    r = client.post("/api/broker/disconnect", json={"broker": "mb"}, headers=WIN_POST)
    assert r.status_code == 200 and r.json()["connected"] is False, r.text
    assert "mb" not in client.hub.pending_auth           # the pending entry is dropped
    assert wait_for(lambda: not conn.alive, timeout=5)   # its adapter is stopped
    row = {b["broker"]: b for b in
           client.get("/api/broker/list", headers=WIN_GET).json()}["mb"]
    assert not row.get("needs_account") and not row.get("connected"), row


# ── the chooser expires after ten minutes ───────────────────────────────────

def test_a_pending_account_chooser_is_set_to_expire_in_ten_minutes(client, home):
    from lse_terminal.engine import broker_hub as bh
    assert bh.PENDING_CHOICE_S == 600
    _pending_chooser(client)
    left = client.hub.pending_auth["mb"]["expires"] - time.time()
    assert 590 <= left <= 600, left


def test_a_card_read_drops_a_chooser_left_unanswered_past_its_expiry(client, home):
    """Ten minutes on, with no action from the user, the next card read
    (GET /api/broker/list) drops the chooser and stops its adapter."""
    conn = _pending_chooser(client)
    client.hub.pending_auth["mb"]["expires"] = time.time() - 1      # ten minutes elapsed
    rows = {b["broker"]: b for b in
            client.get("/api/broker/list", headers=WIN_GET).json()}
    assert not rows["mb"].get("needs_account"), rows["mb"]
    assert "mb" not in client.hub.pending_auth
    assert wait_for(lambda: not conn.alive, timeout=5)


def test_a_fresh_connect_drops_a_chooser_past_its_expiry_and_starts_over(client, home):
    conn = _pending_chooser(client)
    client.hub.pending_auth["mb"]["expires"] = time.time() - 1
    r = client.post("/api/broker/connect", json={"broker": "mb"}, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert wait_for(lambda: not conn.alive, timeout=5)   # the stale adapter is stopped
    # a new login is begun (the chooser opens again, a fresh adapter)
    assert client.hub.pending_auth.get("mb") is not None
    assert client.hub.pending_auth["mb"]["c"] is not conn


# ── a logged-in session is ended when the adapter is stopped ────────────────

def test_the_session_holding_adapter_ends_its_session_when_it_is_stopped(client, monkeypatch):
    """At one listed row's own stand-in: a session exists once connected, and
    stopping the adapter (the engine's disconnect, a graceful close) ends it
    with DELETE /session — the stand-in's alive session count falls to zero."""
    from test_order_answer_lost import _kit_standin
    from test_listed_priced_figures import STANDINS, _connect
    if _kit_standin("fake_capitalcom") is None:
        pytest.skip("the kit's stand-ins are not beside this kit (a wheel install)")
    fake, creds, *_ = STANDINS["capitalcom"](monkeypatch)
    name = "my-capitalcom"
    r = client.post("/api/broker/link", json={"name": name, "example": "capitalcom"},
                    headers=WIN_JSON)
    assert r.status_code == 200, r.text
    r = client.post("/api/broker/credentials", headers=WIN_POST, json={
        "broker": name, "values": creds, "merge": True})
    assert r.status_code == 200, r.text

    def alive():
        return sum(1 for s in fake.broker.sessions.values() if s.alive)
    _connect(client, name)
    assert wait_for(lambda: alive() >= 1, timeout=10), "no session at the stand-in"
    r = client.post("/api/broker/disconnect", json={"broker": name}, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert wait_for(lambda: alive() == 0, timeout=10), "the Capital.com session was not ended"
