"""A program's orders and fills rows on a data_local_only connection carry the
account's own record only, as its positions do (SPEC 3.3, SPEC 4).

An orders row or a fills row given to a program exactly as the adapter sent
it can carry a price: an adapter's own x_ field, or an order's `reason` (the
broker's own words). For a program on such a connection the rows
are cut to SPEC 4's own fields of an Order and of a Fill: what else the
adapter added is left out (the row says which, and why), and an order's
reason is the sentence instead, its error code kept, as on the status rows.
The terminal's own window gets every row whole, and a connection without
such terms is as before.

The adapter is a small Python file written into the test's own folder;
nothing here reaches the network.
"""
import json

from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, link, rows, write_adapter)
from test_stored_values_hidden import WIN_GET, WIN_POST, _connect

PRICE = "1.08512"
# The adapter, with --no-terms for a connection whose terms restrict nothing,
# and a second order whose reason leads with an error code. Its terms are the
# kit's class attribute (terms written as a method are read by the kit as
# both restrictions declared).
LOCAL_OWN = '''
import sys, time
from brueconnect import Adapter

PRICE = "1.08512"

def spec(symbol):
    return {"symbol": symbol, "name": symbol, "asset_class": "fx",
            "base_ccy": "EUR", "quote_ccy": "USD", "digits": 5,
            "tick_size": 0.00001, "lot_step": 1, "min_qty": 1, "max_qty": 1000000,
            "contract_size": 1, "margin_rate": 0.05,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


class LocalOwn(Adapter):
    name, version, broker = "localown", "0.1", "local own broker"
    terms = ({} if "--no-terms" in sys.argv else
             {"data_local_only": True,
              "summary": "Local Own licenses its prices to you alone."})

    def broker_info(self):
        return {"display_name": "Local Own"}

    def capabilities(self):
        return {"orders": {"market": True, "pending": True, "pending_types": ["limit"],
                           "can_list": True},
                "data": {"quotes": True, "bars": False, "history": False}}

    def handle_catalog_list(self, params):
        return {"instruments": [spec("EURUSD")]}

    def handle_account_get(self, params):
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": [{"position_id": "p1", "symbol": "EURUSD", "side": "buy",
                               "qty": 1000, "avg_price": 1.08, "opened_at": 1,
                               "x_mid": PRICE}]}

    def handle_orders_list(self, params):
        return {"orders": [{"order_id": "o1", "client_id": "c1", "symbol": "EURUSD",
                            "type": "limit", "side": "buy", "qty": 1000,
                            "filled_qty": 0, "remaining_qty": 1000, "price": 1.07,
                            "state": "resting", "placed_at": 1,
                            "x_mid": PRICE,
                            "reason": "resting while EURUSD is " + PRICE},
                           {"order_id": "o2", "client_id": "c2", "symbol": "EURUSD",
                            "type": "limit", "side": "sell", "qty": 1000,
                            "filled_qty": 0, "remaining_qty": 1000, "price": 1.2,
                            "stop_price": None, "sl": None, "tp": 1.1, "expiry": "gtc",
                            "expires_at": None, "state": "resting", "placed_at": 2,
                            "done_at": None, "fill_price": None,
                            "reason": "insufficient_margin: needs 54.26 at " + PRICE}]}

    def handle_history_fills(self, params):
        return {"fills": [{"fill_id": "f1", "order_id": "o0", "position_id": "p1",
                           "client_id": "c0", "symbol": "EURUSD", "side": "buy",
                           "qty": 1000, "price": 1.08, "fees": -0.5,
                           "time": int(time.time() * 1000), "x_last": PRICE}]}

LocalOwn().run()
'''
WHY = "under Local Own's terms: Local Own licenses its prices to you alone."


def _linked(client, home, name="localown", args=()):
    path = write_adapter(home / name, name="localown.py", source=LOCAL_OWN)
    assert link(client, name, python_file=path, args=list(args)).status_code == 200
    r = _connect(client, name, WIN_POST)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_programs_orders_and_fills_rows_carry_no_price_an_adapter_added(client, home):
    """No value in a program's orders or fills row carries the price;
    positions keep the record only (the control)."""
    assert _linked(client, home)["terms"]["data_local_only"] is True
    answers = {}
    for route in ("positions", "orders", "fills"):
        p = client.get(f"/api/broker/{route}?broker=localown")      # a program
        assert p.status_code == 200, p.text
        answers[route] = p.json()
    pos = answers["positions"]
    assert "x_mid" not in pos[0] and "withheld" in pos[0], pos
    leaks = {route: [k for row in answers[route] for k, v in row.items()
                     if PRICE in json.dumps(v)] for route in ("orders", "fills")}
    assert not any(leaks.values()), (leaks, answers)


def test_a_programs_rows_are_spec_fields_with_the_reason_said_as_the_status_rows_say_it(
        client, home):
    _linked(client, home)
    orders = client.get("/api/broker/orders?broker=localown").json()
    assert orders == [
        {"order_id": "o1", "client_id": "c1", "symbol": "EURUSD", "type": "limit",
         "side": "buy", "qty": 1000, "filled_qty": 0, "remaining_qty": 1000, "price": 1.07,
         "state": "resting", "placed_at": 1,
         "reason": "The broker's reason withheld " + WHY,
         "withheld": "x_mid withheld " + WHY},
        {"order_id": "o2", "client_id": "c2", "symbol": "EURUSD", "type": "limit",
         "side": "sell", "qty": 1000, "filled_qty": 0, "remaining_qty": 1000, "price": 1.2,
         "stop_price": None, "sl": None, "tp": 1.1, "expiry": "gtc", "expires_at": None,
         "state": "resting", "placed_at": 2, "done_at": None, "fill_price": None,
         "reason": "insufficient_margin: The broker's reason withheld " + WHY}], orders
    fills = client.get("/api/broker/fills?broker=localown").json()
    assert len(fills) == 1 and isinstance(fills[0].pop("time"), int)
    assert fills == [{"fill_id": "f1", "order_id": "o0", "position_id": "p1",
                      "client_id": "c0", "symbol": "EURUSD", "side": "buy", "qty": 1000,
                      "price": 1.08, "fees": -0.5,
                      "withheld": "x_last withheld " + WHY}], fills


def test_the_window_gets_the_rows_whole(client, home):
    _linked(client, home)
    orders = client.get("/api/broker/orders?broker=localown", headers=WIN_GET).json()
    assert [(o["x_mid"], o["reason"]) for o in orders[:1]] == [
        (PRICE, "resting while EURUSD is " + PRICE)]
    assert orders[1]["reason"] == "insufficient_margin: needs 54.26 at " + PRICE
    assert not any("withheld" in o for o in orders)
    fills = client.get("/api/broker/fills?broker=localown", headers=WIN_GET).json()
    assert fills[0]["x_last"] == PRICE and "withheld" not in fills[0]


def test_a_connection_whose_terms_restrict_nothing_is_as_before(client, home):
    """A program on a connection with no such terms gets the rows as the
    adapter sends them, its own fields included."""
    row = _linked(client, home, name="plainown", args=["--no-terms"])
    assert row["terms"]["data_local_only"] is False
    orders = client.get("/api/broker/orders?broker=plainown").json()
    assert orders[0]["x_mid"] == PRICE and orders[0]["reason"] == "resting while EURUSD is " + PRICE
    fills = client.get("/api/broker/fills?broker=plainown").json()
    assert fills[0]["x_last"] == PRICE
