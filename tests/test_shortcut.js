"use strict";
/**
 * test_shortcut.js — T19（plan §9 的 T15）验收测试：桌面快捷方式 + 图标
 *
 * 运行： node tests/test_shortcut.js
 *
 * 无头环境里"双击"这件事没法真做，所以拆成能真验的四块：
 *   §1  静态：脚本里该有的东西都在（electron 解析、项目校验、图标、环境陷阱处理）
 *   §2  **真读 ICO 字节**：头字段 + 两张图的像素颜色（顺手钉住 BGR/RGB 顺序这个坑）
 *   §3  PowerShell AST 语法解析（0 错误）
 *   §4  **真建快捷方式**（写到临时目录，不动桌面）再用 COM 读回校验，
 *       并**两个环境分支各跑一次**：正常 → 指向 electron.exe；设了 ELECTRON_RUN_AS_NODE → 指向兜底 .cmd
 */

const assert = require("assert");
const crypto = require("crypto"); // 比对图标字节（断言挂的确实是我们的图标）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_shortcut_"));
const PS1 = path.join(PROJECT_ROOT, "tools", "make-shortcut.ps1");
const ICO = path.join(PROJECT_ROOT, "assets", "icon.ico");

let passCount = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log("  PASS  " + name);
  } catch (exc) {
    failures.push({ name, message: String(exc && exc.message ? exc.message : exc) });
    console.log("  FAIL  " + name);
    console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
  }
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function section(title) { console.log("\n=== " + title + " ==="); }

/**
 * 用哪个 PowerShell 跑？
 * 优先 **Windows PowerShell 5.1**（`powershell.exe`）——用户右键"使用 PowerShell 运行"就是它，
 * 而且它读 .ps1 依赖 BOM、`Set-Content -Encoding UTF8` 会带 BOM，正是要验的环境。
 * （本机 `pwsh` 不在子进程 PATH 上，所以不能用名字找。）
 */
const POWERSHELL = (() => {
  const win51 = path.join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(win51)) return win51;
  const pwsh = path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh)) return pwsh;
  return "pwsh";
})();

/** PS 5.1 的 `Set-Content -Encoding UTF8` 会带 BOM，读 JSON 前先剥掉 */
function readJsonFile(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

/**
 * 写一个临时 .ps1。**必须带 BOM**：PS 5.1 读不带 BOM 的 .ps1 会按系统 ANSI 代码页解码，
 * 脚本里的中文（比如「元器件管理.lnk」）就变成乱码，`CreateShortcut` 会报
 * "快捷方式路径名称需以 .lnk 或 .url 结尾"。
 * —— 这条坑正是本任务主脚本要处理的，结果我自己的测试脚本先踩了一次。
 */
function writePs1(file, body) {
  fs.writeFileSync(file, "\uFEFF" + body, "utf8");
}

/** 跑一段 PowerShell：把结果写信到一个 JSON 文件（避免依赖管道 stdio——本机沙箱下会 EPERM） */
function runPowerShell(body, tag) {
  const scriptFile = path.join(TMP, `run-${tag}.ps1`);
  const outFile = path.join(TMP, `out-${tag}.json`);
  writePs1(scriptFile, body);
  const result = spawnSync(POWERSHELL, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile,
  ], { stdio: "inherit" });
  if (result.error) throw new Error("启动 PowerShell 失败：" + result.error.message);
  if (result.status !== 0) throw new Error(`PowerShell 退出码 ${result.status}（脚本：${scriptFile}）`);
  if (!fs.existsSync(outFile)) throw new Error("PowerShell 没写出结果文件：" + outFile);
  return readJsonFile(outFile);
}

/* ==================================================== §1 静态检查 */

section("§1 脚本静态检查");

t("make-shortcut.ps1 存在且以 UTF-8 **带 BOM** 落盘（否则 PS 5.1 下中文乱码）", () => {
  const raw = fs.readFileSync(PS1);
  assert.ok(raw.length > 0, "脚本不存在");
  assert.deepStrictEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF], "缺 UTF-8 BOM");
  assert.ok(raw.toString("utf8").includes("元器件管理"), "BOM 之后中文应能正常解码");
});

t("脚本包含建快捷方式必需的调用与属性", () => {
  const text = readText(PS1);
  for (const needle of ["New-Object -ComObject WScript.Shell", "CreateShortcut", "TargetPath",
    "Arguments", "WorkingDirectory", "IconLocation", "Description", ".Save()"]) {
    assert.ok(text.includes(needle), "脚本里缺：" + needle);
  }
});

t("脚本会校验目标目录确实是本项目（package.json + main == src/main.js）", () => {
  const text = readText(PS1);
  assert.ok(/package\.json/.test(text), "应检查 package.json");
  assert.ok(/src\\main\.js|src\/main\.js/.test(text), "应检查 src/main.js");
  assert.ok(/ConvertFrom-Json/.test(text), "应解析 package.json 再判断");
});

t("脚本处理 ELECTRON_RUN_AS_NODE 陷阱（否则双击毫无反应）", () => {
  const text = readText(PS1);
  assert.ok(text.includes("ELECTRON_RUN_AS_NODE"), "脚本应检测该环境变量");
  assert.ok(/set ELECTRON_RUN_AS_NODE=/.test(text), "兜底启动器里应把它清掉");
});

t("脚本支持 -ShortcutDir（便于不动桌面就验证）", () => {
  const text = readText(PS1);
  assert.ok(/\$ShortcutDir/.test(text), "应有 -ShortcutDir 参数");
  assert.ok(/GetFolderPath\("Desktop"\)/.test(text), "默认应指向当前用户桌面");
});

t("make_icon.py 只用标准库（离线 + 零依赖）", () => {
  const text = readText(path.join(PROJECT_ROOT, "tools", "make_icon.py"));
  assert.ok(text.length > 0, "生成脚本不存在");
  const imports = [...text.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "没解析到 import");
  const allowed = new Set(["os", "struct", "sys"]);
  for (const name of imports) {
    assert.ok(allowed.has(name.split(".")[0]), `图标生成脚本引入了非标准库：${name}`);
  }
});

/* ==================================================== §2 ICO 字节 */

section("§2 真读 assets/icon.ico 的字节");

function parseIco(buffer) {
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    entries.push({
      width: buffer[at] === 0 ? 256 : buffer[at],
      height: buffer[at + 1] === 0 ? 256 : buffer[at + 1],
      bit_count: buffer.readUInt16LE(at + 6),
      bytes: buffer.readUInt32LE(at + 8),
      offset: buffer.readUInt32LE(at + 12),
    });
  }
  return { reserved, type, count, entries };
}

const ico = fs.readFileSync(ICO);
const parsed = parseIco(ico);

t("ICONDIR 头合法：reserved=0 / type=1 / 三个尺寸", () => {
  assert.strictEqual(parsed.reserved, 0);
  assert.strictEqual(parsed.type, 1, "type 必须是 1（图标）");
  assert.strictEqual(parsed.count, 3);
  assert.deepStrictEqual(parsed.entries.map((e) => e.width), [16, 32, 48]);
  assert.ok(parsed.entries.every((e) => e.bit_count === 32), "都应是 32bpp（带 alpha）");
});

t("每张图的数据都落在文件内，且偏移首尾相接（不留空洞）", () => {
  let expected = 6 + 16 * parsed.count;
  for (const entry of parsed.entries) {
    assert.strictEqual(entry.offset, expected, "偏移应与前一张首尾相接");
    assert.ok(entry.offset + entry.bytes <= ico.length, "数据不应越界");
    // BITMAPINFOHEADER：高度写的是 2×高（XOR+AND）
    assert.strictEqual(ico.readUInt32LE(entry.offset), 40, "应是 BITMAPINFOHEADER");
    assert.strictEqual(ico.readInt32LE(entry.offset + 4), entry.width);
    assert.strictEqual(ico.readInt32LE(entry.offset + 8), entry.height * 2);
    expected += entry.bytes;
  }
  assert.strictEqual(expected, ico.length, "文件末尾不该有多余字节");
});

/** 取某张图的某像素（BMP 段自下而上，返回 {r,g,b,a}） */
function pixelAt(entry, x, y) {
  const base = entry.offset + 40 + ((entry.height - 1 - y) * entry.width + x) * 4;
  const b = ico[base];
  const g = ico[base + 1];
  const r = ico[base + 2];
  const a = ico[base + 3];
  return { r, g, b, a };
}

t("**像素颜色对**（钉住 BGRA 顺序：第一版写成 RGBA，蓝色底画出来是橙的）", () => {
  const big = parsed.entries.find((e) => e.width === 48);
  const corner = pixelAt(big, 6, 6); // 圆角内、本体外 → 主色
  const center = pixelAt(big, 24, 24); // 芯片本体 → 浅色
  assert.ok(corner.a > 200, `主色区应不透明，实际 alpha=${corner.a}`);
  assert.ok(corner.b > corner.r, `主色应是蓝的（B>R），实际 rgb(${corner.r},${corner.g},${corner.b})`);
  assert.ok(Math.abs(corner.r - 0x1D) < 12 && Math.abs(corner.g - 0x4E) < 12 && Math.abs(corner.b - 0xD8) < 12,
    `主色应接近 #1D4ED8，实际 rgb(${corner.r},${corner.g},${corner.b})`);
  assert.ok(center.r > 200 && center.g > 200 && center.b > 200,
    `本体应是浅色，实际 rgb(${center.r},${center.g},${center.b})`);
});

t("圆角外是透明的（不是画了个实心方块）", () => {
  const big = parsed.entries.find((e) => e.width === 48);
  assert.strictEqual(pixelAt(big, 0, 0).a, 0, "左上角应在圆角之外、完全透明");
});

/* ==================================================== §3 PS 语法 */

section("§3 PowerShell AST 语法解析（0 个解析错误）");

t("make-shortcut.ps1 语法解析通过", () => {
  const report = runPowerShell([
    "$ErrorActionPreference='Stop'",
    `$err = $null`,
    `$null = [System.Management.Automation.Language.Parser]::ParseFile('${PS1}', [ref]$null, [ref]$err)`,
    `$result = [pscustomobject]@{ errors = @($err).Count; first = if ($err -and $err.Count -gt 0) { $err[0].Message } else { '' } }`,
    `$result | ConvertTo-Json -Compress | Set-Content -LiteralPath '${path.join(TMP, "out-parse.json")}' -Encoding UTF8`,
  ].join("\n"), "parse");
  assert.strictEqual(report.errors, 0, "语法错误：" + report.first);
});

/* ==================================================== §4 真建 .lnk */

section("§4 真在临时目录建快捷方式，再用 COM 读回校验");

/** 跑一次脚本 + 用 COM 读回 .lnk，返回结构化结果 */
function buildAndReadBack(tag, setTrap) {
  const outDir = path.join(TMP, "lnk-" + tag);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(TMP, `out-lnk-${tag}.json`);
  const body = [
    "$ErrorActionPreference='Stop'",
    setTrap ? "$env:ELECTRON_RUN_AS_NODE='1'" : "Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
    `$scriptOutput = & '${PS1}' -ShortcutDir '${outDir}' -Quiet`,
    `$lnk = Join-Path '${outDir}' '元器件管理.lnk'`,
    "$shell = New-Object -ComObject WScript.Shell",
    "$s = $shell.CreateShortcut($lnk)",
    // 注意：这一行必须用**模板字符串**。写成双引号时 `${PS1}` 不会被 JS 替换，
    // 会原样落到 PowerShell 里被当成它自己的变量/字面量，Split-Path 拿到空串直接报错。
    `$launcher = Join-Path (Split-Path -Parent (Split-Path -Parent '${PS1}')) '启动-兜底.cmd'`,
    "$result = [pscustomobject]@{",
    "  script_output = ($scriptOutput | Out-String).Trim()",
    "  lnk_path = $lnk",
    "  lnk_exists = (Test-Path -LiteralPath $lnk)",
    "  target_path = $s.TargetPath",
    "  arguments = $s.Arguments",
    "  working_dir = $s.WorkingDirectory",
    "  icon_location = $s.IconLocation",
    "  description = $s.Description",
    "  launcher_exists = (Test-Path -LiteralPath $launcher)",
    "  launcher_path = $launcher",
    "  trap_var = [string]$env:ELECTRON_RUN_AS_NODE",
    "}",
    `$result | ConvertTo-Json -Compress | Set-Content -LiteralPath '${jsonFile}' -Encoding UTF8`,
  ].join("\n");
  return runPowerShell(body, "lnk-" + tag);
}

const PROJECT = PROJECT_ROOT;

t("分支 A（正常环境）：快捷方式指向 electron.exe，参数是项目绝对路径，图标已挂上", () => {
  const r = buildAndReadBack("a", false);
  assert.strictEqual(r.lnk_exists, true, "快捷方式应被创建");
  assert.ok(/electron\.exe$/i.test(r.target_path), "目标应是 electron.exe，实际：" + r.target_path);
  assert.ok(r.arguments.includes(PROJECT), `参数应是项目绝对路径，实际：${r.arguments}`);
  assert.strictEqual(r.working_dir, PROJECT, "工作目录应是项目目录");
  assert.ok(r.description.includes("元器件管理"), "应有描述");
  // 注意：只断言"**指向**的不是兜底启动器"，而不是"兜底文件不存在"——
  // 后者会把上一次测试留下的文件算成失败（第一版就这么误报了一次）。
  assert.ok(!/启动-兜底/.test(r.target_path), "正常环境下不该指向兜底启动器");

  // ---------------- 图标：断言的是**不变量**，不是某一条固定路径 ----------------
  // 2026-10-16 实测：Explorer 读不到**工作区内**的 .ico（快捷方式会退回通用图标），
  // 所以脚本会把图标复制到 %LOCALAPPDATA% 再用。但复制在受限环境里可能失败 →
  // 那时脚本退回工作区内的路径并**明确警告**。两种都算"脚本行为正确"，
  // 真正必须成立的是：**被引用的图标文件存在、且就是我们的图标（字节一致）**。
  const iconFile = r.icon_location.replace(/,\s*\d+$/, "");
  assert.ok(fs.existsSync(iconFile), "被引用的图标文件必须存在：" + r.icon_location);
  const same = crypto.createHash("sha256").update(fs.readFileSync(iconFile)).digest("hex")
    === crypto.createHash("sha256").update(fs.readFileSync(ICO)).digest("hex");
  assert.ok(same, "被引用的图标必须与 assets/icon.ico 字节一致（否则挂的是别的图标）：" + iconFile);
  const outside = !iconFile.toLowerCase().startsWith(PROJECT.toLowerCase());
  if (outside) {
    assert.ok(/component_management/i.test(iconFile), "工作区外的图标应放在我们自己的目录下：" + iconFile);
    console.log("        （图标：工作区外 " + iconFile + " ✓ Explorer 会认）");
  } else {
    // 复制失败的回退路径：仍然可用，但要看得见（脚本也会打印警告）
    console.log("        （图标：工作区内回退路径 " + iconFile + " —— 受限环境下 Explorer 可能显示通用图标）");
  }
  console.log(`        （目标：${path.basename(r.target_path)} ${r.arguments}）`);
});

t("分支 B（设了 ELECTRON_RUN_AS_NODE）：改指向兜底 .cmd，且 .cmd 会清掉该变量", () => {
  const r = buildAndReadBack("b", true);
  assert.strictEqual(r.lnk_exists, true);
  assert.ok(/启动-兜底\.cmd$/.test(r.target_path), "应指向兜底启动器，实际：" + r.target_path);
  assert.strictEqual(r.arguments, "", "指向 .cmd 时不应再带参数");
  assert.strictEqual(r.working_dir, PROJECT);
  assert.strictEqual(r.launcher_exists, true, "兜底启动器应真的被写出来");

  // 启动器内容：纯 ASCII + 先清变量再 start
  const cmd = fs.readFileSync(r.launcher_path, "latin1");
  assert.ok(/set ELECTRON_RUN_AS_NODE=\r?\n/.test(cmd), "应先清掉 ELECTRON_RUN_AS_NODE");
  assert.ok(/start "" ".*electron\.exe" ".*"/.test(cmd), ".cmd 应 start electron.exe 并传项目路径：" + cmd);
  assert.ok(/^[\x00-\x7F]*$/.test(cmd), ".cmd 应保持纯 ASCII（cmd.exe 按 OEM 代码页读批处理，中文会乱码）");
  console.log(`        （兜底：${path.basename(r.target_path)} → ${path.basename(r.launcher_path)}）`);

  // 这个兜底文件是**测试逼出来的产物**（本机进程环境里恰好有这个变量），
  // 正常环境不会生成，所以测完清掉，别把仓库搞脏。
  try { fs.rmSync(r.launcher_path, { force: true }); } catch (ignored) { /* 清不掉不影响结论 */ }
  assert.ok(!fs.existsSync(r.launcher_path), "测试应清理掉自己逼出来的兜底启动器");
});

t("脚本自己的 JSON 输出与 COM 读回的一致（没有「写了但没生效」）", () => {
  const r = buildAndReadBack("c", false);
  const reported = JSON.parse(r.script_output);
  assert.strictEqual(reported.shortcut_path, r.lnk_path);
  assert.strictEqual(reported.target_path, r.target_path);
  assert.strictEqual(reported.working_dir, r.working_dir);
  assert.strictEqual(reported.icon_location, r.icon_location);
});

t("用的是哪个 PowerShell（写进结论里，便于判断证据适用范围）", () => {
  console.log(`        （本次用：${POWERSHELL}）`);
  assert.ok(/powershell\.exe$|pwsh\.exe$/i.test(POWERSHELL), "应解析到一个 PowerShell 可执行文件：" + POWERSHELL);
});

t("重复执行是幂等的（同一个 .lnk 覆盖写，不报错）", () => {
  const first = buildAndReadBack("d", false);
  const second = buildAndReadBack("d", false);
  assert.strictEqual(second.lnk_exists, true);
  assert.strictEqual(second.target_path, first.target_path);
});

t("目标目录不是本项目 → 拒绝生成（不会在别处乱建快捷方式）", () => {
  const bogus = path.join(TMP, "not-a-project");
  fs.mkdirSync(bogus, { recursive: true });
  const scriptFile = path.join(TMP, "run-reject.ps1");
  writePs1(scriptFile, [
    `& '${PS1}' -ShortcutDir '${path.join(TMP, "lnk-reject")}' -ProjectDir '${bogus}' -Quiet *> $null`,
    `$result = [pscustomobject]@{ exit_code = $LASTEXITCODE; out_dir_exists = (Test-Path -LiteralPath '${path.join(TMP, "lnk-reject")}') }`,
    `$result | ConvertTo-Json -Compress | Set-Content -LiteralPath '${path.join(TMP, "out-reject.json")}' -Encoding UTF8`,
  ].join("\n"), "utf8");
  const result = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile], { stdio: "inherit" });
  assert.strictEqual(result.status, 0, "验证脚本本身应正常结束");
  const report = readJsonFile(path.join(TMP, "out-reject.json"));
  assert.strictEqual(report.exit_code, 1, "脚本应以退出码 1 拒绝");
  assert.strictEqual(report.out_dir_exists, false, "被拒绝时不该创建任何快捷方式");
});

t("main.js 给窗口挂上了图标", () => {
  const main = readText(path.join(PROJECT_ROOT, "src", "main.js"));
  assert.ok(/icon:\s*path\.join\(__dirname,\s*"\.\.",\s*"assets",\s*"icon\.ico"\)/.test(main),
    "BrowserWindow 应设置 icon 指向 assets/icon.ico");
});

/* ------------------------------------------------------------------ 收尾 */

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (ignored) { /* 清理失败不影响结论 */ }

console.log("\n" + "=".repeat(64));
console.log(`T19（快捷方式与图标）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
