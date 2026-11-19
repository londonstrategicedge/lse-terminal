"""The window's requests whose fate is not known, held across a reload and
across engine runs (GET /api/broker/held, lse_terminal/engine/held_requests.py).

An order, a resting order, a cancel or a close that the broker may have
carried out but whose answer was lost is held by the terminal's page, which
asks again under its client_id. A page reloads by itself, and its memory goes
with it; the engine keeps the record, and the page loaded next reads it back.
Pinned here, as the page and a program send their requests:
  - the route's shape, oldest first, for the window alone;
  - on each of the four routes, an unknown answer holds the request, a later
    one replaces it and keeps when it was first held, and each kind of answer
    that settles it lets it go from the file, listed answered: carried out,
    refused, and the broker's final "not carried out";
  - an answer that settles nothing (a retry that can mend it, the broker not
    connected) leaves it held;
  - unlinking, and forgetting, a broker let its requests go;
  - a program's requests are never recorded, nor its answers counted;
  - the record survives a new engine on the same config folder, over HTTP as
    the page reads it; it is written whole and synced, mode 0600, with no
    credential in it;
  - a damaged record is set aside with one line on the engine's log, and the
    engine starts.

The brokers are the kit's paper engine (tests/data/terms_adapter.py); a
lost answer is either the fixture's own (--lose-answer) or a connection told
what to answer. Nothing here reaches the network. A request held "out"
before it is handed on, and an answer listed "answered" for 120 s, are
pinned in test_held_requests_out.py.
"""
import json
import os
import stat
import threading
import time
from pathlib import Path

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    LICENCE, WIN_GET, WIN_POST, _free_port, add_profile, call, client, connect, home,
    wait_for)

PROGRAM_JSON = {"Content-Type": "application/json"}
WIN_JSON = {**WIN_POST, "Content-Type": "application/json"}
OWN_WINDOW = "this action is only available from the terminal's own window"
FIELDS = {"broker", "client_id", "route", "what", "request", "since", "detail", "code",
          "state", "instrument", "account"}


# ── helpers ────────────────────────────────────────────────────────────────

def held(c, headers=WIN_GET):
    r = c.get("/api/broker/held", headers=headers)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"held"}
    return r.json()["held"]


def record_file(home):
    return home / "cfg" / "held_requests.json"


def on_disk(home):
    p = record_file(home)
    return json.loads(p.read_text())["held"] if p.exists() else []


@pytest.fixture()
def clock(monkeypatch):
    """The record's clock, set by the test: each entry's `since`."""
    from lse_terminal.engine import held_requests
    now = {"t": "2026-11-15T10:00:00Z"}
    monkeypatch.setattr(held_requests, "_now", lambda: now["t"])
    return now


def _lost(m):
    from brueconnect.client import ConnectorError
    return ConnectorError("internal", f"the broker did not answer the {m} (timeout); whether "
                          "it carried it out is not known yet.", retryable=True)


def LOST(real, m, params, timeout):                 # carried out, its answer lost
    real(m, params, timeout)
    raise _lost(m)


def LOST_UNSENT(real, m, params, timeout):          # its answer lost, not carried out
    raise _lost(m)


def TIMEOUT(real, m, params, timeout):              # the kit gave up waiting
    raise TimeoutError(f"{m} timed out after 10.0s")


def REAL(real, m, params, timeout):                 # asked again: the broker's record
    return real(m, params, timeout)


def REFUSED(real, m, params, timeout):
    from brueconnect.client import ConnectorError
    raise ConnectorError("invalid_qty", "the size is not a multiple of the lot step")


def FINAL(real, m, params, timeout):                # the broker's final "not carried out"
    from brueconnect.client import ConnectorError
    raise ConnectorError("x_fixture_not_carried_out", "It was not carried out: the broker's "
                         "record shows nothing of it 120 s after its answer was lost. Send "
                         "it as a new request if it is still wanted.", like="internal")


def RATE_LIMITED(real, m, params, timeout):         # a retry can mend it; nothing is known
    from brueconnect.client import ConnectorError
    raise ConnectorError("rate_limited", "too many requests", retryable=True)


def script(c, broker, method, *steps):
    """The next calls of `method` on this connection answer as `steps` say,
    in order; every other call, and every call after them, as the adapter."""
    conn = c.hub.conns[broker]
    real = conn.request
    queue = list(steps)

    def request(m, params=None, timeout=10.0):
        if m == method and queue:
            return queue.pop(0)(real, m, params, timeout)
        return real(m, params, timeout)

    conn.request = request
    return queue


def _place(c, body):
    r = c.post("/api/broker/order", json=body, headers=WIN_POST)
    assert r.status_code == 200, r.text
    return r.json()


def _setup(c, kind):
    """(route, the method it sends, the body the page sends) for one kind,
    with what it acts on in place (a resting order to cancel, a position to
    close), put there by a program so that nothing of it is recorded."""
    order = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01}
    if kind == "order":
        return "/api/broker/order", "order.place", {**order, "client_id": "lset-a1b2c3d4e5f6"}
    if kind == "resting":
        return ("/api/broker/order/pending", "order.place",
                {**order, "type": "limit", "price": 1.0, "client_id": "lset-0a0b0c0d0e0f"})
    if kind == "cancel":
        r = c.post("/api/broker/order/pending", json={
            **order, "type": "limit", "price": 1.0, "client_id": "lset-rest-1"})
        assert r.status_code == 200, r.text
        return ("/api/broker/order/cancel", "order.cancel",
                {"broker": "local", "order_id": r.json()["order_id"],
                 "client_id": "lset-cancel-9f8e7d6c5b4a"})
    r = c.post("/api/broker/order", json={**order, "qty": 0.03})
    assert r.status_code == 200, r.text
    pid = r.json()["fill"]["position_id"]
    return ("/api/broker/close", "position.close",
            {"broker": "local", "position_id": pid, "qty": 0.01,
             "client_id": "lset-close-09586a88cde2"})


WHAT = {"order": "order", "resting": "resting", "cancel": "cancel", "close": "close"}


# ── the route ──────────────────────────────────────────────────────────────

def test_the_route_is_the_windows_alone_and_answers_its_shape(client, home, clock):
    add_profile("local", terms=LICENCE, extra=("--resting",))
    connect(client, "local")
    assert held(client) == []
    # a program, a page of another origin, and an address typed: refused,
    # with the words the window-only routes give
    for h in ({}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "none"},
              {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:1"}):
        r = client.get("/api/broker/held", headers=h)
        assert (r.status_code, r.json()) == (403, {"detail": OWN_WINDOW}), h
    # two lost answers, held oldest first, each as the contract spells it
    script(client, "local", "order.place", LOST, LOST_UNSENT)
    first = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
             "sl": None, "tp": None, "client_id": "lset-1111aaaa2222"}
    r = client.post("/api/broker/order", json=first, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    answer = r.json()
    clock["t"] = "2026-11-15T10:00:07Z"
    second = {"broker": "local", "symbol": "EURUSD", "side": "sell", "qty": 0.02,
              "type": "limit", "price": 1.5, "client_id": "lset-3333bbbb4444"}
    r = client.post("/api/broker/order/pending", json=second, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    got = held(client)
    assert [set(e) for e in got] == [FIELDS, FIELDS]
    assert got[0] == {"broker": "local", "client_id": "lset-1111aaaa2222",
                      "route": "/api/broker/order", "what": "order", "request": first,
                      "since": "2026-11-15T10:00:00Z", "detail": answer["detail"],
                      "code": "internal", "state": "unknown", "instrument": "EURUSD",
                      "account": None}
    assert answer["detail"].startswith("internal: the broker did not answer the order.place")
    assert (got[1]["route"], got[1]["what"], got[1]["request"], got[1]["since"],
            got[1]["state"], got[1]["instrument"]) == (
        "/api/broker/order/pending", "resting", second, "2026-11-15T10:00:07Z", "unknown",
        "EURUSD")
    # what the page reads is what is on disk
    assert on_disk(home) == got
    # a program still gets nothing of it
    assert client.get("/api/broker/held").status_code == 403


@pytest.mark.parametrize("kind", ["order", "resting", "cancel", "close"])
@pytest.mark.parametrize("settles", ["carried out", "refused", "not carried out"])
def test_each_route_holds_replaces_and_lets_go(client, home, clock, kind, settles):
    """On each of the four routes: an unknown answer holds the window's
    request; a later one under the same key replaces it and keeps `since`;
    an answer that settles it lets it go from the file, and it is listed
    answered with that answer's status."""
    add_profile("local", terms=LICENCE, extra=("--resting",))
    connect(client, "local")
    route, method, body = _setup(client, kind)
    last = {"carried out": REAL, "refused": REFUSED, "not carried out": FINAL}[settles]
    script(client, "local", method, LOST, TIMEOUT, RATE_LIMITED, last)
    # 1. the answer is lost: held
    r = client.post(route, json=body, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    first = r.json()
    got = held(client)
    assert got == [{"broker": "local", "client_id": body["client_id"], "route": route,
                    "what": WHAT[kind], "request": body, "since": "2026-11-15T10:00:00Z",
                    "detail": first["detail"], "code": "internal", "state": "unknown",
                    "instrument": body.get("symbol"), "account": None}], got
    assert on_disk(home) == got
    # 2. asked again, the kit gave up waiting: replaced, its first time kept
    clock["t"] = "2026-11-15T10:01:30Z"
    r = client.post(route, json=body, headers=WIN_POST)
    assert r.status_code == 502 and r.json()["unknown"] is True, r.text
    got = held(client)
    assert len(got) == 1
    assert got[0]["detail"] == f"{method} timed out after 10.0s" != first["detail"]
    assert (got[0]["code"], got[0]["since"]) == (None, "2026-11-15T10:00:00Z")
    assert on_disk(home) == got
    # 3. asked again, an answer that settles nothing (a retry can mend it): still held
    r = client.post(route, json=body, headers=WIN_POST)
    assert r.status_code == 400 and r.json()["unknown"] is False, r.text
    assert held(client) == got
    # 4. the answer that settles it: let go
    r = client.post(route, json=body, headers=WIN_POST)
    if settles == "carried out":
        assert r.status_code == 200, r.text
    else:
        assert r.status_code == 400 and set(r.json()) == {"detail"}, r.text
    assert [(e["client_id"], e["state"], e["status"]) for e in held(client)] == [
        (body["client_id"], "answered", r.status_code)]
    assert on_disk(home) == []


def test_an_answer_about_nothing_held_and_one_from_no_broker_leave_it_held(client, clock):
    """Only an answer under its own key settles a held request, and the
    broker not connected says nothing about it: refused before it reaches
    the broker, the request stays held, through the reconnect after it."""
    add_profile("local", terms=LICENCE, extra=("--resting",))
    connect(client, "local")
    script(client, "local", "order.place", LOST)
    body = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
            "client_id": "lset-held-000001"}
    assert client.post("/api/broker/order", json=body, headers=WIN_POST).status_code == 400
    # another order, carried out: not this one
    _place(client, {**body, "client_id": "lset-other-000002"})
    # the broker disconnected: asking again is refused before it reaches it
    client.post("/api/broker/disconnect", json={"broker": "local"}, headers=WIN_POST)
    r = client.post("/api/broker/order", json=body, headers=WIN_POST)
    assert r.status_code == 409, r.text
    # (the other order's answer is listed answered beside it)
    picture = [("lset-held-000001", "unknown"), ("lset-other-000002", "answered")]
    assert [(e["client_id"], e["state"]) for e in held(client)] == picture
    # connected again (the page reads the record after each connect)
    connect(client, "local")
    assert [(e["client_id"], e["state"]) for e in held(client)] == picture


def test_the_fixtures_own_lost_answers_are_held_and_let_go_when_asked_again(
        client, home, tmp_path, clock):
    """The adapter's own lost answers, with nothing scripted: an order the
    broker carries out late, and a close and a cancel it carried out at once.
    Each is held; asked again under its client_id, each is answered from the
    broker's record and let go."""
    flag = tmp_path / "lose"
    add_profile("local", terms=LICENCE, extra=("--resting", "--lose-answer", str(flag),
                                               "--late-ms", "1500"))
    connect(client, "local")
    # what the three act on, put in place by a program (nothing recorded)
    pid = client.post("/api/broker/order", json={
        "broker": "local", "symbol": "EURUSD", "side": "buy",
        "qty": 0.03}).json()["fill"]["position_id"]
    rest = client.post("/api/broker/order/pending", json={
        "broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
        "type": "limit", "price": 1.0}).json()["order_id"]
    flag.write_text("x")
    sent = [("/api/broker/order", {"broker": "local", "symbol": "EURUSD", "side": "buy",
                                   "qty": 0.01, "client_id": "lset-late-000001"}),
            ("/api/broker/close", {"broker": "local", "position_id": pid, "qty": 0.01,
                                   "client_id": "lset-close-000001"}),
            ("/api/broker/order/cancel", {"broker": "local", "order_id": rest,
                                          "client_id": "lset-cancel-000001"})]
    for route, body in sent:
        r = client.post(route, json=body, headers=WIN_POST)
        assert r.status_code == 400 and r.json()["unknown"] is True, (route, r.text)
    assert [(e["route"], e["client_id"]) for e in held(client)] == [
        (route, body["client_id"]) for route, body in sent]
    flag.unlink()
    assert wait_for(lambda: [p for p in client.get("/api/broker/positions?broker=local",
                                                   headers=WIN_GET).json()
                             if abs(p["qty"] - 0.03) < 1e-9], timeout=10)
    for route, body in sent:
        r = client.post(route, json=body, headers=WIN_POST)
        assert r.status_code == 200, (route, r.text)
    assert [(e["client_id"], e["state"], e["ok"]) for e in held(client)] == [
        (body["client_id"], "answered", True) for _, body in sent]
    assert on_disk(home) == []
    rows = client.get("/api/broker/positions?broker=local", headers=WIN_GET).json()
    assert [round(p["qty"], 8) for p in rows] == [0.03]    # +0.01 late, -0.01 closed: once each
    assert client.get("/api/broker/orders?broker=local", headers=WIN_GET).json() == []


# ── who is recorded ────────────────────────────────────────────────────────

def test_a_programs_requests_are_never_recorded(client, home, clock):
    """A program's lost answer reaches it with what asking again needs, and
    is not held; its own answers, under a key the window holds, do not let
    the window's request go: the record is the window's."""
    add_profile("local", terms=LICENCE, extra=("--resting",))
    connect(client, "local")
    script(client, "local", "order.place", LOST, LOST)
    body = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
            "client_id": "lset-prog-000001"}
    r = client.post("/api/broker/order", json=body)               # a program
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    assert held(client) == [] and not record_file(home).exists()
    # the window's own lost order, then the program asking again under its key
    mine = {**body, "client_id": "lset-win-000001"}
    assert client.post("/api/broker/order", json=mine, headers=WIN_POST).status_code == 400
    r = client.post("/api/broker/order", json=mine)               # a program, answered
    assert r.status_code == 200, r.text
    assert [e["client_id"] for e in held(client)] == ["lset-win-000001"]
    assert client.get("/api/broker/held").status_code == 403


def test_unlinking_or_forgetting_a_broker_lets_its_held_requests_go(client, home, clock):
    for b in ("one", "two"):
        add_profile(b, terms=LICENCE, extra=("--resting",))
        connect(client, b)
        script(client, b, "order.place", LOST)
        r = client.post("/api/broker/order", headers=WIN_POST, json={
            "broker": b, "symbol": "EURUSD", "side": "buy", "qty": 0.01,
            "client_id": f"lset-{b}-000001"})
        assert r.status_code == 400 and r.json()["unknown"] is True
    assert [e["broker"] for e in held(client)] == ["one", "two"]
    r = client.post("/api/broker/unlink", json={"name": "one"}, headers=WIN_JSON)
    assert r.status_code == 200, r.text
    assert [e["broker"] for e in held(client)] == ["two"] and len(on_disk(home)) == 1
    r = client.post("/api/broker/unlink", json={"name": "two", "forget": True},
                    headers=WIN_JSON)
    assert r.status_code == 200 and r.json()["forgot"] is True, r.text
    assert held(client) == [] and on_disk(home) == []


# ── kept on disk ───────────────────────────────────────────────────────────

def test_the_record_survives_a_new_engine_on_the_same_config_folder(client, home, clock):
    """Written whole and synced, mode 0600, read when the next engine starts;
    no credential in it, even where the adapter's words quoted one."""
    from brueconnect import registry
    from brueconnect.client import ConnectorError
    from lse_terminal.engine.server import create_app
    from fastapi.testclient import TestClient
    secret = "s3cr3t-held-0003"
    add_profile("local", terms=LICENCE, extra=("--resting",))
    registry.set_credentials("local", {"api_secret": secret})
    connect(client, "local")

    def quoting(real, m, params, timeout):
        raise ConnectorError("internal", f"not known yet; the key it was sent: {secret}",
                             retryable=True)
    script(client, "local", "order.place", quoting)
    body = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
            "client_id": "lset-kept-000001", "note": f"pasted {secret}"}
    r = client.post("/api/broker/order", json=body, headers=WIN_POST)
    assert r.status_code == 400 and secret not in r.text, r.text
    before = held(client)
    assert before[0]["detail"] == "internal: not known yet; the key it was sent: [hidden]"
    raw = record_file(home).read_bytes()
    assert secret.encode() not in raw
    assert json.loads(raw)["v"] == 3          # version 3: each entry with its account
    if os.name == "posix":
        assert stat.S_IMODE(record_file(home).stat().st_mode) == 0o600
    assert [p.name for p in record_file(home).parent.iterdir()
            if p.name.startswith("held_requests")] == ["held_requests.json"]
    client.hub.shutdown()
    # a new engine, the same config folder
    app2 = create_app()
    try:
        c2 = TestClient(app2, base_url="http://127.0.0.1")
        assert held(c2) == before
    finally:
        app2.state.broker_hub.shutdown()


def test_the_record_is_written_through_a_synced_file_renamed_over_it(home, monkeypatch, clock):
    from lse_terminal.engine import held_requests as hr
    seen = []
    real_fsync, real_replace = os.fsync, os.replace
    monkeypatch.setattr(hr.os, "fsync", lambda fd: (seen.append(("fsync", fd)), real_fsync(fd))[1])
    monkeypatch.setattr(hr.os, "replace", lambda a, b: (seen.append(("replace", str(a), str(b))),
                                                        real_replace(a, b))[1])
    path = home / "cfg" / hr.FILE_NAME
    rec = hr.HeldRequests(path)
    ticket = rec.send("b", "lset-x-1", "/api/broker/close", {"broker": "b", "position_id": "p1"})
    kinds = [s[0] for s in seen]
    assert kinds[:2] == ["fsync", "replace"], seen
    _, tmp, final = seen[1]
    assert final == str(path) and Path(tmp).parent == path.parent and tmp != final
    assert not Path(tmp).exists()
    rec.unknown(ticket, "internal: not known yet", "internal")
    kinds = [s[0] for s in seen]
    # each change written the same way: the file synced, then renamed over
    assert kinds.count("replace") == 2 and all(
        kinds[i - 1] == "fsync" for i, k in enumerate(kinds) if k == "replace"), seen
    # the body, its client_id put in it when the page sent none
    assert rec.held()[0]["request"] == {"broker": "b", "position_id": "p1",
                                        "client_id": "lset-x-1"}
    assert json.loads(path.read_text())["held"] == rec.held()


@pytest.mark.parametrize("damage,kept", [
    (b"\x00\x01 not json", 0),
    (b'{"v": 1, "held": {"not": "a list"}}', 0),
    (b"[]", 0),
    (None, 1),                                 # one good entry beside one that is not
])
def test_a_damaged_record_is_set_aside_and_the_engine_starts(home, capsys, damage, kept):
    from fastapi.testclient import TestClient
    from lse_terminal.engine.server import create_app
    path = record_file(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    good = {"broker": "local", "client_id": "lset-good-000001", "route": "/api/broker/close",
            "what": "close", "request": {"broker": "local", "position_id": "p1",
                                         "client_id": "lset-good-000001"},
            "since": "2026-11-15T09:00:00Z", "detail": "internal: not known yet",
            "code": "internal"}
    if damage is None:
        damage = json.dumps({"v": 1, "held": [good, {**good, "what": "order"}]}).encode()
    path.write_bytes(damage)
    capsys.readouterr()
    # (the good entry as version 1 wrote it: read as unknown, no account)
    want = [{**good, "state": "unknown", "instrument": None, "account": None}] if kept else []
    app = create_app()
    try:
        c = TestClient(app, base_url="http://127.0.0.1")
        assert c.get("/api/health").status_code == 200          # the engine started
        assert held(c) == want
    finally:
        app.state.broker_hub.shutdown()
    aside = [p for p in path.parent.iterdir() if p.name.startswith("held_requests.json.bad-")]
    assert len(aside) == 1 and aside[0].read_bytes() == damage
    lines = [x for x in capsys.readouterr().err.splitlines() if "[held requests]" in x]
    assert len(lines) == 1 and aside[0].name in lines[0], lines
    # what could be read is written back whole, and nothing else
    assert on_disk(home) == want


# ── as the page reads it: over HTTP, across two engines ────────────────────

class _Engine:
    """The engine on a loopback port, as the app runs it."""

    def __init__(self):
        import uvicorn
        from lse_terminal.engine.server import create_app
        self.app = create_app()
        port = _free_port()
        self.base = f"http://127.0.0.1:{port}"
        self.server = uvicorn.Server(uvicorn.Config(
            self.app, host="127.0.0.1", port=port, log_level="warning",
            access_log=False, lifespan="on"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        deadline = time.time() + 20
        while not self.server.started and time.time() < deadline:
            time.sleep(0.05)
        assert self.server.started, "the engine did not start"
        self.win_get = {"Sec-Fetch-Site": "same-origin"}
        self.win_post = {"Sec-Fetch-Site": "same-origin", "Origin": self.base}

    def stop(self):
        self.server.should_exit = True
        self.thread.join(15)
        self.app.state.broker_hub.shutdown()


def test_a_page_loaded_on_a_new_engine_reads_the_held_order_and_asks_again(home, tmp_path):
    """The user's path: the page's order is lost (the fixture's own lost
    answer), the engine stops and a new one starts on the same config folder,
    the page loaded on it reads GET /api/broker/held, every byte, and asks
    again with what it holds: answered from the broker's record, the one
    execution, and nothing held after."""
    flag = tmp_path / "lose"
    add_profile("local", terms=LICENCE, extra=("--lose-answer", str(flag)))
    e1 = _Engine()
    try:
        st, row = call(e1.base, "/api/broker/connect", "POST", {"broker": "local"},
                       headers=e1.win_post)
        assert st == 200 and row["connected"], row
        flag.write_text("x")
        body = {"broker": "local", "symbol": "EURUSD", "side": "buy", "qty": 0.01,
                "client_id": "lset-c0ffee000001"}
        st, ans = call(e1.base, "/api/broker/order", "POST", body, headers=e1.win_post)
        assert st == 400 and ans["unknown"] is True, ans
        st, got = call(e1.base, "/api/broker/held", headers=e1.win_get)
        assert st == 200 and [e["client_id"] for e in got["held"]] == [body["client_id"]]
        # a program over HTTP: refused
        assert call(e1.base, "/api/broker/held")[0] == 403
    finally:
        e1.stop()
    flag.unlink()
    e2 = _Engine()
    try:
        st, got = call(e2.base, "/api/broker/held", headers=e2.win_get)
        assert st == 200 and len(got["held"]) == 1, got
        entry = got["held"][0]
        assert (entry["route"], entry["what"], entry["request"], entry["state"]) == (
            "/api/broker/order", "order", body, "unknown")
        st, row = call(e2.base, "/api/broker/connect", "POST", {"broker": "local"},
                       headers=e2.win_post)
        assert st == 200 and row["connected"], row
        st, ans = call(e2.base, entry["route"], "POST", entry["request"], headers=e2.win_post)
        assert st == 200 and ans["client_id"] == body["client_id"], ans
        st, got = call(e2.base, "/api/broker/held", headers=e2.win_get)
        assert st == 200 and [(x["client_id"], x["state"], x["ok"]) for x in got["held"]] == [
            (body["client_id"], "answered", True)]
        assert on_disk(home) == []
        st, rows = call(e2.base, "/api/broker/positions?broker=local", headers=e2.win_get)
        assert [p["qty"] for p in rows] == [0.01], rows
    finally:
        e2.stop()
