#!/usr/bin/env bash
# Build the macOS desktop app end to end: python venv, frozen PyInstaller
# sidecar, smoke test, then the Electron dmg. Run ON a Mac (Intel or Apple
# Silicon; the build is native to the machine's own arch), from anywhere:
# paths are script-relative. Prereqs once: Xcode Command Line Tools
# (xcode-select --install), python3 3.10+, node 20+.
#
# The brue SIBLING CLONE IS REQUIRED next to this repo:
#   <parent>/lse-terminal  <parent>/brue
# It holds the Brue language and Brue Connect, the broker kit the app
# bundles. It is installed FIRST so pip sees the brue-language dependency
# satisfied by that checkout, and the app bundles its Brue Connect rather
# than a copy from PyPI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESK="$ROOT/desktop"
VENV="$ROOT/.venv"
PORT="${LSE_SMOKE_PORT:-7897}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "this script builds the macOS app; run it on the Mac" >&2
  exit 1
fi

for sib in brue; do
  if [ ! -f "$ROOT/../$sib/pyproject.toml" ]; then
    echo "missing sibling clone ../$sib; clone it next to lse-terminal first" >&2
    exit 1
  fi
done

echo "== python venv"
# Check the interpreter BEFORE building a venv from it. A stock Mac resolves
# python3 to the Command Line Tools shim, which is 3.9; this project and
# brue both declare requires-python >= 3.10, so a venv built on the
# shim fails several steps later inside pip with a message that says nothing
# about which python was wrong. PYTHON=/path/to/python3 overrides.
PY="${PYTHON:-python3}"
if [ ! -x "$VENV/bin/python" ]; then
  for cand in "$PY" /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    command -v "$cand" >/dev/null 2>&1 || continue
    if "$cand" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
      PY="$cand"; break
    fi
  done
  if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)' 2>/dev/null; then
    echo "python 3.10+ required; '$PY' is $("$PY" -V 2>&1). Install one" >&2
    echo "(brew install python) or set PYTHON=/path/to/python3 and rerun." >&2
    exit 1
  fi
  echo "   using $PY ($("$PY" -V 2>&1))"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
# An earlier build installed a separate brue-connect here; left in a reused
# venv it is imported (and bundled) before the Brue Connect inside ../brue.
"$VENV/bin/pip" uninstall --quiet -y brue-connect >/dev/null 2>&1 || true
"$VENV/bin/pip" install --quiet -e "$ROOT/../brue"
KIT="$("$VENV/bin/python" -c 'import brueconnect, os; print(os.path.realpath(os.path.dirname(brueconnect.__file__)))')"
if [ "$KIT" != "$(cd "$ROOT/../brue/brueconnect" && pwd -P)" ]; then
  echo "brueconnect resolves to $KIT, not ../brue/brueconnect; remove the old copy from $VENV first" >&2
  exit 1
fi
"$VENV/bin/pip" install --quiet -e "$ROOT" pyinstaller

echo "== frozen sidecar (PyInstaller onedir)"
# --clean AND a deleted workpath: a plain rebuild reuses the cached Analysis
# and can keep a stale PYZ (this bit the Windows build once); never trust the cache.
rm -rf "$DESK/pyi-work" "$DESK/pyi-dist" "$DESK/sidecar/lset-server"
"$VENV/bin/pyinstaller" --noconfirm --clean \
  --workpath "$DESK/pyi-work" --distpath "$DESK/pyi-dist" \
  "$DESK/pyi-spec/lset-server.spec"
mkdir -p "$DESK/sidecar"
cp -R "$DESK/pyi-dist/lset-server" "$DESK/sidecar/lset-server"

echo "== smoke test on :$PORT"
"$DESK/sidecar/lset-server/lset-server" --no-browser --port "$PORT" \
  > "$DESK/pyi-dist/smoke.log" 2>&1 &
SMOKE_PID=$!
trap 'kill "$SMOKE_PID" 2>/dev/null || true' EXIT
ok=""
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  # a sidecar that already died never becomes healthy; fail fast with its log
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 1
done
if [ -z "$ok" ]; then
  echo "sidecar failed the smoke test; tail of smoke.log:" >&2
  tail -40 "$DESK/pyi-dist/smoke.log" >&2
  exit 1
fi
kill "$SMOKE_PID" 2>/dev/null || true
trap - EXIT
echo "smoke OK"

echo "== electron app (dmg + zip)"
cd "$DESK"
npm install
# Release channel. LSE_CHANNEL=demo builds LSE DEMO TERMINAL, a separate app
# (own name, bundle id, updater cache and config folder) that installs next
# to the public LSE Terminal and updates from the private shelf's demo/
# subfolder, so changes are exercised there before they are promoted to the
# public feed. The shelf URL and token come from ~/.private_keys/devfeed.env
# (DEV_FEED_URL, DEV_FEED_TOKEN), never the repo; the token is sent as a
# request header whose value must contain no space (electron-builder's
# command line splits the value at the space and drops the secret). "dev" is
# the old name for demo.
EB_ARGS=()
case "${LSE_CHANNEL:-public}" in
  dev|demo)
    DEVFEED="$HOME/.private_keys/devfeed.env"
    [ -f "$DEVFEED" ] || { echo "LSE_CHANNEL=demo needs $DEVFEED" >&2; exit 1; }
    # shellcheck disable=SC1090
    . "$DEVFEED"
    FEED="${DEV_FEED_URL%/}/demo/"
    EB_ARGS+=("-c.productName=LSE Demo Terminal"
              "-c.appId=com.londonstrategicedge.terminal.demo"
              '-c.mac.artifactName=LSE Demo Terminal ${version} ${arch}.${ext}'
              "-c.extraMetadata.name=lse-demo-terminal-desktop"
              "-c.extraMetadata.productName=LSE Demo Terminal"
              "-c.extraMetadata.lseChannel=demo"
              "-c.publish.url=$FEED"
              "-c.publish.requestHeaders.X-LSE-Feed=$DEV_FEED_TOKEN")
    echo "   channel: demo (LSE Demo Terminal, private shelf demo/)"
    ;;
  *) echo "   channel: public" ;;
esac
# Headless signing. codesign reaches the Developer ID that lives in the login
# keychain only from the machine's own GUI session; driven over ssh the
# keychain answers "User interaction is not allowed" and every sign dies with
# errSecInternalComponent, after the whole app has already been packaged.
# find-identity still LISTS the identity in that session, so listing it proves
# nothing; only an actual sign does. When a real sign fails that way and the CI
# credential bundle is on the machine, import the same identity into a
# throwaway keychain this shell unlocks itself (what CI does) and drop it again
# on exit. A GUI build probes clean and skips all of this.
CI_SECRETS="$HOME/.private_keys/ci-secrets.txt"
can_sign_here() {
  local d rc
  d="$(mktemp -d)"
  cp /usr/bin/true "$d/probe" 2>/dev/null || { rm -rf "$d"; return 1; }
  codesign --sign "Developer ID Application" --force "$d/probe" >/dev/null 2>&1
  rc=$?
  rm -rf "$d"
  return $rc
}
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application" \
   && ! can_sign_here && [ -f "$CI_SECRETS" ]; then
  P12B64="$(sed -n 's/^APPLE_CERT_P12_BASE64=//p' "$CI_SECRETS")"
  P12PW="$(sed -n 's/^APPLE_CERT_PASSWORD=//p' "$CI_SECRETS")"
  if [ -n "$P12B64" ] && [ -n "$P12PW" ]; then
    echo "   login keychain unusable from this session: temporary build keychain"
    KCPW="$(openssl rand -hex 16)"
    P12F="$(mktemp)"
    printf '%s' "$P12B64" | base64 -d > "$P12F"
    security delete-keychain lse-build.keychain >/dev/null 2>&1 || true
    security create-keychain -p "$KCPW" lse-build.keychain
    # no auto-relock: a long notarize wait must not lock the key mid-build
    security set-keychain-settings -lut 21600 lse-build.keychain
    security unlock-keychain -p "$KCPW" lse-build.keychain
    security import "$P12F" -k lse-build.keychain -P "$P12PW" -f pkcs12 \
      -T /usr/bin/codesign -T /usr/bin/security >/dev/null
    rm -f "$P12F"
    # without the partition list every sign raises a UI prompt that a headless
    # session cannot answer, which is the same dead end by another route
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" \
      lse-build.keychain >/dev/null 2>&1
    # search order decides which keychain codesign picks; ours must come first
    security list-keychains -d user -s lse-build.keychain login.keychain
    export CSC_KEYCHAIN="$HOME/Library/Keychains/lse-build.keychain-db"
    trap 'security list-keychains -d user -s login.keychain >/dev/null 2>&1;
          security delete-keychain lse-build.keychain >/dev/null 2>&1' EXIT
    can_sign_here || { echo "temporary build keychain still cannot sign" >&2; exit 1; }
  fi
fi

# Sign + notarize when the machine carries the Developer ID identity AND an
# App Store Connect API key (notarytool); otherwise build unsigned so a Mac
# without the credentials still produces a testable dmg (first launch then
# needs Privacy & Security, Open Anyway). The key file is the standard
# notarytool location; electron-builder passes it to @electron/notarize via
# APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER. Key id and issuer
# live in ~/.private_keys/notary.env (KEY_ID=..., ISSUER_ID=...), never in
# the repo.
NOTARY_ENV="$HOME/.private_keys/notary.env"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application" && [ -f "$NOTARY_ENV" ]; then
  # shellcheck disable=SC1090
  . "$NOTARY_ENV"
  export APPLE_API_KEY="$HOME/.private_keys/AuthKey_${KEY_ID}.p8"
  export APPLE_API_KEY_ID="$KEY_ID"
  export APPLE_API_ISSUER="$ISSUER_ID"
  if [ ! -f "$APPLE_API_KEY" ]; then echo "notary key $APPLE_API_KEY missing" >&2; exit 1; fi
  echo "   signing with Developer ID and notarizing (team T9GM7MY6B8)"
  npx electron-builder --mac ${EB_ARGS[@]+"${EB_ARGS[@]}"}
else
  echo "   no Developer ID identity + notary key on this Mac: unsigned build"
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac ${EB_ARGS[@]+"${EB_ARGS[@]}"}
fi
# Say the architecture out loud. The frozen sidecar is a native Mach-O and
# PyInstaller cannot produce a universal one, so this dmg runs ONLY on Macs
# of the arch that built it: an Apple Silicon build will not open on an
# Intel Mac, and vice versa. Shipping both means running this on both.
echo "done ($(uname -m) only):"
ls -d "$DESK"/dist/*.dmg "$DESK"/dist/*.zip 2>/dev/null || echo "  (see $DESK/dist)"
