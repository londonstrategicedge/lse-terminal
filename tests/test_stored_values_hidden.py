"""A value a profile keeps never reaches a caller in its adapter's words.

An adapter should never print or quote a key (SPEC 8.5); these are for one
that does. Its words reach a caller whole (WORDS_CHARS bounds only a dump):
a refused connect, a refused handshake, a rejected order's reason, its
session's detail, a broker chart's error, the lines it printed. In each of
them the values the profile keeps are taken out first, and only then is
anything cut, so a value is never left half shown: its stored credentials
and the values of its own env (which its row never shows either).

The adapters are small Python files written into each test's own folder;
nothing here reaches the network.
"""
import json

from lse_terminal.engine.broker_hub import WORDS_CHARS
from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, link, rows, write_adapter)

LONG = ("Refusing Broker refused this handshake on its practice host "
        "(https://api.practice.refusing.example). A key made on a practice (demo) "
        "login works only on practice, and one made on a live login only on "
        "live: check that it is the key Refusing Broker showed for this login "
        "and that it has not been revoked. Refusing Broker does not offer this "
        "API to residents of the EU or to clients of its overseas arm.")
SECRET = "s3cr3t-value-0002"
ENV_TOKEN = "s3cr3t-value-123"
WIN_POST = {"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1"}
WIN_GET = {"Sec-Fetch-Site": "same-origin"}

REFUSER = '''
from brueconnect import Adapter, protocol

class Refuser(Adapter):
    name, version, broker = "refuser", "0.1", "refusing broker"

    def _dispatch(self, rid, method, params):
        if method == "hello":
            self._send(protocol.res_error(rid, "unauthorized", %r))
            return
        return super()._dispatch(rid, method, params)

Refuser().run()
''' % LONG

ECHO = '''
import os, sys
from brueconnect import Adapter, AdapterError

PAD = int(sys.argv[sys.argv.index("--pad") + 1]) if "--pad" in sys.argv else 0

class Echo(Adapter):
    name, version, broker = "echo", "0.1", "echoing broker"
    credential_form = [{"key": "api_secret", "label": "API secret", "type": "password"}]

    def on_first_call(self):
        secret = os.environ.get("BRUE_CRED_API_SECRET", "") or os.environ.get("MY_TOKEN", "")
        if PAD:
            raise AdapterError("unauthorized", "x" * PAD + secret + " and then more words.")
        raise AdapterError("unauthorized", %r + " The key it was sent: " + secret + ".")

    def handle_catalog_list(self, params):
        return {"instruments": []}

Echo().run()
''' % LONG

# An adapter that quotes its key wherever its own words go.
QUOTER = '''
import os, sys, time
from brueconnect import Adapter, AdapterError

KEY = os.environ.get("BRUE_CRED_API_SECRET", "") or os.environ.get("MY_TOKEN", "")
if "--print-key" in sys.argv:
    print("using token", KEY, file=sys.stderr, flush=True)


def spec(symbol):
    return {"symbol": symbol, "name": symbol, "asset_class": "equity",
            "base_ccy": "X", "quote_ccy": "USD", "digits": 2,
            "tick_size": 0.01, "lot_step": 1, "min_qty": 1, "max_qty": 1000,
            "contract_size": 1, "margin_rate": 0.1,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


class Quoter(Adapter):
    name, version, broker = "quoter", "0.1", "quoting broker"
    credential_form = [{"key": "api_secret", "label": "API secret", "type": "password"}]

    def broker_info(self):
        return {"display_name": "Quoting Broker"}

    def capabilities(self):
        return {"orders": {"market": True, "pending": True, "pending_types": ["limit"]},
                "data": {"quotes": True, "bars": True, "history": True}}

    def handle_catalog_list(self, params):
        return {"instruments": [spec("F")]}

    def handle_account_get(self, params):
        self.emit("session.state", {"state": "degraded",
                                    "detail": "the stream is slow for the key " + KEY})
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": []}

    def handle_order_place(self, params):
        cid = params["client_id"]
        self.emit("order.accepted", {"client_id": cid, "order_id": "o1"})
        self.emit("order.rejected", {"client_id": cid, "order_id": "o1",
                                     "reason": "refused for the key " + KEY})
        return {"order_id": "o1", "status": "accepted"}

    def handle_bars_history(self, params):
        raise AdapterError("internal", "the bars could not be read with the key " + KEY)

Quoter().run()
'''


def _store(client, name, value):
    r = client.post("/api/broker/credentials", headers=WIN_POST, json={
        "broker": name, "values": {"api_secret": value}, "merge": True})
    assert r.status_code == 200, r.text


def _connect(client, name, headers=None):
    return client.post("/api/broker/connect", json={"broker": name}, headers=headers or {})


def test_a_refusal_that_quotes_a_stored_key_past_300_characters(client, home):
    """A connect refused in a long sentence that quotes the stored key after
    its 300th character. The answer the card that pressed Connect shows
    first is the whole sentence, the key taken out, as in the card's record
    (last_error)."""
    path = write_adapter(home / "echo", name="echo.py", source=ECHO)
    assert link(client, "echo", python_file=path).status_code == 200
    _store(client, "echo", SECRET)
    for headers in (WIN_POST, {}):                       # the window, and a program
        r = _connect(client, "echo", headers)
        assert r.status_code == 400, r.text
        detail = r.json()["detail"]
        assert SECRET not in detail
        assert detail == "unauthorized: " + LONG + " The key it was sent: [hidden].", detail
    record = rows(client)["echo"]["last_error"]["message"]
    assert SECRET not in record and record.endswith("The key it was sent: [hidden].")


def test_a_key_quoted_across_the_cut_is_not_left_half_shown(client, home):
    """The key is taken out before the words are cut, not after: one quoted
    across the WORDS_CHARS mark leaves none of itself behind."""
    lead = len("unauthorized: ")
    pad = WORDS_CHARS - lead - 6                         # the key starts 6 before the cut
    path = write_adapter(home / "echo", name="echo.py", source=ECHO)
    r = link(client, "echo", python_file=path, args=["--pad", str(pad)])
    assert r.status_code == 200, r.text
    _store(client, "echo", SECRET)
    r = _connect(client, "echo", WIN_POST)
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert len(detail) <= WORDS_CHARS
    assert detail[lead + pad:lead + pad + 6] == "[hidde", detail[-40:]
    assert not any(SECRET[:n] in detail for n in range(4, len(SECRET) + 1))


def test_a_long_handshake_refusal_reaches_the_add_form_whole(client, home):
    """A link whose adapter refuses the handshake in a 400-character
    sentence, what matters said last. The link's answer, which the add form
    shows, keeps it whole."""
    path = write_adapter(home / "refuser", name="refuser.py", source=REFUSER)
    r = link(client, python_file=path)
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert len(detail) > 300
    assert detail == "The adapter refused the handshake: unauthorized: " + LONG, detail
    assert "refuser" not in rows(client)


def test_an_adapters_other_words_never_carry_the_stored_key(client, home):
    """Its words reach the window in more places than a refusal: a rejected
    order's reason, its session's detail on the row, a broker chart's error.
    Each says what the adapter said, with the stored key taken out."""
    path = write_adapter(home / "quoter", name="quoter.py", source=QUOTER)
    assert link(client, "quoter", python_file=path).status_code == 200
    _store(client, "quoter", SECRET)
    r = _connect(client, "quoter", WIN_POST)
    assert r.status_code == 200, r.text
    # a resting order the broker rejected: its reason
    r = client.post("/api/broker/order/pending", headers=WIN_POST, json={
        "broker": "quoter", "symbol": "F", "side": "buy", "qty": 1,
        "type": "limit", "price": 9.0})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected"
    assert r.json()["reason"] == "refused for the key [hidden]", r.json()
    # its session's detail, on its row
    assert client.get("/api/broker/account?broker=quoter", headers=WIN_GET).status_code == 200
    import time
    deadline = time.time() + 5
    while time.time() < deadline and "session" not in rows(client)["quoter"]:
        time.sleep(0.1)
    sess = rows(client)["quoter"]["session"]
    assert sess == {"state": "degraded", "detail": "the stream is slow for the key [hidden]"}, sess
    # a broker chart's error
    r = client.get("/api/candles", headers=WIN_GET, params={
        "provider": "broker:quoter", "symbol": "F", "timeframe": "1h", "limit": 10})
    assert r.status_code == 502, r.text
    assert SECRET not in r.text
    assert r.json()["detail"] == ("candles failed: internal: the bars could not be read "
                                  "with the key [hidden]"), r.json()


def test_a_value_from_the_profiles_env_is_hidden_like_a_stored_key(client, home):
    """A profile's own env holds what its adapter was given there, a token
    among them, and its row never shows those values (command_preview leaves
    them out). An adapter that prints or quotes one does not put it on its
    row's `printed`, for the window or a program, nor in a refused connect
    or a refused link."""
    path = write_adapter(home / "quoter", name="quoter.py", source=QUOTER)
    r = link(client, "own-env", python_file=path, args=["--print-key"],
             env={"MY_TOKEN": ENV_TOKEN})
    assert r.status_code == 200, r.text
    assert ENV_TOKEN not in json.dumps(r.json())
    assert r.json()["printed"] == "using token [hidden]", r.json().get("printed")
    assert _connect(client, "own-env", WIN_POST).status_code == 200
    for headers in (WIN_GET, {}):
        row = {b["broker"]: b for b in client.get("/api/broker/list", headers=headers).json()}
        assert ENV_TOKEN not in json.dumps(row["own-env"]), headers
        assert "using token [hidden]" in row["own-env"]["printed"], headers
    # a refused connect that quotes it
    echo = write_adapter(home / "echo", name="echo.py", source=ECHO)
    assert link(client, "echo-env", python_file=echo, env={"MY_TOKEN": ENV_TOKEN}).status_code == 200
    r = _connect(client, "echo-env", WIN_POST)
    assert r.status_code == 400 and ENV_TOKEN not in r.text, r.text
    assert r.json()["detail"].endswith("The key it was sent: [hidden].")
    # a refused link whose adapter printed it before it stopped
    stops = write_adapter(home / "stops", name="stops.py", source=(
        "import os, sys\nprint('using token', os.environ.get('MY_TOKEN'), file=sys.stderr)\n"
        "sys.exit(3)\n"))
    r = link(client, "stops", python_file=stops, env={"MY_TOKEN": ENV_TOKEN})
    assert r.status_code == 400 and ENV_TOKEN not in r.text, r.text
    assert r.json()["stderr"] == "using token [hidden]"


# ── the stream's error, and the indicator preview and backtests ────────────
# (each test here fails with its redaction put back to str(e).)

STREAMER = QUOTER.replace(
    "    def handle_bars_history(self, params):",
    "    def handle_quotes_subscribe(self, params):\n"
    "        raise AdapterError(\"internal\", \"the stream could not open with the key \" + KEY)\n\n"
    "    def handle_bars_history(self, params):")


def test_the_live_streams_error_never_carries_the_stored_key(client, home):
    """An adapter whose quotes.subscribe refuses quoting the stored key. Over
    /api/ws the window and a program each get the stream's error with the
    key taken out."""
    assert STREAMER != QUOTER
    path = write_adapter(home / "streamer", name="streamer.py", source=STREAMER)
    assert link(client, "streamer", python_file=path).status_code == 200
    _store(client, "streamer", SECRET)
    r = _connect(client, "streamer", WIN_POST)
    assert r.status_code == 200, r.text
    assert r.json().get("data_source") == "broker:streamer", r.json()
    got = []
    for headers in ({"host": "127.0.0.1", "Origin": "http://127.0.0.1"},   # the window
                    {"host": "127.0.0.1"}):                                # a program
        with client.websocket_connect("/api/ws?provider=broker:streamer&symbols=F",
                                      headers=headers) as ws:
            got.append(ws.receive_json())
    for msg in got:
        assert SECRET not in json.dumps(msg), msg
        assert msg == {"type": "error", "message": (
            "internal: the stream could not open with the key [hidden]")}, msg


def test_the_preview_and_the_backtests_never_carry_the_stored_key(client, home):
    """A broker's bars that cannot be read, in words that quote the stored
    key, answered by the indicator preview, the backtest, Monte Carlo and
    walk-forward."""
    path = write_adapter(home / "quoter", name="quoter.py", source=QUOTER)
    assert link(client, "quoter", python_file=path).status_code == 200
    _store(client, "quoter", SECRET)
    assert _connect(client, "quoter", WIN_POST).status_code == 200
    want = "candles failed: internal: the bars could not be read with the key [hidden]"
    calls = {
        "preview": ("/api/user-indicators/preview",
                    {"source": "x = 1\n", "provider": "broker:quoter", "symbol": "F",
                     "timeframe": "1h", "limit": 60}),
        "backtest": ("/api/backtest", {"provider": "broker:quoter", "symbol": "F",
                                       "timeframe": "1h", "script": "pass\n"}),
        "montecarlo": ("/api/backtest/montecarlo", {"provider": "broker:quoter",
                                                    "symbol": "F", "timeframe": "1h",
                                                    "script": "pass\n", "runs": 10}),
        "walkforward": ("/api/backtest/walkforward", {"provider": "broker:quoter",
                                                      "symbol": "F", "timeframe": "1h",
                                                      "script": "pass\n",
                                                      "params": {"n": "1:2:1"}}),
    }
    for what, (route, body) in calls.items():
        r = client.post(route, headers=WIN_POST, json=body)
        assert r.status_code == 502, (what, r.status_code, r.text)
        assert SECRET not in r.text, (what, r.text)
        assert r.json()["detail"] == want, (what, r.json())
