"use strict";
/**
 * export_format.js — 导出**列结构**（spec §4.2 两种模式）
 *
 * 与 exporter.js 的分工（plan §5）：
 *   exporter.js      只管"把给定的二维数组写成合法 xlsx"，不认识 BOM、不决定内容
 *   export_format.js 只管"把比对结果映射成该有的列"，不碰文件、不碰 zip
 * T13c 把两者接起来（T13d 再由用户上传立创做外部验收）。
 *
 * 为什么单独成模块：列结构是 **spec §4.2 的硬约束**（立创按表头语义识别列、嘉立创列序固定），
 * 一旦散落在 IPC 层/界面里，改一处漏一处。集中成**一张表**（AGENTS.md 标准做法 ④）。
 *
 * 输入形状：`CompareItem`（plan §6 契约）。**数量列取 `shortfall_quantity`**——
 * 这是 spec §4.2 的 `purchase_quantity`（需采购数量 = max(0, 需求−现有库存)），
 * 不是 total_quantity。这是 v1.2 的关键修正：库里已有 3 个而需要 24 个时，
 * 正确采购量是 **21**，写成 24 就会买多（spec §4.2 注、AC-2）。
 */

const { needsUnit } = require("./spec_parser");
const xlsxXml = require("./xlsx_xml");

/**
 * 模式一：立创商城配单（**默认**，spec §4.2）——列名照抄 spec，立创按表头语义识别。
 * 立创侧固定五列「原型号/原品牌/原封装/原参数/原C编码」，`立创编号` 有则优先按它匹配。
 */
const LCSC_COLUMNS = [
  { title: "型号", pick: (item) => item.part_number },
  { title: "品牌", pick: (item) => item.manufacturer },
  { title: "封装", pick: (item) => item.footprint },
  { title: "参数", pick: (item, ctx) => ctx.params },
  { title: "立创编号", pick: (item) => item.supplier_part },
  { title: "位号", pick: (item, ctx) => ctx.designators },
  { title: "数量", pick: (item) => item.shortfall_quantity, numeric: true },
];

/**
 * 模式二：嘉立创 SMT 贴片下单（spec §4.2）——列序是**官方指定**，不能换位。
 * 注意：`LibRef` / `Pins` 在本项目数据模型里没有对应字段（plan §3.1 无此概念），
 * 故留空——**不编造**。`编号` 用供应商编号（立创 C 编码）。
 */
const JLC_COLUMNS = [
  { title: "Comment", pick: (item) => item.value },
  { title: "Description", pick: (item, ctx) => ctx.params },
  { title: "Designator", pick: (item, ctx) => ctx.designators },
  { title: "Footprint", pick: (item) => item.footprint },
  { title: "LibRef", pick: () => "" },
  { title: "Pins", pick: () => "" },
  { title: "Quantity", pick: (item) => item.shortfall_quantity, numeric: true },
  { title: "编号", pick: (item) => item.supplier_part },
];

const MODES = { lcsc: LCSC_COLUMNS, jlc: JLC_COLUMNS };

/** 位号列上限（spec §4.2 格式硬约束：单条位号长度 ≤ 64 字符） */
const MAX_DESIGNATOR_CHARS = 64;

/**
 * 位号切分符：spec §4.2 明确「仅支持英文逗号 `,` 或空格」，
 * 其余 `;` `|` `。` `'` `:` `~` `>` **一律不支持**，必须转成逗号（AC-8）。
 * 这里把不支持的那些也当分隔符切开，再统一用逗号 join——
 * 于是**无论上游给的是数组还是原始串**，出口都一定是合规的英文逗号。
 */
const DESIGNATOR_SPLIT_RE = /[,;|。'`:~>\s，；、]+/;

/** 仅用于"是否发生过转换"的判定（不含 `,` 与空格：这两个本来就支持） */
const UNSUPPORTED_SEP_RE = /[;|。'`:~>，；、]/g;

function splitDesignatorTokens(input) {
  const raw = Array.isArray(input) ? input : [input];
  return raw
    .filter((v) => v != null)
    .flatMap((v) => String(v).split(DESIGNATOR_SPLIT_RE))
    .filter((s) => s !== "");
}

/**
 * 单元格长度上限：**Excel 的硬限制是 32767 个字符/格**（常量定义在 `xlsx_xml`——读写两侧共用一处）。
 *
 * 为什么必须处理：超过上限的单元格会让 Excel/立创打开时直接报"文件损坏，需要修复"——
 * 用户拿到的是一个**打不开的文件**，而这不是"少一点数据"，是**整份导出作废**。
 * 一张采购清单里出现 3 万字符的单元格只可能是脏数据（粘贴事故），所以这里**截断并明确警示**：
 * 宁可导出一份能打开的清单 + 一条说得清的提示，也不要产出打不开的文件。
 */
const MAX_CELL_CHARS = xlsxXml.MAX_CELL_CHARS;

/** 截断超长单元格并记录警示（不静默截断：警示会随 `buildRows().warnings` 回到界面） */
function clampCell(text, rowNo, columnTitle, warnings) {
  const s = String(text);
  if (s.length <= MAX_CELL_CHARS) return s;
  if (warnings) {
    warnings.push(
      `第 ${rowNo} 行「${columnTitle}」有 ${s.length} 个字符，超过 Excel 单元格上限 ${MAX_CELL_CHARS}，已截断`
      + "（不截断的话这份文件 Excel/立创打不开；请检查原始数据是否粘错了）"
    );
  }
  return s.slice(0, MAX_CELL_CHARS);
}

/**
 * 位号列：**一律用英文逗号**（spec §4.2）。
 * 若原串用了不支持的符号，这里转换并**返回警示**（AC-8 要求"导出前转换并在界面提示"）——
 * 放在导出侧而不是导入侧，是因为"立创能不能认"是导出的硬约束，此处是最后一道关。
 */
function formatDesignators(designators, rowNo, warnings) {
  const raw = Array.isArray(designators)
    ? designators.filter((v) => v != null).join(",")
    : String(designators == null ? "" : designators);
  const converted = raw.match(UNSUPPORTED_SEP_RE);
  if (converted && warnings) {
    warnings.push(
      `第 ${rowNo} 行：位号原用 ${[...new Set(converted)].join(" ")} 分隔，`
      + "已转为英文逗号（spec §4.2 仅支持 `,` 或空格）"
    );
  }
  const text = splitDesignatorTokens(designators).join(",");
  if (text.length > MAX_DESIGNATOR_CHARS && warnings) {
    warnings.push(
      `第 ${rowNo} 行：位号列 ${text.length} 字符，超过嘉立创上限 ${MAX_DESIGNATOR_CHARS}（spec §4.2），需拆分或精简`
    );
  }
  return text;
}

/**
 * 参数列（spec §4.2）：非空项连接、**空格分隔**、**必须带单位**。
 * 顺序照 spec：`value` + `voltage` + `dielectric` + `tolerance`（+ `power`，按分类取舍）。
 * 不去猜、不补单位——只把已有的拼起来（spec §1.3：不做元器件参数自动识别）。
 */
function buildParams(item) {
  // **顺序照 spec 的"嘉立创参数拼写规范"示例**（spec line 272：`100nF ±10% 50V X7R`）
  // 与 **AC-8 验收表**（spec line 525 同一个例子）——两处一致，且其中一处是**验收标准**。
  //
  // 说明一处 spec 自相矛盾（审计 R3 发现④）：spec line 239 的列来源表写的是
  // `value + voltage + dielectric + tolerance`（即"值 耐压 材质 容差"），与上面两处**不同**。
  // 取舍理由：验收标准（AC-8）比描述表更该被满足——用户拿着导出文件去立创比对时，
  // 参照的就是 AC-8 那句"形如 `100nF ±10% 50V X7R`"。**已列入待用户裁决项**。
  return [item.value, item.tolerance, item.voltage, item.dielectric, item.power, item.current]
    .map((v) => String(v == null ? "" : v).trim())
    .filter((v) => v !== "")
    .join(" ");
}

/**
 * 把 CompareItem 数组映射成表格行。
 * @param {Array<object>} items CompareItem[]
 * @param {"lcsc"|"jlc"} mode
 * @returns {{columns: string[], rows: Array<Array<string|number>>, warnings: string[]}}
 */
function buildRows(items, mode) {
  const columns = MODES[mode];
  if (!columns) throw new Error(`未知导出模式「${mode}」（只支持 lcsc / jlc，见 spec §4.2）`);
  const list = Array.isArray(items) ? items : [];
  const warnings = [];
  const rows = [columns.map((c) => c.title)];
  for (const item of list) {
    const rowNo = item && item.row_no != null ? item.row_no : rows.length;
    const params = buildParams(item);
    const ctx = {
      params,
      designators: formatDesignators(item && item.designators, rowNo, warnings),
    };
    // spec §4.2「参数必须带单位」：缺单位会让立创按数值猜，必须提示补全（不猜）
    const firstParam = params.split(" ")[0] || "";
    if (needsUnit(firstParam)) {
      warnings.push(`第 ${rowNo} 行：参数列首项「${firstParam}」缺单位（spec §4.2 要求带单位）`);
    }
    // 参数列整列为空：立创优先按空格拆分参数列来核对，空参数会削弱匹配，必须告知（不编造参数）
    if (params === "") {
      warnings.push(`第 ${rowNo} 行：参数列为空（BOM 未提供值/耐压/材质/容差），立创只能靠型号或 C 编码匹配`);
    }
    // AC-8 的异常路径假设"没有 C 编码但型号齐全，立创可凭型号匹配"。
    // 但真实 BOM 里存在**两者都空**的未选型条目（spec 附录 A：修正版含大量未选型物料）——
    // 这种行立创无从匹配，必须**明确告诉用户**，不能静默导出一行"看着有、其实匹配不上"的数据。
    const hasPartNumber = String((item && item.part_number) || "").trim() !== "";
    const hasSupplierCode = String((item && item.supplier_part) || "").trim() !== "";
    if (!hasPartNumber && !hasSupplierCode) {
      warnings.push(
        `第 ${rowNo} 行：既无「型号」也无「立创编号」，立创无法自动匹配（AC-8 异常路径），`
        + "需在核对界面补全型号或由人自行选型"
      );
    }
    const cells = columns.map((col) => {
      const value = col.pick(item, ctx);
      if (col.numeric) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0; // 数量列必须是数字（立创/Excel 按数值处理）
      }
      return clampCell(value == null ? "" : String(value), rowNo, col.title, warnings);
    });
    rows.push(cells);
  }
  return { columns: columns.map((c) => c.title), rows, warnings };
}

const buildLcscRows = (items) => buildRows(items, "lcsc");
const buildJlcRows = (items) => buildRows(items, "jlc");

/* ------------------------------------------------ 库表导出（FR-5.5） */

/**
 * 「导出当前库」的列（FR-5.5 / AC-5 第 5 行：生成表格文件，**条数与库中一致**）。
 * 与配单导出的区别：配单是"要买什么"，这里是"我有什么"——所以列取器件自身的字段。
 */
const LIBRARY_COLUMNS = [
  { title: "值", pick: (part) => part.value },
  { title: "封装", pick: (part) => part.footprint },
  { title: "耐压", pick: (part) => part.voltage },
  { title: "材质", pick: (part) => part.dielectric },
  { title: "容差", pick: (part) => part.tolerance },
  { title: "分类", pick: (part) => part.category },
  { title: "型号", pick: (part) => part.part_number },
  { title: "厂商", pick: (part) => part.manufacturer },
  { title: "供应商编号", pick: (part) => part.supplier_part },
  { title: "数量", pick: (part) => part.quantity, numeric: true },
  // 个体阈值：**留空 = 继承分类默认**（FR-4.8）。这里如实留空，不把继承值写进来冒充个体值。
  { title: "低库存阈值", pick: (part) => (part.min_quantity === "" || part.min_quantity == null ? "" : part.min_quantity), numeric: true },
  { title: "库位", pick: (part) => part.location },
  { title: "备注", pick: (part) => part.note },
  // 判定结果列：直接问 low_stock（**不在这里重算阈值**，否则就是第二套语义）
  { title: "低库存", pick: (part, ctx) => (ctx.isLowStock(part) ? "是" : "") },
];

/**
 * 生成库表导出的表头与行。
 * **约定与 `buildRows` 一致：表头是 `rows` 的第一行**（exporter 只收 rows，表头要自己带上）。
 * @param {object[]} parts 器件数组
 * @param {object} settings 当前设置（分类默认阈值在其中）
 */
function buildLibraryRows(parts, settings) {
  const lowStock = require("./low_stock");
  const list = Array.isArray(parts) ? parts : [];
  const ctx = { isLowStock: (part) => lowStock.isLowStock(part, settings) };
  const header = LIBRARY_COLUMNS.map((c) => c.title);
  const rows = [header.slice()];
  const warnings = [];
  let rowNo = 1; // 表头占第 1 行，数据从第 2 行起（警示里的行号与用户在 Excel 里看到的一致）
  for (const part of list) {
    rowNo += 1;
    rows.push(LIBRARY_COLUMNS.map((col) => {
      const value = col.pick(part || {}, ctx);
      if (col.numeric) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
      }
      // 库表导出同样要过单元格上限这道闸（审计 R3 发现①：原来只有配单导出做了截断）
      return clampCell(value == null ? "" : String(value), rowNo, col.title, warnings);
    }));
  }
  return { columns: header, rows, data_count: list.length, warnings };
}

module.exports = {
  LCSC_COLUMNS,
  JLC_COLUMNS,
  LIBRARY_COLUMNS,
  MODES,
  MAX_DESIGNATOR_CHARS,
  buildParams,
  formatDesignators,
  buildRows,
  buildLcscRows,
  buildJlcRows,
  buildLibraryRows,
};
