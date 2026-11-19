# Public Windows build from the retained release source; no environment upgrades or old overlays.
# Provision the proved Python/dependencies and Brue 0.0.2 (it carries Brue Connect) first.
param([string] $Python = "python")
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Desk = Join-Path $Root "desktop"
$env:PYTHONPATH = (Join-Path $Desk "vendor\lse_data_0_14") + [IO.Path]::PathSeparator + $Root + [IO.Path]::PathSeparator + $Desk
Set-Location $Root
& $Python (Join-Path $Desk "release_build_guard.py")
if ($LASTEXITCODE -ne 0) { throw "Release inputs differ from the proved build" }
$env:LSE_TERMINAL_CONFIG_DIR = Join-Path $Desk "pyi-work\isolated-config"
$env:BRUE_CONNECT_HOME = Join-Path $Desk "pyi-work\isolated-brue"
& $Python -m PyInstaller --noconfirm --clean --workpath (Join-Path $Desk "pyi-work") --distpath (Join-Path $Desk "pyi-dist") (Join-Path $Desk "lset-server-windows.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
# Replace only generated sidecar output, never an installed application.
$Target = Join-Path $Desk "sidecar\lset-server"
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
New-Item -ItemType Directory -Force (Join-Path $Desk "sidecar") | Out-Null
Copy-Item -Recurse (Join-Path $Desk "pyi-dist\lset-server") $Target
Set-Location $Desk
npm ci
if ($LASTEXITCODE -ne 0) { throw "Locked Electron dependencies failed" }
npx electron-builder --win --publish never
if ($LASTEXITCODE -ne 0) { throw "Public Windows packaging failed" }
Write-Output "Built local artifacts only. Run native customer and installation proof before release publication."
