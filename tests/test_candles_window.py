"""/api/candles takes a window's start and end as ISO 8601 or as epoch
seconds, on every source, and answers 400 in plain words naming those forms
for anything else.

What is guarded against: an ISO start or end on a broker source answering
404 with Python's own words ("invalid literal for int() with base 10:
'2026-...'"), from a broker source that reads each bound with int(); and
epoch seconds on the demo and My Data sources failing the other way ("year
1794700800 is out of range"). The route reads each bound once, in either
form (a time with Z or an offset, a time with neither read as UTC, a date
read as its midnight UTC, or epoch seconds as a number), and hands every
source the same ISO time; the broker source reads either form too, for the
engine's other callers.

Through the route as a program and as the window (the window alone on a
source whose terms keep its prices on this computer, which a program is
refused). The brokers are the kit's paper engine (tests/data/
terms_adapter.py); the LSE source is given a stand-in client, so nothing
here reaches the network.
"""
from datetime import datetime, timezone

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    LICENCE, WIN_GET, WIN_POST, add_profile, client, connect, home, wait_for)


def _iso(ts: int, offset_h: int = 0, z: bool = True) -> str:
    dt = datetime.fromtimestamp(ts, timezone.utc)
    if offset_h:
        from datetime import timedelta
        tz = timezone(timedelta(hours=offset_h))
        return dt.astimezone(tz).isoformat()
    s = dt.strftime("%Y-%m-%dT%H:%M:%S")
    return s + "Z" if z else s


def _candles(c, provider, symbol, timeframe, headers, **window):
    params = {"provider": provider, "symbol": symbol, "timeframe": timeframe,
              "limit": 5000, **window}
    return c.get("/api/candles", params=params, headers=headers)


def _forms(a: int, b: int):
    """The same window [a, b] written every way the route takes it."""
    return {"iso Z": (_iso(a), _iso(b)),
            "iso offset": (_iso(a, offset_h=2), _iso(b, offset_h=-5)),
            "iso naive": (_iso(a, z=False), _iso(b, z=False)),
            "epoch": (str(a), str(b)),
            "epoch fraction": (f"{a - 0.5}", f"{b + 0.5}")}


def _check_window(c, provider, symbol, timeframe, who):
    whole = _candles(c, provider, symbol, timeframe, who)
    assert whole.status_code == 200, whole.text
    bars = whole.json()["candles"]
    assert len(bars) >= 8, (provider, len(bars))
    a, b = bars[2][0], bars[5][0]
    want = [x for x in bars if a <= x[0] <= b]
    assert len(want) >= 2, want
    for form, (start, end) in _forms(a, b).items():
        r = _candles(c, provider, symbol, timeframe, who, start=start, end=end)
        assert r.status_code == 200, (provider, form, r.status_code, r.text)
        got = r.json()["candles"]
        assert [x[0] for x in got] == [x[0] for x in want], (provider, form, got[:3], want[:3])
    # a start alone, and an end alone
    r = _candles(c, provider, symbol, timeframe, who, start=_iso(a))
    assert r.status_code == 200 and r.json()["candles"][0][0] == a, (provider, r.text[:200])
    r = _candles(c, provider, symbol, timeframe, who, end=str(b))
    assert r.status_code == 200 and r.json()["candles"][-1][0] == b, (provider, r.text[:200])


@pytest.mark.parametrize("who", ["program", "window"])
def test_a_broker_source_takes_iso_and_epoch_seconds(client, who):
    add_profile("plain")
    row = connect(client, "plain")
    assert row.get("data_source") == "broker:plain", row
    headers = {} if who == "program" else WIN_GET
    # the fixture's minute bars, a few of them closed already
    assert wait_for(lambda: len(_candles(client, "broker:plain", "EURUSD", "1m", headers)
                                .json()["candles"]) >= 8, timeout=20)
    _check_window(client, "broker:plain", "EURUSD", "1m", headers)


def test_a_data_local_only_broker_source_takes_both_forms_in_the_window(client):
    add_profile("local", terms=LICENCE)
    connect(client, "local")
    assert wait_for(lambda: len(_candles(client, "broker:local", "EURUSD", "1m", WIN_GET)
                                .json()["candles"]) >= 8, timeout=20)
    _check_window(client, "broker:local", "EURUSD", "1m", WIN_GET)
    # a program is refused its prices, as before, whatever the window
    r = _candles(client, "broker:local", "EURUSD", "1m", {}, start="2026-01-05T00:00:00Z")
    assert r.status_code == 403, r.text


@pytest.mark.parametrize("who", ["program", "window"])
@pytest.mark.parametrize("provider,symbol,timeframe", [("demo", "DEMO:EURUSD", "1h"),
                                                       ("userdata", "EURUSD", "1h")])
def test_the_other_sources_take_both_forms(client, who, provider, symbol, timeframe):
    _check_window(client, provider, symbol, timeframe, {} if who == "program" else WIN_GET)


def test_the_lse_source_is_handed_the_same_time_in_either_form(client, monkeypatch):
    """The LSE source asks the hosted gate, which takes a time in its own
    shape; a stand-in client records what it is asked, for each form."""
    from lse_terminal.providers import lse as lse_mod
    asked = []

    class Stand:
        def candles(self, symbol, timeframe, start=None, end=None, limit=None, order=None):
            asked.append((start, end))
            return []
    p = client.app.state.registry.get("lse") if hasattr(client.app.state, "registry") else None
    if p is None:
        pytest.skip("the registry is not reachable from the app state")
    monkeypatch.setattr(p, "_lse", lambda: Stand())
    a, b = 1794700800, 1794704400
    for form, (start, end) in _forms(a, b).items():
        asked.clear()
        r = _candles(client, "lse", "EURUSD", "1h", WIN_GET, start=start, end=end)
        assert r.status_code == 200, (form, r.text)
        s, e = asked[0]
        assert lse_mod.LseProvider._gate_ts(s) == "2026-11-15T00:00:00", (form, s)
        assert lse_mod.LseProvider._gate_ts(e) == "2026-11-15T01:00:00", (form, e)


@pytest.mark.parametrize("bad", ["yesterday", "2026-13-40", "1e400", "nan", "12:30",
                                 "2026-11-15T09:30:00Q", "true"])
@pytest.mark.parametrize("which", ["start", "end"])
def test_anything_else_is_answered_400_in_plain_words(client, bad, which):
    add_profile("plain")
    connect(client, "plain")
    for provider in ("broker:plain", "demo"):
        r = _candles(client, provider, "EURUSD", "1h", {}, **{which: bad})
        assert r.status_code == 400, (provider, bad, r.status_code, r.text)
        detail = r.json()["detail"]
        assert detail.startswith(f"{which} must be a time in ISO 8601"), detail
        assert "epoch seconds" in detail and repr(bad) in detail, detail
        assert "invalid literal" not in detail and "out of range" not in detail


def test_the_window_reader_itself():
    from lse_terminal.engine.broker_hub import window_seconds
    assert window_seconds(None) is None and window_seconds("") is None
    assert window_seconds("2026-11-15T00:00:00Z") == 1794700800
    assert window_seconds("2026-11-15T01:00:00+01:00") == 1794700800
    assert window_seconds("2026-11-15T00:00:00") == 1794700800
    assert window_seconds("2026-11-15") == 1794700800
    assert window_seconds("1794700800") == 1794700800
    assert window_seconds(1794700800) == 1794700800
    # inside a second: a start is the next whole one, an end the one before
    assert window_seconds("1794700800.5", "start") == 1794700801
    assert window_seconds("1794700800.5", "end") == 1794700800
    assert window_seconds("2026-11-15T00:00:00.250Z", "start") == 1794700801
    for bad in ("yesterday", "nan", "inf", "1e400", True):
        with pytest.raises(ValueError):
            window_seconds(bad)
