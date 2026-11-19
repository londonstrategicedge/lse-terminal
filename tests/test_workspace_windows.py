"""More than one window on one engine: a window's save must not erase what
another window saved since it last read (engine/workspace.py), and each
window's broker display subscription is kept apart (BrokerHub).

The page names its window in X-LSE-Window (one name per page load); a caller
that names none is written as sent, exactly as before."""
import json
import threading

import pytest
from fastapi.testclient import TestClient

from lse_terminal.engine import workspace
from lse_terminal.engine.broker_hub import BrokerHub
from lse_terminal.engine.server import create_app
from lse_terminal.engine.workspace import merge3


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LSE_TERMINAL_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("BRUE_CONNECT_HOME", str(tmp_path / "brue-connect"))
    monkeypatch.delenv("LSE_API_KEY", raising=False)
    workspace._VIEWS.clear()
    return TestClient(create_app(), base_url="http://127.0.0.1")


def _as(window):
    return {"X-LSE-Window": window}


# ── the rule itself ─────────────────────────────────────────────────────

def test_what_the_window_did_not_change_keeps_the_files_value():
    assert merge3({"a": 1}, {"a": 1}, {"a": 1, "b": 2}) == {"a": 1, "b": 2}


def test_what_nobody_else_changed_takes_the_windows_value():
    assert merge3({"a": 1}, {"a": 5}, {"a": 1}) == {"a": 5}


def test_two_windows_change_different_keys_and_both_are_kept():
    base = {"lse:EUR/USD": ["line-1"]}
    mine = {"lse:EUR/USD": ["line-1"], "lse:GBP/USD": ["box-1"]}
    theirs = {"lse:EUR/USD": ["line-1", "line-2"]}
    assert merge3(base, mine, theirs) == {
        "lse:EUR/USD": ["line-1", "line-2"], "lse:GBP/USD": ["box-1"]}


def test_a_removal_is_kept_unless_the_other_window_changed_the_thing():
    base = {"a": [1], "b": [2]}
    # this window removed both; the other changed b meanwhile
    assert merge3(base, {}, {"a": [1], "b": [2, 3]}) == {"b": [2, 3]}
    # the other window removed a; this one never touched it
    assert merge3(base, {"a": [1], "b": [9]}, {"b": [2]}) == {"b": [9]}
    # the other window removed a; this one changed it: the change is kept
    assert merge3(base, {"a": [1, 5], "b": [2]}, {"b": [2]}) == {"a": [1, 5], "b": [2]}


def test_the_same_key_changed_in_both_takes_the_window_that_saves():
    assert merge3({"a": [1]}, {"a": [1, 2]}, {"a": [1, 3]}) == {"a": [1, 2]}


def test_nested_objects_merge_key_by_key():
    base = {"watchlists": {"lse": ["A"]}, "chartType": "candles"}
    mine = {"watchlists": {"lse": ["A"]}, "chartType": "line"}
    theirs = {"watchlists": {"lse": ["A"], "broker:x": ["B"]}, "chartType": "candles"}
    assert merge3(base, mine, theirs) == {
        "watchlists": {"lse": ["A"], "broker:x": ["B"]}, "chartType": "line"}


def test_lists_of_records_with_ids_merge_record_by_record():
    base = [{"id": "1", "name": "a"}, {"id": "2", "name": "b"}]
    mine = [{"id": "1", "name": "a"}, {"id": "2", "name": "b"}, {"id": "3", "name": "mine"}]
    theirs = [{"id": "1", "name": "renamed"}, {"id": "4", "name": "theirs"}]   # removed 2, added 4
    assert merge3(base, mine, theirs) == [
        {"id": "1", "name": "renamed"}, {"id": "3", "name": "mine"}, {"id": "4", "name": "theirs"}]


def test_a_list_without_ids_is_taken_whole():
    assert merge3(["BTC"], ["BTC", "ETH"], ["BTC", "SOL"]) == ["BTC", "ETH"]
    # duplicate ids are not records to merge by
    assert merge3([{"id": 1}], [{"id": 1}, {"id": 1}], [{"id": 1}, {"id": 2}]) == [{"id": 1}, {"id": 1}]


def test_a_section_that_changed_type_takes_the_window_that_saves():
    assert merge3({"a": 1}, ["x"], {"a": 2}) == ["x"]
    assert merge3(None, {"a": 1}, {"b": 2}) == {"a": 1, "b": 2}


# ── through the engine's routes ─────────────────────────────────────────

def test_two_windows_drawings_both_survive(client, tmp_path):
    client.put("/api/workspace/drawings", json={"lse:EUR/USD": ["line-1"]})
    # both windows read the section once, as the chart bundle does
    for w in ("main.aaaa", "w2.bbbb"):
        assert client.get("/api/workspace/drawings", headers=_as(w)).json()["value"] == {
            "lse:EUR/USD": ["line-1"]}
    # window 2 draws on another symbol; the main window then draws on EUR/USD
    r2 = client.put("/api/workspace/drawings", headers=_as("w2.bbbb"),
                    json={"lse:EUR/USD": ["line-1"], "lse:GBP/USD": ["box-1"]})
    r1 = client.put("/api/workspace/drawings", headers=_as("main.aaaa"),
                    json={"lse:EUR/USD": ["line-1", "line-2"]})
    assert r2.json() == {"ok": True, "section": "drawings", "merged": False}
    assert r1.json()["merged"] is True
    on_disk = json.loads((tmp_path / "workspace.json").read_text())["drawings"]
    assert on_disk == {"lse:EUR/USD": ["line-1", "line-2"], "lse:GBP/USD": ["box-1"]}
    # and again: the main window's own copy still lacks GBP/USD; its next
    # save must not take it away
    client.put("/api/workspace/drawings", headers=_as("main.aaaa"),
               json={"lse:EUR/USD": ["line-1", "line-2", "line-3"]})
    assert client.get("/api/workspace/drawings").json()["value"] == {
        "lse:EUR/USD": ["line-1", "line-2", "line-3"], "lse:GBP/USD": ["box-1"]}


def test_a_window_that_deletes_its_own_drawing_deletes_it(client):
    client.put("/api/workspace/drawings", json={"a": [1], "b": [2]})
    client.get("/api/workspace/drawings", headers=_as("main.aaaa"))
    client.put("/api/workspace/drawings", headers=_as("main.aaaa"), json={"b": [2]})
    assert client.get("/api/workspace/drawings").json()["value"] == {"b": [2]}


def test_a_caller_that_names_no_window_is_written_as_sent(client):
    client.put("/api/workspace/drawings", json={"a": [1], "b": [2]})
    client.put("/api/workspace/drawings", json={"c": [3]})
    assert client.get("/api/workspace/drawings").json()["value"] == {"c": [3]}


def test_a_window_the_engine_has_not_seen_read_is_written_as_sent(client):
    client.put("/api/workspace/drawings", json={"a": [1]})
    client.put("/api/workspace/drawings", headers=_as("w9.zzzz"), json={"c": [3]})
    assert client.get("/api/workspace/drawings").json()["value"] == {"c": [3]}


def test_a_bad_window_name_is_no_window(client):
    client.put("/api/workspace/drawings", json={"a": [1]})
    bad = {"X-LSE-Window": "../../etc x"}
    client.get("/api/workspace/drawings", headers=bad)
    client.put("/api/workspace/drawings", headers=bad, json={"c": [3]})
    assert client.get("/api/workspace/drawings").json()["value"] == {"c": [3]}
    assert not any(k[0].startswith("..") for k in workspace._VIEWS)


def test_the_views_kept_are_bounded(client, monkeypatch):
    monkeypatch.setattr(workspace, "_VIEWS_KEPT", 5)
    for i in range(20):
        client.get("/api/workspace/shell", headers=_as(f"w{i}.x"))
    assert len(workspace._VIEWS) == 5


def test_the_stars_of_two_windows_are_both_kept(client):
    shell = {"activeIndicators": [{"name": "sma"}], "favoriteIndicators": [],
             "chartType": "candles", "watchlists": {"lse": ["EUR/USD"]}, "railWidgets": []}
    client.put("/api/workspace/shell", json=shell)
    a = client.get("/api/workspace/shell", headers=_as("main.a")).json()["value"]
    b = client.get("/api/workspace/shell", headers=_as("w2.b")).json()["value"]
    a["chartType"] = "line"                       # the main window changes its chart
    b["watchlists"]["broker:paper"] = ["XAUUSD"]  # window 2 stars on another source
    client.put("/api/workspace/shell", headers=_as("w2.b"), json=b)
    client.put("/api/workspace/shell", headers=_as("main.a"), json=a)
    stored = client.get("/api/workspace/shell").json()["value"]
    assert stored["watchlists"] == {"lse": ["EUR/USD"], "broker:paper": ["XAUUSD"]}
    assert stored["chartType"] == "line"


def test_the_dashboards_section_exists_and_merges_widgets_by_id(client):
    doc = {"version": 1, "current": "b1", "boards": [
        {"id": "b1", "name": "My dashboard", "widgets": [{"id": "w1", "title": "A", "code": "1"}]}]}
    assert client.put("/api/workspace/dashboards", json=doc).status_code == 200
    a = client.get("/api/workspace/dashboards", headers=_as("main.a")).json()["value"]
    b = client.get("/api/workspace/dashboards", headers=_as("w2.b")).json()["value"]
    a["boards"][0]["widgets"].append({"id": "w2", "title": "from main", "code": "2"})
    b["boards"][0]["widgets"].append({"id": "w3", "title": "from window 2", "code": "3"})
    client.put("/api/workspace/dashboards", headers=_as("main.a"), json=a)
    client.put("/api/workspace/dashboards", headers=_as("w2.b"), json=b)
    titles = [w["title"] for w in
              client.get("/api/workspace/dashboards").json()["value"]["boards"][0]["widgets"]]
    assert sorted(titles) == ["A", "from main", "from window 2"]


def test_an_unknown_section_is_still_refused(client):
    assert client.put("/api/workspace/nonsense", json={}).status_code == 404


# ── a broker's display subscriptions, one claim per window ──────────────

class Connector:
    def __init__(self, existing=(), cap=100):
        self.subscribed = list(existing)
        self.alive = True
        self.cap = cap
        self.requests = []
        self.handshake = {"capabilities": {"data": {"quotes": True}}}

    def subscribe(self, names):
        take, refused = [], []
        for s in names:
            if s in self.subscribed:
                continue
            if len(self.subscribed) >= self.cap:
                refused.append(s)
                continue
            self.subscribed.append(s)
            take.append(s)
            self.requests.append(("add", s))
        return {"subscribed": take, "refused": refused, "cap": self.cap}

    def unsubscribe(self, names):
        for s in names:
            if s in self.subscribed:
                self.subscribed.remove(s)
                self.requests.append(("drop", s))
        return {"unsubscribed": names}

    def close(self):
        self.alive = False


def _hub(c):
    h = BrokerHub.__new__(BrokerHub)
    h.lock = threading.RLock()
    h._quote_owners = {}
    h.conns = {"0": c}
    h.registry = {"0": {}}
    h.quotes = {}
    h.pending_auth = {}
    return h


def test_a_second_windows_ticket_does_not_end_the_first_ones_prices():
    c = Connector()
    h = _hub(c)
    h.subscribe_display("0", ["EURUSD", "HELD"], "main.a")
    h.subscribe_display("0", ["XAUUSD", "HELD"], "w2.b")
    assert set(c.subscribed) == {"EURUSD", "XAUUSD", "HELD"}
    # each window asks again after its positions refresh: nothing is dropped
    h.subscribe_display("0", ["EURUSD", "HELD"], "main.a")
    h.subscribe_display("0", ["XAUUSD", "HELD"], "w2.b")
    assert set(c.subscribed) == {"EURUSD", "XAUUSD", "HELD"}
    assert ("drop", "EURUSD") not in c.requests and ("drop", "XAUUSD") not in c.requests


def test_a_window_changing_its_symbol_drops_only_its_own():
    c = Connector()
    h = _hub(c)
    h.subscribe_display("0", ["EURUSD"], "main.a")
    h.subscribe_display("0", ["XAUUSD"], "w2.b")
    h.subscribe_display("0", ["GBPUSD"], "main.a")
    assert set(c.subscribed) == {"GBPUSD", "XAUUSD"}
    # a symbol both windows show stays while either shows it
    h.subscribe_display("0", ["XAUUSD"], "main.a")
    h.subscribe_display("0", ["USDJPY"], "w2.b")
    assert set(c.subscribed) == {"XAUUSD", "USDJPY"}


def test_a_window_that_stopped_asking_gives_its_claims_up(monkeypatch):
    c = Connector()
    h = _hub(c)
    now = [1000.0]
    monkeypatch.setattr("lse_terminal.engine.broker_hub.time.monotonic", lambda: now[0])
    h.subscribe_display("0", ["EURUSD"], "main.a")
    h.subscribe_display("0", ["XAUUSD"], "w2.b")
    now[0] += BrokerHub.DISPLAY_CLAIM_TTL_S - 1
    h.subscribe_display("0", ["EURUSD"], "main.a")
    assert set(c.subscribed) == {"EURUSD", "XAUUSD"}     # not long enough yet
    now[0] += 2                                          # window 2 closed 46 s ago
    h.subscribe_display("0", ["EURUSD"], "main.a")
    assert c.subscribed == ["EURUSD"]


def test_at_the_brokers_cap_a_window_is_told_only_of_its_own_symbols():
    c = Connector(cap=2)
    h = _hub(c)
    assert h.subscribe_display("0", ["A", "B"], "main.a")["refused"] == []
    out = h.subscribe_display("0", ["C"], "w2.b")
    assert out["refused"] == ["C"]
    # the main window asks again: what did not fit is window 2's, not its own
    out = h.subscribe_display("0", ["A", "B"], "main.a")
    assert out["refused"] == [] and out["quotes"] is True


def test_one_display_behaves_as_it_always_did():
    c = Connector(["EXTERNAL"])
    h = _hub(c)
    h.subscribe_display("0", ["OLD"])
    h.subscribe_display("0", ["NEW"])
    assert c.subscribed == ["EXTERNAL", "NEW"]
    assert h._quote_owners["0"]["display"] == {"NEW"}
    h.subscribe_display("0", [])
    assert c.subscribed == ["EXTERNAL"]


def test_the_route_names_the_display_from_the_windows_header(client, monkeypatch):
    seen = []

    def fake(self, broker, symbols, display=""):
        seen.append((broker, symbols, display))
        return {"subscribed": symbols, "refused": [], "quotes": True}

    monkeypatch.setattr(BrokerHub, "subscribe_display", fake)
    r = client.post("/api/broker/subscribe", json={"broker": "paper-fast", "symbols": ["EURUSD"]},
                    headers=_as("w2.abcd"))
    assert r.status_code == 200
    client.post("/api/broker/subscribe", json={"broker": "paper-fast", "symbols": ["EURUSD"]})
    assert seen == [("paper-fast", ["EURUSD"], "w2.abcd"), ("paper-fast", ["EURUSD"], "")]
