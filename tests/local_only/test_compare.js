"use strict";
/**
 * test_compare.js — T7（plan §9 的 T8）验收测试
 *
 * 运行： node tests/test_compare.js
 *
 * 三块重点：
 *   §1~§2  AC-2 的缺口语义与全部分组边界（含 v1.2 冻结的"够不够"语义）
 *   §3~§4  疑似匹配与单位归一化（spec §5.2：0.1uF 与 100nF 是同一种料）
 *   §5     **FR-2.5/2.6：比对前后库文件逐字节相同**——这是本工具的信任基础
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cmp = require("../src/services/compare");
const bp = require("../src/services/bom_parser");
const ef = require("../src/services/export_format");
const { createStore } = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = "sample_bom";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_cmp_"));

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

/** BOM 条目（plan §6 BomItem 的关键字段） */
function bomItem(over = {}) {
  return Object.assign({
    row_no: 1,
    designators: ["C1", "C2"],
    quantity_per_board: 8,
    total_quantity: 8,
    value: "10uF",
    footprint: "C1210",
    voltage: "50V",
    dielectric: "X7R",
    tolerance: "±10%",
    manufacturer_part: "1210B106K500NT",
    manufacturer: "FH(风华)",
    supplier_part: "C116808",
  }, over);
}

/** 库存器件（plan §3.1 Part 的关键字段） */
function part(over = {}) {
  return Object.assign({
    id: "p_0001",
    value: "10uF",
    footprint: "C1210",
    voltage: "50V",
    dielectric: "X7R",
    tolerance: "±10%",
    quantity: 24,
  }, over);
}

/* ============================ §1b 功率/载流进参数列（spec §4.2 / §5.2） */

section("§1b 功率与载流：CompareItem 要带上，否则导出的参数列永远少这一项");

t("匹配到库中器件 → CompareItem 的 power/current 取自**那条器件**", () => {
  const r = cmp.compareBom(
    [bomItem({ quantity_per_board: 10 })],
    [part({ quantity: 0, power: "1/4W", current: "3A" })],
    1,
  );
  assert.strictEqual(r.shortfall.length, 1);
  const item = r.shortfall[0];
  assert.strictEqual(item.power, "1/4W", "功率应来自库中器件（BOM 里没有这项）");
  assert.strictEqual(item.current, "3A", "载流同上");
  // 拼出来的参数列（spec §4.2 顺序：值 耐压 材质 容差 功率 载流）
  assert.strictEqual(ef.buildParams(item), "10uF ±10% 50V X7R 1/4W 3A");
});

t("库中器件没填功率/载流 → 空串（不是 undefined，参数列不会出现「undefined」）", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 10 })], [part({ quantity: 0 })], 1);
  assert.strictEqual(r.shortfall[0].power, "");
  assert.strictEqual(r.shortfall[0].current, "");
  assert.strictEqual(ef.buildParams(r.shortfall[0]), "10uF ±10% 50V X7R");
});

t("库里没有这条（缺料）→ 功率/载流留空：本来就没有信息，不是丢数据", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 10 })], [], 1);
  assert.strictEqual(r.shortfall[0].match_reason, "none");
  assert.strictEqual(r.shortfall[0].power, "");
  assert.strictEqual(r.shortfall[0].current, "");
});

t("疑似行（有候选器件）也带出候选的功率/载流——勾选「包含疑似」导出时才有内容", () => {
  const r = cmp.compareBom(
    [bomItem({ voltage: "", dielectric: "", tolerance: "" })],
    [part({ id: "p_c", power: "1/8W", current: "1A" })],
    1,
  );
  assert.strictEqual(r.uncertain.length, 1, "库里有候选 → 进疑似");
  assert.strictEqual(r.uncertain[0].power, "1/8W");
  assert.strictEqual(r.uncertain[0].current, "1A");
});

/* ================================================== §1 AC-2 缺口语义边界 */

section("§1 AC-2 缺口语义（spec §4.2 v1.2 已冻结）");

t("需 24 / 库存 24 → 够用，不导出", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 24 })], [part({ quantity: 24 })], 1);
  assert.strictEqual(r.stats.enough, 1);
  assert.strictEqual(r.stats.shortfall, 0);
  assert.deepStrictEqual(r.shortfall, []);
});

t("需 24 / 库存 23 → 缺料，缺口 1", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 24 })], [part({ quantity: 23 })], 1);
  assert.strictEqual(r.stats.shortfall, 1);
  assert.strictEqual(r.shortfall[0].stock_quantity, 23);
  assert.strictEqual(r.shortfall[0].shortfall_quantity, 1);
  assert.strictEqual(r.shortfall[0].required_quantity, 24);
});

t("需 24 / 库存 25 → 够用，不导出", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 24 })], [part({ quantity: 25 })], 1);
  assert.strictEqual(r.stats.enough, 1);
  assert.strictEqual(r.stats.shortfall, 0);
});

t("套数 3、单套 8（=24）、库存 20 → 缺口 **4**（按套数放大后再算）", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 8 })], [part({ quantity: 20 })], 3);
  assert.strictEqual(r.shortfall[0].required_quantity, 24);
  assert.strictEqual(r.shortfall[0].shortfall_quantity, 4, "应按放大后的需求算缺口");
});

t("库中完全未入库 → 缺口 = 需求量（AC-2 异常路径）", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 24 })], [], 1);
  assert.strictEqual(r.shortfall[0].shortfall_quantity, 24);
  assert.strictEqual(r.shortfall[0].stock_quantity, 0);
  assert.strictEqual(r.shortfall[0].matched_part_id, "");
  assert.strictEqual(r.shortfall[0].match_reason, "none");
});

t("Quantity 为 0 → 需求 0，不判缺料、不进导出（AC-2 边界）", () => {
  const r = cmp.compareBom([bomItem({ quantity_per_board: 0 })], [], 1);
  assert.strictEqual(r.stats.shortfall, 0);
  assert.strictEqual(r.stats.enough, 1, "需求 0 且库存 0 → 满足，归入够用");
  assert.strictEqual(r.enough[0].required_quantity, 0);
});

t("空库 → 全部条目归入缺料（AC-2 异常路径）", () => {
  const items = [bomItem({ row_no: 1 }), bomItem({ row_no: 2, value: "1k", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%" })];
  const r = cmp.compareBom(items, [], 1);
  assert.strictEqual(r.stats.total, 2);
  assert.strictEqual(r.stats.shortfall, 2);
  assert.strictEqual(r.stats.no_stock, 2);
});

t("全部够用 → 缺料为空（界面据此提示「无需采购」）", () => {
  const items = [bomItem({ row_no: 1 }), bomItem({ row_no: 2 })];
  const r = cmp.compareBom(items, [part({ quantity: 99 })], 1);
  assert.deepStrictEqual(r.shortfall, []);
  assert.strictEqual(r.stats.shortfall, 0);
});

/* ==================================================== §2 stats 与契约字段 */

section("§2 stats 六项自洽 + CompareItem 字段照 plan §6 契约");

t("stats：total = 三类之和；缺料再分「库中没有」与「库存不足」", () => {
  const items = [
    bomItem({ row_no: 1, quantity_per_board: 5 }),                                   // 够用
    bomItem({ row_no: 2, value: "1k", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%" }), // 缺料·无库存
    bomItem({ row_no: 3, value: "100nF", footprint: "C0603", quantity_per_board: 10 }), // 缺料·不足
    bomItem({ row_no: 4, value: "22uF", footprint: "C1206", tolerance: "" }),          // 疑似（缺容差）
  ];
  const parts = [
    part({ id: "p_1", quantity: 5 }),
    part({ id: "p_2", value: "100nF", footprint: "C0603", voltage: "50V", dielectric: "X7R", tolerance: "±10%", quantity: 6 }),
    // 第 4 行的"部分匹配候选"：只有它存在时，缺容差才算"疑似"（否则没有歧义，就是缺料）
    part({ id: "p_3", value: "22uF", footprint: "C1206", voltage: "50V", dielectric: "X7R", tolerance: "±10%", quantity: 5 }),
  ];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.stats.total, 4);
  assert.strictEqual(r.stats.enough, 1);
  assert.strictEqual(r.stats.shortfall, 2);
  assert.strictEqual(r.stats.uncertain, 1);
  assert.strictEqual(r.stats.no_stock, 1);
  assert.strictEqual(r.stats.insufficient, 1);
  assert.strictEqual(r.stats.total, r.stats.enough + r.stats.shortfall + r.stats.uncertain);
});

/** 从 plan §6 的 CompareItem 表格里解析出字段名（按文档核对，不抄我自己的期望） */
function compareItemFieldsFromDoc() {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "plan.md"), "utf8");
  const section = text.split("### CompareItem")[1].split("### compare:export")[0];
  const fields = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").map((s) => s.trim()).filter((s) => s !== "");
    if (cols.length < 3 || cols[0] !== "响应") continue;
    // 文档里"实现期补记"的字段是**加粗**写的（如 `**power**`），先去掉强调标记再比
    const name = cols[1].replace(/[*`]/g, "").trim();
    if (name === "字段" || !/^[a-z_]+$/.test(name)) continue; // 跳过表头与 |---| 分隔行
    fields.push(name);
  }
  return fields.sort();
}

t("输出的每条 CompareItem 字段集 == plan §6 契约（多一个少一个都算偏离）", () => {
  const expected = compareItemFieldsFromDoc();
  assert.ok(expected.length >= 15, "契约字段解析异常: " + JSON.stringify(expected));
  const r = cmp.compareBom([bomItem({ quantity_per_board: 24 })], [part({ quantity: 3 })], 1);
  assert.deepStrictEqual(Object.keys(r.shortfall[0]).sort(), expected);
});

/* ============================================================ §3 疑似匹配 */

section("§3 疑似匹配（spec FR-2.3：需人工确认）");

t("BOM 缺容差（库里有）→ 归入疑似并列出 missing_fields，且给出部分匹配候选", () => {
  const r = cmp.compareBom([bomItem({ tolerance: "" })], [part({ id: "p_9", quantity: 24 })], 1);
  assert.strictEqual(r.stats.uncertain, 1);
  assert.strictEqual(r.stats.shortfall, 0, "无法精确判定时**不得**擅自算成缺料");
  const item = r.uncertain[0];
  assert.deepStrictEqual(item.missing_fields, ["tolerance"]);
  assert.strictEqual(item.match_reason, "partial");
  assert.strictEqual(item.matched_part_id, "p_9", "应给出候选帮人少看一眼");
  assert.strictEqual(item.stock_quantity, 24);
});

t("缺多个键字段、且库里有候选时全部列出；库里没有候选则直接判缺料", () => {
  // 有候选（同 值+封装）→ 疑似，且列出全部缺失字段
  const withCandidate = cmp.compareBom(
    [bomItem({ voltage: "", dielectric: "", tolerance: "" })],
    [part({ id: "p_c" })],
    1
  );
  assert.deepStrictEqual(withCandidate.uncertain[0].missing_fields, ["voltage", "dielectric", "tolerance"]);
  assert.strictEqual(withCandidate.uncertain[0].matched_part_id, "p_c");
  // 库里空 → 没有歧义，就是缺料（spec AC-2「比对时库为空 → 全部条目归入缺料」）
  const noCandidate = cmp.compareBom([bomItem({ voltage: "", dielectric: "", tolerance: "" })], [], 1);
  assert.strictEqual(noCandidate.stats.shortfall, 1);
  assert.strictEqual(noCandidate.stats.uncertain, 0);
});

t("键字段齐全但库里没有 → 是**缺料**，不是疑似", () => {
  const r = cmp.compareBom([bomItem()], [part({ value: "22uF" })], 1);
  assert.strictEqual(r.stats.shortfall, 1);
  assert.strictEqual(r.stats.uncertain, 0);
  assert.strictEqual(r.shortfall[0].match_reason, "none");
});

/* ======================================================= §4 单位归一化判定 */

section("§4 判定键归一化（spec §5.2：判定前必须做）");

t("库里 `100nF` vs BOM `0.1uF` → **同一种料**（精确匹配）", () => {
  const items = [bomItem({ value: "0.1uF", footprint: "C0603", quantity_per_board: 10 })];
  const parts = [part({ id: "p_x", value: "100nF", footprint: "C0603", quantity: 10 })];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.stats.enough, 1, "归一化后应判为同一种料");
  assert.strictEqual(r.stats.uncertain, 0);
});

t("`1k` / `1kΩ` / `1000Ω` 三者互相匹配", () => {
  const items = [bomItem({ value: "1000Ω", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%" })];
  const parts = [part({ id: "p_r", value: "1k", footprint: "R0603", voltage: "", dielectric: "", tolerance: "±1%", quantity: 50 })];
  assert.strictEqual(cmp.compareBom(items, parts, 1).stats.enough, 1);
});

t("大小写/空格差异不影响判定", () => {
  const items = [bomItem({ value: "10uF", footprint: "c1210", voltage: "50v" })];
  const parts = [part({ footprint: " C1210 ", voltage: "50V" })];
  assert.strictEqual(cmp.compareBom(items, parts, 1).stats.enough, 1);
});

t("容差不同 → **不同料**（容差是五元组成员，不得忽略）", () => {
  const items = [bomItem({ tolerance: "±1%" })];
  const parts = [part({ tolerance: "±10%", quantity: 999 })];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.stats.shortfall, 1);
  assert.strictEqual(r.stats.enough, 0, "容差不同却算够用，会导致买错料");
});

t("dedupeKey 是全工程唯一实现：同键不同写法得到同一 key", () => {
  assert.strictEqual(cmp.dedupeKey({ value: "0.1uF", footprint: "C0603", voltage: "50V", dielectric: "X7R", tolerance: "±10%" }),
    cmp.dedupeKey({ value: "100nF", footprint: "c0603", voltage: "50v", dielectric: "x7r", tolerance: "±10%" }));
  assert.notStrictEqual(cmp.dedupeKey(part()), cmp.dedupeKey(part({ tolerance: "±1%" })));
});

/* ================================================== §5 只读性（信任基础） */

section("§5 FR-2.5/2.6：比对**绝不写库**（本工具的信任基础）");

t("比对前后 parts.json / movements.json **逐字节相同**", () => {
  const base = path.join(TMP, "readonly");
  fs.mkdirSync(base, { recursive: true });
  const s = createStore({ base_dir: base });
  s.saveParts([part({ id: "p_0001", quantity: 3 }), part({ id: "p_0002", value: "1k", footprint: "R0603", quantity: 50 })]);
  s.appendMovement({ part_id: "p_0001", kind: "in", delta: 3, reason: "初始" });

  const partsBefore = fs.readFileSync(s.paths().parts);
  const movementsBefore = fs.readFileSync(s.paths().movements);

  // 走真实链路：读库 → 比对（库里只有 3 个，BOM 要 24 个）
  const items = bp.parseBomFile(path.join(FIX, MAIN_BOM), 3).items;
  const result = cmp.compareBom(items, s.loadParts(), 3);
  assert.ok(result.ok);
  assert.strictEqual(result.stats.total, 33);

  assert.ok(partsBefore.equals(fs.readFileSync(s.paths().parts)), "**parts.json 必须字节级不变**");
  assert.ok(movementsBefore.equals(fs.readFileSync(s.paths().movements)), "**movements.json 必须字节级不变**");
});

t("FR-2.6：比对不产生任何变动记录", () => {
  const base = path.join(TMP, "nomove");
  fs.mkdirSync(base, { recursive: true });
  const s = createStore({ base_dir: base });
  s.saveParts([part({ quantity: 3 })]);
  const before = s.loadMovements().length;
  cmp.compareBom(bp.parseBomFile(path.join(FIX, MAIN_BOM), 1).items, s.loadParts(), 1);
  assert.strictEqual(s.loadMovements().length, before, "比对不得留下任何库内痕迹");
  assert.strictEqual(before, 0);
});

t("传入的 parts / items 数组不会被就地修改", () => {
  const items = [bomItem()];
  const parts = [part()];
  const itemsCopy = JSON.parse(JSON.stringify(items));
  const partsCopy = JSON.parse(JSON.stringify(parts));
  cmp.compareBom(items, parts, 2);
  assert.deepStrictEqual(items, itemsCopy, "items 被改动了");
  assert.deepStrictEqual(parts, partsCopy, "parts 被改动了");
});

t("源码层面就**没有写的能力**：无 fs、无写函数、不 require store", () => {
  // 先去掉注释再扫：注释里出现"writeFile"这类词只是说明文字，不构成能力。
  // （第一版没去注释，被自己文档注释里的 `writeFile` 判红——门禁也得防误报。）
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const src = stripComments(fs.readFileSync(path.join(PROJECT_ROOT, "src", "services", "compare.js"), "utf8"));
  const banned = [
    /require\(\s*["']fs["']\s*\)/, /require\(\s*["']\.\/store["']\s*\)/,
    /writeFileSync|writeFile\b|renameSync|unlinkSync|appendFileSync|createWriteStream|mkdirSync|copyFileSync/,
    /saveParts|appendMovement|saveSettings|restoreFrom/,
  ];
  for (const re of banned) {
    assert.ok(!re.test(src), "compare.js 命中禁用模式 " + re);
  }
  // 反证：去掉注释后源码里仍有 require，说明扫描确实在读代码（不是把文件读空了）
  assert.ok(/require\(/.test(src), "扫描前处理有误：源码被清空了");
});

/* ========================================================== §6 输入与联通 */

section("§6 输入校验与真实 BOM 联通");

t("套数非法 / items 非数组 → ok=false 且带原因", () => {
  for (const bad of [0, -1, 1.5, "abc"]) {
    const r = cmp.compareBom([bomItem()], [], bad);
    assert.strictEqual(r.ok, false);
    assert.ok(/套数/.test(r.error), r.error);
  }
  const r2 = cmp.compareBom("不是数组", [], 1);
  assert.strictEqual(r2.ok, false);
  assert.ok(/必须是数组/.test(r2.error));
});

t("套数只算一次：即便 items 的 total_quantity 已被乘过，也不会重复放大", () => {
  // 模拟"解析时已按套数 3 算过 total_quantity"的条目
  const items = [bomItem({ quantity_per_board: 8, total_quantity: 24 })];
  const r = cmp.compareBom(items, [], 3);
  assert.strictEqual(r.shortfall[0].required_quantity, 24, "需求应是 8×3=24，而不是 24×3=72");
});

t("真实主样本 + 空库：33 条全部缺料，缺口合计 = 各条需求量之和", () => {
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  const r = cmp.compareBom(parsed.items, [], 1);
  assert.strictEqual(r.stats.total, 33);
  assert.strictEqual(r.stats.shortfall, 33);
  const expectSum = parsed.items.reduce((s, it) => s + it.total_quantity, 0);
  const gotSum = r.shortfall.reduce((s, it) => s + it.shortfall_quantity, 0);
  assert.strictEqual(gotSum, expectSum, "空库时缺口合计应等于需求合计");
  assert.ok(expectSum > 0);
});

t("真实主样本 + 把样本本身当库存（数量充足）→ 全部够用、零缺口", () => {
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  const library = parsed.items.map((it, i) => ({
    id: "p_" + String(i + 1).padStart(4, "0"),
    value: it.value, footprint: it.footprint, voltage: it.voltage,
    dielectric: it.dielectric, tolerance: it.tolerance, quantity: it.total_quantity,
  }));
  // 真实数据里存在"同规格多行"（同一判定键出现多次）——如实记录这个事实
  const keyCounts = new Map();
  for (const it of parsed.items) keyCounts.set(cmp.dedupeKey(it), (keyCounts.get(cmp.dedupeKey(it)) || 0) + 1);
  const dupKeys = [...keyCounts.values()].filter((n) => n > 1);
  console.log(`        （真实主样本：${keyCounts.size} 个判定键 / ${parsed.items.length} 行，其中 ${dupKeys.length} 个键出现了多行）`);
  const r = cmp.compareBom(parsed.items, library, 1);
  assert.strictEqual(r.stats.shortfall, 0, "库里每条都有等量库存时应全部够用");
  assert.deepStrictEqual(r.shortfall, []);
  // 正是"同键库存相加"让上面这条成立：只取第一条会漏算第二行的库存。
  // 实测事实：真实主样本 33 行只有 **32 个判定键**，即有 1 个规格出现了两行
  // （→ 入库时 FR-1.9 会把它们并成一条、数量相加，见 T7 inventory 的验收点）。
  assert.strictEqual(dupKeys.length, 1, `主样本应恰好有 1 个重复判定键，实测 ${dupKeys.length}`);
  assert.strictEqual(dupKeys[0], 2, "该键应出现 2 行");
});

/* ============================ §7 跨来源匹配（v2.11 修「比对全缺料」） */

section("§7 跨来源匹配：EDA 封装名 vs 立创封装名（用户 2026-10-17 实测 bug）");

t("封装归一：EDA 写法与立创写法在判定键里等价（R0603↔0603、SOT-23_L…↔SOT-23、TQFN-16_L…↔TQFN-16-EP(3x3)）", () => {
  const sameKey = (a, b) => assert.strictEqual(cmp.dedupeKey(a), cmp.dedupeKey(b), JSON.stringify([a, b]));
  sameKey(
    { value: "10kΩ", footprint: "R0603" },
    { value: "10K", footprint: "0603" },
  );
  sameKey(
    { value: "100nF", footprint: "C0603" },
    { value: "0.1uF", footprint: "0603" },
  );
  sameKey(
    { value: "", footprint: "SOT-23_L2.9-W1.3-P1.90-LS2.4-BR", manufacturer_part: "AO3401A" },
    { value: "AO3401A", footprint: "SOT-23" },
  );
  sameKey(
    { value: "", footprint: "TQFN-16_L3.0-W3.0-P0.50-BL-EP1.1", manufacturer_part: "MAX98357AETE+T" },
    { value: "MAX98357AETE+T", footprint: "TQFN-16-EP(3x3)" },
  );
  sameKey(
    { value: "", footprint: "F1812", manufacturer_part: "1812L300/24SLER" },
    { value: "1812L300/24SLER", footprint: "1812" },
  );
  // 真不同的封装不能被归一成同一个（不能为了匹配而乱配）
  assert.notStrictEqual(
    cmp.dedupeKey({ value: "10uF", footprint: "C1206" }),
    cmp.dedupeKey({ value: "10uF", footprint: "C0805" }),
  );
});

t("值为空 → 按 v2.5「值=型号」参与判定：BOM 里 MOS/连接器值为空也能对上库里「值=型号」的同一颗料", () => {
  const a = cmp.dedupeKey({ value: "", footprint: "SOT-23", manufacturer_part: "AO3401A" });
  const b = cmp.dedupeKey({ value: "AO3401A", footprint: "SOT-23", part_number: "AO3401A" });
  assert.strictEqual(a, b);
});

t("容差归一：±1% / +/-1% / 1% 在判定键里相同", () => {
  const base = { value: "1kΩ", footprint: "R0603" };
  assert.strictEqual(
    cmp.dedupeKey(Object.assign({}, base, { tolerance: "±1%" })),
    cmp.dedupeKey(Object.assign({}, base, { tolerance: "+/-1%" })),
  );
  assert.strictEqual(
    cmp.dedupeKey(Object.assign({}, base, { tolerance: "±1%" })),
    cmp.dedupeKey(Object.assign({}, base, { tolerance: "1%" })),
  );
});

t("比对：判定键对不上、但型号相同 → 按型号匹配（match_reason=mpn），库存够就是够用", () => {
  const items = [bomItem({
    row_no: 1, value: "", footprint: "HDR-TH_3P-P2.54-V-F",
    manufacturer_part: "PM254V-11-03-H85", quantity_per_board: 2,
    voltage: "", dielectric: "", tolerance: "",
  })];
  const parts = [part({
    id: "p_hdr", value: "PM254V-11-03-H85", footprint: "插件,P=2.54mm",
    part_number: "PM254V-11-03-H85", quantity: 10,
  })];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.enough.length, 1, "应进够用（按型号匹配到库里的同型号器件）");
  assert.strictEqual(r.enough[0].match_reason, "mpn");
  assert.strictEqual(r.enough[0].matched_part_id, "p_hdr");
  assert.strictEqual(r.enough[0].stock_quantity, 10);
});

t("型号兜底也守缺口语义：需求 24 / 库存 10 → 缺料 14（不是 24）", () => {
  const items = [bomItem({
    row_no: 1, quantity_per_board: 24, value: "", footprint: "SW-TH_3P-L8.8-W3.9-P2.50_SS12D00G3",
    manufacturer_part: "SS-12D00-G3", voltage: "", dielectric: "", tolerance: "",
  })];
  const parts = [part({
    id: "p_sw", value: "SS-12D00-G3", footprint: "插件-3P,8.8x3.9mm",
    part_number: "SS-12D00-G3", quantity: 10,
  })];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.shortfall.length, 1);
  assert.strictEqual(r.shortfall[0].match_reason, "mpn");
  assert.strictEqual(r.shortfall[0].shortfall_quantity, 14, "缺口 = 需求 24 − 库存 10");
  assert.strictEqual(r.stats.insufficient, 1);
});

t("**安全阀**：型号相同但两边显式值冲突 → 不按型号硬配（33pF 不能认成 10uF 的库存）", () => {
  const items = [bomItem({
    row_no: 1, value: "33pF", footprint: "C0603", manufacturer_part: "1210B106K500NT",
    voltage: "", dielectric: "", tolerance: "",
  })];
  const parts = [part({
    id: "p_bad", value: "10uF", footprint: "1210",
    part_number: "1210B106K500NT", quantity: 100,
  })];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.enough.length, 0, "不能因为型号相同就把 33pF 认成 10uF");
  assert.strictEqual(r.shortfall.length + r.uncertain.length, 1, "应归入缺料/疑似，交人工");
});

t("**真实主样本 ×「对账单口径」库存**：库里按 值+立创封装+型号 建（不是同一份 BOM 录的）→ 不再全军覆没", () => {
  // 复现用户场景：库是「对账单入库」的（封装为立创写法、连接器等以值=型号），
  // BOM 是 EDA 导出的（封装是 EDA 写法）。修复前 33 行全部误判缺料。
  const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
  const isChip = (fp) => /^[RCLDF]\d{3,4}$/i.test(String(fp || ""));
  const library = parsed.items.map((it, i) => ({
    id: "p_" + String(i + 1).padStart(4, "0"),
    // 对账单口径：无参数值的料「值=型号」；有值的料值就是参数值
    value: it.value || it.manufacturer_part,
    // 对账单口径封装：贴片被动件是纯尺寸；其余用立创式描述（与 EDA 写法不同）
    footprint: isChip(it.footprint) ? String(it.footprint).slice(1) : "SMD,插件封装",
    part_number: it.manufacturer_part,
    quantity: 100,
  }));
  const r = cmp.compareBom(parsed.items, library, 1);
  assert.strictEqual(r.stats.shortfall, 0, "库存充足且型号都能对上时不应有缺料（修复前 33 条全缺）");
  assert.strictEqual(r.stats.uncertain, 0, "不应有疑似（型号能确认）");
  assert.strictEqual(r.stats.enough, parsed.items.length);
  const mpnCount = r.enough.filter((x) => x.match_reason === "mpn").length;
  console.log(`        （33 行中按判定键 ${r.enough.length - mpnCount} 条、按型号 ${mpnCount} 条）`);
});

/* ============================ §8 人工裁决（比对页确认键的规则） */

section("§8 人工裁决 applyRulings（疑似行的「是同一颗 / 不是同一颗」）");

function uncertainResult() {
  return {
    ok: true, compare_id: "compare_test", enough: [], shortfall: [],
    uncertain: [
      { row_no: 1, required_quantity: 5, stock_quantity: 10, shortfall_quantity: 0, matched_part_id: "p_a", missing_fields: ["tolerance"] },
      { row_no: 2, required_quantity: 8, stock_quantity: 3, shortfall_quantity: 0, matched_part_id: "p_b", missing_fields: ["voltage"] },
      { row_no: 3, required_quantity: 2, stock_quantity: 0, shortfall_quantity: 0, matched_part_id: "", missing_fields: ["value"] },
    ],
    stats: { total: 3, enough: 0, shortfall: 0, uncertain: 3, no_stock: 0, insufficient: 0 },
  };
}

t("确认「同一颗」→ 按候选库存算：够的进够用、不够的按 max(0,需求−库存) 进缺料", () => {
  const r = cmp.applyRulings(uncertainResult(), { 1: "same", 2: "same" });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.uncertain.length, 1, "只剩未裁决的第 3 行");
  assert.deepStrictEqual(r.enough.map((x) => x.row_no), [1]);
  assert.strictEqual(r.enough[0].match_reason, "confirmed_same");
  assert.strictEqual(r.enough[0].confirmed_by_human, true);
  assert.deepStrictEqual(r.shortfall.map((x) => x.row_no), [2]);
  assert.strictEqual(r.shortfall[0].shortfall_quantity, 5, "需求 8 − 库存 3 = 缺口 5");
});

t("确认「不是同一颗」→ 从疑似移入缺料：库存 0、缺口 = 需求", () => {
  const r = cmp.applyRulings(uncertainResult(), { 3: "different" });
  assert.strictEqual(r.shortfall.length, 1);
  assert.strictEqual(r.shortfall[0].row_no, 3);
  assert.strictEqual(r.shortfall[0].match_reason, "confirmed_different");
  assert.strictEqual(r.shortfall[0].stock_quantity, 0);
  assert.strictEqual(r.shortfall[0].shortfall_quantity, 2);
  assert.strictEqual(r.uncertain.length, 2, "未裁决的两条仍在疑似");
});

t("统计随裁决重算；rulings 为空/非法值 → 全部回到未裁决；非对象 → 明确报错", () => {
  const all = cmp.applyRulings(uncertainResult(), { 1: "same", 2: "different", 3: "same" });
  assert.deepStrictEqual(
    [all.stats.total, all.stats.enough, all.stats.shortfall, all.stats.uncertain],
    [3, 1, 2, 0],
  );
  const reset = cmp.applyRulings(uncertainResult(), { 1: "maybe", 2: null });
  assert.strictEqual(reset.stats.uncertain, 3, "非法裁决值不生效，仍留疑似");
  const bad = cmp.applyRulings(uncertainResult(), [1, 2]);
  assert.strictEqual(bad.ok, false);
  assert.ok(/rulings 必须是对象/.test(bad.error));
});

t("比对输出的疑似行带**候选器件身份快照**（界面要标清疑似的是哪条候选）", () => {
  // BOM 侧没有型号（常见：BOM 只写值/封装），所以不会走"型号相同"的精确匹配；
  // 缺 耐压/材质/容差 → 有候选才进疑似，候选身份要原样带出来。
  const items = [bomItem({
    row_no: 1, value: "10uF", footprint: "C1210", voltage: "", dielectric: "", tolerance: "",
    manufacturer_part: "",
  })];
  const parts = [part({
    id: "p_cand", value: "10uF", footprint: "1210", voltage: "50V", dielectric: "X7R",
    tolerance: "±10%", part_number: "M1", quantity: 999,
  })];
  const r = cmp.compareBom(items, parts, 1);
  assert.strictEqual(r.uncertain.length, 1);
  const u = r.uncertain[0];
  assert.strictEqual(u.candidate_value, "10uF");
  assert.strictEqual(u.candidate_footprint, "1210");
  assert.strictEqual(u.candidate_voltage, "50V");
  assert.strictEqual(u.candidate_dielectric, "X7R");
  assert.strictEqual(u.candidate_tolerance, "±10%");
  assert.strictEqual(u.candidate_part_number, "M1");
  assert.strictEqual(u.stock_quantity, 999);
});

/* ============================================================== 清理与汇总 */

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (ignored) { /* 清理失败不影响结论 */ }

console.log("\n" + "=".repeat(64));
console.log(`T7（compare）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
