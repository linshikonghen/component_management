"use strict";
/**
 * bom_parser.js — BOM 文件（.xlsx / .csv）→ 校验 → 内部条目（plan §6 BomItem 契约）
 *
 * 职责边界（plan §5 模块表）：**只解析，不写库**——本模块不 require store.js，
 * 也不写任何数据文件。这样比对链与导入链可以共用它而永不改库（spec FR-2.5）。
 *
 * xlsx 读取走 zip_container.js（零依赖，Node 内置 zlib）；列映射集中在 COLUMN_MAP
 * 一张表里，禁止在别处硬编码列号（AGENTS.md 标准做法 ④）。
 *
 * 字段名严格照 plan §6 契约（snake_case），**不自转 camelCase**。
 */

const fs = require("fs");
const path = require("path");
const { readZipEntries } = require("./zip_container");
const { collectText, decodeXmlEntities, columnIndex } = require("./xlsx_xml");
const xlsBiff = require("./xls_biff"); // .xls（真 BIFF8）零依赖读取器
const { headerCells } = require("./table_header"); // 「哪一行是表头」的唯一实现
const { parseComment, needsUnit } = require("./spec_parser");
const ids = require("./ids");

/** BOM 列名 → 内部字段名（spec §4.1 的固定十列） */
const COLUMN_MAP = {
  "No.": "row_no",
  Quantity: "quantity_per_board",
  Comment: "comment",
  Designator: "designator",
  Footprint: "footprint",
  Value: "value",
  "Manufacturer Part": "manufacturer_part",
  Manufacturer: "manufacturer",
  "Supplier Part": "supplier_part",
  Supplier: "supplier",
};

/**
 * 必需列：少了就没法建成一条可用器件记录。
 *   数量（→ 库存）、位号（→ 分类与校验）、值、封装（后两者是 spec §5.2 判定键成员）
 * 其余列缺失只降级（置空），不阻断导入。
 */
const REQUIRED_COLUMNS = ["Quantity", "Designator", "Value", "Footprint"];

const ZIP_LOCAL_SIG = 0x04034b50;

/* ------------------------------------------------------------------ 通用小工具 */

/** XML 属性取值（xlsx 里属性顺序不保证，故一律按名字找） */
function readAttr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1] : "";
}

/* --------------------------------------------------------------- xlsx 读取 */

function readSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m = re.exec(xml);
  while (m) {
    out.push(m[1] ? collectText(m[1]) : "");
    m = re.exec(xml);
  }
  return out;
}

function readCellValue(attrs, body, sharedStrings) {
  const type = readAttr(attrs, "t");
  if (type === "inlineStr") {
    const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
    return is ? collectText(is[1]) : "";
  }
  const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
  const raw = vm ? decodeXmlEntities(vm[1]) : "";
  if (type === "s") {
    const idx = Number(raw);
    return Number.isInteger(idx) && sharedStrings[idx] != null ? String(sharedStrings[idx]) : "";
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

/**
 * 解析 sheetN.xml → 二维字符串表（按 `r` 属性定位，缺 `r` 时按出现顺序推断）。
 * 稀疏单元格（如 A1,C1）会被正确放到列位上，不会被左移。
 */
function parseSheetRows(xml, sharedStrings) {
  const raw = [];
  const rowRe = /<row\b([^>]*?)\/>|<row\b([^>]*?)>([\s\S]*?)<\/row>/g;
  let rm = rowRe.exec(xml);
  while (rm) {
    const rowAttrs = rm[1] || rm[2] || "";
    const rowBody = rm[3] || "";
    const rowNo = Number(readAttr(rowAttrs, "r"));
    const cells = [];
    let col = 0;
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm = cellRe.exec(rowBody);
    while (cm) {
      const cellAttrs = cm[1] || cm[2] || "";
      const cellBody = cm[3] || "";
      // 契约：`<c>` 可能缺 `r` 属性（plan §1.3 实现注意 5），此时按上一格 +1 推断
      const idx = columnIndex(readAttr(cellAttrs, "r"));
      if (idx >= 0) col = idx;
      cells[col] = readCellValue(cellAttrs, cellBody, sharedStrings);
      col += 1;
      cm = cellRe.exec(rowBody);
    }
    raw[rowNo > 0 ? rowNo - 1 : raw.length] = cells;
    rm = rowRe.exec(xml);
  }
  // 补洞：把稀疏数组变成规整二维表（缺行补空行，缺格补空串）
  const rows = [];
  for (let i = 0; i < raw.length; i += 1) {
    const src = raw[i] || [];
    const row = [];
    for (let j = 0; j < src.length; j += 1) row[j] = src[j] == null ? "" : String(src[j]);
    rows[i] = row;
  }
  return rows;
}

function resolveFirstSheetPath(entries) {
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const sheetTag = /<sheet\b[^>]*>/.exec(workbook.toString("utf8"));
    const relId = sheetTag ? readAttr(sheetTag[0], "r:id") : "";
    if (relId) {
      const relText = rels.toString("utf8");
      const relRe = /<Relationship\b[^>]*>/g;
      let rel = relRe.exec(relText);
      while (rel) {
        if (readAttr(rel[0], "Id") === relId) {
          const target = readAttr(rel[0], "Target");
          if (target) {
            const p = target.startsWith("/")
              ? target.slice(1)
              : `xl/${target.replace(/^\.\//, "")}`;
            if (entries.has(p)) return p;
          }
          break;
        }
        rel = relRe.exec(relText);
      }
    }
  }
  for (const name of entries.keys()) {
    if (/^xl\/worksheets\/sheet\d*\.xml$/.test(name)) return name;
  }
  return null;
}

function readXlsxRows(buf) {
  const entries = readZipEntries(buf);
  const sheetPath = resolveFirstSheetPath(entries);
  if (!sheetPath) throw new Error("xlsx 中没有工作表（未找到 xl/worksheets/sheet*.xml）");
  const shared = readSharedStrings(entries.get("xl/sharedStrings.xml"));
  return { rows: parseSheetRows(entries.get(sheetPath).toString("utf8"), shared), sheetPath };
}

/* ---------------------------------------------------------------- csv 读取 */

/** RFC4180 风格：支持引号包裹、引号内逗号/换行、`""` 转义、CRLF、BOM 头 */
function parseCsvText(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (ch === "\r") {
      if (src[i + 1] !== "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function readCsvRows(buf) {
  return { rows: parseCsvText(buf.toString("utf8")), sheetPath: "csv" };
}

/**
 * 按扩展名分派；未知扩展名按内容嗅探（zip 魔数 `PK\x03\x04`）。
 *
 * `.xls`（真 BIFF8 老格式）现在**能读了**（`xls_biff.js`，零依赖）——
 * 用户反馈"文件选择器识别不到 xls"时一并补上：EDA 里直接存 `.xls` 的 BOM 也能导。
 * 但**立创对账单**同样长着 `.xls` 的脸，它**不是 BOM**（25 列、没有 Comment/Designator），
 * 所以这里给一条**专门**的提示，而不是让它去撞"表头缺列"那种泛泛错误——
 * 用户看到的第一句话就该说明"这是什么文件、现在该怎么办"。
 */
function readTableRows(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (exc) {
    throw new Error(`读取文件失败：${exc.message}`);
  }
  if (ext === ".xls" || (buf.length >= 8 && buf.readUInt32LE(0) === 0xE011CFD0 && buf.readUInt32LE(4) === 0xE11AB1A1)) {
    const rows = xlsBiff.readXlsRows(buf);
    if (looksLikeLcscStatement(headerCells(rows))) {
      throw new Error("这是立创商城的物料明细对账单（.xls），不是 BOM —— "
        + "它没有 BOM 需要的 Comment/Designator 列。「按对账单入库」功能正在做（T45）；"
        + "眼下要入库请用 BOM 导入，或先把对账单另存为 .xlsx 走同一流程（对账单仍按对账单处理）。");
    }
    return { rows, sheetPath: "xls" };
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZIP_LOCAL_SIG) return readXlsxRows(buf);
  if (ext === ".csv" || ext === ".txt") return readCsvRows(buf);
  return readCsvRows(buf);
}

/** 对账单指纹：表头里同时有「商品名称」「订购数量」（这两个词 BOM 里不会出现） */
function looksLikeLcscStatement(headerCells) {
  const joined = headerCells.join("|");
  return joined.includes("商品名称") && joined.includes("订购数量");
}

/**
 * 猜表头行：**前 12 行里格子最多的那一行**。
 * 为什么要猜而不是取"第一个非空行"：真实对账单的第 0 行有个零散单元格（`1:￥89.60`），
 * 第一个非空行根本不是表头（实测踩到：导致对账单没被认出来）。
 * BOM 侧另有 `locateHeaderRow` 做同一件事，这里只是给"是不是对账单"这个前置判断用。
 */

/* ------------------------------------------------------------- 列映射与校验 */

/** 列名比对：去空格、忽略大小写（真实 BOM 的列名大小写并不保证） */
function canonicalColumn(name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  if (!key) return "";
  return Object.keys(COLUMN_MAP).find((c) => c.toLowerCase() === key) || "";
}

function buildColumnIndex(headerRow) {
  const columns = {};
  (headerRow || []).forEach((cell, i) => {
    const canonical = canonicalColumn(cell);
    if (canonical && columns[canonical] == null) columns[canonical] = i;
  });
  return columns;
}

/** 在前若干行里找最像表头的一行（BOM 有时带标题行） */
function locateHeaderRow(rows) {
  let best = { index: -1, matched: 0 };
  const limit = Math.min(rows.length, 5);
  for (let i = 0; i < limit; i += 1) {
    const columns = buildColumnIndex(rows[i]);
    const matched = Object.keys(columns).length;
    if (matched > best.matched) best = { index: i, matched, columns };
    if (matched === Object.keys(COLUMN_MAP).length) break;
  }
  if (best.matched < 2) return { index: 0, matched: best.matched, columns: buildColumnIndex(rows[0]) };
  return best;
}

/* ------------------------------------------------------------------ 条目化 */

/**
 * 位号切分：英文逗号为主，同时容忍中文逗号/分号/顿号/空格（导出时统一回英文逗号）。
 * 支持嘉立创官方认可的**区间写法** `R1-4` / `R1-R4`（spec §4.2），展开成显式位号——
 * 否则 `Quantity=4` 配 `Designator="R1-4"` 会被误报成"数量与位号个数不符"（FR-1.5 假警报）。
 */
function splitDesignators(text) {
  const tokens = String(text == null ? "" : text)
    .split(/[,;，；、\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const out = [];
  for (const token of tokens) {
    const expanded = expandDesignatorRange(token);
    if (expanded) out.push(...expanded);
    else out.push(token);
  }
  return out;
}

/** 位号区间展开；不是区间（或离谱大到像笔误）返回 null */
function expandDesignatorRange(token) {
  const MAX_RANGE = 1000; // 防"R1-999999"这类笔误把内存吃光
  let m = /^([A-Za-z]+)(\d+)-(\d+)$/.exec(token);
  let prefix;
  let from;
  let to;
  let width;
  if (m) {
    [, prefix, from, to] = m;
    width = from.length;
    from = Number(from);
    to = Number(to);
  } else {
    m = /^([A-Za-z]+)(\d+)-([A-Za-z]+)(\d+)$/.exec(token);
    if (!m || m[1].toUpperCase() !== m[3].toUpperCase()) return null;
    prefix = m[1];
    width = m[2].length;
    from = Number(m[2]);
    to = Number(m[4]);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null; // 官方：起<止
  if (to - from + 1 > MAX_RANGE) return null;
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(prefix + String(i).padStart(width, "0"));
  return out;
}

function cell(row, columns, columnName) {
  const i = columns[columnName];
  if (i == null) return "";
  const v = row[i];
  return v == null ? "" : String(v).trim();
}

function parseBomRow(row, columns, fileRowNo, sets, warnings) {
  const noRaw = cell(row, columns, "No.");
  const rowNo = /^\d+$/.test(noRaw) ? Number(noRaw) : fileRowNo;

  const quantityRaw = cell(row, columns, "Quantity");
  let quantityPerBoard = Number(quantityRaw);
  if (quantityRaw === "" || !Number.isFinite(quantityPerBoard)) {
    warnings.push(`第 ${rowNo} 行：Quantity「${quantityRaw}」不是数字，按 0 处理`);
    quantityPerBoard = 0;
  }
  quantityPerBoard = Math.trunc(quantityPerBoard);

  const designators = splitDesignators(cell(row, columns, "Designator"));
  const comment = cell(row, columns, "Comment");
  const parsed = parseComment(comment);
  // 值优先取 BOM 的 Value 列（BOM 事实），该列为空时才用 Comment 解析出的建议值
  const value = cell(row, columns, "Value") || parsed.value;
  // spec §5.2：`100` 这类纯数字不自动推断单位（可能是 10Ω 也可能是 100Ω），
  // 必须记入"待确认"并提示补全——否则它会带着错误单位参与去重判定并造成错误合并。
  if (needsUnit(value)) {
    warnings.push(`第 ${rowNo} 行：值「${value}」缺单位（spec §5.2 不自动推断），请补全后再入库`);
  }

  // AC-1 / FR-1.5：数量与位号个数不符要醒目警示，且**必须人工裁决**后才可入库。
  // 这里只做"标出来"；"拦住入库"由核对界面（T6）执行。
  const countMismatch = quantityPerBoard !== designators.length;
  if (countMismatch) {
    warnings.push(
      `第 ${rowNo} 行：Quantity=${quantityPerBoard} 与位号个数 ${designators.length} 不符，需人工裁决`
    );
  }

  const totalQuantity = quantityPerBoard * sets;
  return {
    row_no: rowNo,
    designators,
    designator_count: designators.length,
    quantity_per_board: quantityPerBoard, // 只读（BOM 事实，v1.4）
    total_quantity: totalQuantity, // 只读（= 单套 × 套数）
    intake_quantity: totalQuantity, // 可改；默认 = 应入库量
    edited_by_human: false,
    comment,
    value,
    footprint: cell(row, columns, "Footprint"),
    voltage: parsed.voltage,
    dielectric: parsed.dielectric,
    // plan §6 补记：BomItem 原漏了容差，但 spec FR-1.6 明列「容差」可改、
    // 且容差是 spec §5.2 五元组判定键成员，CompareItem 亦已有该字段 → 契约漏项。
    tolerance: parsed.tolerance,
    manufacturer_part: cell(row, columns, "Manufacturer Part") || parsed.part_number_suggestion,
    manufacturer: cell(row, columns, "Manufacturer"),
    supplier_part: cell(row, columns, "Supplier Part"),
    supplier: cell(row, columns, "Supplier"),
    // v1.5 实现期补记：spec FR-1.6 允许核对时改「库位」与「低库存阈值」，
    // 但 BOM 里没有这两列 → 解析时给空值占位，由人工在核对表里填（填了才生效，见 inventory.newPartFromItem）
    location: "",
    min_quantity: "",
    // 解析是否可信：Comment 解析是否确定 **且** 本行数量自洽（两者都需人工确认）
    parse_confident: parsed.confident && !countMismatch,
    action: "keep",
    note: parsed.note,
  };
}

function isBlankRow(row) {
  return !row || row.every((v) => v == null || String(v).trim() === "");
}

/** `batch_YYYYMMDD_HHMMSS`（plan §3.2 的 ref 形态）——时间戳实现统一在 `./ids` */
function makeBatchId(when) {
  return ids.makeRunId("batch", when);
}

/**
 * 解析 BOM 文件 → plan §6 `bom:parse` 的响应体。
 * **不写库、不改文件**；`intake_quantity` 只是默认值，最终入库量由人在核对界面定。
 * @param {string} filePath
 * @param {number} [sets] 套数（≥1 整数，默认 1）
 * @param {{now?: Date}} [options]
 * @returns {{ok: boolean, error: string, batch_id: string, items: object[], warnings: string[]}}
 */
function parseBomFile(filePath, sets, options = {}) {
  const result = { ok: false, error: "", batch_id: "", items: [], warnings: [] };
  const setCount = sets == null ? 1 : Number(sets);
  if (!Number.isInteger(setCount) || setCount < 1) {
    result.error = `套数必须是 ≥1 的整数（收到「${sets}」）`;
    return result;
  }
  let table;
  try {
    table = readTableRows(filePath);
  } catch (exc) {
    result.error = String(exc.message || exc);
    return result;
  }
  const rows = table.rows || [];
  if (rows.length === 0) {
    result.error = "文件为空：未找到有效条目";
    return result;
  }
  const header = locateHeaderRow(rows);
  const missing = REQUIRED_COLUMNS.filter((c) => header.columns[c] == null);
  if (missing.length > 0) {
    result.error = header.matched === 0
      ? `不是可识别的 BOM：表头未包含任何已知列（${Object.keys(COLUMN_MAP).join(" / ")}）`
      : `BOM 缺少必需列：${missing.join("、")}（必需：${REQUIRED_COLUMNS.join("、")}）`;
    return result;
  }
  const dataRows = rows.slice(header.index + 1);
  if (dataRows.every(isBlankRow)) {
    result.error = "未找到有效条目（文件只有表头，或数据行全为空）";
    return result;
  }
  const items = [];
  for (let i = 0; i < dataRows.length; i += 1) {
    if (isBlankRow(dataRows[i])) continue;
    items.push(parseBomRow(dataRows[i], header.columns, header.index + 2 + i, setCount, result.warnings));
  }
  if (items.length === 0) {
    result.error = "未找到有效条目";
    return result;
  }
  result.ok = true;
  result.batch_id = makeBatchId(options.now);
  result.items = items;
  return result;
}

module.exports = {
  COLUMN_MAP,
  REQUIRED_COLUMNS,
  parseBomFile,
  readTableRows,
  readXlsxRows,
  readCsvRows,
  parseCsvText,
  parseSheetRows,
  readSharedStrings,
  canonicalColumn,
  locateHeaderRow,
  splitDesignators,
  expandDesignatorRange,
  makeBatchId,
};
