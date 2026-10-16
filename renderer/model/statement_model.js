"use strict";
/**
 * statement_model.js — 「按对账单入库」核对表的**规则**（纯逻辑、无 DOM、无 require）
 *
 * 三桶来自 `statement:parse`：matched（严格命中→默认 merge）/ suspected（**默认 pending，不替人决定**）/ missing（→new）。
 *
 * **人工可改**（用户 2026-10-16 要求："按账单入库也需要人工修改功能"）：
 *   · 可改：**本次入库量**（= 订购数量，实际到货可能不同）、值、容差、耐压、封装、商品型号
 *   · 只读：商品类型（分类）、阈值键、订购数量（对账单事实）、匹配桶、处置
 *     —— 分类保持来自对账单的「商品类型」；阈值键由它推出（映射表在服务层，避免第二份实现）
 *   · 改动要**留痕**：`edited=true`，并由 `buildOverrides()` 随决定一起提交，
 *     否则界面改了、后端还按原值入库（那就是"假编辑"）
 *
 * 关键约束（FR-8.7 / AC-10:3）：**只要还有一条疑似没裁决，就不得提交**。
 */

/** 表格列（顺序即显示顺序） */
const COLUMNS = [
  { key: "row_no", label: "行", editable: false },
  { key: "category", label: "商品类型（分类）", editable: false },
  { key: "threshold_key", label: "阈值键", editable: false },
  { key: "value", label: "值", editable: true },
  { key: "tolerance", label: "容差", editable: true },
  { key: "voltage", label: "耐压", editable: true },
  { key: "manufacturer_part", label: "商品型号", editable: true },
  { key: "footprint", label: "封装", editable: true },
  { key: "ordered_quantity", label: "订购数量", editable: false },
  { key: "intake_quantity", label: "本次入库量 ✎", editable: true, numeric: true },
  { key: "bucket", label: "匹配", editable: false },
  { key: "decision", label: "处置", editable: false },
];

const BUCKET_LABEL = { matched: "命中", suspected: "疑似", missing: "新增" };
const DECISION_LABEL = { merge: "合并进库中器件", new: "新建器件", skip: "跳过", pending: "待裁决" };

/** 可改字段（顺序即提交 overrides 的顺序） */
const EDITABLE_FIELDS = ["value", "tolerance", "voltage", "footprint", "manufacturer_part", "intake_quantity"];

/** 把 `statement:parse` 的返回整理成表格行（含可改字段的初值 = 对账单原值） */
function buildRows(parsed) {
  const p = parsed || {};
  const items = Array.isArray(p.items) ? p.items : [];
  const matchedBy = new Map((p.matched || []).map((m) => [m.row_no, m]));
  const suspectBy = new Map((p.suspected || []).map((s) => [s.row_no, s]));
  const missing = new Set(p.missing || []);

  return items.map((it) => {
    const row = Object.assign({}, it);
    row.ordered_quantity = Number(it.quantity) > 0 ? Number(it.quantity) : 0;
    row.intake_quantity = row.ordered_quantity; // 默认 = 订购数量（可改）
    row.original = {
      value: it.value == null ? "" : String(it.value),
      tolerance: it.tolerance == null ? "" : String(it.tolerance),
      voltage: it.voltage == null ? "" : String(it.voltage),
      footprint: it.footprint == null ? "" : String(it.footprint),
      manufacturer_part: it.manufacturer_part == null ? "" : String(it.manufacturer_part),
      intake_quantity: row.ordered_quantity,
    };
    row.edited = false;
    if (matchedBy.has(it.row_no)) {
      row.bucket = "matched";
      row.decision = "merge";
      row.part_id = matchedBy.get(it.row_no).part_id;
      row.candidates = [];
    } else if (suspectBy.has(it.row_no)) {
      row.bucket = "suspected";
      row.decision = "pending"; // **默认不替人决定**
      row.part_id = "";
      row.candidates = suspectBy.get(it.row_no).candidates || [];
    } else {
      row.bucket = "missing";
      row.decision = "new";
      row.candidates = [];
    }
    return row;
  });
}

/** 字段级校验：数量必须是非负整数；值不能为空；其余文本去掉首尾空白 */
function validateField(field, raw) {
  if (field === "intake_quantity") {
    const text = String(raw == null ? "" : raw).trim();
    if (text === "") return { ok: false, error: "本次入库量不能为空（不能入库的数量请用「跳过」）" };
    const n = Number(text);
    if (!Number.isInteger(n)) return { ok: false, error: `本次入库量必须是整数（收到「${text}」）` };
    if (n < 0) return { ok: false, error: `本次入库量不能为负（收到「${text}」）` };
    return { ok: true, value: n };
  }
  if (!EDITABLE_FIELDS.includes(field)) return { ok: false, error: `「${field}」不是可改字段` };
  const text = String(raw == null ? "" : raw).trim();
  if (field === "value" && text === "") return { ok: false, error: "值不能改空（要跳过这行请用「跳过」）" };
  return { ok: true, value: text };
}

/** 改一行的一个字段（返回新数组，不就地改）；改动后标记 edited 并重算是否与对账单不同 */
function setFieldEdit(rows, rowNo, field, raw) {
  const v = validateField(field, raw);
  if (!v.ok) return { ok: false, error: v.error, rows };
  const next = [];
  let hit = false;
  for (const row of (rows || [])) {
    if (row.row_no !== rowNo) { next.push(row); continue; }
    hit = true;
    const updated = Object.assign({}, row, { [field]: v.value });
    updated.edited = EDITABLE_FIELDS.some((f) => String(updated[f]) !== String(updated.original[f]));
    next.push(updated);
  }
  if (!hit) return { ok: false, error: `表里没有第 ${rowNo} 行`, rows };
  return { ok: true, rows: next };
}

/** 改一行的处置（merge / new / skip；返回新数组，不就地改） */
function setDecision(rows, rowNo, action, partId) {
  const allowed = ["merge", "new", "skip"];
  if (!allowed.includes(action)) {
    return { ok: false, error: `处置「${action}」不认识（只能是 merge / new / skip）`, rows };
  }
  const next = [];
  let hit = false;
  for (const row of (rows || [])) {
    if (row.row_no !== rowNo) { next.push(row); continue; }
    hit = true;
    if (action === "merge" && !partId) {
      return { ok: false, error: `第 ${rowNo} 行选「合并」但没有指定器件`, rows };
    }
    next.push(Object.assign({}, row, { decision: action, part_id: action === "merge" ? String(partId) : "" }));
  }
  if (!hit) return { ok: false, error: `表里没有第 ${rowNo} 行`, rows };
  return { ok: true, rows: next };
}

/** 还有几条疑似没裁决（>0 就不许提交） */
function pendingRows(rows) {
  return (rows || []).filter((r) => r.decision === "pending");
}

/** 能不能提交（人工闸门） */
function canCommit(rows) {
  return pendingRows(rows).length === 0;
}

/** 某一行的改动（只报**与对账单不同**的字段；数量为 0 也算改动） */
function buildOverrides(row) {
  const out = {};
  for (const f of EDITABLE_FIELDS) {
    const now = f === "intake_quantity" ? Number(row[f]) : String(row[f] == null ? "" : row[f]);
    const before = row.original ? row.original[f] : undefined;
    if (String(now) !== String(before)) out[f] = now;
  }
  return out;
}

/**
 * 提交给 `statement:commit` 的决定：`{ row_no, action, part_id?, overrides? }`
 * —— overrides 是"人工改过的字段"，没有改动就不带（后端按对账单原值处理）。
 */
function buildDecisions(rows) {
  return (rows || [])
    .filter((r) => r.decision && r.decision !== "pending" && r.decision !== "skip")
    .map((r) => {
      const d = r.decision === "merge"
        ? { row_no: r.row_no, action: "merge", part_id: r.part_id }
        : { row_no: r.row_no, action: "new" };
      const overrides = buildOverrides(r);
      if (Object.keys(overrides).length > 0) d.overrides = overrides;
      return d;
    });
}

/** 门禁文案（给按钮上方那行用） */
function gateText(rows) {
  const list = rows || [];
  const pending = pendingRows(list);
  const merge = list.filter((r) => r.decision === "merge").length;
  const created = list.filter((r) => r.decision === "new").length;
  const skip = list.filter((r) => r.decision === "skip").length;
  const edited = list.filter((r) => r.edited).length;
  if (pending.length > 0) {
    // 不用 markdown 星号：这段文字会**原样显示在界面上**（当字面量出现就是缺陷，之前踩过）
    return `还有 ${pending.length} 条疑似需要你裁决（第 ${pending.map((r) => r.row_no + 1).join(" / ")} 行）——裁决完才能入库`;
  }
  const qty = list.filter((r) => r.decision !== "skip")
    .reduce((sum, r) => sum + (Number(r.intake_quantity) > 0 ? Number(r.intake_quantity) : 0), 0);
  return `待入库：合并 ${merge} 条 · 新建 ${created} 条 · 跳过 ${skip} 条 · 合计 ${qty} 件`
    + (edited > 0 ? `（其中 ${edited} 条已人工修改，会留痕）` : "");
}

/** 入库完成后的汇总（来自 statement:commit 的 summary） */
function summaryText(summary) {
  const s = summary || {};
  return `入库完成：合并 ${s.merged_count || 0} 条 · 新建 ${s.created_count || 0} 条 · 共入库 ${s.quantity_in || 0} 件`
    + (s.edited_count ? `（其中 ${s.edited_count} 条人工改过）` : "")
    + (s.order_ref ? `（对账单 ${s.order_ref}）` : "");
}

const API = {
  COLUMNS, BUCKET_LABEL, DECISION_LABEL, EDITABLE_FIELDS,
  buildRows, validateField, setFieldEdit, setDecision, pendingRows, canCommit, buildOverrides, buildDecisions,
  gateText, summaryText,
};

// 双挂载（项目约定）：无头测试走 module.exports，渲染进程走 globalThis。
// **本文件不 require 任何东西**——渲染进程"不得 require"的静态检查才不被削弱。
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.StatementModel = API;
