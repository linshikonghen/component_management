"use strict";
/**
 * T45（新功能第一步）— 零依赖 .xls（BIFF8）读取器
 *
 * **本套件用真实文件测**（`tests/fixtures/sample_statement`）。
 * 这是上一轮的教训：解析器一直用**合成字符串**验（`parseComment("100nF/50V X7R ±10%)"`），
 * 而真实文件里根本没有那种格式——"能力"被验过，"真实数据里存在这种格式"从没被验过。
 * 所以这次直接拿用户给的真文件当基准，断言**具体格子里的具体值**。
 *
 * fixture 缺省时**跳过而不是失败**（那份 .xls 含真实收货人/快递单号/发票号，
 * 用户若要推到公开远端，我会换脱敏样本——所以这里必须容忍它不在）。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { readXlsRows, isOle } = require(path.join(ROOT, "src", "services", "xls_biff.js"));

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

const FIX = path.join(__dirname, "fixtures", "sample_statement");
const HAS_FIX = fs.existsSync(FIX);
const rows = HAS_FIX ? readXlsRows(fs.readFileSync(FIX)) : [];
const cell = (r, c) => (rows[r] && rows[r][c] !== undefined ? rows[r][c] : undefined);

/* ------------------------------------------------------------ §1 容器层 */

t("识别 OLE2 复合文档（真 .xls 的头是 D0 CF 11 E0）", () => {
  if (!HAS_FIX) return;
  const buf = fs.readFileSync(FIX);
  assert.strictEqual(isOle(buf), true, "应识别为 OLE2");
  assert.strictEqual(isOle(Buffer.from("PK\x03\x04xxxx")), false, "zip（xlsx）不该被当成 OLE2");
  assert.strictEqual(isOle(Buffer.from("hello world!!!!")), false, "随便一段字节不该被当成 OLE2");
});

t("读出的形状是二维数组（与 xlsx 读取器同一形状）", () => {
  if (!HAS_FIX) return;
  assert.ok(Array.isArray(rows), "应返回数组");
  assert.ok(rows.length >= 10, "行数应 >= 10，实际 " + rows.length);
  assert.ok(Array.isArray(rows[0]), "每一行应是数组");
  assert.ok(rows[0].length >= 20, "列数应 >= 20（对账单有 25 列），实际 " + rows[0].length);
});

/* ------------------------------------------- §2 共享字符串表（SST）正确性 */

t("表头 25 列逐字正确（证明 SST 没串号错位）", () => {
  if (!HAS_FIX) return;
  const expected = ["订单编号", "订单状态", "下单时间", "收货人", "客户料号", "商品编号", "品牌", "商品类型",
    "商品名称", "商品型号", "封装格式", "订购数量", "商品单位", "单价（人民币含税）", "小计金额（人民币含税）",
    "发货日期", "快递公司", "快递单号", "签收日期", "发票号", "开票时间", "客户代表", "归属原订单", "bom标识", "订单合同编号"];
  const header = rows[1].slice(0, 25);
  assert.deepStrictEqual(header, expected, "表头应与对账单一致（错位说明 SST 解错了）");
});

t("**串号不错位**：明细行的订单号是真订单号，且商品名称不会跑到订单号列（第一版 bug 的回归）", () => {
  if (!HAS_FIX) return;
  // 第一版 SST 解错时，串号会整体偏移（「订单编号」位置显示成别的串）。
  // 实测发现：对账单**自身**还有标签行（A 列 = 「商品合计金额」/「说明：…」/「价外费用（配送费）」），
  // 这些不是错位——所以断言的是**数据能支撑的不变量**，而不是"每行都必须是订单号"：
  //   ① 至少 5 行是形如 SO26101418868 的真订单号；
  //   ② 商品名称那一列的值**绝不出现**在订单号列（错位的典型症状）；
  //   ③ 有订单号的行，必须有商品名称（明细行两列都在）。
  const orderRows = [];
  const nameSet = new Set();
  for (let r = 2; r < rows.length; r += 1) {
    const col0 = cell(r, 0);
    const name = cell(r, 8);
    if (typeof col0 === "string" && /^SO\d+$/.test(col0)) orderRows.push({ r, col0, name });
    if (typeof name === "string" && name.trim() !== "") nameSet.add(name);
  }
  assert.ok(orderRows.length >= 5, "应至少读出 5 个真订单号，实际 " + orderRows.length);
  for (const o of orderRows) {
    assert.ok(typeof o.name === "string" && o.name.trim() !== "",
      `有订单号的行必须也有商品名称（第 ${o.r} 行）`);
  }
  for (let r = 2; r < rows.length; r += 1) {
    assert.ok(!nameSet.has(cell(r, 0)),
      `订单号列出现了商品名称（串号错位）：第 ${r} 行 = ${JSON.stringify(cell(r, 0))}`);
  }
  // 把读到的样子打出来（人工一眼比对 Excel；也让"标签行"这件事有据可查）
  console.log("        —— 前 16 行（列号:值，仅非空）——");
  for (let r = 0; r < Math.min(16, rows.length); r += 1) {
    const parts = [];
    for (let c = 0; c < rows[r].length; c += 1) {
      const v = rows[r][c];
      if (v === "" || v === undefined) continue;
      parts.push(`${c}:${typeof v === "number" ? Math.round(v * 1e6) / 1e6 : String(v).replace(/\n/g, "⏎")}`);
    }
    console.log("          行" + String(r).padStart(2) + " " + parts.join(" | ").slice(0, 150));
  }
});

/* ------------------------------------------------------- §3 真实数据抽样 */

t("抽样逐格比对：商品名称/型号/封装/数量/价格都对得上", () => {
  if (!HAS_FIX) return;
  // 行 2 是第一条明细（行 0 有个 별的合计杂项、行 1 是表头）
  const samples = [
    { r: 2, col: 5, want: "C48543656", label: "商品编号" },
    { r: 2, col: 8, want: "100nF ±10% 100V 编带", label: "商品名称" },
    { r: 2, col: 9, want: "TCC0603X7R104K101CTM", label: "商品型号" },
    { r: 2, col: 10, want: "0603", label: "封装格式" },
    { r: 2, col: 11, want: 50, label: "订购数量" },
    { r: 3, col: 8, want: "22uF ±20% 25V 编带", label: "商品名称（第 2 条）" },
    { r: 3, col: 11, want: 5, label: "订购数量（第 2 条）" },
  ];
  for (const s of samples) {
    assert.deepStrictEqual(cell(s.r, s.col), s.want, `${s.label} 应等于 ${JSON.stringify(s.want)}，实际 ${JSON.stringify(cell(s.r, s.col))}`);
  }
});

t("数值格子是真数字（数量/单价），不是被当字符串", () => {
  if (!HAS_FIX) return;
  assert.strictEqual(typeof cell(2, 11), "number", "订购数量应是 number");
  assert.strictEqual(typeof cell(2, 13), "number", "单价应是 number");
  assert.strictEqual(typeof cell(2, 14), "number", "小计应是 number（小计多为 FORMULA，取缓存值）");
  // **原值 vs 显示值**：格子里是 0.0816，Excel 按格式显示成 0.082。
  // 读取器给的是**原值**（0.0816）——这是对的；我第一版照显示值写期望，写错了。
  assert.ok(Math.abs(cell(2, 13) - 0.0816) < 1e-9, "单价原值应约 0.0816（显示为 0.082），实际 " + cell(2, 13));
  assert.ok(Math.abs(cell(2, 14) - 4.08) < 1e-9, "小计应约 4.08，实际 " + cell(2, 14));
  // 交叉核对：50 × 0.0816 = 4.08 —— 小计（FORMULA 缓存值）与单价×数量自洽
  assert.ok(Math.abs(cell(2, 11) * cell(2, 13) - cell(2, 14)) < 1e-6,
    "小计应等于 数量 × 单价（自洽检查）");
});

t("**耐压/容差确实在这场文件里**（这正是加这个功能的原因）", () => {
  if (!HAS_FIX) return;
  const names = [];
  for (let r = 2; r < rows.length; r += 1) {
    const v = cell(r, 8);
    if (typeof v === "string" && /±\d/.test(v)) names.push(v);
  }
  assert.ok(names.length >= 5, "应有多条带容差的商品名称，实际 " + JSON.stringify(names));
  // 至少一条能同时看到「容差 + 耐压」，如 100nF ±10% 100V 编带
  assert.ok(names.some((v) => /±\d+%\s*\d+(\.\d+)?\s*[Vv]/.test(v)),
    "应能看到「容差 + 耐压」同时出现：" + JSON.stringify(names.slice(0, 5)));
});

/* ------------------------------------------------------------ §4 边界 */

t("非 .xls 输入要明确报错（不猜、不静默返回空表）", () => {
  assert.throws(() => readXlsRows(Buffer.from("PK\x03\x04not an xls at all")), /OLE2|\.xls/, "xlsx 字节应报错");
  assert.throws(() => readXlsRows(Buffer.from("order,status\n1,2\n")), /OLE2|\.xls/, "CSV 文本应报错");
});

t("截断的文件不会**假装成功**（宁可报错也不给半张表）", () => {
  if (!HAS_FIX) return;
  const buf = fs.readFileSync(FIX);
  const cut = buf.slice(0, Math.floor(buf.length / 2));
  let threw = false;
  let result = null;
  try { result = readXlsRows(cut); } catch (exc) { threw = true; }
  // 要么抛错，要么给出**明显不完整**的结果——不许"看着像成功"
  if (!threw) {
    const looksWrong = !result || result.length < 3
      || JSON.stringify(result[1] || []).indexOf("订单编号") === -1;
    assert.ok(looksWrong, "截断文件不该读出一张完整的表（实际读出 " + (result && result.length) + " 行）");
  }
});

/* --------------------------------------------------------------- 执行 */

(async () => {
  if (!HAS_FIX) {
    console.log("注意：fixture 不存在（tests/fixtures/sample_statement");
  }
  for (const item of QUEUE) {
    try {
      await item.fn();
      passCount += 1;
      console.log("  PASS  " + item.name);
    } catch (exc) {
      failures.push({ name: item.name, message: String(exc && exc.message ? exc.message : exc) });
      console.log("  FAIL  " + item.name + "\n        " + String(exc.message).split("\n")[0]);
    }
  }
  console.log("\n" + "=".repeat(64));
  console.log(`T45（.xls / BIFF8 读取器）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
