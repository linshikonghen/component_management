"use strict";
/**
 * test_parts.js — T10（plan §9 的 T10/T11 服务层）验收测试
 *
 * 运行： node tests/test_parts.js
 *
 * 对应验收：AC-3（手动录入四条 + 异常路径）、AC-5（查询的服务侧）、FR-3.2（同一张库表）、
 * FR-4.5（数量变动留痕）、plan §6 的 parts:list / parts:save / parts:delete 契约。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const partsMod = require("../src/services/parts");
const inv = require("../src/services/inventory");
const storeModule = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SETTINGS = JSON.parse(JSON.stringify(storeModule.DEFAULT_SETTINGS));

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

/** 一张录入表单（Part 形状，不是 BomItem） */
function form(over = {}) {
  return Object.assign({
    value: "10uF", footprint: "C1210", voltage: "50V", dielectric: "X7R", tolerance: "±10%",
    part_number: "1210B106K500NT", manufacturer: "FH(风华)", supplier_part: "C116808", supplier: "LCSC",
    quantity: 20, min_quantity: null, location: "A-03", note: "",
  }, over);
}

/** 用 BOM 路径先建一条（验证"同一张库表"） */
function withBomPart() {
  return inv.commitBom("batch_parts", [{
    row_no: 1, designators: ["C1"], quantity_per_board: 8, total_quantity: 8, intake_quantity: 8,
    value: "10uF", footprint: "C1210", voltage: "50V", dielectric: "X7R", tolerance: "±10%",
    manufacturer_part: "1210B106K500NT", manufacturer: "FH(风华)", supplier_part: "C116808", supplier: "LCSC",
    action: "keep", note: "", edited_by_human: false,
  }], [], { sets: 1 }).parts;
}

/* ================================================== §1 表单校验（AC-3） */

section("§1 校验：必填关键信息缺失要指出缺哪个（AC-3 异常路径）");

t("值或封装留空 → 明确报缺哪个字段", () => {
  const r1 = partsMod.validatePartInput(form({ value: "" }));
  assert.strictEqual(r1.ok, false);
  assert.ok(/值/.test(r1.errors[0]), r1.errors[0]);
  const r2 = partsMod.validatePartInput(form({ footprint: "  " }));
  assert.ok(/封装/.test(r2.errors[0]), r2.errors[0]);
  const r3 = partsMod.validatePartInput(form({ value: "", footprint: "" }));
  assert.ok(/值/.test(r3.errors[0]) && /封装/.test(r3.errors[0]), r3.errors[0]);
});

t("数量非负整数校验；阈值非数字也拒绝", () => {
  assert.ok(partsMod.validatePartInput(form({ quantity: -1 })).errors.some((e) => /数量/.test(e)));
  assert.ok(partsMod.validatePartInput(form({ quantity: 1.5 })).errors.some((e) => /数量/.test(e)));
  assert.ok(partsMod.validatePartInput(form({ quantity: "abc" })).errors.some((e) => /数量/.test(e)));
  assert.ok(partsMod.validatePartInput(form({ min_quantity: "abc" })).errors.some((e) => /阈值/.test(e)));
  assert.strictEqual(partsMod.validatePartInput(form({ min_quantity: "" })).ok, true, "留空是允许的");
});

t("缺耐压/材质/容差只是**提示**（不阻断），因为那些条目比对时会进疑似", () => {
  const r = partsMod.validatePartInput(form({ voltage: "", dielectric: "", tolerance: "" }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some((w) => /疑似/.test(w)), JSON.stringify(r.warnings));
});

t("savePart 拒绝非法输入（服务端也要校验，不依赖界面限制）", () => {
  assert.throws(() => partsMod.savePart(form({ value: "" }), [], {}), /缺少必填关键信息/);
  assert.throws(() => partsMod.savePart(form({ quantity: -3 }), [], {}), /数量/);
});

/* ==================================================== §2 新增（FR-3.1） */

section("§2 新增一条器件（FR-3.1 / FR-3.4）");

t("新增成功：拿到 id、字段齐全、分类落 _default（手动录入没有位号可依据）", () => {
  const r = partsMod.savePart(form(), [], {});
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.merged, false);
  assert.strictEqual(r.parts.length, 1);
  assert.strictEqual(r.part.id, "p_0001");
  assert.strictEqual(r.part.value, "10uF");
  assert.strictEqual(r.part.location, "A-03");
  assert.strictEqual(r.part.category, "_default", "没有位号就不猜分类");
  assert.strictEqual(r.part.mpn_list.length, 1);
  assert.ok(r.part.created_at && r.part.updated_at);
  // 落库的字段就该是 plan §3.1 那一套，没有多余键
  const keys = Object.keys(r.part).sort();
  assert.deepStrictEqual(keys, partsMod.PART_FIELDS.concat(["id", "mpn_list", "created_at", "updated_at"]).sort());
});

t("阈值可设（FR-3.4）；留空为 null = 继承分类默认", () => {
  assert.strictEqual(partsMod.savePart(form({ min_quantity: 10 }), [], {}).part.min_quantity, 10);
  assert.strictEqual(partsMod.savePart(form({ min_quantity: "" }), [], {}).part.min_quantity, null);
});

t("新增有数量 → 记 init 变动；数量 0 → 不产生变动记录", () => {
  const withQty = partsMod.savePart(form({ quantity: 20 }), [], {});
  assert.strictEqual(withQty.movement.kind, "init");
  assert.strictEqual(withQty.movement.delta, 20);
  assert.strictEqual(withQty.movement.before, 0);
  assert.strictEqual(withQty.movement.after, 20);
  const zero = partsMod.savePart(form({ quantity: 0 }), [], {});
  assert.strictEqual(zero.movement, null);
});

/* ============================================ §3 同规格累加（FR-3.2） */

section("§3 同规格不重复建条：数量累加（FR-3.2、AC-3）");

t("再录一条库里已有的同规格料 → **累加**，不新增行", () => {
  const first = partsMod.savePart(form({ quantity: 20 }), [], {});
  const second = partsMod.savePart(form({ quantity: 5 }), first.parts, {});
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.merged, true);
  assert.strictEqual(second.parts.length, 1, "不该出现第二行");
  assert.strictEqual(second.parts[0].quantity, 25);
  assert.strictEqual(second.movement.kind, "in");
  assert.strictEqual(second.movement.delta, 5);
});

t("**BOM 导入与手动录入写同一张库表**：手录同规格会并到 BOM 建的那条上（FR-3.2）", () => {
  const library = withBomPart();
  assert.strictEqual(library.length, 1);
  assert.strictEqual(library[0].category, "C", "BOM 里有位号 C1 → 分类 C");
  const r = partsMod.savePart(form({ quantity: 3, category: "" }), library, {});
  assert.strictEqual(r.parts.length, 1, "同一张库表、同一套关键信息校验");
  assert.strictEqual(r.parts[0].id, library[0].id);
  assert.strictEqual(r.parts[0].quantity, 8 + 3);
  assert.strictEqual(r.parts[0].category, "C", "合并不该把已有分类冲掉");
});

t("累加只补空字段，不覆盖用户已填的内容", () => {
  const base = partsMod.savePart(form({ location: "A-03", note: "我的备注" }), [], {});
  const r = partsMod.savePart(form({ location: "B-99", note: "别的" }), base.parts, {});
  assert.strictEqual(r.parts[0].location, "A-03", "已填的库位不能被后来的覆盖");
  assert.strictEqual(r.parts[0].note, "我的备注");
});

/* ================================================== §4 编辑（有 id） */

section("§4 编辑既有器件（parts:save 带 id）");

t("改备注/库位：保留 id 与 created_at，刷新 updated_at", () => {
  const base = partsMod.savePart(form(), [], { now: new Date(2026, 9, 15, 10, 0, 0) });
  const edited = partsMod.savePart(
    Object.assign({}, base.part, { note: "换成 A-04", location: "A-04" }),
    base.parts, { now: new Date(2026, 9, 15, 11, 0, 0) }
  );
  assert.strictEqual(edited.created, false);
  assert.strictEqual(edited.part.id, base.part.id);
  assert.strictEqual(edited.part.created_at, base.part.created_at);
  assert.notStrictEqual(edited.part.updated_at, base.part.updated_at);
  assert.strictEqual(edited.part.note, "换成 A-04");
  assert.strictEqual(edited.parts.length, 1);
});

t("编辑改数量 → 记 adjust 变动（FR-4.5）；数量没变 → 不产生变动记录", () => {
  const base = partsMod.savePart(form({ quantity: 20 }), [], {});
  const bumped = partsMod.savePart(Object.assign({}, base.part, { quantity: 32 }), base.parts, {});
  assert.strictEqual(bumped.movement.kind, "adjust");
  assert.strictEqual(bumped.movement.delta, 12);
  assert.strictEqual(bumped.movement.before, 20);
  assert.strictEqual(bumped.movement.after, 32);
  const same = partsMod.savePart(Object.assign({}, bumped.part, { note: "只改备注" }), bumped.parts, {});
  assert.strictEqual(same.movement, null, "数量没变就不该有变动记录");
});

t("编辑**不许**把规格改成与库里另一条相同（那会破坏去重）", () => {
  const a = partsMod.savePart(form({ quantity: 10 }), [], {});
  const b = partsMod.savePart(form({ value: "22uF", footprint: "C1206", quantity: 5 }), a.parts, {});
  assert.strictEqual(b.parts.length, 2);
  // 把第二条改成和第一条同规格 → 拒绝
  assert.throws(
    () => partsMod.savePart(Object.assign({}, b.part, { value: "10uF", footprint: "C1210" }), b.parts, {}),
    /会产生重复器件/
  );
  assert.strictEqual(b.parts[0].value, "10uF", "原数组未被改动");
});

t("编辑成**新的**规格（与谁都不撞）是允许的", () => {
  const a = partsMod.savePart(form({ quantity: 10 }), [], {});
  const edited = partsMod.savePart(Object.assign({}, a.part, { value: "47uF" }), a.parts, {});
  assert.strictEqual(edited.part.value, "47uF");
  assert.strictEqual(edited.parts.length, 1);
});

/* ================================================== §5 删除（需确认） */

section("§5 删除（AGENTS.md：删除器件属需人工确认操作）");

t("没有 confirm → 拒绝", () => {
  const base = partsMod.savePart(form(), [], {});
  assert.throws(() => partsMod.deletePart(base.part.id, base.parts), /需人工确认/);
  assert.throws(() => partsMod.deletePart(base.part.id, base.parts, { confirm: false }), /需人工确认/);
  assert.strictEqual(base.parts.length, 1, "未确认时不得改动");
});

t("确认后移除，并返回被删的那条", () => {
  const base = partsMod.savePart(form(), [], {});
  const r = partsMod.deletePart(base.part.id, base.parts, { confirm: true });
  assert.strictEqual(r.parts.length, 0);
  assert.strictEqual(r.removed.id, base.part.id);
  assert.strictEqual(r.removed.value, "10uF");
});

t("删不存在的器件 → 明确报错", () => {
  assert.throws(() => partsMod.deletePart("p_9999", [], { confirm: true }), /器件不存在/);
});

/* ============================================== §6 查询（AC-5 服务侧） */

section("§6 查询：搜索 / 筛选 / 排序（FR-5.1~5.3、plan §6 parts:list）");

const LIB = [
  partsMod.savePart(form({ location: "A-03", quantity: 5 }), [], {}).parts[0],
  // 注意：每条都要显式给库位，否则会继承 form() 的默认值 A-03，搜索断言就会撞车
  partsMod.savePart(form({ value: "100nF", footprint: "C0603", part_number: "GRM188R72A104KA35D", manufacturer: "Murata(村田)", quantity: 200, location: "C-11" }), [], {}).parts[0],
  partsMod.savePart(form({ value: "1k", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%", part_number: "RC0603FR-071KL", quantity: 30, location: "R-01" }), [], {}).parts[0],
].map((p, i) => Object.assign(p, { id: "p_000" + (i + 1), category: ["C", "C", "R"][i] }));

t("FR-5.2：搜索跨关键信息字段（值/型号/库位/厂商）", () => {
  const byValue = partsMod.listParts(LIB, { q: "100nF" }, SETTINGS);
  assert.strictEqual(byValue.parts.length, 1);
  assert.strictEqual(byValue.parts[0].value, "100nF");
  assert.strictEqual(partsMod.listParts(LIB, { q: "RC0603" }, SETTINGS).parts.length, 1, "按型号搜到");
  assert.strictEqual(partsMod.listParts(LIB, { q: "A-03" }, SETTINGS).parts.length, 1, "按库位搜到");
  assert.strictEqual(partsMod.listParts(LIB, { q: "村田" }, SETTINGS).parts.length, 1, "按厂商中文搜到");
  assert.strictEqual(partsMod.listParts(LIB, { q: "10uF" }, SETTINGS).parts.length, 1, "大小写不敏感");
  assert.strictEqual(partsMod.listParts(LIB, { q: "10UF" }, SETTINGS).parts.length, 1);
});

t("搜索不存在的关键字 → 空结果，不报错（AC-5 异常路径）", () => {
  const r = partsMod.listParts(LIB, { q: "不存在的料" }, SETTINGS);
  assert.deepStrictEqual(r.parts, []);
  assert.strictEqual(r.total, 0);
});

t("FR-5.3：按分类 / 封装筛选（封装大小写不敏感）", () => {
  assert.strictEqual(partsMod.listParts(LIB, { category: "C" }, SETTINGS).parts.length, 2);
  assert.strictEqual(partsMod.listParts(LIB, { category: "R" }, SETTINGS).parts.length, 1);
  assert.strictEqual(partsMod.listParts(LIB, { footprint: "c0603" }, SETTINGS).parts.length, 1);
  assert.strictEqual(partsMod.listParts(LIB, { category: "C", footprint: "C0603" }, SETTINGS).parts.length, 1);
});

t("low_stock_only 只留低库存的；响应里始终带 low_stock_ids", () => {
  // C 默认阈值 20：库存 5 → 低；100nF 库存 200 → 不低；R 默认 50：库存 30 → 低
  const r = partsMod.listParts(LIB, { low_stock_only: true }, SETTINGS);
  assert.strictEqual(r.parts.length, 2);
  assert.deepStrictEqual(r.low_stock_ids.sort(), ["p_0001", "p_0003"]);
  const all = partsMod.listParts(LIB, {}, SETTINGS);
  assert.strictEqual(all.parts.length, 3);
  assert.deepStrictEqual(all.low_stock_ids.sort(), ["p_0001", "p_0003"]);
});

t("FR-5.1：按列排序（升/降），非法列名报错", () => {
  const asc = partsMod.listParts(LIB, { sort_by: "quantity", sort_dir: "asc" }, SETTINGS).parts.map((p) => p.quantity);
  assert.deepStrictEqual(asc, [5, 30, 200]);
  const desc = partsMod.listParts(LIB, { sort_by: "quantity", sort_dir: "desc" }, SETTINGS).parts.map((p) => p.quantity);
  assert.deepStrictEqual(desc, [200, 30, 5]);
  const byValue = partsMod.listParts(LIB, { sort_by: "value" }, SETTINGS).parts.map((p) => p.value);
  assert.strictEqual(byValue.length, 3, "按值排序不报错");
  assert.throws(() => partsMod.listParts(LIB, { sort_by: "不存在的列" }, SETTINGS), /不支持按/);
});

/* ========================================================== §7 边界 */

section("§7 边界与纯度");

t("传入的 parts 数组不被就地修改（savePart / deletePart 都返回副本）", () => {
  const base = partsMod.savePart(form(), [], {});
  const snapshot = JSON.parse(JSON.stringify(base.parts));
  partsMod.savePart(form({ quantity: 99 }), base.parts, {});
  partsMod.savePart(Object.assign({}, base.parts[0], { note: "x" }), base.parts, {});
  partsMod.deletePart(base.parts[0].id, base.parts, { confirm: true });
  assert.deepStrictEqual(base.parts, snapshot, "调用方数组必须保持不变");
});

t("parts.js **不含写能力**：无 fs、不调 store 的写函数（剥注释后扫源码）", () => {
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const src = stripComments(fs.readFileSync(path.join(PROJECT_ROOT, "src", "services", "parts.js"), "utf8"));
  for (const re of [/require\(\s*["']fs["']\s*\)/, /writeFileSync|renameSync|unlinkSync|mkdirSync|copyFileSync/,
    /saveParts|appendMovement|saveSettings|restoreFrom|writeJsonAtomic/]) {
    assert.ok(!re.test(src), "parts.js 命中禁用模式 " + re);
  }
  assert.ok(/require\(/.test(src), "扫描前处理有误：源码被清空了");
});

/* ============================================================== 汇总输出 */

console.log("\n" + "=".repeat(64));
console.log(`T10（parts）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
