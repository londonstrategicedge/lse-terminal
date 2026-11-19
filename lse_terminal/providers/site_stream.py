"""One authenticated LSE price socket shared by the terminal's charts.

The subscribe ACK resolves an alias; consumers receive their exact requested
name and the original timestamp. Chart changes update subscriptions on the
existing connection instead of spending the address's connection allowance.
"""
from __future__ import annotations

import asyncio
import json
import math
from datetime import datetime, timezone

import websockets

SITE_WS_URL = "wss://ws.londonstrategicedge.com/"
CONTROL_TIMEOUT = 10.0
RECONNECT_DELAY = 3.0
MAX_CONNECT_FAILURES = 3
IDLE_CLOSE_SECONDS = 30.0
_DONE = object()


def _timestamp(value):
    if isinstance(value, bool) or value is None:
        raise ValueError("price stream omitted its timestamp")
    try:
        ts = float(value)
    except (TypeError, ValueError):
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("price stream timestamp has no timezone")
        ts = dt.astimezone(timezone.utc).timestamp()
    if not math.isfinite(ts) or ts <= 0:
        raise ValueError("invalid price stream timestamp")
    return ts


def _tick(message, requested):
    price = message.get("price")
    if isinstance(price, bool) or not isinstance(price, (float, int)) or not math.isfinite(price):
        raise ValueError("invalid price stream value")
    return {"symbol": requested, "price": price, "bid": message.get("bid"),
            "ask": message.get("ask"), "volume": message.get("volume"),
            "ts": _timestamp(message.get("ts"))}


class _Hub:
    def __init__(self, key):
        from lse_terminal.providers.spread import QuoteSynthesizer
        self.key = key
        self.loop = asyncio.get_running_loop()
        self.leases = {}
        self.changed = asyncio.Event()
        self.idle_since = None
        self.closed = False
        self.routes = {}
        self.subscribed = set()
        self.frames = {}
        self.latest = {}
        self.rendered = {}
        self.synth = QuoteSynthesizer()
        self.task = asyncio.create_task(self.run(), name="lse-site-stream")

    def acquire(self, symbols):
        token = object()
        queue = asyncio.Queue(maxsize=1000)
        self.leases[token] = (symbols, queue)
        self.idle_since = None
        # A second chart of an already active instrument gets its last quote.
        for spelling in symbols:
            canonical = self.routes.get(spelling)
            if canonical in self.subscribed and canonical in self.frames:
                self.put(queue, self.render(canonical, spelling, self.frames[canonical]))
        self.changed.set()
        return token, queue

    def release(self, token):
        self.leases.pop(token, None)
        if not self.leases:
            self.idle_since = self.loop.time()
        self.changed.set()

    @staticmethod
    def put(queue, value):
        # Keep the latest data, and always leave room for errors and completion.
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(value)

    def wanted(self):
        return list(dict.fromkeys(s for symbols, _ in self.leases.values() for s in symbols))

    def render(self, canonical, spelling, message):
        cached = self.rendered.get(canonical)
        if cached is None or cached[0] is not message:
            # Infer a quote once per market print, then copy it to chart aliases.
            # Multiple charts must not feed the spread estimator duplicate prints.
            cached = (message, self.synth.fill(_tick(message, canonical)))
            self.rendered[canonical] = cached
        return {**cached[1], "symbol": spelling}

    def emit(self, canonical, message, only=None):
        for symbols, queue in self.leases.values():
            for spelling in symbols:
                if self.routes.get(spelling) == canonical and (only is None or spelling == only):
                    self.put(queue, self.render(canonical, spelling, message))

    def error(self, detail, spelling=None):
        detail = str(detail).replace(self.key, "[redacted]")[:200]
        for token, (symbols, queue) in list(self.leases.items()):
            if spelling is None or spelling in symbols:
                self.put(queue, {"error": detail})
                self.put(queue, _DONE)
                self.release(token)

    async def shutdown(self):
        self.closed = True
        for _, queue in self.leases.values():
            while not queue.empty():
                queue.get_nowait()
            self.put(queue, _DONE)
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)

    async def keepalive(self, ws):
        while True:
            await asyncio.sleep(25)
            await ws.send(json.dumps({"action": "ping"}))

    async def session(self):
        ping = received = None
        try:
            async with websockets.connect(SITE_WS_URL, open_timeout=CONTROL_TIMEOUT,
                                          close_timeout=5, ping_interval=20,
                                          ping_timeout=30, max_size=2**20) as ws:
                welcome = json.loads(await asyncio.wait_for(ws.recv(), CONTROL_TIMEOUT))
                if welcome.get("type") != "welcome":
                    raise ValueError("price stream did not send its welcome")
                await ws.send(json.dumps({"action": "auth", "api_key": self.key}))
                auth = json.loads(await asyncio.wait_for(ws.recv(), CONTROL_TIMEOUT))
                if auth.get("type") != "auth" or auth.get("status") != "ok":
                    self.error(auth.get("message") or "Price stream authentication refused")
                    self.closed = True
                    return
                self.routes = {}
                self.subscribed = set()
                self.frames = {}
                pending = None
                ping = asyncio.create_task(self.keepalive(ws))
                received = asyncio.create_task(ws.recv())
                while not self.closed:
                    wanted = self.wanted()
                    # Free old subscriptions before spending capacity on new ones.
                    if pending is None:
                        remove = next((c for c in self.subscribed if not any(self.routes.get(s) == c for s in wanted)), None)
                        add = next((s for s in wanted if self.routes.get(s) not in self.subscribed), None)
                        if remove is not None:
                            pending = ("unsubscribe", remove, self.loop.time() + CONTROL_TIMEOUT)
                        elif add is not None:
                            pending = ("subscribe", add, self.loop.time() + CONTROL_TIMEOUT)
                        if pending:
                            await ws.send(json.dumps({"action": pending[0], "symbol": pending[1]}))
                    if not self.leases and self.idle_since is not None and self.loop.time() - self.idle_since >= IDLE_CLOSE_SECONDS:
                        self.closed = True
                        return
                    wait_s = max(0, pending[2] - self.loop.time()) if pending else None
                    if not self.leases and self.idle_since is not None:
                        idle_wait = max(0, IDLE_CLOSE_SECONDS - (self.loop.time() - self.idle_since))
                        wait_s = idle_wait if wait_s is None else min(wait_s, idle_wait)
                    self.changed.clear()
                    change = asyncio.create_task(self.changed.wait())
                    try:
                        ready, _ = await asyncio.wait((received, change), timeout=wait_s, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        change.cancel()
                        await asyncio.gather(change, return_exceptions=True)
                    if not ready:
                        if pending and self.loop.time() >= pending[2]:
                            raise TimeoutError("price stream subscription acknowledgement timed out")
                        continue
                    if received not in ready:
                        continue
                    message = json.loads(received.result())
                    received = asyncio.create_task(ws.recv())
                    kind = message.get("type")
                    if kind == "error":
                        detail = message.get("message") or message.get("code") or "Price stream refused"
                        if pending and pending[0] == "subscribe":
                            self.error(detail, pending[1])
                            pending = None
                            continue
                        raise ValueError(detail)
                    if kind == "auth" and message.get("status") != "ok":
                        self.error(message.get("message") or "Price stream authentication refused")
                        self.closed = True
                        return
                    if kind in ("subscribed", "unsubscribed"):
                        action = "subscribe" if kind == "subscribed" else "unsubscribe"
                        canonical = message.get("symbol")
                        if not pending or pending[0] != action or not isinstance(canonical, str) or not canonical:
                            raise ValueError("unmatched price stream subscription acknowledgement")
                        if action == "subscribe":
                            spelling = pending[1]
                            already = canonical in self.subscribed
                            self.routes[spelling] = canonical
                            self.subscribed.add(canonical)
                            if already and canonical in self.frames:
                                self.emit(canonical, self.frames[canonical], only=spelling)
                        else:
                            if canonical != pending[1]:
                                raise ValueError("price stream unsubscribe named another instrument")
                            self.subscribed.discard(canonical)
                            self.frames.pop(canonical, None)
                        pending = None
                        continue
                    if kind != "tick":
                        continue
                    canonical = message.get("symbol")
                    if canonical not in self.subscribed:
                        continue
                    stamp = _timestamp(message.get("ts"))
                    if stamp < self.latest.get(canonical, 0):
                        continue
                    self.latest[canonical] = stamp
                    self.frames[canonical] = message
                    self.failures = 0
                    self.emit(canonical, message)
        finally:
            for task in (ping, received):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(t for t in (ping, received) if t is not None), return_exceptions=True)
            self.subscribed.clear()

    async def run(self):
        self.failures = 0
        try:
            while not self.closed:
                try:
                    await self.session()
                except (OSError, TimeoutError, websockets.ConnectionClosed) as exc:
                    self.failures += 1
                    if self.failures >= MAX_CONNECT_FAILURES:
                        self.error("Price stream connection failed: " + str(exc))
                        return
                except Exception as exc:
                    self.error("Invalid price stream response: " + str(exc))
                    return
                if not self.closed:
                    if not self.leases:
                        return
                    await asyncio.sleep(RECONNECT_DELAY)
        finally:
            self.closed = True
            for _, queue in self.leases.values():
                self.put(queue, _DONE)


async def stream(self, symbols):
    """A chart's subscription lease; releasing it leaves a short reusable idle socket."""
    requested = list(dict.fromkeys(s for s in symbols if isinstance(s, str) and s.strip()))
    if not requested:
        return
    if not self._key:
        yield {"error": "LSE provider needs an API key."}
        return
    hub = getattr(self, "_site_stream_hub", None)
    if hub is not None and (hub.closed or hub.loop is not asyncio.get_running_loop()):
        if hub.loop is asyncio.get_running_loop():
            await hub.shutdown()
        hub = None
    if hub is None:
        hub = self._site_stream_hub = _Hub(self._key)
    token, queue = hub.acquire(requested)
    try:
        while True:
            item = await queue.get()
            if item is _DONE:
                return
            yield item
            if "error" in item:
                return
    finally:
        hub.release(token)


async def close(self):
    """Release the provider's upstream during engine shutdown."""
    hub = getattr(self, "_site_stream_hub", None)
    if hub is not None and hub.loop is asyncio.get_running_loop():
        await hub.shutdown()


def close_sync(self):
    """Config handlers run in a worker thread: stop old credentials before replacing them."""
    hub = getattr(self, "_site_stream_hub", None)
    if hub is None or hub.task.done():
        return
    try:
        current = asyncio.get_running_loop()
    except RuntimeError:
        current = None
    if current is hub.loop:
        raise RuntimeError("close_sync requires a worker thread; await close() on the event loop")
    if not hub.loop.is_running():
        raise RuntimeError("cannot close the price connection: its event loop is not running")
    future = asyncio.run_coroutine_threadsafe(hub.shutdown(), hub.loop)
    future.result(timeout=CONTROL_TIMEOUT + 5)
