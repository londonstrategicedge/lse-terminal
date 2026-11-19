# Rebuild the public Windows release from its proved source and installed resources.
from pathlib import Path
import sys,json
root = Path(SPECPATH).parent
sys.path[:0]=[str(root/'desktop/vendor/lse_data_0_14'),str(root)]
from release_build_guard import verify
verify(root)
from PyInstaller.utils.hooks import collect_submodules, collect_all

# Preserve the installed on-disk resources, including model scripts and custom indicators.
resources=json.loads((root/'desktop/release/0.1.10/resources.json').read_text(encoding='utf-8-sig'))
datas=[(str(root/Path(rel)),str(Path(rel).parent)) for rel in resources if '__pycache__' not in rel and not rel.endswith('.pyc')]
import importlib.util
brue_spec=importlib.util.find_spec('brueconnect')
brue_dir=Path(next(iter(brue_spec.submodule_search_locations)))
datas.append((str(brue_dir),'brueconnect'))
# The same package again, in a directory that holds NOTHING else. Adapters run under the user's own Python and get this
# directory on their import path (broker_hub.sdk_dir) instead of _internal, whose bundled packages and extension modules
# belong to the bundled Python and can shadow another interpreter's own.
datas.append((str(brue_dir),'brue-sdk/brueconnect'))
binaries=[]
hiddenimports=['multipart','python_multipart','uvicorn.logging']
# Keep dynamic imports supported by the installed engine (including stdlib and Brue).
hiddenimports+=json.loads((root/'desktop/published-modules.json').read_text())
for package in ('lse_terminal','brueconnect','uvicorn','pyarrow','openpyxl'):
    hiddenimports+=collect_submodules(package)
for package in ('pip','winpty'):
    package_data=collect_all(package)
    datas+=package_data[0];binaries+=package_data[1];hiddenimports+=package_data[2]
a=Analysis([str(root/'desktop'/'sidecar_entry.py')],pathex=[str(root/'desktop/vendor/lse_data_0_14'),str(root)],binaries=binaries,datas=datas,hiddenimports=hiddenimports,hookspath=[],hooksconfig={},runtime_hooks=[],excludes=['torch'],noarchive=False,optimize=0)
pyz=PYZ(a.pure)
exe=EXE(pyz,a.scripts,[],exclude_binaries=True,name='lset-server',debug=False,bootloader_ignore_signals=False,strip=False,upx=True,console=True,disable_windowed_traceback=False,argv_emulation=False,target_arch=None,codesign_identity=None,entitlements_file=None)
coll=COLLECT(exe,a.binaries,a.datas,strip=False,upx=True,upx_exclude=[],name='lset-server')
