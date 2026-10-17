"use strict";
/**
 * T88 见证：**电阻与 MOS 管的识别**（用户 2026-10-17 报"格式和电容不同、识别有问题"）
 *
 * 真实数据来源：用户机器上的两份立创对账单（E:\edge，73 + 25 行）——
 * 本测试把**真实商品名称字符串**抄进来做矩阵，不依赖那两个文件（那是用户私有文件，不进夹具）：
 *   · 电容：`100nF ±10% 100V 编带`（值在最前，一直能认）
 *   · 电阻：`10Ω ±5% 100mW 厚膜电阻 编带`（值在前）
 *           `厚膜电阻 200kΩ ±1% 100mW 编带`（**描述在前** ← 原来值会丢 ✗）
 *   · MOS：`1个P沟道 耐压:30V 电流:90A 编带`（**标签式** ← 原来整行一个字段都认不出 ✗）
 *   · 三极管：`电流:500mA 电压:25V 编带`
 *
 * 覆盖四层：① 值文法（归一/判据）② 商品名称 → 字段 ③ 分类与阈值 ④ 与库中料对得上
 * 以及"**不猜**"的反例（描述不当值、`±12V` 不当容差、测试条件不当电流、歧义不猜）。
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const sp = require(path.join(ROOT, "src", "services", "spec_parser"));
const st = require(path.join(ROOT, "src", "services", "lcsc_statement"));
const sm = require(path.join(ROOT, "src", "services", "statement_match"));
const C = require(path.join(ROOT, "src", "services", "categories"));
const M = require(path.join(ROOT, "renderer", "model", "parts_model"));
const statementModel = require(path.join(ROOT, "renderer", "model", "statement_model"));
const { createHandlers } = require(path.join(ROOT, "src", "ipc", "handlers"));
const { createStore } = require(path.join(ROOT, "src", "services", "store"));

const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }
function section(title) { QUEUE.push({ section: title }); }
let passCount = 0;
const failures = [];

async function runQueue() {
  for (const q of QUEUE) {
    if (q.section) { console.log("\n=== " + q.section + " ==="); continue; }
    try { await q.fn(); passCount += 1; console.log("  PASS  " + q.name); }
    catch (exc) {
      failures.push({ name: q.name, message: String(exc && exc.message ? exc.message : exc) });
      console.log("  FAIL  " + q.name);
      console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
    }
  }
}

/* ============================================================ §1 值文法 */

section("§1 值文法：同一颗电阻的各种写法必须归一成同一个键（否则库里明明有、导入却说没有）");

const VALUE_EQUIV = [
  ["100K", "100KΩ"], ["100KΩ", "100kΩ"], ["100k", "100kΩ"], ["1000Ω", "1kΩ"],
  ["4K7", "4.7kΩ"], ["1K50", "1.5kΩ"], ["4R7", "4.7Ω"], ["1R5", "1.5Ω"],
  ["R100", "100mΩ"], ["0R05", "50mΩ"], ["0R", "0Ω"], ["0Ω", "0Ω"],
  ["100mΩ", "100mΩ"], ["1M", "1MΩ"], ["1MΩ", "1MΩ"],
  ["100nF", "0.1uF"], ["4.7uF", "4700nF"], ["10uF", "10uF"], ["47uH", "47uH"], ["1000nH", "1uH"],
];
for (const [a, b] of VALUE_EQUIV) {
  t(`归一：${a} == ${b}`, () => {
    assert.strictEqual(sp.normalizeValue(a), sp.normalizeValue(b),
      `${a}(${sp.normalizeValue(a)}) 与 ${b}(${sp.normalizeValue(b)}) 应是同一个值`);
  });
}

t("**Ω 大小写不敏感**（`100KΩ` 曾经归一成 `100kω`，与 `100K` 对不上 ✗）", () => {
  assert.strictEqual(sp.normalizeValue("100KΩ"), "100kΩ");
  assert.strictEqual(sp.normalizeValue("100kΩ"), "100kΩ");
  assert.strictEqual(sp.normalizeValue("100KΩ"), sp.normalizeValue("100K"));
});

t("判据：值是值；耐压/电流/功率/型号/纯数字都**不是**值（spec §5.2 不猜单位）", () => {
  for (const v of ["100KΩ", "4K7", "R100", "0R05", "10mΩ", "100nF", "47uH"]) {
    assert.strictEqual(sp.looksLikeValue(v), true, v + " 应算值");
  }
  for (const v of ["30V", "4.3A", "1.25W", "1/10W", "100mW", "0603", "100", "1N4148W", "SMBJ18CA", "厚膜电阻", "1个P沟道"]) {
    assert.strictEqual(sp.looksLikeValue(v), false, v + " 不该算值");
  }
});

/* ================================================== §2 商品名称 → 字段 */

section("§2 真实商品名称 → 值/容差/耐压/电流/功率/极性（顺序无关、标签式也认）");

const NAMES = [
  // [商品名称, 期望字段]
  ["100nF ±10% 100V 编带", { value: "100nF", tolerance: "±10%", voltage: "100V" }],
  ["10Ω ±5% 100mW 厚膜电阻 编带", { value: "10Ω", tolerance: "±5%", power: "100mW" }],
  ["4.7kΩ ±1% 100mW 厚膜电阻 编带", { value: "4.7kΩ", tolerance: "±1%", power: "100mW" }],
  ["厚膜电阻 200kΩ ±1% 100mW 编带", { value: "200kΩ", tolerance: "±1%", power: "100mW" }],
  ["厚膜电阻 110kΩ ±1% 100mW 编带", { value: "110kΩ", tolerance: "±1%", power: "100mW" }],
  ["50kΩ ±25% 编带", { value: "50kΩ", tolerance: "±25%" }],
  ["1个P沟道 耐压:30V 电流:90A 编带", { voltage: "30V", current: "90A", polarity: "P沟道" }],
  ["1个P沟道 耐压:30V 电流:4A 编带", { voltage: "30V", current: "4A", polarity: "P沟道" }],
  ["电流:500mA 电压:25V 编带", { voltage: "25V", current: "500mA" }],
  ["电压:40V 电流:5A 编带", { voltage: "40V", current: "5A" }],
  ["24V 3A 1812自恢复 编带", { voltage: "24V", current: "3A" }],
  ["独立式 耐压:16V 编带", { voltage: "16V" }],
];
for (const [name, want] of NAMES) {
  t(`识别：${name}`, () => {
    const p = st.parseProductName(name);
    for (const [field, expected] of Object.entries(want)) {
      assert.strictEqual(p[field], expected, `${field} 应为 ${expected}，实际 ${JSON.stringify(p[field])}`);
    }
  });
}

t("**反例（不猜）**：`±12V` 是栅源电压，不是容差；`0.1uA@11.2V` 是测试条件，不是电流", () => {
  const mos = st.parseProductName("1个N沟道 20V 6A ±12V");
  assert.strictEqual(mos.tolerance, "", "±12V 不该被当成容差");
  assert.ok(mos.extra.includes("±12V"), "认不出的词元要留在 extra 里给人看：" + mos.extra);
  const zener = st.parseProductName("独立式 耐压:16V 电流:0.1uA@11.2V 编带");
  assert.strictEqual(zener.voltage, "16V");
  assert.strictEqual(zener.current, "", "带测试条件的漏电流不该塞进「电流」");
  assert.ok(zener.extra.includes("0.1uA@11.2V"), zener.extra);
});

t("**反例（有歧义就不猜）**：LDO 的 `3.3V 500mA 5.5V` —— 两个电压（输出/输入）都不落耐压", () => {
  const ldo = st.parseProductName("3.3V 500mA 5.5V 编带");
  assert.strictEqual(ldo.voltage, "", "两个电压候选有歧义 → 留 extra 交人判断");
  assert.strictEqual(ldo.current, "500mA", "电流只有一个候选 → 可以认");
  assert.ok(ldo.extra.includes("3.3V") && ldo.extra.includes("5.5V"), ldo.extra);
});

t("**反例（描述/型号不是值）**：`厚膜电阻 0603 ±1% 编带`、`1个P沟道 SOT-23`、`100 0603` 值都留空", () => {
  for (const name of ["厚膜电阻 0603 ±1% 编带", "1个P沟道 SOT-23", "100 0603", "降压型 TSOT-23-8"]) {
    assert.strictEqual(st.parseProductName(name).value, "", name + " 不该产出值");
  }
});

/* ============================================== §3 分类与阈值（真实类型） */

section("§3 真实对账单里的商品类型：分类与阈值");

t("用户第 3 点涉及的族都有明确阈值类：电阻→R、MOS/BJT→Q、各二极管→D、开关→KEY", () => {
  const want = {
    "贴片电阻": "R", "场效应管(MOSFET)": "Q", "三极管(BJT)": "Q",
    "肖特基二极管": "D", "稳压二极管": "D", "发光二极管/LED": "LED",
    "轻触开关": "KEY", "拨码开关": "KEY", "线对板针座": "CN", "电源连接器/插头": "CN",
    "线性稳压器(LDO)": "U", "模拟开关/多路复用器": "U",
  };
  for (const [type, key] of Object.entries(want)) {
    assert.strictEqual(C.settingsKeyOf(type), key, type + " 应归 " + key + " 类");
    assert.ok(C.isAcceptable(type), type + " 必须能存能改");
    assert.ok(M.CATEGORY_OPTIONS.some((o) => o.key === type), "下拉里要有 " + type + "（否则用户改不了）");
  }
});

t("阈值按类走：电阻 R=50、MOS Q=10、二极管 D=10、LED=10、开关 KEY=5", () => {
  assert.strictEqual(C.minOf("贴片电阻"), 50);
  assert.strictEqual(C.minOf("场效应管(MOSFET)"), 10);
  assert.strictEqual(C.minOf("三极管(BJT)"), 10);
  assert.strictEqual(C.minOf("稳压二极管"), 10);
  assert.strictEqual(C.minOf("轻触开关"), 5);
});

t("**用户裁定（2026-10-17）**：`可调电阻/电位器` 按电位器来 —— 阈值 5，**不塞进电阻类**", () => {
  // 用户原话："1，按电位器来，阈值5"
  assert.strictEqual(C.minOf("可调电阻/电位器"), 5, "阈值就是 5");
  assert.strictEqual(C.settingsKeyOf("可调电阻/电位器"), "OTHER", "走兜底类（不冒充电阻类）");
  assert.notStrictEqual(C.minOf("可调电阻/电位器"), C.minOf("贴片电阻"), "电阻类阈值 50 不适用于电位器");
  assert.ok(C.isAcceptable("可调电阻/电位器"), "必须能存能改（否则编辑这条料会被判成乱输）");
  assert.ok(C.KNOWN_PRODUCT_TYPES.includes("可调电阻/电位器"), "要进已知商品类型名单");
  assert.ok(M.CATEGORY_OPTIONS.some((o) => o.key === "可调电阻/电位器"), "下拉里要能选到它");
});

t("对账单 29 种真实商品类型现在**全部**有明确归属（不再有静默兜底）", () => {
  // 逐项来自用户真实对账单（73 + 25 行）里出现过的分类名；每一项都要"能存、能改、有阈值"
  const REAL_TYPES = [
    "贴片电阻", "贴片电容(MLCC)", "贴片型铝电解电容", "直插铝电解电容", "固态电容",
    "功率电感", "一体成型电感", "排母", "排针", "线对板针座", "电源连接器/插头",
    "场效应管(MOSFET)", "三极管(BJT)", "肖特基二极管", "稳压二极管", "发光二极管/LED",
    "静电和浪涌保护(TVS/ESD)", "自恢复保险丝", "蜂鸣器", "晶振",
    "翘板船型开关", "滑动开关", "钮子开关", "轻触开关", "拨码开关",
    "线性稳压器(LDO)", "模拟开关/多路复用器", "DC-DC电源芯片", "音频功率放大器", "可调电阻/电位器",
  ];
  for (const type of REAL_TYPES) {
    assert.ok(C.isAcceptable(type), type + " 必须能存能改");
    assert.ok(M.CATEGORY_OPTIONS.some((o) => o.key === type), type + " 必须在下拉里");
    const min = C.minOf(type);
    assert.strictEqual(typeof min, "number", type + " 要有阈值");
    assert.ok(min >= 0, type + " 阈值不能为负");
  }
});

/* ============================================== §4 与库里的料对得上 */

section("§4 手录的电阻与对账单行能对上（否则每次导入都会多一条重复料）");

t("手录 `100K / 0603`（分类存的是旧位号 R、没填型号）vs 对账单 `100kΩ / FRC0603F1003TS` → **疑似**交人裁决", () => {
  const parts = [{ id: "p_0026", category: "R", value: "100K", footprint: "0603", tolerance: "±1%", voltage: "", manufacturer_part: "" }];
  const items = [{
    row_no: 5, category: "贴片电阻", value: "100kΩ", tolerance: "±1%", voltage: "",
    manufacturer_part: "FRC0603F1003TS", footprint: "0603", quantity: 100,
  }];
  const r = sm.matchStatement(items, parts);
  assert.strictEqual(r.missing.length, 0, "不该当成新增（那就是重复料）");
  assert.strictEqual(r.matched.length, 0, "参数不全等 → 不自动合并");
  assert.strictEqual(r.suspected.length, 1, "应进**人工裁决**桶");
  assert.ok(r.suspected[0].candidates[0].diff.join("；").includes("manufacturer_part"),
    "差异清单要说清差在型号：" + JSON.stringify(r.suspected[0].candidates[0].diff));
});

t("分类的两种表示（旧位号 `R` vs 中文名 `贴片电阻`）在对账时等价", () => {
  assert.strictEqual(sm.partKey({ category: "R" }).category, sm.itemKey({ category: "贴片电阻" }).category);
  assert.strictEqual(sm.partKey({ category: "贴片电容（MLCC）" }).category, sm.itemKey({ category: "贴片电容(MLCC)" }).category);
});

t("参数齐全时按归一后的值**严格命中**（`100K` 与 `100kΩ` 视为同一颗）", () => {
  const part = { category: "贴片电阻", value: "100K", tolerance: "±1%", voltage: "50V", manufacturer_part: "FRC0603F1003TS", footprint: "0603" };
  const item = { category: "贴片电阻", value: "100kΩ", tolerance: "+/-1%", voltage: "50V", manufacturer_part: "FRC0603F1003TS", footprint: "0603" };
  const r = sm.matchStatement([item], [part]);
  assert.strictEqual(r.matched.length, 1, "归一后应严格命中");
});

/* ===================================== §5 端到端：核对表看得见、入库落得下 */

section("§5 端到端：识别结果进核对表（可见可改）→ 入库写进器件");

function freshEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cm_recognize_"));
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [], now: () => new Date(2026, 9, 17, 10, 0, 0) });
  return { db, handlers: env.handlers, base };
}

t("核对表列里**看得见**电流/功率/极性，且都是可改字段（识别了却看不见=没识别）", () => {
  const keys = statementModel.COLUMNS.map((c) => c.key);
  for (const k of ["current", "power", "polarity"]) {
    assert.ok(keys.includes(k), "核对表要有 " + k + " 列");
    assert.ok(statementModel.EDITABLE_FIELDS.includes(k), k + " 要可改");
    assert.ok(statementModel.COLUMNS.find((c) => c.key === k).editable, k + " 列要标 editable");
  }
});

t("核对表要有「其它（未自动识别）」列：认不出归属的词元必须看得见，不能默默丢掉", () => {
  const col = statementModel.COLUMNS.find((c) => c.key === "extra");
  assert.ok(col, "要有 extra 列");
  assert.strictEqual(col.editable, false, "它是原始词元，只读（要改就改对应字段）");
  const rows = statementModel.buildRows({
    items: [{ row_no: 2, category: "排母", value: "", extra: "间距:2.54mm 2x4P 直插", quantity: 10,
      manufacturer_part: "PM254V-11-04-H85", footprint: "HDR-TH_4P-P2.54-V-F" }],
    matched: [], suspected: [], missing: [2],
  });
  assert.strictEqual(rows[0].extra, "间距:2.54mm 2x4P 直插", "词元要原样带到行上给界面显示");
});

t("MOS 行：核对表带出耐压/电流/极性；人工改电流后 overrides 带上它", () => {
  const parsed = {
    items: [{
      row_no: 3, category: "场效应管(MOSFET)", threshold_key: "Q", name: "1个P沟道 耐压:30V 电流:90A 编带",
      value: "", tolerance: "", voltage: "30V", current: "90A", power: "", polarity: "P沟道",
      manufacturer_part: "HY19P03D", footprint: "TO-252-2", quantity: 5,
    }],
    matched: [], suspected: [], missing: [3],
  };
  const rows = statementModel.buildRows(parsed);
  assert.strictEqual(rows[0].voltage, "30V");
  assert.strictEqual(rows[0].current, "90A");
  assert.strictEqual(rows[0].polarity, "P沟道");
  assert.strictEqual(rows[0].decision, "new", "匹配不上的按新增");
  const edited = statementModel.setFieldEdit(rows, 3, "current", "90A（峰值）");
  assert.strictEqual(edited.ok, true, edited.error);
  const d = statementModel.buildDecisions(edited.rows)[0];
  assert.strictEqual(d.overrides.current, "90A（峰值）", "人工改动要随决定提交：" + JSON.stringify(d));
});

t("库存列表：**有「型号」列（part_number）**、且已按用户要求去掉「厂商」列", () => {
  // 用户 2026-10-17：「厂商不重要，可以不要这一列，但是除了贴片电阻和贴片电容，型号很重要」
  const fields = M.SORTABLE_COLUMNS.map((c) => c.field);
  assert.ok(fields.includes("part_number"), "型号列必须在（对账单入库的料就靠它识别）");
  assert.strictEqual(fields.includes("manufacturer"), false, "厂商列已去掉");
  const appSrc = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  assert.ok(/cell\(part\.part_number\)/.test(appSrc), "库存行要渲染型号");
  assert.ok(!/cell\(part\.manufacturer\)/.test(appSrc), "库存行不该再渲染厂商（否则列与表头错位）");
  // 表头由 SORTABLE_COLUMNS 生成、行由 app.js 固定顺序渲染 → 两边数量必须一致（否则错列）
  assert.strictEqual(M.SORTABLE_COLUMNS.length, 9, "当前列数 = 9（去掉厂商后）");
});

t("入库落盘：MOS 的 耐压/电流/极性 写进器件；**型号落 part_number**；合并时只补空不覆盖", async () => {
  const { handlers, db } = freshEnv();
  // 先手录一条只有 分类/值/封装 的电阻（模拟用户库里的 p_0026 那种）
  const seeded = await handlers["parts:save"]({ part: { category: "贴片电阻", value: "100K", footprint: "0603", quantity: 0 } });
  assert.strictEqual(seeded.ok, true, seeded.error);
  // 对账单里同一颗（值写法不同、带型号与容差）
  const items = [{
    row_no: 5, category: "贴片电阻", value: "100kΩ", tolerance: "±1%", voltage: "",
    manufacturer_part: "FRC0603F1003TS", footprint: "0603", quantity: 100,
  }];
  const r = sm.matchStatement(items, db.loadParts());
  assert.strictEqual(r.suspected.length, 1, "应进疑似桶");
  const decide = await handlers["statement:commit"]({
    file_path: "",
    decisions: [{ row_no: 5, action: "merge", part_id: r.suspected[0].candidates[0].part.id }],
  });
  // handlers 的 commit 会重新解析文件（file_path 为空必然失败）→ 用 services 层直接算，避免伪造文件
  assert.strictEqual(decide.ok, false, "空 file_path 必须被拒（不允许无凭据入库）");

  const commitSvc = require(path.join(ROOT, "src", "services", "statement_commit"));
  const ids = require(path.join(ROOT, "src", "services", "ids"));
  const plan = commitSvc.planStatementCommit({
    parts: db.loadParts(),
    merged: [{ item: items[0], part: db.loadParts()[0] }],
    created: [{
      row_no: 6, category: "场效应管(MOSFET)", value: "", tolerance: "", voltage: "30V",
      current: "90A", power: "", polarity: "P沟道", manufacturer_part: "HY19P03D",
      footprint: "TO-252-2", quantity: 5,
    }],
    order_ref: "SO26101418868", now: () => "2026-10-17T10:00:00+08:00", next_id: ids.nextPartId,
  });
  const mergedPart = plan.parts.find((p) => p.id === seeded.part.id);
  assert.strictEqual(mergedPart.value, "100K", "库里已有值 → 不被对账单覆盖");
  assert.strictEqual(mergedPart.tolerance, "±1%", "库里空的容差 → 补上");
  // **型号必须落契约字段 part_number**（库存列表「型号」列显示的就是它）：
  // 2026-10-17 前的 bug 是写进 manufacturer_part（不在 PART_FIELDS 白名单里）→ 列表永远空
  assert.strictEqual(mergedPart.part_number, "FRC0603F1003TS", "库里空的型号 → 补到 part_number");
  assert.strictEqual(mergedPart.manufacturer_part, undefined, "不许再写非契约字段 manufacturer_part");
  const created = plan.parts.find((p) => p.category === "场效应管(MOSFET)");
  assert.strictEqual(created.voltage, "30V");
  assert.strictEqual(created.current, "90A");
  assert.strictEqual(created.polarity, "P沟道");
  assert.strictEqual(created.power, "");
  assert.strictEqual(created.part_number, "HY19P03D", "MOS 的型号必须落 part_number（用户：除 R/C 外型号很重要）");
  assert.strictEqual(created.manufacturer_part, undefined, "不许再写非契约字段 manufacturer_part");
});

t("**已裁定（用户 2026-10-17）：值必填，值就是型号** —— MOS/IC 只填型号也能保存，值自动取型号", () => {
  // 曾经的坑：statement 入库能写进「值为空、型号有值」的 MOS 料，但**手动编辑/录入**走 parts:save
  // → validatePartInput 要求 value 必填 → 保存被拒（当时作为"已知限制"钉住、等用户裁定）。
  // 用户裁定：**值必填；对这类没有参数值的料，值就是型号**（A 方案同一规则）→ 业务层自动补值。
  const parts = require(path.join(ROOT, "src", "services", "parts"));
  const r = parts.savePart(
    { category: "场效应管(MOSFET)", value: "", footprint: "SOT-23", part_number: "AO3401A", quantity: 1 }, [], {}
  );
  assert.strictEqual(r.created, true, "只填型号应能保存");
  assert.strictEqual(r.part.value, "AO3401A", "值 = 型号");
  assert.strictEqual(r.part.part_number, "AO3401A", "型号保留");
  assert.ok(r.warnings.some((w) => /已用「型号」作为值/.test(w)), "要提示值是哪来的：" + JSON.stringify(r.warnings));
  // 值必填**没有放宽**：值和型号都空仍拒绝
  assert.throws(
    () => parts.savePart({ category: "场效应管(MOSFET)", value: "", footprint: "SOT-23", part_number: "", quantity: 1 }, [], {}),
    /缺少必填关键信息：值/
  );
});

/* ===================================== §6 A：值留空时用商品型号当值（用户裁定） */

section("§6 A（用户 2026-10-17 裁定）：商品名称没有「值」时，用商品型号当值");

const HEADER = ["", "", "", "", "", "", "", "商品类型", "商品名称", "商品型号", "封装格式", "订购数量"];
const ROW = (cat, name, mpn, fp, qty) => ["", "", "", "", "", "", "", cat, name, mpn, fp, qty];

t("MOS/排母这类「名称里没有值」的行 → 值 = 商品型号（不再是空）；R/C 有真值不被覆盖", () => {
  const rows = [
    HEADER,
    ROW("场效应管(MOSFET)", "1个P沟道 耐压:30V 电流:90A 编带", "AO3401A", "SOT-23", 5),
    ROW("贴片电阻", "10Ω ±5% 100mW 厚膜电阻 编带", "FRC0603J100TS", "0603", 100),
    ROW("排母", "间距:2.54mm 2x4P 直插 袋装", "LAIL-PM2.54-22P-L", "插件,P=2.54mm", 20),
  ];
  const r = st.parseStatementRows(rows);
  assert.strictEqual(r.ok, true, r.error);
  const mos = r.items.find((x) => x.category === "场效应管(MOSFET)");
  assert.strictEqual(mos.value, "AO3401A", "值留空 → 用商品型号当值");
  assert.strictEqual(mos.voltage, "30V", "参数照旧识别");
  const res = r.items.find((x) => x.category === "贴片电阻");
  assert.strictEqual(res.value, "10Ω", "有真值时**不能**被型号覆盖");
  const header = r.items.find((x) => x.category === "排母");
  assert.strictEqual(header.value, "LAIL-PM2.54-22P-L", "排母没有参数值 → 型号当值");
  assert.ok(r.warnings.some((w) => w.includes("商品型号") && w.includes("作为值")),
    "要有一条警告说明「用型号作为值」（不能悄悄改）：" + JSON.stringify(r.warnings));
});

t("A 的效果：两颗不同 MOS（同封装同耐压、值=型号）去重键不同，不会再被当成同一颗", () => {
  const cmp = require(path.join(ROOT, "src", "services", "compare"));
  // 两颗**封装、耐压都一样**但型号不同的 MOS（现实里很常见：SOT-23 的 P 沟道管有好几种）
  const a = { category: "场效应管(MOSFET)", value: "AO3401A", footprint: "SOT-23", voltage: "30V" };
  const b = { category: "场效应管(MOSFET)", value: "SI2301", footprint: "SOT-23", voltage: "30V" };
  assert.notStrictEqual(cmp.dedupeKey(a), cmp.dedupeKey(b), "不同型号必须区分");
  // 反例：若值留空（修复前的状态），封装/耐压/材质/容差全同 → 去重键相同 → 会被当成同一颗
  assert.strictEqual(cmp.dedupeKey(Object.assign({}, a, { value: "" })),
    cmp.dedupeKey(Object.assign({}, b, { value: "" })), "（留空时确实无法区分——A 修复的正是这个）");
});

/* ---------------------------------------------------------------- 执行 */

runQueue().then(() => {
  console.log("\n" + "=".repeat(64));
  console.log(`T88（电阻/MOS 识别）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
