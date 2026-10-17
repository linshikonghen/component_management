"use strict";
/**
 * test_import_model.js — T12（plan §9 的 T5+T6）验收测试：人工核对表的**规则**
 *
 * 运行： node tests/test_import_model.js
 *
 * 对应验收：AC-1 里能在无头环境验证的部分（算式、本次入库量、原值只读、
 * 数量与位号不符必须人工裁决、汇总三数之和、全跳过阻断），以及 FR-1.4/1.5/1.6/1.8。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const model = require("../renderer/model/import_model.js");
const bp = require("../src/services/bom_parser");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");

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

function section(title) {
  console.log("\n=== " + title + " ===");
}

/** 一条核对表行（BomItem + 核对阶段的 adjudicated 标记） */
function row(over = {}) {
  return Object.assign({
    row_no: 1,
    designators: ["C1", "C2"],
    designator_count: 2,
    quantity_per_board: 2,
    total_quantity: 6, // 单套 2 × 套数 3
    intake_quantity: 6,
    edited_by_human: false,
    comment: "10uF/50V X7R",
    value: "10uF",
    footprint: "C1210",
    voltage: "50V",
    dielectric: "X7R",
    tolerance: "±10%",
    manufacturer_part: "1210B106K500NT",
    manufacturer: "FH(风华)",
    supplier_part: "C116808",
    supplier: "LCSC",
    // v1.5 实现期补记：契约补齐后的两个可改字段
    location: "",
    min_quantity: "",
    parse_confident: true,
    action: "keep",
    note: "",
    adjudicated: false,
  }, over);
}

/* ==================================================== §1 算式（FR-1.4） */

section("§1 算式显示（FR-1.4：核对界面必须显示「原数量 × 套数 = 应入库量」）");

t("算式串按「单套 × 套数 = 应入库量」渲染", () => {
  assert.strictEqual(model.formulaText(row({ quantity_per_board: 8 }), 3), "8 × 3 = 24");
  assert.strictEqual(model.formulaText(row({ quantity_per_board: 1 }), 1), "1 × 1 = 1");
  assert.strictEqual(model.formulaText(row({ quantity_per_board: 0 }), 5), "0 × 5 = 0");
});

/* ======================================== §2 本次入库量校验（FR-1.6） */

section("§2 本次入库量校验（FR-1.6 + AC-1 异常路径）");

t("非负整数通过；字符串数字也接受（表单给的就是字符串）", () => {
  assert.deepStrictEqual(model.validateIntake(24), { ok: true, zero: false, value: 24, error: "" });
  assert.deepStrictEqual(model.validateIntake("10"), { ok: true, zero: false, value: 10, error: "" });
  assert.deepStrictEqual(model.validateIntake(0), { ok: true, zero: true, value: 0, error: "" });
});

t("负数 / 小数 / 非数字 → 拒绝并说明原因", () => {
  assert.strictEqual(model.validateIntake(-1).ok, false);
  assert.ok(/非负/.test(model.validateIntake(-1).error));
  assert.strictEqual(model.validateIntake(1.5).ok, false);
  assert.ok(/整数/.test(model.validateIntake(1.5).error));
  assert.strictEqual(model.validateIntake("abc").ok, false);
  assert.ok(/收到「abc」/.test(model.validateIntake("abc").error), model.validateIntake("abc").error);
});

t("**空值不能当成 0**：空 = 没填，不是「用户想跳过」", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const r = model.validateIntake(blank);
    assert.strictEqual(r.ok, false, `空值 ${JSON.stringify(blank)} 应被拒绝`);
    assert.strictEqual(r.zero, false);
    assert.ok(/不能为空/.test(r.error), r.error);
  }
});

/* ================================================== §3 原值只读（v1.4） */

section("§3 BOM 原值只读：改了要**明确拒绝**，不能假装成功（FR-1.6 v1.4）");

t("原数量 / 应入库量 / 位号 / 行号 一律不可改", () => {
  const item = row();
  for (const field of ["quantity_per_board", "total_quantity", "designators", "designator_count", "row_no"]) {
    const r = model.applyEdit(item, field, 999);
    assert.strictEqual(r.ok, false, field + " 不该允许修改");
    assert.ok(/不可修改/.test(r.error), r.error);
    assert.strictEqual(r.item, item, "被拒绝时不应返回改过的对象");
  }
});

t("可改字段照 FR-1.6：值/封装/耐压/材质/容差/型号/厂商/C编码/供应商/备注/本次入库量/库位", () => {
  const item = row();
  for (const field of ["value", "footprint", "voltage", "dielectric", "tolerance",
    "manufacturer_part", "manufacturer", "supplier_part", "supplier", "note", "location"]) {
    const r = model.applyEdit(item, field, "改过");
    assert.strictEqual(r.ok, true, field + " 应可修改：" + r.error);
    assert.strictEqual(r.item[field], "改过");
    assert.notStrictEqual(r.item, item, "应返回新对象，不就地改");
  }
  const intake = model.applyEdit(item, "intake_quantity", 10);
  assert.strictEqual(intake.ok, true);
  assert.strictEqual(intake.item.intake_quantity, 10);
});

t("**低库存阈值**可改：留空 = 继承分类默认（FR-4.8），填了必须是非负整数", () => {
  const item = row();
  const inherit = model.applyEdit(item, "min_quantity", "");
  assert.strictEqual(inherit.ok, true, inherit.error);
  assert.strictEqual(inherit.item.min_quantity, "", "留空应保持留空（不是 0）");

  const own = model.applyEdit(item, "min_quantity", "10");
  assert.strictEqual(own.ok, true, own.error);
  assert.strictEqual(own.item.min_quantity, 10);
  assert.strictEqual(typeof own.item.min_quantity, "number");

  for (const bad of ["abc", "-1", "1.5"]) {
    const r = model.applyEdit(item, "min_quantity", bad);
    assert.strictEqual(r.ok, false, `阈值 ${bad} 应被拒绝`);
    assert.ok(/整数|不能为负/.test(r.error), r.error);
  }
  assert.deepStrictEqual(model.validateMinQuantity(null), { ok: true, value: "", error: "" });
});

t("不认识的字段也拒绝（避免界面与契约悄悄漂移）", () => {
  const r = model.applyEdit(row(), "unknown_field", 1);
  assert.strictEqual(r.ok, false);
  assert.ok(/不是可改字段/.test(r.error), r.error);
});

t("改本次入库量会自动置 edited_by_human；改回原值则复位（FR-1.6 v1.4 留痕）", () => {
  const item = row({ total_quantity: 24, intake_quantity: 24 });
  const edited = model.applyEdit(item, "intake_quantity", 10);
  assert.strictEqual(edited.item.edited_by_human, true);
  assert.strictEqual(model.isEdited(edited.item), true);
  const back = model.applyEdit(edited.item, "intake_quantity", 24);
  assert.strictEqual(back.item.edited_by_human, false);
  // BOM 原值一个字节没变
  assert.strictEqual(back.item.total_quantity, 24);
  assert.strictEqual(back.item.quantity_per_board, 2);
});

/* ============================== §4 数量与位号不符 → 必须人工裁决（FR-1.5） */

section("§4 数量与位号个数不符 → 醒目警示 + **阻止直接入库**（FR-1.5 / AC-1）");

t("判定依据是契约里现成的两个字段，不需新增字段", () => {
  assert.strictEqual(model.hasQuantityMismatch(row({ quantity_per_board: 8, designator_count: 6 })), true);
  assert.strictEqual(model.hasQuantityMismatch(row({ quantity_per_board: 6, designator_count: 6 })), false);
});

t("未裁决 → canCommit 拒绝，并说明要怎么做", () => {
  const items = [row({ quantity_per_board: 8, designator_count: 6, total_quantity: 8, intake_quantity: 8 })];
  assert.strictEqual(model.needsAdjudication(items[0]), true);
  const gate = model.canCommit(items);
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.blockers.length, 1);
  assert.ok(/数量与位号个数不符/.test(gate.blockers[0]), gate.blockers[0]);
  assert.ok(/核实|跳过/.test(gate.blockers[0]), gate.blockers[0]);
});

t("勾选「已核实」后即可入库（人工裁决留痕在核对阶段）", () => {
  let items = [row({ quantity_per_board: 8, designator_count: 6, total_quantity: 8, intake_quantity: 8 })];
  items = [model.setAdjudicated(items[0], true)];
  assert.strictEqual(model.needsAdjudication(items[0]), false);
  assert.strictEqual(model.canCommit(items).ok, true);
});

t("把该行改成跳过 → 不再需要裁决（FR-1.7）", () => {
  const skipped = model.toggleSkip(row({ quantity_per_board: 8, designator_count: 6 }), true, "BOM 有误，暂不入库");
  assert.strictEqual(skipped.action, "skip");
  assert.strictEqual(skipped.note, "BOM 有误，暂不入库");
  assert.strictEqual(model.needsAdjudication(skipped), false);
  // 但全跳过 → 依然不能入库，且提示明确
  const gate = model.canCommit([skipped]);
  assert.strictEqual(gate.ok, false);
  assert.ok(/无条目可入库/.test(gate.blockers[0]), gate.blockers[0]);
});

t("真实数据：修正版 BOM 的 3 行会被要求裁决（spec 附录 B 实测的 3 处不符）", () => {
  const parsed = bp.parseBomFile(path.join(FIX, "sample_bom"), 1);
  assert.strictEqual(parsed.ok, true, parsed.error);
  const items = parsed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
  const need = items.filter((it) => model.needsAdjudication(it));
  assert.strictEqual(need.length, 3, "该文件实测有 3 行 Quantity 与位号个数不符");
  assert.deepStrictEqual(need.map((it) => it.row_no), [1, 2, 12]);
  assert.strictEqual(model.canCommit(items).ok, false, "未裁决前不该允许入库");
});

/* ==================================================== §5 汇总（FR-1.8） */

section("§5 入库前汇总：新增/合并/跳过三数之和 = 条目总数（FR-1.8）");

t("汇总把「显式跳过」「本次入库量 0」「非法值」分别计数，且总和 = 总数", () => {
  const items = [
    row({ row_no: 1 }),
    row({ row_no: 2, intake_quantity: 0 }),
    row({ row_no: 3, action: "skip", note: "不要" }),
    row({ row_no: 4, intake_quantity: "abc" }),
    row({ row_no: 5, intake_quantity: 3 }),
  ];
  const s = model.summarize(items);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.keep, 2);
  assert.strictEqual(s.skip_explicit, 1);
  assert.strictEqual(s.skip_zero, 1);
  assert.strictEqual(s.invalid, 1);
  assert.strictEqual(s.skip, 2);
  assert.strictEqual(s.sum, s.total, "三数（+非法）之和必须等于总数");
});

t("存在非法值 → 阻断入库并指出条数", () => {
  const gate = model.canCommit([row({ row_no: 1 }), row({ row_no: 2, intake_quantity: -5 })]);
  assert.strictEqual(gate.ok, false);
  assert.ok(gate.blockers.some((b) => /本次入库量」不合法/.test(b)), JSON.stringify(gate.blockers));
});

/* ============================================ §6 提交前的字段清理 */

section("§6 提交给 bom:commit 的条目：只带契约字段");

/** 从 plan §6 的 BomItem 表格解析字段名（文档是唯一信源）。
 *  边界取"下一个 ### 标题"，**不能写死成 CompareItem**——plan §6 里 CompareItem 排在 BomItem 之前，
 *  写死会把后面别的响应表（compare:export 的 ok/compare_id/stats…）一并框进来。 */
function bomItemFieldsFromDoc() {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "plan.md"), "utf8");
  const sectionText = text.split("### BomItem")[1].split(/\n### /)[0];
  const fields = [];
  for (const line of sectionText.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").map((s) => s.trim()).filter((s) => s !== "");
    if (cols.length < 3 || cols[0] !== "响应") continue;
    // 文档里关键字段是**加粗**写的（如 `**tolerance**`），比对前先去掉强调标记
    const name = cols[1].replace(/[*`]/g, "").trim();
    if (name === "字段" || !/^[a-z_]+$/.test(name)) continue;
    fields.push(name);
  }
  return fields.sort();
}

t("`adjudicated` 这类核对阶段标记**不进 IPC**（契约里没有它）", () => {
  const items = [model.setAdjudicated(row(), true)];
  const commit = model.toCommitItems(items);
  assert.strictEqual(commit.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(commit[0], "adjudicated"), "不该把界面标记塞进契约");
  // 其余字段照旧带上
  assert.strictEqual(commit[0].intake_quantity, items[0].intake_quantity);
  assert.deepStrictEqual(commit[0].designators, items[0].designators);
});

t("toCommitItems 出来的字段集 == plan §6 BomItem 契约（多一个少一个都算漂移）", () => {
  const expected = bomItemFieldsFromDoc();
  assert.ok(expected.length >= 15, "契约字段解析异常：" + JSON.stringify(expected));
  const [commit] = model.toCommitItems([row()]);
  assert.deepStrictEqual(Object.keys(commit).sort(), expected);
});

/* ================================================================ 汇总输出 */

console.log("\n" + "=".repeat(64));
console.log(`T12（核对表规则）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
