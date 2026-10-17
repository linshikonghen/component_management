"use strict";
/**
 * test_inventory.js — T8（plan §9 的 T7）验收测试
 *
 * 运行： node tests/test_inventory.js
 *
 * 对应验收：AC-1（FR-1.7/1.8/1.9、本次入库量、留痕、异常路径）、AC-7（FR-7.1~7.5）、FR-4.5（留痕）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const inv = require("../src/services/inventory");
const bp = require("../src/services/bom_parser");
const cmp = require("../src/services/compare");
const ef = require("../src/services/export_format");
const storeModule = require("../src/services/store");
const { createStore } = storeModule;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = "sample_bom";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_inv_"));

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

/** BomItem（plan §6），默认"本次入库量 = 应入库量 24" */
function bomItem(over = {}) {
  return Object.assign({
    row_no: 1,
    designators: ["C1", "C2"],
    quantity_per_board: 8,
    total_quantity: 24,
    intake_quantity: 24,
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
    parse_confident: true,
    action: "keep",
    note: "",
  }, over);
}

const BATCH = "batch_20261015_100000";

/* ======================================================= §1 分类推导 */

section("§1 分类推导（spec §5.3 / plan §5.2：长前缀优先）");

t("单字母分类：C/R/L/D/Q/U/X/F/H 各归其类", () => {
  assert.strictEqual(inv.inferCategory(["C1"]), "C");
  assert.strictEqual(inv.inferCategory(["R17"]), "R");
  assert.strictEqual(inv.inferCategory(["L3"]), "L");
  assert.strictEqual(inv.inferCategory(["D2"]), "D");
  assert.strictEqual(inv.inferCategory(["Q2"]), "Q");
  assert.strictEqual(inv.inferCategory(["U10"]), "U");
  assert.strictEqual(inv.inferCategory(["Y1"]), "X");
  assert.strictEqual(inv.inferCategory(["F1"]), "F");
  assert.strictEqual(inv.inferCategory(["H10"]), "H");
  assert.strictEqual(inv.inferCategory(["J1"]), "CN");
  assert.strictEqual(inv.inferCategory(["P1"]), "CN");
});

t("**长前缀优先**：CN 不是 C、LED 不是 L、SW 归按键、BUZZER 归蜂鸣器", () => {
  assert.strictEqual(inv.inferCategory(["CN1"]), "CN", "CN1 若判成 C 就成了电容");
  assert.strictEqual(inv.inferCategory(["LED1"]), "LED", "LED1 若判成 L 就成了电感");
  assert.strictEqual(inv.inferCategory(["SW4"]), "KEY");
  assert.strictEqual(inv.inferCategory(["KEY1"]), "KEY");
  assert.strictEqual(inv.inferCategory(["BUZZER1"]), "BUZZER");
});

t("取不中落 _default；空位号也是 _default", () => {
  assert.strictEqual(inv.inferCategory(["TP1"]), "_default");
  assert.strictEqual(inv.inferCategory([]), "_default");
  assert.strictEqual(inv.inferCategory(null), "_default");
  assert.strictEqual(inv.inferCategory("CN1"), "CN", "字符串形式也可");
});

t("多个位号取出现最多的分类", () => {
  assert.strictEqual(inv.inferCategory(["C1", "C2", "R1"]), "C");
  assert.strictEqual(inv.inferCategory(["R1", "R2", "C1"]), "R");
});

t("分类键与 settings 的默认阈值键**同集合**（防两处漂移）", () => {
  const settingsKeys = new Set(Object.keys(storeModule.DEFAULT_SETTINGS.default_min_quantity));
  const produced = inv.CATEGORY_PREFIXES.map(([, cat]) => cat).concat([inv.DEFAULT_CATEGORY]);
  for (const cat of produced) {
    assert.ok(settingsKeys.has(cat), `分类「${cat}」在 settings.default_min_quantity 里没有对应阈值`);
  }
  // 反向：阈值表里的每个分类都应能被位号推出来（_default 除外）
  for (const key of settingsKeys) {
    if (key === "_default") continue;
    assert.ok(inv.CATEGORY_PREFIXES.some(([, cat]) => cat === key), `阈值键「${key}」没有任何位号前缀能推出来`);
  }
});

/* =================================================== §2 入库合并（FR-1.9） */

section("§2 入库合并：同一种料累加、绝不新建重复器件（FR-1.9）");

t("空库导入两条不同料 → 新增 2 条，数量 = 本次入库量", () => {
  const items = [
    bomItem({ row_no: 1 }),
    bomItem({ row_no: 2, value: "100nF", footprint: "C0603", quantity_per_board: 2, total_quantity: 2, intake_quantity: 2 }),
  ];
  const r = inv.commitBom(BATCH, items, [], { sets: 1, source: "测试" });
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.merged, 0);
  assert.strictEqual(r.parts.length, 2);
  assert.strictEqual(r.parts[0].quantity, 24);
  assert.strictEqual(r.parts[1].quantity, 2);
  assert.deepStrictEqual(r.parts.map((p) => p.id), ["p_0001", "p_0002"]);
  assert.strictEqual(r.parts[0].category, "C", "分类应由位号 C1,C2 推出");
});

t("**连续两次导入同一 BOM（套数 1）→ 条目数不变、数量翻倍**（AC-1 FR-1.9）", () => {
  const items = [bomItem({ quantity_per_board: 8, total_quantity: 8, intake_quantity: 8 })];
  const first = inv.commitBom(BATCH, items, [], { sets: 1 });
  assert.strictEqual(first.parts.length, 1);
  assert.strictEqual(first.parts[0].quantity, 8);
  const second = inv.commitBom("batch_20261015_100001", items, first.parts, { sets: 1 });
  assert.strictEqual(second.parts.length, 1, "不该新建第二条");
  assert.strictEqual(second.parts[0].quantity, 16, "同一种料应累加");
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.merged, 1);
  assert.strictEqual(second.parts[0].id, "p_0001", "合并时 id 不变");
});

t("真实主样本 33 行 → 新增 32 / 合并 1（33 行只有 32 个判定键）", () => {
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  assert.strictEqual(parsed.ok, true, parsed.error);
  const r = inv.commitBom(BATCH, parsed.items, [], { sets: 1, source: MAIN_BOM });
  assert.strictEqual(r.summary.total, 33);
  assert.strictEqual(r.added, 32);
  assert.strictEqual(r.merged, 1, "同规格的那两行应合并成一条");
  assert.strictEqual(r.skipped, 0);
  assert.strictEqual(r.parts.length, 32, "库里应是 32 条而不是 33 条");
  assert.strictEqual(r.movements.length, 33, "每一行入库都要留痕");
});

t("新器件按 plan §3.1 给全字段（含 mpn_list 与 min_quantity=null 继承分类默认）", () => {
  const r = inv.commitBom(BATCH, [bomItem()], [], { sets: 1 });
  const part = r.parts[0];
  for (const field of ["id", "category", "value", "footprint", "voltage", "dielectric", "tolerance",
    "power", "current", "polarity", "mount_type", "part_number", "manufacturer", "supplier_part",
    "supplier", "mpn_list", "quantity", "min_quantity", "location", "datasheet", "substitute",
    "batch", "note", "created_at", "updated_at"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(part, field), "缺字段 " + field);
  }
  assert.strictEqual(part.min_quantity, null, "留空 = 继承分类默认（FR-4.8）");
  assert.strictEqual(part.mpn_list.length, 1);
  assert.deepStrictEqual(part.mpn_list[0], {
    part_number: "1210B106K500NT", manufacturer: "FH(风华)", supplier_part: "C116808", supplier: "LCSC",
  });
});

t("同规格不同厂商料号 → 合并为一条并记入 mpn_list（AML，spec §5.2）", () => {
  const a = bomItem({ manufacturer_part: "1210B106K500NT", manufacturer: "FH(风华)" });
  const b = bomItem({ row_no: 2, manufacturer_part: "GRM31CR61H106KA12L", manufacturer: "Murata(村田)" });
  const r = inv.commitBom(BATCH, [a, b], [], { sets: 1 });
  assert.strictEqual(r.parts.length, 1, "同规格不同厂商 = 同一种料");
  assert.strictEqual(r.parts[0].mpn_list.length, 2, "两个料号都要留");
  assert.strictEqual(r.parts[0].part_number, "1210B106K500NT", "主选料号保持第一条");
});

/* ============================================ §3 本次入库量 vs BOM 原值 */

section("§3 累加的是「本次入库量」，BOM 原值只用于算式与留痕（FR-1.6 v1.4）");

t("把本次入库量 24 改成 10 → 入库存 **10**，算式数据仍是 24", () => {
  const item = bomItem({ quantity_per_board: 8, total_quantity: 24, intake_quantity: 10, edited_by_human: true });
  const r = inv.commitBom(BATCH, [item], [], { sets: 3 });
  assert.strictEqual(r.parts[0].quantity, 10, "只按人工确认的本次入库量入库");
  const m = r.movements[0];
  assert.strictEqual(m.delta, 10);
  assert.strictEqual(m.expected_quantity, 24, "原应入库量要留痕");
  assert.strictEqual(m.intake_quantity, 10, "实际入库量要留痕");
  assert.strictEqual(m.edited_by_human, true, "改动标记要留痕");
  // 原值没有被写回任何地方
  assert.strictEqual(item.total_quantity, 24);
  assert.strictEqual(item.quantity_per_board, 8);
});

t("未改动时 edited_by_human=false；只在 intake≠total 时自动置 true", () => {
  const same = inv.commitBom(BATCH, [bomItem({ total_quantity: 24, intake_quantity: 24 })], [], { sets: 1 });
  assert.strictEqual(same.movements[0].edited_by_human, false);
  const diff = inv.commitBom(BATCH, [bomItem({ total_quantity: 24, intake_quantity: 20, edited_by_human: false })], [], { sets: 1 });
  assert.strictEqual(diff.movements[0].edited_by_human, true, "数量与应入库量不同即为人工改过");
});

t("**绝不回写 BOM**：传入的 items 在入库后逐字段不变", () => {
  const items = [bomItem({ intake_quantity: 10 })];
  const snapshot = JSON.parse(JSON.stringify(items));
  inv.commitBom(BATCH, items, [], { sets: 3 });
  assert.deepStrictEqual(items, snapshot, "BOM 是只读事实，入库不得改动它");
});

t("BOM 原数量不参与累加：改 quantity_per_board 不影响入库量", () => {
  const a = inv.commitBom(BATCH, [bomItem({ quantity_per_board: 1, total_quantity: 24, intake_quantity: 24 })], [], { sets: 1 });
  const b = inv.commitBom(BATCH, [bomItem({ quantity_per_board: 999, total_quantity: 24, intake_quantity: 24 })], [], { sets: 1 });
  assert.strictEqual(a.parts[0].quantity, 24);
  assert.strictEqual(b.parts[0].quantity, 24, "累加只看本次入库量");
});

/* ================================================== §4 跳过与异常路径 */

section("§4 跳过与异常（AC-1 FR-1.7 / FR-1.8）");

t("action=skip → 不入库并记录跳过原因（用人工备注承载）", () => {
  const items = [bomItem({ row_no: 1 }), bomItem({ row_no: 2, action: "skip", note: "已有实物，暂不入库" })];
  const r = inv.commitBom(BATCH, items, [], { sets: 1 });
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.parts.length, 1);
  assert.strictEqual(r.skip_details[0].reason, "已有实物，暂不入库");
  assert.strictEqual(r.movements.length, 1, "跳过的不产生变动记录");
});

t("本次入库量填 0 → 视同跳过并提示，**不产生变动记录**", () => {
  const r = inv.commitBom(BATCH, [bomItem({ intake_quantity: 0 })], [], { sets: 1 });
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.added, 0);
  assert.deepStrictEqual(r.movements, []);
  assert.ok(/视同跳过/.test(r.skip_details[0].reason));
});

t("本次入库量填 -1 / abc / 缺失 → 拒绝该条并报错，不入库", () => {
  // 注意 null/undefined/"" 也算拒绝：**"字段没传"不能当成"用户想跳过"**，
  // 否则导入时会静默丢掉一整行。只有显式的 0 才是"视同跳过"（见上一条）。
  for (const bad of [-1, "abc", 1.5, null, undefined, ""]) {
    const r = inv.commitBom(BATCH, [bomItem({ intake_quantity: bad })], [], { sets: 1 });
    assert.strictEqual(r.added, 0, `intake=${JSON.stringify(bad)} 不该入库`);
    assert.strictEqual(r.skipped, 1, `intake=${JSON.stringify(bad)} 应计入跳过`);
    assert.strictEqual(r.errors.length, 1, `intake=${JSON.stringify(bad)} 应报错`);
    assert.ok(/必须是非负整数/.test(r.errors[0]), r.errors[0]);
    assert.deepStrictEqual(r.movements, []);
  }
  // 反证：显式的数字 0 走的是"视同跳过"而不是报错
  const zero = inv.commitBom(BATCH, [bomItem({ intake_quantity: 0 })], [], { sets: 1 });
  assert.strictEqual(zero.errors.length, 0, "显式 0 是合规输入，只跳过不报错");
  assert.strictEqual(zero.skipped, 1);
});

t("FR-1.8：新增 N + 合并 M + 跳过 K **= 条目总数**", () => {
  const base = [bomItem({ row_no: 1 })];
  const first = inv.commitBom(BATCH, base, [], { sets: 1 });
  const items = [
    bomItem({ row_no: 1 }),                                  // 合并
    bomItem({ row_no: 2, value: "22uF", footprint: "C1206" }), // 新增
    bomItem({ row_no: 3, action: "skip", note: "不要" }),      // 跳过
    bomItem({ row_no: 4, intake_quantity: 0 }),                // 视同跳过
    bomItem({ row_no: 5, intake_quantity: "abc" }),            // 非法 → 跳过
  ];
  const r = inv.commitBom(BATCH, items, first.parts, { sets: 1 });
  assert.strictEqual(r.summary.total, 5);
  assert.strictEqual(r.summary.added, 1);
  assert.strictEqual(r.summary.merged, 1);
  assert.strictEqual(r.summary.skipped, 3);
  assert.strictEqual(r.summary.added + r.summary.merged + r.summary.skipped, r.summary.total);
});

t("全部条目都被跳过 → 不产生变动记录（AC-1 异常路径）", () => {
  const items = [bomItem({ row_no: 1, action: "skip", note: "x" }), bomItem({ row_no: 2, action: "skip", note: "y" })];
  const r = inv.commitBom(BATCH, items, [], { sets: 1 });
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.merged, 0);
  assert.deepStrictEqual(r.movements, []);
  assert.deepStrictEqual(r.parts, []);
});

/* ================================================== §5 出库（FR-7.1~7.3） */

section("§5 出入库（FR-7.1 / FR-7.2 / FR-7.3）");

t("出库 5 → 库存 -5，并生成 kind=out 的变动记录（含原因）", () => {
  const parts = inv.commitBom(BATCH, [bomItem()], [], { sets: 1 }).parts;
  assert.strictEqual(parts[0].quantity, 24);
  const r = inv.moveStock(parts[0].id, -5, "打样领用", parts);
  assert.strictEqual(r.parts[0].quantity, 19);
  assert.strictEqual(r.movement.kind, "out");
  assert.strictEqual(r.movement.delta, -5);
  assert.strictEqual(r.movement.before, 24);
  assert.strictEqual(r.movement.after, 19);
  assert.strictEqual(r.movement.reason, "打样领用");
});

t("**库存 5 尝试出库 10 → 拒绝**，库存不变、无变动记录（FR-7.2）", () => {
  const parts = inv.commitBom(BATCH, [bomItem({ total_quantity: 5, intake_quantity: 5 })], [], { sets: 1 }).parts;
  assert.throws(() => inv.moveStock(parts[0].id, -10, "领用", parts), /库存不足/);
  assert.strictEqual(parts[0].quantity, 5, "原数组不得被改动");
});

t("正好出完（库存 5 出 5）允许；再出 1 则拒绝", () => {
  const parts = inv.commitBom(BATCH, [bomItem({ total_quantity: 5, intake_quantity: 5 })], [], { sets: 1 }).parts;
  const r = inv.moveStock(parts[0].id, -5, "全领", parts);
  assert.strictEqual(r.parts[0].quantity, 0);
  assert.throws(() => inv.moveStock(r.parts[0].id, -1, "再领", r.parts), /库存不足/);
});

t("入库为正数、kind=in；可指定 adjust 作修正", () => {
  const parts = inv.commitBom(BATCH, [bomItem()], [], { sets: 1 }).parts;
  const add = inv.moveStock(parts[0].id, 6, "补货", parts);
  assert.strictEqual(add.movement.kind, "in");
  assert.strictEqual(add.parts[0].quantity, 30);
  const adj = inv.moveStock(parts[0].id, -4, "盘点修正", parts, { kind: "adjust" });
  assert.strictEqual(adj.movement.kind, "adjust");
  assert.strictEqual(adj.parts[0].quantity, 20);
});

t("delta 为 0 / 非整数 / 器件不存在 → 明确报错", () => {
  const parts = inv.commitBom(BATCH, [bomItem()], [], { sets: 1 }).parts;
  assert.throws(() => inv.moveStock(parts[0].id, 0, "空操作", parts), /非 0 整数/);
  assert.throws(() => inv.moveStock(parts[0].id, 1.5, "半个", parts), /非 0 整数/);
  assert.throws(() => inv.moveStock("p_9999", -1, "不存在", parts), /器件不存在/);
});

/* ======================================== §6 按 BOM 领料（FR-7.4/7.5/AC-7） */

section("§6 按 BOM 领料（FR-7.4 / FR-7.5 / AC-7）");

/** 建一个含 1 条 10uF 的库（数量 20），BOM 需要 24 —— 缺口 4 */
function pickFixture() {
  const parts = inv.commitBom(BATCH, [bomItem({ total_quantity: 20, intake_quantity: 20 })], [], { sets: 1 }).parts;
  const items = [bomItem({ quantity_per_board: 24, total_quantity: 24 })];
  return { parts, items };
}

t("BOM 需 24 / 库存 20 → 提示缺口 4，允许部分领用（按 20 扣，FR-7.4/7.5）", () => {
  const { parts, items } = pickFixture();
  const r = inv.pickByBom(items, 1, parts, { pick_id: "pick_1", reason: "打样", allow_partial: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.picked.length, 1);
  assert.strictEqual(r.picked[0].required, 24);
  assert.strictEqual(r.picked[0].deducted, 20);
  assert.strictEqual(r.picked[0].after, 0);
  assert.strictEqual(r.insufficient.length, 1);
  assert.strictEqual(r.insufficient[0].shortfall, 4);
  assert.strictEqual(r.parts[0].quantity, 0);
});

t("allow_partial=false（默认）→ **整单拒绝**，不产生任何变动（plan §6）", () => {
  const { parts, items } = pickFixture();
  const r = inv.pickByBom(items, 1, parts, { pick_id: "pick_2", reason: "打样" });
  assert.strictEqual(r.ok, false);
  assert.ok(/库存不足，整单拒绝/.test(r.error), r.error);
  assert.deepStrictEqual(r.picked, []);
  assert.deepStrictEqual(r.movements, []);
  assert.strictEqual(r.parts[0].quantity, 20, "整单拒绝时库存不得变动");
  assert.strictEqual(r.insufficient.length, 1, "仍要告诉用户缺口在哪");
});

t("库中没有的条目 → 列入 unknown，明确列出而不静默跳过（AC-7 异常路径）", () => {
  const { parts } = pickFixture();
  const items = [
    bomItem({ row_no: 1, quantity_per_board: 5, total_quantity: 5 }),
    bomItem({ row_no: 2, value: "33pF", footprint: "C0603", quantity_per_board: 2, total_quantity: 2 }),
  ];
  const r = inv.pickByBom(items, 1, parts, { pick_id: "pick_3", reason: "打样", allow_partial: true });
  assert.strictEqual(r.unknown.length, 1);
  assert.strictEqual(r.unknown[0].row_no, 2);
  assert.strictEqual(r.unknown[0].value, "33pF");
  assert.strictEqual(r.unknown[0].required, 2);
  assert.strictEqual(r.picked.length, 1, "库中有的条目照常领");
});

t("**跨来源** BOM 也能按 BOM 领料：EDA 封装名 + 型号相同 → 匹配到库里的立创封装器件（v2.11 回归）", () => {
  // 修复前：比对按型号能找到、按 BOM 领料却报"库中没有"，两个入口结论互相矛盾
  const parts = [{
    id: "p_hdr", value: "PM254V-11-03-H85", footprint: "插件,P=2.54mm",
    part_number: "PM254V-11-03-H85", quantity: 5, category: "排母", mpn_list: [],
  }];
  const items = [bomItem({
    row_no: 1, value: "", footprint: "HDR-TH_3P-P2.54-V-F",
    manufacturer_part: "PM254V-11-03-H85", quantity_per_board: 2, total_quantity: 2,
    voltage: "", dielectric: "", tolerance: "",
  })];
  const r = inv.pickByBom(items, 1, parts, { pick_id: "pick_cross", reason: "跨来源领料" });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.unknown.length, 0, "不应再报「库中没有」");
  assert.strictEqual(r.picked.length, 1);
  assert.strictEqual(r.picked[0].deducted, 2);
  assert.strictEqual(r.parts[0].quantity, 3);
});

t("AC-7：同一次领料的每条扣减**带同一批次 ref**", () => {
  const parts = inv.commitBom(BATCH, [
    bomItem({ row_no: 1, total_quantity: 10, intake_quantity: 10 }),
    bomItem({ row_no: 2, value: "1k", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%", total_quantity: 10, intake_quantity: 10 }),
  ], [], { sets: 1 }).parts;
  const items = [
    bomItem({ row_no: 1, quantity_per_board: 3, total_quantity: 3 }),
    bomItem({ row_no: 2, value: "1k", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%", quantity_per_board: 4, total_quantity: 4 }),
  ];
  const r = inv.pickByBom(items, 1, parts, { pick_id: "pick_AC7", reason: "打样" });
  assert.strictEqual(r.movements.length, 2);
  for (const m of r.movements) {
    assert.strictEqual(m.kind, "out");
    assert.strictEqual(m.ref, "pick_AC7", "同一批次的 ref 必须一致");
  }
  assert.deepStrictEqual(r.movements.map((m) => m.delta), [-3, -4]);
  assert.deepStrictEqual(r.parts.map((p) => p.quantity), [7, 6]);
});

t("套数参与需求计算；需求 0 的条目不产生扣减", () => {
  const { parts } = pickFixture();
  const items = [bomItem({ quantity_per_board: 8, total_quantity: 8 }), bomItem({ row_no: 2, quantity_per_board: 0 })];
  const r = inv.pickByBom(items, 2, parts, { pick_id: "pick_4", reason: "试产", allow_partial: true });
  assert.strictEqual(r.picked[0].required, 16, "需求 = 单套 × 套数");
  assert.strictEqual(r.picked.length, 1, "需求 0 的条目不该出现在扣减清单里");
});

t("**同判定键多行**（不同位号/厂牌）不得重复扣减：合起来也不能超过库存（审计发现的负库存 bug）", () => {
  const { parts } = pickFixture(); // p_0001 库存 20
  const two = [
    bomItem({ row_no: 1, quantity_per_board: 20 }),
    bomItem({ row_no: 2, quantity_per_board: 20 }),
  ];
  // 两行同规格 → 指向同一个器件，合计需求 40 > 库存 20
  const plan = inv.pickByBom(two, 1, parts, { pick_id: "pick_dup", reason: "试产" });
  assert.strictEqual(plan.ok, false, "合计超过库存时必须整单拒绝");
  assert.strictEqual(plan.insufficient.length, 1, "应报 1 条不足（而不是两条都以为够）");
  assert.strictEqual(plan.parts[0].quantity, 20, "拒绝时库存分毫不动");

  // 允许部分时：扣减总额也得封顶在库存上，绝不能变负
  const partial = inv.pickByBom(two, 1, parts, { pick_id: "pick_dup2", reason: "试产", allow_partial: true });
  assert.strictEqual(partial.ok, true, partial.error);
  assert.strictEqual(partial.parts[0].quantity, 0, "最多扣到 0，不能变负");
  const sum = partial.movements.reduce((acc, m) => acc + m.delta, 0);
  assert.strictEqual(sum, -20, "扣减总额必须等于库存（20），不能是 -40");
});

t("缺少 pick_id / 套数非法 → 明确报错（批次号由调用方给）", () => {
  const { parts, items } = pickFixture();
  assert.throws(() => inv.pickByBom(items, 1, parts, {}), /pick_id/);
  assert.throws(() => inv.pickByBom(items, 0, parts, { pick_id: "x", reason: "x" }), /套数/);
});

/* ============================================================ §7 变动查询 */

section("§7 变动记录查询（plan §6.3 movements:list）");

const MOVES = [
  { id: "m_0001", part_id: "p_0001", at: "2026-10-15T10:00:00+08:00", ref: "batch_a" },
  { id: "m_0002", part_id: "p_0002", at: "2026-10-15T12:00:00+08:00", ref: "batch_a" },
  { id: "m_0003", part_id: "p_0001", at: "2026-10-15T11:00:00+08:00", ref: "pick_b" },
];

t("不传条件 → 全部，且按时间倒序", () => {
  assert.deepStrictEqual(inv.filterMovements(MOVES).map((m) => m.id), ["m_0002", "m_0003", "m_0001"]);
});

t("按 part_id / ref 过滤", () => {
  assert.deepStrictEqual(inv.filterMovements(MOVES, { part_id: "p_0001" }).map((m) => m.id), ["m_0003", "m_0001"]);
  assert.deepStrictEqual(inv.filterMovements(MOVES, { ref: "batch_a" }).map((m) => m.id), ["m_0002", "m_0001"]);
  assert.deepStrictEqual(inv.filterMovements(MOVES, { part_id: "p_0001", ref: "pick_b" }).map((m) => m.id), ["m_0003"]);
  assert.deepStrictEqual(inv.filterMovements(MOVES, { part_id: "p_9999" }), []);
});

/* ==================================================== §8 端到端与纯度 */

section("§8 端到端（inventory 算 → store 落盘）与纯度自检");

t("入库链路端到端：丢给 store 落盘后能原样读回，且变动记录由 store 赋 id/时间", () => {
  const base = path.join(TMP, "e2e");
  fs.mkdirSync(base, { recursive: true });
  const s = createStore({ base_dir: base });
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  const r = inv.commitBom("batch_e2e", parsed.items, s.loadParts(), { sets: 1, source: MAIN_BOM });
  s.saveParts(r.parts);
  for (const m of r.movements) s.appendMovement(m); // id/at 由 store 统一赋

  const parts = s.loadParts();
  const movements = s.loadMovements();
  assert.strictEqual(parts.length, 32);
  assert.strictEqual(movements.length, 33);
  assert.strictEqual(movements[0].id, "m_0001");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(movements[0].at), "时间由 store 补: " + movements[0].at);
  assert.strictEqual(movements[0].kind, "in");
  assert.strictEqual(movements[0].ref, "batch_e2e");
  // 库里数量 = 该判定键所有入库量之和
  const total = movements.reduce((sum, m) => sum + m.delta, 0);
  assert.strictEqual(parts.reduce((sum, p) => sum + p.quantity, 0), total);
});

t("inventory.js **不含写能力**：无 fs、不调 store 的写函数（剥注释后扫源码）", () => {
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const src = stripComments(fs.readFileSync(path.join(PROJECT_ROOT, "src", "services", "inventory.js"), "utf8"));
  for (const re of [/require\(\s*["']fs["']\s*\)/, /writeFileSync|renameSync|unlinkSync|mkdirSync|copyFileSync/,
    /saveParts|appendMovement|saveSettings|restoreFrom|writeJsonAtomic/]) {
    assert.ok(!re.test(src), "inventory.js 命中禁用模式 " + re);
  }
  assert.ok(/require\(/.test(src), "扫描前处理有误：源码被清空了");
});

t("传入的 parts 数组不被就地修改（commitBom / moveStock / pickByBom 都返回副本）", () => {
  const parts = inv.commitBom(BATCH, [bomItem()], [], { sets: 1 }).parts;
  const snapshot = JSON.parse(JSON.stringify(parts));
  inv.commitBom(BATCH, [bomItem()], parts, { sets: 1 });
  inv.moveStock(parts[0].id, -1, "x", parts);
  inv.pickByBom([bomItem({ quantity_per_board: 1, total_quantity: 1 })], 1, parts, { pick_id: "p1", reason: "测试领料", allow_partial: true });
  assert.deepStrictEqual(parts, snapshot, "调用方数组必须保持不变");
});

/* ===================================================== §9 闭环集成 */

section("§9 闭环集成：导入 → 比对 → 领料 → 再比对（工具的核心价值）");

t("一次跑通：导入后无需采购 → 全领后全部缺料且缺口=需求量", () => {
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  const items = parsed.items;

  // ① 导入：空库 → 32 条（33 行里有一对同规格）
  const commit = inv.commitBom("batch_loop", items, [], { sets: 1, source: MAIN_BOM });
  assert.strictEqual(commit.parts.length, 32);
  const library = commit.parts;

  // ② 比对：库里就是照这份 BOM 录的 → 33 行全部"够用"，无需采购
  const before = cmp.compareBom(items, library, 1);
  assert.strictEqual(before.stats.enough, 33);
  assert.strictEqual(before.stats.shortfall, 0);
  assert.deepStrictEqual(before.shortfall, [], "刚入库就提示要采购，说明去重或比对坏了");

  // ③ 领料：按同一份 BOM 全领（allow_partial 以防边界），扣减记录共用同一批次
  const pick = inv.pickByBom(items, 1, library, { pick_id: "pick_loop", reason: "打样领用", allow_partial: true });
  assert.strictEqual(pick.ok, true, pick.error);
  assert.strictEqual(pick.unknown.length, 0, "库里应有全部条目");
  assert.ok(pick.movements.length > 0);
  for (const m of pick.movements) {
    assert.strictEqual(m.kind, "out");
    assert.strictEqual(m.ref, "pick_loop");
  }
  assert.strictEqual(pick.parts.reduce((s, p) => s + p.quantity, 0), 0, "全领之后库存应为 0");

  // ④ 再比对：这次全都缺料，且缺口 = 需求量（正是"该采购多少"的答案）
  const after = cmp.compareBom(items, pick.parts, 1);
  assert.strictEqual(after.stats.shortfall, 33);
  const needSum = items.reduce((s, it) => s + it.total_quantity, 0);
  assert.strictEqual(after.shortfall.reduce((s, it) => s + it.shortfall_quantity, 0), needSum);

  // ⑤ 把缺料清单交给导出格式层（T4），应立即得到可下单的立创配单表
  const sheet = ef.buildLcscRows(after.shortfall);
  assert.strictEqual(sheet.rows.length, 34, "1 行表头 + 33 行缺料");
  assert.deepStrictEqual(sheet.columns, ["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"]);
  const qtySum = sheet.rows.slice(1).reduce((s, row) => s + row[6], 0);
  assert.strictEqual(qtySum, needSum, "导出数量列合计应等于采购总量（缺口口径）");
});

t("部分领料后：只有被领的条目变成缺料，其余仍够用", () => {
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  const items = parsed.items;
  const library = inv.commitBom("batch_loop2", items, [], { sets: 1 }).parts;

  // 只领前 3 行
  const pick = inv.pickByBom(items.slice(0, 3), 1, library, { pick_id: "pick_part", reason: "只领一部分", allow_partial: true });
  assert.strictEqual(pick.picked.length, 3);

  const after = cmp.compareBom(items, pick.parts, 1);
  assert.ok(after.stats.shortfall > 0, "领走的那几条应变成缺料");
  assert.ok(after.stats.enough > 0, "没被领的条目仍应够用");
  assert.strictEqual(after.stats.shortfall + after.stats.enough + after.stats.uncertain, 33);
});

/* ============================================================== 清理与汇总 */

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (ignored) { /* 清理失败不影响结论 */ }

console.log("\n" + "=".repeat(64));
console.log(`T8（inventory）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
