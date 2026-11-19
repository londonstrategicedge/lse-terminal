"""Each listed row's `priced` (EXAMPLES), held to what its adapter does.

A row's `priced` names the SPEC 4 figures its adapter works out from a price;
a program on a data_local_only connection is given every other figure
(BrokerHub.priced_fields, server.broker_catalog). test_broker_terms.py holds
the rows to their adapters' source by its literals; this holds them to what
the adapters do, as a user's program meets them.

Each listed row is linked as the user links it, given its key on the kit's
own stand-in, and connected through the engine; its catalog is read as a
program and as the window read it. Then every instrument's price at the
stand-in moves up by half and the row is connected again: a new adapter
process, its catalog built at the new prices (the catalog an adapter keeps
from its last run, *_catalog.json in its state folder, is taken out first, or
it would answer from that). Every SPEC 4 figure a program
keeps (not in `priced`) is the same at both prices, and a SPEC 4 figure that
moved is one `priced` names. Each stand-in's listing also carries each
instrument's current mid beside its own fields (x_mid), as a listing may, so
a figure worked out from a price read there moves too.

Nothing here reaches a broker: the stand-ins answer on 127.0.0.1.
"""
from pathlib import Path

import pytest

from test_broker_terms import (  # noqa: F401 - fixtures
    WIN_GET, WIN_POST, client, home)
from test_order_answer_lost import _kit_standin

WIN_JSON = {**WIN_POST, "Content-Type": "application/json"}


def _oanda(monkeypatch):
    mod = _kit_standin("fake_oanda")
    fake = mod.FakeOanda(division="uk", new_connections_per_second=None).start()
    monkeypatch.setenv("OANDA_REST_URL", fake.rest_url)
    monkeypatch.setenv("OANDA_STREAM_URL", fake.stream_url)
    market = fake.market
    for name, inst in market.instruments.items():
        row = inst.row
        inst.row = (lambda row=row, name=name: {**row(), "x_mid": str(market.mid(name))})

    def move():
        for name in list(market.instruments):
            fake.set_price(name, jump_pct=50)
    return (fake, {"token": fake.token}, move,
            lambda: {n: float(market.mid(n)) for n in market.instruments})


def _alpaca(monkeypatch):
    mod = _kit_standin("fake_alpaca")
    fake = mod.FakeAlpaca().start()
    monkeypatch.setenv("ALPACA_TRADING_URL", fake.url)
    monkeypatch.setenv("ALPACA_DATA_URL", fake.url)
    monkeypatch.setenv("ALPACA_STREAM_URL", fake.stream_url)
    market = fake.market
    assets = fake._assets

    def with_mid(q):
        status, rows = assets(q)
        if status != 200:
            return status, rows
        mids = {i.symbol: _alpaca_mid(fake, i) for i in market.instruments}
        return status, [{**r, "x_mid": str(mids.get(r.get("symbol")))} for r in rows]
    fake._assets = with_mid

    def move():
        for inst in market.instruments:
            fake.set_price(inst.symbol, jump_pct=50)
    return (fake, {"api_key": fake.key_id, "api_secret": fake.secret}, move,
            lambda: {i.symbol: _alpaca_mid(fake, i) for i in market.instruments})


def _alpaca_mid(fake, inst):
    return fake.market.mid(inst, fake.market.now_ms())


def _capitalcom(monkeypatch):
    mod = _kit_standin("fake_capitalcom")
    fake = mod.FakeCapitalCom(market="open").start()
    monkeypatch.setenv("CAPITALCOM_API_URL", fake.api_url)
    monkeypatch.setenv("CAPITALCOM_STREAM_URL", fake.stream_url)
    market = fake.market

    def move():
        for inst in market.instruments:
            fake.set_price(inst.epic, jump_pct=50)
    return (fake, {"api_key": fake.api_key, "identifier": fake.identifier,
                   "password": fake.password}, move,
            lambda: {i.epic: market.mid(i.epic) for i in market.instruments})


STANDINS = {"oanda": _oanda, "alpaca": _alpaca, "capitalcom": _capitalcom}


def _connect(client, name):
    r = client.post("/api/broker/connect", json={"broker": name}, headers=WIN_POST)
    assert r.status_code == 200, r.text
    row = r.json()
    if not row.get("connected") and (row.get("needs_account") or row.get("accounts")):
        r = client.post("/api/broker/account", headers=WIN_POST, json={
            "broker": name, "account_id": row["accounts"][0]["id"]})
        assert r.status_code == 200, r.text
        row = r.json()
    assert row.get("connected"), row
    return row


def _catalog(client, name):
    win = client.get(f"/api/broker/catalog?broker={name}", headers=WIN_GET)
    prog = client.get(f"/api/broker/catalog?broker={name}")
    assert win.status_code == 200 and prog.status_code == 200, (win.text, prog.text)
    return ({r["symbol"]: r for r in win.json()}, {r["symbol"]: r for r in prog.json()})


@pytest.mark.parametrize("key", ["oanda", "alpaca", "capitalcom"])
def test_a_listed_rows_kept_figures_stay_put_when_the_price_moves(client, monkeypatch, key):
    from lse_terminal.engine import broker_hub as bh
    if _kit_standin("fake_" + key) is None:
        pytest.skip("the kit's stand-ins are not beside this kit (a wheel install)")
    fake, creds, move, mids = STANDINS[key](monkeypatch)
    name = "my-" + key
    try:
        priced = set(bh.EXAMPLES[key]["priced"])
        r = client.post("/api/broker/link", json={"name": name, "example": key}, headers=WIN_JSON)
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/credentials", headers=WIN_POST, json={
            "broker": name, "values": creds, "merge": True})
        assert r.status_code == 200, r.text
        _connect(client, name)
        win_a, prog_a = _catalog(client, name)
        assert win_a and sorted(win_a) == sorted(prog_a)
        before = mids()
        r = client.post("/api/broker/disconnect", json={"broker": name}, headers=WIN_POST)
        assert r.status_code == 200, r.text
        from brueconnect import registry
        for kept in Path(registry.state_dir(name)).glob("*catalog*.json"):
            kept.unlink()
        move()
        after = mids()
        moved_prices = [s for s in before if before[s] and after.get(s)
                        and abs(after[s] / before[s] - 1.5) < 0.05]
        assert len(moved_prices) >= len(before) // 2, (before, after)
        _connect(client, name)
        win_b, prog_b = _catalog(client, name)
        assert sorted(win_b) == sorted(win_a)
        # every SPEC 4 figure that moved with the price is one `priced` names
        moved = set()
        for sym, a in win_a.items():
            rec_a, _ = bh.instrument_record_only(a, priced=())
            rec_b, _ = bh.instrument_record_only(win_b[sym], priced=())
            moved |= {k for k in set(rec_a) | set(rec_b) if rec_a.get(k) != rec_b.get(k)}
        print("figures that moved with the price:", key, sorted(moved))
        assert moved <= priced, (key, sorted(moved - priced))
        # a row that says its adapter works a figure out from a price shows
        # it here: this check sees a figure move
        assert moved or not priced, (key, "no figure moved")
        # and what a program is given is the same at both prices
        changed = {s: (prog_a[s], prog_b[s]) for s in prog_a if prog_a[s] != prog_b.get(s)}
        assert not changed, (key, list(changed.items())[:2])
    finally:
        try:
            client.hub.disconnect(name)
        except Exception:  # noqa: BLE001
            pass
        fake.stop()
