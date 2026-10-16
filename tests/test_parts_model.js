"use strict";
/**
 * test_parts_model.js — T14（plan §9 的 T10/T11 UI）验收测试
 *
 * 运行： node tests/test_parts_model.js
 *
 * 三块：
 *   §1~§7 规则（表单元数据、必填提示、连续录入保留、排序、变动记录说法）
 *   §8    **跨边界一致性**：渲染侧与服务侧**各有一份**同义数据（浏览器不能 require 服务模块），
 *         靠断言钉住，而不是靠记性——必填字段集、字段白名单、分类键三处
 *   §9    端到端（handlers）：录入 → 列表 → 变动历史 → 合并 → 删除，含异常路径
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const model = require("../renderer/model/parts_model.js");
const partsSvc = require("../src/services/parts");
const storeModule = require("../src/services/store");
const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_partsui_"));

const QUEUE = [];
function t(name, fn) { QUEUE.push({ kind: "test", name, fn }); }
function section(title) { QUEUE.push({ kind: "section", title }); }
let passCount = 0;
const failures = [];

async function runQueue() {
  for (const item of QUEUE) {
    if (item.kind === "section") { console.log("\n=== " + item.title + " ==="); continue; }
    try {
      await item.fn();
      passCount += 1;
      console.log("  PASS  " + item.name);
    } catch (exc) {
      failures.push({ name: item.name, message: String(exc && exc.message ? exc.message : exc) });
      console.log("  FAIL  " + item.name);
      console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
    }
  }
}

/* ==================================================== §1 表单元数据 */

section("§1 表单元数据（渲染侧）与服务侧白名单**逐字一致**");

t("表单字段集 == src/services/parts.js 的 PART_FIELDS（浏览器不能 require，故靠断言防漂移）", () => {
  const formKeys = model.FORM_FIELDS.map((f) => f.key).sort();
  assert.deepStrictEqual(formKeys, partsSvc.PART_FIELDS.slice().sort(),
    "渲染侧表单字段与服务侧白名单不一致：多一个字段界面会被静默丢弃，少一个用户就填不了");
  assert.strictEqual(model.FORM_FIELDS.length, 21);
});

t("必填字段集 == 服务侧 REQUIRED_FIELDS（AC-3 要「明确缺哪个」）", () => {
  assert.deepStrictEqual(model.requiredFields().map((f) => f.key), partsSvc.REQUIRED_FIELDS.map((f) => f.field));
  assert.deepStrictEqual(model.requiredFields().map((f) => f.label), partsSvc.REQUIRED_FIELDS.map((f) => f.label));
});

t("每个字段都有中文标签；key 全是 snake_case（AGENTS.md 字段命名约定）", () => {
  for (const field of model.FORM_FIELDS) {
    assert.ok(field.label && field.label.length > 0, "缺标签：" + field.key);
    assert.ok(/^[a-z][a-z0-9_]*$/.test(field.key), "字段名不是 snake_case：" + field.key);
    assert.ok(["text", "number", "select"].includes(field.kind), "未知控件类型：" + field.kind);
  }
  const keys = model.FORM_FIELDS.map((f) => f.key);
  assert.strictEqual(new Set(keys).size, keys.length, "字段 key 有重复");
});

/* ==================================================== §2 分类下拉 */

section("§2 分类下拉：键取自 spec §5.3，与服务端阈值键同集合");

t("分类键集 == settings.default_min_quantity 的键（服务端按这个键取默认阈值 FR-4.8）", () => {
  const optionKeys = model.CATEGORY_OPTIONS.map((o) => o.key).sort();
  const thresholdKeys = Object.keys(storeModule.DEFAULT_SETTINGS.default_min_quantity).sort();
  assert.deepStrictEqual(optionKeys, thresholdKeys);
  assert.strictEqual(model.CATEGORY_OPTIONS.length, 14, "spec §5.3 是 14 类");
});

t("分类中文标签互不重复，且没有空标签", () => {
  const labels = model.CATEGORY_OPTIONS.map((o) => o.label);
  assert.strictEqual(new Set(labels).size, labels.length, "标签有重复");
  for (const label of labels) assert.ok(label.trim().length > 0);
});

/* =============================================== §3 必填即时提示 */

section("§3 必填即时提示（AC-3 异常路径的界面侧）");

t("值/封装为空 → 按表单顺序指出缺哪几个", () => {
  const form = model.emptyForm();
  assert.deepStrictEqual(model.requiredMissing(form), ["值", "封装"]);
});

t("**数量 0 不算缺**（0 是合法数量，不是「没填」）", () => {
  const form = Object.assign(model.emptyForm(), { value: "10uF", footprint: "C1210", quantity: 0 });
  assert.deepStrictEqual(model.requiredMissing(form), []);
});

t("填齐后返回空数组", () => {
  const form = Object.assign(model.emptyForm(), { value: "10uF", footprint: "C1210", quantity: 5 });
  assert.deepStrictEqual(model.requiredMissing(form), []);
});

/* ================================================== §4 提交载荷 */

section("§4 表单 → 提交载荷（只做类型规整，白名单交给服务端）");

t("数字字段转数字；阈值留空保持空串（服务端按 null = 继承分类默认处理）", () => {
  const form = Object.assign(model.emptyForm(), {
    value: " 10uF ", footprint: "C1210", quantity: "24", min_quantity: "",
  });
  const payload = model.toSavePayload(form);
  assert.strictEqual(payload.part.quantity, 24);
  assert.strictEqual(typeof payload.part.quantity, "number");
  assert.strictEqual(payload.part.min_quantity, "", "留空不塞 0，否则会变成'阈值 0=永不提示'");
  assert.strictEqual(payload.part.value, "10uF", "字符串要去掉首尾空格");
  assert.ok(!Object.prototype.hasOwnProperty.call(payload.part, "id"), "新增不该带 id");
});

t("编辑时带上 id；额外字段不会混进载荷", () => {
  const form = Object.assign(model.emptyForm(), { id: "p_0001", value: "1k", footprint: "R0603", quantity: 3 });
  form.__hack = "x";
  const payload = model.toSavePayload(form);
  assert.strictEqual(payload.part.id, "p_0001");
  assert.ok(!Object.prototype.hasOwnProperty.call(payload.part, "__hack"));
});

/* ============================================ §5 连续录入（FR-3.3） */

section("§5 连续录入：保存后保留分类等字段（FR-3.3）");

t("保留分类/封装/供应商/厂商/库位/安装方式；清掉与这一条料相关的", () => {
  const form = {
    category: "C", footprint: "C0603", supplier: "LCSC", manufacturer: "FH(风华)",
    location: "A-03", mount_type: "SMD", value: "100nF", part_number: "GRM188", supplier_part: "C77035", quantity: 100,
  };
  const kept = model.keepForNextEntry(form);
  assert.strictEqual(kept.category, "C");
  assert.strictEqual(kept.footprint, "C0603");
  assert.strictEqual(kept.supplier, "LCSC");
  assert.strictEqual(kept.location, "A-03");
  assert.strictEqual(kept.value, "", "值要清掉");
  assert.strictEqual(kept.part_number, "");
  assert.strictEqual(kept.supplier_part, "");
  assert.strictEqual(kept.quantity, 0);
});

/* ================================================== §6 排序（FR-5.1） */

section("§6 排序：点同一列反向，换列则升序（FR-5.1）");

t("换列 → 升序；同列再点 → 反向", () => {
  let s = { sort_by: "", sort_dir: "asc" };
  s = model.nextSort(s, "value");
  assert.deepStrictEqual(s, { sort_by: "value", sort_dir: "asc" });
  s = model.nextSort(s, "value");
  assert.deepStrictEqual(s, { sort_by: "value", sort_dir: "desc" });
  s = model.nextSort(s, "value");
  assert.deepStrictEqual(s, { sort_by: "value", sort_dir: "asc" }, "第三次再点回到升序");
  s = model.nextSort(s, "quantity");
  assert.deepStrictEqual(s, { sort_by: "quantity", sort_dir: "asc" }, "换列从升序开始");
});

t("表头箭头只在当前排序列上显示", () => {
  assert.strictEqual(model.sortIndicator({ sort_by: "value", sort_dir: "asc" }, "value"), "▲");
  assert.strictEqual(model.sortIndicator({ sort_by: "value", sort_dir: "desc" }, "value"), "▼");
  assert.strictEqual(model.sortIndicator({ sort_by: "value", sort_dir: "asc" }, "quantity"), "");
});

t("可排序列都在服务端 SORTABLE_FIELDS 里（否则点了会报错）", () => {
  const server = new Set(partsSvc.SORTABLE_FIELDS);
  for (const col of model.SORTABLE_COLUMNS) {
    assert.ok(server.has(col.field), `界面提供了服务端不支持的排序列：${col.field}`);
  }
});

/* ============================================ §7 变动记录说法（FR-5.4） */

section("§7 变动历史的中文说法（FR-5.4 详情要能读懂）");

t("四种 kind 都有中文；显示 before → after", () => {
  assert.deepStrictEqual(Object.keys(model.KIND_LABELS).sort(), ["adjust", "in", "init", "out"]);
  assert.strictEqual(model.describeMovement({ kind: "in", delta: 24, before: 0, after: 24 }), "入库 +24（0 → 24）");
  assert.strictEqual(model.describeMovement({ kind: "out", delta: -5, before: 24, after: 19 }), "出库 -5（24 → 19）");
  assert.strictEqual(model.describeMovement({ kind: "adjust", delta: 3, before: 10, after: 13 }), "修正 +3（10 → 13）");
});

t("人工改过数量的记录要说清「为什么和 BOM 不一样」（v1.4 留痕）", () => {
  const trace = model.movementTrace({ edited_by_human: true, expected_quantity: 24, intake_quantity: 10 });
  assert.ok(/原应入库 24/.test(trace) && /实际入库 10/.test(trace), trace);
  assert.strictEqual(model.movementTrace({ edited_by_human: false }), "");
  assert.strictEqual(model.movementTrace({ edited_by_human: true }), "人工改过数量");
});

/* ============================================ §8 端到端（handlers） */

section("§8 端到端：录入 → 列表 → 变动历史 → 合并 → 删除");

let envNo = 0;
function freshEnv() {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers };
}

t("手动录一条（不碰 BOM）→ 列表查得到 → 变动历史有 init 记录", async () => {
  const { handlers } = freshEnv();
  const form = Object.assign(model.emptyForm(), {
    category: "C", value: "10uF", footprint: "C1210", voltage: "50V", quantity: 20, location: "A-03",
  });
  const saved = await handlers["parts:save"](model.toSavePayload(form));
  assert.strictEqual(saved.ok, true, saved.error);
  assert.strictEqual(saved.created, true);

  const list = await handlers["parts:list"]({ query: {} });
  assert.strictEqual(list.parts.length, 1);
  assert.strictEqual(list.parts[0].category, "C");

  const moves = await handlers["movements:list"]({ part_id: saved.part.id });
  assert.strictEqual(moves.movements.length, 1);
  assert.strictEqual(moves.movements[0].kind, "init");
  assert.strictEqual(model.describeMovement(moves.movements[0]), "初始 +20（0 → 20）");
});

t("再录一条同规格 → 数量累加、不新增行，并留下 in 记录（FR-3.2）", async () => {
  const { handlers } = freshEnv();
  const first = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
    value: "10uF", footprint: "C1210", quantity: 20,
  })));
  const second = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
    value: "10uF", footprint: "C1210", quantity: 5,
  })));
  assert.strictEqual(second.ok, true, second.error);
  assert.strictEqual(second.merged, true);
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.part.id, first.part.id, "应并到同一条");
  assert.strictEqual(second.part.quantity, 25);

  const list = await handlers["parts:list"]({ query: {} });
  assert.strictEqual(list.parts.length, 1, "不该出现重复行");
  const moves = await handlers["movements:list"]({ part_id: first.part.id });
  assert.strictEqual(moves.movements.length, 2, "两次录入两条留痕");
});

t("服务端校验仍然兜底：值/封装留空 → ok:false 且说明缺什么（不依赖界面限制）", async () => {
  const { handlers, db } = freshEnv();
  const bad = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), { quantity: 1 })));
  assert.strictEqual(bad.ok, false);
  assert.ok(/缺少必填关键信息/.test(bad.error), bad.error);
  assert.strictEqual(db.loadParts().length, 0, "校验失败不得写库");
});

t("编辑改数量 → adjust 记录；详情的历史按时间倒序（FR-5.4）", async () => {
  const { handlers } = freshEnv();
  const saved = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
    value: "1k", footprint: "R0603", quantity: 10,
  })));
  const edited = Object.assign({}, saved.part, { quantity: 30, note: "盘点修正" });
  const r = await handlers["parts:save"]({ part: model.toSavePayload(Object.assign(model.formFromPart(edited))).part });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.part.quantity, 30);

  const moves = await handlers["movements:list"]({ part_id: saved.part.id });
  assert.strictEqual(moves.movements.length, 2);
  assert.strictEqual(moves.movements[0].kind, "adjust", "最新一条应是修正");
  const times = moves.movements.map((m) => m.at);
  assert.deepStrictEqual(times, times.slice().sort().reverse(), "必须按时间倒序");
});

t("删除需 confirm；删后器件没了，但**变动记录保留**（历史可追溯）+ 补一条 adjust 留痕", async () => {
  const { handlers, db } = freshEnv();
  const saved = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
    value: "22uF", footprint: "C1206", quantity: 8,
  })));
  const refused = await handlers["parts:delete"]({ part_id: saved.part.id, confirm: false });
  assert.strictEqual(refused.ok, false);

  const done = await handlers["parts:delete"]({ part_id: saved.part.id, confirm: true });
  assert.strictEqual(done.ok, true, done.error);
  assert.strictEqual(db.loadParts().length, 0);
  // **行为变更（审计后修）**：原来删除不留任何痕迹 → 总库存凭空少了 8 个，账面上没有解释。
  // 现在删除时补一条 adjust 记录（delta = -8），于是 init + adjust 两条，账能对上（FR-4.5）。
  assert.strictEqual(db.loadMovements().length, 2, "init + 删除时的 adjust 留痕");
  const adjust = db.loadMovements().find((m) => m.kind === "adjust");
  assert.ok(adjust, "应有一条 adjust 变动记录");
  assert.strictEqual(adjust.delta, -8, "adjust 应把移除的库存记成负数");
  assert.strictEqual(adjust.after, 0);

  const after = await handlers["movements:list"]({ part_id: saved.part.id });
  assert.strictEqual(after.movements.length, 2, "删了器件仍能按 part_id 查到它的历史（两条都在）");
});

/* ============================================ §9 静态检查 */

section("§9 静态检查：渲染侧只调允许的通道");

function readIfExists(rel) {
  const full = path.join(PROJECT_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

t("录入页只调 partsSave / partsList / partsDelete / movementsList", () => {
  const src = readIfExists("renderer/pages/parts_editor.js");
  assert.ok(src.length > 0, "文件不存在");
  const calls = [...src.matchAll(/call\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "没解析到 IPC 调用");
  const allowed = new Set(["partsSave", "partsList", "partsDelete", "movementsList"]);
  for (const name of calls) {
    assert.ok(allowed.has(name), `录入页调用了未授权的通道：${name}`);
  }
  console.log(`        （录入页实际调用：${[...new Set(calls)].sort().join(" / ")}）`);
});

t("录入页不得直接改库（禁止 stock:move 绕过留痕）", () => {
  const src = stripComments(readIfExists("renderer/pages/parts_editor.js"));
  assert.ok(!/stock:move|stockMove/.test(src), "改数量必须走 parts:save（它会写变动记录）");
});

t("渲染侧无 require / fetch", () => {
  for (const rel of ["renderer/pages/parts_editor.js", "renderer/model/parts_model.js"]) {
    const src = stripComments(readIfExists(rel));
    assert.ok(!/require\s*\(/.test(src), rel + " 不得 require");
    assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(src), rel + " 不得联网");
  }
});

/* ------------------------------------------------------------------ 执行 */

runQueue().then(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T14（录入与详情 UI）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
