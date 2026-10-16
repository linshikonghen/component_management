/**
 * stock_model.js — 领料页的**规则**（spec FR-7 / AC-7）
 *
 * 与 import_model / compare_model / parts_model 同一做法：规则抽出来无头可测，页面只做装配。
 * 本文件**不碰 DOM、不 require 任何东西**（Node 走 module.exports，浏览器挂 globalThis）。
 *
 * 这一页是 **FR-7 的唯一入口**（FR-7.6：领料是独立入口，比对页不得有）：
 * 出入库、按 BOM 领料都从这里走，每笔都写变动记录（FR-7.3 / FR-4.5）。
 */

(function attach(root) {
  "use strict";

  /** 方向：界面填正数，方向决定符号（避免用户在输入框里纠结正负号） */
  const DIRECTIONS = [
    { key: "out", label: "出库（领用）", sign: -1, hint: "从库里拿走去打样/生产" },
    { key: "in", label: "入库（补货）", sign: 1, hint: "买回来/找到的料补进库" },
  ];

  function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    return typeof value === "string" && value.trim() === "";
  }

  function directionOf(key) {
    return DIRECTIONS.find((d) => d.key === key) || DIRECTIONS[0];
  }

  /**
   * 校验手动出/入库（FR-7.1：填写数量与原因）。
   * 原因**必填**：出入库是要对账的，没有原因的记录事后查不出所以然（FR-7.3 要求记录原因）。
   */
  function validateMove(input) {
    const src = input || {};
    if (isBlank(src.part_id)) return { ok: false, error: "请先选择器件" };
    if (isBlank(src.reason)) return { ok: false, error: "请填写原因（出入库记录要能对账）" };
    const amount = Number(src.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: `数量必须是正整数（收到「${src.amount}」）；方向由上面的选项决定` };
    }
    if (!DIRECTIONS.some((d) => d.key === src.direction)) {
      return { ok: false, error: `方向只能是 ${DIRECTIONS.map((d) => d.key).join(" / ")}` };
    }
    return { ok: true, error: "" };
  }

  /** 组装 `stock:move` 请求：界面正数 + 方向 → 带符号 delta */
  function toMoveRequest(input) {
    const src = input || {};
    const check = validateMove(src);
    if (!check.ok) return { ok: false, error: check.error };
    const dir = directionOf(src.direction);
    return {
      ok: true,
      error: "",
      request: {
        part_id: String(src.part_id),
        delta: dir.sign * toInt(src.amount),
        reason: String(src.reason).trim(),
      },
    };
  }

  /** 校验按 BOM 领料（FR-7.4） */
  function validatePick(input) {
    const src = input || {};
    if (isBlank(src.file_path)) return { ok: false, error: "请先选择 BOM 文件" };
    const sets = Number(src.sets);
    if (!Number.isInteger(sets) || sets < 1) return { ok: false, error: `套数必须是 ≥1 的整数（收到「${src.sets}」）` };
    if (isBlank(src.reason)) return { ok: false, error: "请填写领用原因（每条扣减都要留下这个原因）" };
    return { ok: true, error: "" };
  }

  function toPickRequest(input) {
    const src = input || {};
    const check = validatePick(src);
    if (!check.ok) return { ok: false, error: check.error };
    return {
      ok: true,
      error: "",
      request: {
        file_path: String(src.file_path),
        sets: toInt(src.sets),
        reason: String(src.reason).trim(),
        allow_partial: src.allow_partial === true,
      },
    };
  }

  /** 领用结果的可显示摘要（成功与"整单拒绝"两种都要说清楚） */
  function pickSummary(result) {
    const r = result || {};
    const picked = Array.isArray(r.picked) ? r.picked : [];
    const insufficient = Array.isArray(r.insufficient) ? r.insufficient : [];
    const unknown = Array.isArray(r.unknown) ? r.unknown : [];
    const movements = Array.isArray(r.movements) ? r.movements : [];
    const deducted = picked.reduce((sum, x) => sum + toInt(x && x.deducted), 0);

    if (r.ok !== true) {
      const parts = ["本次领料未执行（整单拒绝），库存与变动记录都没有改动。"];
      if (insufficient.length > 0) {
        parts.push(`有 ${insufficient.length} 种库存不足：`
          + insufficient.map((x) => `${x.part_id} 需 ${toInt(x.required)} 有 ${toInt(x.stock)} 缺 ${toInt(x.shortfall)}`).join("；"));
        parts.push("若确认要按现有量领用，请勾选「允许部分领用」后重试。");
      }
      if (unknown.length > 0) parts.push(`另有 ${unknown.length} 种库里没有（见下表）。`);
      return {
        ok: false, message: parts.join(" "), picked_count: 0, deducted_total: 0,
        insufficient_count: insufficient.length, unknown_count: unknown.length, movement_count: 0,
      };
    }
    const parts = [`已领用 ${picked.length} 种，共扣减 ${deducted} 个。`];
    if (insufficient.length > 0) parts.push(`其中 ${insufficient.length} 种按现有量部分领用（缺口见下表）。`);
    if (unknown.length > 0) parts.push(`有 ${unknown.length} 种库里没有，已列出、未扣减。`);
    parts.push(`写了 ${movements.length} 条出库记录，批次号 ${r.pick_id || "—"}。`);
    return {
      ok: true, message: parts.join(" "), picked_count: picked.length, deducted_total: deducted,
      insufficient_count: insufficient.length, unknown_count: unknown.length, movement_count: movements.length,
    };
  }

  /** 缺口逐条说法（FR-7.5：逐条列出） */
  function insufficientLines(result) {
    const list = (result && result.insufficient) || [];
    return list.map((x) => ({
      part_id: x.part_id,
      required: toInt(x.required),
      stock: toInt(x.stock),
      shortfall: toInt(x.shortfall),
      text: `需 ${toInt(x.required)} · 现有 ${toInt(x.stock)} · 缺 ${toInt(x.shortfall)}`,
    }));
  }

  /** 库中没有的条目逐条说法（AC-7 异常路径：不静默跳过） */
  function unknownLines(result) {
    const list = (result && result.unknown) || [];
    return list.map((x) => ({
      row_no: x.row_no,
      text: `第 ${x.row_no} 行：${[x.part_number, x.value, x.footprint].filter((v) => v).join(" / ")}（需 ${toInt(x.required)}）`,
    }));
  }

  /** 一条器件在列表里的说法（供选择器显示） */
  function partOptionText(part, lowStockIds) {
    const p = part || {};
    const low = Array.isArray(lowStockIds) && lowStockIds.includes(p.id) ? "⚠ " : "";
    return `${low}${p.value || "?"} / ${p.footprint || "?"}（库存 ${toInt(p.quantity)}）${p.part_number ? " · " + p.part_number : ""}`;
  }

  const api = {
    DIRECTIONS,
    directionOf,
    validateMove,
    toMoveRequest,
    validatePick,
    toPickRequest,
    pickSummary,
    insufficientLines,
    unknownLines,
    partOptionText,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StockModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
