"""The window's requests from the moment they are handed on (the record
GET /api/broker/held reads, lse_terminal/engine/held_requests.py).

A request the window sends on one of the four routes (an order, a resting
order, a cancel, a close) is written to the record as "out" before the
engine hands it to the broker hub, so an engine that stops before the
broker's answer comes leaves it behind: the next engine reads it as
"unknown" (code engine_stopped), and the page loaded on it asks before the
same intent goes out again. Pinned here, as the page and a program send:
  - "out" on disk before the hub is called, on each route; a body with no
    client_id is given one first and sent under it;
  - each state on each route: out, unknown (its answer lost), answered (an
    answer that settles it: gone from the file, listed in memory for 120 s
    with what the answer said, then not at all);
  - an answer to a request the page lost (its connection closed while the
    request was out) is listed answered, as the page loaded next reads it;
  - an Ask again answered "not connected" restores the unknown entry it
    replaced; another such answer to a new request is listed answered;
  - an error of the engine's own after the request was handed on makes it
    unknown, and the answer says so;
  - a program's requests are never recorded, in any state;
  - a cancel's instrument is the symbol the page sends beside the order id,
    and the adapter is sent only what it needs;
  - unlinking and forgetting let a broker's entries go, every state; a
    disconnect keeps them;
  - an engine killed while a close is out at the kit's stand-in for a
    listed broker (a relay holding the answer): the next engine on the
    same config folder lists it unknown with code engine_stopped, and
    asking again under the same client_id makes no second closeout.

The brokers are the kit's paper engine (tests/data/terms_adapter.py) and the
kit's stand-in on 127.0.0.1. Nothing here reaches the network.
"""
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    LICENCE, WIN_GET, WIN_POST, _free_port, add_profile, call, client, connect, home,
    wait_for)
from test_held_requests import (  # noqa: F401
    LOST, REAL, REFUSED, RATE_LIMITED, _Engine, held, on_disk, record_file, script)

T0 = "2026-11-15T10:00:00Z"
FIELDS = {"broker", "client_id", "route", "what", "request", "since", "detail", "code",
          "state", "instrument", "account"}
ANSWERED = FIELDS | {"ok", "status"}
CLIENT_ID = re.compile(r"[A-Za-z0-9][!-~]{0,127}")
ROUTE = {"order": "/api/broker/order", "resting": "/api/broker/order/pending",
         "cancel": "/api/broker/order/cancel", "close": "/api/broker/close"}
WHAT = {"order": "order", "resting": "resting", "cancel": "cancel", "close": "close"}
# The hub's method each route hands its request to, and the adapter method.
HUB_FN = {"order": "order", "resting": "order", "cancel": "cancel_order",
          "close": "close_position"}
METHOD = {"order": "order.place", "resting": "order.place", "cancel": "order.cancel",
          "close": "position.close"}
STOPPED = {"order": "Positions", "resting": "Orders", "cancel": "Orders",
           "close": "Positions"}


@pytest.fixture()
def clock(monkeypatch):
    """The record's two clocks, set by the test: each entry's `since`, and
    the clock an answered entry's 120 s are counted on."""
    from lse_terminal.engine import held_requests
    now = {"t": T0, "s": 1000.0}
    monkeypatch.setattr(held_requests, "_now", lambda: now["t"])
    monkeypatch.setattr(held_requests, "_tick", lambda: now["s"], raising=False)
    return now


def _profile(c):
    add_profile("local", terms=LICENCE, extra=("--resting",))
    connect(c, "local")


def _body(c, kind, client_id=True):
    """The body the page sends for one kind (a cancel with the symbol beside
    the order id, as the page now sends it), with what it acts on put in
    place first by a program, so nothing of that is recorded."""
    order = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01}
    cid = {"order": "lset-a1b2c3d4e5f6", "resting": "lset-0a0b0c0d0e0f",
           "cancel": "lset-cancel-9f8e7d6c5b4a", "close": "lset-close-09586a88cde2"}[kind]
    if kind == "order":
        body = dict(order)
    elif kind == "resting":
        body = {**order, "type": "limit", "price": 1.0}
    elif kind == "cancel":
        r = c.post("/api/broker/order/pending", json={**order, "type": "limit", "price": 1.0})
        assert r.status_code == 200, r.text
        body = {"broker": "local", "order_id": r.json()["order_id"], "symbol": "EURUSD"}
    else:
        r = c.post("/api/broker/order", json={**order, "qty": 0.03})
        assert r.status_code == 200, r.text
        body = {"broker": "local", "position_id": r.json()["fill"]["position_id"], "qty": 0.01}
    if client_id:
        body["client_id"] = cid
    return body


def _instrument(kind):
    return None if kind == "close" else "EURUSD"


def _reading_hub(monkeypatch, c, home, kind, seen):
    """The hub method `kind`'s route hands its request to, wrapped: when it is
    called, the record on disk and the client_id it was given are noted."""
    real = getattr(c.hub, HUB_FN[kind])

    def reading(*a, **kw):
        seen.append({"disk": on_disk(home), "client_id": kw.get("client_id")})
        return real(*a, **kw)
    monkeypatch.setattr(c.hub, HUB_FN[kind], reading)


# ── out, before the hub ────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", ["order", "resting", "cancel", "close"])
def test_the_entry_is_on_disk_as_out_before_the_hub_is_called(
        client, home, clock, monkeypatch, kind):
    _profile(client)
    body = _body(client, kind)
    seen = []
    _reading_hub(monkeypatch, client, home, kind, seen)
    r = client.post(ROUTE[kind], json=body, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert len(seen) == 1, seen
    assert seen[0]["client_id"] == body["client_id"]
    assert seen[0]["disk"] == [{
        "broker": "local", "client_id": body["client_id"], "route": ROUTE[kind],
        "what": WHAT[kind], "request": body, "since": T0, "detail": None, "code": None,
        "state": "out", "instrument": _instrument(kind), "account": None}], seen


@pytest.mark.parametrize("kind", ["order", "resting", "cancel", "close"])
def test_a_body_with_no_client_id_is_given_one_before_it_is_sent(
        client, home, clock, monkeypatch, kind):
    """The id is the engine's, made before the entry is written: the entry,
    the hub and the adapter all have the same one, and the page can send it
    back (an id the routes take)."""
    _profile(client)
    body = _body(client, kind, client_id=False)
    seen, params = [], []
    _reading_hub(monkeypatch, client, home, kind, seen)
    conn = client.hub.conns["local"]
    real = conn.request

    def request(m, p=None, timeout=10.0):
        if m == METHOD[kind]:
            params.append(dict(p or {}))
        return real(m, p, timeout)
    conn.request = request
    r = client.post(ROUTE[kind], json=body, headers=WIN_POST)
    assert r.status_code == 200, r.text
    cid = seen[0]["client_id"]
    assert isinstance(cid, str) and CLIENT_ID.fullmatch(cid), seen
    [entry] = seen[0]["disk"]
    assert entry["client_id"] == cid and entry["request"] == {**body, "client_id": cid}
    assert entry["state"] == "out"
    assert [p["client_id"] for p in params] == [cid]
    # what the page reads afterwards names it too
    [listed] = held(client)
    assert (listed["client_id"], listed["state"]) == (cid, "answered")
    if kind == "order":
        assert r.json()["client_id"] == cid


# ── each state, each route ─────────────────────────────────────────────────

@pytest.mark.parametrize("kind", ["order", "resting", "cancel", "close"])
def test_each_state_on_each_route(client, home, clock, kind):
    """Lost: unknown, the answer's words and code, `since` kept. Asked again
    and answered: gone from the file, listed answered for 120 s with what the
    answer said, then not at all."""
    _profile(client)
    body = _body(client, kind)
    script(client, "local", METHOD[kind], LOST, REAL)
    r = client.post(ROUTE[kind], json=body, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    lost = r.json()
    want = {"broker": "local", "client_id": body["client_id"], "route": ROUTE[kind],
            "what": WHAT[kind], "request": body, "since": T0, "detail": lost["detail"],
            "code": "internal", "state": "unknown", "instrument": _instrument(kind),
            "account": None}
    assert held(client) == [want]
    assert on_disk(home) == [want]
    # asked again a minute later, and answered from the broker's record
    clock["t"] = "2026-11-15T10:01:00Z"
    r = client.post(ROUTE[kind], json=body, headers=WIN_POST)
    assert r.status_code == 200, r.text
    [got] = held(client)
    assert set(got) == ANSWERED, got
    assert got == {**want, "state": "answered", "ok": True, "status": 200,
                   "detail": None, "code": None}
    assert on_disk(home) == []
    # listed for 120 s after the answer, then not at all
    clock["s"] += 119.0
    assert [e["state"] for e in held(client)] == ["answered"]
    clock["s"] += 2.0
    assert held(client) == []
    assert "answered" not in record_file(home).read_text()     # never in the file


@pytest.mark.parametrize("kind", ["order", "close"])
def test_a_refusal_for_good_is_listed_answered_with_its_words_and_code(client, home, clock, kind):
    _profile(client)
    body = _body(client, kind)
    script(client, "local", METHOD[kind], REFUSED)
    r = client.post(ROUTE[kind], json=body, headers=WIN_POST)
    assert r.status_code == 400 and set(r.json()) == {"detail"}, r.text
    [got] = held(client)
    assert {k: got[k] for k in ("state", "ok", "status", "detail", "code")} == {
        "state": "answered", "ok": False, "status": 400, "detail": r.json()["detail"],
        "code": "invalid_qty"}
    assert on_disk(home) == []


def test_an_answer_that_settles_nothing_restores_what_was_there_before(client, home, clock):
    """Asked again, a retry that can mend it (rate limited) settles nothing:
    the unknown entry comes back as it was, words, code and `since`."""
    _profile(client)
    body = _body(client, "order")
    script(client, "local", "order.place", LOST, RATE_LIMITED)
    assert client.post(ROUTE["order"], json=body, headers=WIN_POST).status_code == 400
    before = held(client)
    clock["t"] = "2026-11-15T10:02:00Z"
    r = client.post(ROUTE["order"], json=body, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is False, r.text
    assert held(client) == before and on_disk(home) == before


def test_an_ask_again_answered_not_connected_restores_the_unknown_entry_it_replaced(
        client, home, clock, monkeypatch):
    _profile(client)
    body = _body(client, "order")
    script(client, "local", "order.place", LOST)
    assert client.post(ROUTE["order"], json=body, headers=WIN_POST).status_code == 400
    [unknown] = held(client)
    assert unknown["state"] == "unknown"
    client.post("/api/broker/disconnect", json={"broker": "local"}, headers=WIN_POST)
    seen = []
    _reading_hub(monkeypatch, client, home, "order", seen)
    clock["t"] = "2026-11-15T10:03:00Z"
    r = client.post(ROUTE["order"], json=body, headers=WIN_POST)
    assert r.status_code == 409, r.text
    # it was out while the hub was asked, its first time kept
    assert [(e["state"], e["since"]) for e in seen[0]["disk"]] == [("out", T0)]
    assert held(client) == [unknown] and on_disk(home) == [unknown]
    # a new request answered so: nothing to restore, so it is listed answered
    fresh = {**body, "client_id": "lset-fresh-000001"}
    r = client.post(ROUTE["order"], json=fresh, headers=WIN_POST)
    assert r.status_code == 409, r.text
    got = {e["client_id"]: e for e in held(client)}
    assert got[body["client_id"]] == unknown
    assert {k: got["lset-fresh-000001"][k] for k in ("state", "ok", "status", "detail")} == {
        "state": "answered", "ok": False, "status": 409, "detail": r.json()["detail"]}
    assert on_disk(home) == [unknown]


def test_an_error_of_the_engines_own_after_the_hand_on_holds_it_unknown(
        client, home, clock, monkeypatch):
    """The hub was called, then the engine's own code failed: the request may
    have been carried out, so it is held, and the answer says it is not
    known with the client_id to ask again under."""
    _profile(client)
    body = _body(client, "order")
    real = client.hub.order

    def failing(*a, **kw):
        real(*a, **kw)
        raise TypeError("the engine's own slip")
    monkeypatch.setattr(client.hub, "order", failing)
    r = client.post(ROUTE["order"], json=body, headers=WIN_POST)
    assert r.status_code == 502, r.text
    assert (r.json()["unknown"], r.json()["retryable"], r.json()["client_id"]) == (
        True, True, body["client_id"]), r.json()
    [got] = held(client)
    assert (got["state"], got["client_id"], got["detail"]) == (
        "unknown", body["client_id"], r.json()["detail"])
    assert on_disk(home) == [got]


# ── a page that lost its request ───────────────────────────────────────────

def test_an_answer_to_a_request_the_page_lost_is_listed_answered_for_120_s(home, clock):
    """Over real HTTP: the page sends an order and is reloaded while it is
    out (its connection closes, nothing reads the answer). The page loaded
    next reads it out, then answered with the answer's words, for 120 s."""
    add_profile("local", terms=LICENCE, extra=("--resting",))
    e = _Engine()
    try:
        st, row = call(e.base, "/api/broker/connect", "POST", {"broker": "local"},
                       headers=e.win_post)
        assert st == 200 and row["connected"], row
        conn = e.app.state.broker_hub.conns["local"]
        real = conn.request
        gate = threading.Event()

        def slow(m, p=None, timeout=10.0):
            if m == "order.place":
                gate.wait(30)
            return real(m, p, timeout)
        conn.request = slow
        body = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
                "client_id": "lset-lost-page-01"}
        raw = json.dumps(body).encode()
        page = http.client.HTTPConnection("127.0.0.1", int(e.base.rsplit(":", 1)[1]), timeout=30)
        page.request("POST", "/api/broker/order", body=raw, headers={
            **e.win_post, "Content-Type": "application/json", "Content-Length": str(len(raw))})
        assert wait_for(lambda: [x for x in call(e.base, "/api/broker/held",
                                                 headers=e.win_get)[1]["held"]
                                 if x["state"] == "out"], timeout=10)
        page.sock.close()                  # the page is reloaded: nothing reads the answer
        page.close()
        st, got = call(e.base, "/api/broker/held", headers=e.win_get)
        assert [(x["client_id"], x["state"]) for x in got["held"]] == [
            ("lset-lost-page-01", "out")]
        gate.set()
        done = wait_for(lambda: [x for x in call(e.base, "/api/broker/held",
                                                 headers=e.win_get)[1]["held"]
                                 if x["state"] == "answered"], timeout=15)
        assert done, "the answer was not recorded"
        [ans] = done
        assert set(ans) == ANSWERED
        assert (ans["ok"], ans["status"], ans["request"], ans["instrument"]) == (
            True, 200, body, "EURUSD")
        assert on_disk(home) == []
        clock["s"] += 119.5
        assert len(call(e.base, "/api/broker/held", headers=e.win_get)[1]["held"]) == 1
        clock["s"] += 1.0
        assert call(e.base, "/api/broker/held", headers=e.win_get)[1] == {"held": []}
        st, rows = call(e.base, "/api/broker/positions?broker=local", headers=e.win_get)
        assert [p["qty"] for p in rows] == [0.01]
    finally:
        e.stop()


# ── a program, and the broker unlinked ─────────────────────────────────────

@pytest.mark.parametrize("kind", ["order", "resting", "cancel", "close"])
def test_a_programs_requests_are_never_recorded_in_any_state(
        client, home, clock, monkeypatch, kind):
    _profile(client)
    body = _body(client, kind)
    seen = []
    _reading_hub(monkeypatch, client, home, kind, seen)
    script(client, "local", METHOD[kind], LOST, REAL)
    r = client.post(ROUTE[kind], json=body)                    # lost
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    assert held(client) == []
    r = client.post(ROUTE[kind], json=body)                    # answered
    assert r.status_code == 200, r.text
    assert held(client) == []
    r = client.post(ROUTE[kind], json={k: v for k, v in body.items() if k != "client_id"})
    assert held(client) == []
    assert [s["disk"] for s in seen] == [[], [], []]
    assert not record_file(home).exists() or on_disk(home) == []


def test_a_cancels_symbol_is_its_instrument_and_is_not_sent_to_the_adapter(client, home, clock):
    _profile(client)
    body = _body(client, "cancel")
    assert body["symbol"] == "EURUSD"
    conn = client.hub.conns["local"]
    real, sent = conn.request, []

    def request(m, p=None, timeout=10.0):
        if m == "order.cancel":
            sent.append(dict(p or {}))
        return real(m, p, timeout)
    conn.request = request
    r = client.post(ROUTE["cancel"], json=body, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert sent == [{"order_id": body["order_id"], "client_id": body["client_id"]}]
    [got] = held(client)
    assert (got["instrument"], got["request"]) == ("EURUSD", body)


def test_unlinking_lets_every_state_go_and_a_disconnect_keeps_them(client, home, clock):
    for b in ("one", "two"):
        add_profile(b, terms=LICENCE, extra=("--resting",))
        connect(client, b)
    script(client, "one", "order.place", LOST)
    order = {"symbol": "EURUSD", "side": "buy", "qty": 0.01}
    assert client.post(ROUTE["order"], headers=WIN_POST, json={
        "broker": "one", **order, "client_id": "lset-one-unknown"}).status_code == 400
    assert client.post(ROUTE["order"], headers=WIN_POST, json={
        "broker": "one", **order, "client_id": "lset-one-answered"}).status_code == 200
    assert client.post(ROUTE["order"], headers=WIN_POST, json={
        "broker": "two", **order, "client_id": "lset-two-answered"}).status_code == 200
    states = lambda: sorted((e["broker"], e["state"]) for e in held(client))  # noqa: E731
    assert states() == [("one", "answered"), ("one", "unknown"), ("two", "answered")]
    client.post("/api/broker/disconnect", json={"broker": "one"}, headers=WIN_POST)
    assert states() == [("one", "answered"), ("one", "unknown"), ("two", "answered")]
    r = client.post("/api/broker/unlink", json={"name": "one"},
                    headers={**WIN_POST, "Content-Type": "application/json"})
    assert r.status_code == 200, r.text
    assert states() == [("two", "answered")] and on_disk(home) == []


# ── the file across engines ────────────────────────────────────────────────

def _entry(**more):
    e = {"broker": "local", "client_id": "lset-left-000001", "route": "/api/broker/close",
         "what": "close", "request": {"broker": "local", "position_id": "p1",
                                      "client_id": "lset-left-000001"},
         "since": "2026-11-15T09:00:00Z", "detail": None, "code": None,
         "state": "out", "instrument": None}
    e.update(more)
    return e


@pytest.mark.parametrize("what,route,where", [
    ("order", "/api/broker/order", "Positions"),
    ("resting", "/api/broker/order/pending", "Orders"),
    ("cancel", "/api/broker/order/cancel", "Orders"),
    ("close", "/api/broker/close", "Positions")])
def test_an_entry_left_out_by_an_engine_that_stopped_is_read_unknown(
        home, capsys, what, route, where):
    from lse_terminal.engine import held_requests as hr
    path = record_file(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    left = _entry(what=what, route=route)
    kept = _entry(client_id="lset-kept-000002", request={"broker": "local", "position_id": "p2",
                                                         "client_id": "lset-kept-000002"},
                  state="unknown", detail="internal: not known yet", code="internal")
    path.write_text(json.dumps({"v": 2, "held": [left, kept]}))
    rec = hr.HeldRequests(path)
    got = rec.held()
    # a version 2 file has no account; read with account null
    assert got[1] == {**kept, "account": None}
    skip = ("state", "code", "detail", "account")
    assert {k: v for k, v in got[0].items() if k not in skip} == {
        k: v for k, v in left.items() if k not in skip}
    assert got[0]["account"] is None
    assert (got[0]["state"], got[0]["code"]) == ("unknown", "engine_stopped")
    assert got[0]["detail"] == (
        "The Terminal stopped before the broker's answer came, so it may have been carried "
        f"out: check {where} before sending it again.")
    # the change is on disk, and the file was not set aside
    assert json.loads(path.read_text())["held"] == got
    assert [p.name for p in path.parent.iterdir()] == ["held_requests.json"]
    assert "[held requests]" not in capsys.readouterr().err


def test_a_record_kept_by_version_1_is_read_as_unknown_entries(home, capsys):
    """A file an earlier engine wrote (its version 1: no state, no
    instrument) is read, not set aside: each entry unknown, its instrument
    the symbol of the request it kept."""
    from lse_terminal.engine import held_requests as hr
    path = record_file(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    v1 = {"broker": "local", "client_id": "lset-v1-000001", "route": "/api/broker/order",
          "what": "order", "request": {"broker": "local", "symbol": "EURUSD", "side": "buy",
                                       "qty": 0.01, "client_id": "lset-v1-000001"},
          "since": "2026-11-15T09:00:00Z", "detail": "internal: not known yet",
          "code": "internal"}
    path.write_text(json.dumps({"v": 1, "held": [v1]}))
    assert hr.HeldRequests(path).held() == [
        {**v1, "state": "unknown", "instrument": "EURUSD", "account": None}]
    assert [p.name for p in path.parent.iterdir()] == ["held_requests.json"]
    assert "[held requests]" not in capsys.readouterr().err


# ── an engine killed while a close is out at the kit's stand-in ────────────

def _kit_standin(name):
    import importlib.util
    import brueconnect
    path = Path(brueconnect.__file__).resolve().parents[1] / "tests" / f"{name}.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location(f"kit_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _HoldAnswer:
    """A loopback relay in front of the stand-in's REST port. A request that
    matches a rule is forwarded at once, so the broker carries it out; the
    broker's answer is then held from the client for the rule's seconds and
    the client's connection closed without it. Every request is counted by
    method and path."""

    def __init__(self, upstream_port):
        self.up = upstream_port
        self.rules, self.seen = [], []
        self._lock = threading.Lock()
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(64)
        self.url = "http://127.0.0.1:%d" % self.srv.getsockname()[1]
        self._stop = False
        threading.Thread(target=self._accept, daemon=True).start()

    def close(self):
        self._stop = True
        try:
            self.srv.close()
        except OSError:
            pass

    def _take(self, method, path):
        with self._lock:
            self.seen.append((method, path))
            for i, (match, hold) in enumerate(self.rules):
                if match(method, path):
                    self.rules.pop(i)
                    return hold
        return None

    def _accept(self):
        while not self._stop:
            try:
                cli, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(cli,), daemon=True).start()

    @staticmethod
    def _head(sock, buf):
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                return None, buf
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        return head, rest

    @staticmethod
    def _field(head, name):
        for line in head.split(b"\r\n")[1:]:
            k, _, v = line.partition(b":")
            if k.strip().lower() == name:
                return v.strip()
        return None

    def _body(self, sock, head, rest):
        n = self._field(head, b"content-length")
        if n is not None:
            n = int(n)
            while len(rest) < n:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                rest += chunk
            return rest[:n], rest[n:]
        if b"chunked" in (self._field(head, b"transfer-encoding") or b"").lower():
            while not rest.endswith(b"0\r\n\r\n"):
                chunk = sock.recv(65536)
                if not chunk:
                    break
                rest += chunk
            return rest, b""
        return b"", rest

    def _serve(self, cli):
        up, buf = None, b""
        try:
            while True:
                head, buf = self._head(cli, buf)
                if head is None:
                    return
                body, buf = self._body(cli, head, buf)
                first = head.split(b"\r\n", 1)[0].decode("latin-1").split()
                hold = self._take(first[0], first[1].split("?")[0])
                if up is None:
                    up = socket.create_connection(("127.0.0.1", self.up), timeout=30)
                up.sendall(head + b"\r\n\r\n" + body)
                rhead, rrest = self._head(up, b"")
                if rhead is None:
                    return
                rbody, _ = self._body(up, rhead, rrest)
                if hold:
                    time.sleep(hold)           # carried out; its answer kept from the client
                    return
                cli.sendall(rhead + b"\r\n\r\n" + rbody)
        except OSError:
            return
        finally:
            for s in (cli, up):
                try:
                    if s is not None:
                        s.close()
                except OSError:
                    pass


class _EngineProcess:
    """The engine as the desktop shell runs it: its own process, on a loopback
    port, with the environment of this test (its config folder, its broker
    home, the stand-in's addresses). Stopped with SIGKILL, as a crash."""

    def __init__(self, cwd: Path, log: Path):
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.log = open(log, "ab")
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "lse_terminal.engine.server:create_app",
             "--factory", "--host", "127.0.0.1", "--port", str(self.port),
             "--log-level", "warning"],
            cwd=str(cwd), env=dict(os.environ), stdout=self.log, stderr=subprocess.STDOUT,
            start_new_session=True)
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                if call(self.base, "/api/health", timeout=5)[0] == 200:
                    break
            except OSError:
                time.sleep(0.2)
        else:
            raise AssertionError("the engine did not start")
        self.win_get = {"Sec-Fetch-Site": "same-origin"}
        self.win_post = {"Sec-Fetch-Site": "same-origin", "Origin": self.base}

    def kill(self):
        """SIGKILL the engine alone; what it started is left as a crash leaves it."""
        try:
            self.proc.send_signal(signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.proc.wait(15)

    def reap(self):
        """Everything this engine started, gone (the end of the test)."""
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            self.proc.wait(15)
        except subprocess.TimeoutExpired:
            pass
        self.log.close()


def _closeouts(fake, aid, symbol):
    return [t for t in fake.transactions(aid) if t.get("type") == "MARKET_ORDER"
            and t.get("reason") == "POSITION_CLOSEOUT" and t.get("instrument") == symbol]


def test_an_engine_killed_while_a_close_is_out_leaves_it_unknown_for_the_next(
        home, tmp_path, monkeypatch):
    """The listed row on the kit's stand-in, a netting account, 1000 EUR_USD
    bought. The dock's close of the whole position goes out; the relay sends
    it on at once (the stand-in carries it out) and holds the answer; the
    engine is killed with SIGKILL while it waits. The next engine on the same
    config folder lists the close unknown, code engine_stopped, before
    anything is connected. Connected again and asked again under the same
    client_id: no second closeout at the stand-in, whatever the adapter can
    find of the first. (When the stand-in's closeout carries the close's id,
    the adapter finds it and the answer settles it; until then it is still
    not known.)"""
    fake_oanda = _kit_standin("fake_oanda")
    if fake_oanda is None:
        pytest.skip("the kit's stand-in is not beside this kit (a wheel install)")
    fake = fake_oanda.FakeOanda(division="uk", new_connections_per_second=None).start()
    relay = _HoldAnswer(fake.port)
    engines = []
    try:
        monkeypatch.setenv("OANDA_REST_URL", relay.url)
        monkeypatch.setenv("OANDA_STREAM_URL", fake.stream_url)
        aid = fake.account_ids[0]
        e1 = _EngineProcess(tmp_path, tmp_path / "engine1.log")
        engines.append(e1)
        json_win = {**e1.win_post, "Content-Type": "application/json"}
        st, out = call(e1.base, "/api/broker/link", "POST",
                       {"name": "my-oanda", "example": "oanda"}, headers=json_win)
        assert st == 200, out
        st, out = call(e1.base, "/api/broker/credentials", "POST", {
            "broker": "my-oanda", "values": {"token": fake.token}, "merge": True},
            headers=e1.win_post)
        assert st == 200, out
        st, row = call(e1.base, "/api/broker/connect", "POST", {"broker": "my-oanda"},
                       headers=e1.win_post)
        if row.get("needs_account"):
            st, row = call(e1.base, "/api/broker/account", "POST",
                           {"broker": "my-oanda", "account_id": aid}, headers=e1.win_post)
        assert st == 200 and row.get("connected"), row
        fake.set_price("EUR_USD", bid=1.10000, ask=1.10010)
        time.sleep(1.0)
        st, out = call(e1.base, "/api/broker/order", "POST", {
            "broker": "my-oanda", "symbol": "EUR_USD", "side": "buy", "qty": 1000,
            "client_id": "lset-buy-0123456789ab"}, headers=e1.win_post)
        assert st == 200, out
        rows = wait_for(lambda: [p for p in call(e1.base, "/api/broker/positions?broker=my-oanda",
                                                 headers=e1.win_get)[1] if p.get("qty")], timeout=15)
        assert [(p["symbol"], p["qty"]) for p in rows] == [("EUR_USD", 1000.0)], rows
        close_path = f"/v3/accounts/{aid}/positions/EUR_USD/close"
        relay.rules.append((lambda m, p: m == "PUT" and p == close_path, 30.0))
        body = {"broker": "my-oanda", "position_id": str(rows[0]["position_id"]),
                "client_id": "lset-close-c0ffee000001"}
        sent = {}

        def press():
            try:
                sent["answer"] = call(e1.base, "/api/broker/close", "POST", body,
                                      headers=e1.win_post, timeout=60)
            except Exception as ex:  # noqa: BLE001 - the engine dies under it
                sent["error"] = repr(ex)
        t = threading.Thread(target=press, daemon=True)
        t.start()
        out_on_disk = wait_for(lambda: [x for x in on_disk(home) if x.get("state") == "out"
                                        and x["client_id"] == body["client_id"]], timeout=8)
        assert out_on_disk, on_disk(home)
        assert wait_for(lambda: _closeouts(fake, aid, "EUR_USD"), timeout=15), \
            "the stand-in did not carry the close out"
        e1.kill()
        t.join(30)
        assert "answer" not in sent, sent              # the page never had an answer
        # the next engine, the same config folder and broker home
        e2 = _EngineProcess(tmp_path, tmp_path / "engine2.log")
        engines.append(e2)
        st, got = call(e2.base, "/api/broker/held", headers=e2.win_get)
        assert st == 200, got
        [entry] = got["held"]
        assert (entry["state"], entry["code"], entry["client_id"], entry["route"],
                entry["request"], entry["instrument"]) == (
            "unknown", "engine_stopped", body["client_id"], "/api/broker/close", body, None)
        assert entry["detail"] == (
            "The Terminal stopped before the broker's answer came, so it may have been "
            "carried out: check Positions before sending it again.")
        assert on_disk(home) == [entry]
        assert call(e2.base, "/api/broker/held")[0] == 403        # a program: refused
        st, row = call(e2.base, "/api/broker/connect", "POST", {"broker": "my-oanda"},
                       headers=e2.win_post)
        assert st == 200 and row.get("connected"), row
        puts_before = [s for s in relay.seen if s == ("PUT", close_path)]
        assert len(puts_before) == 1, relay.seen
        st, ans = call(e2.base, entry["route"], "POST", entry["request"],
                       headers=e2.win_post, timeout=60)
        time.sleep(2.0)
        # one closeout, one close sent to the broker: asking again sent nothing
        assert len(_closeouts(fake, aid, "EUR_USD")) == 1, _closeouts(fake, aid, "EUR_USD")
        assert [s for s in relay.seen if s == ("PUT", close_path)] == puts_before
        st2, after = call(e2.base, "/api/broker/held", headers=e2.win_get)
        [now] = after["held"]
        found = any((t.get("clientExtensions") or {}).get("id")
                    for t in _closeouts(fake, aid, "EUR_USD"))
        print("facts:", json.dumps({"entry_after_restart": entry, "ask_again": [st, ans],
                                    "entry_after_ask_again": now, "closeouts": len(
                                        _closeouts(fake, aid, "EUR_USD")),
                                    "close_puts": len(puts_before), "id_on_closeout": found,
                                    "first_press": sent}, default=str))
        if found:
            # the stand-in keeps the close's id on its closeout: found, settled
            assert st == 200, ans
            assert (now["state"], now["ok"], now["status"]) == ("answered", True, 200)
            assert on_disk(home) == []
        else:
            # the stand-in keeps no id there: the adapter cannot find it yet
            assert st == 400 and ans["unknown"] is True, ans
            assert ans["client_id"] == body["client_id"]
            assert "not in oanda's record yet" in ans["detail"].lower(), ans
            assert (now["state"], now["since"], now["detail"]) == (
                "unknown", entry["since"], ans["detail"])
            assert on_disk(home) == [now]
    finally:
        for e in engines:
            e.reap()
        relay.close()
        fake.stop()



def test_the_kept_request_is_sent_again_as_it_was_sent(client, home, clock):
    """What is kept is what Ask again sends, so the fields the route reads
    are kept as the page sent them, even when a value the profile keeps is
    part of one, or the whole of one (short stored values: a key inside the
    symbol, an account number that is also an order's id). Changed, Ask
    again would ask about another instrument or another order. Only words
    beside them have such a value taken out."""
    from brueconnect import registry
    _profile(client)
    rest = client.post("/api/broker/order/pending", json={
        "broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
        "type": "limit", "price": 1.0}).json()["order_id"]
    registry.set_credentials("local", {"api_secret": "EURU", "account": rest})
    order = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
             "client_id": "lset-kept-order-1", "note": "pasted EURU here"}
    cancel = {"broker": "local", "order_id": rest, "symbol": "EURUSD",
              "client_id": "lset-kept-cancel-1"}
    script(client, "local", "order.place", LOST)
    script(client, "local", "order.cancel", LOST)
    for route, body in ((ROUTE["order"], order), (ROUTE["cancel"], cancel)):
        r = client.post(route, json=body, headers=WIN_POST)
        assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    got = {e["client_id"]: e for e in held(client)}
    assert got["lset-kept-order-1"]["request"] == {**order, "note": "pasted [hidden] here"}
    assert got["lset-kept-cancel-1"]["request"] == cancel
    assert got["lset-kept-cancel-1"]["instrument"] == "EURUSD"
    # asked again with what was kept: the same requests, answered from the record
    for e in got.values():
        r = client.post(e["route"], json=e["request"], headers=WIN_POST)
        assert r.status_code == 200, (e["route"], r.text)
    rows = client.get("/api/broker/positions?broker=local", headers=WIN_GET).json()
    assert [round(p["qty"], 8) for p in rows] == [0.01]
    assert client.get("/api/broker/orders?broker=local", headers=WIN_GET).json() == []


def test_an_order_the_broker_rejected_is_answered_not_ok_with_its_reason(client, home, clock):
    """A 200 whose order the broker rejected settles it, and is not ok: the
    page shows such an answer in the error style, its reason as its words
    (as the window got them, the stored key taken out)."""
    from test_own_broker import link, write_adapter
    from test_stored_values_hidden import QUOTER, SECRET, _store
    path = write_adapter(home / "quoter", name="quoter.py", source=QUOTER)
    assert link(client, "quoter", python_file=path).status_code == 200
    _store(client, "quoter", SECRET)
    assert client.post("/api/broker/connect", json={"broker": "quoter"},
                       headers=WIN_POST).status_code == 200
    body = {"broker": "quoter", "symbol": "F", "side": "buy", "qty": 1, "type": "limit",
            "price": 9.0, "client_id": "lset-rejected-01"}
    r = client.post("/api/broker/order/pending", json=body, headers=WIN_POST)
    assert r.status_code == 200 and r.json()["status"] == "rejected", r.text
    [got] = held(client)
    assert {k: got[k] for k in ("state", "ok", "status", "detail", "code", "instrument")} == {
        "state": "answered", "ok": False, "status": 200,
        "detail": "refused for the key [hidden]", "code": None, "instrument": "F"}
    assert SECRET not in json.dumps(got)


def test_two_requests_out_under_one_key_each_answer_applies_to_its_own(home, clock):
    """Each answer changes the record only while its own request is the one
    out under the key; one that settles nothing puts back what was there
    before it, another request still out included."""
    from lse_terminal.engine import held_requests as hr
    rec = hr.HeldRequests(record_file(home))
    route, body = "/api/broker/close", {"broker": "b", "position_id": "p1"}
    a = rec.send("b", "lset-two-1", route, body)
    b = rec.send("b", "lset-two-1", route, body)          # the same request, again
    rec.settled(a, ok=True, status=200)                     # the first's answer: not the one out
    assert [e["state"] for e in rec.held()] == ["out"]
    rec.other(b, ok=False, status=409, detail="not connected")   # back to the first, still out
    assert [e["state"] for e in rec.held()] == ["out"]
    rec.settled(a, ok=True, status=200)                     # now its answer counts
    assert [(e["state"], e["ok"]) for e in rec.held()] == [("answered", True)]
    assert on_disk(home) == []
    # an unknown entry asked again twice, the second settling nothing: unknown again
    c = rec.send("b", "lset-two-2", route, body)
    rec.unknown(c, "internal: not known yet", "internal")
    d = rec.send("b", "lset-two-2", route, body)
    e = rec.send("b", "lset-two-2", route, body)
    rec.other(e, ok=False, status=409, detail="not connected")
    rec.other(d, ok=False, status=409, detail="not connected")
    [kept] = [x for x in rec.held() if x["client_id"] == "lset-two-2"]
    assert (kept["state"], kept["detail"], kept["code"]) == (
        "unknown", "internal: not known yet", "internal")


def test_a_repeated_key_is_said_as_a_repeat_when_the_file_is_set_aside(home, capsys):
    """A (broker, client_id) twice in the file is a repeat, and is said so
    when the file is set aside, not as "not held requests"; the first is
    kept."""
    from lse_terminal.engine import held_requests as hr
    path = record_file(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    first = _entry(state="unknown", detail="internal: not known yet", code="internal")
    path.write_text(json.dumps({"v": 2, "held": [first, {**first, "detail": "again"}]}))
    rec = hr.HeldRequests(path)
    kept = {**first, "account": None}          # a version 2 file has no account
    assert rec.held() == [kept]
    [line] = [x for x in capsys.readouterr().err.splitlines() if "[held requests]" in x]
    assert "1 of its 2 entries repeat the broker and client_id of an earlier one" in line, line
    assert "not held requests" not in line
    assert json.loads(path.read_text())["held"] == [kept]
