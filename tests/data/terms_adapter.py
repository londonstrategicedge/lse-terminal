"""A broker adapter that declares terms (Brue Connect SPEC 3.3), for tests.

The kit's own paper engine under a name, a mode and terms given on its command
line, so a test can stand up a broker whose terms keep its prices on this
computer, or have every order on a live account placed by hand, without any
broker's API. It sends nothing over the network. Its positions also carry a
`current_price`, the field an adapter for a real broker may add and which is
market data, not the account's own record.

Two options put a price into the adapter's own words, as an adapter may:
`--degrade` reports its session degraded with the last bid in the detail,
and `--fail-account FILE` makes each account read, while FILE exists, print
the quote to stderr and fail with an error that names the bid.

`--marked-catalog` adds to each instrument the fields a broker can work out
from a price: a minimum stop stated as a share of the price, handed on in
points of it; the tick's value in the account's currency at a rate of the
broker's own; and a field of the adapter's own holding the price itself.
`--nested-extra` puts keys of the adapter's own, figures from the price
among them, inside the objects an instrument carries (its fees, sessions,
early closes, margin tiers and dividend). `--fixed-stops N` states each
instrument's minimum stop as N points, a fixed figure no price moves.

`--lose-answer FILE` loses the answer to each order, close and cancel sent
under a new client_id while FILE exists, as a broker that took the request
and never answered: the request is carried out (an order `--late-ms` later,
as a broker that carries one out after its client gave up), the answer is
"not known yet" (retryable), and asking again under the same client_id is
answered from the record, never carried out twice.

`--resting` declares resting orders (limit and stop): such an order rests
until it is cancelled, the orders read lists it, and a cancel takes it out.
With `--lose-answer`, a resting order's answer and a cancel's are lost the
same way (each carried out, its answer "not known yet").

`--fail-reads FILE` makes each positions, orders and fills read, while FILE
exists, print the quote to stderr and fail with an error that names the bid.

`--multi-accounts` declares a login that reaches two accounts (SPEC 1.7).

Three options print a line quoting the price to stderr, as an adapter's
own diagnostics may, at a moment of the session: `--say-account` at each
account read (which succeeds), `--say-start` as it starts, before its hello,
and `--say-bye` when the terminal closes it.

    python terms_adapter.py --terms '{"data_local_only": true}' --mode live
"""
import argparse
import json
import math
import os
import sys
import threading
import time

# Started by the terminal, BRUE_CONNECT_SDK names the kit it runs; first on
# the path so this file speaks that kit's protocol.
_sdk = os.environ.get("BRUE_CONNECT_SDK")
if _sdk and _sdk not in sys.path:
    sys.path.insert(0, _sdk)

from brueconnect import protocol  # noqa: E402
from brueconnect.adapter import AdapterError  # noqa: E402
from brueconnect.adapters.paper.paper_adapter import PaperAdapter  # noqa: E402


class TermsAdapter(PaperAdapter):
    name = "terms-fixture"
    broker = "terms fixture broker"

    def __init__(self, args):
        super().__init__(args)
        self.mode = args.mode
        self._terms = json.loads(args.terms) if args.terms else None
        self._display = args.display
        self._degrade = args.degrade
        self._fail_account = args.fail_account
        self._marked_catalog = args.marked_catalog
        self._nested_extra = args.nested_extra
        self._fixed_stops = args.fixed_stops
        self._lose_answer = args.lose_answer
        self._late_ms = args.late_ms
        self._multi = args.multi_accounts
        self._say_account = args.say_account
        self._say_bye = args.say_bye
        self._resting = args.resting
        self._fail_reads = args.fail_reads
        # resting orders by order_id (--resting)
        self._orders = {}
        self._rests = 0
        # client_ids of orders sent, answer lost, not carried out yet
        self._late = set()

    def _say(self, what):
        with self.lockstate:
            bid, ask = self.quote_at("EURUSD")
        print(f"terms fixture ({self._display}): {what}; EURUSD bid {bid} ask {ask}",
              file=sys.stderr, flush=True)

    def on_shutdown(self):
        if self._say_bye:
            self._say("closing")
        return super().on_shutdown()

    def capabilities(self):
        caps = super().capabilities()
        if self._multi:
            caps["accounts"] = {"multi": True}
        if self._resting:
            caps["orders"] = {**(caps.get("orders") or {}), "pending": True,
                              "pending_types": ["limit", "stop"], "can_list": True}
        return caps

    def _read_fails(self, what):
        """--fail-reads: while its file exists, a read says the price and fails."""
        if not (self._fail_reads and os.path.exists(self._fail_reads)):
            return
        with self.lockstate:
            bid, ask = self.quote_at("EURUSD")
        print(f"terms fixture ({self._display}): {what} read; EURUSD bid {bid} ask {ask}",
              file=sys.stderr, flush=True)
        raise AdapterError("x_fixture_read", f"the {what} could not be read while "
                           f"EURUSD was {bid}", retryable=True)

    # == resting orders (--resting) ===========================================
    def _rest(self, params):
        cid = str(params.get("client_id") or "")
        with self.lockstate:
            self._rests += 1
            oid = f"r{self._rests}"
            qty = float(params.get("qty") or 0.0)
            self._orders[oid] = {
                "order_id": oid, "client_id": cid, "symbol": params.get("symbol"),
                "type": params.get("type"), "side": params.get("side"), "qty": qty,
                "filled_qty": 0.0, "remaining_qty": qty, "price": params.get("price"),
                "stop_price": params.get("stop_price"), "sl": params.get("sl"),
                "tp": params.get("tp"), "state": "resting", "placed_at": self.now_ms(),
                "done_at": None, "fill_price": None, "reason": None}
        self.emit("order.accepted", {"client_id": cid, "order_id": oid})
        return {"order_id": oid, "status": "accepted"}

    def _resting_only(self, method):
        """Without --resting the paper engine has no resting orders: the
        method is answered as the kit answers one it does not have."""
        if not self._resting:
            raise AdapterError("unsupported", f"method {method!r} not supported")

    def handle_orders_list(self, params):
        self._resting_only("orders.list")
        self._read_fails("orders")
        with self.lockstate:
            return {"orders": [dict(o) for o in self._orders.values()]}

    def handle_order_cancel(self, params):
        self._resting_only("order.cancel")
        oid = str(params.get("order_id") or "")
        with self.lockstate:
            o = self._orders.pop(oid, None)
        if o is None:
            raise AdapterError("not_found", f"no resting order {oid!r}")
        self.emit("order.cancelled", {"order_id": oid, "client_id": o["client_id"]})
        if self._losing(params):
            self.idempotent_store(str(params["client_id"]), {},
                                  protocol.order_signature("order.cancel", params))
            raise self._unknown("cancel")
        return {}

    def handle_history_fills(self, params):
        self._read_fails("fills")
        return super().handle_history_fills(params)

    def handle_accounts_list(self, params):
        return {"accounts": [
            {"id": "fx-1", "label": "Main", "currency": "USD",
             "mode": self.mode, "balance": 10000.0},
            {"id": "fx-2", "label": "Second", "currency": "EUR",
             "mode": self.mode, "balance": 500.0}]}

    def handle_account_get(self, params):
        with self.lockstate:
            bid, ask = self.quote_at("EURUSD")
        if self._degrade:
            self.emit("session.state", {
                "state": "degraded",
                "detail": f"EURUSD quotes delayed; last bid {bid}"})
        if self._fail_account and os.path.exists(self._fail_account):
            print(f"terms fixture ({self._display}): account read; EURUSD "
                  f"bid {bid} ask {ask}", file=sys.stderr, flush=True)
            raise AdapterError("x_fixture_account", "the account could not "
                               f"be read while EURUSD was {bid}",
                               retryable=True)
        if self._say_account:
            self._say("account read")
        return super().handle_account_get(params)

    def handle_catalog_list(self, params):
        out = super().handle_catalog_list(params)
        if self._marked_catalog:
            with self.lockstate:
                for spec in out["instruments"]:
                    bid, ask = self.quote_at(spec["symbol"])
                    mid = (bid + ask) / 2.0
                    tick = spec["tick_size"]
                    # a minimum stop of 0.1% of the price, in its points
                    spec["stops_level_points"] = int(
                        math.ceil(mid * 0.001 * 1.1 / tick - 1e-9)) + 1
                    spec["tick_value_account"] = round(
                        float(spec.get("tick_value") or tick) / 1.0857, 8)
                    spec["x_snapshot_mid"] = mid
        if self._nested_extra:
            with self.lockstate:
                for spec in out["instruments"]:
                    bid, ask = self.quote_at(spec["symbol"])
                    mid = (bid + ask) / 2.0
                    spec["fees"] = {**(spec.get("fees") or {}), "x_spread": round(ask - bid, 8)}
                    spec["sessions"] = [{**s, "x_note": f"opened at {mid}"}
                                        for s in spec.get("sessions") or []]
                    spec["early_closes"] = [{"date": "2026-12-24", "close": "18:00",
                                             "tz": "UTC", "x_why": f"last {mid}"}]
                    spec["margin_tiers"] = [{"above_notional": 0, "margin_rate": 0.05,
                                             "x_margin_per_unit": round(mid * 0.05, 8)}]
                    spec["dividend"] = {"ex_date": "2026-12-01", "amount_per_share": 0.5,
                                        "x_yield_pct": round(0.5 / mid * 100, 8)}
        if self._fixed_stops is not None:
            for spec in out["instruments"]:
                spec["stops_level_points"] = self._fixed_stops
        return out

    # == answers lost (--lose-answer) ========================================
    def _losing(self, params) -> bool:
        return bool(self._lose_answer and params.get("client_id")
                    and os.path.exists(self._lose_answer))

    @staticmethod
    def _unknown(what: str) -> AdapterError:
        return AdapterError(
            "internal", f"the broker did not answer the {what} (timeout); "
            "whether it carried it out is not known yet. It is NOT sent "
            "again: asking again with the same client_id is safe, and is "
            "answered from the broker's own record.", retryable=True)

    def handle_order_place(self, params):
        cid = str(params.get("client_id") or "")
        if cid in self._late:
            # Sent before, its answer lost, and not carried out yet: never
            # sent a second time.
            raise self._unknown("order")
        resting = self._resting and params.get("type") in ("limit", "stop")
        place = self._rest if resting else super().handle_order_place
        if not self._losing(params):
            return place(params)
        sig = protocol.order_signature("order.place", params)
        if self._late_ms <= 0:
            self.idempotent_store(cid, place(params), sig)
            raise self._unknown("order")
        self._late.add(cid)

        def late():
            time.sleep(self._late_ms / 1000.0)
            try:
                result = place(params)
                self.idempotent_store(cid, result, sig)
            finally:
                self._late.discard(cid)
        threading.Thread(target=late, daemon=True).start()
        raise self._unknown("order")

    def handle_position_close(self, params):
        result = super().handle_position_close(params)
        if self._losing(params):
            self.idempotent_store(str(params["client_id"]), result,
                                  protocol.order_signature("position.close",
                                                           params))
            raise self._unknown("close")
        return result

    @property
    def terms(self):
        # None (not {}) for "says nothing", so the field is left out of hello.
        return self._terms

    def broker_info(self):
        return {"display_name": self._display,
                "tagline": "A test broker that declares terms", "mark": "TF"}

    def handle_positions_list(self, params):
        self._read_fails("positions")
        out = super().handle_positions_list(params)
        with self.lockstate:
            for p in out["positions"]:
                bid, ask = self.quote_at(p["symbol"])
                p["current_price"] = bid if p.get("side") == "buy" else ask
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", default=os.environ.get("BRUE_BROKER_STATE", ""))
    ap.add_argument("--model", choices=["netting", "hedging"], default="netting")
    ap.add_argument("--tick-ms", type=int, default=20)
    ap.add_argument("--sim-step-ms", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--balance", type=float, default=10000.0)
    ap.add_argument("--warmup-bars", type=int, default=30)
    ap.add_argument("--mode", default="paper")
    ap.add_argument("--terms", default="")
    ap.add_argument("--display", default="Fixture Markets")
    ap.add_argument("--degrade", action="store_true",
                    help="report the session degraded, the last bid in its "
                         "detail, at each account read")
    ap.add_argument("--fail-account", default="",
                    help="while this file exists, each account read prints "
                         "the quote to stderr and fails naming the bid")
    ap.add_argument("--marked-catalog", action="store_true",
                    help="add the catalog fields a broker works out from a "
                         "price")
    ap.add_argument("--nested-extra", action="store_true",
                    help="keys of the adapter's own inside an instrument's "
                         "objects, figures from the price among them")
    ap.add_argument("--fixed-stops", type=int, default=None,
                    help="each instrument's minimum stop, in points: fixed")
    ap.add_argument("--lose-answer", default="",
                    help="while this file exists, the answer to each order "
                         "and close under a new client_id is lost")
    ap.add_argument("--late-ms", type=int, default=0,
                    help="with --lose-answer: an order is carried out this "
                         "long after its answer was lost")
    ap.add_argument("--multi-accounts", action="store_true",
                    help="a login that reaches two accounts")
    ap.add_argument("--resting", action="store_true",
                    help="resting orders: limit and stop rest until cancelled")
    ap.add_argument("--fail-reads", default="",
                    help="while this file exists, each positions, orders and "
                         "fills read prints the quote and fails naming the bid")
    ap.add_argument("--say-account", action="store_true",
                    help="print the quote to stderr at each account read")
    ap.add_argument("--say-start", action="store_true",
                    help="print the quote to stderr as it starts")
    ap.add_argument("--say-bye", action="store_true",
                    help="print the quote to stderr when it is closed")
    ap.add_argument("--fail", action="store_true",
                    help="end before answering hello: a broken adapter")
    ap.add_argument("--fail-if-exists", default="",
                    help="end before hello while this file exists: the same "
                         "command, broken later")
    args = ap.parse_args()
    if args.fail or (args.fail_if_exists and os.path.exists(args.fail_if_exists)):
        print("terms fixture: told to fail", file=sys.stderr)
        sys.exit(3)
    a = TermsAdapter(args)
    if args.say_start:
        a._say("starting")
    threading.Thread(target=a.clock_loop, daemon=True).start()
    a.emit("session.state", {"state": "connected", "detail": "fixture ready"})
    a.run()


if __name__ == "__main__":
    main()
