"use strict";
/**
 * test_low_stock.js — T9（plan §9 的 T12 + T12b 服务层）验收测试
 *
 * 运行： node tests/test_low_stock.js
 *
 * 对应验收：AC-9（分类阈值四条）、AC-4（阈值与提示）、FR-4.8（个体覆盖分类默认）。
 * §5 专门记录一处 **spec 自相矛盾**（AC-4 异常路径 vs FR-4.8/AC-9），需用户裁决。
 */

const assert = require("assert");
const path = require("path");

const ls = require("../src/services/low_stock");
const inv = require("../src/services/inventory");
const storeModule = require("../src/services/store");
const categories = require("../src/services/categories");

const PROJECT_ROOT = path.resolve(__dirname, "..");

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

/** 首启默认设置（14 类阈值，与 spec §5.3 一致） */
const SETTINGS = JSON.parse(JSON.stringify(storeModule.DEFAULT_SETTINGS));

function part(over = {}) {
  return Object.assign({
    id: "p_0001", category: "C", value: "10uF", footprint: "C1210",
    quantity: 100, min_quantity: null,
  }, over);
}

/* ================================================== §1 阈值解析（FR-4.8） */

section("§1 阈值解析：个体覆盖分类默认（FR-4.8）");

t("个体阈值非空 → 用它（source=individual）", () => {
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ min_quantity: 10 }), SETTINGS),
    { threshold: 10, source: "individual" });
});

t("个体留空 → 继承分类默认（source=category）", () => {
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ category: "C" }), SETTINGS), { threshold: 20, source: "category" });
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ category: "R" }), SETTINGS), { threshold: 50, source: "category" });
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ category: "U" }), SETTINGS), { threshold: 5, source: "category" });
});

t("分类为空或未知 → 落 _default（5），并如实标 source=default（不是「按分类默认」）", () => {
  assert.strictEqual(ls.effectiveMinQuantity(part({ category: "" }), SETTINGS).threshold, 5);
  assert.strictEqual(ls.effectiveMinQuantity(part({ category: "不存在的分类" }), SETTINGS).threshold, 5);
  // 分类认不出时用的是**兜底**那条阈值（`_default`），说成 "category" 会让界面写成"按分类默认阈值判定"——
  // 那是在骗用户（其实是兜底）。实测对账单里的「固态电容」原走这条路径；该类型**已被用户裁定归入电容类**，
  // 所以这里改用另一个表外名字做见证 ✓
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ category: "不存在的分类" }), SETTINGS),
    { threshold: 5, source: "default" });
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ category: "火星牌电容" }), SETTINGS),
    { threshold: 5, source: "default" }, "立创类型表里没有的分类 → 兜底，不猜 ✗");
  // 显式落哨兵/「其它」也走兜底
  assert.strictEqual(ls.effectiveMinQuantity(part({ category: "_default" }), SETTINGS).source, "default");
  assert.strictEqual(ls.effectiveMinQuantity(part({ category: "其它" }), SETTINGS).source, "default");
});

t("个体阈值 **0 是有效值**，不是留空（否则分类默认会把它盖掉）", () => {
  assert.deepStrictEqual(ls.effectiveMinQuantity(part({ min_quantity: 0 }), SETTINGS),
    { threshold: 0, source: "individual" });
  assert.strictEqual(ls.effectiveMinQuantity(part({ min_quantity: "" }), SETTINGS).source, "category", "空串才算留空");
  assert.strictEqual(ls.effectiveMinQuantity(part({ min_quantity: null }), SETTINGS).source, "category");
});

t("分类默认也不存在时 → 不提示（threshold=null）", () => {
  const bare = { schema_version: 1, default_min_quantity: {} };
  assert.deepStrictEqual(ls.effectiveMinQuantity(part(), bare), { threshold: null, source: "none" });
  assert.strictEqual(ls.isLowStock(part({ quantity: 0 }), bare), false);
});

t("阈值非法（非数字/负数）→ 报错，不静默当作 0", () => {
  assert.throws(() => ls.effectiveMinQuantity(part({ min_quantity: "abc" }), SETTINGS), /阈值非法/);
  assert.throws(() => ls.effectiveMinQuantity(part({ min_quantity: -5 }), SETTINGS), /阈值非法/);
  const badMap = { default_min_quantity: { C: "abc", _default: 5 } };
  assert.throws(() => ls.effectiveMinQuantity(part({ category: "C" }), badMap), /默认阈值非法/);
});

/* ============================================== §2 AC-9 的四条验收 */

section("§2 AC-9：分类与阈值（逐条对照验收标准）");

t("AC-9①：首次启动时设置里已有 **14 类**预置阈值（spec §5.3）", () => {
  assert.strictEqual(Object.keys(SETTINGS.default_min_quantity).length, 14);
  for (const key of ["C", "R", "L", "D", "Q", "U", "CN", "X", "KEY", "F", "BUZZER", "LED", "H", "_default"]) {
    assert.ok(key in SETTINGS.default_min_quantity, "缺分类 " + key);
  }
});

t("AC-9②：把「电容」默认阈值 20→30，未设个体阈值的电容按 30 判定", () => {
  const bumped = JSON.parse(JSON.stringify(SETTINGS));
  bumped.default_min_quantity.C = 30;
  const cap = part({ category: "C", quantity: 25, min_quantity: null });
  assert.strictEqual(ls.isLowStock(cap, SETTINGS), false, "阈值 20 时库存 25 不算低");
  assert.strictEqual(ls.isLowStock(cap, bumped), true, "改成 30 后库存 25 就低于阈值了");
  const cap35 = part({ category: "C", quantity: 35, min_quantity: null });
  assert.strictEqual(ls.isLowStock(cap35, SETTINGS), false, "20 阈值下 35 不低");
  assert.strictEqual(ls.isLowStock(cap35, bumped), false, "30 阈值下 35 仍不低");
  const cap28 = part({ category: "C", quantity: 28, min_quantity: null });
  assert.strictEqual(ls.isLowStock(cap28, SETTINGS), false, "20 阈值下 28 不低");
  assert.strictEqual(ls.isLowStock(cap28, bumped), true, "30 阈值下 28 变成低库存 ← 改默认阈值确实生效");
});

t("AC-9③：某电容不设个体阈值、分类默认 20、库存 15 → **判为低库存**（FR-4.8）", () => {
  const cap = part({ category: "C", quantity: 15, min_quantity: null });
  assert.strictEqual(ls.isLowStock(cap, SETTINGS), true);
  const found = ls.findLowStock([cap], SETTINGS);
  assert.deepStrictEqual(found.ids, ["p_0001"]);
  assert.strictEqual(found.items[0].threshold, 20);
  assert.strictEqual(found.items[0].source, "category");
  assert.strictEqual(found.items[0].shortage, 5);
});

t("AC-9④：同器件设个体阈值 10 → **不再**判低库存（个体覆盖生效）", () => {
  const cap = part({ category: "C", quantity: 15, min_quantity: 10 });
  assert.strictEqual(ls.isLowStock(cap, SETTINGS), false);
  assert.deepStrictEqual(ls.findLowStock([cap], SETTINGS).ids, []);
  // 对照：库存降到 9 就低于个体阈值
  assert.strictEqual(ls.isLowStock(part({ category: "C", quantity: 9, min_quantity: 10 }), SETTINGS), true);
});

/* ================================================ §3 判定边界（AC-4） */

section("§3 判定边界（AC-4 / FR-4.2「低于阈值」）");

t("AC-4：阈值 10、库存 5 → 列表标示；补到 20 → 不再标示", () => {
  const low = part({ min_quantity: 10, quantity: 5 });
  const found = ls.findLowStock([low], SETTINGS);
  assert.deepStrictEqual(found.ids, ["p_0001"]);
  assert.strictEqual(found.items[0].source, "individual");
  const refilled = part({ min_quantity: 10, quantity: 20 });
  assert.deepStrictEqual(ls.findLowStock([refilled], SETTINGS).ids, []);
});

t("库存 **等于** 阈值不算低库存（FR-4.2 原文是「低于」）", () => {
  assert.strictEqual(ls.isLowStock(part({ min_quantity: 10, quantity: 10 }), SETTINGS), false);
  assert.strictEqual(ls.isLowStock(part({ min_quantity: 10, quantity: 9 }), SETTINGS), true);
});

t("个体阈值 0 = **永不提示**（库存不可能低于 0）——给用户的逃生口", () => {
  for (const qty of [0, 1, 100]) {
    assert.strictEqual(ls.isLowStock(part({ min_quantity: 0, quantity: qty }), SETTINGS), false);
  }
});

t("findLowStock 只返回低库存的，且 ids 与 items 一一对应", () => {
  const parts = [
    part({ id: "p_1", category: "R", quantity: 49 }),  // R 默认 50 → 低
    part({ id: "p_2", category: "R", quantity: 50 }),  // 等于 → 不低
    part({ id: "p_3", category: "U", quantity: 0 }),   // U 默认 5 → 低
    part({ id: "p_4", quantity: 100, min_quantity: 0 }), // 永不提示
  ];
  const found = ls.findLowStock(parts, SETTINGS);
  assert.deepStrictEqual(found.ids, ["p_1", "p_3"]);
  assert.strictEqual(found.items.length, 2);
  assert.strictEqual(found.items[0].category, "R");
  assert.strictEqual(found.items[1].category, "U");
});

t("summarizeLowStock 给出条数与一句中文摘要；无低库存时为空串", () => {
  const none = ls.summarizeLowStock([part({ quantity: 999 })], SETTINGS);
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.message, "");
  const some = ls.summarizeLowStock([
    part({ id: "p_1", category: "R", quantity: 1 }),
    part({ id: "p_2", category: "U", quantity: 1 }),
  ], SETTINGS);
  assert.strictEqual(some.count, 2);
  assert.deepStrictEqual(some.ids, ["p_1", "p_2"]);
  assert.ok(/有 2 种器件低于低库存阈值/.test(some.message), some.message);
});

/* ===================================== §4 与入库/出库串起来（FR-4.4） */

section("§4 与库存变动串起来（FR-4.4：变动后立即重算）");

t("入库补货后提示立即消失；出库后又出现（纯函数每次重算即得）", () => {
  // 建一条电容：分类 C（默认阈值 20），入库 15 → 低库存
  const commit = inv.commitBom("batch_ls", [{
    row_no: 1, designators: ["C1"], quantity_per_board: 15, total_quantity: 15, intake_quantity: 15,
    value: "10uF", footprint: "C1210", voltage: "50V", dielectric: "X7R", tolerance: "±10%",
    manufacturer_part: "X", manufacturer: "Y", supplier_part: "C1", supplier: "LCSC",
    action: "keep", note: "", edited_by_human: false,
  }], [], { sets: 1 });
  const parts = commit.parts;
  assert.strictEqual(parts[0].category, "C");
  assert.strictEqual(parts[0].min_quantity, null, "入库时留空 → 继承分类默认");
  assert.deepStrictEqual(ls.findLowStock(parts, SETTINGS).ids, [parts[0].id], "15 < 20 → 低库存");

  const refill = inv.moveStock(parts[0].id, 10, "补货", parts); // 15 → 25
  assert.deepStrictEqual(ls.findLowStock(refill.parts, SETTINGS).ids, [], "25 ≥ 20 → 提示消失");

  const take = inv.moveStock(refill.parts[0].id, -6, "领用", refill.parts); // 25 → 19
  assert.deepStrictEqual(ls.findLowStock(take.parts, SETTINGS).ids, [parts[0].id], "19 < 20 → 提示又出现");
});

t("真实主样本建库后，每条器件都能解析出阈值且不抛错", () => {
  const bp = require("../src/services/bom_parser");
  const parsed = bp.parseBomFile(path.join(PROJECT_ROOT, "tests", "fixtures", "sample_bom"), 1);
  const library = inv.commitBom("batch_real", parsed.items, [], { sets: 1 }).parts;
  assert.strictEqual(library.length, 32);
  const found = ls.findLowStock(library, SETTINGS);
  // 库里的数量都 ≥ 1，各分类默认阈值的分布决定谁低；关键是不抛错、结果自洽
  for (const item of found.items) {
    assert.ok(library.some((p) => p.id === item.part_id));
    assert.ok(item.quantity < item.threshold);
  }
  const categories = new Set(library.map((p) => p.category));
  assert.ok(categories.size >= 3, "主样本应推出多个分类: " + [...categories].join(","));
  console.log(`        （真实主样本 32 条器件，推出分类 ${[...categories].sort().join("/")}，其中 ${found.items.length} 条低于分类默认阈值）`);
});

t("AC-9 前提（v2.1）：category 是立创中文名时也要按类键取到阈值（多对一映射）", () => {
  const settings = { default_min_quantity: storeModule.DEFAULT_SETTINGS.default_min_quantity };
  const cases = [
    ["贴片电容(MLCC)", "C", 20],
    ["直插铝电解电容", "C", 20],
    ["排母", "H", 10],
    ["场效应管(MOSFET)", "Q", 10],
    ["翘板船型开关", "KEY", 5],
    ["自恢复保险丝", "F", 5],
    ["DC-DC电源芯片", "U", 5],
    ["贴片电阻", "R", 50],
  ];
  for (const [name, classKey, min] of cases) {
    assert.strictEqual(categories.resolve(name).key, classKey, name + " 应映射到 " + classKey);
    const r = ls.effectiveMinQuantity({ category: name, min_quantity: "" }, settings);
    assert.strictEqual(r.threshold, min, name + " 的分类默认阈值应是 " + min);
    assert.strictEqual(r.source, "category");
  }
  // 中文名 + 个体阈值：个体优先，不受映射影响
  assert.strictEqual(ls.effectiveMinQuantity({ category: "排母", min_quantity: 3 }, settings).threshold, 3);
  // 映射不到的乱值 → 兜底到兜底类（不猜、不抛）；查表时再落 `_default` 哨兵
  assert.strictEqual(ls.effectiveMinQuantity({ category: "火星元件", min_quantity: "" }, settings).threshold, 5);
  assert.strictEqual(categories.settingsKeyOf("火星元件"), "OTHER", "认不出就落兜底类，绝不猜");
  assert.strictEqual(categories.settingsKeyOf("_default"), "OTHER");
  assert.strictEqual(categories.minOf("火星元件"), 5);
});

/* ==================================== §5 spec 自相矛盾（记录，需用户裁决） */

section("§5 记录一处 spec 冲突：AC-4 异常路径 vs FR-4.8/AC-9（**未擅改 spec**）");

t("同一输入、两句相反的原文，本实现选了 FR-4.8/AC-9 一侧（按 Q4 用户答复）", () => {
  // spec AC-4 异常路径原文：阈值留空 → 该器件不参与低库存判断，不误报
  // spec FR-4.8 + AC-9 原文：留空 = 继承分类默认；分类默认 20、库存 15 → 判为低库存
  const doc = require("fs").readFileSync(path.join(PROJECT_ROOT, "docs", "spec.md"), "utf8");
  assert.ok(/阈值留空[^\n]*不参与低库存判断/.test(doc), "AC-4 那句原文应在 spec 里");
  assert.ok(/留空=继承分类默认/.test(doc), "FR-4.8 那句原文应在 spec 里");

  // 本实现的选择（= 继承分类默认）：
  const cap = part({ category: "C", quantity: 15, min_quantity: null });
  assert.strictEqual(ls.isLowStock(cap, SETTINGS), true, "按 FR-4.8/AC-9：留空 → 继承 20 → 15 低于 20 → 低库存");

  // 若按 AC-4 那一行实现，这里应当是 false —— 两句不可能同时为真，必须由用户裁决。
  // 在裁决之前，想"彻底不提示"的用户可以用个体阈值 0 达到目的（两种读法下都成立）。
  assert.strictEqual(ls.isLowStock(part({ category: "C", quantity: 15, min_quantity: 0 }), SETTINGS), false,
    "个体阈值 0 = 永不提示，作为逃生口");
});

/* ============================================================== 汇总输出 */

console.log("\n" + "=".repeat(64));
console.log(`T9（low_stock）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
