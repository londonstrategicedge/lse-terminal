"""Which of a profile's own values are taken out of its adapter's words.

The rule has one closed list of mode words (tests/test_hidden_words_rule.py
states it whole and holds its table and cases). A stored credential is
hidden from 4 characters, whatever it looks like, and never shorter. A value
of the profile's own env is hidden when its name holds a secret word as a
whole part and the value is 4 or more characters and not one of the mode
words of that list (MY_PASSWORD=swordfish is hidden, AUTH_MODE=password is
kept), or when the value looks like a key (12 or more characters with both
letters and digits and no space, or 20 or more of [A-Za-z0-9+/=_-]); of a
URL, its userinfo, its query's values and its long path parts. Anything else
is kept: hiding every env value of 4 or more characters would garble an
adapter's ordinary words ("not the [hidden] one" for an env word "paper").

The cases below hold these too: a 3-character value under a secret name
(MY_TOKEN=abc) and a 3-character stored key are kept; a number of 20 digits
or more is hidden as key-like. A word of lower-case letters under a secret
name is kept only when it is one of the mode words. The sign-in modes are
mode words (MERIDIAN_AUTH=login, which the Terminal itself sets, is kept); a
secret word glued to another word, plural or numbered makes a name
secret-worded (APISECRET, PASSWORD2); and an address, a host and a port, is
kept as it is in a URL.

The adapters are small Python files written into each test's own folder;
nothing here reaches the network.
"""
import json

from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, link, rows, write_adapter)
from test_stored_values_hidden import ECHO, WIN_POST, _connect, _store

# An adapter that refuses its first call in a sentence with the word "paper".
REFUSE_WORDS = "this key is for a live login, not the paper one"
PLAIN = '''
from brueconnect import Adapter, AdapterError

class Plain(Adapter):
    name, version, broker = "plain", "0.1", "plain broker"

    def on_first_call(self):
        raise AdapterError("unauthorized", %r)

    def handle_catalog_list(self, params):
        return {"instruments": []}

Plain().run()
''' % REFUSE_WORDS

# An adapter that refuses its first call quoting the env values it is told
# to name on its command line, as NAME=value, one after another.
QUOTES_ENV = '''
import os, sys
from brueconnect import Adapter, AdapterError

NAMES = sys.argv[sys.argv.index("--quote") + 1].split(",")

class QuotesEnv(Adapter):
    name, version, broker = "quotes-env", "0.1", "quoting broker"

    def on_first_call(self):
        raise AdapterError("unauthorized", "; ".join(
            n + "=" + os.environ.get(n, "") for n in NAMES) + ".")

    def handle_catalog_list(self, params):
        return {"instruments": []}

QuotesEnv().run()
'''

HEX32 = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"


def test_an_env_value_that_is_a_common_word_stays_in_the_adapters_words(client, home):
    """A profile whose env sets a mode word; the refusal the card shows is
    the adapter's sentence as it said it."""
    path = write_adapter(home / "plain", name="plain.py", source=PLAIN)
    assert link(client, "plain-env", python_file=path,
                env={"MY_ACCOUNT_KIND": "paper"}).status_code == 200
    r = _connect(client, "plain-env", WIN_POST)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "unauthorized: " + REFUSE_WORDS, r.json()
    assert rows(client)["plain-env"]["last_error"]["message"] == (
        "unauthorized: " + REFUSE_WORDS)


def _refusal(client, home, env):
    path = write_adapter(home / "quotes", name="quotes.py", source=QUOTES_ENV)
    r = link(client, "quotes-env", python_file=path, args=["--quote", ",".join(env)], env=env)
    assert r.status_code == 200, r.text
    out = {}
    for who, headers in (("window", WIN_POST), ("program", {})):
        r = _connect(client, "quotes-env", headers)
        assert r.status_code == 400, r.text
        out[who] = r.json()["detail"]
    out["record"] = rows(client)["quotes-env"]["last_error"]["message"]
    return out


def test_env_values_are_hidden_by_their_name_or_their_look_and_words_are_kept(client, home):
    env = {"MY_TOKEN": "abc",                       # a secret name, but 3 characters: kept
           "MY_SECRET": "abc4",                     # a secret name, 4 characters: hidden
           "MY_PASSWORD": "swordfish",              # lower-case letters, no mode word: hidden
           "AUTH_MODE": "password",                 # a mode word of the one list: kept
           "ACCOUNT_REF": HEX32,                    # 32 characters of hex, any name: hidden
           "MODE": "practice", "SYMBOL": "EURUSD",  # a plain word
           "SIZE": "1000",                          # a number
           "DIR": "/home/u/x",                      # a path
           "BASE": "https://api.example/v3/accounts",  # a URL with no userinfo or query
           "FEED": "https://u1:pw9@feed.example/v1?k=q8r7s6t5&tier=gold"}
    want = ("unauthorized: MY_TOKEN=abc; MY_SECRET=[hidden]; MY_PASSWORD=[hidden]; "
            "AUTH_MODE=password; ACCOUNT_REF=[hidden]; MODE=practice; "
            "SYMBOL=EURUSD; SIZE=1000; DIR=/home/u/x; BASE=https://api.example/v3/accounts; "
            "FEED=https://[hidden]@feed.example/v1?k=[hidden]&tier=gold.")
    got = _refusal(client, home, env)
    assert got == {"window": want, "program": want, "record": want}, json.dumps(got, indent=1)


def test_a_value_that_looks_like_a_key_is_hidden_under_any_name(client, home):
    env = {"ACCOUNT": "acct7Q2x9Lm4Zp",             # 14, letters and digits, no space
           "LABEL": "aGVsbG8gd29ybGQgYmFzZTY0",     # 24 characters of base64
           "NOTE": "two words 12345678901",         # a space: not a key
           # 24 digits are 20 or more of [A-Za-z0-9+/=_-]: key-like, judged
           # before the rule that keeps a number
           "WHEN": "123456789012345678901234",
           "COUNT": "1234567890123456789"}          # 19 digits: a number, kept
    got = _refusal(client, home, env)
    assert got["window"] == ("unauthorized: ACCOUNT=[hidden]; LABEL=[hidden]; "
                             "NOTE=two words 12345678901; WHEN=[hidden]; "
                             "COUNT=1234567890123456789."), got


def test_a_stored_credential_is_hidden_always_whatever_it_looks_like(client, home):
    """The stored key is the user's secret however plain it is, from 4
    characters; one of 1 to 3 is never taken out (it would garble the
    words), so "a1b" is said as it is."""
    path = write_adapter(home / "echo", name="echo.py", source=ECHO)
    assert link(client, "echo", python_file=path).status_code == 200
    for value, said in (("paper", "[hidden]"), ("a1b2", "[hidden]"), ("a1b", "a1b")):
        _store(client, "echo", value)
        r = _connect(client, "echo", WIN_POST)
        assert r.status_code == 400, r.text
        assert r.json()["detail"].endswith(f"The key it was sent: {said}."), (value, r.json())


def test_the_classifier_itself():
    from lse_terminal.engine.broker_hub import BrokerHub
    hidden = BrokerHub._env_values
    # 1 to 3 characters are never hidden, whatever the name
    assert hidden({"MY_TOKEN": "abc"}) == []
    assert hidden({"my_api_key": "x1"}) == []
    assert hidden({"my_api_key": "x1y2"}) == ["x1y2"]       # any case
    for name in ("KEY", "SECRET", "TOKEN", "PASS", "PWD", "PIN", "AUTH", "CRED", "COOKIE",
                 "SESSION", "PRIVATE", "SIGN"):
        # a mode word of the one closed list ("plain" is one) is kept; any
        # other value of 4 or more characters is hidden, lower-case letters
        # or not
        assert hidden({f"A_{name.lower()}_B": "plain"}) == [], name
        assert hidden({f"A_{name.lower()}_B": "Plain"}) == ["Plain"], name
        assert hidden({f"A_{name.lower()}_B": "swordfish"}) == ["swordfish"], name
    assert hidden({"ANY": HEX32}) == [HEX32]
    assert hidden({"ANY": HEX32.upper()}) == [HEX32.upper()]
    for word in ("practice", "EURUSD", "1000", "/home/u/x", "paper", "true", "EUR_USD",
                 "-3.5", "1e6", "~/keys", "C:\\Users\\u", "./state", "https://host.example/v3",
                 "two words", "short1"):
        assert hidden({"MODE": word}) == [], word
    # a URL: its userinfo and its query's values, never the rest of it; a
    # query value that is a word or a number only when its key looks secret
    got = hidden({"FEED": "https://u1:pw9@feed.example/v1?k=q8r7&tier=gold&page=1"})
    assert set(got) == {"u1:pw9", "q8r7"}, got
    # "abc" and "a/b" are 3 characters, never hidden
    got = hidden({"FEED": "https://u1:longpass@h.example/?token=abc&n=2&sig=a%2Fb"})
    assert set(got) == {"u1:longpass", "longpass", "a%2Fb"}, got
    # a sign-in mode is a mode word; a secret word glued, plural or numbered
    # makes a name secret-worded, and PING stays plain; an address by name is
    # kept as it is in a URL
    assert hidden({"MERIDIAN_AUTH": "login", "AUTH_FLOW": "refresh"}) == []
    assert hidden({"APISECRET": "quixotic", "PASSWORD2": "hullabaloo", "TOKENS": "kumquat",
                   "PING": "everysecond", "CREDIT": "unlimited"}) == [
                       "quixotic", "hullabaloo", "kumquat"]
    assert hidden({"FEED_ADDR": "venues.example.net:9101"}) == []
    # the terminal's own entries are never the profile's
    assert hidden({"BRUE_CONNECT_EXAMPLE": HEX32}) == []
    # {state} expanded, as the adapter gets it, judged the same way
    assert hidden({"STATE_TOKEN": "{state}/t"}, state="/s") == ["{state}/t", "/s/t"]
    assert hidden({"DIR": "{state}/x"}, state="/s") == []


def test_a_short_value_is_never_taken_out_of_a_hidden_mark(client, home):
    """A stored value can be part of the mark that stands in for another
    ("idde" is in "[hidden]"; "idd" is 3 characters and never hidden): each
    value is taken out in one pass over the adapter's words, so a mark is
    never cut again."""
    from test_stored_values_hidden import SECRET
    path = write_adapter(home / "echo", name="echo.py", source=ECHO)
    assert link(client, "echo", python_file=path).status_code == 200
    r = client.post("/api/broker/credentials", headers=WIN_POST, json={
        "broker": "echo", "values": {"api_secret": SECRET, "pin": "idde"}, "merge": True})
    assert r.status_code == 200, r.text
    r = _connect(client, "echo", WIN_POST)
    assert r.status_code == 400, r.text
    assert r.json()["detail"].endswith("The key it was sent: [hidden]."), r.json()
