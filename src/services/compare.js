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

const { normalizeValue, normalizeText } = require("./spec_parser");
const ids = require("./ids");

/** 判定键字段（spec §5.2 五元组；顺序即 dedupe_key 的拼接顺序，plan §3.1） */
const KEY_FIELDS = ["value", "footprint", "voltage", "dielectric", "tolerance"];

/** 比对结果分组（spec FR-2.3） */
const GROUPS = ["enough", "shortfall", "uncertain"];

/**
 * 判定键（plan §3.1 dedupe_key）。**全工程唯一实现**——入库合并（T7 inventory）与比对都调它，
 * 不允许各写一份：两份实现只要有一点不同，"同一颗料"在导入时与比对时就会得出不同结论。
 */
function dedupeKey(item) {
  const src = item || {};
  return [
    normalizeValue(src.value),
    normalizeText(src.footprint),
    normalizeText(src.voltage),
    normalizeText(src.dielectric),
    normalizeText(src.tolerance),
  ].join("|");
}

/** 缺失的判定键字段（缺了就没法精确判定，必须交人工——plan §3.1 注） */
function missingKeyFields(item) {
  const src = item || {};
  return KEY_FIELDS.filter((f) => String(src[f] == null ? "" : src[f]).trim() === "");
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 文本字段统一成"空串或去空格的字符串"（库里的 Part 字段可能是 null/undefined） */
function str(value) {
  return value == null ? "" : String(value).trim();
}

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

  // 库存索引：判定键 → { 总库存, 首个器件 id, **首个器件对象**, 条数 }
  // **同键多条时库存要相加**：库里若真出现两条同规格（FR-1.9 本不该发生），
  // 只取第一条会**少报库存**→ 用户去买本来已经有的料，正是本工具要消灭的"重复采购"
  // （spec §1.1 问题①）。宁可总数正确、把"重复建条"当作数据问题另管。
  // 保留 `first`（器件对象）是为了取**功率/载流**：spec §5.2 说这两项"进导出参数列"，
  // 而 BOM 与核对表都不提供它们（FR-1.6 的可改字段清单里没有），只能来自库中器件。
  const byKey = new Map();
  for (const part of library) {
    const key = dedupeKey(part);
    const cur = byKey.get(key);
    if (cur) {
      cur.stock += toInt(part.quantity);
      cur.count += 1;
    } else {
      byKey.set(key, { stock: toInt(part.quantity), firstId: part.id, first: part, count: 1 });
    }
  }

  for (const raw of items) {
    const item = raw || {};
    const required = toInt(item.quantity_per_board) * setCount;
    const missing = missingKeyFields(item);
    const key = dedupeKey(item);
    const hit = byKey.get(key) || null;

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
    };

    // ① **先看精确命中**：判定键完全相同就是同一种料——即便双方都缺同一个键字段
    //    （例如库是从同一份 BOM 录进去的，两边都没写耐压，那它们仍是"同一种料"）。
    if (hit) {
      const stock = hit.stock;
      const shortfall = Math.max(0, required - stock);
      const matched = Object.assign(base, {
        matched_part_id: hit.firstId,
        stock_quantity: stock,
        shortfall_quantity: shortfall,
        match_reason: "exact",
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
    const same = known.every((f) => {
      if (f === "value") return normalizeValue(part.value) === normalizeValue(item.value);
      return normalizeText(part[f]) === normalizeText(item[f]);
    });
    if (same) return part;
  }
  return null;
}

/** `compare_YYYYMMDD_HHMMSS`（与 batch/pick 号同一形态，便于按 ref 追溯）——实现统一在 `./ids` */
function makeCompareId(when) {
  return ids.makeRunId("compare", when);
}

module.exports = {
  KEY_FIELDS,
  GROUPS,
  dedupeKey,
  missingKeyFields,
  compareBom,
  findPartialMatch,
  makeCompareId,
};
