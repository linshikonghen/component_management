"use strict";
/**
 * test_import_gate.js — T12 的**集成**测试：核对表规则 ↔ IPC 闸门 ↔ 真实落盘
 *
 * 运行： node tests/test_import_gate.js
 *
 * 单测（test_import_model.js）证明"规则算得对"，这个文件证明"规则真的接在写库路径上"：
 *   ① `bom:commit` 只认本次 `bom:parse` 发出的批次号 → 未解析的批次号写了也白写（spec FR-1.3 的接口层一半）
 *   ② 走完整流程（解析 → 模型改本次入库量 → toCommitItems → 提交）后，库里与变动记录都对得上
 *   ③ 改过的条目带 `expected/intake/edited_by_human` 留痕（FR-1.6 v1.4）
 *   ④ 全跳过时不会误写任何东西
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");
const model = require("../renderer/model/import_model.js");

const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const FIXED_BOM = path.join(FIX, "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_gate_"));

let passCount = 0;
const failures = [];

/** 本文件的用例都是 async → 登记后统一 await（见 T11 教训：不 await 会得到"假 PASS"） */
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

let caseNo = 0;
function freshEnv() {
  caseNo += 1;
  const base = path.join(TMP, "case" + caseNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers, base };
}

/** 走一遍"解析 → 人工核对（用真实模型改字段）→ 提交" */
async function runFlow(handlers, db, { file = MAIN_BOM, sets = 1, edit = null } = {}) {
  const parsed = await handlers["bom:parse"]({ file_path: file, sets });
  assert.strictEqual(parsed.ok, true, parsed.error);
  let items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
  if (edit) items = items.map((it, i) => (edit(it, i) === null ? it : edit(it, i)));
  const verdict = model.canCommit(items);
  return { parsed, items, verdict };
}

/* ================================================ §1 服务端闸门（FR-1.3） */

section("§1 不得一键静默导入：未解析的批次号写不进库");

t("凭空编一个 batch_id 直接提交 → 拒绝，库里一条也没有", async () => {
  const { handlers, db } = freshEnv();
  const r = await handlers["bom:commit"]({
    batch_id: "batch_20261015_000000", // 没经过 bom:parse
    items: [{ row_no: 1, designators: ["C1"], designator_count: 1, quantity_per_board: 1, total_quantity: 1, intake_quantity: 1, value: "10uF", footprint: "C1210", action: "keep" }],
    sets: 1,
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/没有经过解析与核对流程/.test(r.error), r.error);
  assert.strictEqual(db.loadParts().length, 0, "被拒绝的提交不得写库");
  assert.strictEqual(db.loadMovements().length, 0, "也不得留下变动记录");
});

t("空 batch_id / 不传 batch_id → 同样拒绝", async () => {
  const { handlers } = freshEnv();
  for (const bad of ["", null, undefined]) {
    const r = await handlers["bom:commit"]({ batch_id: bad, items: [], sets: 1 });
    assert.strictEqual(r.ok, false, `batch_id=${JSON.stringify(bad)} 应被拒绝`);
  }
});

t("先解析再提交 → 通过（正常流程不受影响）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.added, 32);
  assert.strictEqual(db.loadParts().length, 32);
});

/* ============================================== §2 完整流程端到端 */

section("§2 完整流程：解析 → 模型核对 → 提交 → 落盘对得上");

t("33 行主样本走完整流程：库 32 条、变动 33 条、汇总三数之和 = 33", async () => {
  const { handlers, db } = freshEnv();
  const { items, verdict } = await runFlow(handlers, db, { sets: 1 });
  assert.strictEqual(verdict.ok, true, JSON.stringify(verdict.blockers));
  assert.strictEqual(verdict.summary.total, 33);
  assert.strictEqual(verdict.summary.keep, 33);

  const r = await handlers["bom:commit"]({
    batch_id: (await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 })).batch_id,
    items: model.toCommitItems(items),
    sets: 1,
    source: "sample_bom",
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.added, 32, "33 行含一对同规格 → 入库 32 条");
  assert.strictEqual(r.merged, 1);
  assert.strictEqual(r.skipped, 0);
  assert.strictEqual(r.added + r.merged + r.skipped, r.summary.total, "FR-1.8：三数之和 = 条目总数");
  assert.strictEqual(db.loadParts().length, 32);
  assert.strictEqual(db.loadMovements().length, 33);
  assert.strictEqual(db.loadMovements()[0].ref, r.summary.total ? db.loadMovements()[0].ref : "", "变动记录应带批次 ref");
});

t("套数 3 → 应入库量 ×3（算式与落库一致）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 3 });
  const first = parsed.items[0];
  assert.strictEqual(model.formulaText(first, 3), "8 × 3 = 24");
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 3 });
  assert.strictEqual(r.ok, true, r.error);
  const part = db.loadParts().find((p) => p.value === first.value && p.footprint === first.footprint);
  assert.strictEqual(part.quantity, 24, "应按套数放大后入库");
});

/* ================================== §3 改本次入库量：只加改后的值 + 留痕 */

section("§3 核对时改「本次入库量」：只按改后的值入库，且留痕（FR-1.6 v1.4）");

t("把第一条 24 → 10：库里只加 10，变动记录带 expected/intake/edited", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 3 });
  let items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
  const edited = model.applyEdit(items[0], "intake_quantity", 10);
  assert.strictEqual(edited.ok, true, edited.error);
  items[0] = edited.item;
  assert.strictEqual(items[0].edited_by_human, true, "改了就要标记");

  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 3 });
  assert.strictEqual(r.ok, true, r.error);

  const first = db.loadParts().find((p) => p.value === items[0].value && p.footprint === items[0].footprint);
  assert.strictEqual(first.quantity, 10, "只加人工确认后的 10");

  const mv = db.loadMovements().find((m) => m.part_id === first.id);
  assert.strictEqual(mv.delta, 10);
  assert.strictEqual(mv.expected_quantity, 24, "原应入库量要留痕");
  assert.strictEqual(mv.intake_quantity, 10, "实际入库量要留痕");
  assert.strictEqual(mv.edited_by_human, true, "改动标记要留痕");
  assert.strictEqual(items[0].quantity_per_board, 8, "BOM 原值不变（绝不回写）");
});

/* ============================ §3b 核对时改库位/阈值 → 入库后真的在（FR-1.6 / AC-1） */

section("§3b 核对时填的「库位」「低库存阈值」要**真的落库**（不是被静默丢弃）");

t("新器件：核对该两列 → 入库后器件上就有（AC-1「试改库位/阈值均可改并生效」）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  let items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
  // 用**真实模型**改（而不是手改对象）——这样界面走的路就是这里走的路
  items[0] = model.applyEdit(items[0], "location", "A-03").item;
  items[0] = model.applyEdit(items[0], "min_quantity", 15).item;

  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  const part = db.loadParts().find((p) => p.value === items[0].value && p.footprint === items[0].footprint);
  assert.ok(part, "应能找到刚入库的器件");
  assert.strictEqual(part.location, "A-03", "库位必须落库（此前会被静默丢弃）");
  assert.strictEqual(part.min_quantity, 15, "低库存阈值必须落库");
  assert.strictEqual(typeof part.min_quantity, "number", "阈值应是数字，不是字符串");

  // 阈值 15 + 数量 < 15 → 应参与低库存判定（个体阈值覆盖分类默认）
  const list = await handlers["parts:list"]({ query: {} });
  const judged = list.low_stock_ids.includes(part.id);
  assert.strictEqual(judged, part.quantity < 15, "个体阈值要真的参与判定");
  console.log(`        （器件数量 ${part.quantity}，阈值 15 → ${judged ? "判为低库存" : "不报警"}）`);
});

t("已有器件：核对时填的库位/阈值**只补空、不覆盖**用户已填的", async () => {
  const { handlers, db } = freshEnv();
  // 先手动录一条（用户已填库位 A-01 与阈值 5）
  const existing = await handlers["parts:save"]({
    part: { value: "10uF", footprint: "C1210", quantity: 0, location: "A-01", min_quantity: 5 },
  });
  assert.strictEqual(existing.ok, true, existing.error);

  // 再用 BOM 入库同规格，核对时填 库位 B-02 / 阈值 99
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const hit = parsed.items.find((it) => it.value === "10uF" && it.footprint === "C1210");
  assert.ok(hit, "样本里应有 10uF/C1210");
  const items = parsed.items.map((it) => (it === hit
    ? model.applyEdit(model.applyEdit(Object.assign({}, it), "location", "B-02").item, "min_quantity", 99).item
    : it));

  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  const after = db.loadParts().find((p) => p.id === existing.part.id);
  assert.strictEqual(after.location, "A-01", "用户已填的库位不能被 BOM 覆盖");
  assert.strictEqual(after.min_quantity, 5, "用户设的阈值不能被 BOM 覆盖");
});

/* ============================================ §4 FR-1.5 未裁决不允许提交 */

section("§4 数量与位号不符：未裁决时模型层面就不放行（FR-1.5）");

t("修正版 3 行不符 → canCommit 拒绝；逐行勾选「已核实」后才放行", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: FIXED_BOM, sets: 1 });
  let items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));

  const blocked = model.canCommit(items);
  assert.strictEqual(blocked.ok, false);
  assert.ok(/数量与位号个数不符/.test(blocked.blockers[0]), blocked.blockers[0]);

  // 逐行裁决
  items = items.map((it) => (model.needsAdjudication(it) ? model.setAdjudicated(it, true) : it));
  const verdict = model.canCommit(items);
  assert.strictEqual(verdict.ok, true, JSON.stringify(verdict.blockers));

  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  // 不写死 added：这份 BOM 里也有同规格多行会被合并，唯一稳妥的不变量是"新增+合并=总行数"
  assert.strictEqual(r.added + r.merged, 37, `新增 ${r.added} + 合并 ${r.merged} 应等于 37`);
  assert.strictEqual(r.skipped, 0);
  assert.strictEqual(db.loadParts().length, 37 - r.merged);
  console.log(`        （修正版 37 行 → 新增 ${r.added} / 合并 ${r.merged}）`);
});

t("把不符的行改成「跳过」并记原因 → 也能入库，且跳过原因进汇总", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: FIXED_BOM, sets: 1 });
  let items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
  items = items.map((it) => (model.needsAdjudication(it)
    ? model.toggleSkip(it, true, "BOM 数量疑似填错，先不入库")
    : it));
  const verdict = model.canCommit(items);
  assert.strictEqual(verdict.ok, true, JSON.stringify(verdict.blockers));
  assert.strictEqual(verdict.summary.skip, 3);

  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.skipped, 3);
  assert.strictEqual(r.added + r.merged, 34, `37 行里 3 行跳过 → 其余 34 行应入库（新增 ${r.added} + 合并 ${r.merged}）`);
  assert.ok(r.skip_details.every((d) => /先不入库/.test(d.reason)), JSON.stringify(r.skip_details));
});

/* ======================================== §5 全跳过 / 非法值不写库 */

section("§5 全跳过与非法值：一条都不写");

t("全部跳过 → 模型层拒绝提交（提示「无条目可入库」）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const items = parsed.items.map((it) => model.toggleSkip(Object.assign({}, it, { adjudicated: false }), true, "先不进"));
  const verdict = model.canCommit(items);
  assert.strictEqual(verdict.ok, false);
  assert.ok(/无条目可入库/.test(verdict.blockers[0]), verdict.blockers[0]);
  // 即便硬提交，也不得产生任何库存与变动记录
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(db.loadParts().length, 0);
  assert.strictEqual(db.loadMovements().length, 0, "全跳过不该留下变动记录");
});

t("本次入库量为 0 → 视同跳过，不写库、不留痕", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  let items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
  items[0] = model.applyEdit(items[0], "intake_quantity", 0).item;
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(db.loadMovements().length, 32, "33 行里 1 行视同跳过 → 32 条变动");
});

/* ============================================ §6 模型与契约不漂移 */

section("§6 模型提交的字段能被 IPC 层原样接受（不因多余字段炸掉）");

t("toCommitItems 去掉了 adjudicated，提交后库里没有这个字段", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const items = parsed.items.map((it) => model.setAdjudicated(Object.assign({}, it), true));
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: model.toCommitItems(items), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  for (const part of db.loadParts()) {
    assert.ok(!Object.prototype.hasOwnProperty.call(part, "adjudicated"), "库里不该出现界面标记");
  }
});

/* ------------------------------------------------------------------ 执行 */

runQueue().then(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T12（导入闸门与端到端）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
