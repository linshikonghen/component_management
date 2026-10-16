"use strict";
/**
 * test_audit_fixes.js — T36：**对抗性审计发现 → 修复 → 回归**（一一对应）
 *
 * 运行： node tests/test_audit_fixes.js
 *
 * 背景：两轮对抗性审计（各由独立上下文的 agent 完成，报告在
 * `.addmodel/upload/audit-findings.md` 与评审提交 `R_*`）报了 9 条真缺陷。
 * 这份套件把**每一条**都固化成回归用例——缺陷修完之后，还得有人盯着它不许回来。
 * 编号即审计报告里的编号，便于对照。
 *
 * 审计的价值不在"找出问题"，而在"问题不再回来"。所以这里每条都写清：
 * **原来的错法 → 现在的正确行为 → 为什么这样是对的**。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../src/services/store");
const inv = require("../src/services/inventory");
const cmp = require("../src/services/compare");
const ef = require("../src/services/export_format");
const partsSvc = require("../src/services/parts");
const ids = require("../src/services/ids");
const { createHandlers } = require("../src/ipc/handlers");

const ROOT = path.resolve(__dirname, "..");
const MAIN_BOM = path.join(__dirname, "fixtures", "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_fix_"));

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ kind: "test", name, fn }); }
function section(title) { QUEUE.push({ kind: "section", title }); }

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

let n = 0;
function freshEnv(name, deps = {}) {
  n += 1;
  const base = path.join(TMP, `${name || "e"}${n}`);
  fs.mkdirSync(base, { recursive: true });
  const db = store.createStore({ base_dir: base });
  const env = createHandlers(Object.assign({
    store: db, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 0, 1, 8, 0, 0),
  }, deps));
  return { db, H: env.handlers, base };
}

function bomRow(over = {}) {
  return Object.assign({
    row_no: 1, value: "100nF", footprint: "C0603", voltage: "50V", dielectric: "X7R", tolerance: "",
    quantity_per_board: 10, intake_quantity: 10, action: "keep", designators: ["C1"],
  }, over);
}

/* ================================================== 审计 #1 负库存 */

section("审计 #1（critical）按 BOM 领料：同判定键多行重复扣减 → 库存变负");

t("合计需求超过库存 → 整单拒绝（库存分毫不动）；允许部分 → 扣减总额封顶在库存", () => {
  const parts = [{ id: "p_0001", value: "100nF", footprint: "C0603", voltage: "50V", dielectric: "X7R", tolerance: "", quantity: 15 }];
  const two = [bomRow({ row_no: 1 }), bomRow({ row_no: 2, designators: ["C2"] })]; // 两行同规格、各需 10
  const strict = inv.pickByBom(two, 1, parts, { pick_id: "pick_a", reason: "试产" });
  assert.strictEqual(strict.ok, false, "10+10 > 15，必须整单拒绝（原来会 ok:true 并把库存扣成 -5）");
  assert.strictEqual(strict.parts[0].quantity, 15, "拒绝时库存不动");

  const partial = inv.pickByBom(two, 1, parts, { pick_id: "pick_b", reason: "试产", allow_partial: true });
  assert.strictEqual(partial.parts[0].quantity, 0, "最多扣到 0");
  assert.strictEqual(partial.movements.reduce((a, m) => a + m.delta, 0), -15, "扣减总额 = 库存（不是 -20）");
});

t("端到端：真实样本（含同键两行）不会把任何器件扣成负数", async () => {
  const { db, H } = freshEnv("neg");
  const parsed = await H["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  // 注意：parse 出来的条目 `intake_quantity` 是空的（等人工核对时填），
  // 直接拿去 commit 会**一条都不入库**——这里按"照单全收"补上入库量（sets=1 → 等于单板用量）
  const items = parsed.items.map((it) => Object.assign({}, it, { intake_quantity: it.quantity_per_board }));
  const committed = await H["bom:commit"]({ batch_id: parsed.batch_id, items, sets: 1, reason: "首次入库" });
  assert.strictEqual(committed.ok, true, committed.error);
  assert.ok(db.loadParts().length > 30, `入库后应有三十二条左右，实际 ${db.loadParts().length}`);

  // 把所有器件都调成 0：任何一次领料都必须被拒绝
  db.saveParts(db.loadParts().map((p) => Object.assign({}, p, { quantity: 0 })));
  const pick = await H["stock:pick_by_bom"]({ file_path: MAIN_BOM, sets: 1, reason: "整机" });
  assert.strictEqual(pick.ok, false, "库存全 0 时必然整单拒绝");
  const negatives = db.loadParts().filter((p) => p.quantity < 0);
  assert.deepStrictEqual(negatives, [], "任何情况下都不该出现负库存");
});

/* ================================================== 审计 #2 恢复 */

section("审计 #2（critical）restoreFrom：边读边写 → 半恢复 / 库看起来是空的");

/** 造一个"半损坏"的备份：settings 合法（且 data_dir 指向别处）+ parts 损坏 */
function makeBrokenBackup(dir, movedDir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    schema_version: 1, data_dir: movedDir, default_min_quantity: {}, last_used_dir: "", export_mode: "lcsc",
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "parts.json"), "{ 这不是合法 JSON", "utf8");
  return dir;
}

t("备份里 parts 损坏 → 抛错，且**当前库与设置完全不受影响**（不写半个恢复）", () => {
  const { db, base } = freshEnv("r1");
  db.loadSettings(); // 先落一次 settings.json，快照才有意义
  db.saveParts([{ id: "p_0001", value: "1k", footprint: "R0603", quantity: 3 }]);
  const beforeSettings = fs.readFileSync(db.paths().settings);
  const moved = path.join(TMP, "moved-r1");
  fs.mkdirSync(moved, { recursive: true });
  const bak = makeBrokenBackup(path.join(TMP, "bak-r1"), moved);

  assert.throws(() => db.restoreFrom(bak, { confirm: true }), /损坏|无法解析/);
  assert.strictEqual(db.loadParts().length, 1, "原库必须还在（原来会变成 0 条，用户以为数据没了）");
  assert.ok(beforeSettings.equals(fs.readFileSync(db.paths().settings)), "settings.json 也必须原封不动");
  assert.notStrictEqual(db.loadSettings().data_dir, moved, "data_dir 不能被备份带跑");
  void base;
});

t("备份里 schema_version 不符 → 拒绝恢复，且库仍可读", () => {
  const { db } = freshEnv("r2");
  db.saveParts([{ id: "p_0001", value: "1k", footprint: "R0603", quantity: 3 }]);
  const bak = path.join(TMP, "bak-r2");
  fs.mkdirSync(bak, { recursive: true });
  fs.writeFileSync(path.join(bak, "parts.json"), JSON.stringify({ schema_version: 99, parts: [] }), "utf8");

  assert.throws(() => db.restoreFrom(bak, { confirm: true }), /版本不支持/);
  assert.strictEqual(db.loadParts().length, 1, "库仍可读（原来恢复「成功」后 loadParts 直接抛错）");
});

t("**空库**做的备份也能恢复（原来只有 manifest+settings 的备份会被拒）", () => {
  const { db } = freshEnv("r3");
  db.loadSettings(); // 装了但还没录料
  const dir = path.join(TMP, "bak-r3");
  fs.mkdirSync(dir, { recursive: true });
  const made = db.backupTo(dir);
  assert.deepStrictEqual(fs.readdirSync(made).sort(), ["manifest.json", "settings.json"]);
  const r = db.restoreFrom(made, { confirm: true });
  assert.ok(Array.isArray(r.restored_files), "应正常返回");
  assert.strictEqual(db.loadParts().length, 0, "空库恢复后还是空库（不是报错）");
});

/* ================================================== 审计 #3 备注 */

section("审计 #3（major）核对表「备注」被静默丢弃（FR-1.6 可改字段）");

t("新建路径：note 必须落库（原来硬编码成空串）", () => {
  const r = inv.commitBom("b_note", [bomRow({ note: "人工备注：只买了一半" })], [], {});
  assert.strictEqual(r.parts[0].note, "人工备注：只买了一半");
});

t("合并路径：已有器件空白备注被补上，已有备注不被覆盖", () => {
  const first = inv.commitBom("b1", [bomRow({ note: "第一次的备注" })], [], {});
  const merged = inv.commitBom("b2", [bomRow({ note: "不该覆盖" })], first.parts, {});
  assert.strictEqual(merged.parts[0].note, "第一次的备注", "只补空、不覆盖");

  const empty = inv.commitBom("b3", [bomRow({ note: "" })], [], {});
  const filled = inv.commitBom("b4", [bomRow({ note: "后来补的" })], empty.parts, {});
  assert.strictEqual(filled.parts[0].note, "后来补的", "原来是空的就该补上");
});

/* ================================================== 审计 #4 疑似缺口 */

section("审计 #4（major）疑似条目导出的「数量」列恒为 0");

t("疑似行的 shortfall_quantity = max(0, 需求 − 候选库存)，导出数量列照 spec §4.2", () => {
  const parts = [{ id: "p_0001", value: "10uF", footprint: "C1210", voltage: "50V", dielectric: "X7R", tolerance: "±10%", quantity: 3 }];
  // 缺 voltage/dielectric/tolerance → 键不全 → 进"疑似"，但候选器件的库存是已知的（3）
  const items = [bomRow({ value: "10uF", footprint: "C1210", voltage: "", dielectric: "", tolerance: "", quantity_per_board: 24 })];
  const r = cmp.compareBom(items, parts, 1);
  const row = r.uncertain[0];
  assert.ok(row, "应进疑似");
  assert.strictEqual(row.stock_quantity, 3);
  assert.strictEqual(row.shortfall_quantity, 21, "按 spec §4.2 的公式应为 21（原来恒为 0）");

  const built = ef.buildRows([].concat(r.shortfall, r.uncertain), "lcsc");
  const dataRow = built.rows[built.rows.length - 1];
  assert.ok(dataRow.some((cell) => String(cell) === "21"), "导出的数量列里应出现 21，实际：" + JSON.stringify(dataRow));
});

/* ================================================== 审计 #5 留痕批量化 */

section("审计 #5（major）变动记录逐条写 → 中途失败留幽灵留痕");

t("一次入库只写**一次** movements 文件（批量），不是每条一次", async () => {
  const { db } = freshEnv("batch");
  const calls = [];
  const spy = Object.assign(Object.create(db), {
    appendMovements: (list) => { calls.push(list.length); return db.appendMovements(list); },
    appendMovement: (m) => { calls.push(1); return db.appendMovement(m); },
  });
  const env = createHandlers({ store: spy, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 0, 1, 8, 0, 0) });
  const parsed = await env.handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await env.handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1, reason: "首次入库" });
  assert.deepStrictEqual(calls, [33], `应只调用一次批量写（33 条），实际调用序列：${JSON.stringify(calls)}`);
  assert.strictEqual(db.loadMovements().length, 33);
});

/* ================================================== 审计 #6 kind 矛盾 */

section("审计 #6（minor）kind 与 delta 自相矛盾 / 未登记字段透传");

t("kind 与 delta 方向矛盾 → 抛错（不再写出「出库却加多了」的记录）", () => {
  const parts = [{ id: "p_0001", quantity: 5 }];
  assert.throws(() => inv.moveStock("p_0001", 10, "r", parts, { kind: "out" }), /方向自相矛盾/);
  assert.throws(() => inv.moveStock("p_0001", -1, "r", parts, { kind: "in" }), /方向自相矛盾/);
  // adjust（盘点修正）方向任意，允许
  assert.strictEqual(inv.moveStock("p_0001", -2, "盘点", parts, { kind: "adjust" }).movement.kind, "adjust");
});

t("IPC 层不再透传契约外的 kind/ref：请求里塞了也被忽略", async () => {
  const { db, H } = freshEnv("kind");
  const saved = await H["parts:save"]({ part: { value: "1k", footprint: "R0603", quantity: 5 } });
  const r = await H["stock:move"]({ part_id: saved.part.id, delta: 3, reason: "补货", kind: "out", ref: "乱塞的" });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.movement.kind, "in", "kind 由 delta 推出来（+3 → in），不受请求里塞的值影响");
  assert.strictEqual(r.movement.ref, "", "ref 也不该被塞进来");
  assert.strictEqual(db.loadParts()[0].quantity, 8);
});

/* ================================================== 审计 #7 只读 */

section("审计 #7（minor）compare:export 会凭空写出 settings.json（比对只读）");

t("全新库里比对+导出：data 目录里不出现新文件，parts/movements 字节不变", async () => {
  const { db, H } = freshEnv("ro");
  const run = await H["compare:run"]({ file_path: MAIN_BOM, sets: 1 });
  const dataDir = path.dirname(db.paths().parts);
  const snapshot = () => (fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort() : []);
  const listBefore = snapshot();
  const exported = await H["compare:export"]({ compare_id: run.compare_id, mode: "lcsc" });
  assert.strictEqual(exported.ok, true, exported.error);
  const listAfter = snapshot();
  assert.deepStrictEqual(listAfter, listBefore,
    `比对导出不得在 data/ 里留下文件（原来会凭空多出一个 settings.json），变化：${JSON.stringify(listAfter)}`);
  assert.ok(!listAfter.includes("settings.json"), "settings.json 不该因为一次导出而出现");
  // 导出文件本身落在"数据目录的上级"，不在 data/ 里——顺便确认它真的写出来了
  assert.ok(fs.existsSync(exported.file_path), "导出文件应真的存在：" + exported.file_path);
});

/* ================================================== 审计 B1/B3/B4 */

section("审计 B1（major）删除器件后 ID 被复用 + 删除不留痕");

t("删掉器件后新建：**id 不复用**（沿用过的号永不回收）", async () => {
  const { db, H } = freshEnv("idreuse");
  const a = await H["parts:save"]({ part: { value: "1k", footprint: "R0603", quantity: 1 } });
  const b = await H["parts:save"]({ part: { value: "2k", footprint: "R0603", quantity: 1 } });
  await H["parts:delete"]({ part_id: b.part.id, confirm: true });
  const c = await H["parts:save"]({ part: { value: "3k", footprint: "R0603", quantity: 1 } });
  assert.notStrictEqual(c.part.id, b.part.id, `新器件不得复用已删器件的 id（${b.part.id}）`);
  // 新器件的变动历史里不能出现旧器件的记录
  const history = await H["movements:list"]({ part_id: c.part.id });
  assert.ok(history.movements.every((m) => m.reason !== "手动录入" || m.delta === 1), "历史应是自己的");
  void a;
  void db;
});

t("删除有库存的器件 → 补一条 adjust 留痕（总库存变化可解释，FR-4.5）", async () => {
  const { db, H } = freshEnv("deltrace");
  const saved = await H["parts:save"]({ part: { value: "22uF", footprint: "C1206", quantity: 13 } });
  const before = db.loadParts().reduce((s, p) => s + p.quantity, 0);
  await H["parts:delete"]({ part_id: saved.part.id, confirm: true });
  const after = db.loadParts().reduce((s, p) => s + p.quantity, 0);
  const adjust = db.loadMovements().find((m) => m.kind === "adjust");
  assert.ok(adjust, "应有 adjust 记录");
  assert.strictEqual(after - before, -13, "总库存少了 13");
  assert.strictEqual(adjust.delta, -13, "adjust 记录必须正好解释这 13 个");
});

section("审计 B3（major）按 BOM 领料服务端不校验原因");

t("未填原因 → 拒绝（与 stock:move 同一套要求，plan §6 reason 必填）", () => {
  const parts = [{ id: "p_0001", value: "100nF", footprint: "C0603", voltage: "50V", dielectric: "X7R", tolerance: "", quantity: 50 }];
  assert.throws(() => inv.pickByBom([bomRow()], 1, parts, { pick_id: "pick_r" }), /必须填写原因/);
  assert.throws(() => inv.pickByBom([bomRow()], 1, parts, { pick_id: "pick_r", reason: "   " }), /必须填写原因/);
});

section("审计 B4（major）运行号秒级精度：同秒两次运行共用 ID");

t("同一秒内两次解析/比对/领料：三个运行号互不相同", async () => {
  // 时钟钉死在同一秒：这正是审计里用来复现的条件
  const frozen = () => new Date(2026, 0, 1, 8, 0, 0);
  const { db, H } = freshEnv("sameclock", { now: frozen });
  const p1 = await H["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const p2 = await H["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  assert.notStrictEqual(p1.batch_id, p2.batch_id, `两次解析不该共用批次号（${p1.batch_id}）`);
  assert.ok(p1.batch_id.startsWith("batch_20260101_080000"), "标准形态不变：" + p1.batch_id);

  const c1 = await H["compare:run"]({ file_path: MAIN_BOM, sets: 1 });
  const c2 = await H["compare:run"]({ file_path: MAIN_BOM, sets: 1 });
  assert.notStrictEqual(c1.compare_id, c2.compare_id, "两次比对不该共用比对号");

  const items = p1.items.map((it) => Object.assign({}, it, { intake_quantity: it.quantity_per_board }));
  const committed = await H["bom:commit"]({ batch_id: p1.batch_id, items, sets: 1, reason: "首次入库" });
  assert.strictEqual(committed.ok, true, committed.error);
  // 两次领料都允许部分（第一次会把库存领光，第二次只能领到 0——但它仍应拿到**自己的**批次号）
  const k1 = await H["stock:pick_by_bom"]({ file_path: MAIN_BOM, sets: 1, reason: "第一次", allow_partial: true });
  const k2 = await H["stock:pick_by_bom"]({ file_path: MAIN_BOM, sets: 1, reason: "第二次", allow_partial: true });
  assert.strictEqual(k1.ok, true, k1.error);
  assert.strictEqual(k2.ok, true, k2.error);
  assert.notStrictEqual(k1.pick_id, k2.pick_id, "两次领料不该共用批次号");
  assert.strictEqual(k1.pick_id, "pick_20260101_080000", "标准形态不变");
  assert.strictEqual(k2.pick_id, "pick_20260101_080000-2", "撞车时才加后缀");
  void db;
});

/* ================================================== 审计外的顺带 */

section("顺带：id 分配的唯一实现（反重复）");

t("ids.nextPartId 把变动记录里的 part_id 也算进「用过的号」", () => {
  const library = [{ id: "p_0001" }];
  const movements = [{ part_id: "p_0007" }];
  assert.strictEqual(ids.nextPartId(library, movements), "p_0008", "取两者最大号 +1");
  assert.strictEqual(ids.nextPartId(library, []), "p_0002");
  assert.strictEqual(inv.nextPartId(library, movements), "p_0008", "inventory 与 ids 必须一致（唯一实现）");
});

/* ================================================== 审计"未验证疑点"两条 */

section("审计未验证疑点 ①（排序）时间戳按字符串比较 → 跨时区排错");

t("跨时区的时间戳也能正确倒序；同一秒仍按插入倒序；脏数据不抛错", () => {
  // 这两条的**真实先后**：15:00Z 在前、16:00Z 在后；字符串比较却会把 "+08:00" 那条排前面
  const list = [
    { id: "m_1", part_id: "p_0001", at: "2026-10-15T23:00:00+08:00", delta: 1 }, // = 15:00Z
    { id: "m_2", part_id: "p_0001", at: "2026-10-15T16:00:00+00:00", delta: 2 }, // = 16:00Z（更晚）
  ];
  const sorted = inv.filterMovements(list, { part_id: "p_0001" });
  assert.deepStrictEqual(sorted.map((m) => m.id), ["m_2", "m_1"], "16:00Z 必须排在 23:00+08:00 之后");

  // 同一秒的多条：后写入的排前面（原有行为，不能被这次修复改坏）
  const same = [
    { id: "a", part_id: "p_0001", at: "2026-10-15T10:00:00+08:00" },
    { id: "b", part_id: "p_0001", at: "2026-10-15T10:00:00+08:00" },
  ];
  assert.deepStrictEqual(inv.filterMovements(same, { part_id: "p_0001" }).map((m) => m.id), ["b", "a"]);

  // 脏数据（解析不出来的时间）：不抛错，且顺序确定可复现
  const dirty = [
    { id: "x", part_id: "p_0001", at: "不是时间" },
    { id: "y", part_id: "p_0001", at: "2026-10-15T10:00:00+08:00" },
  ];
  const once = inv.filterMovements(dirty, { part_id: "p_0001" }).map((m) => m.id);
  const twice = inv.filterMovements(dirty.slice().reverse(), { part_id: "p_0001" }).map((m) => m.id);
  assert.strictEqual(once.length, 2);
  assert.deepStrictEqual(twice, once, "同样输入顺序下的结果必须稳定");
});

section("审计未验证疑点 ②（闸门）commit 只认 batch_id → 可塞进解析时没有的条目");

t("伪造行号被拒；来自该批次的合法编辑（改值/改入库量/跳过）仍被接受", async () => {
  const { H } = freshEnv("gate");
  const parsed = await H["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  assert.strictEqual(parsed.ok, true, parsed.error);

  // ① 伪造一行（row_no 999 不在解析结果里）→ 整笔拒绝
  const forged = parsed.items.slice(0, 3).concat([{
    row_no: 999, value: "假料", footprint: "X-999", quantity_per_board: 1, intake_quantity: 1, action: "keep",
  }]);
  const bad = await H["bom:commit"]({ batch_id: parsed.batch_id, items: forged, sets: 1, reason: "试" });
  assert.strictEqual(bad.ok, false, "解析时没有的行必须被拒");
  assert.ok(/不是这份 BOM 解析出来的/.test(bad.error), bad.error);

  // ② 合法：来自该批次、改了值/入库量、还跳过一行 → 必须放行（否则就是矫枉过正）
  const legit = parsed.items.slice(0, 5).map((it, i) => Object.assign({}, it, {
    intake_quantity: i === 0 ? 3 : it.intake_quantity,
    value: i === 1 ? "人工改过的值" : it.value,
    action: i === 4 ? "skip" : "keep",
  }));
  const good = await H["bom:commit"]({ batch_id: parsed.batch_id, items: legit, sets: 1, reason: "试" });
  assert.strictEqual(good.ok, true, good.error);
  assert.strictEqual(good.skipped, 1, "跳过的 1 行应计入 skipped");
  assert.strictEqual(good.added + good.merged, 4, "其余 4 行入库");
});

/* ---------------------------------------------------------------- */

runQueue().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }
  console.log("\n" + "=".repeat(64));
  console.log(`T36（审计发现回归）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
