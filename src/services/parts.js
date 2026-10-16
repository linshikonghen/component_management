"use strict";
/**
 * parts.js — 器件的单条增 / 改 / 删 / 查（手动录入路径，spec FR-3、FR-5、AC-3）
 *
 * 三个通道的真实载体（plan §6）：`parts:save` / `parts:delete` / `parts:list`。
 *
 * 三条不能破的规则：
 *  ① **同规格不重复建条**（FR-3.2 + FR-1.9）：手动录一条"库里已有"的同规格料时，
 *     **数量累加**而不是新建——它和 BOM 导入写的是**同一张库表、同一套关键信息校验**。
 *     判定键复用 `compare.dedupeKey`（全工程唯一实现），不由本模块另写。
 *  ② **编辑不许制造重复**：改完的判定键若撞上库里**另一条**器件，直接拒绝——
 *     否则用户一次手滑就把去重破坏了，之后比对与合并全乱。
 *  ③ **任何数量变化都留痕**（FR-4.5）：新增记 `init`、合并记 `in`、编辑改量记 `adjust`。
 *
 * 与 inventory.js 的分工（避免两份"造器件"的代码）：
 *   inventory：**BOM 行**（BomItem）→ 器件，字段就是 BOM 那十列
 *   parts   ：**录入表单**（Part 形状）→ 器件，还带库位/数据手册/替代料/极性/批次等 BOM 没有的字段
 * 两者输入形状不同，故各自映射；字段白名单都照 plan §3.1。
 *
 * 纯函数：不碰文件系统、不调用 store 的写函数；落盘由 IPC 层交给 store（唯一写入口）。
 */

const { dedupeKey } = require("./compare");
const { nowIso } = require("./store");
const { inferCategory } = require("./inventory");
const { findLowStock } = require("./low_stock");
const ids = require("./ids");

/** plan §3.1 的器件字段（白名单：表单里多余的东西不会混进库） */
const PART_FIELDS = [
  "category", "value", "footprint", "voltage", "dielectric", "tolerance",
  "power", "current", "polarity", "mount_type",
  "part_number", "manufacturer", "supplier_part", "supplier",
  "quantity", "min_quantity", "location", "datasheet", "substitute", "batch", "note",
];

/** 必填关键信息：少了它这条器件根本没法用于比对/去重 */
const REQUIRED_FIELDS = [
  { field: "value", label: "值" },
  { field: "footprint", label: "封装" },
];

/** 可在列表里排序的列（FR-5.1「按任意关键信息列排序」） */
const SORTABLE_FIELDS = [
  "value", "footprint", "voltage", "dielectric", "tolerance", "category",
  "part_number", "manufacturer", "supplier_part", "quantity", "min_quantity", "location", "updated_at",
];

function str(value) {
  return value == null ? "" : String(value).trim();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 校验录入表单（界面可即时调用，服务端也调用一次——**不依赖界面限制**）。
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
function validatePartInput(input) {
  const src = input || {};
  const errors = [];
  const warnings = [];
  const missing = REQUIRED_FIELDS.filter((f) => str(src[f.field]) === "");
  if (missing.length > 0) {
    errors.push(`缺少必填关键信息：${missing.map((f) => f.label).join("、")}`);
  }
  if (!Number.isInteger(Number(src.quantity)) || Number(src.quantity) < 0) {
    errors.push(`数量必须是非负整数（收到「${src.quantity}」）`);
  }
  if (!isBlank(src.min_quantity)) {
    const n = Number(src.min_quantity);
    if (!Number.isFinite(n) || n < 0) errors.push(`低库存阈值必须是非负数字或留空（收到「${src.min_quantity}」）`);
  }
  // 提示（不阻断）：缺这些字段的条目在比对时会落进"疑似"，需要人工裁决
  const soft = [["voltage", "耐压"], ["dielectric", "材质"], ["tolerance", "容差"]]
    .filter(([f]) => str(src[f]) === "")
    .map(([, label]) => label);
  if (soft.length > 0) warnings.push(`未填写 ${soft.join("、")}：该条目在比对时会归入「疑似」，需人工确认`);
  return { ok: errors.length === 0, errors, warnings };
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/** 把表单字段按白名单搬进器件（缺的给默认值），不夹带其它键 */
function normalizeFields(input, base) {
  const out = base ? clone(base) : {};
  for (const field of PART_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) out[field] = input[field];
  }
  out.value = str(out.value);
  out.footprint = str(out.footprint);
  out.voltage = str(out.voltage);
  out.dielectric = str(out.dielectric);
  out.tolerance = str(out.tolerance);
  out.power = str(out.power);
  out.current = str(out.current);
  out.polarity = str(out.polarity);
  out.mount_type = str(out.mount_type);
  out.part_number = str(out.part_number);
  out.manufacturer = str(out.manufacturer);
  out.supplier_part = str(out.supplier_part);
  out.supplier = str(out.supplier);
  out.location = str(out.location);
  out.datasheet = str(out.datasheet);
  out.substitute = str(out.substitute);
  out.batch = str(out.batch);
  out.note = str(out.note);
  out.quantity = toInt(out.quantity);
  out.min_quantity = isBlank(out.min_quantity) ? null : toInt(out.min_quantity);
  out.category = str(out.category) !== "" ? str(out.category) : inferCategoryFrom(out);
  return out;
}

/** 分类留空时由位号推——手动录入没有位号，故退到"值+封装"的启发式？不猜：落 _default */
function inferCategoryFrom(part) {
  // 手动录入没有位号可依据（分类才需要前缀）；这里不猜，交给用户选或落 _default。
  // 保留 inferCategory 的默认分支语义，避免两处默认值不一致。
  return inferCategory([]);
}

/** 维护厂商料号列表（AML，spec §5.2）：一条器件 ↔ 多个 MPN */
function syncMpnList(part) {
  const candidate = {
    part_number: part.part_number, manufacturer: part.manufacturer,
    supplier_part: part.supplier_part, supplier: part.supplier,
  };
  if (!Array.isArray(part.mpn_list)) part.mpn_list = [];
  const meaningful = candidate.part_number !== "" || candidate.supplier_part !== "";
  if (!meaningful) return part;
  const dup = part.mpn_list.some((m) => str(m.part_number) === candidate.part_number
    && str(m.supplier_part) === candidate.supplier_part);
  if (!dup) part.mpn_list.push(candidate);
  return part;
}

function nextPartId(library, movements) {
  // 与 inventory 里那份**逐字相同**的实现已合并到 ./ids（AGENTS.md 反重复：不许留两份）
  return ids.nextPartId(library, movements);
}

/**
 * 保存一条器件（plan §6 `parts:save`）。
 * @param {object} input 表单数据；**有 id 视为编辑**，无 id 视为新增
 * @param {Array<object>} parts 当前库存（不被就地修改）
 * @param {{now?: Date}} [options]
 * @returns {{parts: object[], part: object, created: boolean, merged: boolean,
 *            movement: object|null, warnings: string[]}}
 * @throws 校验失败 / 编辑撞键 时抛错（IPC 层转成 {ok:false,error}）
 */
function savePart(input, parts, options = {}) {
  const src = input || {};
  const library = (Array.isArray(parts) ? parts : []).map(clone);
  const check = validatePartInput(src);
  if (!check.ok) throw new Error(check.errors.join("；"));

  const now = options.now;
  const byId = src.id ? library.findIndex((p) => str(p.id) === str(src.id)) : -1;
  const fields = normalizeFields(src, byId >= 0 ? library[byId] : null);
  const key = dedupeKey(fields);

  // 编辑：判定键不能撞上"另一条"器件
  if (byId >= 0) {
    const clash = library.find((p, i) => i !== byId && dedupeKey(p) === key);
    if (clash) {
      throw new Error(
        `不能这样改：改后的规格与库里已有的「${clash.value} / ${clash.footprint}」（${clash.id}）相同，`
        + "会产生重复器件。请改为编辑那一条，或调整值/封装/耐压/材质/容差。"
      );
    }
    const before = library[byId];
    const beforeQty = toInt(before.quantity);
    const after = Object.assign(normalizeFields(src, before), {
      id: before.id,
      created_at: before.created_at,
      updated_at: nowIso(now),
    });
    // 编辑时数量按表单给的**绝对值**（不是累加），变动部分记为 adjust 留痕
    syncMpnList(after);
    library[byId] = after;
    const delta = after.quantity - beforeQty;
    return {
      parts: library,
      part: after,
      created: false,
      merged: false,
      movement: delta === 0 ? null : {
        part_id: after.id, kind: "adjust", delta, before: beforeQty, after: after.quantity,
        reason: "手动编辑器件", ref: "",
      },
      warnings: check.warnings,
    };
  }

  // 新增：同规格已存在 → 数量累加，不新建（FR-3.2 / FR-1.9）
  const existingIdx = library.findIndex((p) => dedupeKey(p) === key);
  if (existingIdx >= 0) {
    const existing = library[existingIdx];
    const beforeQty = toInt(existing.quantity);
    const addQty = toInt(fields.quantity);
    existing.quantity = beforeQty + addQty;
    existing.updated_at = nowIso(now);
    // 只补空字段，不覆盖用户已填的（与 inventory.mergePartInfo 同一取向）
    for (const f of PART_FIELDS) {
      if (f === "quantity") continue;
      if (str(fields[f]) !== "" && (existing[f] === null || existing[f] === undefined || str(existing[f]) === "")) {
        existing[f] = fields[f];
      }
    }
    syncMpnList(existing);
    return {
      parts: library,
      part: existing,
      created: false,
      merged: true,
      movement: addQty === 0 ? null : {
        part_id: existing.id, kind: "in", delta: addQty, before: beforeQty, after: existing.quantity,
        reason: "手动录入（同规格累加）", ref: "",
      },
      warnings: check.warnings,
    };
  }

  const created = Object.assign({}, fields, {
    // 变动记录里出现过的 part_id 也要算进"用过的号"——删掉的器件 id 绝不复用（审计发现）
    id: nextPartId(library, options.movements),
    mpn_list: [],
    created_at: nowIso(now),
    updated_at: nowIso(now),
  });
  syncMpnList(created);
  library.push(created);
  return {
    parts: library,
    part: created,
    created: true,
    merged: false,
    // 新增有数量时记 init（plan §3.2 枚举内），保证"任何数量变化都留痕"
    movement: created.quantity > 0 ? {
      part_id: created.id, kind: "init", delta: created.quantity, before: 0, after: created.quantity,
      reason: "手动录入", ref: "",
    } : null,
    warnings: check.warnings,
  };
}

/**
 * 删除一条器件（plan §6 `parts:delete`）。
 * AGENTS.md 把"删除任何器件记录"列为需人工确认的操作 → 必须显式 confirm。
 * **变动记录不清除**：它是历史，删掉器件后仍应按 part_id 查得到（可追溯）。
 *
 * v1.5 实现期补记（审计发现）：若被删器件还有库存，**补一条 adjust 变动记录**——
 * 否则"总库存凭空少了 13 个"这件事在账面上没有任何解释（FR-4.5 要求数量变化都有留痕）。
 * 记录写在删除**之前**落盘（由调用方 persist），失败则整体回滚。
 * @returns {{parts: object[], removed: object, movement?: object}}
 */
function deletePart(partId, parts, options = {}) {
  if (options.confirm !== true) {
    throw new Error("删除器件属需人工确认的操作：请显式传 { confirm: true }");
  }
  const library = (Array.isArray(parts) ? parts : []).map(clone);
  const idx = library.findIndex((p) => str(p.id) === str(partId));
  if (idx < 0) throw new Error(`器件不存在：${partId}`);
  const [removed] = library.splice(idx, 1);
  const quantity = toInt(removed.quantity);
  const result = { parts: library, removed };
  if (quantity !== 0) {
    // 器件没了，但"这批库存去哪了"要能查：kind=adjust（盘点修正）+ 说清原因
    result.movement = {
      part_id: removed.id,
      kind: "adjust",
      delta: -quantity,
      before: quantity,
      after: 0,
      reason: str(options.reason) || `删除器件（${str(removed.value) || removed.id}）时移除剩余库存`,
    };
  }
  return result;
}

/**
 * 列表查询（plan §6 `parts:list`）。
 * @param {Array<object>} parts
 * @param {{q?: string, category?: string, footprint?: string, low_stock_only?: boolean,
 *          sort_by?: string, sort_dir?: "asc"|"desc"}} [query]
 * @param {object} settings 用于低库存判定
 * @returns {{parts: object[], low_stock_ids: string[], total: number}}
 */
function listParts(parts, query = {}, settings = {}) {
  const all = Array.isArray(parts) ? parts : [];
  const { ids: lowIds } = findLowStock(all, settings);
  const lowSet = new Set(lowIds);
  const q = str(query.q).toLowerCase();
  const category = str(query.category);
  const footprint = str(query.footprint);

  let out = all.filter((part) => {
    if (category !== "" && str(part.category) !== category) return false;
    if (footprint !== "" && str(part.footprint).toLowerCase() !== footprint.toLowerCase()) return false;
    if (query.low_stock_only === true && !lowSet.has(part.id)) return false;
    if (q === "") return true;
    // FR-5.2：跨关键信息字段搜索（值/封装/耐压/材质/容差/型号/厂商/编号/库位/备注）
    const haystack = [
      part.value, part.footprint, part.voltage, part.dielectric, part.tolerance,
      part.part_number, part.manufacturer, part.supplier_part, part.supplier,
      part.location, part.note, part.category, part.batch,
    ].map((v) => str(v).toLowerCase()).join("\u0000");
    return haystack.includes(q);
  });

  const sortBy = str(query.sort_by);
  if (sortBy !== "") {
    if (!SORTABLE_FIELDS.includes(sortBy)) {
      throw new Error(`不支持按「${sortBy}」排序（可排序列：${SORTABLE_FIELDS.join("、")}）`);
    }
    const dir = str(query.sort_dir) === "desc" ? -1 : 1;
    out = out.slice().sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      if (typeof av === "number" || typeof bv === "number") {
        return (Number(av || 0) - Number(bv || 0)) * dir;
      }
      return String(str(av)).localeCompare(String(str(bv)), "zh") * dir;
    });
  }
  return { parts: out, low_stock_ids: lowIds, total: out.length };
}

module.exports = {
  PART_FIELDS,
  REQUIRED_FIELDS,
  SORTABLE_FIELDS,
  validatePartInput,
  savePart,
  deletePart,
  listParts,
};
