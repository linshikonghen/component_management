"use strict";
/**
 * statement_match.js — 把对账单明细与库中器件对上（**只用于入库**；不写库、不导出、不比对）
 *
 * 匹配键（用户 2026-10-16 决定）：**商品类型 + 商品名称(值/容差/耐压) + 商品型号 + 封装**
 * —— 不用品牌、不用立创 C 编码（同型号可能从别处买、厂商不同；C 编码是立创特有的）。
 *
 * **为什么要分三桶**（这是本模块唯一的判断，说明白）：
 * 库里从 BOM 建的器件**没有容差/耐压**（BOM 里本来就没有这两列，实测 68/68 行都空）。
 * 若坚持"四字段全等才算命中"，这些器件会**全部匹配不上** → 每次导入都新增一批重复器件。
 * 所以分三桶，把"拿不准"的交给人（这正是本项目的人工核对闸门）：
 *
 *   matched   严格命中：四项全等（值/容差/耐压 双方都有且相同）
 *   suspected **疑似**：型号 + 封装相同，但参数有差异或**库里缺项**（如库里容差是空的）
 *              → 必须在核对表里由人裁决"就是它 / 不是它"，**绝不自动合并**
 *   missing   新增：型号+封装都找不到 → 当作新器件
 *
 * 归一化：去空白、统一大小写、全角括号转半角（`贴片电容(MLCC)` 两种括号都见过）。
 */

/** 归一化：去首尾/内部多余空白 → 小写 → 全角括号/符号转半角 */
function norm(text) {
  return String(text == null ? "" : text)
    .replace(/（/g, "(").replace(/）/g, ")")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * **分类**归一：走单一来源 `categories.settingsKeyOf`。
 * 为什么必须这样：库里可能存的是旧位号键（`R`），对账单存的是立创中文名（`贴片电阻`）——
 * 直接比字符串永远不相等 → 明明库里有这颗料，导入却当成"新增"再建一条 ✗（用户实测报过）
 * ⚠️ 查表前先做一次"清洗"（全角括号→半角、去多余空白、破折号归一）但**不转小写**——
 * 立创类型名的大小写是有意义的（`贴片电容(MLCC)`），转小写就查不到了。
 * 认不出（未收录的商品类型）就退回原样小写，仍然可比。
 */
function normCategory(text) {
  const { settingsKeyOf } = require("./categories");
  const cleaned = String(text == null ? "" : text)
    .replace(/（/g, "(").replace(/）/g, ")")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";
  const key = settingsKeyOf(cleaned);
  return key === "OTHER" ? norm(cleaned) : key;
}

/** **值**归一：走单一来源 `spec_parser.normalizeValue`（`100K` == `100KΩ` == `100kΩ`） */
function normValue(text) {
  const { normalizeValue } = require("./spec_parser");
  return normalizeValue(text);
}

/** 容差/耐压归一：±/+/- 统一、去空格、大小写归一 */
function normSpec(text) {
  const { normalizeText } = require("./spec_parser");
  return normalizeText(text);
}

/** 器件（库中）侧的四字段键 */
function partKey(part) {
  const p = part || {};
  return {
    category: normCategory(p.category),
    value: normValue(p.value),
    tolerance: normSpec(p.tolerance),
    voltage: normSpec(p.voltage),
    // 库中器件的型号在**契约字段 `part_number`**（厂商料号）；`manufacturer_part` 只作旧数据兜底
    //（2026-10-17 前的对账单入库曾把它写进 manufacturer_part —— 那是个不在白名单的错误字段）
    manufacturer_part: norm(p.part_number || p.manufacturer_part),
    footprint: norm(p.footprint),
  };
}

/** 明细（对账单）侧的四字段键 */
function itemKey(item) {
  const it = item || {};
  return {
    category: normCategory(it.category),
    value: normValue(it.value),
    tolerance: normSpec(it.tolerance),
    voltage: normSpec(it.voltage),
    manufacturer_part: norm(it.manufacturer_part),
    footprint: norm(it.footprint),
  };
}

/** 严格命中：分类/值/容差/耐压/型号/封装 六项全等（容差与耐压为空的**不算全等**） */
function isStrictMatch(a, b) {
  return a.category === b.category
    && a.value === b.value
    && a.manufacturer_part === b.manufacturer_part
    && a.footprint === b.footprint
    && a.tolerance === b.tolerance
    && a.voltage === b.voltage
    && a.tolerance !== "" && a.voltage !== "";
}

/** 疑似：型号 + 封装 + 值 相同，但容差/耐压有差异或库里缺项（→ 交人工裁决） */
function isSuspect(a, b) {
  return a.manufacturer_part !== "" && a.manufacturer_part === b.manufacturer_part
    && a.footprint === b.footprint
    && a.value === b.value
    && !isStrictMatch(a, b);
}

/**
 * 疑似（**库里没有型号**的那种）：手工录入的料往往只填了 分类/值/封装（型号留空），
 * 而对账单行是有型号的 → 上面那条 isSuspect 永远不成立 → 会被当成"新增"再建一条重复料 ✗
 * （用户实测：手录的 `100K / 0603` 与对账单的 `100kΩ / FRC0603F1003TS` 对不上）
 * 所以补一条**只进人工裁决桶**的规则：分类+值+封装相同、且至少一边型号为空 → 疑似。
 * 绝不自动合并（仍是 suspected，界面默认"待裁决"）✓
 */
function isSuspectByBlankPartNo(a, b) {
  return a.category !== "" && a.category === b.category
    && a.value !== "" && a.value === b.value
    && a.footprint !== "" && a.footprint === b.footprint
    && (a.manufacturer_part === "" || b.manufacturer_part === "");
}

/** 差异清单（给核对表显示"差在哪"，人才能裁决） */
function diffFields(a, b) {
  const out = [];
  for (const f of ["category", "value", "tolerance", "voltage", "manufacturer_part", "footprint"]) {
    if (a[f] !== b[f]) out.push(`${f}: 库里「${b[f] || "空"}」 vs 对账单「${a[f] || "空"}」`);
  }
  return out;
}

/**
 * @param {Array} items 对账单明细（lcsc_statement.parseStatementRows 的 items）
 * @param {Array} parts 库中器件
 * @returns {{matched: Array, suspected: Array, missing: Array}}
 *   matched[]   { item, part, index }
 *   suspected[] { item, candidates: [{part, index, diff: string[]}] }
 *   missing[]   { item }
 */
function matchStatement(items, parts) {
  const list = Array.isArray(parts) ? parts : [];
  const keys = list.map(partKey);
  const matched = [];
  const suspected = [];
  const missing = [];

  for (const item of (Array.isArray(items) ? items : [])) {
    const k = itemKey(item);
    let hitIndex = -1;
    for (let i = 0; i < keys.length; i += 1) {
      if (isStrictMatch(k, keys[i])) { hitIndex = i; break; }
    }
    if (hitIndex >= 0) {
      matched.push({ item, part: list[hitIndex], index: hitIndex });
      continue;
    }
    const candidates = [];
    for (let i = 0; i < keys.length; i += 1) {
      if (isSuspect(k, keys[i]) || isSuspectByBlankPartNo(k, keys[i])) {
        candidates.push({ part: list[i], index: i, diff: diffFields(k, keys[i]) });
      }
    }
    if (candidates.length > 0) suspected.push({ item, candidates });
    else missing.push({ item });
  }
  return { matched, suspected, missing };
}

module.exports = {
  norm, normCategory, normValue, normSpec,
  partKey, itemKey, isStrictMatch, isSuspect, isSuspectByBlankPartNo, diffFields, matchStatement,
};
