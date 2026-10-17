"use strict";

/**
 * part_search.js — 器件检索与筛选的**唯一定义处**（"相似产品"怎么认定，只在这里说）
 *
 * 背景（用户 2026-10-17 目标）：「领料和库存太繁琐了，至少要有检索，筛选等功能，
 * 检索相似产品的应对方法学习并更新」。
 *
 * 三档判定（越靠前越"像"；回来的每条命中带 `match`，界面可以据此标"相似"）：
 *   ① `exact`   字面命中：跨关键信息字段的子串匹配（FR-5.2，字段清单见 SEARCH_FIELDS）
 *   ② `similar` **同值相似**：把查询词归一到标准值再比较（复用 `spec_parser.normalizeValue`，
 *      所以 `0.1uF` ↔ `100nF`、`4K7` ↔ `4.7kΩ`、`10K` ↔ `10kΩ`、`0R` ↔ `0Ω`、大小写无关都算"同一个值"）；
 *      或**容差归一后相同**（`±1%` ↔ `+/-1%` ↔ `1%`，复用 `spec_parser.normalizeTolerance`）；
 *      或**封装/型号"宽松归一"后相同**（全角→半角、去空格/连字符/下划线，例：`SOT23` ↔ `SOT-23`）；
 *      查询词是"值+参数"混合写法时（`100nF 50V`、`100nF/50V`）会从词元里**取出值**再比。
 *   ③ `tokenized` **多关键字 AND**（行业常规的搜索语义：空格分隔的每个词都要在同一器件上命中，
 *      不是 OR；单关键字查询不会走到这一档）——例如 `贴片 0603`、`村田 100nF`
 *   ④ 空查询 = 全部（match: "all"）
 *   ⑤ 排序遵循"越精确越靠前"的行业常规：exact > similar > tokenized，同档内
 *      值/型号"完全相等 > 前缀命中 > 普通子串命中"
 *
 * 筛选（FR-5.3）：分类 / 封装 / 耐压（大小写不敏感）/ 只看低库存。
 *
 * 为什么集中在这里：界面（库存页、领料页）都通过 `parts:list` 的 query 走同一套语义——
 * **禁止**在渲染进程里另写一份"相似"判断（AGENTS.md 反重复规则）。
 */

const { looksLikeValue, normalizeValue, normalizeText, normalizeTolerance, parseValueToken } = require("./spec_parser");

/** 原文（不 trim；检索内部用；对外的 str 语义统一在 value_util） */
function rawText(value) {
  return value == null ? "" : String(value);
}

/** FR-5.2：参与字面搜索的字段（跨关键信息；顺序不影响结果） */
const SEARCH_FIELDS = [
  "value", "footprint", "voltage", "dielectric", "tolerance",
  "part_number", "manufacturer", "supplier_part", "supplier",
  "location", "note", "category", "batch",
];

function lower(value) {
  return rawText(value).toLowerCase();
}

/** 全角 → 半角（用户可能从 Excel/中文输入法粘进全角字符：`１００ｎＦ` 要能当 `100nF` 搜） */
function foldWidth(value) {
  const text = rawText(value);
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 宽松归一：全角→半角、小写、去掉分隔符（空格/连字符/下划线/斜杠/点/括号）——用于封装、型号的写法差异 */
function looseText(value) {
  return foldWidth(value).toLowerCase().replace(/[\s\-_/.,()\[\]（）【】]/g, "");
}

/** 检索用的"字面文本"（全角折半 + 小写，让全角输入也能命中） */
function searchText(value) {
  return foldWidth(value).toLowerCase();
}

/** 一条器件的可搜索文本（字段值 join；用 NUL 分隔避免跨字段拼接误命中） */
function haystackOf(part) {
  const p = part || {};
  return SEARCH_FIELDS.map((f) => searchText(p[f])).join("\u0000");
}

/** 值归一：解析失败时退回原文（不许因为一个坏值把整次检索搞崩） */
function normalizedValueOf(value) {
  const raw = rawText(value).trim();
  if (raw === "") return "";
  try {
    return normalizeValue(raw);
  } catch (exc) {
    return raw;
  }
}

/** 从"值+参数"的混合写法里取出值：`100nF 50V` / `100nF/50V` / `100nF±10%` → 100nF */
function extractValueFromQuery(raw) {
  const text = foldWidth(raw).replace(/[（）()]/g, " ");
  // 先整体试（快路径），再按常见分隔符切片逐个试
  const pieces = [text].concat(text.split(/[\s,，;；/|、]+/).filter((x) => x !== ""));
  for (const piece of pieces) {
    const token = piece.trim();
    if (token === "" || !looksLikeValue(token)) continue;
    try {
      if (parseValueToken(token)) return normalizedValueOf(token);
    } catch (exc) { /* 继续试下一片 */ }
  }
  return "";
}

/** 单条容差归一（失败返回 ""；容差相似与多关键字 AND 共用，避免两处各写一套 try/catch） */
function toleranceOf(value) {
  try {
    return normalizeTolerance(rawText(value));
  } catch (exc) {
    return "";
  }
}

/** 从混合写法里取出容差（`±1%` / `+/-1%` / `1%`） */
function extractToleranceFromQuery(raw) {
  const text = foldWidth(raw);
  const pieces = [text].concat(text.split(/[\s,，;；/|、]+/).filter((x) => x !== ""));
  for (const piece of pieces) {
    const token = piece.trim();
    if (token === "") continue;
    let normalized = "";
    try {
      normalized = normalizeTolerance(token);
    } catch (exc) { normalized = ""; }
    if (normalized !== "") return normalized;
  }
  return "";
}

/** 把查询词整理成可比对的形式（纯函数，可缓存） */
function prepareQuery(rawQuery) {
  const raw = rawText(rawQuery).trim();
  const prepared = {
    raw,
    lower: searchText(raw),
    value: "",       // 查询词若本身（或混合写法里）含"值"，这里放它的标准值
    tolerance: "",   // 查询词里的容差标准写法（±1% / ±10% …）
    mpn: normalizeText(raw),
    loose: looseText(raw), // 宽松归一（封装/型号写法差异：SOT23 ↔ SOT-23）
    // 多关键字（空格/逗号/斜杠分隔）；行业常规是 AND：每个词都要命中同一器件。
    // 单关键字时长度 = 1，检索行为与以前完全一致（不会引入新的"疑似匹配"）。
    tokens: [],
  };
  if (raw === "") return prepared;
  if (looksLikeValue(raw)) {
    prepared.value = normalizedValueOf(raw);
  } else {
    prepared.value = extractValueFromQuery(raw);
  }
  prepared.tolerance = extractToleranceFromQuery(raw);
  prepared.tokens = Array.from(new Set(
    searchText(raw).split(/[\s,，;；/|、]+/).map((x) => x.trim()).filter((x) => x !== "")
  ));
  return prepared;
}

/** 筛选条件（FR-5.3）：分类 / 封装 / 耐压 / 只看低库存 */
function passesFilters(part, query, lowSet) {
  const p = part || {};
  const q = query || {};
  const category = rawText(q.category).trim();
  if (category !== "" && rawText(p.category).trim() !== category) return false;
  const footprint = rawText(q.footprint).trim();
  if (footprint !== "" && lower(p.footprint).trim() !== footprint.toLowerCase()) return false;
  const voltage = rawText(q.voltage).trim();
  if (voltage !== "" && lower(p.voltage).trim() !== voltage.toLowerCase()) return false;
  if (q.low_stock_only === true && !lowSet.has(p.id)) return false;
  return true;
}

/**
 * 多关键字 AND 里"这一个词是否命中该器件"。
 * 行业常规的搜索允许写法差异：字面命中之外，也认"值归一相同 / 容差归一相同 / 封装型号宽松归一相同"，
 * 否则「100nF 50V」搜不到库里写成 0.1uF 的同一颗料（用户高频场景）。
 */
function tokenMatches(part, hay, token) {
  if (hay.indexOf(token) >= 0) return true;
  const sub = prepareQuery(token);
  if (sub.value !== "" && normalizedValueOf(part.value) === sub.value) return true;
  if (sub.tolerance !== "" && toleranceOf(part.tolerance) === sub.tolerance) return true;
  if (sub.loose !== "") {
    for (const field of ["footprint", "part_number", "supplier_part"]) {
      const got = looseText(part[field]);
      if (got !== "" && got === sub.loose) return true;
    }
  }
  return false;
}

/**
 * 单条判定：`exact` / `similar` / tokenized / null
 * @param {object} part
 * @param {{lower:string, value:string, mpn:string}} prepared prepareQuery 的结果
 */
function classify(part, prepared) {
  const p = part || {};
  const prep = prepared || { raw: "", lower: "", value: "", tolerance: "", mpn: "", loose: "" };
  if (prep.lower === "") return "all";
  const hay = haystackOf(p);
  if (hay.indexOf(prep.lower) >= 0) return "exact";
  // 多关键字 AND 闸门（行业常规）：查询里每个词都必须命中同一器件，之后才谈"相似写法"。
  // 否则「村田 100nF」会因为 100nF 归一相似而冒出无关的料 —— 那不是 AND 语义。
  if (prep.tokens && prep.tokens.length > 1) {
    if (!prep.tokens.every((token) => tokenMatches(p, hay, token))) return null;
  }
  // 同值相似：0.1uF ↔ 100nF、4K7 ↔ 4.7kΩ、10K ↔ 10kΩ ……
  if (prep.value !== "") {
    const pv = normalizedValueOf(p.value);
    if (pv !== "" && pv === prep.value) return "similar";
  }
  // 容差相似：±1% ↔ +/-1% ↔ 1%（用户从不同来源抄下来的写法不一样）
  if (prep.tolerance !== "") {
    const pv = toleranceOf(p.tolerance);
    if (pv !== "" && pv === prep.tolerance) return "similar";
  }
  // 封装/型号"宽松归一"相似：全角→半角、去空格/连字符/下划线（SOT23 ↔ SOT-23、AO3401 A ↔ AO3401A）
  if (prep.loose !== "") {
    for (const field of ["footprint", "part_number", "supplier_part"]) {
      const got = looseText(p[field]);
      if (got !== "" && got === prep.loose) return "similar";
    }
  }
  // 走到这里说明"每个关键字都命中"（上面的 AND 闸门已保证），但没有同值/容差/宽松归一这类
  // 更精确的理由 → 记为 tokenized（多关键字命中，不算"相似"，similar_ids 里不出现）。
  if (prep.tokens && prep.tokens.length > 1) return "tokenized";
  return null;
}

/** 筛选下拉框的可选值（从**全部**器件算，不受当前筛选影响） */
function facetsOf(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const uniq = (values) => Array.from(new Set(values.map((v) => rawText(v).trim()).filter((v) => v !== "")))
    .sort((a, b) => a.localeCompare(b, "zh"));
  return {
    categories: uniq(list.map((p) => p.category)),
    footprints: uniq(list.map((p) => p.footprint)),
    voltages: uniq(list.map((p) => p.voltage)),
  };
}

/**
 * 检索 + 筛选（排序不在这里做，由调用方按 SORTABLE_FIELDS 排）。
 * @returns {{hits: Array<{part: object, match: "all"|"exact"|"similar"}>, similar_ids: string[], facets: object}}
 */
function searchParts(parts, query = {}, options = {}) {
  const list = Array.isArray(parts) ? parts : [];
  const lowSet = options.lowSet instanceof Set ? options.lowSet : new Set();
  const q = query || {};
  const prepared = prepareQuery(q.q);
  const hits = [];
  for (const part of list) {
    if (!passesFilters(part, q, lowSet)) continue;
    const match = classify(part, prepared);
    if (!match) continue;
    hits.push({ part, match });
  }
  // 排序（行业常规：越精确越靠前）：
  //   档位 exact > similar > tokenized；同档内"值/型号 完全相等 > 前缀命中 > 普通子串"，最后按库内原顺序（稳定）
  const MATCH_LEVEL = { exact: 3, similar: 2, tokenized: 1 };
  const ranked = hits.map((hit, index) => ({
    hit,
    index,
    score: (MATCH_LEVEL[hit.match] || 0) * 1000 + relevanceBoost(hit.part, prepared),
  }));
  ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const sorted = ranked.map((x) => x.hit);
  return {
    hits: sorted,
    similar_ids: sorted.filter((h) => h.match === "similar").map((h) => rawText(h.part.id)),
    facets: facetsOf(list),
  };
}

/**
 * 同档内的相关性加分（行业常规：精确相等 > 前缀 > 子串；值/型号是"身份字段"权重更高）。
 * 只影响排序，不改变命中集合。
 */
function relevanceBoost(part, prepared) {
  const p = part || {};
  const prep = prepared || { lower: "" };
  const q = prep.lower;
  if (q === "") return 0;
  let boost = 0;
  const value = searchText(p.value);
  const mpn = searchText(p.part_number);
  const supplierPart = searchText(p.supplier_part);
  for (const [text, equalScore, prefixScore, subScore] of [
    [value, 400, 220, 90],
    [mpn, 320, 160, 70],
    [supplierPart, 320, 160, 70],
  ]) {
    if (text === "") continue;
    if (text === q) boost += equalScore;
    else if (text.indexOf(q) === 0) boost += prefixScore;
    else if (text.indexOf(q) >= 0) boost += subScore;
  }
  return boost;
}

module.exports = {
  SEARCH_FIELDS,
  foldWidth,
  looseText,
  searchText,
  extractValueFromQuery,
  extractToleranceFromQuery,
  haystackOf,
  normalizedValueOf,
  prepareQuery,
  passesFilters,
  classify,
  facetsOf,
  searchParts,
  toleranceOf,
  tokenMatches,
};
