"use strict";
/**
 * test_exporter_roundtrip.js — T2（plan §9 的 T13b）验收测试
 *
 * 运行：
 *   node tests/test_exporter_roundtrip.js
 *   node tests/test_exporter_roundtrip.js --out <path.xlsx>     # 另存一份给独立判卷用
 *
 * 验收依据 plan §10.1 第 2 步：**导出后用本项目自己的读取器读回、逐格比对**。
 * 注意这一步是"必要条件"而非"充分条件"——读写两半都是本项目的代码，
 * 同源 bug 可能一起骗过这条测试。因此另有**独立实现判卷**：
 *   E:\python3.11.9\python.exe tests\verify_export_independently.py <path.xlsx>
 * 用 Python 标准库 zipfile / xml.etree + 第三方 openpyxl 三个互不相同的实现复核。
 * 最终外部验收（真文件上传立创）仍须用户执行（spec AC-8 / T13d）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ex = require("../src/services/exporter");
const bp = require("../src/services/bom_parser");
const zc = require("../src/services/zip_container");

const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm_xlsx_"));
const SHEET = "BOM 导出";

/**
 * 对抗性内容：每一项都对应一类"会让 xlsx 静默写坏"的真实风险。
 * 值类型混用（string / number / boolean / 空）以覆盖三条单元格分支。
 */
const ROWS = [
  ["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"],
  ["1210B106K500NT", "FH(风华)", "C1210", "10uF 50V X7R", "C116808", "C1,C2,C4,C5", 21],
  ["RC0603FR-071KL", "YAGEO(国巨)", "R0603", "1kΩ ±1%", "C21190", "R1,R2", 2],
  ["", null, "", "含 & < > \" ' 的文本", "", "带 空格 的值", 0],
  ["多行文本\n第二行", "±10%", "Ω µH", "=SUM(A1)", "00123", " 首尾空格 ", -5],
  ["emoji 🚀 与制表\t符", "x".repeat(500), "", "", "", "", 3.14],
  [true, false, "", "", "", "", 1000000],
];

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

/** 期望读回值：读取器把所有单元格都读成字符串（数字→"21"，布尔→"TRUE"/"FALSE"） */
function expectedCell(value) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

const EXPORTED = path.join(OUT_DIR, "roundtrip.xlsx");
const result = ex.writeXlsx(EXPORTED, { sheet_name: SHEET, rows: ROWS });

/* ============================================================ §1 基本契约 */

section("§1 写文件与返回契约");

t("writeXlsx 返回路径/字节数/行列数，且文件确实存在", () => {
  assert.strictEqual(result.file_path, EXPORTED);
  assert.ok(fs.existsSync(EXPORTED), "文件未生成");
  assert.strictEqual(fs.statSync(EXPORTED).size, result.bytes);
  assert.strictEqual(result.rows, ROWS.length);
  assert.strictEqual(result.cols, 7);
  assert.ok(result.bytes > 800, "文件过小，可能没写出内容: " + result.bytes);
});

t("临时文件不残留（原子写：tmp + rename）", () => {
  const leftovers = fs.readdirSync(OUT_DIR).filter((n) => n.includes(".tmp-"));
  assert.deepStrictEqual(leftovers, [], "残留临时文件: " + leftovers);
});

/* ================================================== §2 回读逐格比对（验收） */

section("§2 用本项目自己的读取器读回、逐格比对（plan §10.1 第 2 步）");

t("zip 结构完整：6 个必需部件都在，且 CRC32 全部通过", () => {
  const buf = fs.readFileSync(EXPORTED);
  const entries = zc.readZipEntries(buf); // 内部逐条校验大小与 CRC32
  const required = [
    "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml",
  ];
  for (const name of required) assert.ok(entries.has(name), "缺部件 " + name);
  assert.strictEqual(entries.size, required.length, "多出了计划外的部件: " + [...entries.keys()]);
});

t("逐格比对：行数、列数、每一格都与源数据一致", () => {
  const { rows } = bp.readTableRows(EXPORTED);
  assert.strictEqual(rows.length, ROWS.length, "行数不一致");
  for (let r = 0; r < ROWS.length; r += 1) {
    assert.strictEqual((rows[r] || []).length, ROWS[r].length, `第 ${r + 1} 行列数不一致`);
    for (let c = 0; c < ROWS[r].length; c += 1) {
      assert.strictEqual(
        rows[r][c], expectedCell(ROWS[r][c]),
        `第 ${r + 1} 行 ${String.fromCharCode(65 + c)} 列不一致`
      );
    }
  }
});

t("空串保留列位（写成 `<c r=\"A4\"/>`），不会把后面的列左移", () => {
  const xml = zc.readZipEntry(fs.readFileSync(EXPORTED), "xl/worksheets/sheet1.xml").toString("utf8");
  assert.ok(xml.includes('<c r="A4"/>'), "空单元格未占位");
  assert.ok(xml.includes('<c r="B4"/>'), "null 单元格未占位");
  // 关键证据：C4/D4 之间若左移，D4 就不会是那句带 & < > 的文本
  assert.ok(/<c r="D4" t="inlineStr"><is><t xml:space="preserve">含 &amp; &lt; &gt; &quot; &apos; 的文本<\/t>/.test(xml),
    "转义或列位不正确");
});

/* ================================================== §3 单元格类型与转义 */

section("§3 单元格类型、转义与保真");

t("数字写真数字（`<v>`），不是披着数字外衣的文本", () => {
  const xml = zc.readZipEntry(fs.readFileSync(EXPORTED), "xl/worksheets/sheet1.xml").toString("utf8");
  assert.ok(xml.includes('<c r="G2"><v>21</v></c>'), "数量列没写成数值");
  assert.ok(xml.includes('<c r="G5"><v>-5</v></c>'), "负数未写成数值");
  assert.ok(xml.includes('<c r="G6"><v>3.14</v></c>'), "小数未写成数值");
});

t("布尔写 `t=\"b\"`（读回 TRUE/FALSE）", () => {
  const xml = zc.readZipEntry(fs.readFileSync(EXPORTED), "xl/worksheets/sheet1.xml").toString("utf8");
  assert.ok(xml.includes('<c r="A7" t="b"><v>1</v></c>'), "true 未按布尔写");
  assert.ok(xml.includes('<c r="B7" t="b"><v>0</v></c>'), "false 未按布尔写");
});

t("文本一律 inlineStr（完全绕开 sharedStrings），且 `xml:space` 保留首尾空格", () => {
  const buf = fs.readFileSync(EXPORTED);
  assert.strictEqual(zc.readZipEntry(buf, "xl/sharedStrings.xml"), null, "不该有 sharedStrings 表");
  const xml = zc.readZipEntry(buf, "xl/worksheets/sheet1.xml").toString("utf8");
  assert.ok(!xml.includes("t=\"s\""), "出现了 sharedStrings 引用");
  assert.ok(xml.includes('<c r="F5" t="inlineStr"><is><t xml:space="preserve"> 首尾空格 </t></is></c>'));
});

t("前导零不被吃掉（`00123` 仍是字符串 `00123`）", () => {
  const { rows } = bp.readTableRows(EXPORTED);
  assert.strictEqual(rows[4][4], "00123");
});

t("中文、emoji、制表符、换行、±Ωµ 全部无损", () => {
  const { rows } = bp.readTableRows(EXPORTED);
  assert.strictEqual(rows[4][0], "多行文本\n第二行");
  assert.strictEqual(rows[5][0], "emoji 🚀 与制表\t符");
  assert.strictEqual(rows[1][1], "FH(风华)");
  assert.strictEqual(rows[4][1], "±10%");
  assert.strictEqual(rows[4][2], "Ω µH");
  assert.strictEqual(rows[5][1], "x".repeat(500));
});

t("看似公式的文本不会被当公式（`=SUM(A1)` 原样保留）", () => {
  const { rows } = bp.readTableRows(EXPORTED);
  assert.strictEqual(rows[4][3], "=SUM(A1)");
  const xml = zc.readZipEntry(fs.readFileSync(EXPORTED), "xl/worksheets/sheet1.xml").toString("utf8");
  assert.ok(!xml.includes("<f>"), "不该产生公式元素");
});

/* ============================================================ §4 边界与错误 */

section("§4 边界与错误处理");

t("工作表名非法字符被清理，超长被截断，空名回退 Sheet1", () => {
  assert.strictEqual(ex.sanitizeSheetName("立创/BOM:导出*表"), "立创_BOM_导出_表");
  assert.strictEqual(ex.sanitizeSheetName("x".repeat(40)).length, 31);
  assert.strictEqual(ex.sanitizeSheetName("   "), "Sheet1");
  assert.strictEqual(ex.sanitizeSheetName(null), "Sheet1");
});

t("超过 xlsx 上限时明确报错，不硬写坏文件", () => {
  assert.throws(() => ex.buildXlsxBuffer({ rows: [new Array(ex.MAX_COLS + 1).fill("x")] }), /列数.*超过 xlsx 上限/);
  assert.throws(() => ex.buildXlsxBuffer({ rows: "not-an-array" }), /必须是二维数组/);
  assert.throws(() => ex.buildXlsxBuffer({ rows: [["ok", NaN]] }), /不是有限数字/);
  assert.throws(() => ex.buildXlsxBuffer({ rows: [["ok", Infinity]] }), /不是有限数字/);
});

t("不支持的单元格类型直接报错，而不是静默写成 `[object Object]`", () => {
  assert.throws(() => ex.buildXlsxBuffer({ rows: [[{}]] }), /值类型不支持/);
  assert.throws(() => ex.buildXlsxBuffer({ rows: [[new Date()]] }), /值类型不支持/);
  assert.throws(() => ex.buildXlsxBuffer({ rows: [[Symbol("s")]] }), /值类型不支持/);
  // null / undefined 是"空格"，合法
  assert.doesNotThrow(() => ex.buildXlsxBuffer({ rows: [[null, undefined, ""]] }));
});

t("空表也能写出并读回（0 行）", () => {
  const empty = path.join(OUT_DIR, "empty.xlsx");
  ex.writeXlsx(empty, { rows: [] });
  assert.deepStrictEqual(bp.readTableRows(empty).rows, []);
});

t("重复写同一路径会覆盖（原子替换），不报错也不残留", () => {
  const target = path.join(OUT_DIR, "overwrite.xlsx");
  ex.writeXlsx(target, { rows: [["第一次"]] });
  const first = fs.statSync(target).size;
  ex.writeXlsx(target, { rows: [["第二次"], ["多一行"]] });
  const second = fs.statSync(target).size;
  assert.notStrictEqual(first, second, "内容应已更新");
  assert.deepStrictEqual(bp.readTableRows(target).rows, [["第二次"], ["多一行"]]);
  assert.deepStrictEqual(fs.readdirSync(OUT_DIR).filter((n) => n.includes(".tmp-")), []);
});

t("同一份输入两次导出结果逐字节相同（时间戳固定时无随机性）", () => {
  const when = new Date(2026, 9, 15, 10, 0, 0);
  const a = ex.buildXlsxBuffer({ sheet_name: "S", rows: [["x", 1]], date: when });
  const b = ex.buildXlsxBuffer({ sheet_name: "S", rows: [["x", 1]], date: when });
  assert.ok(a.equals(b), "同样输入应产出同样字节（否则无法用哈希做回归基线）");
});

/* ============================ §4b 第三方判卷：独立 XML 解析器 */

section("§4b **独立判卷**：用 Python 的严格解析器验我们写出的文件（自写读取器是宽容的，不算数）");

t("刁钻内容写出的 xlsx：zip CRC + 全部 XML 部件都通过**独立**解析器", () => {
  const { spawnSync } = require("child_process");
  const py = process.env.CM_PYTHON || "E:\\python3.11.9\\python.exe";
  const validator = path.join(__dirname, "..", "tools", "validate_xlsx_xml.py");
  assert.ok(fs.existsSync(validator), "独立判卷脚本应存在：" + validator);

  // 刁钻内容：XML 非法控制字符、非字符 U+FFFE/U+FFFF、emoji、制表/换行、超长单元格、公式样文本
  const tricky = path.join(OUT_DIR, "tricky.xlsx");
  ex.writeXlsx(tricky, {
    sheet_name: "刁钻内容",
    rows: [
      ["XML非法控制字符", "非字符", "emoji", "空白", "超长", "公式样"],
      ["10\u0001uF\u0008", "a\ufffeb\uffffc", "10uF🚀😀", "x\ty\r\nz", "L".repeat(40000), "=SUM(A1)"],
    ],
    // 这条用例要证明的是"写入器**字节忠实**"（超长内容照写、由导出层负责截断），
    // 所以显式放行单元格长度闸。默认行为（超限报错）另有专门用例，见下一条。
    max_cell_chars: Infinity,
  });

  // 注意：本机沙箱下 Node 子进程的**管道** stdio 会 EPERM（既有限制），所以用 stdio: "inherit"
  // 让判卷脚本直接打印到控制台，另外用 `--out` 落一份报告文件供断言读取。
  const reportPath = path.join(OUT_DIR, "validate-report.txt");
  const run = spawnSync(py, [validator, tricky, "--out", reportPath], { stdio: "inherit" });
  const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : "";
  assert.strictEqual(run.status, 0, "独立解析器判定有问题（见上面的输出与报告）：\n" + report);
  assert.ok(/PASS/.test(report), "判卷报告应含 PASS，实际：" + report);

  // 直接看写出去的 sheet XML：非法字符必须**已被剔除**（而不是"照写、只是解析器没管"）
  const entries = zc.readZipEntries(fs.readFileSync(tricky));
  const sheet = entries.get("xl/worksheets/sheet1.xml").toString("utf8");
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sheet), "XML 非法控制字符必须已被剔除");
  assert.ok(!sheet.includes("\ufffe") && !sheet.includes("\uffff"), "XML 非字符 U+FFFE/U+FFFF 也必须剔除");
  assert.ok(sheet.includes("10uF"), "剔除控制字符后剩下的文本应完好（`10\\u0001uF` → `10uF`）");
  assert.ok(sheet.includes("abc"), "非字符剔除后 a/b/c 应连起来");
  assert.ok(sheet.includes("🚀") && sheet.includes("😀"), "emoji 必须无损（合法字符不该被误剔）");
  assert.ok(sheet.includes("L".repeat(40000)), "写入器本身不下手截断（截断是导出层的事，见 export_format.MAX_CELL_CHARS）");
});

t("Excel 单元格上限：导出层截断到 32767 并**明确警示**（不静默）", () => {
  const ef = require("../src/services/export_format");
  const item = {
    row_no: 1, part_number: "MPN-1", manufacturer: "FH", footprint: "C0603", value: "10uF",
    designators: ["C1"], purchase_quantity: 1, supplier_part: "C1", part_desc: "X".repeat(40000),
  };
  // 借"品牌"列放超长文本（列结构不变，只塞脏数据）
  const built = ef.buildRows([Object.assign({}, item, { manufacturer: "Y".repeat(40000) })], "lcsc");
  const row = built.rows[1];
  const longCell = row.find((c) => typeof c === "string" && c.length > 1000);
  assert.ok(longCell, "应能定位到那个超长单元格");
  assert.strictEqual(longCell.length, 32767, "必须截断到 Excel 上限（否则整份文件打不开）");
  assert.ok(built.warnings.some((w) => /超过 Excel 单元格上限/.test(w) && /已截断/.test(w)),
    "必须留下警示，不能静默截断；实际警示：" + JSON.stringify(built.warnings.slice(0, 3)));
});

t("超长单元格：**默认报错**（不产出用户打不开的文件），显式放行才写（审计 R3 发现①）", () => {
  const tooLong = "L".repeat(ex.MAX_CELL_CHARS + 1);
  assert.throws(
    () => ex.buildXlsxBuffer({ rows: [["ok", tooLong]] }),
    /超过 Excel 单元格上限|max_cell_chars/,
    "默认必须挡住超长单元格——行/列数早有守卫，文本长度不能例外",
  );
  // 显式放行（给"字节忠实"类测试与特殊用途用）
  assert.doesNotThrow(() => ex.buildXlsxBuffer({ rows: [["ok", tooLong]], max_cell_chars: Infinity }));
  // 恰好等于上限要放行（边界值不能误伤）
  const exactly = "L".repeat(32767);
  assert.doesNotThrow(() => ex.buildXlsxBuffer({ rows: [["ok", exactly]] }));
});

t("zip 重名条目：**读取器报错**而不是静默覆盖（审计 R3 发现⑥）", () => {
  // 用 tests/fake_zip.js 造一个带重名条目的包（writeZip 不会产出这种包——
  // 但读取器要面对**别人产出的** xlsx，不能假设它规整）
  const { buildZip } = require("./fake_zip");
  const dup = buildZip([
    { name: "a.xml", data: "1" },
    { name: "a.xml", data: "22" },
  ]);
  assert.throws(() => zc.readZipEntries(dup), /重名条目/,
    "同名条目会静默覆盖成 1 条（且不知道少了哪个），必须报错");
});

/* ================================================= §5 离线与零依赖自检 */

section("§5 离线与零依赖自检（AGENTS.md 硬约束）");

t("src/ 下没有任何网络模块引用，也没有 npm 第三方 require", () => {
  const dir = path.join(__dirname, "..", "src");
  const files = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js")) files.push(full);
    }
  })(dir);
  assert.ok(files.length >= 5, "src/ 下应有实现文件，实际 " + files.length);
  // 先剥注释再扫：注释里出现 require("xxx") 只是说明文字，不构成能力
  // （本文件的静态扫描此前已被自己的文档注释误伤过一次，故统一先剥注释。）
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const banned = [/require\(\s*["'](http|https|net|dns|tls|dgram)["']\s*\)/, /\bfetch\s*\(/, /XMLHttpRequest/,
    /require\(\s*["'][^"'.][^"']*["']\s*\)/]; // 非相对路径 require = 内置模块或运行时包
  // 允许清单：Node 内置 + **electron**。
  // electron 不算"第三方依赖"：它是本项目选定的运行时（plan §1），本机全局安装，
  // 不在 package.json 的 dependencies 里（零依赖由 gate 与 package.json 断言保证）。
  const ALLOWED_REQUIRE = /require\(\s*["'](fs|path|zlib|os|util|crypto|events|stream|url|electron)["']\s*\)/;
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const re of banned) {
      const hit = re.exec(src);
      if (hit && !ALLOWED_REQUIRE.test(hit[0])) {
        assert.fail(`${path.basename(file)} 命中禁用模式 ${re}: ${hit[0]}`);
      }
    }
  }
  // 反证：剥注释后仍应能扫到 require（否则可能是把源码读空了导致"全部通过"）。
  // 注意不能只看第一个文件——`ipc/channels.js` 是纯数据清单，本来就没有 require。
  const anyRequire = files.some((f) => /require\(/.test(stripComments(fs.readFileSync(f, "utf8"))));
  assert.ok(anyRequire, "扫描前处理有误：所有源码看起来都被清空了");
});

/* ============================================================== 可选导出物 */

const outIdx = process.argv.indexOf("--out");
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const target = path.resolve(process.argv[outIdx + 1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  ex.writeXlsx(target, { sheet_name: SHEET, rows: ROWS, date: new Date(2026, 9, 15, 10, 0, 0) });
  fs.writeFileSync(target + ".expected.json", JSON.stringify({
    sheet_name: SHEET,
    rows: ROWS.map((row) => row.map((v) => expectedCell(v))),
  }, null, 2), "utf8");
  console.log(`\n为独立判卷另存：${target}（+ .expected.json）`);
}

try {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
} catch (ignored) { /* 临时目录清理失败不影响结论 */ }

console.log("\n" + "=".repeat(64));
console.log(`T2（T13b）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
