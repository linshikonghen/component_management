"use strict";
/**
 * 全局扫描：**用户可见文案里不得出现字面量 markdown 星号**（AGENTS.md 的 mimo 评审规则第 3 条）
 *
 * 为什么要有这条（而不是只断言某几个字符串）：
 *   这类缺陷是**一整类**，不是一处——`showError` / `textContent` 会把 `**` 原样显示给用户，
 *   而写代码的人（我）在写错误提示时很自然会用 markdown 加粗。
 *   T44 修的是"核对表提示"，T46 被打回时又发现"对账单错误串"还带着 `**` ✗
 *   ——说明**逐条断言挡不住这一类**，必须全局扫。
 *
 * 判据：`src/` 与 `renderer/` 里，**非注释行**的字符串字面量中不得含 `**`。
 * （注释里的 `**` 是排版，允许；这也是为什么不直接全文件 grep。）
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const offenders = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith(".js")) continue;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!line.includes("**")) return;
      const s = line.trim();
      if (s.startsWith("*") || s.startsWith("//") || s.startsWith("/*")) return; // 注释：允许
      if (!/["'`]/.test(line)) return;
      const code = line.replace(/\/\/.*$/, "");
      if (!code.includes("**")) return;
      offenders.push(`${path.relative(ROOT, full)}:${idx + 1}  ${s.slice(0, 90)}`);
    });
  }
}

for (const dir of ["src", "renderer"]) walk(path.join(ROOT, dir));

console.log("=".repeat(64));
if (offenders.length === 0) {
  console.log("用户可见文案扫描：未发现字面量 markdown 星号 ✓");
  console.log("全部通过");
} else {
  console.log(`用户可见文案扫描：发现 ${offenders.length} 处字面量 **（会原样显示给用户）✗`);
  for (const o of offenders) console.log("  " + o);
  process.exitCode = 1;
}
