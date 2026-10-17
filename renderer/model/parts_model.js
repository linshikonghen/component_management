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
    { key: "tolerance", label: "容差", kind: "text",
    // 快捷选择：± 这个符号键盘打不出来（用户实测），点一下即可；也仍可自由输入
    //（normalizeText 已把 +- 归一为 ±，见 tests/test_normalize_tolerance.js）
    quick: ["±1%", "±5%", "±10%", "±20%"] },
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
   * 分类下拉（**落库值 = 立创商品类型中文名**，用户 2026-10-16 裁定①）。
   *
   * 与 "位号前缀 = 阈值键" 的旧设计关系：
   *   · `key` 就是**存进 parts.json 的值**（中文名），也是服务端 `categories.isAcceptable` 的输入；
   *   · `legacy` 只用于**读旧数据**（旧库存的是前缀键 / `_default` 哨兵），
   *     展示时映射成中文名，**保存时原样回传**（前缀与 `_default` 服务端仍接受，不逼用户重选）；
   *   · 位号前缀**不再**是落库值，也不在这里当阈值键用 —— 阈值表在 `CATEGORY_CLASS_ROWS`。
   * ⚠️ 这份列表是 `src/services/categories.js` 的**镜像**（渲染进程不能 require 服务端模块），
   *    一致性由 `tests/test_categories.js` 钉住（漏一个立创类型就会红）。
   */
  const CATEGORY_OPTIONS = [
    { key: "贴片电容(MLCC)", label: "贴片电容(MLCC)", legacy: "C" },
    { key: "贴片型铝电解电容", label: "贴片型铝电解电容", legacy: "C" },
    { key: "直插铝电解电容", label: "直插铝电解电容", legacy: "C" },
    { key: "固态电容", label: "固态电容", legacy: "C" },
    { key: "贴片电阻", label: "贴片电阻", legacy: "R" },
    // 用户裁定（2026-10-17）：电位器按阈值 5，与电阻类（50）分开；legacy 留空（它不是位号前缀）
    { key: "可调电阻/电位器", label: "可调电阻/电位器", legacy: "" },
    { key: "贴片电感", label: "贴片电感", legacy: "L" },
    { key: "功率电感", label: "功率电感", legacy: "L" },
    { key: "一体成型电感", label: "一体成型电感", legacy: "L" },
    { key: "二极管", label: "二极管", legacy: "D" },
    { key: "发光二极管", label: "发光二极管", legacy: "LED" },
    { key: "发光二极管/LED", label: "发光二极管/LED", legacy: "LED" },
    { key: "静电和浪涌保护(TVS/ESD)", label: "静电和浪涌保护(TVS/ESD)", legacy: "D" },
    { key: "肖特基二极管", label: "肖特基二极管", legacy: "D" },
    { key: "稳压二极管", label: "稳压二极管", legacy: "D" },
    { key: "三极管", label: "三极管", legacy: "Q" },
    { key: "三极管(BJT)", label: "三极管(BJT)", legacy: "Q" },
    { key: "场效应管(MOSFET)", label: "场效应管(MOSFET)", legacy: "Q" },
    { key: "集成电路", label: "集成电路", legacy: "U" },
    { key: "DC-DC电源芯片", label: "DC-DC电源芯片", legacy: "U" },
    { key: "音频功率放大器", label: "音频功率放大器", legacy: "U" },
    { key: "线性稳压器(LDO)", label: "线性稳压器(LDO)", legacy: "U" },
    { key: "模拟开关/多路复用器", label: "模拟开关/多路复用器", legacy: "U" },
    { key: "晶振", label: "晶振", legacy: "X" },
    { key: "连接器", label: "连接器", legacy: "CN" },
    { key: "线对板针座", label: "线对板针座", legacy: "CN" },
    { key: "电源连接器/插头", label: "电源连接器/插头", legacy: "CN" },
    { key: "排母", label: "排母", legacy: "H" },
    { key: "排针", label: "排针", legacy: "H" },
    { key: "翘板船型开关", label: "翘板船型开关", legacy: "KEY" },
    { key: "滑动开关", label: "滑动开关", legacy: "KEY" },
    { key: "钮子开关", label: "钮子开关", legacy: "KEY" },
    { key: "轻触开关", label: "轻触开关", legacy: "KEY" },
    { key: "拨码开关", label: "拨码开关", legacy: "KEY" },
    { key: "自恢复保险丝", label: "自恢复保险丝", legacy: "F" },
    { key: "蜂鸣器", label: "蜂鸣器", legacy: "BUZZER" },
    { key: "测试点", label: "测试点", legacy: "" },
    { key: "其它", label: "其它", legacy: "" },
  ];

  /**
   * 阈值表的 14 行（**键 = spec §5.3 的类键**，与 `settings.default_min_quantity` 同集合）。
   *
   * 为什么阈值表仍按类键走：`default_min_quantity` 是 spec §5.3 的表（14 类 / 14 个默认值），
   * 服务端 `low_stock.js` 按类键取默认阈值；而**分类下拉**是立创商品类型（25+ 种），
   * 两者是"多个商品类型 → 一个阈值类"的多对一关系，用一张表表达会丢信息。
   * 页面不给这 14 行再写第二份表（`settings_model.thresholdRows` 只读这里）。
   */
  const CATEGORY_CLASS_ROWS = [
    { key: "C", label: "电容", prefixes: ["C"] },
    { key: "R", label: "电阻", prefixes: ["R"] },
    { key: "L", label: "电感", prefixes: ["L"] },
    { key: "D", label: "二极管", prefixes: ["D"] },
    { key: "Q", label: "三极管/MOS", prefixes: ["Q"] },
    { key: "U", label: "集成电路", prefixes: ["U"] },
    { key: "CN", label: "连接器", prefixes: ["CN", "J", "P"] },
    { key: "X", label: "晶振", prefixes: ["X", "Y"] },
    { key: "KEY", label: "按键/开关", prefixes: ["KEY", "SW"] },
    { key: "F", label: "保险丝", prefixes: ["F"] },
    { key: "BUZZER", label: "蜂鸣器", prefixes: ["BUZZER"] },
    { key: "LED", label: "指示灯", prefixes: ["LED"] },
    { key: "H", label: "排针/排母", prefixes: ["H"] },
    // 兜底类的键是 `_default`（settings.default_min_quantity 用的就是这个哨兵，
    // 不是 spec 表里的字面 "其它"）——改成别名字符串会让服务端查不到值（有测试钉住）
    { key: "_default", label: "其它", prefixes: [] },
  ];

  /** 类键 → 类中文名（旧数据里的裸类键 `C`/`KEY` 要显示成中文） */
  const CLASS_LABELS = {};
  for (const cls of CATEGORY_CLASS_ROWS) CLASS_LABELS[cls.key] = cls.label;

  /**
   * 旧数据展示：库里存的可能是 `R` / `SW` / `_default`（前缀或哨兵）——
   * 下拉框要显示成中文名，否则用户看到"这条料的分类不在列表里"。
   * 只在**展示**时映射；`toSavePayload` 原样回传（服务端对旧值仍放行，不逼用户重选）。
   *
   * ⚠️ 三个约定（**踩过坑，别改回去**）：
   *   ① 返回值必须是**下拉项的 key**（立创中文名），否则 `<select>` 找不到匹配项 →
   *      界面显示成「（未选 = 其它）」——明明有分类却像没分类（实测 R/SW/固态电容 全中招）；
   *   ② 一个位号对应多个商品类型（`SW` 有三种开关）→ 取该类**第一个**下拉项，顺序即代表项（确定、可断言）；
   *   ③ 表里没有的**中文名**（如对账单里的 `固态电容`）原样返回，由页面显示成"（表外类型）"，
   *      **不许映射成「其它」**（那是把用户的值说成别的分类，属于撒谎）。
   */
  const CLASS_OF_OPTION = {};
  for (const option of CATEGORY_OPTIONS) {
    if (option.legacy && CLASS_OF_OPTION[option.legacy] === undefined) CLASS_OF_OPTION[option.legacy] = option.key;
  }
  /** 旧值（类键 / 位号前缀，如 `H`、`SW`、`Y`、`J`）→ 该类**第一个**下拉项 */
  const CLASS_REPRESENTATIVE = { "_default": "其它", "其它": "其它", "OTHER": "其它" };
  for (const cls of CATEGORY_CLASS_ROWS) {
    if (CLASS_REPRESENTATIVE[cls.key]) continue;
    const first = CATEGORY_OPTIONS.find((o) => o.legacy === cls.key);
    if (first) CLASS_REPRESENTATIVE[cls.key] = first.key;
  }
  for (const cls of CATEGORY_CLASS_ROWS) {
    for (const prefix of cls.prefixes) {
      if (CLASS_REPRESENTATIVE[prefix]) continue; // 类键优先（`C` 要落电容而不是「贴片型铝电解电容」）
      const first = CATEGORY_OPTIONS.find((o) => o.legacy === cls.key);
      if (first) CLASS_REPRESENTATIVE[prefix] = first.key;
    }
  }
  const OPTION_KEYS = new Set(CATEGORY_OPTIONS.map((o) => o.key));

  function categoryDisplayValue(stored) {
    const raw = isBlank(stored) ? "" : String(stored).trim();
    if (raw === "") return "";
    if (OPTION_KEYS.has(raw)) return raw;
    const upper = raw.toUpperCase();
    if (CLASS_REPRESENTATIVE[upper]) return CLASS_REPRESENTATIVE[upper];
    if (CLASS_REPRESENTATIVE[raw]) return CLASS_REPRESENTATIVE[raw];
    return raw; // 表外类型（含未收录的立创商品类型）原样显示，不猜、不伪装
  }

  /** 下拉项要显示的文本：认得的给类/商品中文名，表外的按原样（页面会标注"表外类型"） */
  function categoryDisplayLabel(stored) {
    const raw = isBlank(stored) ? "" : String(stored).trim();
    if (raw === "") return "";
    const resolved = categoryDisplayValue(raw);
    const option = CATEGORY_OPTIONS.find((o) => o.key === resolved);
    if (option) return option.label;
    return CLASS_LABELS[resolved.toUpperCase()] || raw;
  }

  /** 可排序的列（与 `parts:list` 的 SORTABLE_FIELDS 对齐；界面标题 → 字段名） */
  const SORTABLE_COLUMNS = [
    { title: "值", field: "value" },
    { title: "封装", field: "footprint" },
    { title: "耐压", field: "voltage" },
    { title: "材质", field: "dielectric" },
    { title: "容差", field: "tolerance" },
    { title: "分类", field: "category" },
    // **型号必须显示**：对账单入库的料（MOS/IC/连接器…）型号就是它的身份（用户 2026-10-17 反馈）
    { title: "型号", field: "part_number" },
    // 「厂商」列已按用户要求去掉（2026-10-17：厂商不重要）——字段本身仍在数据模型里，只是列表不占位
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
    CATEGORY_CLASS_ROWS,
    SORTABLE_COLUMNS,
    KIND_LABELS,
    requiredFields,
    requiredMissing,
    emptyForm,
    formFromPart,
    categoryDisplayValue,
    categoryDisplayLabel,
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
