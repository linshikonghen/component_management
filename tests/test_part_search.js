"use strict";
/**
 * test_part_search.js — 检索/筛选/相似产品（用户 2026-10-17 目标）
 *
 * 为什么单独一套：`src/services/part_search.js` 是"检索与相似产品"的**唯一定义处**，
 * 库存页与领料页都通过 `parts:list` 走它。这里钉住三件事：
 *   ① 字面命中（FR-5.2 跨字段）
 *   ② **相似产品**的认定：值归一后相同（0.1uF ↔ 100nF、4K7 ↔ 4.7kΩ、10K ↔ 10kΩ、0R ↔ 0Ω）或型号归一相同
 *   ③ 筛选（FR-5.3）：分类 / 封装 / 耐压（大小写不敏感）/ 只看低库存；facets 用全量算
 */

const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const search = require(path.join(ROOT, "src", "services", "part_search"));
const partsMod = require(path.join(ROOT, "src", "services", "parts"));

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }
function section(title) { QUEUE.push({ section: title }); }
async function runQueue() {
  for (const item of QUEUE) {
    if (item.section) { console.log("\n=== " + item.section + " ==="); continue; }
    try {
      item.fn();
      passCount += 1;
      console.log("  PASS  " + item.name);
    } catch (exc) {
      failures.push({ name: item.name, message: String((exc && exc.message) || exc) });
      console.log("  FAIL  " + item.name);
      console.log("        " + String((exc && exc.message) || exc).split("\n").join("\n        "));
    }
  }
}

const LIB = [
  { id: "p1", category: "贴片电容(MLCC)", value: "100nF", footprint: "C0603", voltage: "50V", tolerance: "±10%", quantity: 10, part_number: "M1" },
  { id: "p2", category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", voltage: "50V", tolerance: "±10%", quantity: 5, part_number: "M2" },
  { id: "p3", category: "贴片电阻", value: "4.7kΩ", footprint: "R0603", voltage: "", tolerance: "±1%", quantity: 3, part_number: "M3" },
  { id: "p4", category: "贴片电阻", value: "10kΩ", footprint: "R0603", voltage: "", tolerance: "±1%", quantity: 7, part_number: "M4" },
  { id: "p5", category: "贴片电阻", value: "10k", footprint: "R0805", voltage: "", tolerance: "±1%", quantity: 2, part_number: "M5" },
  { id: "p6", category: "贴片电容(MLCC)", value: "1uF", footprint: "C0603", voltage: "25V", tolerance: "±10%", quantity: 9, part_number: "M6" },
  { id: "p7", category: "场效应管(MOSFET)", value: "AO3401A", footprint: "SOT-23", voltage: "30V", tolerance: "", quantity: 1, part_number: "AO3401A" },
];
const SETTINGS = {}; // findLowStock 对空设置不报错；需要低库存用例时显式给 min_quantity

const ids = (r) => r.parts.map((p) => p.id);
const list = (query) => partsMod.listParts(LIB, query, SETTINGS);

section("§1 prepareQuery：什么时候把查询词当成「值」")

t("值形态的查询会被归一（0.1uF→100nF、4K7→4.7kΩ、10K→10kΩ）；非值形态不当值", () => {
  assert.strictEqual(search.prepareQuery("0.1uF").value, "100nF");
  assert.strictEqual(search.prepareQuery("4K7").value, "4.7kΩ");
  assert.strictEqual(search.prepareQuery("10K").value, "10kΩ");
  assert.strictEqual(search.prepareQuery("0R").value, "0Ω");
  assert.strictEqual(search.prepareQuery("电阻").value, "", "「电阻」不是值");
  assert.strictEqual(search.prepareQuery("C0603").value, "", "封装不是值");
  assert.strictEqual(search.prepareQuery("").value, "");
});

section("§2 相似产品的认定（用户目标：检索相似产品的应对方法）")

t("写法不同但值相同 → similar：搜 0.1uF 能带出 100nF，反之亦然", () => {
  const a = list({ q: "0.1uF" });
  assert.ok(ids(a).includes("p1"), "0.1uF 应带出 100nF（p1）：" + ids(a));
  assert.ok(a.similar_ids.includes("p1"), "p1 应标为相似：" + JSON.stringify(a.similar_ids));
  assert.ok(ids(a).includes("p2"), "写法相同的 p2 应精确命中");
  assert.ok(!a.similar_ids.includes("p2"), "字面命中的不算相似");

  const b = list({ q: "100nF" });
  assert.ok(ids(b).includes("p2"), "100nF 应带出 0.1uF（p2）");
  assert.ok(b.similar_ids.includes("p2"));
});

t("EIA 简写 / Ω·R 差异 / 大小写都算同一个值：4K7、4.7k、4k7Ω、0R", () => {
  for (const q of ["4K7", "4.7k", "4.7KΩ", "4k7"]) {
    const r = list({ q });
    assert.ok(ids(r).includes("p3"), `搜「${q}」应命中 4.7kΩ（p3）：` + ids(r));
  }
  const zero = [{ id: "z1", value: "0Ω", footprint: "R0603", quantity: 1 }];
  const r0 = partsMod.listParts(zero, { q: "0R" }, SETTINGS);
  assert.deepStrictEqual(ids(r0), ["z1"], "0R 与 0Ω 是同一个值");
  assert.deepStrictEqual(r0.similar_ids, ["z1"], "0R 是相似命中（字面不含 0r）");
});

t("不同的值不会被误判成相似（1uF ≠ 100nF、10kΩ ≠ 100kΩ）", () => {
  assert.deepStrictEqual(list({ q: "100nF" }).similar_ids, ["p2"], "只有 0.1uF 是相似，1uF 不能被误判");
  const r = list({ q: "100k" });
  assert.strictEqual(r.parts.length, 0, "库里没有 100k，不能被 10k 之类误命中：" + ids(r));
});

t("型号归一后相同也算相似（「AO3401 A」能命中型号 AO3401A）", () => {
  const r = list({ q: "AO3401 A" });
  assert.ok(ids(r).includes("p7"), "空格写法差异应命中型号：" + ids(r));
  assert.ok(r.similar_ids.includes("p7"), "这条应是相似命中：" + JSON.stringify(r.similar_ids));
});

t("精确命中排在相似前面（stable，同组保持库内顺序）", () => {
  const r = list({ q: "0.1uF" });
  assert.strictEqual(ids(r)[0], "p2", "字面命中的 0.1uF 应排第一：" + ids(r));
  const exactFirst = r.parts.map((p) => (r.similar_ids.includes(p.id) ? "S" : "E"));
  assert.strictEqual(exactFirst.join(""), "ES".slice(0, exactFirst.length), "前精确后相似：" + exactFirst.join(""));
});

t("**容差写法不同 → 相似**：±1% ↔ +/-1% ↔ 1%；±10% ↔ +/-10%", () => {
  const lib = [
    { id: "t1", value: "4.7kΩ", footprint: "R0603", tolerance: "+/-1%", quantity: 1 },
    { id: "t2", value: "10kΩ", footprint: "R0603", tolerance: "±1%", quantity: 1 },
    { id: "t3", value: "100nF", footprint: "C0603", tolerance: "+/-10%", quantity: 1 },
  ];
  const r1 = partsMod.listParts(lib, { q: "±1%" }, SETTINGS);
  assert.ok(r1.parts.some((x) => x.id === "t1"), "±1% 应带出 +/-1% 的料（相似）：" + ids(r1));
  assert.ok(r1.similar_ids.includes("t1"), "且标为相似");
  assert.ok(r1.parts.some((x) => x.id === "t2"), "字面 ±1% 的精确命中");
  const r3 = partsMod.listParts(lib, { q: "+/-10%" }, SETTINGS);
  assert.deepStrictEqual(ids(r3), ["t3"], "写法不同但容差相同的料應被找到");
});

t("**全角输入也能搜**（从 Excel/中文输入法粘进来的 `１００ｎＦ`）", () => {
  const r = list({ q: "１００ｎＦ" });
  assert.ok(ids(r).includes("p1"), "全角 100nF 应命中 p1：" + ids(r));
  const fx = [{ id: "fx", value: "100nF", footprint: "C0603", quantity: 1 }];
  const r2 = partsMod.listParts(fx, { q: "１００ｎＦ" }, SETTINGS);
  assert.deepStrictEqual(ids(r2), ["fx"], "全角查询应字面命中（全角折半后比较）");
});

t("**混合写法里取值**：`100nF 50V`、`100nF/50V` 也能找到 100nF（及相似写法）", () => {
  for (const q of ["100nF 50V", "100nF/50V", "100nF，50V"]) {
    const r = list({ q });
    assert.ok(ids(r).includes("p1"), `「${q}」应命中 100nF（p1）：` + ids(r));
    assert.ok(ids(r).includes("p2"), `「${q}」也应带出 0.1uF（相似）：` + ids(r));
  }
});

t("**封装/型号宽松归一**：SOT23 ↔ SOT-23；MPN 去掉连字符也能对上", () => {
  const r = list({ q: "SOT23" });
  assert.ok(ids(r).includes("p7"), "SOT23 应命中封装 SOT-23 的料：" + ids(r));
  const fx = [{ id: "mpn", value: "4.7kΩ", footprint: "R0603", part_number: "RC0603FR-074K7L", quantity: 1 }];
  const r3 = partsMod.listParts(fx, { q: "RC0603FR074K7L" }, SETTINGS);
  assert.deepStrictEqual(ids(r3), ["mpn"], "去连字符的 MPN 应相似命中");
  assert.deepStrictEqual(r3.similar_ids, ["mpn"], "并标为相似");
});

t("扩展的相似规则**不误伤普通关键字**（搜 0603 是字面命中，不因宽松归一乱标相似）", () => {
  const r = list({ q: "0603" });
  assert.ok(r.parts.length >= 1, "0603 应命中 C0603/R0603 等");
  assert.deepStrictEqual(r.similar_ids, [], "这些都是字面命中（封装字符串里含 0603），不该标相似：" + JSON.stringify(r.similar_ids));
  assert.deepStrictEqual(ids(list({ q: "不存在的料" })), [], "普通无结果关键字不应被相似规则命中");
});

section("§2b 多关键字 AND 与相关性排序（行业常规）")

t("多关键字是 **AND**：每个词都要命中同一器件，缺一个就不算", () => {
  const r = list({ q: "贴片 0603" });
  assert.ok(ids(r).includes("p1") && ids(r).includes("p3"), "贴片 + 0603 的料都要在：" + ids(r));
  assert.ok(!ids(r).includes("p5"), "R0805 不含 0603，不能命中");
  assert.ok(!ids(r).includes("p7"), "场效应管不算「贴片」，不能命中");
  assert.deepStrictEqual(r.similar_ids, [], "多关键字命中属于 tokenized，不标「相似」");
  assert.deepStrictEqual(ids(list({ q: "贴片 9999" })), [], "缺一个关键字 → 不命中（AND 不是 OR）");
  assert.deepStrictEqual(ids(list({ q: "村田 100nF" })), [],
    "制造商标不是村田 → AND 不成立（不能被 100nF 的值相似带出来）");
});

t("AND 允许写法差异：`100nF 50V` 也能找到库里的 `0.1uF`（同值），`100nF 25V` 则不能", () => {
  const hit = list({ q: "100nF 50V" });
  assert.ok(ids(hit).includes("p1") && ids(hit).includes("p2"), "同值的 0.1uF 也要在：" + ids(hit));
  assert.ok(hit.similar_ids.includes("p2"), "0.1uF 是值归一相似");
  assert.deepStrictEqual(ids(list({ q: "100nF 25V" })), [], "耐压不匹配 → 不命中");
});

t("排序遵循「越精确越靠前」：值完全相等 > 值前缀 > 值子串", () => {
  const lib = [
    { id: "v1", value: "10kΩ", footprint: "R0603", quantity: 1 },
    { id: "v2", value: "510kΩ", footprint: "R0603", quantity: 1 },
    { id: "v3", value: "10kΩ 1%", footprint: "R0603", quantity: 1 },
  ];
  const r = partsMod.listParts(lib, { q: "10kΩ" }, SETTINGS);
  assert.deepStrictEqual(ids(r), ["v1", "v3", "v2"], "完全相等 > 前缀 > 子串（实际：" + ids(r) + "）");
});

section("§3 筛选（FR-5.3）：分类 / 封装 / 耐压 / 低库存")

t("分类筛选（精确）、封装筛选（大小写不敏感）、耐压筛选（大小写不敏感）", () => {
  assert.deepStrictEqual(ids(list({ category: "贴片电阻" })), ["p3", "p4", "p5"]);
  assert.deepStrictEqual(ids(list({ footprint: "c0603" })), ["p1", "p2", "p6"]);
  assert.deepStrictEqual(ids(list({ voltage: "50v" })), ["p1", "p2"]);
});

t("筛选与检索可组合（耐压 50V + 搜 100nF → 命中 + 相似）", () => {
  const r = list({ q: "100nF", voltage: "50V" });
  assert.deepStrictEqual(ids(r), ["p1", "p2"]);
  assert.deepStrictEqual(r.similar_ids, ["p2"]);
});

t("只看低库存（low_stock_only）", () => {
  const withMin = [
    { id: "a", category: "贴片电阻", value: "1kΩ", footprint: "R0603", quantity: 1, min_quantity: 10 },
    { id: "b", category: "贴片电阻", value: "2kΩ", footprint: "R0603", quantity: 50, min_quantity: 10 },
  ];
  const r = partsMod.listParts(withMin, { low_stock_only: true }, {});
  assert.deepStrictEqual(ids(r), ["a"], "只有低于阈值的那条");
});

t("facets 用**全部**器件算（不受当前筛选影响），且去空去重排序", () => {
  const r = list({ category: "贴片电阻" });
  assert.deepStrictEqual(r.facets.categories, ["贴片电容(MLCC)", "场效应管(MOSFET)", "贴片电阻"].sort((a, b) => a.localeCompare(b, "zh")));
  assert.deepStrictEqual(r.facets.footprints, ["C0603", "R0603", "R0805", "SOT-23"]);
  assert.deepStrictEqual(r.facets.voltages, ["25V", "30V", "50V"]);
});

section("§4 与 listParts 的整合（总数 / 相似标记 / 排序）")

t("total 是筛选/检索后的条数，all_total 是库中总数", () => {
  const r = list({ q: "100nF" });
  assert.strictEqual(r.total, 2, "100nF + 0.1uF");
  assert.strictEqual(r.all_total, LIB.length);
  const empty = list({ q: "不存在" });
  assert.deepStrictEqual(ids(empty), []);
  assert.strictEqual(empty.total, 0);
  assert.strictEqual(empty.all_total, LIB.length);
});

t("检索结果仍可按列排序（相似命中也参与排序，不丢）", () => {
  const r = partsMod.listParts(LIB, { q: "100nF", sort_by: "quantity", sort_dir: "desc" }, SETTINGS);
  assert.deepStrictEqual(ids(r), ["p1", "p2"], "按数量降序：10 → 5");
  assert.strictEqual(r.similar_ids.length, 1, "相似标记不因排序丢失");
});

/* ---------------------------------------------------------------- 执行 */

runQueue().then(() => {
  console.log("\n" + "=".repeat(64));
  console.log(`T105（检索/筛选/相似产品）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
