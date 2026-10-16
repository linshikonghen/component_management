"use strict";
/**
 * test_nfr.js — T27：**非功能需求实测**（spec NFR-2 / NFR-3 / NFR-4 / NFR-5）
 *
 * 运行： node tests/test_nfr.js
 *
 * 为什么单独一个套件：此前的 21 个套件都在验"功能对不对"，**性能与健壮性从来没实测过**——
 * spec 里 NFR-2（1000 条即时响应）、NFR-3（200 行 BOM 5 秒内解析）是有明确指标的要求，
 * 只"看着像是对的"不算验过。这里做四件事：
 *
 *   NFR-2  造 1000 条器件，实测列表/搜索/筛选/排序的耗时（并打印实测值）
 *   NFR-3  **合成**一份 200 行列头合规的 BOM，实测 `bom:parse` 耗时
 *   NFR-4  各类非法输入必须**全被拒绝且三个数据文件字节不变**（不是"看着还对"）
 *   NFR-5  危险操作（删除/恢复/改数据目录）未确认时一律拒绝、数据不动
 *
 * 阈值取"明显宽于实测量级"的保守值：目的是**挡住数量级退化**（比如某次改动让列表变成 O(n²)），
 * 而不是卡到毫秒。实测值一并打印，便于人工判断"无明显卡顿"。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");
const exporter = require("../src/services/exporter");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_nfr_"));

/** NFR-2 的单次调用上限（毫秒）。1000 条量级下实测在个位数~几十毫秒，这里留足余量挡数量级退化 */
const LIST_BUDGET_MS = 300;
/** NFR-3：spec 原文就是 5 秒 */
const PARSE_BUDGET_MS = 5000;

let passCount = 0;
const failures = [];
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

/* --------------------------------------------------------------- 工具 */

function freshEnv(name) {
  const base = path.join(TMP, name);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers };
}

/** 直接写库（不经过 IPC）——本套件关心的是查询/解析性能，不需要 1000 次入库的额外开销 */
function seedParts(db, count) {
  const parts = [];
  for (let i = 1; i <= count; i += 1) {
    const n = String(i).padStart(4, "0");
    parts.push({
      id: `p_${n}`,
      category: i % 2 === 0 ? "C" : "R",
      value: i % 2 === 0 ? `${i}nF` : `${i}k`,
      footprint: i % 3 === 0 ? "C0603" : (i % 3 === 1 ? "R0603" : "C1210"),
      voltage: `${(i % 5) * 10 + 10}V`,
      dielectric: i % 2 === 0 ? "X7R" : "",
      tolerance: "±10%",
      quantity: i % 50,
      min_quantity: null,
      location: `A-${String(i % 40).padStart(2, "0")}`,
      mpn_list: [],
      created_at: "2026-10-15T10:00:00+08:00",
      updated_at: "2026-10-15T10:00:00+08:00",
    });
  }
  db.saveParts(parts);
  return parts;
}

/** 合成一份 200 行、列头合规的 BOM（用自写导出器写 xlsx，列名取 spec §4.1 的十列） */
function makeBigBom(file, rows) {
  const header = ["No.", "Quantity", "Comment", "Designator", "Footprint", "Value",
    "Manufacturer Part", "Manufacturer", "Supplier Part", "Supplier"];
  const data = [header];
  for (let i = 1; i <= rows; i += 1) {
    data.push([
      i, 2, `${i}nF/50V X7R ±10%`, `C${i * 2 - 1},C${i * 2}`, "C0603",
      `${i}nF`, `MPN-${i}`, "FH(风华)", `C${100000 + i}`, "LCSC",
    ]);
  }
  exporter.writeXlsx(file, { sheet_name: "BOM", rows: data, date: new Date(2026, 9, 15) });
  return file;
}

function snapshot(db) {
  return {
    parts: fs.readFileSync(db.paths().parts),
    movements: fs.existsSync(db.paths().movements) ? fs.readFileSync(db.paths().movements) : Buffer.from(""),
    settings: fs.existsSync(db.paths().settings) ? fs.readFileSync(db.paths().settings) : Buffer.from(""),
  };
}

function assertUnchanged(db, before, what) {
  const after = snapshot(db);
  for (const key of ["parts", "movements", "settings"]) {
    assert.ok(before[key].equals(after[key]), `${what}：${key} 变了（出错时不得改动已有数据，NFR-4）`);
  }
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { value, ms };
}

/* ==================================================== NFR-2 */

section("NFR-2：1000 条以内的库，搜索/筛选即时响应");

let bigEnv = null;
let bigParts = null;

t("造 1000 条器件（直接写库）", () => {
  bigEnv = freshEnv("big");
  bigParts = seedParts(bigEnv.db, 1000);
  assert.strictEqual(bigEnv.db.loadParts().length, 1000);
  const bytes = fs.statSync(bigEnv.db.paths().parts).size;
  console.log(`        （parts.json ${(bytes / 1024).toFixed(1)} KB，1000 条）`);
});

t("全量列表 ≤ " + LIST_BUDGET_MS + "ms", async () => {
  const { value, ms } = await timed(() => bigEnv.handlers["parts:list"]({ query: {} }));
  assert.strictEqual(value.parts.length, 1000);
  assert.ok(ms <= LIST_BUDGET_MS, `全量列表 ${ms.toFixed(1)}ms 超过 ${LIST_BUDGET_MS}ms`);
  console.log(`        （全量列表：${ms.toFixed(1)} ms）`);
});

t("关键字搜索 ≤ " + LIST_BUDGET_MS + "ms", async () => {
  // 用**真实存在**的值去搜（第一版我写死「123nF」，而 123 是奇数、值是 "123k"，白搜一场）
  const needle = bigParts[499].value; // 第 500 条：偶数 → "500nF"
  const { value, ms } = await timed(() => bigEnv.handlers["parts:list"]({ query: { q: needle } }));
  assert.ok(value.parts.length >= 1, `应能搜到「${needle}」`);
  assert.ok(ms <= LIST_BUDGET_MS, `搜索 ${ms.toFixed(1)}ms 超过 ${LIST_BUDGET_MS}ms`);
  console.log(`        （搜「${needle}」命中 ${value.parts.length} 条：${ms.toFixed(1)} ms）`);
});

t("按封装筛选 ≤ " + LIST_BUDGET_MS + "ms", async () => {
  const { value, ms } = await timed(() => bigEnv.handlers["parts:list"]({ query: { footprint: "C0603" } }));
  assert.ok(value.parts.length > 300, "C0603 应有三成多");
  assert.ok(value.parts.every((p) => p.footprint === "C0603"), "筛选结果必须全对");
  assert.ok(ms <= LIST_BUDGET_MS, `筛选 ${ms.toFixed(1)}ms 超过 ${LIST_BUDGET_MS}ms`);
  console.log(`        （筛 C0603 得 ${value.parts.length} 条：${ms.toFixed(1)} ms）`);
});

t("排序 + 筛选组合 ≤ " + LIST_BUDGET_MS + "ms", async () => {
  const { value, ms } = await timed(() => bigEnv.handlers["parts:list"]({
    query: { footprint: "C0603", sort_by: "value", sort_dir: "desc" },
  }));
  const values = value.parts.map((p) => p.value);
  assert.deepStrictEqual(values, values.slice().sort().reverse(), "降序应真的有序");
  assert.ok(ms <= LIST_BUDGET_MS, `排序 ${ms.toFixed(1)}ms 超过 ${LIST_BUDGET_MS}ms`);
  console.log(`        （筛 C0603 + 值降序：${ms.toFixed(1)} ms）`);
});

t("低库存判定在 1000 条规模下也 ≤ " + LIST_BUDGET_MS + "ms（没退回 O(n²)）", async () => {
  const { value, ms } = await timed(() => bigEnv.handlers["parts:list"]({ query: {} }));
  assert.ok(Array.isArray(value.low_stock_ids), "应带回低库存 id");
  assert.ok(ms <= LIST_BUDGET_MS, `带判定的列表 ${ms.toFixed(1)}ms 超过 ${LIST_BUDGET_MS}ms`);
  console.log(`        （列表 + 低库存判定：${ms.toFixed(1)} ms，低库存 ${value.low_stock_ids.length} 条）`);
});

/* ==================================================== NFR-3 */

section("NFR-3：导入 200 行的 BOM 在 5 秒内完成解析");

t("合成 200 行 BOM → bom:parse ≤ " + PARSE_BUDGET_MS + "ms", async () => {
  const env = freshEnv("parse");
  const bomFile = makeBigBom(path.join(TMP, "big200.xlsx"), 200);
  assert.ok(fs.existsSync(bomFile), "合成 BOM 应已写出");

  const { value, ms } = await timed(() => env.handlers["bom:parse"]({ file_path: bomFile, sets: 1 }));
  assert.strictEqual(value.ok, true, value.error);
  assert.strictEqual(value.items.length, 200, "应解析出 200 条（不是少几条）");
  assert.ok(ms <= PARSE_BUDGET_MS, `解析 200 行用了 ${ms.toFixed(1)}ms，超过 ${PARSE_BUDGET_MS}ms`);
  console.log(`        （200 行解析：${ms.toFixed(1)} ms，${value.items.length} 条）`);
});

t("同一份 200 行 BOM 做比对也 ≤ " + PARSE_BUDGET_MS + "ms", async () => {
  const env = freshEnv("cmp");
  seedParts(env.db, 500);
  const bomFile = path.join(TMP, "big200.xlsx");
  const { value, ms } = await timed(() => env.handlers["compare:run"]({ file_path: bomFile, sets: 1 }));
  assert.strictEqual(value.ok, true, value.error);
  assert.strictEqual(value.stats.total, 200);
  assert.ok(ms <= PARSE_BUDGET_MS, `比对 200 行用了 ${ms.toFixed(1)}ms`);
  console.log(`        （200 行 × 500 条库比对：${ms.toFixed(1)} ms；缺料 ${value.stats.shortfall}）`);
});

/* ==================================================== NFR-4 */

section("NFR-4：任何操作出错时不损坏已有数据");

t("各类非法输入全部被拒绝，且三个数据文件**字节不变**", async () => {
  const env = freshEnv("nfr4");
  await env.handlers["parts:save"]({ part: { value: "10uF", footprint: "C1210", quantity: 20 } });
  const parsed = await env.handlers["bom:parse"]({
    file_path: path.join(__dirname, "fixtures", "sample_bom"), sets: 1,
  });
  assert.strictEqual(parsed.ok, true, parsed.error);

  const before = snapshot(env.db);
  const attempts = [
    ["坏 batch_id 入库", () => env.handlers["bom:commit"]({ batch_id: "batch_不存在", items: parsed.items, sets: 1 })],
    ["非法出库（负数超库存）", () => env.handlers["stock:move"]({ part_id: "p_0001", delta: -9999, reason: "x" })],
    ["缺原因的出入库", () => env.handlers["stock:move"]({ part_id: "p_0001", delta: 5 })],
    ["非法阈值", () => env.handlers["settings:set"]({ settings: { default_min_quantity: { C: "abc" } } })],
    ["未知设置项", () => env.handlers["settings:set"]({ settings: { 不存在: 1 } })],
    ["缺必填的手动录入", () => env.handlers["parts:save"]({ part: { quantity: 1 } })],
    ["未确认删器件", () => env.handlers["parts:delete"]({ part_id: "p_0001", confirm: false })],
    ["未确认改数据目录", () => env.handlers["settings:set"]({ settings: { data_dir: path.join(TMP, "nope") } })],
    ["未确认恢复备份", () => env.handlers["data:restore"]({ file_path: path.join(TMP, "nope"), confirm: false })],
    ["解析不存在的文件", () => env.handlers["bom:parse"]({ file_path: path.join(TMP, "没有这个文件.xlsx"), sets: 1 })],
    ["非法套数", () => env.handlers["bom:parse"]({ file_path: path.join(TMP, "big200.xlsx"), sets: 0 })],
    ["不存在的对比号导出", () => env.handlers["compare:export"]({ compare_id: "compare_不存在", mode: "lcsc" })],
  ];

  const rejected = [];
  for (const [name, fn] of attempts) {
    const r = await fn();
    assert.strictEqual(r.ok, false, `${name} 竟然成功了（应当被拒绝）`);
    rejected.push(`${name}: ${String(r.error || "").slice(0, 24)}…`);
    assertUnchanged(env.db, before, name);
  }
  console.log(`        （${attempts.length} 类非法输入全部被拒且数据字节不变）`);
  for (const line of rejected.slice(0, 4)) console.log(`          · ${line}`);
});

/* ==================================================== NFR-5 */

section("NFR-5：危险操作需二次确认（未确认时数据不动）");

t("删除器件 / 恢复备份 / 改数据目录 三条路径都要显式确认", async () => {
  const env = freshEnv("nfr5");
  const saved = await env.handlers["parts:save"]({ part: { value: "1k", footprint: "R0603", quantity: 9 } });
  const backupDir = path.join(TMP, "nfr5-bak");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = await env.handlers["data:backup"]({ dir_path: backupDir });
  const before = snapshot(env.db);

  const cases = [
    ["删除（不带 confirm）", await env.handlers["parts:delete"]({ part_id: saved.part.id, confirm: false })],
    ["恢复（不带 confirm）", await env.handlers["data:restore"]({ file_path: backup.backup_path, confirm: false })],
    ["改数据目录（不带 confirm_data_dir）", await env.handlers["settings:set"]({ settings: { data_dir: "D:\\别处" } })],
  ];
  for (const [name, r] of cases) {
    assert.strictEqual(r.ok, false, `${name} 应被拒绝`);
    assert.ok(/确认/.test(String(r.error)), `${name} 的报错应说清"需要确认"：${r.error}`);
    assertUnchanged(env.db, before, name);
  }
  // 反证：带确认时删除是真的生效的（否则"拒绝"可能只是因为功能坏了）
  const done = await env.handlers["parts:delete"]({ part_id: saved.part.id, confirm: true });
  assert.strictEqual(done.ok, true, done.error);
  assert.strictEqual(env.db.loadParts().length, 0, "带确认后应真的删掉");
  console.log("        （三条路径未确认均被拒且数据字节不变；带确认后删除确实生效）");
});

/* ==================================================== 其余 NFR 的归属 */

section("其余 NFR 由谁覆盖（不重复造轮子）");

t("NFR-1 / NFR-6 / NFR-7 的覆盖情况登记", () => {
  // NFR-1（启动 3 秒可见）：本环境起不了 Electron → 待人工（T11 的 smoke 判定逻辑已有测试）
  // NFR-6（中文术语）：界面文案与导出列名，由各套件与验收表覆盖
  // NFR-7（离线可用）：由验收套件的离线静态审计覆盖
  const acceptance = fs.readFileSync(path.join(__dirname, "test_acceptance_full.js"), "utf8");
  assert.ok(/connect-src 'none'/.test(acceptance), "NFR-7 的离线审计应在验收套件里");
  assert.ok(/webRequest\.onBeforeRequest/.test(acceptance), "运行时拦截也应在验收套件里");
  console.log("        （NFR-1 待人工（需真桌面）；NFR-6/7 由 test_acceptance_full.js 覆盖）");
});

/* ---------------------------------------------------------------- */

runQueue().then(() => {
  console.log("\n" + "=".repeat(64));
  console.log(`T27（NFR 实测）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  console.log(`  预算：列表类 ≤ ${LIST_BUDGET_MS}ms ｜ 解析类 ≤ ${PARSE_BUDGET_MS}ms（spec NFR-3 原文）`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }
});
