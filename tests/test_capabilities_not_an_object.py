"""A hello whose capabilities, or a part of them, are not an object.

SPEC 3: a capability that is absent is absent from the broker. An adapter in
another language may send capabilities as null, a list or a string, or one of
its parts (data, orders, accounts) so; the kit reads each such part as
absent. A hub that reads them as objects (c.handshake.get('capabilities',
{}).get('data', {})) crashes on such a hello, the ticket's prices and more.
Pinned here: the hub reads capabilities, and each part of them, as absent
unless it is an object, everywhere it reads them: the link's test spawn, the
connect and its account question, the status row, the display's and the
providers' subscriptions, the orders read, and the data source a connection
becomes.

The adapters are small Python files written into each test's own folder;
nothing here reaches the network.
"""
import pytest

from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, link, rows, write_adapter)
from test_stored_values_hidden import WIN_GET, WIN_POST, _connect

# An adapter whose hello says `capabilities` as its command line asks.
ODD = '''
import json, sys
from brueconnect import Adapter

CAPS = json.loads(sys.argv[sys.argv.index("--caps") + 1])


def spec(symbol):
    return {"symbol": symbol, "name": symbol, "asset_class": "equity",
            "base_ccy": "X", "quote_ccy": "USD", "digits": 2,
            "tick_size": 0.01, "lot_step": 1, "min_qty": 1, "max_qty": 1000,
            "contract_size": 1, "margin_rate": 0.1,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


class Odd(Adapter):
    name, version, broker = "odd", "0.1", "odd broker"

    def capabilities(self):
        return CAPS

    def handle_catalog_list(self, params):
        return {"instruments": [spec("F")]}

    def handle_account_get(self, params):
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": []}

    def handle_orders_list(self, params):
        return {"orders": []}

Odd().run()
'''

CASES = {
    "a list": "[]",
    "null": "null",
    "a string": '"quotes"',
    "a number": "7",
    "its parts not objects": '{"data": ["quotes"], "orders": null, "accounts": "multi"}',
}


@pytest.mark.parametrize("caps", sorted(CASES))
def test_capabilities_that_are_not_an_object_read_as_absent(client, home, caps):
    path = write_adapter(home / "odd", name="odd.py", source=ODD)
    r = link(client, "odd", python_file=path, args=["--caps", CASES[caps]])
    assert r.status_code == 200, r.text
    r = _connect(client, "odd", WIN_POST)
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["connected"] is True, row
    assert isinstance(row["capabilities"], dict), row["capabilities"]
    assert "data_source" not in row                     # no bars, no history: no chart source
    assert isinstance(rows(client)["odd"]["capabilities"], dict)
    # the ticket's prices, and a provider's: no quotes declared
    for route in ("/api/broker/subscribe",):
        r = client.post(route, headers=WIN_POST, json={"broker": "odd", "symbols": ["F"]})
        assert r.status_code == 200, r.text
        assert r.json() == {"subscribed": [], "refused": [], "quotes": False}, r.json()
    hub = client.app.state.broker_hub
    assert hub.subscribe("odd", ["F"]) == {"subscribed": [], "refused": [], "quotes": False}
    # the orders read: no resting orders declared
    r = client.get("/api/broker/orders?broker=odd", headers=WIN_GET)
    assert (r.status_code, r.json()) == (200, [])


def test_the_hub_reads_each_part_as_absent_unless_an_object():
    from lse_terminal.engine.broker_hub import caps_of

    class C:
        def __init__(self, hello):
            self.handshake = hello
    assert caps_of(C({"capabilities": {"data": {"quotes": True}}})) == {"data": {"quotes": True}}
    assert caps_of(C({"capabilities": {"data": {"quotes": True}}}), "data") == {"quotes": True}
    for hello in ({"capabilities": []}, {"capabilities": None}, {"capabilities": "x"}, {},
                  None, [], "hello"):
        assert caps_of(C(hello)) == {} and caps_of(C(hello), "data") == {}, hello
    for part in ([], None, "quotes", 1):
        assert caps_of(C({"capabilities": {"data": part}}), "data") == {}, part
    assert caps_of(object()) == {} and caps_of(None, "orders") == {}
