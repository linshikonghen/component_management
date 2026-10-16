/**
 * settings_model.js — 设置页的**规则**（spec FR-4 / AC-4 / AC-9）
 *
 * 与其它 model 同一做法：规则抽出来无头可测，页面只做装配。
 * 本文件**不碰 DOM、不 require 任何东西**（Node 走 module.exports，浏览器挂 globalThis）。
 *
 * 分类的**中文标签由页面注入**（`PartsModel.CATEGORY_OPTIONS`）——
 * 不在这里再抄一份，否则标签就会有两处真相（跨边界一致性已由 test_parts_model 钉住）。
 *
 * ⚠️ **生效逻辑不在本文件**：某条到底算不算低库存，由服务端 `low_stock.js` 决定
 * （个体阈值覆盖分类默认、留空=继承）。这里只管"用户改了什么、能不能提交、要不要确认"。
 */

(function attach(root) {
  "use strict";

  function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    return typeof value === "string" && value.trim() === "";
  }

  /**
   * 分类默认阈值的校验（plan §6 v1.5：每个值必须是 number，否则**拒绝整个写入**）。
   * - 非负整数合法；**0 表示"不提示"**（`quantity < min` 时 min=0 恒不成立）
   * - 空值不合法：分类默认值代表"这类料至少备多少个"，没有"留空"的说法
   *   （"留空=继承"是**个体**阈值的语义，见 FR-4.8）
   */
  function validateThreshold(raw) {
    if (isBlank(raw)) return { ok: false, value: 0, error: "分类默认阈值不能为空（只能是 0 或正整数；0 表示这类不提示）" };
    // **类型也要拦**（审计 R3 发现③）：`Number(true)` 是 1、`Number([])` 是 0、`Number(["7"])` 是 7——
    // 这些"看着能变成数字"的东西一旦放进来，服务端就会收到一个**类型不对但值合法**的写入。
    // 界面传的是字符串所以在界面上不可达，但这里是**接口**，接口不该靠"调用方恰好传对"。
    if (typeof raw !== "string" && typeof raw !== "number") {
      return { ok: false, value: 0, error: `阈值类型不对（只接受数字或数字字符串，收到 ${typeof raw}）` };
    }
    const n = Number(raw);
    if (!Number.isInteger(n)) return { ok: false, value: 0, error: `阈值必须是整数（收到「${raw}」）` };
    if (n < 0) return { ok: false, value: 0, error: `阈值不能为负（收到「${raw}」）` };
    return { ok: true, value: n, error: "" };
  }

  /** 设置页的 14 行：{key, label, value}（label 由调用方注入，避免第二份真相） */
  function thresholdRows(settings, categories) {
    const map = (settings && settings.default_min_quantity) || {};
    const cats = Array.isArray(categories) ? categories : [];
    return cats.map((cat) => ({
      key: cat.key,
      label: cat.label,
      value: map[cat.key] === undefined || map[cat.key] === null ? "" : map[cat.key],
    }));
  }

  /**
   * 只挑出**改动过**的项提交（合并写入语义下，少写就少出错；
   * 也避免把界面上的空值顺带覆盖掉服务端已有的合法值）。
   */
  function changedThresholds(formValues, settings, categories) {
    const current = (settings && settings.default_min_quantity) || {};
    const rows = thresholdRows(settings, categories);
    const changes = {};
    const errors = [];
    for (const row of rows) {
      const raw = formValues ? formValues[row.key] : undefined;
      if (raw === undefined) continue; // 界面上没有这一格
      const check = validateThreshold(raw);
      if (!check.ok) {
        errors.push(`${row.label}：${check.error}`);
        continue;
      }
      if (check.value !== toInt(current[row.key], -1)) changes[row.key] = check.value;
    }
    return { ok: errors.length === 0, changes, errors };
  }

  /** 组装 `settings:set` 载荷；无改动则返回 null（调用方据此禁用保存按钮） */
  function thresholdPayload(changes) {
    const keys = Object.keys(changes || {});
    if (keys.length === 0) return null;
    return { settings: { default_min_quantity: Object.assign({}, changes) } };
  }

  /* --------------------------------------------------------- 数据目录 */

  const DATA_DIR_WARNING =
    "数据文件不会跟着搬过去：改完之后界面会是空库（原目录里的文件还在，没丢）。"
    + "要搬家请先用「备份」导出，再到新目录用「恢复」导入。";

  function validateDataDir(raw, current) {
    const value = String(raw == null ? "" : raw).trim();
    if (value === "") return { ok: false, value: "", error: "数据目录不能为空（留空表示用默认 data/）" };
    if (/[<>"|?*]/.test(value)) return { ok: false, value, error: `路径里不能有 < > " | ? * 这些字符（收到「${value}」）` };
    if (value === String(current == null ? "" : current).trim()) {
      return { ok: false, value, error: "新目录和当前目录一样，不需要更改" };
    }
    return { ok: true, value, error: "" };
  }

  /**
   * 更改数据目录**属需人工确认的操作**（AGENTS.md）。
   * 未确认 → 只返回"需要确认"与警告，不产生任何载荷；确认后才给 `confirm_data_dir: true`。
   */
  function dataDirPayload(raw, current, confirmed) {
    const check = validateDataDir(raw, current);
    if (!check.ok) return { ok: false, needs_confirm: false, error: check.error, payload: null, warning: "" };
    if (confirmed !== true) {
      return { ok: false, needs_confirm: true, error: "更改数据目录需要确认", payload: null, warning: DATA_DIR_WARNING };
    }
    return {
      ok: true,
      needs_confirm: false,
      error: "",
      payload: { settings: { data_dir: check.value }, confirm_data_dir: true },
      warning: DATA_DIR_WARNING,
    };
  }

  /* --------------------------------------------------------- 低库存 */

  /** FR-4.3：启动时若有低库存器件，**提示一次**汇总（不要每次切页都弹） */
  function startupNotice(lowCount, alreadyShown) {
    const n = toInt(lowCount);
    if (n <= 0) return "";
    if (alreadyShown === true) return "";
    return `有 ${n} 种器件低于低库存阈值，建议补货（可在「库存」页看到标红条目，「设置」页可调阈值）。`;
  }

  /** FR-4.2：低库存清单的每一行 */
  function lowStockLines(parts, lowIds) {
    const ids = new Set(Array.isArray(lowIds) ? lowIds : []);
    return (Array.isArray(parts) ? parts : [])
      // **元素也要防空**（审计 R3 发现⑤）：`parts` 里混进一个 `null`（parts.json 被改坏、
      // 或上游漏过滤）就会让 `p.id` 抛 TypeError；设置页渲染没有 try/catch → **整屏白**。
      // 同目录其他模型都有 `|| {}` 兜底，只这里漏了——一处漏就是"整页打不开"。
      .filter((p) => p && ids.has(p.id))
      .map((p) => ({
        id: p.id,
        value: p.value,
        footprint: p.footprint,
        quantity: toInt(p.quantity),
        min_quantity: p.min_quantity === "" || p.min_quantity === null || p.min_quantity === undefined ? null : toInt(p.min_quantity),
        category: p.category || "_default",
        text: `${p.value} / ${p.footprint}：现有 ${toInt(p.quantity)}`
          + (p.min_quantity === "" || p.min_quantity === null || p.min_quantity === undefined
            ? "（按分类默认阈值判定）"
            : `（个体阈值 ${toInt(p.min_quantity)}）`),
      }));
  }

  /** 阈值改动摘要（保存后告诉用户到底改了什么） */
  function changeSummary(changes, categories) {
    const map = {};
    for (const cat of Array.isArray(categories) ? categories : []) map[cat.key] = cat.label;
    const keys = Object.keys(changes || {});
    if (keys.length === 0) return "没有改动。";
    return keys.map((k) => `${map[k] || k} → ${changes[k]}`).join("；");
  }

  const api = {
    DATA_DIR_WARNING,
    validateThreshold,
    thresholdRows,
    changedThresholds,
    thresholdPayload,
    validateDataDir,
    dataDirPayload,
    startupNotice,
    lowStockLines,
    changeSummary,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SettingsModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
