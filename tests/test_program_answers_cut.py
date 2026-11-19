"""A program's answers on a data_local_only connection carry the account's
own record only (SPEC 3.3, SPEC 4), its mutating answers too, and the
withheld line names only fields that can carry a price.

What is guarded against:
  - a program's POST /api/broker/order answer carrying `fill`, the adapter's
    order.filled data as sent (x_mid "1.08512", x_note "filled while the mid
    was 1.08512"), while GET /api/broker/fills is cut; and the cancel, close
    and modify answers relayed as the adapter sent them ({"x_mid": ...});
  - on the listed row at the kit's stand-in, a program's orders losing
    trail_points and its fills losing reason_detail, neither of them a price,
    and every row saying they were withheld under the broker's price terms.
A program's order answer carries its fill cut to SPEC 4's Fill (with
realized_pnl, swap, commission and reason_detail), and its cancel, close and
modify answers are SPEC's {} (with the withheld line when something was left
out); trail_points and oco_group stay in an order, reason_detail in a fill;
and a field left out whose value is null, true or false, which carries no
price, is not named in the line. The window gets every answer whole, and a
connection without such terms is as before.

The adapters are small Python files written into each test's own folder,
and the listed row runs against the kit's stand-in on 127.0.0.1; nothing
here reaches a broker.
"""
import json

import pytest

from test_broker_terms import WIN_GET as T_WIN_GET, WIN_POST as T_WIN_POST  # noqa: F401
from test_order_answer_lost import _kit_standin
from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, link, rows, write_adapter)
from test_stored_values_hidden import WIN_GET, WIN_POST, _connect

PRICE = "1.08512"
WHY = "under Local Fill's terms: Local Fill licenses its prices to you alone."

# The adapter. With --quiet its own fields are null, true or false only;
# with --no-terms it is a connection whose terms restrict nothing.
LOCAL_FILL = '''
import sys, time
from brueconnect import Adapter

PRICE = "1.08512"
QUIET = "--quiet" in sys.argv

def spec(symbol):
    return {"symbol": symbol, "name": symbol, "asset_class": "fx",
            "base_ccy": "EUR", "quote_ccy": "USD", "digits": 5,
            "tick_size": 0.00001, "lot_step": 1, "min_qty": 1, "max_qty": 1000000,
            "contract_size": 1, "margin_rate": 0.05,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


def extra():
    if QUIET:
        return {"x_flag": True, "x_none": None}
    return {"x_mid": PRICE}


class LocalFill(Adapter):
    name, version, broker = "localfill", "0.1", "local fill broker"
    terms = ({} if "--no-terms" in sys.argv else
             {"data_local_only": True,
              "summary": "Local Fill licenses its prices to you alone."})

    def broker_info(self):
        return {"display_name": "Local Fill"}

    def capabilities(self):
        return {"orders": {"market": True, "pending": True, "pending_types": ["limit"],
                           "can_list": True, "modify": True},
                "data": {"quotes": True, "bars": False, "history": False}}

    def handle_catalog_list(self, params):
        return {"instruments": [spec("EURUSD")]}

    def handle_account_get(self, params):
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": [{"position_id": "p1", "symbol": "EURUSD", "side": "buy",
                               "qty": 1000, "avg_price": 1.08, "opened_at": 1,
                               **({"current_price": None} if QUIET else {})}]}

    def handle_order_place(self, params):
        cid = params["client_id"]
        self.emit("order.accepted", {"client_id": cid, "order_id": "o9"})
        fill = {"fill_id": "f9", "order_id": "o9", "position_id": "p1",
                "client_id": cid, "symbol": params["symbol"],
                "side": params["side"], "qty": params["qty"],
                "price": 1.08, "fees": 0.0, "time": int(time.time() * 1000),
                "reason_detail": "MARKET_ORDER", "realized_pnl": 0.0}
        if QUIET:
            fill.update(x_flag=True, x_none=None)
        else:
            fill.update(x_mid=PRICE, x_note="filled while the mid was " + PRICE)
        self.emit("order.filled", fill)
        return {"order_id": "o9", "status": "accepted"}

    def handle_order_cancel(self, params):
        return extra()

    def handle_position_close(self, params):
        return extra()

    def handle_order_modify(self, params):
        return extra()

    def handle_orders_list(self, params):
        return {"orders": [{"order_id": "o1", "client_id": "c1", "symbol": "EURUSD",
                            "type": "limit", "side": "buy", "qty": 1000,
                            "filled_qty": 0, "remaining_qty": 1000, "price": 1.07,
                            "state": "resting", "placed_at": 1, "trail_points": 0,
                            "oco_group": "g1", **({"x_flag": False} if QUIET else {})}]}

    def handle_history_fills(self, params):
        return {"fills": [{"fill_id": "f1", "order_id": "o0", "position_id": "p1",
                           "client_id": "c0", "symbol": "EURUSD", "side": "buy",
                           "qty": 1000, "price": 1.08, "fees": -0.5, "time": 5,
                           "reason_detail": "MARKET_ORDER",
                           **({"x_none": None} if QUIET else {"x_last": PRICE})}]}

LocalFill().run()
'''


def _linked(client, home, name="localfill", args=()):
    path = write_adapter(home / name, name="localfill.py", source=LOCAL_FILL)
    assert link(client, name, python_file=path, args=list(args)).status_code == 200
    r = _connect(client, name, WIN_POST)
    assert r.status_code == 200, r.text
    return r.json()


def _mutating(client, name, headers):
    """The four mutating answers, as `headers` sends them."""
    out = {}
    out["order"] = client.post("/api/broker/order", headers=headers, json={
        "broker": name, "symbol": "EURUSD", "side": "buy", "qty": 1000})
    out["cancel"] = client.post("/api/broker/order/cancel", headers=headers, json={
        "broker": name, "order_id": "o1", "symbol": "EURUSD"})
    out["close"] = client.post("/api/broker/close", headers=headers, json={
        "broker": name, "position_id": "p1"})
    out["modify"] = client.post("/api/broker/modify", headers=headers, json={
        "broker": name, "position_id": "p1", "sl": None, "tp": None})
    got = {k: (v.status_code, v.json()) for k, v in out.items()}
    assert all(s == 200 for s, _ in got.values()), got
    return {k: body for k, (_, body) in got.items()}


def test_a_programs_mutating_answers_carry_the_record_only(client, home):
    """A program's order answer, and its cancel, close and modify answers,
    carry no price the adapter added."""
    assert _linked(client, home)["terms"]["data_local_only"] is True
    got = _mutating(client, "localfill", {})
    assert PRICE not in json.dumps(got), json.dumps(got, indent=1)
    fill = dict(got["order"]["fill"])
    assert isinstance(fill.pop("time"), int)
    assert fill == {"fill_id": "f9", "order_id": "o9", "position_id": "p1",
                    "client_id": got["order"]["client_id"], "symbol": "EURUSD",
                    "side": "buy", "qty": 1000.0, "price": 1.08, "fees": 0.0,
                    "reason_detail": "MARKET_ORDER", "realized_pnl": 0.0,
                    "withheld": "x_mid, x_note withheld " + WHY}, fill
    assert {k: v for k, v in got["order"].items() if k != "fill"} == {
        "order_id": "o9", "client_id": got["order"]["client_id"], "status": "filled"}
    for k in ("cancel", "close", "modify"):
        assert got[k] == {"withheld": "x_mid withheld " + WHY}, (k, got[k])
    # the fills route as before: cut
    assert PRICE not in client.get("/api/broker/fills?broker=localfill").text


def test_the_window_gets_every_answer_whole(client, home):
    _linked(client, home)
    got = _mutating(client, "localfill", WIN_POST)
    assert got["order"]["fill"]["x_mid"] == PRICE, got["order"]
    assert got["order"]["fill"]["x_note"] == "filled while the mid was " + PRICE
    for k in ("cancel", "close", "modify"):
        assert got[k] == {"x_mid": PRICE}, (k, got[k])


def test_a_connection_without_terms_answers_a_program_as_before(client, home):
    row = _linked(client, home, name="plainfill", args=["--no-terms"])
    assert row["terms"]["data_local_only"] is False
    got = _mutating(client, "plainfill", {})
    assert got["order"]["fill"]["x_mid"] == PRICE and "withheld" not in got["order"]["fill"]
    for k in ("cancel", "close", "modify"):
        assert got[k] == {"x_mid": PRICE}, (k, got[k])


def test_a_field_that_can_carry_no_price_is_left_out_unnamed(client, home):
    """null, true and false carry no price: such an added field is left out
    of the record without a line saying a price was held back."""
    _linked(client, home, args=["--quiet"])
    got = _mutating(client, "localfill", {})
    assert "withheld" not in got["order"]["fill"], got["order"]
    assert not ({"x_flag", "x_none"} & set(got["order"]["fill"])), got["order"]
    for k in ("cancel", "close", "modify"):
        assert got[k] == {}, (k, got[k])
    orders = client.get("/api/broker/orders?broker=localfill").json()
    fills = client.get("/api/broker/fills?broker=localfill").json()
    poss = client.get("/api/broker/positions?broker=localfill").json()
    for row in orders + fills + poss:
        assert "withheld" not in row and not ({"x_flag", "x_none", "current_price"} & set(row)), row


def test_trail_points_oco_group_and_reason_detail_are_kept(client, home):
    """Not prices: an order's trailing distance and its OCO group, a fill's
    reason in the broker's own word (SPEC 5's reason_detail)."""
    _linked(client, home)
    [order] = client.get("/api/broker/orders?broker=localfill").json()
    assert (order["trail_points"], order["oco_group"]) == (0, "g1"), order
    assert "withheld" not in order, order
    [fill] = client.get("/api/broker/fills?broker=localfill").json()
    assert fill["reason_detail"] == "MARKET_ORDER", fill
    assert fill["withheld"] == "x_last withheld " + WHY, fill


def test_the_listed_rows_orders_and_fills_as_a_program_reads_them(client, monkeypatch):
    """On the listed row at the kit's stand-in: a program's order rows keep
    trail_points and its fill rows reason_detail, and no row says a price
    was withheld for them."""
    mod = _kit_standin("fake_oanda")
    if mod is None:
        pytest.skip("the kit's stand-in is not beside this kit (a wheel install)")
    fake = mod.FakeOanda(division="uk", new_connections_per_second=None).start()
    monkeypatch.setenv("OANDA_REST_URL", fake.rest_url)
    monkeypatch.setenv("OANDA_STREAM_URL", fake.stream_url)
    name = "my-oanda"
    json_win = {**WIN_POST, "Content-Type": "application/json"}
    try:
        r = client.post("/api/broker/link", json={"name": name, "example": "oanda"},
                        headers=json_win)
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/credentials", headers=WIN_POST, json={
            "broker": name, "values": {"token": fake.token}, "merge": True})
        assert r.status_code == 200, r.text
        row = client.post("/api/broker/connect", json={"broker": name}, headers=WIN_POST).json()
        if not row.get("connected") and row.get("accounts"):
            row = client.post("/api/broker/account", headers=WIN_POST, json={
                "broker": name, "account_id": row["accounts"][0]["id"]}).json()
        assert row.get("connected"), row
        mid = float(fake.market.mid("EUR_USD"))
        r = client.post("/api/broker/order", headers=WIN_POST, json={
            "broker": name, "symbol": "EUR_USD", "side": "buy", "qty": 1000})
        assert r.status_code == 200, r.text
        r = client.post("/api/broker/order/pending", headers=WIN_POST, json={
            "broker": name, "symbol": "EUR_USD", "side": "buy", "qty": 1000, "type": "limit",
            "price": round(mid * 0.9, 5)})
        assert r.status_code == 200, r.text
        orders = client.get(f"/api/broker/orders?broker={name}").json()
        fills = client.get(f"/api/broker/fills?broker={name}").json()
        assert orders and fills, (orders, fills)
        assert all("trail_points" in o for o in orders), orders
        assert any("reason_detail" in f for f in fills), fills
        lines = sorted({r.get("withheld", "") for r in orders + fills} - {""})
        assert not any("trail_points" in x or "reason_detail" in x for x in lines), lines
        # and the window's rows are the same rows, whole
        w_orders = client.get(f"/api/broker/orders?broker={name}", headers=WIN_GET).json()
        assert [o["trail_points"] for o in w_orders] == [o["trail_points"] for o in orders]
    finally:
        try:
            client.post("/api/broker/disconnect", json={"broker": name}, headers=WIN_POST)
        except Exception:  # noqa: BLE001
            pass
        fake.stop()
