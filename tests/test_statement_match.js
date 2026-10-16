"use strict";
/** T45（对账单 ↔ 库中器件 匹配）— 三桶：严格命中 / 疑似（人工裁决）/ 新增 */
const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const m = require(path.join(ROOT, "src", "services", "statement_match.js"));
const st = require(path.join(ROOT, "src", "services", "lcsc_statement.js"));

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

/** 对账单明细的最小构造（只带匹配用得上的字段） */
const item = (over) => Object.assign({
  category: "贴片电容(MLCC)", value: "100nF", tolerance: "±10%", voltage: "100V",
  manufacturer_part: "TCC0603X7R104K101CTM", footprint: "0603", quantity: 50,
}, over || {});
/** 库中器件的最小构造 */
const part = (over) => Object.assign({
  id: "p_0001", category: "贴片电容(MLCC)", value: "100nF", tolerance: "±10%", voltage: "100V",
  manufacturer_part: "TCC0603X7R104K101CTM", footprint: "0603", quantity: 3,
}, over || {});

/* ----------------------------------------------------------- §1 归一化 */

t("归一化：空白/大小写/全角括号/连字符 不影响匹配", () => {
  assert.strictEqual(m.norm("  100NF  "), "100nf");
  assert.strictEqual(m.norm("贴片电容（MLCC）"), "贴片电容(mlcc)");
  assert.strictEqual(m.norm("0603"), "0603");
  const a = m.itemKey(item({ category: "贴片电容（MLCC）", value: "100NF" }));
  const b = m.partKey(part({ category: "贴片电容(MLCC)", value: "100nf" }));
  assert.strictEqual(a.category, b.category);
  assert.strictEqual(a.value, b.value);
});

/* --------------------------------------------------------- §2 三桶判定 */

t("四项全等 → **严格命中**（数量相加由入库层做，这里只负责对上）", () => {
  const r = m.matchStatement([item()], [part()]);
  assert.strictEqual(r.matched.length, 1);
  assert.strictEqual(r.matched[0].index, 0);
  assert.strictEqual(r.suspected.length, 0);
  assert.strictEqual(r.missing.length, 0);
});

t("库里**缺容差/耐压**（BOM 建的器件就是这样）→ **疑似**，不自动合并、也不当新增", () => {
  const r = m.matchStatement([item()], [part({ tolerance: "", voltage: "" })]);
  assert.strictEqual(r.matched.length, 0, "缺项时不该算严格命中");
  assert.strictEqual(r.suspected.length, 1, "应进「疑似」交人工裁决");
  assert.strictEqual(r.missing.length, 0, "不该直接当新器件（会造成重复）");
  const diff = r.suspected[0].candidates[0].diff.join(" ");
  assert.ok(/tolerance/.test(diff) && /voltage/.test(diff), "差异清单要说明差在哪：" + diff);
});

t("参数**不一致**（如耐压不同）→ 也是疑似，且差异清单写清两边值", () => {
  const r = m.matchStatement([item({ voltage: "50V" })], [part({ voltage: "100V" })]);
  assert.strictEqual(r.suspected.length, 1);
  const diff = r.suspected[0].candidates[0].diff.join(" ");
  assert.ok(/100v/.test(diff) && /50v/.test(diff), diff);
});

t("型号+封装都对不上 → **新增**", () => {
  const r = m.matchStatement([item()], [part({ manufacturer_part: "别的型号" })]);
  assert.strictEqual(r.missing.length, 1);
  assert.strictEqual(r.matched.length + r.suspected.length, 0);
});

t("**品牌不参与匹配**：品牌不同但四字段相同 → 仍算严格命中（用户明确要求）", () => {
  const r = m.matchStatement([item({ manufacturer: "CCTC(三环)" })],
    [part({ manufacturer: "别家" })]);
  assert.strictEqual(r.matched.length, 1, "品牌不同不该影响匹配");
});

t("**立创 C 编码不参与匹配**：库里没有/不同，也照样命中", () => {
  const r = m.matchStatement([item({ supplier_part: "C48543656" })],
    [part({ supplier_part: "" })]);
  assert.strictEqual(r.matched.length, 1);
});

t("同型号多条候选 → 全部列进疑似（人自己挑，不替人挑）", () => {
  const parts = [part({ id: "p_0001", voltage: "" }), part({ id: "p_0002", voltage: "25V" })];
  const r = m.matchStatement([item({ voltage: "100V" })], parts);
  assert.strictEqual(r.suspected.length, 1);
  assert.strictEqual(r.suspected[0].candidates.length, 2, "两个疑似候选都要列出来");
  assert.deepStrictEqual(r.suspected[0].candidates.map((c) => c.part.id), ["p_0001", "p_0002"]);
});

t("严格命中优先于疑似：库里有完全一致的就直接命中，不再列疑似", () => {
  const parts = [part({ id: "p_0001", voltage: "" }), part({ id: "p_0002" })];
  const r = m.matchStatement([item()], parts);
  assert.strictEqual(r.matched.length, 1);
  assert.strictEqual(r.matched[0].part.id, "p_0002");
  assert.strictEqual(r.suspected.length, 0);
});

t("空库 / 空明细：不抛错，全部归入对应桶", () => {
  assert.deepStrictEqual(m.matchStatement([], []), { matched: [], suspected: [], missing: [] });
  const r = m.matchStatement([item()], []);
  assert.strictEqual(r.missing.length, 1);
});

/* ------------------------------------------- §3 与真实对账单串起来 */

t("用真实对账单的明细匹配一个空库 → 8 条全进「新增」（不炸、不丢）", () => {
  const FIX = path.join(__dirname, "fixtures", "sample_statement");
  if (!require("fs").existsSync(FIX)) return;
  const parsed = st.parseStatementFile(FIX);
  assert.strictEqual(parsed.ok, true, parsed.error);
  const r = m.matchStatement(parsed.items, []);
  assert.strictEqual(r.missing.length, parsed.items.length);
  assert.strictEqual(r.matched.length, 0);
  for (const x of r.missing) {
    assert.ok(x.item.quantity > 0 && x.item.manufacturer_part, JSON.stringify(x.item));
  }
});

(async () => {
  for (const it of QUEUE) {
    try { await it.fn(); passCount += 1; console.log("  PASS  " + it.name); }
    catch (exc) {
      failures.push(it.name);
      console.log("  FAIL  " + it.name + "\n        " + String(exc.message).split("\n")[0]);
    }
  }
  console.log("\n" + "=".repeat(64));
  console.log(`T45（对账单匹配）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
