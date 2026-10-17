"use strict";
/**
 * T45（对账单解析）— 用**真实对账单**当基准
 *
 * 口径（用户 2026-10-16 决定）：
 *   · 只用于**入库**；导出/比对不动
 *   · 只用 **H–L 列**（商品类型/商品名称/商品型号/封装格式/订购数量）
 *   · 匹配键 = 商品类型 + 商品名称(值/容差/耐压) + 商品型号 + 封装（不用品牌、不用 C 编码）
 *   · 无位号；分类以「商品类型」为准，阈值键由它推出
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const st = require(path.join(ROOT, "src", "services", "lcsc_statement.js"));

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

const FIX = path.join(__dirname, "fixtures", "sample_statement");
const HAS_FIX = fs.existsSync(FIX);
const parsed = HAS_FIX ? st.parseStatementFile(FIX) : { ok: false, items: [], warnings: [] };

/* --------------------------------------------------- §1 商品名称解析 */

t("商品名称 → 值/容差/耐压，包装词（编带）被剔掉", () => {
  assert.deepStrictEqual(
    (({ value, tolerance, voltage, pack }) => ({ value, tolerance, voltage, pack }))(st.parseProductName("100nF ±10% 100V 编带")),
    { value: "100nF", tolerance: "±10%", voltage: "100V", pack: "编带" },
  );
  assert.deepStrictEqual(
    (({ value, tolerance, voltage }) => ({ value, tolerance, voltage }))(st.parseProductName("22uF ±20% 25V 编带")),
    { value: "22uF", tolerance: "±20%", voltage: "25V" },
  );
  // 没有容差/耐压的也照样解出值（如电感 `47uH`）
  assert.strictEqual(st.parseProductName("47uH").value, "47uH");
  assert.strictEqual(st.parseProductName("47uH").voltage, "");
  // 空/缺省不炸
  assert.strictEqual(st.parseProductName("").value, "");
  assert.strictEqual(st.parseProductName(null).value, "");
});

t("**不猜材质**：商品名称里没有材质就留空（材质藏在型号里，spec 禁止自动识别）", () => {
  const p = st.parseProductName("100nF ±10% 100V 编带");
  assert.strictEqual(p.value, "100nF");
  assert.strictEqual(p.extra, "", "不该从别处猜出材质塞进来");
});

/* ------------------------------------------- §2 分类 → 阈值键（不猜） */

t("商品类型 → 阈值键（**只跟分类单一来源**走，且显示的键=判定真正会用的键）", () => {
  assert.strictEqual(st.thresholdKey("贴片电容(MLCC)"), "C");
  assert.strictEqual(st.thresholdKey("贴片电阻"), "R");
  assert.strictEqual(st.thresholdKey("电感"), "L");
  assert.strictEqual(st.thresholdKey("连接器"), "CN");
  // **行为变更（独立复核发现后修）**：原来本模块自带一张正则表，它给 `发光二极管` D（实际 LED）、
  // `排针` CN（实际 H）；而 `固态电容` 当时"看名字像电容"给 C(20)，但 low_stock 映射不到、实际用
  // `_default`(5) → 核对表里显示的阈值是**假的**（用户按 20 备货、系统按 5 报警）。
  // 现在只跟单一来源走，显示的键 == 判定真正会用的键 ✓
  // `固态电容` 后续由**用户裁定**归入电容类 → 两边都是 C（20），一致 ✓
  assert.strictEqual(st.thresholdKey("固态电容"), "C", "已裁定归电容类（单一来源里就是 C）");
  assert.strictEqual(st.thresholdKey("发光二极管"), "LED", "不能按名字里的「二极管」给 D");
  assert.strictEqual(st.thresholdKey("排针"), "H", "不能给 CN");
  // 仍未归类的表外名字：不猜，落 `_default`，并在核对表里显示出来
  assert.strictEqual(st.thresholdKey("火星牌电容"), "_default");
  assert.strictEqual(st.thresholdKey("某种没见过的品类"), "_default");
  assert.strictEqual(st.thresholdKey(""), "_default");
});

/* ------------------------------------------------------- §3 表头识别 */

t("认不出表头 → **明确报错**（只认对账单，绝不猜哪列是数量）", () => {
  const r = st.parseStatementRows([["No.", "Quantity", "Comment"], ["1", "8", "10uF"]]);
  assert.strictEqual(r.ok, false);
  assert.ok(/不是立创商城的物料明细对账单/.test(r.error), r.error);
  assert.ok(/商品名称/.test(r.error), "应指出缺哪个表头：" + r.error);
});

t("表头在第 0 行有噪声时也能找到（真实文件就是这样：第 0 行是 `1:￥89.60`）", () => {
  if (!HAS_FIX) return;
  assert.strictEqual(parsed.ok, true, parsed.error);
  assert.ok(Number.isInteger(parsed.header_row), "应报出表头行号");
  assert.ok(parsed.header_row >= 1, "这份文件的表头不在第 0 行，行号应为 1，实际 " + parsed.header_row);
});

/* --------------------------------------------------- §4 真实数据抽样 */

t("真实对账单：明细条数与首条逐字段正确", () => {
  if (!HAS_FIX) return;
  assert.strictEqual(parsed.items.length, 8, "这份对账单有 8 条明细，实际 " + parsed.items.length);
  const it = parsed.items[0];
  assert.strictEqual(it.manufacturer_part, "TCC0603X7R104K101CTM");
  assert.strictEqual(it.footprint, "0603");
  assert.strictEqual(it.quantity, 50);
  assert.strictEqual(it.value, "100nF");
  assert.strictEqual(it.tolerance, "±10%");
  assert.strictEqual(it.voltage, "100V");
  assert.strictEqual(it.category, "贴片电容(MLCC)");
  assert.strictEqual(it.threshold_key, "C");
});

t("**标签行/合计行/说明行**不会被当成明细（也不报成「丢失数据」）", () => {
  if (!HAS_FIX) return;
  for (const it of parsed.items) {
    assert.ok(Number.isFinite(it.quantity) && it.quantity > 0, "明细数量应为正数：" + JSON.stringify(it));
    assert.ok(it.manufacturer_part !== "", "明细行必须有序号：" + JSON.stringify(it));
    assert.ok(!/商品合计金额|说明：|价外费用/.test(it.category + it.manufacturer_part),
      "标签行不该被当成明细：" + JSON.stringify(it));
  }
});

t("匹配键四字段在每条明细上都不是空的（否则匹配会误判）", () => {
  if (!HAS_FIX) return;
  for (const it of parsed.items) {
    assert.ok(it.category.trim() !== "", "缺商品类型：" + JSON.stringify(it));
    assert.ok(it.value.trim() !== "", "缺值：" + JSON.stringify(it));
    assert.ok(it.manufacturer_part.trim() !== "", "缺型号：" + JSON.stringify(it));
    assert.ok(it.footprint.trim() !== "", "缺封装：" + JSON.stringify(it));
  }
});

t("**位号不参与**：解析结果里根本没有位号字段（这条路径没有位号）", () => {
  if (!HAS_FIX) return;
  for (const it of parsed.items) {
    assert.strictEqual("designators" in it, false, "对账单路径不该有位号：" + JSON.stringify(it));
  }
});

t("同一份文件解析两次结果一致（可重复，不是「跑一次一个样」）", () => {
  if (!HAS_FIX) return;
  const again = st.parseStatementFile(FIX);
  assert.deepStrictEqual(again.items, parsed.items);
});

/* ------------------------------------------------------------ §5 边界 */

t("非 .xls（如 .csv）→ 明确说明目前只认 .xls", () => {
  const tmp = path.join(__dirname, "fixtures", "_stmt_probe.csv");
  fs.writeFileSync(tmp, "商品类型,商品名称\n", "utf8");
  try {
    const r = st.parseStatementFile(tmp);
    assert.strictEqual(r.ok, false);
    assert.ok(/只认 \.xls/.test(r.error), r.error);
  } finally {
    fs.unlinkSync(tmp);
  }
});

/* --------------------------------------------------------------- 执行 */

(async () => {
  if (!HAS_FIX) console.log("注意：对账单样本不在（含真实订单信息，已 .gitignore），跳过真实数据用例");
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
  console.log(`T45（对账单解析）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
