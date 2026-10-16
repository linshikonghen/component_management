"use strict";
/**
 * spec_parser.js — 从 BOM 的 `Comment` 提取规格建议值（plan §5.1）
 *
 * 定位（spec §1.3 边界 + AGENTS.md 项目硬规则 3）：
 *   解析结果**一律是"建议"**，不是事实。耐压/材质/容差必须由人在核对界面确认。
 *   因此本模块只做"能提就提、提不准就留空并说明"，**绝不猜**。
 *   尤其：`100` 这类纯数字**不自动推断单位**（可能是 10Ω 也可能是 100Ω）——
 *   按嘉立创官方建议记入"待确认"（spec §5.2）。
 *
 * 真实数据形态（plan §5.1，取自 E:\bom 的 4 份真实 BOM）：
 *   `10uF/50V X7R`      → value=10uF  voltage=50V   dielectric=X7R
 *   `100uF/35V 固态高频低阻` → value=100uF voltage=35V  note=固态高频低阻
 *   `10uF`（无斜杠）      → value=10uF，其余留空
 *   `HX-PH2.0-6PWZ-M`   → 不解析，整体作为型号建议（连接器）
 *
 * 另含 plan §3.1 的**单位归一化**单一实现（normalizeValue/normalizeText）。
 * 它放在这里而不是 compare.js/inventory.js，是因为"什么算同一个值"属于**单位语义**，
 * 与解析同域；放两份必然写歪（AGENTS.md 反重复规则）。去重键的组装（§3.1 dedupe_key）
 * 由 T7/T8 调用本函数，不另写一份。
 */

/** 介质/材质关键字（spec §5.2 判定键之一） */
const DIELECTRIC_LIST = ["X7R", "X5R", "C0G", "NP0", "Y5V", "X7T", "X6S", "X6T", "Z5U"];

/** 容差：`±10%` / `+/-5%` / `+-1%` 统一记为 `±N%` */
const TOLERANCE_RE = /(?:±|\+\/-|\+-)\s*(\d+(?:\.\d+)?)\s*%/;

/** 值：数字 + 单位，如 `10uF` `1k` `1000Ω`。**必须以数字开头**——
 *  这正是 `HX-PH2.0-6PWZ-M` 不被误判为值的原因（它以 H 开头）。 */
const VALUE_RE = /^([+-]?\d+(?:\.\d+)?)([a-zA-ZμΩ]{1,3})$/;

/** 值可用的单位后缀（大小写敏感：`uF` 与 `uH` 是两回事） */
const VALUE_UNITS = new Set([
  "F", "mF", "uF", "nF", "pF",
  "H", "mH", "uH", "nH",
  "Ω", "mΩ", "kΩ", "MΩ", "R", "k", "K", "M",
]);

const VOLTAGE_RE = /\b(\d+(?:\.\d+)?)\s*([kKmM]?)V\b/;

/** 纯数字、没有单位（`100`）。spec §5.2 要求**不推断**，只提示待确认。 */
const BARE_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;

/** 该值是否"缺单位"——缺单位就无法参与去重判定（spec §5.2）。 */
function needsUnit(text) {
  return BARE_NUMBER_RE.test(String(text == null ? "" : text).trim());
}

/** 把 Comment 切成候选词元：斜杠与空白都算分隔符 */
function tokenize(comment) {
  return comment.split(/[\/\s]+/).map((t) => t.trim()).filter((t) => t !== "");
}

function matchDielectric(token) {
  const upper = token.toUpperCase();
  return DIELECTRIC_LIST.find((d) => d === upper) || "";
}

/**
 * 解析 Comment。
 * @param {string} rawComment
 * @returns {{
 *   value: string, voltage: string, dielectric: string, tolerance: string, note: string,
 *   part_number_suggestion: string, is_part_number: boolean, confident: boolean
 * }}
 *   `confident` = 值、耐压都提到了，且**没有无法归类的残留文本**。
 *   注意 confident=false 不代表解析失败，只代表"需人工确认"（界面据此高亮）。
 */
function parseComment(rawComment) {
  const out = {
    value: "",
    voltage: "",
    dielectric: "",
    tolerance: "",
    note: "",
    part_number_suggestion: "",
    is_part_number: false,
    confident: false,
  };
  const comment = String(rawComment == null ? "" : rawComment).trim();
  if (comment === "") return out;

  // 容差先从**整串**里摘出来，再切词元。原因：`+/-5%` 里含 `/`，
  // 若先按 `/` 切分会把它劈成 `+` 与 `-5%`，容差就再也认不出来了。
  let working = comment;
  const tolMatch = TOLERANCE_RE.exec(working);
  if (tolMatch) {
    out.tolerance = `±${tolMatch[1]}%`;
    working = working.replace(tolMatch[0], " ");
  }

  const tokens = tokenize(working);
  const first = tokens[0] || "";
  const firstMatch = VALUE_RE.exec(first);
  if (firstMatch && VALUE_UNITS.has(firstMatch[2])) {
    out.value = first;
  } else if (needsUnit(first)) {
    // spec §5.2：纯数字**不自动推断单位**（`100` 可能是 10Ω 也可能是 100Ω）→
    // 原样作为值，由调用方提示"缺单位、待确认"，绝不猜。
    out.value = first;
  } else {
    // 不像值 → 整体当型号（连接器等），不做任何字段解析
    out.is_part_number = true;
    out.part_number_suggestion = comment;
    return out;
  }

  const leftovers = [];
  for (const token of tokens.slice(1)) {
    const dielectric = matchDielectric(token);
    if (dielectric && !out.dielectric) {
      out.dielectric = dielectric;
      continue;
    }
    const volt = VOLTAGE_RE.exec(token);
    if (volt && !out.voltage) {
      out.voltage = `${volt[1]}${volt[2] || ""}V`;
      continue;
    }
    leftovers.push(token);
  }
  out.note = leftovers.join(" ");
  out.confident = out.value !== "" && out.voltage !== "" && leftovers.length === 0 && out.note === "";
  return out;
}

/**
 * 单位归一化（plan §3.1）——**判定前必须做**，否则 `0.1uF` 与 `100nF` 会被当成两种料。
 * 归一目标不是"最小单位"，而是**尾数落在 [1,1000) 的工程写法**：
 *   `0.1uF` / `100nF` → `100nF`；`4700nF` / `4.7uF` → `4.7uF`；`1k` / `1000Ω` → `1kΩ`
 * 非数值（`HX-PH2.0-6PWZ-M`）只做大小写归一；纯数字（`100`）**原样返回**——
 * 不猜单位（spec §5.2），是否需要补单位由调用方按 warn 处理。
 */
function normalizeValue(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (text === "") return "";
  const compact = text.replace(/\s+/g, "");
  const m = VALUE_RE.exec(compact);
  if (!m || !VALUE_UNITS.has(m[2])) return compact.toLowerCase();
  const suffix = m[2];
  const num = Number(m[1]);
  // 以"基准单位"表示的倍数：F / H / Ω 三族互不相通
  const families = [
    { units: { F: 1, mF: 1e-3, uF: 1e-6, nF: 1e-9, pF: 1e-12 }, order: ["F", "mF", "uF", "nF", "pF"] },
    { units: { H: 1, mH: 1e-3, uH: 1e-6, nH: 1e-9 }, order: ["H", "mH", "uH", "nH"] },
    {
      units: { MΩ: 1e6, M: 1e6, kΩ: 1e3, K: 1e3, k: 1e3, Ω: 1, R: 1, mΩ: 1e-3 },
      order: ["MΩ", "kΩ", "Ω", "mΩ"],
    },
  ];
  for (const family of families) {
    if (!Object.prototype.hasOwnProperty.call(family.units, suffix)) continue;
    const base = num * family.units[suffix];
    for (const unit of family.order) {
      const scaled = base / family.units[unit];
      if (Math.abs(scaled) >= 1 - 1e-12) return formatNumber(scaled) + unit;
    }
    const smallest = family.order[family.order.length - 1];
    return formatNumber(base / family.units[smallest]) + smallest;
  }
  return compact.toLowerCase();
}

/** 数值取 6 位有效数字再去尾零，避免 `4.699999999999999uF` 这类浮点噪音。 */
function formatNumber(n) {
  return String(Number(n.toPrecision(6)));
}

/** 文本类字段的归一（封装/耐压/材质/容差）：去空格 + 小写。 */
function normalizeText(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, "").toLowerCase();
}

module.exports = {
  parseComment,
  normalizeValue,
  normalizeText,
  needsUnit,
  DIELECTRIC_LIST,
  VALUE_UNITS,
};
