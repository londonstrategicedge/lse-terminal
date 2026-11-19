"""A capability flag is read as `is True` wherever the hub reads one (SPEC 3:
flags are booleans, and what is absent from capabilities is absent from the
broker), so a flag said as the string "false" is absent, not present.

With data.quotes, bars and history and orders.pending all "false" and read
as present, POST /api/broker/subscribe answers 400 "method
'quotes.subscribe' not supported" where it should say quotes false, GET
/api/broker/orders answers 400 "method 'orders.list' not supported" where it
should be [], and the row is offered as a data source. Here too: an
accounts.multi of "false" is no chooser, and connects without asking which
account. A flag said true as a string is absent the same way; orders.can_list
is true unless it is false itself (its SPEC default).

The adapter is a small Python file written into the test's own folder;
nothing here reaches the network.
"""
from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, link, rows, write_adapter)
from test_stored_values_hidden import WIN_GET, WIN_POST, _connect

WORDY = '''
import sys
from brueconnect import Adapter, AdapterError

FLAG = sys.argv[sys.argv.index("--flag") + 1]

def spec(symbol):
    return {"symbol": symbol, "name": symbol, "asset_class": "fx",
            "base_ccy": "EUR", "quote_ccy": "USD", "digits": 5,
            "tick_size": 0.00001, "lot_step": 1, "min_qty": 1, "max_qty": 1000000,
            "contract_size": 1, "margin_rate": 0.05,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


class Wordy(Adapter):
    name, version, broker = "wordy", "0.1", "wordy broker"

    def capabilities(self):
        return {"orders": {"market": True, "pending": FLAG},
                "data": {"quotes": FLAG, "bars": FLAG, "history": FLAG},
                "accounts": {"multi": FLAG}}

    def handle_accounts_list(self, params):
        raise AdapterError("x_wordy_asked", "accounts.list was asked")

    def handle_catalog_list(self, params):
        return {"instruments": [spec("EURUSD")]}

    def handle_account_get(self, params):
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": []}

Wordy().run()
'''


def _wordy(client, home, flag):
    path = write_adapter(home / "wordy", name="wordy.py", source=WORDY)
    assert link(client, "wordy", python_file=path, args=["--flag", flag]).status_code == 200
    r = _connect(client, "wordy", WIN_POST)
    got = {"connect": (r.status_code, r.json())}
    s = client.post("/api/broker/subscribe", headers=WIN_POST,
                    json={"broker": "wordy", "symbols": ["EURUSD"]})
    got["subscribe"] = (s.status_code, s.json())
    o = client.get("/api/broker/orders?broker=wordy", headers=WIN_GET)
    got["orders"] = (o.status_code, o.json())
    return got


def test_a_capability_said_as_the_string_false_reads_as_absent(client, home):
    got = _wordy(client, home, "false")
    status, row = got["connect"]
    assert status == 200 and row["connected"] is True, got          # no chooser asked
    assert "data_source" not in row, row                              # no bars, no history
    assert "accounts_multi" not in row and "needs_account" not in row, row
    assert got["subscribe"] == (200, {"subscribed": [], "refused": [], "quotes": False}), got
    assert got["orders"] == (200, []), got
    providers = [p["name"] for p in client.get("/api/providers").json()]
    assert "broker:wordy" not in providers


def test_a_flag_said_true_as_a_string_is_absent_too(client, home):
    got = _wordy(client, home, "true")
    status, row = got["connect"]
    assert status == 200 and row["connected"] is True and "data_source" not in row, got
    assert got["subscribe"][1]["quotes"] is False, got
    assert got["orders"] == (200, []), got


def test_each_read_of_a_flag_in_the_hub():
    from types import SimpleNamespace

    from lse_terminal.engine.broker_hub import BrokerHub

    def conn(**caps):
        return SimpleNamespace(handshake={"capabilities": caps})
    for said in ("false", "true", 1, "yes", None, [True]):
        assert BrokerHub._accounts_multi(conn(accounts={"multi": said})) is False, said
    assert BrokerHub._accounts_multi(conn(accounts={"multi": True})) is True
    # orders.list: pending must be true itself; can_list is true unless false itself
    hub = BrokerHub.__new__(BrokerHub)
    asked = []

    class C(SimpleNamespace):
        alive = True

        def request(self, method, params=None, timeout=10.0):
            asked.append(method)
            return {"orders": [{"order_id": "1", "state": "resting"}]}
    for orders, want in (({"pending": "false"}, []), ({"pending": "true"}, []),
                         ({"pending": True, "can_list": False}, []),
                         ({"pending": True, "can_list": "false"}, [{"order_id": "1", "state": "resting"}]),
                         ({"pending": True}, [{"order_id": "1", "state": "resting"}])):
        c = C(handshake={"capabilities": {"orders": orders}})
        hub._conn = lambda broker, c=c: c
        assert BrokerHub.orders_list(hub, "b") == want, orders
