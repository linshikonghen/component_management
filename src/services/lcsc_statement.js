"use strict";
/**
 * lcsc_statement.js — 立创商城「物料明细对账单」解析（**只用于按订单入库**）
 *
 * 用户 2026-10-16 的决定（逐条落在这里，改口径就改这里）：
 *   ① **只用于入库**：导出、比对**一律不动**（本模块不导出、不比对，也不碰库）
 *   ② **只用 H–L 列**（0 基下标 **7..11**）：商品类型 / 商品名称 / 商品型号 / 封装格式 / 订购数量
 *      —— G（品牌）不参与；更早的订单级列（A/B…）更不用
 *   ③ **匹配键 = 商品类型 + 商品名称(值/容差/耐压) + 商品型号 + 封装**，**不用品牌、不用商品编号**
 *      （理由：同型号可能从别处买、厂商不同；C 编码是立创特有的，不该当身份）
 *   ④ **没有位号**：对账单里没有位号，这条路径就不碰它（器件字段本身保留，BOM 路径照旧用）
 *   ⑤ **分类以「商品类型」为准**（比位号前缀更准），并由此推出**阈值键**（见 thresholdKey）
 *
 * 为什么"只认对账单"（用户决定③）：列语义必须靠**表头**确定，猜错哪列是数量就是错账。
 * 认不出表头 → 明确报错，绝不猜。
 */

const path = require("path");
const xlsBiff = require("./xls_biff");
const { locateHeaderRow } = require("./table_header"); // 「哪一行是表头」的唯一实现

/** 对账单里我们**需要**的列（H–L）。值是 0 基下标；表头文字用于识别。 */
const NEEDED_COLUMNS = [
  { header: "商品类型", index: 7, field: "category" },
  { header: "商品名称", index: 8, field: "name" },
  { header: "商品型号", index: 9, field: "manufacturer_part" },
  { header: "封装格式", index: 10, field: "footprint" },
  { header: "订购数量", index: 11, field: "quantity" },
];

/** 供识别用的关键表头（缺任何一个就不是我们要的对账单） */
const REQUIRED_HEADERS = ["商品类型", "商品名称", "商品型号", "封装格式", "订购数量"];

/** 包装词：进不了器件参数（`100nF ±10% 100V 编带` 里的「编带」） */
const PACKAGING_WORDS = ["编带", "袋装", "散装", "管装", "盘装", "卷装", "托盘"];

/**
 * 商品类型 → **低库存阈值键**（spec §5.3 的 14 类是按位号前缀建的）。
 * 为什么需要：对账单**没有位号**，阈值不能靠前缀推；而分类改成"商品类型"后，
 * 阈值表又只认前缀键——所以做一张**集中**的映射表（AGENTS.md 标准做法④），
 * 映射不到就 `_default`（**不猜**）。核对表里会把「分类 / 阈值键」都显示出来，
 * 映射错了一眼能看见，不会悄悄按错阈值判定。
 */
const CATEGORY_TO_THRESHOLD_KEY = [
  { match: /贴片电容|MLCC|固态电容|铝电解|钽电容|电容/, key: "C" },
  { match: /贴片电阻|电阻/, key: "R" },
  { match: /电感|磁珠/, key: "L" },
  { match: /二极管|TVS|整流|稳压|齐纳/, key: "D" },
  { match: /三极管|MOS|晶体管|场效应/, key: "Q" },
  { match: /芯片|集成电路|IC|单片机|运放|逻辑/, key: "U" },
  { match: /连接器|插座|排针|端子|连接/, key: "CN" },
  { match: /晶振|谐振|振荡/, key: "X" },
  { match: /按键|轻触开关|开关/, key: "KEY" },
  { match: /保险丝|熔断|自恢复/, key: "F" },
  { match: /蜂鸣器/, key: "BUZZER" },
  { match: /发光二极管|LED/, key: "LED" },
  { match: /排母|排针座|插座/, key: "H" },
];

/** 由商品类型推阈值键；推不出返回 `_default`（不猜） */
function thresholdKey(category) {
  const text = String(category == null ? "" : category);
  for (const rule of CATEGORY_TO_THRESHOLD_KEY) {
    if (rule.match.test(text)) return rule.key;
  }
  return "_default";
}

/**
 * 解析「商品名称」为 值 / 容差 / 耐压（+ 去掉包装词）。
 * 立创的写法就是 spec §4.2「参数拼写规范」那一套：`100nF ±10% 100V 编带`（值 容差 耐压）。
 * **不猜材质**：商品名称里没有材质（材质藏在型号里，spec 明令禁止从型号自动识别）。
 */
function parseProductName(name) {
  const raw = String(name == null ? "" : name).trim();
  const out = { value: "", tolerance: "", voltage: "", pack: "" };
  if (raw === "") return out;
  const tokens = raw.split(/\s+/).filter((t) => t !== "");
  const leftovers = [];
  for (const token of tokens) {
    if (PACKAGING_WORDS.some((w) => token.includes(w))) { out.pack = token; continue; }
    if (/^[±+\-]\s*\d/.test(token) && !out.tolerance) { out.tolerance = token; continue; }
    if (/^\d+(\.\d+)?\s*[Vv]$/.test(token) && !out.voltage) { out.voltage = token; continue; }
    leftovers.push(token);
  }
  out.value = leftovers.shift() || "";
  // 剩下的（如 `X7R` 材质、`1/4W` 功率）**原样留在 extra**，由人决定要不要填 —— 不自动落库
  out.extra = leftovers.join(" ");
  return out;
}

/** 认不出表头就明确报错（绝不猜哪列是数量） */
function assertIsStatement(headerRow) {
  const cells = (headerRow || []).map((v) => String(v == null ? "" : v));
  const missing = REQUIRED_HEADERS.filter((h) => !cells.includes(h));
  if (missing.length > 0) {
    throw new Error("不是立创商城的物料明细对账单：缺少表头 " + missing.join(" / ")
      + "（本功能只认对账单，列语义靠表头确定——猜错哪列是数量就是错账）");
  }
}

/** 明细行判定：订购数量是正数、且商品型号非空（"商品合计金额 / 说明 / 价外费用"等标签行会被自然跳过） */
function isDetailRow(row) {
  const qty = Number(row[11]);
  const mp = row[9];
  return Number.isFinite(qty) && qty > 0 && typeof mp === "string" && mp.trim() !== "";
}

/**
 * 解析对账单的二维数组。
 * @returns {{ok: boolean, items?: Array, error?: string, warnings: string[]}}
 *   item = { row_no, category, threshold_key, name, value, tolerance, voltage, extra,
 *            manufacturer_part, footprint, quantity }
 */
function parseStatementRows(rows) {
  const warnings = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "对账单是空的（没有任何行）", warnings };
  }
  const headerIdx = locateHeaderRow(rows);
  const headerRow = rows[headerIdx] || [];
  try {
    assertIsStatement(headerRow);
  } catch (exc) {
    return { ok: false, error: exc.message, warnings };
  }

  const items = [];
  for (let r = headerIdx + 1; r < rows.length; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    if (!isDetailRow(row)) continue; // 标签行/合计行/说明行：跳过（不是"丢失数据"，它们本就不是明细）
    const parsed = parseProductName(row[8]);
    const category = String(row[7] == null ? "" : row[7]).trim();
    if (!parsed.value) warnings.push(`第 ${r + 1} 行：商品名称「${row[8]}」里没解出值，已留空待人工填`);
    items.push({
      row_no: r,
      category,
      threshold_key: thresholdKey(category),
      name: String(row[8] == null ? "" : row[8]).trim(),
      value: parsed.value,
      tolerance: parsed.tolerance,
      voltage: parsed.voltage,
      extra: parsed.extra,
      pack: parsed.pack,
      manufacturer_part: String(row[9] == null ? "" : row[9]).trim(),
      footprint: String(row[10] == null ? "" : row[10]).trim(),
      quantity: Number(row[11]),
    });
  }
  if (items.length === 0) {
    return { ok: false, error: "表头认出来了，但一条明细都没找到（订购数量列没有正数？）", warnings };
  }
  return { ok: true, items, warnings, header_row: headerIdx };
}

/** 读文件（目前只支持 .xls —— 用户决定"只认对账单"，而导出的对账单就是 .xls） */
function parseStatementFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".xls") {
      const fs = require("fs");
      const rows = xlsBiff.readXlsRows(fs.readFileSync(filePath));
      return parseStatementRows(rows);
    }
    return { ok: false, error: `对账单目前只认 .xls（立创导出就是这种）；收到 ${ext || "无扩展名"}`, warnings: [] };
  } catch (exc) {
    return { ok: false, error: `读取对账单失败：${exc.message}`, warnings: [] };
  }
}

module.exports = {
  NEEDED_COLUMNS,
  REQUIRED_HEADERS,
  CATEGORY_TO_THRESHOLD_KEY,
  PACKAGING_WORDS,
  thresholdKey,
  parseProductName,
  assertIsStatement,
  isDetailRow,
  parseStatementRows,
  parseStatementFile,
};
