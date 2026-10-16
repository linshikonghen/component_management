"use strict";
/**
 * test_bom_parser.js — T1（plan §9 的 T3+T4）验收测试
 *
 * 运行： node tests/test_bom_parser.js        退出码 0 = 全通过
 * 零依赖、零框架（AGENTS.md：除 Electron 外不引第三方包）。
 *
 * 覆盖：
 *   §1 zip 容器（CRC32 标准向量 / 读写往返 / 真实文件 / 篡改与截断检出）
 *   §2 xlsx 文本层（列标互逆 / 实体编解码互逆）
 *   §3 spec_parser（plan §5.1 六个真实样例 + 容差 + 纯数字不猜单位）
 *   §4 单位归一化（plan §3.1 表）
 *   §5 真实 BOM ×4（条数、字段、警示；含 spec AC-1 的"33 条"）
 *   §6 异常路径（空文件 / 非 BOM / 数量与位号不符 / 套数非法 / 缺文件 / .xls）
 *   §7 CSV（引号内逗号、中文、位号区间展开）
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const bp = require("../src/services/bom_parser");
const sp = require("../src/services/spec_parser");
const zc = require("../src/services/zip_container");
const xx = require("../src/services/xlsx_xml");

const FIX = path.join(__dirname, "fixtures");
const fixture = (name) => path.join(FIX, name);

const MAIN_BOM = "sample_bom";
const FIXED_BOM = "sample_bom";

/**
 * plan §6 `BomItem` 契约的**完整**字段集（多一个少一个都算偏离契约）。
 *
 * **从文档解析，不再手抄一份**：原先这里写死 20 个字段名，结果 T21 给契约补了
 * `location`/`min_quantity` 之后，测试报的却是"字段集偏离契约"——**测试自己的副本过期了**。
 * 契约的唯一信源是 plan §6，所以这里直接读它（字段名可能带 `**加粗**` 标记，先去掉）。
 */
function bomItemFieldsFromDoc() {
  const text = fs.readFileSync(path.join(__dirname, "..", "docs", "plan.md"), "utf8");
  const sectionText = text.split("### BomItem")[1].split(/\n### /)[0];
  const fields = [];
  for (const line of sectionText.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").map((s) => s.trim()).filter((s) => s !== "");
    if (cols.length < 3 || cols[0] !== "响应") continue;
    const name = cols[1].replace(/[*`]/g, "").trim();
    if (!/^[a-z_]+$/.test(name)) continue;
    fields.push(name);
  }
  return fields;
}
const BOM_ITEM_FIELDS = bomItemFieldsFromDoc();

let passCount = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log("  PASS  " + name);
  } catch (exc) {
    failures.push({ name, message: String(exc && exc.message ? exc.message : exc) });
    console.log("  FAIL  " + name);
    console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
  }
}

function section(title) {
  console.log("\n=== " + title + " ===");
}

/* ==================================================================== §1 zip */

section("§1 zip 容器（zip_container.js）");

t("crc32 与标准校验向量一致（'123456789' → 0xCBF43926）", () => {
  assert.strictEqual(zc.crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
  assert.strictEqual(zc.crc32(Buffer.alloc(0)), 0);
});

t("写入→读回 逐字节往返（中文 / 空条目 / 长重复 / 短内容）", () => {
  const entries = [
    { name: "a.txt", data: "电阻电容 10uF/50V X7R —— 中文与符号 ±Ωµ" },
    { name: "empty.bin", data: Buffer.alloc(0) },
    { name: "long.txt", data: "AB".repeat(20000) }, // 可压缩 → 走 deflate
    { name: "tiny.txt", data: "x" }, // 压不动 → 应退化为 store
  ];
  const buf = zc.writeZip(entries, { date: new Date(2026, 9, 15, 10, 0, 0) });
  const back = zc.readZipEntries(buf);
  assert.strictEqual(back.size, entries.length, "条目数应一致");
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    assert.ok(back.has(entry.name), "缺少条目 " + entry.name);
    assert.ok(data.equals(back.get(entry.name)), "条目内容不一致: " + entry.name);
  }
  assert.deepStrictEqual(zc.listZipEntryNames(buf), entries.map((e) => e.name));
});

t("真实 xlsx 的全部条目 CRC32 校验通过（读成功即证明 CRC 实现正确）", () => {
  const names = fs.readdirSync(FIX).filter((n) => n.startsWith("BOM_") && n.endsWith(".xlsx"));
  assert.strictEqual(names.length, 4, "应有 4 份真实 BOM");
  for (const name of names) {
    const buf = fs.readFileSync(fixture(name));
    const entries = zc.readZipEntries(buf); // 内部逐条校验 uncompSize 与 CRC32
    assert.ok(entries.has("[Content_Types].xml"), name + " 缺 [Content_Types].xml");
    assert.ok(entries.size >= 9, name + " 条目数偏少: " + entries.size);
  }
});

t("逐字节篡改：要么报错，要么数据仍正确——绝不静默返回坏数据", () => {
  const payload = "hello 元器件 10uF/50V X7R ".repeat(40);
  const original = zc.writeZip([{ name: "a.txt", data: payload }]);
  const expected = Buffer.from(payload, "utf8");
  let detected = 0;
  let harmless = 0;
  const silentBad = [];
  for (let i = 0; i < original.length; i += 1) {
    const mutated = Buffer.from(original);
    mutated[i] ^= 0xff;
    let entries;
    try {
      entries = zc.readZipEntries(mutated);
    } catch (exc) {
      detected += 1; // 被检出：CRC32 / 解压失败 / 大小不符 / 条目名不一致 / 结构损坏
      continue;
    }
    const got = entries.get("a.txt");
    if (entries.size === 1 && got !== undefined && got.equals(expected)) harmless += 1;
    else silentBad.push(i);
  }
  assert.deepStrictEqual(silentBad, [], "这些偏移被篡改后仍静默返回了错误数据");
  assert.ok(detected > 0, "至少应有偏移被检出（否则等于完全不校验）");
  assert.strictEqual(detected + harmless, original.length, "两种结果应覆盖全部偏移");
});

t("截断文件被检出（不是有效 zip）", () => {
  const buf = zc.writeZip([{ name: "x.txt", data: "abc" }]);
  assert.throws(() => zc.readZipEntries(buf.subarray(0, buf.length - 30)), /不是有效的 zip/);
  assert.throws(() => zc.readZipEntries(Buffer.from("not a zip at all")), /不是有效的 zip/);
});

t("缺少条目 / 条目无名 会被拒绝", () => {
  assert.throws(() => zc.writeZip([]), /至少要有一个条目/);
  assert.throws(() => zc.writeZip([{ name: "", data: "x" }]), /非空 name/);
});

t("openpyxl 写出的 xlsx 也能读（独立第三方写入实现，非同源自证）", () => {
  const res = bp.parseBomFile(fixture("demo_multi_row.xlsx"), 1);
  assert.strictEqual(res.ok, true, "解析失败: " + res.error);
  assert.strictEqual(res.items.length, 4);
});

/* =============================================================== §2 文本层 */

section("§2 xlsx 文本层（xlsx_xml.js）");

t("columnIndex / columnName 互逆", () => {
  const samples = ["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"];
  for (const name of samples) {
    const idx = xx.columnIndex(name + "1");
    assert.strictEqual(xx.columnName(idx), name, name + " 互逆失败");
  }
  assert.strictEqual(xx.columnIndex("C1210"), 2);
  assert.strictEqual(xx.cellRef(2, 7), "C7");
  assert.throws(() => xx.columnName(-1), /非负整数/);
});

t("XML 实体编码/解码互逆，且剔除非法控制字符", () => {
  const raw = "A&B<C>D\"E'F 中文 ±Ω \u0007 尾巴";
  const decoded = xx.decodeXmlEntities(xx.encodeXmlEntities(raw));
  assert.strictEqual(decoded, "A&B<C>D\"E'F 中文 ±Ω  尾巴");
  // `&` 必须先转义，否则会二次转义
  assert.strictEqual(xx.encodeXmlEntities("&amp;"), "&amp;amp;");
  assert.strictEqual(xx.decodeXmlEntities("&amp;lt;"), "&lt;");
  assert.strictEqual(xx.decodeXmlEntities("&#65;&#x42;"), "AB");
});

/* ============================================================ §3 spec_parser */

section("§3 spec_parser：plan §5.1 的六个真实样例");

const CASES = [
  { comment: "10uF/50V X7R", value: "10uF", voltage: "50V", dielectric: "X7R", note: "", confident: true },
  { comment: "100nF/100V X7R", value: "100nF", voltage: "100V", dielectric: "X7R", note: "", confident: true },
  { comment: "100uF/35V 固态高频低阻", value: "100uF", voltage: "35V", dielectric: "", note: "固态高频低阻", confident: false },
  { comment: "33pF/50V C0G", value: "33pF", voltage: "50V", dielectric: "C0G", note: "", confident: true },
  { comment: "10uF", value: "10uF", voltage: "", dielectric: "", note: "", confident: false },
];

for (const c of CASES) {
  t("Comment「" + c.comment + "」", () => {
    const r = sp.parseComment(c.comment);
    assert.strictEqual(r.value, c.value, "value");
    assert.strictEqual(r.voltage, c.voltage, "voltage");
    assert.strictEqual(r.dielectric, c.dielectric, "dielectric");
    assert.strictEqual(r.note, c.note, "note");
    assert.strictEqual(r.confident, c.confident, "confident");
    assert.strictEqual(r.is_part_number, false, "不应被当作型号");
  });
}

t("Comment「HX-PH2.0-6PWZ-M」→ 整体作为型号，不解析（连接器）", () => {
  const r = sp.parseComment("HX-PH2.0-6PWZ-M");
  assert.strictEqual(r.is_part_number, true);
  assert.strictEqual(r.part_number_suggestion, "HX-PH2.0-6PWZ-M");
  assert.strictEqual(r.value, "");
  assert.strictEqual(r.voltage, "");
});

t("容差提取：`100nF/50V X7R ±10%` → ±10%", () => {
  const r = sp.parseComment("100nF/50V X7R ±10%");
  assert.strictEqual(r.tolerance, "±10%");
  assert.strictEqual(r.value, "100nF");
  assert.strictEqual(r.confident, true);
  assert.strictEqual(sp.parseComment("1k/0.5% 0603 +/-5%").tolerance, "±5%", "+/- 也应识别");
});

t("空 Comment → 全空且不可信（不猜）", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const r = sp.parseComment(empty);
    assert.deepStrictEqual(
      [r.value, r.voltage, r.dielectric, r.tolerance, r.note, r.confident, r.is_part_number],
      ["", "", "", "", "", false, false]
    );
  }
});

t("纯数字「100」→ 作为值但不推断单位（spec §5.2）", () => {
  const r = sp.parseComment("100");
  assert.strictEqual(r.value, "100");
  assert.strictEqual(r.is_part_number, false, "纯数字不应被当成型号");
  assert.strictEqual(r.confident, false, "缺单位必须标为不可信");
  assert.strictEqual(sp.needsUnit("100"), true);
  assert.strictEqual(sp.needsUnit("100nF"), false);
});

/* ========================================================= §4 单位归一化 */

section("§4 单位归一化（plan §3.1 表）+ 文本归一");

t("normalizeValue 按 plan §3.1 归一", () => {
  const table = [
    ["0.1uF", "100nF"], ["100nF", "100nF"],
    ["4.7uF", "4.7uF"], ["4700nF", "4.7uF"],
    ["1k", "1kΩ"], ["1kΩ", "1kΩ"], ["1000Ω", "1kΩ"],
    ["10 uF", "10uF"], ["33pF", "33pF"],
    ["1M", "1MΩ"], ["470Ω", "470Ω"],
    ["10uH", "10uH"], ["1000nH", "1uH"],
    ["", ""],
  ];
  for (const [input, expected] of table) {
    assert.strictEqual(sp.normalizeValue(input), expected, `normalizeValue(${JSON.stringify(input)})`);
  }
});

t("normalizeValue 对纯数字不补单位、对非数值只做小写", () => {
  assert.strictEqual(sp.normalizeValue("100"), "100", "纯数字必须原样（不猜单位）");
  assert.strictEqual(sp.normalizeValue("100V"), "100v");
  assert.strictEqual(sp.normalizeValue("HX-PH2.0-6PWZ-M"), "hx-ph2.0-6pwz-m");
});

t("normalizeText 去空格 + 小写（封装/耐压/材质/容差用）", () => {
  assert.strictEqual(sp.normalizeText("  C1210 "), "c1210");
  assert.strictEqual(sp.normalizeText("50 V"), "50v");
  assert.strictEqual(sp.normalizeText(null), "");
});

/* ======================================================= §5 真实 BOM 解析 */

section("§5 真实 BOM ×4（spec 附录 A 的主测试样本）");

const REAL_BOMS = [
  { name: "sample_bom", items: 33 },
  { name: "sample_bom", items: 37 },
  { name: "sample_bom", items: 35 },
  { name: "BOM_v2.1-未验证 兼容3519_Schematic1_1_2026-07-28.xlsx", items: 53 },
];

t("四份真实 BOM 全部解析成功，且条数与实测一致", () => {
  for (const bom of REAL_BOMS) {
    const res = bp.parseBomFile(fixture(bom.name), 1);
    assert.strictEqual(res.ok, true, bom.name + " 解析失败: " + res.error);
    assert.strictEqual(res.items.length, bom.items, bom.name + " 条数");
  }
});

t("表头识别出 spec §4.1 的 10 列（含 `No.` 这种带点的列名）", () => {
  const { rows } = bp.readTableRows(fixture(MAIN_BOM));
  assert.deepStrictEqual(rows[0], [
    "No.", "Quantity", "Comment", "Designator", "Footprint", "Value",
    "Manufacturer Part", "Manufacturer", "Supplier Part", "Supplier",
  ]);
  const columns = bp.locateHeaderRow(rows).columns;
  assert.strictEqual(Object.keys(columns).length, 10);
  assert.strictEqual(Object.keys(bp.COLUMN_MAP).length, 10);
});

t("AC-1：主样本 + 套数 3 → 33 条，首条显示 `8 × 3 = 24`", () => {
  const res = bp.parseBomFile(fixture(MAIN_BOM), 3);
  assert.strictEqual(res.items.length, 33, "AC-1 要求核对界面出现 33 条");
  const first = res.items[0];
  assert.strictEqual(first.quantity_per_board, 8, "BOM 原数量（只读）");
  assert.strictEqual(first.total_quantity, 24, "应入库量 = 8 × 3");
  assert.strictEqual(first.intake_quantity, 24, "本次入库量默认 = 应入库量");
  assert.strictEqual(first.edited_by_human, false, "未改过则为 false");
  assert.deepStrictEqual(res.warnings, [], "主样本不应有警示");
});

t("AC-1：首条字段与 spec §4.1 行 2 的样例逐字一致", () => {
  const first = bp.parseBomFile(fixture(MAIN_BOM), 1).items[0];
  assert.strictEqual(first.row_no, 1);
  assert.strictEqual(first.designator_count, 8);
  assert.deepStrictEqual(first.designators, ["C1", "C2", "C4", "C5", "C6", "C7", "C10", "C11"]);
  assert.strictEqual(first.comment, "10uF");
  assert.strictEqual(first.footprint, "C1210");
  assert.strictEqual(first.value, "10uF");
  assert.strictEqual(first.voltage, "");
  assert.strictEqual(first.manufacturer_part, "1210B106K500NT");
  assert.strictEqual(first.manufacturer, "FH(风华)");
  assert.strictEqual(first.supplier_part, "C116808");
  assert.strictEqual(first.supplier, "LCSC");
  assert.strictEqual(first.action, "keep");
});

t("AC-1 FR-1.5：Quantity 与位号个数不符要警示（真实数据即可触发）", () => {
  const res = bp.parseBomFile(fixture(FIXED_BOM), 1);
  const mismatched = res.items.filter((i) => i.quantity_per_board !== i.designator_count);
  assert.strictEqual(mismatched.length, 3, "该文件实测有 3 行不符（No.1 Q=3 位号 C1；No.2 Q=3 位号 C2；No.12 Q=2 位号 C28）");
  assert.strictEqual(res.warnings.length, 3);
  for (const w of res.warnings) assert.ok(/不符，需人工裁决/.test(w), w);
  for (const item of mismatched) assert.strictEqual(item.parse_confident, false, "不符的行不可信");
});

t("每个条目**严格**符合 plan §6 BomItem 契约（无自增字段、无 camelCase）", () => {
  const res = bp.parseBomFile(fixture(MAIN_BOM), 2);
  assert.ok(BOM_ITEM_FIELDS.length >= 20, "契约字段解析异常：" + JSON.stringify(BOM_ITEM_FIELDS));
  for (const item of res.items) {
    assert.deepStrictEqual(Object.keys(item).sort(), BOM_ITEM_FIELDS.slice().sort(), "字段集偏离契约");
    assert.strictEqual(Array.isArray(item.designators), true);
    assert.strictEqual(typeof item.quantity_per_board, "number");
    assert.strictEqual(typeof item.total_quantity, "number");
    assert.strictEqual(typeof item.intake_quantity, "number");
    assert.strictEqual(typeof item.edited_by_human, "boolean");
    assert.strictEqual(typeof item.parse_confident, "boolean");
    assert.ok(["keep", "skip"].includes(item.action));
    assert.strictEqual(item.total_quantity, item.quantity_per_board * 2);
    assert.strictEqual(item.intake_quantity, item.total_quantity, "默认本次入库量 = 应入库量");
    assert.strictEqual(item.designator_count, item.designators.length);
  }
});

t("batch_id 形如 plan §3.2 的 `batch_YYYYMMDD_HHMMSS`", () => {
  const res = bp.parseBomFile(fixture(MAIN_BOM), 1, { now: new Date(2026, 9, 15, 10, 0, 0) });
  assert.strictEqual(res.batch_id, "batch_20261015_100000");
  assert.ok(/^batch_\d{8}_\d{6}$/.test(bp.makeBatchId()));
});

/* ============================================================ §6 异常路径 */

section("§6 异常路径（spec AC-1）");

t("只有表头的文件 → 「未找到有效条目」，且不进核对界面", () => {
  for (const name of ["neg_header_only.xlsx"]) {
    const res = bp.parseBomFile(fixture(name), 1);
    assert.strictEqual(res.ok, false, name + " 不应解析成功");
    assert.ok(/未找到有效条目/.test(res.error), res.error);
    assert.deepStrictEqual(res.items, []);
    assert.strictEqual(res.batch_id, "");
  }
});

t("非 BOM 格式的 xlsx → 明确报错并列出缺哪些列，不写入任何数据", () => {
  const res = bp.parseBomFile(fixture("neg_not_a_bom.xlsx"), 1);
  assert.strictEqual(res.ok, false);
  assert.ok(/不是可识别的 BOM|缺少必需列/.test(res.error), res.error);
  assert.deepStrictEqual(res.items, []);
});

t("Quantity=8 但位号只有 6 个 → 警示 + 不可信（AC-1 FR-1.5 构造样本）", () => {
  const res = bp.parseBomFile(fixture("neg_quantity_mismatch.xlsx"), 1);
  assert.strictEqual(res.ok, true, "解析本身应成功，由人工裁决");
  const item = res.items[0];
  assert.strictEqual(item.quantity_per_board, 8);
  assert.strictEqual(item.designator_count, 6);
  assert.strictEqual(item.parse_confident, false);
  assert.strictEqual(res.warnings.length, 1);
  assert.ok(/不符，需人工裁决/.test(res.warnings[0]), res.warnings[0]);
});

t("套数必须为 ≥1 的整数，否则拒绝", () => {
  for (const bad of [0, -1, 1.5, "abc", ""]) {
    const res = bp.parseBomFile(fixture(MAIN_BOM), bad);
    assert.strictEqual(res.ok, false, `sets=${JSON.stringify(bad)} 应被拒绝`);
    assert.ok(/套数/.test(res.error), res.error);
  }
  assert.strictEqual(bp.parseBomFile(fixture(MAIN_BOM)).items.length, 33, "不传套数默认 1");
  assert.strictEqual(bp.parseBomFile(fixture(MAIN_BOM), "3").items[0].total_quantity, 24, "字符串数字可接受");
});

t("文件不存在 / 假 .xls → 明确报错（不再有「不支持 .xls」这个限制）", () => {
  assert.ok(/读取文件失败/.test(bp.parseBomFile(fixture("不存在的文件.xlsx"), 1).error));
  // 2026-10-16 起 `.xls`（真 BIFF8）**已经支持**（src/services/xls_biff.js，零依赖）。
  // 所以这里断言的是"假 .xls 要明确报错、不许装成功"，而**不是**"一律不支持"。
  const xls = path.join(FIX, "fake.xls");
  fs.writeFileSync(xls, "not really xls");
  try {
    const res = bp.parseBomFile(xls, 1);
    assert.strictEqual(res.ok, false, "假 .xls 不该被当成有效 BOM");
    assert.ok(!/不支持 \.xls/.test(res.error), "「不支持 .xls」这句限制已经不存在了，不该再出现：" + res.error);
  } finally {
    fs.unlinkSync(xls);
  }
});

t("**立创对账单**（真 .xls）→ 给出**专门**提示，而不是泛泛的「表头缺列」", () => {
  const stmt = path.join(FIX, "sample_statement");
  if (!fs.existsSync(stmt)) return; // fixture 含真实订单信息，允许缺失（见 test_xls_biff.js 说明）
  const res = bp.parseBomFile(stmt, 1);
  assert.strictEqual(res.ok, false, "对账单不是 BOM，不该被当成 BOM 通过");
  assert.ok(/物料明细对账单/.test(res.error), "提示里应点明「这是对账单」：" + res.error);
  assert.ok(/不是 BOM/.test(res.error), "应说明它不是 BOM：" + res.error);
  assert.ok(/T45|正在做/.test(res.error), "应告诉用户这件事正在做：" + res.error);
});

t("空 CSV（0 字节）→ 未找到有效条目", () => {
  const empty = path.join(FIX, "empty.csv");
  fs.writeFileSync(empty, "");
  try {
    const res = bp.parseBomFile(empty, 1);
    assert.strictEqual(res.ok, false);
    assert.ok(/文件为空|未找到有效条目/.test(res.error), res.error);
  } finally {
    fs.unlinkSync(empty);
  }
});

/* ================================================================== §7 CSV */

section("§7 CSV 导入（spec FR-1.1 支持 .csv）");

t("CSV 正常解析 6 条，且引号内的逗号不被当作分隔符", () => {
  const res = bp.parseBomFile(fixture("sample_small.csv"), 1);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.items.length, 6);
  assert.strictEqual(res.items[0].designator_count, 8);
  assert.strictEqual(res.items[0].manufacturer, "FH(风华)", "中文应无损");
  assert.strictEqual(res.items[3].comment, "100nF/50V, 高频", "引号内逗号应保留");
  assert.strictEqual(res.items[3].voltage, "50V");
  assert.strictEqual(res.items[3].note, "高频");
});

t("CSV 里 `R1-4` 展开成 4 个位号，不与 Quantity=4 误报冲突", () => {
  const res = bp.parseBomFile(fixture("sample_small.csv"), 1);
  const row2 = res.items[1];
  assert.deepStrictEqual(row2.designators, ["R1", "R2", "R3", "R4"]);
  assert.strictEqual(row2.designator_count, 4);
  assert.strictEqual(row2.quantity_per_board, 4);
  assert.ok(!res.warnings.some((w) => w.startsWith("第 2 行")), "第 2 行不应有警示");
});

t("CSV 里数量不符（第 5 行）与缺单位（第 6 行）各出一条警示", () => {
  const res = bp.parseBomFile(fixture("sample_small.csv"), 1);
  assert.strictEqual(res.warnings.length, 2, JSON.stringify(res.warnings));
  assert.ok(res.warnings.some((w) => /第 5 行.*不符，需人工裁决/.test(w)), JSON.stringify(res.warnings));
  assert.ok(res.warnings.some((w) => /第 6 行.*缺单位/.test(w)), JSON.stringify(res.warnings));
  assert.strictEqual(res.items[5].value, "100");
});

t("位号区间展开单测（官方仅支持 `字母+数字-数字`，起<止）", () => {
  assert.deepStrictEqual(bp.splitDesignators("R1-4"), ["R1", "R2", "R3", "R4"]);
  assert.deepStrictEqual(bp.splitDesignators("R1-R4"), ["R1", "R2", "R3", "R4"]);
  assert.deepStrictEqual(bp.splitDesignators("R01-03"), ["R01", "R02", "R03"]);
  assert.deepStrictEqual(bp.splitDesignators("R1-4,C9"), ["R1", "R2", "R3", "R4", "C9"]);
  // 非区间：不能误展开
  assert.deepStrictEqual(bp.splitDesignators("TP-1"), ["TP-1"]);
  assert.deepStrictEqual(bp.splitDesignators("R5-1"), ["R5-1"], "起<止 不成立则不展开");
  assert.deepStrictEqual(bp.splitDesignators("HX-PH2.0-6PWZ-M"), ["HX-PH2.0-6PWZ-M"]);
  assert.deepStrictEqual(bp.splitDesignators("C1，C2; C3、C4 C5"), ["C1", "C2", "C3", "C4", "C5"]);
  assert.deepStrictEqual(bp.splitDesignators(""), []);
  assert.strictEqual(bp.expandDesignatorRange("R1-999999"), null, "离谱区间不展开，防内存爆掉");
});

/* ================================================================ 汇总输出 */

console.log("\n" + "=".repeat(64));
console.log(`T1 测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
