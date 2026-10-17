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
const categories = require("../src/services/categories");
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

t("分类落库值一律是立创中文名，且服务端单一来源都接受（v2.1 分类统一）", () => {
  const optionKeys = model.CATEGORY_OPTIONS.map((o) => o.key);
  assert.strictEqual(new Set(optionKeys).size, optionKeys.length, "下拉值有重复");
  for (const bad of ["C", "R", "L", "D", "Q", "U", "CN", "X", "KEY", "F", "H", "_default"]) {
    assert.ok(!optionKeys.includes(bad), `${bad} 是内部键，不该作为落库值（spec §5.3 / v2.1 裁定①）`);
  }
  for (const key of optionKeys) {
    assert.ok(categories.isAcceptable(key), `界面能选 ⇒ 服务端必须接受，缺 ${key}`);
    assert.ok(/[\u4e00-\u9fa5]/.test(key), `${key} 不是中文名`);
  }
  // 用户库里实际出现过的 13 个立创商品类型必须都能选（导入的对账单就是这些名字）
  for (const n of ["排母", "场效应管(MOSFET)", "翘板船型开关", "DC-DC电源芯片", "功率电感",
    "一体成型电感", "自恢复保险丝", "静电和浪涌保护(TVS/ESD)", "贴片型铝电解电容",
    "直插铝电解电容", "滑动开关", "音频功率放大器", "钮子开关"]) {
    assert.ok(optionKeys.includes(n), "下拉缺用户库里的立创类型：" + n);
  }
});

t("分类中文标签互不重复，且没有空标签", () => {
  const labels = model.CATEGORY_OPTIONS.map((o) => o.label);
  assert.strictEqual(new Set(labels).size, labels.length, "标签有重复");
  for (const label of labels) assert.ok(label.trim().length > 0);
});

t("阈值表仍是 spec §5.3 的 14 个类键（== settings.default_min_quantity 的键，FR-4.8）", () => {
  const rowKeys = model.CATEGORY_CLASS_ROWS.map((r) => r.key).sort();
  const thresholdKeys = Object.keys(storeModule.DEFAULT_SETTINGS.default_min_quantity).sort();
  assert.deepStrictEqual(rowKeys, thresholdKeys, "阈值表键与服务端查表的键必须同集合");
  assert.strictEqual(model.CATEGORY_CLASS_ROWS.length, 14, "spec §5.3 是 14 类");
});

t("旧数据展示：类键/位号前缀/哨兵一律映射成**下拉项的 key**（这是那次「显示成未选」事故的回归断言）", () => {
  // 事故复盘：曾经把旧值映射成"类的中文名"（`R`→`电阻`），而下拉的 key 是立创商品名（`贴片电阻`）——
  // 于是 `<select>` 找不到匹配项，**明明有分类的器件在编辑页显示成「（未选 = 其它）」**。
  // 所以这条断言的核心不是"好看"，而是"映射结果必须能在下拉里选中" ✗
  const optionKeys = new Set(model.CATEGORY_OPTIONS.map((o) => o.key));
  const represent = {
    C: "贴片电容(MLCC)", R: "贴片电阻", L: "贴片电感", D: "二极管", Q: "三极管", U: "集成电路",
    CN: "连接器", X: "晶振", KEY: "翘板船型开关", F: "自恢复保险丝", BUZZER: "蜂鸣器",
    LED: "发光二极管", H: "排母", _default: "其它",
  };
  for (const [stored, want] of Object.entries(represent)) {
    assert.strictEqual(model.categoryDisplayValue(stored), want, `${stored} 应映射到下拉项「${want}」`);
  }
  // 类键之外的位号别名（spec §5.3 里 J/P 属连接器、Y 属晶振、SW 属按键/开关）也要能选中
  for (const stored of ["J", "P", "Y", "SW", "OTHER", "其它"]) {
    const got = model.categoryDisplayValue(stored);
    assert.ok(optionKeys.has(got), `${stored} 映射成「${got}」后在下拉里选不中（等于显示成未选）`);
  }
  assert.strictEqual(model.categoryDisplayValue(""), "", "空值保持空（下拉显示「（未选 = 其它）」项）");
  assert.strictEqual(model.categoryDisplayValue("贴片电阻"), "贴片电阻", "已是中文名则原样返回");
  // 每一条都还要是服务端能接受的落库值（界面能选 ⇒ 服务端必须接受）
  for (const stored of ["R", "SW", "CN", "J", "Y", "LED", "KEY", "_default", "Q", "H", "BUZZER", "OTHER", "其它"]) {
    assert.ok(categories.isAcceptable(model.categoryDisplayValue(stored)),
      `旧值 ${stored} 映射成「${model.categoryDisplayValue(stored)}」后服务端应仍接受`);
  }
  // 下拉要显示的文本是给人看的（类/商品中文名），不能是 `_default` 这种内部哨兵
  assert.strictEqual(model.categoryDisplayLabel("_default"), "其它");
  assert.strictEqual(model.categoryDisplayLabel("R"), "贴片电阻");
  assert.strictEqual(model.categoryDisplayLabel("SW"), "翘板船型开关");
});

t("表外类型（对账单里没收录的商品类型）原样保留：不伪装成「其它」，也不能让下拉变空", () => {
  // `固态电容` 是真实对账单里出现、但类表还没收录的商品类型 → 必须**原样**显示，
  // 既不能显示成「其它」（那是把用户的值说成别的分类=撒谎），也不能显示成"未选"（=看着像没分类）
  for (const stored of ["固态电容", "测试点", "火星元件"]) {
    assert.strictEqual(model.categoryDisplayValue(stored), stored, `${stored} 应原样保留`);
    assert.strictEqual(model.categoryDisplayLabel(stored), stored, `${stored} 的显示文本应原样`);
  }
  assert.ok(categories.isAcceptable("固态电容"), "对账单实测类型服务端必须接受（能存能改）");
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
  // 同规格会**合并**进已有器件 → 服务端要求显式确认（用户实测："直接合并，没有人工通道"）
  const ask = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
    value: "10uF", footprint: "C1210", quantity: 5,
  })));
  assert.strictEqual(ask.ok, true);
  assert.strictEqual(ask.needs_confirm, true, "同规格必须先问人");
  assert.strictEqual(ask.existing_part.id, first.part.id);
  assert.strictEqual(ask.merged, false, "未确认时**不得**合并");
  const second = await handlers["parts:save"](Object.assign(model.toSavePayload(Object.assign(model.emptyForm(), {
    value: "10uF", footprint: "C1210", quantity: 5,
  })), { confirm_merge: true }));
  assert.strictEqual(second.ok, true, second.error);
  assert.strictEqual(second.merged, true);
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.part.id, first.part.id, "应并到同一条");
  assert.strictEqual(second.part.quantity, 25);
  assert.strictEqual((await handlers["parts:list"]({ query: {} })).parts.length, 1, "不该出现重复行");
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

t("AC-9:9 的**保存路径**见证：分类乱输 → ok:false + 明确报错；空分类 → 放行并落 _default", async () => {
  // 评审（R_8adb1e0d / R_97e52f62）指出的正是这条：以前只测了 isAcceptable 谓词与静态 includes，
  // 谓词返回 false ≠ **保存被拒并报错**（AC-9:9 的原话是"保存时分类必须可解析…乱输拒绝并明确报错"）
  const { handlers, db } = freshEnv();
  for (const bad of ["乱七八糟!!!", "??", "<script>"]) {
    const r = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
      category: bad, value: "10uF", footprint: "C1210", quantity: 1,
    })));
    assert.strictEqual(r.ok, false, bad + " 应被拒绝");
    assert.ok(/不在可选范围内/.test(r.error), "报错要说清原因：" + r.error);
    assert.ok(!r.error.includes("**"), "用户可见文案不得含 markdown 星号：" + r.error);
    assert.strictEqual(db.loadParts().length, 0, "被拒的提交不得写库");
  }
  // 空分类 = 未选 = 其它 → 必须放行，并落库为 _default 哨兵
  const okBlank = await handlers["parts:save"](model.toSavePayload(Object.assign(model.emptyForm(), {
    category: "", value: "22uF", footprint: "C1206", quantity: 2,
  })));
  assert.strictEqual(okBlank.ok, true, okBlank.error);
  assert.strictEqual(okBlank.part.category, "_default");
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
