# component_management - build an installer package (zero extra tools)
#
# Uses ONLY what Windows already ships: Compress-Archive (zip) + iexpress.exe (optional self-extracting exe).
# No npm packages, no network - the project is offline by design.
#
# Two package flavours:
#   default          lightweight (~1 MB): the app itself (~560 KB) + desktop shortcut + uninstall script.
#                    Requires Electron on the target machine (same as the current shortcut setup).
#   -WithElectron    full (~350 MB): also bundles the Electron runtime, so the target machine needs nothing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\make_installer.ps1
#   powershell -ExecutionPolicy Bypass -File tools\make_installer.ps1 -WithElectron
#   powershell -ExecutionPolicy Bypass -File tools\make_installer.ps1 -OutDir D:\packages
#
# NOTE: all text here is ASCII on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI unless it has a UTF-8 BOM,
# so Chinese text in this file would turn into mojibake. Chinese instructions live in README.md instead.
param(
    [switch]$WithElectron,
    [string]$OutDir = "",
    [string]$ElectronPath = (Join-Path $env:APPDATA "npm\node_modules\electron\dist\electron.exe")
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $env:USERPROFILE "component_management_package" }
$Stamp = Get-Date -Format "yyyyMMdd"
$Name = if ($WithElectron) { "component_management-full-$Stamp" } else { "component_management-lite-$Stamp" }
$Stage = Join-Path $env:TEMP "cm_installer_$Stamp"
$Pkg = Join-Path $Stage $Name

Write-Host "[1/6] staging: $Pkg"
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Pkg | Out-Null

Write-Host "[2/6] copying app files (code/docs/tools/icon; no tests, no data)"
foreach ($item in @("src", "renderer", "docs", "tools", "assets", "package.json", "README.md", "AGENTS.md")) {
    $from = Join-Path $ProjectDir $item
    if (-not (Test-Path -LiteralPath $from)) { continue }
    Copy-Item -LiteralPath $from -Destination $Pkg -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $Pkg "data") | Out-Null

if ($WithElectron) {
    $dist = Split-Path -Parent $ElectronPath
    Write-Host "      bundling Electron runtime: $dist"
    Copy-Item -LiteralPath $dist -Destination (Join-Path $Pkg "electron") -Recurse -Force
}

Write-Host "[3/6] writing launcher / install / uninstall scripts (ASCII only, cmd.exe reads OEM codepage)"
$launcher = @'
@echo off
rem Clears ELECTRON_RUN_AS_NODE: with it set, electron.exe runs as plain Node and shows no window.
set ELECTRON_RUN_AS_NODE=
set APPDIR=%~dp0
if exist "%APPDIR%electron\electron.exe" (
  start "" "%APPDIR%electron\electron.exe" "%APPDIR%"
  goto :eof
)
for /f "delims=" %%i in ('where electron.exe 2^>nul') do (
  start "" "%%i" "%APPDIR%"
  goto :eof
)
echo Electron not found on this machine.
echo   Option A: npm i -g electron     (needs network)
echo   Option B: use the full package: make_installer.ps1 -WithElectron
pause
'@
Set-Content -LiteralPath (Join-Path $Pkg "start.cmd") -Value $launcher -Encoding ASCII

$install = @'
@echo off
rem Copies the app to %LOCALAPPDATA%\component_management\app and creates a Desktop shortcut.
setlocal
set TARGET=%LOCALAPPDATA%\component_management\app
set SRC=%~dp0
echo Installing to "%TARGET%" ...
if exist "%TARGET%" rmdir /s /q "%TARGET%"
mkdir "%TARGET%" 2>nul
xcopy "%SRC%*" "%TARGET%\" /e /i /y /q >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\component_management.lnk'); $s.TargetPath='%TARGET%\start.cmd'; $s.WorkingDirectory='%TARGET%'; $s.IconLocation='%TARGET%\assets\icon.ico,0'; $s.Description='component_management (offline)'; $s.Save()"
echo.
echo Installed. A shortcut was created on your Desktop.
echo Your data will live in: %TARGET%\data
echo To uninstall: run uninstall.cmd in the installed folder.
pause
'@
Set-Content -LiteralPath (Join-Path $Pkg "install.cmd") -Value $install -Encoding ASCII

$uninstall = @'
@echo off
rem Removes program files and the Desktop shortcut. The data folder is NOT deleted (your library is safe).
setlocal
set TARGET=%LOCALAPPDATA%\component_management\app
set DATA=%LOCALAPPDATA%\component_management\data
echo Program folder: "%TARGET%"
if exist "%TARGET%\data" (
  echo Moving your data to "%DATA%" so it is not lost ...
  mkdir "%DATA%" 2>nul
  xcopy "%TARGET%\data\*" "%DATA%\" /e /i /y /q >nul
)
if exist "%TARGET%" rmdir /s /q "%TARGET%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item ([Environment]::GetFolderPath('Desktop')+'\component_management.lnk') -Force -ErrorAction SilentlyContinue"
echo Uninstalled. Your data was kept at: %DATA%
pause
'@
Set-Content -LiteralPath (Join-Path $Pkg "uninstall.cmd") -Value $uninstall -Encoding ASCII

Write-Host "[4/6] writing package README"
$readme = @'
component_management - offline component inventory tool
======================================================

HOW TO USE
  1. Unzip this folder anywhere.
  2. Double-click  install.cmd  (installs to %LOCALAPPDATA%\component_management\app and
     creates a Desktop shortcut).
  3. Double-click the Desktop shortcut to start.

If you prefer a portable setup (no install):
  run  start.cmd  directly in the unzipped folder.

REQUIREMENTS
  Lite package : Electron must already be installed (npm i -g electron).
  Full package : nothing else needed - the Electron runtime is bundled in electron\.

NOTES
  * The app is fully offline: it never makes network requests.
  * Your data lives in the app folder's data\ subfolder (three JSON files).
    uninstall.cmd moves that folder out before removing the program, so your
    library is not deleted by an uninstall.
  * Uninstalling does not touch the Windows registry - it is a plain file install.
'@
Set-Content -LiteralPath (Join-Path $Pkg "README.txt") -Value $readme -Encoding ASCII

Write-Host "[5/6] zipping"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "$Name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path $Pkg -DestinationPath $zip -CompressionLevel Optimal

Write-Host "[6/6] done"
$size = [Math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
Write-Host "  package : $zip  ($size MB)"
Write-Host "  install : unzip, then run install.cmd"
Write-Host "  remove  : uninstall.cmd in the installed folder (keeps your data)"
if (-not $WithElectron) {
    Write-Host "  NOTE: lite package needs Electron on the target machine; use -WithElectron for a self-contained one (~350 MB)."
}
Write-Host "  staging dir kept for inspection: $Pkg"
