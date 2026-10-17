"use strict";
/**
 * lcsc_statement.js — 立创商城「物料明细对账单」解析（**只用于按订单入库**）
 *
 * 用户 2026-10-16 的决定（逐条落在这里，改口径就改这里）：
 *   ① **只用于入库**：导出、比对**一律不动**（本模块不导出、不比对，也不碰库）
 *   ② **只用 H–L 列**（0 基下标 **7..11**）：商品类型 / 商品名称 / 商品型号 / 封装格式 / 订购数量
 *      —— G（品牌）不参与；更早的订单级列（A/B…）更不用
 *   ③ **匹配键 = 商品类型 + 商品名称(值/容差/耐压) + 商品型号 + 封装**，**不用品牌、不用商品编号**
 *      （理由：同型号可能从别处买、厂商不同；C 编码是立创特有的，不该当身份）
 *   ④ **没有位号**：对账单里没有位号，这条路径就不碰它（器件字段本身保留，BOM 路径照旧用）
 *   ⑤ **分类以「商品类型」为准**（比位号前缀更准），并由此推出**阈值键**（见 thresholdKey）
 *
 * 为什么"只认对账单"（用户决定③）：列语义必须靠**表头**确定，猜错哪列是数量就是错账。
 * 认不出表头 → 明确报错，绝不猜。
 */

const path = require("path");
const xlsBiff = require("./xls_biff");
const { looksLikeValue, normalizeTolerance } = require("./spec_parser"); // 「是不是值」与容差的唯一判据
const { locateHeaderRow } = require("./table_header"); // 「哪一行是表头」的唯一实现

/** 对账单里我们**需要**的列（H–L）。值是 0 基下标；表头文字用于识别。 */
const NEEDED_COLUMNS = [
  { header: "商品类型", index: 7, field: "category" },
  { header: "商品名称", index: 8, field: "name" },
  { header: "商品型号", index: 9, field: "manufacturer_part" },
  { header: "封装格式", index: 10, field: "footprint" },
  { header: "订购数量", index: 11, field: "quantity" },
];

/** 供识别用的关键表头（缺任何一个就不是我们要的对账单） */
const REQUIRED_HEADERS = ["商品类型", "商品名称", "商品型号", "封装格式", "订购数量"];

/** 包装词：进不了器件参数（`100nF ±10% 100V 编带` 里的「编带」） */
const PACKAGING_WORDS = ["编带", "袋装", "散装", "管装", "盘装", "卷装", "托盘"];

/**
 * 商品类型 → **低库存阈值键**（spec §5.3 的 14 类是按位号前缀建的）。
 *
 * ⚠️ 只用**单一来源**（spec §5.3 的 v2.1 验收行：映射只在 categories.js）：
 *   这里曾经有一张自己的正则表，实测和单一来源**打架**：
 *     `发光二极管` 表里给 D、单一来源给 LED；`排针` 表里给 CN、单一来源给 H；
 *     `固态电容` 表里给 C(20)，而 low_stock 因为映射不到实际用 `_default`(5)
 *   —— 核对表里显示"阈值键 C"，用户按 20 备货，却按 5 报警 ✗（"两个真相"的典型症状）。
 *   现在：单一来源认得出就用它（含排母→H、排针→H、MOSFET→Q、开关→KEY、TVS→D…），
 *   认不出（未收录的商品类型，如 `固态电容`）→ `_default`，**不猜** ✓
 *   核对表照样把「分类 / 阈值键」都显示出来，供人核对。
 */
function thresholdKey(category) {
  const text = String(category == null ? "" : category);
  const { settingsKeyOf } = require("./categories");
  const key = settingsKeyOf(text);
  return key === "OTHER" ? "_default" : key;
}

/**
 * 商品名称里的「标签:值」写法 —— 立创的 MOS/三极管/二极管行就是这样：
 *   `1个P沟道 耐压:30V 电流:90A 编带`
 *   `电流:500mA 电压:25V 编带`
 * 半角/全角冒号都见过。
 */
const LABEL_ALIASES = {
  "耐压": "voltage", "电压": "voltage", "vds": "voltage", "vdss": "voltage",
  "电流": "current", "id": "current",
  "功率": "power", "功耗": "power",
  "容差": "tolerance", "精度": "tolerance",
  "阻值": "value", "容值": "value", "电感值": "value",
  "材质": "dielectric", "温度系数": "dielectric",
};
const LABEL_RE = /^([^:：]{1,8})[:：](.+)$/;

/** 沟道（MOS 管的极性）：`1个P沟道` → `P沟道` */
function matchChannel(token) {
  const m = /^(?:\d+\s*个)?\s*([NPnp])[\s-]*沟道$/.exec(String(token == null ? "" : token).trim());
  return m ? `${m[1].toUpperCase()}沟道` : "";
}

/** `30V` / `1.5kV` → 归一为原样（大写 V） */
function matchVoltage(token) {
  const m = /^(\d+(?:\.\d+)?)\s*(k?V)$/.exec(String(token == null ? "" : token).trim());
  return m ? `${m[1]}${m[2]}` : "";
}

/** `90A` / `500mA` → 原样（大小写规范到 A / mA） */
function matchCurrent(token) {
  const m = /^(\d+(?:\.\d+)?)\s*(m?A)$/.exec(String(token == null ? "" : token).trim());
  return m ? `${m[1]}${m[2]}` : "";
}

/** `1.25W` / `100mW` / `1/10W` / `1/4W` → 原样 */
function matchPower(token) {
  const text = String(token == null ? "" : token).trim();
  if (/^1\/\d+(?:\.\d+)?\s*W$/.test(text)) return text.replace(/\s+/g, "");
  const m = /^(\d+(?:\.\d+)?)\s*(m?W)$/.exec(text);
  return m ? `${m[1]}${m[2]}` : "";
}

/** 一个"值/参数"token → 落到哪个字段（标签式与裸写法共用**同一套**判定，不重复实现） */
function classifyParam(token) {
  const text = String(token == null ? "" : token).trim();
  if (text === "") return null;
  const channel = matchChannel(text);
  if (channel) return { field: "polarity", value: channel };
  const tolerance = normalizeTolerance(text);
  // **容差必须带 %**：`±20V` 是 MOS 的栅源电压，不是容差（原来会把它当容差 ✗）
  if (tolerance && text.includes("%")) return { field: "tolerance", value: tolerance };
  const voltage = matchVoltage(text);
  if (voltage) return { field: "voltage", value: voltage };
  const current = matchCurrent(text);
  if (current) return { field: "current", value: current };
  const power = matchPower(text);
  if (power) return { field: "power", value: power };
  if (looksLikeValue(text)) return { field: "value", value: text };
  return null;
}

/**
 * 解析「商品名称」为 值 / 容差 / 耐压 / 电流 / 功率 / 极性（+ 去掉包装词）。
 *
 * ⚠️ **不能只看第一个词元，也不能只认裸写法**（真实对账单实测，用户报"识别有问题"）：
 *   · 电阻有 4/18 行的写法是**描述在前**：`厚膜电阻 200kΩ ±1% 100mW 编带`
 *     → 原来只看 leftovers[0]（=「厚膜电阻」）→ **值丢了** ✗
 *   · MOS/三极管是**标签式**：`1个P沟道 耐压:30V 电流:90A 编带`
 *     → 原来只认裸 `30V` → 整行**一个字段都认不出** ✗
 *   现在按 token 分类扫全串：只要出现"像值/像参数"的词元就认出来 ✓
 *
 * 仍然**不猜**：描述词（厚膜电阻/降压型/钮子开关）与型号样式（1N4148W）都不是值；
 * 材质与没认出的词元一律留在 extra 里供人查看，**不自动落库**。
 */
function parseProductName(name) {
  const raw = String(name == null ? "" : name).trim();
  const out = { value: "", tolerance: "", voltage: "", current: "", power: "", polarity: "", pack: "" };
  if (raw === "") return out;
  const extras = [];
  // 无标签的参数先**收集**再决定：同一串出现多个候选（如 LDO 的 `3.3V 500mA 5.5V`，第一个 V 是输出、
  // 第二个才是输入耐压）时**不猜**，全部留 extra 交人判断 ✓
  const pending = { voltage: [], current: [], power: [] };
  for (const token of raw.split(/\s+/).filter((t) => t !== "")) {
    if (PACKAGING_WORDS.some((w) => token.includes(w))) { out.pack = token; continue; }
    // 标签式：`耐压:30V` → 只认**已知标签**，未知标签（如 `封装:0603`）整串进 extra，不乱认
    const label = LABEL_RE.exec(token);
    if (label) {
      const labelKey = label[1].trim().toLowerCase();
      const field = LABEL_ALIASES[labelKey] || LABEL_ALIASES[label[1].trim()];
      if (field && field !== "dielectric") {
        const hit = classifyParam(label[2]);
        // 右侧必须是**认得出的形状**才落字段：`电流:0.1uA@11.2V`（漏电@测试电压）这种
        // 不是"电流"这一个数，硬塞进去会误导 → 整串留 extra 供人看 ✓
        if (hit && (field === hit.field || field === "value")) {
          if (!out[field]) { out[field] = hit.value; continue; }
        }
      }
      extras.push(token);
      continue;
    }
    const hit = classifyParam(token);
    if (!hit) { extras.push(token); continue; }
    if (hit.field === "value" || hit.field === "tolerance" || hit.field === "polarity") {
      if (!out[hit.field]) out[hit.field] = hit.value; else extras.push(token);
      continue;
    }
    pending[hit.field].push(hit.value);
  }
  for (const field of ["voltage", "current", "power"]) {
    if (out[field]) continue;
    const list = pending[field];
    if (list.length === 1) out[field] = list[0];
    else if (list.length > 1) extras.push(...list); // 有歧义 → 不猜
  }
  // 剩下的（如 `X7R` 材质、`厚膜电阻` 描述、`0603` 封装串）**原样留在 extra**，由人决定要不要填 —— 不自动落库
  out.extra = extras.join(" ");
  return out;
}

/** 认不出表头就明确报错（绝不猜哪列是数量） */
function assertIsStatement(headerRow) {
  const cells = (headerRow || []).map((v) => String(v == null ? "" : v));
  const missing = REQUIRED_HEADERS.filter((h) => !cells.includes(h));
  if (missing.length > 0) {
    throw new Error("不是立创商城的物料明细对账单：缺少表头 " + missing.join(" / ")
      + "（本功能只认对账单，列语义靠表头确定——猜错哪列是数量就是错账）");
  }
}

/** 明细行判定：订购数量是正数、且商品型号非空（"商品合计金额 / 说明 / 价外费用"等标签行会被自然跳过） */
function isDetailRow(row) {
  const qty = Number(row[11]);
  const mp = row[9];
  return Number.isFinite(qty) && qty > 0 && typeof mp === "string" && mp.trim() !== "";
}

/**
 * 解析对账单的二维数组。
 * @returns {{ok: boolean, items?: Array, error?: string, warnings: string[]}}
 *   item = { row_no, category, threshold_key, name, value, tolerance, voltage, extra,
 *            manufacturer_part, footprint, quantity }
 */
function parseStatementRows(rows) {
  const warnings = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "对账单是空的（没有任何行）", warnings };
  }
  const headerIdx = locateHeaderRow(rows);
  const headerRow = rows[headerIdx] || [];
  try {
    assertIsStatement(headerRow);
  } catch (exc) {
    return { ok: false, error: exc.message, warnings };
  }

  const items = [];
  for (let r = headerIdx + 1; r < rows.length; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    if (!isDetailRow(row)) continue; // 标签行/合计行/说明行：跳过（不是"丢失数据"，它们本就不是明细）
    const parsed = parseProductName(row[8]);
    const category = String(row[7] == null ? "" : row[7]).trim();
    const manufacturerPart = String(row[9] == null ? "" : row[9]).trim();
    // **A：值留空时用商品型号当值**（用户 2026-10-17 裁定）：
    //   除了贴片电阻/贴片电容（它们有真值 100K/100nF），MOS/IC/连接器/开关这些**型号就是它的身份**
    //   （立创商品名称对它们只有描述+参数，没有"值"）。空值会带来两个实际后果：
    //     ① 库存列表「值」列空着，靠型号认料；② 值必填 → 导入后编辑保存被拒 ✗；
    //     ③ 去重键不含型号 → 两颗不同 MOS（同封装/耐压/值为空）会被当成同一颗 ✗
    //   用商品型号兜底为值，一次解决三条，且不猜任何参数（型号是**对账单上的事实**，不是推断）。
    let value = parsed.value;
    if (value === "" && manufacturerPart !== "") {
      value = manufacturerPart;
      warnings.push(`第 ${r + 1} 行：商品名称里没有参数值，按约定用「商品型号」${manufacturerPart} 作为值（可在核对表里改）`);
    } else if (value === "") {
      const known = ["voltage", "current", "power", "polarity"].some((f) => parsed[f]);
      warnings.push(known
        ? `第 ${r + 1} 行：商品名称「${row[8]}」没有值、商品型号也是空的（请用商品型号当值，见核对表）`
        : `第 ${r + 1} 行：商品名称「${row[8]}」里没解出值，已留空待人工填`);
    }
    items.push({
      row_no: r,
      category,
      threshold_key: thresholdKey(category),
      name: String(row[8] == null ? "" : row[8]).trim(),
      value,
      tolerance: parsed.tolerance,
      voltage: parsed.voltage,
      current: parsed.current,
      power: parsed.power,
      polarity: parsed.polarity,
      extra: parsed.extra,
      pack: parsed.pack,
      manufacturer_part: manufacturerPart,
      footprint: String(row[10] == null ? "" : row[10]).trim(),
      quantity: Number(row[11]),
    });
  }
  if (items.length === 0) {
    return { ok: false, error: "表头认出来了，但一条明细都没找到（订购数量列没有正数？）", warnings };
  }
  return { ok: true, items, warnings, header_row: headerIdx };
}

/** 读文件（目前只支持 .xls —— 用户决定"只认对账单"，而导出的对账单就是 .xls） */
function parseStatementFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".xls") {
      const fs = require("fs");
      const rows = xlsBiff.readXlsRows(fs.readFileSync(filePath));
      return parseStatementRows(rows);
    }
    return { ok: false, error: `对账单目前只认 .xls（立创导出就是这种）；收到 ${ext || "无扩展名"}`, warnings: [] };
  } catch (exc) {
    return { ok: false, error: `读取对账单失败：${exc.message}`, warnings: [] };
  }
}

module.exports = {
  NEEDED_COLUMNS,
  REQUIRED_HEADERS,
  PACKAGING_WORDS,
  thresholdKey,
  parseProductName,
  assertIsStatement,
  isDetailRow,
  parseStatementRows,
  parseStatementFile,
};
