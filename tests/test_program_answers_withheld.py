"""A program on a data_local_only connection gets the sentence, never the
adapter's own words, on every route that answers them (SPEC 3.3).

Pinned here, beside test_broker_terms.py's routes:
  - the read routes (positions, orders, fills) that relay a failure in the
    broker's own words (server._broker_call; with _hub_call in its place a
    program would get them);
  - a program's own link answer, and its refused link, for a listed row and
    for an adapter of its own whose hello declares the terms;
  - lines kept from a run that was held stay held when a later run of the
    same profile declares no terms.

The brokers are the kit's paper engine (tests/data/terms_adapter.py); nothing
here reaches the network.
"""
import json
import sys

from test_broker_terms import (  # noqa: F401 - fixtures
    FIXTURE, LICENCE, WIN_GET, WIN_POST, _rows, add_profile, client, connect, home,
    listed, wait_for)

PROGRAM_JSON = {"Content-Type": "application/json"}    # a program: no browser headers
WIN_JSON = {**WIN_POST, "Content-Type": "application/json"}
TERMS = "Fixture Markets' terms: " + LICENCE["summary"]
WORDS = "The broker's own words withheld under " + TERMS
REASON = "The broker's reason withheld under " + TERMS


def test_a_programs_failed_reads_of_positions_orders_and_fills_carry_the_sentence(
        client, tmp_path):
    """Each read route relays the broker's reason when the read fails; on a
    data_local_only connection a program gets its code and the sentence."""
    flag = tmp_path / "fail"
    for b, terms in (("local", LICENCE), ("plain", None)):
        add_profile(b, terms=terms, extra=("--resting", "--fail-reads", str(flag)))
        connect(client, b)
    flag.write_text("x")
    for route in ("positions", "orders", "fills"):
        r = client.get(f"/api/broker/{route}?broker=local")
        assert r.status_code == 400, (route, r.text)
        assert r.json()["detail"] == "x_fixture_read: " + REASON, (route, r.json())
        assert "EURUSD" not in r.text, route
        # the window keeps the broker's reason
        r = client.get(f"/api/broker/{route}?broker=local", headers=WIN_GET)
        assert r.status_code == 400 and "while EURUSD was 1." in r.json()["detail"], route
        # and a connection without terms answers a program as before
        r = client.get(f"/api/broker/{route}?broker=plain")
        assert r.status_code == 400 and "while EURUSD was 1." in r.json()["detail"], route
    flag.unlink()
    assert client.get("/api/broker/orders?broker=local").json() == []


def test_a_programs_own_link_of_a_listed_row_carries_none_of_its_printed_lines(
        client, listed):
    """POST /api/broker/link is open to a program (it sends no browser
    headers). Its answer is the row as that program may have it: the
    sentence where the test spawn's printed lines were. The window's link
    answer shows them."""
    listed["args"] = ("--mode", "live", "--say-start", "--say-bye")
    r = client.post("/api/broker/link", json={"name": "my-fixture", "example": "fixture"},
                    headers=PROGRAM_JSON)
    assert r.status_code == 200, r.text
    assert r.json()["printed"] == WORDS, r.json().get("printed")
    assert "EURUSD" not in r.text
    r = client.post("/api/broker/link", json={"name": "my-window", "example": "fixture"},
                    headers=WIN_JSON)
    assert r.status_code == 200, r.text
    assert "starting; EURUSD bid" in r.json()["printed"]


def test_a_programs_own_link_of_its_declaring_adapter_carries_none_of_its_printed_lines(
        client, tmp_path):
    own = tmp_path / "own_adapter.py"
    own.write_text(FIXTURE.read_text())
    r = client.post("/api/broker/link", headers=PROGRAM_JSON, json={
        "name": "own-local", "python_file": str(own),
        "args": ["--terms", json.dumps(LICENCE), "--say-bye"]})
    assert r.status_code == 200, r.text
    assert r.json()["printed"] == WORDS, r.json().get("printed")
    assert "EURUSD" not in r.text


def test_a_programs_refused_link_of_a_listed_row_carries_the_sentence(
        client, listed, tmp_path, monkeypatch):
    """A link refused answers the adapter's own words (what it printed, the
    reason it gave) to whoever linked; for a program linking a row whose
    terms keep its prices on this computer, the sentence in their place.
    The window gets them whole."""
    from lse_terminal.engine import broker_hub
    adapter = {"file": None}
    real = broker_hub.BrokerHub._example_path
    monkeypatch.setattr(broker_hub.BrokerHub, "_example_path",
                        lambda self, key: adapter["file"] if key == "fixture" else real(self, key))
    listed["args"] = ()
    # one that prints a quote and ends before its hello
    stops = tmp_path / "stops.py"
    stops.write_text("import sys\nprint('starting; EURUSD bid 1.08512 ask 1.08526', "
                     "file=sys.stderr)\nsys.exit(3)\n")
    adapter["file"] = stops
    body = {"name": "my-fixture", "example": "fixture"}
    r = client.post("/api/broker/link", json=body, headers=PROGRAM_JSON)
    assert r.status_code == 400, r.text
    assert r.json() == {"detail": "The file stopped before it answered the terminal. "
                                  "The last lines it printed are below.", "stderr": WORDS}
    r = client.post("/api/broker/link", json=body, headers=WIN_JSON)
    assert r.status_code == 400 and r.json()["stderr"] == "starting; EURUSD bid 1.08512 ask 1.08526"
    # one that refuses its hello in words that quote the price
    refuses = tmp_path / "refuses.py"
    refuses.write_text(
        "import sys, os\n"
        "sys.path.insert(0, os.environ['BRUE_CONNECT_SDK'])\n"
        "from brueconnect import Adapter, protocol\n"
        "class R(Adapter):\n"
        "    name, version, broker = 'r', '0.1', 'refusing'\n"
        "    def _dispatch(self, rid, method, params):\n"
        "        if method == 'hello':\n"
        "            self._send(protocol.res_error(rid, 'unauthorized', "
        "'refused while EURUSD was 1.08512'))\n"
        "            return\n"
        "        return super()._dispatch(rid, method, params)\n"
        "R().run()\n")
    adapter["file"] = refuses
    r = client.post("/api/broker/link", json=body, headers=PROGRAM_JSON)
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "The adapter refused the handshake: unauthorized: " + WORDS
    assert "EURUSD" not in r.text
    r = client.post("/api/broker/link", json=body, headers=WIN_JSON)
    assert r.json()["detail"] == ("The adapter refused the handshake: unauthorized: "
                                  "refused while EURUSD was 1.08512"), r.json()
    assert "my-fixture" not in _rows(client, WIN_GET)


def test_lines_printed_under_the_terms_stay_held_when_the_next_run_declares_none(
        client, tmp_path):
    """An adapter of the user's own whose first run declares data_local_only
    and whose next run declares no terms (its author edited it, or its terms
    follow the account it is bound to). The first run's lines stay held from
    a program, the sentence in their place; the next run's own lines, under
    no terms, reach it; the window keeps them all."""
    terms_file = tmp_path / "terms.json"
    terms_file.write_text(json.dumps(LICENCE))
    own = tmp_path / "switching_adapter.py"
    src = FIXTURE.read_text()
    # the fixture, reading its --terms from a file as it starts, and saying
    # in each line whether it runs under terms
    swaps = (("self._terms = json.loads(args.terms) if args.terms else None",
              "self._terms = (json.loads(open(args.terms).read() or 'null')"
              " if args.terms else None)"),
             ('print(f"terms fixture ({self._display}): {what}; EURUSD bid {bid} ask {ask}",',
              'print(f"terms fixture ({self._display}, '
              '{\'held run\' if self._terms else \'open run\'}): {what}; '
              'EURUSD bid {bid} ask {ask}",'))
    for old, new in swaps:
        assert src.count(old) == 1, old
        src = src.replace(old, new)
    own.write_text(src)
    from brueconnect import registry
    registry.add("own", argv=[sys.executable, str(own), "--mode", "paper", "--terms",
                              str(terms_file), "--say-account", "--say-bye"],
                 description="own")
    connect(client, "own")
    assert client.get("/api/broker/account?broker=own", headers=WIN_GET).status_code == 200
    assert wait_for(lambda: "held run): account read; EURUSD bid" in (
        _rows(client, WIN_GET)["own"].get("printed") or ""))
    assert _rows(client)["own"]["printed"] == WORDS
    client.post("/api/broker/disconnect", json={"broker": "own"}, headers=WIN_POST)
    terms_file.write_text("")                     # the next run declares no terms
    connect(client, "own")
    assert client.get("/api/broker/account?broker=own", headers=WIN_GET).status_code == 200
    assert wait_for(lambda: "open run): account read" in (
        _rows(client, WIN_GET)["own"].get("printed") or ""))
    row = _rows(client)["own"]
    assert row["terms"]["data_local_only"] is False
    printed = row["printed"]
    assert "held run" not in printed, printed     # none of the held run's lines
    assert WORDS in printed, printed              # the sentence in their place
    assert "open run): account read; EURUSD bid" in printed, printed
    # the window has every line, the held run's first
    win = _rows(client, WIN_GET)["own"]["printed"]
    assert win.index("held run): account read") < win.index("open run): account read")
