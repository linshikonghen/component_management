"use strict";
/**
 * test_xlsx_robustness.js — T35：**xlsx 读取器的对抗性鲁棒性**
 *
 * 运行： node tests/test_xlsx_robustness.js
 *
 * 为什么需要：T13b（自写 xlsx 读写器）是本项目的最高风险项，读取侧此前只拿**真实样本**验过——
 * 而那几个样本都是**同一家工具**产出的，格式变体从没试过。别的工具（Excel / 在线 BOM 导出器 /
 * Python 的库）会产出这些差异，任何一个读不了，用户就会看到"解析失败"或更糟：**静默读错**。
 *
 * 所以这里**手工合成** xlsx（复用 `zip_container.crc32`，不引任何第三方包），逐个制造变体：
 *   ① 全条目不压缩（method 0）        ② **数据描述符**（bit 3，本地头 size=0，尺寸只在中央目录）
 *   ③ 共享字符串 + **富文本多段**     ④ 单元格**缺 `r` 属性**（按出现顺序推断列位）
 *   ⑤ **稀疏列**（只有 A/E/J 有值）   ⑥ 实体（`&amp;` 与数字实体）
 *   ⑦ **行号跳号**（表头第 1 行、数据 `r="5"`）  ⑧ `inlineStr`（我自己的写入器风格）对照
 *
 * 每条都断言**解析出来的具体字段值**——不是"没报错就算过"。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { crc32 } = require("../src/services/zip_container");
const bp = require("../src/services/bom_parser");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_xlsxr_"));

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
function section(title) { console.log("\n=== " + title + " ==="); }

/* ------------------------------------------------- 测试专用：变体 zip 写入器 */

// 变体 zip 的构造器抽到 tests/fake_zip.js（另一处测试也要造重名条目），
// 这里只 require，不再各写一份（AGENTS.md 反重复）。
const { buildZip } = require("./fake_zip");

/* ------------------------------------------- 测试专用：拼一份最小可读 xlsx */

const COLUMNS = ["No.", "Quantity", "Comment", "Designator", "Footprint", "Value",
  "Manufacturer Part", "Manufacturer", "Supplier Part", "Supplier"];

/** 列号 → 字母（A..J 够用，但写成通用的，免得以后列数变了） */
function colLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 造一份 BOM 工作表 XML。
 * @param {object} shape
 *   shared:      string[]  共享字符串表（用 t="s" 引用）
 *   headerRow:   number    表头所在行号（默认 1）
 *   dataRow:     number    数据行号（默认 2，可与表头跳号）
 *   cells:       Array<{col:number, v:string, type?:string, runs?:string[]}>  第一行数据
 *   omitR:       boolean   所有单元格不写 `r` 属性（按出现顺序推断）
 *   sparse:      boolean   只写非空格（其余列整格省略）
 */
function buildSheetXml(shape) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');

  const rows = [];
  rows.push({ r: shape.headerRow == null ? 1 : shape.headerRow, cells: COLUMNS.map((name, i) => ({ col: i, text: name })) });
  const dataRowNo = shape.dataRow == null ? 2 : shape.dataRow;
  rows.push({ r: dataRowNo, cells: shape.cells });

  for (const row of rows) {
    parts.push(`<row r="${row.r}">`);
    for (const cell of row.cells) {
      const ref = shape.omitR ? "" : ` r="${colLetter(cell.col)}${row.r}"`;
      if (cell.raw != null) {
        // 直接给整段 <c>…</c>（用于手工制造特殊形态）
        parts.push(cell.raw.replace("__REF__", ref));
        continue;
      }
      if (cell.text != null) {
        parts.push(`<c${ref} t="inlineStr"><is><t>${esc(cell.text)}</t></is></c>`);
      }
    }
    parts.push("</row>");
  }
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

function sharedStringsXml(list) {
  const items = list.map((item) => (Array.isArray(item)
    ? `<si>${item.map((piece) => `<r><t>${esc(piece)}</t></r>`).join("")}</si>`
    : `<si><t>${esc(item)}</t></si>`)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">${items}</sst>`;
}

/**
 * 写一个 .xlsx 到临时目录并解析。
 * @returns {object} parseBomFile 的结果
 */
function parseSynthetic(name, { sheetXml, shared, zipOpts }) {
  const entries = [
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  ];
  if (shared) entries.push({ name: "xl/sharedStrings.xml", data: shared });
  const file = path.join(TMP, `${name}.xlsx`);
  fs.writeFileSync(file, buildZip(entries, zipOpts || {}));
  return bp.parseBomFile(file, 1);
}

/** 一份"标准"的数据行（inlineStr），供各用例复用 */
function standardCells(over = {}) {
  return [
    { col: 0, text: "1" },
    { col: 1, text: "8" },
    { col: 2, text: "10uF/50V X7R ±10%" },
    { col: 3, text: "C1,C2,C3,C4,C5,C6,C7,C8" },
    { col: 4, text: "C1210" },
    { col: 5, text: "10uF" },
    { col: 6, text: "CL32B106KBJNNNE" },
    { col: 7, text: "Samsung" },
    { col: 8, text: "C19702" },
    { col: 9, text: "LCSC" },
  ].map((cell) => Object.assign(cell, over));
}

/** 断言"这条被正确解析出来了" */
function assertFirstItem(result, expected, note) {
  assert.strictEqual(result.ok, true, `${note}：解析应成功，实际错误：${result.error}`);
  assert.strictEqual(result.items.length, 1, `${note}：应解析出 1 条，实际 ${result.items.length}`);
  const item = result.items[0];
  for (const [key, want] of Object.entries(expected)) {
    // 用 deepStrictEqual：字段里有数组（designators），strictEqual 比引用会假红
    assert.deepStrictEqual(item[key], want, `${note}：${key} 应为「${JSON.stringify(want)}」，实际「${JSON.stringify(item[key])}」`);
  }
  return item;
}

/* ============================================================ 变体逐条过 */

section("§1 zip 层变体：别的工具会这么写");

t("① 全条目不压缩（method 0）：照样读得出来", () => {
  const result = parseSynthetic("stored", { sheetXml: buildSheetXml({ cells: standardCells() }), zipOpts: { store: true } });
  // 字段名照 plan §6 BomItem：位号是 **designators（数组）**，不是 designator（我第一版写错了）
  assertFirstItem(result, {
    value: "10uF", footprint: "C1210", quantity_per_board: 8,
    designators: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"],
    designator_count: 8,
  }, "不压缩");
});

t("② **数据描述符**（bit 3，本地头 size=0）：必须信中央目录，照样读得出来", () => {
  const result = parseSynthetic("datadesc", { sheetXml: buildSheetXml({ cells: standardCells() }), zipOpts: { dataDescriptor: true } });
  assertFirstItem(result, { value: "10uF", footprint: "C1210", quantity_per_board: 8 }, "数据描述符");
});

t("②b 数据描述符 + 不压缩（两个变体叠加）", () => {
  const result = parseSynthetic("dd_store", { sheetXml: buildSheetXml({ cells: standardCells() }), zipOpts: { dataDescriptor: true, store: true } });
  assertFirstItem(result, { value: "10uF", footprint: "C1210" }, "描述符+不压缩");
});

/* ============================================================ XML 层变体 */

section("§2 XML 层变体：共享字符串 / 富文本 / 缺 r / 稀疏 / 实体 / 跳号");

t("③ 共享字符串 + **富文本多段**：10 + uF 必须拼成 `10uF`（不能只剩一段或读空）", () => {
  // 共享表：索引 1..9 是各列文本，索引 10 是**被拆成两段**的富文本
  const shared = sharedStringsXml([
    "占位（索引 0）",
    "1", "8", "10uF/50V X7R ±10%", "C1,C2,C3,C4,C5,C6,C7,C8", "C1210",
    "CL32B106KBJNNNE", "Samsung", "C19702", "LCSC",
    ["10", "uF"],
  ]);
  const header = COLUMNS
    .map((name, i) => `<c r="${colLetter(i)}1" t="inlineStr"><is><t>${esc(name)}</t></is></c>`)
    .join("");
  const siOrder = [1, 2, 3, 4, 5, 10, 6, 7, 8, 9]; // Value（第 6 列）指向富文本条目
  const data = siOrder.map((si, i) => `<c r="${colLetter(i)}2" t="s"><v>${si}</v></c>`).join("");
  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + `<row r="1">${header}</row><row r="2">${data}</row>`
    + "</sheetData></worksheet>";
  const result = parseSynthetic("richtext", { sheetXml, shared });
  assertFirstItem(result, { value: "10uF", quantity_per_board: 8, footprint: "C1210", manufacturer: "Samsung" },
    "富文本共享字符串");
});

t("④ 单元格**缺 `r` 属性**：按出现顺序推断列位，不得串列", () => {
  const result = parseSynthetic("noref", { sheetXml: buildSheetXml({ cells: standardCells(), omitR: true }) });
  assertFirstItem(result, { value: "10uF", footprint: "C1210", manufacturer: "Samsung", supplier_part: "C19702" }, "缺 r 属性");
});

t("⑤ **稀疏列**：只有 A/E/J 有 `r`，数据不得左移", () => {
  const cells = [
    { col: 0, text: "1" },
    { col: 1, text: "8" },
    { col: 3, text: "C1,C2,C3,C4,C5,C6,C7,C8" },
    { col: 4, text: "C1210" },
    { col: 5, text: "10uF" },
    { col: 9, text: "LCSC" },
  ];
  const result = parseSynthetic("sparse", { sheetXml: buildSheetXml({ cells }) });
  assertFirstItem(result, { value: "10uF", footprint: "C1210", supplier: "LCSC", supplier_part: "" }, "稀疏列");
});

t("⑥ 实体（`&amp;` 与数字实体）必须解码", () => {
  const cells = standardCells();
  // 注意：这里给的是**原文**（&、中文），由 esc() 负责编码——第一版我直接写了 `&amp;`，
  // 结果被 esc() 二次转义，读回来当然还是 `&amp;`（测试自己的错，不是解析器的错）
  cells[2] = { col: 2, text: "10uF/50V X7R ±10% A&B 中文" };
  cells[7] = { col: 7, text: "村田&TDK" };
  const result = parseSynthetic("entities", { sheetXml: buildSheetXml({ cells }) });
  assertFirstItem(result, { comment: "10uF/50V X7R ±10% A&B 中文", manufacturer: "村田&TDK" }, "实体解码");
});

t("⑦ **行号跳号**（表头第 1 行、数据 `r=\"5\"`）：补空行不得错位", () => {
  const result = parseSynthetic("gapped", { sheetXml: buildSheetXml({ cells: standardCells(), dataRow: 5 }) });
  // `row_no` 是 **No. 列的值**（不是 Excel 行号）——第一版我按行号断言 5，写错了
  assertFirstItem(result, { value: "10uF", footprint: "C1210", row_no: 1, quantity_per_board: 8 }, "行号跳号");
});

t("⑧ `inlineStr`（本项目写入器的风格）对照", () => {
  const result = parseSynthetic("inline", { sheetXml: buildSheetXml({ cells: standardCells() }) });
  assertFirstItem(result, { value: "10uF", footprint: "C1210", row_no: 1, no: undefined }, "inlineStr 对照");
});

/* ============================================================ 反证 */

section("§3 反证：坏文件必须**明确报错**，不能静默读成空表");

t("压缩数据被截断 → 报错且指明是哪个条目", () => {
  const good = buildZip([{ name: "xl/worksheets/sheet1.xml", data: buildSheetXml({ cells: standardCells() }) }]);
  // 砍掉尾部：中央目录没了 → 应报"未找到 EOCD"，而不是返回空表
  const broken = good.subarray(0, Math.floor(good.length / 2));
  const file = path.join(TMP, "truncated.xlsx");
  fs.writeFileSync(file, broken);
  const result = bp.parseBomFile(file, 1);
  assert.strictEqual(result.ok, false, "截断文件必须被拒绝");
  assert.ok(/EOCD|zip|xlsx/i.test(result.error), "错误信息应说清原因，实际：" + result.error);
});

t("中央目录说有、数据却越界 → 报错（不能返回半张表）", () => {
  const entries = [{ name: "xl/worksheets/sheet1.xml", data: buildSheetXml({ cells: standardCells() }) }];
  const buf = buildZip(entries);
  // 把中央目录里的 compSize 改成一个远超文件长度的值
  const cdSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const at = buf.indexOf(cdSig);
  buf.writeUInt32LE(0x7fffffff, at + 20);
  const file = path.join(TMP, "oversize.xlsx");
  fs.writeFileSync(file, buf);
  const result = bp.parseBomFile(file, 1);
  assert.strictEqual(result.ok, false, "越界必须被拒绝");
});

/* ---------------------------------------------------------------- */

console.log("\n" + "=".repeat(64));
console.log(`T35（xlsx 读取器鲁棒性）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }
