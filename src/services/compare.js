"use strict";
/**
 * compare.js — BOM 与库存的比对（plan §5 模块表：**绝对只读**）
 *
 * 本工具最核心的一条信任基础（spec FR-2.5/2.6）：
 *   **比对绝不修改库中任何器件的任何信息，比对全过程只读，不产生库存变动记录。**
 *
 * 我没有把这条交给"纪律"去保证，而是让它**在结构上不可能违反**：
 *   本模块**不 require fs、不 require store、不接收文件路径**——
 *   `parts` 是调用方传进来的普通数组，比对结果也是普通对象。
 *   一个连 `fs` 都没有的模块，写不出库；测试里还有一条静态断言盯着它的源码
 *   （出现 `fs` / `writeFile` / `saveParts` / `rename` 就红）。
 *
 * 缺口语义（spec §4.2 v1.2 **已冻结**，不得退回"有没有"的旧语义）：
 *   需求 required = quantity_per_board × sets
 *   缺口 shortfall = max(0, required − 库存)
 *   需 24 有 3 → 缺口 **21**（不是 24）。旧语义会漏掉库存不足的缺口，违背"只补缺的"。
 *
 * 套数只在这里算一次：**刻意忽略 items 里的 total_quantity**（那是"解析时按套数算过的应入库量"）。
 * 若两个都乘，套数就被算了两遍——这类错误在界面上不显眼，但会让人买错数量。
 */

const { normalizeValue, normalizeText, normalizeTolerance } = require("./spec_parser");
const ids = require("./ids");
const { toInt, str } = require("./value_util");

/** 判定键字段（spec §5.2 五元组；顺序即 dedupe_key 的拼接顺序，plan §3.1） */
const KEY_FIELDS = ["value", "footprint", "voltage", "dielectric", "tolerance"];

/** 比对结果分组（spec FR-2.3） */
const GROUPS = ["enough", "shortfall", "uncertain"];

/**
 * 封装归一化（**跨来源比对的关键**，v2.10 修「比对全缺料」）
 *
 * 同一个封装在不同来源里写法不同：
 *   · 立创商城 / 对账单：`0603`、`1210`、`SOT-23`、`TQFN-16-EP(3x3)`、`插件,P=2.54mm`
 *   · 立创 EDA BOM：   `R0603`、`C1210`、`SOT-23_L2.9-W1.3-P1.90-LS2.4-BR`、`TQFN-16_L3.0-W3.0-P0.50-BL-EP1.1`
 * 只做"写法归一"（不改变封装本身的语义），让两种来源能对上：
 *   1) `_` 之后是 EDA 的尺寸/型号后缀，不参与判定；
 *   2) 括号里的尺寸（`(3x3)`）与 `-EP`（exposed pad）不参与判定；
 *   3) 贴片被动件的 R/C/L/D/F 前缀去掉（`R0603`/`C0603` → `0603`，`F1812` → `1812`）。
 */
function normalizeFootprint(value) {
  let text = normalizeText(value);
  if (text === "") return "";
  const underscore = text.indexOf("_");
  if (underscore > 0) text = text.slice(0, underscore);
  text = text.replace(/\([^)]*\)/g, "");
  text = text.replace(/-ep$/, "");
  const chip = /^[a-z]{1,3}(\d{3,4})$/.exec(text);
  if (chip) return chip[1];
  return text;
}

/** 容差归一化：`±1%` ↔ `+/-1%` ↔ `1%` 视为同一容差；无法解析的文本退回原文（不吞字段） */
function normalizeToleranceField(value) {
  const text = normalizeText(value);
  if (text === "") return "";
  return normalizeTolerance(text) || text;
}

/**
 * 判定键的"值"：值为空时按 v2.5 规则用**型号**兜底。
 * 依据（plan §3.1 的 v2.5 裁定）：没有参数值的料（MOS/IC/连接器/开关…）"值就是型号"。
 * 对账单导入已按这条补值；BOM 比对也必须用同一规则，否则 BOM 里值为空的行永远匹配不到库里
 * 以"值=型号"入库的同一颗料（实测：连接器/开关/三极管全被判缺料）。
 */
function keyValueOf(src) {
  const item = src || {};
  const value = normalizeValue(item.value);
  if (value !== "") return value;
  const fallback = item.part_number != null ? item.part_number : item.manufacturer_part;
  return normalizeValue(fallback);
}

/** 判定键单个字段归一（dedupeKey 与"疑似候选"共用同一套，避免两处规则漂移） */
function normalizeKeyField(field, value) {
  if (field === "value") return normalizeValue(value);
  if (field === "footprint") return normalizeFootprint(value);
  if (field === "tolerance") return normalizeToleranceField(value);
  return normalizeText(value);
}

/**
 * 判定键（plan §3.1 dedupe_key）。**全工程唯一实现**——入库合并（T7 inventory）与比对都调它，
 * 不允许各写一份：两份实现只要有一点不同，"同一颗料"在导入时与比对时就会得出不同结论。
 */
function dedupeKey(item) {
  const src = item || {};
  return [
    keyValueOf(src),
    normalizeFootprint(src.footprint),
    normalizeText(src.voltage),
    normalizeText(src.dielectric),
    normalizeToleranceField(src.tolerance),
  ].join("|");
}

/** 型号归一（大小写/连字符/空格/斜杠/括号等写法差异不参与比对；空串表示没有型号） */
function normalizeMpn(value) {
  return normalizeText(value).replace(/[\s\-_/.,+()（）]/g, "");
}

/** 从一条记录里收集全部型号（BOM 行有 manufacturer_part/part_number；库里可能还有 mpn_list） */
function mpnsOf(record) {
  const r = record || {};
  const list = [r.part_number, r.supplier_part, r.manufacturer_part];
  for (const mpn of (Array.isArray(r.mpn_list) ? r.mpn_list : [])) {
    list.push(mpn && mpn.part_number, mpn && mpn.supplier_part);
  }
  return list.map(normalizeMpn).filter((x) => x !== "");
}

/**
 * 建库存索引（比对与按 BOM 领料共用，避免两处各写一套"怎么算同一颗料"）：
 *   · byKey：判定键 → 聚合后的库存（同键多条**库存相加**，见 compareBom 注释）
 *   · byMpn：型号 → 同一条目（**比对专用**：BOM 的封装可能是 EDA 写法、库里是立创写法，
 *     判定键对不上时，型号相同是"同一颗料"最强的采购身份证据；判定键本身仍不含 MPN——
 *     spec §5.2 / plan §3.1 的 AML 规则不变：合并记录时 MPN 不参与判定）
 */
function buildLibraryIndex(parts) {
  const library = Array.isArray(parts) ? parts : [];
  const byKey = new Map();
  const byMpn = new Map();
  for (const part of library) {
    const key = dedupeKey(part);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { stock: 0, firstId: "", first: part, count: 0 };
      byKey.set(key, entry);
    }
    entry.stock += toInt(part.quantity);
    entry.count += 1;
    if (entry.firstId === "") entry.firstId = part.id;
    for (const mpn of mpnsOf(part)) {
      if (!byMpn.has(mpn)) byMpn.set(mpn, entry);
    }
  }
  return { byKey: byKey, byMpn: byMpn };
}

/**
 * 在库存索引里找 BOM 行对应的器件：**先判定键（精确），再型号兜底**。
 * @returns {{entry: object, reason: "exact"|"mpn"}|null}
 */
function findLibraryMatch(index, item) {
  const idx = index || { byKey: new Map(), byMpn: new Map() };
  const hit = idx.byKey.get(dedupeKey(item));
  if (hit) return { entry: hit, reason: "exact" };
  for (const mpn of mpnsOf(item)) {
    const entry = idx.byMpn.get(mpn);
    if (!entry) continue;
    // **型号相同但显式"值"冲突时不算匹配**：两边都写了值且归一后不同，说明型号可能填错/串行，
    // 当作"没匹配"更安全（交给缺料/疑似让人看），不能因为一个 MPN 就把 33pF 认成 10uF。
    // 跨来源的正常情况是：BOM 侧值为空（值=型号），或两边值归一后相同。
    const itemValue = normalizeValue(item.value);
    const partValue = normalizeValue(entry.first && entry.first.value);
    if (itemValue !== "" && partValue !== "" && itemValue !== partValue) continue;
    return { entry: entry, reason: "mpn" };
  }
  return null;
}

/** 缺失的判定键字段（缺了就没法精确判定，必须交人工——plan §3.1 注） */
function missingKeyFields(item) {
  const src = item || {};
  return KEY_FIELDS.filter((f) => String(src[f] == null ? "" : src[f]).trim() === "");
}

/** 文本字段统一成"空串或去空格的字符串"（库里的 Part 字段可能是 null/undefined） */
/**
 * 比对。
 * @param {Array<object>} items BOM 条目（plan §6 BomItem，只需 row_no/designators/quantity_per_board/…）
 * @param {Array<object>} parts 库存器件（plan §3.1 Part）
 * @param {number} [sets] 套数（≥1，默认 1）；需求 = quantity_per_board × sets
 * @returns {{ok: boolean, error: string, compare_id: string, enough: object[], shortfall: object[],
 *            uncertain: object[], stats: object}}
 */
function compareBom(items, parts, sets = 1) {
  const result = {
    ok: false, error: "", compare_id: "",
    enough: [], shortfall: [], uncertain: [],
    stats: { total: 0, enough: 0, shortfall: 0, uncertain: 0, no_stock: 0, insufficient: 0 },
  };
  const setCount = Number(sets);
  if (!Number.isInteger(setCount) || setCount < 1) {
    result.error = `套数必须是 ≥1 的整数（收到「${sets}」）`;
    return result;
  }
  if (!Array.isArray(items)) {
    result.error = "compareBom: items 必须是数组";
    return result;
  }
  const library = Array.isArray(parts) ? parts : [];

  // 库存索引：判定键 → { 总库存, 首个器件 id, **首个器件对象**, 条数 }；型号 → 同一条目。
  // **同键多条时库存要相加**：库里若真出现两条同规格（FR-1.9 本不该发生），
  // 只取第一条会**少报库存**→ 用户去买本来已经有的料，正是本工具要消灭的"重复采购"
  // （spec §1.1 问题①）。宁可总数正确、把"重复建条"当作数据问题另管。
  // 保留 `first`（器件对象）是为了取**功率/载流**：spec §5.2 说这两项"进导出参数列"，
  // 而 BOM 与核对表都不提供它们（FR-1.6 的可改字段清单里没有），只能来自库中器件。
  // 索引构造与"怎么算同一颗料"的实现都收在 buildLibraryIndex / findLibraryMatch，
  // 按 BOM 领料（inventory.pickByBom）复用同一份，避免两处规则漂移。
  const index = buildLibraryIndex(library);

  for (const raw of items) {
    const item = raw || {};
    const required = toInt(item.quantity_per_board) * setCount;
    const missing = missingKeyFields(item);
    // 先按判定键（值/封装/耐压/材质/容差归一后相同）匹配；对不上再看**型号**是否相同
    // （跨来源时 BOM 的 EDA 封装名与库里的立创封装名可能无法靠规则归一，型号是最硬的采购身份）
    const found = findLibraryMatch(index, item);
    const hit = found ? found.entry : null;

    const base = {
      row_no: item.row_no,
      designators: Array.isArray(item.designators) ? item.designators.slice() : [],
      quantity_per_board: toInt(item.quantity_per_board),
      required_quantity: required,
      value: item.value == null ? "" : item.value,
      footprint: item.footprint == null ? "" : item.footprint,
      voltage: item.voltage == null ? "" : item.voltage,
      dielectric: item.dielectric == null ? "" : item.dielectric,
      tolerance: item.tolerance == null ? "" : item.tolerance,
      // v1.5 实现期补记：spec §5.2 说「功率」「载流」**进导出参数列**，但 BOM 与核对表都不提供它们
      // （FR-1.6 的可改字段清单里没有）→ 只能来自**匹配到的库中器件**；没有匹配就留空。
      power: "",
      current: "",
      part_number: item.manufacturer_part || item.part_number || "",
      manufacturer: item.manufacturer == null ? "" : item.manufacturer,
      supplier_part: item.supplier_part == null ? "" : item.supplier_part,
      matched_part_id: "",
      stock_quantity: 0,
      shortfall_quantity: 0,
      match_reason: "none",
      missing_fields: [],
      // v2.12：疑似行的「库里候选身份快照」——**每条都带字段**（无候选时为空串），
      // 保证 CompareItem 的字段集与 plan §6 契约一致（前端不用判断字段是否存在）。
      candidate_value: "",
      candidate_footprint: "",
      candidate_voltage: "",
      candidate_dielectric: "",
      candidate_tolerance: "",
      candidate_part_number: "",
      candidate_supplier_part: "",
      // v2.12：是否经过人工裁决（只有 confirmed_same / confirmed_different 行为 true）
      confirmed_by_human: false,
    };

    // ① **先看精确命中**：判定键归一后完全相同，或型号相同（match_reason 会标出来），
    //    就是同一颗料——即便双方都缺同一个键字段（例如库是从同一份 BOM 录进去的，两边都没写耐压）。
    if (hit) {
      const stock = hit.stock;
      const shortfall = Math.max(0, required - stock);
      const matched = Object.assign(base, {
        matched_part_id: hit.firstId,
        stock_quantity: stock,
        shortfall_quantity: shortfall,
        match_reason: found.reason, // exact（判定键） / mpn（型号相同、封装写法不同）
        // 功率/载流取库中那条（spec §5.2：它们进参数列，而 BOM 侧没有）
        power: str(hit.first && hit.first.power),
        current: str(hit.first && hit.first.current),
      });
      // 需求 0（如 BOM 里 Quantity=0）：不判缺料、不导出（spec AC-2 边界）
      if (shortfall === 0) result.enough.push(matched);
      else result.shortfall.push(matched);
      continue;
    }

    // ② 没命中，且**库里存在"部分匹配"的候选**时才是"疑似"——歧义来自"它可能就是库里那条"。
    //    若库里根本没有候选（例如库为空），那就没有歧义：结论只能是缺料。
    //    这条同时满足 spec 的两处要求：§5.2「键字段缺失需人工裁决」与 AC-2「库为空 → 全部缺料」。
    const partial = missing.length > 0 ? findPartialMatch(item, library, missing) : null;
    if (partial) {
      const stock = toInt(partial.quantity);
      result.uncertain.push(Object.assign(base, {
        matched_part_id: partial.id,
        stock_quantity: stock,
        match_reason: "partial",
        missing_fields: missing,
        // **界面要把"疑似的是什么"标清楚**（用户反馈：只说"待人工确认"却没给确认键/没说清候选是谁）：
        // 候选器件的身份快照（值/封装/耐压/材质/容差/型号/库存）。只读信息，不写库。
        candidate_value: str(partial.value),
        candidate_footprint: str(partial.footprint),
        candidate_voltage: str(partial.voltage),
        candidate_dielectric: str(partial.dielectric),
        candidate_tolerance: str(partial.tolerance),
        candidate_part_number: str(partial.part_number),
        candidate_supplier_part: str(partial.supplier_part),
        // **疑似行也要按 spec §4.2 的公式算缺口**：数量列 = max(0, 需求 − 现有库存)。
        // 原来这里没算，于是勾选"连同疑似一起导出"时，最需要人看一眼的那几行数量列恒为 0
        // ——用户拿着它去下单，等于把"缺 21 个"写成"0 个"。
        shortfall_quantity: Math.max(0, required - stock),
        // 功率/载流取库中那条（spec §5.2：它们进参数列，而 BOM 侧没有）
        power: str(partial.power),
        current: str(partial.current),
      }));
      continue;
    }

    // ③ 库里没有这条 → 缺料。库存按 0 算，于是与 ① 同一条公式：缺口 = max(0, 需求 − 库存)。
    //    需求为 0 的条目（BOM 里 Quantity=0）在这一步同样落进"够用"，不判缺料（spec AC-2 边界）。
    const absent = required;
    const missOut = Object.assign(base, { shortfall_quantity: absent, match_reason: "none" });
    if (absent === 0) result.enough.push(missOut);
    else result.shortfall.push(missOut);
  }

  result.stats.total = result.enough.length + result.shortfall.length + result.uncertain.length;
  result.stats.enough = result.enough.length;
  result.stats.shortfall = result.shortfall.length;
  result.stats.uncertain = result.uncertain.length;
  result.stats.no_stock = result.shortfall.filter((x) => x.stock_quantity === 0).length;
  result.stats.insufficient = result.shortfall.filter((x) => x.stock_quantity > 0).length;
  result.ok = true;
  return result;
}

/**
 * 部分匹配候选：把"缺失字段"排除后，其余判定键字段全同的器件。
 * 只用于给"疑似"提供线索，**不据此下结论**（那是人裁决的事）。
 */
function findPartialMatch(item, library, missing) {
  const known = KEY_FIELDS.filter((f) => !missing.includes(f));
  for (const part of library) {
    const same = known.every((f) => normalizeKeyField(f, part[f]) === normalizeKeyField(f, item[f]));
    if (same) return part;
  }
  return null;
}

/**
 * 应用**人工裁决**（比对页的「是同一颗 / 不是同一颗」按钮；spec FR-2.3 的"疑似需人工确认"）。
 *
 * **比对仍然只读**：裁决只影响"这份比对结果怎么分组/导出多少"，不写库、不产生变动记录。
 * 规则（服务端唯一实现，界面只负责收集裁决）：
 *   · `"same"`（确认是同一颗）→ 从疑似移出，按候选库存算：够用或缺口 = max(0, 需求 − 候选库存)；
 *   · `"different"`（不是同一颗）→ 从疑似移出，进缺料：库存 0、缺口 = 需求；
 *   · 未裁决 / 非法值 → 留在疑似。
 * @param {object} result compareBom 的结果
 * @param {object} rulings `{ [row_no]: "same"|"different" }`
 * @returns {{ok:boolean,error:string,enough:object[],shortfall:object[],uncertain:object[],stats:object,compare_id:string}}
 */
function applyRulings(result, rulings) {
  const src = result || {};
  const map = rulings == null ? {} : rulings;
  if (typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, error: "rulings 必须是对象：{ 行号: \"same\" | \"different\" }", enough: [], shortfall: [], uncertain: [], stats: {}, compare_id: str(src.compare_id) };
  }
  const enough = (Array.isArray(src.enough) ? src.enough : []).slice();
  const shortfall = (Array.isArray(src.shortfall) ? src.shortfall : []).slice();
  const uncertain = [];
  for (const item of (Array.isArray(src.uncertain) ? src.uncertain : [])) {
    const ruling = map[item && item.row_no];
    if (ruling === "same") {
      const stock = toInt(item.stock_quantity);
      const required = toInt(item.required_quantity);
      const gap = Math.max(0, required - stock);
      const ruled = Object.assign({}, item, {
        match_reason: "confirmed_same",
        confirmed_by_human: true,
        shortfall_quantity: gap,
      });
      if (gap === 0) enough.push(ruled);
      else shortfall.push(ruled);
    } else if (ruling === "different") {
      shortfall.push(Object.assign({}, item, {
        match_reason: "confirmed_different",
        confirmed_by_human: true,
        matched_part_id: "",
        stock_quantity: 0,
        shortfall_quantity: toInt(item.required_quantity),
      }));
    } else {
      uncertain.push(item);
    }
  }
  return {
    ok: true,
    error: "",
    compare_id: str(src.compare_id),
    enough: enough,
    shortfall: shortfall,
    uncertain: uncertain,
    stats: {
      total: enough.length + shortfall.length + uncertain.length,
      enough: enough.length,
      shortfall: shortfall.length,
      uncertain: uncertain.length,
      no_stock: shortfall.filter((x) => toInt(x.stock_quantity) === 0).length,
      insufficient: shortfall.filter((x) => toInt(x.stock_quantity) > 0).length,
    },
  };
}

/** `compare_YYYYMMDD_HHMMSS`（与 batch/pick 号同一形态，便于按 ref 追溯）——实现统一在 `./ids` */
function makeCompareId(when) {
  return ids.makeRunId("compare", when);
}

module.exports = {
  KEY_FIELDS,
  GROUPS,
  normalizeFootprint,
  normalizeToleranceField,
  normalizeMpn,
  normalizeKeyField,
  buildLibraryIndex,
  findLibraryMatch,
  applyRulings,
  dedupeKey,
  missingKeyFields,
  compareBom,
  findPartialMatch,
  makeCompareId,
};
