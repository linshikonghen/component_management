"use strict";
/**
 * low_stock.js — 低库存阈值解析与判定（spec FR-4 / AC-4 / AC-9）
 *
 * 规则来源（spec §5.3 + FR-4.6~4.8）：
 *   分类默认阈值预置在 settings.default_min_quantity（14 类，首启写入，见 store.DEFAULT_SETTINGS）
 *   ⚠️ 器件的 `category` 存的是**立创中文名**，不是阈值类键 → 查表前要经
 *      `categories.settingsKeyOf` 映射（单一来源）；漏了这一步会**静默漏报**（阈值永远取不到）
 *   **单个器件可覆盖分类默认；留空 = 继承分类默认**（FR-4.8）
 *   判据是「库存 **低于** 阈值」（FR-4.2 原文），等于阈值不算低
 *
 * ⚠️ 以文档为准记下的一处 spec 自相矛盾（我没有擅自"抹平"，也没改 spec）：
 *   · AC-4 异常路径：「阈值留空 → 该器件不参与低库存判断，不误报」
 *   · FR-4.8 + AC-9：「留空 = 继承分类默认」，且 AC-9 明确要求
 *     "某电容不设个体阈值、分类默认 20、库存 15 → 判为**低库存**"
 *   同一输入（个体阈值留空 + 分类默认存在）得出相反结论，两句不可能同时为真。
 *   本实现按 **FR-4.8 / AC-9** 走，依据有三：
 *     ① spec §9 的 Q4 用户答复原文是「B 按分类默认 + 个体覆盖」——留空即继承是用户选的；
 *     ② AC-9 是 v1.5 专门为"FR-4.6~4.8 无实现载体"补的验收，比 AC-4 那一行更晚、更具体；
 *     ③ FR-4.1「可为空=不提示」是 v1.0 的旧措辞，与 Q4 之后的 FR-4.8 冲突。
 *   **想彻底关掉某条器件的提示**：把它的个体阈值设为 `0`（库存不可能低于 0）——
 *   这在两种读法下都成立，是给用户的逃生口，已写进测试。
 *   **已裁定（用户 2026-10-17）：以 FR-4.8 为准**（留空 = 继承分类默认；要"不提示"就显式填 0）。
 *   spec 的 AC-4 该行已在 v1.6 统一成同一语义，因此本轮**不改 spec**，只把 AC 覆盖表里的
 *   "conflict/待裁决" 更新为 auto（见 tests/test_ac_coverage.js 的 AC-4:4）。
 *
 * 纯函数：不碰文件系统、不读写设置文件——`settings` 由调用方从 store 取来传入。
 */

const { DEFAULT_CATEGORY } = require("./inventory");
const { settingsKeyOf } = require("./categories");
const { toInt, isBlank } = require("./value_util");

/** 个体阈值是否"留空"（null/undefined/"" 都算留空；0 是**有效值**，不是留空） */
/**
 * 解析一条器件的**实际生效阈值**（FR-4.8）。
 * @param {object} part 器件（plan §3.1）
 * @param {object} settings 应用设置（plan §3.3）
 * @returns {{threshold: number|null, source: "individual"|"category"|"default"|"none"}}
 *   `default` = 分类认不出（或落的是兜底类 `OTHER`）→ 用了 `_default` 那条兜底阈值；
 *   `none` 仅当个体留空**且**连兜底阈值都不存在（设置被裁剪过）时才出现——此时不提示。
 * @throws 阈值不是非负数字时报错（不静默当作 0，否则会静默漏报或误报）
 */
function effectiveMinQuantity(part, settings) {
  const src = part || {};
  if (!isBlank(src.min_quantity)) {
    const n = Number(src.min_quantity);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `器件的低库存阈值非法：${JSON.stringify(src.min_quantity)}（必须是非负数字或留空）`
      );
    }
    return { threshold: Math.trunc(n), source: "individual" };
  }
  const map = (settings && settings.default_min_quantity) || {};
  const category = String(src.category == null ? "" : src.category).trim();
  // category 落库的是**立创中文名**（`贴片电容(MLCC)` / `排母` …），而 default_min_quantity 的键
  // 是 spec §5.3 的**类键**（C / H / Q …）→ 必须先映射回类键，否则永远查不到阈值（静默漏报）。
  // `_default` 哨兵与旧前缀键（R / SW / Y…）经 categories.settingsKeyOf 都能落回同一个类 ✓
  // ⚠️ 分类表里没有的立创类型（如对账单里的「固态电容」）会映射到兜底类 `OTHER`——
  //    而设置表的兜底键是哨兵 `_default` → 此处按 `_default` 的阈值处理，并如实报告 source="default" ✓
  const mapped = category === "" ? DEFAULT_CATEGORY : settingsKeyOf(category);
  const usable = Object.prototype.hasOwnProperty.call(map, mapped)
    && (mapped !== "OTHER" || category === "OTHER" || category === "其它");
  const key = usable ? mapped : DEFAULT_CATEGORY;
  const raw = map[key];
  if (isBlank(raw)) return { threshold: null, source: "none" };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`分类「${key}」的默认阈值非法：${JSON.stringify(raw)}（必须是非负数字）`);
  }
  return {
    threshold: Math.trunc(n),
    // 用的是兜底那条（分类认不出 / 落 OTHER）→ 如实标 `default`，别谎称"按分类默认"
    source: key === DEFAULT_CATEGORY ? "default" : "category",
  };
}

/** 单条是否低库存（库存 **低于** 阈值；等于不算） */
function isLowStock(part, settings) {
  const { threshold } = effectiveMinQuantity(part, settings);
  if (threshold == null) return false;
  return toInt(part && part.quantity) < threshold;
}

/**
 * 找出所有低库存器件（plan §6 `parts:list` 的 `low_stock_ids` 契约）。
 * @returns {{ids: string[], items: Array<{part_id: string, quantity: number, threshold: number,
 *            source: string, shortage: number, category: string}>}}
 */
function findLowStock(parts, settings) {
  const items = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    const { threshold, source } = effectiveMinQuantity(part, settings);
    if (threshold == null) continue;
    const quantity = toInt(part && part.quantity);
    if (quantity >= threshold) continue;
    items.push({
      part_id: part.id,
      quantity,
      threshold,
      source,
      shortage: threshold - quantity,
      category: String((part && part.category) || ""),
    });
  }
  return { ids: items.map((x) => x.part_id), items };
}

/**
 * 启动时的汇总（FR-4.3：若有低库存器件，显示**一次**汇总提示）。
 * 只给数据，措辞交给界面（NFR-6 界面中文）。
 */
function summarizeLowStock(parts, settings) {
  const { ids, items } = findLowStock(parts, settings);
  return {
    count: items.length,
    ids,
    items,
    // 界面可直接用的一句中文摘要；没有低库存时为空串
    message: items.length === 0
      ? ""
      : `有 ${items.length} 种器件低于低库存阈值：`
        + items.slice(0, 5).map((x) => `${x.category || "?"} 库存${x.quantity}/阈值${x.threshold}`).join("、")
        + (items.length > 5 ? ` 等 ${items.length} 种` : ""),
  };
}

module.exports = {
  isBlank,
  effectiveMinQuantity,
  isLowStock,
  findLowStock,
  summarizeLowStock,
};
