"""Reject unproved SDK or demo-adapter inputs before a public Windows build."""
from pathlib import Path
import hashlib
import importlib
import json
import sys
import tomllib

def digest(path):
    return hashlib.sha256(Path(path).read_bytes().replace(b"\r\n", b"\n")).hexdigest()

def verify(root=None):
    root = Path(root or Path(__file__).resolve().parent.parent)
    contract = json.loads((root / "desktop/release/0.1.10/build-contract.json").read_text())
    if sys.version.split()[0] != contract["python"]:
        raise RuntimeError("Use the release's proved Python " + contract["python"])
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8-sig"))
    if "lse-data==0.14.0" not in project["project"]["dependencies"]:
        raise RuntimeError("The terminal dependency must retain its proved SDK 0.14.0 contract")
    sdk = importlib.import_module("lse")
    sdk_root = Path(sdk.__file__).resolve().parent
    if sdk_root != (root / "desktop/vendor/lse_data_0_14/lse").resolve():
        raise RuntimeError("Build must use the retained, proved SDK source")
    if sdk.__version__ != contract["sdk_version"]:
        raise RuntimeError("SDK version drift")
    for name, expected in contract["sdk"].items():
        if digest(sdk_root / name) != expected:
            raise RuntimeError("SDK source drift: " + name)
    adapter = importlib.import_module("brueconnect.adapters.lse_sim.lse_sim_adapter")
    if digest(adapter.__file__) != contract["brue_adapter_sha256"]:
        raise RuntimeError("Brue Connect's lse_sim adapter is not the one this release was built with: "
                           "install Brue 0.0.2 (pip install -e ../brue) before building")
    import lse_terminal
    package = json.loads((root / "desktop/package.json").read_text(encoding="utf-8-sig"))
    if lse_terminal.__version__ != contract["version"] or package["version"] != contract["version"]:
        raise RuntimeError("Engine/shell release versions differ")
    build = package.get("build", {})
    if (package.get("lseChannel", "public") != "public"
            or build.get("extraMetadata", {}).get("lseChannel", "public") != "public"
            or package.get("productName") != "LSE Terminal"
            or build.get("productName") != "LSE Terminal"
            or build.get("appId") != "com.londonstrategicedge.terminal"
            or build.get("publish") != [{"provider": "generic", "url": "https://terminal.londonstrategicedge.com/releases/"}]):
        raise RuntimeError("This release builds only the public LSE Terminal identity and update feed")
    resources = json.loads((root / "desktop/release/0.1.10/resources.json").read_text())
    missing = [name for name in resources if not (root / name).is_file()]
    if missing:
        raise RuntimeError("Missing packaged resources: " + repr(missing[:10]))
    return contract

if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))
