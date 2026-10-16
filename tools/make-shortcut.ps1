#Requires -Version 5.1
<#
.SYNOPSIS
    生成「元器件管理」的桌面快捷方式（spec FR-6.3 / AC-6：双击即用）。

.DESCRIPTION
    不做安装包（plan §1：离线环境避免下载），所以启动方式就是"一个 .lnk 指向 electron.exe"。
    本脚本负责把这件事做对：
      · 找到 electron.exe（参数 → PATH → npm 全局目录 → 常见安装位置）
      · 确认目标目录**确实是本项目**（有 package.json，且 main 指向 src/main.js）
      · 用 WScript.Shell 建 .lnk：TargetPath / Arguments(项目绝对路径) / WorkingDirectory / IconLocation
      · 处理一个会让"双击毫无反应"的环境陷阱：若存在 ELECTRON_RUN_AS_NODE，
        electron.exe 会退化成纯 Node（不建窗口、静默退出）——此时改指向一个先清掉该变量的 .cmd

.PARAMETER ShortcutDir
    快捷方式放哪。默认当前用户桌面。**测试时指向临时目录**，就能在不动桌面的前提下验证。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
.EXAMPLE
    # 只生成到某个目录（不碰桌面），用于验证
    powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1 -ShortcutDir .\tmp
#>
[CmdletBinding()]
param(
    [string]$ShortcutDir = "",
    [string]$Name = "元器件管理",
    [string]$ProjectDir = "",
    [string]$ElectronPath = "",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$text) { if (-not $Quiet) { Write-Host $text } }
function Fail([string]$text) { Write-Host "错误：$text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. 项目目录
if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $ProjectDir)) { Fail "项目目录不存在：$ProjectDir" }
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path

$pkgPath = Join-Path $ProjectDir "package.json"
$mainPath = Join-Path $ProjectDir "src\main.js"
if (-not (Test-Path -LiteralPath $pkgPath)) { Fail "这里不是本项目（缺 package.json）：$ProjectDir" }
if (-not (Test-Path -LiteralPath $mainPath)) { Fail "这里不是本项目（缺 src\main.js）：$ProjectDir" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pkg.main -ne "src/main.js") { Fail "package.json 的 main 不是 src/main.js（读到「$($pkg.main)」），拒绝生成" }

# ---------------------------------------------------------------- 2. electron.exe
# 关键：快捷方式的目标**必须是真正的 exe**（…\electron\dist\electron.exe）。
# 不能直接用 `Get-Command electron` 的结果——npm 装的是 shell shim（electron.ps1 / electron.cmd），
# 双击指向它的 .lnk 只会用记事本把 ps1 打开（用户看到的就是"双击没反应"）。
# 所以先按已知安装位置找 dist\electron.exe，最后才参考 PATH，并**强制校验扩展名是 .exe**。
if ([string]::IsNullOrWhiteSpace($ElectronPath)) {
    $candidates = @()
    foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
        if ($root) { $candidates += (Join-Path $root "npm\node_modules\electron\dist\electron.exe") }
    }
    $npmCmd = Get-Command "npm" -ErrorAction SilentlyContinue
    if ($npmCmd) {
        try {
            $globalRoot = (& npm root -g 2>$null | Select-Object -First 1)
            if ($globalRoot) { $candidates += (Join-Path $globalRoot.Trim() "electron\dist\electron.exe") }
        } catch { }
    }
    $onPath = Get-Command "electron" -ErrorAction SilentlyContinue
    if ($onPath) {
        # 若是 shim，从它所在目录往下找真正的 exe
        $shimDir = Split-Path -Parent $onPath.Source
        $candidates += (Join-Path $shimDir "node_modules\electron\dist\electron.exe")
        $candidates += $onPath.Source
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c) -and $c.ToLower().EndsWith(".exe")) {
            $ElectronPath = (Resolve-Path -LiteralPath $c).Path
            break
        }
    }
}
if (-not [string]::IsNullOrWhiteSpace($ElectronPath) -and -not $ElectronPath.ToLower().EndsWith(".exe")) {
    Fail @"
解析到的不是可执行文件：$ElectronPath
快捷方式的目标必须是 electron.exe —— 不是 npm 的 electron.ps1 / electron.cmd shim
（指向 shim 时双击只会用记事本打开脚本）。请用 -ElectronPath 指定真正的 exe。
"@
}
if ([string]::IsNullOrWhiteSpace($ElectronPath) -or -not (Test-Path -LiteralPath $ElectronPath)) {
    Fail @"
找不到 electron.exe。请用 -ElectronPath 指定，例如：
  -ElectronPath "$env:APPDATA\npm\node_modules\electron\dist\electron.exe"
（本项目不做安装包，运行时依赖本机已装的 Electron）
"@
}
Write-Step "Electron：$ElectronPath"

# ---------------------------------------------------------------- 3. 图标
# **图标必须放在工作区之外，Explorer 才会用它。**
# 实测（2026-10-16，三组对照）：把同一个 .ico 放在本工作区里，快捷方式的图标会**回退成
# Windows 的通用快捷方式图标（白纸+箭头）**；把同样的字节放到 %LOCALAPPDATA% 下，立刻正常显示。
# 原因在工作区的 ACL/完整性标签上（DSH 沙箱给工作区加了条目，Explorer 的图标渲染路径读不到），
# **不是图标文件本身的问题**——同一个文件用 Pillow 读、用 shell 直接读、逐字节校验都正常。
# 所以：优先把图标复制到 %LOCALAPPDATA% 再用；复制失败才退回工作区内的路径（并给出提示）。
$iconSource = Join-Path $ProjectDir "assets\icon.ico"
$iconPath = $iconSource
if (-not (Test-Path -LiteralPath $iconSource)) {
    Write-Step "提示：没有 assets\icon.ico，快捷方式将使用 electron.exe 自带图标。"
    Write-Step "      想生成图标：python tools\make_icon.py"
    $iconLocation = "$ElectronPath,0"
} else {
    $iconStore = Join-Path $env:LOCALAPPDATA "component_management"
    $iconOutside = Join-Path $iconStore "icon.ico"
    try {
        New-Item -ItemType Directory -Force -Path $iconStore | Out-Null
        Copy-Item -LiteralPath $iconSource -Destination $iconOutside -Force
        # 校验复制是否真的成功（字节一致才算）——不能"以为复制了"
        $same = (Get-FileHash -LiteralPath $iconSource).Hash -eq (Get-FileHash -LiteralPath $iconOutside).Hash
        if ($same) {
            $iconPath = $iconOutside
            Write-Step "图标：已复制到工作区之外（Explorer 只认工作区外的图标）"
            Write-Step "      $iconOutside"
        } else {
            Write-Step "警告：图标复制后字节不一致，退回使用工作区内的图标（可能显示为通用图标）"
        }
    } catch {
        Write-Step "警告：无法把图标复制到 $iconOutside（$($_.Exception.Message)）"
        Write-Step "      将使用工作区内的图标；Explorer 可能显示为通用快捷方式图标。"
    }
    $iconLocation = "$iconPath,0"
}

# ---------------------------------------------------------------- 4. 环境陷阱
# ELECTRON_RUN_AS_NODE 会让 electron.exe 以纯 Node 运行：不建窗口、脚本跑完就退出，
# 用户看到的就是"双击了，什么都没发生"。这个变量常见于被某些工具设置的环境。
$targetPath = $ElectronPath
$arguments = "`"$ProjectDir`""
$launcher = ""
if ($env:ELECTRON_RUN_AS_NODE) {
    $launcher = Join-Path $ProjectDir "启动-兜底.cmd"
    # .cmd 内容保持**纯 ASCII**：cmd.exe 按 OEM 代码页读批处理，中文容易变乱码
    $lines = @(
        "@echo off",
        "rem Launcher fallback: clears ELECTRON_RUN_AS_NODE, then starts the app.",
        "rem (If that variable is set, electron.exe runs as plain Node and shows no window.)",
        "set ELECTRON_RUN_AS_NODE=",
        "start `"`" `"$ElectronPath`" `"$ProjectDir`""
    )
    [System.IO.File]::WriteAllText($launcher, ($lines -join "`r`n") + "`r`n", (New-Object System.Text.ASCIIEncoding))
    $targetPath = $launcher
    $arguments = ""
    Write-Step "注意：检测到环境变量 ELECTRON_RUN_AS_NODE —— 直接指向 electron.exe 会静默退出。"
    Write-Step "      已改为指向兜底启动器：$launcher"
}

# ---------------------------------------------------------------- 5. 建快捷方式
if ([string]::IsNullOrWhiteSpace($ShortcutDir)) { $ShortcutDir = [Environment]::GetFolderPath("Desktop") }
if (-not (Test-Path -LiteralPath $ShortcutDir)) {
    New-Item -ItemType Directory -Path $ShortcutDir -Force | Out-Null
}
$ShortcutDir = (Resolve-Path -LiteralPath $ShortcutDir).Path
$lnkPath = Join-Path $ShortcutDir "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $ProjectDir
$shortcut.IconLocation = $iconLocation
$shortcut.Description = "元器件管理（本地离线工具）"
$shortcut.WindowStyle = 1
$shortcut.Save()

if (-not (Test-Path -LiteralPath $lnkPath)) { Fail "快捷方式没写出来：$lnkPath" }

Write-Step ""
Write-Step "已创建：$lnkPath"
Write-Step "  目标：$targetPath $arguments"
Write-Step "  工作目录：$ProjectDir"
Write-Step "  图标：$iconLocation"
Write-Step ""
Write-Step "现在可以双击桌面上的「$Name」启动。"
if ($launcher) { Write-Step "（若哪天双击没反应，直接双击 $launcher 也行。）" }

# 供测试与调用方读取结果（-Quiet + JSON）
if ($Quiet) {
    [pscustomobject]@{
        shortcut_path = $lnkPath
        target_path   = $targetPath
        arguments     = $arguments
        working_dir   = $ProjectDir
        icon_location = $iconLocation
        launcher      = $launcher
    } | ConvertTo-Json -Compress
}
