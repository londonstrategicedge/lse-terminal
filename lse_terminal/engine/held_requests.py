"""The window's requests from the moment they are handed on, kept across
engine runs.

An order, a resting order, a cancel or a close can be taken by the broker and
its answer lost (SPEC 2), or the engine can stop while the broker has it: the
request may then have been carried out. The terminal's page holds such a
request: it says so and asks again under the client_id it went under, which
the broker answers from its own record, never carrying it out twice. A page
reloads (a renderer that died, an update of the interface) and an engine can
be stopped and started again by the desktop shell, so the page's memory is
not enough: this record is what lets the page loaded next hold the same
request again instead of sending the same intent under a new client_id
(GET /api/broker/held, server.py).

What it holds, keyed by (broker, client_id), oldest first by `since`: one
entry per request the window sent on one of ROUTES. Each carries the account
the profile was bound to when it was handed on (SPEC 1.7; null when it has
none), so an Ask again on another account than the entry's can be refused
before it reaches the broker. In one of three states.
  - "out": written, and on disk, BEFORE the request is handed to the broker
    hub (`send`), so a run that ends before the answer leaves it behind. The
    run read next makes each one left "unknown", code `engine_stopped`.
  - "unknown": its answer said its outcome is not known (the again-fields'
    `unknown`), or the engine's own code failed after it was handed on.
    `since` is kept from when it first went out.
  - "answered": the answer settled it (a 2xx, or a 400 with nothing to ask
    again), or answered it otherwise when nothing was held before it. Gone
    from the file; kept in memory only, for ANSWERED_S, with what the answer
    said, for a page loaded while it was out.
Any other answer to an Ask again (the broker not connected, a retry that can
mend it) puts back the entry that was there before. Unlinking or forgetting a
broker lets its entries go, every state; a disconnect keeps them. A program's
requests are never recorded (server._mutating).

Kept in held_requests.json in the terminal's config folder, written whole on
each change (a temporary file, synced, then renamed over the last one; mode
0600) and read when the engine starts. A file that cannot be read is set aside
beside it (held_requests.json.bad-<UTC stamp>) and said in one line on the
engine's log; the engine starts with the entries it could read. A file an
earlier version wrote (the oldest has no state, no instrument; none before
version 3 has an account) is read for what it has, the rest filled in. No
credential is kept in it: the words are kept as the route answered
them, with the profile's keys already taken out.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from pathlib import Path

# The routes a request is held from, and what each sends.
ROUTES = {"/api/broker/order": "order",
          "/api/broker/order/pending": "resting",
          "/api/broker/order/cancel": "cancel",
          "/api/broker/close": "close"}

FILE_NAME = "held_requests.json"
VERSION = 3
# How long an answered request stays listed after its answer.
ANSWERED_S = 120.0
# At most this many answered requests are listed at once (the oldest go).
_ANSWERED_KEPT = 512
# A file this large is not one this engine wrote.
_MAX_BYTES = 8 * 1024 * 1024
_CLIENT_ID = re.compile(r"[A-Za-z0-9][!-~]{0,127}")
_SINCE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")
# An entry as the versions before this one wrote it, and as this one does.
# Version 2 added state and instrument; version 3 adds account, the id of the
# account the profile was bound to when the request was handed on (null when
# it has none), so an Ask again can be refused on another account than the
# one the request went out on.
_FIELDS_V1 = ("broker", "client_id", "route", "what", "request", "since", "detail",
              "code")
_FIELDS_V2 = _FIELDS_V1 + ("state", "instrument")
_FIELDS = _FIELDS_V2 + ("account",)
_ON_DISK = ("out", "unknown")
# Where the user sees whether each kind of request was carried out.
_SEE = {"order": "Positions", "resting": "Orders", "cancel": "Orders",
        "close": "Positions"}


def _now() -> str:
    """Now, as ISO-8601 UTC to the second."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _tick() -> float:
    """The clock an answered entry's ANSWERED_S is counted on."""
    return time.monotonic()


def _stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def _say(line: str) -> None:
    """One line on the engine's log (its stderr)."""
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 - a closed log is no reason to fail
        pass


def stopped_words(what: str) -> str:
    """The words an entry left out by a run that stopped are held with."""
    return ("The Terminal stopped before the broker's answer came, so it may have "
            f"been carried out: check {_SEE.get(what, 'Positions')} before sending "
            "it again.")


def _common_ok(e: dict) -> bool:
    return (isinstance(e["broker"], str) and bool(e["broker"])
            and isinstance(e["client_id"], str) and bool(_CLIENT_ID.fullmatch(e["client_id"]))
            and e["route"] in ROUTES and e["what"] == ROUTES[e["route"]]
            and isinstance(e["request"], dict)
            and isinstance(e["since"], str) and bool(_SINCE.fullmatch(e["since"]))
            and (e["code"] is None or isinstance(e["code"], str)))


def _read_entry(e):
    """An entry of the file as this engine holds it, or None when it is not
    one. One a version before this one wrote is read for what it has: the
    oldest (no state) is unknown, its instrument its request's symbol; one
    from before version 3 has no account (null)."""
    if not isinstance(e, dict):
        return None
    keys = set(e)
    if keys == set(_FIELDS_V1):
        if not (_common_ok(e) and isinstance(e["detail"], str)):
            return None
        sym = e["request"].get("symbol")
        return {**e, "state": "unknown",
                "instrument": sym if isinstance(sym, str) and sym else None,
                "account": None}
    if keys == set(_FIELDS_V2):
        if not (_common_ok(e) and e["state"] in _ON_DISK
                and (e["detail"] is None or isinstance(e["detail"], str))
                and (e["instrument"] is None or isinstance(e["instrument"], str))):
            return None
        return {**e, "account": None}
    if keys == set(_FIELDS):
        if not (_common_ok(e) and e["state"] in _ON_DISK
                and (e["detail"] is None or isinstance(e["detail"], str))
                and (e["instrument"] is None or isinstance(e["instrument"], str))
                and (e["account"] is None or isinstance(e["account"], str))):
            return None
        return dict(e)
    return None


def _copy(e: dict) -> dict:
    return json.loads(json.dumps(e))


class HeldRequests:
    """The record, in memory and on disk. Every method is safe to call from
    several request threads at once, and none of them raises: a record that
    cannot be written is said on the engine's log and kept in memory.

    `send` returns a ticket for the request it wrote out; the answer is then
    given with `unknown`, `settled` or `other` and that ticket. A ticket is
    stale once another request under the same key has gone out since, or the
    broker's entries were let go: its answer then changes nothing."""

    def __init__(self, path: Path, say=_say):
        self.path = Path(path)
        self._say = say
        self._lock = threading.Lock()
        self._held: dict[tuple, dict] = {}       # out and unknown: the file
        self._answered: dict[tuple, tuple] = {}  # key -> (entry, listed until)
        self._token: dict[tuple, int] = {}       # key -> the request out under it
        self._seq: dict[tuple, int] = {}         # key -> its place, oldest first
        self._next = 0
        self._load()

    # == reading ==========================================================
    def held(self) -> list[dict]:
        """Every entry of every state, oldest first by `since` (copies)."""
        with self._lock:
            self._expire()
            rows = [(self._seq.get(k, 0), e) for k, e in self._held.items()]
            rows += [(self._seq.get(k, 0), e) for k, (e, _) in self._answered.items()]
            rows.sort(key=lambda r: (r[1]["since"], r[0]))
            return [_copy(e) for _, e in rows]

    # == a request handed on, and its answer ===============================
    def send(self, broker: str, client_id: str, route: str, request: dict,
             instrument=None, account=None):
        """The window's request on `route`, its own checks passed, about to
        be handed to the hub: written out, on disk, before this returns.
        `account` is the account the profile is bound to at this moment (SPEC
        1.7), kept so an Ask again can be told from one on another account.
        The ticket for its answer, or None when it is not one this record
        keeps."""
        if route not in ROUTES or not isinstance(client_id, str) \
                or not _CLIENT_ID.fullmatch(client_id) or not broker:
            return None
        sent = dict(request) if isinstance(request, dict) else {}
        sent["client_id"] = client_id
        with self._lock:
            key = (broker, client_id)
            cur = self._held.get(key)
            # what was there before this request, put back on an answer that
            # settles nothing (another request still out under the key too)
            before = (dict(cur), self._token.get(key)) if cur is not None else None
            gone = self._answered.pop(key, None)
            self._next += 1
            token = self._next
            since = (cur["since"] if cur is not None
                     else gone[0]["since"] if gone is not None else _now())
            self._held[key] = {
                "broker": broker, "client_id": client_id, "route": route,
                "what": ROUTES[route], "request": sent, "since": since,
                "detail": None, "code": None, "state": "out",
                "instrument": instrument if isinstance(instrument, str) and instrument else None,
                "account": account if isinstance(account, str) and account else None}
            self._token[key] = token
            self._place(key)
            self._save()
        return (key, token, before)

    def entry(self, broker: str, client_id: str):
        """The out or unknown entry held under this key (a copy), or None.
        A route reads it to tell an Ask again (a window request under a held
        entry's client_id) from a fresh one, and to see the account it went
        out on."""
        with self._lock:
            e = self._held.get((broker, client_id))
            return _copy(e) if e is not None else None

    def oldest_live(self, broker: str):
        """The oldest out or unknown entry of this broker (a copy), or None:
        the one an account switch names while the broker has anything held."""
        with self._lock:
            rows = [(self._seq.get(k, 0), e) for k, e in self._held.items()
                    if k[0] == broker]
            if not rows:
                return None
            rows.sort(key=lambda r: (r[1]["since"], r[0]))
            return _copy(rows[0][1])

    def unknown(self, ticket, detail, code=None) -> None:
        """Its answer says its outcome is not known, or the engine failed
        after handing it on: held unknown, `since` kept, on disk."""
        with self._lock:
            cur = self._current(ticket)
            if cur is None:
                return
            key = ticket[0]
            self._held[key] = {**cur, "state": "unknown",
                               "detail": detail if isinstance(detail, str) else str(detail or ""),
                               "code": code if isinstance(code, str) else None}
            self._token.pop(key, None)
            self._save()

    def settled(self, ticket, *, ok: bool, status: int, detail=None, code=None) -> None:
        """An answer that settles it: gone from the file, listed answered."""
        with self._lock:
            cur = self._current(ticket)
            if cur is None:
                return
            self._answer(ticket[0], cur, ok, status, detail, code)
            self._save()

    def other(self, ticket, *, ok: bool, status: int, detail=None, code=None) -> None:
        """Any other answer: what was there before this request comes back
        (an Ask again of an unknown entry); when nothing was, it is answered."""
        with self._lock:
            cur = self._current(ticket)
            if cur is None:
                return
            key, _, before = ticket
            if before is not None:
                self._held[key] = before[0]
                if before[1] is None:
                    self._token.pop(key, None)
                else:
                    self._token[key] = before[1]
            else:
                self._answer(key, cur, ok, status, detail, code)
            self._save()

    def forget_broker(self, broker: str) -> None:
        """That broker was unlinked, or forgotten: its entries go, every
        state."""
        with self._lock:
            keys = [k for k in self._held if k[0] == broker]
            for k in keys:
                del self._held[k]
            for k in [k for k in self._answered if k[0] == broker]:
                del self._answered[k]
            for k in [k for k in self._token if k[0] == broker]:
                del self._token[k]
            if keys:
                self._save()

    # == inside (the lock held) ===========================================
    def _current(self, ticket):
        """The entry `ticket` is the answer of, while it is still that
        request's; else None."""
        if not ticket:
            return None
        key, token, _ = ticket
        cur = self._held.get(key)
        if cur is None or cur.get("state") != "out" or self._token.get(key) != token:
            return None
        return cur

    def _answer(self, key, cur, ok, status, detail, code) -> None:
        self._held.pop(key, None)
        self._token.pop(key, None)
        self._answered[key] = (
            {**cur, "state": "answered", "ok": bool(ok),
             "status": int(status) if isinstance(status, int) else None,
             "detail": detail if isinstance(detail, str) and detail else None,
             "code": code if isinstance(code, str) and code else None},
            _tick() + ANSWERED_S)
        while len(self._answered) > _ANSWERED_KEPT:
            self._answered.pop(next(iter(self._answered)))

    def _expire(self) -> None:
        now = _tick()
        for k in [k for k, (_, until) in self._answered.items() if until <= now]:
            del self._answered[k]

    def _place(self, key) -> None:
        if key not in self._seq:
            self._next += 1
            self._seq[key] = self._next
        if len(self._seq) > 4 * _ANSWERED_KEPT:
            live = set(self._held) | set(self._answered)
            self._seq = {k: v for k, v in self._seq.items() if k in live}

    # == the file =========================================================
    def _load(self) -> None:
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            return
        except OSError as e:
            self._set_aside(f"it could not be read ({type(e).__name__})", [])
            return
        why, kept = "", []
        if size > _MAX_BYTES:
            why = f"it is {size} bytes, more than this engine writes"
        else:
            try:
                data = json.loads(self.path.read_bytes().decode("utf-8"))
            except OSError as e:
                why = f"it could not be read ({type(e).__name__})"
            except (UnicodeDecodeError, ValueError):
                why = "it is not JSON"
            else:
                entries = data.get("held") if isinstance(data, dict) else None
                if not isinstance(entries, list):
                    why = "it holds no list of held requests"
                else:
                    seen, bad, twice = set(), 0, 0
                    for raw in entries:
                        e = _read_entry(raw)
                        if e is None:
                            bad += 1
                        elif (e["broker"], e["client_id"]) in seen:
                            twice += 1
                        else:
                            seen.add((e["broker"], e["client_id"]))
                            kept.append(e)
                    parts = []
                    if bad:
                        parts.append(f"{bad} of its {len(entries)} entries are not held requests")
                    if twice:
                        parts.append(f"{twice} of its {len(entries)} entries repeat the broker "
                                     "and client_id of an earlier one")
                    why = "; ".join(parts)
        if why:
            self._set_aside(why, kept)
            return
        self._adopt(kept)

    def _adopt(self, kept: list, write: bool = False) -> None:
        """The entries read, as this run holds them: each one left out by the
        run before is unknown now, code engine_stopped, and said so on disk
        (as is the whole record when `write`)."""
        stopped = 0
        for e in kept:
            if e["state"] == "out":
                e.update(state="unknown", code="engine_stopped",
                         detail=stopped_words(e["what"]))
                stopped += 1
            key = (e["broker"], e["client_id"])
            self._held[key] = e
            self._place(key)
        if stopped or write:
            with self._lock:
                self._save()

    def _set_aside(self, why: str, kept: list) -> None:
        """Rename the damaged file beside itself, say so in one line, and
        keep what could be read."""
        aside = self.path.with_name(f"{self.path.name}.bad-{_stamp()}")
        n = 1
        while aside.exists():
            n += 1
            aside = self.path.with_name(f"{self.path.name}.bad-{_stamp()}-{n}")
        try:
            os.replace(self.path, aside)
            where = f"set aside as {aside.name}"
        except OSError as e:
            where = f"and could not be set aside ({type(e).__name__})"
        self._say(f"[held requests] {self.path} was not read as it stands: {why}; "
                  f"{where}. The engine starts with {len(kept)} held request(s).")
        self._adopt(kept, write=bool(kept))

    def _save(self) -> None:
        """Write the whole record (out and unknown; never answered): a
        temporary file beside it, synced, then renamed over it (mode 0600).
        Called with the lock held."""
        rows = sorted(self._held.items(), key=lambda kv: (kv[1]["since"], self._seq.get(kv[0], 0)))
        data = json.dumps({"v": VERSION, "held": [e for _, e in rows]},
                          ensure_ascii=False, indent=1).encode("utf-8")
        tmp = self.path.with_name(f"{self.path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC
                         | getattr(os, "O_BINARY", 0), 0o600)
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            _sync_dir(self.path.parent)
        except OSError as e:
            self._say(f"[held requests] {self.path} could not be written "
                      f"({type(e).__name__}: {e}); the held requests are kept "
                      "until the engine stops.")


def _sync_dir(folder: Path) -> None:
    """The rename made durable where the system allows it (not on Windows,
    whose folders cannot be opened this way)."""
    try:
        fd = os.open(folder, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
