"""LSE Terminal: a free, open-source market research terminal by London Strategic Edge."""

__version__ = "0.1.10"


def __getattr__(name):
    # `from lse_terminal import indicator` is what the docs teach: the
    # .contracts path reads as jargon to non-programmers.
    # The decorator's real home stays lse_terminal.contracts; this and the
    # lse_terminal.indicators re-export are aliases of the same function.
    # Lazy (PEP 562) so `import lse_terminal` alone, e.g. a version check,
    # never drags pandas in.
    if name == "indicator":
        from lse_terminal.contracts.indicator import indicator as fn
        return fn
    raise AttributeError(f"module 'lse_terminal' has no attribute {name!r}")
