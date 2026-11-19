"""The London Strategic Edge provider: full vault history + live streaming
through the lse-data client, with one free API key.

This is the reference implementation for a real remote source: lazy client
construction, an instrument catalog, sync-to-async stream bridging, and
graceful "not configured" behavior when no key is present.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import datetime, timezone

import pandas as pd

from lse_terminal.contracts import CANDLE_COLUMNS, Instrument, Provider
from lse_terminal.engine.config import get_lse_api_key
from lse_terminal.providers.spread import QuoteSynthesizer

# Catalog datasets the /candles endpoint serves. Options and economics exist
# in the catalog but chart through different endpoints; they join in v0.2+.
_CANDLE_DATASETS = {
    # "futures" is the asset class (per the class registry); "eurex" is an
    # exchange name, not a class, and must not appear here.
    "stocks", "fx", "crypto", "etf", "index", "commodity", "futures",
    "volatility", "interest_rates", "currency_index",
}


def _iso_to_epoch(iso: str) -> int:
    return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
               .astimezone(timezone.utc).timestamp())


def verify_key(key: str, timeout: float = 8.0) -> tuple[bool, str]:
    """Prove a candidate key against the live gate before anything stores it.

    Returns (ok, message). Only an explicit auth refusal (401/403) returns
    False: the caller must not persist that key. Every other outcome returns
    True, because a timeout or a DNS failure means "we could not ask", not
    "the key is bad", and a user on a plane must still be able to save the
    key they just copied.

    This exists because lse_configured is merely bool(saved key), and MARKETS
    only renders the connect form while no key is saved. Persisting a rejected
    key therefore locked the user out of the one screen that could fix it: the
    tab went live-looking, every call 401'd, and there was no way back to the
    input short of hand-editing config.json.

    stdlib urllib on purpose, matching prices() below: `requests` is not in
    the app's dependency set and the frozen desktop build ships only what the
    spec collects.
    """
    import urllib.error
    import urllib.parse
    import urllib.request
    key = (key or "").strip()
    if not key:
        return False, "empty key"
    q = urllib.parse.urlencode({"symbols": "AAPL"})
    req = urllib.request.Request(
        f"https://data-api.londonstrategicedge.com/v1/prices?{q}",
        # The edge 403s the default Python-urllib agent, so a missing
        # User-Agent here would read as "key rejected" for every key.
        headers={"x-api-key": key,
                 "User-Agent": "lse-terminal (+https://londonstrategicedge.com)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            return True, "ok"
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, ("The LSE API rejected this key. Copy it again from "
                           "londonstrategicedge.com/data#api.")
        # 4xx/5xx that is not an auth refusal: the key may well be fine.
        return True, f"unverified (HTTP {e.code})"
    except Exception as e:
        return True, f"unverified ({type(e).__name__})"


class LseProvider(Provider):
    name = "lse"
    title = "London Strategic Edge"
    # tick / 1s / 30s: the vault gate serves 1s
    # natively and folds 30s from the 1s tables at read time. Tick charts
    # start empty and append live ticks; historical tick replay is unavailable.
    # Futures pairs (ES.F family)
    # have no sub-minute bars; the gate's own error message surfaces in
    # the UI status line for those.
    timeframes = ["tick", "1s", "30s", "1m", "5m", "15m", "30m",
                  "1h", "4h", "1d", "1w"]

    def __init__(self, api_key: str | None = None):
        self._key = api_key or get_lse_api_key()
        self._client = None
        self._catalog: list[Instrument] | None = None
        self._catalog_at = 0.0
        self._catalog_refreshing = False
        self._lock = threading.Lock()

    def configured(self) -> bool:
        return bool(self._key)

    def _lse(self):
        if not self._key:
            raise RuntimeError(
                "LSE provider needs an API key. Get a free one at "
                "https://londonstrategicedge.com/data#api and set it in the terminal."
            )
        with self._lock:
            if self._client is None:
                from lse import LSE
                self._client = LSE(api_key=self._key)
        return self._client

    # ------------------------------------------------------------------

    # Display order of the catalog's groups (the provider.py presentation
    # contract says order is the provider's call, not the UI's). Categories
    # the API adds later fall in after these, in catalog order.
    _CATEGORY_ORDER = ["Forex", "Stocks", "Crypto", "Indices", "Commodities",
                       "ETFs", "Futures"]

    # How long a catalog copy counts as fresh. Short on purpose: a newly
    # registered pair should appear on the next look, not the next
    # restart; the API's own rate caps are the abuse limit.
    _CATALOG_TTL_S = 60

    def _instruments(self) -> list[Instrument]:
        now = time.time()
        if self._catalog is not None and now - self._catalog_at < self._CATALOG_TTL_S:
            return self._catalog
        if self._catalog is None:
            # Nothing to serve stale: the first load blocks.
            self._refresh_catalog()
            return self._catalog or []
        # Stale-while-revalidate: hand back the copy we have NOW and refresh
        # in the background, so search never blocks on the network and the
        # next look is current.
        if not self._catalog_refreshing:
            self._catalog_refreshing = True
            threading.Thread(target=self._refresh_catalog_bg, daemon=True).start()
        return self._catalog

    def _refresh_catalog_bg(self) -> None:
        try:
            self._refresh_catalog()
        except Exception:
            pass  # offline: the stale copy stands until the next attempt
        finally:
            self._catalog_refreshing = False

    def _refresh_catalog(self) -> None:
        cli = self._lse()
        # Both SDK views cache the same payload. Clear both so a newly
        # available instrument appears after refresh without restarting.
        for cache in ("_catalog_cache", "_vault_catalog_cache"):
            try:
                setattr(cli, cache, None)
            except Exception:
                pass
        rows = cli.catalog()
        # The SDK catalog() projection omits availability flags; datasets()
        # retains them from the same response. Current marks instruments with
        # recent candle data without the legacy desktop's live-list limit.
        # Older servers remain usable through live only when current is absent.
        current = {(d.get("dataset"), d.get("symbol")) for d in cli.datasets()
                   if d.get("dataset") in _CANDLE_DATASETS
                   and d.get("current", d.get("live"))}
        items = [
            Instrument(symbol=r["symbol"], name=r.get("name") or "",
                       category=r.get("category") or "", provider=self.name,
                       meta={"dataset": r.get("dataset", ""), "live": True})
            for r in rows
            if r.get("symbol") and (r.get("dataset"), r["symbol"]) in current
        ]
        # Group-contiguous in display order, stable within each group, so
        # the UI can render folders from a single pass. Categories outside
        # _CATEGORY_ORDER rank by first appearance rather than sharing one
        # fallback rank: the API serves the catalog unordered, and a shared
        # rank let an interleaved category (Interest rates) split into two
        # folders.
        rank = {c: i for i, c in enumerate(self._CATEGORY_ORDER)}
        for ins in items:
            if ins.category not in rank:
                rank[ins.category] = len(rank)
        self._catalog = sorted(items, key=lambda ins: rank[ins.category])
        self._catalog_at = time.time()
    def search(self, query: str = "", limit: int | None = 50) -> list[Instrument]:
        q = query.strip().upper()
        if limit is None:
            if q:
                raise ValueError("unlimited catalogue requests require an empty query")
            return list(self._instruments())
        out: list[Instrument] = []
        # Symbol prefix matches first (what a trader typing "AAP" wants),
        # then substring hits on symbol or name.
        rest: list[Instrument] = []
        for ins in self._instruments():
            sym = ins.symbol.upper()
            if not q:
                out.append(ins)
            elif sym.startswith(q):
                out.append(ins)
            elif q in sym or q in ins.name.upper():
                rest.append(ins)
            if len(out) >= limit:
                break
        out.extend(rest[: max(0, limit - len(out))])
        return out[:limit]

    # Rows per hosted /candles call: the gate's synchronous row cap
    # (api_plans.max_rows_per_request, the same 5000 on every plan). Longer
    # loads page through it below.
    _PAGE_ROWS = 5000

    @staticmethod
    def _gate_ts(value) -> str | None:
        """A start/end bound in the one shape the hosted gate accepts.

        The gate takes `YYYY-MM-DD` or `YYYY-MM-DD[T ]HH:MM[:SS]` and 400s on
        anything else, including the `+00:00` suffix that
        datetime.isoformat() appends to an aware UTC value (which is exactly
        what the engine's windowed backtest load sends). Epoch seconds and
        tz-aware ISO strings both become naive UTC here; a value already in
        gate shape passes through untouched.
        """
        if value is None or value == "":
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        s = str(value).strip()
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            try:
                return datetime.fromtimestamp(float(s), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            except ValueError:
                return s  # not ours to judge; the gate's own error surfaces
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt.strftime("%Y-%m-%dT%H:%M:%S")

    @staticmethod
    def _candle_frame(rows) -> pd.DataFrame:
        df = pd.DataFrame(rows)
        if df.empty:
            return pd.DataFrame(columns=CANDLE_COLUMNS)
        df["ts"] = df["timestamp"].map(_iso_to_epoch)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df.get(col, 0.0), errors="coerce")
        return df[CANDLE_COLUMNS].dropna(subset=["open", "high", "low", "close"])

    def candles(self, symbol: str, timeframe: str, limit: int = 500,
                start: str | None = None, end: str | None = None) -> pd.DataFrame:
        if timeframe == "tick":
            return self._tick_candles(symbol, limit=limit, start=start, end=end)
        # Paged load. One call returns at most _PAGE_ROWS, which capped every
        # hosted backtest at 5000 bars however much the engine asked for (its
        # remote ceiling is 50k). Pages walk the gate's own bound semantics:
        # start is inclusive, end is exclusive, and a start-anchored query
        # pages FORWARD (oldest first) while everything else returns the
        # newest rows first, so a backward page ends exactly at the previous
        # page's oldest bar and a forward page starts one second past its
        # newest. Each page is ~0.3 s at the edge, so a full 50k load is a few
        # seconds; a chart's 5000-bar request is still exactly one call.
        want = max(1, int(limit))
        s, e = self._gate_ts(start), self._gate_ts(end)
        forward = bool(s)
        client = self._lse()
        frames: list[pd.DataFrame] = []
        got = 0
        while got < want:
            page = min(self._PAGE_ROWS, want - got)
            rows = client.candles(symbol, timeframe=timeframe, start=s, end=e,
                                  limit=page, order="asc" if forward else "desc")
            df = self._candle_frame(rows)
            if df.empty:
                break
            frames.append(df)
            got += len(df)
            if len(rows) < page:
                break  # the vault ran out of history in this direction
            if forward:
                s = self._gate_ts(int(df["ts"].max()) + 1)
            else:
                e = self._gate_ts(int(df["ts"].min()))
        if not frames:
            return pd.DataFrame(columns=CANDLE_COLUMNS)
        out = (pd.concat(frames, ignore_index=True)
               .drop_duplicates(subset="ts").sort_values("ts"))
        # Provider law: start-anchored queries hand back the oldest N from
        # start, everything else the newest N.
        out = out.head(want) if forward else out.tail(want)
        return out.reset_index(drop=True)

    def _tick_candles(self, symbol: str, limit: int = 500,
                      start: str | None = None,
                      end: str | None = None) -> pd.DataFrame:
        """Tick charts begin empty and append the live stream; no replay is offered."""
        if start is not None or end is not None:
            raise ValueError("Tick charts are live only; historical tick windows are unavailable.")
        return pd.DataFrame(columns=CANDLE_COLUMNS)

    def prices(self, symbols: list[str]) -> list[dict]:
        """Latest price/bid/ask per symbol from the platform price board
        (data-api /v1/prices, key-gated, max 50 symbols per call). One cheap
        budgeted poll replaces per-symbol websocket subscriptions for the
        watchlist. stdlib urllib on purpose: the lse SDK has no wrapper for
        this endpoint yet and `requests` is not in the app's dependency set,
        so no third-party HTTP lib here."""
        import json as _json
        import urllib.parse
        import urllib.request
        out: list[dict] = []
        for i in range(0, len(symbols), 50):
            q = urllib.parse.urlencode({"symbols": ",".join(symbols[i:i + 50])})
            req = urllib.request.Request(
                f"https://data-api.londonstrategicedge.com/v1/prices?{q}",
                headers={"x-api-key": self._key or "",
                         # The edge 403s the default Python-urllib agent
                         "User-Agent": "lse-terminal (+https://londonstrategicedge.com)"})
            with urllib.request.urlopen(req, timeout=5) as r:
                out.extend(_json.load(r).get("data", []))
        return out

    def screener(self) -> dict:
        """The full cross-sectional screener snapshot (~4.2k instruments,
        ~75 metric columns + a column manifest) from /v1/screener. The
        server refreshes its snapshot every 30-60s and revalidates with
        ETag, so we poll with If-None-Match and keep the last good payload:
        steady state is a 304 with zero body. stdlib urllib for the same
        reason as prices(). Raises on first-load failure only; once one
        payload is held, network hiccups return the cached snapshot."""
        if not self._key:
            # Same contract as _lse(): the engine route maps this to a 409
            # and the page renders the connect hint instead of an error.
            raise RuntimeError(
                "LSE provider needs an API key. Get a free one at "
                "https://londonstrategicedge.com/data#api and set it in the terminal.")
        import gzip as _gzip
        import json as _json
        import urllib.error
        import urllib.request
        cached = getattr(self, "_screener_cache", None)
        headers = {"x-api-key": self._key or "",
                   "Accept-Encoding": "gzip",
                   "User-Agent": "lse-terminal (+https://londonstrategicedge.com)"}
        if cached and cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        req = urllib.request.Request(
            "https://data-api.londonstrategicedge.com/v1/screener",
            headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = _gzip.decompress(raw)
                data = _json.loads(raw)
                self._screener_cache = {"etag": r.headers.get("ETag"),
                                        "data": data}
                return data
        except urllib.error.HTTPError as e:
            if e.code == 304 and cached:
                return cached["data"]
            if cached:
                return cached["data"]
            raise
        except Exception:
            if cached:
                return cached["data"]
            raise

    def logos(self) -> dict:
        """Symbol -> {"light": url, "dark": url} instrument logo map for the
        watchlist, from the platform's public asset mapping (one static JSON,
        CDN-served, no key needed). Values in the file are either one string
        (same art both themes) or a {light, dark} pair; site-relative paths
        are made absolute here so the UI can drop them straight into <img>.
        Cached for the process lifetime on success only: a transient fetch
        failure returns {} and the next call retries, so one bad network
        moment can't leave the terminal logo-less until restart."""
        cached = getattr(self, "_logo_map", None)
        if cached is not None:
            return cached
        import json as _json
        import urllib.request
        site = "https://londonstrategicedge.com"
        # api. host first: it serves the freshest mapping straight from the
        # platform (symlinked into the /logos/ alias, no site deploy in the
        # loop). The main-site copy is the fallback, one deploy behind at
        # worst. Image paths inside are relative to the MAIN site either way.
        raw = None
        for url in (f"https://api.londonstrategicedge.com/logos/photo_mapping.json",
                    f"{site}/market_photos/photo_mapping.json"):
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "lse-terminal (+https://londonstrategicedge.com)"})
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    raw = _json.load(r)
                break
            except Exception:
                continue
        if not isinstance(raw, dict):
            return {}
        # Stock art resolves against the platform's master store, everything
        # else against the website copy. They are complementary stores, not a
        # primary and a mirror: the site copy does not carry every stock
        # logo, and the master carries none of the crypto/forex/commodity/
        # index art. A miss on the site host is served as the SPA index
        # (HTTP 200 HTML), not a 404, so a wrong base URL costs a full page
        # download per logo and still paints nothing.
        master = "https://api.londonstrategicedge.com/logos/"

        def _abs(p: str) -> str:
            if p.startswith("http"):
                return p
            if p.startswith("/market_photos/stocks/"):
                return master + p[len("/market_photos/stocks/"):]
            return site + p

        out: dict = {}
        for sym, v in raw.items():
            light = v if isinstance(v, str) else (v.get("light") or "")
            dark = light if isinstance(v, str) else (v.get("dark") or light)
            if not light:
                continue
            out[sym] = {"light": _abs(light), "dark": _abs(dark)}
        self._logo_map = out
        return out

    def economic_calendar(self, region=None, event: str | None = None,
                          start: str | None = None, end: str | None = None,
                          released_only: bool = False, order: str = "asc",
                          limit: int = 5000) -> list[dict]:
        """Macro events (CPI, NFP, rate decisions, ...) from the LSE feed.

        Returned rows are the client's dicts untouched: `actual`/`previous`/
        `consensus` stay the feed's display strings ("57K", "3.5%") because
        the unit suffix carries meaning the UI needs for axis labels; parsing
        to numbers is the chart's job, not the transport's.
        """
        return self._lse().economic_calendar(
            region=region, event=event, start=start, end=end,
            released_only=released_only, order=order,
            limit=min(int(limit), 5000))

    # Macro datasets the ECONOMIC section browses beyond the calendar. Both are
    # series-shaped in the vault (one (date, value) stream per symbol), so one
    # catalog call describes every series and one series call charts any of them.
    _MACRO_DATASETS = ("economics", "bonds")

    def macro_catalog(self) -> list[dict]:
        """Every macro series the vault holds, with its last print.

        Covers `economics` (national statistics: rates, inflation, money
        supply, reserves, trade, ...) and `bonds` (government yield curves per
        tenor). Only the fields the ECONOMIC pages actually render are kept:
        the raw catalog carries per-instrument tick counts for the whole vault
        and is ~8.7 MB over the wire, which is a page-load cost for data the
        macro views never read.

        `last_value` / `last_date` come straight from the catalog snapshot, so
        the INDICATORS table, the yield curve and the CENTRAL BANKS rate board
        all render from this ONE request; a series is only fetched when the
        user opens it.
        """
        c = self._lse()
        out: list[dict] = []
        for ds in self._MACRO_DATASETS:
            for r in c.datasets(ds):
                out.append({
                    "dataset": ds,
                    "symbol": r.get("symbol") or "",
                    "name": r.get("name") or "",
                    # `category` is the real statistic ("Interest Rate"), not the
                    # dataset label the SDK's catalog() substitutes.
                    "category": r.get("category") or "",
                    "country": r.get("country") or "",
                    "country_name": r.get("country_name") or "",
                    "unit": r.get("unit") or "",
                    # For economics this names the publishing institution, which
                    # is how the CENTRAL BANKS view knows a policy rate belongs
                    # to the Bank of England rather than to "GB".
                    "source": r.get("source") or "",
                    "frequency": r.get("frequency") or "",
                    "obs": r.get("ticks"),
                    "first": (r.get("first_tick") or "")[:10],
                    "last": (r.get("last_tick") or "")[:10],
                    "last_value": r.get("last_value"),
                    "change_pct": r.get("change_pct"),
                    "change_1y": r.get("change_1y"),
                })
        return out

    def macro_series(self, symbol: str, dataset: str | None = None,
                     start: str | None = None, end: str | None = None,
                     order: str = "asc", limit: int = 5000) -> list[dict]:
        """One macro series as [{"symbol", "date", "value"}, ...].

        `dataset` is optional (the vault resolves the class from the symbol),
        but the pages always pass it: resolution costs the gate a catalog
        lookup per request, and a bare symbol that exists in two classes would
        be ambiguous.
        """
        return self._lse().series(symbol, dataset=dataset, start=start,
                                  end=end, order=order,
                                  limit=min(int(limit), 5000))

    def options_underlyings(self) -> list[dict]:
        """Every optionable underlying, [{"symbol", "name"}, ...]. Feeds the
        MARKETS > Options search box; the chain itself is per-underlying."""
        return self._lse().options_underlyings()

    def option_chain(self, underlying: str, type: str | None = None,
                     expiry: str | None = None,
                     limit: int = 5000) -> list[dict]:
        """Current chain rows for one underlying (latest price, IV, greeks,
        today's volume/premium per contract).

        Two verified upstream quirks shape this:
        the vault keeps contracts after expiry and its min_dte filters on
        the STORED dte (stamped at the row's last update), so dead rows
        survive min_dte=0; and the request row cap is 5000, which a dense
        chain (SPY) fills with near expiries before any monthly appears.
        So the all-expiries fetch merges a near window with a far sweep
        (live far rows carry a large stored dte; dead rows never do), and
        every path drops rows whose expiry is already in the past."""
        c = self._lse()
        lim = min(int(limit), 5000)
        if expiry:
            rows = c.options(underlying, type=type, expiry=expiry,
                             min_dte=0, limit=lim)
        else:
            near = c.options(underlying, type=type, min_dte=0, limit=lim)
            far = c.options(underlying, type=type, min_dte=45, limit=lim)
            seen: set = set()
            rows = []
            for r in near + far:
                t = r.get("ticker")
                if t in seen:
                    continue
                seen.add(t)
                rows.append(r)
        today = datetime.now(timezone.utc).date().isoformat()
        return [r for r in rows if str(r.get("expiry") or "") >= today]

    def options_flow(self, underlying: str | None = None,
                     type: str | None = None,
                     min_premium: float | None = None,
                     limit: int = 300) -> list[dict]:
        """Recent option prints (time and sales), newest first. No underlying
        sweeps the whole tape, the classic pro terminal default view."""
        return self._lse().options_flow(underlying=underlying, type=type,
                                        min_premium=min_premium,
                                        order="desc",
                                        limit=min(int(limit), 1000))

    async def stream(self, symbols: list[str]):
        """Read all terminal markets from the LSE shared price stream."""
        from lse_terminal.providers.site_stream import stream
        upstream = stream(self, symbols)
        try:
            async for item in upstream:
                yield item
        finally:
            await upstream.aclose()

    async def close(self):
        """Release the shared price connection during engine shutdown."""
        from lse_terminal.providers.site_stream import close
        await close(self)

    def close_sync(self):
        """Stop the old stream before a worker-thread key change or sign-out."""
        from lse_terminal.providers.site_stream import close_sync
        close_sync(self)
