"use strict";
/**
 * test_ipc_handlers.js — T11（plan §9 的 T1）验收测试：IPC 薄层
 *
 * 运行： node tests/test_ipc_handlers.js
 *
 * 不启动 Electron：`createHandlers()` 不 require electron（对话框以 `pick_files` 注入），
 * 于是 15 个通道可以在纯 Node 下逐个真跑——用的是**临时目录**里的真 store。
 *
 * 重点：
 *   §1 通道清单与 plan §6 **逐字核对**（不多不少）
 *   §2~§6 15 个通道的成功路径 + 错误包装（{ok:false,error}）
 *   §7 **落盘顺序**：movements 必须先于 parts（FR-4.5）
 *   §8 离线与渲染进程禁令的静态检查
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHandlers, CHANNELS } = require("../src/ipc/handlers");
const extensions = require("../src/ipc/extensions");
const { channelToMethod } = require("../src/ipc/channels");
const { createStore } = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = "sample_bom";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_ipc_"));
const FIXED_NOW = new Date(2026, 9, 15, 10, 0, 0);

let passCount = 0;
const failures = [];

/**
 * 本文件几乎每个用例都是 async —— 因此 `t()` **只登记不执行**，
 * 末尾统一 `await` 顺序跑完。
 * （第一版直接 `fn()` 不 await：异步用例会立刻打印 PASS，实际断言还没跑；
 *   一旦后面失败就变成 unhandled rejection 直接崩进程，PASS 全成了假的。）
 */
const QUEUE = [];
function t(name, fn) { QUEUE.push({ kind: "test", name, fn }); }

function section(title) { QUEUE.push({ kind: "section", title }); }

async function runQueue() {
  for (const item of QUEUE) {
    if (item.kind === "section") {
      console.log("\n=== " + item.title + " ===");
      continue;
    }
    try {
      await item.fn(); // 同步/异步用例都能正确等待
      passCount += 1;
      console.log("  PASS  " + item.name);
    } catch (exc) {
      failures.push({ name: item.name, message: String(exc && exc.message ? exc.message : exc) });
      console.log("  FAIL  " + item.name);
      console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
    }
  }
}

/** 每个用例一套干净的临时数据目录 + 一套 handler */
let caseNo = 0;
function freshEnv(overrides = {}) {
  caseNo += 1;
  const base = path.join(TMP, "case" + caseNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const picked = [];
  const env = createHandlers({
    store: db,
    pick_files: async () => picked,
    now: () => FIXED_NOW,
  });
  return { db, env, handlers: env.handlers, picked, base };
}

/** 记录 store 的调用顺序（用于验证"先写变动记录、再写 parts"） */
function spyStore(db, order) {
  return Object.assign(Object.create(db), {
    appendMovement: (m) => { order.push("appendMovement"); return db.appendMovement(m); },
    saveParts: (p) => { order.push("saveParts"); return db.saveParts(p); },
  });
}

const BOM_PATH = path.join(FIX, MAIN_BOM);

/* ================================================== §1 通道清单核对 */

section("§1 通道清单与 plan §6 **逐字**核对");

/** 从 plan §6 里解析出所有 `### 模块:动作` 标题（文档是唯一信源）。
 *  注意 `### settings:get  → { settings }` 这种标题后面还跟着说明，故不能用 `$` 收尾。 */
function channelsFromPlan() {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "plan.md"), "utf8");
  return [...text.matchAll(/^### ([a-z]+:[A-Za-z_]+)\b/gm)].map((m) => m[1]);
}

t("实际通道集合 == plan §6 ∪ **已登记的契约扩展**（多一个没登记就红）", () => {
  // 为什么不是"完全等于 plan §6"：spec 有些能力在冻结契约里可能**没有载体**，
  // 实现时不得不加通道。直接放开会让契约失去约束力；所以改成"plan ∪ 登记表"，
  // 登记表（src/ipc/extensions.js）里每条都要写清 spec 出处与原因。
  // v1.5（实现期补记 2）后登记表已清空——parts:export 并入 §6，于是这里等价于"== plan §6"。
  const fromPlan = channelsFromPlan();
  // v1.7：新增 statement:parse / statement:commit → 16 → 18
  assert.strictEqual(fromPlan.length, 18, "plan §6 应定义 18 个通道，实际解析到 " + fromPlan.length);
  const expected = fromPlan.concat(extensions.EXTENSION_CHANNELS).sort();
  assert.deepStrictEqual(CHANNELS.slice().sort(), expected,
    "通道与「plan §6 + 已登记扩展」不一致：多了没登记的，或登记了却没实现");
  for (const extra of extensions.EXTENSION_CHANNELS) {
    assert.ok(!fromPlan.includes(extra), `${extra} 已在 plan §6 里，就不该继续挂在扩展表上（该删登记项）`);
  }
});

t("每个通道都有对应的 handler，且方法名不重复（preload 白名单不冲突）", () => {
  const { handlers } = freshEnv();
  const methods = new Set();
  for (const channel of CHANNELS) {
    assert.strictEqual(typeof handlers[channel], "function", "缺 handler: " + channel);
    const method = channelToMethod(channel);
    assert.ok(!methods.has(method), "方法名重复: " + method);
    methods.add(method);
  }
  // 不写死 15：通道数由清单决定（含已登记扩展）。写死会在加通道时"测出个假问题"。
  assert.strictEqual(methods.size, CHANNELS.length);
  assert.strictEqual(channelToMethod("parts:list"), "partsList");
  assert.strictEqual(channelToMethod("stock:pick_by_bom"), "stockPickByBom");
});

/* ============================================================ §2 BOM */

section("§2 BOM 通道（bom:pickFiles / bom:parse / bom:commit）");

t("bom:pickFiles 走注入的选择器，返回 file_paths", async () => {
  const { handlers, picked } = freshEnv();
  picked.push(BOM_PATH, "另一个.csv");
  const r = await handlers["bom:pickFiles"]({});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.file_paths, [BOM_PATH, "另一个.csv"]);
});

t("bom:parse：真实主样本 + 套数 3 → 33 条 + 算式数据 + batch_id", async () => {
  const { handlers } = freshEnv();
  const r = await handlers["bom:parse"]({ file_path: BOM_PATH, sets: 3 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.items.length, 33);
  assert.strictEqual(r.items[0].quantity_per_board, 8);
  assert.strictEqual(r.items[0].total_quantity, 24);
  assert.strictEqual(r.items[0].intake_quantity, 24);
  assert.ok(/^batch_\d{8}_\d{6}$/.test(r.batch_id), r.batch_id);
});

t("bom:parse 失败时返回 {ok:false,error}，不抛异常（IPC 层的约定）", async () => {
  const { handlers } = freshEnv();
  const bad = await handlers["bom:parse"]({ file_path: path.join(FIX, "neg_not_a_bom.xlsx"), sets: 1 });
  assert.strictEqual(bad.ok, false);
  assert.ok(/不是可识别的 BOM|缺少必需列/.test(bad.error), bad.error);
  const missing = await handlers["bom:parse"]({ file_path: path.join(FIX, "查无此文件.xlsx"), sets: 1 });
  assert.strictEqual(missing.ok, false);
  assert.ok(/读取文件失败/.test(missing.error), missing.error);
});

t("bom:commit：入库并**真的落盘**（重新从 store 读得到）", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: BOM_PATH, sets: 1 });
  const r = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1, source: MAIN_BOM });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.added, 32);
  assert.strictEqual(r.merged, 1);
  assert.strictEqual(r.skipped, 0);
  assert.strictEqual(r.parts.length, 32, "响应里的 parts 应是变更后的库");
  assert.strictEqual(db.loadParts().length, 32, "必须真落盘");
  assert.strictEqual(db.loadMovements().length, 33);
});

/* ========================================================== §3 比对 */

section("§3 比对通道（compare:run / compare:export）");

async function envWithLibrary() {
  const env = freshEnv();
  const parsed = await env.handlers["bom:parse"]({ file_path: BOM_PATH, sets: 1 });
  await env.handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1, source: MAIN_BOM });
  return env;
}

t("compare:run：库里就是照这份 BOM 录的 → 全部够用、零缺料", async () => {
  const { handlers } = await envWithLibrary();
  const r = await handlers["compare:run"]({ file_path: BOM_PATH, sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.stats.total, 33);
  assert.strictEqual(r.stats.shortfall, 0);
  assert.ok(/^compare_\d{8}_\d{6}$/.test(r.compare_id), r.compare_id);
  assert.deepStrictEqual(r.shortfall, []);
});

t("compare:run 空库 → 33 条全缺料", async () => {
  const { handlers } = freshEnv();
  const r = await handlers["compare:run"]({ file_path: BOM_PATH, sets: 1 });
  assert.strictEqual(r.stats.shortfall, 33);
  assert.strictEqual(r.stats.no_stock, 33);
});

t("compare:export：导出缺料清单为 xlsx，文件真存在且能被读回", async () => {
  const { handlers, base } = await envWithLibrary();
  const run = await handlers["compare:run"]({ file_path: BOM_PATH, sets: 1 });
  // 先把库存清空 → 制造 33 条缺料（顺便验证 export 只导缺料）
  const parts = (await handlers["parts:list"]({})).parts;
  for (const p of parts) {
    await handlers["stock:move"]({ part_id: p.id, delta: -p.quantity, reason: "清库以便测试导出" });
  }
  const again = await handlers["compare:run"]({ file_path: BOM_PATH, sets: 1 });
  assert.strictEqual(again.stats.shortfall, 33);

  const outPath = path.join(base, "out.xlsx");
  const r = await handlers["compare:export"]({ compare_id: again.compare_id, output_path: outPath, mode: "lcsc" });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.exported_count, 33);
  assert.strictEqual(r.file_path, outPath);
  assert.ok(fs.existsSync(outPath), "导出文件不存在");
  const bp = require("../src/services/bom_parser");
  const rows = bp.readTableRows(outPath).rows;
  assert.deepStrictEqual(rows[0], ["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"]);
  assert.strictEqual(rows.length, 34);
  assert.strictEqual(run.stats.total, 33, "前面的比对结果不受影响");
});

t("compare:export 用不存在的 compare_id → 明确报错，不静默生成空文件", async () => {
  const { handlers, base } = freshEnv();
  const outPath = path.join(base, "none.xlsx");
  const r = await handlers["compare:export"]({ compare_id: "compare_不存在", output_path: outPath, mode: "lcsc" });
  assert.strictEqual(r.ok, false);
  assert.ok(/找不到该比对结果/.test(r.error), r.error);
  assert.strictEqual(fs.existsSync(outPath), false, "失败时不该留下文件");
});

t("compare:export 不指定路径 → 默认文件名含时间戳（FR-2.8）", async () => {
  const { handlers } = freshEnv();
  const run = await handlers["compare:run"]({ file_path: BOM_PATH, sets: 1 });
  const r = await handlers["compare:export"]({ compare_id: run.compare_id, mode: "lcsc" });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(/立创配单_\d{8}_\d{6}\.xlsx$/.test(r.file_path), r.file_path);
  fs.rmSync(r.file_path, { force: true });
});

/* ======================================================== §4 器件 */

section("§4 器件通道（parts:list / parts:save / parts:delete）");

t("parts:list 返回 {parts, low_stock_ids}", async () => {
  const { handlers } = await envWithLibrary();
  const r = await handlers["parts:list"]({ query: {} });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.parts.length, 32);
  assert.ok(Array.isArray(r.low_stock_ids));
  const filtered = await handlers["parts:list"]({ query: { q: "10uF" } });
  assert.ok(filtered.parts.length >= 1);
  assert.ok(filtered.parts.every((p) => JSON.stringify(p).includes("10uF") || p.value.includes("10uF")));
});

t("parts:save 新增一条并落盘；非法输入返回 ok:false", async () => {
  const { handlers, db } = freshEnv();
  const r = await handlers["parts:save"]({ part: { value: "10uF", footprint: "C1210", quantity: 7, supplier_part: "C116808" } });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.created, true);
  assert.strictEqual(db.loadParts().length, 1);
  assert.strictEqual(db.loadMovements().length, 1, "数量 7 → 应有一条 init 变动");
  const bad = await handlers["parts:save"]({ part: { value: "", footprint: "" } });
  assert.strictEqual(bad.ok, false);
  assert.ok(/缺少必填关键信息/.test(bad.error), bad.error);
});

t("parts:delete 必须带 confirm；确认后真的删掉", async () => {
  const { handlers, db } = freshEnv();
  const saved = await handlers["parts:save"]({ part: { value: "10uF", footprint: "C1210", quantity: 1 } });
  const id = saved.part.id;
  const refused = await handlers["parts:delete"]({ part_id: id, confirm: false });
  assert.strictEqual(refused.ok, false);
  assert.ok(/需人工确认/.test(refused.error), refused.error);
  assert.strictEqual(db.loadParts().length, 1);
  const done = await handlers["parts:delete"]({ part_id: id, confirm: true });
  assert.strictEqual(done.ok, true, done.error);
  assert.strictEqual(db.loadParts().length, 0);
});

/* ======================================================== §5 库存 */

section("§5 库存通道（stock:move / stock:pick_by_bom）");

t("stock:move 出库 5 → 库存减少 + 变动记录带 store 赋的 id", async () => {
  const { handlers, db } = await envWithLibrary();
  const first = (await handlers["parts:list"]({})).parts[0];
  const r = await handlers["stock:move"]({ part_id: first.id, delta: -5, reason: "打样领用" });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.part.quantity, first.quantity - 5);
  assert.strictEqual(r.movement.kind, "out");
  assert.strictEqual(r.movement.reason, "打样领用");
  assert.ok(/^m_\d{4}$/.test(r.movement.id), "store 应给变动记录赋 id：" + r.movement.id);
  assert.strictEqual(db.loadParts().find((p) => p.id === first.id).quantity, first.quantity - 5);
});

t("stock:move 超库存 → ok:false，且库存与变动记录都不动（FR-7.2）", async () => {
  const { handlers, db } = await envWithLibrary();
  const first = (await handlers["parts:list"]({})).parts[0];
  const before = db.loadMovements().length;
  const r = await handlers["stock:move"]({ part_id: first.id, delta: -(first.quantity + 1), reason: "多领" });
  assert.strictEqual(r.ok, false);
  assert.ok(/库存不足/.test(r.error), r.error);
  assert.strictEqual(db.loadParts().find((p) => p.id === first.id).quantity, first.quantity);
  assert.strictEqual(db.loadMovements().length, before, "被拒绝的操作不得留下变动记录");
});

t("stock:pick_by_bom：允许部分领用时扣到库存为 0，并逐条列缺口", async () => {
  const { handlers, db } = await envWithLibrary();
  const r = await handlers["stock:pick_by_bom"]({
    file_path: BOM_PATH, sets: 4, reason: "打样领用", allow_partial: true,
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(/^pick_\d{8}_\d{6}$/.test(r.pick_id), r.pick_id);
  assert.ok(r.picked.length > 0);
  assert.ok(r.insufficient.length > 0, "套数放大后应有缺口");
  const stored = db.loadMovements().filter((m) => m.ref === r.pick_id);
  assert.strictEqual(stored.length, r.picked.length, "每条扣减都应留痕");
  assert.ok(stored.every((m) => m.kind === "out"));
});

t("stock:pick_by_bom 不允许部分领用且库存不足 → 整单拒绝、零变动", async () => {
  const { handlers, db } = await envWithLibrary();
  const before = db.loadMovements().length;
  const r = await handlers["stock:pick_by_bom"]({ file_path: BOM_PATH, sets: 4, reason: "打样", allow_partial: false });
  assert.strictEqual(r.ok, false);
  assert.ok(/库存不足，整单拒绝/.test(r.error), r.error);
  assert.deepStrictEqual(r.movements, []);
  assert.strictEqual(db.loadMovements().length, before);
  assert.strictEqual(db.loadParts().reduce((s, p) => s + p.quantity, 0) > 0, true, "库存不得被扣");
});

t("stock:pick_by_bom 遇到库中没有的条目 → 列入 unknown 不静默跳过", async () => {
  const { handlers } = freshEnv();
  const r = await handlers["stock:pick_by_bom"]({ file_path: BOM_PATH, sets: 1, reason: "空库领料", allow_partial: true });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.unknown.length, 33, "空库时 33 条都应在 unknown 里");
  assert.strictEqual(r.picked.length, 0);
});

/* ============================================ §6 变动、设置与备份 */

section("§6 movements:list / settings / data:backup & restore");

t("movements:list 按时间倒序，并支持按 part_id 过滤", async () => {
  const { handlers } = await envWithLibrary();
  const first = (await handlers["parts:list"]({})).parts[0];
  await handlers["stock:move"]({ part_id: first.id, delta: -1, reason: "领一个" });
  const all = await handlers["movements:list"]({});
  assert.strictEqual(all.ok, true);
  assert.strictEqual(all.movements.length, 34);
  const filtered = await handlers["movements:list"]({ part_id: first.id });
  assert.ok(filtered.movements.length >= 2);
  assert.ok(filtered.movements.every((m) => m.part_id === first.id));
});

t("settings:get 首启 14 类阈值；settings:set 非法值被整笔拒绝（AC-9）", async () => {
  const { handlers, db } = freshEnv();
  const got = await handlers["settings:get"]({});
  assert.strictEqual(Object.keys(got.settings.default_min_quantity).length, 14);

  const good = await handlers["settings:set"]({ settings: { default_min_quantity: { C: 30 } } });
  assert.strictEqual(good.ok, true, good.error);
  assert.strictEqual(good.settings.default_min_quantity.C, 30);

  const bad = await handlers["settings:set"]({ settings: { default_min_quantity: { C: "abc", R: 10 } } });
  assert.strictEqual(bad.ok, false);
  assert.ok(/必须是非负数字/.test(bad.error), bad.error);
  assert.strictEqual(db.loadSettings().default_min_quantity.C, 30, "被拒绝的写入不得改动原值");
  assert.strictEqual(db.loadSettings().default_min_quantity.R, 50, "同一笔里的合法项也不得部分写入");
});

t("settings:set 改 data_dir 需带 confirm_data_dir（AGENTS.md 需人工确认项）", async () => {
  const { handlers } = freshEnv();
  const refused = await handlers["settings:set"]({ settings: { data_dir: "another" } });
  assert.strictEqual(refused.ok, false);
  assert.ok(/需人工确认/.test(refused.error), refused.error);
  const done = await handlers["settings:set"]({ settings: { data_dir: "another" }, confirm_data_dir: true });
  assert.strictEqual(done.ok, true, done.error);
  assert.strictEqual(done.settings.data_dir, "another");
});

t("data:backup → 目录里有三个文件；data:restore 需 confirm，成功后数据一致且留了安全备份", async () => {
  const { handlers, db, base } = await envWithLibrary();
  const partsBefore = db.loadParts().length;
  const backup = await handlers["data:backup"]({ dir_path: path.join(base, "backups") });
  assert.strictEqual(backup.ok, true, backup.error);
  for (const f of ["parts.json", "movements.json", "settings.json", "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(backup.backup_path, f)), "备份缺 " + f);
  }
  // 破坏现场：删光器件
  const listed = await handlers["parts:list"]({});
  for (const p of listed.parts) await handlers["parts:delete"]({ part_id: p.id, confirm: true });
  assert.strictEqual(db.loadParts().length, 0);

  const refused = await handlers["data:restore"]({ file_path: backup.backup_path, confirm: false });
  assert.strictEqual(refused.ok, false);
  assert.ok(/需人工确认/.test(refused.error), refused.error);

  const done = await handlers["data:restore"]({ file_path: backup.backup_path, confirm: true });
  assert.strictEqual(done.ok, true, done.error);
  assert.strictEqual(db.loadParts().length, partsBefore, "恢复后应与备份时一致");
  assert.ok(fs.existsSync(done.safety_backup_path), "恢复前应自动留一份当前备份（AC-6）");
});

/* ==================================================== §7 落盘顺序 */

section("§7 落盘顺序：movements 必须先于 parts（FR-4.5）");

t("bom:commit 的 store 调用顺序是「全部 appendMovement → saveParts」", async () => {
  const { db, picked } = freshEnv();
  const order = [];
  const spied = spyStore(db, order);
  const env = createHandlers({ store: spied, pick_files: async () => picked, now: () => FIXED_NOW });
  const parsed = await env.handlers["bom:parse"]({ file_path: BOM_PATH, sets: 1 });
  await env.handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.ok(order.length > 0);
  const firstSave = order.indexOf("saveParts");
  const lastAppend = order.lastIndexOf("appendMovement");
  assert.ok(firstSave > lastAppend, `顺序应为先 movements 后 parts，实际：${order.slice(0, 4).join(",")} … ${order.slice(-3).join(",")}`);
  assert.strictEqual(order.filter((x) => x === "saveParts").length, 1);
});

t("若 parts 落盘失败：**两边都不留**（变动记录也要撤掉，不留解释不了的幽灵留痕）", async () => {
  const { db, picked } = freshEnv();
  const broken = Object.assign(Object.create(db), {
    saveParts: () => { throw new Error("磁盘满了（模拟）"); },
  });
  const env = createHandlers({ store: broken, pick_files: async () => picked, now: () => FIXED_NOW });
  const parsed = await env.handlers["bom:parse"]({ file_path: BOM_PATH, sets: 1 });
  const r = await env.handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.strictEqual(r.ok, false, "落盘失败必须报错，不能假装成功");
  assert.ok(/磁盘满了/.test(r.error), r.error);
  assert.strictEqual(db.loadParts().length, 0, "库存没写进去");
  // **行为变更（审计后修）**：原来是"变动记录留着"——但一次入库有 33 条记录，
  // 逐条写时中途失败会留下"前 k 条已落盘、器件一条没改"的幽灵，而重试那批与它**共用同一个 ref**，
  // 事后完全分不出真假。现在改成"要么两边都成，要么都不留"（批量写 + 失败补偿）。
  assert.strictEqual(db.loadMovements().length, 0, "器件没落盘，变动记录也必须撤掉");
});

/* ====================================================== §8 静态检查 */

section("§8 离线与渲染进程禁令的静态检查");

t("主进程/preload/IPC 层不 require 任何网络模块", () => {
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  for (const rel of ["src/main.js", "src/preload.js", "src/ipc/handlers.js", "src/ipc/channels.js"]) {
    const src = stripComments(fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8"));
    for (const re of [/require\(\s*["'](http|https|net|dns|tls|dgram)["']\s*\)/, /\bfetch\s*\(/, /XMLHttpRequest/]) {
      assert.ok(!re.test(src), `${rel} 命中禁用模式 ${re}`);
    }
  }
});

t("渲染进程：无 require、无 fetch、无远程资源引用，且 CSP 只允许 self", () => {
  // 注释里提到 require/fetch 只是说明文字，不构成能力 → 先剥注释再扫（T7/T8 的同一教训）
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const js = stripComments(fs.readFileSync(path.join(PROJECT_ROOT, "renderer", "app.js"), "utf8"));
  assert.ok(!/require\s*\(/.test(js), "渲染进程不得 require");
  assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(js), "渲染进程不得发起网络请求");
  // 渲染进程必须经由 preload 暴露的 window.api 取数据（允许 `const api = window.api` 这种转存）
  assert.ok(/window\.api/.test(js), "渲染进程应通过 window.api 走 IPC");

  const html = fs.readFileSync(path.join(PROJECT_ROOT, "renderer", "index.html"), "utf8");
  assert.ok(/Content-Security-Policy/.test(html), "缺 CSP");
  assert.ok(/default-src 'self'/.test(html), "CSP 应限制为 self");
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), "页面里不得有远程资源");
});

t("package.json：Electron 入口正确，且**零第三方依赖**", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  assert.strictEqual(pkg.main, "src/main.js");
  assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), []);
  assert.deepStrictEqual(Object.keys(pkg.devDependencies || {}), []);
});

/* ============================================================== 执行与汇总 */

runQueue().then(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T11（IPC 层）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
