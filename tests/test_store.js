"use strict";
/**
 * test_store.js — T6（plan §9 的 T2）验收测试
 *
 * 运行： node tests/test_store.js
 *
 * 重点验 plan §9 给 T2 定的验收：**"写坏测试：中途失败原文件完好"**（对应 spec NFR-4），
 * 以及 AC-6（备份/恢复、恢复前自动留一份）、AC-9（阈值非数字拒绝且原值不变）。
 *
 * 全部在**临时目录**里跑；最后有一条断言专门确认**真实 data/ 未被碰过**
 * （AGENTS.md：data/ 下真实数据不得用于测试）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storeModule = require("../src/services/store");
const { createStore } = storeModule;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_store_"));
// 加载时先拍真实 data/ 的快照，套件跑完再比对（见 tests/real_data_guard.js）
const { createRealDataGuard } = require("./real_data_guard");
const REAL_DATA = createRealDataGuard(PROJECT_ROOT);

let passCount = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log("  PASS  " + name);
  } catch (exc) {
    failures.push({ name, message: String(exc && exc.message ? exc.message : exc) });
    console.log("  FAIL  " + name);
    console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
  }
}

function section(title) {
  console.log("\n=== " + title + " ===");
}

/** 每个用例一个干净的 base_dir，互不干扰 */
let caseNo = 0;
function mkTmp() {
  caseNo += 1;
  const base = path.join(TMP, "case" + caseNo);
  fs.mkdirSync(base, { recursive: true });
  return base;
}
function freshStore() {
  return createStore({ base_dir: mkTmp() });
}

const PART = {
  id: "p_0001", category: "C", value: "10uF", footprint: "C1210", voltage: "50V",
  dielectric: "X7R", tolerance: "±10%", quantity: 24, min_quantity: null,
  created_at: "2026-10-15T10:00:00+08:00", updated_at: "2026-10-15T10:00:00+08:00",
};

/* ====================================================== §1 原子写与失败安全 */

section("§1 原子写（plan §9 T2 验收：中途失败原文件完好 / spec NFR-4）");

t("saveParts → loadParts 往返一致，且不留临时文件", () => {
  const s = freshStore();
  const info = s.saveParts([PART]);
  assert.ok(fs.existsSync(info.file), "文件应存在");
  assert.deepStrictEqual(s.loadParts(), [PART]);
  const leftovers = fs.readdirSync(path.dirname(info.file)).filter((n) => n.includes(".tmp-"));
  assert.deepStrictEqual(leftovers, [], "不该残留临时文件: " + leftovers);
  // 落盘内容应是可读的 JSON（不是半个文件）
  const raw = JSON.parse(fs.readFileSync(info.file, "utf8"));
  assert.strictEqual(raw.schema_version, 1);
  assert.strictEqual(raw.parts.length, 1);
});

t("序列化就失败（循环引用）→ **原文件字节不变**，且不留临时文件", () => {
  const s = freshStore();
  s.saveParts([PART]);
  const file = s.paths().parts;
  const before = fs.readFileSync(file);
  const circular = [];
  circular.push(circular);
  assert.throws(() => s.saveParts(circular), /无法序列化/);
  assert.ok(before.equals(fs.readFileSync(file)), "失败后原文件必须逐字节不变");
  assert.deepStrictEqual(s.loadParts(), [PART], "原数据仍可读且完好");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-")), []);
});

t("替换失败（目标被目录占位）→ 报明确错误 + 临时文件被清理", () => {
  const s = freshStore();
  s.saveParts([PART]);
  const file = s.paths().parts;
  const before = fs.readFileSync(file);
  fs.unlinkSync(file);
  fs.mkdirSync(file); // 让 rename 无法覆盖
  try {
    assert.throws(() => s.saveParts([PART, PART]), /替换数据文件失败|目标可能正被其他程序打开/);
    assert.ok(fs.statSync(file).isDirectory(), "失败后原状保持");
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-")), [],
      "失败路径必须清理临时文件");
  } finally {
    fs.rmdirSync(file);
    fs.writeFileSync(file, before);
  }
  assert.deepStrictEqual(s.loadParts(), [PART]);
});

t("同一份数据两次保存结果逐字节相同（内容确定性，便于比对）", () => {
  const s1 = freshStore();
  const s2 = freshStore();
  s1.saveParts([PART]);
  s2.saveParts([PART]);
  assert.ok(fs.readFileSync(s1.paths().parts).equals(fs.readFileSync(s2.paths().parts)));
});

/* =========================================================== §2 损坏不静默 */

section("§2 数据损坏/版本不符 → 抛错，绝不静默当空库（spec AC-6 异常路径）");

t("JSON 损坏 → 抛错且**文件保持原样**（不搬动用户文件）", () => {
  const s = freshStore();
  s.saveParts([PART]);
  const file = s.paths().parts;
  fs.writeFileSync(file, "{ 这不是 JSON", "utf8");
  const before = fs.readFileSync(file);
  assert.throws(() => s.loadParts(), /已损坏，无法解析/);
  assert.ok(before.equals(fs.readFileSync(file)), "读取路径不得修改损坏文件");
});

t("schema_version 不认识 → 拒绝读入（不猜着读）", () => {
  const s = freshStore();
  s.saveParts([PART]);
  const file = s.paths().parts;
  fs.writeFileSync(file, JSON.stringify({ schema_version: 999, parts: [] }), "utf8");
  assert.throws(() => s.loadParts(), /版本不支持/);
});

t("结构不对（parts 不是数组）→ 抛错", () => {
  const s = freshStore();
  s.saveParts([PART]);
  fs.writeFileSync(s.paths().parts, JSON.stringify({ schema_version: 1, parts: {} }), "utf8");
  assert.throws(() => s.loadParts(), /parts 应为数组/);
});

t("文件不存在 = 首次运行 → 返回空库（不是错误）", () => {
  const s = freshStore();
  assert.deepStrictEqual(s.loadParts(), []);
  assert.deepStrictEqual(s.loadMovements(), []);
  assert.ok(!fs.existsSync(s.paths().parts), "读空库不该顺手创建文件");
});

/* ================================================================ §3 设置 */

section("§3 设置：首启默认值 + 字段级校验（plan §6.4 / spec AC-9）");

t("首启写入 14 类预置阈值（spec §5.3 逐项核对）", () => {
  const s = freshStore();
  const settings = s.loadSettings();
  assert.deepStrictEqual(settings.default_min_quantity, {
    C: 20, R: 50, L: 10, D: 10, Q: 10, U: 5,
    CN: 5, X: 3, KEY: 5, F: 5, BUZZER: 2,
    LED: 10, H: 10, _default: 5,
  });
  assert.strictEqual(Object.keys(settings.default_min_quantity).length, 14);
  assert.strictEqual(settings.export_mode, "lcsc");
  assert.strictEqual(settings.schema_version, 1);
  assert.ok(fs.existsSync(s.paths().settings), "首启应把默认设置落盘");
});

t("改「电容」默认阈值 20→30 后能读回（AC-9 第 2 条）", () => {
  const s = freshStore();
  s.loadSettings();
  const next = s.saveSettings({ default_min_quantity: { C: 30 } });
  assert.strictEqual(next.default_min_quantity.C, 30);
  assert.strictEqual(next.default_min_quantity.R, 50, "未提交的分类保持原值");
  assert.strictEqual(s.loadSettings().default_min_quantity.C, 30, "改动应已持久化");
});

t("阈值填非数字（abc）→ **整笔拒绝且原值不变**（AC-9 异常路径）", () => {
  const s = freshStore();
  s.loadSettings();
  s.saveSettings({ default_min_quantity: { C: 30 } });
  assert.throws(() => s.saveSettings({ default_min_quantity: { C: "abc", R: 10 } }),
    /必须是非负数字/);
  const now = s.loadSettings();
  assert.strictEqual(now.default_min_quantity.C, 30, "被拒绝的写入不能改动原值");
  assert.strictEqual(now.default_min_quantity.R, 50, "同一笔里的合法项也不得部分写入（整笔拒绝）");
  assert.throws(() => s.saveSettings({ default_min_quantity: { C: null } }), /必须是非负数字/);
  assert.throws(() => s.saveSettings({ default_min_quantity: { C: -1 } }), /必须是非负数字/);
});

t("未知设置项 / 非法导出模式 → 拒绝", () => {
  const s = freshStore();
  assert.throws(() => s.saveSettings({ remember_sets: true }), /未知设置项/);
  assert.throws(() => s.saveSettings({ export_mode: "eda" }), /只能是 lcsc \/ jlc/);
  assert.strictEqual(s.loadSettings().export_mode, "lcsc");
});

t("改 data_dir 需显式确认；确认后 parts 落到新目录（AGENTS.md 需人工确认项）", () => {
  const s = freshStore();
  s.loadSettings();
  s.saveParts([PART]);
  assert.throws(() => s.saveSettings({ data_dir: "other" }), /需人工确认/);
  const next = s.saveSettings({ data_dir: "other" }, { confirm_data_dir: true });
  assert.strictEqual(next.data_dir, "other");
  assert.ok(s.paths().parts.endsWith(path.join("other", "parts.json")), s.paths().parts);
  assert.deepStrictEqual(s.loadParts(), [], "新目录里还没有数据（这是换目录，不是数据丢失）");
  s.saveParts([PART]);
  assert.deepStrictEqual(s.loadParts(), [PART]);
});

/* ========================================================== §4 变动记录 */

section("§4 变动记录：id/时间自动补 + 枚举校验（spec FR-4.5）");

t("appendMovement 自动补 id 与时间，并按序持久化", () => {
  const s = freshStore();
  const m1 = s.appendMovement({ part_id: "p_0001", kind: "in", delta: 24, before: 0, after: 24, reason: "BOM 导入", ref: "batch_x" });
  const m2 = s.appendMovement({ part_id: "p_0001", kind: "out", delta: -5, before: 24, after: 19, reason: "领用" });
  assert.strictEqual(m1.id, "m_0001");
  assert.strictEqual(m2.id, "m_0002");
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(m1.at), "时间是带时区偏移的 ISO: " + m1.at);
  const all = s.loadMovements();
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((m) => m.id), ["m_0001", "m_0002"]);
  assert.strictEqual(all[1].delta, -5);
});

t("kind 必须在 plan §3.2 枚举内；part_id 必填", () => {
  const s = freshStore();
  assert.throws(() => s.appendMovement({ part_id: "p_1", kind: "steal" }), /不合法/);
  assert.throws(() => s.appendMovement({ kind: "in" }), /缺少 part_id/);
  for (const kind of ["in", "out", "adjust", "init"]) {
    assert.doesNotThrow(() => s.appendMovement({ part_id: "p_1", kind, delta: 1 }));
  }
  assert.strictEqual(s.loadMovements().length, 4);
});

t("id 生成取现有最大号 +1（不重复、不受删除影响）", () => {
  assert.strictEqual(storeModule.nextId([], "p"), "p_0001");
  assert.strictEqual(storeModule.nextId([{ id: "p_0003" }], "p"), "p_0004");
  assert.strictEqual(storeModule.nextId([{ id: "p_0003" }, { id: "p_0010" }, { id: "别的" }], "p"), "p_0011");
  assert.strictEqual(storeModule.nextId([{ id: "p_0009" }], "m"), "m_0001", "前缀不同互不干扰");
});

/* ============================================================ §5 备份恢复 */

section("§5 备份 / 恢复（spec AC-6：恢复后一致；恢复前自动留一份）");

t("backupTo 生成带清单的备份目录，条数记录正确", () => {
  const s = freshStore();
  s.saveParts([PART, Object.assign({}, PART, { id: "p_0002" })]);
  s.appendMovement({ part_id: "p_0001", kind: "in", delta: 1 });
  const dir = s.backupTo(path.join(s.base_dir, "backups"));
  assert.ok(fs.existsSync(dir));
  for (const f of ["parts.json", "movements.json", "settings.json", "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), "备份缺 " + f);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.strictEqual(manifest.parts_count, 2);
  assert.strictEqual(manifest.movements_count, 1);
  assert.ok(manifest.backed_up_at);
});

t("恢复需显式 confirm（NFR-5：危险操作二次确认）", () => {
  const s = freshStore();
  s.saveParts([PART]);
  const dir = s.backupTo(path.join(s.base_dir, "backups"));
  assert.throws(() => s.restoreFrom(dir), /需人工确认/);
  assert.throws(() => s.restoreFrom(dir, { confirm: false }), /需人工确认/);
  assert.deepStrictEqual(s.loadParts(), [PART], "未确认时数据不得变动");
});

t("AC-6：恢复后数据与备份时一致，且**恢复前自动留了一份当前备份**", () => {
  const s = freshStore();
  s.saveParts([PART]);
  s.appendMovement({ part_id: "p_0001", kind: "in", delta: 24 });
  const backupDir = s.backupTo(path.join(s.base_dir, "backups"));

  // 备份之后又把库改坏：删光 + 加一条垃圾
  s.saveParts([]);
  s.appendMovement({ part_id: "p_9999", kind: "out", delta: -1 });

  const result = s.restoreFrom(backupDir, { confirm: true });
  assert.deepStrictEqual(s.loadParts(), [PART], "恢复后应与备份时一致");
  assert.strictEqual(s.loadMovements().length, 1, "变动记录也应恢复");
  assert.strictEqual(result.restored_from, backupDir);

  // 关键：恢复前的那份"当前状态"必须被自动留存，否则恢复错了没法回去
  assert.ok(fs.existsSync(result.safety_backup_path), "缺恢复前的安全备份");
  const safetyParts = JSON.parse(fs.readFileSync(path.join(result.safety_backup_path, "parts.json"), "utf8"));
  assert.deepStrictEqual(safetyParts.parts, [], "安全备份里应是恢复前的（空）状态");
});

t("指向非备份目录 → 明确拒绝（不误当整库恢复）", () => {
  const s = freshStore();
  const empty = path.join(s.base_dir, "notabackup");
  fs.mkdirSync(empty, { recursive: true });
  assert.throws(() => s.restoreFrom(empty, { confirm: true }), /不是本工具的整库备份/);
  assert.throws(() => s.restoreFrom(path.join(s.base_dir, "查无此目录"), { confirm: true }), /不存在或不是目录/);
});

/* ==================================================== §6 隔离与真实数据 */

section("§6 测试隔离：绝不触碰真实 data/（AGENTS.md 硬规则）");

t("所有写入都发生在临时目录；项目 data/ 未被创建或改动", () => {
  // 快照比对（而不是"data/ 必须不存在"）：用户真的用过工具后 data/ 本就存在，
  // 那是正常使用；这里要守的是"**本套件运行期间**没碰过真实库"。见 tests/real_data_guard.js
  REAL_DATA.assertUnchanged("T6 store 套件");
  // 默认实例确实指向项目 data/（说明隔离靠的是显式传 base_dir，不是"恰好没写"）
  assert.ok(storeModule.paths().parts.startsWith(PROJECT_ROOT), storeModule.paths().parts);
});

t("两个实例互不干扰（base_dir 隔离生效）", () => {
  const a = freshStore();
  const b = freshStore();
  a.saveParts([PART]);
  b.saveParts([]);
  assert.strictEqual(a.loadParts().length, 1);
  assert.strictEqual(b.loadParts().length, 0);
});

t("AC-6 第 5 行：**关闭再打开数据还在**（换个实例读同一个目录，内容一致）", () => {
  const base = mkTmp(); // 同一个目录
  const first = createStore({ base_dir: base });
  first.saveParts([PART]);
  first.appendMovement({ part_id: PART.id, kind: "init", delta: PART.quantity, before: 0, after: PART.quantity, reason: "初次" });
  const settings = first.saveSettings({ default_min_quantity: { C: 42 } });
  assert.strictEqual(settings.default_min_quantity.C, 42);

  // 模拟"关掉应用再打开"：换一个全新实例，只给同一个 base_dir
  const second = createStore({ base_dir: base });
  assert.deepStrictEqual(second.loadParts(), [PART], "器件应原样读回");
  assert.strictEqual(second.loadMovements().length, 1, "变动记录应原样读回");
  assert.strictEqual(second.loadSettings().default_min_quantity.C, 42, "设置应原样读回");
});

/* ================================================ §7 与规格文档逐项对齐 */

section("§7 默认阈值与 spec §5.3 / plan §3.3 **按文档**核对（不是抄我自己的期望值）");

/** 从 spec §5.3 的表格里解析出「位号前缀 → 默认阈值」 */
function specDefaultsFromDoc() {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "spec.md"), "utf8");
  const section = text.split("### 5.3 预置分类表")[1].split("> 分类默认")[0];
  const out = {};
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").map((s) => s.trim()).filter((s) => s !== "");
    if (cols.length < 3 || cols[0] === "分类" || /^-+$/.test(cols[0])) continue;
    const tokens = [...cols[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // 未匹配（其它类）落 _default；其余取该分类的首个位号前缀作键
    const key = tokens.length > 0 ? tokens[0] : "_default";
    out[key] = Number(cols[2]);
  }
  return out;
}

/** 从 plan §3.3 的 settings schema 里解析出 default_min_quantity */
function planDefaultsFromDoc() {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "plan.md"), "utf8");
  const m = /"default_min_quantity":\s*\{([^}]*)\}/.exec(text);
  const out = {};
  for (const kv of m[1].matchAll(/"([^"]+)"\s*:\s*(\d+)/g)) out[kv[1]] = Number(kv[2]);
  return out;
}

t("spec §5.3 与 plan §3.3 的阈值表逐项一致（两文档不得互相打架）", () => {
  const specDefaults = specDefaultsFromDoc();
  assert.strictEqual(Object.keys(specDefaults).length, 14, "spec §5.3 应解析出 14 类：" + JSON.stringify(specDefaults));
  assert.deepStrictEqual(specDefaults, planDefaultsFromDoc());
});

t("store 首启写入的默认值 == spec §5.3（代码错了这条就红，不靠我手抄）", () => {
  assert.deepStrictEqual(storeModule.DEFAULT_SETTINGS.default_min_quantity, specDefaultsFromDoc());
});

t("首启真正落盘的 settings.json 也等于 spec §5.3（验的是文件，不是内存对象）", () => {
  const s = freshStore();
  s.loadSettings();
  const onDisk = JSON.parse(fs.readFileSync(s.paths().settings, "utf8"));
  assert.deepStrictEqual(onDisk.default_min_quantity, specDefaultsFromDoc());
  assert.strictEqual(onDisk.schema_version, 1);
});

/* ============================================================== 清理与汇总 */

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (ignored) { /* 清理失败不影响结论 */ }

console.log("\n" + "=".repeat(64));
console.log(`T6（store）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
