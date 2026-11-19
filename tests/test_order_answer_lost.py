"""An order, close or cancel whose answer is lost (SPEC 2), through the
engine's routes, as the terminal's window and a program send them.

A broker can take a request and never answer it: the adapter then says its
fate is not known yet (code internal, retryable), and asking again under the
SAME client_id is answered from the broker's own record, never carried out
twice. What is pinned here:
  - the order routes take the client_id back, and the hub sends it;
  - such a failure answers with what asking again needs: `unknown`,
    `retryable` and the `client_id`, beside the code and the whole of the
    broker's words (for a program on a data_local_only connection, the
    sentence in their place, the fields kept);
  - asking again finds an outcome that arrived in between (the fill), so
    the answer says filled at once;
  - one order and one execution however often the same order is asked
    again, and a new order only when one is asked for;
  - a close asked again under its client_id closes once; one asked for
    again without it is a new close, as the user meant;
  - the kit's own timeout on an order is a fate not known, too;
  - and, on the kit's own stand-in for a listed broker: the broker carries
    the first order out late, after the adapter gave up on its answer; the
    user's second click asks again; one market order, one position of 1000.

No broker's API is called: the brokers are the kit's paper engine
(tests/data/terms_adapter.py) and the kit's stand-in on 127.0.0.1.
"""
import importlib.util
import socket
import threading
import time
from pathlib import Path

import pytest

from test_broker_terms import (LICENCE, WIN_GET, WIN_POST, add_profile,  # noqa: F401
                               client, connect, home, wait_for)

ORDER = {"symbol": "EURUSD", "side": "buy", "qty": 0.01}


def _lost_profile(name, flag, terms=None, late_ms=0):
    add_profile(name, terms=terms, extra=("--lose-answer", str(flag),
                                          "--late-ms", str(late_ms)))


def _positions(c, broker):
    return c.get(f"/api/broker/positions?broker={broker}", headers=WIN_GET).json()


def _fills(c, broker):
    return c.get(f"/api/broker/fills?broker={broker}", headers=WIN_GET).json()


def test_an_order_whose_answer_was_lost_is_asked_again_and_placed_once(client, tmp_path):
    """On the paper engine: the broker carries the order out 1.5 s after its
    answer was lost; the user's second click comes before that, and a third
    after. One execution."""
    flag = tmp_path / "lose"
    _lost_profile("local", flag, terms=LICENCE, late_ms=1500)
    connect(client, "local")
    flag.write_text("x")
    body = {"broker": "local", **ORDER}
    r1 = client.post("/api/broker/order", json=body, headers=WIN_POST)
    assert r1.status_code == 400, r1.text
    a1 = r1.json()
    assert (a1["code"], a1["retryable"], a1["unknown"]) == ("internal", True, True)
    cid = a1["client_id"]
    assert cid.startswith("lset-")
    # the broker's words whole, for the window's ticket: not cut at 80 or 300
    assert a1["detail"].startswith("internal: the broker did not answer the order")
    assert a1["detail"].endswith("answered from the broker's own record.")
    # the second click, before the broker has carried it out: asked again
    r2 = client.post("/api/broker/order", json={**body, "client_id": cid}, headers=WIN_POST)
    assert r2.status_code == 400 and r2.json()["unknown"] is True
    assert r2.json()["client_id"] == cid
    # the broker carries it out, once
    rows = wait_for(lambda: _positions(client, "local"), timeout=10)
    assert [(p["symbol"], p["qty"]) for p in rows] == [("EURUSD", 0.01)]
    # asked again after: the outcome that arrived in between, at once
    t0 = time.time()
    r3 = client.post("/api/broker/order", json={**body, "client_id": cid}, headers=WIN_POST)
    assert r3.status_code == 200, r3.text
    a3 = r3.json()
    assert (a3["status"], a3["client_id"]) == ("filled", cid)
    assert a3["fill"]["client_id"] == cid and a3["fill"]["qty"] == 0.01
    assert time.time() - t0 < 4.0                      # not the 5 s fill wait
    assert [(p["symbol"], p["qty"]) for p in _positions(client, "local")] == [("EURUSD", 0.01)]
    assert [f["client_id"] for f in _fills(client, "local")] == [cid]
    # a new order is placed only when one is asked for: no client_id
    flag.unlink()
    r4 = client.post("/api/broker/order", json=body, headers=WIN_POST)
    assert r4.status_code == 200 and r4.json()["client_id"] != cid
    assert [p["qty"] for p in _positions(client, "local")] == [0.02]


def test_a_lost_answer_reaches_a_program_with_what_asking_again_needs(client, tmp_path):
    """A program gets the fields it needs to ask again; on a data_local_only
    connection the sentence stands in for the broker's words."""
    flag = tmp_path / "lose"
    for b, terms in (("local", LICENCE), ("plain", None)):
        _lost_profile(b, flag, terms=terms)
        connect(client, b)
    flag.write_text("x")
    reason = "The broker's reason withheld under Fixture Markets' terms: " + LICENCE["summary"]
    r = client.post("/api/broker/order", json={"broker": "local", **ORDER})
    assert r.status_code == 400, r.text
    a = r.json()
    assert a["detail"] == "internal: " + reason
    assert (a["code"], a["retryable"], a["unknown"]) == ("internal", True, True)
    assert a["client_id"].startswith("lset-")
    r = client.post("/api/broker/order", json={"broker": "plain", **ORDER})
    assert r.status_code == 400 and "not known yet" in r.json()["detail"].lower()
    assert r.json()["unknown"] is True
    # asked again by the program under its client_id: the one execution
    flag.unlink()
    r = client.post("/api/broker/order", json={"broker": "local", **ORDER,
                                               "client_id": a["client_id"]})
    assert r.status_code == 200 and r.json()["client_id"] == a["client_id"]
    assert [p["qty"] for p in _positions(client, "local")] == [0.01]
    # a refusal that is final is said as before, with nothing to ask again
    r = client.post("/api/broker/order", json={"broker": "plain", "symbol": "EURUSD",
                                               "side": "buy", "qty": 500})
    assert r.status_code == 400 and set(r.json()) == {"detail"}


def test_a_close_whose_answer_was_lost_is_asked_again_and_closes_once(client, tmp_path):
    flag = tmp_path / "lose"
    _lost_profile("local", flag, terms=LICENCE)
    connect(client, "local")
    r = client.post("/api/broker/order", json={"broker": "local", **ORDER, "qty": 0.03},
                    headers=WIN_POST)
    assert r.status_code == 200, r.text
    pid = r.json()["fill"]["position_id"]
    flag.write_text("x")
    close = {"broker": "local", "position_id": pid, "qty": 0.01}
    r = client.post("/api/broker/close", json=close, headers=WIN_POST)
    assert r.status_code == 400, r.text
    a = r.json()
    assert (a["unknown"], a["retryable"]) == (True, True)
    cid = a["client_id"]
    assert cid.startswith("close-")
    assert [p["qty"] for p in _positions(client, "local")] == [0.02]   # it was carried out
    flag.unlink()
    # asked again under its client_id: the first outcome, nothing closed twice
    r = client.post("/api/broker/close", json={**close, "client_id": cid}, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert [p["qty"] for p in _positions(client, "local")] == [0.02]
    # the same close asked for again, without it, is a new close
    r = client.post("/api/broker/close", json=close, headers=WIN_POST)
    assert r.status_code == 200, r.text
    assert [p["qty"] for p in _positions(client, "local")] == [0.01]


def test_the_routes_take_a_client_id_and_refuse_one_that_is_not_one(client):
    add_profile("plain")
    connect(client, "plain")
    body = {"broker": "plain", **ORDER}
    for bad in ("two words", "x" * 129, 7, "-lead", ["lset-1"]):
        r = client.post("/api/broker/order", json={**body, "client_id": bad})
        assert r.status_code == 400 and r.json()["detail"].startswith("client_id "), bad
    for path, extra in (("/api/broker/order/pending", {"type": "limit", "price": 1.0}),
                        ("/api/broker/close", {"position_id": "x"}),
                        ("/api/broker/order/cancel", {"order_id": "x"})):
        r = client.post(path, json={**body, **extra, "client_id": "two words"})
        assert r.status_code == 400 and r.json()["detail"].startswith("client_id "), path
    r = client.post("/api/broker/order", json={**body, "client_id": "lset-mine-1"})
    assert r.status_code == 200 and r.json()["client_id"] == "lset-mine-1"
    # the same order under the same id is a replay, not a second order
    r = client.post("/api/broker/order", json={**body, "client_id": "lset-mine-1"})
    assert r.status_code == 200
    assert [p["qty"] for p in _positions(client, "plain")] == [0.01]
    # another order under that id is refused by the kit, never placed
    r = client.post("/api/broker/order", json={**body, "qty": 0.02, "client_id": "lset-mine-1"})
    assert r.status_code == 400 and r.json()["detail"].startswith("duplicate_client_id")
    assert [p["qty"] for p in _positions(client, "plain")] == [0.01]


def test_the_hub_sends_the_client_id_it_is_given_and_makes_one_otherwise(home):
    from lse_terminal.engine.broker_hub import BrokerHub
    sent = []

    class Conn:
        def mark(self):
            return 0

        def request(self, method, params=None, timeout=10.0):
            sent.append((method, dict(params or {})))
            return {}

    hub = BrokerHub.__new__(BrokerHub)
    hub._conn = lambda broker: Conn()
    BrokerHub.cancel_order(hub, "b", "o1", client_id="lset-x-cancel")
    BrokerHub.cancel_order(hub, "b", "o1")
    BrokerHub.close_position(hub, "b", "p1", 0.5, client_id="lset-x-close")
    BrokerHub.close_position(hub, "b", "p1", 0.5)
    cids = [p["client_id"] for _, p in sent]
    assert cids[0] == "lset-x-cancel" and cids[1].startswith("cancel-o1-")
    assert cids[2] == "lset-x-close" and cids[3].startswith("close-p1-0.5-")
    # a cancel or close asked for again without one is a new request
    BrokerHub.cancel_order(hub, "b", "o1")
    assert sent[-1][1]["client_id"] not in cids


def test_the_kits_own_timeout_on_an_order_is_a_fate_not_known(client):
    """The kit gives up on an order after its own time (no answer from the
    adapter): the order was sent and may have been placed."""
    add_profile("plain")
    connect(client, "plain")
    conn = client.hub.conns["plain"]
    real = conn.request

    def slow(method, params=None, timeout=10.0):
        if method == "order.place":
            raise TimeoutError("order.place timed out after 10.0s")
        return real(method, params, timeout)

    conn.request = slow
    r = client.post("/api/broker/order", json={"broker": "plain", **ORDER,
                                               "client_id": "lset-slow-1"},
                    headers=WIN_POST)
    assert r.status_code == 502, r.text
    assert r.json() == {"detail": "order.place timed out after 10.0s", "retryable": True,
                        "unknown": True, "client_id": "lset-slow-1"}


def test_a_lost_answers_long_words_reach_the_ticket_whole(client):
    """What the adapter says about a request whose answer was lost can run
    long: what it knows, what it watched for, what asking again will do. The
    window's ticket gets it whole, well past the 300 characters a short
    refusal once got, with what asking again needs beside it."""
    from brueconnect.client import ConnectorError
    add_profile("plain")
    connect(client, "plain")
    conn = client.hub.conns["plain"]
    real = conn.request
    words = " ".join(
        f"Step {i}: the broker took the order and its answer did not arrive in time." for i in range(1, 11))
    assert len(words) > 600

    def lost(method, params=None, timeout=10.0):
        if method == "order.place":
            raise ConnectorError("internal", words, retryable=True)
        return real(method, params, timeout)

    conn.request = lost
    r = client.post("/api/broker/order", json={"broker": "plain", **ORDER,
                                               "client_id": "lset-long-1"},
                    headers=WIN_POST)
    assert r.status_code == 400, r.text
    assert r.json() == {"detail": "internal: " + words, "code": "internal", "retryable": True,
                        "unknown": True, "client_id": "lset-long-1"}


# ── a late order on the kit's stand-in for a listed broker ─────────────────

def _kit_standin(name):
    """The kit's own stand-in for a broker, beside the brueconnect package of
    a kit checkout (its tests folder), or None (a kit installed as a wheel
    carries no tests)."""
    import brueconnect
    path = Path(brueconnect.__file__).resolve().parents[1] / "tests" / f"{name}.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location(f"kit_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _HoldOnce:
    """A loopback relay in front of the stand-in's REST port that holds the
    first request matching a rule, lets the client give up on it, and then
    sends it on: the broker carries the request out late. The same model as
    the kit's own tests' Proxy "delay" rule."""

    def __init__(self, upstream_port):
        self.up = upstream_port
        self.rules, self.fired = [], []
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
            for i, (match, hold) in enumerate(self.rules):
                if match(method, path):
                    self.rules.pop(i)
                    self.fired.append(("held", time.time()))
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
                if hold:
                    raw = head + b"\r\n\r\n" + body
                    threading.Thread(target=self._late, args=(raw, hold),
                                     daemon=True).start()
                    time.sleep(hold + 1.0)
                    return
                if up is None:
                    up = socket.create_connection(("127.0.0.1", self.up), timeout=30)
                up.sendall(head + b"\r\n\r\n" + body)
                rhead, rrest = self._head(up, b"")
                if rhead is None:
                    return
                rbody, _ = self._body(up, rhead, rrest)
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

    def _late(self, raw, seconds):
        time.sleep(seconds)
        try:
            up = socket.create_connection(("127.0.0.1", self.up), timeout=30)
            up.sendall(raw)
            head, rest = self._head(up, b"")
            self._body(up, head or b"", rest)
            up.close()
            with self._lock:
                self.fired.append(("sent on", time.time()))
        except OSError:
            pass


def test_the_listed_rows_lost_order_asked_again_on_the_kits_stand_in(client, monkeypatch):
    """A late order, as the window sends it: the listed row linked and
    its token stored, the netting account chosen, Buy 1000 EUR_USD. The
    broker carries the order out 15 s late, after the adapter gave up on its
    answer. The user's second click, 2 s after the first answer, asks again
    under the first one's client_id. One market order, one position of
    1000; asked once more after it turned up, the answer is its fill."""
    fake_oanda = _kit_standin("fake_oanda")
    if fake_oanda is None:
        pytest.skip("the kit's stand-in is not beside this kit (a wheel install)")
    fake = fake_oanda.FakeOanda(division="uk", new_connections_per_second=None).start()
    relay = _HoldOnce(fake.port)
    try:
        monkeypatch.setenv("OANDA_REST_URL", relay.url)
        monkeypatch.setenv("OANDA_STREAM_URL", fake.stream_url)
        aid = fake.account_ids[0]
        json_win = {**WIN_POST, "Content-Type": "application/json"}
        r = client.post("/api/broker/link", json={"name": "my-oanda", "example": "oanda"},
                        headers=json_win)
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/credentials", headers=WIN_POST, json={
            "broker": "my-oanda", "values": {"token": fake.token}, "merge": True})
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/connect", json={"broker": "my-oanda"}, headers=WIN_POST)
        row = r.json()
        if row.get("needs_account"):
            row = client.post("/api/broker/account", headers=WIN_POST,
                              json={"broker": "my-oanda", "account_id": aid}).json()
        assert row.get("connected"), row
        fake.set_price("EUR_USD", bid=1.10000, ask=1.10010)
        time.sleep(1.0)
        orders = "/v3/accounts/%s/orders" % aid
        relay.rules.append((lambda m, p: m == "POST" and p == orders, 15.0))
        body = {"broker": "my-oanda", "symbol": "EUR_USD", "side": "buy", "qty": 1000}
        r1 = client.post("/api/broker/order", json=body, headers=WIN_POST)
        assert r1.status_code == 400, r1.text
        a1 = r1.json()
        assert (a1["unknown"], a1["retryable"]) == (True, True), a1
        # The adapter's whole words, which say the order's fate is not known
        # yet, in whatever case the kit writes them ("Not known yet whether
        # ..."); the engine itself reads only the code and `retryable`.
        assert "not known yet" in a1["detail"].lower() and len(a1["detail"]) > 80
        time.sleep(2.0)
        r2 = client.post("/api/broker/order", json={**body, "client_id": a1["client_id"]},
                         headers=WIN_POST)
        assert r2.status_code == 400 and r2.json()["unknown"] is True, r2.text
        assert wait_for(lambda: any(f[0] == "sent on" for f in relay.fired), timeout=30)
        time.sleep(4.0)
        txs = fake.transactions(aid)
        markets = [t for t in txs if t.get("type") == "MARKET_ORDER"]
        assert len(markets) == 1, markets
        rows = wait_for(lambda: [p for p in client.get("/api/broker/positions?broker=my-oanda",
                                                       headers=WIN_GET).json() if p["qty"]])
        assert [(p["symbol"], p["qty"]) for p in rows] == [("EUR_USD", 1000.0)]
        r3 = client.post("/api/broker/order", json={**body, "client_id": a1["client_id"]},
                         headers=WIN_POST)
        assert r3.status_code == 200, r3.text
        assert (r3.json()["status"], r3.json()["client_id"]) == ("filled", a1["client_id"])
        assert len([t for t in fake.transactions(aid) if t.get("type") == "MARKET_ORDER"]) == 1
    finally:
        try:
            client.hub.disconnect("my-oanda")
        except Exception:  # noqa: BLE001
            pass
        relay.close()
        fake.stop()
