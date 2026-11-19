"""Comments and docstrings a visitor reads in the terminal's Python and in
its tests name no broker: a broker's name belongs on its own row and in its
own adapter.

What is read is every comment line and every docstring line, continuation
lines included, in every Python file of lse_terminal (the engine, the
backtests, the contracts, the indicators, the ML scripts, the providers) and
of tests, tests/data included: a string standing alone as a statement is read
as one too, and an f-string standing alone the same (its literal text a
visitor reads alike), in any branch (an else or a finally as well as a body).
A listed row's own entry in EXAMPLES may name its own broker, and so may
identifiers, strings in code, test data and an adapter's own files, which are
not read here. The page and its stylesheet are held by the page's own tests.

The names are the brokers the terminal lists and others a visitor would read
as a broker. A name joined to a word by an underscore is read: the boundary
is a letter or a digit, not an underscore. The one two letters long is read
in capitals only, as a whole word: in lower case it is part of other words.
The kit's own simulated venues (Northgate, Helix, Quantex) are not brokers
and stay.
"""
import ast
import io
import re
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The brokers a visitor would read as named: those the terminal lists and
# others like them. The boundary is a letter or a digit, not an underscore: a
# name joined to a word by an underscore is read. The kit's own simulated
# venues (Northgate, Helix, Quantex) are not brokers and stay.
NAMES = re.compile(
    r"(?<![A-Za-z0-9])(alpaca|oanda|capital\.?com|capitalcom|interactive\s+brokers|ibkr|"
    r"saxo|fxcm|pepperstone|ic\s*markets|ig\s+(?:markets|group|index)|etoro|ctrader|"
    r"tradestation|ninjatrader|tastytrade|tastyworks|schwab|ameritrade|e\*?trade|tradier|"
    r"robinhood|webull|moomoo|coinbase|binance|kraken|dukascopy|plus500|xtb|avatrade|"
    r"fxpro|tickmill|exness|swissquote|degiro|lmax|forex\.com|metatrader|fxtrade|"
    r"fxpractice|admirals|vantage|ftmo|zerodha|kucoin|bitget|trade\s*republic|"
    r"match\s*trader)(?![A-Za-z0-9])",
    re.I)
BARE_IG = re.compile(r"(?<![A-Za-z0-9])IG(?![A-Za-z0-9])")
# Every list of statements a node can hold: a string alone in any of them is
# read as a docstring line.
_BRANCHES = ("body", "orelse", "finalbody")


def _named(text: str) -> set:
    return ({m.group(0).lower() for m in NAMES.finditer(text)}
            | {"ig" for _ in BARE_IG.finditer(text)})


def _shared_files():
    """Every Python file of the terminal outside the page (lse_terminal/ui,
    which the page's own tests hold), and of its tests, tests/data included."""
    pkg = ROOT / "lse_terminal"
    out = sorted(p for p in pkg.rglob("*.py") if p.relative_to(pkg).parts[0] != "ui")
    out += sorted((ROOT / "tests").rglob("*.py"))
    return out


def _read_lines(path: Path):
    """(line number, kind, text) of each comment line and docstring line."""
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines()
    found = []
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.COMMENT:
            found.append((tok.start[0], "comment", tok.string))
    for node in ast.walk(ast.parse(src)):
        for field in _BRANCHES:
            stmts = getattr(node, field, None)
            if not isinstance(stmts, list):
                continue
            for stmt in stmts:
                if isinstance(stmt, ast.Expr) and _is_string_expr(stmt.value):
                    for n in range(stmt.lineno, stmt.end_lineno + 1):
                        found.append((n, "docstring", lines[n - 1]))
    return found


def _is_string_expr(value) -> bool:
    """A string standing alone as a statement: a plain string, or an f-string
    (ast.JoinedStr), whose literal text a visitor reads the same way."""
    if isinstance(value, ast.Constant):
        return isinstance(value.value, str)
    return isinstance(value, ast.JoinedStr)


def _own_entries(path: Path) -> dict:
    """For the hub: each line of a listed row's own EXAMPLES entry, and the
    names that row may use there (its key and its `name`)."""
    allowed = {}
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)
                and any(isinstance(t, ast.Name) and t.id == "EXAMPLES" for t in node.targets)):
            continue
        for key, value in zip(node.value.keys, node.value.values):
            if not (isinstance(key, ast.Constant) and isinstance(value, ast.Dict)):
                continue
            names = {str(key.value).lower()}
            for k, v in zip(value.keys, value.values):
                if (isinstance(k, ast.Constant) and k.value == "name"
                        and isinstance(v, ast.Constant)):
                    names.add(str(v.value).lower())
            for n in range(key.lineno, value.end_lineno + 1):
                allowed[n] = names
    return allowed


def test_no_comment_or_docstring_in_the_engine_or_its_tests_names_a_broker():
    hits = []
    for path in _shared_files():
        rel = path.relative_to(ROOT).as_posix()
        own = _own_entries(path) if rel == "lse_terminal/engine/broker_hub.py" else {}
        for n, kind, text in _read_lines(path):
            named = _named(text)
            if not named:
                continue
            if n in own and all(any(w in name or name in w for name in own[n]) for w in named):
                continue
            hits.append(f"{rel}:{n}: {kind}: {text.strip()[:120]}")
    assert not hits, "\n".join(hits)


def test_the_reader_finds_what_it_is_meant_to(tmp_path):
    """The reader itself, on a sample: a comment, a docstring's continuation
    line, a string standing alone and an f-string standing alone are read, in
    a body, an else, a finally and an except; an identifier and a string in
    code are not; a name joined to a word by an underscore is read; the
    two-letter name is read in capitals only."""
    sample = tmp_path / "sample.py"
    sample.write_text('x = "Saxo"  # plain words\n'
                      'def f():\n'
                      '    """First line,\n'
                      '    and a continuation naming Kraken."""\n'
                      '    saxo_bank = 1\n'
                      '    "a string alone, naming FXCM"\n'
                      '    return saxo_bank  # then Binance\n'
                      'if x:\n'
                      '    pass\n'
                      'else:\n'
                      '    "a string alone in an else, naming OANDA"\n'
                      'try:\n'
                      '    pass\n'
                      'except OSError:\n'
                      '    "one in an except, naming Alpaca"\n'
                      'finally:\n'
                      '    "one in a finally, naming Capital.com"\n'
                      'big = "IG"  # an IG demo; a config, a sig and big words are not\n'
                      'for _ in ():\n'
                      '    pass\n'
                      'else:\n'
                      '    "a for loop\'s else, naming eToro"\n'
                      'baz = 2\n'
                      'f"an f-string alone, naming Pepperstone"\n'
                      '# a comment reading oanda_adapter in it\n', encoding="utf-8")
    got = sorted((n, kind) for n, kind, text in _read_lines(sample) if _named(text))
    assert got == [(4, "docstring"), (6, "docstring"), (7, "comment"), (11, "docstring"),
                   (15, "docstring"), (17, "docstring"), (18, "comment"), (22, "docstring"),
                   (24, "docstring"), (25, "comment")]
    assert not _named("an ig in lower case, a config, a signal, BIG and IGNORE")
    # a name joined to a word by an underscore (or a hyphen) is read
    assert _named("oanda_adapter") == {"oanda"} and _named("my-oanda-thing") == {"oanda"}
    assert _named("IG_MARKETS note") == {"ig"} and not _named("TRIGGER and CONFIGURE")


def test_the_files_read_are_the_whole_of_the_terminals_python():
    rel = {p.relative_to(ROOT).as_posix() for p in _shared_files()}
    for want in ("lse_terminal/engine/server.py", "lse_terminal/cli.py",
                 "tests/data/terms_adapter.py", "tests/test_held_requests.py"):
        assert want in rel, want
    for folder in ("backtest", "contracts", "indicators", "ml", "providers"):
        assert any(r.startswith(f"lse_terminal/{folder}/") for r in rel), folder
    assert not any(r.startswith("lse_terminal/ui/") for r in rel)
