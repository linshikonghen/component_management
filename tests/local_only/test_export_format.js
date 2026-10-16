"use strict";
/**
 * test_export_format.js — T4（plan §9 的 T13c 格式层）验收测试
 *
 * 运行：
 *   node tests/test_export_format.js
 *   node tests/test_export_format.js --out <path.xlsx>   # 用真实 BOM 出外部验收样本给用户上传立创
 *
 * 覆盖 spec §4.2 的**硬约束**：列结构、数量列=缺口（purchase_quantity）、
 * 参数列带单位且空格分隔、位号仅英文逗号、以及"无立创编号仍可导出"的异常路径。
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ef = require("../src/services/export_format");
const ex = require("../src/services/exporter");
const bp = require("../src/services/bom_parser");

const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = "sample_bom";
const FIXED_BOM = "sample_bom";

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

/** 造一个 CompareItem（plan §6 契约），只填本测试关心的字段 */
function compareItem(over = {}) {
  return Object.assign({
    row_no: 1,
    designators: ["C1", "C2"],
    quantity_per_board: 8,
    required_quantity: 24,
    value: "10uF",
    footprint: "C1210",
    voltage: "50V",
    dielectric: "X7R",
    tolerance: "±10%",
    power: "",
    part_number: "1210B106K500NT",
    manufacturer: "FH(风华)",
    supplier_part: "C116808",
    matched_part_id: "",
    stock_quantity: 3,
    shortfall_quantity: 21,
    match_reason: "none",
    missing_fields: [],
  }, over);
}

/* ============================================================ §1 列结构 */

section("§1 列结构（spec §4.2）");

t("模式一列名与顺序严格照 spec：型号/品牌/封装/参数/立创编号/位号/数量", () => {
  assert.deepStrictEqual(ef.LCSC_COLUMNS.map((c) => c.title),
    ["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"]);
  const { rows } = ef.buildLcscRows([]);
  assert.deepStrictEqual(rows, [["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"]]);
});

t("模式二列序严格照嘉立创官方：Comment/Description/Designator/Footprint/LibRef/Pins/Quantity/编号", () => {
  assert.deepStrictEqual(ef.JLC_COLUMNS.map((c) => c.title),
    ["Comment", "Description", "Designator", "Footprint", "LibRef", "Pins", "Quantity", "编号"]);
});

t("未知模式明确报错（不让调用方以为导出了）", () => {
  assert.throws(() => ef.buildRows([], "eda"), /未知导出模式/);
  assert.throws(() => ef.buildRows([], ""), /未知导出模式/);
});

t("每行列数与表头一致（不会有半截行）", () => {
  const { rows } = ef.buildLcscRows([compareItem(), compareItem({ row_no: 2 })]);
  for (const row of rows) assert.strictEqual(row.length, 7, "列数不一致: " + JSON.stringify(row));
});

/* ======================================================= §2 数量列 = 缺口 */

section("§2 数量列必须是**缺口**（spec §4.2 的 purchase_quantity）");

t("需 24 / 库存 3 → 数量列 21（不是 24）", () => {
  const { rows } = ef.buildLcscRows([compareItem({ required_quantity: 24, stock_quantity: 3, shortfall_quantity: 21 })]);
  assert.strictEqual(rows[1][6], 21);
  assert.strictEqual(typeof rows[1][6], "number", "数量必须是数字，不能是文本");
});

t("库中没有该条 → 数量列 = 需求量（AC-2 异常路径）", () => {
  const { rows } = ef.buildLcscRows([compareItem({ stock_quantity: 0, shortfall_quantity: 24 })]);
  assert.strictEqual(rows[1][6], 24);
});

t("缺口为 0 时不会写成 NaN/字符串", () => {
  const { rows } = ef.buildLcscRows([compareItem({ shortfall_quantity: 0 })]);
  assert.strictEqual(rows[1][6], 0);
  const { rows: bad } = ef.buildLcscRows([compareItem({ shortfall_quantity: undefined })]);
  assert.strictEqual(bad[1][6], 0, "缺失时应落 0 而不是 NaN");
});

t("两种模式的数量列都取缺口（FR-2.4 对导出内容的统一要求）", () => {
  const item = compareItem({ shortfall_quantity: 21 });
  assert.strictEqual(ef.buildLcscRows([item]).rows[1][6], 21);
  assert.strictEqual(ef.buildJlcRows([item]).rows[1][6], 21);
});

/* ========================================================= §3 参数列拼写 */

section("§3 参数列（spec §4.2：空格分隔、非空项连接、必须带单位）");

t("参数列顺序照 **spec 的拼写规范示例 + AC-8 验收表**（值 → 容差 → 耐压 → 材质），空项不产生多余空格", () => {
  // spec line 272「不同属性之间用空格分隔，如 `100nF ±10% 50V X7R`」
  // spec line 525（AC-8 验收表）同一个例子 —— 两处一致
  assert.strictEqual(ef.buildParams(compareItem()), "10uF ±10% 50V X7R");
  assert.strictEqual(ef.buildParams(compareItem({ voltage: "", dielectric: "", tolerance: "" })), "10uF");
  assert.strictEqual(ef.buildParams(compareItem({ value: "100nF", voltage: "100V", dielectric: "X7R", tolerance: "" })), "100nF 100V X7R");
  assert.strictEqual(
    ef.buildParams({ value: "100nF", voltage: "50V", dielectric: "X7R", tolerance: "±10%" }),
    "100nF ±10% 50V X7R",
    "必须与 spec:272 / AC-8(spec:525) 的示例逐字一致——用户就是拿这串去比对的",
  );
});

t("有功率时按 spec 计入（+power，按分类取舍）", () => {
  assert.strictEqual(ef.buildParams(compareItem({ value: "10k", voltage: "", dielectric: "", tolerance: "±1%", power: "1/4W" })), "10k ±1% 1/4W");
});

t("**载流**也进参数列（spec §5.2 明列；顺序在功率之后）", () => {
  assert.strictEqual(
    ef.buildParams(compareItem({ value: "1k", voltage: "", dielectric: "", tolerance: "", power: "1/4W", current: "3A" })),
    "1k 1/4W 3A",
  );
  assert.strictEqual(ef.buildParams(compareItem({ power: "", current: "" })), "10uF ±10% 50V X7R", "空值不参与拼接");
});

t("参数缺单位时警示（spec §4.2 必须带单位，但不替用户猜）", () => {
  const { warnings } = ef.buildLcscRows([compareItem({ value: "100", voltage: "", dielectric: "", tolerance: "" })]);
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.ok(/缺单位/.test(warnings[0]), warnings[0]);
  const clean = ef.buildLcscRows([compareItem()]);
  assert.deepStrictEqual(clean.warnings, [], "正常参数不该有警示");
});

t("参数列进的是表格里的第 4 列（模式一）/ 第 2 列（模式二）", () => {
  const item = compareItem();
  assert.strictEqual(ef.buildLcscRows([item]).rows[1][3], "10uF ±10% 50V X7R");
  assert.strictEqual(ef.buildJlcRows([item]).rows[1][1], "10uF ±10% 50V X7R");
  assert.strictEqual(ef.buildJlcRows([item]).rows[1][0], "10uF", "Comment 应是值");
});

/* ============================================================ §4 位号列 */

section("§4 位号列（spec §4.2：仅支持英文逗号或空格）");

t("数组 join 成英文逗号", () => {
  assert.strictEqual(ef.formatDesignators(["C1", "C2", "C10"], 1, []), "C1,C2,C10");
});

t("字符串里混入 `;` `|` `。` 等不支持符号时会被归一成逗号**并给出提示**（AC-8）", () => {
  const warnings = [];
  assert.strictEqual(ef.formatDesignators("R1;R2|R3。R4", 1, warnings), "R1,R2,R3,R4");
  assert.strictEqual(warnings.length, 1);
  assert.ok(/第 1 行/.test(warnings[0]) && /英文逗号/.test(warnings[0]), warnings[0]);
  assert.strictEqual(ef.formatDesignators("R1 R2\tR3", 1, []), "R1,R2,R3", "空格本就支持，不算转换");
  assert.strictEqual(ef.formatDesignators("C1，C2、C3", 1, []), "C1,C2,C3");
  assert.strictEqual(ef.formatDesignators(["R1", "R2"], 1, []), "R1,R2", "数组路径不受影响");
  // 数组里混进了未拆开的脏 token 也要在出口修好（导入侧可能没切）
  assert.strictEqual(ef.formatDesignators(["R1;R2", "R3"], 1, []), "R1,R2,R3");
});

t("超过 64 字符时警示（spec §4.2 上限），不静默截断", () => {
  const warnings = [];
  const many = Array.from({ length: 30 }, (_, i) => "C" + (i + 1));
  const text = ef.formatDesignators(many, 7, warnings);
  assert.ok(text.length > ef.MAX_DESIGNATOR_CHARS);
  assert.strictEqual(warnings.length, 1);
  assert.ok(/第 7 行/.test(warnings[0]) && /64/.test(warnings[0]), warnings[0]);
  assert.strictEqual(text.split(",").length, 30, "警示了但不能丢位号");
});

t("空位号得到空串，不产生 `undefined`", () => {
  assert.strictEqual(ef.formatDesignators([], 1, []), "");
  assert.strictEqual(ef.formatDesignators(null, 1, []), "");
  assert.strictEqual(ef.buildLcscRows([compareItem({ designators: [] })]).rows[1][5], "");
});

/* ==================================================== §5 与 exporter 串起来 */

section("§5 端到端：列结构 → xlsx → 读回（AC-8 内部一级）");

t("导出的 xlsx 读回后，表头与逐格内容都和列结构一致", () => {
  const out = path.join(require("os").tmpdir(), `cm_fmt_${process.pid}.xlsx`);
  const items = [compareItem(), compareItem({ row_no: 2, value: "1k", voltage: "", dielectric: "", tolerance: "±1%", part_number: "RC0603FR-071KL", supplier_part: "", shortfall_quantity: 4, designators: ["R1", "R2"] })];
  const built = ef.buildLcscRows(items);
  ex.writeXlsx(out, { sheet_name: "立创配单", rows: built.rows });
  try {
    const back = bp.readTableRows(out).rows;
    assert.deepStrictEqual(back, built.rows.map((row) => row.map((c) => String(c))));
    assert.strictEqual(back[2][4], "", "无立创编号的行该列应为空串");
    assert.strictEqual(back[2][0], "RC0603FR-071KL", "无 C 编码仍要有型号（AC-8 异常路径）");
  } finally {
    fs.unlinkSync(out);
  }
});

/* ================================================ §6 真实样本（外部验收用） */

section("§6 真实 BOM → 库为空场景的导出样本（供 T13d 上传立创）");

/** 库为空 ⇒ 全部条目缺料、缺口=需求量、匹配 none。这正是 AC-2 的异常路径。 */
function emptyLibraryCompare(items) {
  return items.map((it) => ({
    row_no: it.row_no,
    designators: it.designators,
    quantity_per_board: it.quantity_per_board,
    required_quantity: it.total_quantity,
    value: it.value,
    footprint: it.footprint,
    voltage: it.voltage,
    dielectric: it.dielectric,
    tolerance: it.tolerance,
    power: "",
    part_number: it.manufacturer_part,
    manufacturer: it.manufacturer,
    supplier_part: it.supplier_part,
    matched_part_id: "",
    stock_quantity: 0,
    shortfall_quantity: it.total_quantity,
    match_reason: "none",
    missing_fields: [],
  }));
}

const parsed = bp.parseBomFile(path.join(FIX, MAIN_BOM), 1);
const sampleItems = emptyLibraryCompare(parsed.items);
const sample = ef.buildLcscRows(sampleItems);

t("真实主样本 33 条 → 33 行数据 + 1 行表头", () => {
  assert.strictEqual(parsed.ok, true, parsed.error);
  assert.strictEqual(sample.rows.length, 34);
  assert.strictEqual(sample.rows[0].length, 7);
});

t("未选型（无立创编号）的条目仍能导出，封装/参数齐全（AC-8 异常路径）", () => {
  // 用"修正版"样本：spec 附录 A 注明它「含大量未选型条目（厂商/供应商为空）」
  const fixed = bp.parseBomFile(path.join(FIX, FIXED_BOM), 1);
  assert.strictEqual(fixed.ok, true, fixed.error);
  const items = emptyLibraryCompare(fixed.items);
  const noCode = items.filter((it) => !it.supplier_part);
  assert.ok(noCode.length > 0, "修正版里应有未选型条目，否则这条测试无意义");
  const rows = ef.buildLcscRows(items);
  const rowsWithoutCode = rows.rows.slice(1).filter((row) => row[4] === "");
  assert.strictEqual(rowsWithoutCode.length, noCode.length, "无 C 编码的条目一条都不能少");
  for (const row of rowsWithoutCode) {
    // 封装来自 BOM，必然有；参数在 BOM 本身没给值/耐压时**允许为空**，但必须有警示
    assert.ok(row[2] !== "", "缺 C 编码时封装仍须齐全: " + JSON.stringify(row));
    if (row[3] === "") {
      const rowNo = items[rows.rows.indexOf(row) - 1].row_no;
      assert.ok(rows.warnings.some((w) => w.includes(`第 ${rowNo} 行`) && /参数列为空/.test(w)),
        `第 ${rowNo} 行参数为空却没有警示`);
    }
  }
  // 每一行要么"可被立创匹配"（有型号或有 C 编码），要么**有明确警示**——不允许静默导出不可匹配的行
  const unmatchable = rows.rows.slice(1).filter((row) => row[0] === "" && row[4] === "");
  assert.ok(unmatchable.length > 0, "真实数据里确有两者皆空的未选型条目");
  for (const row of unmatchable) {
    const rowNo = items[rows.rows.indexOf(row) - 1].row_no;
    assert.ok(rows.warnings.some((w) => w.includes(`第 ${rowNo} 行`) && /无法自动匹配/.test(w)),
      `第 ${rowNo} 行两者皆空却没有警示`);
  }
});

t("首行与 spec §4.1 的样例对应（10uF / C1210 / 1210B106K500NT / C116808）", () => {
  assert.deepStrictEqual(sample.rows[1], [
    "1210B106K500NT", "FH(风华)", "C1210", "10uF", "C116808",
    "C1,C2,C4,C5,C6,C7,C10,C11", 8,
  ]);
});

const outIdx = process.argv.indexOf("--out");
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const target = path.resolve(process.argv[outIdx + 1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  ex.writeXlsx(target, { sheet_name: "立创配单", rows: sample.rows, date: new Date(2026, 9, 15, 10, 0, 0) });
  fs.writeFileSync(target + ".expected.json", JSON.stringify({
    sheet_name: "立创配单",
    rows: sample.rows.map((row) => row.map((c) => String(c))),
  }, null, 2), "utf8");
  console.log(`\n外部验收样本已生成：${target}`);
  console.log(`  数据行 ${sample.rows.length - 1} 行，列 ${sample.columns.join(" / ")}`);
  if (sample.warnings.length) console.log(`  警示 ${sample.warnings.length} 条：${sample.warnings.slice(0, 5).join("；")}`);
}

console.log("\n" + "=".repeat(64));
console.log(`T4（T13c-1）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
