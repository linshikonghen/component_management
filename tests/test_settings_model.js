"use strict";
/**
 * test_settings_model.js — T17（plan §9 的 T12b）验收测试：设置页规则 + AC-4 / AC-9
 *
 * 运行： node tests/test_settings_model.js
 *
 *   §1~§6 规则（阈值校验、只提交改动、数据目录确认、启动提示、低库存清单）
 *   §7    **AC-9 / AC-4 端到端**（预置 14 类、改阈值立即生效、个体阈值覆盖、非法值整单拒绝）
 *   §8    静态检查（FR-4.3/4.4 的"立即重算"在代码里真的接上了）
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const model = require("../renderer/model/settings_model.js");
const partsModel = require("../renderer/model/parts_model.js");
const storeModule = require("../src/services/store");
const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_settings_"));
const CATS = partsModel.CATEGORY_OPTIONS;

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

/* ================================================== §1 阈值校验 */

section("§1 分类默认阈值校验（plan §6 v1.5：必须是 number）");

t("0 与正整数合法（0 = 这一类不提示）", () => {
  assert.deepStrictEqual(model.validateThreshold(0), { ok: true, value: 0, error: "" });
  assert.strictEqual(model.validateThreshold(30).value, 30);
  assert.strictEqual(model.validateThreshold("30").value, 30);
});

t("**空值不合法**：分类默认没有「留空」语义（留空=继承是**个体**阈值的事 FR-4.8）", () => {
  for (const blank of ["", "   ", null, undefined]) {
    const r = model.validateThreshold(blank);
    assert.strictEqual(r.ok, false, `空值 ${JSON.stringify(blank)} 应被拒绝`);
    assert.ok(/不能为空/.test(r.error), r.error);
  }
});

t("负数 / 小数 / 非数字被拒绝并说明收到什么", () => {
  assert.ok(/不能为负/.test(model.validateThreshold(-1).error));
  assert.ok(/整数/.test(model.validateThreshold(1.5).error));
  assert.ok(/收到「abc」/.test(model.validateThreshold("abc").error));
});

t("**类型不对也要拒**（审计 R3 发现③）：`true`/`[]`/`[\"7\"]` 不能被强转成数字", () => {
  // `Number(true)`=1、`Number([])`=0、`Number(["7"])`=7 —— 放进来就会让服务端收到
  // "值合法但类型不对"的写入（plan §6 v1.5 要求值必须是 number，否则拒绝整笔）
  for (const bad of [true, false, [], ["7"], {}, NaN, Infinity]) {
    const r = model.validateThreshold(bad);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} 应被拒绝，实际 ${JSON.stringify(r)}`);
  }
  // 合法类型仍要放行（别把字符串形式误伤：界面输入框给的就是字符串）
  assert.strictEqual(model.validateThreshold("30").value, 30);
  assert.strictEqual(model.validateThreshold(30).value, 30);
});

t("低库存清单**遇 null 元素不能整页崩**（审计 R3 发现⑤）", () => {
  // parts.json 被改坏 / 上游漏过滤时，数组里可能混进 null ——
  // 设置页渲染没有 try/catch，一抛就是**整屏白**
  const parts = [null, { id: "p1", value: "10uF", footprint: "C1210", quantity: 3 }, undefined];
  const lines = model.lowStockLines(parts, ["p1"]);
  assert.strictEqual(lines.length, 1, "只应留下那一条真器件");
  assert.strictEqual(lines[0].id, "p1");
  assert.deepStrictEqual(model.lowStockLines([null], ["p1"]), [], "全是坏元素时应返回空数组而不是抛错");
});

/* ================================================== §2 设置页的行 */

section("§2 阈值行的标签由调用方注入（不在模型里抄第二份分类表）");

t("thresholdRows 按注入的分类生成，值取当前设置", () => {
  const rows = model.thresholdRows({ default_min_quantity: { C: 20, R: 50 } }, CATS);
  assert.strictEqual(rows.length, 14);
  assert.strictEqual(rows.find((r) => r.key === "C").value, 20);
  assert.strictEqual(rows.find((r) => r.key === "C").label, "电容");
  assert.strictEqual(rows.find((r) => r.key === "LED").value, "", "缺的键给空值（界面能看到没设）");
});

/* ============================================ §3 只提交改动项 */

section("§3 只提交改动过的项（合并写入语义下，少写就少出错）");

const SETTINGS = { default_min_quantity: { C: 20, R: 50, L: 10 } };

t("没改 → 载荷为 null（界面据此禁用保存按钮）", () => {
  const form = { C: "20", R: "50" };
  const verdict = model.changedThresholds(form, SETTINGS, CATS);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.changes, {});
  assert.strictEqual(model.thresholdPayload(verdict.changes), null);
});

t("改一项 → 只带这一项", () => {
  const verdict = model.changedThresholds({ C: "30", R: "50" }, SETTINGS, CATS);
  assert.deepStrictEqual(verdict.changes, { C: 30 });
  assert.deepStrictEqual(model.thresholdPayload(verdict.changes), { settings: { default_min_quantity: { C: 30 } } });
});

t("有非法项 → ok:false 并逐条给出「哪个分类、错在哪」", () => {
  const verdict = model.changedThresholds({ C: "abc", R: "-5" }, SETTINGS, CATS);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.errors.length, 2);
  assert.ok(verdict.errors.some((e) => /电容/.test(e)), JSON.stringify(verdict.errors));
  assert.ok(verdict.errors.some((e) => /电阻/.test(e)), JSON.stringify(verdict.errors));
});

t("界面没提供的格子不参与（undefined 跳过），不会被误判成改动", () => {
  const verdict = model.changedThresholds({ C: "30" }, SETTINGS, CATS);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(Object.keys(verdict.changes), ["C"]);
});

t("改动摘要给中文标签", () => {
  assert.strictEqual(model.changeSummary({ C: 30, LED: 10 }, CATS), "电容 → 30；指示灯 → 10");
  assert.strictEqual(model.changeSummary({}, CATS), "没有改动。");
});

/* ============================================== §4 数据目录 */

section("§4 数据目录：需人工确认（AGENTS.md）");

t("空 / 非法字符 / 与当前相同 → 拒绝", () => {
  assert.ok(/不能为空/.test(model.validateDataDir("", "data").error));
  assert.ok(/不能有/.test(model.validateDataDir('D:\\a<b', "data").error));
  assert.ok(/一样/.test(model.validateDataDir("data", "data").error));
  assert.strictEqual(model.validateDataDir("D:\\元件库", "data").ok, true);
});

t("未勾确认 → 只回「需要确认」+ 警告，**不产生载荷**", () => {
  const verdict = model.dataDirPayload("D:\\元件库", "data", false);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.needs_confirm, true);
  assert.strictEqual(verdict.payload, null);
  assert.ok(/不会/.test(verdict.warning) && /搬/.test(verdict.warning), verdict.warning);
});

t("勾了确认 → 载荷带 confirm_data_dir:true", () => {
  const verdict = model.dataDirPayload("D:\\元件库", "data", true);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.payload, { settings: { data_dir: "D:\\元件库" }, confirm_data_dir: true });
});

/* ============================================== §5 启动提示 */

section("§5 启动汇总提示（FR-4.3：只提示一次）");

t("有低库存且未提示过 → 给出条数；已提示过 → 空串", () => {
  const text = model.startupNotice(5, false);
  assert.ok(/5 种/.test(text), text);
  assert.strictEqual(model.startupNotice(5, true), "");
  assert.strictEqual(model.startupNotice(0, false), "");
});

/* ============================================== §6 低库存清单 */

section("§6 低库存清单（FR-4.2：主动标示）");

t("只列 low_stock_ids 里的，并区分个体阈值与分类默认", () => {
  const parts = [
    { id: "p1", value: "10uF", footprint: "C1210", quantity: 3, min_quantity: "", category: "C" },
    { id: "p2", value: "1k", footprint: "R0603", quantity: 2, min_quantity: 10, category: "R" },
    { id: "p3", value: "22uF", footprint: "C1206", quantity: 99, min_quantity: "", category: "C" },
  ];
  const lines = model.lowStockLines(parts, ["p1", "p2"]);
  assert.strictEqual(lines.length, 2);
  assert.ok(/按分类默认阈值判定/.test(lines[0].text), lines[0].text);
  assert.ok(/个体阈值 10/.test(lines[1].text), lines[1].text);
  assert.strictEqual(lines[0].min_quantity, null);
});

/* ============================================== §7 端到端 */

section("§7 AC-9 逐行端到端");

let envNo = 0;
function freshEnv() {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers };
}

async function seedCap(handlers, quantity, minQuantity) {
  const part = { category: "C", value: "10uF", footprint: "C1210", quantity };
  if (minQuantity !== undefined) part.min_quantity = minQuantity;
  const saved = await handlers["parts:save"]({ part });
  assert.strictEqual(saved.ok, true, saved.error);
  return saved.part;
}

async function lowIds(handlers) {
  const r = await handlers["parts:list"]({ query: {} });
  return r.low_stock_ids;
}

t("AC-9 第 1 行：首次启动设置页已有 14 类预置阈值（spec §5.3）", async () => {
  const { handlers } = freshEnv();
  const r = await handlers["settings:get"]({});
  const map = r.settings.default_min_quantity;
  assert.deepStrictEqual(Object.keys(map).sort(), CATS.map((c) => c.key).sort());
  assert.deepStrictEqual(map, storeModule.DEFAULT_SETTINGS.default_min_quantity, "预置值必须等于 spec §5.3 的默认值");
  console.log(`        （预置：C=${map.C} R=${map.R} LED=${map.LED} _default=${map._default}）`);
});

t("AC-9 第 2 行：电容阈值 20→30 保存后，未设个体阈值的电容（库存 25）**由不提示变为低库存**", async () => {
  const { handlers } = freshEnv();
  await seedCap(handlers, 25);
  assert.deepStrictEqual(await lowIds(handlers), [], "阈值 20 时 25 个不该报警");

  const verdict = model.changedThresholds({ C: "30" }, { default_min_quantity: storeModule.DEFAULT_SETTINGS.default_min_quantity }, CATS);
  assert.deepStrictEqual(verdict.changes, { C: 30 });
  const saved = await handlers["settings:set"](model.thresholdPayload(verdict.changes));
  assert.strictEqual(saved.ok, true, saved.error);
  assert.strictEqual(saved.settings.default_min_quantity.C, 30);
  assert.strictEqual((await lowIds(handlers)).length, 1, "阈值抬到 30 后应立刻变成低库存");
  console.log("        （C: 20 → 30，库存 25：不提示 → 低库存）");
});

t("AC-9 第 3/4 行：分类默认 20 + 库存 15 → 低库存；该器件设个体阈值 10 → 不再低库存", async () => {
  const { handlers } = freshEnv();
  const part = await seedCap(handlers, 15);
  assert.deepStrictEqual(await lowIds(handlers), [part.id], "15 < 20 应判低库存");

  // 编辑是**整份快照**提交（不是补丁）：拿回完整器件、改一个字段、整份发回去——
  // 这正是界面 `parts_editor` 的做法（toSavePayload 带全部 21 个字段）。
  const updated = await handlers["parts:save"]({ part: Object.assign({}, part, { min_quantity: 10 }) });
  assert.strictEqual(updated.ok, true, updated.error);
  assert.strictEqual(updated.part.min_quantity, 10);
  assert.deepStrictEqual(await lowIds(handlers), [], "个体阈值 10 覆盖分类默认 20 → 不再报警");
  console.log("        （个体阈值覆盖生效：15 在分类默认 20 下报警、在个体 10 下不报警）");
});

t("补丁式编辑会被**明确拒绝**（不是静默合并）——把这条语义钉住", async () => {
  const { handlers } = freshEnv();
  const part = await seedCap(handlers, 15);
  const before = (await handlers["parts:list"]({ query: {} })).parts.find((p) => p.id === part.id);
  const patched = await handlers["parts:save"]({ part: { id: part.id, min_quantity: 10 } });
  assert.strictEqual(patched.ok, false, "只发一个字段应被拒绝，而不是悄悄继承旧值");
  assert.ok(/缺少必填关键信息/.test(patched.error), patched.error);
  const after = (await handlers["parts:list"]({ query: {} })).parts.find((p) => p.id === part.id);
  assert.strictEqual(after.min_quantity, before.min_quantity, "被拒绝的提交不得改动任何字段");
  assert.notStrictEqual(after.min_quantity, 10);
  assert.deepStrictEqual(await lowIds(handlers), [part.id], "判定结果也不该变");
});

t("AC-9 异常路径：阈值传非数字 → **拒绝整个写入，已存阈值保持原样**", async () => {
  const { handlers, db } = freshEnv();
  const before = (await handlers["settings:get"]({})).settings.default_min_quantity;
  const saved = await handlers["settings:set"]({ settings: { default_min_quantity: { C: "abc" } } });
  assert.strictEqual(saved.ok, false);
  assert.ok(/阈值|数字|number/i.test(saved.error), saved.error);
  const after = db.loadSettings().default_min_quantity;
  assert.deepStrictEqual(after, before, "不得部分写入，也不得静默忽略");
});

t("0 是合法阈值：设为 0 → 该类不再报警（FR-4.1 的「不提示」）", async () => {
  const { handlers } = freshEnv();
  await seedCap(handlers, 0);
  const r = await handlers["settings:set"]({ settings: { default_min_quantity: { C: 0 } } });
  assert.strictEqual(r.ok, true, r.error);
  const lines = model.lowStockLines((await handlers["parts:list"]({ query: {} })).parts, await lowIds(handlers));
  assert.strictEqual(lines.length, 0, "阈值 0 = 这一类不提示");
});

t("改数据目录：不带确认被拒；带确认成功（AGENTS.md 需人工确认）", async () => {
  const { handlers, db } = freshEnv();
  const refused = await handlers["settings:set"]({ settings: { data_dir: path.join(TMP, "moved") } });
  assert.strictEqual(refused.ok, false);
  assert.ok(/确认/.test(refused.error), refused.error);

  const ok = await handlers["settings:set"](model.dataDirPayload(path.join(TMP, "moved"), db.loadSettings().data_dir, true).payload);
  assert.strictEqual(ok.ok, true, ok.error);
  assert.strictEqual(ok.settings.data_dir, path.join(TMP, "moved"));
  // 数据文件没被搬走（新目录是空的）——这正是警告里说的
  assert.ok(!fs.existsSync(path.join(TMP, "moved", "parts.json")), "改目录不搬数据，界面会变成空库");
});

/* ============================================== §8 静态检查 */

section("§8 FR-4.3 / FR-4.4 的「立即重算」在代码里真的接上了");

function readIfExists(rel) {
  const full = path.join(PROJECT_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

t("设置页只调 settingsGet / settingsSet / partsList", () => {
  const src = stripComments(readIfExists("renderer/pages/settings_page.js"));
  const calls = [...src.matchAll(/call\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "没解析到 IPC 调用");
  const allowed = new Set(["settingsGet", "settingsSet", "partsList"]);
  for (const name of calls) assert.ok(allowed.has(name), `设置页调用了未授权的通道：${name}`);
  console.log(`        （设置页实际调用：${[...new Set(calls)].sort().join(" / ")}）`);
});

t("FR-4.4：领料页每次出入库/领料后都刷新库存（提示立即重算）", () => {
  const src = stripComments(readIfExists("renderer/pages/stock_page.js"));
  const refreshCalls = (src.match(/refreshInventory\(\)/g) || []).length;
  assert.ok(refreshCalls >= 2, `出入库与领料后都应刷新（当前 ${refreshCalls} 处）`);
});

t("FR-4.3：库存页加载后调用启动提示（只显示一次由 app.js 的标记保证）", () => {
  const app = stripComments(readIfExists("renderer/app.js"));
  assert.ok(/startupNotice\(/.test(app), "app.js 应调用 SettingsModel.startupNotice");
  assert.ok(/startupNoticeShown = true/.test(app), "显示过之后要置标记");
  assert.ok(/id="startup-notice"|startup-notice/.test(readIfExists("renderer/index.html")), "index.html 要有提示容器");
});

t("设置页与设置模型都没有 require / fetch", () => {
  for (const rel of ["renderer/pages/settings_page.js", "renderer/model/settings_model.js"]) {
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
  console.log(`T17（设置页规则与 AC-4/AC-9）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
