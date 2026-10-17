/**
 * import_model.js — 人工核对表的**规则**（spec FR-1.3~1.8 / AC-1）
 *
 * 为什么把规则单独放一个文件：核对界面是本工具最要紧的一屏，它的规则又多又细
 * （本次入库量可改、BOM 原值只读、数量与位号不符必须人工裁决、汇总三数之和要等于总数……）。
 * 塞进 DOM 代码里就只能靠人点着看；抽出来就能**无头逐条断言**。
 *
 * 本文件**不碰 DOM、不 require 任何东西**：
 * Node 里走 `module.exports`，浏览器里挂到 `globalThis.ImportModel`——
 * 于是同一份代码既能被页面用，也能被 `tests/test_import_model.js` 直接测。
 * （刻意不写 `require(...)`：渲染进程的静态检查要求"渲染进程不得 require"，
 *   而这个双挂载写法根本不需要 require。）
 *
 * 术语（spec §2）：BOM 原数量 = 单套数量；应入库量 = 原数量 × 套数；**本次入库量** = 人确认后实际入的。
 */

(function attach(root) {
  "use strict";

  /** 核对阶段**可改**的字段（spec FR-1.6） */
  const EDITABLE_FIELDS = [
    "intake_quantity", "value", "footprint", "voltage", "dielectric", "tolerance",
    "manufacturer_part", "manufacturer", "supplier_part", "supplier", "note",
    // v1.5 实现期补记：spec FR-1.6 明列「库位」「低库存阈值」也可改。
    // 此前契约没有这两个字段，界面就**不提供**输入（不给会丢数据的框）；现在契约补齐了，核对表加回来。
    "location", "min_quantity",
  ];

  /**
   * 核对阶段**不可改**的字段（spec FR-1.6 + v1.4 表）：
   * BOM 原数量与位号是"BOM 事实"，只作参照展示；改了就等于篡改原始清单。
   */
  const READONLY_FIELDS = [
    "row_no", "designators", "designator_count", "quantity_per_board", "total_quantity", "comment",
  ];

  function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    return typeof value === "string" && value.trim() === "";
  }

  /** 算式串：`8 × 3 = 24`（spec FR-1.4 要求在核对界面显示这个算式） */
  function formulaText(item, sets) {
    const per = toInt(item && item.quantity_per_board);
    const total = per * toInt(sets, 1);
    return `${per} × ${toInt(sets, 1)} = ${total}`;
  }

  /**
   * 校验"本次入库量"（spec AC-1 异常路径）。
   * - 合法：非负整数（含 0）
   * - `0` → `zero: true`，界面据此"视同跳过并提示"
   * - 负数/小数/非数字/**空值** → 拒绝。空值尤其不能当 0：那会把"字段没填"静默变成"跳过"
   */
  function validateIntake(raw) {
    if (isBlank(raw)) return { ok: false, zero: false, value: 0, error: "本次入库量不能为空（必须是非负整数）" };
    const n = Number(raw);
    if (!Number.isInteger(n)) return { ok: false, zero: false, value: 0, error: `本次入库量必须是非负整数（收到「${raw}」）` };
    if (n < 0) return { ok: false, zero: false, value: 0, error: `本次入库量不能为负（必须是非负整数：收到「${raw}」）` };
    return { ok: true, zero: n === 0, value: n, error: "" };
  }

  /**
   * 该行是否"数量与位号个数不符"（spec FR-1.5：必须醒目警示并要求人工裁决）。
   * 这两个字段都在 BomItem 契约里，**不需要新增字段**就能判定。
   */
  function hasQuantityMismatch(item) {
    const per = toInt(item && item.quantity_per_board);
    const count = toInt(item && item.designator_count);
    return per !== count;
  }

  /** 该行是否"已被人工裁决"（界面上的"已核实"勾选；此标记只存在于核对阶段） */
  function isAdjudicated(item) {
    return Boolean(item && item.adjudicated === true);
  }

  /** 该行是否"需要人工裁决才能入库" */
  function needsAdjudication(item) {
    if (!item || item.action === "skip") return false; // 跳过的不需要裁决
    return hasQuantityMismatch(item) && !isAdjudicated(item);
  }

  /**
   * 本次入库量是否被人工改过（spec FR-1.6 v1.4 留痕）。
   * **由数值推导，而不是记"用户碰过这个输入框"**：24 → 10 → 24 之后，
   * 实际入库量与 BOM 原值已经一致，"为什么和 BOM 不一样"这个问题不再存在，
   * 标记留着反而会让事后核对时多出一堆查不出原因的"改动"。
   */
  function isEdited(item) {
    if (!item) return false;
    return toInt(item.intake_quantity) !== toInt(item.total_quantity);
  }

  /** 低库存阈值的校验：**留空合法**（= 继承分类默认，FR-4.8），填了就必须是非负整数 */
  function validateMinQuantity(raw) {
    if (isBlank(raw)) return { ok: true, value: "", error: "" };
    const n = Number(raw);
    if (!Number.isInteger(n)) return { ok: false, value: "", error: `低库存阈值必须是整数或留空（收到「${raw}」）` };
    if (n < 0) return { ok: false, value: "", error: `低库存阈值不能为负（收到「${raw}」）` };
    return { ok: true, value: n, error: "" };
  }

  /**
   * 改一个字段（spec FR-1.6）。
   * **只读字段一律拒绝**：返回 `{ok:false, error}` 而不是静默忽略——
   * 静默忽略会让界面看起来"改成功了"，而实际没生效。
   */
  function applyEdit(item, field, value) {
    if (READONLY_FIELDS.includes(field)) {
      return { ok: false, error: `「${field}」是 BOM 原值，核对阶段不可修改`, item };
    }
    if (!EDITABLE_FIELDS.includes(field)) {
      return { ok: false, error: `「${field}」不是可改字段`, item };
    }
    const next = Object.assign({}, item);
    if (field === "intake_quantity") {
      const check = validateIntake(value);
      if (!check.ok) return { ok: false, error: check.error, item };
      next.intake_quantity = check.value;
      next.edited_by_human = isEdited(next);
      return { ok: true, error: "", item: next };
    }
    if (field === "min_quantity") {
      const check = validateMinQuantity(value);
      if (!check.ok) return { ok: false, error: check.error, item };
      next.min_quantity = check.value;
      return { ok: true, error: "", item: next };
    }
    next[field] = value == null ? "" : String(value);
    return { ok: true, error: "", item: next };
  }

  /** 切换"跳过"（spec FR-1.7：可跳过某条并记原因） */
  function toggleSkip(item, skip, reason) {
    const next = Object.assign({}, item);
    next.action = skip ? "skip" : "keep";
    if (skip && !isBlank(reason)) next.note = String(reason);
    return next;
  }

  /** 勾选/取消"已核实"（人工裁决 FR-1.5） */
  function setAdjudicated(item, adjudicated) {
    return Object.assign({}, item, { adjudicated: adjudicated === true });
  }

  /**
   * 汇总（spec FR-1.8：入库前显示"新增 N / 合并 M / 跳过 K"）。
   * "新增/合并"要等真正入库时才知道（取决于库里有没有同规格），
   * 所以核对界面的预览按**条目去向**给出可核对的三类：待入库 / 跳过 / 非法，
   * 并保证**三数之和 = 条目总数**。
   */
  function summarize(items) {
    const list = Array.isArray(items) ? items : [];
    let keep = 0;
    let skip = 0;
    let invalid = 0;
    let zeroSkipped = 0;
    for (const item of list) {
      if (!item || item.action === "skip") { skip += 1; continue; }
      const check = validateIntake(item.intake_quantity);
      if (!check.ok) { invalid += 1; continue; }
      if (check.zero) { zeroSkipped += 1; continue; }
      keep += 1;
    }
    return {
      total: list.length,
      keep,
      skip: skip + zeroSkipped, // 显式跳过 + 本次入库量为 0 视同跳过
      skip_explicit: skip,
      skip_zero: zeroSkipped,
      invalid,
      sum: keep + skip + zeroSkipped + invalid,
    };
  }

  /**
   * 能否入库；不能则给出**具体原因**（不是一句"有错误"）。
   * 这正是 AC-1 里"阻止直接入库、要求人工裁决"的落点。
   */
  function canCommit(items) {
    const list = Array.isArray(items) ? items : [];
    const blockers = [];
    const pending = list.filter((it) => needsAdjudication(it));
    if (pending.length > 0) {
      blockers.push(`${pending.length} 条的「数量与位号个数不符」，请逐条确认（勾选"已核实"）或改为跳过`);
    }
    const invalid = list.filter((it) => it && it.action !== "skip" && !validateIntake(it.intake_quantity).ok);
    if (invalid.length > 0) {
      blockers.push(`${invalid.length} 条的「本次入库量」不合法（必须是非负整数）`);
    }
    const s = summarize(list);
    if (s.keep === 0) {
      blockers.push("无条目可入库：全部被跳过或本次入库量为 0");
    }
    return { ok: blockers.length === 0, blockers, summary: s };
  }

  /**
   * 生成提交给 `bom:commit` 的条目（去掉只属于核对阶段的字段）。
   * `adjudicated` 是本界面的临时标记，不进 IPC——契约里没有这个字段，多传就是契约漂移。
   */
  function toCommitItems(items) {
    return (Array.isArray(items) ? items : []).map((item) => {
      const out = {};
      for (const key of Object.keys(item)) {
        if (key === "adjudicated") continue;
        out[key] = item[key];
      }
      return out;
    });
  }

  const api = {
    EDITABLE_FIELDS,
    READONLY_FIELDS,
    validateIntake,
    validateMinQuantity,
    formulaText,
    hasQuantityMismatch,
    isAdjudicated,
    needsAdjudication,
    isEdited,
    applyEdit,
    toggleSkip,
    setAdjudicated,
    summarize,
    canCommit,
    toCommitItems,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ImportModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
