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

/**
 * 容差：`±10%` / `+/-5%` / `+-1%` / 裸 `1%` 统一记为 `±N%`。
 * **带符号的优先**：`1k/0.5% 0603 +/-5%` 这种串里两个百分号，第一个是"精度等级"的裸写法，
 * 带 `+/-` 的那个才是容差 → 先找带符号的，找不到才接受裸 `N%`（`精度:1%` 要用）。
 */
const TOLERANCE_SIGNED_RE = /(?:±|\+\/-|\+-)\s*(\d+(?:\.\d+)?)\s*%/;
const TOLERANCE_BARE_RE = /(\d+(?:\.\d+)?)\s*%/;

function matchTolerance(text) {
  const s = String(text == null ? "" : text);
  return TOLERANCE_SIGNED_RE.exec(s) || TOLERANCE_BARE_RE.exec(s);
}

/** 容差归一（单一实现：BOM 的 Comment 与对账单的商品名称都用它） */
function normalizeTolerance(text) {
  const m = matchTolerance(text);
  return m ? `±${m[1]}%` : "";
}

/**
 * 值：数字 + 单位。**必须以数字开头**——这正是 `HX-PH2.0-6PWZ-M` 不被误判为值的原因。
 * ⚠️ 值文法已由 `parseValueToken()` 统一实现（支持 `100KΩ` / `4K7` / `R100` 等电阻写法），
 *    这里的正则只保留给"是不是以数字开头"的快速判断，**判据不要另写一份**。
 */
const VALUE_RE = /^([+-]?\d+(?:\.\d+)?)([a-zA-ZμΩ]{1,3})$/;

/** 值可用的单位后缀（大小写敏感：`uF` 与 `uH` 是两回事）。由单位表派生，供外部/测试引用。 */
const VALUE_UNITS = new Set(["F", "mF", "uF", "nF", "pF", "H", "mH", "uH", "nH", "Ω", "mΩ", "kΩ", "MΩ", "R", "k", "K", "M"]);

const MICRO_PREFIXES = "u\u00b5\u03bc"; // u µ μ（三种写法都见过）

/** 三个单位族：换算到基准量（F / H / Ω），并给出规范写法顺序 */
const VALUE_FAMILIES = [
  { family: "F", base: "F", order: [["F", 1], ["mF", 1e-3], ["uF", 1e-6], ["nF", 1e-9], ["pF", 1e-12]] },
  { family: "H", base: "H", order: [["H", 1], ["mH", 1e-3], ["uH", 1e-6], ["nH", 1e-9]] },
  { family: "R", base: "Ω", order: [["MΩ", 1e6], ["kΩ", 1e3], ["Ω", 1], ["mΩ", 1e-3]] },
];

/**
 * 单位后缀 → { family, scale }；认不出返回 null。
 *
 * 关键细节（都来自实测的立创/工程写法）：
 *   · **`m` 与 `M` 大小写有意义**：`mΩ`=毫欧、`MΩ`=兆欧。原来的实现把后缀整串 lowerCase，
 *     `100KΩ` 变成了 `100kω`（Ω 被小写成 ω）→ 与 `100K` 的归一结果不同 → **同一颗料的去重键不同** ✗
 *   · 电阻的裸字母也算单位：`1k` `100K` `1M` `0R`（BOM 里很常见）
 *   · 电容/电感的单位字母大小写不敏感（`NF` 与 `nF` 同义），但前缀 m/u/n/p 的含义不变
 */
function matchUnit(suffix) {
  const s = String(suffix == null ? "" : suffix);
  // Ω 族带 Ω/ohm/R 的写法
  let m = /^(m|k|K|M|G)?(Ω|ω|ohm|Ohm|OHM|R|r)$/.exec(s);
  if (m) {
    const pre = m[1] || "";
    const scale = pre === "" ? 1
      : pre === "m" ? 1e-3
        : (pre === "k" || pre === "K") ? 1e3
          : pre === "M" ? 1e6 : 1e9; // G
    return { family: "R", scale };
  }
  // Ω 族的裸字母
  if (s === "k" || s === "K") return { family: "R", scale: 1e3 };
  if (s === "M") return { family: "R", scale: 1e6 };
  if (s === "m") return { family: "R", scale: 1e-3 };
  if (s === "R" || s === "r") return { family: "R", scale: 1 };
  // F / H 族（前缀 m/u/µ/μ/n/p，单位字母大小写不敏感）
  m = new RegExp("^(m|[" + MICRO_PREFIXES + "]|n|p)?(f)$", "i").exec(s);
  if (m) return { family: "F", scale: unitPrefixScale(m[1]) };
  m = new RegExp("^(m|[" + MICRO_PREFIXES + "]|n|p)?(h)$", "i").exec(s);
  if (m) return { family: "H", scale: unitPrefixScale(m[1]) };
  return null;
}

function unitPrefixScale(prefix) {
  const p = String(prefix == null ? "" : prefix).toLowerCase();
  if (p === "") return 1;
  if (p === "m") return 1e-3;
  if (MICRO_PREFIXES.includes(p)) return 1e-6;
  if (p === "n") return 1e-9;
  if (p === "p") return 1e-12;
  return 1;
}

/**
 * 把一段文本解析成「值」：{ family, base }（base = 换算到 F / H / Ω 的量）；不是值返回 null。
 *
 * 覆盖的真实写法（都有测试）：
 *   ① 标准式 `100nF` `4.7kΩ` `100KΩ` `10mΩ` `1M` `1k` `0R`
 *   ② **EIA 短写法**（单位字母当小数点）`4K7` = 4.7kΩ、`1K50` = 1.50kΩ、`4u7` = 4.7uH、`1R5` = 1.5Ω
 *   ③ **R 当小数点**（EIA）`R100` = 0.100Ω、`0R05` = 0.05Ω、`0R` = 0Ω
 *   ④ 纯数字（`0603` `100`）**不是值**（spec §5.2：缺单位不推断）
 *   ⑤ 型号样式（`1N4148W` `SMBJ18CA`）**不是值**（以字母开头/结尾带字母）
 */
function parseValueToken(text) {
  const compact = String(text == null ? "" : text).replace(/\s+/g, "");
  if (compact === "") return null;
  // ① 标准式
  let m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/.exec(compact);
  if (m && m[2] !== "") {
    const unit = matchUnit(m[2]);
    if (unit) return { family: unit.family, base: Number(m[1]) * unit.scale };
  }
  // ② EIA 短写法：字母当小数点（必须以数字结尾，避免把 `1N4148W` 当值）
  m = /^(\d+)([A-Za-z\u00b5\u03bcΩ]+)(\d+)$/.exec(compact);
  if (m) {
    const unit = matchUnit(m[2]);
    if (unit) return { family: unit.family, base: Number(m[1] + "." + m[3]) * unit.scale };
  }
  // ③ R 当小数点
  m = /^R(\d+)$/.exec(compact);
  if (m) return { family: "R", base: Number("0." + m[1]) };
  m = /^(\d+)R(\d+)$/.exec(compact);
  if (m) return { family: "R", base: Number(m[1] + "." + m[2]) };
  m = /^(\d+)R$/.exec(compact);
  if (m) return { family: "R", base: Number(m[1]) };
  return null;
}

/** 基准量 → 工程写法（尾数落在 [1,1000)）；0 一律 `0Ω/0F/0H`（`0R` 与 `0Ω` 归一成同一个） */
function formatValue(family, base) {
  const fam = VALUE_FAMILIES.find((f) => f.family === family);
  if (!fam) return String(base);
  if (base === 0) return "0" + fam.base;
  for (const [unit, scale] of fam.order) {
    const scaled = base / scale;
    if (Math.abs(scaled) >= 1 - 1e-12) return formatNumber(scaled) + unit;
  }
  const last = fam.order[fam.order.length - 1];
  return formatNumber(base / last[1]) + last[0];
}

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
  const tolMatch = matchTolerance(working);
  if (tolMatch) {
    out.tolerance = normalizeTolerance(tolMatch[0]);
    working = working.replace(tolMatch[0], " ");
  }

  const tokens = tokenize(working);
  // **扫全部词元找一个"像值"的**，不再只看第一个：BOM 里 `0603 100nF` 这种"封装在前"的写法
  // 原来会把 `0603`（缺单位的纯数字）当成值 ✗。只有在**一个值都没有**时才退回"纯数字待确认"。
  const valueIdx = tokens.findIndex((tok) => looksLikeValue(tok));
  if (valueIdx >= 0) {
    out.value = tokens[valueIdx];
  } else if (needsUnit(tokens[0] || "")) {
    // spec §5.2：纯数字**不自动推断单位**（`100` 可能是 10Ω 也可能是 100Ω）→
    // 原样作为值，由调用方提示"缺单位、待确认"，绝不猜。
    out.value = tokens[0];
  } else {
    // 不像值 → 整体当型号（连接器等），不做任何字段解析
    out.is_part_number = true;
    out.part_number_suggestion = comment;
    return out;
  }

  const leftovers = [];
  for (const [i, token] of tokens.entries()) {
    if (i === valueIdx) continue;
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
  const token = parseValueToken(compact);
  if (token) return formatValue(token.family, token.base);
  return compact.toLowerCase();
}

/** 数值取 6 位有效数字再去尾零，避免 `4.699999999999999uF` 这类浮点噪音。 */
function formatNumber(n) {
  return String(Number(n.toPrecision(6)));
}

/** 文本类字段的归一（封装/耐压/材质/容差）：去空格 + 小写。 */
function normalizeText(raw) {
  return String(raw == null ? "" : raw).replace(/\+\/-/g, "\u00b1").replace(/\+-/g, "\u00b1").replace(/\s+/g, "").toLowerCase();
}

/**
 * 这个 token 看起来是不是「值」？（数字开头 + 已知单位）
 *
 * 为什么需要它：立创对账单里，电阻/开关那几行的**商品名称是描述**（「厚膜电阻」「钮子开关」），
 * 真正的值（阻值/容值）只在**商品型号**里 —— 而项目铁律是**禁止从型号猜参数** ✗，
 * 所以解析必须**留空 + 让人工填**，不能把描述冒充成值 ✗。
 * 判据只此一处（复用本模块的 VALUE_RE / VALUE_UNITS），对账单解析直接引用，不另写正则。
 */
function looksLikeValue(text) {
  return parseValueToken(text) !== null;
}

module.exports = {
  parseComment,
  looksLikeValue,
  parseValueToken,
  normalizeValue,
  normalizeText,
  normalizeTolerance,
  needsUnit,
  DIELECTRIC_LIST,
  VALUE_UNITS,
};
