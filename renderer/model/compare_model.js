/**
 * compare_model.js — 比对结果页的**规则**（spec FR-2 / AC-2 / FR-7.6）
 *
 * 与 T12 的 import_model 同一做法：规则抽出来、无头可测，页面只做装配。
 * 本文件**不碰 DOM、不 require 任何东西**（Node 走 module.exports，浏览器挂 globalThis）。
 *
 * ⚠️ **本页只读**（spec FR-2.5/2.6）：这里只算"要买什么、买多少"，
 * 绝不产生任何库存变动。**领料是独立入口**（spec FR-7.6）——
 * 因此本文件与 `pages/compare_report.js` 里**不得出现任何领料通道的引用**
 * （`stock:pick_by_bom` / `stockPickByBom`）。这条由测试静态断言盯着，防止哪天有人顺手加个按钮。
 */

(function attach(root) {
  "use strict";

  /** 分组（spec FR-2.3 只定义三类，不得自创第四类） */
  const GROUPS = [
    { key: "enough", label: "够用", hint: "库里已有且库存充足" },
    { key: "shortfall", label: "缺料", hint: "需采购（含库存不足时的缺口）" },
    { key: "uncertain", label: "疑似", hint: "关键信息不全或库中有相似条目，需人工确认" },
  ];

  /** 导出模式（spec §4.2 两种，键名与 compare:export 的 mode 一致） */
  const MODES = [
    { key: "lcsc", label: "立创商城配单", filePrefix: "立创配单" },
    { key: "jlc", label: "嘉立创 SMT 贴片", filePrefix: "嘉立创SMT" },
  ];

  /** spec §4.2：数量列取**缺口**（purchase_quantity），不是需求量 */
  const PURCHASE_FIELD = "shortfall_quantity";

  function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function groupLabel(key) {
    const hit = GROUPS.find((g) => g.key === key);
    return hit ? hit.label : key;
  }

  function modeOf(key) {
    return MODES.find((m) => m.key === key) || MODES[0];
  }

  /** 汇总行：`共 33 条 · 够用 5 · 缺料 28 · 疑似 0` */
  function summaryLine(stats) {
    const s = stats || {};
    return `共 ${toInt(s.total)} 条 · 够用 ${toInt(s.enough)} · 缺料 ${toInt(s.shortfall)} · 疑似 ${toInt(s.uncertain)}`;
  }

  /** 缺料合计 = Σ 缺口（界面上要能一眼看到"总共要买多少个"） */
  function shortfallTotal(items) {
    return (Array.isArray(items) ? items : []).reduce((sum, it) => sum + toInt(it && it[PURCHASE_FIELD]), 0);
  }

  /** 需求合计（用于对照：需求 vs 缺口 vs 现有库存） */
  function requiredTotal(items) {
    return (Array.isArray(items) ? items : []).reduce((sum, it) => sum + toInt(it && it.required_quantity), 0);
  }

  function stockTotal(items) {
    return (Array.isArray(items) ? items : []).reduce((sum, it) => sum + toInt(it && it.stock_quantity), 0);
  }

  /** 采购提示（AC-2 异常路径：缺料为 0 → 明确说"无需采购"，而不是给一张空表） */
  function purchaseMessage(stats) {
    const s = stats || {};
    const count = toInt(s.shortfall);
    if (count === 0) return "库里都够用，无需采购。";
    const parts = [`需采购 ${count} 种`];
    if (toInt(s.no_stock) > 0) parts.push(`其中库中没有 ${toInt(s.no_stock)} 种`);
    if (toInt(s.insufficient) > 0) parts.push(`库存不足 ${toInt(s.insufficient)} 种`);
    if (toInt(s.uncertain) > 0) parts.push(`另有 ${toInt(s.uncertain)} 种疑似需人工确认`);
    return `${parts.join("，")}。`;
  }

  /**
   * 能否导出（spec FR-2.4：导出内容**只含缺料**）。
   * 缺料为 0 时默认不给导出——免得用户拿到一张只有表头的空表还以为工具坏了；
   * 若勾了"包含疑似条目"且确实有疑似，则允许（那是用户明确要的）。
   */
  function canExport(options) {
    const opt = options || {};
    const stats = opt.stats || {};
    const shortfall = toInt(stats.shortfall);
    const uncertain = toInt(stats.uncertain);
    if (shortfall > 0) return { ok: true, reason: "" };
    if (opt.include_uncertain === true && uncertain > 0) {
      return { ok: true, reason: `缺料 0 条，本次导出的是 ${uncertain} 条疑似条目（需人工确认）` };
    }
    if (shortfall === 0 && uncertain > 0) {
      return { ok: false, reason: `缺料 0 条，没有要采购的条目；如仍要导出疑似条目，请勾选「包含疑似条目」（${uncertain} 条）` };
    }
    return { ok: false, reason: "缺料 0 条且没有疑似条目，导出会是空表，已阻止" };
  }

  /** 组装并校验 `compare:export` 的请求 */
  function buildExportRequest(input) {
    const src = input || {};
    if (!src.compare_id) return { ok: false, error: "缺少比对结果编号（compare_id）：请先执行一次比对" };
    const mode = String(src.mode == null || src.mode === "" ? MODES[0].key : src.mode);
    if (!MODES.some((m) => m.key === mode)) {
      return { ok: false, error: `导出模式只能是 ${MODES.map((m) => m.key).join(" / ")}（spec §4.2）` };
    }
    const check = canExport({ stats: src.stats, include_uncertain: src.include_uncertain });
    if (!check.ok) return { ok: false, error: check.reason };
    const request = {
      compare_id: String(src.compare_id),
      mode,
      include_uncertain: src.include_uncertain === true,
    };
    const outPath = String(src.output_path == null ? "" : src.output_path).trim();
    if (outPath !== "") request.output_path = outPath; // 留空则由主进程用含时间戳的默认名（FR-2.8）
    return { ok: true, error: "", request, notice: check.reason };
  }

  /** 默认文件名（FR-2.8：可自定义，默认含时间戳）——与主进程的默认名保持同一形态 */
  function defaultFileName(mode, when) {
    const d = when instanceof Date ? when : new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${modeOf(mode).filePrefix}_${stamp}.xlsx`;
  }

  /** 一行的关键数字（界面与测试共用，避免两处各写一遍格式化） */
  function quantityLine(item) {
    const it = item || {};
    return `需求 ${toInt(it.required_quantity)} · 库存 ${toInt(it.stock_quantity)} · 缺口 ${toInt(it[PURCHASE_FIELD])}`;
  }

  /** 疑似条目为什么进疑似（missing_fields 为空则是"库中有相似条目"） */
  function uncertainReason(item) {
    const missing = (item && item.missing_fields) || [];
    if (missing.length === 0) return "库中有相似条目，但无法确认是同一种料";
    const labels = { voltage: "耐压", dielectric: "材质", tolerance: "容差", value: "值", footprint: "封装" };
    return `BOM 缺 ${missing.map((f) => labels[f] || f).join("、")}，无法精确判定`;
  }

  const api = {
    GROUPS,
    MODES,
    PURCHASE_FIELD,
    groupLabel,
    modeOf,
    summaryLine,
    shortfallTotal,
    requiredTotal,
    stockTotal,
    purchaseMessage,
    canExport,
    buildExportRequest,
    defaultFileName,
    quantityLine,
    uncertainReason,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CompareModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
