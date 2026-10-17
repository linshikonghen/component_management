"use strict";
/**
 * test_stock_model.js — T16（plan §9 的 T13）验收测试：领料页规则 + AC-7 全部 7 行
 *
 * 运行： node tests/test_stock_model.js
 *
 *   §1~§5 规则（方向/请求/结果摘要/逐条缺口/器件选项）
 *   §6    **AC-7 逐行端到端**（出库、超库存拒绝、部分领用、未入库条目、同一批次 ref）
 *   §7    **FR-7.6 联合断言**：领料是独立入口，比对页里没有任何领料路径
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const model = require("../renderer/model/stock_model.js");
const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_stock_"));

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

/* ================================================= §1 手动出/入库 */

section("§1 手动出 / 入库：方向 + 数量 + 原因（FR-7.1 / FR-7.3）");

t("两个方向：出库 −、入库 +", () => {
  assert.deepStrictEqual(model.DIRECTIONS.map((d) => d.key), ["out", "in"]);
  assert.strictEqual(model.directionOf("out").sign, -1);
  assert.strictEqual(model.directionOf("in").sign, 1);
  assert.strictEqual(model.directionOf("不存在").key, "out", "未知方向落默认");
});

t("界面填正数，方向决定符号（用户不必纠结正负号）", () => {
  const out = model.toMoveRequest({ part_id: "p_0001", direction: "out", amount: 5, reason: "打样领用" });
  assert.strictEqual(out.ok, true, out.error);
  assert.deepStrictEqual(out.request, { part_id: "p_0001", delta: -5, reason: "打样领用" });
  const back = model.toMoveRequest({ part_id: "p_0001", direction: "in", amount: "7", reason: " 补货 " });
  assert.strictEqual(back.request.delta, 7);
  assert.strictEqual(back.request.reason, "补货", "原因要去掉首尾空格");
});

t("器件必选、原因必填、数量必须是正整数", () => {
  assert.strictEqual(model.validateMove({ direction: "out", amount: 1, reason: "x" }).ok, false);
  assert.ok(/选择器件/.test(model.validateMove({ direction: "out", amount: 1, reason: "x" }).error));
  assert.ok(/原因/.test(model.validateMove({ part_id: "p1", direction: "out", amount: 1, reason: "" }).error));
  for (const bad of [0, -1, 1.5, "abc", "", null]) {
    const r = model.validateMove({ part_id: "p1", direction: "out", amount: bad, reason: "x" });
    assert.strictEqual(r.ok, false, `数量 ${JSON.stringify(bad)} 应被拒绝`);
    assert.ok(/正整数/.test(r.error), r.error);
  }
  assert.strictEqual(model.validateMove({ part_id: "p1", direction: "out", amount: 1, reason: "x" }).ok, true);
});

/* ================================================= §2 领料请求 */

section("§2 按 BOM 领料请求（FR-7.4）");

t("文件/套数/原因三者缺一不可", () => {
  assert.ok(/选择 BOM/.test(model.validatePick({ sets: 1, reason: "x" }).error));
  assert.ok(/套数/.test(model.validatePick({ file_path: "a.xlsx", sets: 0, reason: "x" }).error));
  assert.ok(/原因/.test(model.validatePick({ file_path: "a.xlsx", sets: 1 }).error));
  assert.strictEqual(model.validatePick({ file_path: "a.xlsx", sets: 1, reason: "打样" }).ok, true);
});

t("allow_partial 默认 false（不给就是整单拒绝，plan §6）", () => {
  const req = model.toPickRequest({ file_path: "a.xlsx", sets: 2, reason: "打样" });
  assert.strictEqual(req.ok, true, req.error);
  assert.strictEqual(req.request.allow_partial, false);
  assert.strictEqual(model.toPickRequest({ file_path: "a.xlsx", sets: 2, reason: "打样", allow_partial: true }).request.allow_partial, true);
  assert.strictEqual(model.toPickRequest({ file_path: "a.xlsx", sets: "2", reason: "打样" }).request.sets, 2);
});

/* ================================================= §3 结果摘要 */

section("§3 领料结果摘要：成功与「整单拒绝」都要说清楚");

const OK_RESULT = {
  ok: true, pick_id: "pick_20261015_100000",
  picked: [{ part_id: "p_1", required: 24, deducted: 20, after: 0 }],
  insufficient: [{ part_id: "p_1", required: 24, stock: 20, shortfall: 4 }],
  unknown: [],
  movements: [{ part_id: "p_1", kind: "out", delta: -20, ref: "pick_20261015_100000" }],
};

t("成功：给出条数、扣减合计、记录数、批次号", () => {
  const s = model.pickSummary(OK_RESULT);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.picked_count, 1);
  assert.strictEqual(s.deducted_total, 20);
  assert.strictEqual(s.movement_count, 1);
  assert.ok(/共扣减 20 个/.test(s.message), s.message);
  assert.ok(/部分领用/.test(s.message), s.message);
  assert.ok(/pick_20261015_100000/.test(s.message), s.message);
});

t("整单拒绝：明确说「库存与变动记录都没有改动」，并告诉用户下一步", () => {
  const rejected = Object.assign({}, OK_RESULT, {
    ok: false, picked: [], movements: [],
    error: "库存不足，整单拒绝（1 条）：p_1 需 24 有 20 缺 4",
  });
  const s = model.pickSummary(rejected);
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.deducted_total, 0);
  assert.strictEqual(s.movement_count, 0);
  assert.ok(/未执行/.test(s.message) && /整单拒绝/.test(s.message), s.message);
  assert.ok(/库存与变动记录都没有改动/.test(s.message), s.message);
  assert.ok(/允许部分领用/.test(s.message), s.message);
});

t("库中没有的条目也在摘要里点名（AC-7 异常路径：不静默跳过）", () => {
  const withUnknown = Object.assign({}, OK_RESULT, {
    unknown: [{ row_no: 2, part_number: "", value: "33pF", footprint: "C0603", required: 2 }],
  });
  const s = model.pickSummary(withUnknown);
  assert.strictEqual(s.unknown_count, 1);
  assert.ok(/1 种库里没有/.test(s.message), s.message);
});

/* ============================================ §4 逐条缺口与未入库 */

section("§4 缺口逐条列出（FR-7.5）与未入库条目逐条列出");

t("缺口行含 需求/现有/缺口 三个数", () => {
  const lines = model.insufficientLines(OK_RESULT);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].shortfall, 4);
  assert.strictEqual(lines[0].text, "需 24 · 现有 20 · 缺 4");
});

t("未入库条目行含行号与型号/值/封装", () => {
  const lines = model.unknownLines({ unknown: [{ row_no: 7, part_number: "X1", value: "10uF", footprint: "C0603", required: 3 }] });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, "第 7 行：X1 / 10uF / C0603（需 3）");
  assert.deepStrictEqual(model.unknownLines({}), []);
});

t("器件选择项的文案含库存，低库存加警示标记", () => {
  const text = model.partOptionText({ id: "p_1", value: "10uF", footprint: "C1210", quantity: 3, part_number: "MPN1" }, ["p_1"]);
  assert.ok(/10uF \/ C1210/.test(text), text);
  assert.ok(/库存 3/.test(text), text);
  assert.ok(text.startsWith("⚠"), text);
  assert.ok(!model.partOptionText({ id: "p_2", value: "1k", footprint: "R0603", quantity: 50 }, ["p_1"]).startsWith("⚠"));
});

/* ============================================ §5 端到端（AC-7） */

section("§5 AC-7 逐行端到端");

let envNo = 0;
function freshEnv() {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers };
}

/** 建一条数量 5 的器件 */
async function seedPart(handlers, quantity) {
  const saved = await handlers["parts:save"]({
    part: { value: "10uF", footprint: "C1210", quantity },
  });
  assert.strictEqual(saved.ok, true, saved.error);
  return saved.part;
}

t("AC-7 第 1 行：出库 5 填原因 → 库存 −5，变动记录 kind=out 且含原因", async () => {
  const { handlers } = freshEnv();
  const part = await seedPart(handlers, 20);
  const built = model.toMoveRequest({ part_id: part.id, direction: "out", amount: 5, reason: "打样领用" });
  const r = await handlers["stock:move"](built.request);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.part.quantity, 15);
  assert.strictEqual(r.movement.kind, "out");
  assert.strictEqual(r.movement.delta, -5);
  assert.strictEqual(r.movement.reason, "打样领用");
  assert.strictEqual(r.movement.before, 20);
  assert.strictEqual(r.movement.after, 15);
});

t("AC-7 异常路径：库存 5 出 10 → 拒绝、库存不变、**无变动记录**", async () => {
  const { handlers, db } = freshEnv();
  const part = await seedPart(handlers, 5);
  const before = db.loadMovements().length;
  const built = model.toMoveRequest({ part_id: part.id, direction: "out", amount: 10, reason: "领用" });
  const r = await handlers["stock:move"](built.request);
  assert.strictEqual(r.ok, false);
  assert.ok(/库存不足/.test(r.error), r.error);
  const after = (await handlers["parts:list"]({ query: {} })).parts[0];
  assert.strictEqual(after.quantity, 5, "库存必须不变");
  assert.strictEqual(db.loadMovements().length, before, "不得留下变动记录");
});

t("前置：用真实主样本建库（32 条）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(db.loadParts().length, 32);
});

t("AC-7 第 3 行：套数 4 需求放大 → 允许部分领用时按现有量扣（缺口逐条）", async () => {
  const { handlers } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });

  const built = model.toPickRequest({ file_path: MAIN_BOM, sets: 4, reason: "打样领用", allow_partial: true });
  const r = await handlers["stock:pick_by_bom"](built.request);
  assert.strictEqual(r.ok, true, r.error);
  const summary = model.pickSummary(r);
  assert.ok(summary.picked_count > 0);
  assert.ok(summary.insufficient_count > 0, "套数放大后应有缺口");
  assert.ok(summary.deducted_total > 0);
  assert.ok(model.insufficientLines(r).every((x) => x.shortfall > 0));
});

t("AC-7 异常路径：默认（不勾部分领用）→ **整单拒绝、零变动**", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  const stockBefore = db.loadParts().reduce((s, p) => s + p.quantity, 0);
  const movesBefore = db.loadMovements().length;

  const built = model.toPickRequest({ file_path: MAIN_BOM, sets: 4, reason: "打样领用" });
  const r = await handlers["stock:pick_by_bom"](built.request);
  assert.strictEqual(r.ok, false);
  assert.ok(/库存不足，整单拒绝/.test(r.error), r.error);
  assert.deepStrictEqual(r.picked, []);
  assert.deepStrictEqual(r.movements, []);
  assert.strictEqual(db.loadParts().reduce((s, p) => s + p.quantity, 0), stockBefore, "库存一点都不能动");
  assert.strictEqual(db.loadMovements().length, movesBefore, "也不能留变动记录");
  assert.ok(/未执行/.test(model.pickSummary(r).message));
});

t("AC-7 异常路径：BOM 有未入库条目 → 逐条列出，不静默跳过", async () => {
  const { handlers } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const built = model.toPickRequest({ file_path: MAIN_BOM, sets: 1, reason: "空库领料", allow_partial: true });
  const r = await handlers["stock:pick_by_bom"](built.request);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.unknown.length, 33, "空库时 33 条都应在「库中没有」里");
  assert.strictEqual(r.picked.length, 0);
  const lines = model.unknownLines(r);
  assert.strictEqual(lines.length, 33);
  assert.ok(/第 1 行/.test(lines[0].text), lines[0].text);
  console.log(`        （空库领料：${r.unknown.length} 条明确列出，库存未动）`);
});

t("AC-7 第 5 行：领料后每条扣减各有一条 out 记录，且**带同一批次 ref**", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });

  const built = model.toPickRequest({ file_path: MAIN_BOM, sets: 1, reason: "整单领用", allow_partial: true });
  const r = await handlers["stock:pick_by_bom"](built.request);
  assert.strictEqual(r.ok, true, r.error);
  const stored = db.loadMovements().filter((m) => m.ref === r.pick_id);
  assert.strictEqual(stored.length, r.picked.length, "每条扣减都要留痕");
  assert.ok(stored.every((m) => m.kind === "out"), "都应是出库记录");
  assert.ok(stored.every((m) => m.reason === "整单领用"), "原因要落到每条记录上");
  assert.ok(stored.every((m) => m.delta < 0));
  console.log(`        （一次领料：扣 ${r.picked.length} 条，出库记录 ${stored.length} 条，同一批次 ${r.pick_id}）`);
});

/* ======================================== §6 FR-7.6 入口隔离（联合） */

section("§6 FR-7.6：领料是独立入口，比对页里没有领料路径（AC-7 最后两行）");

function readIfExists(rel) {
  const full = path.join(PROJECT_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

t("领料页只调允许的通道（出入库 / 领料 / 选文件 / 列表 / 变动记录）", () => {
  const src = stripComments(readIfExists("renderer/pages/stock_page.js"));
  const calls = [...src.matchAll(/call\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "没解析到 IPC 调用");
  const allowed = new Set(["bomPickFiles", "partsList", "stockMove", "stockPickByBom", "movementsList"]);
  for (const name of calls) assert.ok(allowed.has(name), `领料页调用了未授权的通道：${name}`);
  // 领料结果要展示“整单拒绝/缺口”（业务结果，不是异常）→ 经 UIUtil.callRaw 这条桥取原始响应
  assert.ok(/UIUtil\.callRaw\(root\.api,\s*"stockPickByBom"/.test(src),
    "领料结果应经 UIUtil.callRaw 取原始响应以便展示缺口（仍只走 lib 这一条 IPC 通道）");
  console.log(`        （领料页实际调用：${[...new Set(calls)].sort().join(" / ")}）`);
});

t("**比对页仍然没有任何领料通道**（FR-7.6：从比对页无法触发领料）", () => {
  for (const rel of ["renderer/pages/compare_report.js", "renderer/model/compare_model.js"]) {
    const code = stripComments(readIfExists(rel));
    assert.ok(!/stock:pick_by_bom|stockPickByBom|pickByBom|stock:move|stockMove/.test(code),
      `${rel} 出现了领料/出入库通道——比对页必须是只读入口`);
  }
});

t("index.html：比对页与领料页是两个独立 section，比对页里没有领料入口", () => {
  const html = readIfExists("renderer/index.html");
  assert.ok(/id="page-compare"/.test(html), "缺比对页 section");
  assert.ok(/id="page-stock"/.test(html), "缺领料页 section");
  assert.ok(/id="page-parts"/.test(html), "缺手动录入 section（下面用它当比对页的结束边界）");
  // 边界用「下一个 section 的 id」而不是「领料页的 id」——
  // 后者会把领料页**上方的注释**也框进来（第一版就这么误报了一次）。
  const compareSection = html.split('id="page-compare"')[1].split('id="page-parts"')[0];
  assert.ok(!/领料|出库/.test(compareSection), "比对页 section 里出现了「领料/出库」字样");
  assert.ok(!/stock-panel|stockPickByBom|stockMove/.test(compareSection), "比对页 section 里挂了领料容器或通道");
  // 反证：领料页 section 确实存在领料容器
  const stockSection = html.split('id="page-stock"')[1];
  assert.ok(/stock-panel/.test(stockSection), "领料页应挂载领料容器");
});

/* ------------------------------------------------------------------ 执行 */

runQueue().then(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T16（领料页规则与 AC-7）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
