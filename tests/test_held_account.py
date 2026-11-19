"""The held-requests contract: each held request keeps the account the
profile was bound to when it went out, an Ask again on another account is
refused before anything reaches the broker, and an account switch of a broker
with anything held asks first (lse_terminal/engine/held_requests.py and
server.py).

The case, as a test: two accounts, a close of half carried out but its
answer lost, a switch to the other account refused without confirm and made
with it, an Ask again refused on the other account with nothing closed
there, then answered on the account it went out on, one closeout in all.

The broker is the kit's paper engine with two accounts (tests/data/
terms_adapter.py --multi-accounts), whose book and idempotent record survive
a reconnect; a lost answer is scripted. Nothing here reaches the network.
"""
import json

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    LICENCE, WIN_GET, WIN_POST, add_profile, client, home)
from test_held_requests import LOST, REAL, held, on_disk, record_file, script


def _mb(client, account="fx-1"):
    """A two-account paper broker (fx-1, fx-2), bound to `account`, connected.
    Connect reaches the account chooser (needs_account); choosing one binds
    it and opens the session."""
    add_profile("mb", terms=LICENCE, extra=("--multi-accounts", "--resting"))
    r = client.post("/api/broker/connect", json={"broker": "mb"}, headers=WIN_POST)
    assert r.status_code == 200 and r.json().get("needs_account") is True, r.text
    assert {a["id"] for a in r.json()["accounts"]} == {"fx-1", "fx-2"}, r.json()
    r = client.post("/api/broker/account", json={"broker": "mb", "account_id": account},
                    headers=WIN_POST)
    assert r.status_code == 200 and r.json().get("connected"), r.text
    return r.json()


def _position(client, qty=0.03):
    """A position put in place by a program (nothing of it is recorded)."""
    r = client.post("/api/broker/order", json={
        "broker": "mb", "symbol": "EURUSD", "side": "buy", "qty": qty})
    assert r.status_code == 200, r.text
    return r.json()["fill"]["position_id"]


def _eurusd_qty(client):
    rows = client.get("/api/broker/positions?broker=mb", headers=WIN_GET).json()
    return round(sum(p["qty"] for p in rows if p["symbol"] == "EURUSD"), 8)


# ── the record keeps the account, and the forms it reads ────────────────────

def test_held_requests_keep_and_list_the_account(tmp_path):
    """HeldRequests keeps the account on each entry, lists it, writes it
    (version 3), and reads a file an earlier version wrote (no account) as
    null; entry() and oldest_live() read it."""
    from lse_terminal.engine import held_requests as hr
    path = tmp_path / "held_requests.json"
    rec = hr.HeldRequests(path)
    rec.send("mb", "lset-close-1", "/api/broker/close",
             {"broker": "mb", "position_id": "p1"}, "EUR_USD",
             account="101-004-7240139-001")
    [e] = rec.held()
    assert e["account"] == "101-004-7240139-001"
    on_disk_entry = json.loads(path.read_text())["held"][0]
    assert on_disk_entry["account"] == "101-004-7240139-001"
    assert json.loads(path.read_text())["v"] == 3
    # read back whole by a fresh record on the same file
    assert hr.HeldRequests(path).held()[0]["account"] == "101-004-7240139-001"
    # an entry with no account is null, and entry()/oldest_live() read them
    rec.send("mb", "lset-order-2", "/api/broker/order", {"broker": "mb"})
    assert rec.entry("mb", "lset-order-2")["account"] is None
    assert rec.entry("mb", "lset-close-1")["account"] == "101-004-7240139-001"
    assert rec.entry("mb", "nobody") is None
    assert rec.oldest_live("mb")["client_id"] == "lset-close-1"    # oldest by since
    assert rec.oldest_live("other") is None
    # a file version 2 wrote (no account) reads as null
    v2 = {"broker": "mb", "client_id": "lset-v2-3", "route": "/api/broker/close",
          "what": "close", "request": {"broker": "mb", "position_id": "p9",
                                       "client_id": "lset-v2-3"},
          "since": "2026-11-15T09:00:00Z", "detail": "internal: not known yet",
          "code": "internal", "state": "unknown", "instrument": "EUR_USD"}
    path.write_text(json.dumps({"v": 2, "held": [v2]}))
    assert hr.HeldRequests(path).held() == [{**v2, "account": None}]


def test_the_account_mask():
    """An account id masked as a sentence names it (the card's own form)."""
    from lse_terminal.engine.server import _mask_account
    assert _mask_account("101-004-7240139-001") == "…-001"
    assert _mask_account("101-004-7240139-003") == "…-003"
    assert _mask_account("fx-1") == "…-1"
    assert _mask_account("ABCDEFGH") == "…EFGH"
    assert _mask_account("ab") == "ab"
    assert _mask_account("") == "no account" and _mask_account(None) == "no account"


# ── the account switch asks first ───────────────────────────────────────────

def test_the_account_switch_asks_first_while_anything_is_held(client, home):
    """A switch of a broker with a held request answers 409 held_requests and
    switches nothing without confirm; with confirm it switches, and the held
    entry keeps the account it went out on. With nothing held it needs no
    confirm (the first choice in _mb)."""
    _mb(client, "fx-1")                      # chosen with nothing held: no confirm
    assert client.hub.bound_account("mb") == "fx-1"
    pid = _position(client)
    script(client, "mb", "position.close", LOST)
    body = {"broker": "mb", "position_id": pid, "qty": 0.01,
            "client_id": "lset-close-sw000001"}
    r = client.post("/api/broker/close", json=body, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    assert held(client)[0]["account"] == "fx-1"
    # a bare switch: refused with the oldest held request's own sentence
    r = client.post("/api/broker/account", json={"broker": "mb", "account_id": "fx-2"},
                    headers=WIN_POST)
    assert (r.status_code, r.json()["code"]) == (409, "held_requests"), r.text
    d = r.json()["detail"]
    assert "The close may have been carried out" in d and "Positions" in d, d
    assert client.hub.bound_account("mb") == "fx-1"       # switched nothing
    assert held(client)[0]["account"] == "fx-1"
    # with confirm it goes ahead; the entry keeps its own account
    r = client.post("/api/broker/account",
                    json={"broker": "mb", "account_id": "fx-2", "confirm": True},
                    headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert client.hub.bound_account("mb") == "fx-2"
    assert held(client)[0]["account"] == "fx-1"


# ── an Ask again on another account ─────────────────────────────────────────

def test_ask_again_on_another_account_is_refused_then_answered(client, home):
    """The close goes out on fx-1 and its answer is lost (held unknown, account
    fx-1). The broker is then on fx-2: an Ask again is refused before it
    reaches the broker (held_other_account, both accounts masked), nothing is
    closed on fx-2, and the entry stays as it was. Back on fx-1 the Ask again
    is answered from the broker's own record: one closeout in all.

    The switch is made with registry.set_account, which is what the switch
    route stores (hub.choose_account), so the scripted connection stays alive
    across the Ask again and the broker answers it from its idempotent record.
    """
    from brueconnect import registry
    _mb(client, "fx-1")
    pid = _position(client, 0.03)
    script(client, "mb", "position.close", LOST, REAL)
    body = {"broker": "mb", "position_id": pid, "qty": 0.01,
            "client_id": "lset-close-w8000001"}
    r = client.post("/api/broker/close", json=body, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    [entry] = held(client)
    assert (entry["state"], entry["account"]) == ("unknown", "fx-1")
    assert on_disk(home)[0]["account"] == "fx-1"
    assert _eurusd_qty(client) == 0.02        # the close was carried out, once

    # the broker is now on fx-2: the Ask again is refused before the hub
    registry.set_account("mb", "fx-2")
    assert client.hub.bound_account("mb") == "fx-2"
    r = client.post("/api/broker/close", json=body, headers=WIN_POST)
    assert (r.status_code, r.json()["code"]) == (409, "held_other_account"), r.text
    d = r.json()["detail"]
    assert "…-1" in d and "…-2" in d and "Switch back to …-1" in d, d
    assert held(client) == [entry]            # the entry stays exactly as it was
    assert _eurusd_qty(client) == 0.02        # nothing was closed on fx-2

    # back on fx-1, the Ask again reaches the broker and is answered from its
    # record: one closeout in all
    registry.set_account("mb", "fx-1")
    r = client.post("/api/broker/close", json=body, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert [(e["client_id"], e["state"], e["ok"]) for e in held(client)] == [
        (body["client_id"], "answered", True)]
    assert on_disk(home) == []
    assert _eurusd_qty(client) == 0.02        # not closed a second time
