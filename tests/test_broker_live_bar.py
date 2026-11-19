"""A broker chart's live bar: BrokerProvider.stream sends the broker's own quotes as ticks, and
candles() adds the bar now forming, built from the venue's closed minute bars inside it.

Before it, a broker source did not stream and its chart stood on its last CLOSED bar while the
ticket quoted the market (a listed broker's paper account at the US open of 2026-11-11: chart
347.13, ticket 351.97/352.33).
"""
import asyncio
import time
import unittest

from lse_terminal.contracts import NotSupported
from lse_terminal.engine.broker_hub import BrokerProvider


class Hub:
    """The two hub calls stream() makes, with the hub's own failure (LookupError when not connected)."""

    def __init__(self, quotes=True):
        self.cache = {}
        self.alive = True
        self.claims = []
        self.has_quotes = quotes

    def subscribe(self, broker, symbols):
        if not self.alive:
            raise LookupError(f"broker {broker!r} not connected")
        self.claims.append(list(symbols))
        if not self.has_quotes:
            return {"subscribed": [], "refused": [], "quotes": False}
        return {"subscribed": list(symbols), "refused": [], "quotes": True}

    def latest_quotes(self, broker):
        if not self.alive:
            raise LookupError(f"broker {broker!r} not connected")
        return dict(self.cache)


def provider(hub):
    p = BrokerProvider(hub, "my-alpaca", "Alpaca paper")
    p.STREAM_LOOK_SEC = 0.01
    return p


async def collect(agen, into):
    async for tick in agen:
        into.append(tick)


class BrokerStream(unittest.TestCase):
    def test_ticks_are_the_bid_in_seconds_one_per_new_quote_and_end_on_disconnect(self):
        async def run():
            hub = Hub()
            t0 = 1794407580123  # broker time, epoch milliseconds
            hub.cache["AAPL"] = {"bid": 351.97, "ask": 352.33, "time": t0}
            got = []
            task = asyncio.create_task(collect(provider(hub).stream(["AAPL", "AAPL", ""]), got))
            await asyncio.sleep(0.1)
            self.assertEqual(hub.claims, [["AAPL"]])  # one claim, duplicates and blanks dropped
            self.assertEqual(got, [{"symbol": "AAPL", "price": 351.97, "bid": 351.97, "ask": 352.33,
                                    "ts": t0 / 1000.0}])  # the bid; seconds, as the chart buckets them
            await asyncio.sleep(0.1)
            self.assertEqual(len(got), 1)  # the same quote is not sent twice
            hub.cache["AAPL"] = {"bid": 352.01, "ask": 352.40, "time": t0 + 1500}
            await asyncio.sleep(0.1)
            self.assertEqual([t["price"] for t in got], [351.97, 352.01])
            hub.cache["AAPL"] = {"bid": 352.02, "ask": 352.41, "time": None}  # no source time: not sent
            await asyncio.sleep(0.1)
            self.assertEqual(len(got), 2)
            hub.cache["AAPL"] = {"bid": None, "ask": 352.50, "time": t0 + 4500}  # no bid: the ask
            await asyncio.sleep(0.1)
            self.assertEqual(got[-1]["price"], 352.50)
            self.assertEqual(got[-1]["ts"], (t0 + 4500) / 1000.0)
            hub.cache["MSFT"] = {"bid": 500.0, "ask": 500.1, "time": t0 + 5000}  # not charted: not sent
            await asyncio.sleep(0.1)
            self.assertEqual({t["symbol"] for t in got}, {"AAPL"})
            hub.alive = False  # the broker disconnects: the stream ends and says why
            with self.assertRaises(LookupError):
                await asyncio.wait_for(task, 1.0)
        asyncio.run(run())

    def test_a_venue_without_quotes_gives_the_quiet_capability_answer(self):
        async def run():
            agen = provider(Hub(quotes=False)).stream(["AAPL"])
            with self.assertRaisesRegex(NotSupported, "does not stream"):
                await agen.__anext__()
        asyncio.run(run())

    def test_not_connected_is_reported(self):
        async def run():
            hub = Hub()
            hub.alive = False
            with self.assertRaises(LookupError):
                await provider(hub).stream(["AAPL"]).__anext__()
        asyncio.run(run())

    def test_nothing_wanted_ends_at_once_and_claims_nothing(self):
        async def run():
            hub = Hub()
            with self.assertRaises(StopAsyncIteration):
                await provider(hub).stream(["", ""]).__anext__()
            self.assertEqual(hub.claims, [])
        asyncio.run(run())

    def test_the_provider_now_says_it_streams(self):
        self.assertIn("stream", provider(Hub()).capabilities())


class Conn:
    """bars.history as a venue answers it: closed bars of the asked timeframe, epoch milliseconds."""

    def __init__(self, page, minutes, minutes_fail=False):
        self.page, self.minutes, self.minutes_fail, self.asked = page, minutes, minutes_fail, []

    def request(self, method, params):
        self.asked.append((method, dict(params)))
        if params["timeframe"] == "1m":
            if self.minutes_fail:
                raise RuntimeError("minute bars refused")
            return {"bars": self.minutes}
        return {"bars": self.page}


class ConnHub:
    def __init__(self, conn):
        self.conn = conn

    def connector(self, broker):
        return self.conn


class FormingBar(unittest.TestCase):
    H = 3600

    def venue(self, minutes_fail=False, gap=0):
        """An hour chart now: closed hours up to the one before this, minute bars of this hour so far."""
        begin = int(time.time() // self.H * self.H)
        page = [[(begin - (3 - i) * self.H) * 1000, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000] for i in range(3)]
        page[-1][0] = (begin - self.H - gap) * 1000
        minutes = [[(begin - 120) * 1000, 1, 1, 1, 1, 1],  # the hour before: not in this bar
                   [(begin - 60) * 1000, 1, 1, 1, 1, 1]]
        minutes += [[(begin + 60 * k) * 1000, 110 + k, 112 + k, 109 - k, 111 + k, 10] for k in range(3)]
        return begin, Conn(page, minutes, minutes_fail)

    def test_the_forming_hour_is_built_from_its_minutes_and_asked_beside_the_page(self):
        begin, conn = self.venue()
        df = BrokerProvider(ConnHub(conn), "my-alpaca").candles("AAPL", "1h", limit=5000)
        self.assertEqual(sorted(p["timeframe"] for _, p in conn.asked), ["1h", "1m"])
        self.assertEqual([p["count"] for _, p in conn.asked if p["timeframe"] == "1m"], [60])
        self.assertEqual(len(df), 4)
        last = df.iloc[-1].tolist()
        # opens at the first minute's open, the highest high, the lowest low, closes at the last minute's close
        self.assertEqual(last, [begin, 110.0, 114.0, 107.0, 113.0, 30.0])
        self.assertEqual(int(df.iloc[-2]["ts"]), begin - self.H)

    def test_no_forming_bar_for_a_page_of_the_past_or_a_minute_chart(self):
        begin, conn = self.venue()
        p = BrokerProvider(ConnHub(conn), "my-alpaca")
        df = p.candles("AAPL", "1h", limit=5000, start=begin - 10 * self.H)
        self.assertEqual(len(df), 3)
        self.assertEqual([q["timeframe"] for _, q in conn.asked], ["1h"])
        conn.asked.clear()
        p.candles("AAPL", "1m", limit=5000)
        self.assertEqual([q["timeframe"] for _, q in conn.asked], ["1m"])

    def test_the_closed_bars_stand_when_the_minutes_fail(self):
        _, conn = self.venue(minutes_fail=True)
        df = BrokerProvider(ConnHub(conn), "my-alpaca").candles("AAPL", "1h", limit=5000)
        self.assertEqual(len(df), 3)

    def test_periods_out_of_line_with_the_chart_get_no_built_bar(self):
        # the venue's last closed bar not a whole period before this one: its periods start elsewhere
        _, conn = self.venue(gap=1800)
        df = BrokerProvider(ConnHub(conn), "my-alpaca").candles("AAPL", "1h", limit=5000)
        self.assertEqual(len(df), 3)

    def test_forming_edges(self):
        now, w = 1794407580.0, 3600
        begin = int(now // w * w)
        bars = {"bars": [[(begin + 60) * 1000, 5, 6, 4, 5.5, None], [(begin + w) * 1000, 9, 9, 9, 9, 9],
                         [(begin + 120) * 1000, "x", 1, 1, 1, 1], [(begin + 180) * 1000, 5.5, 7, 5, 6, 2]]}
        self.assertEqual(BrokerProvider._forming(bars, w, begin - w, now), [begin, 5.0, 7.0, 4.0, 6.0, 2.0])
        self.assertIsNone(BrokerProvider._forming(bars, w, begin, now))           # this period is closed already
        self.assertIsNone(BrokerProvider._forming({"bars": []}, w, begin - w, now))  # no minute in it yet
        self.assertIsNone(BrokerProvider._forming(bars, w, begin - w - 60, now))  # out of line


if __name__ == "__main__":
    unittest.main()
