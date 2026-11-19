"""A listed row's chart source offers 30m, since its adapter serves it.

Each listed adapter maps the SPEC's 30m onto its broker's own period (read
from the adapters: one asks M30, one MINUTE_30, one 30Min), but a broker
source offered the provider contract's default timeframes, which have no
30m. Each listed row now says which timeframes its adapter serves (its
EXAMPLES entry's `timeframes`, held here to the adapter's own TIMEFRAMES
table, read from its source), its source offers them, and a 30m chart loads
from each at the kit's stand-in for it. A profile our listing does not name
keeps the default. The period now forming at 30m is built from closed minute
bars as it is for the other periods up to four hours.

Nothing here reaches a broker: the stand-ins answer on 127.0.0.1.
"""
import ast
import time

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    WIN_GET, WIN_POST, add_profile, client, connect, home, wait_for)
from test_listed_priced_figures import STANDINS, _connect
from test_order_answer_lost import _kit_standin

WIN_JSON = {**WIN_POST, "Content-Type": "application/json"}
SPEC_ORDER = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]
# The 30m period each stand-in is asked for, as its adapter writes it.
ASKED = {"oanda": "M30", "capitalcom": "MINUTE_30", "alpaca": "30Min"}
SYMBOL = {"oanda": "EUR_USD", "capitalcom": None, "alpaca": None}


def _adapter_timeframes(key):
    """The keys of the TIMEFRAMES table in the listed adapter's own source."""
    from lse_terminal.engine import broker_hub as bh
    path = bh.connect_base().joinpath(*bh.EXAMPLES[key]["path"])
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if (isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "TIMEFRAMES"
                                                 for t in node.targets)):
            return [k.value for k in node.value.keys]
    raise AssertionError(f"no TIMEFRAMES in {path}")


@pytest.mark.parametrize("key", ["oanda", "capitalcom", "alpaca"])
def test_each_listed_row_says_the_timeframes_its_adapter_serves(key):
    from lse_terminal.engine import broker_hub as bh
    served = _adapter_timeframes(key)
    row = list(bh.EXAMPLES[key]["timeframes"])
    assert "30m" in served and "30m" in row, (key, served, row)
    assert sorted(row, key=SPEC_ORDER.index) == row, row          # in display order
    assert set(row) == set(served), (key, row, served)


def test_a_profile_the_listing_does_not_name_keeps_the_default(client):
    from lse_terminal.contracts.provider import Provider
    add_profile("plain")
    row = connect(client, "plain")
    assert row.get("data_source") == "broker:plain"
    [src] = [p for p in client.get("/api/providers").json() if p["name"] == "broker:plain"]
    assert src["timeframes"] == list(Provider.timeframes), src


def test_the_period_forming_at_30m_is_built_from_minute_bars():
    from lse_terminal.engine.broker_hub import BrokerProvider
    assert BrokerProvider.FORMING_FROM_1M["30m"] == 1800
    begin = 1794700800                  # a whole half hour
    minutes = {"bars": [[(begin + 60 * i) * 1000, 1.0 + i, 2.0 + i, 0.5, 1.5 + i, 10]
                        for i in range(3)]}
    row = BrokerProvider._forming(minutes, 1800, begin - 1800, now=begin + 200)
    assert row == [begin, 1.0, 4.0, 0.5, 3.5, 30.0], row


def _asked_30m(fake, key) -> list:
    """The stand-in's own log of the requests that asked for its 30m period."""
    want = ASKED[key]
    return [r for r in fake.requests() if isinstance(r, dict) and r.get("method") == "GET"
            and want in (str(r.get("query")) + str(r.get("path")))]


@pytest.mark.parametrize("key", ["oanda", "capitalcom", "alpaca"])
def test_a_30m_chart_loads_from_each_listed_row_at_its_stand_in(client, monkeypatch, key):
    if _kit_standin("fake_" + key) is None:
        pytest.skip("the kit's stand-ins are not beside this kit (a wheel install)")
    fake, creds, _move, _mids = STANDINS[key](monkeypatch)
    name = "my-" + key
    try:
        r = client.post("/api/broker/link", json={"name": name, "example": key}, headers=WIN_JSON)
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/credentials", headers=WIN_POST, json={
            "broker": name, "values": creds, "merge": True})
        assert r.status_code == 200, r.text
        row = _connect(client, name)
        assert row.get("data_source") == f"broker:{name}", row
        [src] = [p for p in client.get("/api/providers").json() if p["name"] == f"broker:{name}"]
        assert "30m" in src["timeframes"], src
        catalog = client.get(f"/api/broker/catalog?broker={name}", headers=WIN_GET).json()
        symbol = SYMBOL[key] or catalog[0]["symbol"]
        assert any(i["symbol"] == symbol for i in catalog), symbol
        r = client.get("/api/candles", headers=WIN_GET, params={
            "provider": f"broker:{name}", "symbol": symbol, "timeframe": "30m", "limit": 200})
        assert r.status_code == 200, r.text
        bars = r.json()["candles"]
        assert len(bars) >= 20, (key, len(bars))
        steps = [b[0] - a[0] for a, b in zip(bars, bars[1:])]
        # closed bars a half hour apart (a market's closed hours may leave a gap)
        assert min(steps) == 1800 and sum(s == 1800 for s in steps) >= len(steps) // 2, steps[:20]
        assert all(b[0] % 1800 == 0 for b in bars), [b[0] for b in bars[:5]]
        # the stand-in's own record: it was asked for its 30-minute period
        asked = _asked_30m(fake, key)
        assert asked, (key, [r.get("path") for r in fake.requests()][-10:])
        print("30m bars at the stand-in:", key, symbol, len(bars), bars[-1],
              "asked:", asked[-1].get("path"), asked[-1].get("query"))
    finally:
        try:
            client.hub.disconnect(name)
        except Exception:  # noqa: BLE001
            pass
        fake.stop()
