"use strict";
/**
 * test_architecture.js — 分层与“唯一实现”规则的静态检查（docs/architecture.md 的可执行版本）
 *
 * 为什么要有它：项目大了以后最大的风险不是写错一行代码，而是**架构慢慢烂掉**——
 * 页面里又摸 window.api、服务层又各复制一份小工具、renderer 里又出现 require……
 * 这些都能用静态检查钉住；规则清单与 docs/architecture.md §3 一一对应。
 *
 * 注意：这里只做「结构性」检查；行为正确性由其他套件与 acceptance 负责。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}
function walk(dir, exts, out = []) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = dir + "/" + name;
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}
/** 去掉注释，避免把注释里的示例代码当成违规 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const rendererFiles = walk("renderer", [".js"]);
const pageFiles = walk("renderer/pages", [".js"]);
const serviceFiles = walk("src/services", [".js"]);
const indexHtml = read("renderer/index.html");

let passCount = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passCount += 1; console.log("  PASS  " + name); }
  catch (exc) {
    failures.push(name);
    console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]);
  }
}

/* ------------------------------------------------------------------ 目录与加载 */

t("renderer 下每个 .js 都在 index.html 里被 <script> 加载（没有“写完忘了接”的文件）", () => {
  const missing = rendererFiles.filter((rel) => {
    const src = rel.replace(/^renderer\//, "");
    return !new RegExp('<script src="' + src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"></script>').test(indexHtml);
  });
  assert.deepStrictEqual(missing, [], "以下脚本没被 index.html 加载：" + missing.join(", "));
});

t("加载顺序：ui_util.js 在 dialog.js 之前，app.js 最后", () => {
  const pos = (src) => indexHtml.indexOf('<script src="' + src + '"></script>');
  const util = pos("lib/ui_util.js");
  const dialog = pos("lib/dialog.js");
  const app = pos("app.js");
  assert.ok(util >= 0 && dialog >= 0 && app >= 0, "三个关键脚本都应在");
  assert.ok(util < dialog, "ui_util.js 必须先于 dialog.js（dialog 用它的 el）");
  assert.ok(dialog < app, "app.js 应在最后");
});

t("不存在残留的旧路径（renderer/dialog.js / renderer/ui_util.js 已移到 lib/）", () => {
  assert.ok(exists("renderer/lib/dialog.js") && exists("renderer/lib/ui_util.js"), "lib 下应有 dialog.js 与 ui_util.js");
  assert.ok(!exists("renderer/dialog.js"), "旧位置 renderer/dialog.js 不应再存在");
  assert.ok(!exists("renderer/ui_util.js"), "旧位置 renderer/ui_util.js 不应再存在");
});

/* ------------------------------------------------------------------ 渲染层规则 */

t("renderer 里禁止 require / fetch / XMLHttpRequest（拿不到 Node，也不许联网）", () => {
  const bad = [];
  for (const rel of rendererFiles) {
    const code = stripComments(read(rel));
    if (/\brequire\s*\(/.test(code) || /\bfetch\s*\(/.test(code) || /XMLHttpRequest/.test(code)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [], "违规文件：" + bad.join(", "));
});

t("页面里禁止再定义 el()/call()（唯一实现只允许在 renderer/lib/ui_util.js）", () => {
  const bad = [];
  for (const rel of rendererFiles) {
    if (rel === "renderer/lib/ui_util.js") continue;
    const code = stripComments(read(rel));
    if (/function\s+el\s*\(/.test(code) || /(?:async\s+)?function\s+call\s*\(/.test(code)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [], "违规文件：" + bad.join(", "));
});

t("页面只能通过 UIUtil 这一条通道摸 IPC（禁止 root.api.方法名 直接调用）", () => {
  // 允许把整个 api 对象作为参数交给 UIUtil（el/call/callRaw/available/has），
  // 但**禁止直接访问它的方法**（root.api.stockMove(...) 这种绕过统一错误处理/守卫的写法）。
  const bad = [];
  for (const rel of pageFiles) {
    const code = stripComments(read(rel));
    for (const line of code.split("\n")) {
      if (/root\.api\s*[.\[]/.test(line)) bad.push(rel + ": " + line.trim());
    }
  }
  const appCode = stripComments(read("renderer/app.js"));
  for (const line of appCode.split("\n")) {
    if (/window\.api\s*[.\[]/.test(line)) bad.push("renderer/app.js: " + line.trim());
  }
  assert.deepStrictEqual(bad, [], "绕过 UIUtil 直接调 api.方法名：\n  " + bad.join("\n  "));
});

t("renderer 里禁止 console.log（错误走 console.error / 页面 showError）", () => {
  const bad = rendererFiles.filter((rel) => /console\.log\s*\(/.test(stripComments(read(rel))));
  assert.deepStrictEqual(bad, [], "违规文件：" + bad.join(", "));
});

/* ------------------------------------------------------------------ 服务层规则 */

t("services 不依赖 Electron / DOM / 网络 / IPC 层（可单测是硬约束）", () => {
  const bad = [];
  for (const rel of serviceFiles) {
    const code = stripComments(read(rel));
    if (/require\(\s*["']electron["']\s*\)/.test(code)) bad.push(rel + " require electron");
    if (/\b(document|window)\s*\./.test(code)) bad.push(rel + " 使用 DOM");
    if (/\bfetch\s*\(|require\(\s*["']https?["']\s*\)/.test(code)) bad.push(rel + " 网络访问");
    if (/require\(\s*["'][^"']*\.\.\/ipc\//.test(code)) bad.push(rel + " 反向依赖 ipc 层");
  }
  assert.deepStrictEqual(bad, [], "违规：\n  " + bad.join("\n  "));
});

t("str/toInt/isBlank/clone 只允许在 src/services/value_util.js 定义（服务层唯一实现）", () => {
  const names = ["str", "toInt", "isBlank", "clone"];
  const bad = [];
  for (const rel of serviceFiles) {
    if (rel === "src/services/value_util.js") continue;
    const code = stripComments(read(rel));
    for (const name of names) {
      if (new RegExp("function\\s+" + name + "\\s*\\(").test(code)) bad.push(rel + " 又定义了 " + name + "()");
    }
  }
  assert.deepStrictEqual(bad, [], "违规：\n  " + bad.join("\n  "));
});

/* ------------------------------------------------------------------ IPC / preload / main */

t("ipc/handlers.js 是薄层：不直接 require fs/zlib/child_process", () => {
  const code = stripComments(read("src/ipc/handlers.js"));
  for (const mod of ["fs", "zlib", "child_process", "http", "https"]) {
    assert.ok(!new RegExp('require\\(\\s*["\']' + mod + '["\']\\s*\\)').test(code),
      "handlers.js 不应直接 require " + mod + "（属于 service 的职责）");
  }
});

t("preload 用 channels.js 作为唯一契约来源，不硬编码通道名", () => {
  const code = stripComments(read("src/preload.js"));
  assert.ok(/require\(\s*["']\.\/ipc\/channels["']\s*\)/.test(code), "preload 应 require ./ipc/channels");
  const literals = code.match(/["'][a-z_]+\.[a-z_]+["']/g) || [];
  const channelLike = literals.filter((s) => /["'][a-z_]+\.[a-z_]+["']/.test(s));
  assert.deepStrictEqual(channelLike, [], "preload 里不应出现硬编码通道名：" + channelLike.join(", "));
});

t("main.js 保持安全基线：contextIsolation=true、nodeIntegration=false、请求拦截", () => {
  // 用原文检查：main.js 里 "http:/*" 这类字符串会让粗粒度的“去注释”正则把后面代码吞掉（自检实测）
  const code = read("src/main.js");
  assert.ok(/contextIsolation:\s*true/.test(code), "contextIsolation 必须 true");
  assert.ok(/nodeIntegration:\s*false/.test(code), "nodeIntegration 必须 false");
  assert.ok(/webRequest\.onBeforeRequest/.test(code), "必须拦截外部请求（离线硬需求）");
});

/* ------------------------------------------------------------------ 文档 */

t("docs/architecture.md 存在，且 README 指向它", () => {
  assert.ok(exists("docs/architecture.md"), "应有 docs/architecture.md");
  const readme = read("README.md");
  assert.ok(/docs\/architecture\.md/.test(readme), "README 应链接 docs/architecture.md");
});

console.log("\n" + "=".repeat(64));
console.log(`T114（架构分层与唯一实现）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const name of failures) console.log("  - " + name);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
