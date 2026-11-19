"""Which of a profile's values are taken out of its adapter's words: the rule,
with its one closed list of mode words and its secret-worded name parts.

  - A stored credential value (what the row's key form saved) is hidden
    wherever it appears when it is 4 or more characters, whatever it looks
    like. One of 1 to 3 characters is never hidden: it would garble the words.
  - A value of the profile's own env is hidden when
    (a) its name is secret-worded, and the value is 4 or more characters and
        not one of the mode words of one closed list (MODE_WORDS below), as
        it is written: AUTH_MODE=password and MERIDIAN_AUTH=login are kept,
        PASSWORD=swordfish is hidden. The name is split at "_", "-", "." and
        where a lower-case letter meets a capital; a part is secret-worded
        when, with a trailing plural S or trailing digits taken off, it is a
        secret word (KEYS, PASSWORD2), or it begins or ends with one of the
        secret words of five letters or more (APISECRET, SECRETKEY,
        ACCESSTOKEN), or it is AUTHORIZATION, or it holds AUTHTOKEN, APIKEY or
        SESSIONID; PING, BYPASS, PASSIVE, COMPASS and CREDIT stay plain; or
    (b) whatever its name, the value looks like a key: 12 or more characters
        with both letters and digits and no space, or 20 or more characters
        of [A-Za-z0-9+/=_-], judged before any plain-word rule, unless it is
        an address, a host and a port and nothing else, which is judged as
        that address in a URL is; or
    (c) it is a URL's userinfo, a query value, or a part of its path of 20 or
        more characters of [A-Za-z0-9_-] (a webhook's secret path). A query
        value under a key that is secret-worded is judged as in (a).
  - Anything else is kept: a plain word, a number, a path, an address, a URL
    without those parts. Every value the Terminal itself gives its own rows'
    adapters is kept, unless it is a key typed into a row's form.

What the cases guard against. A name rule that matches the listed letters
anywhere in a name (PING holds PIN), with no length floor, takes a setting's
one-digit value out of every price ("1.08512" comes out as
"[hidden].085[hidden]2") and shows secrets under names the list lacks. A rule
that keeps ANY value of lower-case letters under a secret-worded name, to
keep its mode words, shows a secret of lower-case letters:
PASSWORD=swordfish, API_PASSWORD=hunter, a passphrase of 19 lower-case
letters. A list without the sign-in modes takes the "login" the Terminal
itself sets for a simulated venue (MERIDIAN_AUTH=login) out of everything
its adapter says. A rule under which a secret word glued to another word,
made plural or numbered makes no name secret-worded shows the value under it
(APISECRET=Tr0ub4dor and ACCESSTOKEN=sesamestreet on the card). Each case is
here with what this rule gives, through every kind of words an adapter says:
a refusal, the card's record of it (last_error), its printed lines, its
session's detail, a rejected order's reason, and the held record, in memory
and on disk.

The adapters are small Python files written into each test's own folder;
nothing here reaches the network.
"""
import json
import os
import urllib.parse
from pathlib import Path

import pytest

from lse_terminal.engine.broker_hub import EXAMPLE_ENV, EXAMPLES, SIM_ADAPTERS
from test_own_broker import (  # noqa: F401 - fixtures
    adapter, client, home, hub_of, link, registry_file, rows, write_adapter)
from test_stored_values_hidden import ECHO, QUOTER, SECRET, WIN_GET, WIN_POST, _connect, _store

# The adapter's own sentence around the settings it quotes: a price, a date,
# and the words a simulated venue's adapter says about its sign-in ("the
# stored login", "log in again", "registering afresh"), which a sign-in mode
# word taken out of every word that holds it would garble.
LEAD = ("needs 120.50 at 1.08512 on 2026-11-15 UTC, more than the 1000 free; "
        "sign in with the password again; no longer accepts the stored login, "
        "log in again or go on registering afresh")

# The classifier table, each entry with what this rule gives: True when the
# value is taken out.
TABLE = [
    ("PING_INTERVAL_S", "20", False),
    ("BYPASS_CACHE", "1", False),
    ("SESSION_TZ", "UTC", False),
    ("AUTH_MODE", "password", False),
    ("CREDIT_LIMIT", "5000", False),
    ("SIGNAL_TF", "M5", False),
    ("KEYBOARD_LAYOUT", "uk", False),
    ("PASSIVE_MODE", "true", False),
    ("TOKEN_TTL_S", "60", False),
    ("FEED_URL", "https://feed.example/v1?session=1&ping=20", False),
    ("WALLET_MNEMONIC", "abandon ability able about above absent absorb abstract", True),
    ("LOGIN_PW", "Tr0ub4dor&3", True),
    ("BROKER_PW", "hunter22", True),
    ("SEED_PHRASE", "correct horse battery staple", True),
    ("WEBHOOK_URL", "https://hooks.example/services/T000/B000/aGVsbG8gd29ybGQgc2VjcmV0", True),
    ("ACCESS", "CorrectHorseBatteryStaple", True),
    ("MY_TOKEN", " ", False),
]
# Beside it: more cases this rule keeps or hides, and a webhook's address
# under a name that is not secret, whose path alone is its secret.
MORE = [
    ("MY_TOKEN", "abc", False),          # a secret name, but 3 characters
    ("MY_ACCOUNT_KIND", "paper", False),
    ("MODE", "practice", False),
    ("SYMBOL", "EURUSD", False),
    ("SIZE", "1000", False),
    ("DIR", "/home/u/x", False),
    ("MY_TOKEN", "tok-abc", True),       # a secret name, 7 characters, not all letters
]
NOTIFY = "https://notify.example/hook/T111/B111/c2VjcmV0LXBhdGgtcGFydC0wMDAx"
NOTIFY_SAID = "https://notify.example/hook/T111/B111/[hidden]"

# More cases by kind, each with what this rule gives: True when the value is
# taken out.
EX_HOOK = "https://hooks.ex/services/T/B/aGVsbG8gd29ybGQgc2VjcmV0"
# all lower-case letters under a secret-worded name: hidden
WORDLIKE = [("PASSWORD", "swordfish", True), ("API_PASSWORD", "hunter", True),
            ("PASSPHRASE", "correcthorsebattery", True),     # 19 lower-case letters
            ("SESSION", "abcdef", True), ("TOKEN", "opensesame", True)]
# a setting under a secret-worded name, 4 or more characters and no mode
# word: hidden (the price of hiding what may be a secret)
CONFIGS = [("SESSION_LIMIT", "5000", True), ("SESSION_TIMEOUT", "3600", True),
           ("AUTH_LEVEL", "5000", True), ("SIGN_WINDOW_S", "3600", True),
           ("PIN_DIGITS", "Four", True), ("CRED_TTL", "86400", True),
           ("SESSION_TZ", "Europe/London", True), ("SESSION_NAME", "Primary", True)]
# secrets under LOGIN_PW, WEBHOOK_URL and PASSPHRASE: hidden
THE_REST = [("LOGIN_PW", "Tr0ub4dor&3", True), ("WEBHOOK_URL", EX_HOOK, True),
            ("PASSPHRASE", "correcthorsebatterystaple", True)]
# prices and settings kept whole, and a mode word under a secret-worded name
IS_KEPT = [("PRICE", "1.08512", False), ("SIZE", "1000", False), ("DATE", "2026-11-15", False),
           ("CREDIT_LIMIT", "5000", False), ("PING_INTERVAL_S", "20", False),
           ("AUTH_MODE", "password", False)]
BY_KIND = WORDLIKE + CONFIGS + THE_REST + IS_KEPT

# The one closed list of mode words, the sign-in modes among them: under a
# secret-worded name only one of these, as written, is kept.
LISTED_MODE_WORDS = (
    "password passwd passphrase token oauth oauth2 basic bearer digest hmac apikey key "
    "cookie session header query body none off on true false yes no paper practice demo "
    "live sandbox test prod production default auto manual plain rsa ed25519 sha256 "
    "utc login register signin signup sso oidc saml device interactive refresh").split()

# A secret word glued to another word, made plural or followed by digits
# makes its name secret-worded, so a value under it that does not look like a
# key is hidden wherever the adapter says it. Each name with such a value
# (none of them 12 characters with digits, none a mode word).
GLUED = [("APISECRET", "quixotic"), ("SECRETKEY", "zephyrine"), ("APITOKEN", "marmalade"),
         ("AUTHTOKEN", "gondolier"), ("ACCESSTOKEN", "sesamestreet"),
         ("APIPASSWORD", "Tr0ub4dor"), ("PASSCODE", "4711x"), ("PASSKEY", "lanternfish"),
         ("SESSIONID", "s9x8c7"), ("PRIVATEKEY", "pumpernickel"), ("CLIENTSECRET", "whirligig"),
         ("TOKENS", "kumquat"), ("SECRETS", "bramblewood"), ("KEYS", "xylograph"),
         ("PASSWORDS", "fiddlehead"), ("PASSWORD2", "hullabaloo"),
         ("AUTHORIZATION", "Basic dXNlcjpwYXNz")]
# Names that hold a secret word's letters and are no secret: they stay plain.
PLAIN_NAMES = [("PING", "everysecond"), ("BYPASS", "thecache"), ("PASSIVE", "listening"),
               ("COMPASS", "northwest"), ("CREDIT", "unlimited")]
# The same words as a URL's query keys.
GLUED_URL = ("https://feed.example/v1?accesstoken=gooseberry&passcode=nightjar"
             "&apisecret=fennelseed&ping=wombat&compass=north")
GLUED_URL_SAID = ("https://feed.example/v1?accesstoken=[hidden]&passcode=[hidden]"
                  "&apisecret=[hidden]&ping=wombat&compass=north")

# A directory row's endpoint for a simulated venue: a public host by name, as
# the hosted directory announces one, with TLS; and the others a row can give.
OWN_EP = {"host": "venues.londonstrategicedge.com", "port": 9101, "tls": True}
ENDPOINTS = [OWN_EP, {"host": "venues.example.net", "port": 7631, "tls": False},
             {"host": "localhost", "port": 7631, "tls": False},
             {"host": "127.0.0.1", "port": 9101, "tls": False}]
# What the Terminal itself gives its own simulated venues' adapters for that
# row (each SIM_ADAPTERS entry's env, the feed port a row may carry): none of
# it is a secret.
OWN_ENV = {n: v for spec in SIM_ADAPTERS.values()
           for n, v in spec["env"](OWN_EP, {"ws_port": 9102}).items()}


def _hidden(name, value):
    from lse_terminal.engine.broker_hub import BrokerHub
    return BrokerHub._env_values({name: value})


# ── the classifier ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,value,hidden", TABLE + MORE + BY_KIND)
def test_the_table_and_the_cases_beside_it(name, value, hidden):
    got = _hidden(name, value)
    if hidden:
        assert value in got, (name, value, got)
    else:
        assert got == [], (name, value, got)


def test_under_a_secret_name_only_a_mode_word_of_the_one_list_is_kept():
    """A secret of lower-case letters would be shown if every lower-case
    value under a secret-worded name were kept. Only a word of the closed
    list is, as it is written; any other value of 4 or more characters there
    is hidden, and a short one still never."""
    from lse_terminal.engine.broker_hub import MODE_WORDS, secret_name
    assert len(LISTED_MODE_WORDS) == 50
    assert MODE_WORDS == frozenset(LISTED_MODE_WORDS)
    for name in ("AUTH_MODE", "PASSWORD", "API_PASSWORD", "TOKEN", "SESSION", "SIGN_TYPE",
                 "myApiKey", "x.secret", "db-dsn", "A_COOKIE_B", "MERIDIAN_AUTH"):
        assert secret_name(name), name
        for word in LISTED_MODE_WORDS:
            assert _hidden(name, word) == [], (name, word)
        for value in ("swordfish", "hunter", "opensesame", "abcdef", "correcthorsebattery",
                      "logon", "plainer",
                      # a mode word written otherwise, or with more to it
                      "Password", "PASSWORD", "password1", "passwords", " password",
                      "live-demo", "oauth3", "Bearer", "Login", "logins", "register2"):
            assert _hidden(name, value) == [value], (name, value)
        assert _hidden(name, "abc") == [] and _hidden(name, "hun") == [], name
    # under a name that holds no secret word, a plain word is kept as before
    for value in ("swordfish", "hunter", "login", "Primary"):
        assert _hidden("MODE", value) == [], value


def test_a_setting_under_a_secret_name_is_hidden_and_a_price_beside_it_stays_whole():
    """SESSION_LIMIT=5000 is a setting, but under a secret-worded name, 4
    characters and no mode word, so it is taken out wherever it is said;
    1.08512 beside it is whole."""
    from lse_terminal.engine.broker_hub import BrokerHub
    hub = BrokerHub.__new__(BrokerHub)
    said = "needs 5000.50 at 1.08512; stop out at 5000"
    assert BrokerHub._redact(hub, "x", said, secrets=_hidden("SESSION_LIMIT", "5000")) == (
        "needs [hidden].50 at 1.08512; stop out at [hidden]")
    assert BrokerHub._redact(hub, "x", said, secrets=_hidden("PING_INTERVAL_S", "20")) == said


def test_a_webhooks_secret_path_is_hidden_and_the_rest_of_its_address_kept():
    assert _hidden("NOTIFY_URL", NOTIFY) == ["c2VjcmV0LXBhdGgtcGFydC0wMDAx"]
    # under a name holding a secret word, the whole address too
    got = _hidden("WEBHOOK_URL", "https://hooks.example/services/T000/B000/aGVsbG8gd29ybGQgc2VjcmV0")
    assert set(got) == {"https://hooks.example/services/T000/B000/aGVsbG8gd29ybGQgc2VjcmV0",
                        "aGVsbG8gd29ybGQgc2VjcmV0"}, got
    # a path part shorter than 20, or with a character outside [A-Za-z0-9_-], is kept
    assert _hidden("NOTIFY_URL", "https://h.example/a/B000/short1234567890") == []
    assert _hidden("NOTIFY_URL", "https://h.example/a/" + "x" * 19) == []
    assert _hidden("NOTIFY_URL", "https://h.example/a/" + "x" * 20) == ["x" * 20]


def test_which_parts_of_a_name_are_secret_worded():
    """A part is secret-worded when, with a trailing plural S or trailing
    digits taken off, it is a secret word; or it begins or ends with a secret
    word of five letters or more; or it is AUTHORIZATION; or it holds
    AUTHTOKEN, APIKEY or SESSIONID. A short secret word inside a longer word
    is no secret word (PING holds PIN, MONKEY holds KEY)."""
    from lse_terminal.engine.broker_hub import SECRET_ENDS, name_parts, secret_name
    assert name_parts("PING_INTERVAL_S") == ["PING", "INTERVAL", "S"]
    assert name_parts("myApiKey") == ["my", "Api", "Key"]
    assert name_parts("api-key.v2") == ["api", "key", "v2"]
    assert name_parts("APIKey") == ["APIKey"]
    assert SECRET_ENDS == frozenset(
        "SECRET TOKEN PASSWORD PASSWD PASSCODE PASSKEY PASSPHRASE PRIVATE SESSION CREDENTIAL "
        "SIGNATURE BEARER COOKIE MNEMONIC".split())
    for name in ("PING_INTERVAL_S", "BYPASS_CACHE", "CREDIT_LIMIT", "SIGNAL_TF",
                 "KEYBOARD_LAYOUT", "PASSIVE_MODE", "SPINE", "AUTHOR", "SEEDLING",
                 "MONKEY", "PASSPORT_NO", "CREDITS", "HOTKEYS", "PINGS", "PING2",
                 "COMPASSES", "BYPASS2"):
        assert not secret_name(name), name
    for name in ("SESSION_TZ", "AUTH_MODE", "TOKEN_TTL_S", "LOGIN_PW", "WALLET_MNEMONIC",
                 "SEED_PHRASE", "WEBHOOK_URL", "my_api_key", "myApiKey", "APIKey",
                 "x.secret", "db-dsn", "MY_TOKEN",
                 # plural or numbered
                 "KEY2", "PINS", "API_KEYS", "my_tokens", "x.secrets", "clientSecret2",
                 # glued to another word
                 "TOPSECRET", "Authorization", "X_AUTHTOKEN_V", "XAPIKEYID", "MYSESSIONIDS"):
        assert secret_name(name), name
    words = ("KEY APIKEY SECRET TOKEN PASS PASSWORD PASSWD PASSPHRASE PASSCODE PASSKEY PWD PW "
             "PIN AUTH CRED CREDS CREDENTIAL CREDENTIALS COOKIE SESSION SID PRIVATE SIGN "
             "SIGNATURE MNEMONIC SEED OTP TOTP BEARER JWT WEBHOOK DSN").split()
    assert len(words) == 32
    for w in words:
        for name in (f"A_{w}_B", f"{w.lower()}", f"my{w.capitalize()}", f"X-{w}"):
            assert secret_name(name), name
            # a value 4 or more characters that is not all lower-case letters
            assert _hidden(name, "Pl4in") == ["Pl4in"], name
            # a mode word of the one list is kept ("plain" is one)...
            assert _hidden(name, "plain") == [], name
            # ...and a word of lower-case letters that is not one is hidden
            assert _hidden(name, "swordfish") == ["swordfish"], name
            # and 1 to 3 characters never
            assert _hidden(name, "P4x") == [], name


@pytest.mark.parametrize("name,value", GLUED)
def test_a_secret_word_glued_plural_or_numbered_makes_its_name_secret_worded(name, value):
    """Under each of these names a value that does not look like a key is
    hidden wherever the adapter says it, however the name is written and
    whatever stands beside it; a mode word of the one list is kept there,
    and 1 to 3 characters never hidden."""
    from lse_terminal.engine.broker_hub import secret_name
    one = name[0] + name[1:].lower()            # "Apisecret": one part
    for n in (name, name.lower(), one, f"MY_{name}", f"{name}_FILE", f"x-{name.lower()}",
              f"my{one}", f"A.{name}.B"):
        assert secret_name(n), n
        assert _hidden(n, value) == [value], (n, value)
        assert _hidden(n, "login") == [] and _hidden(n, "x9z") == [], n
    # as a URL's query key: its value is judged as under an env name
    url = "https://feed.example/v1?" + urllib.parse.urlencode({name.lower(): value, "mode": "practice"})
    got = _hidden("FEED_URL", url)
    assert value in got and "practice" not in got, (url, got)


@pytest.mark.parametrize("name,value", PLAIN_NAMES)
def test_a_name_that_holds_a_secret_words_letters_stays_plain(name, value):
    from lse_terminal.engine.broker_hub import secret_name
    one = name[0] + name[1:].lower()
    for n in (name, name.lower(), one, f"MY_{name}", f"{name}S", f"{name}2", f"my{one}"):
        assert not secret_name(n), n
        assert _hidden(n, value) == [], (n, value)
    url = "https://feed.example/v1?" + urllib.parse.urlencode({name.lower(): value})
    assert _hidden("FEED_URL", url) == [], url


def test_glued_query_keys_hide_their_values_and_plain_ones_keep_theirs():
    assert set(_hidden("FEED_URL", GLUED_URL)) == {"gooseberry", "nightjar", "fennelseed"}


def test_the_sign_in_modes_are_kept_and_a_venues_own_words_with_them():
    """The Terminal itself sets MERIDIAN_AUTH=login for its own simulated
    venue, and its adapter reads register or login. Carried by a profile of
    the user's own, the mode word is kept, so the words that adapter says
    stay whole (with "login" taken out they would read "the [hidden]
    expired", "[hidden]ing afresh")."""
    from lse_terminal.engine.broker_hub import BrokerHub
    hub = BrokerHub.__new__(BrokerHub)
    said = ("Meridian no longer accepts the stored login; log in again (auth.begin); "
            "credential file unreadable; registering afresh; there is no interactive "
            "login; MERIDIAN_AUTH=login")
    for word in ("login", "register", "signin", "signup", "sso", "oidc", "saml", "device",
                 "interactive", "refresh"):
        for name in ("MERIDIAN_AUTH", "AUTH_MODE", "SESSION_KIND", "TOKEN_FLOW"):
            got = _hidden(name, word)
            assert got == [], (name, word, got)
            assert BrokerHub._redact(hub, "x", said, secrets=got) == said
    # a mode word as written only: what is more to it is hidden as before
    assert _hidden("MERIDIAN_AUTH", "Login") == ["Login"]


def test_every_env_value_the_terminal_gives_its_own_venues_is_kept(tmp_path):
    """Each env the Terminal itself gives a simulated venue's adapter, made by
    its own code (directory_brokers over a directory row for every
    SIM_ADAPTERS entry, at a public host by name, with TLS and without, at
    localhost and at an IP, with and without the feed port a row may carry),
    is kept when a profile of the user's own carries it: none of it is a
    secret. An address by name is not hidden by its look."""
    from lse_terminal.engine.broker_hub import BrokerHub, directory_brokers, env_hidden
    base = tmp_path / "kit" / "brueconnect"
    for spec in SIM_ADAPTERS.values():
        f = base.joinpath(*spec["path"])
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("")
    seen = {}
    for ep in ENDPOINTS:
        for extra in ({}, {"ws_port": ep["port"] + 1}):
            rows_ = [{"key": k, "label": k, "endpoint": ep, "extra": extra} for k in SIM_ADAPTERS]
            got = directory_brokers(base, {"brokers": rows_})
            assert set(got) == set(SIM_ADAPTERS)
            for key, entry in got.items():
                env = entry["endpoint_env"]
                assert env, key
                for n, v in env.items():
                    seen.setdefault(n, set()).add(v)
                    assert env_hidden(n, v) == [], (key, n, v)
                assert BrokerHub._env_values(env) == [], (key, env)
    # every name each entry sets was seen, the sign-in mode among them
    assert set(seen) == {n for spec in SIM_ADAPTERS.values()
                         for n in spec["env"](OWN_EP, {"ws_port": 1})}
    assert seen["MERIDIAN_AUTH"] == {"login"}


def test_an_address_is_judged_as_it_is_in_a_url():
    """A host and a port and nothing else: the host is what a URL's host is,
    kept, as the same address in a URL always was. A value with anything
    more to it is still judged by its look."""
    for value in ("venues.londonstrategicedge.com:9101", "venues.example.net:443",
                  "localhost:7631", "127.0.0.1:9101", "a-b.c-d.example:65535"):
        assert _hidden("FEED_ADDR", value) == [], value
        assert _hidden("FEED_URL", "https://" + value) == [], value
    for value in ("venues.example.net:443/aGVsbG8gd29ybGQgc2VjcmV0",   # a path to it
                  "user:Tr0ub4dor@venues.example.net:443",               # a login in it
                  "venues.example.net:65536", "acct7Q2x9Lm4Zp:9101",     # no port, no host
                  "-bad.example.net:9101", "venues.example.n3t:9101"):
        assert _hidden("FEED_ADDR", value) == [value], value
    # under a secret-worded name rule (a) holds as before
    assert _hidden("TOKEN_ADDR", "venues.example.net:443") == ["venues.example.net:443"]


def test_a_listed_rows_own_env_is_kept_and_the_keys_typed_into_its_form_hidden(client, home):
    """Each listed row (EXAMPLES), linked by its key alone as the Connections
    screen links it, is given its example's name as env by the Terminal: its
    adapter's words keep it. The keys typed into the row's form are the
    secret: hidden wherever the adapter says them."""
    from lse_terminal.engine.broker_hub import BrokerHub
    hub = hub_of(client)
    base = home / "kit" / "brueconnect"
    for key, ex in EXAMPLES.items():
        write_adapter(base.joinpath(*ex["path"][:-1]), name=ex["path"][-1],
                      source=SAYS_KEYS % json.dumps([dict(f) for f in ex["form"]]))
    hub.adapter_base = base
    for key, ex in EXAMPLES.items():
        name = "listed-" + key
        r = link(client, name=name, example=key)
        assert r.status_code == 200, r.text
        env = registry_file(home)["brokers"][name]["env"]
        assert env == {EXAMPLE_ENV: key}
        assert BrokerHub._env_values(env) == []
        typed = {f["key"]: f"typed-{f['key']}-{i}417x" for i, f in enumerate(ex["form"])}
        r = client.post("/api/broker/credentials", headers=WIN_POST,
                        json={"broker": name, "values": typed, "merge": True})
        assert r.status_code == 200, r.text
        r = _connect(client, name, WIN_POST)
        assert r.status_code == 400, r.text
        detail = r.json()["detail"]
        want = (f"unauthorized: linked as the listed row {key}; keys: "
                + ", ".join("[hidden]" for _ in typed))
        assert detail == want, (detail, want)
        # (the card's record of a row whose terms keep its prices on this
        # computer is the sentence a program reads in place of the words)
        record = rows(client)[name]["last_error"]["message"]
        assert not [v for v in typed.values() if v in record], record


def test_a_value_that_looks_like_a_key_is_hidden_whatever_its_name():
    for value in ("acct7Q2x9Lm4Zp",                  # 14, letters and digits, no space
                  "aGVsbG8gd29ybGQgYmFzZTY0",        # 24 of base64
                  "CorrectHorseBatteryStaple",       # 25 letters: before any plain-word rule
                  "abcdefghijklmnopqrstu",           # 21 lower-case letters
                  "123456789012345678901234",        # 24 digits
                  "0f1e2d3c4b5a69788796a5b4c3d2e1f0"):
        assert _hidden("NOTE", value) == [value], value
        # and under a secret name the lower-case rule does not keep one
        assert value in _hidden("API_KEY", value), value
    for value in ("two words 12345678901", "short1", "1.08512", "2026-11-15",
                  "1794778253618", "EUR_USD", "-3.5", "1e6"):
        assert _hidden("NOTE", value) == [], value


def test_anything_else_is_kept():
    for value in ("practice", "EURUSD", "1000", "/home/u/x", "paper", "true", "-3.5", "1e6",
                  "~/keys", "C:\\Users\\u", "./state", "https://host.example/v3",
                  "https://api.example/v3/accounts", "two words", "short1"):
        assert _hidden("MODE", value) == [], value


def test_a_urls_userinfo_and_query_values_are_hidden_and_never_one_of_1_to_3():
    got = _hidden("FEED", "https://u1:pw9@feed.example/v1?k=q8r7&tier=gold&page=1")
    assert set(got) == {"u1:pw9", "q8r7"}, got
    got = _hidden("FEED", "https://u1:longpass@h.example/?token=abc&n=2&sig=a%2Fb")
    assert set(got) == {"u1:longpass", "longpass", "a%2Fb"}, got
    got = _hidden("FEED", "https://feed.example/v1?session=1&ping=20&mode=practice&size=1000")
    assert got == [], got
    got = _hidden("FEED", "https://feed.example/v1?token=Ab12&session=s3ss10n")
    assert set(got) == {"Ab12", "s3ss10n"}, got
    # under a key that holds a secret word, as for an env name: only a mode
    # word of the one list is kept (any other lower-case word there is hidden)
    got = _hidden("FEED", "https://feed.example/v1?token=opensesame&auth=basic"
                          "&session=practice&mode=swordfish&pass=hunter")
    assert set(got) == {"opensesame", "hunter"}, got


def test_the_terminals_own_entries_and_state_paths():
    from lse_terminal.engine.broker_hub import BrokerHub
    hidden = BrokerHub._env_values
    assert hidden({"BRUE_CONNECT_EXAMPLE": "0f1e2d3c4b5a69788796a5b4c3d2e1f0"}) == []
    assert hidden({"STATE_TOKEN": "{state}/t"}, state="/s") == ["{state}/t", "/s/t"]
    assert hidden({"DIR": "{state}/x"}, state="/home/u/brue/state/my-long-profile-name") == []


def test_a_stored_value_is_hidden_from_4_characters_and_never_shorter():
    from lse_terminal.engine.broker_hub import BrokerHub
    hub = BrokerHub.__new__(BrokerHub)
    words = "a1b, a1b2, paper and EURUSD at 1.08512; abc"
    assert BrokerHub._redact(hub, "x", words, secrets=["a1b"]) == words
    assert BrokerHub._redact(hub, "x", words, secrets=["a1b2", "paper"]) == (
        "a1b, [hidden], [hidden] and EURUSD at 1.08512; abc")
    assert BrokerHub._redact(hub, "x", words, secrets=["1", "08", "abc", " "]) == words


# ── through the routes, as the window and a program get the words ─────────

SAYS_ENV = '''
import os, sys
from brueconnect import Adapter, AdapterError

NAMES = [n for n in sys.argv[sys.argv.index("--quote") + 1].split(",") if n]
LEAD = %r
SAID = "; ".join([LEAD] + [n + "=" + os.environ.get(n, "") for n in NAMES])
REFUSE = "--refuse" in sys.argv
LOSE = "--lose" in sys.argv
print("starting: " + SAID, file=sys.stderr, flush=True)


def spec(symbol):
    return {"symbol": symbol, "name": symbol, "asset_class": "fx",
            "base_ccy": "EUR", "quote_ccy": "USD", "digits": 5,
            "tick_size": 0.00001, "lot_step": 1, "min_qty": 1, "max_qty": 1000000,
            "contract_size": 1, "margin_rate": 0.05,
            "sessions": [{"days": [1, 2, 3, 4, 5, 6, 7], "open": "00:00",
                          "close": "24:00", "tz": "UTC"}],
            "holidays": [], "tradable": True, "shortable": True,
            "fees": {"commission_per_lot": 0}, "swap_long": 0, "swap_short": 0}


class SaysEnv(Adapter):
    name, version, broker = "says-env", "0.1", "saying broker"

    def broker_info(self):
        return {"display_name": "Saying Broker"}

    def capabilities(self):
        return {"orders": {"market": True, "pending": True, "pending_types": ["limit"],
                           "expiry": ["gtc"], "can_list": True},
                "data": {"quotes": True, "bars": False, "history": False}}

    def on_first_call(self):
        if REFUSE:
            raise AdapterError("unauthorized", SAID)

    def handle_catalog_list(self, params):
        return {"instruments": [spec("EURUSD")]}

    def handle_account_get(self, params):
        self.emit("session.state", {"state": "degraded", "detail": "slow: " + SAID})
        return {"balance": 1000.0, "equity": 1000.0, "margin_used": 0.0,
                "margin_free": 1000.0, "currency": "USD"}

    def handle_positions_list(self, params):
        return {"positions": []}

    def handle_orders_list(self, params):
        return {"orders": []}

    def handle_order_place(self, params):
        cid = params["client_id"]
        if LOSE:
            raise AdapterError("internal", "not known yet: " + SAID, retryable=True)
        self.emit("order.accepted", {"client_id": cid, "order_id": "o1"})
        self.emit("order.rejected", {"client_id": cid, "order_id": "o1",
                                     "reason": "insufficient_margin: " + SAID})
        return {"order_id": "o1", "status": "accepted"}

SaysEnv().run()
''' % LEAD

# A listed row's stand-in adapter: its form is the row's own, and its first
# call is refused naming the listed row it was linked as (the env the
# Terminal gives it) and then each key typed into its form, in the form's
# order.
SAYS_KEYS = '''
import os
from brueconnect import Adapter, AdapterError

FORM = %s


class SaysKeys(Adapter):
    name, version, broker = "says-keys", "0.1", "listed stand-in"
    credential_form = FORM

    def on_first_call(self):
        keys = [os.environ.get("BRUE_CRED_" + f["key"].upper().replace("-", "_"), "")
                for f in FORM]
        raise AdapterError("unauthorized", "linked as the listed row "
                           + os.environ.get("BRUE_CONNECT_EXAMPLE", "") + "; keys: " + ", ".join(keys))

    def handle_catalog_list(self, params):
        return {"instruments": []}

SaysKeys().run()
'''


def _as_said(cases):
    """(name, value, how the words say it) of (name, value, hidden): whole,
    or as one mark."""
    return [(n, v, "[hidden]" if h else v) for n, v, h in cases]


GARBLE = "needs 5000.50 at 1.08512; stop out at 5000"

# The env of each profile the routes are driven with, one value a name, each
# entry (name, value, how the adapter's words say it); beside it what must
# never be shown anywhere in them.
ROUTE_SETS = {
    # the classifier table and the cases beside it (MY_TOKEN once, as tok-abc)
    "table": (
        _as_said([c for c in TABLE if c[1].strip()] + MORE[1:-1] + [("API_TOKEN", "abc", False)])
        + [("NOTIFY_URL", NOTIFY, NOTIFY_SAID), ("MY_TOKEN", "tok-abc", "[hidden]")],
        [v for _, v, h in TABLE + MORE if h] + ["c2VjcmV0LXBhdGgtcGFydC0wMDAx"]),
    # the secrets of lower-case letters, the secrets under LOGIN_PW and
    # WEBHOOK_URL, and the prices, settings and mode word that are kept
    "secrets": (
        _as_said(WORDLIKE + THE_REST[:2] + IS_KEPT),
        [v for _, v, _ in WORDLIKE + THE_REST[:2]] + ["aGVsbG8gd29ybGQgc2VjcmV0"]),
    # settings under secret-worded names, hidden by this rule wherever they
    # are said (a price beside one keeps its own digits), and a passphrase of
    # 25 letters
    "settings": (
        _as_said(CONFIGS + THE_REST[2:])
        + [("NOTE", GARBLE, "needs [hidden].50 at 1.08512; stop out at [hidden]")],
        ["correcthorsebatterystaple"]),
    # what the Terminal itself gives its own simulated venues' adapters, at a
    # public host by name, carried by a profile of the user's own: every value
    # said whole, the sign-in mode and the words around it included
    "own-venues": ([(n, v, v) for n, v in OWN_ENV.items()], []),
    # secret words glued to another word, plural or numbered, as env names
    # and as query keys, hidden; the names that only hold a secret word's
    # letters keep their values
    "glued-names": (
        _as_said([(n, v, True) for n, v in GLUED] + [(n, v, False) for n, v in PLAIN_NAMES])
        + [("FEED_URL", GLUED_URL, GLUED_URL_SAID)],
        [v for _, v in GLUED] + ["gooseberry", "nightjar", "fennelseed"]),
}
SETS = pytest.mark.parametrize("cases,secrets", list(ROUTE_SETS.values()), ids=list(ROUTE_SETS))


def _env(cases):
    return {n: v for n, v, _ in cases}


def _said(cases):
    """The adapter's words as the rule gives them."""
    return "; ".join([LEAD] + [f"{n}={said}" for n, _, said in cases])


def _link_says(client, home, name, cases, *extra):
    env = _env(cases)
    assert len(env) == len(cases), "one value a name"
    path = write_adapter(home / name, name="says_env.py", source=SAYS_ENV)
    r = link(client, name, python_file=path, args=["--quote", ",".join(env), *extra], env=env)
    return r, env


def _no_secret(text, secrets):
    return [s for s in secrets if s in text]


@SETS
def test_a_refusal_and_its_record_say_the_settings_and_hide_the_secrets(client, home, cases, secrets):
    """Each set of cases (settings named like secrets, secrets under
    secret-worded names, secrets of lower-case letters), as one refusal: the
    window's answer, a program's and the card's record are the adapter's
    sentence with the secrets out, "1.08512" whole and every setting as the
    rule gives it."""
    r, env = _link_says(client, home, "says-refuse", cases, "--refuse")
    assert r.status_code == 200, r.text
    want = "unauthorized: " + _said(cases)
    got = {}
    for who, headers in (("window", WIN_POST), ("program", {})):
        r = _connect(client, "says-refuse", headers)
        assert r.status_code == 400, r.text
        got[who] = r.json()["detail"]
    got["record"] = rows(client)["says-refuse"]["last_error"]["message"]
    assert got == {"window": want, "program": want, "record": want}, json.dumps(got, indent=1)
    assert "1.08512" in want and "[hidden].085" not in want
    assert not _no_secret(json.dumps(got), secrets)


@SETS
def test_every_other_kind_of_words_keeps_a_setting_and_hides_a_secret(client, home, cases, secrets):
    """The printed line, the session's detail and a rejected order's reason,
    to the window (and the row's printed lines to a program too)."""
    r, env = _link_says(client, home, "says", cases)
    assert r.status_code == 200, r.text
    assert _connect(client, "says", WIN_POST).status_code == 200
    assert client.get("/api/broker/account?broker=says", headers=WIN_GET).status_code == 200
    o = client.post("/api/broker/order", headers=WIN_POST, json={
        "broker": "says", "symbol": "EURUSD", "side": "buy", "qty": 1})
    assert o.status_code == 200, o.text
    said = _said(cases)
    assert o.json()["reason"] == "insufficient_margin: " + said, o.json()
    import time
    deadline = time.time() + 5
    while time.time() < deadline and "session" not in rows(client)["says"]:
        time.sleep(0.1)
    row = rows(client)["says"]
    assert row["session"] == {"state": "degraded", "detail": "slow: " + said}, row["session"]
    for headers in (WIN_GET, {}):
        listed = {b["broker"]: b for b in client.get("/api/broker/list", headers=headers).json()}
        assert "starting: " + said in listed["says"]["printed"], headers
        assert not _no_secret(json.dumps(listed["says"]), secrets), headers
    # the held record keeps the rejected order's words as the window got them
    [entry] = client.get("/api/broker/held", headers=WIN_GET).json()["held"]
    assert (entry["state"], entry["detail"]) == ("answered", "insufficient_margin: " + said)
    assert not _no_secret(json.dumps(o.json()), secrets)


@SETS
def test_the_held_record_of_a_lost_answer_hides_the_secrets_on_disk_too(client, home, cases, secrets):
    r, env = _link_says(client, home, "says-lost", cases, "--lose")
    assert r.status_code == 200, r.text
    assert _connect(client, "says-lost", WIN_POST).status_code == 200
    body = {"broker": "says-lost", "symbol": "EURUSD", "side": "buy", "qty": 1,
            "client_id": "lset-lost-words-1"}
    r = client.post("/api/broker/order", headers=WIN_POST, json=body)
    assert r.status_code == 400 and r.json()["unknown"] is True, r.text
    want = "internal: not known yet: " + _said(cases)
    assert r.json()["detail"] == want
    [entry] = client.get("/api/broker/held", headers=WIN_GET).json()["held"]
    assert (entry["state"], entry["detail"]) == ("unknown", want)
    raw = (Path(os.environ["LSE_TERMINAL_CONFIG_DIR"]) / "held_requests.json").read_text()
    assert not _no_secret(raw, secrets), raw
    assert json.loads(raw)["held"][0]["detail"] == want


def test_a_stored_key_in_a_rejected_reason_is_hidden_in_the_held_record(client, home):
    """A window order rejected with a reason that quotes the stored key; the
    answer and the record both carry [hidden], and nothing of it is on
    disk."""
    path = write_adapter(home / "quoter", name="quoter.py", source=QUOTER)
    assert link(client, "quoter", python_file=path).status_code == 200
    _store(client, "quoter", SECRET)
    assert _connect(client, "quoter", WIN_POST).status_code == 200
    o = client.post("/api/broker/order", headers=WIN_POST, json={
        "broker": "quoter", "symbol": "F", "side": "buy", "qty": 1})
    h = client.get("/api/broker/held", headers=WIN_GET)
    assert SECRET not in o.text + h.text
    [entry] = [e for e in h.json()["held"] if e["state"] == "answered"]
    assert entry["detail"] == "refused for the key [hidden]", entry
    cfg = Path(os.environ["LSE_TERMINAL_CONFIG_DIR"])
    assert not any(SECRET in p.read_text() for p in cfg.glob("held*.json"))


# (a stored credential is hidden whatever it is from 4 characters: the list
# of mode words is for an env value under a secret-worded name only)
@pytest.mark.parametrize("value,said", [("a1b", "a1b"), ("a1b2", "[hidden]"),
                                        ("paper", "[hidden]"), ("Z", "Z"),
                                        ("swordfish", "[hidden]"), ("hunter", "[hidden]"),
                                        ("password", "[hidden]")])
def test_a_stored_credential_through_a_refusal(client, home, value, said):
    path = write_adapter(home / "echo", name="echo.py", source=ECHO)
    assert link(client, "echo", python_file=path).status_code == 200
    _store(client, "echo", value)
    r = _connect(client, "echo", WIN_POST)
    assert r.status_code == 400, r.text
    assert r.json()["detail"].endswith(f"The key it was sent: {said}."), r.json()
