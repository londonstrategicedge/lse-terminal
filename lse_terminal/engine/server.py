"""The local API server. The bundled web UI is one client of this; notebooks
and scripts hitting the same endpoints are another. Everything the UI can do
happens through these routes, so the terminal stays fully headless-drivable.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import types
import time
from pathlib import Path

import pandas as pd
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lse_terminal import __version__
from lse_terminal.contracts import NotSupported, all_specs, compute
from lse_terminal.engine import config as cfg
from lse_terminal.engine.registry import Registry, load_builtins, load_plugins
from lse_terminal.engine.user_indicators import TEMPLATE, UserIndicators
from lse_terminal.engine import notebooks as nbstore
from lse_terminal.engine import workspace
from lse_terminal.engine.streaming import bridge

_STATIC = Path(__file__).resolve().parent.parent / "ui" / "static"


def _write_whole(target: Path, text: str) -> None:
    """`text` as the whole of `target`, mode 0600: written to a temporary file
    in the same folder (a dot name ending .tmp, which no reader of the
    target's own pattern matches), synced, then renamed over it. A reader
    finds the file whole or not at all; a failure leaves nothing behind."""
    import tempfile  # noqa: PLC0415
    folder = target.parent
    folder.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(folder), prefix=f".{target.stem}-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── The built-in user guide (the TERMINAL WALKTHROUGH tab) ──
# ONE source of truth, ui/static/guide.md: the walkthrough page renders it, the
# hosted assistant gets its section summaries every turn plus a read_guide
# local tool for the full text, the user's own CLI agent gets it as GUIDE.md
# in the ai-workspace, and /mcp exposes the same read_guide to any other
# local MCP client. It lives in the static dir on purpose: the frozen
# desktop sidecar hot-deploys UI files only, so a guide edit reaches the
# user's screen (the page reads /guide.md directly) without an engine
# rebuild; the engine helpers below re-read the file on every call, so
# they never serve a stale copy either.
# Convention the summary depends on: each `## Section` opens with ONE plain
# paragraph that says what the section covers; guide_brief() lifts exactly
# that paragraph, so the model's per-turn view of the guide is the authors'
# own one-liners, never a machine truncation.
_GUIDE_PATH = _STATIC / "guide.md"


def guide_text() -> str:
    try:
        return _GUIDE_PATH.read_text(encoding="utf-8")
    except OSError:
        return ""


def guide_sections() -> list[tuple[str, str]]:
    """The guide split on its `## ` headings: [(title, body)], with the part
    before the first heading (the document title + intro) as ("", body).
    Fenced code is skipped so a `##` inside a snippet cannot split a section."""
    out: list[tuple[str, str]] = []
    title, buf, fenced = "", [], False
    for line in guide_text().splitlines():
        if line.startswith("```"):
            fenced = not fenced
        if not fenced and line.startswith("## "):
            out.append((title, "\n".join(buf).strip()))
            title, buf = line[3:].strip(), []
            continue
        buf.append(line)
    out.append((title, "\n".join(buf).strip()))
    return out


def guide_brief(limit: int = 7000) -> str:
    """The per-turn summary handed to the hosted assistant: one line per
    section (number, title, its opening paragraph). Capped because the
    cloud side truncates any single system message at 8000 chars; the full
    text is one read_guide call away, so nothing is lost by the cap."""
    lines = ["TERMINAL GUIDE (summary of the terminal's built-in user guide, "
             "the TERMINAL WALKTHROUGH tab, top right next to MY DATA; the "
             "numbered sections are what read_guide "
             "returns in full: call it with a section number or title before "
             "answering how the app works, what it can do, or how to do "
             "something in it):"]
    n = 0
    for title, body in guide_sections():
        if not title:
            continue
        n += 1
        first = ""
        for para in body.split("\n\n"):
            p = para.strip()
            if p and not p.startswith(("#", "```", "|", "- ", "* ", ">")):
                first = " ".join(p.split())
                break
        lines.append(f"{n}. {title}: {first}" if first else f"{n}. {title}")
    if n == 0:
        return ""  # no guide in this build: advertise nothing
    return "\n".join(lines)[:limit]


def guide_section(query: str = "") -> str:
    """The whole guide, or one section by number or title (case-insensitive;
    a substring is enough). An unknown name returns the section list, so a
    wrong guess still lands the caller somewhere useful."""
    secs = [(t, b) for t, b in guide_sections() if t]
    q = (query or "").strip().lower()
    if not q or q in ("all", "*", "everything", "full", "whole"):
        return guide_text() or "the guide file is missing from this build"
    if q.isdigit() and 1 <= int(q) <= len(secs):
        t, b = secs[int(q) - 1]
        return f"## {t}\n{b}"
    for t, b in secs:
        if q == t.lower():
            return f"## {t}\n{b}"
    for t, b in secs:
        if q in t.lower():
            return f"## {t}\n{b}"
    return ("no guide section named " + repr(query) + "; sections are:\n"
            + "\n".join(f"{i + 1}. {t}" for i, (t, _) in enumerate(secs)))


# The hosted LSE assistant the in-app chat proxies to (see /api/assistant).
# Env override is for LSE-side development against a staging endpoint.
ASSISTANT_URL = os.environ.get(
    "LSE_ASSISTANT_URL",
    "https://api.londonstrategicedge.com/brue-cloud/terminal-assistant")


def _mask_account(account_id) -> str:
    """An account id as a sentence names it, the form the card shows: an
    ellipsis and its last dash-part ("101-004-7240139-001" -> "…-001"), or
    the whole of a short id with no dash."""
    s = str(account_id or "")
    if not s:
        return "no account"
    if "-" in s:
        return "…-" + s.rsplit("-", 1)[-1]
    return "…" + s[-4:] if len(s) > 4 else s


def _parse_indicators(raw: str) -> list[tuple[str, dict]]:
    """Parse "sma:length=20,rsi:length=14" into [(name, params), ...]."""
    out: list[tuple[str, dict]] = []
    for item in filter(None, (s.strip() for s in raw.split(","))):
        name, _, ptail = item.partition(":")
        params: dict = {}
        for pair in filter(None, ptail.split(";")):
            k, _, v = pair.partition("=")
            params[k.strip()] = v.strip()
        out.append((name.strip(), params))
    return out


class KeyIn(BaseModel):
    key: str


class AssistantIn(BaseModel):
    # Chat turns in OpenAI shape ({role, content}); the cloud endpoint owns
    # the system prompt, caps and validation, so this stays a thin envelope.
    messages: list[dict]
    max_tokens: int = 8192


class SourceIn(BaseModel):
    source: str


class PreviewIn(BaseModel):
    # Draft indicator source for the editor's live preview. filename only
    # decides the language (.brue compiles; anything else execs as Python);
    # nothing is written to disk.
    source: str
    filename: str = "preview.py"
    provider: str
    symbol: str
    timeframe: str = "1h"
    limit: int = 300


class WsFileIn(BaseModel):
    path: str
    content: str = ""
    to: str = ""


class QuantFitIn(BaseModel):
    model: str
    datasets: list[str] = []
    source: str = "datasets"        # or "lse-options" for a live chain
    underlying: str = ""
    opts: dict = {}


class QuantSampleIn(BaseModel):
    symbol: str


class MLCodeIn(BaseModel):
    code: str


class MLDatasetIn(BaseModel):
    name: str
    source: str
    timeframe: str = "1h"
    bars: int = 5000
    start: str | None = None
    end: str | None = None
    features: list[str] = []


class MLTrainIn(BaseModel):
    model_key: str
    provider: str
    symbol: str
    timeframe: str = "1h"
    limit: int = 5000
    start: str | None = None
    end: str | None = None
    params: dict = {}
    # Feature ids from the catalog FEATURES list, for models that accept a
    # feature selection (--features). Empty = script defaults (OHLCV).
    features: list[str] = []


class BacktestIn(BaseModel):
    engine: str = "python"
    provider: str
    symbol: str
    timeframe: str = "1h"
    script: str
    # 0 = every bar the provider has (a backtest reads the user's own files;
    # the whole history is the point). A positive value caps the load.
    limit: int = 0
    # Run options passed through to the engine: date window, extended
    # stats, pre-run resample. All optional; empty dict = plain run.
    options: dict = {}
    # User datasets to attach as `use NAME` bindings (alternative data).
    datasets: list[str] = []


class MonteCarloIn(BacktestIn):
    runs: int = 1000
    seed: int = 42


class WalkForwardIn(BacktestIn):
    # {"len": "5:30:5", "mult": "1,2,3"} - name -> grid spec
    params: dict[str, str] = {}
    folds: int = 4
    train: float = 0.7
    metric: str = "netProfit"


class AlgoStartIn(BaseModel):
    # /api/algo/start: attach the editor's strategy to a live paper run.
    # Module-level (not inside create_app): postponed annotations mean
    # FastAPI can't resolve function-local model classes.
    script: str
    symbol: str = "EURUSD"
    timeframe: str = "1m"
    warmup: int = 100
    bars: int = 100000  # effectively "until stopped"


class AiWorkspaceIn(BaseModel):
    script: str
    provider: str = ""
    symbol: str = ""
    timeframe: str = "1h"
    # Workspace-relative path of the strategy file open in the editor right
    # now, so "the code on my screen" resolves to a file instead of a guess.
    open_file: str = ""
    # The page the app is showing ("ECONOMIC > CALENDAR"), from the live nav
    # state; stamped into each turn so the agent knows what the user sees.
    view: str = ""
    # Live account + open positions as DATA (None when there is no sim
    # session). The agent can see the screen, but reading a P&L off a
    # screenshot is how a winning EUR/JPY short got reported as a losing
    # "EURUSD"; numbers must arrive as numbers.
    account: dict | None = None
    # The whole screen as a self-describing map: every region with its
    # bounds, visibility, current values, and `more` (the tool or endpoint
    # that returns its detail). The agent reads the region that owns the
    # question instead of needing the brief to enumerate every question.
    terminal: dict | None = None


class AiSettingsIn(BaseModel):
    # Windows only: OpenAI's sandbox runner can be broken/hanging on a
    # machine (seen live: "runner pipe-in" timeouts); this consent-gated
    # switch runs ChatGPT commands without that sandbox instead.
    codex_full_access: bool


class AiUpdateIn(BaseModel):
    agent: str
    # True: the user asked for this update (the menu row or /update), which
    # also turns on keeping this CLI current. False: the page's own
    # automatic update, allowed only where that is already on.
    asked: bool = False


class AiAutoUpdateIn(BaseModel):
    agent: str
    enabled: bool


class AiInstructionsIn(BaseModel):
    # The rail's settings panel edits USER.md only; every other workspace
    # .md is regenerated from the brief and would silently lose hand edits.
    name: str
    content: str


class AiToolRunIn(BaseModel):
    # From the bridge's "tools" role: a native capability call.
    token: str
    name: str
    args: dict = {}


class AiAgentIn(BaseModel):
    agent: str = "claude"


class AiRevertIn(BaseModel):
    # Checkpoint id from the chat's revert button.
    id: str


class AiPasteIn(BaseModel):
    # Base64 PNG/JPEG pasted into the chat composer; lands in the agent
    # workspace so vision-capable CLIs can Read it.
    data: str


class AiApproveIn(BaseModel):
    # From the local approve_bridge subprocess only (token-gated): a Claude
    # tool call waiting on the user's Allow/Deny in the rail.
    token: str
    tool_name: str = ""
    input: dict = {}


class AiKeyIn(BaseModel):
    # Connection modes for the AI panel beyond a consumer login:
    #   api-key  Anthropic console / OpenAI platform key
    #   foundry  Microsoft Foundry (claude only): resource or endpoint + key
    # Empty key removes the stored connection (back to subscription mode).
    agent: str
    key: str = ""
    mode: str = "api-key"
    resource: str = ""  # foundry resource name, or a full https endpoint


class DataImportIn(BaseModel):
    symbol: str
    name: str = ""
    csv_text: str
    folder: str = ""
    kind: str = ""  # "" = auto-detect; "ohlcv" | "series"


class DataPreviewIn(BaseModel):
    csv_text: str


class DataUpdateIn(BaseModel):
    name: str | None = None
    folder: str | None = None


class FolderIn(BaseModel):
    path: str
    new_path: str | None = None


class LseBankImportIn(BaseModel):
    # Module level like every request model: `from __future__ import
    # annotations` makes closure-local models unresolvable to FastAPI (it
    # reads them as query params).
    dataset: str
    symbol: str = ""      # one market instrument or series
    timeframe: str = "1h"
    start: str = ""
    end: str = ""
    folder: str = ""


class _LocalOnlyGuard:
    """Reject browser cross-site and DNS-rebinding requests, engine-wide.

    The engine trusts the local machine (loopback bind, no auth). The one
    local program that runs REMOTE code is the browser: any web page a user
    visits can fire fetch()/WebSocket at 127.0.0.1 (localhost CSRF), and DNS
    rebinding can resolve evil.com TO 127.0.0.1, which matters for every
    endpoint and most of all the PTY websockets. Two header checks kill the
    whole class without adding any friction for real local clients:

    - Host must be a loopback name. A rebound page's requests carry the
      attacker's hostname, a tunnel or direct local call carries loopback.
    - Origin, when present, must be a loopback origin. Browsers stamp the
      true page origin on every cross-origin request and WebSocket and
      pages cannot forge it; native processes (the agent CLIs, curl, MCP
      clients, the stdio bridge) send no Origin at all. "null" (sandboxed
      iframe / file://) is rejected.

    The MCP spec requires exactly this Origin validation for streamable
    HTTP servers; applied to the whole app because the exposure is shared.
    Raw ASGI (not BaseHTTPMiddleware) so websocket handshakes are covered.
    Hosted mode never installs this guard: there the public domain IS the
    legitimate Host/Origin and nginx fronts the app.
    """

    _LOOPBACK = {"127.0.0.1", "localhost", "::1"}

    def __init__(self, app):
        self.app = app

    @classmethod
    def _hostname(cls, netloc: str) -> str:
        netloc = netloc.strip().lower()
        if netloc.startswith("["):          # [::1]:7799
            return netloc[1:].split("]", 1)[0]
        return netloc.rsplit(":", 1)[0] if ":" in netloc else netloc

    @classmethod
    def _allowed(cls, scope) -> bool:
        hdrs = {}
        for k, v in scope.get("headers") or []:
            hdrs.setdefault(k, v)
        host = cls._hostname(hdrs.get(b"host", b"").decode("latin1"))
        if host not in cls._LOOPBACK:
            return False
        origin = hdrs.get(b"origin", b"").decode("latin1").strip().lower()
        if not origin:
            return True
        from urllib.parse import urlsplit
        try:
            return cls._hostname(urlsplit(origin).netloc) in cls._LOOPBACK
        except ValueError:
            return False

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or self._allowed(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            # Refuse the handshake; uvicorn turns this into an HTTP 403.
            await send({"type": "websocket.close", "code": 4403})
            return
        await send({"type": "http.response.start", "status": 403,
                    "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body",
                    "body": b"local requests only: this engine rejects "
                            b"cross-site browser and non-loopback calls"})


class _HostedRateLimit:
    """Per-client request budget for the HOSTED website instance ONLY.

    The public embed has no login by design (forcing a sign-in is friction
    users do not get). Instead every visitor gets a
    cost-weighted token bucket keyed by their real IP, so nobody can hammer
    the data, sim or upload paths indefinitely, no account required. A normal
    read costs 1 token; the expensive paths (file parsing, sim relay, data
    fetches, per-key work) cost more, so the same bucket that allows brisk
    browsing throttles a scraper or a decompression-bomb loop to a trickle.

    Refills continuously (token bucket, not a fixed window), so a real user
    clicking around never notices and only sustained abuse hits the wall,
    which then returns 429 + Retry-After. Desktop mode never installs this:
    there the machine is the user's own and there is nothing to share.
    """

    CAPACITY = 300.0            # burst budget per client
    REFILL_PER_S = 5.0          # sustained: 5 light reqs/s, or fewer heavy
    _HEAVY = (                  # path prefix -> token cost
        ("/api/dataviz", 40), ("/api/data/upload", 40),
        ("/api/sim", 12), ("/api/data", 6), ("/api/research", 6),
        ("/api/quant", 6), ("/api/ml", 6),
    )
    _MAX_CLIENTS = 20000        # hard cap so the bucket map cannot grow unbounded

    def __init__(self, app):
        self.app = app
        self.buckets: dict[str, list[float]] = {}  # ip -> [tokens, last_ts]

    @staticmethod
    def _client_ip(scope) -> str:
        hdrs = dict(scope.get("headers") or [])
        # Behind the CDN edge and nginx: trust the edge connecting-IP header,
        # else the first X-Forwarded-For hop, else the socket peer.
        cf = hdrs.get(b"cf-connecting-ip")
        if cf:
            return cf.decode("latin1").strip()
        xff = hdrs.get(b"x-forwarded-for")
        if xff:
            return xff.decode("latin1").split(",")[0].strip()
        client = scope.get("client")
        return client[0] if client else "unknown"

    @classmethod
    def _cost(cls, path: str) -> int:
        for prefix, c in cls._HEAVY:
            if path.startswith(prefix):
                return c
        return 1

    def _charge(self, ip: str, cost: int) -> float:
        """Deduct cost; return seconds to wait (0 if allowed)."""
        now = time.time()
        b = self.buckets.get(ip)
        if b is None:
            if len(self.buckets) >= self._MAX_CLIENTS:
                # Evict the stalest quarter rather than grow without bound.
                cutoff = now - 300
                for k in [k for k, v in self.buckets.items() if v[1] < cutoff]:
                    del self.buckets[k]
                if len(self.buckets) >= self._MAX_CLIENTS:
                    self.buckets.clear()
            b = [self.CAPACITY, now]
            self.buckets[ip] = b
        tokens, last = b
        tokens = min(self.CAPACITY, tokens + (now - last) * self.REFILL_PER_S)
        if tokens >= cost:
            b[0], b[1] = tokens - cost, now
            return 0.0
        b[0], b[1] = tokens, now
        return (cost - tokens) / self.REFILL_PER_S

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        wait = self._charge(self._client_ip(scope),
                            self._cost(scope.get("path", "")))
        if wait <= 0:
            await self.app(scope, receive, send)
            return
        retry = str(max(1, round(wait)))
        await send({"type": "http.response.start", "status": 429,
                    "headers": [(b"content-type", b"application/json"),
                                (b"retry-after", retry.encode())]})
        await send({"type": "http.response.body",
                    "body": b'{"detail":"Too many requests. Slow down and '
                            b'retry shortly."}'})


def create_app() -> FastAPI:
    reg = Registry()
    load_builtins(reg)
    load_plugins(reg)
    # Bundled Brue indicators registered at lse_terminal.indicators import
    # time (deterministic registry content); surface any load errors here.
    from lse_terminal.indicators import _BRUE_BUNDLED_ERRORS
    for _f, _err in _BRUE_BUNDLED_ERRORS.items():
        reg.plugin_errors.append(f"bundled brue indicator {_f}: {_err}")
    user_indicators = UserIndicators()
    user_indicators.load_all()
    # First run on a fresh machine: preload the bundled Gold/Apple 30m
    # samples so backtests and charts have data out of the box (no key, no
    # imports). No-op the moment a manifest exists.
    from lse_terminal.providers import userdata as _userdata
    _userdata.seed_samples()

    # Hosted mode (the site-embedded terminal): endpoints that write to the
    # host machine or execute user Python are disabled, because the server is
    # shared by every visitor instead of owned by one user. The UI hides the
    # corresponding buttons via /api/config.
    hosted = os.environ.get("LSE_TERMINAL_HOSTED") == "1"

    async def deny_hosted_ws(websocket) -> bool:
        """True when the socket was refused because this is the hosted
        instance. Websockets cannot raise HTTPException usefully, so the
        refusal is a message plus a close, matching term_pty's existing
        shape. Hosted mode must deny /api/ai/pty, /api/ai/chat and the two
        installers here: a real PTY or pip over a shared socket is a remote
        shell on the server for anyone who can reach it, and an edge proxy
        in front is not a control this app owns.
        """
        if not hosted:
            return False
        await websocket.send_json({
            "type": "error",
            "message": "Not available in the hosted terminal; "
                       "download the app from GitHub to use this."})
        await websocket.close()
        return True

    def deny_hosted():
        if hosted:
            raise HTTPException(
                403, "not available in the hosted terminal; download the app "
                     "from GitHub to use this")

    # ── "only the terminal's own window" ─────────────────────────────────
    # The engine-wide guard (_LocalOnlyGuard) lets ANY loopback origin in: it
    # compares the Origin's hostname and ignores its port. So a page served by
    # some other program on this machine (a dev server, another local app's
    # UI) can call everything here. For most routes that is a nuisance. For
    # the ones below it is not: they move money (arm, order, close, modify),
    # hold keys (credentials, account), or run a program as the user (connect
    # and probe spawn an adapter; the PTY, backtest, indicator, ML, algo and
    # tool routes run the user's code). Those ask for the engine's OWN origin.
    #
    # The rule, for a request that carries browser evidence of where it came
    # from, and only for one that does:
    # - `Origin`, when present, must be exactly `http://<Host header>`:
    #   scheme, host AND port. The terminal's page is served by this engine,
    #   so its own requests always are; another port's page never is.
    # - `Sec-Fetch-Site`, when present, must be `same-origin` (or `none`, a
    #   request the user typed). A browser that says the request crossed
    #   origins is believed.
    # A native client sends neither header and passes, exactly as it does the
    # engine-wide guard: the agent CLIs, the approval bridge, the assistant's
    # own tools (urllib) and any MCP client that is not a web page. Hosted
    # mode never reaches this: every route that uses it refuses hosted first,
    # and there the public domain is the legitimate origin anyway.
    _OWN_WINDOW = "this action is only available from the terminal's own window"

    def _from_own_window(headers) -> bool:
        host = (headers.get("host") or "").strip().lower()
        origins = headers.getlist("origin")
        if origins and (len(origins) > 1 or not host
                        or origins[0].strip().lower() != "http://" + host):
            return False
        site = (headers.get("sec-fetch-site") or "").strip().lower()
        return not site or site in ("same-origin", "none")

    def own_origin_only(request: Request):
        """Refuse an HTTP request that a browser says came from another
        origin. Called after deny_hosted() by every route named above."""
        if hosted:
            return
        if not _from_own_window(request.headers):
            raise HTTPException(403, _OWN_WINDOW)

    # ── "the terminal's own window, and nothing else" ─────────────────────
    # A broker's terms (SPEC 3.3) can keep its prices on this computer, or
    # have every order on a live account placed by the user. The terminal's
    # page shows those prices and sends those orders from the user's clicks;
    # a PROGRAM must get neither: the assistant's code, an agent's shell, an
    # MCP client, a script. _from_own_window lets every program through (it
    # sends no browser headers), so these paths ask for more: the browser has
    # to SAY the request is this origin. A browser sends Sec-Fetch-Site:
    # same-origin with every request a page makes to its own loopback origin,
    # and Origin with every websocket handshake and POST; an Origin present
    # must be exactly http://<Host>. "none" (an address typed, or opened by
    # a browser a program drives) is not the page. A program can forge these
    # headers, so this closes the door to code that simply calls the engine,
    # and says why; it is not a lock against a determined one.
    def _terminal_window(headers) -> bool:
        host = (headers.get("host") or "").strip().lower()
        origins = headers.getlist("origin")
        if origins and (len(origins) > 1 or not host
                        or origins[0].strip().lower() != "http://" + host):
            return False
        site = (headers.get("sec-fetch-site") or "").strip().lower()
        return site == "same-origin" or (not site and bool(origins))

    def _source_broker(provider) -> str | None:
        """The broker profile behind a `broker:<name>` data source."""
        p = str(provider or "")
        return p[len("broker:"):] if p.startswith("broker:") else None

    def _local_refusal(broker: str | None, what: str = "") -> str | None:
        """The sentence a request for this broker's market data is refused
        with when its terms keep the data on this computer, else None."""
        if not broker:
            return None
        try:
            if not hub.data_local(broker):
                return None
            return hub.withheld(broker, what)
        except Exception:  # noqa: BLE001 - cannot tell: refuse, and say so
            return ("Withheld: this broker's terms could not be read, so its "
                    "prices stay on this computer.")

    def local_data_only(request_or_ws, broker: str | None, what: str = ""):
        """Refuse a program's request for a data_local_only connection's
        market data (403, the sentence). The terminal's own window passes,
        as does every request about a connection without such terms."""
        why = _local_refusal(broker, what)
        if why and not _terminal_window(request_or_ws.headers):
            raise HTTPException(403, why)

    def by_hand_only(request: Request, broker: str):
        """Refuse a mutating call to an orders_by_hand_only connection that
        is not paper unless the terminal's own window sent it: the ticket,
        the dock and the chart are the user's own action for that order; a
        program is not (SPEC 3.3)."""
        try:
            hand = hub.by_hand(broker)
        except Exception:  # noqa: BLE001 - unreadable: the careful answer
            hand = True
        if hand and not _terminal_window(request.headers):
            raise HTTPException(403, hub.by_hand_refusal(broker))

    async def deny_other_origin_ws(websocket) -> bool:
        """The same rule for an accepted websocket: True when it was refused
        (a message, then a close), in the shape deny_hosted_ws uses. Browsers
        stamp Origin on every websocket handshake, the page's own included,
        so for a socket this is an exact check, not a best-effort one."""
        if hosted or _from_own_window(websocket.headers):
            return False
        await websocket.send_json({"type": "error", "message": _OWN_WINDOW})
        await websocket.close(code=4403)
        return True

    def own_window_only(request: Request, json_body: bool = True):
        """The guard for the routes that LINK a broker: the rule above, plus
        a declared JSON body.

        Linking stores a command that is then spawned as the user, with the
        engine's environment, on the next connect, and it survives restarts.
        So on top of own_origin_only these routes require the body to be
        declared `application/json`: a page cannot send that type across
        origins without a preflight, which the engine-wide guard refuses, so
        a form or a typeless blob can never be made to look like one of these
        requests. (The older routes do not demand the type: their callers
        were written before the rule and the origin check alone closes the
        other-port hole for them.)
        """
        deny_hosted()
        own_origin_only(request)
        if json_body:
            ctype = (request.headers.get("content-type") or "")
            if ctype.split(";")[0].strip().lower() != "application/json":
                raise HTTPException(
                    415, "send this request with Content-Type: application/json")

    async def json_object(request: Request, limit: int = 65536) -> dict:
        """The request body as a JSON object, read by hand so a route's
        guard runs before anything is parsed."""
        raw = await request.body()
        if len(raw) > limit:
            raise HTTPException(413, "request body too large")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(400, "the request body is not JSON")
        if not isinstance(body, dict):
            raise HTTPException(400, "the request body must be a JSON object")
        return body

    app = FastAPI(title="LSE Terminal", version=__version__)
    if not hosted:
        app.add_middleware(_LocalOnlyGuard)
    else:
        # Public embed: no login by design, so a per-client
        # rate budget is what stops anyone hammering data, sim or uploads.
        app.add_middleware(_HostedRateLimit)

    @app.middleware("http")
    async def no_stale_ui(request, call_next):
        # Everything is served from the user's own machine; caching only
        # creates "old UI after update" bugs (seen in the wild on the
        # desktop app). Cost of no-store on localhost is zero.
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response
    app.state.registry = reg
    app.state.user_indicators = user_indicators

    @app.get("/api/health")
    def health():
        # ui_version: newest mtime of the served UI CODE. The page polls it
        # and reloads itself when it changes, so a dev sync (or an update
        # installed while running) shows up live without a manual refresh.
        # assets/ is excluded because it is a CONTENT directory, not code:
        # news refreshes rewrite assets/news/ file by file, and with those
        # files counted the open terminal reloaded itself once per file,
        # throwing away the charted pair, timeframe and scroll position each
        # time. Content lands through its own fetches; only a code change
        # justifies a reload.
        try:
            ui_version = max(
                int(f.stat().st_mtime) for f in _STATIC.rglob("*")
                if f.is_file() and not f.is_relative_to(_STATIC / "assets")
            )
        except ValueError:
            ui_version = 0
        return {"ok": True, "version": __version__, "ui_version": ui_version,
                "dev": os.environ.get("LSE_TERMINAL_DEV") == "1"}

    @app.get("/api/providers")
    def providers():
        # LSE-shipped data connections are gated by the remote directory
        # (fleet decides who is listed, whatever version the app is);
        # the user's own sources (custom keys, userdata) never are.
        # No directory (offline, first boot) fails open to everything.
        d = getattr(app.state, "directory_state", {}).get("d")
        allowed = ({p["key"] for p in d.get("providers", []) if p.get("key")}
                   if d else None)
        out = []
        for p in reg.all():
            # A connected broker is the user's own connection, not something
            # the fleet directory lists as a data vendor, so it is never
            # filtered by the allowlist.
            own = (bool(getattr(p, "is_custom", False)) or p.name == "userdata"
                   or bool(getattr(p, "is_broker", False)))
            if allowed is not None and not own and p.name not in allowed:
                continue
            out.append(
                {"name": p.name, "title": p.title, "timeframes": p.timeframes,
                 "capabilities": sorted(p.capabilities()), "configured": p.configured(),
                 # Custom = user-configured live source; the MARKETS sidebar
                 # shows these as their own folders next to LSE.
                 "custom": bool(getattr(p, "is_custom", False)),
                 # A live execution venue driving the markets page. The UI
                 # treats it as a live source but keeps research off it.
                 "broker": bool(getattr(p, "is_broker", False))})
        return out

    @app.get("/api/directory")
    def directory():
        # The connection screen decorates each broker with the fleet
        # directory's metadata: logo, tagline, partner flag, instrument count,
        # and the fields to collect before connecting. The hub owns ONE fetch
        # path (fetch_directory: network, fail-open to the disk cache); a 6h
        # background loop keeps the copy warm, and opening this screen
        # refreshes it when older than a minute so a newly listed broker
        # appears the moment anyone looks, not up to
        # six hours later. Offline stays fine: the same fetch falls back to
        # the last good copy.
        from urllib.parse import urlsplit  # noqa: PLC0415
        from .broker_hub import DIRECTORY_URL  # noqa: PLC0415
        st = getattr(app.state, "directory_state", {})
        refresh = getattr(app.state, "directory_refresh", None)
        lock = st.get("lock")
        if (refresh and lock and time.time() - st.get("at", 0) > 60
                and lock.acquire(blocking=False)):
            try:
                refresh()
            finally:
                lock.release()
        d = st.get("d") or {}
        # logo_url in the listing is a PATH (/sim/logo/<key>); the browser
        # needs the origin the directory was served from to load it as an
        # <img> src, so it is derived once here rather than hardcoded in the UI.
        u = urlsplit(DIRECTORY_URL)
        origin = f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else ""
        return {"v": d.get("v"), "origin": origin,
                "brokers": d.get("brokers", []),
                "providers": d.get("providers", [])}

    @app.get("/api/instruments")
    def instruments(provider: str, query: str = "", limit: int = 50,
                    all_current: bool = False):
        # Full discovery is explicit and limited to the LSE sidebar. Search
        # and other providers keep their existing bounded request contract.
        if all_current and (provider != "lse" or query.strip()):
            raise HTTPException(400, "all_current requires LSE and an empty query")
        try:
            source = reg.get(provider)
            items = source.search(
                query, limit=None if all_current else min(int(limit), 5000))
        except ValueError as e:
            raise HTTPException(404, str(e))
        except Exception as e:
            raise HTTPException(502, f"search failed: {e}")
        # live=False marks catalog rows that exist only as history datasets
        # (no live feed, so no price board row and no stream). Providers that
        # predate the flag never set it and default to live.
        rows = [{"symbol": i.symbol, "name": i.name, "category": i.category,
                 "live": bool(i.meta.get("live", True))}
                for i in items]
        # A source that declares how many decimals it quotes an instrument to
        # (a connected broker's catalog does) says so on the row; the page
        # prints that source's prices from it. Sources that declare none keep
        # the four keys every client already reads.
        for row, i in zip(rows, items):
            digits = i.meta.get("digits")
            if isinstance(digits, int) and not isinstance(digits, bool) \
                    and 0 <= digits <= 20:
                row["digits"] = digits
        # A bounded page of a bigger catalog must be able to say so. A source
        # that can count (a connected broker) reports how many instruments it
        # holds in a header, so the list itself keeps the shape every client
        # already reads. Decoration: a count that fails costs only the count.
        count = getattr(source, "total", None)
        if callable(count) and not query.strip():
            try:
                total = int(count(""))
            except Exception:  # noqa: BLE001
                total = None
            if total is not None:
                from fastapi.responses import JSONResponse  # noqa: PLC0415
                return JSONResponse(rows,
                                    headers={"X-Total-Count": str(total)})
        return rows

    @app.get("/api/indicators")
    def indicators():
        return [
            {"name": s.name, "title": s.title, "overlay": s.overlay,
             "params": s.params, "styles": s.styles}
            for s in all_specs()
        ]

    def _prices_terms(provider: str, request: Request):
        # A broker whose terms keep its prices on this computer answers its
        # own window only (SPEC 3.3), never a program that could hand them on.
        # A dependency of the route rather than a line in it, so the route
        # itself reads as it always did.
        local_data_only(request, _source_broker(provider), "Prices")

    @app.get("/api/prices", dependencies=[Depends(_prices_terms)])
    def prices(provider: str, symbols: str):
        """Latest price/bid/ask for up to 50 symbols from the platform price
        board (/v1/prices). The watchlist uses a shared three-second budget instead of
        holding websocket subscriptions per row (plan cap: 16 concurrent)."""
        try:
            p = reg.get(provider)
        except ValueError as e:
            raise HTTPException(404, str(e))
        fn = getattr(p, "prices", None)
        if fn is None:
            raise HTTPException(404, f"{provider} has no price board")
        syms = [s for s in symbols.split(",") if s.strip()][:50]
        if not syms:
            return []
        try:
            return fn(syms)
        except Exception as e:
            import urllib.error
            if isinstance(e, urllib.error.HTTPError) and e.code == 429:
                # Preserve the quota contract instead of disguising it as an
                # upstream outage. Consume the complete refusal before closing.
                try:
                    e.read()
                finally:
                    e.close()
                try:
                    retry = max(3, min(120, math.ceil(float(e.headers.get("Retry-After", "60")))))
                except (TypeError, ValueError, OverflowError):
                    retry = 60
                raise HTTPException(429, "Price request limit reached", headers={"Retry-After": str(retry)})
            raise HTTPException(502, f"prices failed: {e}")

    @app.get("/api/screener")
    def screener(provider: str = "lse"):
        """The full screener snapshot (rows + column manifest) from the
        provider's screener(). Optional capability like logos(): providers
        without one 404 and the UI shows its connect/unsupported hint. The
        provider caches with ETag so the UI can poll this freely."""
        try:
            p = reg.get(provider)
        except ValueError as e:
            raise HTTPException(404, str(e))
        fn = getattr(p, "screener", None)
        if fn is None:
            raise HTTPException(404, f"{provider} has no screener feed")
        try:
            return fn()
        except RuntimeError as e:
            # Unconfigured key: same 409 contract as the options routes so
            # the page renders the connect hint instead of an error.
            raise HTTPException(409, str(e))
        except Exception as e:
            raise HTTPException(502, f"screener failed: {e}")

    @app.get("/api/logos")
    def logos(provider: str):
        """Symbol -> {light, dark} logo URL map for the watchlist. Optional
        capability: providers without a logos() (user data, custom vendors)
        just get an empty map, which the UI renders as monogram tiles."""
        try:
            p = reg.get(provider)
        except ValueError as e:
            raise HTTPException(404, str(e))
        fn = getattr(p, "logos", None)
        if fn is None:
            return {}
        try:
            return fn()
        except Exception:
            # Logos are decoration; a fetch hiccup must never error the UI.
            return {}

    @app.get("/api/candles")
    def candles(provider: str, symbol: str, request: Request,
                timeframe: str = "1h",
                limit: int = 5000, indicators: str = "",
                start: str | None = None, end: str | None = None):
        # The chart's own fetch passes; a program asking for a
        # data_local_only broker's bars is told why it gets none.
        local_data_only(request, _source_broker(provider),
                        f"{str(symbol)[:40]} candles")
        # start/end, ISO 8601 or epoch seconds, read once here and handed to
        # every source as the same ISO time, the form the provider contract
        # names (the manual-backtest replay needs "history up to the session
        # start" and windowed scrollback, not just "latest N"). Anything else
        # is a 400 that names the forms taken.
        from .broker_hub import window_iso, window_seconds  # noqa: PLC0415
        try:
            start = window_iso(window_seconds(start, "start"))
            end = window_iso(window_seconds(end, "end"))
        except ValueError as e:
            raise HTTPException(400, str(e))
        try:
            p = reg.get(provider)
            df = p.candles(symbol, timeframe, limit=min(int(limit), 5000),
                           start=start, end=end)
        except ValueError as e:
            raise HTTPException(404, str(e))
        except Exception as e:
            raise HTTPException(502, f"candles failed: {_said(_source_broker(provider), e)}")

        # Indicator maths runs on the USER'S machine, never ours.
        #
        # On a downloaded terminal this endpoint IS the user's machine, so
        # Python indicators cost them nothing but their own CPU. In hosted mode
        # the engine is a shared server, and computing indicators there would
        # put every visitor's indicator load on our hardware. So hosted mode
        # simply does not compute them: the chart carries its own indicator
        # library and evaluates it in the browser, which is the visitor's CPU
        # either way. Nothing is lost on screen, and the cost stays with the
        # person asking for the work.
        if hosted and indicators:
            indicators = ""

        out = {
            "provider": provider, "symbol": symbol, "timeframe": timeframe,
            # Explicit int ts: .values.tolist() would upcast the whole frame
            # to float64 and ship epoch seconds as floats.
            "candles": [[int(r.ts), r.open, r.high, r.low, r.close, r.volume]
                        for r in df.itertuples(index=False)],
            "indicators": {},
        }
        for name, params in _parse_indicators(indicators):
            try:
                frame = compute(name, df, **params)
            except (KeyError, ValueError, TypeError) as e:
                raise HTTPException(400, str(e))
            label = name if not params else \
                name + "(" + ";".join(f"{k}={v}" for k, v in params.items()) + ")"
            spec = next(s for s in all_specs() if s.name == name)
            series_out = {}
            for col in frame.columns:
                pts = [
                    [int(t), float(v)]
                    for t, v in zip(df["ts"], frame[col])
                    if v is not None and not (isinstance(v, float) and math.isnan(v))
                ]
                series_out[col] = {
                    "kind": spec.styles.get(col, {}).get("kind", "line"),
                    "points": pts,
                }
            out["indicators"][label] = {"overlay": spec.overlay,
                                        "series": series_out}
        return out

    @app.get("/api/user-indicators")
    def user_ind_list():
        return user_indicators.listing()

    @app.get("/api/user-indicators/template")
    def user_ind_template(lang: str = "python"):
        if lang == "brue":
            from lse_terminal.engine.brue_indicators import BRUE_TEMPLATE
            return {"source": BRUE_TEMPLATE}
        return {"source": TEMPLATE}

    @app.post("/api/user-indicators/preview")
    def user_ind_preview(body: PreviewIn, request: Request):
        """Run a DRAFT indicator source over real candles for the editor's
        live preview, without saving and without touching the picker.

        The draft registers into the global REGISTRY while it execs (that is
        what @indicator does), so the registry is snapshotted and restored
        BEFORE any maths runs; computation happens on the captured spec
        objects directly. Errors come back in-band (HTTP 200 with an error
        field): a half-typed file erroring is the normal case here, not an
        exceptional one, and the editor shows it inline while keeping the
        last good drawing on screen."""
        deny_hosted()
        own_origin_only(request)
        # The preview answers with the candles themselves.
        local_data_only(request, _source_broker(body.provider),
                        f"{str(body.symbol)[:40]} candles")
        try:
            p = reg.get(body.provider)
            df = p.candles(body.symbol, body.timeframe,
                           limit=max(50, min(int(body.limit), 1000)))
        except ValueError as e:
            raise HTTPException(404, str(e))
        except Exception as e:
            raise HTTPException(502, "candles failed: "
                                + _said(_source_broker(body.provider), e))
        if df is None or not len(df):
            return {"error": "no candles for this symbol", "candles": [],
                    "indicators": {}}

        from lse_terminal.contracts.indicator import REGISTRY
        before = dict(REGISTRY)
        try:
            from lse_terminal.engine.user_indicators import BRUE_EXTS
            if body.filename.endswith(BRUE_EXTS):
                from lse_terminal.engine import brue_indicators
                brue_indicators.register_brue_source("_preview", body.source)
            else:
                module = types.ModuleType("lse_terminal_user._preview")
                exec(compile(body.source, "<preview>", "exec"), module.__dict__)
            specs = [REGISTRY[n] for n in set(REGISTRY) - set(before)]
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}", "candles": [],
                    "indicators": {}}
        finally:
            REGISTRY.clear()
            REGISTRY.update(before)

        out = {
            "error": None,
            "candles": [[int(r.ts), r.open, r.high, r.low, r.close, r.volume]
                        for r in df.itertuples(index=False)],
            "indicators": {},
        }
        if not specs:
            out["error"] = "no @indicator function in this file yet"
            return out
        for spec in sorted(specs, key=lambda s: s.name):
            kwargs = {k: v.get("default") for k, v in spec.params.items()
                      if v.get("default") is not None}
            try:
                frame = spec.fn(df, **kwargs)
                if isinstance(frame, pd.Series):
                    frame = frame.to_frame(name=spec.name)
                if not isinstance(frame, pd.DataFrame):
                    raise TypeError(
                        f"returned {type(frame).__name__}, expected Series "
                        "or DataFrame")
                if len(frame) != len(df):
                    raise ValueError(
                        f"returned {len(frame)} rows for {len(df)} bars")
            except Exception as e:
                out["error"] = f"{spec.name}: {type(e).__name__}: {e}"
                continue
            series_out = {}
            for col in frame.columns:
                pts = [
                    [int(t), float(v)]
                    for t, v in zip(df["ts"], frame[col])
                    if v is not None and not (isinstance(v, float) and math.isnan(v))
                ]
                series_out[str(col)] = {
                    "kind": spec.styles.get(col, {}).get("kind", "line"),
                    "points": pts,
                }
            out["indicators"][spec.name] = {"overlay": spec.overlay,
                                            "series": series_out}
        return out

    @app.get("/api/user-indicators/{filename}")
    def user_ind_read(filename: str):
        source = user_indicators.read(filename)
        if source is None:
            raise HTTPException(404, f"no such indicator file: {filename}")
        return {"file": filename, "source": source}

    @app.post("/api/user-indicators/{filename}")
    def user_ind_save(filename: str, body: SourceIn, request: Request):
        deny_hosted()
        own_origin_only(request)
        error = user_indicators.save(filename, body.source)
        return {"ok": error is None, "file": filename, "error": error,
                "names": user_indicators.file_names.get(filename, [])}

    @app.delete("/api/user-indicators/{filename}")
    def user_ind_delete(filename: str):
        deny_hosted()
        user_indicators.delete(filename)
        return {"ok": True}

    @app.get("/api/backtest/engines")
    def backtest_engines():
        return [{"name": e.name, "title": e.title, "language": e.language,
                 "configured": e.configured()} for e in reg.engines()]

    @app.get("/api/backtest/template")
    def backtest_template(engine: str = "python"):
        try:
            return {"template": reg.engine(engine).template()}
        except ValueError as e:
            raise HTTPException(404, str(e))

    def _resolve_datasets(names: list[str]) -> dict:
        """Attached user datasets -> {use_name: engine-ready file path}."""
        from lse_terminal.providers import userdata
        out: dict = {}
        for n in names:
            path = userdata.dataset_path(n)
            if path is None or not path.exists():
                raise HTTPException(404, f"no dataset named {n}")
            # Both spellings: the symbol as the user typed it, and the old
            # slug. The slug existed because Brue `use` names had to be bare
            # identifiers; strategies are plain Python now and reach these
            # through a dict, where data["ALT:SENT"] is the obvious key, so
            # the slug stays only so older scripts keep working.
            out[n] = str(path)
            out[userdata._slug(n).lower()] = str(path)
        # The whole library rides along implicitly, CANDLE datasets included:
        # a fresh install must run the seeded starters on the first
        # click, curve_regime_overlay reads the bundled
        # USYIELDS curve which no new user knows to attach, and cross-asset
        # strategies (pair/ratio scripts the AI assistant writes) read a
        # second candle set via data["NAS100"]; the old series-only filter
        # made every such read a KeyError while the files sat in MY DATA
        # (found via the assistant's NAS100/SPX500 strategy). Paths
        # only: the engine loads a file the moment a strategy reads its
        # name, so datasets a script never touches cost the run nothing.
        for sym in userdata.load_manifest():
            if sym in out:
                continue
            path = userdata.dataset_path(sym)
            if path is None or not path.exists():
                continue
            out[sym] = str(path)
            out.setdefault(userdata._slug(sym).lower(), str(path))
        return out

    def _backtest_candles(provider, body):
        """Load the bars a backtest runs on. Local files load whole (limit 0
        is the default: the user's own history is the point, and the engine
        applies the from/to window itself, including the one bar past `to`
        it needs to flatten an open trade). A positive limit caps the load.
        Remote providers keep a 100k ceiling, and get the window passed
        down so a range older than the newest bars is served instead of
        being cut off by the cap (the old 2000-bar default loaded the newest
        bars, then found nothing inside an older window)."""
        if body.provider == "lse" and body.timeframe == "tick":
            raise ValueError("LSE tick charts are live only; choose a candle timeframe for backtesting")
        from lse_terminal.backtest.runner import _parse_when
        import datetime as _dt
        opts = body.options or {}
        lim = int(body.limit or 0)
        local = body.provider == "userdata"
        if lim <= 0:
            lim = 0 if local else 100_000
        else:
            lim = min(lim, 1_000_000)
        start = end = None
        if not local:
            def iso(v, pad=0):
                t = _parse_when(v)
                return None if t is None else _dt.datetime.fromtimestamp(t + pad, _dt.timezone.utc).isoformat()
            start = iso(opts.get("from"))
            end = iso(opts.get("to"), pad=7 * 86400)  # room for the flatten bar
        return provider.candles(body.symbol, body.timeframe, limit=lim,
                                start=start, end=end)

    @app.post("/api/backtest")
    def backtest(body: BacktestIn, request: Request):
        # Executes user Python in-process: never on a shared host.
        deny_hosted()
        own_origin_only(request)
        # On a data_local_only broker's bars the user's own backtest runs
        # from the terminal's window; its trades carry the broker's prices,
        # so a program does not get them.
        local_data_only(request, _source_broker(body.provider),
                        f"Backtest results on {str(body.symbol)[:40]}")
        from lse_terminal.backtest.contract import BacktestError
        try:
            engine = reg.engine(body.engine)
            provider = reg.get(body.provider)
        except ValueError as e:
            raise HTTPException(404, str(e))
        try:
            candles = _backtest_candles(provider, body)
        except Exception as e:
            raise HTTPException(502, "candles failed: "
                                + _said(_source_broker(body.provider), e))
        try:
            result = engine.run(body.script, candles, body.symbol, body.timeframe,
                                options=body.options,
                                data_files=_resolve_datasets(body.datasets))
        except BacktestError as e:
            raise HTTPException(400, str(e))
        return result.to_json()

    def _quant_mode(body, method: str, **kwargs):
        """Shared plumbing for the engine's quant modes (MC, walk-forward)."""
        from lse_terminal.backtest.contract import BacktestError
        try:
            engine = reg.engine(body.engine)
            provider = reg.get(body.provider)
        except ValueError as e:
            raise HTTPException(404, str(e))
        fn = getattr(engine, method, None)
        if fn is None:
            raise HTTPException(400, f"engine {body.engine} does not support {method}")
        try:
            # Same ceiling as /api/backtest: a
            # walk-forward or Monte Carlo capped at 5000 bars validated a
            # 50k-bar strategy against its last few months (4 folds of ~375
            # hourly bars, 5-9 trades each), which is no validation at all.
            candles = _backtest_candles(provider, body)
        except Exception as e:
            raise HTTPException(502, "candles failed: "
                                + _said(_source_broker(body.provider), e))
        try:
            return fn(body.script, candles, options=body.options,
                      data_files=_resolve_datasets(body.datasets), **kwargs)
        except BacktestError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/backtest/montecarlo")
    def backtest_montecarlo(body: MonteCarloIn, request: Request):
        # Executes user Python in-process: never on a shared host.
        deny_hosted()
        own_origin_only(request)
        local_data_only(request, _source_broker(body.provider),
                        f"Monte Carlo results on {str(body.symbol)[:40]}")
        return _quant_mode(body, "montecarlo",
                           runs=max(1, min(body.runs, 100_000)), seed=body.seed)

    @app.post("/api/backtest/walkforward")
    def backtest_walkforward(body: WalkForwardIn, request: Request):
        # Executes user Python in-process: never on a shared host.
        deny_hosted()
        own_origin_only(request)
        local_data_only(request, _source_broker(body.provider),
                        f"Walk-forward results on {str(body.symbol)[:40]}")
        if not body.params:
            raise HTTPException(400, "walkforward needs at least one param grid")
        return _quant_mode(body, "walkforward", params=body.params,
                           folds=body.folds, train=body.train, metric=body.metric)

    # ── Economic calendar: LSE macro-event feed ───────────────────────

    # Filter flips in the calendar UI re-request the same windows over and
    # over; a short TTL cache keeps that snappy and spares the remote API.
    # Bounded so an event-history browse (one entry per event) can't grow it
    # without limit.
    econ_cache: dict[tuple, tuple[float, list]] = {}

    @app.get("/api/economic-calendar")
    def economic_calendar(region: str = "", event: str = "",
                          start: str | None = None, end: str | None = None,
                          released: int = 0, order: str = "asc",
                          limit: int = 5000):
        try:
            p = reg.get("lse")
        except ValueError:
            raise HTTPException(404, "LSE provider not available")
        if not p.configured():
            # 409 (not 502): the terminal works, the user just hasn't linked
            # a key. The calendar page shows its "connect a key" state on this.
            raise HTTPException(409, "LSE API key not set. Add your free key "
                                     "to load the economic calendar.")
        key = (region, event, start, end, bool(released), order,
               min(int(limit), 5000))
        hit = econ_cache.get(key)
        if hit and time.time() - hit[0] < 60:
            return hit[1]
        try:
            regions = [r.strip() for r in region.split(",") if r.strip()]
            rows = p.economic_calendar(region=regions or None,
                                       event=event or None, start=start,
                                       end=end, released_only=bool(released),
                                       order=order, limit=min(int(limit), 5000))
        except Exception as e:
            raise HTTPException(502, f"economic calendar failed: {e}")
        if len(econ_cache) >= 64:
            del econ_cache[min(econ_cache, key=lambda k: econ_cache[k][0])]
        econ_cache[key] = (time.time(), rows)
        return rows

    # ── ECONOMIC > Indicators / Bond yields / Central banks ───────────
    # The three views past the calendar all read the same two macro datasets
    # (economics series + government yield curves), so they share one catalog
    # and one series proxy. Key-gated like the calendar: 409 means "connect a
    # key", which the page renders as a hint rather than a broken table.

    # The catalog is a snapshot the vault rebuilds on its own schedule, not a
    # live quote, so it caches for an hour; without that every view switch
    # re-pulls ~15k rows from the API for an answer that cannot have changed.
    macro_cat_cache: dict[str, tuple[float, list]] = {}
    macro_series_cache: dict[tuple, tuple[float, list]] = {}

    def _lse_for_macro():
        try:
            p = reg.get("lse")
        except ValueError:
            raise HTTPException(404, "LSE provider not available")
        if not p.configured():
            raise HTTPException(409, "LSE API key not set. Add your free key "
                                     "to load macro data.")
        return p

    @app.get("/api/macro/catalog")
    def macro_catalog():
        p = _lse_for_macro()
        hit = macro_cat_cache.get("all")
        # 60s, not an hour: a dataset added on the fleet shows on next open.
        if hit and time.time() - hit[0] < 60:
            return hit[1]
        try:
            rows = p.macro_catalog()
        except Exception as e:
            raise HTTPException(502, f"macro catalog failed: {e}")
        macro_cat_cache["all"] = (time.time(), rows)
        return rows

    @app.get("/api/macro/series")
    def macro_series(symbol: str, dataset: str = "", start: str | None = None,
                     end: str | None = None, order: str = "asc",
                     limit: int = 5000):
        p = _lse_for_macro()
        key = (symbol, dataset, start, end, order, min(int(limit), 5000))
        hit = macro_series_cache.get(key)
        # 10 min: macro series print daily at best (most are monthly), and the
        # yield-curve view re-requests the same tenors every time a country is
        # reselected.
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        try:
            rows = p.macro_series(symbol, dataset=dataset or None, start=start,
                                  end=end, order=order,
                                  limit=min(int(limit), 5000))
        except Exception as e:
            raise HTTPException(502, f"macro series failed: {e}")
        # Bounded like econ_cache, but wider: one country's yield curve alone
        # opens ~15 entries and a browse walks through many indicators.
        if len(macro_series_cache) >= 256:
            del macro_series_cache[min(macro_series_cache,
                                       key=lambda k: macro_series_cache[k][0])]
        macro_series_cache[key] = (time.time(), rows)
        return rows

    # ── MARKETS > Options: chain + flow tape, LSE-key gated like the
    #    economic calendar (409 = "connect a key", rendered as a hint by the
    #    page, never a broken table). Same small TTL cache shape as
    #    econ_cache: the vault refreshes the chain continuously, so a
    #    per-click fetch would hammer the API for identical rows.
    opt_cache: dict[tuple, tuple[float, list]] = {}

    def _lse_for_options():
        try:
            p = reg.get("lse")
        except ValueError:
            raise HTTPException(404, "LSE provider not available")
        if not p.configured():
            raise HTTPException(409, "LSE API key not set. Add your free key "
                                     "under MARKETS to load options data.")
        return p

    def _opt_cached(key: tuple, ttl: float, fetch):
        hit = opt_cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        try:
            rows = fetch()
        except Exception as e:
            raise HTTPException(502, f"options request failed: {e}")
        if len(opt_cache) >= 64:
            del opt_cache[min(opt_cache, key=lambda k: opt_cache[k][0])]
        opt_cache[key] = (time.time(), rows)
        return rows

    @app.get("/api/options/underlyings")
    def options_underlyings():
        p = _lse_for_options()
        # 1h TTL: the optionable-name list moves on listings, not on ticks.
        # 60s, not an hour: a newly optionable symbol shows on next open.
        return _opt_cached(("und",), 60, p.options_underlyings)

    @app.get("/api/options/chain")
    def options_chain(underlying: str, type: str = "", expiry: str = "",
                      limit: int = 5000):
        p = _lse_for_options()
        lim = min(int(limit), 5000)
        # 15s, matching the flow tape: the vault refreshes the chain every
        # minute, but a 30s cache on top of the client's 30s poll made the
        # board feel dead next to the ticking trade dock.
        key = ("chain", underlying.strip().upper(), type, expiry, lim)
        return _opt_cached(key, 15, lambda: p.option_chain(
            underlying.strip(), type=type or None, expiry=expiry or None,
            limit=lim))

    @app.get("/api/options/flow")
    def options_flow(underlying: str = "", type: str = "",
                     min_premium: float = 0, limit: int = 300):
        p = _lse_for_options()
        lim = min(int(limit), 1000)
        key = ("flow", underlying.strip().upper(), type, float(min_premium), lim)
        return _opt_cached(key, 15, lambda: p.options_flow(
            underlying=underlying.strip() or None, type=type or None,
            min_premium=min_premium or None, limit=lim))

    # ── Level 3 (MBO) data: internal keys only ────────────────────────
    #
    # The vault's /mbo/* door serves the order-by-order futures capture and
    # is gated by a server-side entitlement, so for almost every key
    # /api/mbo/status simply reports available:false and the UI never shows
    # the button. The engine proxies (key never in the browser, same rule as
    # the sim ticket) and maps chart symbols to the live front-month contract:
    # spot canonicals (XAU/USD) and the .F futures pairs (ES.F) both resolve.

    _MBO_VAULT = "https://api.londonstrategicedge.com/vault"
    mbo_cache: dict = {}

    def _mbo_key() -> str | None:
        from lse_terminal.engine.config import get_lse_api_key
        return get_lse_api_key()

    def _mbo_get(path: str, params: dict) -> dict:
        import json as _json
        import urllib.parse as _up
        import urllib.request as _rq
        key = _mbo_key()
        if not key:
            raise HTTPException(401, "no LSE API key configured")
        # Default Python-urllib UA is 403'd at the edge WAF (same reason every
        # other outbound call in this file names the terminal); keep parity.
        req = _rq.Request(_MBO_VAULT + path + "?" + _up.urlencode(params),
                          headers={"x-api-key": key,
                                   "User-Agent": f"lse-terminal/{__version__}"})
        try:
            with _rq.urlopen(req, timeout=20) as r:
                return _json.loads(r.read())
        except Exception as e:
            code = getattr(e, "code", 502)
            if code == 410:
                # Consume the retirement response before caching unavailable.
                with e:
                    e.read()
            raise HTTPException(code if code in (401, 403, 410, 429) else 502,
                                f"mbo request failed: {e}")

    @app.get("/api/mbo/status")
    def mbo_status():
        """{available, symbols:{chart symbol -> contract code}}. 10 min TTL
        both ways: entitlement changes on a plan flip, contracts on a roll."""
        hit = mbo_cache.get("status")
        if hit and time.time() - hit[0] < 600:
            return hit[1]
        try:
            rows = _mbo_get("/mbo/contracts", {}).get("contracts", [])
            symbols: dict[str, str] = {}
            for c in rows:
                if c.get("canonical_symbol"):
                    symbols[c["canonical_symbol"]] = c["active_contract"]
                symbols[c["root"] + ".F"] = c["active_contract"]
            out = {"available": True, "symbols": symbols}
        except HTTPException as e:
            if e.status_code not in (401, 403, 410):
                raise
            out = {"available": False, "symbols": {}}
        mbo_cache["status"] = (time.time(), out)
        return out

    @app.get("/api/mbo/events")
    def mbo_events(symbol: str, seconds: float = 4, limit: int = 5000):
        """The last <seconds> of order-by-order events for a charted symbol.
        No cache: each poll is a fresh sliding window."""
        st = mbo_status()
        contract = st["symbols"].get(symbol.strip().upper())
        if not st["available"] or not contract:
            raise HTTPException(404, f"no MBO stream for {symbol}")
        from datetime import datetime, timedelta, timezone
        secs = min(max(float(seconds), 1.0), 60.0)
        # The recorder flushes to the DB in batches: event-time visibility lag
        # measured 1-5s, so a window ending at now() is randomly
        # empty. Serve a window shifted back past the flush cycle instead; the
        # rail is a ~5s-delayed view, which the poll cadence already implies.
        end = datetime.now(timezone.utc) - timedelta(seconds=5)
        body = _mbo_get("/mbo/events", {
            "symbol": contract,
            "start": (end - timedelta(seconds=secs)).isoformat(),
            "end": end.isoformat(),
            "limit": min(int(limit), 20000),
        })
        body["contract"] = contract
        return body

    # ── AI panel: the user's own Claude Code in a PTY ─────────────────
    #
    # The terminal never ships or proxies an AI. It spawns the CLAUDE CODE
    # the user installed themselves, signed in with their own subscription,
    # inside a workspace folder that mirrors the strategy open in the editor.
    # Their machine, their account, their cost. Everything here is local-only
    # (deny_hosted): a PTY endpoint on a shared host would be a remote shell.

    ai_dir = cfg.config_dir() / "ai-workspace"

    # ── the broker's terms in what the agents are given (SPEC 3.3) ────────
    # The page sends the account and the screen map as data every turn. For a
    # connection whose broker keeps its prices on this computer, its market
    # data is taken out here, before anything is written where an agent reads,
    # and the sentence saying why goes in its place: never a silent gap. The
    # page does the same before it builds the hosted assistant's context; this
    # is the engine's own copy of the rule, for the files.
    # What stays of an account and its positions: the account's own records
    # (SPEC 3.3), by the protocol's names and the page's (sl_price, tp_price,
    # name, leverage, starting_balance). Every other field is set to null:
    # the prices, and every figure marked to them (a position's unrealised
    # P/L, the account's equity, open P/L and margin), which with the size
    # and the entry price give the price back. A field the page adds later
    # is withheld until it is named here.
    from .broker_hub import (ACCOUNT_RECORD_FIELDS, MARKED_TO_PRICE,  # noqa: PLC0415
                             POSITION_RECORD_FIELDS)
    _ACCOUNT_KEEP = ACCOUNT_RECORD_FIELDS | {"name", "leverage",
                                             "starting_balance", "positions",
                                             "broker", "error", "note"}
    _POSITION_KEEP = POSITION_RECORD_FIELDS | {"sl_price", "tp_price"}

    def _dock_broker(terminal) -> str | None:
        """Which connection the account dock shows, from the screen map:
        a profile name, "lse-hosted" for the hosted sim, None when unsaid."""
        try:
            for r in (terminal or {}).get("regions") or []:
                if isinstance(r, dict) and r.get("id") == "acct-dock":
                    b = (r.get("data") or {}).get("broker")
                    return b if isinstance(b, str) and b else None
        except Exception:  # noqa: BLE001 - a malformed map says nothing
            pass
        return None

    # What a position says when its stop's level is held back: the broker
    # moves a trailed stop from the price, and a null stop reads as none.
    TRAILED_STOP = "The level of a stop the broker trails"

    def _withhold_account(acct, why: str, trail_why: str | None = None):
        if not isinstance(acct, dict):
            return acct
        out = {k: (v if k in _ACCOUNT_KEEP else None) for k, v in acct.items()}
        # Positions only as the page sent them: a failed snapshot ({error,
        # note}) stays one, not an empty book.
        if not isinstance(acct.get("positions"), list):
            if "positions" in acct:
                out["positions"] = None
            out["prices_withheld"] = why
            return out
        poss = []
        for p in acct["positions"]:
            if isinstance(p, dict):
                p = {k: (v if k in _POSITION_KEEP else None)
                     for k, v in p.items()}
                # A stop the broker trails moves with the price: its level is
                # withheld, and the position says so, since a null stop
                # otherwise reads as no stop at all. The distance stays.
                if p.get("trail_points"):
                    for k in ("sl", "sl_price"):
                        if k in p:
                            p[k] = None
                    p["withheld"] = trail_why or why
            poss.append(p)
        out["positions"] = poss
        out["prices_withheld"] = why
        return out

    def _local_live() -> list:
        """The live connections whose broker keeps its prices here."""
        return [b for b, t in hub.connected_terms() if t.get("data_local_only")]

    def _withhold_context(provider, account, terminal) -> tuple:
        """(account, terminal, sentences): the page's account and screen map
        with each data_local_only connection's market data replaced by its
        sentence, and the order door closed for an orders_by_hand_only one
        that is not paper."""
        said = []
        dock = _dock_broker(terminal)
        dock_why = hand_why = trail_why = None
        if dock is None:
            # The map cannot say which account the dock shows; while a
            # data_local_only connection is live, the careful reading is
            # that it may be that one.
            local = _local_live()
            if local:
                dock_why = hub.withheld(local[0], MARKED_TO_PRICE)
                trail_why = _withheld_words(local[0], TRAILED_STOP)
        elif dock != "lse-hosted":
            dock_why = _local_refusal(dock, MARKED_TO_PRICE)
            if dock_why:
                trail_why = _withheld_words(dock, TRAILED_STOP)
            try:
                if hub.by_hand(dock):
                    hand_why = hub.by_hand_refusal(dock)
            except Exception:  # noqa: BLE001 - unreadable: the careful answer
                hand_why = hub.by_hand_refusal(dock)
        chart_why = _local_refusal(_source_broker(provider), "Chart prices")
        if dock_why:
            account = _withhold_account(account, dock_why, trail_why)
            said.append(dock_why)
        if isinstance(terminal, dict) and (chart_why or dock_why or hand_why):
            terminal = dict(terminal)
            regions = []
            for r in terminal.get("regions") or []:
                if isinstance(r, dict):
                    r = dict(r)
                    data = r.get("data")
                    if (r.get("id") == "chart-wrap" and chart_why
                            and isinstance(data, dict)):
                        data = dict(data)
                        for k in ("last_close", "bid", "ask"):
                            if k in data:
                                data[k] = None
                        data["prices_withheld"] = chart_why
                        r["data"] = data
                    elif (r.get("id") == "acct-dock" and dock_why
                            and isinstance(data, dict)):
                        data = dict(data)
                        data["account"] = _withhold_account(
                            data.get("account"), dock_why, trail_why)
                        r["data"] = data
                    elif r.get("id") == "trade-panel" and hand_why:
                        r["more"] = [hand_why]
                regions.append(r)
            terminal["regions"] = regions
        if chart_why:
            said.append(chart_why)
        if hand_why:
            said.append(hand_why)
        return account, terminal, list(dict.fromkeys(said))

    def _screen_withheld(ctx=None) -> str | None:
        """The sentence the screenshot is withheld with, or None.

        Withheld while a live data_local_only connection's prices may be on
        screen: it is the chart's source, or the account dock's broker, or
        the last context does not say what is on screen (the shell's first
        snapshot at boot, a map that failed to build).
        """
        local = _local_live()
        if not local:
            return None
        if ctx is None:
            try:
                ctx = json.loads((ai_dir / "context.json").read_text())
            except (OSError, ValueError):
                ctx = None
        if not isinstance(ctx, dict):
            return hub.withheld(local[0], "Screenshot")
        dock = _dock_broker(ctx.get("terminal"))
        if dock is None:
            return hub.withheld(local[0], "Screenshot")
        shown = {dock, _source_broker(ctx.get("provider"))}
        for b in local:
            if b in shown:
                return hub.withheld(b, "Screenshot")
        return None

    def _drop_screenshot() -> None:
        for n in ("chart.png", "chart.png.tmp"):
            try:
                (ai_dir / n).unlink()
            except OSError:
                pass

    def _terms_brief() -> str:
        """The brief's section on the live connections' terms, or ""."""
        lines = []
        for b, t in hub.connected_terms():
            if not (t.get("data_local_only") or t.get("by_hand")):
                continue
            line = f"- {hub.terms_name(b)} (connection `{b}`): {t.get('said') or ''}"
            if t.get("data_local_only"):
                line += (" Its prices (quotes, bars, the current price of its "
                         "positions) stay on this computer, and so do the "
                         "figures worked from them (open P/L, equity, "
                         "margin): get_candles, the backtest tools and the "
                         "engine's price routes refuse them, get_positions "
                         "and context.json leave them out, and there is no "
                         "screenshot while they are on screen. Say so when "
                         "asked; do not look for another way to get them.")
            if t.get("by_hand"):
                line += (" On this live account the user places every order "
                         "in the terminal's own window (the ticket, the "
                         "positions, the chart): the engine refuses an order, "
                         "close, change or cancel that you send.")
            lines.append(line)
        if not lines:
            return ""
        return "## A broker's terms\n" + "\n".join(lines) + "\n\n"

    def _ai_write_workspace(body: AiWorkspaceIn, host: str) -> None:
        from lse_terminal.backtest.runner import TEMPLATE
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / "strategy.py").write_text(body.script or "")
        import json as _json
        account, terminal, withheld = _withhold_context(
            body.provider, body.account, body.terminal)
        shot = _screen_withheld({"provider": body.provider,
                                 "terminal": body.terminal})
        if shot:
            _drop_screenshot()
            withheld.append(shot)
        ctx_doc = {
            "engine_url": f"http://{host}",
            "provider": body.provider, "symbol": body.symbol,
            "timeframe": body.timeframe,
            "open_file": body.open_file,
            "view": body.view,
            "account": account,
            "terminal": terminal,
        }
        if withheld:
            # What was left out and why, in the broker's terms' own words.
            ctx_doc["withheld"] = withheld
        (ai_dir / "context.json").write_text(
            _json.dumps(ctx_doc, indent=2) + "\n")
        # The runner Claude uses to close its own loop: edit strategy.py,
        # run this, read the stats. Plain stdlib so it works on any Python.
        (ai_dir / "backtest.py").write_text(
            '#!/usr/bin/env python3\n'
            '"""Run strategy.py through the LSE Terminal engine and print the stats."""\n'
            'import json, sys, urllib.request\n'
            'ctx = json.load(open("context.json"))\n'
            'body = {"engine": "python", "provider": ctx["provider"],\n'
            '        "symbol": ctx["symbol"], "timeframe": ctx["timeframe"],\n'
            '        "script": open("strategy.py").read(), "limit": 2000,\n'
            '        "options": {"extended_stats": True}}\n'
            'req = urllib.request.Request(ctx["engine_url"] + "/api/backtest",\n'
            '    json.dumps(body).encode(), {"Content-Type": "application/json"})\n'
            'try:\n'
            '    r = json.load(urllib.request.urlopen(req, timeout=120))\n'
            'except urllib.error.HTTPError as e:\n'
            '    print("BACKTEST ERROR:", e.read().decode()[:2000]); sys.exit(1)\n'
            's = r.get("stats", r)\n'
            'for k in sorted(s) if isinstance(s, dict) else []:\n'
            '    print(f"{k}: {s[k]}")\n'
            'print("trades:", len(r.get("trades", [])))\n'
        )
        # Workspace-scoped permissions: inside this folder Claude may edit
        # the strategy files and run the backtest helper without prompting.
        # Nothing broader; anything else still asks the user.
        (ai_dir / ".claude").mkdir(exist_ok=True)
        (ai_dir / ".claude" / "settings.json").write_text(_json.dumps({
            "permissions": {"allow": [
                "Read", "Edit", "Write",
                "Bash(python3 backtest.py*)", "Bash(python backtest.py*)",
                # Claude Code's own web tools, allowed deliberately. Without
                # this every search raised an approval card, which in a
                # headless -p turn is a prompt the user has to clear before
                # the answer arrives; most models simply gave up and answered
                # from memory instead. Reading public web pages is the same
                # risk class as the terminal's own web_search tool, which
                # needs no card either. Search is billed to the user's own
                # agent subscription, not to us.
                "WebSearch", "WebFetch",
            ]},
        }, indent=2) + "\n")
        data_dir = cfg.config_dir() / "data"
        # The default brief the user's linked agent reads: what the app is,
        # where the user's data lives, and how to act on it. This IS the
        # product idea: they bring the model, we bring the knowledge.
        brief = (
            "# LSE Terminal: brief for the user's linked AI agent\n\n"
            "You are the user's own AI agent, linked into LSE Terminal, a\n"
            "free local backtesting terminal running on their machine.\n\n"
            "## The app\n"
            f"- Local engine at http://{host}/ (FastAPI + the app UI).\n"
            "- Tabs: MARKETS (charts), BACKTEST (strategy testing), MY DATA\n"
            "  (the user's imported datasets), ECONOMIC (macro calendar),\n"
            "  WORKSPACE (the full IDE: the same strategy folder as a file\n"
            "  tree, editor tabs, and a real Python terminal rooted there),\n"
            "  RESEARCH (papers wire + quant models), TERMINAL WALKTHROUGH\n"
            "  (the built-in user guide, top right next to MY DATA).\n"
            f"- `{ai_dir / 'GUIDE.md'}` IS that user guide: every tab,\n"
            "  feature and workflow of the terminal, written by its authors\n"
            "  (the read_guide tool returns it by section, too). Read it\n"
            "  before answering what the terminal is, what it can do, or how\n"
            "  to do something in it; it is the source of truth over the\n"
            "  one-line tab list above.\n"
            f"- Chart currently open: {body.symbol or '(none yet)'} "
            f"({body.timeframe}, provider {body.provider or 'n/a'}).\n"
            + (f"- Page the user is on right now: {body.view} (refreshed "
               "every turn in context.json).\n\n" if body.view else "\n")
            + "## The user's data (MY DATA)\n"
            f"- Imported datasets are CSVs in `{data_dir}`, indexed by\n"
            f"  `{data_dir / 'manifest.json'}` (name, kind, folder, columns).\n"
            "- kind `candles` = OHLCV, chartable. kind `series` = any\n"
            "  timestamped alternative data. Both kinds are readable inside\n"
            "  a strategy through the injected `data` dict (see the\n"
            "  strategies section).\n"
            "- You may read those files directly for analysis the terminal\n"
            "  does not do itself (correlations, distributions, joins,\n"
            "  data-quality checks) and report findings in chat.\n\n"
            "## The screen map: read this FIRST, every turn\n"
            "- `context.json` carries a `terminal` object: every region of\n"
            "  the app with its label, whether it is visible, its bounds, the\n"
            "  values it currently holds, and `more`, the tool or endpoint\n"
            "  that returns its detail. When the user asks about anything on\n"
            "  screen, find the region that owns it and read its `data`; if\n"
            "  you need more than the summary, call what `more` names. You do\n"
            "  not have to guess what exists, the map says.\n"
            "- `visible: false` WITH data means the panel exists but is\n"
            "  closed. Say that, rather than \"you do not have one\".\n"
            "- `captured_at` is when the snapshot was taken. If a question\n"
            "  turns on a fast-moving number, call the tool rather than\n"
            "  quoting the snapshot.\n\n"
            "## Account, positions and any other NUMBER\n"
            "- `context.json` carries an `account` object every turn: name,\n"
            "  balance, equity, open_pnl, leverage, and a `positions` list\n"
            "  (symbol, side, qty, avg_price, price, unrealized_pnl). Read\n"
            "  it for anything about what the user is holding, and call the\n"
            "  get_positions tool when you need it fresher than the last\n"
            "  turn. `account: null` means no sim session is open: say that,\n"
            "  do not report an empty book as \"no positions\".\n"
            "- NEVER read a number off the screenshot. Prices, quantities,\n"
            "  P&L, balances and symbols come from context.json or a tool,\n"
            "  ALWAYS. Before this rule existed, the assistant transcribed\n"
            "  the positions dock from pixels: it read\n"
            "  EUR/JPY as \"EURUSD\", 0.75 as 0.73, 186.36 as 186.30, and\n"
            "  flipped a +69.17 profit into a -77.37 loss. If the data you\n"
            "  need is not in context.json and no tool returns it, say so\n"
            "  rather than reading it off the image.\n\n"
            "## Seeing the screen\n"
            f"- `{ai_dir / 'chart.png'}` is a fresh screenshot of the\n"
            "  terminal window exactly as the user sees it, refreshed right\n"
            "  before each of your turns (desktop app only). When the user\n"
            "  asks about their chart, what is on screen, or a pattern they\n"
            "  see: Read that file FIRST and describe what is actually\n"
            "  visible. It is for SHAPE, not for numbers: what is charted,\n"
            "  the layout, which panel is open, the form of a pattern. Any\n"
            "  figure you quote must come from context.json or a tool, per\n"
            "  the section above. `[pasted image: <path>]` in a message is\n"
            "  an image the user pasted; Read that path.\n\n"
            "## Strategies + backtesting (PYTHON, the primary workflow)\n"
            f"- The user's strategy workspace is `{cfg.config_dir() / 'workspace'}`:\n"
            "  a real folder of .py files shown in the terminal's BACKTEST >\n"
            "  Algo Development IDE. Read and edit those files DIRECTLY;\n"
            "  the user sees your edits in their editor within seconds.\n"
            + (f"- OPEN IN THE EDITOR RIGHT NOW: `{body.open_file}` (relative\n"
               "  to that workspace folder). When the user says \"this\n"
               "  strategy\", \"the code on my screen\" or \"change it\", they\n"
               "  mean THAT file; edit it, never a similarly-named sibling.\n"
               if body.open_file else
               "- No strategy file is open in the editor right now; ask\n"
               "  which file they mean before editing, or check context.json\n"
               "  (open_file is refreshed every turn).\n")
            + "- A strategy is PLAIN PYTHON. There is NOTHING to import from\n"
            "  us and no base class. The candles are already in scope as\n"
            "  `df`, a pandas DataFrame with ts/open/high/low/close/volume.\n"
            "  Do the work in ordinary pandas, then leave a list called\n"
            "  `trades`, one dict per trade:\n"
            "    trades.append({\"entry_i\": 10, \"exit_i\": 25, \"dir\": \"long\"})\n"
            "  entry_i/exit_i are bar indexes; entry_ts/exit_ts in epoch\n"
            "  seconds work too. dir defaults to long. Prices default to those\n"
            "  bars\' opens; pass entry/exit to override and qty for an\n"
            "  absolute size (default is the whole account, compounding).\n"
            "  The terminal does sizing, commission, the equity curve and\n"
            "  every statistic, so never hand-roll those.\n"
            # Fill-timing house rule: without it the model
            # signalled on bar i's close and filled at bar i's open, one bar
            # of look-ahead, and shipped Sharpe 5-8 breakouts as real edges.
            "- FILL TIMING (house rule, no look-ahead): a trade fills at the\n"
            "  OPEN of bar entry_i and the OPEN of bar exit_i. A signal from\n"
            "  bar i's close (or any rolling window that includes bar i) is\n"
            "  only known once bar i has closed, so decide at i and set\n"
            "  entry_i = i + 1 and exit_i = i + 1 (loop to len(df) - 1 so\n"
            "  i + 1 exists). Filling at bar i's own open on a bar-i signal\n"
            "  is look-ahead and gives fake numbers (a plain breakout or MA\n"
            "  rule showing Sharpe 5+ or profit factor 10 is that bug, not\n"
            "  an edge; check the fill before reporting such numbers). A\n"
            "  stop or target touched INSIDE bar i may exit on bar i itself\n"
            "  with exit=<that level>. Rolling statistics stay causal: no\n"
            "  .shift(-1), no center=True, no fits on the full sample.\n"
            "- EVERY dataset in MY DATA is also in scope through `data`, a\n"
            "  lazy dict keyed by EXACT symbol: data[\"NAS100\"] is that\n"
            "  dataset as a DataFrame (candles: ts/open/high/low/close/\n"
            "  volume; series: ts + its own columns). Nothing to attach or\n"
            "  import; list_datasets returns the real symbols, use those\n"
            "  verbatim (never invent one; guard with `\"X\" in data`).\n"
            "  Timestamps are epoch seconds in `ts`; datasets differ in\n"
            "  timeframe, so align cross-asset joins on ts (merge or\n"
            "  merge_asof), never by row position.\n"
            "- A backtest TRADES only its own dataset (`df`). A cross-asset\n"
            "  strategy (pair, ratio, regime filter) must be RUN on the\n"
            "  symbol it actually trades: a NAS100/SPX500 ratio strategy\n"
            "  runs on NAS100, not on whatever chart is open. Say which\n"
            "  dataset to run it on every time you hand one over, and pass\n"
            "  that symbol yourself when you call run_backtest.\n"
            "- Pin that choice INTO the file: make its first line\n"
            "  `# run: <DATASET> <TIMEFRAME>` (e.g. `# run: EURUSD 1h`).\n"
            "  Every runner (the IDE RUN button, run_backtest,\n"
            "  run_walkforward, run_montecarlo) targets the pinned dataset\n"
            "  when no explicit symbol is passed, so the strategy reproduces\n"
            "  the same numbers wherever it is run.\n"
            "- Line two is `# name: <short_snake_case_name>` (e.g.\n"
            "  `# name: usdjpy_sma_trend`): chat strategies are filed in\n"
            "  the workspace under this name, so pick one that says what\n"
            "  the strategy actually is.\n"
            "- The old Strategy API is DELETED, never write any of it: \n"
            "  `from lse_terminal.pybt import Strategy`, a Strategy subclass,\n"
            "  init(self), next(self, i), self.buy()/sell()/close(),\n"
            "  self.data.close, self.sma/ema/rsi/atr/crossover, self.I.\n"
            "  None of it exists any more and a file using it WILL fail.\n"
            "  Moving averages are pandas: df.close.ewm(span=9).mean().\n"
            "- Tunable params come from the injected `params` dict, e.g.\n"
            "  fast = params.get(\"fast\", 9). Write them that way so\n"
            "  run_walkforward can sweep them without editing the file.\n"
            "- Backtest with the run_backtest tool (engine \"python\") or POST\n"
            f"  http://{host}/api/backtest with engine=\"python\",\n"
            "  provider=\"userdata\", symbol=<dataset name>, script=<file text>.\n"
            "- Research scripts: any .py in the workspace can be executed via\n"
            "  the run_ml_blueprint tool (it streams arbitrary local Python).\n"
            "- Brue is an EXECUTION language (log in with one key, place\n"
            "  trades). It is not a strategy or backtest language and has no\n"
            "  indicators. Never write Brue for a backtest.\n\n"
            "## Research papers (RESEARCH tab)\n"
            "- list_research is the terminal's live feed of new quant\n"
            "  papers; read_research_paper returns a paper's FULL TEXT from\n"
            "  its PDF. When the user says \"this paper\", their message\n"
            "  names it (the reader's Ask AI button pastes the context).\n"
            "- Strategy from a paper: read the full text FIRST, then write\n"
            "  the method as a workspace strategy .py under the run_backtest\n"
            "  contract, with a comment per rule citing the section of the\n"
            "  paper it implements and every simplification made. Backtest\n"
            "  it and report the real numbers; most papers weaken after\n"
            "  costs, say so plainly when they do.\n"
            "- Diagrams: draw the paper's mechanism as a SELF-CONTAINED .svg\n"
            "  via write_workspace_file (flow, timeline, payoff, pipeline;\n"
            "  no external fonts/refs; dark-background friendly; large\n"
            "  legible labels). The user records videos over these, so\n"
            "  clarity beats decoration.\n\n"
            "## Native tools (chat panel: Claude AND ChatGPT get these)\n"
            "- The lse_terminal MCP server exposes: get_positions (live\n"
            "  account + open positions with prices), get_fills (closed\n"
            "  trades and realised P&L), run_backtest,\n"
            "  get_candles, list_datasets, list_research,\n"
            "  read_research_paper, read_guide, list_workspace,\n"
            "  read_workspace_file, write_workspace_file (asks the user\n"
            "  unless autonomy allows edits), open_in_app, and the ML tools\n"
            "  below. PREFER them over shell+curl: run_backtest with no\n"
            "  arguments backtests the strategy currently in the user's\n"
            "  editor on the chart's own symbol/timeframe.\n"
            "- Research pack: run_walkforward (param-grid walk-forward with\n"
            "  per-fold OOS efficiency), run_montecarlo (trade-resample\n"
            "  stress: drawdown percentiles, risk of ruin), get_economics\n"
            "  (the macro calendar: releases, surprises, next dates; built\n"
            "  for event studies), import_lse_data (pull any databank\n"
            "  instrument into the user's library by symbol/timeframe).\n"
            "  A finished strategy should ship with walkforward AND\n"
            "  montecarlo evidence, not just one in-sample backtest.\n"
            "- The web: web_search (live search), fetch_url (a page or PDF as\n"
            "  text), browse (renders JavaScript pages in a real browser).\n"
            "  Your training data has a cutoff and the user is asking today,\n"
            "  so SEARCH before answering anything that turns on a current\n"
            "  rate, release, policy or piece of news, and cite the URL. Do\n"
            "  not search for numbers the terminal already has: the user's\n"
            "  own prices, positions and P&L come from the tools above.\n"
            "- run_python runs Python in the workspace and returns stdout,\n"
            "  for analysis the terminal does not do itself (correlations,\n"
            "  distributions, joins, data-quality checks). Never use it to\n"
            "  hand-roll a backtest: run_backtest's numbers match the UI.\n"
            "- remember stores one durable fact about the user for FUTURE\n"
            "  chats; recall lists or deletes them. Your saved notes are\n"
            "  handed to you at the start of every chat, so use them rather\n"
            "  than asking the same questions again. Save preferences and\n"
            "  decisions, never secrets.\n"
            "- open_in_app drives the user's screen: view=dataset shows an\n"
            "  imported CSV, view=file opens a strategy in the editor,\n"
            "  view=section switches pages\n"
            "  (markets, backtest:py, backtest:ml, backtest:manual,\n"
            "  economic, workspace, research, guide, mydata). When the\n"
            "  user says open/show\n"
            "  something that exists in the app, USE IT instead of just\n"
            "  describing the data.\n"
            "## Machine learning (BACKTEST > MACHINE LEARNING section)\n"
            "- Training is CODE-FIRST: a run is a small Python blueprint\n"
            "  calling lse_terminal.ml.blueprint.train(). When the user asks\n"
            "  for an ML model, prediction, forecast, or regime/volatility\n"
            "  analysis: call list_ml_models for the schemas, build the\n"
            "  dataset if needed (build_ml_dataset, from their MY DATA\n"
            "  imports only), write or edit a blueprint, run it with\n"
            "  run_ml_blueprint, then poll get_ml_job and explain the\n"
            "  results. Everything trains locally on this machine; never\n"
            "  invent parameters that are not in the model's schema.\n\n"
            "## Useful engine endpoints (GET unless noted)\n"
            f"- http://{host}/mcp : the SAME tools as a direct streamable-\n"
            "  HTTP MCP server, for any OTHER local MCP client the user\n"
            "  runs (Claude Code in an IDE, Claude Desktop). No auth;\n"
            "  local machine only.\n"
            f"- http://{host}/api/data : the My Data manifest\n"
            f"- http://{host}/api/candles?provider=&symbol=&timeframe= :\n"
            "  chart candles as JSON\n"
            f"- http://{host}/api/backtest (POST) : run a strategy; see\n"
            "  backtest.py for the request shape\n\n"
            "Minimal working strategy (plain Python):\n\n"
            "```python\n" + TEMPLATE + "```\n"
        )
        # What a connected broker's terms take away from the agent, and why,
        # so a refusal it meets is one it was told about (SPEC 3.3).
        brief += _terms_brief()
        # USER.md is the ONE hand-editable file here (via the rail's settings
        # panel): it persists across regenerations and its content is appended
        # to every generated context file, so custom instructions reach the
        # agent whichever CLI the user runs.
        user_md = ai_dir / "USER.md"
        if not user_md.exists():
            user_md.write_text(
                "# Your instructions for the AI\n\n"
                "Anything you write here is added to what every AI provider\n"
                "in the panel is told. Trading style, preferred markets,\n"
                "risk rules, tone: it all belongs here.\n"
            )
        user_txt = user_md.read_text().strip()
        if user_txt:
            brief += "\n## The user's own instructions\n\n" + user_txt + "\n"
        (ai_dir / "LSE-TERMINAL.md").write_text(brief)
        # The user guide travels with the brief (same folder, so a plain
        # Read reaches it); rewritten each push so an updated guide.md in
        # the static dir is what the agent reads on its next turn.
        (ai_dir / "GUIDE.md").write_text(guide_text())
        # Same brief under every context-file name the supported agents read
        # (CLAUDE.md: Claude; AGENTS.md: Codex/Kimi/Copilot/OpenCode;
        # GEMINI.md / QWEN.md: the gemini-cli family), so the panel behaves
        # the same whichever agent the user signs in with.
        for ctx_name in ("CLAUDE.md", "AGENTS.md", "GEMINI.md", "QWEN.md"):
            (ai_dir / ctx_name).write_text(brief)

    @app.post("/api/ai/workspace")
    def ai_workspace(body: AiWorkspaceIn, request: Request):
        deny_hosted()
        _ai_write_workspace(body, request.headers.get("host", "127.0.0.1:7788"))
        return {"ok": True, "path": str(ai_dir)}

    @app.get("/api/ai/capture-allowed")
    def ai_capture_allowed():
        """Asked by the desktop shell before it writes a screenshot into the
        agent workspace (desktop/main.js): not while a live connection whose
        broker keeps its prices on this computer may be on screen, and then
        with the sentence that says why (SPEC 3.3)."""
        deny_hosted()
        why = _screen_withheld()
        if why:
            _drop_screenshot()
            return {"allowed": False, "reason": why}
        return {"allowed": True}

    @app.get("/api/ai/strategy")
    def ai_strategy():
        deny_hosted()
        p = ai_dir / "strategy.py"
        if not p.exists():
            return {"source": None, "mtime": 0}
        return {"source": p.read_text(), "mtime": p.stat().st_mtime}

    # ── auto-update check ─────────────────────────────────────────────
    # The desktop app updates itself (electron-updater in desktop/main.js
    # against the same feed); this endpoint is for pip/source runs, where
    # the shell shows a banner instead. latest.yml is served with
    # Cache-Control: no-store and fetched here with a cache-busting query,
    # so a fresh release is visible on the next check; the 10 minute
    # in-process interval only spaces out the remote hits, it never serves
    # a stale answer past that window.
    RELEASES_BASE = "https://terminal.londonstrategicedge.com/releases/"
    update_cache = {"t": 0.0, "latest": "", "path": ""}

    @app.get("/api/update/status")
    def update_status():
        import re as _re
        import urllib.request as _rq
        if hosted:  # the hosted site instance is redeployed, never self-updated
            return {"current": __version__, "latest": "", "update": False}
        now = time.time()
        if now - update_cache["t"] > 600:
            update_cache["t"] = now
            try:
                req = _rq.Request(
                    RELEASES_BASE + f"latest.yml?noCache={int(now)}",
                    headers={"Cache-Control": "no-cache",
                             "User-Agent": f"lse-terminal/{__version__}"})
                text = _rq.urlopen(req, timeout=5).read().decode()
                mv = _re.search(r"^version:\s*(\S+)", text, _re.M)
                # Installer names contain spaces ("LSE Terminal Setup x.exe"),
                # so capture the whole line and URL-encode for the link.
                mp = _re.search(r"^path:\s*(.+?)\s*$", text, _re.M)
                update_cache["latest"] = mv.group(1) if mv else ""
                update_cache["path"] = (
                    _rq.quote(mp.group(1)) if mp else "")
            except Exception:
                update_cache["latest"] = ""  # offline or feed away: no banner
        latest = update_cache["latest"]

        def _key(v: str):
            return [int(x) for x in _re.findall(r"\d+", v)[:3]] or [0]

        newer = bool(latest) and _key(latest) > _key(__version__)
        return {"current": __version__, "latest": latest, "update": newer,
                "download": RELEASES_BASE + update_cache["path"]
                            if update_cache["path"] else RELEASES_BASE}

    # The rail's settings panel: the .md context files the agents read.
    # USER.md is the user's persistent custom instructions; the rest are
    # regenerated on every workspace push, shown read-only so nobody edits
    # a file that is about to be overwritten.
    AI_MD_FILES = ("USER.md", "LSE-TERMINAL.md", "CLAUDE.md", "AGENTS.md",
                   "GEMINI.md", "QWEN.md")

    @app.get("/api/ai/instructions")
    def ai_instructions():
        deny_hosted()
        files = []
        for name in AI_MD_FILES:
            p = ai_dir / name
            files.append({"name": name, "editable": name == "USER.md",
                          "content": p.read_text() if p.exists() else ""})
        return {"dir": str(ai_dir), "files": files}

    @app.post("/api/ai/instructions")
    def ai_instructions_save(body: AiInstructionsIn):
        deny_hosted()
        if body.name != "USER.md":
            raise HTTPException(400, "only USER.md is editable; the other "
                                     "files are regenerated from it")
        ai_dir.mkdir(parents=True, exist_ok=True)
        (ai_dir / "USER.md").write_text(body.content)
        # The client follows a save with a workspace push, which rebuilds
        # every generated context file with the new instructions inside.
        return {"ok": True}

    # The agents the panel can run: each is the user's OWN CLI, signed in to
    # their own subscription/account, running in the user's HOME directory
    # with whatever access that CLI normally has on their machine. The shell
    # builds its provider dropdown from /api/ai/status, so adding a BYO agent
    # is one row here, nothing else.
    #   binary   executable looked up on PATH
    #   install  how to get it (shown in the panel when it is missing)
    #   chat     how /api/ai/chat drives a non-interactive turn:
    #            "claude-json"  -p --output-format stream-json JSONL
    #            "codex-json"   exec --json JSONL (thread/item/turn events)
    #            "text"         plain stdout, ANSI-stripped, streamed as-is
    #   first    FLAGS for the opening turn of a conversation
    #   resume   FLAGS for follow-up turns; sid is the session token captured
    #            from the first turn, or True for CLIs that resume by "most
    #            recent session" (no id to capture).
    # THE PROMPT IS NOT IN ARGV. Both CLIs read the turn's text from stdin
    # (confirmed on Windows: "Reading prompt from stdin..."
    # for codex exec AND codex exec resume, and claude -p --print with no
    # positional prompt), and run_turn writes it there. Argv carries flags
    # only, because argv has a hard length cap and stdin does not: an
    # npm-installed CLI on Windows is a .cmd shim, CreateProcess hands a
    # .cmd to cmd.exe, and cmd.exe truncates at 8191 characters, so an
    # agent brief inlined into argv fails every turn with "The command
    # line is too long." (a CLI shipped as a real .exe only gets the
    # 32767 cap, which is still a cap). Anything user- or context-sized
    # (prompt, brief, memory, pasted code) goes down stdin.
    # m is an optional model override from the panel's /model command; each
    # CLI's flag spelling was verified against its --help (codex accepts -m
    # on both exec and exec resume). Chat turns run with each CLI's DEFAULT
    # approval behavior: in the user's home dir, silently auto-approving
    # edits would be wrong, so actions a CLI would normally confirm get
    # denied headlessly and belong in the Terminal view instead.

    def _mf(m, flag="-m"):
        return [flag, m] if m else []

    AI_AGENTS = {
        "claude": {
            "label": "Claude", "binary": "claude",
            "install": "npm install -g @anthropic-ai/claude-code",
            "install_argv": ["npm", "install", "-g", "@anthropic-ai/claude-code"],
            "chat": "claude-json",
            "first": lambda m: ["claude", "-p", *_mf(m, "--model"),
                                "--output-format", "stream-json",
                                "--verbose"],
            "resume": lambda sid, m: ["claude", "-p", *_mf(m, "--model"),
                                      "--resume", str(sid),
                                      "--output-format", "stream-json",
                                      "--verbose"],
        },
        "codex": {
            "label": "ChatGPT", "binary": "codex",
            "install": "npm install -g @openai/codex",
            "install_argv": ["npm", "install", "-g", "@openai/codex"],
            "chat": "codex-json",
            "first": lambda m: ["codex", "exec", *_mf(m), "--json",
                                "--skip-git-repo-check"],
            "resume": lambda sid, m: ["codex", "exec", "resume", str(sid),
                                      *_mf(m), "--json",
                                      "--skip-git-repo-check"],
        },
    }

    # How each CLI starts its interactive sign-in, used by the terminal
    # view's ?login=1 launch (the chat panel's "Sign in" button). Providers
    # not listed just run their normal TUI, which prompts for auth on first
    # run by itself. `codex login` and `opencode auth login` verified
    # against --help; claude executes an initial "/login" slash argument
    # (worst case it lands prefilled as the first prompt).
    AI_LOGIN = {
        "claude": ["claude", "/login"],
        "codex": ["codex", "login"],
    }

    # ── One-click CLI install: npm install streamed into the chat ─────
    # No PTY needed (npm runs fine on pipes). The client shows a progress
    # card; on success it re-fetches status, so the login card (or plain
    # welcome) takes over. The command is fixed server-side per provider.

    @app.websocket("/api/ai/install")
    async def ai_install(websocket: WebSocket):
        await websocket.accept()
        if await deny_hosted_ws(websocket):
            return
        if await deny_other_origin_ws(websocket):
            return
        agent = websocket.query_params.get("agent", "")
        spec = AI_AGENTS.get(agent) or {}
        argv = spec.get("install_argv")
        if hosted or not argv:
            await websocket.send_json({"type": "error",
                                       "message": "one-click install is not available for this provider"})
            await websocket.close()
            return
        import shutil
        import subprocess
        tool = shutil.which(argv[0])
        if not tool:
            await websocket.send_json({"type": "error",
                                       "message": f"{argv[0]} is not installed on this machine; "
                                                  f"install Node.js first, or run: {spec['install']}"})
            await websocket.close()
            return
        run_argv = [tool] + argv[1:]
        if tool.lower().endswith((".cmd", ".bat")):
            run_argv = ["cmd.exe", "/c"] + run_argv
        try:
            proc = await asyncio.create_subprocess_exec(
                *run_argv, cwd=str(Path.home()),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env={**os.environ, "NO_COLOR": "1"},
                start_new_session=(os.name == "posix"))
        except OSError as e:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close()
            return
        tail = ""
        try:
            while True:
                chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=600)
                if not chunk:
                    break
                tail = (tail + _ANSI_RE.sub("", chunk.decode("utf-8", "replace")))[-2000:]
                line = tail.strip().rsplit("\n", 1)[-1][-160:]
                try:
                    await websocket.send_json({"type": "progress", "line": line})
                except Exception:
                    break
            rc = await proc.wait()
            _authed_cache.clear()
            if rc == 0:
                # What the terminal installed for the user, it keeps current,
                # unless they have already said otherwise.
                _set_auto_update(agent, True, only_if_unset=True)
            try:
                if rc == 0:
                    await websocket.send_json({"type": "ok"})
                else:
                    await websocket.send_json({"type": "error",
                                               "message": (tail.strip()[-400:] or f"install exited with code {rc}")})
            except Exception:
                pass
        except (asyncio.TimeoutError, Exception):
            try:
                proc.kill()
            except Exception:
                pass
            try:
                await websocket.send_json({"type": "error", "message": "install timed out or was interrupted"})
            except Exception:
                pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    # ── GUI sign-in: drive the CLI's login invisibly ──────────────────
    # The vendors' pretty login pages (the VS Code experience) are private
    # to their own apps; what we CAN do is run the CLI's login flow on a
    # hidden PTY, auto-answer its picker, surface the OAuth URL, and watch
    # for success, so the shell shows a clean card instead of a TUI.
    # Success detection avoids fragile TUI text: claude = its credentials
    # file being rewritten (fresh mtime + valid expiry); codex = its login
    # helper process exiting cleanly after the localhost callback.

    import json as _json
    import re as _re

    _AI_LOGIN_URL_RE = _re.compile(r"https://[^\s\x1b\"']+")

    @app.websocket("/api/ai/login")
    async def ai_login(websocket: WebSocket):
        await websocket.accept()
        if await deny_hosted_ws(websocket):
            return
        if await deny_other_origin_ws(websocket):
            return
        agent = websocket.query_params.get("agent", "claude")
        if hosted or agent not in AI_AGENTS or agent not in AI_LOGIN:
            await websocket.send_json({"type": "error",
                                       "message": "GUI sign-in is not available for this provider; use its Terminal view."})
            await websocket.close()
            return
        import shutil
        agent_bin = shutil.which(AI_AGENTS[agent]["binary"])
        if not agent_bin:
            await websocket.send_json({"type": "missing", "agent": agent,
                                       "hint": AI_AGENTS[agent]["install"]})
            await websocket.close()
            return
        argv = [agent_bin] + AI_LOGIN[agent][1:]
        if agent_bin.lower().endswith((".cmd", ".bat")):
            argv = ["cmd.exe", "/c"] + argv
        cred_path = Path.home() / ".claude" / ".credentials.json"
        start_mtime = cred_path.stat().st_mtime if cred_path.exists() else 0
        loop = asyncio.get_running_loop()
        env = {**os.environ, "TERM": "xterm-256color"}

        if os.name == "posix":
            import fcntl
            import pty
            import signal
            import struct
            import subprocess
            import termios
            master, slave = pty.openpty()
            # 1000 columns on purpose: the OAuth URL then never line-wraps,
            # so a plain \S+ regex recovers it intact (at normal widths the
            # TUI wraps it and gluing lines back together is unreliable).
            fcntl.ioctl(master, termios.TIOCSWINSZ,
                        struct.pack("HHHH", 40, 1000, 0, 0))
            proc = subprocess.Popen(argv, stdin=slave, stdout=slave,
                                    stderr=slave, cwd=str(Path.home()),
                                    env=env, start_new_session=True,
                                    close_fds=True)
            os.close(slave)

            async def read_chunk():
                try:
                    return await loop.run_in_executor(None, os.read, master, 65536)
                except OSError:
                    return b""

            def write_str(s):
                try:
                    os.write(master, s.encode())
                except OSError:
                    pass

            def alive():
                return proc.poll() is None

            def exit_ok():
                return proc.poll() == 0

            def kill():
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    pass
                try:
                    os.close(master)
                except Exception:
                    pass
        else:
            from winpty import PtyProcess
            proc = PtyProcess.spawn(argv, cwd=str(Path.home()), env=env,
                                    dimensions=(40, 1000))

            async def read_chunk():
                try:
                    s = await loop.run_in_executor(None, proc.read, 65536)
                    return s.encode()
                except (EOFError, OSError):
                    return b""

            def write_str(s):
                try:
                    proc.write(s)
                except Exception:
                    pass

            def alive():
                return proc.isalive()

            def exit_ok():
                return not proc.isalive()

            def kill():
                try:
                    proc.terminate(force=True)
                except Exception:
                    pass

        done = asyncio.Event()
        state = {"url_sent": False, "code_asked": False, "fired": set()}
        # Screens claude shows before/around the login picker, each answered
        # with one Enter (the wanted option is always preselected). Matching
        # runs on whitespace-squashed text: the TUI positions words with
        # cursor moves, so ANSI-stripped output has no spaces left.
        AUTO_ENTER = ["itrustthisfolder", "choosethetextstyle",
                      "selectloginmethod", "pressentertocontinue"]

        async def emit(payload):
            try:
                await websocket.send_json(payload)
            except Exception:
                done.set()

        def _claude_cred_fresh():
            # Read the CLI's credential file DIRECTLY, never through
            # _agent_authed's 15s cache. During a login the whole point is
            # to see the write the moment it lands, and a cached "signed
            # out" answer taken before the flow started would hold the card
            # open for up to 15s after the CLI is already done. A read that
            # catches a half-written file just fails this poll and succeeds
            # on the next one, 250 ms later.
            try:
                oauth = _json.loads(cred_path.read_text()).get("claudeAiOauth") or {}
            except (OSError, ValueError):
                return False
            return bool(oauth.get("expiresAt", 0) > (time.time() - 7 * 86400) * 1000)

        def logged_in_now():
            if agent == "claude":
                if not cred_path.exists():
                    return False
                if cred_path.stat().st_mtime <= start_mtime:
                    return False
                return _claude_cred_fresh()
            return exit_ok()  # codex: the login helper exits after callback

        async def pump():
            buf = ""
            while not done.is_set():
                chunk = await read_chunk()
                if not chunk:
                    break
                buf = (buf + _ANSI_RE.sub("", chunk.decode("utf-8", "replace")))[-16000:]
                squashed = _re.sub(r"\s+", "", buf.lower())
                for marker in AUTO_ENTER:
                    if marker not in state["fired"] and marker in squashed:
                        state["fired"].add(marker)
                        write_str("\r")
                        await asyncio.sleep(0.3)
                if not state["url_sent"]:
                    m = _AI_LOGIN_URL_RE.search(buf)
                    if m and "oauth" in m.group(0):
                        state["url_sent"] = True
                        await emit({"type": "url", "url": m.group(0)})
                if not state["code_asked"] and "pastecode" in squashed:
                    state["code_asked"] = True
                    await emit({"type": "code_wanted"})

        async def checker():
            # 250 ms, not 2 s: the CLI signals completion only by writing
            # its credential file, so every extra beat here is dead time
            # the user watches. One beat costs a stat, plus a small JSON
            # read on the single beat where the mtime finally moves.
            # The account rides along with the "ok" because the CLI writes
            # ~/.claude.json's oauthAccount BEFORE the credential file
            # (verified in its own login path), so by the time we detect
            # the login the profile on disk is already the new one; the
            # client no longer waits on a status round trip to name it.
            for _ in range(1200):  # 5 minutes
                if done.is_set():
                    return
                if logged_in_now():
                    _authed_cache.clear()  # fresh answer on the next status
                    await emit({"type": "ok",
                                "identity": _agent_identity(agent)})
                    done.set()
                    return
                if not alive() and not logged_in_now():
                    await emit({"type": "error",
                                "message": "the sign-in flow ended without completing"})
                    done.set()
                    return
                await asyncio.sleep(0.25)
            await emit({"type": "error", "message": "sign-in timed out"})
            done.set()

        async def receiver():
            try:
                while not done.is_set():
                    msg = await websocket.receive_json()
                    if msg.get("type") == "code":
                        write_str(str(msg.get("value", "")).strip() + "\r")
                    elif msg.get("type") == "cancel":
                        done.set()
            except Exception:
                done.set()

        # Transactional sign-in (this has stranded real users twice):
        # claude's /login clears the EXISTING login as soon as its picker
        # starts, so a cancelled / timed-out / abandoned switch strands the
        # user signed out. Snapshot the credential file before the flow and
        # put it back if the flow ends without a completed new login. The
        # snapshot never leaves this machine or this process; it is the
        # CLI's own file, restored to its own path.
        cred_backup = None
        if agent == "claude":
            try:
                cred_backup = cred_path.read_bytes()
            except OSError:
                cred_backup = None

        tasks = [asyncio.create_task(pump()), asyncio.create_task(checker()),
                 asyncio.create_task(receiver())]
        await done.wait()
        for t in tasks:
            t.cancel()
        kill()
        if (agent == "claude" and cred_backup is not None
                and not logged_in_now()):
            # No new login completed; if the flow consumed the old one,
            # reinstate it so cancelling a switch never costs the session.
            _authed_cache.clear()
            if _agent_authed("claude") is not True:
                try:
                    cred_path.write_bytes(cred_backup)
                    os.chmod(cred_path, 0o600)
                    _authed_cache.clear()
                    await emit({"type": "restored"})
                except OSError:
                    pass
        try:
            await websocket.close()
        except Exception:
            pass

    async def _ai_pty_windows(websocket, agent, agent_binary, agent_hint,
                              login_mode):
        # ConPTY via pywinpty: the Windows counterpart of the POSIX PTY
        # below, so the terminal view (and therefore every provider's
        # sign-in flow) works on Windows too. API verified against the
        # pywinpty 3.x wheel source: blocking read() returns str and raises
        # EOFError at close; write(str); setwinsize(rows, cols);
        # terminate(force).
        import shutil
        try:
            from winpty import PtyProcess
        except ImportError:
            await websocket.send_json({"type": "error",
                                       "message": "This build is missing pywinpty; reinstall the app."})
            await websocket.close()
            return
        agent_bin = shutil.which(agent_binary)
        if not agent_bin:
            await websocket.send_json({"type": "missing", "agent": agent,
                                       "hint": agent_hint})
            await websocket.close()
            return
        ai_dir.mkdir(parents=True, exist_ok=True)
        argv = ([agent_bin] + AI_LOGIN[agent][1:]
                if login_mode and agent in AI_LOGIN else [agent_bin])
        if agent_bin.lower().endswith((".cmd", ".bat")):
            # CreateProcess cannot exec cmd shims, and npm installs its
            # Windows CLIs as exactly those.
            argv = ["cmd.exe", "/c"] + argv
        try:
            proc = PtyProcess.spawn(argv, cwd=str(Path.home()),
                                    env={**os.environ, "TERM": "xterm-256color",
                                         **_ai_env_extra(agent)})
        except Exception as e:
            await websocket.send_json({"type": "error",
                                       "message": f"could not start {agent}: {e}"})
            await websocket.close()
            return
        loop = asyncio.get_running_loop()

        async def pump_out():
            while True:
                try:
                    data = await loop.run_in_executor(None, proc.read, 65536)
                except (EOFError, OSError):
                    break
                if not data:
                    break
                try:
                    await websocket.send_bytes(data.encode())
                except Exception:
                    break
            try:
                await websocket.send_json({"type": "exit"})
            except Exception:
                pass

        out_task = asyncio.create_task(pump_out())
        try:
            while True:
                msg = await websocket.receive_json()
                if msg.get("type") == "input":
                    proc.write(str(msg.get("data", "")))
                elif msg.get("type") == "resize":
                    proc.setwinsize(int(msg["rows"]), int(msg["cols"]))
        except Exception:
            pass  # disconnect or dead pty: tear down either way
        finally:
            out_task.cancel()
            try:
                proc.terminate(force=True)
            except Exception:
                pass

    # API-key mode (the "Azure-style" infra route): a stored key makes the
    # CLI bill the key's platform account instead of a consumer login.
    # claude honors ANTHROPIC_API_KEY from env per turn; codex persists the
    # key itself via `codex login --with-api-key`, so nothing is stored for
    # it here. Keys never leave this machine (config.json, like the LSE
    # data key).

    def _ai_conn(agent):
        conn = (cfg.load().get("ai_connections") or {}).get(agent) or {}
        return conn if conn.get("key") else {}

    def _ai_key(agent):
        conn = _ai_conn(agent)
        return conn.get("key", "") if conn.get("mode") == "api-key" else ""

    def _ai_env_extra(agent):
        if agent != "claude":
            return {}
        conn = _ai_conn("claude")
        if conn.get("mode") == "foundry":
            # Env names read from the claude binary itself (strings dump,
            # 2.1.215): CLAUDE_CODE_USE_FOUNDRY plus
            # ANTHROPIC_FOUNDRY_API_KEY and _RESOURCE / _BASE_URL.
            env = {"CLAUDE_CODE_USE_FOUNDRY": "1",
                   "ANTHROPIC_FOUNDRY_API_KEY": conn["key"]}
            res = (conn.get("resource") or "").strip()
            if res.startswith("http"):
                env["ANTHROPIC_FOUNDRY_BASE_URL"] = res
            elif res:
                env["ANTHROPIC_FOUNDRY_RESOURCE"] = res
            return env
        if conn.get("mode") == "api-key":
            return {"ANTHROPIC_API_KEY": conn["key"]}
        return {}

    # claude ignores a bare ANTHROPIC_API_KEY without an interactive
    # approval (tested, incl on a pristine HOME); the mechanism that
    # DOES work headless is apiKeyHelper, passed per invocation via
    # --settings so the user's own claude config is never touched. The
    # helper script holds the key (0700, same trust level as config.json).
    def _claude_key_args():
        key = _ai_key("claude")
        if not key:
            return []
        if os.name == "posix":
            helper = cfg.config_dir() / "claude-key-helper.sh"
            helper.write_text(f"#!/bin/sh\necho {key}\n")
            helper.chmod(0o700)
        else:
            # cmd-style helper; NOT yet verified on Windows.
            helper = cfg.config_dir() / "claude-key-helper.cmd"
            helper.write_text(f"@echo {key}\n")
        return ["--settings", _json.dumps({"apiKeyHelper": str(helper)})]

    @app.post("/api/ai/settings")
    def ai_settings_set(body: AiSettingsIn):
        deny_hosted()
        conf = cfg.load()
        conf["ai_codex_full_access"] = bool(body.codex_full_access)
        cfg.save(conf)
        return {"ok": True}

    @app.post("/api/ai/key")
    def ai_key_set(body: AiKeyIn):
        deny_hosted()
        agent = body.agent
        key = body.key.strip()
        mode = body.mode.strip() or "api-key"
        if agent not in AI_AGENTS:
            raise HTTPException(404, "unknown agent")
        if agent == "claude" and mode not in ("api-key", "foundry"):
            raise HTTPException(400, "unknown connection mode")
        if agent == "codex":
            # codex owns its key storage; feed it through its own login.
            if mode != "api-key":
                raise HTTPException(400, "ChatGPT supports API-key mode here")
            import shutil
            import subprocess
            binary = shutil.which("codex")
            if not binary:
                raise HTTPException(400, "install the ChatGPT CLI first")
            if not key:
                subprocess.run([binary, "logout"], capture_output=True,
                               text=True, timeout=15)
            else:
                proc = subprocess.run([binary, "login", "--with-api-key"],
                                      input=key, capture_output=True,
                                      text=True, timeout=30)
                if proc.returncode != 0:
                    raise HTTPException(400, (proc.stderr or proc.stdout or
                                              "codex rejected the key").strip()[-300:])
        else:
            if mode == "foundry" and key and not body.resource.strip():
                raise HTTPException(400, "Foundry needs the resource name or endpoint URL")
            conf = cfg.load()
            conns = conf.get("ai_connections") or {}
            if key:
                conns[agent] = {"mode": mode, "key": key,
                                "resource": body.resource.strip()}
            else:
                conns.pop(agent, None)
                for helper in ("claude-key-helper.sh", "claude-key-helper.cmd"):
                    try:
                        (cfg.config_dir() / helper).unlink()
                    except OSError:
                        pass
            conf["ai_connections"] = conns
            cfg.save(conf)
        _authed_cache.clear()
        return {"ok": True, "mode": mode if key else "removed"}

    # Auth probes spawn subprocesses (codex); a short cache keeps repeated
    # status fetches (panel open, chat/terminal flips) from hammering them.
    _authed_cache = {}

    def _agent_authed(name):
        # True/False only where the semantics were verified on real
        # machines; None = unknown (the panel then falls back to surfacing
        # the CLI's own auth error with a sign-in button).
        # claude: ~/.claude/.credentials.json expiresAt refreshes on every
        # use, so a recently-expired token still refreshes silently, while
        # one dead for months is a hard 401 (both states seen live). Grace
        # of 7 days separates the two.
        # codex: `codex login status` run in the ENGINE'S OWN env, the same
        # env its turns run in, so probe and turns cannot disagree. Only
        # the literal "Not logged in" (verified output) means signed out;
        # "logged in" without the "not" means signed in; anything else is
        # unknown.
        cached = _authed_cache.get(name)
        if cached and time.time() - cached[0] < 15:
            return cached[1]
        result = None
        try:
            if name == "claude":
                if _ai_conn("claude"):
                    result = True  # key/foundry connection: no login needed
                    _authed_cache[name] = (time.time(), result)
                    return result
                p = Path.home() / ".claude" / ".credentials.json"
                if not p.exists():
                    result = False
                else:
                    oauth = _json.loads(p.read_text()).get("claudeAiOauth") or {}
                    cutoff_ms = (time.time() - 7 * 86400) * 1000
                    result = bool(oauth.get("expiresAt", 0) > cutoff_ms)
            elif name == "codex":
                import shutil
                import subprocess
                binary = shutil.which("codex")
                if binary:
                    proc = subprocess.run(
                        [binary, "login", "status"], capture_output=True,
                        text=True, timeout=8)
                    low = ((proc.stdout or "") + (proc.stderr or "")).lower()
                    if "not logged in" in low:
                        result = False
                        _authed_cache["codex_mode"] = (time.time(), "")
                    elif "logged in" in low:
                        result = True
                        _authed_cache["codex_mode"] = (
                            time.time(),
                            "api-key" if "api key" in low else "subscription")
        except Exception:
            result = None
        _authed_cache[name] = (time.time(), result)
        return result

    def _agent_mode(name):
        # How the agent is connected: subscription (default), api-key, or
        # foundry. codex's mode comes from its login status probe.
        if name == "claude":
            conn = _ai_conn("claude")
            return conn.get("mode") or "subscription"
        if name == "codex":
            cached = _authed_cache.get("codex_mode")
            return cached[1] or "subscription" if cached else "subscription"
        return "subscription"

    def _agent_identity(name):
        """Who the CLI is signed in as, read from ITS OWN local files.
        Never a network call, never the tokens themselves: claude keeps the
        account profile in ~/.claude.json (oauthAccount), codex an id_token
        JWT in ~/.codex/auth.json whose payload carries the email. The app
        does no auth of its own, so showing this is the only honest answer
        to "which account am I on?" (previously identity was
        inherited from the machine-global CLI login but never displayed).
        Best-effort: None when the store is absent or the shape unknown."""
        try:
            if name == "claude":
                d = _json.loads((Path.home() / ".claude.json").read_text())
                acct = d.get("oauthAccount") or {}
                email = str(acct.get("emailAddress") or "")
                org = str(acct.get("organizationName") or "")
                return {"email": email, "org": org} if email else None
            if name == "codex":
                d = _json.loads(
                    (Path.home() / ".codex" / "auth.json").read_text())
                tokens = d.get("tokens") if isinstance(d.get("tokens"), dict) else {}
                tok = tokens.get("id_token") or d.get("id_token")
                email = ""
                if isinstance(tok, str) and tok.count(".") == 2:
                    import base64
                    pay = tok.split(".")[1]
                    pay += "=" * (-len(pay) % 4)
                    email = str(_json.loads(
                        base64.urlsafe_b64decode(pay)).get("email") or "")
                email = email or str(d.get("email") or "")
                return {"email": email, "org": ""} if email else None
        except Exception:
            return None
        return None

    @app.post("/api/ai/logout")
    def ai_logout(body: AiAgentIn):
        """Sign the CLI out of its account, from the panel. claude has no
        headless logout subcommand, so its /logout slash is driven on a
        hidden PTY exactly like the GUI sign-in flow; success is the CLI's
        own credential file disappearing (verified in a sandboxed HOME:
        removed in ~1.2s with no interactive screens). codex
        has a real `codex logout` subcommand."""
        deny_hosted()
        agent = body.agent
        if agent not in AI_AGENTS:
            raise HTTPException(400, "unknown agent")
        import shutil
        import subprocess as _sp
        agent_bin = shutil.which(AI_AGENTS[agent]["binary"])
        if not agent_bin:
            raise HTTPException(404, f"{agent} is not installed")
        if agent == "codex":
            try:
                r = _sp.run([agent_bin, "logout"], capture_output=True,
                            text=True, timeout=30)
                _authed_cache.clear()
                return {"ok": True, "signed_out": r.returncode == 0,
                        "detail": (r.stdout or r.stderr or "")[:200]}
            except Exception as e:
                raise HTTPException(502, f"codex logout failed: {e}")
        if agent != "claude":
            raise HTTPException(400, "no sign-out driver for this agent")
        cred = Path.home() / ".claude" / ".credentials.json"
        if not cred.exists():
            _authed_cache.clear()
            return {"ok": True, "signed_out": True, "detail": "already signed out"}
        argv = [agent_bin, "/logout"]
        if agent_bin.lower().endswith((".cmd", ".bat")):
            argv = ["cmd.exe", "/c"] + argv
        env = {**os.environ, "TERM": "xterm-256color"}
        if os.name == "posix":
            import pty as _pty
            import signal as _signal
            master, slave = _pty.openpty()
            proc = _sp.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                             cwd=str(Path.home()), env=env,
                             start_new_session=True, close_fds=True)
            os.close(slave)
            kill = lambda: (os.killpg(proc.pid, _signal.SIGKILL),
                            os.close(master))
        else:
            from winpty import PtyProcess
            proc = PtyProcess.spawn(argv, cwd=str(Path.home()), env=env,
                                    dimensions=(40, 200))
            kill = lambda: proc.terminate(force=True)
        try:
            deadline = time.time() + 30
            while time.time() < deadline:
                if not cred.exists():
                    _authed_cache.clear()
                    return {"ok": True, "signed_out": True, "detail": ""}
                time.sleep(0.5)
            raise HTTPException(504, "sign-out did not complete in 30s; "
                                     "use the agent's terminal view")
        finally:
            try:
                kill()
            except Exception:
                pass

    # Signed-out awareness (the user has no other way to know): the login
    # is machine-global CLI state, so it can vanish from
    # outside the app (a /logout in VS Code, an interrupted /login, token
    # revocation). Watch the credential file and tell the open panel the
    # moment it goes, instead of letting the next message fail.
    @app.on_event("startup")
    async def _watch_agent_signout():
        async def _loop():
            cred = Path.home() / ".claude" / ".credentials.json"
            last = cred.exists()
            while True:
                await asyncio.sleep(20)
                try:
                    now = cred.exists()
                except OSError:
                    continue
                if last and not now:
                    _authed_cache.clear()
                    ui_event_push({"type": "agent_signed_out",
                                   "agent": "claude"})
                last = now
        asyncio.create_task(_loop())

    @app.get("/api/ai/status")
    def ai_status():
        import shutil
        agents = {name: bool(shutil.which(spec["binary"]))
                  for name, spec in AI_AGENTS.items()}
        return {"agents": agents, "posix": os.name == "posix", "hosted": hosted,
                "meta": {name: {"label": spec["label"],
                                "install": spec["install"],
                                "installable": bool(spec.get("install_argv")),
                                "installed": agents[name],
                                "authed": _agent_authed(name),
                                # Shown only while authed: a signed-out
                                # CLI's leftover profile must not read as
                                # a live account.
                                "identity": (_agent_identity(name)
                                             if _agent_authed(name) is True
                                             else None),
                                "mode": _agent_mode(name),
                                "full_access": bool(name == "codex"
                                                    and cfg.load().get("ai_codex_full_access"))}
                         for name, spec in AI_AGENTS.items()},
                # real paths the composer menu inserts (Mention a dataset)
                "paths": {"data": str(cfg.config_dir() / "data"),
                          "workspace": str(ai_dir)},
                # back-compat with the first cut of the panel
                "claude": agents.get("claude", False)}

    # ── The model menu, asked of the user's own CLI ───────────────────
    # The page used to carry a typed list of models, which aged between
    # builds: new models were missing and a withdrawn one stayed as a row
    # that failed. Each CLI knows what its account can run, so the menu asks
    # it (agent_models.py). The CLI is started exactly as a chat turn starts
    # it: same executable, same environment, same account arguments, so the
    # list is the one the next turn will be held to.
    # The answer is kept beside the sign-in probes in _authed_cache, so every
    # place that already clears those (sign in, sign out, a key saved or
    # removed) also drops a list that belonged to the previous account.
    _MODELS_TTL_OK = 60     # a `claude update` shows within a minute
    _MODELS_TTL_FAIL = 15   # do not hammer a CLI that cannot answer

    @app.get("/api/ai/models")
    def ai_models(request: Request, agent: str = "", refresh: int = 0):
        deny_hosted()
        own_origin_only(request)  # starts a program as the user
        if agent not in AI_AGENTS:
            raise HTTPException(404, "unknown agent")
        cached = _authed_cache.get("models:" + agent)
        if cached and not refresh:
            ttl = _MODELS_TTL_OK if cached[1].get("ok") else _MODELS_TTL_FAIL
            if time.time() - cached[0] < ttl:
                return _with_update_state(agent, cached[1])
        import shutil
        from . import agent_models
        agent_bin = shutil.which(AI_AGENTS[agent]["binary"])
        if not agent_bin:
            out = {"ok": False, "agent": agent, "source": "", "models": [],
                   "unavailable": [], "error": "not installed"}
        else:
            argv = _direct_argv([agent_bin])
            if argv[0].lower().endswith((".cmd", ".bat")):
                argv = ["cmd.exe", "/c"] + argv
            env = {**os.environ, "TERM": "dumb", "NO_COLOR": "1",
                   **_ai_env_extra(agent)}
            out = agent_models.list_models(
                agent, argv, env=env, cwd=str(Path.home()),
                account_args=_claude_key_args() if agent == "claude" else ())
        out["fetched_at"] = int(time.time())
        _authed_cache["models:" + agent] = (time.time(), out)
        return _with_update_state(agent, out)

    # ── Keeping the user's CLI current ────────────────────────────────
    # A CLI lists only the models it knows, so a CLI that is behind is why
    # a user cannot pick the newest model. The terminal runs the CLI's own
    # updater for them (agent_models.update_cli):
    # - asked: the user's click on the menu row, or /update. It also turns
    #   on keeping that CLI current (ai_auto_update in config.json).
    # - not asked: the page's automatic update when the CLI is behind,
    #   allowed only where that is on. The Install button turns it on for
    #   what it installs; otherwise the user's first update does.
    # The program is the user's own and is used outside this app too, so
    # nothing here runs before one of those two.
    # Never while that provider is answering (the turn would be running the
    # program being replaced), one update at a time, and a failed or
    # unmoved update is remembered for this launch so the page does not
    # try the same version again by itself.
    import threading as _threading_cli
    _cli_update_lock = _threading_cli.Lock()
    _cli_updating = {}   # agent -> True while its updater runs
    _cli_turns = {}      # agent -> chat turns running now
    _cli_tried = {}      # agent -> newest version an update did not reach
    app.state.ai_cli_turns = _cli_turns

    def _auto_update(agent):
        value = (cfg.load().get("ai_auto_update") or {}).get(agent)
        return value if isinstance(value, bool) else None

    def _set_auto_update(agent, value, only_if_unset=False):
        conf = cfg.load()
        chosen = conf.get("ai_auto_update")
        chosen = dict(chosen) if isinstance(chosen, dict) else {}
        if only_if_unset and isinstance(chosen.get(agent), bool):
            return
        chosen[agent] = bool(value)
        conf["ai_auto_update"] = chosen
        cfg.save(conf)

    def _with_update_state(agent, out):
        # Added per request, not kept with the list: the setting and the
        # last attempt can change while the list is still fresh.
        if not isinstance(out.get("cli"), dict):
            return out
        return {**out, "cli": {**out["cli"],
                               "auto": _auto_update(agent),
                               "tried": _cli_tried.get(agent, ""),
                               "updating": bool(_cli_updating.get(agent))}}

    @app.post("/api/ai/auto-update")
    def ai_auto_update_set(body: AiAutoUpdateIn, request: Request):
        deny_hosted()
        own_origin_only(request)
        if body.agent not in AI_AGENTS:
            raise HTTPException(404, "unknown agent")
        _set_auto_update(body.agent, body.enabled)
        return {"ok": True, "agent": body.agent, "auto": _auto_update(body.agent)}

    @app.post("/api/ai/update")
    def ai_update(body: AiUpdateIn, request: Request):
        deny_hosted()
        own_origin_only(request)  # runs a program as the user
        from . import agent_models
        agent = body.agent
        if agent not in AI_AGENTS or agent not in agent_models.CLI:
            raise HTTPException(404, "unknown agent")
        if not body.asked and _auto_update(agent) is not True:
            raise HTTPException(403, "automatic updates are not turned on "
                                     "for this provider")
        import shutil
        agent_bin = shutil.which(AI_AGENTS[agent]["binary"])
        if not agent_bin:
            raise HTTPException(400, "not installed")
        if _cli_turns.get(agent, 0) > 0:
            raise HTTPException(409, "a message is being answered; update "
                                     "when it has finished")
        if not _cli_update_lock.acquire(blocking=False):
            raise HTTPException(409, "an update is already running")
        argv = _direct_argv([agent_bin])
        if argv[0].lower().endswith((".cmd", ".bat")):
            argv = ["cmd.exe", "/c"] + argv
        env = {**os.environ, "TERM": "dumb", "NO_COLOR": "1"}
        try:
            _cli_updating[agent] = True
            result = agent_models.update_cli(agent, argv, env=env,
                                             cwd=str(Path.home()))
        finally:
            _cli_updating.pop(agent, None)
            _cli_update_lock.release()
        _authed_cache.clear()  # the list belonged to the old version
        state = agent_models.cli_state(agent, argv, env=env, cwd=str(Path.home()))
        if state.get("outdated") or not result["ok"]:
            _cli_tried[agent] = state.get("latest") or result["after"] or "?"
        else:
            _cli_tried.pop(agent, None)
        if body.asked and result["ok"]:
            _set_auto_update(agent, True)
        return {**result, "agent": agent,
                "cli": _with_update_state(agent, {"cli": state})["cli"]}

    @app.websocket("/api/ai/pty")
    async def ai_pty(websocket: WebSocket):
        await websocket.accept()
        if await deny_hosted_ws(websocket):
            return
        if await deny_other_origin_ws(websocket):
            return
        agent = websocket.query_params.get("agent", "claude")
        if agent not in AI_AGENTS:
            agent = "claude"
        agent_binary = AI_AGENTS[agent]["binary"]
        agent_hint = AI_AGENTS[agent]["install"]
        login_mode = websocket.query_params.get("login") == "1"
        if hosted:
            await websocket.send_json({"type": "error",
                                       "message": "The AI panel only runs in the local terminal."})
            await websocket.close()
            return
        if os.name != "posix":
            await _ai_pty_windows(websocket, agent, agent_binary, agent_hint,
                                  login_mode)
            return
        import fcntl
        import pty
        import shutil
        import signal
        import struct
        import subprocess
        import termios
        import threading
        agent_bin = shutil.which(agent_binary)
        if not agent_bin:
            await websocket.send_json({"type": "missing", "agent": agent,
                                       "hint": agent_hint})
            await websocket.close()
            return
        ai_dir.mkdir(parents=True, exist_ok=True)
        master, slave = pty.openpty()

        def child_setup():
            # New session + make the PTY the controlling terminal, otherwise
            # Claude's TUI gets no job control and redraws break.
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        pty_argv = ([agent_bin] + AI_LOGIN[agent][1:]
                    if login_mode and agent in AI_LOGIN else [agent_bin])
        if agent == "claude" and not login_mode:
            pty_argv = pty_argv + _claude_key_args()
        # Home directory, not the strategy workspace: the terminal view is
        # the user's full agent on their own machine (sign-in, approvals,
        # anything the CLI can normally do).
        proc = subprocess.Popen(
            pty_argv, cwd=str(Path.home()),
            stdin=slave, stdout=slave, stderr=slave,
            env={**os.environ, "TERM": "xterm-256color",
                 "COLORTERM": "truecolor", **_ai_env_extra(agent)},
            preexec_fn=child_setup, close_fds=True)
        os.close(slave)
        loop = asyncio.get_running_loop()

        async def pump_out():
            while True:
                try:
                    data = await loop.run_in_executor(None, os.read, master, 65536)
                except OSError:  # EIO when the child exits and the PTY closes
                    break
                if not data:
                    break
                try:
                    await websocket.send_bytes(data)
                except Exception:
                    break
            try:
                await websocket.send_json({"type": "exit"})
            except Exception:
                pass

        out_task = asyncio.create_task(pump_out())
        try:
            while True:
                msg = await websocket.receive_json()
                if msg.get("type") == "input":
                    os.write(master, str(msg.get("data", "")).encode())
                elif msg.get("type") == "resize":
                    fcntl.ioctl(master, termios.TIOCSWINSZ,
                                struct.pack("HHHH", int(msg["rows"]),
                                            int(msg["cols"]), 0, 0))
        except Exception:
            pass  # disconnect, malformed frame: either way tear down
        finally:
            out_task.cancel()
            try:
                os.killpg(proc.pid, signal.SIGHUP)
            except Exception:
                pass
            try:
                os.close(master)
            except Exception:
                pass
            # Reap off-thread so a slow exit never blocks the event loop.
            threading.Thread(target=proc.wait, daemon=True).start()

    # ── AI chat mode: structured turns instead of a raw TUI ───────────
    # One WebSocket per open panel. Each user message spawns the agent CLI
    # for ONE non-interactive turn (first/resume argv from AI_AGENTS) and
    # streams parsed events back: text, tool chips, turn_end. Unlike the
    # PTY endpoint this needs no pseudo-terminal, so it also runs on
    # Windows, where the TUI panel is not wired.

    import json as _json
    import re as _re

    _ANSI_RE = _re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f]")

    # npm's Windows shim is a .cmd batch file, and CreateProcess runs a .cmd
    # by launching cmd.exe, which drags in cmd's own rules: an 8191-char
    # command line (vs 32767 for a real executable) and re-parsing of %VAR%,
    # &, | and > INSIDE arguments we already quoted. The shim's only job is
    # to call `node <pkg>/bin/<x>.js "%*"`, so read that path out of it and
    # call node ourselves: same program, none of cmd's rules. Falls back to
    # the shim untouched whenever the file is not the shape we expect.
    _NPM_SHIM_JS = _re.compile(r'%dp0%\\?([^"\r\n]+\.js)', _re.I)

    def _direct_argv(argv):
        if os.name == "posix" or not argv:
            return argv
        exe = Path(argv[0])
        if exe.suffix.lower() not in (".cmd", ".bat"):
            return argv
        try:
            shim = exe.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return argv
        m = _NPM_SHIM_JS.search(shim)
        if not m:
            return argv
        entry = (exe.parent / m.group(1).replace("\\", os.sep)).resolve()
        if not entry.is_file():
            return argv
        import shutil as _sh
        # The shim prefers a node.exe sitting beside it (npm bundled inside
        # the Node install); mirror that before falling back to PATH.
        local = exe.parent / "node.exe"
        node = str(local) if local.is_file() else _sh.which("node")
        return [node, str(entry)] + argv[1:] if node else argv

    def _ai_tool_detail(name, tool_input):
        # One short human line per tool call; the full input stays server-side.
        if not isinstance(tool_input, dict):
            return ""
        for key in ("file_path", "command", "pattern", "url", "description",
                    "path", "prompt"):
            if tool_input.get(key):
                return str(tool_input[key])[:200]
        return ""

    # ── Checkpoints (Phase 4): snapshot the workspace before each agent
    # turn so any turn can be reverted, VS Code checkpoint style. Plain file
    # copies, not git: user machines cannot be assumed to have git, and the
    # workspace is a handful of small files. chart.png / pasted images are
    # ephemera and excluded. So is context.json: the page's state, written
    # again before every turn, so a revert has nothing to restore from it,
    # and it carries the screen's prices, which a broker's terms can keep off
    # any copy an agent reads (SPEC 3.3).
    _NOT_CHECKPOINTED = ("chart.png", "context.json")

    def _checkpoint_make() -> str:
        import shutil as _sh
        import uuid as _uuid
        cid = _uuid.uuid4().hex[:8]
        root = ai_dir / ".checkpoints"
        dst = root / cid
        dst.mkdir(parents=True, exist_ok=True)
        # A checkpoint made by a build from before that rule may hold one.
        for old in root.iterdir():
            try:
                (old / "context.json").unlink()
            except OSError:
                pass
        for f in ai_dir.iterdir():
            if (f.is_file() and f.stat().st_size <= 1024 * 1024
                    and f.name not in _NOT_CHECKPOINTED
                    and not f.name.startswith("pasted-")):
                _sh.copy2(f, dst / f.name)
        # The agents' real edits land in the STRATEGY workspace, so a revert
        # that only restored ai-workspace scratch files was cosmetic: the
        # user's .py strategies kept the unwanted change. Snapshot them too,
        # under ws/ so flat ai-dir files and the tree cannot collide.
        for f in ws_dir().rglob("*"):
            if (f.is_file() and f.suffix.lower() in WS_EXTS
                    and f.stat().st_size <= 1024 * 1024):
                rel = f.relative_to(ws_dir())
                (dst / "ws" / rel).parent.mkdir(parents=True, exist_ok=True)
                _sh.copy2(f, dst / "ws" / rel)
        keep = sorted(root.iterdir(), key=lambda p: p.stat().st_mtime)
        for old in keep[:-20]:
            _sh.rmtree(old, ignore_errors=True)
        return cid

    @app.post("/api/ai/revert")
    def ai_revert(body: AiRevertIn):
        deny_hosted()
        import shutil as _sh
        cid = "".join(c for c in body.id if c.isalnum())[:16]
        src = ai_dir / ".checkpoints" / cid
        if not cid or not src.is_dir():
            raise HTTPException(404, "checkpoint not found")
        restored = []
        for f in sorted(src.iterdir()):
            if f.is_file() and f.name not in _NOT_CHECKPOINTED:
                _sh.copy2(f, ai_dir / f.name)
                restored.append(f.name)
        # Strategy-workspace files ride under ws/ (see _checkpoint_make).
        # Copy-back only, matching the ai-dir behavior: files the agent
        # CREATED after this checkpoint stay on disk rather than being
        # deleted, erring toward never destroying user work.
        wsroot = src / "ws"
        if wsroot.is_dir():
            for f in sorted(p for p in wsroot.rglob("*") if p.is_file()):
                rel = str(f.relative_to(wsroot)).replace("\\", "/")
                target = ws_dir() / rel
                changed = (not target.is_file()
                           or target.read_bytes() != f.read_bytes())
                target.parent.mkdir(parents=True, exist_ok=True)
                _ws_note_self_write(rel)  # the push below is the one event
                _sh.copy2(f, target)
                restored.append("ws/" + rel)
                if changed:
                    # Open editors reload the restored content immediately
                    # instead of waiting a watcher cycle.
                    ui_event_push({"type": "workspace_changed", "path": rel})
        return {"ok": True, "restored": restored}

    @app.post("/api/ai/paste-image")
    def ai_paste_image(body: AiPasteIn):
        deny_hosted()
        import base64
        try:
            raw = base64.b64decode(body.data, validate=True)
        except Exception:
            raise HTTPException(400, "not base64 image data")
        if not (0 < len(raw) <= 8 * 1024 * 1024):
            raise HTTPException(400, "image must be under 8 MB")
        ai_dir.mkdir(parents=True, exist_ok=True)
        # Rolling names: pasted images are conversation ephemera, keep the
        # last few rather than growing the workspace forever.
        name = f"pasted-{int(time.time())}.png"
        (ai_dir / name).write_bytes(raw)
        pasted = sorted(ai_dir.glob("pasted-*.png"))
        for old in pasted[:-5]:
            try:
                old.unlink()
            except OSError:
                pass
        return {"path": str(ai_dir / name)}

    def _plain(data):
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(
            data if isinstance(data, str) else data.decode("utf-8", "replace"))

    # ── Native capability tools (Phase 5) ─────────────────────────────
    # The bridge's "tools" role forwards mcp__lse_terminal__* calls here.
    # Defaults come from the LIVE workspace (context.json = the chart open
    # right now; strategy.py = the editor), so "backtest this" needs no
    # arguments at all. Token-gated like the approval path.
    # ── UI event bus: capability tools drive the app's own screens ──────
    # The open_in_app tool answers asks like "open the AAPL csv": the tool
    # handler pushes an event here, every open app window receives it over
    # SSE and performs the navigation itself with its own view functions.
    # (queue, loop) pairs: pushes come from threadpool tool handlers, so the
    # enqueue must hop onto each subscriber's event loop.
    ui_event_subs: set = set()

    def ui_event_push(ev: dict) -> int:
        delivered = 0
        for q, loop in list(ui_event_subs):
            try:
                loop.call_soon_threadsafe(q.put_nowait, ev)
                delivered += 1
            except Exception:
                ui_event_subs.discard((q, loop))
        return delivered

    @app.get("/api/ui/events")
    async def ui_events():
        deny_hosted()
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        sub = (q, asyncio.get_running_loop())
        ui_event_subs.add(sub)

        async def gen():
            try:
                yield b": connected\n\n"
                while True:
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=25)
                        yield ("data: " + _json.dumps(ev) + "\n\n").encode()
                    except asyncio.TimeoutError:
                        yield b": keepalive\n\n"
            finally:
                ui_event_subs.discard(sub)

        return StreamingResponse(gen(), media_type="text/event-stream")

    # ── Workspace watcher: agent edits reach the editor, always ────────
    # The chat agents edit strategy files with their OWN tools (Claude's
    # Edit/Write run straight on the filesystem), so an SSE push from the
    # write_workspace_file MCP tool alone misses most real edits: the file
    # changed on disk but the open editor kept showing the old code, which
    # made the agent look broken. This mtime/size poll is the catch-all:
    # ANY on-disk change in the workspace becomes a workspace_changed event.
    # Engine-side writes (the editor's own 800ms autosave, the MCP tool,
    # rename/delete) are remembered for a few seconds and swallowed here,
    # otherwise every keystroke's autosave would echo back as a reload and
    # yank the cursor out from under the user.
    _ws_self_writes: dict = {}

    def _ws_note_self_write(rel: str) -> None:
        _ws_self_writes[rel.replace("\\", "/").lstrip("/")] = time.monotonic()

    def _ws_snapshot() -> dict:
        snap = {}
        try:
            for p in ws_dir().rglob("*"):
                if p.is_file() and p.suffix.lower() in WS_EXTS:
                    st = p.stat()
                    rel = str(p.relative_to(ws_dir())).replace("\\", "/")
                    snap[rel] = (st.st_mtime_ns, st.st_size)
        except OSError:
            pass  # a file vanished mid-scan; next cycle is authoritative
        return snap

    def _ws_watch() -> None:
        last = None
        while True:
            time.sleep(1.5)
            if not ui_event_subs:
                # No window listening: skip the scan AND drop the baseline,
                # so changes made while the app was closed do not replay as
                # a burst of stale events when it reopens.
                last = None
                continue
            cur = _ws_snapshot()
            if last is not None:
                now = time.monotonic()
                fresh = {r for r, t in _ws_self_writes.items() if now - t < 5}
                for rel, sig in cur.items():
                    if last.get(rel) != sig and rel not in fresh:
                        ui_event_push({"type": "workspace_changed", "path": rel})
                for rel in last:
                    if rel not in cur and rel not in fresh:
                        ui_event_push({"type": "workspace_removed", "path": rel})
            last = cur

    @app.on_event("startup")
    def _ws_watch_start():
        if not hosted:  # hosted mode has no local editor to keep in sync
            import threading
            threading.Thread(target=_ws_watch, daemon=True,
                             name="lse-ws-watch").start()

    # Sections open_in_app may navigate to; values are what the frontend
    # dispatches on, keys are what agents write.
    # ("backtest:charts" was removed with the BACKTEST > CHARTS
    # page; the frontend falls back to backtest:py for any stale value.)
    # "research" and "guide": the frontend's open_section
    # dispatcher already handled research but this set rejected it, so the
    # agent could never navigate there; guide is the new user-guide tab.
    UI_SECTIONS = {"markets", "backtest", "backtest:py",
                   "backtest:manual", "backtest:ml",
                   "economic", "workspace", "mydata", "research", "guide"}

    @app.post("/api/ai/tool-run")
    def ai_tool_run(body: AiToolRunIn, request: Request):
        deny_hosted()
        own_origin_only(request)
        if body.token not in approve_channels:
            raise HTTPException(403, "no active chat session for this token")
        return _plain(_tool_dispatch(body.name, body.args or {},
                                     _self_url(request), body.token))

    def _pdf_text(data: bytes, pages: str = "") -> str:
        """Extract a paper's text for the assistant. pypdf is pure Python so
        it works in every install; a missing module degrades to a clear
        instruction instead of a crash (the frozen sidecar gains it at the
        next installer build)."""
        try:
            from io import BytesIO
            from pypdf import PdfReader
        except ImportError:
            raise HTTPException(
                501, "pypdf is not installed in this build; run "
                     "`pip install pypdf` next to the engine and retry")
        reader = PdfReader(BytesIO(data))
        first, last = 1, len(reader.pages)
        if pages.strip():
            a, _, b = pages.strip().partition("-")
            if a.strip().isdigit():
                first = max(1, int(a))
                last = min(last, int(b) if b.strip().isdigit() else first)
        out, budget = [], 60_000
        for i in range(first - 1, last):
            try:
                txt = reader.pages[i].extract_text() or ""
            except Exception:
                txt = ""
            out.append(f"[page {i + 1}]\n{txt.strip()}")
            if sum(len(t) for t in out) > budget:
                out.append(f"[truncated at page {i + 1} of {len(reader.pages)}; "
                           "ask for a page range for the rest]")
                break
        return "\n\n".join(out)

    def _self_url(request) -> str:
        # This process IS the engine: self-calls go to the port THIS request
        # arrived on. context.json's engine_url can be stale (an earlier run
        # on another port), which turned every self-call into a 502.
        return "http://127.0.0.1:%d" % (
            (request.scope.get("server") or ("127.0.0.1", 7799))[1])

    def _tool_dispatch(name: str, args: dict, engine_url: str,
                       token) -> str:
        # ONE implementation behind both tool doors: the per-session stdio
        # bridge (/api/ai/tool-run, panel chats, token = that chat's channel)
        # and the direct /mcp endpoint (token None: any local MCP client).
        # Returns plain text; HTTPException carries tool errors either way.
        try:
            ctx = _json.loads((ai_dir / "context.json").read_text())
        except (OSError, ValueError):
            ctx = {}
        ctx["engine_url"] = engine_url
        if name == "open_in_app":
            view = str(args.get("view") or "")
            ev = None
            # view=chart is accepted as an alias of view=dataset: the page
            # it used to open (BACKTEST > CHARTS, a standalone chart of an
            # imported file) was removed, and the
            # closest thing the app has is the file's preview in Algo
            # Development. Kept so an older prompt or MCP client does not
            # break; the tool schema no longer advertises it.
            if view in ("dataset", "chart"):
                from lse_terminal.providers import userdata
                sym = str(args.get("name") or args.get("symbol")
                          or ctx.get("symbol") or "")
                if sym not in userdata.load_manifest():
                    raise HTTPException(404, f"no imported dataset named {sym!r}; "
                                        "list_datasets shows what exists")
                ev = {"type": "open_dataset", "symbol": sym}
            elif view == "file":
                rel = str(args.get("name") or args.get("path") or "")
                if not _ws_resolve(rel).is_file():
                    raise HTTPException(404, f"no workspace file {rel!r}")
                ev = {"type": "open_file", "path": rel}
            elif view == "section":
                sec = str(args.get("name") or args.get("section") or "")
                if sec not in UI_SECTIONS:
                    raise HTTPException(400, "unknown section; valid: "
                                        + ", ".join(sorted(UI_SECTIONS)))
                ev = {"type": "open_section", "section": sec}
            else:
                raise HTTPException(400, "view must be one of dataset, file, "
                                         "section")
            if ui_event_push(ev) == 0:
                return ("could not open: the LSE Terminal window is "
                        "not open right now")
            return f"opened in the app: {ev}"
        if name == "list_research":
            doc = research_feed()
            rows = doc.get("items", [])
            src = str(args.get("source") or "").strip().upper()
            cat = str(args.get("category") or "").strip().lower()
            if src:
                rows = [r for r in rows if r.get("source") == src]
            if cat:
                rows = [r for r in rows
                        if (r.get("category") or "").lower() == cat]
            lines = ["%s | %s | %s | %s | %s | %s" % (
                r.get("source", ""), (r.get("published") or "")[:10],
                r.get("category", ""), r.get("title", ""),
                ", ".join(r.get("authors") or []) or "authors n/a",
                r.get("link", "")) for r in rows[:60]]
            return "\n".join(lines) or "no papers match that filter"
        if name == "read_research_paper":
            deny_hosted()
            data = _research_pdf_bytes(str(args.get("link") or ""))
            return _pdf_text(data, str(args.get("pages") or ""))
        if name == "read_guide":
            return guide_section(str(args.get("section") or ""))
        if name == "list_workspace":
            out = []
            for pth in sorted(ws_dir().rglob("*")):
                if pth.is_file() and pth.suffix.lower() in WS_EXTS:
                    out.append(str(pth.relative_to(ws_dir())).replace("\\", "/"))
            return "\n".join(out) or "(workspace is empty)"
        if name == "read_workspace_file":
            pth = _ws_resolve(str(args.get("path") or ""))
            if not pth.is_file():
                raise HTTPException(404, f"no workspace file {args.get('path')!r}")
            if pth.stat().st_size > 512_000:
                raise HTTPException(413, "file too large; read it in the editor")
            return pth.read_text(errors="replace")
        if name == "write_workspace_file":
            rel = str(args.get("path") or "")
            content = str(args.get("content") or "")
            pth = _ws_resolve(rel)
            if pth.suffix.lower() not in WS_EXTS:
                raise HTTPException(400, f"only {', '.join(sorted(WS_EXTS))} files")
            # Consent parity for CLIs without Claude's permission bridge
            # (codex): route through the same Allow/Deny card in the chat.
            # Claude's own Edit/Write in ai-workspace stays as it was; this
            # tool is the cross-agent door into the STRATEGY workspace.
            # Direct /mcp callers (token None) have no panel to show a card
            # in and already passed their OWN CLI's permission prompt;
            # local = trusted by design, so they write.
            ch = approve_channels.get(token) or {}
            autonomy = ("full" if token is None else
                        (ch.get("state") or {}).get("autonomy", "ask"))
            recent = (ch.get("recent_allows") or {}).get(
                "write_workspace_file:" + rel, 0)
            if time.time() - recent < 180:
                autonomy = "edits"  # the user just allowed exactly this write
            if autonomy not in ("full", "edits"):
                import urllib.request as _rq
                port2 = ctx.get("engine_url", "http://127.0.0.1:7799")
                preview = content[:400] + ("..." if len(content) > 400 else "")
                req = _rq.Request(port2 + "/api/ai/approve-request",
                                  _json.dumps({"token": token,
                                               "tool_name": "write_workspace_file",
                                               "input": {"path": rel,
                                                         "preview": preview}}).encode(),
                                  {"Content-Type": "application/json"})
                try:
                    decision = _json.loads(_rq.urlopen(req, timeout=300).read())
                except Exception as e:
                    raise HTTPException(502, f"approval unavailable: {e}")
                if decision.get("behavior") != "allow":
                    raise HTTPException(403, decision.get("message")
                                        or "the user declined this write")
            pth.parent.mkdir(parents=True, exist_ok=True)
            # Self-write note: this tool pushes its own event immediately;
            # without the note the watcher would push a duplicate ~2s later.
            _ws_note_self_write(rel)
            pth.write_text(content, encoding="utf-8")
            ui_event_push({"type": "workspace_changed", "path": rel})
            return f"wrote {rel} ({len(content)} chars)"
        if name == "get_fills":
            # Closed trades and realised P&L, so "what was my last trade,
            # did it make money" is answerable from the agent's tools.
            # (NO local `import json as _json` in this function, ever: a
            # local import makes _json function-local for the WHOLE
            # function, so the ctx read at the top of _tool_dispatch dies
            # unbound and every native tool fails.)
            #
            # Broker-aware: the ticket may trade the hosted
            # sim OR any brue-connect broker, and this engine cannot see
            # which tab the page's ticket is on. So report EVERY account this
            # terminal is connected to, labelled by broker, and let the agent
            # match the dock's `broker` field from the screen map. When the
            # lse-sim broker is connected the hosted sim is SKIPPED: they are
            # the same account, and listing it twice reads as two accounts.
            import urllib.parse as _up
            import urllib.request as _rq
            base = ctx.get("engine_url", "http://127.0.0.1:7799")
            limit = max(1, min(int(args.get("limit") or 50), 500))

            def _fill_stats(fills):
                # realized_pnl is null on an OPENING fill and a number on a
                # closing one; summing the numbers gives realised P&L, and
                # saying so stops the agent reading null as a zero-profit
                # trade.
                closed = [f for f in fills
                          if f.get("realized_pnl") is not None]
                return {"fills": fills,
                        "realized_pnl_in_these_fills":
                            sum(f["realized_pnl"] for f in closed),
                        "closed_trades": len(closed),
                        "winners": len([f for f in closed
                                        if f["realized_pnl"] > 0])}

            accounts = []
            try:
                rows = _json.loads(_rq.urlopen(
                    base + "/api/broker/list", timeout=30).read())
            except Exception:
                rows = []
            connected = [r for r in rows if r.get("connected")]
            for row in connected:
                slug = row["broker"]
                try:
                    fills = _json.loads(_rq.urlopen(
                        base + "/api/broker/fills?broker="
                        + _up.quote(slug), timeout=30).read())
                except Exception as e:  # noqa: BLE001 - report, don't die
                    accounts.append({"broker": slug, "error": str(e)})
                    continue
                fills = sorted(fills, key=lambda f: f.get("time") or 0,
                               reverse=True)[:limit]
                accounts.append({"broker": slug,
                                 "label": row.get("label") or slug,
                                 **_fill_stats(fills)})
            if not any(r["broker"] == "lse-sim" for r in connected):
                try:
                    accts = _json.loads(_rq.urlopen(
                        base + "/api/sim/accounts", timeout=30).read())
                except Exception:
                    accts = []
                if accts:
                    acct = accts[0]
                    fills = _json.loads(_rq.urlopen(
                        base + f"/api/sim/fills?account_id={acct['id']}"
                        f"&limit={limit}", timeout=30).read())
                    accounts.append({"broker": "lse-hosted",
                                     "label": acct["name"],
                                     **_fill_stats(fills)})
            if not accounts:
                return ("no broker is connected and no sim account is open, "
                        "so there is no trade history.")
            return _json.dumps({
                "accounts": accounts,
                "note": "one entry per connected account; the dock shows the "
                        "one whose broker matches the screen map's acct-dock "
                        "region. realized_pnl is null on an opening fill and "
                        "a number on a closing one; a null is not a "
                        "zero-profit trade. The totals cover only the fills "
                        "returned, not the account's whole life, unless "
                        "limit reached them all.",
            }, default=str)
        if name == "get_positions":
            # Live account state as DATA. Exists because the agent can see
            # the screen and a vision model cannot read a P&L reliably: it
            # once transcribed the positions dock from pixels and
            # reported a winning EUR/JPY short as a losing "EURUSD".
            # Broker-aware, same shape as get_fills: one
            # entry per connected account (brokers via brue-connect, plus
            # the hosted sim unless lse-sim is connected, which IS the same
            # account). The dock shows the entry whose broker matches the
            # screen map's acct-dock region.
            import urllib.parse as _up
            import urllib.request as _rq
            base = ctx.get("engine_url", "http://127.0.0.1:7799")
            accounts = []
            try:
                rows = _json.loads(_rq.urlopen(
                    base + "/api/broker/list", timeout=30).read())
            except Exception:
                rows = []
            connected = [r for r in rows if r.get("connected")]
            for row in connected:
                slug = row["broker"]
                # A broker whose terms keep its prices on this computer
                # (SPEC 3.3): the account's own records are reported (its
                # balance, the sizes, sides and entry prices of its
                # positions); the current prices are market data, and so are
                # the figures marked to them (unrealised P/L, equity,
                # margin), which give them back, so none is; the entry says
                # so in one sentence.
                local = _local_refusal(slug, MARKED_TO_PRICE)
                try:
                    acct = _json.loads(_rq.urlopen(
                        base + "/api/broker/account?broker="
                        + _up.quote(slug), timeout=30).read())
                    poss = _json.loads(_rq.urlopen(
                        base + "/api/broker/positions?broker="
                        + _up.quote(slug), timeout=30).read())
                    # The broker's own quote cache prices its positions
                    # (broker symbols are the broker's spellings; /api/prices
                    # has never heard of them). Closing side, like the dock.
                    quotes = {} if local else _json.loads(_rq.urlopen(
                        base + "/api/broker/quotes?broker="
                        + _up.quote(slug), timeout=30).read())
                except Exception as e:  # noqa: BLE001 - report, don't die
                    accounts.append({"broker": slug, "error": str(e)})
                    continue
                if local:
                    from .broker_hub import (  # noqa: PLC0415
                        account_record_only, record_only)
                    # Each position keeps the sentence naming what it lost
                    # (the route gives one; a trailed stop is among them).
                    recs = []
                    for p in poss:
                        kept, dropped = record_only(p)
                        dropped = [d for d in dropped if d != "withheld"]
                        why = ((p.get("withheld") if isinstance(p, dict)
                                else None)
                               or (hub.withheld(slug, ", ".join(dropped))
                                   if dropped else None))
                        kept["price"] = None
                        if why:
                            kept["withheld"] = why
                        recs.append(kept)
                    poss = recs
                    accounts.append({"broker": slug,
                                     "label": row.get("label") or slug,
                                     "account": account_record_only(acct)[0],
                                     "positions": poss,
                                     "prices_withheld": local})
                    continue
                for pos in poss:
                    q = quotes.get(pos.get("symbol")) or {}
                    long_ = pos.get("side") != "sell"
                    pos["price"] = q.get("bid") if long_ else q.get("ask")
                accounts.append({"broker": slug,
                                 "label": row.get("label") or slug,
                                 "account": acct, "positions": poss})
            if not any(r["broker"] == "lse-sim" for r in connected):
                try:
                    accts = _json.loads(_rq.urlopen(
                        base + "/api/sim/accounts", timeout=30).read())
                except Exception:
                    accts = []
                if accts:
                    acct = accts[0]
                    poss = _json.loads(_rq.urlopen(
                        base + f"/api/sim/positions?account_id={acct['id']}",
                        timeout=30).read())
                    # /api/sim/positions carries no current price, and the
                    # UI's own quote cache only holds symbols that happen
                    # to be charted or on the watchlist. Prices come from
                    # /api/prices, which answers for any symbol. Closing
                    # side (bid exits a long, ask exits a short), the same
                    # convention as the dock.
                    if poss:
                        syms = ",".join(sorted({p["symbol"] for p in poss}))
                        try:
                            quotes = _json.loads(_rq.urlopen(
                                base + "/api/prices?provider=lse&symbols="
                                + _up.quote(syms, safe=","),
                                timeout=30).read())
                        except Exception:
                            quotes = []  # no feed: leave price null, say so
                        bysym = {q["symbol"]: q for q in quotes}
                        for pos in poss:
                            q = bysym.get(pos["symbol"])
                            if not q:
                                pos["price"] = None
                                continue
                            long_ = (pos.get("qty") or 0) > 0
                            pos["price"] = (q.get("bid") if long_
                                            else q.get("ask"))
                            pos["bid"] = q.get("bid")
                            pos["ask"] = q.get("ask")
                            # A price can be hours old on a closed market;
                            # the age travels with it or the agent states a
                            # stale number as current.
                            pos["price_ts"] = q.get("ts")
                    accounts.append({"broker": "lse-hosted",
                                     "label": acct.get("name"),
                                     "account": acct, "positions": poss})
            if not accounts:
                return ("no broker is connected and no sim account is open, "
                        "so there are no positions to report. Say exactly "
                        "that; do not describe an empty book as the user "
                        "having no positions.")
            return _json.dumps({"accounts": accounts,
                                "price_note": "price is marked at the closing "
                                "side (bid for a long, ask for a short); on "
                                "sim entries price_ts is when that quote was "
                                "taken and can be hours old on a closed "
                                "market. The dock shows the entry whose "
                                "broker matches the screen map."},
                               default=str)
        if name == "list_datasets":
            import urllib.request as _rq
            port = ctx.get("engine_url", "http://127.0.0.1:7799")
            return _rq.urlopen(port + "/api/data",
                               timeout=30).read().decode("utf-8", "replace")
        if name == "get_candles":
            import urllib.parse as _up
            import urllib.request as _rq
            prov = args.get("provider") or ctx.get("provider") or "lse"
            sym = args.get("symbol") or ctx.get("symbol") or ""
            # Refused, and said why, for a broker whose terms keep its
            # prices on this computer: the chart shows them, a model does not
            # get them (SPEC 3.3).
            why = _local_refusal(_source_broker(prov), f"{str(sym)[:40]} candles")
            if why:
                raise HTTPException(403, why)
            q = _up.urlencode({
                "provider": prov,
                "symbol": sym,
                "timeframe": args.get("timeframe") or ctx.get("timeframe") or "1h",
                "limit": min(int(args.get("limit") or 200), 500)})
            url = ctx.get("engine_url", "http://127.0.0.1:7799") + "/api/candles?" + q
            try:
                with _rq.urlopen(url, timeout=60) as response:
                    data = _json.loads(response.read())
                # Tool readers need explicit UTC dates, not mental epoch
                # arithmetic. Keep the chart API's original candle arrays.
                from datetime import datetime, timezone
                import re as _candle_re
                now = time.time()
                timeframe = str(data.get("timeframe") or
                                args.get("timeframe") or "1h")
                match = _candle_re.fullmatch(r"([1-9][0-9]*)([smhdw])", timeframe)
                width = (int(match[1]) * {"s": 1, "m": 60, "h": 3600,
                         "d": 86400, "w": 604800}[match[2]]) if match else None
                utc = lambda ts: datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")
                rows = [{"timestamp_utc": utc(row[0]),
                         "open": row[1], "high": row[2], "low": row[3],
                         "close": row[4], "volume": row[5],
                         "completed": row[0] + width <= now if width else None}
                        for row in data.get("candles", [])]
                data["as_of_utc"] = utc(now)
                data["candles_utc"] = rows
                data["latest_completed_candle"] = next(
                    (row for row in reversed(rows) if row["completed"]), None)
                return _json.dumps(data)
            except _rq.HTTPError as exc:
                # Keep the local candle handler's useful error, not request
                # headers or a key-bearing upstream URL. Bound unexpected bodies.
                body = exc.read(2048).decode("utf-8", "replace")
                try:
                    detail = _json.loads(body).get("detail", body)
                except (ValueError, AttributeError):
                    detail = body
                raise HTTPException(exc.code, str(detail)[:2048] or
                                    "Candle request failed") from None
        if name == "list_ml_models":
            payload = {
                "models": [{k: m.get(k) for k in
                            ("key", "name", "category", "description",
                             "params", "features_arg", "deps", "gpu")}
                           for m in ml_catalog.MODELS],
                "feature_ids": [f["id"] for f in ml_catalog.FEATURES],
                "built_datasets": [d["name"] for d in ml_blueprint.list_datasets()],
            }
            return _json.dumps(payload)
        if name == "generate_ml_blueprint":
            try:
                code = ml_blueprint.generate_code(
                    str(args.get("model", "")),
                    dataset=str(args.get("dataset") or ""),
                    timeframe=str(args.get("timeframe") or "1h"),
                    bars=int(args.get("bars") or 5000))
            except ValueError as e:
                raise HTTPException(400, str(e))
            return code
        if name == "build_ml_dataset":
            try:
                entry = ml_blueprint.build_dataset(
                    str(args.get("name", "")), str(args.get("source", "")),
                    timeframe=str(args.get("timeframe") or "1h"),
                    bars=int(args.get("bars") or 5000),
                    start=args.get("start") or None,
                    end=args.get("to") or args.get("end") or None,
                    features=args.get("features") or None)
            # NotSupported = timeframe finer than the import; tell the
            # assistant plainly so it retries at the native resolution.
            except (ValueError, NotSupported) as e:
                raise HTTPException(400, str(e))
            return _json.dumps(entry)
        if name == "run_ml_blueprint":
            code = str(args.get("code") or "")
            if not code.strip():
                raise HTTPException(400, "empty blueprint code")
            if ml_jobs.running_count() >= 2:
                raise HTTPException(429, "two trainings already running")
            job = ml_jobs.start_code(code)
            return _json.dumps(
                {"job_id": job.id, "status": job.status,
                 "note": "poll get_ml_job until status is not running"})
        if name == "get_ml_job":
            rec = ml_jobs.saved_results(str(args.get("job_id", "")))
            if rec is None:
                raise HTTPException(404, "unknown job")
            lines = rec.get("lines") or []
            rec["lines"] = lines[-40:]
            return _json.dumps(rec, default=str)
        if name == "run_backtest":
            import urllib.request as _rq
            # Python is the only strategy language; brue was removed as a
            # backtest engine.
            bt_engine = str(args.get("engine") or "python")
            script = args.get("script") or ""
            if not script and args.get("file"):
                p = _ws_resolve(str(args["file"]))
                if not p.is_file():
                    raise HTTPException(404, f"no workspace file {args['file']}")
                script = p.read_text(errors="replace")
            if not script:
                try:
                    script = (ai_dir / "strategy.py").read_text()
                except OSError:
                    pass
            if not script:
                raise HTTPException(400, "give script=<python code> or "
                                         "file=<workspace path>")
            options = {"extended_stats": True}
            if args.get("from"):
                options["from"] = str(args["from"])
            if args.get("to"):
                options["to"] = str(args["to"])
            # A `# run:` pin in the script names its dataset; it outranks
            # the ambient chart context but never an explicit argument.
            from lse_terminal.backtest.contract import parse_run_pin
            pin = parse_run_pin(script) or {}
            payload = {"engine": bt_engine,
                       # Python strategies test on the user's own datasets
                       # by default, matching the IDE.
                       "provider": args.get("provider") or ctx.get("provider")
                       or ("userdata" if bt_engine == "python" else "lse"),
                       "symbol": args.get("symbol") or pin.get("symbol")
                       or ctx.get("symbol") or "",
                       "timeframe": args.get("timeframe")
                       or pin.get("timeframe")
                       or ctx.get("timeframe") or "1h",
                       "script": script, "limit": 0, "options": options}
            # A backtest on a data_local_only broker's bars runs in the
            # terminal's own BACKTEST; its results carry the broker's prices,
            # so they are not handed to a model (SPEC 3.3).
            why = _local_refusal(_source_broker(payload["provider"]),
                                 f"Backtest results on {str(payload['symbol'])[:40]}")
            if why:
                raise HTTPException(403, why)
            req = _rq.Request(
                ctx.get("engine_url", "http://127.0.0.1:7799") + "/api/backtest",
                _json.dumps(payload).encode(), {"Content-Type": "application/json"})
            try:
                r = _json.loads(_rq.urlopen(req, timeout=150).read().decode())
            except Exception as e:
                detail = getattr(e, "read", lambda: b"")()
                # Models trained on backtesting.py (and on our own deleted
                # Strategy API) keep writing those dialects; hand the real
                # contract back WITH the error so the retry is written against
                # it instead of repeating the same guess.
                hint = (" | strategy contract reminder: PLAIN PYTHON, nothing "
                        "to import. `df` is a pandas DataFrame already in "
                        "scope (ts/open/high/low/close/volume). Leave a list "
                        "`trades` of dicts like "
                        "{'entry_i': 10, 'exit_i': 25, 'dir': 'long'}. "
                        "Indicators are pandas: df.close.ewm(span=9).mean(). "
                        "There is NO Strategy class, no init/next, no "
                        "self.buy, no self.sma, no self.I.")
                raise HTTPException(502, f"backtest failed: {detail[:400] or e}{hint}")
            stats = r.get("stats", {})
            lines = [f"{k}: {stats[k]}" for k in sorted(stats)] if isinstance(stats, dict) else [str(stats)]
            lines.append(f"trades: {len(r.get('trades', []))}")
            return "\n".join(lines)
        if name in ("run_montecarlo", "run_walkforward"):
            # Research pack: same script resolution as run_backtest, then
            # the engine's own quant endpoints (both engines support them
            # (the runner implements montecarlo/walkforward itself).
            import urllib.request as _rq
            bt_engine = str(args.get("engine") or "python")
            script = args.get("script") or ""
            if not script and args.get("file"):
                p = _ws_resolve(str(args["file"]))
                if not p.is_file():
                    raise HTTPException(404, f"no workspace file {args['file']}")
                script = p.read_text(errors="replace")
            if not script:
                raise HTTPException(400, "give script=<python code> or "
                                         "file=<workspace path>")
            options = {}
            if args.get("from"):
                options["from"] = str(args["from"])
            if args.get("to"):
                options["to"] = str(args["to"])
            # Same pin resolution as run_backtest: script > context.
            from lse_terminal.backtest.contract import parse_run_pin
            pin = parse_run_pin(script) or {}
            payload = {"engine": bt_engine,
                       "provider": args.get("provider") or ctx.get("provider")
                       or ("userdata" if bt_engine == "python" else "lse"),
                       "symbol": args.get("symbol") or pin.get("symbol")
                       or ctx.get("symbol") or "",
                       "timeframe": args.get("timeframe")
                       or pin.get("timeframe")
                       or ctx.get("timeframe") or "1h",
                       "script": script,
                       # Was capped at 5000 bars, which validated a strategy
                       # tested on 50k bars against its last few months
                       # only (a 4-fold walk-forward on hourly data got
                       # ~375-bar OOS slices, shorter than a 200-bar MA
                       # warmup). Same ceiling as run_backtest now; the
                       # combo guard below keeps the CPU bill bounded.
                       "limit": min(int(args.get("bars") or 2000), 100_000),
                       "options": options}
            why = _local_refusal(
                _source_broker(payload["provider"]),
                ("Monte Carlo" if name == "run_montecarlo" else "Walk-forward")
                + f" results on {str(payload['symbol'])[:40]}")
            if why:
                raise HTTPException(403, why)
            if name == "run_montecarlo":
                path = "/api/backtest/montecarlo"
                payload.update(runs=min(int(args.get("runs") or 1000), 100_000),
                               seed=int(args.get("seed") or 42))
            else:
                params = args.get("params") or {}
                if not isinstance(params, dict) or not params:
                    raise HTTPException(400, 'params must be an object like '
                                        '{"length": "10:50:10"} (lo:hi:step '
                                        'or v1,v2,...) with at least one entry')
                path = "/api/backtest/walkforward"
                # Every combo is one full backtest per fold on the train
                # window plus one on the test window. Long windows only get
                # small grids, so a sweep finishes inside the 300 s call
                # instead of chewing CPU for an hour after the caller gave up.
                if payload["limit"] > 5000:
                    from lse_terminal.backtest import research as _rs
                    combos = 1
                    for v in params.values():
                        try:
                            combos *= len(_rs.expand_param_spec(str(v)))
                        except ValueError as e:
                            raise HTTPException(400, f"param grid: {e}")
                    if combos > 24:
                        raise HTTPException(
                            400, f"{combos} combos over {payload['limit']} "
                                 "bars is too much work; on windows longer "
                                 "than 5000 bars keep the grid to 24 combos "
                                 "or fewer (a few values around your "
                                 "defaults), or pass bars<=5000")
                payload.update(params={str(k): str(v) for k, v in params.items()},
                               folds=int(args.get("folds") or 4),
                               train=float(args.get("train") or 0.7),
                               metric=str(args.get("metric") or "netProfit"))
            req = _rq.Request(
                ctx.get("engine_url", "http://127.0.0.1:7799") + path,
                _json.dumps(payload).encode(), {"Content-Type": "application/json"})
            try:
                return _rq.urlopen(req, timeout=300).read().decode("utf-8", "replace")
            except Exception as e:
                detail = getattr(e, "read", lambda: b"")()
                raise HTTPException(502, f"{name} failed: "
                                    + ((detail or b"").decode("utf-8", "replace")[:400]
                                       or str(e)))
        if name == "get_economics":
            import urllib.parse as _up
            import urllib.request as _rq
            q = {"region": str(args.get("region") or args.get("country") or ""),
                 "event": str(args.get("event") or ""),
                 "order": str(args.get("order") or "asc"),
                 "released": 1 if args.get("released_only") else 0,
                 "limit": min(int(args.get("limit") or 300), 1000)}
            if args.get("from"):
                q["start"] = str(args["from"])
            if args.get("to"):
                q["end"] = str(args["to"])
            url = (ctx.get("engine_url", "http://127.0.0.1:7799")
                   + "/api/economic-calendar?" + _up.urlencode(q))
            try:
                return _rq.urlopen(url, timeout=60).read().decode("utf-8", "replace")
            except Exception as e:
                detail = getattr(e, "read", lambda: b"")()
                raise HTTPException(502, "economics failed: "
                                    + ((detail or b"").decode("utf-8", "replace")[:300]
                                       or str(e)))
        if name == "import_lse_data":
            # The databank import modal as a tool: submit the paged import,
            # then wait a bounded while. Long histories outlive the wait;
            # the job_id comes back so a later call can finish the check.
            import urllib.request as _rq
            port = ctx.get("engine_url", "http://127.0.0.1:7799")
            job_id = str(args.get("job_id") or "")
            if not job_id:
                body = {"dataset": str(args.get("dataset") or ""),
                        "symbol": str(args.get("symbol") or ""),
                        "timeframe": str(args.get("timeframe") or "1h"),
                        "start": str(args.get("from") or ""),
                        "end": str(args.get("to") or ""),
                        "folder": str(args.get("folder") or "LSE")}
                if not body["dataset"]:
                    raise HTTPException(400, "dataset required, e.g. fx, "
                                        "stocks, crypto, etf, index, commodity")
                req = _rq.Request(port + "/api/lse/databank/import",
                                  _json.dumps(body).encode(),
                                  {"Content-Type": "application/json"})
                try:
                    job_id = _json.loads(_rq.urlopen(req, timeout=30).read())["job_id"]
                except Exception as e:
                    raw = (getattr(e, "read", lambda: b"")() or b"").decode("utf-8", "replace")
                    try:
                        msg = _json.loads(raw).get("detail") or raw
                    except Exception:
                        msg = raw or str(e)
                    code = getattr(e, "code", None)
                    raise HTTPException(code if isinstance(code, int) and 400 <= code < 500 else 502,
                                        f"databank submit failed: {str(msg)[:300]}")
            deadline = time.time() + 90
            job: dict = {}
            while time.time() < deadline:
                try:
                    job = _json.loads(_rq.urlopen(
                        port + f"/api/lse/databank/import/{job_id}",
                        timeout=15).read())
                except Exception as e:
                    raise HTTPException(502, f"job poll failed: {e}")
                if job.get("status") in ("done", "saved", "failed"):
                    break
                time.sleep(2)
            job["job_id"] = job_id
            if job.get("status") not in ("done", "saved", "failed"):
                job["note"] = ("still running; call import_lse_data again "
                               f"with job_id=\"{job_id}\" to check")
            return _json.dumps(job)
        # ── the web ──
        # THIS machine fetches, on the user's own connection, exactly like the
        # research paper reader above. Nothing is proxied through LSE: we do
        # not want to carry a user's page traffic or put an LSE IP behind every
        # site they ask about.
        if name in ("web_search", "fetch_url", "browse"):
            from lse_terminal.engine import webtools
            if name == "web_search":
                return _json.dumps(webtools.search(
                    str(args.get("query") or ""),
                    str(args.get("category") or "web"),
                    str(args.get("recency") or ""),
                    int(args.get("limit") or 6)))
            if name == "fetch_url":
                return _json.dumps(webtools.fetch(
                    str(args.get("url") or ""),
                    int(args.get("max_chars") or 8000)))
            return _json.dumps(webtools.browse(
                str(args.get("url") or ""),
                int(args.get("max_chars") or 8000)))
        if name == "run_python":
            import subprocess
            code = str(args.get("code") or "")
            rel = str(args.get("file") or "").strip()
            if rel and not code:
                p = _ws_resolve(rel)
                if not p.is_file():
                    raise HTTPException(404, f"no workspace file {rel!r}")
                code = p.read_text()
            if not code.strip():
                raise HTTPException(400, "run_python needs code= or file=")
            # Timeout is generous but hard: an agent's exploratory script that
            # blocks on input() or a runaway loop must not pin a chat turn open
            # forever. Runs in the workspace so relative paths behave the same
            # as they do in the WORKSPACE tab's own terminal.
            secs = max(5, min(int(args.get("timeout") or 120), 600))
            # The workspace is created lazily by the chat panel, so on a fresh
            # install run_python is reachable before anything has made the
            # directory. Caught by the sidecar smoke test on a clean
            # config, where the first call died with ENOENT on the temp script.
            ai_dir.mkdir(parents=True, exist_ok=True)
            script = ai_dir / "_agent_run.py"
            script.write_text(code)
            _ws_note_self_write("_agent_run.py")
            # In the frozen desktop build sys.executable IS lset-server.exe,
            # not a Python interpreter, so running [sys.executable, script]
            # re-invoked the sidecar with the script as an argv and it exited
            # with "unrecognized arguments" (caught by the sidecar
            # smoke test; the source install never sees it). Re-enter through
            # the CLI's own --run-script, the same door the WORKSPACE terminal
            # uses, which also guarantees the bundled pandas/numpy are
            # importable rather than whatever a stray system python has.
            if getattr(sys, "frozen", False):
                run_argv = [sys.executable, "--run-script", str(script)]
            else:
                run_argv = [sys.executable, "-m", "lse_terminal.cli",
                            "--run-script", str(script)]
            try:
                proc = subprocess.run(
                    run_argv, cwd=str(ai_dir),
                    capture_output=True, text=True, timeout=secs)
            except subprocess.TimeoutExpired:
                return _json.dumps({"error": f"timed out after {secs}s",
                                    "hint": "make it finish faster or raise timeout"})
            out = (proc.stdout or "")[-20000:]
            err = (proc.stderr or "")[-4000:]
            return _json.dumps({"exit_code": proc.returncode, "stdout": out,
                                "stderr": err,
                                "note": "" if out.strip() or err.strip() else
                                        "the script printed nothing; print() what you "
                                        "want to see"})
        # ── memory across chats ──
        # A flat JSON list in the config dir. Deliberately small and readable:
        # it is the user's file, they should be able to open it and see exactly
        # what the assistant has been told to remember about them.
        if name in ("remember", "recall"):
            mem_path = cfg.config_dir() / "assistant_memory.json"

            def _mem_load():
                try:
                    return _json.loads(mem_path.read_text())
                except (OSError, ValueError):
                    return []

            def _mem_save(items):
                mem_path.write_text(_json.dumps(items, indent=1))

            items = _mem_load()
            if name == "remember":
                note = str(args.get("note") or "").strip()[:500]
                if not note:
                    raise HTTPException(400, "remember needs a note")
                if any(m.get("note") == note for m in items):
                    return _json.dumps({"ok": True, "note": "already remembered"})
                nid = max([m.get("id", 0) for m in items] or [0]) + 1
                items.append({"id": nid, "note": note,
                              "at": time.strftime("%Y-%m-%d")})
                # Cap it. An unbounded list would grow into every future chat's
                # opening prompt and slowly crowd out the actual question.
                _mem_save(items[-100:])
                return _json.dumps({"ok": True, "id": nid, "stored": note})
            forget = args.get("forget_id")
            if forget is not None:
                keep = [m for m in items if m.get("id") != int(forget)]
                _mem_save(keep)
                return _json.dumps({"ok": True, "forgot": int(forget),
                                    "remaining": len(keep)})
            return _json.dumps({"memories": items, "file": str(mem_path)})
        raise HTTPException(404, f"unknown tool {name}")

    # ── Direct MCP endpoint ────────────────────────────────────────────
    # The terminal IS the local hub: any MCP client on this machine (the
    # panel's CLIs, a Claude Code session in an IDE, Claude Desktop, a
    # future broker assistant) connects to http://127.0.0.1:<port>/mcp and
    # gets the SAME tools as the panel, full sight. Deliberately NO tokens,
    # NO scopes: the engine already serves its whole API unauthenticated on
    # loopback, the caller is the user's own agent with normal machine
    # access, and consent lives in that agent's own permission prompts.
    # The only boundary that matters is the existing one: loopback binding
    # plus deny_hosted so the shared web build never exposes this.
    # Streamable HTTP, stateless: JSON-RPC request in the POST body, JSON
    # response out, notifications get 202. No Mcp-Session-Id is issued and
    # no server-initiated stream exists, so GET is 405 per spec.
    from lse_terminal.engine.approve_bridge import CAPABILITY_TOOLS

    @app.get("/api/ai/tools")
    def ai_tools():
        # The tool-browser strip under the chat header. Serves the SAME
        # menu the agents get (CAPABILITY_TOOLS), so what the user browses
        # and what is actually callable can never drift apart. Names,
        # descriptions and parameter names only; nothing here is runnable,
        # which is why this one stays open where /mcp is deny_hosted.
        return {"tools": [
            {"name": t["name"], "description": t["description"],
             "params": list(((t.get("inputSchema") or {})
                             .get("properties") or {}).keys())}
            for t in CAPABILITY_TOOLS]}

    def _mcp_reply(m: dict, engine_url: str):
        mid = m.get("id")
        method = m.get("method")
        if mid is None:
            return None  # notification: nothing to say back
        if method == "initialize":
            return {"jsonrpc": "2.0", "id": mid, "result": {
                # Echo the client's version, like the stdio bridge: we only
                # announce tools, so every protocol revision is satisfiable.
                "protocolVersion": (m.get("params") or {}).get(
                    "protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "lse-terminal",
                               "version": __version__}}}
        if method == "ping":
            return {"jsonrpc": "2.0", "id": mid, "result": {}}
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": mid,
                    "result": {"tools": CAPABILITY_TOOLS}}
        if method == "tools/call":
            p = m.get("params") or {}
            try:
                text = _tool_dispatch(str(p.get("name", "")),
                                      p.get("arguments") or {},
                                      engine_url, None)
                result = {"content": [{"type": "text",
                                       "text": text[:100_000]}]}
            except HTTPException as e:
                # Tool-level failure: isError result, not a protocol error,
                # so the model reads the message and can retry sensibly.
                result = {"content": [{"type": "text",
                                       "text": f"tool failed: {e.detail}"}],
                          "isError": True}
            except Exception as e:
                result = {"content": [{"type": "text",
                                       "text": f"tool failed: {e}"}],
                          "isError": True}
            return {"jsonrpc": "2.0", "id": mid, "result": result}
        return {"jsonrpc": "2.0", "id": mid,
                "error": {"code": -32601, "message": f"unknown method {method}"}}

    @app.post("/mcp")
    async def mcp_http(request: Request):
        deny_hosted()
        own_origin_only(request)
        from fastapi import Response
        from fastapi.concurrency import run_in_threadpool
        from fastapi.responses import JSONResponse
        try:
            msg = _json.loads(await request.body())
        except ValueError:
            return JSONResponse(
                {"jsonrpc": "2.0", "id": None,
                 "error": {"code": -32700, "message": "parse error"}},
                status_code=400)
        engine_url = _self_url(request)
        batch = isinstance(msg, list)
        # Threadpool because tools block (backtests run up to 150s) and this
        # handler is async: the event loop must stay free for the UI.
        replies = [r for m in (msg if batch else [msg])
                   if isinstance(m, dict)
                   for r in [await run_in_threadpool(_mcp_reply, m, engine_url)]
                   if r is not None]
        if not replies:
            return Response(status_code=202)  # notification(s) only
        return JSONResponse(replies if batch else replies[0])

    @app.get("/mcp")
    def mcp_http_get():
        deny_hosted()
        raise HTTPException(405, "POST JSON-RPC here; this MCP server opens "
                                 "no server-initiated stream")

    # ── In-chat permission prompts (Phase 1 autonomy) ─────────────────
    # One channel per live claude chat connection: token -> {emit, pending}.
    # The MCP bridge (engine/approve_bridge.py, spawned by the claude CLI)
    # posts here; the request becomes an Allow/Deny card over the chat ws
    # and the click resolves the awaited future.
    approve_channels: dict = {}

    def _always_rules() -> list:
        v = cfg.load().get("ai_always_allow")
        return v if isinstance(v, list) else []

    # Words of a command that would place, change, cancel or close an order
    # through the engine, arm a connection, or trade beside it with the kit's
    # own runner or connector.
    _TRADING_WORDS = ("/api/broker/order", "/api/broker/close",
                      "/api/broker/modify", "/api/broker/arm",
                      "live_driver", "brueconnect")

    def _hand_live() -> bool:
        """True while a live connection's broker has every order on a live
        account placed by the user (SPEC 3.3)."""
        try:
            return any(hub.by_hand(b) for b, c in list(hub.conns.items())
                       if getattr(c, "alive", False))
        except Exception:  # noqa: BLE001 - cannot tell: the careful answer
            return True

    def _always_matches(tool: str, tool_input: dict) -> bool:
        # An "always allow" never covers an order while such a connection is
        # live: the card is shown every time. (The engine refuses such an
        # order from a program anyway; this keeps the user's earlier "always"
        # from waving one through unseen.)
        if (tool == "Bash" and _hand_live()
                and any(w in str((tool_input or {}).get("command", ""))
                        for w in _TRADING_WORDS)):
            return False
        for r in _always_rules():
            if r.get("tool") != tool:
                continue
            if tool == "Bash":
                pref = r.get("prefix", "")
                if pref and str(tool_input.get("command", "")).startswith(pref):
                    return True
            else:
                return True
        return False

    def _always_remember(tool: str, tool_input: dict) -> None:
        rules = _always_rules()
        entry = {"tool": tool}
        if tool == "Bash":
            # First word of the command: "always allow git" style, matching
            # how people reason about it, without whitelisting arbitrary
            # full command lines.
            first = str(tool_input.get("command", "")).strip().split(" ")[0]
            if not first:
                return
            entry["prefix"] = first
        if entry in rules:
            return
        rules.append(entry)
        c = cfg.load()
        c["ai_always_allow"] = rules
        cfg.save(c)

    @app.post("/api/ai/approve-request")
    async def ai_approve_request(body: AiApproveIn):
        deny_hosted()
        ch = approve_channels.get(body.token)
        if not ch:
            return {"behavior": "deny", "message": "no active chat session"}
        if _always_matches(body.tool_name, body.input):
            return {"behavior": "allow", "updatedInput": body.input}
        import uuid as _uuid
        pid = _uuid.uuid4().hex[:12]
        fut = asyncio.get_running_loop().create_future()
        ch["pending"][pid] = fut
        await ch["emit"]({"type": "permission", "pid": pid,
                          "tool": body.tool_name,
                          "detail": _ai_tool_detail(body.tool_name, body.input)})
        try:
            decision, always = await asyncio.wait_for(fut, 280)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            decision, always = "deny", False
        finally:
            ch["pending"].pop(pid, None)
        if decision == "allow":
            if always:
                _always_remember(body.tool_name, body.input)
            # Capability tools double-check consent engine-side (that path
            # serves CLIs without a permission bridge); remember this allow
            # so the same action does not ask twice in one breath.
            key = (body.tool_name.rsplit("__", 1)[-1] + ":"
                   + str((body.input or {}).get("path") or ""))
            ch.setdefault("recent_allows", {})[key] = time.time()
            return {"behavior": "allow", "updatedInput": body.input}
        return {"behavior": "deny",
                "message": "the user declined this action in LSE Terminal"}

    # ── Chat log on disk ──────────────────────────────────────────────
    # Conversations used to live only in the browser's localStorage: capped at
    # 40, wiped by a cache clear, invisible to the user as files, and gone
    # entirely if they open the app from a different origin. What the user
    # needs is a real log on their own PC that they can keep, so every
    # chat is now also a JSON file under the config dir. localStorage stays as
    # the fast read path; disk is the record.
    #
    # Each file also carries `sid`, the agent CLI's own session id. That is
    # what makes "open an old chat" resume the CONVERSATION rather than just
    # redisplay it: see the resume message in the chat socket below.
    chats_dir = cfg.config_dir() / "chats"

    def _chat_path(cid: str) -> Path:
        # Ids come from the browser, so treat them as hostile: keep the
        # characters we generate and nothing else, then confirm the resolved
        # path really is inside chats_dir before any read or write.
        import re as _re_chat  # local: `re` is not a name in this scope
        safe = _re_chat.sub(r"[^A-Za-z0-9_-]", "", str(cid))[:64]
        if not safe:
            raise HTTPException(400, "bad chat id")
        p = (chats_dir / (safe + ".json")).resolve()
        if p.parent != chats_dir.resolve():
            raise HTTPException(400, "bad chat id")
        return p

    @app.get("/api/ai/chats")
    def ai_chats_list():
        deny_hosted()
        out = []
        if chats_dir.is_dir():
            for p in chats_dir.glob("*.json"):
                try:
                    d = json.loads(p.read_text())
                except (OSError, ValueError):
                    continue  # a half-written file must not break the list
                out.append({"id": d.get("id") or p.stem,
                            "agent": d.get("agent") or "",
                            "title": d.get("title") or "Untitled chat",
                            "ts": d.get("ts") or int(p.stat().st_mtime * 1000),
                            "model": d.get("model") or "",
                            "effort": d.get("effort") or "",
                            "sid": d.get("sid") or "",
                            "turns": len([m for m in (d.get("msgs") or [])
                                          if m.get("kind") == "user"])})
        out.sort(key=lambda c: c["ts"], reverse=True)
        return {"chats": out, "dir": str(chats_dir)}

    @app.get("/api/ai/chats/{cid}")
    def ai_chat_get(cid: str):
        deny_hosted()
        p = _chat_path(cid)
        if not p.is_file():
            raise HTTPException(404, "no such chat")
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            raise HTTPException(500, "chat file is unreadable")

    @app.put("/api/ai/chats/{cid}")
    def ai_chat_put(cid: str, body: dict):
        deny_hosted()
        chats_dir.mkdir(parents=True, exist_ok=True)
        p = _chat_path(cid)
        doc = {"id": cid,
               "agent": str(body.get("agent") or "")[:32],
               "sid": str(body.get("sid") or "")[:128],
               "title": str(body.get("title") or "Untitled chat")[:200],
               "ts": int(body.get("ts") or (time.time() * 1000)),
               "model": str(body.get("model") or "")[:100],
               "effort": str(body.get("effort") or "")[:16],
               "msgs": body.get("msgs") or []}
        # Atomic write: the UI saves on every turn boundary, and a crash
        # mid-write would otherwise leave a truncated file that reads as a
        # lost conversation, which is the exact complaint this fixes.
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=1))
        tmp.replace(p)
        return {"ok": True, "path": str(p)}

    @app.delete("/api/ai/chats/{cid}")
    def ai_chat_delete(cid: str):
        deny_hosted()
        p = _chat_path(cid)
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            raise HTTPException(500, f"could not delete: {e}")
        return {"ok": True}

    @app.websocket("/api/ai/chat")
    async def ai_chat(websocket: WebSocket):
        await websocket.accept()
        if await deny_hosted_ws(websocket):
            return
        if await deny_other_origin_ws(websocket):
            return
        agent = websocket.query_params.get("agent", "claude")
        if agent not in AI_AGENTS:
            agent = "claude"
        spec = AI_AGENTS[agent]
        if hosted:
            await websocket.send_json({"type": "error",
                                       "message": "The AI panel only runs in the local terminal."})
            await websocket.close()
            return
        import shutil
        import signal
        import subprocess
        agent_bin = shutil.which(spec["binary"])
        if not agent_bin:
            await websocket.send_json({"type": "missing", "agent": agent,
                                       "hint": spec["install"]})
            await websocket.close()
            return
        ai_dir.mkdir(parents=True, exist_ok=True)
        # sid: session token from the first turn (claude session_id, codex
        # thread_id) or True for CLIs that resume by directory recency.
        # autonomy: "ask" (every risky action prompts in-chat), "edits"
        # (file edits auto-approved, commands still prompt), "full"
        # (claude --dangerously-skip-permissions; UI consent-gated).
        state = {"sid": None, "proc": None, "task": None, "autonomy": "ask"}

        async def emit(payload):
            try:
                await websocket.send_json(payload)
            except Exception:
                pass  # panel closed mid-turn; the finally clause reaps

        # Permission bridge (claude only): register this connection's channel
        # and write the one-line MCP config claude will be launched with.
        import sys as _sys
        import uuid as _uuid
        approve_token = _uuid.uuid4().hex
        mcp_cfg_path = None
        # Every agent gets a token + channel: the capability tools (and the
        # write-approval card) are agent-agnostic; only the transport of the
        # MCP config differs (claude: --mcp-config file; codex: -c overrides).
        approve_channels[approve_token] = {"emit": emit, "pending": {},
                                           "state": state}
        port = (websocket.scope.get("server") or ("127.0.0.1", 7799))[1]
        if getattr(_sys, "frozen", False):
            bridge_cmd, bridge_pre = _sys.executable, []
        else:
            bridge_cmd, bridge_pre = _sys.executable, ["-m", "lse_terminal.cli"]
        base_args = bridge_pre + ["--approve-bridge",
                                  "--engine-port", str(port),
                                  "--engine-token", approve_token]
        if agent == "claude":
            mcp_cfg_path = cfg.config_dir() / f"approve-{approve_token[:8]}.json"
            # Two servers from the same bridge binary: the approval prompt
            # tool, and the terminal's own capabilities (Phase 5) so the
            # agent runs backtests / reads data as clean native tool calls.
            # Written whole or not at all: a temporary file beside it (named
            # so no reader of approve-*.json finds it), synced, then renamed
            # into place, so whoever reads it the moment it appears reads it
            # all. The owner's alone (mode 0600): it carries the engine token.
            _write_whole(mcp_cfg_path, _json.dumps({"mcpServers": {
                "lse_approver": {"command": bridge_cmd, "args": base_args},
                "lse_terminal": {"command": bridge_cmd,
                                 "args": base_args + ["--bridge-role", "tools"]},
            }}))

        async def parse_claude_json(line):
            try:
                d = _json.loads(line)
            except ValueError:
                return
            t = d.get("type")
            if t == "system" and d.get("subtype") == "init":
                state["sid"] = d.get("session_id") or state["sid"]
                # Ship the session id to the panel so it can store it with the
                # chat. Without it a reopened chat could only redisplay text;
                # with it, "resume" below hands the CLI back its own thread.
                await emit({"type": "meta", "model": d.get("model", ""),
                            "sid": state["sid"] if isinstance(state["sid"], str) else ""})
            elif t == "assistant":
                for block in (d.get("message") or {}).get("content", []):
                    if block.get("type") == "text" and block.get("text"):
                        await emit({"type": "text", "text": block["text"]})
                    elif block.get("type") == "tool_use":
                        # Tool card open: ship enough of the input for the
                        # UI to show the command, or a real diff for edits.
                        name = block.get("name", "tool")
                        inp = block.get("input") or {}
                        payload = {"type": "tool_start",
                                   "id": block.get("id", ""), "name": name,
                                   "detail": _ai_tool_detail(name, inp)}
                        if name == "Bash":
                            payload["command"] = str(inp.get("command", ""))[:2000]
                        elif name in ("Edit", "MultiEdit"):
                            payload["file"] = str(inp.get("file_path", ""))
                            payload["old"] = str(inp.get("old_string", ""))[:4000]
                            payload["new"] = str(inp.get("new_string", ""))[:4000]
                        elif name == "Write":
                            payload["file"] = str(inp.get("file_path", ""))
                            # Whole scripts must survive the card; the user
                            # wants to see the code it ran.
                            payload["new"] = str(inp.get("content", ""))[:8000]
                        await emit(payload)
            elif t == "user":
                # Tool results echo back as user-role tool_result blocks.
                for block in (d.get("message") or {}).get("content", []):
                    if not (isinstance(block, dict)
                            and block.get("type") == "tool_result"):
                        continue
                    content = block.get("content")
                    if isinstance(content, list):
                        out = "\n".join(c.get("text", "") for c in content
                                        if isinstance(c, dict))
                    else:
                        out = str(content or "")
                    await emit({"type": "tool_result",
                                "id": block.get("tool_use_id", ""),
                                "output": out[:4000],
                                "is_error": bool(block.get("is_error"))})
            elif t == "result":
                if d.get("is_error"):
                    await emit({"type": "error",
                                "message": str(d.get("result", ""))[:500]})

        async def parse_codex_json(line):
            try:
                d = _json.loads(line)
            except ValueError:
                return
            t = d.get("type")
            if t == "thread.started":
                state["sid"] = d.get("thread_id") or state["sid"]
                # Same purpose as claude's init emit above: the panel stores
                # this with the chat so reopening it resumes the thread.
                await emit({"type": "meta", "model": "",
                            "sid": state["sid"] if isinstance(state["sid"], str) else ""})
            elif t == "item.started":
                item = d.get("item") or {}
                if item.get("type") == "command_execution":
                    await emit({"type": "tool_start",
                                "id": str(item.get("id", "")), "name": "shell",
                                "detail": str(item.get("command", ""))[:200],
                                "command": str(item.get("command", ""))[:2000]})
            elif t == "item.completed":
                item = d.get("item") or {}
                it = item.get("type")
                if it == "agent_message" and item.get("text"):
                    await emit({"type": "text", "text": item["text"]})
                elif it == "command_execution":
                    # Card may or may not exist (item.started coverage varies
                    # by codex version); the UI upserts by id either way.
                    await emit({"type": "tool_start",
                                "id": str(item.get("id", "")), "name": "shell",
                                "detail": str(item.get("command", ""))[:200],
                                "command": str(item.get("command", ""))[:2000]})
                    await emit({"type": "tool_result",
                                "id": str(item.get("id", "")),
                                "output": str(item.get("aggregated_output", ""))[:4000],
                                "is_error": item.get("exit_code") not in (0, None)})
                elif it == "file_change":
                    changes = item.get("changes") or []
                    paths = ", ".join(str(c.get("path", "")) for c in changes[:3])
                    await emit({"type": "tool_start", "id": str(item.get("id", "")),
                                "name": "edit", "detail": paths[:200]})
                    await emit({"type": "tool_result", "id": str(item.get("id", "")),
                                "output": "", "is_error": False})
            elif t == "turn.failed":
                err = (d.get("error") or {}).get("message", "turn failed")
                await emit({"type": "error", "message": str(err)[:500]})

        def screen_note():
            # Stamped onto EVERY turn: the agent must never claim it cannot
            # see the screen. The desktop shell snapshots the window into
            # chart.png right before each send; the current page comes from
            # context.json (written by the same send). Added
            # after Claude answered "I can't see your screen" with a valid
            # screenshot on disk: the capability lived only in the brief,
            # which a model may skip; the per-turn stamp cannot be skipped.
            import json as _json
            view = ""
            try:
                view = (_json.loads((ai_dir / "context.json").read_text())
                        .get("view") or "")
            except (OSError, ValueError):
                pass
            png = ai_dir / "chart.png"
            parts = []
            if view:
                parts.append(f"the user is on {view}")
            # A broker's terms can keep its prices off any picture an agent
            # is given (SPEC 3.3): the file goes, and the turn says why.
            shot = _screen_withheld()
            if shot:
                _drop_screenshot()
                parts.append(shot)
            elif png.exists():
                age = int(time.time() - png.stat().st_mtime)
                parts.append(
                    f"a screenshot of their window is at {png} "
                    f"({age}s old" + ("; may be stale" if age > 120 else "")
                    + "); Read it before answering anything about what is "
                    "on screen")
            if not parts:
                return ""
            return "[Screen: " + "; ".join(parts) + ".]\n\n"

        async def run_turn(text, model="", effort=""):
            if state["sid"] is None:
                # The full brief rides INSIDE the first turn so setup is
                # effortless for the user: a pointer-only
                # note made the agent open with a visible "let me read the
                # documentation" Read step, and models sometimes skipped it
                # entirely. The file stays on disk for re-reads; this is
                # push, not a replacement.
                try:
                    brief_text = (ai_dir / "LSE-TERMINAL.md").read_text()
                except OSError:
                    brief_text = ""
                # What the assistant has been asked to remember about this
                # user, pushed into the opening turn. A `recall` tool alone was
                # not enough: a model with no reason to suspect it has memory
                # simply never calls it, and the user experiences the same
                # amnesia as before. Push, with the tool for edits.
                mem_block = ""
                try:
                    mems = _json.loads(
                        (cfg.config_dir() / "assistant_memory.json").read_text())
                    lines = [f"- {m['note']}" for m in mems if m.get("note")][-40:]
                    if lines:
                        mem_block = ("\n<what-you-remember-about-this-user>\n"
                                     + "\n".join(lines)
                                     + "\n</what-you-remember-about-this-user>\n"
                                     "[Use these naturally. Do not recite them "
                                     "back. `remember` adds one, `recall` "
                                     "lists or deletes.]\n")
                except (OSError, ValueError, KeyError, TypeError):
                    pass  # no memory file yet, or it was hand-edited badly
                text = (
                    "[Context: this chat runs inside LSE Terminal, a local "
                    "backtesting app on the user's machine; you are the "
                    "user's own agent CLI with your normal access to their "
                    "computer. The app brief follows; you have already read "
                    "it, never announce reading docs. PREFER the "
                    "lse_terminal MCP tools (run_backtest, run_walkforward, "
                    "run_montecarlo, get_candles, import_lse_data) over "
                    "hand-rolled analysis scripts: their numbers match the "
                    "terminal's own UI, a private pandas loop's do not. You "
                    "also have web_search and fetch_url: your training data "
                    "has a cutoff and the user is asking today, so search "
                    "before answering anything about current rates, releases, "
                    "news or policy, and cite the URL.]\n"
                    + ("\n<lse-terminal-brief>\n" + brief_text
                       + "\n</lse-terminal-brief>\n" if brief_text else
                       f"[Brief unavailable; read {ai_dir}/LSE-TERMINAL.md.]\n")
                    + mem_block
                    + "\n" + text)
            text = screen_note() + text
            argv = (spec["resume"](state["sid"], model) if state["sid"]
                    else spec["first"](model))
            argv = [agent_bin] + argv[1:]
            # Effort tier, claude only (its --effort takes low..max; other
            # CLIs have no equivalent flag).
            if effort and agent == "claude" and effort in (
                    "low", "medium", "high", "xhigh", "max"):
                argv += ["--effort", effort]
            if agent == "claude":
                key_args = _claude_key_args()
                if key_args:
                    argv += key_args
                # Autonomy (Phase 1): full = the CLI's own skip-permissions
                # mode (consent-gated in the UI); otherwise the permission
                # bridge turns every would-be denial into an in-chat
                # Allow/Deny card. "edits" additionally auto-accepts file
                # edits via the CLI's native acceptEdits mode.
                level = state["autonomy"]
                extra = []
                if mcp_cfg_path is not None:
                    # The capability tools ride along in EVERY mode; only
                    # the approval routing differs per level.
                    extra += ["--mcp-config", str(mcp_cfg_path)]
                if level == "full":
                    extra += ["--dangerously-skip-permissions"]
                elif mcp_cfg_path is not None:
                    extra += ["--permission-prompt-tool",
                              "mcp__lse_approver__approve"]
                    if level == "edits":
                        extra += ["--permission-mode", "acceptEdits"]
                argv += extra
            if agent == "codex":
                # Same capability toolset as claude, transported codex-style:
                # -c mcp_servers.* config overrides (valid on exec AND exec
                # resume, like sandbox_mode below). JSON encoding doubles as
                # TOML: basic strings and arrays parse identically. Codex
                # has no --permission-prompt-tool; consent for writes runs
                # engine-side inside the write_workspace_file tool instead.
                toolsrv_args = base_args + ["--bridge-role", "tools"]
                extra = ["-c", "mcp_servers.lse_terminal.command="
                         + _json.dumps(bridge_cmd),
                         "-c", "mcp_servers.lse_terminal.args="
                         + _json.dumps(toolsrv_args),
                         # codex's own web search, off by default. `--search`
                         # exists but only on the interactive command; on exec
                         # and exec resume it is rejected (verified against
                         # 0.142.5), so use the config key it maps to, which
                         # both accept. codex also has our web_search tool via
                         # the MCP server above; this just lets it use its
                         # native one when that suits it better.
                         "-c", "features.web_search=true"]
                argv += extra
            # Windows: OpenAI's sandbox runner can hang at process creation
            # (seen live). With the user's explicit consent we skip it via
            # the config override, which unlike -s is valid on exec AND
            # exec resume (both verified on the affected machine).
            if (agent == "codex" and os.name != "posix"
                    and cfg.load().get("ai_codex_full_access")):
                argv += ["-c", 'sandbox_mode="danger-full-access"']
            argv = _direct_argv(argv)
            mode = spec["chat"]
            await emit({"type": "turn_start"})
            # Checkpoint BEFORE the agent can touch anything; the UI pins
            # the id to this turn's user message as its revert point.
            try:
                await emit({"type": "checkpoint", "id": _checkpoint_make()})
            except OSError:
                pass  # snapshot is best effort, never blocks the turn
            # NO_COLOR + dumb TERM: the text-mode CLIs then skip most of
            # their spinner/ANSI dressing; whatever remains is stripped.
            env = {**os.environ, "TERM": "dumb", "NO_COLOR": "1",
                   **_ai_env_extra(agent)}
            # The CLI's own updater may be replacing the program this very
            # moment (ai_update, a few seconds): wait for it rather than
            # start a half-replaced program.
            waited = 0.0
            while _cli_updating.get(agent) and waited < 320:
                await asyncio.sleep(0.25)
                waited += 0.25
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv, cwd=str(Path.home()),
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, env=env,
                    start_new_session=(os.name == "posix"),
                    limit=10 * 1024 * 1024)
            except OSError as e:
                await emit({"type": "error", "message": f"could not start {agent}: {e}"})
                await emit({"type": "turn_end"})
                return
            state["proc"] = proc
            # The turn's text rides stdin (see AI_AGENTS): no length cap, no
            # shell quoting, no cmd.exe %VAR% expansion inside the user's own
            # words. Closing the pipe is what tells both CLIs the prompt is
            # finished, so it is not optional. A CLI that dies before reading
            # (missing auth, bad flag) breaks the pipe; that is not the error
            # worth reporting, the exit code and stderr below are.
            try:
                proc.stdin.write(text.encode("utf-8"))
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            try:
                proc.stdin.close()
            except OSError:
                pass
            stderr_tail = []

            async def drain_stderr():
                while True:
                    chunk = await proc.stderr.readline()
                    if not chunk:
                        break
                    stderr_tail.append(chunk.decode("utf-8", "replace"))
                    del stderr_tail[:-20]

            err_task = asyncio.create_task(drain_stderr())
            try:
                if mode in ("claude-json", "codex-json"):
                    parse = (parse_claude_json if mode == "claude-json"
                             else parse_codex_json)
                    while True:
                        line = await proc.stdout.readline()
                        if not line:
                            break
                        await parse(line.decode("utf-8", "replace"))
                else:
                    first_turn = state["sid"] is None
                    while True:
                        chunk = await proc.stdout.read(4096)
                        if not chunk:
                            break
                        clean = _ANSI_RE.sub("", chunk.decode("utf-8", "replace"))
                        # spinner lines repaint with \r; keep the final paint
                        if "\r" in clean:
                            clean = clean.rsplit("\r", 1)[-1]
                        if clean:
                            await emit({"type": "text", "text": clean,
                                        "stream": True})
                    if first_turn:
                        state["sid"] = True  # resume-by-recency from now on
                rc = await proc.wait()
                await err_task
                if rc not in (0, None) and rc >= 0:
                    tail = "".join(stderr_tail)[-500:].strip()
                    await emit({"type": "error",
                                "message": tail or f"{agent} exited with code {rc}"})
            finally:
                err_task.cancel()
                state["proc"] = None
                await emit({"type": "turn_end"})

        try:
            while True:
                msg = await websocket.receive_json()
                if msg.get("type") == "user":
                    text = str(msg.get("text", "")).strip()
                    if not text:
                        continue
                    if state["task"] and not state["task"].done():
                        await emit({"type": "error",
                                    "message": "a turn is already running"})
                        continue
                    model = str(msg.get("model", "")).strip()[:100]
                    effort = str(msg.get("effort", "")).strip()[:10]
                    level = str(msg.get("autonomy", "")).strip()
                    if level in ("ask", "edits", "full"):
                        state["autonomy"] = level
                    # Counted from here, so ai_update refuses to replace
                    # the CLI under a turn that is about to start it.
                    _cli_turns[agent] = _cli_turns.get(agent, 0) + 1
                    state["task"] = asyncio.create_task(
                        run_turn(text[:20000], model, effort))
                    state["task"].add_done_callback(
                        lambda _t, a=agent: _cli_turns.__setitem__(
                            a, max(0, _cli_turns.get(a, 0) - 1)))
                elif msg.get("type") == "permission_reply":
                    ch = approve_channels.get(approve_token) or {"pending": {}}
                    fut = ch["pending"].get(str(msg.get("pid", "")))
                    if fut and not fut.done():
                        fut.set_result((
                            "allow" if msg.get("decision") == "allow" else "deny",
                            bool(msg.get("always"))))
                elif msg.get("type") == "reset":
                    # /new in the panel: next turn starts a fresh session.
                    if not (state["task"] and not state["task"].done()):
                        state["sid"] = None
                elif msg.get("type") == "resume":
                    # Reopening an archived chat. This path used to send
                    # "reset", so an old chat came back as a DEAD
                    # transcript: the text was there, the agent remembered
                    # none of it, and the user could not continue from
                    # where they left off. Handing the
                    # stored session id back means the next turn runs as
                    # `claude --resume <sid>` / `codex exec resume <sid>` and
                    # the conversation genuinely continues.
                    if not (state["task"] and not state["task"].done()):
                        sid = str(msg.get("sid") or "").strip()[:128]
                        state["sid"] = sid or None
                        await emit({"type": "resumed", "sid": sid,
                                    "ok": bool(sid)})
                elif msg.get("type") == "stop":
                    if state["proc"]:
                        try:
                            os.killpg(state["proc"].pid, signal.SIGTERM)
                        except Exception:
                            # killpg is POSIX-only; on Windows fall back to
                            # killing just the CLI process itself.
                            try:
                                state["proc"].terminate()
                            except Exception:
                                pass
        except Exception:
            pass  # disconnect or malformed frame: tear down either way
        finally:
            ch = approve_channels.pop(approve_token, None)
            if ch:
                for fut in ch["pending"].values():
                    if not fut.done():
                        fut.set_result(("deny", False))
            if mcp_cfg_path is not None:
                try:
                    mcp_cfg_path.unlink()
                except OSError:
                    pass
            if state["task"]:
                state["task"].cancel()
            if state["proc"]:
                try:
                    os.killpg(state["proc"].pid, signal.SIGKILL)
                except Exception:
                    try:
                        state["proc"].kill()
                    except Exception:
                        pass

    # ── My Data: the user's own imported datasets ─────────────────────

    # ── MACHINE LEARNING: local model training on the user's own box ──
    #
    # Same models as the LSE ML Studio, but training runs here, in a
    # subprocess of this server, on the user's CPU/GPU. We provide the
    # workflow (dataset export, parameters, progress, results); the compute
    # and the data never leave the machine.
    from lse_terminal.ml import catalog as ml_catalog
    from lse_terminal.ml import env as ml_env
    from lse_terminal.ml.runner import MLJobManager

    ml_jobs = MLJobManager(cfg.config_dir() / "ml")
    app.state.ml_jobs = ml_jobs

    def _econ_num(raw) -> float | None:
        """Parse feed display strings ('57K', '3.5%', '$1.2B') to numbers."""
        if raw is None:
            return None
        s = str(raw).strip().replace(",", "").replace("$", "").replace("%", "")
        mult = 1.0
        if s[-1:].upper() in ("K", "M", "B", "T"):
            mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}[s[-1].upper()]
            s = s[:-1]
        try:
            return float(s) * mult
        except ValueError:
            return None

    # Feed rows carry no impact rating (the calendar UI derives one client
    # side); a tiny keyword list marks the universally market-moving
    # releases so the econ_high_count style features stay meaningful.
    _ECON_HIGH = ("cpi", "inflation", "nonfarm", "non-farm", "nfp", "fomc",
                  "rate decision", "interest rate", "gdp", "unemployment",
                  "payroll", "pce", "retail sales")

    def _ml_econ_frame(start: str | None, end: str | None):
        """Best-effort economic-events export for econ_* features; None if
        the LSE source is not connected (features then fill with 0)."""
        try:
            p = reg.get("lse")
            if not p.configured():
                return None
            rows = p.economic_calendar(start=start, end=end,
                                       released_only=True, limit=5000)
        except Exception:
            return None
        recs = []
        for r in rows:
            actual = _econ_num(r.get("actual"))
            estimate = _econ_num(r.get("consensus"))
            if actual is None or estimate is None:
                continue
            name = str(r.get("event", "")).lower()
            impact = "High" if any(k in name for k in _ECON_HIGH) else "Medium"
            date = r.get("date") or ""
            if r.get("time"):
                date = f"{date}T{r['time']}"
            recs.append({"event_date": date, "actual": actual,
                         "estimate": estimate, "impact": impact})
        if not recs:
            return None
        return pd.DataFrame(recs)

    @app.get("/api/ml/models")
    def ml_models():
        deps = ml_env.dep_status(ml_catalog.MODELS)
        models = []
        for m in ml_catalog.MODELS:
            d = {k: m.get(k) for k in ("key", "name", "category", "description",
                                       "params", "features_arg", "deps", "gpu")}
            d["ready"] = all(deps.get(p, {}).get("installed") for p in m.get("deps", []))
            models.append(d)
        return {"models": models,
                "categories": [{"key": k, "label": v} for k, v in ml_catalog.CATEGORIES],
                "features": ml_catalog.FEATURES,
                "deps": deps,
                "hosted": hosted}

    @app.get("/api/ml/env")
    def ml_environment(refresh: int = 0):
        import platform
        return {"gpu": ml_env.gpu_info(refresh=bool(refresh)),
                "deps": ml_env.dep_status(ml_catalog.MODELS),
                "python": platform.python_version(),
                # where the ML tab's installs land, for the Libraries panel
                "packages_dir": ml_env.packages_dir_str()}

    @app.post("/api/ml/train")
    def ml_train(body: MLTrainIn, request: Request):
        # Training spawns subprocesses and writes weights to disk, so it is a
        # single-user action, never a shared hosted-server one.
        deny_hosted()
        own_origin_only(request)
        model = ml_catalog.get_model(body.model_key)
        if model is None:
            raise HTTPException(404, f"unknown model: {body.model_key}")
        missing = [pip for pip, imp in zip(model.get("deps", []), model.get("dep_imports", []))
                   if not ml_env.dep_installed(imp)]
        if missing:
            raise HTTPException(409, "missing packages: " + ", ".join(missing))
        if ml_jobs.running_count() >= 2:
            raise HTTPException(429, "two trainings are already running; "
                                     "wait for one to finish or stop it")
        # Training data must already be on this computer by design:
        # only the user's imported MY DATA files qualify.
        if body.provider != "userdata":
            raise HTTPException(400, "training uses data already on this "
                                     "computer; import it in the MY DATA tab "
                                     "first")
        try:
            p = reg.get(body.provider)
            df = p.candles(body.symbol, body.timeframe,
                           limit=max(200, min(int(body.limit), 100_000)),
                           start=body.start or None, end=body.end or None)
        except ValueError as e:
            raise HTTPException(404, str(e))
        except Exception as e:
            raise HTTPException(502, f"could not load training data: {e}")
        if df is None or len(df) < 200:
            raise HTTPException(400, "not enough bars to train on (need at "
                                     "least 200); raise the bar count or pick "
                                     "a busier symbol/timeframe")
        econ_df = None
        if any(str(f).startswith("econ_") for f in body.features):
            econ_df = _ml_econ_frame(body.start or None, body.end or None)
        label = f"{body.symbol} {body.timeframe} · {body.provider}"
        job = ml_jobs.start(model, df, label, body.params or {},
                            features=body.features or None, econ_df=econ_df,
                            timeframe=body.timeframe)
        return {"job_id": job.id, "status": job.status}

    # ── Python strategy workspace (BACKTEST > Algo Development) ─────
    # A real folder of .py files on the user's disk, VS Code style: the
    # file tree, the editor, the run button, and the AI agents all operate
    # on the SAME directory, so "the AI edited my strategy" is literally
    # true. Jailed to the workspace dir; text files only.
    # .svg included: the assistant draws explanatory diagrams
    # (paper mechanisms, strategy flows) as self-contained SVG files.
    WS_EXTS = {".py", ".md", ".txt", ".json", ".csv", ".svg"}

    def ws_dir() -> Path:
        d = cfg.config_dir() / "workspace"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _ws_resolve(rel: str) -> Path:
        p = (ws_dir() / rel.replace("\\", "/").lstrip("/")).resolve()
        # Compare path COMPONENTS, not the string form. startswith() passed
        # "../workspace2/notes.py": that resolves to a SIBLING of the
        # workspace, but its text still begins with the workspace path, so
        # every reader and writer routed through here (the assistant's
        # read_workspace_file and run_backtest file= among them) could reach
        # outside it. is_relative_to only accepts real descendants.
        if not p.is_relative_to(ws_dir().resolve()):
            raise HTTPException(400, "path escapes the workspace")
        return p

    def _ws_seed() -> None:
        """First open: the starter strategies, so the IDE is never blank and
        what is in it is worth reading. Seven quant strategies (the
        single EMA-crossover starter said nothing
        about what this terminal is for); they ship as source strings in
        backtest/starters.py because the engine ships frozen and only code
        in the PYZ is guaranteed to travel."""
        if any(ws_dir().rglob("*.py")):
            return
        (ws_dir() / "strategies").mkdir(exist_ok=True)
        try:
            from lse_terminal.backtest.starters import STARTERS
        except Exception:
            STARTERS = ()
        for fname, source in STARTERS:
            (ws_dir() / "strategies" / fname).write_text(source)
        if not STARTERS:   # never leave the IDE with nothing to open
            try:
                template = reg.engine("python").template()
            except Exception:
                template = ("# Python strategy workspace. Create a file and "
                            "write plain Python: df is a pandas DataFrame,\n"
                            "# the AI assistant can write one for you.\n")
            (ws_dir() / "strategies" / "starter.py").write_text(template)

    @app.post("/api/reveal")
    def reveal_library():
        # The "Saved in ..." sidebar line: open the terminal's storage folder
        # in the OS file manager. Fixed path, no client input, so this can
        # never be turned into an arbitrary-open; hosted mode has no desktop
        # to open anything on.
        deny_hosted()
        import subprocess
        import sys
        d = cfg.config_dir()
        d.mkdir(parents=True, exist_ok=True)
        try:
            if sys.platform == "win32":
                os.startfile(str(d))  # noqa: S606 - fixed local path
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(d)])
            else:
                subprocess.Popen(["xdg-open", str(d)])
        except Exception as e:
            raise HTTPException(500, f"could not open the folder: {e}")
        return {"ok": True, "path": str(d)}

    @app.get("/api/ws-files")
    def ws_files():
        from lse_terminal.providers import userdata
        _ws_seed()
        out = []
        for p in sorted(ws_dir().rglob("*")):
            if p.is_file() and p.suffix.lower() in WS_EXTS:
                out.append({"path": str(p.relative_to(ws_dir())).replace("\\", "/"),
                            "size": p.stat().st_size,
                            "mtime": int(p.stat().st_mtime)})
        # data_root rides along so the library sidebar can show WHERE both
        # stores live on the user's disk; a separate /api/data shape change
        # would break its list-consumers.
        return {"root": str(ws_dir()), "data_root": str(userdata.data_dir()),
                "files": out}

    @app.get("/api/ws-files/read")
    def ws_read(path: str):
        p = _ws_resolve(path)
        if not p.is_file():
            raise HTTPException(404, f"no such file: {path}")
        if p.stat().st_size > 2_000_000:
            raise HTTPException(413, "file too large for the editor")
        return {"path": path, "content": p.read_text(errors="replace")}

    @app.post("/api/ws-files/write")
    def ws_write(body: WsFileIn):
        deny_hosted()
        p = _ws_resolve(body.path)
        if p.suffix.lower() not in WS_EXTS:
            raise HTTPException(400, f"only {', '.join(sorted(WS_EXTS))} files")
        p.parent.mkdir(parents=True, exist_ok=True)
        # The editor saving its own buffer must not bounce back as a reload.
        _ws_note_self_write(body.path)
        p.write_text(body.content, encoding="utf-8")
        return {"ok": True, "path": body.path}

    @app.post("/api/ws-files/rename")
    def ws_rename(body: WsFileIn):
        deny_hosted()
        src = _ws_resolve(body.path)
        dst = _ws_resolve(body.to)
        if not src.is_file():
            raise HTTPException(404, f"no such file: {body.path}")
        if dst.suffix.lower() not in WS_EXTS:
            raise HTTPException(400, f"only {', '.join(sorted(WS_EXTS))} files")
        dst.parent.mkdir(parents=True, exist_ok=True)
        # The requesting window already updates its tabs; keep the watcher out.
        _ws_note_self_write(body.path)
        _ws_note_self_write(body.to)
        src.rename(dst)
        return {"ok": True, "path": body.to}

    @app.post("/api/ws-files/delete")
    def ws_delete(body: WsFileIn):
        deny_hosted()
        p = _ws_resolve(body.path)
        if not p.is_file():
            raise HTTPException(404, f"no such file: {body.path}")
        # The requesting window already closes its tab; keep the watcher out.
        _ws_note_self_write(body.path)
        p.unlink()
        return {"ok": True}

    # ── WORKSPACE terminal: a real PTY rooted in the strategy folder ──
    # The WORKSPACE tab's bottom panel. Three launch modes, all with the
    # workspace as cwd so the terminal, the editor tabs and the AI agents
    # share one folder:
    #   python  an interactive REPL through this engine's own interpreter
    #           (cli.py --repl), so lse_terminal / pandas import with zero
    #           setup even in the frozen desktop build
    #   shell   the user's own shell, for pip installs, git, ad-hoc tools
    #   run     execute one workspace .py and leave its output on screen
    # Like /api/ai/pty this must never run hosted: a PTY on a shared host
    # would be a remote shell.

    def _term_argv(mode: str, path: str) -> list:
        import sys as _sys
        if getattr(_sys, "frozen", False):
            self_cmd = [_sys.executable]
        else:
            self_cmd = [_sys.executable, "-m", "lse_terminal.cli"]
        if mode == "run":
            p = _ws_resolve(path)
            if not p.is_file() or p.suffix.lower() != ".py":
                raise HTTPException(400, "run needs a workspace .py file")
            return self_cmd + ["--run-script", str(p)]
        if mode == "shell":
            if os.name != "posix":
                return ["cmd.exe"]
            shell = os.environ.get("SHELL") or "/bin/sh"
            return [shell]
        return self_cmd + ["--repl"]

    @app.websocket("/api/term/pty")
    async def term_pty(websocket: WebSocket):
        await websocket.accept()
        if hosted:
            await websocket.send_json({"type": "error",
                                       "message": "The terminal only runs in the local app."})
            await websocket.close()
            return
        # a shell on this machine: only for the terminal's own window
        if await deny_other_origin_ws(websocket):
            return
        mode = websocket.query_params.get("mode", "python")
        try:
            argv = _term_argv(mode, websocket.query_params.get("path", ""))
        except HTTPException as e:
            await websocket.send_json({"type": "error", "message": e.detail})
            await websocket.close()
            return
        env = {**os.environ, "TERM": "xterm-256color",
               "COLORTERM": "truecolor", "PYTHONUNBUFFERED": "1"}
        cwd = str(ws_dir())

        if os.name != "posix":
            # ConPTY via pywinpty, same contract as _ai_pty_windows.
            try:
                from winpty import PtyProcess
            except ImportError:
                await websocket.send_json({"type": "error",
                                           "message": "This build is missing pywinpty; reinstall the app."})
                await websocket.close()
                return
            try:
                proc = PtyProcess.spawn(argv, cwd=cwd, env=env)
            except Exception as e:
                await websocket.send_json({"type": "error",
                                           "message": f"could not start the terminal: {e}"})
                await websocket.close()
                return
            loop = asyncio.get_running_loop()

            async def pump_win():
                while True:
                    try:
                        data = await loop.run_in_executor(None, proc.read, 65536)
                    except (EOFError, OSError):
                        break
                    if not data:
                        break
                    try:
                        await websocket.send_bytes(data.encode())
                    except Exception:
                        break
                try:
                    await websocket.send_json({"type": "exit"})
                except Exception:
                    pass

            out_task = asyncio.create_task(pump_win())
            try:
                while True:
                    msg = await websocket.receive_json()
                    if msg.get("type") == "input":
                        proc.write(str(msg.get("data", "")))
                    elif msg.get("type") == "resize":
                        proc.setwinsize(int(msg["rows"]), int(msg["cols"]))
            except Exception:
                pass  # disconnect or dead pty: tear down either way
            finally:
                out_task.cancel()
                try:
                    proc.terminate(force=True)
                except Exception:
                    pass
            return

        import fcntl
        import pty
        import signal
        import struct
        import subprocess
        import termios
        import threading
        master, slave = pty.openpty()

        def child_setup():
            # New session + controlling terminal, same reason as ai_pty:
            # without it ^C never reaches the child and REPLs lose job
            # control.
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            proc = subprocess.Popen(
                argv, cwd=cwd,
                stdin=slave, stdout=slave, stderr=slave,
                env=env, preexec_fn=child_setup, close_fds=True)
        except OSError as e:
            os.close(master)
            os.close(slave)
            await websocket.send_json({"type": "error",
                                       "message": f"could not start the terminal: {e}"})
            await websocket.close()
            return
        os.close(slave)
        loop = asyncio.get_running_loop()

        async def pump_out():
            while True:
                try:
                    data = await loop.run_in_executor(None, os.read, master, 65536)
                except OSError:  # EIO when the child exits and the PTY closes
                    break
                if not data:
                    break
                try:
                    await websocket.send_bytes(data)
                except Exception:
                    break
            try:
                await websocket.send_json({"type": "exit"})
            except Exception:
                pass

        out_task = asyncio.create_task(pump_out())
        try:
            while True:
                msg = await websocket.receive_json()
                if msg.get("type") == "input":
                    os.write(master, str(msg.get("data", "")).encode())
                elif msg.get("type") == "resize":
                    fcntl.ioctl(master, termios.TIOCSWINSZ,
                                struct.pack("HHHH", int(msg["rows"]),
                                            int(msg["cols"]), 0, 0))
        except Exception:
            pass  # disconnect, malformed frame: either way tear down
        finally:
            out_task.cancel()
            try:
                os.killpg(proc.pid, signal.SIGHUP)
            except Exception:
                pass
            try:
                os.close(master)
            except Exception:
                pass
            # Reap off-thread so a slow exit never blocks the event loop.
            threading.Thread(target=proc.wait, daemon=True).start()

    # ── Code-first ML (BACKTEST > MACHINE LEARNING): blueprints ──────
    from lse_terminal.ml import blueprint as ml_blueprint

    @app.get("/api/ml/blueprint")
    def ml_blueprint_code(model: str, dataset: str = "",
                          timeframe: str = "1h", bars: int = 5000):
        try:
            return {"code": ml_blueprint.generate_code(
                model, dataset=dataset, timeframe=timeframe, bars=bars)}
        except ValueError as e:
            raise HTTPException(404, str(e))

    @app.post("/api/ml/run-code")
    def ml_run_code(body: MLCodeIn, request: Request):
        # Blueprints are user Python executed locally, same trust model as
        # custom indicators; never on a shared hosted server.
        deny_hosted()
        own_origin_only(request)
        if not body.code.strip():
            raise HTTPException(400, "empty blueprint")
        if ml_jobs.running_count() >= 2:
            raise HTTPException(429, "two trainings are already running; "
                                     "wait for one to finish or stop it")
        job = ml_jobs.start_code(body.code)
        return {"job_id": job.id, "status": job.status}

    @app.get("/api/ml/datasets")
    def ml_datasets():
        return ml_blueprint.list_datasets()

    @app.post("/api/ml/build-dataset")
    def ml_build_dataset(body: MLDatasetIn):
        deny_hosted()
        try:
            return ml_blueprint.build_dataset(
                body.name, body.source, timeframe=body.timeframe,
                bars=body.bars, start=body.start or None,
                end=body.end or None, features=body.features or None)
        # NotSupported (e.g. a daily import asked for 1h) is a caller
        # mistake, not an engine fault; 502 buried it in "build failed".
        except (ValueError, NotSupported) as e:
            raise HTTPException(400, str(e))
        except Exception as e:
            raise HTTPException(502, f"dataset build failed: {e}")

    @app.get("/api/ml/jobs")
    def ml_job_list():
        running = [j.public() for j in ml_jobs.jobs.values() if j.status == "running"]
        return {"running": running, "history": ml_jobs.history()}

    @app.get("/api/ml/jobs/{job_id}")
    def ml_job_detail(job_id: str):
        rec = ml_jobs.saved_results(job_id)
        if rec is None:
            raise HTTPException(404, "unknown job")
        return rec

    @app.post("/api/ml/jobs/{job_id}/cancel")
    def ml_job_cancel(job_id: str):
        if not ml_jobs.cancel(job_id):
            raise HTTPException(404, "no running job with that id")
        return {"ok": True}

    @app.websocket("/api/ml/jobs/{job_id}/stream")
    async def ml_job_stream(websocket: WebSocket, job_id: str):
        """Live training log + final results. Event-driven off the reader
        thread (wait_lines blocks on the job's event), no busy polling."""
        await websocket.accept()
        job = ml_jobs.jobs.get(job_id)
        if job is None:
            await websocket.send_json({"type": "error", "message": "unknown job"})
            await websocket.close()
            return
        cursor = 0
        loop = asyncio.get_running_loop()
        try:
            while True:
                new, cursor, finished = await loop.run_in_executor(
                    None, ml_jobs.wait_lines, job, cursor)
                for line in new:
                    await websocket.send_json({"type": "line", "line": line})
                if finished:
                    await websocket.send_json({
                        "type": "end", "status": job.status,
                        "error": job.error, "results": job.results})
                    break
        except (WebSocketDisconnect, RuntimeError):
            pass  # client went away; the job keeps running server-side
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    @app.websocket("/api/ml/install")
    async def ml_install(websocket: WebSocket):
        """One-click pip install of a model's libraries, streamed like the AI
        CLI installer. Package names are allowlisted against the catalog so
        this can never install something arbitrary."""
        await websocket.accept()
        if await deny_hosted_ws(websocket):
            return
        if await deny_other_origin_ws(websocket):
            return
        if hosted:
            await websocket.send_json({"type": "error",
                                       "message": "not available in the hosted terminal"})
            await websocket.close()
            return
        import subprocess
        import sys as _sys
        requested = [p for p in websocket.query_params.get("packages", "").split(",") if p]
        allowed = ml_env.allowed_packages(ml_catalog.MODELS)
        bad = [p for p in requested if p not in allowed]
        if not requested or bad:
            await websocket.send_json({"type": "error",
                                       "message": f"unknown packages: {', '.join(bad) or '(none given)'}"})
            await websocket.close()
            return
        try:
            proc = await asyncio.create_subprocess_exec(
                _sys.executable, "-m", "pip", "install", "--upgrade", *requested,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env={**os.environ, "NO_COLOR": "1", "PIP_PROGRESS_BAR": "off"})
        except OSError as e:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close()
            return
        tail = ""
        # Structured progress for the Libraries panel / deps banner (say
        # what is downloading, how big, and what got installed): every
        # complete pip line is parsed by ml_env.parse_pip_line and
        # forwarded with its fields; `line` stays on every frame so older
        # UI code that only prints it keeps working.
        buf = ""
        wheel_mb = {}          # normalised package -> its own wheel size
        total_mb = 0.0         # everything pip fetched this run (deps too)
        cached_mb = 0.0
        run_packages = 0       # "Installing collected packages: ..." count
        try:
            while True:
                # torch wheels are multi-GB; allow long quiet stretches
                chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=1800)
                if not chunk:
                    break
                text = chunk.decode("utf-8", "replace")
                tail = (tail + text)[-2000:]
                buf += text
                lines = buf.split("\n")
                buf = lines.pop()  # a partial last line waits for the next chunk
                for raw_line in lines:
                    line = raw_line.rstrip()[-200:]
                    if not line.strip():
                        continue
                    frame = {"type": "progress", "line": line}
                    parsed = ml_env.parse_pip_line(line)
                    if parsed:
                        frame.update(parsed)
                        if parsed.get("stage") == "install":
                            run_packages = int(parsed.get("count") or 0)
                        if parsed.get("stage") == "download":
                            wheel_mb[parsed["package"]] = parsed.get("size_mb") or 0.0
                            if parsed.get("cached"):
                                cached_mb += parsed.get("size_mb") or 0.0
                            else:
                                total_mb += parsed.get("size_mb") or 0.0
                            frame["total_mb"] = round(total_mb, 1)
                            frame["cached_mb"] = round(cached_mb, 1)
                    try:
                        await websocket.send_json(frame)
                    except Exception:
                        break
            rc = await proc.wait()
            if "torch" in requested:
                ml_env.gpu_info(refresh=True)
            try:
                if rc == 0:
                    status = ml_env.dep_status(ml_catalog.MODELS)
                    run_total = round(total_mb + cached_mb, 1)
                    ml_env.record_install(
                        requested,
                        {p: wheel_mb.get(ml_env.norm_name(p), 0.0) for p in requested},
                        {p: (status.get(p) or {}).get("version") for p in requested},
                        run_mb=run_total, run_packages=run_packages)
                    await websocket.send_json({
                        "type": "ok",
                        "packages": [{"name": p,
                                      "version": (status.get(p) or {}).get("version"),
                                      "downloaded_mb": wheel_mb.get(ml_env.norm_name(p), 0.0)}
                                     for p in requested],
                        "total_mb": round(total_mb, 1), "cached_mb": round(cached_mb, 1),
                        "run_mb": run_total, "run_packages": run_packages})
                else:
                    await websocket.send_json({"type": "error",
                                               "message": (tail.strip()[-400:] or f"pip exited with code {rc}")})
            except Exception:
                pass
        finally:
            if proc.returncode is None:
                proc.kill()
            try:
                await websocket.close()
            except Exception:
                pass

    @app.get("/api/data")
    def data_list():
        from lse_terminal.providers import userdata
        return list(userdata.load_manifest().values())

    @app.post("/api/data/preview")
    def data_preview(body: DataPreviewIn):
        deny_hosted()
        from lse_terminal.providers import userdata
        if len(body.csv_text) > 50_000_000:
            raise HTTPException(413, "CSV larger than 50 MB; split it up")
        try:
            return userdata.preview_csv(body.csv_text)
        except userdata.ImportError_ as e:
            raise HTTPException(400, str(e))

    @app.post("/api/data/import")
    def data_import(body: DataImportIn):
        deny_hosted()
        from lse_terminal.providers import userdata
        symbol = body.symbol.strip()
        if not symbol:
            raise HTTPException(400, "dataset needs a symbol name")
        if len(body.csv_text) > 50_000_000:
            raise HTTPException(413, "CSV larger than 50 MB; split it up")
        try:
            return userdata.import_csv(symbol, body.csv_text, name=body.name.strip(),
                                       folder=body.folder, kind=body.kind)
        except userdata.ImportError_ as e:
            raise HTTPException(400, str(e))

    @app.post("/api/data/upload")
    async def data_upload(file: UploadFile = File(...), folder: str = Form("")):
        """Any-format import: decoders turn the bytes into a table, then the
        same normalize/import brain as CSV runs. This is the UI's path."""
        deny_hosted()
        from lse_terminal.providers import decoders, userdata
        data = await file.read()
        if len(data) > 200_000_000:
            raise HTTPException(413, "file larger than 200 MB; split it up")
        filename = file.filename or "dataset"
        symbol = filename.rsplit(".", 1)[0].upper()
        symbol = "".join(c if c.isalnum() or c in ":_-" else "_" for c in symbol) or "DATASET"
        try:
            raw = decoders.decode(filename, data)
            ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ".csv"
            return userdata.import_table(symbol, raw, folder=folder, source_ext=ext)
        except decoders.DecodeError as e:
            raise HTTPException(400, str(e))
        except userdata.ImportError_ as e:
            raise HTTPException(400, str(e))

    @app.get("/api/data/formats")
    def data_formats():
        from lse_terminal.providers import decoders
        return {"formats": decoders.supported()}

    @app.get("/api/data/location")
    def data_location():
        # Names a path on THIS machine; meaningless and a small infra leak on
        # the shared hosted box.
        deny_hosted()
        from lse_terminal.providers import userdata
        return {"path": str(userdata.data_dir())}

    @app.post("/api/data/open-location")
    def data_open_location():
        # Opens the storage folder in the OS file manager. Local app only:
        # the engine runs on the user's own machine.
        deny_hosted()
        from lse_terminal.providers import userdata
        import subprocess
        import sys
        d = userdata.data_dir()
        d.mkdir(parents=True, exist_ok=True)
        if os.name == "nt":
            os.startfile(str(d))  # noqa: S606 - intentional, user-initiated
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(d)])
        else:
            subprocess.Popen(["xdg-open", str(d)])
        return {"ok": True}

    @app.get("/api/data/folders")
    def folders_list():
        from lse_terminal.providers import userdata
        return userdata.load_folders()

    @app.post("/api/data/folders")
    def folders_create(body: FolderIn):
        deny_hosted()
        from lse_terminal.providers import userdata
        try:
            return userdata.create_folder(body.path)
        except userdata.ImportError_ as e:
            raise HTTPException(400, str(e))

    @app.patch("/api/data/folders")
    def folders_rename(body: FolderIn):
        deny_hosted()
        from lse_terminal.providers import userdata
        if not body.new_path:
            raise HTTPException(400, "new_path required")
        try:
            return userdata.rename_folder(body.path, body.new_path)
        except userdata.ImportError_ as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/data/folders")
    def folders_delete(path: str):
        deny_hosted()
        from lse_terminal.providers import userdata
        try:
            return userdata.delete_folder(path)
        except userdata.ImportError_ as e:
            raise HTTPException(400, str(e))

    @app.patch("/api/data/{symbol}")
    def data_update(symbol: str, body: DataUpdateIn):
        deny_hosted()
        from lse_terminal.providers import userdata
        entry = userdata.update_dataset(symbol, name=body.name, folder=body.folder)
        if entry is None:
            raise HTTPException(404, f"no dataset named {symbol}")
        return entry

    @app.delete("/api/data/{symbol}")
    def data_delete(symbol: str):
        deny_hosted()
        from lse_terminal.providers import userdata
        if not userdata.delete_dataset(symbol):
            raise HTTPException(404, f"no dataset named {symbol}")
        return {"ok": True}

    # ── LSE databank imports ─────────────────────────────────────────────────
    # The library imports supported public candles and series in bounded pages.
    # Only complete, validated downloads become local files and manifest rows.
    # The modal and assistant share this asynchronous job interface.

    lsebank_jobs: dict[str, dict] = {}

    def _lse_bank():
        p = _lse_for_options()  # same guard: provider present + key set
        return p._lse()

    def _databank_http_error(e: Exception) -> HTTPException:
        # The SDK raises LSEError(status, message) for any non-2xx from the
        # data service. A 4xx is the service answering (bad key, plan, quota,
        # rate limit), so its status and words pass straight through; only a
        # transport failure (no HTTP status) is "unreachable". Before this,
        # a quota hit read as an outage.
        st = getattr(e, "status", None)
        msg = getattr(e, "message", None) or str(e)
        # Some SDK paths hand back the service's raw JSON body as the message.
        try:
            parsed = _json.loads(msg)
            if isinstance(parsed, dict):
                msg = parsed.get("detail") or parsed.get("message") or msg
        except Exception:
            pass
        if isinstance(st, int) and 400 <= st < 500:
            return HTTPException(st, f"Databank: {msg}")
        return HTTPException(502, f"Databank unreachable: {msg}")

    @app.get("/api/lse/databank")
    def lsebank_overview():
        c = _lse_bank()
        try:
            from lse_terminal.engine.lse_import import import_meta
            from lse_terminal.providers import userdata
            meta = import_meta(c.vault_meta(), userdata)
            reference = []
        except Exception as e:
            raise _databank_http_error(e)
        # Quota is a nice-to-have (no public SDK wrapper yet): the modal shows
        # bytes used/cap when available and silently omits the line when not.
        usage = None
        try:
            usage = c._vault_call("/usage")
        except Exception:
            pass
        return {"meta": meta, "reference": reference, "usage": usage}

    @app.get("/api/lse/databank/catalog")
    def lsebank_catalog(dataset: str, query: str = "", limit: int = 300):
        c = _lse_bank()
        try:
            rows = c.datasets(dataset)
        except Exception as e:
            raise HTTPException(502, f"catalog failed: {e}")
        q = query.strip().upper()
        # Same ranking as provider search: prefix hits first, then substring
        # on symbol or name, catalog order within each band.
        out, rest = [], []
        for r in rows:
            sym = str(r.get("symbol") or "").upper()
            if not q or sym.startswith(q):
                out.append(r)
            elif q in sym or q in str(r.get("name") or "").upper():
                rest.append(r)
            if len(out) >= limit:
                break
        out.extend(rest[: max(0, limit - len(out))])
        return {"total": len(rows), "rows": out[:limit]}

    @app.post("/api/lse/databank/import")
    def lsebank_import(body: LseBankImportIn):
        deny_hosted()
        from lse_terminal.providers import userdata
        from lse_terminal.engine import lse_import
        try:
            return lse_import.submit(_lse_bank(), body, userdata, lsebank_jobs)
        except lse_import.ImportProblem as e:
            raise HTTPException(e.status, e.message)
        except Exception as e:
            raise _databank_http_error(e)

    @app.get("/api/lse/databank/import/{job_id}")
    def lsebank_job(job_id: str):
        job = lsebank_jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "no such import job")
        return job

    # ── Data Visualisation feeds ─────────────────────────────────────────────
    # The WORKSPACE > DATA VISUALISATION page charts arbitrary tables in the
    # browser. Rows are shipped as JSON with a hard cap: the page is a chart
    # builder, not a data browser, and 5000 points is already past what any
    # of its chart forms can display legibly.

    _VIZ_MAX_ROWS = 5000

    def _viz_table(df, keep_tail: bool = False) -> dict:
        """DataFrame -> {fields, rows} JSON the viz page keys on. Datetimes
        become ISO strings, NaN/NaT become null, numpy scalars unwrap; column
        names stringify because the page uses them as object keys."""
        import numpy as np
        import pandas as pd
        df = df.copy()
        df.columns = [str(c) for c in df.columns]
        nrows = int(len(df))
        truncated = nrows > _VIZ_MAX_ROWS
        if truncated:
            # Library datasets are time-ascending; the recent end is the
            # useful end for financial series, so those keep the tail.
            df = df.tail(_VIZ_MAX_ROWS) if keep_tail else df.head(_VIZ_MAX_ROWS)

        def kind(dtype):
            if pd.api.types.is_bool_dtype(dtype):
                return "bool"
            if pd.api.types.is_numeric_dtype(dtype):
                return "number"
            if pd.api.types.is_datetime64_any_dtype(dtype):
                return "date"
            return "category"

        fields = [{"name": c, "type": kind(df[c].dtype)} for c in df.columns]
        for c in df.columns:
            if pd.api.types.is_datetime64_any_dtype(df[c].dtype):
                df[c] = df[c].dt.strftime("%Y-%m-%d %H:%M:%S")
        df = df.astype(object).where(pd.notnull(df), None)
        rows = df.to_dict("records")
        for r in rows:
            for k, v in r.items():
                if isinstance(v, np.integer):
                    r[k] = int(v)
                elif isinstance(v, np.floating):
                    r[k] = None if np.isnan(v) else float(v)
        return {"ok": True, "fields": fields, "nrows": nrows,
                "truncated": truncated, "rows": rows}

    @app.get("/api/data/{symbol}/rows")
    def data_rows(symbol: str):
        """A MY DATA library dataset as viz rows. Reads the stored normalized
        CSV, so OHLCV sets arrive as ts/open/high/low/close/volume and series
        sets as their numeric columns; epoch columns come back as real dates
        so the page types them for time-axis charts."""
        import pandas as pd
        from lse_terminal.providers import userdata
        path = userdata.dataset_path(symbol)
        if path is None or not path.exists():
            raise HTTPException(404, f"no dataset named {symbol}")
        df = pd.read_csv(path)
        # Stored time bases differ by kind (see userdata.import_table): series
        # files carry "time" in ms for the chart engine, OHLCV carry "ts" in
        # seconds. Both become tz-naive datetimes here.
        if "time" in df.columns:
            df["time"] = pd.to_datetime(df["time"], unit="ms")
        elif "ts" in df.columns:
            df["ts"] = pd.to_datetime(df["ts"], unit="s")
        return _viz_table(df, keep_tail=True)

    @app.post("/api/dataviz/parse")
    async def dataviz_parse(file: UploadFile = File(...)):
        """Ephemeral any-format parse for the viz page: unlike /api/data/upload
        nothing is imported or normalized, so categorical/text columns survive
        and nothing is written to disk. The browser handles pasted CSV itself;
        this exists for the formats it cannot read (parquet, feather, xlsx)."""
        # Local-only feature; on the shared host it is an unbounded-
        # decompression DoS surface.
        deny_hosted()
        from lse_terminal.providers import decoders
        data = await file.read()
        if len(data) > 200_000_000:
            raise HTTPException(413, "file larger than 200 MB; split it up")
        try:
            df = decoders.decode(file.filename or "dataset.csv", data)
        except decoders.DecodeError as e:
            raise HTTPException(400, str(e))
        if df is None or df.empty or not len(df.columns):
            raise HTTPException(400, "no tabular data found in the file")
        import pandas as pd
        # Text columns that are really dates should chart on a time axis;
        # sniff conservatively (>=90% parseable) so id-like strings stay
        # categorical instead of becoming garbage dates. Both dtype checks
        # matter: pandas 3 types text as "str", older frames as object.
        for c in df.columns:
            if df[c].dtype == object or pd.api.types.is_string_dtype(df[c]):
                sample = df[c].dropna().head(200)
                if len(sample) == 0:
                    continue
                parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
                if parsed.notna().mean() >= 0.9:
                    df[c] = pd.to_datetime(df[c], errors="coerce", format="mixed")
        return _viz_table(df)

    # ── chart workspace (drawings, layouts, settings, tools) ────────────────
    # Persisted to a file next to the config so the user's work survives a
    # browser cache clear, a reinstall, or moving machines. See workspace.py.

    @app.get("/api/workspace")
    def workspace_all():
        return workspace.load()

    # A page names its window in X-LSE-Window (one name per page load, set
    # by index.html for every request the page makes, the chart bundle's
    # included). The store uses it to merge a window's save with what the
    # other windows saved since that window last read (workspace.py).
    _WINDOW_CHARS = frozenset(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

    def _window_of(request: Request) -> str | None:
        name = (request.headers.get("x-lse-window") or "").strip()
        ok = 0 < len(name) <= 64 and all(ch in _WINDOW_CHARS for ch in name)
        return name if ok else None

    @app.get("/api/workspace/{section}")
    def workspace_get(section: str, request: Request):
        if section not in workspace.SECTIONS:
            raise HTTPException(404, f"unknown workspace section: {section}")
        return {"section": section,
                "value": workspace.get(section, window=_window_of(request))}

    @app.put("/api/workspace/{section}")
    async def workspace_put(section: str, request: Request):
        # Hosted mode serves the same bundle from the website, where there is
        # no per-user filesystem to write to.
        deny_hosted()
        if section not in workspace.SECTIONS:
            raise HTTPException(404, f"unknown workspace section: {section}")
        try:
            value = await request.json()
        except Exception:
            raise HTTPException(400, "body must be JSON")
        window = _window_of(request)
        try:
            stored = workspace.put(section, value, window=window)
        except OSError as e:
            raise HTTPException(507, f"could not write workspace: {e}")
        # Tell the other windows the section moved, so one that shows it can
        # read it again (the stars in the sidebar, a dashboard). The sender
        # is named so it does not answer its own save.
        ui_event_push({"type": "workspace_section", "section": section,
                       "by": window or ""})
        return {"ok": True, "section": section, "merged": stored != value}

    @app.get("/api/config")
    def get_config():
        return {"lse_configured": bool(cfg.get_lse_api_key()), "hosted": hosted}

    # ---- WORKSPACE > NOTEBOOKS: infinite-canvas research documents --------
    # One JSON document per notebook on the user's own disk (see
    # engine/notebooks.py for why it is a directory and not a workspace
    # section). The engine stores and serves; it never interprets a block,
    # so the canvas can grow new block types without a migration here.
    async def _nb_json(request: Request) -> dict:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "body must be JSON")
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        return body

    @app.get("/api/notebooks")
    def notebooks_list():
        return nbstore.listing()

    @app.post("/api/notebooks")
    async def notebooks_create(request: Request):
        deny_hosted()
        body = await _nb_json(request)
        try:
            return nbstore.create(str(body.get("name") or "Untitled")[:120],
                                  str(body.get("folder") or "")[:120])
        except OSError as e:
            raise HTTPException(507, f"could not write notebook: {e}")

    @app.get("/api/notebooks/{nid}")
    def notebooks_read(nid: str):
        try:
            return nbstore.read(nid)
        except (KeyError, FileNotFoundError):
            raise HTTPException(404, f"no notebook {nid!r}")
        except (ValueError, json.JSONDecodeError) as e:
            raise HTTPException(500, f"notebook {nid!r} is unreadable: {e}")

    @app.put("/api/notebooks/{nid}")
    async def notebooks_write(nid: str, request: Request):
        deny_hosted()
        raw = await request.body()
        if len(raw) > nbstore.MAX_DOC_BYTES:
            raise HTTPException(413, "notebook document too large")
        try:
            doc = json.loads(raw)
        except Exception:
            raise HTTPException(400, "body must be JSON")
        if not isinstance(doc, dict):
            raise HTTPException(400, "notebook must be an object")
        try:
            saved = nbstore.write(nid, doc)
        except KeyError:
            raise HTTPException(404, f"no notebook {nid!r}")
        except OSError as e:
            raise HTTPException(507, f"could not write notebook: {e}")
        return {"ok": True, "id": saved["id"], "updated_at": saved["updated_at"]}

    @app.delete("/api/notebooks/{nid}")
    def notebooks_delete(nid: str):
        deny_hosted()
        try:
            nbstore.delete(nid)
        except KeyError:
            raise HTTPException(404, f"no notebook {nid!r}")
        return {"ok": True}

    @app.post("/api/notebooks/asset")
    async def notebooks_asset(request: Request):
        """Store one image and hand back the URL to put in an image block.

        Base64 in JSON rather than multipart because every door the canvas
        offers (clipboard paste, drag-drop, file picker) already has the
        bytes in the page; one shape covers all three.
        """
        deny_hosted()
        body = await _nb_json(request)
        import base64
        try:
            raw = base64.b64decode(str(body.get("data") or ""), validate=True)
        except Exception:
            raise HTTPException(400, "data must be base64 image bytes")
        try:
            name = nbstore.save_asset(raw, str(body.get("mime") or ""))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except OSError as e:
            raise HTTPException(507, f"could not write image: {e}")
        return {"name": name, "src": f"/api/notebooks/asset/{name}"}

    @app.get("/api/notebooks/asset/{name}")
    def notebooks_asset_get(name: str):
        from fastapi.responses import FileResponse
        try:
            p = nbstore.asset_path(name)
        except KeyError:
            raise HTTPException(404, "no such image")
        if not p.is_file():
            raise HTTPException(404, "no such image")
        # Content-addressed names never change content, so they are immutable
        # to any cache that sees them.
        return FileResponse(p, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    # ---- RESEARCH > QUANT MODELS: fit a model to the user's own data -------
    # The gallery used to be parametric sliders over closed-form shapes, which
    # is an illustration, not a tool. These two endpoints let the user point
    # any model at their own dataset (or at a live LSE option chain) and get
    # the parameters ESTIMATED from it, with the columns, clock, estimator and
    # caveats reported back. All of the maths runs here, on their machine.
    @app.get("/api/quant/fit-info")
    def quant_fit_info():
        """What each model needs, and what this user actually has to feed it."""
        from lse_terminal.providers import userdata
        from lse_terminal.engine import quant_fit as qfit
        sets = []
        for symbol, meta in userdata.load_manifest().items():
            sets.append({
                "symbol": symbol, "name": meta.get("name") or symbol,
                "kind": meta.get("kind") or "series",
                "rows": meta.get("rows") or 0,
                "timeframe": meta.get("timeframe") or "",
                "folder": meta.get("folder") or "",
                # The column list is what makes the picker honest: the UI can
                # offer "which column is the price?" instead of guessing.
                # OHLCV imports leave this empty in the manifest (the columns
                # are implied by the kind), so fill the canonical set or the
                # picker would show nothing for exactly the common case.
                "columns": list(meta.get("columns")
                                or (["open", "high", "low", "close", "volume"]
                                    if (meta.get("kind") == "ohlcv") else [])),
            })
        sets.sort(key=lambda d: (d["folder"], d["name"].lower()))
        lse_ok = False
        try:
            lse_ok = bool(reg.get("lse").configured())
        except Exception:
            lse_ok = False
        return {"models": qfit.REQUIREMENTS, "datasets": sets,
                # Concrete column expectations per requirement, so the UI can
                # state the format BEFORE a mismatched dataset produces a
                # garbage fit. From the same constants the loaders match on.
                "formats": qfit.FORMATS,
                # Bundled samples not yet in the library: installs that
                # predate the sample library (seed_samples is first-run only)
                # can add them from the fit bar instead of hunting for CSVs.
                # Empty on the hosted instance: add-sample is denied there
                # (multi-tenant library), so offering the control would give
                # every visitor a button that silently does nothing.
                "samples": [] if hosted else userdata.available_samples(),
                "lse_options": lse_ok}

    @app.post("/api/quant/add-sample")
    def quant_add_sample(body: QuantSampleIn):
        # Writes into the user's library, so single-user only, like fit.
        deny_hosted()
        from lse_terminal.providers import userdata
        entry = userdata.import_sample(body.symbol)
        if entry is None:
            raise HTTPException(404, f"no bundled sample named {body.symbol!r}")
        return {"ok": True, "symbol": body.symbol}

    @app.post("/api/quant/fit")
    def quant_fit_run(body: QuantFitIn):
        deny_hosted()          # the fit runs the user's data on their machine
        import pandas as _pd
        from lse_terminal.providers import userdata
        from lse_terminal.engine import quant_fit as qfit
        try:
            if body.source == "lse-options":
                und = (body.underlying or "").strip().upper()
                if not und:
                    raise qfit.FitError("pick an underlying for the option chain")
                rows = _lse_for_options().option_chain(und, limit=5000)
                if not rows:
                    raise qfit.FitError(f"no live option chain rows for {und}")
                frame = _pd.DataFrame(rows)
                frames = [(f"{und} option chain", frame)]
            else:
                man = userdata.load_manifest()
                frames = []
                for sym in (body.datasets or []):
                    if sym not in man:
                        raise qfit.FitError(f"no imported dataset named {sym!r}")
                    frames.append((sym, _pd.read_csv(userdata.dataset_path(sym))))
            out = qfit.fit(body.model, frames, body.opts or {})
        except qfit.FitError as e:
            # A data problem is an ANSWER, not a server error: the UI shows it
            # as guidance ("this model needs an option chain", "override the
            # column"), so it must not arrive as a 500.
            return {"ok": False, "error": str(e)}
        except HTTPException:
            raise
        except Exception as e:
            sys.stderr.write(f"quant fit {body.model} failed: {e}\n")
            return {"ok": False,
                    "error": f"{type(e).__name__}: {e}"}
        return out

    # ---- RESEARCH > ARTICLES: the papers feed ------------------------------
    # Live-first: the feed comes from the public research_papers table on the
    # LSE API (keyless PUBLIC read, same route family as terminal_datasets),
    # so every terminal sees new papers the moment the server-side pipeline
    # runs, with no app update. Any failure falls back to the wire file
    # shipped in the static dir, so the tab still works offline. Response
    # shape matches the file exactly; the UI cannot tell which one it got.
    # (The hosted terminal calls the same URL: that is the server talking
    # to its own public API through nginx, not a third party.)
    _RESEARCH_FEED_URL = ("https://api.londonstrategicedge.com/"
                          "public_research_papers"
                          "?select=source,category,title,link,summary,authors,tags,published,thumb"
                          "&order=published.desc.nullslast&limit=200")
    _research_feed_cache: dict = {"at": 0.0, "doc": None}

    @app.get("/api/research/feed")
    def research_feed():
        import json
        now = time.time()
        cached = _research_feed_cache
        if cached["doc"] is not None and now - cached["at"] < 600:
            return cached["doc"]
        doc = None
        try:
            import urllib.request
            req = urllib.request.Request(
                _RESEARCH_FEED_URL, headers={"User-Agent": _RESEARCH_UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                rows = json.loads(r.read().decode("utf-8", "replace"))
            if isinstance(rows, list) and rows:
                doc = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "live": True,
                       "items": [{**row, "authors": row.get("authors") or [],
                                  "tags": row.get("tags") or [],
                                  "published": row.get("published") or ""}
                                 for row in rows]}
        except Exception as e:
            sys.stderr.write(f"research feed: live fetch failed, using file: {e}\n")
        if doc is None:
            try:
                doc = json.loads((_STATIC / "assets" / "research"
                                  / "research_wire.json").read_text())
                doc["live"] = False
            except Exception:
                raise HTTPException(404, "no research feed available")
        _research_feed_cache["at"] = now
        _research_feed_cache["doc"] = doc
        return doc

    # ---- MARKETS > NEWS: headlines + newsroom articles, live ----------------
    # Same contract as the research feed above. Reading news_wire.json and
    # articles.json from the local static dir does not work for a downloaded
    # terminal: nothing on the user's machine ever fills those files, so the
    # tab shows "No news source connected" forever. Live-first: the wire
    # JSON is served publicly at /news-assets/ on the api host and the
    # newsroom posts come from the public posts endpoint; image paths are
    # rewritten to that host. Any failure falls back to the shipped files so
    # the tab still works offline.
    # Response shape is exactly what the two static files carry, merged:
    # {generated, live, events:[...], posts:[...]}.
    _NEWS_ASSETS_URL = "https://api.londonstrategicedge.com/news-assets"
    _NEWS_POSTS_URL = ("https://api.londonstrategicedge.com/public_news_posts"
                       "?select=slug,headline,dek,body_md,category,symbols,"
                       "sources,image_path,image_credit,image_credit_url,"
                       "published_at&status=eq.published"
                       "&order=published_at.desc&limit=40")
    _news_feed_cache: dict = {"at": 0.0, "doc": None}

    def _news_img_url(path: str, ver: str) -> str:
        """'/assets/news/img/ev_ab12.jpg' -> the public copy on the api host.
        Legacy ev<N> files were rewritten under the same name every run, so
        the wire's generated stamp rides along as a cache-buster for those;
        ev_<hash> and post_* names are unique and need none."""
        import re as _re
        if not path:
            return ""
        if path.startswith("http://") or path.startswith("https://"):
            return path
        name = path.rsplit("/", 1)[-1]
        url = f"{_NEWS_ASSETS_URL}/img/{name}"
        # Only the legacy ev0..ev11 names were rewritten in place; the
        # wire now names images ev_<hash> per story (immutable).
        return f"{url}?v={ver}" if _re.match(r"ev\d+\.", name) and ver else url

    @app.get("/api/news/feed")
    def news_feed():
        import json
        import re as _re
        import urllib.request
        now = time.time()
        cached = _news_feed_cache
        if cached["doc"] is not None and now - cached["at"] < 300:
            return cached["doc"]
        events = posts = None
        gen = ""
        try:
            req = urllib.request.Request(
                f"{_NEWS_ASSETS_URL}/news_wire.json",
                headers={"User-Agent": _RESEARCH_UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                wire = json.loads(r.read().decode("utf-8", "replace"))
            if isinstance(wire, dict) and isinstance(wire.get("events"), list):
                gen = _re.sub(r"[^0-9]", "", wire.get("generated") or "")
                events = [{**e, "image": _news_img_url(e.get("image") or "", gen)}
                          for e in wire["events"]]
        except Exception as e:
            sys.stderr.write(f"news feed: live wire fetch failed: {e}\n")
        try:
            req = urllib.request.Request(
                _NEWS_POSTS_URL, headers={"User-Agent": _RESEARCH_UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                rows = json.loads(r.read().decode("utf-8", "replace"))
            if isinstance(rows, list):
                posts = [{**row,
                          "image": _news_img_url(row.get("image_path") or "", ""),
                          "symbols": row.get("symbols") or [],
                          "sources": row.get("sources") or []}
                         for row in rows]
        except Exception as e:
            sys.stderr.write(f"news feed: live posts fetch failed: {e}\n")
        live = events is not None or posts is not None
        # Whatever the live side could not supply comes from the shipped
        # files (old copies on a downloaded terminal, current ones on a PC the
        # pipelines push to); absent files simply leave that half empty.
        if events is None:
            try:
                events = json.loads((_STATIC / "assets" / "news"
                                     / "news_wire.json").read_text()).get("events") or []
            except Exception:
                events = []
        if posts is None:
            try:
                posts = json.loads((_STATIC / "assets" / "news"
                                    / "articles.json").read_text()).get("posts") or []
            except Exception:
                posts = []
        doc = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "live": live, "events": events, "posts": posts}
        _news_feed_cache["at"] = now
        _news_feed_cache["doc"] = doc
        return doc

    # ---- RESEARCH > ARTICLES: in-terminal paper reader --------------------
    # Clicking a paper opens its PDF inside the terminal. THIS machine (the
    # user's own, exactly like their browser) fetches it from the publisher
    # and serves the bytes same-origin, so the iframe PDF viewer needs no
    # third-party framing permission and the licensing posture stays
    # browser-like: transient display of the publisher's own copy, never
    # redistribution. Hosted mode denies: the shared server must not open
    # sockets to third parties, so the hosted feed keeps plain
    # external links.
    #
    # Host allowlist = the five wire publishers only. It is checked on the
    # incoming link, on any citation_pdf_url found on a landing page, and on
    # the FINAL post-redirect URL, so the endpoint cannot be steered to an
    # arbitrary host (SSRF guard).
    _RESEARCH_HOSTS = {
        "arxiv.org", "www.arxiv.org", "export.arxiv.org",
        "ecb.europa.eu", "www.ecb.europa.eu",
        "bis.org", "www.bis.org",
        "federalreserve.gov", "www.federalreserve.gov",
        "nber.org", "www.nber.org", "back.nber.org",
        # CLASSICS entries (curated in the research wire pipeline). IOP's
        # bot shield blocks datacenter fetches; the reader still works
        # because the curated PDF is seeded into research_cache, which
        # _research_pdf_bytes checks before any network call.
        "iopscience.iop.org",
    }
    _RESEARCH_UA = f"lse-terminal/{__version__} (paper reader)"
    _RESEARCH_MAX_PDF = 40 * 1024 * 1024  # a working paper, not a dataset

    def _research_host_ok(url: str) -> bool:
        from urllib.parse import urlsplit
        parts = urlsplit(url)
        return parts.scheme == "https" and parts.hostname in _RESEARCH_HOSTS

    def _research_get(url: str, cap: int):
        """GET with UA/timeout/size cap; returns (bytes, final_url)."""
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": _RESEARCH_UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read(cap + 1)
            if len(data) > cap:
                raise HTTPException(413, "document too large")
            return data, r.geturl()

    def _research_pdf_url(link: str) -> str | None:
        """Resolve a wire item's landing link to its PDF URL. arXiv is
        deterministic (/abs/ -> /pdf/); the central banks and NBER publish a
        citation_pdf_url meta tag on the landing page (the Google Scholar
        convention), which is scraped rather than guessed."""
        import re as _re
        from urllib.parse import urljoin, urlsplit
        parts = urlsplit(link)
        if parts.hostname and parts.hostname.endswith("arxiv.org") and "/abs/" in parts.path:
            return link.replace("/abs/", "/pdf/", 1)
        if parts.path.lower().endswith(".pdf"):
            return link
        # IOP article pages publish the PDF at <article-url>/pdf.
        if parts.hostname == "iopscience.iop.org" and "/article/" in parts.path:
            return link.rstrip("/") + "/pdf"
        # BIS publishes no citation_pdf_url meta; its working-paper URLs are
        # a deterministic pair (spot-checked: /publ/work1371.htm ->
        # /publ/work1371.pdf, real %PDF bytes).
        if parts.hostname and parts.hostname.endswith("bis.org") \
                and parts.path.startswith("/publ/") and parts.path.endswith(".htm"):
            return link[:-4] + ".pdf"
        html_bytes, final = _research_get(link, 2 * 1024 * 1024)
        if not _research_host_ok(final):
            return None
        text = html_bytes.decode("utf-8", "replace")
        m = _re.search(
            r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)',
            text, _re.I)
        if not m:
            m = _re.search(
                r'<meta[^>]+content=["\']([^"\']+\.pdf)["\'][^>]+name=["\']citation_pdf_url["\']',
                text, _re.I)
        if m:
            return urljoin(final, m.group(1))
        # Last resort: the first same-publisher .pdf link on the page.
        # The allowlist check downstream keeps this from ever leaving the
        # five publishers.
        m = _re.search(r'href=["\']([^"\']+\.pdf)["\']', text, _re.I)
        return urljoin(final, m.group(1)) if m else None

    # Some publishers meter their own PDF. NBER allows 3 anonymous downloads
    # per IP per year (the meter is server side and per IP, so cookies, the
    # /api/v1/auth handshake and the user agent make no difference;
    # institutional subscriber IPs are unlimited). When the publisher
    # refuses, the SAME paper is often still
    # legitimately free somewhere else, because working papers get cross
    # posted: "A Currency Premium Puzzle" is NBER w35572 and also a San
    # Francisco Fed working paper, free at frbsf.org. This resolves that open
    # copy through OpenAlex and reads it instead, which is an ordinary fetch
    # of a freely published document. It never attempts to defeat the meter.
    _RESEARCH_OA_API = "https://api.openalex.org/works"
    _RESEARCH_OA_MAIL = "support@londonstrategicedge.com"

    def _research_safe_remote(url: str) -> bool:
        """https to a public address. An open-access URL comes from OpenAlex
        rather than the publisher allowlist, so it needs its own SSRF guard:
        a repository host that resolves to a private or loopback address must
        never be fetched by the machine running the terminal."""
        import ipaddress
        import socket
        from urllib.parse import urlsplit
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            return False
        try:
            infos = socket.getaddrinfo(parts.hostname, 443,
                                       proto=socket.IPPROTO_TCP)
        except OSError:
            return False
        if not infos:
            return False
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if (ip.is_private or ip.is_loopback or ip.is_link_local
                    or ip.is_reserved or ip.is_multicast):
                return False
        return True

    def _research_oa_pdf_url(link: str) -> str | None:
        """An independently hosted free copy of the paper at `link`, or None.
        The landing page stays readable even when the PDF is metered, so the
        title is taken from its citation_title meta and matched against
        OpenAlex on the exact normalised title. Matching is deliberately not
        by DOI: OpenAlex and Unpaywall both 404 on NBER's own 10.3386 DOIs,
        because the work is indexed under the
        co-publisher's DOI, which is precisely the copy worth finding."""
        import json
        import re as _re
        import urllib.parse
        import urllib.request
        from urllib.parse import urlsplit
        try:
            html_bytes, final = _research_get(link, 2 * 1024 * 1024)
        except Exception:
            return None
        text = html_bytes.decode("utf-8", "replace")
        m = _re.search(
            r'<meta[^>]+name=["\']citation_title["\'][^>]+content=["\']([^"\']+)',
            text, _re.I)
        if not m:
            return None
        title = m.group(1).strip()
        gated = (urlsplit(final).hostname or "").removeprefix("www.")
        query = urllib.parse.quote(_re.sub(r"[^A-Za-z0-9 ]", " ", title))
        api = (f"{_RESEARCH_OA_API}?search={query}&per-page=5"
               f"&mailto={_RESEARCH_OA_MAIL}")
        try:
            req = urllib.request.Request(
                api, headers={"User-Agent": _RESEARCH_UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                works = json.loads(
                    r.read().decode("utf-8", "replace")).get("results", [])
        except Exception:
            return None

        def _norm(s: str) -> list:
            return _re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()

        want = _norm(title)
        for work in works:
            # OpenAlex search is fuzzy and will happily return a different
            # paper on the same subject, so only an exact title is accepted.
            if _norm(work.get("title")) != want:
                continue
            for loc in (work.get("locations") or []):
                url = loc.get("pdf_url") or ""
                if not url or not loc.get("is_oa"):
                    continue
                host = (urlsplit(url).hostname or "").removeprefix("www.")
                # doi.org redirects straight back to the metering publisher,
                # so it is not an independent copy however OpenAlex flags it.
                if host in ("doi.org", "dx.doi.org"):
                    continue
                if host == gated or host.endswith("." + gated):
                    continue
                if _research_safe_remote(url):
                    return url
        return None

    def _research_pdf_bytes(link: str) -> bytes:
        """The paper's PDF bytes: local cache first, then the publisher's own
        copy, then a free copy in an open repository. Shared by the reader
        endpoint and the assistant's read_research_paper tool."""
        if not _research_host_ok(link):
            raise HTTPException(400, "link is not one of the research wire publishers")
        import hashlib
        cache_dir = cfg.config_dir() / "research_cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached = cache_dir / (hashlib.sha1(link.encode()).hexdigest() + ".pdf")
        if cached.exists():
            return cached.read_bytes()
        data = None
        try:
            pdf_url = _research_pdf_url(link)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(502, f"could not reach the publisher: {e}")
        if pdf_url and _research_host_ok(pdf_url):
            try:
                got, final = _research_get(pdf_url, _RESEARCH_MAX_PDF)
                if _research_host_ok(final) and got.startswith(b"%PDF"):
                    data = got
            except HTTPException:
                raise
            except Exception:
                # A metered or withdrawn paper lands here (NBER answers 403
                # with an HTML gate page). Not fatal: the open-access lookup
                # below is the second door, and only if it also comes up
                # empty does the reader report a failure.
                data = None
        if data is None:
            oa_url = _research_oa_pdf_url(link)
            if oa_url:
                try:
                    got, final = _research_get(oa_url, _RESEARCH_MAX_PDF)
                    if got.startswith(b"%PDF") and _research_safe_remote(final):
                        data = got
                except HTTPException:
                    raise
                except Exception:
                    data = None
        if data is None:
            from urllib.parse import urlsplit
            host = (urlsplit(link).hostname or "").removeprefix("www.")
            why = ("NBER meters anonymous downloads to 3 per year per IP "
                   "address, and this address has used its three"
                   if host.endswith("nber.org") else
                   "the publisher did not return a PDF")
            raise HTTPException(
                404, f"no in-app copy: {why}, and no free copy of this paper "
                     "exists in an open repository. Use Open in browser.")
        # Cache-by-link: reopening a paper is instant and offline-safe, and
        # this directory doubles as the reader's local library store.
        try:
            cached.write_bytes(data)
        except OSError:
            pass  # cache is best-effort; serving the bytes still works
        return data

    @app.get("/api/research/pdf")
    def research_pdf(link: str):
        deny_hosted()
        from fastapi.responses import Response
        return Response(_research_pdf_bytes(link), media_type="application/pdf")

    # ── Tested-run registry ──────────────────────────────────────────────
    # Every successful assistant run_backtest is recorded here keyed by the
    # strategy's pin-invariant code hash, so a delivered code block can be
    # traced back to the exact run that vouched for it. This is the engine
    # backstop behind the `# run:` pin (backtest/contract.py): the model is
    # told to write the pin itself, and when it forgets, the To-strategy-IDE
    # handoff asks /api/assistant/stamp to add it from this registry.
    def _tested_runs_path():
        return cfg.config_dir() / "ai-workspace" / "tested_runs.json"

    def _tested_runs_load() -> list:
        try:
            recs = json.loads(_tested_runs_path().read_text())
            return recs if isinstance(recs, list) else []
        except (OSError, ValueError):
            return []

    def _tested_runs_record(script: str, symbol: str, timeframe: str,
                            trades, net_profit) -> None:
        from lse_terminal.backtest.contract import run_pin_hash
        try:
            recs = [{"hash": run_pin_hash(script), "symbol": symbol,
                     "timeframe": timeframe, "trades": trades,
                     "net_profit": net_profit, "ts": int(time.time())}]
            recs += [r for r in _tested_runs_load()
                     if r.get("hash") != recs[0]["hash"]][:49]
            path = _tested_runs_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(recs))
        except OSError:
            pass  # the registry is a safety net; the run itself succeeded

    @app.post("/api/assistant/stamp")
    def assistant_stamp(body: dict):
        # Called by the chat panel's "To strategy IDE" button before the
        # code block becomes a workspace file. Already-pinned scripts pass
        # through; an unpinned script whose code hash matches a tested run
        # gets that run's `# run:` line stamped on, so the IDE runs exactly
        # what the assistant tested. Unknown scripts pass through unchanged
        # (source: null) and behave as before the pin existed.
        deny_hosted()
        from lse_terminal.backtest.contract import parse_run_pin, run_pin_hash
        script = str((body or {}).get("script") or "")
        pin = parse_run_pin(script)
        if pin:
            return {"script": script, "symbol": pin["symbol"],
                    "timeframe": pin["timeframe"], "source": "pin"}
        h = run_pin_hash(script)
        for rec in _tested_runs_load():
            if rec.get("hash") == h and rec.get("symbol"):
                line = "# run: " + rec["symbol"] + (
                    " " + rec["timeframe"] if rec.get("timeframe") else "")
                return {"script": line + "\n" + script,
                        "symbol": rec["symbol"],
                        "timeframe": rec.get("timeframe"),
                        "source": "tested"}
        return {"script": script, "symbol": None, "timeframe": None,
                "source": None}

    # Tools from the agents' menu (CAPABILITY_TOOLS) the hosted LSE Assistant
    # may also call, executed by this engine through the SAME dispatcher the
    # local agents and /mcp use: give it what the agents can do.
    # READ and COMPUTE only, plus screen navigation and its own
    # notes: nothing here writes the user's files, runs arbitrary code,
    # spends the data plan on imports or launches GPU jobs, because this
    # path has no Allow/Deny card in front of it the way the local agents
    # do. run_backtest / list_datasets / preview_dataset / read_guide keep
    # their assistant-specific implementations below (ok_runs bookkeeping).
    LSE_SHARED_TOOLS = (
        "get_positions", "get_fills", "get_candles", "get_economics",
        "run_montecarlo", "run_walkforward", "list_research",
        "read_research_paper", "list_workspace", "read_workspace_file",
        "open_in_app", "remember", "recall", "list_ml_models", "get_ml_job")

    def lse_local_specs():
        """OpenAI-shaped function specs for the assistant: the four
        assistant-native tools plus the shared allowlist, converted from
        the MCP schema the agents see (same descriptions, same params)."""
        from lse_terminal.engine.approve_bridge import CAPABILITY_TOOLS
        out = []
        for t in CAPABILITY_TOOLS:
            if t["name"] not in LSE_SHARED_TOOLS:
                continue
            out.append({"type": "function", "function": {
                "name": t["name"],
                "description": t.get("description") or "",
                "parameters": t.get("inputSchema") or {"type": "object",
                                                       "properties": {}}}})
        return out

    @app.get("/api/assistant/usage")
    def assistant_usage():
        """The user's assistant allowance today (used / cap / reset), from
        the LSE assistant endpoint with the local key. Powers the panel's
        /usage; never counts as a message."""
        deny_hosted()
        key = cfg.get_lse_api_key()
        if not key:
            raise HTTPException(401, "The assistant needs your LSE API key.")
        import json as _json
        import urllib.error
        import urllib.request
        req = urllib.request.Request(
            ASSISTANT_URL, method="GET",
            headers={"x-api-key": key,
                     "User-Agent": f"lse-terminal/{__version__}"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return _json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raise HTTPException(e.code, f"assistant usage HTTP {e.code}")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"assistant unreachable: {type(e).__name__}")

    @app.get("/api/assistant/tools")
    def assistant_tools():
        """What the hosted LSE Assistant can call: its local tools (this
        engine executes them) plus the cloud's web tools. Same shape as
        /api/ai/tools so the panel's tool strip renders either list."""
        cloud = [
            {"name": "web_search", "description": "Search the web (runs on the LSE side, in a sandbox).", "params": ["query"]},
            {"name": "fetch_url", "description": "Read a web page, PDF or text/data file (LSE-side sandbox).", "params": ["url"]},
            {"name": "browse", "description": "Open a page and follow links (LSE-side sandbox).", "params": ["url"]},
        ]
        native = [
            {"name": "list_datasets", "description": "The user's MY DATA library: every dataset's symbol, kind, timeframe, rows, columns and time range.", "params": []},
            {"name": "preview_dataset", "description": "First rows of one dataset with its column names.", "params": ["symbol", "rows", "part"]},
            {"name": "run_backtest", "description": "Run a strategy script on the local backtest engine; returns the real stats or the exact error.", "params": ["script", "symbol", "timeframe"]},
            {"name": "show_backtest", "description": "Put a tested strategy's run on screen: files it, pins its dataset and runs it in BACKTEST > ALGO DEVELOPMENT (equity curve, trades, plot panes, stats).", "params": ["script", "symbol"]},
            {"name": "read_guide", "description": "A section of the terminal's built-in guide.", "params": ["section"]},
        ]
        shared = [{"name": t["function"]["name"],
                   "description": t["function"]["description"],
                   "params": list((t["function"]["parameters"].get("properties") or {}).keys())}
                  for t in lse_local_specs()]
        return {"tools": native + shared + cloud}

    @app.post("/api/assistant")
    def assistant(body: AssistantIn, request: Request):
        # The AI chat. The terminal itself runs no model; this proxies to the
        # LSE assistant endpoint with the user's own API key (the same free
        # key the LSE data provider uses) so the key never has to live in the
        # browser page, and streams the SSE reply through unchanged. stdlib
        # urllib keeps the app free of an extra HTTP dependency; FastAPI runs
        # this sync generator in its threadpool, which is fine for a
        # single-user local app. Hosted mode is denied: on the shared site
        # server there is no per-user key to send.
        deny_hosted()
        key = cfg.get_lse_api_key()
        if not key:
            raise HTTPException(
                401, "The assistant needs your LSE API key. Get a free one at "
                     "https://londonstrategicedge.com/data and paste it in "
                     "the Assistant panel.")
        import json as _json
        import urllib.error
        import urllib.request

        # Paper grounding (local app only; this code path is already denied
        # hosted). The hosted LSE Assistant has NO tools, so when the chat
        # names a research-feed paper (the reader's Ask AI prefill carries a
        # "Link: <url>" line), THIS machine extracts the paper's text and
        # attaches it to that message before proxying. Without this the
        # cloud model answers a paper question from conversation vibes; it
        # once confidently produced a Eurobond strategy for a
        # pension-allocations paper. Re-applied on the newest linked message
        # each turn (the UI resends plain history), so the paper stays in
        # context for follow-ups. Any failure falls back to the unenriched
        # messages: the chat must never break because a publisher was slow.
        messages = body.messages
        try:
            import re as _re2
            msgs = [dict(m) for m in body.messages]
            for m in reversed(msgs):
                if m.get("role") != "user":
                    continue
                c = str(m.get("content") or "")
                mt = _re2.search(r"^Link: (https://\S+)$", c, _re2.M)
                if not mt:
                    continue
                if _research_host_ok(mt.group(1)):
                    text = _pdf_text(_research_pdf_bytes(mt.group(1)))[:20000]
                    m["content"] = (c + "\n\n[paper text, extracted from "
                                    "the PDF by the terminal]\n" + text)
                    messages = msgs
                break
        except Exception as e:
            sys.stderr.write(f"assistant paper grounding skipped: {e}\n")

        # ── Local tools: the hosted model may ask THIS terminal to act on
        # the user's machine (list/preview the library, run a backtest on a
        # strategy it just wrote) so it can test its own code before the
        # user ever sees it. The engine advertises the specs, executes the
        # calls, and drives the round loop; the server only relays model
        # rounds via `lse_round` frames.
        local_specs = [
            {"type": "function", "function": {
                "name": "list_datasets",
                "description": "The user's MY DATA library: every dataset's "
                               "symbol, kind, timeframe, rows, columns and "
                               "time range.",
                "parameters": {"type": "object", "properties": {}}}},
            {"type": "function", "function": {
                "name": "preview_dataset",
                "description": "First rows of one dataset with its column "
                               "names, so code is written against the real "
                               "shape, never a guessed one.",
                "parameters": {"type": "object", "properties": {
                    "symbol": {"type": "string"},
                    "rows": {"type": "integer",
                             "description": "default 8, max 30"},
                    "part": {"type": "string", "enum": ["head", "tail"],
                             "description": "head (default) or tail"}},
                    "required": ["symbol"]}}},
            {"type": "function", "function": {
                "name": "run_backtest",
                "description": "Run a strategy script on the user's local "
                               "backtest engine; returns the real stats or "
                               "the exact error. Test every strategy you "
                               "write BEFORE delivering it.",
                "parameters": {"type": "object", "properties": {
                    "script": {"type": "string",
                               "description": "the full strategy python"},
                    "symbol": {"type": "string",
                               "description": "dataset to trade (its df)"},
                    "timeframe": {"type": "string",
                                  "description": "optional; defaults to the "
                                                 "dataset's own"},
                    "cost_pct": {"type": "number",
                                 "description": "optional cost per side in "
                                                "percent of notional (0.01 = "
                                                "a basis point per side, a "
                                                "liquid-market spread proxy); "
                                                "default 0"}},
                    "required": ["script", "symbol"]}}},
            # Results on screen: the results window the
            # IDE already draws (trade list, equity curve, plot panes, full
            # stats) is where "show me / plot it / let me see the curve"
            # lands. Defaults to the last run_backtest of this turn.
            {"type": "function", "function": {
                "name": "show_backtest",
                "description": "Show a tested strategy's backtest ON THE "
                               "USER'S SCREEN: files it in their workspace, "
                               "pins its dataset and runs it in BACKTEST > "
                               "ALGO DEVELOPMENT, whose results window "
                               "draws the equity curve, the trade list, "
                               "every `plots` pane the script left, and "
                               "the full stats. Call it after a successful "
                               "run_backtest whenever the user asks to see, "
                               "show, open, plot or chart the results, or "
                               "when a picture would help. With no script it "
                               "shows the last strategy you ran this turn.",
                "parameters": {"type": "object", "properties": {
                    "script": {"type": "string",
                               "description": "optional; defaults to the "
                                              "last run_backtest script"},
                    "symbol": {"type": "string",
                               "description": "optional; defaults to the "
                                              "script's # run: pin"}}}}},
            # The user guide. Its section summaries ride in
            # the system message every turn; this returns the full text so
            # "how does the terminal work / what can it do / how do I ..."
            # is answered from the authors' own document, not from the
            # model's memory of an older build.
            {"type": "function", "function": {
                "name": "read_guide",
                "description": "The terminal's built-in user guide (the "
                               "TERMINAL WALKTHROUGH tab): every tab, feature "
                               "and workflow, "
                               "written by the terminal's authors. Call it "
                               "before answering how the app works, what it "
                               "can do, or how to do something in it. "
                               "Returns one section by number or title, or "
                               "the whole guide when section is empty.",
                "parameters": {"type": "object", "properties": {
                    "section": {"type": "string",
                                "description": "section number or title "
                                               "from the TERMINAL GUIDE "
                                               "summary; empty for all"}}}}},
        ]

        # The shared allowlist rides along with the four assistant-native
        # specs above (see LSE_SHARED_TOOLS).
        local_specs = local_specs + lse_local_specs()
        engine_url = _self_url(request)

        # Per-request memory shared between the tools of ONE chat turn:
        # the last successful run_backtest, so show_backtest can reopen it
        # without the model re-sending the script.
        turn_state: dict = {"last_ok": None}

        def _local_tool(name: str, args: dict) -> str:
            from lse_terminal.providers import userdata
            if name in LSE_SHARED_TOOLS:
                # Same door as the agents and /mcp; token None = no per-chat
                # approval channel (these tools need none).
                try:
                    return _tool_dispatch(name, args, engine_url, None)
                except HTTPException as e:
                    return _json.dumps({"error": str(e.detail)[:400]})
                except Exception as e:  # noqa: BLE001
                    return _json.dumps({"error": f"{type(e).__name__}: "
                                                 f"{e}"[:400]})
            try:
                if name == "read_guide":
                    return guide_section(str(args.get("section") or ""))
                if name == "list_datasets":
                    out = [{"symbol": sym, "kind": e.get("kind", "ohlcv"),
                            "timeframe": e.get("timeframe"),
                            "rows": e.get("rows"),
                            "columns": e.get("columns") or
                                ["ts", "open", "high", "low", "close",
                                 "volume"],
                            "first_ts": e.get("first_ts"),
                            "last_ts": e.get("last_ts")}
                           for sym, e in userdata.load_manifest().items()]
                    return _json.dumps({"datasets": out})
                if name == "preview_dataset":
                    import pandas as _pd
                    sym = str(args.get("symbol") or "")
                    path = userdata.dataset_path(sym)
                    if path is None or not path.exists():
                        return _json.dumps({"error": f"no dataset named "
                                                     f"{sym}; call "
                                                     "list_datasets"})
                    n = max(1, min(int(args.get("rows") or 8), 30))
                    if str(args.get("part") or "head") == "tail":
                        frame = _pd.read_csv(path).tail(n)
                    else:
                        frame = _pd.read_csv(path, nrows=n)
                    # Present the frame EXACTLY as a strategy receives it:
                    # series files store time in ms, but the engine's loader
                    # adds epoch-second ts on load. Showing the raw file made
                    # the model write ms-based code that then crashed against
                    # the injected seconds.
                    if "time" in frame.columns and "ts" not in frame.columns:
                        frame["ts"] = (_pd.to_numeric(frame["time"],
                                                      errors="coerce")
                                       // 1000).astype("int64")
                    cols = (["ts"] + [c for c in frame.columns if c != "ts"]
                            if "ts" in frame.columns else list(frame.columns))
                    return _json.dumps({
                        "symbol": sym, "columns": cols,
                        "note": "shown exactly as a strategy receives it "
                                "via data[symbol]; ts is epoch seconds",
                        "head": frame[cols].to_dict("records")})[:6000]
                if name == "run_backtest":
                    from lse_terminal.backtest.contract import BacktestError
                    script = str(args.get("script") or "")
                    sym = str(args.get("symbol") or "")
                    entry = userdata.load_manifest().get(sym)
                    if not script or entry is None:
                        return _json.dumps({"error": "script and a real "
                                            "dataset symbol are required; "
                                            "list_datasets shows what "
                                            "exists"})
                    tf = str(args.get("timeframe") or
                             entry.get("timeframe") or "1d")
                    # Optional cost per side, in percent of notional (the
                    # runner's commission_pct): 0.01 is a basis point per
                    # side, a fair spread proxy for liquid FX / gold /
                    # index CFDs. Default 0 = the engine's own default.
                    try:
                        cost_pct = float(args.get("cost_pct") or 0.0)
                    except (TypeError, ValueError):
                        cost_pct = 0.0
                    cost_pct = min(max(cost_pct, 0.0), 5.0)
                    run_opts = {"extended_stats": True}
                    if cost_pct:
                        run_opts["commission_pct"] = cost_pct
                    try:
                        candles = reg.get("userdata").candles(sym, tf,
                                                              limit=100_000)
                        res = reg.engine("python").run(
                            script, candles, sym, tf, options=run_opts,
                            data_files=_resolve_datasets([]))
                    except BacktestError as e:
                        return _json.dumps({"ok": False,
                                            "error": str(e)[:800]})
                    st = res.stats
                    # ── Hygiene checks the model is not trained to run on
                    # itself (the generic craft, not specific models).
                    # Mechanical where possible, so a rule does not
                    # depend on the prompt being obeyed.
                    # (1) Causality: re-run on the history minus its last
                    # tenth; every trade closed before the cut must be
                    # identical. A full-sample fit, a two-sided window, a
                    # bfill or a shift(-1) changes earlier trades when the
                    # future changes; a causal strategy does not.
                    causality = "unavailable"
                    try:
                        n_all = len(candles)
                        cut = max(50, n_all // 10)
                        if n_all - cut > 200:
                            trunc = candles.iloc[:n_all - cut].reset_index(
                                drop=True)
                            res2 = reg.engine("python").run(
                                script, trunc, sym, tf,
                                options=dict(run_opts, extended_stats=False),
                                data_files=_resolve_datasets([]))
                            cut_ts = int(trunc["ts"].iloc[-1])

                            def _key(t):
                                return (int(t.entry_ts), int(t.exit_ts),
                                        t.direction,
                                        round(float(t.entry_price), 6),
                                        round(float(t.exit_price), 6))
                            before_full = sorted(_key(t) for t in res.trades
                                                 if int(t.exit_ts) < cut_ts)
                            before_cut = sorted(_key(t) for t in res2.trades
                                                if int(t.exit_ts) < cut_ts)
                            if before_full == before_cut:
                                causality = (f"pass: the {len(before_full)} "
                                             "trades closed before the cut "
                                             "are identical with the last "
                                             f"{cut} bars removed")
                            else:
                                sf, sc = set(before_full), set(before_cut)
                                causality = (
                                    f"FAIL: {len(sf ^ sc)} trades before the "
                                    f"cut changed when the last {cut} bars "
                                    "were removed, so the strategy reads "
                                    "the future (a statistic fitted over "
                                    "the whole sample, a two-sided window, "
                                    "bfill, shift(-n), or a lookback tied to "
                                    "len(df)). Fix it and run again; never "
                                    "deliver this version.")
                        else:
                            causality = "skipped: too few bars"
                    except BacktestError as e:
                        causality = f"unavailable: {str(e)[:200]}"
                    except Exception as e:  # noqa: BLE001
                        causality = f"unavailable: {type(e).__name__}"
                    # (2) Static future reads the causality test can miss at
                    # the boundary.
                    import re as _re_h
                    warns = []
                    if _re_h.search(r"\.shift\(\s*-\s*\d", script):
                        warns.append("shift(-n) reads future bars")
                    if _re_h.search(r"cent(?:er|re)\s*=\s*True", script):
                        warns.append("center=True is a two-sided window "
                                     "(uses future bars)")
                    if _re_h.search(r"\.bfill\(|method\s*=\s*['\"]bfill",
                                    script):
                        warns.append("bfill fills from the future")
                    # (3) Buy-and-hold over the same bars: the honest
                    # yardstick for a long-only rule on a rising market.
                    try:
                        cap0 = float(res.initial_capital)
                        bh = cap0 * (float(candles["close"].iloc[-1])
                                     / float(candles["open"].iloc[0]) - 1.0)
                        bh_net = round(bh, 2)
                    except Exception:  # noqa: BLE001
                        bh_net = None
                    # The run vouches for this exact code: remember it so the
                    # To-strategy-IDE handoff can pin the delivered block to
                    # the dataset it was actually tested on.
                    _tested_runs_record(script, sym, tf,
                                        st.get("totalTrades"),
                                        round(res.net_profit, 2))
                    # show_backtest with no script argument reopens THIS
                    # run, so the model never has to re-type 2k chars of
                    # code (at ~90 tok/s that is ten silent seconds).
                    turn_state["last_ok"] = {"script": script, "symbol": sym,
                                             "timeframe": tf}
                    # Specifics matter: the six headline numbers alone let a
                    # single lucky year pass as an edge. Per-year P&L off
                    # the equity curve (UTC calendar years), the period
                    # covered, exposure and holding time give the model
                    # something to be honest WITH, and are what an
                    # overfitting conversation actually needs.
                    import datetime as _dt
                    ext = st.get("extended") or {}
                    eqc = res.equity_curve or []
                    per_year = {}
                    if len(eqc) > 1:
                        last_year = None
                        year_start = eqc[0][1]
                        for t_, e_ in eqc:
                            y_ = _dt.datetime.fromtimestamp(
                                float(t_), _dt.timezone.utc).year
                            if last_year is None:
                                last_year = y_
                            elif y_ != last_year:
                                per_year[str(last_year)] = round(
                                    prev_e - year_start, 2)
                                year_start = prev_e
                                last_year = y_
                            prev_e = e_
                        per_year[str(last_year)] = round(prev_e - year_start, 2)
                    prof_years = sum(1 for v in per_year.values() if v > 0)
                    d0 = (_dt.datetime.fromtimestamp(float(eqc[0][0]),
                                                     _dt.timezone.utc)
                          .strftime("%Y-%m-%d") if eqc else None)
                    d1 = (_dt.datetime.fromtimestamp(float(eqc[-1][0]),
                                                     _dt.timezone.utc)
                          .strftime("%Y-%m-%d") if eqc else None)
                    return _json.dumps({
                        "ok": True, "symbol": sym, "timeframe": tf,
                        "trades": st.get("totalTrades"),
                        "net_profit": round(res.net_profit, 2),
                        "win_rate": round(st.get("winRate", 0), 1),
                        "profit_factor": st.get("profitFactor"),
                        "max_drawdown_pct": round(st.get("maxDrawdownPct", 0),
                                                  1),
                        "sharpe": round(st.get("sharpeRatio", 0), 2),
                        "period": f"{d0} to {d1}",
                        "years_covered": len(per_year),
                        "annualised_return_pct": round(
                            ext.get("annualizedReturn", 0) or 0, 1),
                        "annualised_vol_pct": round(
                            ext.get("annualizedVol", 0) or 0, 1),
                        "sortino": round(ext.get("sortino", 0) or 0, 2),
                        "calmar": round(ext.get("calmar", 0) or 0, 2),
                        "exposure_pct": ext.get("exposurePct"),
                        "avg_bars_held": round(ext.get("avgBarsHeld", 0) or 0,
                                               1),
                        "avg_trade": round(st.get("avgTrade", 0) or 0, 2),
                        "largest_loss": round(st.get("largestLoss", 0) or 0,
                                              2),
                        "max_consec_losses": st.get("maxConsecLosses"),
                        "profitable_years": f"{prof_years}/{len(per_year)}",
                        "net_by_year": per_year,
                        "best_year_share_pct": (
                            round(max(per_year.values()) / res.net_profit
                                  * 100)
                            if per_year and res.net_profit > 0 else None),
                        "buy_and_hold_net": bh_net,
                        "cost_pct_per_side": cost_pct,
                        "causality_check": causality,
                        "warnings": warns + (
                            ["fewer than 30 trades: no statistical "
                             "conclusion is possible"]
                            if (st.get("totalTrades") or 0) < 30 else []),
                        "plots": sorted((res.plots or {}).keys()),
                        "note": "in-sample: the whole history, one pass, "
                                "capital 100000 compounding"
                                + (", no costs" if not cost_pct else
                                   f", {cost_pct}% per side charged")
                                + "; the equity curve, trade list and "
                                "plots are on screen after show_backtest"})
                if name == "show_backtest":
                    # Put a tested run on the user's screen: the panel files
                    # the script under its # name, pins its dataset, opens
                    # BACKTEST > ALGO DEVELOPMENT and presses RUN, so the
                    # results window (trade list, equity curve, plot panes,
                    # full stats) shows the SAME run the model just reported.
                    # The write happens client-side exactly as the user's
                    # own "To strategy IDE" click does (a NEW file, never an
                    # overwrite), which is why this stays inside the
                    # read/compute/navigate policy of this tool path.
                    script = str(args.get("script") or "")
                    last = turn_state.get("last_ok") or {}
                    if not script:
                        script = str(last.get("script") or "")
                    if not script:
                        return _json.dumps({"ok": False, "error":
                                            "nothing to show: run_backtest "
                                            "a strategy first (or pass its "
                                            "script)"})
                    from lse_terminal.backtest.contract import parse_run_pin
                    pin = parse_run_pin(script) or {}
                    sym = (str(args.get("symbol") or "") or pin.get("symbol")
                           or (last.get("symbol") if script == last.get("script")
                               else None) or "")
                    if not sym or sym not in userdata.load_manifest():
                        return _json.dumps({"ok": False, "error":
                                            "the script has no # run: pin "
                                            "naming a dataset in the "
                                            "library; add it or pass symbol"})
                    n_ = ui_event_push({"type": "open_backtest_run",
                                        "script": script, "symbol": sym})
                    if n_ == 0:
                        return _json.dumps({"ok": False, "error":
                                            "the terminal window is not "
                                            "open, nothing to show it in"})
                    return _json.dumps({
                        "ok": True, "symbol": sym,
                        "note": "the terminal is filing the strategy in the "
                                "workspace, pinning it to " + sym + " and "
                                "running it in BACKTEST > ALGO DEVELOPMENT; "
                                "the results window shows the trade list, "
                                "equity curve, plot panes and full stats. "
                                "Tell the user it is on screen; on an older "
                                "terminal that ignores this, the To strategy "
                                "IDE button under the code then RUN does the "
                                "same."})
                return _json.dumps({"error": f"unknown tool {name}"})
            except Exception as e:  # noqa: BLE001
                return _json.dumps({"error": f"{type(e).__name__}: "
                                             f"{e}"[:400]})

        def _tool_note(name: str, args: dict) -> str:
            if name == "run_backtest":
                return f"Backtesting on {args.get('symbol', '?')}..."
            if name == "show_backtest":
                return "Opening the results on screen..."
            if name == "preview_dataset":
                return f"Reading {args.get('symbol', '?')}..."
            if name == "read_guide":
                return "Reading the terminal guide..."
            if name == "list_datasets":
                return "Reading the data library..."
            notes = {"get_positions": "Reading your positions...",
                     "get_fills": "Reading your trade history...",
                     "get_candles": f"Loading {args.get('symbol', '?')} candles...",
                     "get_economics": "Reading the economic data...",
                     "run_montecarlo": "Running the Monte Carlo...",
                     "run_walkforward": "Running the walk-forward...",
                     "list_research": "Reading the research feed...",
                     "read_research_paper": "Reading the paper...",
                     "list_workspace": "Listing your workspace...",
                     "read_workspace_file": f"Reading {args.get('path', args.get('name', '?'))}...",
                     "open_in_app": "Opening it in the app...",
                     "remember": "Saving a note...",
                     "recall": "Reading its notes...",
                     "list_ml_models": "Reading the ML catalog...",
                     "get_ml_job": "Checking the ML job..."}
            return notes.get(name, f"{name}...")

        def stream():
            msgs = [dict(m) for m in messages]
            # The guide summary rides as its own system message, placed
            # right after the app's live-context system message (the cloud
            # side merges every system message, in order, into the one
            # leading system turn its template allows). A separate message
            # rather than a paragraph inside aiContext: that message is
            # already near the cloud's 8000-char per-message cap, so an
            # appended summary would be the part that gets cut off.
            gb = guide_brief()
            if gb:
                at = 0
                while at < len(msgs) and msgs[at].get("role") == "system":
                    at += 1
                msgs.insert(at, {"role": "system", "content": gb})
            # The workflow says test before delivering, but model compliance
            # is stochastic: an untested strategy can be delivered without
            # comment and lose the whole account. The loop enforces it: a
            # final answer containing code with no successful run_backtest
            # this turn is sent back ONCE. ok_runs remembers every successful
            # test (script + target + numbers) so delivery can be verified
            # MECHANICALLY below: the model rewrites code between its last
            # test and the delivery, and sometimes describes a tested
            # strategy without any code at all.
            from lse_terminal.backtest.contract import (parse_run_pin,
                                                        run_pin_hash)
            ran_ok = False
            nudged = False
            ok_runs = []
            try:
                # 10 rounds bounds a stuck model, while a strategy that needs
                # list -> preview -> write -> test -> fix -> test fits easily.
                for _round in range(10):
                    req = urllib.request.Request(
                        ASSISTANT_URL,
                        data=_json.dumps({"messages": msgs,
                                          "max_tokens": body.max_tokens,
                                          "local_tools": local_specs}
                                         ).encode(),
                        # A real product UA: the API edge rejects the default
                        # Python-urllib agent (bot filtering) with a 403.
                        headers={"Content-Type": "application/json",
                                 "x-api-key": key,
                                 "User-Agent": f"lse-terminal/{__version__}"},
                        method="POST")
                    round_frame = None
                    text_parts = []
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        buf = b""
                        while True:
                            chunk = resp.read(1024)
                            if not chunk:
                                break
                            buf += chunk
                            while b"\n" in buf:
                                line, buf = buf.split(b"\n", 1)
                                line = line.strip()
                                if not line.startswith(b"data:"):
                                    continue
                                raw = line[5:].strip()
                                if not raw or raw == b"[DONE]":
                                    continue
                                try:
                                    fr = _json.loads(raw)
                                except ValueError:
                                    continue
                                if isinstance(fr, dict) and fr.get("lse_round"):
                                    round_frame = fr["lse_round"]
                                    continue
                                if isinstance(fr, dict):
                                    for c in fr.get("choices") or []:
                                        d = (c.get("delta") or {}).get("content")
                                        if d:
                                            text_parts.append(d)
                                # Everything else (content deltas, lse_tool
                                # chips, errors) flows to the panel as-is.
                                yield line + b"\n\n"
                    if not round_frame:
                        text = "".join(text_parts)
                        import re as _re3
                        blocks = _re3.findall(r"```(?:python|py)?\n(.*?)```",
                                              text, _re3.S)
                        code = (blocks[-1].strip() + "\n") if blocks else None
                        # Two delivery failures, one net: code that was never
                        # tested, and a tested strategy whose final message
                        # describes it without the code (the model assumes
                        # the user saw the run_backtest argument; they see
                        # only chat text). Either way, one corrective round.
                        undelivered = (ran_ok and not code
                                       and "strategy" in text.lower())
                        untested = bool(code) and not ran_ok
                        if (untested or undelivered) and not nudged:
                            nudged = True
                            msgs.append({"role": "assistant", "content": text})
                            msgs.append({"role": "user", "content":
                                         "[terminal note, not the user "
                                         "typing: the user never sees tool "
                                         "calls or their arguments. Give "
                                         "your final message again with the "
                                         "COMPLETE final code in one "
                                         "```python block and its real "
                                         "run_backtest numbers; if the code "
                                         "was never successfully run, test "
                                         "it first and fix what fails.]"})
                            continue

                        def _say(t):
                            return ("data: " + _json.dumps(
                                {"choices": [{"delta": {"content": t}}]})
                                + "\n\n").encode()

                        if ran_ok and not code and ok_runs:
                            # The model described its tested strategy without
                            # the code TWICE (the nudge above already fired).
                            # Attach the exact script from its last
                            # successful run mechanically: the product
                            # promise is code plus real numbers, never a
                            # description, and this script provably produced
                            # these numbers on this machine.
                            run = ok_runs[-1]
                            script = run["script"]
                            if not parse_run_pin(script):
                                script = (f"# run: {run['symbol']} "
                                          f"{run['timeframe']}\n" + script)
                            yield _say(
                                "\n\n```python\n" + script + "```\n"
                                f"[terminal note: attached the exact code "
                                f"from the successful test run: "
                                f"{run['trades']} trades, net {run['net']} "
                                f"on {run['symbol']} {run['timeframe']}]\n")
                            return

                        if code and run_pin_hash(code) not in \
                                {r["hash"] for r in ok_runs}:
                            # The delivered text differs from every script
                            # actually tested this turn (the pin
                            # simulations: 4 of 4 deliveries were rewritten
                            # after the last test). Verify THE DELIVERED
                            # CODE itself, so tested == delivered is a
                            # mechanical guarantee, not model compliance;
                            # this also lands its hash in the tested-run
                            # registry for the To-strategy-IDE stamp.
                            pin = parse_run_pin(code)
                            sym = (pin or {}).get("symbol") or (
                                ok_runs[-1]["symbol"] if ok_runs else None)
                            if sym:
                                yield ("data: " + _json.dumps(
                                    {"lse_tool": {
                                        "name": "run_backtest",
                                        "label": "Verifying the delivered "
                                                 "code..."}}) + "\n\n"
                                    ).encode()
                                vargs = {"script": code, "symbol": sym}
                                if pin and pin.get("timeframe"):
                                    vargs["timeframe"] = pin["timeframe"]
                                try:
                                    vr = _json.loads(
                                        _local_tool("run_backtest", vargs))
                                except ValueError:
                                    vr = {}
                                if vr.get("ok"):
                                    yield _say(
                                        f"\n[terminal verified this exact "
                                        f"code: {vr['trades']} trades, net "
                                        f"{vr['net_profit']} on "
                                        f"{vr['symbol']} {vr['timeframe']}]\n")
                                elif not nudged:
                                    # Broken delivery (e.g. an unterminated
                                    # string the model never ran): one
                                    # corrective round with the real error
                                    # beats printing a failure note under
                                    # dead code.
                                    nudged = True
                                    msgs.append({"role": "assistant",
                                                 "content": text})
                                    msgs.append({"role": "user", "content":
                                                 "[terminal note, not the "
                                                 "user typing: the exact "
                                                 "code you delivered fails "
                                                 "to run: "
                                                 + str(vr.get("error"))[:300]
                                                 + " . Fix it, run_backtest "
                                                 "the corrected code, and "
                                                 "deliver it unchanged in "
                                                 "one ```python block.]"})
                                    continue
                                else:
                                    yield _say(
                                        f"\n[terminal note: this exact code "
                                        f"FAILED verification on {sym}: "
                                        f"{str(vr.get('error'))[:200]}]\n")
                        return  # the model answered; the turn is complete
                    calls = round_frame.get("tool_calls") or []
                    web_results = round_frame.get("web_results") or {}
                    msgs.append({"role": "assistant",
                                 "content": "".join(text_parts) or None,
                                 "tool_calls": [
                                     {"id": c.get("id") or "",
                                      "type": "function",
                                      "function": {
                                          "name": c.get("name") or "",
                                          "arguments": c.get("arguments")
                                          or "{}"}}
                                     for c in calls]})
                    for c in calls:
                        cid = c.get("id") or ""
                        if cid in web_results:
                            content = web_results[cid]
                        else:
                            try:
                                cargs = _json.loads(c.get("arguments") or "{}")
                                if not isinstance(cargs, dict):
                                    cargs = {}
                            except ValueError:
                                cargs = {}
                            yield ("data: " + _json.dumps(
                                {"lse_tool": {
                                    "name": c.get("name"),
                                    "label": _tool_note(c.get("name") or "",
                                                        cargs)}})
                                + "\n\n").encode()
                            content = _local_tool(c.get("name") or "", cargs)
                            if (c.get("name") == "run_backtest"
                                    and '"ok": true' in content):
                                ran_ok = True
                                try:
                                    rr = _json.loads(content)
                                    ok_runs.append({
                                        "hash": run_pin_hash(
                                            str(cargs.get("script") or "")),
                                        "script": str(cargs.get("script")
                                                      or ""),
                                        "symbol": rr.get("symbol"),
                                        "timeframe": rr.get("timeframe"),
                                        "trades": rr.get("trades"),
                                        "net": rr.get("net_profit")})
                                except ValueError:
                                    pass
                        msgs.append({"role": "tool", "tool_call_id": cid,
                                     "content": content})
                # Rounds exhausted mid-iteration. One final request WITHOUT
                # tools forces the model to deliver its best tested version
                # instead of ending on a progress sentence with no code,
                # which is where hard-iterating asks otherwise die.
                msgs.append({"role": "user", "content":
                             "[terminal note, not the user typing: tool "
                             "rounds for this question are used up. Deliver "
                             "your best tested version NOW in one ```python "
                             "block with its real backtest numbers, and say "
                             "plainly if it still loses money.]"})
                req = urllib.request.Request(
                    ASSISTANT_URL,
                    data=_json.dumps({"messages": msgs,
                                      "max_tokens": body.max_tokens}
                                     ).encode(),
                    headers={"Content-Type": "application/json",
                             "x-api-key": key,
                             "User-Agent": f"lse-terminal/{__version__}"},
                    method="POST")
                with urllib.request.urlopen(req, timeout=300) as resp:
                    while True:
                        chunk = resp.read(1024)
                        if not chunk:
                            break
                        yield chunk
            except urllib.error.HTTPError as e:
                detail = ""
                try:
                    detail = _json.loads(e.read()).get("error", "")
                except Exception:
                    pass
                yield ("data: " + _json.dumps(
                    {"error": detail or f"assistant HTTP {e.code}"}) + "\n\n").encode()
            except Exception as e:
                yield ("data: " + _json.dumps(
                    {"error": str(e)[:200]}) + "\n\n").encode()

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.post("/api/config/lse_key")
    def set_key(body: KeyIn):
        deny_hosted()
        key = body.key.strip()
        if not key:
            raise HTTPException(400, "empty key")
        # Prove it BEFORE storing. lse_configured is just bool(saved key) and
        # MARKETS only shows the connect form while nothing is saved, so a
        # persisted bad key used to lock the user out of the screen that fixes
        # it. verify_key only refuses on a real 401/403, never on being offline.
        from lse_terminal.providers.lse import verify_key
        ok, why = verify_key(key)
        if not ok:
            raise HTTPException(400, why)
        close_old = getattr(reg.get("lse"), "close_sync", None)
        if close_old is not None:
            close_old()
        old_key = cfg.get_lse_api_key()
        cfg.set_lse_api_key(key)
        # Replace the provider so the new key takes effect without a restart.
        from lse_terminal.providers import LseProvider
        reg.register(LseProvider(api_key=key))
        if old_key and old_key != key:
            # A pinned demo account belongs to the OLD key's login; carried
            # across, the adapter's strict binding refuses to connect (no
            # such demo account under the new login). Forget the choice and
            # drop any live session; the next connect binds the new login's
            # primary.
            try:
                from brueconnect import registry as _pcreg
                _pcreg.set_account("lse-sim", "")
                hub.disconnect("lse-sim")
            except Exception:
                pass  # a broker hiccup must never block saving the key
        # The LSE key IS the account: the demo account comes with the key,
        # so it connects here rather than as a separate broker the user has
        # to manage. Best effort; the data side is already live.
        try:
            hub.connect("lse-sim")
        except Exception:
            pass
        return {"ok": True}

    @app.delete("/api/config/lse_key")
    def clear_key():
        """Sign out of LSE: the key, the live data it unlocks and the demo
        account it carries all go at once, so nothing LSE keeps answering
        after the user has signed out."""
        close_old = getattr(reg.get("lse"), "close_sync", None)
        if close_old is not None:
            close_old()
        try:
            hub.disconnect("lse-sim")
        except Exception:
            pass
        c = cfg.load()
        c.pop("lse_api_key", None)
        cfg.save(c)
        from lse_terminal.providers import LseProvider
        reg.register(LseProvider())
        return {"ok": True}

    # ── simulated trading proxy ─────────────────────────────────────────────
    # The browser never sees the LSE key; the terminal backend attaches it and
    # relays to the hosted sim engine. Same endpoints for hosted and desktop.
    _SIM_BASE = os.environ.get("LSE_SIM_API", "https://api.londonstrategicedge.com")

    async def _sim_relay(method: str, path: str, body: dict | None = None):
        import urllib.request, json as _json
        key = cfg.get_lse_api_key()
        if not key:
            raise HTTPException(401, "no LSE API key configured")
        req = urllib.request.Request(
            _SIM_BASE + path, method=method,
            headers={"x-api-key": key, "Content-Type": "application/json",
                     # The edge 403s the default Python-urllib agent from
                     # datacenter IPs (same fix as provider prices()).
                     "User-Agent": "lse-terminal (+https://londonstrategicedge.com)"},
            data=_json.dumps(body).encode() if body is not None else None)
        try:
            def _do():
                with urllib.request.urlopen(req, timeout=15) as r:
                    return r.status, r.read()
            status, raw = await asyncio.to_thread(_do)
        except Exception as e:
            import urllib.error
            if isinstance(e, urllib.error.HTTPError):
                raise HTTPException(e.code, e.read().decode()[:300])
            raise HTTPException(502, f"sim api unreachable: {e}")
        return _json.loads(raw)

    @app.get("/api/sim/accounts")
    async def sim_accounts():
        return await _sim_relay("GET", "/sim/accounts")

    @app.get("/api/sim/positions")
    async def sim_positions(account_id: int):
        return await _sim_relay("GET", f"/sim/positions?account_id={account_id}")

    @app.post("/api/sim/orders")
    async def sim_order(body: dict):
        return await _sim_relay("POST", "/sim/orders", body)

    @app.get("/api/sim/orders")
    async def sim_orders_list(account_id: int):
        """Working (resting) orders, for the dock's Orders tab."""
        return await _sim_relay("GET", f"/sim/orders?account_id={account_id}")

    @app.post("/api/sim/orders/cancel")
    async def sim_order_cancel(body: dict):
        return await _sim_relay("POST", "/sim/orders/cancel", body)

    @app.post("/api/sim/modify")
    async def sim_modify(body: dict):
        return await _sim_relay("POST", "/sim/positions/modify", body)

    @app.get("/api/sim/fills")
    async def sim_fills(account_id: int, limit: int = 100):
        return await _sim_relay("GET", f"/sim/fills?account_id={account_id}&limit={limit}")

    @app.post("/api/sim/close")
    async def sim_close(account_id: int, symbol: str):
        import urllib.parse
        return await _sim_relay("POST", f"/sim/positions/close?account_id={account_id}&symbol={urllib.parse.quote(symbol, safe='')}")

    @app.websocket("/api/ws")
    async def ws(websocket: WebSocket, provider: str, symbols: str):
        await websocket.accept()
        wanted = [s for s in symbols.split(",") if s.strip()]
        # A data_local_only broker's live prices stream to the terminal's
        # own window only: a browser sends Origin on every websocket
        # handshake, a program sends none (SPEC 3.3).
        why = _local_refusal(_source_broker(provider), "Live prices")
        if why and not _terminal_window(websocket.headers):
            await websocket.send_json({"type": "error", "message": why})
            await websocket.close()
            return
        try:
            p = reg.get(provider)
            agen = p.stream(wanted)
        except (ValueError, NotSupported) as e:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close()
            return
        try:
            await bridge(websocket, agen)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            try:
                await websocket.send_json({"type": "error", "message": _said(
                    _source_broker(provider), e)[:200]})
            except Exception:
                pass
        finally:
            await agen.aclose()
            try:
                await websocket.close()
            except (WebSocketDisconnect, RuntimeError):
                pass

    # ── Algo trading: run a strategy LIVE against a brue-connect adapter ──
    #
    # MT5-style attach: the editor's Brue strategy + a symbol/timeframe +
    # the paper broker adapter, supervised as a subprocess of the engine.
    # The live driver (brue-connect/runner/live_driver.py) re-runs the
    # script on every closed bar and turns final-bar intents into connector
    # orders with deterministic ids, so stop/start/crash cannot double-send.
    # Local-only like the AI PTY (deny_hosted): runs spawn processes.
    import shlex as _shlex
    import subprocess as _subprocess
    import uuid as _uuid

    algo_runs: dict = {}
    algo_dir = cfg.config_dir() / "algo"
    # brueconnect resolves like any dependency: the installed wheel ships
    # the adapters and runner inside the package, so user installs need no
    # checkout and no env var. LSE_BRUE_CONNECT_DIR (or a brue-connect
    # checkout sitting next to this repo, the documented dev layout)
    # remains the dev override and wins when present.
    from .broker_hub import connect_base

    _env_dir = os.environ.get("LSE_BRUE_CONNECT_DIR")
    connect_dir = (Path(_env_dir) if _env_dir
                   else Path(__file__).resolve().parents[3] / "brue-connect")

    def _connect_base_or_503() -> Path:
        try:
            return connect_base(connect_dir)
        except ImportError:
            raise HTTPException(
                503, "brueconnect, the broker kit, is not installed. Update "
                     "or reinstall the terminal, or set LSE_BRUE_CONNECT_DIR "
                     "to a checkout")

    def _algo_row(rid: str, r: dict) -> dict:
        proc = r["proc"]
        running = proc.poll() is None
        last = ""
        try:
            jl = r["journal"]
            if jl.exists():
                lines = jl.read_text().strip().splitlines()
                if lines:
                    last = lines[-1][:300]
        except OSError:
            pass
        return {"id": rid, "symbol": r["symbol"], "timeframe": r["timeframe"],
                "started": r["started"], "running": running,
                "exit_code": None if running else proc.returncode,
                "last_journal": last}

    @app.get("/api/algo/runs")
    def algo_runs_list():
        return [_algo_row(rid, r) for rid, r in sorted(algo_runs.items())]

    @app.post("/api/algo/start")
    def algo_start(body: AlgoStartIn, request: Request):
        deny_hosted()
        own_origin_only(request)
        base = _connect_base_or_503()
        driver = base / "runner" / "live_driver.py"
        adapter = base / "adapters" / "paper" / "paper_adapter.py"
        if not driver.exists() or not adapter.exists():
            raise HTTPException(
                503, f"The broker kit (brueconnect) at {base} is missing "
                     "its runner or its paper adapter. Update or reinstall "
                     "the terminal.")
        if not (body.script or "").strip():
            raise HTTPException(400, "empty strategy script")
        rid = _uuid.uuid4().hex[:8]
        rdir = algo_dir / rid
        rdir.mkdir(parents=True, exist_ok=True)
        script_path = rdir / "strategy.brue"
        script_path.write_text(body.script)
        journal = rdir / "journal.jsonl"
        log = rdir / "run.log"
        adapter_cmd = f"{_shlex.quote(sys.executable)} {_shlex.quote(str(adapter))} --tick-ms 200"
        cmd = [sys.executable, str(driver),
               "--script", str(script_path),
               "--symbol", body.symbol, "--timeframe", body.timeframe,
               "--adapter", adapter_cmd,
               "--warmup", str(int(body.warmup)), "--bars", str(int(body.bars)),
               "--journal", str(journal), "--flatten-on-exit"]
        # cwd is the run dir, not a checkout: driver and adapter resolve
        # their own imports (wheel or checkout) since the package move
        proc = _subprocess.Popen(
            cmd, cwd=str(rdir),
            stdout=open(log, "ab"), stderr=_subprocess.STDOUT)
        algo_runs[rid] = {"proc": proc, "symbol": body.symbol,
                          "timeframe": body.timeframe, "journal": journal,
                          "log": log, "started": int(time.time())}
        return _algo_row(rid, algo_runs[rid])

    def _algo_stop_one(r: dict) -> None:
        proc = r["proc"]
        if proc.poll() is None:
            proc.terminate()  # driver flattens on exit
            try:
                proc.wait(timeout=15)
            except _subprocess.TimeoutExpired:
                proc.kill()

    @app.post("/api/algo/stop")
    def algo_stop(body: dict):
        deny_hosted()
        rid = str(body.get("id", ""))
        r = algo_runs.get(rid)
        if r is None:
            raise HTTPException(404, f"no algo run {rid!r}")
        _algo_stop_one(r)
        return _algo_row(rid, r)

    @app.post("/api/algo/killswitch")
    def algo_killswitch():
        deny_hosted()
        for r in algo_runs.values():
            _algo_stop_one(r)
        return {"stopped": len(algo_runs)}

    @app.get("/api/algo/journal")
    def algo_journal(id: str, limit: int = 100):
        r = algo_runs.get(id)
        if r is None:
            raise HTTPException(404, f"no algo run {id!r}")
        events = []
        try:
            if r["journal"].exists():
                import json as _json
                for line in r["journal"].read_text().strip().splitlines()[-limit:]:
                    try:
                        events.append(_json.loads(line))
                    except ValueError:
                        pass
        except OSError:
            pass
        log_tail = ""
        try:
            if r["log"].exists():
                log_tail = r["log"].read_text(errors="replace")[-4000:]
        except OSError:
            pass
        return {"events": events, "log_tail": log_tail}

    # ── Broker connections: brue-connect, the universal trading door ────
    #
    # Every broker (our demo, the bundled paper simulator, any onboarded
    # external broker) is one adapter command behind one hub; no endpoint
    # here knows a broker by name. Local-only like the algo runner: a
    # connection is a subprocess on the user's machine and their broker
    # credentials never touch our servers.
    from .broker_hub import (BrokerHub, DIRECTORY_REFRESH_S, WORDS_CHARS,
                             fetch_directory)

    # The identity cache remembers what each broker calls itself, so the
    # connection picker can name them before anything is spawned.
    hub = BrokerHub(connect_dir,
                    identity_cache=cfg.config_dir() / "broker_identity.json")
    # Reachable beside app.state.registry, for the same readers: tests and
    # anything in-process that needs the hub the routes below are using.
    app.state.broker_hub = hub
    # The window's requests from the moment they are handed on
    # (held_requests.py): written out by _mutating before the hub has them,
    # changed by their answers, read by GET /api/broker/held, let go by
    # unlinking the broker. Read now, as the engine starts (what a run that
    # stopped left out is unknown from now on); the hosted terminal, which
    # has no broker routes, keeps none.
    from .held_requests import FILE_NAME as _HELD_FILE, HeldRequests
    held = None if hosted else HeldRequests(cfg.config_dir() / _HELD_FILE)
    app.state.held_requests = held
    # Directory refresh off the startup path: the terminal must come up
    # instantly offline; the remote listing lands on the hub (and the
    # provider gate below) as soon as the first fetch returns.
    import threading as _threading0
    directory_state = {"d": None, "at": 0.0, "lock": _threading0.Lock()}
    app.state.directory_state = directory_state  # read by /api/providers
    _dir_cache = cfg.config_dir() / "directory.json"

    def _refresh_directory():
        d = fetch_directory(_dir_cache)
        directory_state["d"] = d
        directory_state["at"] = time.time()
        hub.apply_directory(d)
        return d
    app.state.directory_refresh = _refresh_directory

    def _directory_loop():
        import threading as _t
        while True:
            _refresh_directory()
            _t.Event().wait(DIRECTORY_REFRESH_S)

    import threading as _threading
    _threading.Thread(target=_directory_loop, daemon=True).start()

    def _said(broker, text) -> str:
        """An adapter's words as a route answers them: the values its
        profile keeps (stored keys, its own env's values) taken out
        (BrokerHub.redact), before anything is cut, so a value is never
        left half shown."""
        text = text if isinstance(text, str) else str(text or "")
        if not broker or not text:
            return text
        try:
            return hub.redact(broker, text)
        except Exception:  # noqa: BLE001 - words that cannot be checked are not said
            return "The adapter's words could not be checked for its keys."

    def _hub_call(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except KeyError as e:
            raise HTTPException(404, str(e))
        except LookupError as e:
            raise HTTPException(409, str(e))
        except HTTPException:
            raise
        except Exception as e:
            # An unarmed broker is a decision the user has not made yet, not a
            # fault: 403 so the UI can offer the decision. Typed by the SDK
            # (brueconnect.NotArmed), matched on its code so this stays a
            # thin HTTP layer over the one arming rule.
            #
            # (Was two sibling `except Exception` blocks; the second was
            # unreachable, so every adapter-typed error fell out as a bare
            # 500 and the UI showed "Internal Server Error" instead of the
            # broker's own reason.)
            code = getattr(e, "code", None)
            if code == "not_armed":
                raise HTTPException(403, str(e))
            # adapter-typed errors (insufficient_margin, invalid_stops,
            # market_closed...) pass through so the ticket can show them;
            # ConnectorError's str already leads with its code. They are said
            # whole (WORDS_CHARS bounds only a dump): a connect's refusal can
            # put who may not use the broker's API last. A mutating call that
            # an identical retry can mend, or whose outcome is not known (its
            # answer was lost), carries what asking again needs too
            # (`lse_again`, rendered by _mutating).
            again = bool(getattr(e, "client_id", None)
                         and getattr(e, "retryable", False))
            # Every hub call names the broker first; what the profile keeps
            # is taken out of the adapter's words before they are cut.
            broker = a[0] if a and isinstance(a[0], str) else ""
            out = HTTPException(502 if code is None else 400,
                                _said(broker, str(e))[:WORDS_CHARS])
            if again:
                out.lse_again = {"retryable": True,
                                 "unknown": bool(getattr(e, "fate_unknown", False)),
                                 "client_id": e.client_id}
                if code is not None:
                    out.lse_again = {"code": code, **out.lse_again}
            raise out

    # ── A broker's own words, and a program (SPEC 3.3) ──────────────────────
    # An adapter's error text, its session's detail and the lines it prints
    # are its own words, and they can carry its prices: a margin "need", "AAPL
    # is at ...", "the positions are worth ...", "last bid ...". On a
    # data_local_only connection a program is given the error code and the
    # sentence saying why in their place. The terminal's own window keeps
    # them: its ticket and its Connections card show the broker's reason.
    # An error code as SPEC 6 spells one (insufficient_margin, or an adapter's
    # own x_<name>): what is kept of a broker's words when they are withheld.
    import re as _re_mod  # noqa: PLC0415
    _ERROR_CODE = _re_mod.compile(r"[a-z][a-z0-9_]{0,39}")
    _SESSION_STATES = ("connected", "degraded", "disconnected")
    # An Account as SPEC 4 names its fields (accounts.list): the account's own
    # record. What else an adapter adds to one may be marked to the prices.
    _ACCOUNT_ROW_KEEP = frozenset({"id", "label", "currency", "mode", "type",
                                   "balance", "selected"})

    def _code_of(text) -> str:
        head = str(text or "").split(":", 1)[0].strip()
        return head if _ERROR_CODE.fullmatch(head) else ""

    def _program_on_local(request: Request, broker: str) -> bool:
        """A caller that is not the terminal's own window, about a connection
        whose broker's terms keep its prices on this computer."""
        return bool(_local_refusal(broker)) and not _terminal_window(
            request.headers)

    def _withheld_words(broker: str, what: str) -> str:
        try:
            return hub.withheld(broker, what)
        except Exception:  # noqa: BLE001 - a refusal must always be said
            return (f"{what} withheld: this broker's terms could not be read, "
                    "so its prices stay on this computer.")

    def _broker_call(request: Request, broker: str, fn, *a, **kw):
        """_hub_call for a route that relays what the broker says: an order
        refused or rejected, a read or a connect that failed. For a program
        on a data_local_only connection a 400 keeps its error code and
        carries the sentence instead of the broker's words, and so does a
        502 that is not the kit's own (the adapter gone or silent); what
        asking again needs (the client_id, and whether the outcome is
        known) is kept. Decided AFTER the call, on the terms known then: a
        connect's own hello can be what says them."""
        try:
            out = _hub_call(fn, *a, **kw)
        except HTTPException as e:
            # 400 is _hub_call's adapter-typed branch, its detail led by the
            # error code. A 502 is the kit's words when the adapter is gone or
            # did not answer (Disconnected, a timeout) and may quote what the
            # adapter sent otherwise. 403, 404 and 409 are the kit's or the
            # hub's words.
            cause = type(e.__context__).__name__ if e.__context__ else ""
            words = e.status_code == 400 or (
                e.status_code == 502
                and cause not in ("Disconnected", "TimeoutError"))
            if words and _program_on_local(request, broker):
                code = _code_of(e.detail) if e.status_code == 400 else ""
                why = _withheld_words(broker, "The broker's reason")
                said = HTTPException(e.status_code,
                                     f"{code}: {why}" if code else why)
                if getattr(e, "lse_again", None):
                    said.lse_again = e.lse_again
                raise said from None
            raise
        if isinstance(out, dict) and isinstance(out.get("reason"), str) and out["reason"]:
            # A rejected order's reason is the adapter's words too.
            out = dict(out, reason=(
                _withheld_words(broker, "The broker's reason")
                if _program_on_local(request, broker) else _said(broker, out["reason"])))
        return out

    def _row_for(request: Request, row):
        """A broker's status row as this caller may have it. For a program,
        on a data_local_only connection, the adapter's own words in it (its
        session's detail, a failed connect's message, the last lines the
        adapter printed then and in its runs, `printed`) are the sentence
        saying why, an error code kept, and its accounts keep the account's
        own record. Everything else stays, and the window and every
        connection without such terms get the row as it is."""
        if not isinstance(row, dict) or _terminal_window(request.headers):
            return row
        broker = str(row.get("broker") or "")
        if not _local_refusal(broker):
            # Lines kept from a run that was held under the terms in force
            # for it stay held, whatever the terms are now.
            if row.get("printed"):
                try:
                    if hub.printed_held(broker):
                        row = dict(row, printed=hub.printed_lines(broker, program=True))
                except Exception:  # noqa: BLE001 - cannot tell which: none of them
                    row = {k: v for k, v in row.items() if k != "printed"}
            return row
        why = _withheld_words(broker, "The broker's own words")
        out = dict(row)
        sess = out.get("session")
        if isinstance(sess, dict):
            state = sess.get("state")
            kept = {"state": state if state in _SESSION_STATES else why}
            if any(k != "state" for k in sess):
                kept["detail"] = why
            out["session"] = kept
        failed = out.get("last_error")
        if isinstance(failed, dict):
            code = _code_of(failed.get("message"))
            kept = {"message": f"{code}: {why}" if code else why}
            if "at" in failed:
                kept["at"] = failed["at"]
            if failed.get("stderr"):
                kept["stderr"] = why
            out["last_error"] = kept
        if out.get("printed"):
            # what the adapter printed in its runs, for the window's card
            out["printed"] = why
        if isinstance(out.get("accounts"), list):
            out["accounts"] = [
                {k: v for k, v in acct.items() if k in _ACCOUNT_ROW_KEEP}
                for acct in out["accounts"] if isinstance(acct, dict)]
        return out

    @app.get("/api/broker/list")
    def broker_list(request: Request):
        # Also denied in the hosted terminal: listing brokers there would show
        # rows that can never be named or connected (every other endpoint here
        # is local-only), and an inert broker list reads as a broken one.
        deny_hosted()
        return [_row_for(request, r) for r in hub.list_brokers()]

    @app.post("/api/broker/arm")
    def broker_arm(body: dict, request: Request):
        """Clear a broker that is not paper to receive orders, or take it back.

        The rule is the SDK's (brueconnect.Connector refuses the call), so
        this endpoint only carries the user's decision to it. The consent
        lives on the connection and dies with it: nothing on disk can arm real
        money.
        """
        deny_hosted()
        own_origin_only(request)
        # Arming lets the next order through, so on a live orders_by_hand_only
        # connection only the user, in this window, gives that consent.
        # Taking it back is open to anyone.
        if bool(body.get("armed", True)):
            by_hand_only(request, str(body.get("broker", "")))
        return _hub_call(hub.arm, str(body.get("broker", "")),
                         bool(body.get("armed", True)),
                         str(body.get("reason") or "armed from the terminal"))

    @app.post("/api/broker/probe")
    def broker_probe(body: dict, request: Request):
        """Handshake only: fills in a broker's own name for the picker.

        Deliberately separate from connect. Opening a session on a live
        broker is a decision the user makes; learning what it is called is
        not, and the picker needs the second without the first.
        """
        deny_hosted()
        own_origin_only(request)
        broker = str(body.get("broker", ""))
        return _row_for(request, _broker_call(request, broker, hub.probe, broker))

    def _sync_broker_source(broker: str, status: dict) -> dict:
        """A connected broker becomes a selectable DATA source, and stops
        being one the moment it disconnects.

        Offered only when the venue can actually serve candles: a broker that
        declares no bars/history is an execution venue, not a data source, and
        listing it would hand the user a source whose chart is always empty.
        Backtests and research never follow this; they stay on the data
        connection, because a venue's history is a shallow slice next to the
        LSE archive.
        """
        from .broker_hub import BrokerProvider, cap_flag  # noqa: PLC0415
        c = hub.conns.get(broker)
        if (status.get("connected") and cap_flag(c, "data", "bars")
                and cap_flag(c, "data", "history")):
            # the periods its adapter serves when our listing says (30m
            # among them), else the provider contract's own
            try:
                periods = hub.timeframes_of(broker)
            except Exception:  # noqa: BLE001 - not known: the contract's own
                periods = None
            reg.register(BrokerProvider(hub, broker, status.get("label") or broker,
                                        timeframes=periods))
            status["data_source"] = f"broker:{broker}"
        else:
            reg.unregister(f"broker:{broker}")
        return status

    @app.post("/api/broker/connect")
    def broker_connect(body: dict, request: Request):
        deny_hosted()
        own_origin_only(request)
        broker = str(body.get("broker", ""))
        return _row_for(request, _sync_broker_source(
            broker, _broker_call(request, broker, hub.connect, broker)))

    @app.post("/api/broker/disconnect")
    def broker_disconnect(body: dict, request: Request):
        deny_hosted()
        own_origin_only(request)
        broker = str(body.get("broker", ""))
        return _sync_broker_source(broker, _hub_call(hub.disconnect, broker))

    @app.post("/api/broker/credentials")
    def broker_credentials(body: dict, request: Request):
        """Save the user's own key for a broker, on this machine only.

        The connection screen collects whatever fields the broker's profile
        asks for; they land in that profile's private state directory and are
        handed to its adapter as environment at spawn (SPEC 8.5). Nothing is
        sent to us and nothing is echoed back: the response names the fields
        stored, never their values, so no log line can leak a secret.
        """
        deny_hosted()
        own_origin_only(request)
        values = body.get("values")
        if not isinstance(values, dict):
            raise HTTPException(400, "values must be an object of field: value")
        # merge: write only the fields the user actually typed and keep
        # every other stored value. Without it the object REPLACES what was
        # stored (and an empty one forgets it all), which is the older
        # contract and the explicit "forget keys" action.
        return _hub_call(hub.set_credentials, str(body.get("broker", "")),
                         values, bool(body.get("merge")))

    # ── Add your own broker ──────────────────────────────────────────────
    # These three decide what program runs on the user's machine, so they
    # carry own_window_only (above) rather than deny_hosted alone, and the
    # two that change anything read their body by hand so that guard runs
    # before a byte of it is parsed. The logic is the hub's; a route here
    # only checks the request's shape and turns the hub's answer into HTTP.
    from fastapi.concurrency import run_in_threadpool as _in_thread
    from fastapi.responses import JSONResponse as _JSONResponse
    from .broker_hub import LinkError

    _LINK_FIELDS = {"name", "python_file", "args", "description", "env",
                    "example", "test"}

    def _link_refusal(e: LinkError, request: Request | None = None):
        # A string `detail` like every other error here, plus the tail of
        # the adapter's own stderr when it was run: a broken adapter's
        # traceback is the one thing its author needs, and it used to exist
        # only in the engine's log file. A program linking a row whose terms
        # keep its prices on this computer gets the sentence in place of the
        # adapter's words (LinkError.withheld); the window gets them whole.
        words = getattr(e, "withheld", None)
        if (isinstance(words, dict) and request is not None
                and not _terminal_window(request.headers)):
            return _JSONResponse({"detail": words.get("detail") or str(e),
                                  "stderr": words.get("stderr") or ""},
                                 status_code=e.status)
        return _JSONResponse({"detail": str(e), "stderr": e.stderr or ""},
                             status_code=e.status)

    @app.get("/api/broker/examples")
    def broker_examples(request: Request):
        """Adapters shipped inside the kit that can be linked in one click."""
        own_window_only(request, json_body=False)
        return hub.examples()

    # The two reads behind "+ Add your own broker"'s instructions. Read-only,
    # and for the same window as the routes beside them: the second names
    # folders on this machine.
    @app.get("/api/broker/template")
    def broker_template(request: Request):
        """The kit's starter adapter, as a file to save
        (my_broker_adapter.py). A link to it with `download` saves it in a
        browser; in the desktop window it meets Electron's default for a
        download, which asks where to save it (the shell sets no handler of
        its own)."""
        own_window_only(request, json_body=False)
        path = hub.template_path()
        if path is None:
            raise HTTPException(404, "This terminal's kit has no starter "
                                     "adapter. Update the terminal.")
        from fastapi.responses import Response as _Response  # noqa: PLC0415
        return _Response(
            path.read_bytes(), media_type="text/x-python; charset=utf-8",
            headers={"Content-Disposition":
                     'attachment; filename="my_broker_adapter.py"'})

    @app.post("/api/broker/template/save")
    async def broker_template_save(request: Request):
        """"Create my starter adapter": the kit's starter written to the
        user's own folder (BrokerHub.save_template), its path returned for
        the card to fill in. An existing file there is kept as it is."""
        own_window_only(request)
        try:
            return hub.save_template()
        except LookupError:
            raise HTTPException(404, "This terminal's kit has no starter "
                                     "adapter. Update the terminal.")
        except OSError as e:
            raise HTTPException(500, f"The starter adapter could not be saved: {e}")

    @app.post("/api/broker/template/reveal")
    async def broker_template_reveal(request: Request):
        """"Open folder": the saved starter shown in the file manager. Only
        that file or its folder; the page names no path."""
        own_window_only(request)
        try:
            return hub.reveal_template()
        except LookupError:
            raise HTTPException(404, "Create the starter adapter first.")
        except OSError as e:
            raise HTTPException(500, f"The folder could not be opened: {e}")

    @app.get("/api/broker/own-guide")
    def broker_own_guide(request: Request):
        """This machine's facts for adding a broker of your own: the Python
        that runs an adapter, its version, the SDK folder, the platform and
        the command that tests the starter adapter (BrokerHub.own_guide)."""
        own_window_only(request, json_body=False)
        return hub.own_guide()

    @app.post("/api/broker/link")
    async def broker_link(request: Request):
        """Link an adapter of the user's own: a .py file, or a kit example.

        The adapter is run and handshaken before anything is stored (always,
        from this route: a `test` field is accepted and cannot switch it
        off). On failure nothing is stored and the answer carries the
        adapter's own error and its stderr tail. On success: the hub row.
        """
        own_window_only(request)
        body = await json_object(request)
        unknown = sorted(set(body) - _LINK_FIELDS)
        if unknown:
            # Refused, not ignored: a caller that sent `command` or `argv`
            # believes it registered that, and it did not.
            raise HTTPException(400, f"unknown field(s): {', '.join(unknown)}")
        try:
            status = await _in_thread(
                hub.link, body.get("name"),
                python_file=body.get("python_file"), args=body.get("args"),
                description=body.get("description") or "",
                env=body.get("env"), example=body.get("example"))
        except LinkError as e:
            return _link_refusal(e, request)
        # The row as this caller may have it: a program on a data_local_only
        # row gets the sentence in place of what the test spawn printed.
        return _row_for(request, status)

    @app.post("/api/broker/unlink")
    async def broker_unlink(request: Request):
        """Remove a broker the user linked (disconnecting it first).
        `forget` also deletes its stored keys and account choice."""
        own_window_only(request)
        body = await json_object(request)
        name = str(body.get("name") or body.get("broker") or "")
        try:
            out = await _in_thread(hub.unlink, name, bool(body.get("forget")))
        except KeyError as e:
            raise HTTPException(404, str(e.args[0]) if e.args else str(e))
        except LinkError as e:
            return _link_refusal(e)
        reg.unregister(f"broker:{name}")
        # Unlinked (and, with `forget`, forgotten): its requests are no
        # longer held.
        if held is not None:
            held.forget_broker(name)
        return out

    @app.post("/api/broker/account")
    def broker_account(body: dict, request: Request):
        """Pick which of the login's accounts this broker deals on.

        Stored on this machine and applied by spawning the adapter bound to
        it, so the account is fixed before the process exists and switching
        is always a fresh session rather than a swap under open positions.
        """
        deny_hosted()
        own_origin_only(request)
        broker = str(body.get("broker", ""))
        # An empty account_id FORGETS the choice, which is how "switch
        # account" reopens the chooser without making the user log in again.
        account_id = str(body.get("account_id", ""))
        # While this broker has a request still out or unknown, switching
        # account asks first: a bare switch is refused with the oldest held
        # request's own sentence, and switches nothing, so a held request is
        # never left bound to an account the user has moved off. "confirm":
        # true goes ahead; the held entries keep the account they went out
        # on, so an Ask again on one of them is then refused until the user
        # switches back (held_other_account, _mutating).
        if held is not None and not body.get("confirm"):
            oldest = held.oldest_live(broker)
            if oldest is not None:
                return _JSONResponse({"detail": _held_sentence(oldest),
                                      "code": "held_requests"}, status_code=409)
        return _row_for(request, _sync_broker_source(
            broker, _broker_call(request, broker, hub.choose_account, broker,
                                 account_id)))

    @app.post("/api/broker/auth/open")
    def broker_auth_open(body: dict, request: Request):
        """Open the pending broker login in the user's own browser.

        The engine runs on the user's machine (deny_hosted above), so
        webbrowser.open lands on THEIR default browser in both shells: the
        desktop app and plain `lset`. The url comes from the hub's pending
        login, never from the request body: the page cannot make this
        endpoint open an arbitrary address. Returned as well, so the UI can
        show a clickable fallback link if no window appeared (headless
        engine, exotic desktop).
        """
        deny_hosted()
        own_origin_only(request)
        broker = str(body.get("broker", ""))
        url = _hub_call(hub.auth_url, broker)
        if not url:
            raise HTTPException(409, f"no login is pending for {broker!r}; "
                                     "connect first")
        import webbrowser  # noqa: PLC0415
        try:
            opened = webbrowser.open(url)
        except Exception:
            opened = False
        return {"broker": broker, "url": url, "opened": bool(opened)}

    @app.get("/api/broker/catalog")
    def broker_catalog(broker: str, request: Request):
        rows = _broker_call(request, broker, hub.catalog, broker)
        # For a data_local_only connection a program gets each instrument as
        # the broker's contract for it, SPEC 4's record all the way down, and
        # nothing worked out from a price: a minimum stop stated as a share of
        # the price comes back in points of it, which with the tick size gives
        # the price back (SPEC 3.3). Such a figure is kept where our listing
        # says the broker's adapter sends it fixed (hub.priced_fields). Each
        # row that lost a field says which, by its path, and why. The window,
        # whose ticket sizes and prices orders from the whole row, gets every
        # field.
        if not _program_on_local(request, broker):
            return rows
        from .broker_hub import PRICED_FIELDS, instrument_record_only  # noqa: PLC0415
        try:
            priced = hub.priced_fields(broker)
        except Exception:  # noqa: BLE001 - not known which: all of them
            priced = PRICED_FIELDS
        said, out = {}, []
        for spec in rows:
            kept, dropped = instrument_record_only(spec, priced)
            if dropped:
                what = ", ".join(dropped)
                if what not in said:
                    said[what] = _withheld_words(broker, what)
                kept["withheld"] = said[what]
            out.append(kept)
        return out

    @app.get("/api/broker/account")
    def broker_account(broker: str, request: Request):
        acct = _broker_call(request, broker, hub.account, broker)
        # For a data_local_only connection a program gets the account's own
        # record (its balance, currency and names) and not the figures marked
        # to its positions' current prices (equity, margin in use, free
        # margin), which give those prices back (SPEC 3.3); the answer says
        # which were held back, and why.
        if _local_refusal(broker) and not _terminal_window(request.headers):
            from .broker_hub import account_record_only, priced_names  # noqa: PLC0415
            kept, dropped = account_record_only(acct)
            named = priced_names(acct, dropped)
            if named:
                kept["withheld"] = hub.withheld(broker, ", ".join(named))
            return kept
        return acct

    @app.get("/api/broker/positions")
    def broker_positions(broker: str, request: Request):
        rows = _broker_call(request, broker, hub.positions, broker)
        # The account's own records are not market data (SPEC 3.3), so a
        # program still gets them; for a data_local_only connection it gets
        # nothing else: not a current price or market value an adapter added,
        # nor the unrealised P/L marked to it. Each position that lost a field
        # says which, and why.
        if _local_refusal(broker) and not _terminal_window(request.headers):
            from .broker_hub import priced_names, record_only  # noqa: PLC0415
            out = []
            for p in rows:
                kept, dropped = record_only(p)
                named = priced_names(p, dropped)
                if named:
                    kept["withheld"] = hub.withheld(broker, ", ".join(named))
                out.append(kept)
            return out
        return rows

    @app.post("/api/broker/subscribe")
    def broker_subscribe(body: dict, request: Request):
        """Price the ticket and held positions using the display-owned subscription set."""
        deny_hosted()
        own_origin_only(request)
        syms = body.get("symbols") or []
        if not isinstance(syms, list):
            raise HTTPException(400, "symbols must be a list")
        # The window that asks, so two windows' tickets keep their own
        # claims (BrokerHub.subscribe_display). A page that names none is
        # the one display there always was.
        display = _window_of(request) or ""
        return _broker_call(request, str(body.get("broker", "")),
                            hub.subscribe_display, str(body.get("broker", "")),
                            [str(s) for s in syms], display)

    @app.get("/api/broker/quotes")
    def broker_quotes(broker: str, request: Request):
        local_data_only(request, broker, "Prices")
        return _hub_call(hub.latest_quotes, broker)

    # ── asking again (SPEC 2) ──────────────────────────────────────────────
    # The order, close and cancel routes take back the client_id an earlier
    # answer gave. A request whose answer was lost may have been carried out;
    # sent again under the same client_id it is answered from the broker's
    # own record, never carried out a second time, where a new client_id is
    # a new order. Without one, the hub makes a new one, as before.
    _CLIENT_ID = _re_mod.compile(r"[A-Za-z0-9][!-~]{0,127}")

    def _client_id_of(body: dict):
        cid = body.get("client_id")
        if cid is None or cid == "":
            return None
        if not isinstance(cid, str) or not _CLIENT_ID.fullmatch(cid):
            raise HTTPException(
                400, "client_id must be the one an earlier answer gave: up "
                     "to 128 letters, digits and signs, with no spaces")
        return cid

    # The fields of a request body the four routes read: what asking again
    # sends, so what the record keeps of them is what was sent.
    _SENT_AGAIN = frozenset({"broker", "symbol", "side", "qty", "sl", "tp", "type",
                             "price", "stop_price", "client_id", "order_id",
                             "position_id"})

    def _secrets_out(broker: str, value, top: bool = True):
        """A request body with the values the profile keeps taken out of its
        strings (none are there from the page; kept so none can be), but for
        the fields the routes read (_SENT_AGAIN), which are kept as sent: a
        short stored value can be part of a symbol or the whole of an order
        id, and changed, asking again would ask about another one."""
        if isinstance(value, str):
            return _said(broker, value)
        if isinstance(value, dict):
            return {k: (v if top and k in _SENT_AGAIN else _secrets_out(broker, v, False))
                    for k, v in value.items()}
        if isinstance(value, list):
            return [_secrets_out(broker, v, False) for v in value]
        return value

    def _new_client_id(route: str, body: dict) -> str:
        """The client_id a window's request with none goes under, made before
        the record is written: the one the hub would make for it."""
        from .broker_hub import new_client_id  # noqa: PLC0415
        if route == "/api/broker/order/cancel":
            return new_client_id("cancel", str(body.get("order_id", "")))
        if route == "/api/broker/close":
            return new_client_id("close", str(body.get("position_id", "")),
                                 body.get("qty"))
        return new_client_id("order")

    def _instrument_of(body) -> str | None:
        """The instrument a request is about, as it names it: an order's
        symbol, and a cancel's, which the page sends beside the order id (the
        adapter is sent the order id alone)."""
        sym = body.get("symbol") if isinstance(body, dict) else None
        return sym if isinstance(sym, str) and sym else None

    # How each kind of request reads in a held sentence of a lost answer, as
    # the ticket's own line says it (app.js tpxHeldText): what may have
    # happened, where to check, and the undo it names.
    _HELD_SAY = {
        "order": ("The order may have been placed", "Positions", "placing it again"),
        "resting": ("The order may have been placed", "Orders", "placing it again"),
        "close": ("The close may have been carried out", "Positions", "closing it again"),
        "cancel": ("The cancel may have been carried out", "Orders", "cancelling it again")}

    def _held_name(entry: dict) -> str:
        """A held request named as the ticket names it (app.js tpxHeldName)."""
        b = entry.get("request") or {}
        what = entry.get("what")
        if what == "order":
            return f"The order to {b.get('side')} {b.get('qty')} {b.get('symbol')}"
        if what == "resting":
            return (f"The {b.get('side')} {b.get('type')} order for "
                    f"{b.get('qty')} {b.get('symbol')}")
        if what == "close":
            sym = entry.get("instrument") or b.get("position_id")
            return (f"The close of {b.get('qty')} {sym}" if b.get("qty") is not None
                    else f"The close of {sym}")
        return f"The cancel of order {b.get('order_id')}"

    def _held_sentence(entry: dict) -> str:
        """One held request in a sentence, as its ticket line reads it: an
        entry still out is waiting for the broker's answer; one whose answer
        was lost may have been carried out; one left by a stopped engine says
        the engine's own words (engine_stopped). The oldest such sentence is
        what an account switch of a broker with anything held is refused
        with."""
        name = hub.terms_name(entry.get("broker", ""))
        if entry.get("state") == "out":
            return f"{_held_name(entry)} is waiting for {name}'s answer."
        if entry.get("code") == "engine_stopped" and isinstance(entry.get("detail"), str):
            return entry["detail"]
        say = _HELD_SAY.get(entry.get("what"), _HELD_SAY["order"])
        return f"{say[0]}: the answer from {name} was lost. Check {say[1]} before {say[2]}."

    def _other_account_words(broker: str, entry_account, now_account) -> str:
        """Why an Ask again is refused: the request went out on one account
        and the broker is now on another, named as the card masks them."""
        name = hub.terms_name(broker)
        return (f"This request went out on {name} account {_mask_account(entry_account)}, "
                f"and {name} is now on account {_mask_account(now_account)}. Switch back "
                f"to {_mask_account(entry_account)} to ask again.")

    def _an_answer(e) -> bool:
        """Whether an exception out of a hub call is an answer the route
        relays, the broker's, the kit's or the hub's (the broker not linked
        or not connected, not armed, refused, not answered in time, the
        adapter not running), rather than the engine's own failure after the
        request was handed on, whose outcome is then not known."""
        if isinstance(e, (KeyError, LookupError, TimeoutError, HTTPException)):
            return True
        if getattr(e, "code", None) is not None:
            return True
        return type(e).__name__ == "Disconnected"

    def _answer_words(out):
        """(ok, words, code) of a 2xx answer: an order the broker rejected is
        not ok, and its reason is its words."""
        if not isinstance(out, dict):
            return True, None, None
        reason = out.get("reason")
        words = reason if isinstance(reason, str) and reason else None
        return (out.get("status") != "rejected", words,
                (_code_of(words) or None) if words else None)

    def _record_answer(ticket, status: int, said, again) -> None:
        """The answer to the window's request `ticket` names, kept by the
        record (held_requests.py): not known holds it unknown; one that
        settles it (a 2xx, or a 400 with nothing to ask again: the page's own
        reading) is listed answered; any other puts back what was held before
        it, or is listed answered when nothing was."""
        try:
            if status < 300:
                ok, words, code = _answer_words(said)
                held.settled(ticket, ok=ok, status=status, detail=words, code=code)
            elif again and again.get("unknown"):
                held.unknown(ticket, said, again.get("code"))
            elif status == 400 and not again:
                held.settled(ticket, ok=False, status=status, detail=said,
                             code=_code_of(said) or None)
            else:
                held.other(ticket, ok=False, status=status, detail=said,
                           code=(again or {}).get("code") or _code_of(said) or None)
        except Exception:  # noqa: BLE001 - the answer is said regardless
            pass

    def _mutating(request: Request, broker: str, fn, *a, held_as=None, **kw):
        """_broker_call for a route that sends the broker an order, a close
        or a cancel. A failure that an identical retry can mend, or whose
        outcome is not known because its answer was lost
        (broker_hub.fate_unknown), answers with what asking again needs
        beside the words: `retryable`, `unknown` and the `client_id` it went
        under, to send back with the same request. So does a failure of the
        engine's own after the request was handed to the hub: it may have
        been carried out.

        From the terminal's own window (`held_as`: the route and the body it
        sent), the request is kept in the record GET /api/broker/held reads,
        keyed by (broker, client_id), from before it is handed on: written
        "out" (a body with no client_id is given one first, and sent under
        it), then changed by its answer (_record_answer). A program's
        requests are never recorded."""
        ticket = None
        if (held is not None and held_as is not None
                and _terminal_window(request.headers)):
            route, body = held_as
            cid = kw.get("client_id")
            # An Ask again (a window request under a held entry's client_id)
            # on another account than the one the entry went out on is
            # refused here, before anything reaches the hub: asking again on
            # the wrong account would close or place on an account the user
            # never chose for it (SPEC 1.7). The entry stays as it was.
            if cid:
                prior = held.entry(broker, cid)
                now_acct = hub.bound_account(broker)
                if (prior is not None and prior.get("state") == "unknown"
                        and prior.get("account") and prior.get("account") != now_acct):
                    return _JSONResponse(
                        {"detail": _other_account_words(broker, prior["account"], now_acct),
                         "code": "held_other_account"}, status_code=409)
            if not cid:
                kw["client_id"] = _new_client_id(route, body)
            try:
                ticket = held.send(
                    broker, kw["client_id"], route,
                    _secrets_out(broker, {**body, "client_id": kw["client_id"]}),
                    _instrument_of(body), account=hub.bound_account(broker))
            except Exception:  # noqa: BLE001 - never a reason to refuse the order
                ticket = None
        asked = kw.get("client_id")
        slipped = []

        def handed(*fa, **fkw):
            try:
                return fn(*fa, **fkw)
            except Exception as e:
                if not _an_answer(e):
                    slipped.append(e)
                raise

        try:
            out = _broker_call(request, broker, handed, *a, **kw)
        except HTTPException as e:
            again = getattr(e, "lse_again", None)
            cid = asked or (getattr(slipped[0], "client_id", None) if slipped else None)
            if slipped and not again and cid:
                again = {"retryable": True, "unknown": True, "client_id": cid}
            if ticket is not None:
                _record_answer(ticket, e.status_code, e.detail, again)
            if not again:
                raise
            return _JSONResponse({"detail": e.detail, **again},
                                 status_code=e.status_code)
        except BaseException as e:
            # (not an answer the hub gave: the engine itself failed after
            # handing the request on)
            if ticket is not None:
                try:
                    held.unknown(ticket, "The Terminal's engine failed before the "
                                 f"broker's answer was read ({type(e).__name__}), so "
                                 "it may have been carried out.", None)
                except Exception:  # noqa: BLE001
                    pass
            raise
        if ticket is not None:
            _record_answer(ticket, 200, out, None)
        return out

    @app.post("/api/broker/order")
    def broker_order(body: dict, request: Request):
        deny_hosted()
        own_origin_only(request)
        # Orders on a live orders_by_hand_only connection come from the
        # user's own click in the terminal's window, and from nothing else.
        by_hand_only(request, str(body.get("broker", "")))
        qty = float(body.get("qty", 0))
        if not qty > 0:
            raise HTTPException(400, "qty must be > 0")
        cid = _client_id_of(body)
        broker = str(body.get("broker", ""))
        return _program_answer(request, broker, _mutating(
            request, broker,
            hub.order, broker, str(body.get("symbol", "")),
            str(body.get("side", "")), qty,
            body.get("sl"), body.get("tp"), client_id=cid,
            held_as=("/api/broker/order", body)), "order")

    @app.post("/api/broker/order/pending")
    def broker_order_pending(body: dict, request: Request):
        """Resting order (limit/stop) from the chart's right-click menu.

        Deliberately NOT a `type` field on /api/broker/order: the desktop app
        ships new static JS ahead of the frozen engine sidecar, and an old
        engine that ignored an unknown `type` would fill a "Buy Limit" click
        as an instant market order. On this separate route an old engine
        404s and the ticket reports it, which is the safe failure.
        """
        deny_hosted()
        own_origin_only(request)
        by_hand_only(request, str(body.get("broker", "")))
        qty = float(body.get("qty", 0))
        if not qty > 0:
            raise HTTPException(400, "qty must be > 0")
        otype = str(body.get("type") or "")
        if otype not in ("limit", "stop", "stop_limit"):
            raise HTTPException(400, f"bad pending order type {otype!r}")
        price = body.get("price")
        if price is None:
            raise HTTPException(400, f"{otype} order needs a price")
        cid = _client_id_of(body)
        broker = str(body.get("broker", ""))
        return _program_answer(request, broker, _mutating(
            request, broker,
            hub.order, broker, str(body.get("symbol", "")),
            str(body.get("side", "")), qty,
            body.get("sl"), body.get("tp"),
            otype, price, body.get("stop_price"), client_id=cid,
            held_as=("/api/broker/order/pending", body)), "order")

    def _record_rows(request: Request, broker: str, rows, fields):
        """A program's orders or fills rows on a data_local_only connection:
        each the account's own record (SPEC 4's fields, `fields`), saying
        which of its fields were left out and why, and an order's reason
        (the broker's own words) the sentence instead, its error code kept,
        as on the status rows. The window, and every connection without such
        terms, get the rows as the adapter sent them."""
        if not isinstance(rows, list) or not _program_on_local(request, broker):
            return rows
        from .broker_hub import priced_names, row_record_only  # noqa: PLC0415
        said, out = {}, []
        for row in rows:
            kept, dropped = row_record_only(row, fields)
            reason = kept.get("reason")
            if reason is not None:
                code = _code_of(reason) if isinstance(reason, str) else ""
                why = _withheld_words(broker, "The broker's reason")
                kept["reason"] = f"{code}: {why}" if code else why
            named = priced_names(row, dropped)
            if named:
                what = ", ".join(named)
                if what not in said:
                    said[what] = _withheld_words(broker, what)
                kept["withheld"] = said[what]
            out.append(kept)
        return out

    def _program_answer(request: Request, broker: str, out, kind: str):
        """A mutating route's answer as a program may have it. On a
        data_local_only connection: an order's `fill` is the account's own
        record of it (FILL_RECORD_FIELDS), and a cancel's, a close's or a
        modify's answer is SPEC's {}; what was left out that can carry a
        price is named in `withheld`, with why. The engine's own fields of an
        order's answer (its order_id, client_id, status and reason, which
        _broker_call already says for a program) stay. The window, and every
        connection without such terms, get the answer as it came."""
        if not isinstance(out, dict) or not _program_on_local(request, broker):
            return out
        from .broker_hub import FILL_RECORD_FIELDS, priced_names, row_record_only  # noqa: PLC0415
        if kind == "order":
            fill = out.get("fill")
            if fill is None or "fill" not in out:
                return out
            kept, dropped = row_record_only(fill, FILL_RECORD_FIELDS)
            named = priced_names(fill, dropped)
            if named:
                kept["withheld"] = _withheld_words(broker, ", ".join(named))
            return dict(out, fill=kept)
        named = priced_names(out, list(out))
        return {"withheld": _withheld_words(broker, ", ".join(named))} if named else {}

    @app.get("/api/broker/orders")
    def broker_orders(broker: str, request: Request):
        """Resting orders for the dock's Orders tab. Read-only, so no
        deny_hosted, same as account and positions. A program on a
        data_local_only connection gets each as the account's own record
        (_record_rows)."""
        from .broker_hub import ORDER_RECORD_FIELDS  # noqa: PLC0415
        return _record_rows(request, broker,
                            _broker_call(request, broker, hub.orders_list, broker),
                            ORDER_RECORD_FIELDS)

    @app.post("/api/broker/order/cancel")
    def broker_order_cancel(body: dict, request: Request):
        deny_hosted()
        own_origin_only(request)
        by_hand_only(request, str(body.get("broker", "")))
        cid = _client_id_of(body)
        broker = str(body.get("broker", ""))
        return _program_answer(request, broker, _mutating(
            request, broker, hub.cancel_order, broker,
            str(body.get("order_id", "")), client_id=cid,
            held_as=("/api/broker/order/cancel", body)), "cancel")

    @app.post("/api/broker/close")
    def broker_close(body: dict, request: Request):
        deny_hosted()
        own_origin_only(request)
        by_hand_only(request, str(body.get("broker", "")))
        cid = _client_id_of(body)
        broker = str(body.get("broker", ""))
        return _program_answer(request, broker, _mutating(
            request, broker, hub.close_position, broker,
            str(body.get("position_id", "")), body.get("qty"),
            client_id=cid, held_as=("/api/broker/close", body)), "close")

    @app.get("/api/broker/held")
    def broker_held(request: Request):
        """The requests this window sent, oldest first, for a page loaded
        after they were sent to hold them again (held_requests.py): each in
        its state, "out" (handed on, no answer yet), "unknown" (its fate not
        known: its answer was lost, or the engine stopped before it came) or
        "answered" (settled in the last 120 s, with `ok` and the HTTP
        `status`); with the broker profile, the route it went to, the body it
        sent (its client_id in it), the instrument it is about, when it first
        went out, and the answer's words and code. The window's alone: a
        program gets the refusal the window-only routes give."""
        own_window_only(request, json_body=False)
        if not _terminal_window(request.headers):
            raise HTTPException(403, _OWN_WINDOW)
        return {"held": held.held() if held is not None else []}

    @app.post("/api/broker/modify")
    def broker_modify(body: dict, request: Request):
        """SL/TP on an open position. The body carries the FULL desired
        bracket (null clears a side), mirroring /api/sim/modify so the chart
        drag handles have one contract on both trading paths."""
        deny_hosted()
        own_origin_only(request)
        broker = str(body.get("broker", ""))
        by_hand_only(request, broker)
        return _program_answer(request, broker, _broker_call(
            request, broker, hub.modify_position, broker,
            str(body.get("position_id", "")), body.get("sl"), body.get("tp")), "modify")

    @app.get("/api/broker/fills")
    def broker_fills(broker: str, request: Request, frm: int | None = None,
                     to: int | None = None):
        """The connected broker's fill ledger, for the dock's History tab.
        `frm`/`to` are UTC epoch ms (frm, not from: python keyword). Read
        only, so no deny_hosted, same as account and positions. A program on
        a data_local_only connection gets each fill as the account's own
        record (_record_rows)."""
        from .broker_hub import FILL_RECORD_FIELDS  # noqa: PLC0415
        return _record_rows(request, broker,
                            _broker_call(request, broker, hub.fills, broker, frm, to),
                            FILL_RECORD_FIELDS)

    @app.on_event("shutdown")
    async def _provider_shutdown():
        close = getattr(reg.get("lse"), "close", None)
        if close is not None:
            await close()

    @app.on_event("shutdown")
    def _broker_shutdown():
        hub.shutdown()

    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="ui")
    return app
