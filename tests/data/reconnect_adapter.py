"""A broker adapter whose cold handshake guesses its account, for tests.

`hello` is answered before anything is read (Brue Connect SPEC 3.1), so this
adapter states its account's currency as GBP until it has read the account,
which is USD. The session's opening reads it: when the handshake said
otherwise, the adapter remembers USD in its state folder and refuses with the
protocol's `reconnect` (SPEC 6): start it again and its next hello says USD.

Each process counts itself in `count` in its state folder as it starts.
`--forgets` remembers nothing, so the process started again asks again.
`--chatter N` has every process after the first write N characters and then
"process <n> wrote its lines" to stderr before it answers its catalog read:
its pipe fills unless the terminal drains it.

It sends nothing over the network.

    python reconnect_adapter.py [--forgets] [--chatter N]
"""
import argparse
import os
import sys

# Started by the terminal, BRUE_CONNECT_SDK names the kit it runs; first on
# the path so this file speaks that kit's protocol.
_sdk = os.environ.get("BRUE_CONNECT_SDK")
if _sdk and _sdk not in sys.path:
    sys.path.insert(0, _sdk)

from brueconnect import Adapter, AdapterError  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--forgets", action="store_true")
ap.add_argument("--chatter", type=int, default=0)
ARGS = ap.parse_args()

STATE = os.environ.get("BRUE_BROKER_STATE") or "."
with open(os.path.join(STATE, "count"), "a") as fh:
    fh.write(".")
N = os.path.getsize(os.path.join(STATE, "count"))
LEARNED = os.path.join(STATE, "learned")
SAID = open(LEARNED).read().strip() if os.path.exists(LEARNED) else "GBP"


class Relearning(Adapter):
    name, version, broker = "relearning", "1", "Relearn Markets"
    mode = "paper"
    account_currency = SAID
    account_model = "netting"

    def broker_info(self):
        return {"display_name": "Relearn Markets"}

    def on_first_call(self):
        if SAID != "USD":
            if not ARGS.forgets:
                with open(LEARNED, "w") as fh:
                    fh.write("USD")
            raise AdapterError(
                "reconnect", "the handshake said %s before the account was "
                "read; it is USD. That is now remembered: reconnect, and the "
                "handshake will say so." % SAID)

    def handle_catalog_list(self, p):
        if N > 1 and ARGS.chatter:
            sys.stderr.write("x" * ARGS.chatter + "\n")
            sys.stderr.write("process %d wrote its lines\n" % N)
            sys.stderr.flush()
        return {"instruments": [{
            "symbol": "TEST", "name": "Test Instrument", "asset_class": "fx",
            "base_ccy": "TST", "quote_ccy": "USD", "digits": 5,
            "tick_size": 0.00001, "lot_step": 0.01, "min_qty": 0.01,
            "max_qty": 100, "contract_size": 100000, "margin_rate": 0.02,
            "tradable": True, "shortable": True}]}

    def handle_account_get(self, p):
        return {"balance": 100.0, "equity": 100.0, "margin_used": 0.0,
                "margin_free": 100.0, "currency": SAID}

    def handle_positions_list(self, p):
        return {"positions": []}

    def handle_flatten_all(self, p):
        return {"closed": 0}


if __name__ == "__main__":
    Relearning().run()
