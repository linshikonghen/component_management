"use strict";
/**
 * test_ids.js — T25：运行号 / 时间戳 / 顺序 id 的**唯一实现**（`src/services/ids.js`）
 *
 * 运行： node tests/test_ids.js
 *
 * 为什么值得单独一个套件：这几段逻辑此前在 6 处各写了一份（见 ids.js 顶部注释）。
 * 合并之后要保证两件事：
 *   ① **格式没变**——`batch_20261015_100000` 这类形态是 plan §3.2 写死的，改了会破坏与其他模块的约定；
 *   ② **真的只有一份**——用源码扫描断言"没有第二处自己拼时间戳"，否则合并随时会被抄回去。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ids = require("../src/services/ids");
const bomParser = require("../src/services/bom_parser");
const compare = require("../src/services/compare");
const { createStore } = require("../src/services/store");
const { createHandlers } = require("../src/ipc/handlers");

const ROOT = path.resolve(__dirname, "..");
const WHEN = new Date(2026, 9, 15, 10, 0, 0); // 2026-10-15 10:00:00 本地时间

let passCount = 0;
const failures = [];

/**
 * **用例排队后统一 await**（T11 的教训：同步 runner 遇到 async 用例会得到"假 PASS"——
 * 用例还没跑完就先打印 PASS，之后的失败变成 unhandled rejection 把进程搞崩）。
 */
const QUEUE = [];
function t(name, fn) { QUEUE.push({ kind: "test", name, fn }); }
function section(title) { QUEUE.push({ kind: "section", title }); }
async function runQueue() {
  for (const item of QUEUE) {
    if (item.kind === "section") { console.log("\n=== " + item.title + " ==="); continue; }
    try {
      await item.fn();
      passCount += 1;
      console.log("  PASS  " + item.name);
    } catch (exc) {
      failures.push({ name: item.name, message: String(exc && exc.message ? exc.message : exc) });
      console.log("  FAIL  " + item.name);
      console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
    }
  }
}

/* ==================================================== §1 格式（不许变） */

section("§1 格式：时间戳与运行号（plan §3.2 的形态）");

t("stamp 是 YYYYMMDD_HHMMSS，本地时间", () => {
  assert.strictEqual(ids.stamp(WHEN), "20261015_100000");
  assert.strictEqual(ids.stamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102_030405");
  assert.strictEqual(ids.stamp(new Date(2026, 11, 31, 23, 59, 59)), "20261231_235959");
});

t("makeRunId：前缀 + 戳（batch / compare / pick 同形态）", () => {
  assert.strictEqual(ids.makeRunId("batch", WHEN), "batch_20261015_100000");
  assert.strictEqual(ids.makeRunId("compare", WHEN), "compare_20261015_100000");
  assert.strictEqual(ids.makeRunId("pick", WHEN), "pick_20261015_100000");
});

t("nextSequentialId：按现有最大号 +1，补零 4 位", () => {
  assert.strictEqual(ids.nextSequentialId("p", []), "p_0001");
  assert.strictEqual(ids.nextSequentialId("p", [{ id: "p_0001" }]), "p_0002");
  assert.strictEqual(ids.nextSequentialId("p", [{ id: "p_0001" }, { id: "p_0009" }, { id: "x" }]), "p_0010");
  assert.strictEqual(ids.nextSequentialId("m", [{ id: "m_9999" }]), "m_10000", "超过 4 位不再截断");
  assert.strictEqual(ids.nextSequentialId("p", null), "p_0001", "空值也要能算");
});

t("nextPartId 就是 p_ 前缀的序 id", () => {
  assert.strictEqual(ids.nextPartId([{ id: "p_0007" }]), "p_0008");
});

/* ==================================================== §2 各处都走同一实现 */

section("§2 四个调用方（解析 / 比对 / 存储 / IPC）产出的号必须**同源**");

t("bom_parser.makeBatchId == ids.makeRunId('batch')", () => {
  assert.strictEqual(bomParser.makeBatchId(WHEN), ids.makeRunId("batch", WHEN));
});

t("compare.makeCompareId == ids.makeRunId('compare')", () => {
  assert.strictEqual(compare.makeCompareId(WHEN), ids.makeRunId("compare", WHEN));
});

t("store 的备份目录名用的是同一个戳", () => {
  const base = path.join(require("os").tmpdir(), "cm_ids_" + process.pid);
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  const store = createStore({ base_dir: base });
  const target = store.backupTo(path.join(base, "bak"), { now: WHEN });
  assert.ok(path.basename(target).endsWith(ids.stamp(WHEN)), "备份目录名应含同一个戳：" + path.basename(target));
  fs.rmSync(base, { recursive: true, force: true });
});

t("IPC 层的运行号与导出默认名用的是同一个戳", () => {
  const { makeRunId, defaultExportName } = require("../src/ipc/handlers");
  assert.strictEqual(makeRunId("pick", WHEN), ids.makeRunId("pick", WHEN));
  assert.strictEqual(defaultExportName("lcsc", WHEN), `立创配单_${ids.stamp(WHEN)}.xlsx`);
  assert.strictEqual(defaultExportName("jlc", WHEN), `嘉立创SMT_${ids.stamp(WHEN)}.xlsx`);
  assert.strictEqual(defaultExportName("library", WHEN), `器件库_${ids.stamp(WHEN)}.xlsx`);
});

t("端到端：一次解析 + 一次比对，两个号的时间戳部分一致", async () => {
  const base = path.join(require("os").tmpdir(), "cm_ids_e2e_" + process.pid);
  fs.rmSync(base, { recursive: true, force: true });
  const store = createStore({ base_dir: base });
  const env = createHandlers({ store, pick_files: async () => [], now: () => WHEN });
  const parsed = await env.handlers["bom:parse"]({ file_path: path.join(__dirname, "fixtures", "sample_bom"), sets: 1 });
  assert.strictEqual(parsed.batch_id, "batch_20261015_100000");
  const run = await env.handlers["compare:run"]({ file_path: path.join(__dirname, "fixtures", "sample_bom"), sets: 1 });
  assert.strictEqual(run.compare_id, "compare_20261015_100000");
  fs.rmSync(base, { recursive: true, force: true });
});

/* ==================================================== §3 反重复（源码扫描） */

section("§3 源码扫描：不许再出现第二份自己拼时间戳的实现");

const SCAN_FILES = ["src/services/bom_parser.js", "src/services/compare.js", "src/services/parts.js",
  "src/services/inventory.js", "src/services/store.js", "src/ipc/handlers.js"];

function readCode(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

t("除 ids.js 外，没有任何文件自己拼 YYYYMMDD_HHMMSS", () => {
  const offenders = [];
  for (const rel of SCAN_FILES) {
    const code = readCode(rel);
    // 典型特征：取年份 + 手动补零拼下划线
    if (/getFullYear\(\)/.test(code) && /padStart\(\s*2/.test(code)) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [], "这些文件又抄了一份时间戳实现：" + offenders.join(", "));
  const own = readCode("src/services/ids.js");
  assert.ok(/getFullYear\(\)/.test(own), "反证：ids.js 里应该有这份实现");
});

t("除 ids.js 外，没有任何文件自己拼 `prefix_0001` 序 id", () => {
  const offenders = [];
  for (const rel of SCAN_FILES.concat(["src/services/low_stock.js", "src/services/export_format.js"])) {
    const code = readCode(rel);
    if (/new RegExp\(`\^\$\{prefix\}_/.test(code) || /`\$\{prefix\}_\$\{String\(max \+ 1\)/.test(code)) {
      offenders.push(rel);
    }
  }
  assert.deepStrictEqual(offenders, [], "这些文件又抄了一份序 id 实现：" + offenders.join(", "));
});

/* ---------------------------------------------------------------- */

runQueue().then(() => {
  console.log("\n" + "=".repeat(64));
  console.log(`T25（运行号/时间戳/id 唯一实现）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
