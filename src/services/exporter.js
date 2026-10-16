"use strict";
/**
 * exporter.js — 自写最小 xlsx **写入器**（plan §1.0 / §10.1，本工程最高风险点）
 *
 * 为什么自写：本机离线、零 npm 依赖，`xlsx`/`SheetJS` 装不上（plan §1.3 已实测）。
 * 为什么风险高（plan §10.1 原话）：zip 格式细节多（CRC32、local header、central directory），
 * XML 转义稍错就让 Excel/立创打不开，而**失败是静默的**（文件生成成功但内容坏）。
 * 因此本模块的验收不是"我看着觉得对"，而是：
 *   ① 用本项目自己的读取器读回、逐格比对（`tests/test_exporter_roundtrip.js`）
 *   ② 用**独立实现**复核：Python `zipfile`（CRC/条目）+ `xml.etree`（严格 XML）+ `openpyxl`（真实取值）
 *      （`tests/verify_export_independently.py`）
 *   ③ 最后仍需**用户实际把文件传一次立创商城**（spec AC-8 外部验收，唯一能证明"立创可识别"的方式）
 *
 * 职责边界（plan §5）：**只负责把给定的行写成合法 xlsx，不决定导出的内容**——
 * "哪些列、哪几行、lcsc 还是 jlc 列序"是 T13c 的事（spec §4.2）。本模块不认识"BOM"。
 *
 * 写法取舍（照 plan §1.0 的"最小可行写法"）：
 *   - 单元格文本一律 `inlineStr`，**完全绕开 sharedStrings 表**（少一张表 = 少一类错）
 *   - 数字写真数字（`<v>`），因为立创/Excel 侧要按"数量"当数值处理
 *   - 空串写成空单元格 `<c r="B2"/>`，**保留列位**（否则读回时列会左移）
 *   - 附一份最小 `xl/styles.xml`：xlsx 规范里样式是可选件，但补上可让严格解析器少一类意外
 *   - **不做**合并单元格、公式、图表、多 sheet、列宽——用不到，且每多一样就多一类静默失败
 */

const fs = require("fs");
const path = require("path");
const { writeZip } = require("./zip_container");
const { encodeXmlEntities, cellRef, columnName, MAX_CELL_CHARS } = require("./xlsx_xml");

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** xlsx（ECMA-376）硬上限：超了不该硬写，要报错 */
const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const MAX_SHEET_NAME = 31;

/** Excel 工作表名不允许出现的字符 */
const INVALID_SHEET_CHARS = /[\\/?*[\]:]/g;

function sanitizeSheetName(name) {
  const raw = String(name == null ? "" : name).trim();
  const cleaned = raw.replace(INVALID_SHEET_CHARS, "_").slice(0, MAX_SHEET_NAME);
  return cleaned === "" ? "Sheet1" : cleaned;
}

/** 单元格 XML。空值也**占位**，否则读回时列位会左移。 */
function cellXml(value, colIndex, rowNumber) {
  const ref = cellRef(colIndex, rowNumber);
  if (value == null || value === "") return `<c r="${ref}"/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`导出失败：第 ${rowNumber} 行第 ${colIndex + 1} 列不是有限数字（${value}）`);
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value !== "string") {
    // 宁可报错也不写 "[object Object]"：导出文件是要拿去下单的，
    // 静默写进垃圾比直接失败危险得多（plan §10.1 的教训就是"失败是静默的"）。
    throw new Error(
      `导出失败：第 ${rowNumber} 行第 ${colIndex + 1} 列的值类型不支持（${typeof value}），只接受 字符串/数字/布尔/空`
    );
  }
  // `xml:space="preserve"` 必须加：否则 Excel 会吃掉值前后的空格（位号/备注里常见）
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${encodeXmlEntities(value)}</t></is></c>`;
}

function buildSheetXml(rows) {
  const parts = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const cells = [];
    for (let c = 0; c < row.length; c += 1) cells.push(cellXml(row[c], c, r + 1));
    parts.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  }
  const maxCols = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
  const dimension = rows.length === 0 || maxCols === 0
    ? "A1"
    : `A1:${cellRef(maxCols - 1, rows.length)}`;
  return `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><dimension ref="${dimension}"/>`
    + `<sheetData>${parts.join("")}</sheetData></worksheet>`;
}

function buildContentTypesXml() {
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + "</Types>";
}

function buildRootRelsXml() {
  return `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
    + "</Relationships>";
}

function buildWorkbookXml(sheetName) {
  return `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<sheets><sheet name="${encodeXmlEntities(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + "</workbook>";
}

function buildWorkbookRelsXml() {
  return `${XML_DECL}<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
    + `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>`
    + "</Relationships>";
}

function buildStylesXml() {
  return `${XML_DECL}<styleSheet xmlns="${NS_MAIN}">`
    + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border/></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    // 少了 cellStyles，openpyxl 会告警 "Workbook contains no default style"（Excel 容忍，但严格解析器未必）
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + "</styleSheet>";
}

/**
 * 组装完整的 xlsx 字节。
 * @param {{sheet_name?: string, rows: Array<Array<string|number|boolean|null>>, date?: Date}} options
 * @returns {Buffer}
 */
function buildXlsxBuffer(options = {}) {
  const rows = options.rows;
  if (!Array.isArray(rows)) throw new Error("buildXlsxBuffer: rows 必须是二维数组");
  if (rows.length > MAX_ROWS) throw new Error(`行数 ${rows.length} 超过 xlsx 上限 ${MAX_ROWS}`);
  for (const row of rows) {
    if (row != null && !Array.isArray(row)) throw new Error("buildXlsxBuffer: 每一行都必须是数组");
    if (row && row.length > MAX_COLS) throw new Error(`列数 ${row.length} 超过 xlsx 上限 ${MAX_COLS}`);
  }
  // **单元格文本长度也要有闸**（审计 R3 发现①）：行/列数早就有守卫，文本长度却没有——
  // 超过 Excel 上限（32767）的单元格会让文件在 Excel/立创里被判定"损坏"。
  // 这里默认**报错**（低层工具不该悄悄产出用户打不开的文件）；
  // 导出层（export_format）已经在上面**截断并警示**，所以产品路径永远不会走到这个错。
  // 需要写超长内容做测试/特殊用途时，显式传 `max_cell_chars: Infinity` 放行。
  const maxCellChars = options.max_cell_chars == null ? MAX_CELL_CHARS : Number(options.max_cell_chars);
  if (Number.isFinite(maxCellChars)) {
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c += 1) {
        const v = row[c];
        if (typeof v === "string" && v.length > maxCellChars) {
          throw new Error(
            `第 ${r + 1} 行第 ${c + 1} 列的文本有 ${v.length} 个字符，超过 Excel 单元格上限 ${maxCellChars}：`
            + "这样的文件 Excel/立创会判定为损坏。请先在导出层截断（export_format.clampCell），"
            + "或显式传 max_cell_chars 放行。"
          );
        }
      }
    }
  }
  const sheetName = sanitizeSheetName(options.sheet_name);
  const entries = [
    { name: "[Content_Types].xml", data: buildContentTypesXml() },
    { name: "_rels/.rels", data: buildRootRelsXml() },
    { name: "xl/workbook.xml", data: buildWorkbookXml(sheetName) },
    { name: "xl/_rels/workbook.xml.rels", data: buildWorkbookRelsXml() },
    { name: "xl/styles.xml", data: buildStylesXml() },
    { name: "xl/worksheets/sheet1.xml", data: buildSheetXml(rows) },
  ];
  return writeZip(entries, { date: options.date });
}

/**
 * 写出 xlsx 文件。
 * 落盘用「同目录临时文件 + rename」的原子写（与 AGENTS.md 标准做法 ① 同源）：
 * 写一半失败时，用户原有的那份导出文件不会被毁掉（spec NFR-4）。
 * @returns {{file_path: string, bytes: number, sheet_name: string, rows: number, cols: number}}
 */
function writeXlsx(filePath, options = {}) {
  if (!filePath || typeof filePath !== "string") throw new Error("writeXlsx: 缺少输出路径");
  const buffer = buildXlsxBuffer(options);
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, filePath);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (ignored) { /* 清理失败不掩盖原错误 */ }
    throw new Error(`写入 xlsx 失败（目标文件可能正被 Excel 打开）：${exc.message}`);
  }
  const cols = (options.rows || []).reduce((max, row) => Math.max(max, (row || []).length), 0);
  return {
    file_path: filePath,
    bytes: buffer.length,
    sheet_name: sanitizeSheetName(options.sheet_name),
    rows: (options.rows || []).length,
    cols,
  };
}

module.exports = {
  writeXlsx,
  buildXlsxBuffer,
  buildSheetXml,
  sanitizeSheetName,
  columnName,
  MAX_ROWS,
  MAX_COLS,
  /** Excel 单元格文本上限（写入器默认守卫用它；定义在 xlsx_xml，读写两侧共用一处） */
  MAX_CELL_CHARS,
};
