"use strict";
/**
 * test_backup_model.js — T18（plan §9 的 T14）验收测试：备份/恢复页规则 + **AC-6**
 *
 * 运行： node tests/test_backup_model.js
 *
 *   §1~§4 规则（路径校验、请求组装、恢复需确认、结果摘要）
 *   §5    **AC-6 端到端**：备份 → 改数据 → 恢复 → 数据与备份时一致，且恢复前自动留一份当前状态
 *   §6    静态检查（备份页只调 dataBackup/dataRestore/settingsGet）
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const model = require("../renderer/model/backup_model.js");
const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_backup_"));

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

/* ==================================================== §1 路径校验 */

section("§1 路径校验（两种操作共用）");

t("空路径被拒绝（并说清是哪个路径）", () => {
  assert.ok(/备份目录不能为空/.test(model.validatePath("", "备份目录").error));
  assert.ok(/备份目录不能为空/.test(model.validatePath("   ", "备份目录").error));
  assert.ok(/恢复目录不能为空/.test(model.validatePath(null, "恢复目录").error));
});

t("非法字符被拒绝并回显收到什么", () => {
  const r = model.validatePath("D:\\a<b", "备份目录");
  assert.strictEqual(r.ok, false);
  assert.ok(/收到「D:\\a<b」/.test(r.error), r.error);
});

t("正常路径通过，且去掉首尾空格", () => {
  const r = model.validatePath("  D:\\元器件备份  ", "备份目录");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, "D:\\元器件备份");
});

/* ================================================ §2 备份请求 */

section("§2 备份请求组装");

t("组装 { dir_path }；非法路径不给请求", () => {
  const good = model.backupRequest("D:\\bak");
  assert.strictEqual(good.ok, true, good.error);
  assert.deepStrictEqual(good.request, { dir_path: "D:\\bak" });
  const bad = model.backupRequest("");
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.request, null);
});

/* ================================================ §3 恢复请求 */

section("§3 恢复需人工确认（AGENTS.md：恢复备份会覆盖当前数据）");

t("未勾确认 → needs_confirm，且**不给载荷**", () => {
  const r = model.restoreRequest("D:\\bak\\x", false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needs_confirm, true);
  assert.strictEqual(r.request, null);
  assert.ok(/勾选确认/.test(r.error), r.error);
});

t("勾了确认 → 载荷带 confirm:true", () => {
  const r = model.restoreRequest("D:\\bak\\x", true);
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.request, { file_path: "D:\\bak\\x", confirm: true });
});

t("路径非法时**不问确认**（先修路径，别让用户白勾一遍）", () => {
  const r = model.restoreRequest("", true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needs_confirm, false);
});

/* ================================================ §4 结果摘要 */

section("§4 结果摘要（要说清「留了一份在哪」）");

t("备份成功给路径；失败给原因", () => {
  assert.ok(/D:\\bak\\x/.test(model.backupSummary({ ok: true, backup_path: "D:\\bak\\x" })));
  assert.ok(/备份失败：磁盘满/.test(model.backupSummary({ ok: false, error: "磁盘满" })));
});

t("恢复成功说清：来源、文件数、条数、**恢复前那一份在哪**", () => {
  const text = model.restoreSummary({
    ok: true, restored_from: "D:\\bak\\x", restored_files: ["settings.json", "parts.json", "movements.json"],
    parts_count: 32, movements_count: 33, safety_backup_path: "D:\\bak\\x.pre-restore-20261015",
  });
  assert.ok(/D:\\bak\\x/.test(text), text);
  assert.ok(/3 个文件/.test(text), text);
  assert.ok(/32 条器件/.test(text) && /33 条变动记录/.test(text), text);
  assert.ok(/D:\\bak\\x.pre-restore-20261015/.test(text), text);
  assert.ok(/反悔/.test(text), text);
});

t("恢复失败给原因", () => {
  assert.ok(/恢复失败：没有 parts.json/.test(model.restoreSummary({ ok: false, error: "没有 parts.json" })));
});

t("数据目录提示：空则显示默认", () => {
  assert.ok(/默认 data/.test(model.dataDirLine({ data_dir: "" })));
  assert.ok(/D:\\库/.test(model.dataDirLine({ data_dir: "D:\\库" })));
});

/* ================================================ §5 AC-6 端到端 */

section("§5 AC-6：备份 → 改数据 → 恢复 → 与备份时一致（且恢复前自动留一份）");

let envNo = 0;
function freshEnv() {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers, base };
}

/** 便于比较的快照：器件（id/值/封装/数量） + 变动条数 + 阈值 */
function snapshot(handlers, db) {
  const parts = db.loadParts().map((p) => `${p.id}|${p.value}|${p.footprint}|${p.quantity}`).sort();
  const movements = db.loadMovements();
  return {
    parts,
    movements_count: movements.length,
    min_c: db.loadSettings().default_min_quantity.C,
    ids: db.loadParts().map((p) => p.id).sort(),
  };
}

t("AC-6 全流程：导入 32 条 → 备份 → 改库 → 恢复 → 与备份时**逐条一致**", async () => {
  const { handlers, db } = freshEnv();
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.strictEqual(db.loadParts().length, 32);

  // ① 备份
  const backupDir = path.join(TMP, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const built = model.backupRequest(backupDir);
  const backup = await handlers["data:backup"](built.request);
  assert.strictEqual(backup.ok, true, backup.error);
  assert.ok(fs.existsSync(path.join(backup.backup_path, "parts.json")), "备份目录里必须有 parts.json");
  assert.ok(fs.existsSync(path.join(backup.backup_path, "manifest.json")), "还要有 manifest");
  const atBackup = snapshot(handlers, db);

  // ② 改数据：加一条器件、出库一笔、改阈值
  await handlers["parts:save"]({ part: { value: "新料", footprint: "C0603", quantity: 7 } });
  const somePart = db.loadParts().find((p) => p.quantity > 5);
  await handlers["stock:move"]({ part_id: somePart.id, delta: -3, reason: "领用" });
  await handlers["settings:set"]({ settings: { default_min_quantity: { C: 99 } } });
  const afterChanges = snapshot(handlers, db);
  assert.notDeepStrictEqual(afterChanges.parts, atBackup.parts, "这一步必须真的改了数据，否则下面的恢复断言是空的");
  assert.strictEqual(db.loadParts().length, 33);

  // ③ 恢复（带确认）
  const restored = await handlers["data:restore"](model.restoreRequest(backup.backup_path, true).request);
  assert.strictEqual(restored.ok, true, restored.error);

  const afterRestore = snapshot(handlers, db);
  assert.deepStrictEqual(afterRestore.parts, atBackup.parts, "恢复后器件必须与备份时逐条一致");
  assert.strictEqual(afterRestore.movements_count, atBackup.movements_count, "变动记录也要回到备份时");
  assert.strictEqual(afterRestore.min_c, atBackup.min_c, "设置同样要恢复");
  console.log(`        （备份时 ${atBackup.parts.length} 条 → 改动后 ${afterChanges.parts.length} 条 → 恢复后 ${afterRestore.parts.length} 条）`);

  // ④ 恢复前自动留的那一份，内容应是"改动后"的状态
  assert.ok(restored.safety_backup_path, "必须返回 safety_backup_path");
  assert.ok(fs.existsSync(restored.safety_backup_path), "safety 目录必须真的存在");
  const safetyParts = JSON.parse(fs.readFileSync(path.join(restored.safety_backup_path, "parts.json"), "utf8"));
  assert.strictEqual(safetyParts.parts.length, 33, "safety 里存的应是**覆盖前**那 33 条");
  console.log(`        （覆盖前自动另存：${path.basename(restored.safety_backup_path)} 里有 ${safetyParts.parts.length} 条）`);
});

t("AC-6 异常路径：不带 confirm 的恢复被拒绝，数据一点不动", async () => {
  const { handlers, db } = freshEnv();
  await handlers["parts:save"]({ part: { value: "10uF", footprint: "C1210", quantity: 5 } });
  const backupDir = path.join(TMP, "backups2");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = await handlers["data:backup"]({ dir_path: backupDir });
  await handlers["parts:save"]({ part: { value: "22uF", footprint: "C1206", quantity: 9 } });
  const before = snapshot(handlers, db);

  const refused = await handlers["data:restore"]({ file_path: backup.backup_path, confirm: false });
  assert.strictEqual(refused.ok, false);
  assert.ok(/确认/.test(refused.error), refused.error);
  assert.deepStrictEqual(snapshot(handlers, db), before, "被拒绝的恢复不得改动任何东西");
});

t("AC-6 异常路径：指向一个不是备份的目录 → 拒绝并说明缺什么", async () => {
  const { handlers, db } = freshEnv();
  await handlers["parts:save"]({ part: { value: "10uF", footprint: "C1210", quantity: 5 } });
  const emptyDir = path.join(TMP, "not-a-backup");
  fs.mkdirSync(emptyDir, { recursive: true });
  const before = snapshot(handlers, db);

  const r = await handlers["data:restore"]({ file_path: emptyDir, confirm: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/不是本工具的整库备份/.test(r.error), r.error);
  assert.deepStrictEqual(snapshot(handlers, db), before, "目录不对时不得动数据");
});

t("恢复用的写盘是**原子写**：恢复过程不会留下半个文件", async () => {
  const { handlers } = freshEnv();
  await handlers["parts:save"]({ part: { value: "1k", footprint: "R0603", quantity: 50 } });
  const backupDir = path.join(TMP, "backups3");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = await handlers["data:backup"]({ dir_path: backupDir });
  await handlers["data:restore"](model.restoreRequest(backup.backup_path, true).request);

  const dataDir = path.join(TMP, "e" + envNo, "data");
  const leftovers = fs.readdirSync(dataDir).filter((f) => /\.tmp$|\.tmp-|\.tmp\./.test(f));
  assert.deepStrictEqual(leftovers, [], "不应留下临时文件");
  // 且关键文件都是合法 JSON
  for (const name of ["parts.json", "movements.json", "settings.json"]) {
    const raw = fs.readFileSync(path.join(dataDir, name), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), name + " 应是合法 JSON");
  }
});

/* ==================================================== §6 静态检查 */

section("§6 静态检查：备份页只调允许的通道");

function readIfExists(rel) {
  const full = path.join(PROJECT_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

t("备份页只调 dataBackup / dataRestore / settingsGet", () => {
  const src = stripComments(readIfExists("renderer/pages/backup_page.js"));
  const calls = [...src.matchAll(/call\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "没解析到 IPC 调用");
  const allowed = new Set(["dataBackup", "dataRestore", "settingsGet"]);
  for (const name of calls) assert.ok(allowed.has(name), `备份页调用了未授权的通道：${name}`);
  console.log(`        （备份页实际调用：${[...new Set(calls)].sort().join(" / ")}）`);
});

t("备份页/备份模型都没有 require / fetch", () => {
  for (const rel of ["renderer/pages/backup_page.js", "renderer/model/backup_model.js"]) {
    const src = stripComments(readIfExists(rel));
    assert.ok(!/require\s*\(/.test(src), rel + " 不得 require");
    assert.ok(!/fetch\s*\(|XMLHttpRequest/.test(src), rel + " 不得联网");
  }
});

t("index.html 有独立的备份页 section 与挂载点", () => {
  const html = readIfExists("renderer/index.html");
  assert.ok(/id="page-backup"/.test(html), "缺备份页 section");
  assert.ok(/id="backup-panel"/.test(html), "缺备份页挂载点");
  assert.ok(/data-page="backup"/.test(html), "缺侧栏入口");
  // 导航顺序好看一点：备份在设置后面
  assert.ok(html.indexOf('data-page="settings"') < html.indexOf('data-page="backup"'));
});

/* ------------------------------------------------------------------ 执行 */

runQueue().then(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T18（备份/恢复页规则与 AC-6）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
