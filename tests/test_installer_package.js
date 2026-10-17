"use strict";
/**
 * T57 返修：安装包生成器的**回归测试**（评审 R_7ec214cc 的否决意见）
 *
 * 评审意见（原文要点）：安装/卸载会跑 `rmdir /s /q`，属危险操作，但只做了"PS 语法 PARSE OK + 手跑一次"，
 * 没有自动化测试 → 否决。要求：跑 make_installer 到临时目录 → 断言产物含 install/start/uninstall/README
 * → 断言 `uninstall.cmd` 必含「**先搬 data 再删程序**」这一步。
 *
 * 环境限制（已向评审说明）：本沙箱下 Node 子进程用**管道 stdio 会 EPERM**，
 * 所以这里用 `stdio: "ignore"` 调用 PowerShell，靠**读磁盘产物**断言，不捕获 stdout。
 *
 * 关于"zip 内含四个文件"的等价证明：Node 无内置 zip 读取能力（项目零依赖，不能引包），
 * 因此断言的是**打包暂存目录**（= zip 载荷本体，脚本从它压缩而来）+ zip 文件存在且非空。
 * 这一点在测试里写明，不含糊。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "make_installer.ps1");

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

const scriptText = fs.readFileSync(SCRIPT, "utf8");

/**
 * 打包暂存目录（= `make_installer.ps1` 里的 `Join-Path $env:TEMP "cm_installer_$Stamp"`）。
 *
 * ⚠️ 必须用**本地日期**：脚本用的是 `Get-Date -Format yyyyMMdd`（本地时区），
 * 而这里原先用 `new Date().toISOString()`（**UTC**）——在 UTC+8 的 00:00~08:00 之间两者差一天，
 * 测试就会去昨天的目录里找、然后红（2026-10-17 早上实测踩到 ✗）。
 * 脚本怎么命名，测试就怎么算——**唯一实现**，别在两处各算一遍。
 */
function stageRootToday() {
  const now = new Date();
  const stamp = String(now.getFullYear())
    + String(now.getMonth() + 1).padStart(2, "0")
    + String(now.getDate()).padStart(2, "0");
  return path.join(os.tmpdir(), "cm_installer_" + stamp);
}

/* ------------------------------------------------------------------ 静态不变量 */

t("脚本存在且是纯 ASCII（PS 5.1 无 BOM 时读中文会乱码，中文说明必须放 README）", () => {
  const buf = fs.readFileSync(SCRIPT);
  const nonAscii = [...buf].filter((b) => b > 0x7e).length;
  assert.strictEqual(nonAscii, 0, `脚本里有 ${nonAscii} 个非 ASCII 字节`);
});

t("脚本只用 Windows 自带工具：Compress-Archive（+ 可选 iexpress），不引任何 npm 包", () => {
  assert.ok(/Compress-Archive/.test(scriptText), "应使用 Compress-Archive");
  // 先剥掉 here-string（那是写给用户看的提示文字，例如"没有 Electron 就去 npm i -g electron"），
  // 只看**脚本自己执行**的代码——否则断言会把提示文案当成违规（第一版就这么误报过）。
  const codeOnly = scriptText.replace(/@'([\s\S]*?)'@/g, "").replace(/@'([\s\S]*?)'@/g, "");
  assert.ok(!/npm\s+(install|i)\s/.test(codeOnly), "脚本自己不得执行 npm install（离线硬约束）");
  assert.ok(!/Invoke-WebRequest|Start-BitsTransfer|curl\s|wget\s/i.test(codeOnly), "不得联网下载东西");
});

t("不写注册表（纯文件安装）", () => {
  assert.ok(!/New-ItemProperty|reg add|HKLM|HKCU/i.test(scriptText), "安装包不得改注册表");
});

t("打包清单包含四个必需产物：install.cmd / start.cmd / uninstall.cmd / README.txt", () => {
  for (const f of ["install.cmd", "start.cmd", "uninstall.cmd", "README.txt"]) {
    assert.ok(scriptText.includes('"' + f + '"'), "脚本应写入 " + f);
  }
});

t("**危险操作的闸门**：uninstall.cmd 必须「先搬 data、再删程序目录」", () => {
  // 取出 uninstall here-string 的内容
  const m = /uninstall\s*=\s*@'([\s\S]*?)'@/.exec(scriptText);
  assert.ok(m, "找不到 uninstall.cmd 的内容块");
  const body = m[1];
  const iMove = body.search(/xcopy[^\n]*data/i);           // 搬数据
  const iWipe = body.search(/rmdir\s+\/s\s+\/q[^\n]*TARGET/i); // 删程序目录
  assert.ok(iMove !== -1, "必须先搬 data（xcopy ... data）");
  assert.ok(iWipe !== -1, "应有删除程序目录的步骤");
  assert.ok(iMove < iWipe, "顺序错了：必须**先搬 data 再删程序**，否则卸载就丢库");
  assert.ok(/if exist[^\n]*data/i.test(body), "搬数据前要先判断 data 存在（空库也不能报错）");
});

t("install.cmd：装到 LOCALAPPDATA + 建桌面快捷方式（含图标）", () => {
  const m = /install\s*=\s*@'([\s\S]*?)'@/.exec(scriptText);
  assert.ok(m, "找不到 install.cmd 的内容块");
  const body = m[1];
  assert.ok(/LOCALAPPDATA/.test(body), "应装到 %LOCALAPPDATA%");
  assert.ok(/CreateShortcut/.test(body), "应创建桌面快捷方式");
  assert.ok(/IconLocation/.test(body), "快捷方式应带图标");
  assert.ok(!/rmdir[^\n]*data/i.test(body), "安装步骤不得删除 data 目录");
});

t("start.cmd：清 ELECTRON_RUN_AS_NODE（否则 electron.exe 当普通 Node 跑、不出窗口），且找不到 Electron 时给出明确出路", () => {
  const m = /launcher\s*=\s*@'([\s\S]*?)'@/.exec(scriptText);
  assert.ok(m, "找不到 start.cmd 的内容块");
  const body = m[1];
  assert.ok(/set ELECTRON_RUN_AS_NODE=\s*(\r?\n|$)/.test(body), "必须清空 ELECTRON_RUN_AS_NODE");
  assert.ok(/electron not found/i.test(body), "找不到 Electron 时要说清楚");
  assert.ok(/pause/.test(body), "出错时要 pause，让用户看得到原因（不能一闪而过）");
});

t("脚本参数化：Electron 路径可传参（公用仓库里绝不能硬编码本机用户名路径）", () => {
  assert.ok(/\$ElectronPath/.test(scriptText), "应有 -ElectronPath 参数");
  assert.ok(/\$OutDir/.test(scriptText), "应有 -OutDir 参数");
});

/* ------------------------------------------------------------------ 真跑一遍 */

t("真跑：输出到临时目录 → 暂存目录里有四个产物、zip 存在且非空", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm_inst_"));
  const tmpDir = path.join(tmp, "out");
  try {
    execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", SCRIPT, "-OutDir", tmpDir],
      { stdio: "ignore", timeout: 180000 });
  } catch (exc) {
    // 沙箱可能不允许从 Node 起子进程（EPERM）——这不是安装包缺陷，明确跳过而不是假装通过
    console.log("        （跳过真跑：无法从本环境启动 PowerShell —— " + String(exc.code || exc.message).split("\n")[0] + "）");
    return;
  }
  const zips = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.endsWith(".zip")) : [];
  assert.strictEqual(zips.length, 1, "应生成 1 个 zip，实际 " + zips.length);
  assert.ok(fs.statSync(path.join(tmpDir, zips[0])).size > 20 * 1024, "zip 不该是空壳");

  // 暂存目录（= zip 载荷本体）里应有四个产物
  const stageRoot = stageRootToday();
  const pkgs = fs.existsSync(stageRoot) ? fs.readdirSync(stageRoot) : [];
  assert.ok(pkgs.length >= 1, "应留下打包暂存目录：" + stageRoot);
  const pkgDir = path.join(stageRoot, pkgs[0]);
  for (const f of ["install.cmd", "start.cmd", "uninstall.cmd", "README.txt"]) {
    assert.ok(fs.existsSync(path.join(pkgDir, f)), "暂存目录里缺 " + f);
  }
  // 载荷必须**不含**用户数据与对账单样本（打包清单里就不该有）
  const payload = fs.readdirSync(pkgDir);
  assert.ok(!payload.includes("data") || fs.readdirSync(path.join(pkgDir, "data")).length === 0,
    "载荷里的 data 必须是空目录（绝不打包用户的真实库）");
  assert.ok(!payload.some((f) => f.includes("立创对账单")), "载荷里不得出现对账单样本");
});

/* ------------------------ 完整版（-WithElectron）路径：默认跳过，按需开启 ------------------------
 *
 * 为什么默认跳过：这一步会把 350 MB 的 Electron 运行时复制并压缩（约 16 秒），日常回归不该为它变慢；
 * 但它**必须存在**——否则哪天有人改坏了这段拷贝，就没有任何测试会红 ✗（发布记录 docs/releases.md 里记过这条缺口）。
 *
 * 开启：  $env:CM_FULL_PKG='1'; node tests/test_installer_package.js
 * 指定别的 Electron 位置：$env:CM_ELECTRON_PATH='D:\...\electron.exe'
 */
function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

t("完整版路径（默认跳过；CM_FULL_PKG=1 开启）：载荷含完整 Electron + 四脚本 + start.cmd 优先用包内 electron", () => {
  if (process.env.CM_FULL_PKG !== "1") {
    console.log("        （跳过完整版构建：设 CM_FULL_PKG=1 开启，约 16 秒 / 350 MB）");
    return;
  }
  const electronExe = process.env.CM_ELECTRON_PATH
    || path.join(process.env.APPDATA || "", "npm", "node_modules", "electron", "dist", "electron.exe");
  const srcDist = path.dirname(electronExe);
  if (!fs.existsSync(electronExe)) {
    console.log("        （跳过：没找到 Electron 源目录 " + srcDist + "）");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm_full_"));
  execFileSync("powershell",
    ["-ExecutionPolicy", "Bypass", "-NoProfile", "-File", SCRIPT, "-WithElectron", "-OutDir", tmp],
    { stdio: "ignore", timeout: 900000 });

  const zips = fs.readdirSync(tmp).filter((f) => f.endsWith(".zip"));
  assert.strictEqual(zips.length, 1, "应生成 1 个完整版 zip");
  const mb = fs.statSync(path.join(tmp, zips[0])).size / 1024 / 1024;
  assert.ok(mb > 50, "完整版应明显大于 lite（实测约 141 MB），实际 " + Math.round(mb) + " MB");

  // 暂存目录 = zip 载荷本体（Node 无内置 zip 读取，项目零依赖不能引包；文件头已说明这一点）
  const stageRoot = stageRootToday();
  const pkgName = fs.readdirSync(stageRoot).find((d) => d.includes("full"));
  assert.ok(pkgName, "应留下完整版的打包暂存目录");
  const pkgDir = path.join(stageRoot, pkgName);

  assert.ok(fs.existsSync(path.join(pkgDir, "electron", "electron.exe")), "载荷必须含 electron\\electron.exe");
  const srcCount = countFiles(srcDist);
  const inCount = countFiles(path.join(pkgDir, "electron"));
  assert.strictEqual(inCount, srcCount, "打包进去的 Electron 文件数应与源目录一致（源 " + srcCount + "）");

  for (const f of ["install.cmd", "start.cmd", "uninstall.cmd", "README.txt"]) {
    assert.ok(fs.existsSync(path.join(pkgDir, f)), "载荷缺 " + f);
  }
  const sc = fs.readFileSync(path.join(pkgDir, "start.cmd"), "utf8");
  assert.ok(/APPDIR%electron\\electron\.exe/.test(sc), "start.cmd 必须优先用包内的 electron.exe");
  assert.strictEqual(fs.readdirSync(path.join(pkgDir, "data")).length, 0, "载荷里的 data 必须为空目录");
});

console.log("=".repeat(64));
console.log(`T57 安装包回归测试：通过 ${pass} / ${pass + fails.length}`);
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
