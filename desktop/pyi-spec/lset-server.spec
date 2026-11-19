# -*- mode: python ; coding: utf-8 -*-
# Cross-platform sidecar spec: every path is SPECPATH-relative rather
# than a machine-specific absolute path, so the same file builds the
# sidecar on macOS, Linux and Windows.
import os
import sys
import importlib.util
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import collect_all

IS_WIN = sys.platform == "win32"
# SPECPATH (injected by PyInstaller) = <repo>/desktop/pyi-spec
ROOT = os.path.dirname(os.path.dirname(SPECPATH))

# brueconnect ships as REAL FILES, not only PYZ modules: the engine
# imports it from _internal, and broker adapters are spawned as .py
# subprocesses so they must exist on disk. The datas copy MUST come from
# the same install the analysis bakes into the PYZ (the classic
# frozen-build trap: a stale venv copy silently wins over shipped datas),
# so resolve the installed package instead of a hand-copied tree.
_pc = importlib.util.find_spec("brueconnect")
if _pc is None or not _pc.submodule_search_locations:
    raise SystemExit(
        "brueconnect is not installed in the build venv. Install the "
        "sibling clone first (pip install -e ../brue): the frozen "
        "app both bakes it into the PYZ and ships it as real files, and the "
        "two copies must come from the same install.")
BRUECONNECT_DIR = list(_pc.submodule_search_locations)[0]
# The starter adapter that Connections offers ("+ Add your own broker", then
# "Download the starter adapter") is a file of the kit. A kit without it
# builds an app whose card says "Update the terminal" where the
# walkthrough's first step says to download it, so it is refused here.
if not os.path.isfile(os.path.join(BRUECONNECT_DIR, "templates",
                                   "my_broker_adapter.py")):
    raise SystemExit(
        "The brueconnect in the build venv (%s) has no "
        "templates/my_broker_adapter.py, the starter adapter the "
        "Connections screen offers. Install Brue 0.0.2 or newer "
        "(pip install -e ../brue) before building." % BRUECONNECT_DIR)

datas = [(os.path.join(ROOT, "lse_terminal", "ui", "static"), "lse_terminal/ui/static"),
         # The bundled sample datasets. Without this line the samples
         # directory never enters the frozen build: seed_samples() finds no
         # files, skips in silence, and a fresh install opens with an empty
         # library. That was true of every build before this line, the two
         # old 30m samples included, so 'the download comes with data' has
         # never actually been true on the desktop channel until now.
         (os.path.join(ROOT, "lse_terminal", "samples"), "lse_terminal/samples"),
         # The ML model scripts. blueprint.train() runs them as FILES in a
         # subprocess (--run-script <path>), resolved from
         # Path(blueprint.__file__).parent / "scripts"; the PYZ copy that
         # collect_submodules bakes in is invisible to that path. Without
         # this line every desktop training run dies on the first step
         # ("can't find '__main__' module in ...autoencoder_anomaly.py":
         # PyInstaller's path hook claims any path under _internal, so a
         # missing file reads as a runpy error, not a FileNotFoundError).
         (os.path.join(ROOT, "lse_terminal", "ml", "scripts"), "lse_terminal/ml/scripts"),
         # The 12 bundled .brue chart indicators: brue_indicators.py globs
         # them from indicators/brue at startup, silently registering none
         # when the folder is absent, which is what every desktop build did
         # until this line (found in the same sweep of package-relative
         # disk reads that turned up the ML scripts).
         (os.path.join(ROOT, "lse_terminal", "indicators", "brue"), "lse_terminal/indicators/brue"),
         (BRUECONNECT_DIR, "brueconnect"),
         # The same package again, in a directory that holds NOTHING else.
         # Adapters run under the user's own Python, and broker_hub.sdk_dir
         # puts this directory on their import path instead of _internal:
         # _internal also holds this app's numpy, pandas and (on Windows) the
         # bundled Python's extension modules, which can shadow another
         # interpreter's own. Bundled adapters are spawned from this copy
         # too, because each inserts its own grandparent directory on
         # sys.path and that must not be _internal either.
         (BRUECONNECT_DIR, "brue-sdk/brueconnect")]
binaries = []
hiddenimports = ['multipart', 'python_multipart', 'uvicorn.logging']
hiddenimports += collect_submodules('lse_terminal')
# The brue language package, whole. Static analysis reaches only what
# lse_terminal imports at module level (api, runtime, parser, ...); the
# bridge behind the bundled .brue chart indicators imports
# brue.pandas_api INSIDE a function, so without this the frozen build
# lacks it and all 12 shipped indicators fail registration with
# ModuleNotFoundError.
hiddenimports += collect_submodules('brue')
# The WHOLE standard library, not only what our own code imports. The
# optional ML libraries are installed by the user at runtime into
# python-packages and were never analysed here, so any stdlib module they
# import that lse_terminal does not is simply absent from the bundle:
# scikit-learn's ensemble module needs `timeit`, so Random Forest and the
# GPU probe fail with ModuleNotFoundError. Every importable stdlib module goes
# in, packages with their submodules; GUI/test/build-only trees are left
# out on purpose (tkinter, idlelib, turtle, test, lib2to3, ensurepip, venv).
#
# The POSIX-only names (pty, termios, fcntl, resource, readline, curses,
# grp, pwd, ...) are deliberately NOT skipped, though this list was first
# written from the Windows spec where they were. Skipping them is a no-op on
# Windows, where they are not importable and the loop's own except-continue
# drops them anyway; on macOS and Linux they are real modules, so listing
# them here EXCLUDED them from exactly the sweep that exists to cover what
# runtime-installed libraries reach for (fsspec imports resource, click
# imports termios, rich imports pty, filelock imports fcntl). Only names
# that are dead or platform-foreign everywhere stay below.
_STDLIB_SKIP = {
    "antigravity", "this", "idlelib", "tkinter", "_tkinter", "turtle",
    "turtledemo", "test", "lib2to3", "ensurepip", "venv", "pydoc_data",
    "__hello__", "__phello__", "msilib", "nis", "ossaudiodev", "spwd",
    "crypt", "xxlimited", "xxsubtype",
    "_xxsubinterpreters", "_xxtestfuzz", "xxlimited_35", "_aix_support",
}
_stdlib_added = 0
for _name in sorted(getattr(sys, "stdlib_module_names", ())):
    if _name in _STDLIB_SKIP or _name.startswith("_test") or _name.startswith("xx"):
        continue
    try:
        _mod = importlib.import_module(_name)
    except Exception:  # not on this platform / not importable here
        continue
    hiddenimports.append(_name)
    _stdlib_added += 1
    if getattr(_mod, "__path__", None):
        try:
            hiddenimports += collect_submodules(_name)
        except Exception:
            pass
print(f"lset-server.spec: {_stdlib_added} standard-library modules added as hidden imports")
hiddenimports += collect_submodules('uvicorn')
hiddenimports += collect_submodules('pyarrow')
hiddenimports += collect_submodules('openpyxl')
# pip is bundled so the frozen app can install the optional ML libraries
# it does not ship. cli.py intercepts `-m pip` and redirects it to a
# user-writable directory; without pip in here the ML tab's install
# button has nothing to run.
tmp_ret = collect_all('pip')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
if IS_WIN:
    # ConPTY backend for the AI panel's terminal view. Windows-only wheel;
    # POSIX (mac, linux) uses the stdlib pty module, which the analysis
    # already collects by following lse_terminal's own imports.
    tmp_ret = collect_all('winpty')
    datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    [os.path.join(ROOT, "desktop", "sidecar_entry.py")],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # torch is deliberately NOT shipped. Nothing in this codebase imports
    # it; it arrives only because scipy vendors an Array-API compat layer
    # whose torch backend (scipy/_lib/array_api_compat/torch/*) imports it
    # at module level, and PyInstaller's hook then collects the whole
    # 360 MB package, doubling the installer for 5 of the 20 catalog
    # models. Users who want those install it from the ML tab at runtime
    # (cli.py intercepts -m pip and targets the user packages dir).
    excludes=['torch'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='lset-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # upx is only applied where a upx binary is found; PyInstaller skips it
    # for Mach-O, so this stays true without harming the mac build.
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='lset-server',
)
