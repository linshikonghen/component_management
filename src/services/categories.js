"use strict";
/**
 * categories.js — 分类的**单一来源**（spec §5.3 预置分类表 + 立创商品类型映射）
 *
 * 为什么要有这个文件（背景，写给后来的人）：
 *   · 原先 `category` 有**两种表示** —— 手动录入存**位号前缀**（`R` ✗）、
 *     对账单入库存**立创商品类型中文名**（`贴片电阻` ✗）→ 同一类料阈值标准不同、界面显示混乱。
 *   · 用户 2026-10-16 裁定 **① 统一为立创中文名** ✓：`category` 一律存中文名；
 *     前缀只作为**阈值映射的内部键**，不再落库 ✗。
 *   · 又因为 spec §5.3 的阈值类只有 **14 个**，而用户库里的 13 个立创类型
 *     **几乎全能映射到现有类**（排母→H、MOS/三极管→Q、各类开关→KEY/SW、自恢复保险丝→F、
 *     TVS→D、功率与一体成型电感→L、铝电解→C、DC-DC 与功放→U）→
 *     **不需要扩 `default_min_quantity` 的键集** ✗，只需要这一张映射表 ✓。
 *
 * 本模块**纯数据 + 纯函数**：不 require 任何东西、不碰 fs（与 renderer/model 的约定一致）✓。
 * ⚠️ 下表的阈值**逐字抄自 spec §5.3**（R 是 50、晶振是 3、蜂鸣器是 2、排针/排母是 10）——
 *    改这里就必须同步改 spec（门上会挡：tests/test_categories.js 会逐项比对）✓
 */

/** spec §5.3 预置分类表（逐字抄，含默认阈值） */
const CLASSES = [
  { key: "C", label: "电容", prefixes: ["C"], min: 20, note: "" },
  { key: "R", label: "电阻", prefixes: ["R"], min: 50, note: "用量最大、单价最低" },
  { key: "L", label: "电感", prefixes: ["L"], min: 10, note: "" },
  { key: "D", label: "二极管", prefixes: ["D"], min: 10, note: "" },
  { key: "Q", label: "三极管/MOS", prefixes: ["Q"], min: 10, note: "" },
  { key: "U", label: "集成电路", prefixes: ["U"], min: 5, note: "单价高，阈值低" },
  { key: "CN", label: "连接器", prefixes: ["CN", "J", "P"], min: 5, note: "" },
  { key: "X", label: "晶振", prefixes: ["X", "Y"], min: 3, note: "" },
  { key: "KEY", label: "按键/开关", prefixes: ["KEY", "SW"], min: 5, note: "" },
  { key: "F", label: "保险丝", prefixes: ["F"], min: 5, note: "" },
  { key: "BUZZER", label: "蜂鸣器", prefixes: ["BUZZER"], min: 2, note: "" },
  { key: "LED", label: "指示灯", prefixes: ["LED"], min: 10, note: "" },
  { key: "H", label: "排针/排母", prefixes: ["H"], min: 10, note: "" },
  { key: "OTHER", label: "其它", prefixes: [], min: 5, note: "兜底" },
];

/** 立创商品类型（中文名）→ 上面 14 类中的某一类（用户库里出现过的全部覆盖 ✓） */
const LCSC_TO_CLASS = {
  "贴片电容(MLCC)": "C",
  "贴片型铝电解电容": "C",
  "直插铝电解电容": "C",
  // 用户裁定（2026-10-16）：对账单里真实出现的 `固态电容` 归入**电容**类（阈值 20）。
  // 注意：spec §5.3 的阈值类里没有"铝电解电容"这一类（只有「电容」C=20）——
  // 用户原话是"归铝电解电容"，落地即"其它铝电解/固态电容同样进 C 类"，与贴片/直插铝电解一致 ✓
  "固态电容": "C",
  "贴片电阻": "R",
  "贴片电感": "L",
  "功率电感": "L",
  "一体成型电感": "L",
  "二极管": "D",
  "发光二极管": "LED",
  "静电和浪涌保护(TVS/ESD)": "D",
  "三极管": "Q",
  "场效应管(MOSFET)": "Q",
  "集成电路": "U",
  "DC-DC电源芯片": "U",
  "音频功率放大器": "U",
  "晶振": "X",
  "连接器": "CN",
  "排母": "H",
  "排针": "H",
  "翘板船型开关": "KEY",
  "滑动开关": "KEY",
  "钮子开关": "KEY",
  "自恢复保险丝": "F",
  "蜂鸣器": "BUZZER",
  "测试点": "OTHER",
  // ---- 2026-10-17 补：用户**真实对账单**（E:\edge 两份，73 + 25 行）里出现、此前未收录的立创商品类型。
  // 归类依据是"名字就是这一类"（与 spec §5.3 的类名/位号前缀一一对应），不是新的业务判断：
  "三极管(BJT)": "Q",          // 三极管 → Q（§5.3「三极管/MOS」）
  "发光二极管/LED": "LED",     // LED → LED（§5.3「指示灯」）
  "肖特基二极管": "D",         // 二极管 → D
  "稳压二极管": "D",           // 二极管 → D
  "线对板针座": "CN",          // 针座/连接器 → CN
  "电源连接器/插头": "CN",     // 连接器 → CN
  "轻触开关": "KEY",           // 开关 → KEY
  "拨码开关": "KEY",           // 开关 → KEY
  "线性稳压器(LDO)": "U",      // 芯片 → U（§5.3「集成电路」）
  "模拟开关/多路复用器": "U",  // 芯片 → U
  // 用户裁定（2026-10-17）：「按电位器来，阈值 5」——电位器**不塞进电阻类**
  // （§5.3「电阻」类阈值是 50，那是给贴片电阻的用量口径，电位器按 50 备货不合理）
  // 归兜底类 `OTHER`（阈值 5），但作为**已知商品类型**放行落库、并进下拉（否则编辑这条料会被判乱输）
  "可调电阻/电位器": "OTHER",
};

const BY_KEY = new Map(CLASSES.map((c) => [c.key, c]));
const BY_PREFIX = new Map();
for (const c of CLASSES) for (const p of c.prefixes) BY_PREFIX.set(p, c);

/** 中文名（或已存的类名）→ 分类条目；认不出一律 `其它`（兜底，不猜 ✗） */
function resolve(name) {
  const text = String(name == null ? "" : name).trim();
  if (text === "") return BY_KEY.get("OTHER");
  const byLcsc = LCSC_TO_CLASS[text];
  if (byLcsc) return BY_KEY.get(byLcsc);
  const byKey = BY_KEY.get(text);
  if (byKey) return byKey;
  // 旧数据兼容：库里存的可能是位号前缀（R / C / SW …）→ 反向查
  const byPre = BY_PREFIX.get(text.toUpperCase());
  if (byPre) return byPre;
  const byLabel = CLASSES.find((c) => c.label === text);
  return byLabel || BY_KEY.get("OTHER");
}

/** 默认阈值（分类默认；个体阈值由器件自带，此处只给"继承值"） */
function minOf(name) {
  return resolve(name).min;
}

/**
 * 这个 category 值是不是"可接受的落库值"。
 *
 * 可接受 = 立创商品类型中文名 ∪ 旧位号前缀键 ∪ 类键/类名 ∪ `_default` 哨兵。
 *
 * ⚠️ 为什么"认得的立创类型"和"映射得上的立创类型"必须分开看（实测踩到）：
 *   对账单里会出现**本表还没收录**的商品类型（实测：`固态电容`）——
 *   它照样会被入库（对账单是**事实**，spec FR-8.6 不许改写/丢弃），阈值走 `_default` 兜底。
 *   可是手动录入/编辑这条料时，如果服务端把 `固态电容` 判成"乱输"直接拒绝，
 *   用户就**再也存不回自己的数据**（同一份器件没法编辑）→ 这是个真窟窿。
 *   所以：**认不认得**用于阈值映射（认不出就兜底），**落库值合不合法**用下面这张名单，
 *   包含"已知的立创商品类型"。名单外的真·乱输依旧拒绝并明确报错 ✓
 */
const KNOWN_PRODUCT_TYPES = [
  ...Object.keys(LCSC_TO_CLASS),
  // 对账单里实测出现、本表**暂时**决定不了归类的立创商品类型（**照样会被入库** —— 对账单是事实）。
  // 这里只负责"落库合法性"（否则用户编辑这条料会被判成乱输、数据存不回去）；
  // 阈值继续走 `_default` 兜底，**绝不替用户猜**（要归类得由用户裁定）✗
  // （`固态电容` 已由用户裁定归入电容类，因此升格到 LCSC_TO_CLASS，不再列在这里 ✓）
];

/** 认得的立创商品类型（含尚未映射到阈值类的，如 `固态电容`） */
function isKnownProductType(name) {
  return KNOWN_PRODUCT_TYPES.includes(String(name == null ? "" : name).trim());
}

/** 这个 category 值是不是"可接受的落库值"（中文名 ∪ 旧前缀键 ∪ 类名 ∪ 已知立创类型） */
function isAcceptable(name) {
  const text = String(name == null ? "" : name).trim();
  if (text === "") return false;
  if (text === "_default") return true; // 项目既有哨兵：没位号 → _default（test_parts 明确断言）
  if (LCSC_TO_CLASS[text] || BY_KEY.get(text)) return true;
  if (BY_PREFIX.get(text.toUpperCase())) return true;
  if (isKnownProductType(text)) return true;
  return CLASSES.some((c) => c.label === text);
}

/** 中文名 → default_min_quantity 的键（用于旧设置表；旧表就是这 14 个键 ✓） */
function settingsKeyOf(name) {
  return resolve(name).key;
}

const API = { CLASSES, LCSC_TO_CLASS, KNOWN_PRODUCT_TYPES, resolve, minOf, isAcceptable, isKnownProductType, settingsKeyOf };
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof globalThis !== "undefined") globalThis.Categories = API;
