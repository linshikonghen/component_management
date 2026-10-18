"use strict";
/**
 * test_compare_model.js — T13（plan §9 的 T9）验收测试：比对结果页的规则 + 端到端导出
 *
 * 运行： node tests/test_compare_model.js
 *
 * 三块：
 *   §1~§4 规则（分组、汇总、缺口合计、采购提示、导出校验）—— AC-2 的界面口径
 *   §5    **FR-7.6 入口隔离的代码级断言**：比对页里根本没有领料那条代码路径
 *   §6    端到端：compare:run → compare:export → 文件可读、只含缺料、**库文件字节不变**
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const model = require("../renderer/model/compare_model.js");
const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");
const bp = require("../src/services/bom_parser");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_cmpmodel_"));

const QUEUE = [];
function t(name, fn) { QUEUE.push({ kind: "test", name, fn }); }
function section(title) { QUEUE.push({ kind: "section", title }); }
let passCount = 0;
const failures = [];

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

const STATS = { total: 33, enough: 5, shortfall: 28, uncertain: 0, no_stock: 20, insufficient: 8 };

function shortfallItem(over = {}) {
  return Object.assign({
    row_no: 1, value: "10uF", footprint: "C1210",
    required_quantity: 24, stock_quantity: 3, shortfall_quantity: 21,
  }, over);
}

/* ================================================== §1 三类分组（FR-2.3） */

section("§1 分组只有三类（spec FR-2.3，不得自创第四类）");

t("分组键与中文标签照 spec：够用 / 缺料 / 疑似", () => {
  assert.deepStrictEqual(model.GROUPS.map((g) => g.key), ["enough", "shortfall", "uncertain"]);
  assert.deepStrictEqual(model.GROUPS.map((g) => g.label), ["够用", "缺料", "疑似"]);
  assert.strictEqual(model.groupLabel("shortfall"), "缺料");
  assert.strictEqual(model.groupLabel("不存在"), "不存在", "未知键原样返回，不编一个中文名");
});

t("导出模式两种，键名与 compare:export 的 mode 一致", () => {
  assert.deepStrictEqual(model.MODES.map((m) => m.key), ["lcsc", "jlc"]);
  assert.strictEqual(model.modeOf("jlc").filePrefix, "嘉立创SMT");
  assert.strictEqual(model.modeOf("不存在").key, "lcsc", "未知模式落默认（立创配单）");
});

/* ============================================ §2 汇总与缺口合计（AC-2） */

section("§2 汇总行与缺料合计");

t("汇总行给出四类条数", () => {
  assert.strictEqual(model.summaryLine(STATS), "共 33 条 · 够用 5 · 缺料 28 · 疑似 0");
  assert.strictEqual(model.summaryLine({}), "共 0 条 · 够用 0 · 缺料 0 · 疑似 0");
});

t("**缺料合计 = Σ缺口**（不是 Σ需求——那是旧语义的错法）", () => {
  const items = [
    shortfallItem({ required_quantity: 24, stock_quantity: 3, shortfall_quantity: 21 }),
    shortfallItem({ row_no: 2, required_quantity: 10, stock_quantity: 0, shortfall_quantity: 10 }),
  ];
  assert.strictEqual(model.shortfallTotal(items), 31);
  assert.strictEqual(model.requiredTotal(items), 34);
  assert.strictEqual(model.stockTotal(items), 3);
  assert.notStrictEqual(model.shortfallTotal(items), model.requiredTotal(items),
    "把需求当缺口就会多买");
});

t("数量列取的是缺口字段（spec §4.2 的 purchase_quantity）", () => {
  assert.strictEqual(model.PURCHASE_FIELD, "shortfall_quantity");
  assert.strictEqual(model.quantityLine(shortfallItem()), "需求 24 · 库存 3 · 缺口 21");
});

/* ============================================ §3 采购提示（AC-2 边界） */

section("§3 采购提示：缺料为 0 时明确说「无需采购」");

t("缺料 0 → 无需采购（不是给一张空表）", () => {
  const msg = model.purchaseMessage({ total: 33, enough: 33, shortfall: 0, uncertain: 0 });
  assert.ok(/无需采购/.test(msg), msg);
});

t("有缺料时给出细分：库中没有 / 库存不足 / 疑似", () => {
  const msg = model.purchaseMessage({ total: 33, shortfall: 28, no_stock: 20, insufficient: 8, uncertain: 3 });
  assert.ok(/需采购 28 种/.test(msg), msg);
  assert.ok(/库中没有 20 种/.test(msg), msg);
  assert.ok(/库存不足 8 种/.test(msg), msg);
  assert.ok(/疑似需人工确认/.test(msg), msg);
});

/* ==================================================== §4 导出校验 */

section("§4 导出请求校验（FR-2.4 只导缺料 / FR-2.8 默认名含时间戳）");

t("有缺料 → 允许导出", () => {
  assert.strictEqual(model.canExport({ stats: STATS }).ok, true);
});

t("缺料 0 且有疑似、未勾选 → **阻止导出空表**并告诉用户怎么改", () => {
  const verdict = model.canExport({ stats: { shortfall: 0, uncertain: 3 }, include_uncertain: false });
  assert.strictEqual(verdict.ok, false);
  assert.ok(/勾选/.test(verdict.reason), verdict.reason);
});

t("缺料 0 + 勾选疑似 → 允许，但说明「这次导的是疑似」", () => {
  const verdict = model.canExport({ stats: { shortfall: 0, uncertain: 3 }, include_uncertain: true });
  assert.strictEqual(verdict.ok, true);
  assert.ok(/疑似/.test(verdict.reason), verdict.reason);
});

t("缺料 0 且无疑似 → 阻止（导出会是只有表头的空表）", () => {
  const verdict = model.canExport({ stats: { shortfall: 0, uncertain: 0 }, include_uncertain: true });
  assert.strictEqual(verdict.ok, false);
  assert.ok(/空表/.test(verdict.reason), verdict.reason);
});

t("buildExportRequest：缺 compare_id / 非法 mode 一律拒绝", () => {
  assert.strictEqual(model.buildExportRequest({ stats: STATS }).ok, false);
  assert.ok(/compare_id/.test(model.buildExportRequest({ stats: STATS }).error));
  const badMode = model.buildExportRequest({ compare_id: "compare_x", mode: "eda", stats: STATS });
  assert.strictEqual(badMode.ok, false);
  assert.ok(/lcsc \/ jlc/.test(badMode.error), badMode.error);
});

t("文件名留空 → 请求里不带 output_path（由主进程用默认名）", () => {
  const built = model.buildExportRequest({ compare_id: "compare_x", stats: STATS, output_path: "   " });
  assert.strictEqual(built.ok, true, built.error);
  assert.ok(!Object.prototype.hasOwnProperty.call(built.request, "output_path"), "留空不该塞空字符串进去");
  const named = model.buildExportRequest({ compare_id: "compare_x", stats: STATS, output_path: "我的单子.xlsx" });
  assert.strictEqual(named.request.output_path, "我的单子.xlsx");
});

t("默认文件名含时间戳（FR-2.8）", () => {
  const when = new Date(2026, 9, 15, 10, 0, 0);
  assert.strictEqual(model.defaultFileName("lcsc", when), "立创配单_20261015_100000.xlsx");
  assert.strictEqual(model.defaultFileName("jlc", when), "嘉立创SMT_20261015_100000.xlsx");
});

t("疑似原因说人话（缺什么字段就说什么）", () => {
  assert.strictEqual(model.uncertainReason({ missing_fields: ["tolerance"] }), "BOM 缺 容差，无法精确判定");
  assert.ok(/耐压、材质/.test(model.uncertainReason({ missing_fields: ["voltage", "dielectric"] })));
  assert.ok(/相似条目/.test(model.uncertainReason({ missing_fields: [] })));
});

/* ========================================= §5 FR-7.6 入口隔离（代码级） */

section("§5 FR-7.6：比对页禁放领料入口 —— 用「有没有那条代码路径」来断言");

function readIfExists(rel) {
  const full = path.join(PROJECT_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

/** 先剥注释再扫：注释里写「本文件不得出现 stockPickByBom」是**说明**，不是能力。
 *  （这个坑在 T7/T8/T11 已经栽过三次，这里统一先剥。） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

t("比对页与比对模型里**不出现领料通道**（stock:pick_by_bom / stockPickByBom）", () => {
  for (const rel of ["renderer/pages/compare_report.js", "renderer/model/compare_model.js"]) {
    const src = readIfExists(rel);
    assert.ok(src.length > 0, "文件不存在：" + rel);
    const code = stripComments(src);
    assert.ok(!/stock:pick_by_bom|stockPickByBom|pickByBom/.test(code),
      `${rel} 的**代码**里出现了领料通道引用——比对页必须是只读入口（FR-7.6）`);
    // 反证：剥注释后仍应能扫到 IPC 调用（免得把文件剥空了还判通过）
    assert.ok(/ComparePage|CompareModel|call\(/.test(code), "扫描前处理有误：源码像被清空了");
  }
});

t("比对页也不调用出/入库通道（stock:move），避免顺手写库", () => {
  const src = readIfExists("renderer/pages/compare_report.js");
  assert.ok(!/stock:move|stockMove/.test(src), "比对页不得出现 stock:move 引用");
});

t("比对页只允许调用这几个通道（新增通道必须在此登记用途）", () => {
  const src = readIfExists("renderer/pages/compare_report.js");
  const calls = [...src.matchAll(/call\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "没解析到 IPC 调用，检查写法是否变了");
  const allowed = new Set([
    "bomPickFiles", // 选 BOM（只读）
    "compareRun", // 比对 + 人工裁决/人工匹配（只重分组，不写库）
    "compareExport", // 导出（只写用户指定文件）
    "partsList", // v2.2 人工匹配的器件选择器（只读）
    "compareSyncFields", // v2.2 唯一可写库的通道：人工匹配后同步判定键字段（confirm=true 才写）
  ]);
  for (const name of calls) {
    assert.ok(allowed.has(name), `比对页调用了未授权的通道：${name}（只允许 ${[...allowed].join(" / ")}）`);
  }
  // 写库通道在页面里必须"预览一次（confirm:false）+ 确认后才写（confirm:true）"——两层闸门的前端一半
  assert.ok(/compareSyncFields/.test(src) && /confirm:\s*false/.test(src) && /confirm:\s*true/.test(src),
    "compareSyncFields 必须同时有预览调用与确认调用");
  console.log(`        （比对页实际调用：${[...new Set(calls)].join(" / ")}）`);
});

t("渲染进程禁令：比对页无 require / fetch / 远程资源", () => {
  const src = stripComments(readIfExists("renderer/pages/compare_report.js"));
  assert.ok(!/require\s*\(/.test(src), "渲染进程不得 require");
  assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(src), "渲染进程不得联网");
});

/* ========================================== §6 端到端（真实 BOM） */

section("§6 端到端：compare:run → compare:export（AC-2 / AC-8 内部一级）");

let envNo = 0;
function freshEnv() {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers, base };
}

t("空库比对 → 33 条全缺料；导出立创配单 34 行，数量列合计 = Σ缺口", async () => {
  const { handlers, base } = freshEnv();
  const run = await handlers["compare:run"]({ file_path: MAIN_BOM, sets: 1 });
  assert.strictEqual(run.ok, true, run.error);
  assert.strictEqual(run.stats.shortfall, 33);
  assert.deepStrictEqual(run.enough, []);

  const built = model.buildExportRequest({ compare_id: run.compare_id, mode: "lcsc", stats: run.stats });
  assert.strictEqual(built.ok, true, built.error);
  const exported = await handlers["compare:export"](built.request);
  assert.strictEqual(exported.ok, true, exported.error);
  assert.strictEqual(exported.exported_count, 33);
  assert.ok(fs.existsSync(exported.file_path), exported.file_path);

  const rows = bp.readTableRows(exported.file_path).rows;
  assert.deepStrictEqual(rows[0], ["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"]);
  assert.strictEqual(rows.length, 34, "1 行表头 + 33 行缺料");
  const qtySum = rows.slice(1).reduce((s, row) => s + Number(row[6]), 0);
  assert.strictEqual(qtySum, model.shortfallTotal(run.shortfall), "导出数量列合计 = 界面显示的缺料合计");
});

t("库里都有 → 缺料 0，界面阻止导出空表（AC-2 边界）", async () => {
  const { handlers } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  const run = await handlers["compare:run"]({ file_path: MAIN_BOM, sets: 1 });
  assert.strictEqual(run.stats.shortfall, 0);
  assert.strictEqual(model.canExport({ stats: run.stats, include_uncertain: false }).ok, false);
  assert.ok(/无需采购/.test(model.purchaseMessage(run.stats)));
});

t("**比对与导出全程只读**：库里文件字节不变（FR-2.5 在界面流程里的复核）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });

  const partsBefore = fs.readFileSync(db.paths().parts);
  const movesBefore = fs.readFileSync(db.paths().movements);

  const run = await handlers["compare:run"]({ file_path: MAIN_BOM, sets: 3 });
  const built = model.buildExportRequest({ compare_id: run.compare_id, mode: "jlc", stats: run.stats });
  await handlers["compare:export"](built.request);

  assert.ok(partsBefore.equals(fs.readFileSync(db.paths().parts)), "parts.json 必须字节级不变");
  assert.ok(movesBefore.equals(fs.readFileSync(db.paths().movements)), "movements.json 必须字节级不变");
});

t("疑似行要标清\"疑似的是什么\"：库里候选一句话身份 + 原因写明候选那边的值", () => {
  assert.strictEqual(
    model.candidateText({
      candidate_value: "10uF", candidate_footprint: "1210", candidate_voltage: "",
      candidate_tolerance: "±10%", candidate_part_number: "M1", stock_quantity: 999,
    }),
    "10uF / 1210 / ±10%（M1，库存 999）",
  );
  // 没有候选值时不报空：给兜底文案
  assert.ok(/候选器件字段为空/.test(model.candidateText({ stock_quantity: 0 })));

  // 原有"缺什么字段"文案保持不变（已有测试的兼容）
  assert.strictEqual(model.uncertainReason({ missing_fields: ["tolerance"] }), "BOM 缺 容差，无法精确判定");
  // 有候选快照时补上"库里候选那边是什么"
  assert.strictEqual(
    model.uncertainReason({ missing_fields: ["tolerance"], candidate_tolerance: "±10%" }),
    "BOM 缺 容差（库里候选：容差「±10%」），无法精确判定",
  );
});

t("人工匹配的界面规则：哪些缺料行可以匹配、状态文案、字段同步预览文案", () => {
  // 可匹配：库里没这颗（none）/ 疑似被否定（confirmed_different）
  assert.strictEqual(model.isManualMatchable({ match_reason: "none" }), true);
  assert.strictEqual(model.isManualMatchable({ match_reason: "confirmed_different" }), true);
  // 不可匹配：已匹配上只是库存不足 / 已经人工匹配过 / 疑似未裁决
  for (const reason of ["exact", "mpn", "confirmed_same", "manual_match", "partial"]) {
    assert.strictEqual(model.isManualMatchable({ match_reason: reason }), false, reason + " 不应给人工匹配入口");
  }
  // 状态文案
  assert.strictEqual(model.decisionText({ match_reason: "confirmed_same" }), "已确认：同一颗");
  assert.strictEqual(model.decisionText({ match_reason: "confirmed_different" }), "已确认：不是同一颗");
  assert.strictEqual(model.decisionText({ match_reason: "manual_match" }), "已手动匹配");
  assert.strictEqual(model.decisionText({ match_reason: "none" }), "");
  // 取判定键五字段（BOM 侧值；null → 空串）
  assert.deepStrictEqual(
    model.keyFieldsOf({ value: "10uF", footprint: "C1210", voltage: null, dielectric: "X7R", tolerance: "±10%" }),
    { value: "10uF", footprint: "C1210", voltage: "", dielectric: "X7R", tolerance: "±10%" },
  );
  // 同步预览逐行文案（空值显示"（空）"）
  assert.deepStrictEqual(
    model.formatFieldChanges([
      { field: "value", from: "10uF", to: "100nF" },
      { field: "voltage", from: "", to: "50V" },
    ]),
    ["值：「10uF」→「100nF」", "耐压：「（空）」→「50V」"],
  );
  assert.deepStrictEqual(model.formatFieldChanges(null), []);
  assert.strictEqual(
    model.manualMatchText({
      match_reason: "manual_match",
      candidate_value: "10uF", candidate_footprint: "1210", stock_quantity: 4,
    }),
    "已手动匹配：10uF / 1210（库存 4）",
  );
});

/* ------------------------------------------------------------------ 执行 */

runQueue().then(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T13（比对页规则与导出）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
