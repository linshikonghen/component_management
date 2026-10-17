"use strict";
/** T45（对账单入库计算）— 合并/新增/留痕/只补空 逐条钉住 */
const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const c = require(path.join(ROOT, "src", "services", "statement_commit.js"));
const ids = require(path.join(ROOT, "src", "services", "ids.js"));

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

const NOW = () => "2026-10-16T10:00:00+08:00";
const item = (over) => Object.assign({
  row_no: 2, category: "贴片电容(MLCC)", value: "100nF", tolerance: "±10%", voltage: "100V",
  manufacturer_part: "TCC0603X7R104K101CTM", footprint: "0603", quantity: 50,
}, over || {});
const part = (over) => Object.assign({
  id: "p_0001", category: "贴片电容(MLCC)", value: "100nF", tolerance: "±10%", voltage: "100V",
  footprint: "0603", manufacturer_part: "TCC0603X7R104K101CTM", quantity: 3,
  manufacturer: "", supplier_part: "", min_quantity: "", location: "", note: "",
}, over || {});
const plan = (over) => c.planStatementCommit(Object.assign({
  parts: [], merged: [], created: [], order_ref: "SO26101418868", now: NOW,
  next_id: ids.nextPartId,
}, over || {}));

/* ------------------------------------------------------------ §1 合并 */

t("合并：数量相加（3 + 50 = 53），且不动调用方的原数组", () => {
  const parts = [part()];
  const r = plan({ parts, merged: [{ item: item(), part: parts[0] }] });
  assert.strictEqual(r.parts.length, 1);
  assert.strictEqual(r.parts[0].quantity, 53);
  assert.strictEqual(parts[0].quantity, 3, "原数组不该被就地改（要能回滚/对比）");
  assert.strictEqual(r.summary.merged_count, 1);
  assert.strictEqual(r.summary.quantity_in, 50);
});

t("**只补空、不覆盖**：库里容差为空 → 补上；已有值 → 一个字节都不动", () => {
  const empty = part({ id: "p_0001", tolerance: "", voltage: "" });
  const full = part({ id: "p_0002", tolerance: "±1%", voltage: "50V" });
  const r = plan({
    parts: [empty, full],
    merged: [
      { item: item(), part: empty },
      { item: item({ tolerance: "±10%", voltage: "100V" }), part: full },
    ],
  });
  assert.strictEqual(r.parts[0].tolerance, "±10%", "空的要补上");
  assert.strictEqual(r.parts[0].voltage, "100V");
  assert.strictEqual(r.parts[1].tolerance, "±1%", "已有值不能被对账单覆盖");
  assert.strictEqual(r.parts[1].voltage, "50V");
});

/* ------------------------------------------------------------ §2 新增 */

t("新增：数量 = 订购数量，id 递增，**不写位号**（对账单没有位号）", () => {
  const r = plan({ created: [item(), item({ row_no: 3, manufacturer_part: "另一个", quantity: 5 })] });
  assert.strictEqual(r.parts.length, 2);
  assert.deepStrictEqual(r.parts.map((p) => p.id), ["p_0001", "p_0002"]);
  assert.deepStrictEqual(r.parts.map((p) => p.quantity), [50, 5]);
  assert.strictEqual("designators" in r.parts[0], false, "对账单路径不写位号字段");
  assert.strictEqual(r.parts[0].category, "贴片电容(MLCC)", "分类取商品类型");
  assert.ok(/SO26101418868/.test(r.parts[0].note), "备注里留下对账单号，事后可查： " + r.parts[0].note);
});

t("新增的 id 会避开**已删器件**用过的号（沿用 ids.nextPartId 的既有保证）", () => {
  const r = plan({
    parts: [],
    existing_movements: [{ part_id: "p_0007", kind: "out", delta: -1 }],
    created: [item()],
  });
  assert.strictEqual(r.parts[0].id, "p_0008", "变动记录里用过的号不能复用");
});

t("新增：同一批里两条同型号缺不同参数 → 分别建两个器件（数量各自算）", () => {
  const r = plan({
    created: [
      item({ row_no: 2, voltage: "100V", quantity: 50 }),
      item({ row_no: 6, voltage: "50V", quantity: 20 }),
    ],
  });
  assert.strictEqual(r.parts.length, 2);
  assert.deepStrictEqual(r.parts.map((p) => p.voltage), ["100V", "50V"]);
  assert.strictEqual(r.summary.quantity_in, 70);
});

/* ------------------------------------------------------------ §3 留痕 */

t("留痕**一条不漏**：合并的 in + 新增的 init 都在返回里", () => {
  const p = part();
  const r = plan({
    parts: [p],
    merged: [{ item: item(), part: p }],
    created: [item({ row_no: 6, manufacturer_part: "另一个", quantity: 20 })],
  });
  assert.strictEqual(r.movements.length, 2, "一笔合并 + 一笔新建 = 2 条留痕，实际 " + r.movements.length);
  const kinds = r.movements.map((m) => m.kind).sort();
  assert.deepStrictEqual(kinds, ["in", "init"]);
  for (const m of r.movements) {
    assert.strictEqual(m.ref, "SO26101418868", "留痕要带对账单号");
    assert.ok(/对账单/.test(m.reason), m.reason);
    assert.ok(typeof m.statement_row === "number" || m.statement_row === null, "要记下对账单行号");
    assert.strictEqual(m.at, NOW(), "时间取自注入的时钟（可钉死）");
  }
  const inRec = r.movements.find((m) => m.kind === "in");
  assert.strictEqual(inRec.before, 3);
  assert.strictEqual(inRec.after, 53);
  assert.strictEqual(inRec.delta, 50);
});

/* ------------------------------------------------------------ §4 边界 */

t("数量非法（0/负数/文字/空）→ 按 0 算，不抛错、也不静默算成大数", () => {
  const p = part();
  for (const bad of [0, -5, "abc", "", null, undefined]) {
    const r = plan({ parts: [p], merged: [{ item: item({ quantity: bad }), part: p }], order_ref: "X" });
    assert.strictEqual(r.summary.quantity_in, 0, `数量 ${JSON.stringify(bad)} 应算 0`);
    assert.strictEqual(r.parts[0].quantity, 3, "库存不该变");
    assert.strictEqual(r.movements.length, 1, "但仍要留一条 delta=0 的痕（有操作就有记录）");
  }
});

t("决定指向不存在的器件 → 跳过该条，不炸（调用方应先校验，但这里不能崩）", () => {
  const r = plan({ parts: [part()], merged: [{ item: item(), part: { id: "p_9999" } }] });
  assert.strictEqual(r.parts[0].quantity, 3);
  assert.strictEqual(r.movements.length, 0);
});

t("空输入 → 空结果（不抛错）", () => {
  const r = plan({});
  assert.deepStrictEqual(r.parts, []);
  assert.deepStrictEqual(r.movements, []);
  assert.strictEqual(r.summary.quantity_in, 0);
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
  console.log(`T45（对账单入库计算）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
