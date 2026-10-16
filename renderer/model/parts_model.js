/**
 * parts_model.js — 手动录入 / 编辑表单的**规则**（spec FR-3 / FR-5.1 / FR-5.4）
 *
 * 与 import_model / compare_model 同一做法：规则抽出来、无头可测，页面只做装配。
 * 本文件**不碰 DOM、不 require 任何东西**（Node 走 module.exports，浏览器挂 globalThis）。
 *
 * ⚠️ **校验不在这里重复实现**：字段白名单、数量/阈值合法性、同规格累加、编辑防重复
 * 都在服务端 `src/services/parts.js`（spec FR-3.2：走同一套关键信息校验）。
 * 渲染进程**拿不到**那个模块（AGENTS.md：渲染进程禁 require），所以这里只做两件不重复的事：
 *   ① 表单元数据（标签/类型/是否必填/提示语）——纯展示；
 *   ② `requiredMissing()` 的**即时提示**，让用户不等往返就知道少了什么。
 * 必填字段集与分类键**必须**与服务端一致，这一点由 `tests/test_parts_model.js`
 * 跨边界断言钉住（渲染侧与服务侧各有一份，靠测试防漂移，而不是靠记性）。
 */

(function attach(root) {
  "use strict";

  /** 表单字段（顺序即界面顺序）。`required` 必须与服务端 REQUIRED_FIELDS 一致（有测试） */
  const FORM_FIELDS = [
    { key: "category", label: "分类", kind: "select", hint: "手动录入没有位号，分类不会自动推导；留空=其它" },
    { key: "value", label: "值", kind: "text", required: true },
    { key: "footprint", label: "封装", kind: "text", required: true },
    { key: "voltage", label: "耐压", kind: "text" },
    { key: "dielectric", label: "材质", kind: "text" },
    { key: "tolerance", label: "容差", kind: "text" },
    { key: "power", label: "功率", kind: "text" },
    { key: "current", label: "电流", kind: "text" },
    { key: "mount_type", label: "安装方式", kind: "text" },
    { key: "polarity", label: "极性", kind: "text" },
    { key: "part_number", label: "型号", kind: "text" },
    { key: "manufacturer", label: "厂商", kind: "text" },
    { key: "supplier_part", label: "供应商编号", kind: "text", hint: "立创商城就是 C 编码" },
    { key: "supplier", label: "供应商", kind: "text" },
    { key: "quantity", label: "数量", kind: "number", hint: "必须是整数；0 也是合法值（知道有这条料但手上没有）" },
    { key: "min_quantity", label: "低库存阈值", kind: "number", hint: "留空 = 继承分类默认阈值" },
    { key: "location", label: "库位", kind: "text" },
    { key: "datasheet", label: "数据手册", kind: "text" },
    { key: "substitute", label: "替代料", kind: "text" },
    { key: "batch", label: "批次", kind: "text" },
    { key: "note", label: "备注", kind: "text" },
  ];

  /**
   * 分类下拉（spec §5.3 的 14 类）。
   * 键必须与 `settings.default_min_quantity` 的键同集合——服务端靠这个键取默认阈值（FR-4.8）。
   */
  const CATEGORY_OPTIONS = [
    { key: "C", label: "电容" },
    { key: "R", label: "电阻" },
    { key: "L", label: "电感" },
    { key: "D", label: "二极管" },
    { key: "Q", label: "三极管 / MOS" },
    { key: "U", label: "集成电路" },
    { key: "CN", label: "连接器" },
    { key: "X", label: "晶振" },
    { key: "KEY", label: "按键 / 开关" },
    { key: "F", label: "保险丝" },
    { key: "BUZZER", label: "蜂鸣器" },
    { key: "LED", label: "指示灯" },
    { key: "H", label: "排针 / 排母" },
    { key: "_default", label: "其它" },
  ];

  /** 可排序的列（与 `parts:list` 的 SORTABLE_FIELDS 对齐；界面标题 → 字段名） */
  const SORTABLE_COLUMNS = [
    { title: "值", field: "value" },
    { title: "封装", field: "footprint" },
    { title: "耐压", field: "voltage" },
    { title: "材质", field: "dielectric" },
    { title: "容差", field: "tolerance" },
    { title: "分类", field: "category" },
    { title: "型号", field: "part_number" },
    { title: "厂商", field: "manufacturer" },
    { title: "数量", field: "quantity" },
    { title: "库位", field: "location" },
  ];

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    return typeof value === "string" && value.trim() === "";
  }

  function requiredFields() {
    return FORM_FIELDS.filter((f) => f.required === true);
  }

  /** 缺哪些必填项（返回**中文标签**，直接可显示；AC-3 异常路径要"明确缺哪个"） */
  function requiredMissing(form) {
    const src = form || {};
    return requiredFields()
      .filter((f) => isBlank(src[f.key]))
      .map((f) => f.label);
  }

  function emptyForm() {
    const form = {};
    for (const field of FORM_FIELDS) {
      form[field.key] = field.key === "quantity" ? 0 : "";
    }
    form.category = "";
    form.min_quantity = "";
    return form;
  }

  /** 从一条已有器件填表单（编辑模式） */
  function formFromPart(part) {
    const form = emptyForm();
    const src = part || {};
    for (const field of FORM_FIELDS) {
      const value = src[field.key];
      form[field.key] = value === null || value === undefined ? "" : value;
    }
    form.id = src.id || "";
    return form;
  }

  /** 表单 → `parts:save` 的载荷（只做类型与空值规整；白名单由服务端执行） */
  function toSavePayload(form) {
    const src = form || {};
    const part = {};
    for (const field of FORM_FIELDS) {
      const raw = src[field.key];
      if (field.kind === "number") {
        if (field.key === "min_quantity" && isBlank(raw)) {
          part[field.key] = ""; // 留空 → 服务端按 null 处理（= 继承分类默认）
        } else {
          part[field.key] = isBlank(raw) ? 0 : Number(raw);
        }
      } else {
        part[field.key] = isBlank(raw) ? "" : String(raw).trim();
      }
    }
    if (!isBlank(src.id)) part.id = String(src.id);
    return { part };
  }

  /** 保存成功后要**保留**的字段（FR-3.3：连续录入同类料不必重选分类） */
  function keepForNextEntry(form) {
    const kept = emptyForm();
    for (const key of ["category", "footprint", "supplier", "manufacturer", "location", "mount_type"]) {
      kept[key] = (form || {})[key] || "";
    }
    kept.value = "";
    kept.part_number = "";
    kept.supplier_part = "";
    kept.quantity = 0;
    return kept;
  }

  /** FR-5.1：点同一列反向；换列则升序 */
  function nextSort(current, field) {
    const cur = current || {};
    if (cur.sort_by === field) {
      return { sort_by: field, sort_dir: cur.sort_dir === "asc" ? "desc" : "asc" };
    }
    return { sort_by: field, sort_dir: "asc" };
  }

  /** 表头要不要显示箭头（界面用） */
  function sortIndicator(current, field) {
    const cur = current || {};
    if (cur.sort_by !== field) return "";
    return cur.sort_dir === "desc" ? "▼" : "▲";
  }

  /**
   * 变动记录的**中文说法**（FR-5.4 详情里要能读懂）。
   * kind 枚举来自 plan §3.2：in / out / adjust / init。
   */
  const KIND_LABELS = { in: "入库", out: "出库", adjust: "修正", init: "初始" };

  function describeMovement(movement) {
    const m = movement || {};
    const kind = KIND_LABELS[m.kind] || m.kind || "";
    const delta = Number(m.delta) || 0;
    const sign = delta > 0 ? "+" : "";
    return `${kind} ${sign}${delta}（${Number(m.before) || 0} → ${Number(m.after) || 0}）`;
  }

  /** 详情里"这条为什么和 BOM 不一样"的说明（v1.4 留痕字段，缺了就留空） */
  function movementTrace(movement) {
    const m = movement || {};
    if (m.edited_by_human !== true) return "";
    const expected = m.expected_quantity;
    const intake = m.intake_quantity;
    if (expected === undefined && intake === undefined) return "人工改过数量";
    return `人工改过：原应入库 ${expected === undefined ? "—" : expected}，实际入库 ${intake === undefined ? "—" : intake}`;
  }

  const api = {
    FORM_FIELDS,
    CATEGORY_OPTIONS,
    SORTABLE_COLUMNS,
    KIND_LABELS,
    requiredFields,
    requiredMissing,
    emptyForm,
    formFromPart,
    toSavePayload,
    keepForNextEntry,
    nextSort,
    sortIndicator,
    describeMovement,
    movementTrace,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PartsModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
