"""MCP stdio bridge for in-chat permission prompts.

Claude Code's headless mode (-p) cannot show its own approval UI, so chat
turns used to hard-deny anything outside the workspace allowlist. This
bridge is the missing UI: the engine spawns claude with
--permission-prompt-tool pointing at the `approve` tool below, claude calls
it whenever an action needs consent, and the tool forwards the request to
the engine over localhost HTTP, where it becomes an Allow / Deny card in
the rail. The user's click travels back the same path.

Runs as a subprocess OF THE CLAUDE CLI (declared via --mcp-config), speaking
MCP JSON-RPC over stdio. Pure stdlib on purpose: in the frozen desktop build
it is re-entered through the sidecar exe itself (lset --approve-bridge), so
it must start fast and depend on nothing.
"""

from __future__ import annotations

import json
import sys
import urllib.request

PROTOCOL_FALLBACK = "2024-11-05"


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# role "tools": the terminal's own capabilities, exposed natively so the
# agent backtests and reads data through clean tool calls instead of shell
# + curl. The logic lives ENGINE-side (/api/ai/tool-run fills defaults from
# the live workspace); these schemas are just the menu.
CAPABILITY_TOOLS = [
    {"name": "run_backtest",
     "description": "Backtest a PLAIN PYTHON strategy through the local LSE "
                    "Terminal engine and return the stats. Pass the code via "
                    "script= or a workspace file via file=. There is NOTHING "
                    "to import and no base class: `df` is already in scope, a "
                    "pandas DataFrame with ts/open/high/low/close/volume. Use "
                    "ordinary pandas (df.close.ewm(span=9).mean()), then "
                    "leave a list `trades` of dicts: {'entry_i': 10, "
                    "'exit_i': 25, 'dir': 'long'} where entry_i/exit_i are "
                    "bar indexes (entry_ts/exit_ts epoch seconds also work), "
                    "dir defaults to long, prices default to those bars' "
                    "opens, and qty defaults to the whole account. Read "
                    "tunable values from the injected `params` dict so "
                    "run_walkforward can sweep them. There is NO Strategy "
                    "class, no init/next(self, i), no self.buy/self.sma, no "
                    "self.I: that API no longer exists.",
     "inputSchema": {"type": "object", "properties": {
         "script": {"type": "string", "description": "Python strategy source"},
         "file": {"type": "string", "description": "workspace-relative .py path, e.g. strategies/sma_cross.py"},
         "engine": {"type": "string", "description": "python (the only engine)"},
         "symbol": {"type": "string", "description": "dataset / symbol to test on"},
         "timeframe": {"type": "string"},
         "from": {"type": "string", "description": "YYYY-MM-DD"},
         "to": {"type": "string", "description": "YYYY-MM-DD"}}}},
    {"name": "get_fills",
     "description": "The user's CLOSED trades and realised P&L: per fill the "
                    "symbol, side, qty, price, realised P&L and timestamp, "
                    "plus totals. USE THIS for \"what was my last trade\", "
                    "\"did that make money\", \"how am I doing overall\". "
                    "realized_pnl is null on an opening fill and a number on "
                    "a closing one, so a null is not a break-even trade.",
     "inputSchema": {"type": "object", "properties": {
         "limit": {"type": "integer",
                   "description": "how many fills, newest first (default 50)"}}}},
    {"name": "get_positions",
     "description": "The user's LIVE account and open positions as DATA: "
                    "balance, equity, leverage, and per position the symbol, "
                    "side, qty, average price, current price and unrealized "
                    "P&L. USE THIS for any question about what the user is "
                    "holding, how a trade is doing, or what their account is "
                    "worth. NEVER read those numbers off the screenshot: a "
                    "vision model misreads digits and flips P&L signs. If no "
                    "sim account is open this says so; report that rather "
                    "than calling it an empty book.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_candles",
     "description": "Recent OHLCV candles from the terminal for a symbol "
                    "(defaults to the chart the user has open). Use provider "
                    "lse for LSE market data and preserve its exact symbol, "
                    "for example BTC/USD, EUR/USD, SP500.F or VOD.UK. Local "
                    "MY DATA names identify different datasets; do not "
                    "substitute or remove punctuation. The newest candle "
                    "may still be forming. Use candles_utc and "
                    "latest_completed_candle for UTC times/completion; "
                    "do not convert epoch timestamps mentally.",
     "inputSchema": {"type": "object", "properties": {
         "provider": {"type": "string", "description":
                      "lse for LSE market data; otherwise the chart provider"},
         "symbol": {"type": "string", "description":
                    "Exact provider symbol, e.g. BTC/USD; defaults to the chart"},
         "timeframe": {"type": "string"},
         "limit": {"type": "integer", "maximum": 500}}}},
    {"name": "list_datasets",
     "description": "The user's imported MY DATA datasets (names, kinds, "
                    "rows, file paths).",
     "inputSchema": {"type": "object", "properties": {}}},
    # ── Research pack (quant validation + data acquisition) ─────────
    {"name": "run_montecarlo",
     "description": "Monte Carlo stress test of a strategy: backtests it, "
                    "then resamples the trade PnL sequence into N equity "
                    "paths and reports percentile distributions (finalEquity, "
                    "maxDrawdownPct), probability of loss, and risk of ruin. "
                    "Same script/file/symbol semantics as run_backtest. Needs "
                    "a strategy that actually trades (>= 2 trades).",
     "inputSchema": {"type": "object", "properties": {
         "script": {"type": "string", "description": "Python strategy source"},
         "file": {"type": "string", "description": "workspace-relative .py path"},
         "engine": {"type": "string", "description": "python (the only engine)"},
         "symbol": {"type": "string"}, "timeframe": {"type": "string"},
         "runs": {"type": "integer", "description": "paths, default 1000"},
         "seed": {"type": "integer"},
         "bars": {"type": "integer", "maximum": 50000},
         "from": {"type": "string", "description": "YYYY-MM-DD"},
         "to": {"type": "string", "description": "YYYY-MM-DD"}}}},
    {"name": "run_walkforward",
     "description": "Walk-forward analysis: optimizes the given param grid "
                    "on each rolling train window, replays the best combo "
                    "out-of-sample, and reports per-fold bestParams, OOS net "
                    "profit and efficiency (OOS rate / train rate; > 0.5 is "
                    "usually considered robust). params values are grids: "
                    "\"10:50:10\" (lo:hi:step) or \"12,26,50\". Param names "
                    "are the keys the script reads with params.get(name, "
                    "default). Keep grids small (each combo is a full "
                    "backtest per fold; capped at 500 combos, and at 24 "
                    "combos when bars > 5000). bars defaults to 2000; pass "
                    "the same bars as the backtest you are validating "
                    "(up to 50000) so the folds cover the same history.",
     "inputSchema": {"type": "object", "required": ["params"], "properties": {
         "script": {"type": "string"}, "file": {"type": "string"},
         "engine": {"type": "string", "description": "python (the only engine)"},
         "symbol": {"type": "string"}, "timeframe": {"type": "string"},
         "params": {"type": "object",
                    "description": "{\"length\": \"10:50:10\", \"mult\": \"1,2,3\"}"},
         "folds": {"type": "integer", "description": "default 4"},
         "train": {"type": "number", "description": "train fraction, default 0.7"},
         "metric": {"type": "string",
                    "description": "netProfit (default), profitFactor, winRate, avgTrade"},
         "bars": {"type": "integer", "maximum": 50000},
         "from": {"type": "string"}, "to": {"type": "string"}}}},
    {"name": "get_economics",
     "description": "The LSE macro-economic calendar: releases with actual/"
                    "forecast/previous values and next release dates. Filter "
                    "by region (country name, comma list), event substring, "
                    "and date window; released_only=true limits to rows that "
                    "already printed (event studies). Needs the user's LSE "
                    "key linked.",
     "inputSchema": {"type": "object", "properties": {
         "region": {"type": "string", "description": "e.g. United States"},
         "event": {"type": "string", "description": "e.g. CPI"},
         "from": {"type": "string", "description": "YYYY-MM-DD"},
         "to": {"type": "string", "description": "YYYY-MM-DD"},
         "released_only": {"type": "boolean"},
         "order": {"type": "string", "description": "asc (default) or desc"},
         "limit": {"type": "integer", "maximum": 1000}}}},
    {"name": "import_lse_data",
     "description": "Import available LSE market candles, economic series or bond "
                    "yields into the local library using your key. Reads complete "
                    "pages within key limits and preserves the source values. "
                    "Tick history, options and reference exports are unavailable. "
                    "Waits up to ~90s; longer imports return status + job_id. "
                    "Call again with job_id to check completion. Uses the key's data quota.",
     "inputSchema": {"type": "object", "properties": {
         "dataset": {"type": "string",
                     "description": "class: fx, stocks, crypto, etf, index, commodity, ..."},
         "symbol": {"type": "string", "description": "e.g. XAU/USD"},
         "timeframe": {"type": "string", "description": "1s, 30s, 1m, 5m, 15m, 30m, 1h (default), 4h, 1d, 1w; ignored for series"},
         "from": {"type": "string", "description": "YYYY-MM-DD"},
         "to": {"type": "string", "description": "YYYY-MM-DD"},
         "folder": {"type": "string", "description": "library folder, default LSE"},
         "job_id": {"type": "string", "description": "check a still-running import"}}}},
    # ── Machine learning (BACKTEST > MACHINE LEARNING, code-first) ──
    {"name": "list_ml_models",
     "description": "The terminal's 20 trainable ML models with their full "
                    "parameter schemas and the selectable feature ids. Read "
                    "this before writing or editing a training blueprint.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "generate_ml_blueprint",
     "description": "A runnable Python training blueprint for a model "
                    "(blueprint.train call with every parameter at its "
                    "default). Edit it, then run with run_ml_blueprint.",
     "inputSchema": {"type": "object", "required": ["model"], "properties": {
         "model": {"type": "string", "description": "model key from list_ml_models"},
         "dataset": {"type": "string", "description": "MY DATA import or built ML dataset name"},
         "timeframe": {"type": "string"}, "bars": {"type": "integer"}}}},
    {"name": "build_ml_dataset",
     "description": "Compose a named training dataset from an imported MY "
                    "DATA file: resample, slice a date window, optionally "
                    "bake indicator feature columns in.",
     "inputSchema": {"type": "object", "required": ["name", "source"], "properties": {
         "name": {"type": "string"},
         "source": {"type": "string", "description": "MY DATA dataset to build from"},
         "timeframe": {"type": "string"}, "bars": {"type": "integer"},
         "start": {"type": "string", "description": "YYYY-MM-DD"},
         "to": {"type": "string", "description": "YYYY-MM-DD (alias: end)"},
         "features": {"type": "array", "items": {"type": "string"},
                      "description": "feature ids to bake in as columns"}}}},
    {"name": "run_ml_blueprint",
     "description": "Start a training blueprint (Python code calling "
                    "lse_terminal.ml.blueprint) on this machine. Returns a "
                    "job_id immediately; poll get_ml_job for the log and "
                    "results. Training can take minutes.",
     "inputSchema": {"type": "object", "required": ["code"], "properties": {
         "code": {"type": "string"}}}},
    {"name": "get_ml_job",
     "description": "Status, recent log lines, and (when finished) results "
                    "of an ML training job.",
     "inputSchema": {"type": "object", "required": ["job_id"], "properties": {
         "job_id": {"type": "string"}}}},
    # ── Operating the app itself ──
    {"name": "open_in_app",
     "description": "Open something on the user's LSE Terminal screen: an "
                    "imported dataset's preview (view=dataset), a workspace "
                    "strategy file in the editor (view=file), or a page "
                    "(view=section: markets, backtest:py, backtest:ml, "
                    "backtest:manual, economic, workspace, research, "
                    "guide, mydata). Call "
                    "this whenever the user asks to open, show, or go to "
                    "something that exists in the app.",
     "inputSchema": {"type": "object", "required": ["view", "name"],
                     "properties": {
         "view": {"type": "string",
                  "enum": ["dataset", "file", "section"]},
         "name": {"type": "string", "description":
                  "dataset name / workspace path / section key"}}}},
    {"name": "list_research",
     "description": "The RESEARCH tab's live papers feed: the newest "
                    "quant-finance papers (arXiv q-fin + NBER/BIS/Fed/ECB "
                    "working papers), each row with source, date, category, "
                    "title, authors and the link read_research_paper takes.",
     "inputSchema": {"type": "object", "properties": {
         "source": {"type": "string",
                    "description": "optional: ARXIV, NBER, BIS, FED or ECB"},
         "category": {"type": "string", "description":
                      "optional, e.g. Machine Learning, Options & Volatility"}}}},
    {"name": "read_research_paper",
     "description": "The FULL TEXT of a paper from the research feed, "
                    "extracted from the publisher's PDF (fetched by this "
                    "machine and cached). Read it before building a strategy "
                    "or diagram from a paper, so the method comes from the "
                    "paper itself rather than the abstract.",
     "inputSchema": {"type": "object", "required": ["link"], "properties": {
         "link": {"type": "string", "description":
                  "the paper's link, from list_research or the user's message"},
         "pages": {"type": "string", "description":
                   "optional page range like '1-8' (default: whole paper, "
                   "capped)"}}}},
    # ── The user guide ──
    # The TERMINAL WALKTHROUGH tab's document, so any agent answers "how
    # does the terminal work / what can it do" from the authors' text.
    {"name": "read_guide",
     "description": "The terminal's built-in user guide (the TERMINAL WALKTHROUGH tab): "
                    "every tab, feature and workflow, written by the "
                    "terminal's authors. Read it before answering what the "
                    "terminal is, what it can do, or how to do something in "
                    "it. Returns one section by number or title, or the "
                    "whole guide when section is empty.",
     "inputSchema": {"type": "object", "properties": {
         "section": {"type": "string", "description":
                     "section number or title (case-insensitive, substring "
                     "ok); empty for the whole guide"}}}},
    # ── The web ──
    # Fetched by THIS machine, on the user's own connection, exactly like the
    # paper reader. Nothing is proxied through LSE.
    {"name": "web_search",
     "description": "Search the live web. USE THIS whenever the answer depends "
                    "on anything current: a rate, an economic release, company "
                    "or market news, a policy, a definition you are unsure of. "
                    "Your training data has a cutoff and the user is asking "
                    "today. Returns titles, URLs and snippets; call fetch_url "
                    "on a result to read the whole page. Prices and positions "
                    "the user already has on screen come from the terminal's "
                    "own tools, not from here.",
     "inputSchema": {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string", "description": "the search query"},
         "category": {"type": "string", "enum": ["web", "news"]},
         "recency": {"type": "string", "enum": ["day", "week", "month", "year"],
                     "description": "optional: only results this recent"}}}},
    {"name": "fetch_url",
     "description": "Read a web page or PDF and get its text. Use it on a URL "
                    "from web_search when the snippet is not enough, or on a "
                    "URL the user gives you. Never guess a URL; search first. "
                    "If it comes back with almost no text, the page is "
                    "JavaScript-rendered: use browse instead.",
     "inputSchema": {"type": "object", "required": ["url"], "properties": {
         "url": {"type": "string", "description": "the full http(s) URL"},
         "max_chars": {"type": "integer",
                       "description": "cap on returned text, default 8000"}}}},
    {"name": "browse",
     "description": "Load a page in a real browser so JavaScript runs, then "
                    "return its text and its links. Slower than fetch_url, so "
                    "use it when fetch_url came back empty or blocked, or when "
                    "the content only appears after the page renders. Uses the "
                    "user's installed Chrome or Edge when present.",
     "inputSchema": {"type": "object", "required": ["url"], "properties": {
         "url": {"type": "string"},
         "max_chars": {"type": "integer"}}}},
    # ── Running the user's own analysis ──
    {"name": "run_python",
     "description": "Run Python in the user's strategy workspace and get its "
                    "output back. For analysis the terminal does not do "
                    "itself: correlations, distributions, joins, data-quality "
                    "checks, quick numbers off their MY DATA CSVs. pandas and "
                    "numpy are available. This is NOT how you backtest: use "
                    "run_backtest, whose numbers match the terminal's own UI. "
                    "Print what you want to see; only stdout comes back.",
     "inputSchema": {"type": "object", "properties": {
         "code": {"type": "string", "description": "Python source to run"},
         "file": {"type": "string",
                  "description": "or a workspace-relative .py file to run instead"},
         "timeout": {"type": "integer",
                     "description": "seconds, default 120, max 600"}}}},
    # ── Memory across chats ──
    {"name": "remember",
     "description": "Save one durable fact about this user or their work, so "
                    "you still know it in a NEW chat: how they trade, what "
                    "they are building, preferences they have stated, "
                    "decisions already made. One fact per call, written so it "
                    "makes sense months later. Do not save secrets, and do not "
                    "save what is already in the workspace or on screen.",
     "inputSchema": {"type": "object", "required": ["note"], "properties": {
         "note": {"type": "string", "description": "the fact, one sentence"}}}},
    {"name": "recall",
     "description": "Everything you have previously remembered about this "
                    "user, with the id of each note. Your saved notes are also "
                    "handed to you at the start of every chat, so call this "
                    "only when you need to check or clean up the list.",
     "inputSchema": {"type": "object", "properties": {
         "forget_id": {"type": "integer",
                       "description": "optional: delete this note instead of listing"}}}},
    {"name": "list_workspace",
     "description": "The user's strategy workspace files (the same tree the "
                    "BACKTEST editor shows), as relative paths.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "read_workspace_file",
     "description": "Read a strategy workspace file by its relative path.",
     "inputSchema": {"type": "object", "required": ["path"], "properties": {
         "path": {"type": "string"}}}},
    {"name": "write_workspace_file",
     "description": "Create or overwrite a strategy workspace file (.py, "
                    ".md, .txt, .json, .csv, .svg). Diagrams are "
                    "self-contained .svg files (no external refs). Strategy "
                    ".py files are plain "
                    "Python following the contract described on "
                    "run_backtest: `df` in scope, `trades` list out, nothing "
                    "imported from us. Unless the user granted edit "
                    "autonomy, this shows them an Allow / Deny card first; "
                    "a deny is their answer, do not retry it.",
     "inputSchema": {"type": "object", "required": ["path", "content"],
                     "properties": {
         "path": {"type": "string",
                  "description": "workspace-relative, e.g. strategies/x.py"},
         "content": {"type": "string"}}}},
]


def main(port: int, token: str, role: str = "approve") -> int:
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        mid = msg.get("id")
        method = msg.get("method")
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": (msg.get("params") or {}).get(
                    "protocolVersion", PROTOCOL_FALLBACK),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": f"lse-{role}", "version": "1.0"}}})
        elif method == "tools/list":
            tools = CAPABILITY_TOOLS if role == "tools" else [{
                "name": "approve",
                "description": "Ask the LSE Terminal user to approve or "
                               "deny a tool call",
                "inputSchema": {"type": "object", "properties": {
                    "tool_name": {"type": "string"},
                    "input": {"type": "object"},
                    "tool_use_id": {"type": "string"},
                }}}]
            _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": tools}})
        elif method == "tools/call" and role == "tools":
            params = msg.get("params") or {}
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/ai/tool-run",
                    json.dumps({"token": token,
                                "name": str(params.get("name", "")),
                                "args": params.get("arguments") or {}}).encode(),
                    {"Content-Type": "application/json"})
                out = urllib.request.urlopen(req, timeout=180).read().decode()
                reply = {"content": [{"type": "text", "text": out[:20000]}]}
            except Exception as e:
                reply = {"content": [{"type": "text",
                                      "text": f"tool failed: {e}"}],
                         "isError": True}
            _send({"jsonrpc": "2.0", "id": mid, "result": reply})
        elif method == "tools/call":
            args = ((msg.get("params") or {}).get("arguments") or {})
            # Fail CLOSED: any bridge/engine hiccup is a deny, never a
            # silent allow.
            decision = {"behavior": "deny",
                        "message": "the approval prompt was not answered"}
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/api/ai/approve-request",
                    json.dumps({
                        "token": token,
                        "tool_name": str(args.get("tool_name", "")),
                        "input": args.get("input") or {},
                    }).encode(),
                    {"Content-Type": "application/json"})
                # Engine holds the request while the card waits on screen;
                # its own timeout (280s) fires before this one.
                decision = json.loads(
                    urllib.request.urlopen(req, timeout=300).read().decode())
            except Exception as e:
                decision = {"behavior": "deny",
                            "message": f"approval bridge error: {e}"}
            _send({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": json.dumps(decision)}]}})
        elif mid is not None:
            # Unknown request: answer emptily rather than stalling the CLI.
            _send({"jsonrpc": "2.0", "id": mid, "result": {}})
        # Notifications (no id) need no reply.
    return 0
