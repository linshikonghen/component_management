"use strict";
/**
 * statement_model.js 的无头测试 —— 核对表规则逐条钉住（FR-8.4 / FR-8.7 / AC-10:3）
 * 为什么先测模型：页面的判断（谁能提交、提交什么）不该只在"人手点一遍"里被验证。
 */
const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const M = require(path.join(ROOT, "renderer", "model", "statement_model.js"));

let pass = 0;
const fails = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

const item = (over) => Object.assign({
  row_no: 2, category: "贴片电容(MLCC)", threshold_key: "C", value: "100nF",
  tolerance: "±10%", voltage: "100V", manufacturer_part: "TCC0603X7R104K101CTM",
  footprint: "0603", quantity: 50,
}, over || {});

/** 一份典型解析结果：1 命中 / 1 疑似（库缺容差耐压）/ 1 新增 */
const PARSED = {
  items: [item({ row_no: 2 }), item({ row_no: 3, value: "22uF", voltage: "25V" }), item({ row_no: 6, manufacturer_part: "新的型号" })],
  matched: [{ row_no: 2, part_id: "p_0001" }],
  suspected: [{ row_no: 3, candidates: [{ part_id: "p_0007", diff: ["tolerance: 库里「空」 vs 对账单「±10%」"] }] }],
  missing: [6],
};

t("buildRows：三桶各自默认处置 —— 命中=合并、疑似=**待裁决**、新增=新建", () => {
  const rows = M.buildRows(PARSED);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].bucket, "matched");
  assert.strictEqual(rows[0].decision, "merge");
  assert.strictEqual(rows[0].part_id, "p_0001");
  assert.strictEqual(rows[1].bucket, "suspected");
  assert.strictEqual(rows[1].decision, "pending", "疑似**不能**替人决定");
  assert.strictEqual(rows[2].bucket, "missing");
  assert.strictEqual(rows[2].decision, "new");
});

t("**行号一致**：表格显示的「对账单行号」必须等于门禁文案里的行号（都是 row_no + 1）", () => {
  // 用户实测反馈：「提示 56 行待裁定，实际可以裁定的在 55 行」——
  // 表格原来显示解析下标（少 1），门禁显示 +1，两处差 1，用户按表格的号去找就对不上 ✗
  const rows = M.buildRows(PARSED);
  for (const row of rows) {
    assert.strictEqual(row.row_no_label, row.row_no + 1, "给人看的号 = 内部下标 + 1");
  }
  const suspected = rows.find((r) => r.decision === "pending");
  const gate = M.gateText(rows);
  const shown = String(suspected.row_no_label);
  assert.ok(gate.includes(`第 ${shown} 行`), `门禁文案里的行号应与表格一致（表格 ${shown}）：${gate}`);
  assert.ok(!gate.includes(`第 ${suspected.row_no} 行`), "不能再用内部下标当行号：" + gate);
  // 表格「行」列必须绑到 label 字段（否则又是两套号）
  // 2026-10-17：最前面新增了「入库」勾选列，所以按 key 找行号列（不假设它一定是第 0 列）
  const col = M.COLUMNS.find((c) => c.key === "row_no_label");
  assert.ok(col, "表格里必须有 row_no_label 列（对账单行号）");
  assert.strictEqual(col.label, "对账单行号");
  assert.strictEqual(M.COLUMNS[0].key, "selected", "第一列是「入库」勾选列（默认全选）");
});

t("**行号一致（错误文案）**：找不到行时的报错也用对账单行号（不是内部下标）", () => {
  const rows = M.buildRows(PARSED);
  const bad = M.setFieldEdit(rows, 999, "value", "x");
  assert.strictEqual(bad.ok, false);
  assert.ok(/第 1000 行/.test(bad.error), "报错要用对账单行号：" + bad.error);
  const noPart = M.setDecision(rows, 6, "merge", "");
  assert.strictEqual(noPart.ok, false);
  assert.ok(/第 7 行/.test(noPart.error), "报错要用对账单行号：" + noPart.error);
});

t("**疑似未裁决 → 不许提交**（人工闸门，AC-10:3）", () => {
  const rows = M.buildRows(PARSED);
  assert.strictEqual(M.canCommit(rows), false, "还有疑似没裁决时不得提交");
  assert.strictEqual(M.pendingRows(rows).length, 1);
  assert.ok(/需要你裁决/.test(M.gateText(rows)), M.gateText(rows));
  assert.ok(!/\*\*/.test(M.gateText(rows)), "界面文字里不能出现 markdown 星号");
});

t("裁决后（合并/新建/跳过都行）才允许提交", () => {
  let rows = M.buildRows(PARSED);
  const r1 = M.setDecision(rows, 3, "merge", "p_0007");
  assert.strictEqual(r1.ok, true, r1.error);
  rows = r1.rows;
  assert.strictEqual(M.canCommit(rows), true);
  assert.ok(/待入库：合并 2 条 · 新建 1 条 · 跳过 0 条 · 合计 150 件/.test(M.gateText(rows)), M.gateText(rows));
});

t("setDecision：非法处置/合并却没给器件/行号不存在 → 明确报错且**不改数据**", () => {
  const rows = M.buildRows(PARSED);
  assert.strictEqual(M.setDecision(rows, 3, "乱来").ok, false);
  assert.strictEqual(M.setDecision(rows, 3, "merge", "").ok, false);
  assert.strictEqual(M.setDecision(rows, 999, "new").ok, false);
  assert.strictEqual(rows[1].decision, "pending", "失败时原数组不该被改");
});

t("buildDecisions：只发真实决定，跳过的不发；疑似未裁决的也不发", () => {
  let rows = M.buildRows(PARSED);
  rows = M.setDecision(rows, 3, "merge", "p_0007").rows;
  rows = M.setDecision(rows, 6, "skip").rows;
  const d = M.buildDecisions(rows);
  assert.deepStrictEqual(d, [{ row_no: 2, action: "merge", part_id: "p_0001" }, { row_no: 3, action: "merge", part_id: "p_0007" }]);
});

t("gateText 的合计件数**不含**跳过与待裁决的行", () => {
  let rows = M.buildRows(PARSED);
  rows = M.setDecision(rows, 3, "merge", "p_0007").rows;
  // 三行各 50 → 150 件（我第一版心算成 120，是**期望值错了**，不是代码错）
  assert.ok(/合计 150 件/.test(M.gateText(rows)), M.gateText(rows));
  // 跳过一行后：150 − 50 = 100 件
  rows = M.setDecision(rows, 2, "skip").rows;
  assert.ok(/合计 100 件/.test(M.gateText(rows)), M.gateText(rows));
  // 还有疑似未裁决时，门禁文案只讲"需要裁决"，不报件数（避免让人以为可以点了）
  rows = M.setDecision(rows, 3, "merge", "p_0007").rows;
  const withPending = M.buildRows(PARSED);
  assert.ok(!/合计/.test(M.gateText(withPending)), M.gateText(withPending));
});

t("**勾选部分入库**（用户 2026-10-17）：默认全选；取消勾选的行不进决定、也不必裁决", () => {
  const rows = M.buildRows(PARSED);
  // 默认全选：用户要求「默认全选」，只是可以取消勾选少数几条
  assert.ok(rows.every((r) => r.selected === true), "默认应全部勾选");
  assert.strictEqual(M.selectedRows(rows).length, rows.length, "selectedRows = 全部");

  // 取消勾选那条「疑似」→ 它不再是 pending（没勾选就不需要裁决），也不进 decisions
  const suspected = rows.find((r) => r.decision === "pending");
  assert.ok(suspected, "夹具里应有一条疑似");
  let next = M.setSelected(rows, suspected.row_no, false);
  assert.strictEqual(next.find((r) => r.row_no === suspected.row_no).selected, false);
  assert.strictEqual(M.pendingRows(next).length, 0, "没勾选的疑似不该再拦提交");
  assert.strictEqual(M.canCommit(next), true, "只入库勾选的行是允许的");
  assert.ok(!M.buildDecisions(next).some((d) => d.row_no === suspected.row_no), "未勾选的行不能进 decisions");
  const gate = M.gateText(next);
  assert.ok(/未勾选 1 条/.test(gate), "门禁文案要说明有几条未勾选：" + gate);

  // 一条都不勾 → 不许提交，且文案告诉用户去哪勾
  const none = M.setSelectedMany(rows, null, false);
  assert.ok(none.every((r) => r.selected === false));
  assert.strictEqual(M.canCommit(none), false, "一条都没勾选不能提交");
  assert.ok(/还没有勾选/.test(M.gateText(none)), "文案要说清没勾选：" + M.gateText(none));

  // 「全选」能一键勾回来（按当前可见行传 row_no）
  const back = M.setSelectedMany(none, rows.map((r) => r.row_no), true);
  assert.ok(back.every((r) => r.selected === true), "全选应全部勾上");
});

t("**候选身份文案**：candidateText / suspectText 把「谁是谁」分开写清楚（用户反馈表述不清）", () => {
  const cand = {
    part_id: "p_0007", value: "22uF", footprint: "1206", voltage: "25V",
    dielectric: "", tolerance: "±20%", part_number: "M2", quantity: 5,
  };
  const c = M.candidateText(cand);
  assert.ok(c.includes("22uF") && c.includes("1206") && c.includes("25V"), "要含值/封装/耐压：" + c);
  assert.ok(c.includes("p_0007") && c.includes("库存 5"), "要含库中编号与库存：" + c);

  const rows = M.buildRows(PARSED);
  const suspect = rows.find((r) => r.bucket === "suspected");
  suspect.candidates = [cand];
  const t2 = M.suspectText(suspect);
  assert.ok(/^对账单这一行：/.test(t2), "先说对账单这一行：" + t2);
  assert.ok(/；库里候选：/.test(t2), "再说库里候选：" + t2);
  assert.ok(t2.includes("22uF"), "候选身份要在里面：" + t2);

  // 库里没有候选时也要说清（而不是让人猜）
  const noCand = M.suspectText(Object.assign({}, suspect, { candidates: [] }));
  assert.ok(/库里没有可合并的候选/.test(noCand), noCand);
});

t("**裁决可撤销**（resetDecision）：改回「待裁决」后重新拦住提交（点错了能改选）", () => {
  const rows = M.buildRows(PARSED);
  const suspected = rows.find((r) => r.decision === "pending");
  assert.ok(suspected, "夹具里应有疑似行");
  const decided = M.setDecision(rows, suspected.row_no, "new");
  assert.strictEqual(decided.ok, true);
  assert.strictEqual(M.canCommit(decided.rows), true, "裁决完应可提交");

  const back = M.resetDecision(decided.rows, suspected.row_no);
  assert.strictEqual(back.ok, true, back.error);
  const row = back.rows.find((r) => r.row_no === suspected.row_no);
  assert.strictEqual(row.decision, "pending", "应回到待裁决");
  assert.strictEqual(row.part_id, "", "part_id 也要清掉");
  assert.strictEqual(M.canCommit(back.rows), false, "回到待裁决后必须重新拦住提交");
  assert.ok(/需要你裁决/.test(M.gateText(back.rows)), "门禁文案要重新提示裁决");

  // 不存在的行 → 明确报错
  const bad = M.resetDecision(back.rows, 999);
  assert.strictEqual(bad.ok, false);
  assert.ok(/表里没有第 1000 行/.test(bad.error), bad.error);
});

t("summaryText：把入库汇总说清楚（含对账单号）", () => {
  const text = M.summaryText({ merged_count: 3, created_count: 5, quantity_in: 70, order_ref: "SO26101418868" });
  assert.ok(/合并 3 条/.test(text) && /新建 5 条/.test(text) && /共入库 70 件/.test(text) && /SO26101418868/.test(text), text);
});

/* ------------------------------------------- §5 人工可改（用户要求：按账单入库也能人工修改） */

t("**人工可改**：本次入库量可改；非整数/负数/空 被拒且**不改数据**", () => {
  let rows = M.buildRows(PARSED);
  const ok = M.setFieldEdit(rows, 2, "intake_quantity", "8");
  assert.strictEqual(ok.ok, true, ok.error);
  rows = ok.rows;
  assert.strictEqual(rows[0].intake_quantity, 8);
  assert.strictEqual(rows[0].edited, true, "改过要标记（留痕的依据）");
  for (const bad of ["", "abc", "-1", "1.5"]) {
    const r = M.setFieldEdit(rows, 2, "intake_quantity", bad);
    assert.strictEqual(r.ok, false, `数量 ${JSON.stringify(bad)} 应被拒绝`);
    assert.strictEqual(r.rows[0].intake_quantity, 8, "拒绝时不得改动数据");
  }
});

t("**人工可改**：值/容差/耐压/封装/型号 可改；「值」不许改空；分类不可改", () => {
  let rows = M.buildRows(PARSED);
  for (const [f, v] of [["value", "100nF"], ["tolerance", "±5%"], ["voltage", "50V"], ["footprint", "0805"], ["manufacturer_part", "NEW-1"]]) {
    const r = M.setFieldEdit(rows, 3, f, v);
    assert.strictEqual(r.ok, true, f + " 应可改：" + r.error);
    rows = r.rows;
    assert.strictEqual(rows[1][f], v);
  }
  assert.strictEqual(M.setFieldEdit(rows, 3, "value", "   ").ok, false, "值不能改空");
  assert.strictEqual(M.setFieldEdit(rows, 3, "category", "随便").ok, false, "分类是不可改字段（对账单事实）");
  assert.strictEqual(M.setFieldEdit(rows, 999, "value", "x").ok, false, "行号不存在要报错");
});

t("**改动必须随决定提交**：buildOverrides 只报改过的字段，没改就不带", () => {
  let rows = M.buildRows(PARSED);
  rows = M.setFieldEdit(rows, 2, "intake_quantity", "8").rows;
  rows = M.setFieldEdit(rows, 2, "voltage", "50V").rows;
  rows = M.setDecision(rows, 3, "new").rows;
  const d = M.buildDecisions(rows);
  const first = d.find((x) => x.row_no === 2);
  assert.deepStrictEqual(first.overrides, { voltage: "50V", intake_quantity: 8 },
    "只报改过的字段：" + JSON.stringify(first.overrides));
  assert.strictEqual(d.find((x) => x.row_no === 3).overrides, undefined, "没改动不该带 overrides");
});

t("门禁文案：合计按**改后**的入库量算，并提示「已人工修改」", () => {
  let rows = M.buildRows(PARSED);
  // 先把疑似裁决掉
  rows = M.setDecision(rows, 3, "new").rows;
  assert.ok(/合计 150 件/.test(M.gateText(rows)), M.gateText(rows));
  rows = M.setFieldEdit(rows, 2, "intake_quantity", "8").rows;
  const text = M.gateText(rows);
  assert.ok(/合计 108 件/.test(text), "8 + 50 + 50 = 108：" + text);
  assert.ok(/1 条已人工修改/.test(text), "要提示改过：" + text);
});

(async () => {
  for (const it of QUEUE) {
    try { await it.fn(); pass += 1; console.log("  PASS  " + it.name); }
    catch (exc) { fails.push(it.name); console.log("  FAIL  " + it.name + "\n        " + String(exc.message).split("\n")[0]); }
  }
  console.log("\n" + "=".repeat(64));
  console.log(`T49（对账单核对表规则）测试结果：通过 ${pass} / ${pass + fails.length}`);
  if (fails.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
