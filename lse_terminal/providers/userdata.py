"""The user's own data, imported from CSV files into a local library.

This is the heart of the open-source terminal: no account, no network, just
"here is my data, backtest on it". Files land in
``<config_dir>/data/<slug>.csv`` normalized to CANDLE_COLUMNS with ts in
epoch seconds, and ``manifest.json`` next to them records what each one is.

Import is deliberately forgiving about column names (ts/time/date/datetime,
o/h/l/c or full words, volume optional, epoch s/ms or datetime strings) so a
CSV exported from any broker or spreadsheet drops in unchanged.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from functools import wraps
import re
import time
from io import StringIO
from pathlib import Path

import pandas as pd

from lse_terminal.contracts import CANDLE_COLUMNS, Instrument, NotSupported, Provider
from lse_terminal.engine import config as cfg

_TF_SECONDS = {
    # No "tick" here: imported files are OHLC bars and there is no honest
    # way to divide a bar back into trades. Sub-minute entries serve users
    # whose imports ARE sub-minute; a 1m-native import asked for 1s hits
    # the existing divisibility refusal below, same as 1h-native asked
    # for 1m always has.
    "1s": 1, "30s": 30,
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
}

_TIME_NAMES = ("ts", "time", "timestamp", "date", "datetime")
_FIELD_ALIASES = {
    "open": ("open", "o"),
    "high": ("high", "h"),
    "low": ("low", "l"),
    "close": ("close", "c", "price", "adj close", "adj_close"),
    "volume": ("volume", "vol", "v"),
}


STORE_LOCK = threading.RLock()


def _store_locked(fn):
    @wraps(fn)
    def locked(*args, **kwargs):
        with STORE_LOCK:
            return fn(*args, **kwargs)
    return locked


class ImportError_(Exception):
    """User-facing import problem (bad columns, unparseable times)."""


def data_dir() -> Path:
    return cfg.config_dir() / "data"


def _manifest_path() -> Path:
    return data_dir() / "manifest.json"


@_store_locked
def load_manifest() -> dict:
    try:
        return json.loads(_manifest_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


@_store_locked
def _save_manifest(m: dict) -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".manifest-", suffix=".tmp", dir=data_dir())
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(m, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, _manifest_path())
    finally:
        Path(name).unlink(missing_ok=True)


def _slug(symbol: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", symbol).strip("_")
    return s or "dataset"


def _find_column(columns: list[str], wanted: tuple[str, ...]) -> str | None:
    lower = {c.lower().strip(): c for c in columns}
    for w in wanted:
        if w in lower:
            return lower[w]
    return None


def normalize_csv(text: str) -> pd.DataFrame:
    try:
        raw = pd.read_csv(StringIO(text))
    except Exception as e:
        raise ImportError_(f"could not parse the CSV: {e}") from e
    return normalize_frame(raw)


def normalize_frame(raw: pd.DataFrame) -> pd.DataFrame:
    """Arbitrary raw table -> CANDLE_COLUMNS frame (any decoder feeds this).

    Raises ImportError_ with a message a non-technical user can act on.
    """
    if raw.empty:
        raise ImportError_("the file has no rows")

    cols = list(raw.columns)
    time_col = _find_column(cols, _TIME_NAMES)
    if time_col is None:
        raise ImportError_(
            "no time column found (looked for: " + ", ".join(_TIME_NAMES) + ")")

    mapped: dict[str, str] = {}
    for field, aliases in _FIELD_ALIASES.items():
        col = _find_column(cols, aliases)
        if col is not None:
            mapped[field] = col
    missing = [f for f in ("open", "high", "low", "close") if f not in mapped]
    if missing:
        raise ImportError_("missing price columns: " + ", ".join(missing))

    t = raw[time_col]
    if pd.api.types.is_numeric_dtype(t):
        ts = pd.to_numeric(t, errors="coerce")
        # epoch ms vs s: anything past the year 5138 in seconds is ms
        ts = ts.where(ts < 1e11, ts / 1000.0)
    else:
        parsed = pd.to_datetime(t, errors="coerce", utc=True)
        # total_seconds is resolution-independent (pandas may parse to ns OR
        # us depending on the input strings; a raw int64 cast is not safe).
        ts = (parsed - pd.Timestamp(0, tz="UTC")).dt.total_seconds()

    out = pd.DataFrame({"ts": ts})
    for field in ("open", "high", "low", "close"):
        out[field] = pd.to_numeric(raw[mapped[field]], errors="coerce")
    out["volume"] = (
        pd.to_numeric(raw[mapped["volume"]], errors="coerce").fillna(0.0)
        if "volume" in mapped else 0.0
    )

    out = out.dropna(subset=["ts", "open", "high", "low", "close"])
    if out.empty:
        raise ImportError_("no usable rows after parsing (bad times or prices?)")
    out["ts"] = out["ts"].astype("int64")
    out = out.sort_values("ts").drop_duplicates(subset="ts", keep="last")
    return out[CANDLE_COLUMNS].reset_index(drop=True)


def repair_float32_prices(df: pd.DataFrame) -> tuple[pd.DataFrame, int | None]:
    """Detect and undo float32 price damage in open/high/low/close.

    Many vendor exports pass prices through single precision (about 7
    significant digits), which turns 209.53 into 209.529999. The damage is
    mathematically detectable: if snapping a column to p decimals
    reproduces every stored value within float32's error band, the column
    IS float32-damaged p-decimal prices and the snap recovers the true
    grid exactly. The smallest p that explains all values wins. A file
    already exactly on its grid is left untouched, and a file no p
    explains is left untouched: never guess, only repair what is provably
    float32 damage. Volume is never touched. Returns (frame, decimals) with
    decimals None when nothing was repaired."""
    import numpy as np
    cols = ["open", "high", "low", "close"]
    vals = pd.concat([df[c] for c in cols]).to_numpy(dtype=float)
    vals = vals[np.isfinite(vals)]
    if len(vals) == 0:
        return df, None
    scale = np.maximum(np.abs(vals), 1.0)
    for p in range(0, 7):
        snapped = np.round(vals, p)
        err = np.abs(snapped - vals)
        # float32 keeps ~2^-24 relative precision; the extra term absorbs
        # the 6-decimal text printing these files usually carry.
        tol = scale * 6e-7 + (10.0 ** (-p)) * 1e-3
        if np.all(err <= tol):
            if float(np.max(err)) <= float(scale.max()) * 1e-12:
                return df, None  # already exactly on this grid: clean file
            out = df.copy()
            for c in cols:
                out[c] = out[c].round(p)
            return out, p
    return df, None


def infer_timeframe(df: pd.DataFrame) -> str:
    """Best-effort label from the median bar spacing; '?' when irregular."""
    if len(df) < 3:
        return "?"
    diffs = df["ts"].diff().dropna()
    med = float(diffs.median())
    for label, secs in _TF_SECONDS.items():
        if abs(med - secs) < secs * 0.05:
            return label
    return "?"


def _parse_time_series(text: str) -> pd.DataFrame:
    try:
        raw = pd.read_csv(StringIO(text))
    except Exception as e:
        raise ImportError_(f"could not parse the CSV: {e}") from e
    return series_frame(raw)


def series_frame(raw: pd.DataFrame) -> pd.DataFrame:
    """Generic time + numeric-columns table (alternative data): normalized to
    a 'ts' seconds column plus every numeric column found, sorted, deduped."""
    if raw.empty:
        raise ImportError_("the file has no rows")
    time_col = _find_column(list(raw.columns), _TIME_NAMES)
    if time_col is None:
        raise ImportError_(
            "no time column found (looked for: " + ", ".join(_TIME_NAMES) + ")")
    t = raw[time_col]
    if pd.api.types.is_numeric_dtype(t):
        ts = pd.to_numeric(t, errors="coerce")
        ts = ts.where(ts < 1e11, ts / 1000.0)
    else:
        parsed = pd.to_datetime(t, errors="coerce", utc=True)
        ts = (parsed - pd.Timestamp(0, tz="UTC")).dt.total_seconds()
    # Split the non-time columns into numeric values and text. A text column
    # with a handful of repeating values is a symbol tag: the file is LONG
    # format (many pairs stacked). That column used to be silently
    # dropped and the ts dedupe then kept only the LAST pair per timestamp,
    # so a 3-pair file imported as one mangled series with no warning.
    numeric_cols, text_cols = [], []
    for c in raw.columns:
        if c == time_col:
            continue
        if pd.to_numeric(raw[c], errors="coerce").notna().sum() == 0:
            text_cols.append(c)
        else:
            numeric_cols.append(c)
    if not numeric_cols:
        raise ImportError_("no numeric data columns found next to the time column")

    def _clean_name(c, taken):
        n = re.sub(r"[^A-Za-z0-9_]+", "_", str(c)).strip("_").lower() or "value"
        base, k = n, 1
        while n in taken:
            n = f"{base}_{k}"
            k += 1
        taken.add(n)
        return n

    # Symbol tags REPEAT (each pair appears on many dates); a free-text
    # notes column is unique per row. No upper count bound here: a file
    # with 250 symbols must hit the explicit cap error below, never fall
    # through to the old silent keep-last-per-timestamp mangling.
    cats = [c for c in text_cols
            if 2 <= raw[c].astype(str).str.strip().nunique() < len(raw)]
    if len(cats) > 1:
        raise ImportError_(
            "two text columns could each be the symbol column ("
            + ", ".join(str(c) for c in cats)
            + "); keep one text column per file, or pivot it to one column "
              "per pair before importing")
    if cats:
        # LONG -> WIDE: one column per pair (per pair-and-field when the
        # file carries several value columns), so no pair is thrown away.
        cat = cats[0]
        sym = raw[cat].astype(str).str.strip()
        syms = sorted(sym.unique())
        if len(syms) * len(numeric_cols) > 200:
            raise ImportError_(
                f"{len(syms)} symbols with {len(numeric_cols)} value column(s) "
                f"would make {len(syms) * len(numeric_cols)} columns; the cap "
                "is 200. Split the file into fewer symbols per import")
        wide = pd.DataFrame({"__ts": ts, "__sym": sym})
        for c in numeric_cols:
            wide[c] = pd.to_numeric(raw[c], errors="coerce")
        wide = wide.dropna(subset=["__ts"])
        if wide.empty:
            raise ImportError_("no usable rows after parsing (bad times?)")
        pv = wide.pivot_table(index="__ts", columns="__sym",
                              values=numeric_cols, aggfunc="last")
        out = pd.DataFrame({"ts": pv.index.astype("int64")})
        taken: set = set()
        for s in syms:
            for c in numeric_cols:
                name = s if len(numeric_cols) == 1 else f"{s}_{c}"
                out[_clean_name(name, taken)] = pv[(c, s)].to_numpy()
        return out.sort_values("ts").reset_index(drop=True)

    out = pd.DataFrame({"ts": ts})
    taken = set()
    for c in numeric_cols:
        out[_clean_name(c, taken)] = pd.to_numeric(raw[c], errors="coerce")
    out = out.dropna(subset=["ts"])
    if out.empty:
        raise ImportError_("no usable rows after parsing (bad times?)")
    out["ts"] = out["ts"].astype("int64")
    before = len(out)
    out = out.sort_values("ts").drop_duplicates(subset="ts", keep="last")
    # Timestamps normally repeat only in revision-style files, where
    # keep-last is what the user wants. But if a text column was present
    # and a big share of rows would vanish, this is almost certainly a
    # stacked multi-pair file whose tag we could not identify: refuse
    # loudly rather than shrink the data in silence.
    if text_cols and before - len(out) > max(1, before // 5):
        raise ImportError_(
            f"{before - len(out)} of {before} rows share a timestamp with "
            "another row and would be dropped. If this file stacks several "
            f"pairs, make the text column ({text_cols[0]}) a symbol tag with "
            "repeated values, or pivot to one column per pair before importing")
    return out.reset_index(drop=True)


def detect_kind(text: str) -> str:
    try:
        head = pd.read_csv(StringIO(text), nrows=1)
    except Exception:
        return "series"
    return detect_kind_frame(head)


def detect_kind_frame(raw: pd.DataFrame) -> str:
    """'ohlcv' when the price columns are all present, else 'series'."""
    cols = list(raw.columns)
    have = all(_find_column(cols, _FIELD_ALIASES[f]) for f in ("open", "high", "low", "close"))
    return "ohlcv" if have else "series"


def preview_csv(text: str) -> dict:
    """Dry-run of an import: what we detected, so the user can confirm or
    override before anything is written."""
    kind = detect_kind(text)
    if kind == "ohlcv":
        df = normalize_csv(text)
        cols = ["open", "high", "low", "close", "volume"]
    else:
        df = _parse_time_series(text)
        cols = [c for c in df.columns if c != "ts"]
    return {
        "kind": kind,
        "rows": int(len(df)),
        "columns": cols,
        "first_ts": int(df["ts"].iloc[0]),
        "last_ts": int(df["ts"].iloc[-1]),
        "timeframe": infer_timeframe(df) if kind == "ohlcv" else None,
        "sample": df.head(3).values.tolist(),
    }


@_store_locked
def import_csv(symbol: str, text: str, name: str = "", folder: str = "",
               kind: str = "") -> dict:
    """Normalize + store one dataset; returns its manifest entry.

    kind: '' = auto-detect; 'ohlcv' = chartable candles; 'series' =
    alternative data (any timestamped numeric columns), stored engine-ready
    so Brue strategies can `use` it directly.
    """
    kind = kind or detect_kind(text)
    repaired_dp = None
    if kind == "ohlcv":
        df = normalize_csv(text)
        df, repaired_dp = repair_float32_prices(df)
        tf = infer_timeframe(df)
        columns = []
    else:
        df = _parse_time_series(text)
        tf = None
        columns = [c for c in df.columns if c != "ts"]
    slug = _slug(symbol)
    data_dir().mkdir(parents=True, exist_ok=True)
    path = data_dir() / f"{slug}.csv"
    if kind == "series":
        # Engine-ready format: `time` in EPOCH MS first, then the columns
        # (brue's parse_data_file contract), so backtests reference the file
        # as-is with --data.
        eng = df.rename(columns={"ts": "time"}).copy()
        eng["time"] = eng["time"] * 1000
        eng.to_csv(path, index=False)
    else:
        df.to_csv(path, index=False)
    manifest = load_manifest()
    entry = {
        "symbol": symbol,
        "name": name or symbol,
        "kind": kind,
        "folder": folder.strip().strip("/"),
        "columns": columns,
        "file": path.name,
        "timeframe": tf,
        "rows": int(len(df)),
        "first_ts": int(df["ts"].iloc[0]),
        "last_ts": int(df["ts"].iloc[-1]),
        "imported_at": int(time.time()),
        # Provenance: this file arrived from OUTSIDE (dropped/pasted), so
        # its data quality is whatever its producer did. LSE-provider
        # downloads never pass through here.
        "source": "user-import",
    }
    if repaired_dp is not None:
        entry["price_repair"] = {"decimals": repaired_dp,
                                 "reason": "float32 artifacts detected"}
    manifest[symbol] = entry
    _save_manifest(manifest)
    return entry


@_store_locked
def import_table(symbol: str, raw: pd.DataFrame, name: str = "",
                 folder: str = "", kind: str = "", source_ext: str = ".csv") -> dict:
    """Import an already-decoded table (any format). Same semantics as
    import_csv, minus the CSV parsing."""
    kind = kind or detect_kind_frame(raw)
    repaired_dp = None
    if kind == "ohlcv":
        df = normalize_frame(raw)
        df, repaired_dp = repair_float32_prices(df)
        tf = infer_timeframe(df)
        columns = []
    else:
        df = series_frame(raw)
        tf = None
        columns = [c for c in df.columns if c != "ts"]
    slug = _slug(symbol)
    data_dir().mkdir(parents=True, exist_ok=True)
    path = data_dir() / f"{slug}.csv"
    if kind == "series":
        eng = df.rename(columns={"ts": "time"}).copy()
        eng["time"] = eng["time"] * 1000
        eng.to_csv(path, index=False)
    else:
        df.to_csv(path, index=False)
    manifest = load_manifest()
    entry = {
        "symbol": symbol,
        "name": name or symbol,
        "kind": kind,
        "folder": folder.strip().strip("/"),
        "columns": columns,
        "file": path.name,
        "ext": source_ext,
        "timeframe": tf,
        "rows": int(len(df)),
        "first_ts": int(df["ts"].iloc[0]),
        "last_ts": int(df["ts"].iloc[-1]),
        "imported_at": int(time.time()),
        "source": "user-import",
    }
    if repaired_dp is not None:
        entry["price_repair"] = {"decimals": repaired_dp,
                                 "reason": "float32 artifacts detected"}
    manifest[symbol] = entry
    _save_manifest(manifest)
    return entry


# The bundled library, in the order it should read in the sidebar: the two
# deepest intraday sets first, then the daily set, then the curve.
# (file, symbol, display name, kind)
#
# A fresh download must already hold real data across
# real asset classes, so "is this legit" is answered before the user has
# imported anything or entered a key. Six classes, 1990-2026, ~11 MB of
# parquet in the install: commodity (gold hourly to 2006, silver, Brent),
# FX (EUR/USD hourly to 2003, USD/JPY), index (S&P 500 hourly, Nasdaq 100),
# crypto (Bitcoin hourly to 2017), equity (Apple), and the US Treasury curve
# as an alternative-data series a strategy can bind to.
SAMPLES = (
    ("gold_1h.parquet",      "GOLD",     "Gold",                     "ohlcv"),
    ("eurusd_1h.parquet",    "EURUSD",   "Euro / US Dollar",         "ohlcv"),
    ("spx500_1h.parquet",    "SPX500",   "S&P 500",                  "ohlcv"),
    ("btcusd_1h.parquet",    "BTCUSD",   "Bitcoin",                  "ohlcv"),
    ("silver_1d.parquet",    "SILVER",   "Silver",                   "ohlcv"),
    ("brent_1d.parquet",     "BRENT",    "Brent Crude",              "ohlcv"),
    ("usdjpy_1d.parquet",    "USDJPY",   "US Dollar / Japanese Yen", "ohlcv"),
    ("nas100_1d.parquet",    "NAS100",   "Nasdaq 100",               "ohlcv"),
    ("aapl_1d.parquet",      "AAPL",     "Apple",                    "ohlcv"),
    ("us_yields_1d.parquet", "USYIELDS", "US Treasury Curve",        "series"),
)


def available_samples() -> list[dict]:
    """Bundled sample datasets NOT yet in the user's library. Installs that
    predate the ten-dataset library (seed_samples only runs on first launch)
    can pull them in one by one through import_sample()."""
    manifest = load_manifest()
    samples = Path(__file__).resolve().parent.parent / "samples"
    out = []
    for fname, symbol, display, kind in SAMPLES:
        if symbol in manifest or not (samples / fname).exists():
            continue
        out.append({"symbol": symbol, "name": display, "kind": kind})
    return out


@_store_locked
def import_sample(symbol: str) -> dict | None:
    """Import one bundled sample into the user's library; idempotent (an
    already-imported symbol just returns its entry). None if no such sample."""
    manifest = load_manifest()
    if symbol in manifest:
        return manifest[symbol]
    samples = Path(__file__).resolve().parent.parent / "samples"
    for fname, sym, display, kind in SAMPLES:
        if sym != symbol:
            continue
        path = samples / fname
        if not path.exists():
            return None
        entry = import_table(symbol, pd.read_parquet(path), name=display,
                             folder="Samples", kind=kind,
                             source_ext=".parquet")
        entry["source"] = "bundled-sample"
        m = load_manifest()
        m[symbol] = entry
        _save_manifest(m)
        return entry
    return None


@_store_locked
def seed_samples() -> None:
    """First-run only: preload the bundled sample datasets so a fresh
    download can chart and backtest immediately, with zero imports and no
    API key.

    Keyed on manifest.json NOT existing: once anything has been imported
    (or this has run), the manifest exists and we never touch the library
    again, so a user who deletes the samples does not get them back on the
    next launch."""
    if _manifest_path().exists():
        return
    samples = Path(__file__).resolve().parent.parent / "samples"
    for fname, symbol, display, kind in SAMPLES:
        path = samples / fname
        if not path.exists():
            continue  # source checkout without bundled data; nothing to seed
        try:
            entry = import_table(symbol, pd.read_parquet(path), name=display,
                                 folder="Samples", kind=kind,
                                 source_ext=".parquet")
            # Honest provenance: these did not arrive through an upload.
            entry["source"] = "bundled-sample"
            m = load_manifest()
            m[symbol] = entry
            _save_manifest(m)
        except Exception:
            # Seeding is a convenience; a failure must never block startup.
            continue


@_store_locked
def update_dataset(symbol: str, name: str | None = None,
                   folder: str | None = None) -> dict | None:
    """Rename / move-to-folder; returns the updated entry or None."""
    manifest = load_manifest()
    entry = manifest.get(symbol)
    if entry is None:
        return None
    if name is not None and name.strip():
        entry["name"] = name.strip()
    if folder is not None:
        entry["folder"] = folder.strip().strip("/")
    _save_manifest(manifest)
    return entry


def dataset_path(symbol: str):
    entry = load_manifest().get(symbol)
    if entry is None:
        return None
    return data_dir() / entry["file"]


@_store_locked
def delete_dataset(symbol: str) -> bool:
    manifest = load_manifest()
    entry = manifest.pop(symbol, None)
    if entry is None:
        return False
    try:
        (data_dir() / entry["file"]).unlink()
    except FileNotFoundError:
        pass
    _save_manifest(manifest)
    return True


class UserDataProvider(Provider):
    name = "userdata"
    title = "My Data"
    timeframes = list(_TF_SECONDS)
    deterministic = True

    def configured(self) -> bool:
        return True  # always available; just empty until an import

    def search(self, query: str = "", limit: int = 50) -> list[Instrument]:
        q = query.lower()
        out = []
        for sym, e in load_manifest().items():
            if e.get("kind", "ohlcv") != "ohlcv":
                continue  # series/alternative data is not chartable candles
            if q and q not in sym.lower() and q not in e.get("name", "").lower():
                continue
            out.append(Instrument(
                symbol=sym, name=e.get("name", sym), category="My Data",
                provider=self.name,
                meta={"timeframe": e.get("timeframe", "?"), "rows": e.get("rows", 0)},
            ))
        return out[:limit]

    def candles(self, symbol: str, timeframe: str, limit: int = 500,
                start: str | None = None, end: str | None = None) -> pd.DataFrame:
        entry = load_manifest().get(symbol)
        if entry is None:
            raise NotSupported(f"no imported dataset named {symbol}")
        df = pd.read_csv(data_dir() / entry["file"])

        native = entry.get("timeframe", "?")
        if timeframe != native:
            native_s = _TF_SECONDS.get(native)
            want_s = _TF_SECONDS.get(timeframe)
            if native_s is None or want_s is None or want_s % native_s != 0:
                raise NotSupported(
                    f"{symbol} was imported as {native}; cannot serve {timeframe}")
            # epoch-floor buckets, same rule as everywhere else in the app:
            # never local-calendar truncation.
            bucket = (df["ts"] // want_s) * want_s
            df = df.groupby(bucket).agg(
                open=("open", "first"), high=("high", "max"),
                low=("low", "min"), close=("close", "last"),
                volume=("volume", "sum"),
            ).reset_index().rename(columns={"ts": "ts"})
            df.columns = CANDLE_COLUMNS

        # Window filters, same semantics as the other providers. Imported
        # datasets were previously served whole-file-newest-N only, which the
        # chart tolerated; the manual backtester's windowed replay load needs
        # real bounds.
        if start:
            df = df[df["ts"] >= int(pd.Timestamp(start, tz="UTC").timestamp())]
        if end:
            df = df[df["ts"] <= int(pd.Timestamp(end, tz="UTC").timestamp())]
        # Start-anchored queries page FORWARD (oldest N from start); everything
        # else returns the newest N. The frontend's pagination depends on this.
        if limit and len(df) > limit:
            df = (df.head(limit) if start else df.tail(limit)).reset_index(drop=True)
        return df[CANDLE_COLUMNS].reset_index(drop=True)


# ── Folder management (explorer-style; empty folders persist) ─────────────

def _folders_path() -> Path:
    return data_dir() / "folders.json"


def load_folders() -> list[str]:
    """Explicitly created folders plus every folder datasets live in."""
    try:
        explicit = set(json.loads(_folders_path().read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        explicit = set()
    # every ancestor exists implicitly: a/b/c implies a and a/b, whether the
    # path came from an explicit create or from a dataset's folder
    paths = set(explicit) | {e.get("folder", "") for e in load_manifest().values()}
    out: set[str] = set()
    for f in paths:
        parts = [p for p in f.split("/") if p]
        for i in range(1, len(parts) + 1):
            out.add("/".join(parts[:i]))
    return sorted(out)


@_store_locked
def _save_folders(folders: set[str]) -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    _folders_path().write_text(json.dumps(sorted(folders)) + "\n")


@_store_locked
def create_folder(path: str) -> list[str]:
    path = path.strip().strip("/")
    if not path:
        raise ImportError_("folder needs a name")
    if any(seg == "" for seg in path.split("/")):
        raise ImportError_("bad folder path")
    try:
        explicit = set(json.loads(_folders_path().read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        explicit = set()
    explicit.add(path)
    _save_folders(explicit)
    return load_folders()


@_store_locked
def rename_folder(path: str, new_path: str) -> list[str]:
    path = path.strip().strip("/")
    new_path = new_path.strip().strip("/")
    if not path or not new_path:
        raise ImportError_("folder rename needs both names")
    manifest = load_manifest()
    for e in manifest.values():
        f = e.get("folder", "")
        if f == path or f.startswith(path + "/"):
            e["folder"] = new_path + f[len(path):]
    _save_manifest(manifest)
    try:
        explicit = set(json.loads(_folders_path().read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        explicit = set()
    renamed = set()
    for f in explicit:
        if f == path or f.startswith(path + "/"):
            renamed.add(new_path + f[len(path):])
        else:
            renamed.add(f)
    renamed.add(new_path)
    _save_folders(renamed)
    return load_folders()


@_store_locked
def delete_folder(path: str) -> list[str]:
    """Delete a folder; its datasets (and subfolder datasets) move up to the
    parent so nothing is ever destroyed by a folder delete."""
    path = path.strip().strip("/")
    if not path:
        raise ImportError_("folder needs a name")
    parent = "/".join(path.split("/")[:-1])
    manifest = load_manifest()
    for e in manifest.values():
        f = e.get("folder", "")
        if f == path or f.startswith(path + "/"):
            tail = f[len(path):].strip("/")
            e["folder"] = "/".join(x for x in (parent, tail) if x)
    _save_manifest(manifest)
    try:
        explicit = set(json.loads(_folders_path().read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        explicit = set()
    explicit = {f for f in explicit if not (f == path or f.startswith(path + "/"))}
    _save_folders(explicit)
    return load_folders()
