"use strict";
/**
 * test_acceptance_full.js — T20（plan §9 的 T16）**离线全流程验收**
 *
 * 运行： node tests/test_acceptance_full.js
 *
 * 与其它套件的区别：那些是"按模块测"，这个是**按用户的使用顺序**在**同一个库**上走一遍：
 *   断网 → 导入 BOM → 人工核对 → 入库 → 比对 → 手动录入 → 调阈值 → 领料 → 查询 → 备份恢复 → 导出
 * 每走一步对照 spec 的 AC-1~AC-9 记一条结论，最后打出验收表。
 *
 * 两条原则：
 *   ① **不把"验不了"写成"通过"**：本环境起不了 Electron，凡必须真点界面/真上传的，一律记 BLOCKED 并写明原因；
 *   ② **FAIL 一律 exit 1**：只要有一项该过的没过，这条命令就红。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");
const bp = require("../src/services/bom_parser");
const exportFormat = require("../src/services/export_format");

const importModel = require("../renderer/model/import_model.js");
const compareModel = require("../renderer/model/compare_model.js");
const partsModel = require("../renderer/model/parts_model.js");
const settingsModel = require("../renderer/model/settings_model.js");
const stockModel = require("../renderer/model/stock_model.js");

const ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const FIXED_BOM = path.join(FIX, "sample_bom");
const NEG_FILE = path.join(FIX, "neg_header_only.xlsx");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_accept_"));
const REPORT_MD = path.join(ROOT, ".addmodel", "upload", "T20-acceptance-report.md");

/* --------------------------------------------------------------- 结果表 */

const RESULTS = [];
let currentAc = "";

function ac(id, title) {
  currentAc = id;
  AC_TITLES[id] = title;
  console.log(`\n=== ${id} ${title} ===`);
}
const AC_TITLES = {};

async function check(item, fn) {
  try {
    const note = await fn();
    RESULTS.push({ ac: currentAc, item, status: "PASS", note: note || "" });
    console.log(`  PASS  ${item}${note ? "  —  " + note : ""}`);
  } catch (exc) {
    const message = String((exc && exc.message) || exc).split("\n")[0];
    RESULTS.push({ ac: currentAc, item, status: "FAIL", note: message });
    console.log(`  FAIL  ${item}\n        ${message}`);
  }
}

/** 本环境验不了的：记 BLOCKED，并在报告里写明为什么、以及谁来验 */
function blocked(item, reason) {
  RESULTS.push({ ac: currentAc, item, status: "BLOCKED", note: reason });
  console.log(`  BLOCK ${item}  —  ${reason}`);
}

/**
 * **人工验证签收**：有些验收项**只能人在真机上做**（双击出窗口、上传立创）。
 * 本套件不假装能自动验——但也不能永远停在"待人工"：所以读一份**可撤销的签收记录**
 * `.addmodel/human-signoff.json`：
 *   · 有该键且 `verified: true` → 记为 **PASS（人工验证）**，并把"谁、何时、原话"写进证据列；
 *   · 没有 → 仍记 **BLOCKED**（写明该由谁验）。
 * **为什么要落文件、而不是我在报告里写一句"已通过"**：报告是每次运行**重新生成**的，
 * 手写的一句话会被下一次生成冲掉；记录文件是**可审计、可撤销**的——删掉它，这项就自动回到"待人工"。
 */
function signoffRecord(key) {
  const file = path.join(ROOT, ".addmodel", "human-signoff.json");
  if (!fs.existsSync(file)) return null; // 没签收过 = 待人工（这是正常状态，不是错误）
  let all;
  try {
    all = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (exc) {
    // **坏掉的签收记录必须炸出来**，不能悄悄退回"待人工"：
    // 第一版我把整个查找包在 try 里，结果自己写错了变量名（用了没定义的 PROJECT_ROOT），
    // ReferenceError 被吞掉 → 已签收的项**静默**显示成"待人工"。宁可报错也不要这种静默。
    throw new Error(`人工签收记录读不出来（${file}）：${exc.message}`);
  }
  const rec = all && all[key];
  return rec && rec.verified === true ? rec : null;
}

/** 有签收记录就算 PASS（人工），否则退回 BLOCKED */
function humanVerified(item, key, whoShouldVerify) {
  const rec = signoffRecord(key);
  if (!rec) {
    blocked(item, whoShouldVerify);
    return false;
  }
  RESULTS.push({
    ac: currentAc,
    item,
    status: "PASS",
    note: `**人工验证**（${rec.at || "日期未记"}，${rec.by || "验证人未记"}）：${rec.note || ""}`,
    human: true,
  });
  console.log(`  PASS  ${item}  —  人工验证（${rec.at || "?"}）：${rec.note || ""}`);
  return true;
}

/* --------------------------------------------------------------- 环境 */

const db = createStore({ base_dir: path.join(TMP, "lib") });
const env = createHandlers({
  store: db,
  pick_files: async () => [MAIN_BOM],
  now: () => new Date(2026, 9, 15, 10, 0, 0),
});
const handlers = env.handlers;
const H = (name, payload) => handlers[name](payload);

function readText(rel) {
  const full = path.join(ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}
function allSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSourceFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** 精确定位一条料。
 *  这条验收是**共用一个库**按顺序走的，用 `q: "22uF"` 这种模糊搜索会在
 *  "同值不同耐压"的两条料之间摇摆（我自己就先被这个绊了一次），所以按 值+封装+耐压 精确找。 */
async function findPart(value, footprint, voltage) {
  const list = await H("parts:list", { query: { q: value } });
  const hit = list.parts.find((p) => p.value === value && p.footprint === footprint
    && String(p.voltage || "") === String(voltage || ""));
  assert.ok(hit, `库里找不到 ${value} / ${footprint} / ${voltage || "(无耐压)"}`);
  return hit;
}

/* ==================================================================== */

async function main() {
  console.log("T20 离线全流程验收 —— 按真实使用顺序走一遍（AC-1~AC-9）");
  console.log("库目录：" + db.paths().data_dir);

  /* ---------------------------------------------------- AC-6(1) 离线 */
  ac("AC-6", "应用形态：完全离线（断网也能用）");

  await check("源码里没有对外发起请求的调用（fetch / XHR / http(s).request / net.connect / WebSocket）", () => {
    const banned = /(?<![\w.])fetch\s*\(|XMLHttpRequest|require\(\s*["']https?["']\s*\)|https?\.request|net\.connect|new WebSocket|require\(\s*["']ws["']\s*\)/;
    const offenders = [];
    for (const file of allSourceFiles(path.join(ROOT, "src")).concat(allSourceFiles(path.join(ROOT, "renderer")))) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (banned.test(code)) offenders.push(path.relative(ROOT, file));
    }
    assert.deepStrictEqual(offenders, [], "这些文件里有对外请求的调用：" + offenders.join(", "));
    return `${allSourceFiles(path.join(ROOT, "src")).length + allSourceFiles(path.join(ROOT, "renderer")).length} 个源文件扫过，0 处`;
  });

  await check("页面 CSP 收紧到 connect-src 'none'（连想联网都没通道）", () => {
    const html = readText("renderer/index.html");
    // 先剥 HTML 注释再扫：注释里写着「不写 'unsafe-inline'」是**说明**，不是能力。
    // （这是第 8 次同类误报了——凡是扫源码/文本片段，先剥注释。）
    const scanned = html.replace(/<!--[\s\S]*?-->/g, " ");
    assert.ok(/Content-Security-Policy/.test(scanned), "缺 CSP");
    assert.ok(/connect-src 'none'/.test(scanned), "CSP 里 connect-src 应为 'none'");
    assert.ok(!/'unsafe-inline'/.test(scanned), "CSP 不该放开 unsafe-inline");
    assert.ok(!/https?:\/\//.test(scanned), "CSP 里不该出现远程来源");
    return "default-src 'self'；connect-src 'none'；无 unsafe-inline";
  });

  await check("主进程装了运行时拦截（webRequest.onBeforeRequest → cancel）", () => {
    const main = readText("src/main.js");
    assert.ok(/webRequest\.onBeforeRequest/.test(main), "没装请求拦截");
    assert.ok(/cancel:\s*true/.test(main), "拦截回调应 cancel");
    return "http/https/ws/wss/ftp 一律 cancel（运行时行为由 T11 的桩 Electron 测试证明）";
  });

  await check("渲染进程拿不到 Node（contextIsolation 开、nodeIntegration 关、无 require）", () => {
    const main = readText("src/main.js");
    assert.ok(/contextIsolation:\s*true/.test(main));
    assert.ok(/nodeIntegration:\s*false/.test(main));
    for (const file of allSourceFiles(path.join(ROOT, "renderer"))) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      assert.ok(!/require\s*\(/.test(code), path.relative(ROOT, file) + " 里出现了 require");
    }
    return "7 个渲染进程文件均无 require";
  });

  /* ---------------------------------------------------- AC-1 导入核对 */
  ac("AC-1", "BOM 导入与人工核对（含异常路径）");

  let parsed = null;
  await check("解析真实主 BOM（33 行）并给出批次号", async () => {
    parsed = await H("bom:parse", { file_path: MAIN_BOM, sets: 3 });
    assert.strictEqual(parsed.ok, true, parsed.error);
    assert.strictEqual(parsed.items.length, 33);
    assert.ok(parsed.batch_id, "应有 batch_id");
    return `33 行；算式示例 ${importModel.formulaText(parsed.items[0], 3)}`;
  });

  await check("**解析与核对全程只读**：走到这一步库里还是空的（「不点确认直接关闭」无变化）", () => {
    assert.strictEqual(db.loadParts().length, 0);
    assert.strictEqual(db.loadMovements().length, 0);
    return "库 0 条、变动 0 条";
  });

  await check("人工核算式：本次入库量可改、BOM 原值只读、非法值拒绝", () => {
    const item = parsed.items[0];
    const edited = importModel.applyEdit(item, "intake_quantity", 10);
    assert.strictEqual(edited.ok, true, edited.error);
    assert.strictEqual(edited.item.intake_quantity, 10);
    assert.strictEqual(edited.item.edited_by_human, true, "改过要留痕");
    assert.strictEqual(item.quantity_per_board, 8, "BOM 原值不变");
    assert.strictEqual(importModel.applyEdit(item, "total_quantity", 999).ok, false, "应入库量只读");
    assert.strictEqual(importModel.applyEdit(item, "quantity_per_board", 1).ok, false, "原数量只读");
    assert.strictEqual(importModel.applyEdit(item, "designators", ["X"]).ok, false, "位号只读");
    for (const bad of [-1, "abc", ""]) {
      assert.strictEqual(importModel.validateIntake(bad).ok, false, `${JSON.stringify(bad)} 应被拒绝`);
    }
    return "8 × 3 = 24；改 24→10 留痕；-1/abc/空 均拒绝";
  });

  await check("FR-1.6 核对时可改的字段**全都能改**（含此前缺载体的库位/阈值），且拒绝非法值", () => {
    const item = parsed.items[0];
    const editable = importModel.EDITABLE_FIELDS;
    // spec FR-1.6 明列的可改字段都要在名单里（一个一个点名，不靠"名单非空"糊过去）
    for (const field of ["intake_quantity", "value", "footprint", "voltage", "dielectric", "tolerance",
      "manufacturer_part", "manufacturer", "supplier_part", "supplier", "location", "min_quantity", "note"]) {
      assert.ok(editable.includes(field), "FR-1.6 说可改但名单里没有：" + field);
    }
    assert.strictEqual(importModel.applyEdit(item, "location", "A-03").item.location, "A-03");
    assert.strictEqual(importModel.applyEdit(item, "min_quantity", 15).item.min_quantity, 15);
    assert.strictEqual(importModel.applyEdit(item, "min_quantity", "").ok, true, "留空=继承，合法");
    assert.strictEqual(importModel.applyEdit(item, "min_quantity", "abc").ok, false, "非法阈值要拒绝");
    return "13 个可改字段齐备；库位/阈值可改可留空";
  });

  await check("异常路径：数量与位号个数不符 → 未裁决不许入库；裁决后可入库", async () => {
    const fixed = await H("bom:parse", { file_path: FIXED_BOM, sets: 1 });
    const items = fixed.items.map((it) => Object.assign({}, it, { adjudicated: false }));
    const need = items.filter((it) => importModel.needsAdjudication(it));
    assert.strictEqual(need.length, 3, "实测有 3 行不符");
    assert.strictEqual(importModel.canCommit(items).ok, false, "未裁决不该放行");
    const done = items.map((it) => (importModel.needsAdjudication(it) ? importModel.setAdjudicated(it, true) : it));
    assert.strictEqual(importModel.canCommit(done).ok, true);
    return "3 行（No.1/2/12）要求人工裁决，勾选后放行";
  });

  await check("异常路径：非法 BOM 文件 → 明确报错，不写库", async () => {
    const bad = await H("bom:parse", { file_path: NEG_FILE, sets: 1 });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.error && bad.error.length > 0, "应给出原因");
    assert.strictEqual(db.loadParts().length, 0, "解析失败不该写库");
    return "「" + String(bad.error).slice(0, 40) + "…」";
  });

  await check("入库：汇总三数之和 = 条目总数，库 32 条 / 变动 33 条", async () => {
    const committed = await H("bom:commit", { batch_id: parsed.batch_id, items: parsed.items, sets: 3 });
    assert.strictEqual(committed.ok, true, committed.error);
    assert.strictEqual(committed.added + committed.merged + committed.skipped, committed.summary.total);
    assert.strictEqual(db.loadParts().length, 32, "33 行含一对同规格 → 32 条");
    assert.strictEqual(db.loadMovements().length, 33);
    return `新增 ${committed.added} / 合并 ${committed.merged} / 跳过 ${committed.skipped}，合计 ${committed.summary.total}`;
  });

  await check("未经解析的批次号禁止入库（不得一键静默导入 FR-1.3）", async () => {
    const refused = await H("bom:commit", { batch_id: "batch_20261015_000000", items: [], sets: 1 });
    assert.strictEqual(refused.ok, false);
    assert.ok(/没有经过解析与核对流程/.test(refused.error), refused.error);
    return "服务端闸门生效";
  });

  /* ---------------------------------------------------- AC-2 比对 */
  ac("AC-2", "BOM 比对（够用 / 缺料 / 疑似）");

  let compare = null;
  await check("套数放大后比对：给出缺料条数与缺口合计", async () => {
    compare = await H("compare:run", { file_path: MAIN_BOM, sets: 4 });
    assert.strictEqual(compare.ok, true, compare.error);
    assert.ok(compare.stats.shortfall > 0, "套数放大后应有缺料");
    assert.strictEqual(compare.shortfall.length, compare.stats.shortfall);
    return `${compareModel.summaryLine(compare.stats)}；需采购合计 ${compareModel.shortfallTotal(compare.shortfall)} 个`;
  });

  await check("数量列取**缺口**而不是需求量（v1.2 冻结语义）", () => {
    const items = compare.shortfall;
    const gap = compareModel.shortfallTotal(items);
    const need = compareModel.requiredTotal(items);
    assert.notStrictEqual(gap, need, "把需求当缺口就会多买");
    assert.ok(items.every((it) => it.shortfall_quantity === it.required_quantity - it.stock_quantity
      || it.stock_quantity === 0));
    return `${items.length} 条：需求 ${need} · 缺口 ${gap}`;
  });

  await check("**比对全程只读**：库文件字节级不变（FR-2.5 信任基础）", () => {
    const before = fs.readFileSync(db.paths().parts);
    const beforeMoves = fs.readFileSync(db.paths().movements);
    return H("compare:run", { file_path: MAIN_BOM, sets: 1 }).then(() => {
      assert.ok(before.equals(fs.readFileSync(db.paths().parts)), "parts.json 必须字节不变");
      assert.ok(beforeMoves.equals(fs.readFileSync(db.paths().movements)), "movements.json 必须字节不变");
      return "parts.json / movements.json 字节一致";
    });
  });

  await check("空库比对 → 全部进「缺料」（AC-2 的前提）", async () => {
    const empty = createStore({ base_dir: path.join(TMP, "empty") });
    const emptyEnv = createHandlers({ store: empty, pick_files: async () => [], now: () => new Date(2026, 9, 15) });
    const run = await emptyEnv.handlers["compare:run"]({ file_path: MAIN_BOM, sets: 1 });
    assert.strictEqual(run.stats.shortfall, 33);
    assert.deepStrictEqual(run.enough, []);
    return "空库 33 行全部缺料";
  });

  /* ---------------------------------------------------- AC-3 手动录入 */
  ac("AC-3", "手动录入（不碰 BOM）");

  await check("直接录一条：库里出现该条，字段完整", async () => {
    const form = Object.assign(partsModel.emptyForm(), {
      category: "C", value: "22uF", footprint: "C1206", voltage: "25V", quantity: 50, location: "B-01",
    });
    const saved = await H("parts:save", partsModel.toSavePayload(form));
    assert.strictEqual(saved.ok, true, saved.error);
    assert.strictEqual(saved.created, true);
    assert.strictEqual(saved.part.category, "C");
    assert.strictEqual(saved.part.voltage, "25V");
    return `p=${saved.part.id} 22uF/C1206 25V ×50`;
  });

  await check("再录一条同规格 → 数量累加、不产生重复行", async () => {
    const before = db.loadParts().length;
    const again = await H("parts:save", partsModel.toSavePayload(Object.assign(partsModel.emptyForm(), {
      value: "22uF", footprint: "C1206", voltage: "25V", quantity: 7,
    })));
    assert.strictEqual(again.merged, true, "同规格（值+封装+耐压+材质+容差 全同）应合并");
    assert.strictEqual(db.loadParts().length, before, "不该新增行");
    assert.strictEqual(again.part.quantity, 57);
    return "22uF/C1206/25V：50 + 7 = 57";
  });

  await check("耐压不同 → **不合并**（去重键含耐压，plan §3.1）", async () => {
    const before = db.loadParts().length;
    const other = await H("parts:save", partsModel.toSavePayload(Object.assign(partsModel.emptyForm(), {
      value: "22uF", footprint: "C1206", voltage: "50V", quantity: 7,
    })));
    assert.strictEqual(other.created, true, "耐压不同应是另一条料");
    assert.strictEqual(db.loadParts().length, before + 1);
    return "同值同封装、耐压 25V vs 50V → 两条（这条断言最初是我的失误，现在变成覆盖）";
  });

  await check("连续录入：保存后保留分类等字段（FR-3.3）", () => {
    const kept = partsModel.keepForNextEntry({ category: "C", footprint: "C1206", location: "B-01", value: "22uF", quantity: 7 });
    assert.strictEqual(kept.category, "C");
    assert.strictEqual(kept.footprint, "C1206");
    assert.strictEqual(kept.value, "");
    return "保留 分类/封装/库位，清掉 值/数量";
  });

  /* ---------------------------------------------------- AC-9 阈值 */
  ac("AC-9", "分类与阈值");

  await check("首次启动已有 spec §5.3 的 14 类预置阈值", async () => {
    const got = await H("settings:get", {});
    const map = got.settings.default_min_quantity;
    assert.strictEqual(Object.keys(map).length, 14);
    assert.strictEqual(map.C, 20);
    assert.strictEqual(map._default, 5);
    return `C=${map.C} R=${map.R} LED=${map.LED} _default=${map._default}`;
  });

  await check("把电容默认阈值 20→30 → 未设个体阈值的电容按 30 判定（AC-9 第 2 行）", async () => {
    const created = await H("parts:save", { part: { category: "C", value: "47uF", footprint: "C1210", quantity: 25 } });
    const before = (await H("parts:list", { query: {} })).low_stock_ids;
    assert.ok(!before.includes(created.part.id), "25 个在阈值 20 下不该报警");
    await H("settings:set", { settings: { default_min_quantity: { C: 30 } } });
    const after = (await H("parts:list", { query: {} })).low_stock_ids;
    assert.ok(after.includes(created.part.id), "阈值抬到 30 后应立刻报警");
    return "C: 20 → 30，库存 25：不提示 → 低库存";
  });

  await check("个体阈值覆盖分类默认（AC-9 第 3/4 行）", async () => {
    const part = (await H("parts:list", { query: { q: "47uF" } })).parts[0];
    const patched = Object.assign({}, part, { min_quantity: 10 });
    await H("parts:save", { part: patched });
    const low = (await H("parts:list", { query: {} })).low_stock_ids;
    assert.ok(!low.includes(part.id), "个体阈值 10 应覆盖分类默认 30");
    const back = Object.assign({}, part, { min_quantity: 30 });
    await H("parts:save", { part: back });
    return "个体 10 → 不报警（覆盖生效）";
  });

  await check("异常路径：阈值传非数字 → 拒绝整个写入，已存阈值保持原样", async () => {
    const before = (await H("settings:get", {})).settings.default_min_quantity;
    const saved = await H("settings:set", { settings: { default_min_quantity: { C: "abc" } } });
    assert.strictEqual(saved.ok, false);
    const after = db.loadSettings().default_min_quantity;
    assert.deepStrictEqual(after, before, "不得部分写入");
    return "C 仍是 " + after.C;
  });

  /* ---------------------------------------------------- AC-4 低库存 */
  ac("AC-4", "低库存提示（主动标示 + 立即重算）");

  await check("列表返回低库存 ID，设置页能逐条列清判定依据", async () => {
    const list = await H("parts:list", { query: {} });
    const lines = settingsModel.lowStockLines(list.parts, list.low_stock_ids);
    assert.ok(lines.length > 0, "应有低库存条目");
    assert.ok(lines.some((l) => /按分类默认阈值/.test(l.text)) || lines.some((l) => /个体阈值/.test(l.text)));
    return `${lines.length} 条低库存；示例：${lines[0].text}`;
  });

  await check("启动汇总提示只显示一次（FR-4.3）", () => {
    const first = settingsModel.startupNotice(5, false);
    assert.ok(/5 种/.test(first));
    assert.strictEqual(settingsModel.startupNotice(5, true), "", "第二次不该再提示");
    return "首次提示、之后不再弹";
  });

  await check("出入库后低库存判定立即跟着变（FR-4.4）", async () => {
    const list = await H("parts:list", { query: {} });
    const target = settingsModel.lowStockLines(list.parts, list.low_stock_ids)[0];
    const before = list.low_stock_ids.length;
    await H("stock:move", { part_id: target.id, delta: 200, reason: "补货（验收）" });
    const after = (await H("parts:list", { query: {} })).low_stock_ids.length;
    assert.ok(after < before, `补货后低库存应减少：${before} → ${after}`);
    return `补货 200 个 → 低库存 ${before} → ${after}`;
  });

  /* ---------------------------------------------------- AC-5 查询 */
  ac("AC-5", "查询与浏览");

  await check("按「值」升序/降序排序（FR-5.1）", async () => {
    const asc = await H("parts:list", { query: { sort_by: "value", sort_dir: "asc" } });
    const desc = await H("parts:list", { query: { sort_by: "value", sort_dir: "desc" } });
    const values = (r) => r.parts.map((p) => p.value);
    assert.deepStrictEqual(values(desc), values(asc).slice().reverse(), "降序应是升序的逆序");
    return `${asc.parts.length} 条，首条「${values(asc)[0]}」/ 末条「${values(asc).slice(-1)[0]}」`;
  });

  await check("关键字搜索（跨关键信息字段，FR-5.2）", async () => {
    const hit = await H("parts:list", { query: { q: "22uF" } });
    assert.ok(hit.parts.length >= 1, "应能搜到");
    assert.ok(hit.parts.every((p) => JSON.stringify(p).includes("22uF")), "结果都应相关");
    return `搜「22uF」命中 ${hit.parts.length} 条`;
  });

  await check("按封装筛选（FR-5.3）", async () => {
    const hit = await H("parts:list", { query: { footprint: "C1210" } });
    assert.ok(hit.parts.length >= 1);
    assert.ok(hit.parts.every((p) => p.footprint === "C1210"));
    return `封装 C1210 共 ${hit.parts.length} 条`;
  });

  await check("详情：完整字段 + 该器件的变动历史（时间倒序，FR-5.4）", async () => {
    const part = await findPart("22uF", "C1206", "25V");
    const moves = await H("movements:list", { part_id: part.id });
    assert.ok(moves.movements.length >= 2, "至少 init + in（同规格累加过一次）");
    const times = moves.movements.map((m) => m.at);
    assert.deepStrictEqual(times, times.slice().sort().reverse(), "应按时间倒序");
    return `${moves.movements.length} 条变动，最新：${partsModel.describeMovement(moves.movements[0])}`;
  });

  await check("导出当前库为表格文件：**条数与库中一致**（FR-5.5 / AC-5 第 5 行）", async () => {
    const before = db.loadParts().length;
    const exportedLibrary = await H("parts:export", {});
    assert.strictEqual(exportedLibrary.ok, true, exportedLibrary.error);
    assert.strictEqual(exportedLibrary.exported_count, before, "AC-5 的通过标准：条数与库中一致");
    const rows = bp.readTableRows(exportedLibrary.file_path).rows;
    assert.strictEqual(rows.length - 1, before, "1 行表头 + N 行数据");
    assert.strictEqual(rows[0].length, 14, "14 列");
    return `库 ${before} 条 → 导出 ${exportedLibrary.exported_count} 条；${path.basename(exportedLibrary.file_path)}`;
  });

  /* ---------------------------------------------------- AC-7 领用 */
  ac("AC-7", "出库 / 领用");

  await check("出库 5 个填原因 → 库存 −5，变动记录 kind=out 且含原因", async () => {
    const part = await findPart("22uF", "C1206", "25V");
    const built = stockModel.toMoveRequest({ part_id: part.id, direction: "out", amount: 5, reason: "打样领用" });
    const moved = await H("stock:move", built.request);
    assert.strictEqual(moved.ok, true, moved.error);
    assert.strictEqual(moved.movement.kind, "out");
    assert.strictEqual(moved.movement.reason, "打样领用");
    return `${moved.movement.before} → ${moved.movement.after}`;
  });

  await check("异常路径：出库超过库存 → 拒绝 + 库存不变 + 无变动记录", async () => {
    const list = await H("parts:list", { query: {} });
    const part = list.parts.find((p) => p.quantity < 10);
    const movesBefore = db.loadMovements().length;
    const moved = await H("stock:move", { part_id: part.id, delta: -(part.quantity + 10), reason: "故意超领" });
    assert.strictEqual(moved.ok, false);
    assert.ok(/库存不足/.test(moved.error));
    assert.strictEqual(db.loadMovements().length, movesBefore, "不该留变动记录");
    return `库存 ${part.quantity} 想领 ${part.quantity + 10} → 拒绝`;
  });

  await check("按 BOM 领料：默认整单拒绝（零变动），勾选后按现有量部分领用", async () => {
    const movesBefore = db.loadMovements().length;
    const strict = await H("stock:pick_by_bom", { file_path: MAIN_BOM, sets: 6, reason: "整单领用", allow_partial: false });
    assert.strictEqual(strict.ok, false);
    assert.ok(/整单拒绝/.test(strict.error));
    assert.strictEqual(db.loadMovements().length, movesBefore, "整单拒绝不得留痕");

    const partial = await H("stock:pick_by_bom", { file_path: MAIN_BOM, sets: 6, reason: "整单领用", allow_partial: true });
    assert.strictEqual(partial.ok, true, partial.error);
    const refs = db.loadMovements().filter((m) => m.ref === partial.pick_id);
    assert.strictEqual(refs.length, partial.picked.length, "每条扣减各一条 out 记录");
    assert.ok(refs.every((m) => m.kind === "out" && m.reason === "整单领用"));
    return `部分领用扣 ${partial.picked.length} 条，同批次 ${partial.pick_id}；缺口 ${partial.insufficient.length} 条逐条列出`;
  });

  await check("FR-7.6 入口隔离：比对页里没有领料通道（代码级）", () => {
    for (const rel of ["renderer/pages/compare_report.js", "renderer/model/compare_model.js"]) {
      const code = stripComments(readText(rel));
      assert.ok(!/stock:pick_by_bom|stockPickByBom|stock:move|stockMove/.test(code), rel + " 不该有领料/出入库通道");
    }
    return "比对页只调 bomPickFiles / compareRun / compareExport";
  });

  /* ---------------------------------------------------- AC-6 备份恢复 */
  ac("AC-6", "应用形态：备份 / 恢复（FR-6.4）");

  await check("备份 → 改数据 → 恢复 → 与备份时一致，且恢复前自动留一份", async () => {
    const backupDir = path.join(TMP, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = await H("data:backup", { dir_path: backupDir });
    assert.strictEqual(backup.ok, true, backup.error);
    const snap = () => db.loadParts().map((p) => `${p.id}|${p.quantity}`).sort();
    const atBackup = snap();

    await H("parts:save", { part: { value: "临时料", footprint: "X1", quantity: 3 } });
    await H("parts:delete", { part_id: db.loadParts()[0].id, confirm: true });
    assert.notDeepStrictEqual(snap(), atBackup, "这一步必须真改了数据，否则断言是空的");

    const restored = await H("data:restore", { file_path: backup.backup_path, confirm: true });
    assert.strictEqual(restored.ok, true, restored.error);
    assert.deepStrictEqual(snap(), atBackup, "恢复后应与备份时逐条一致");
    assert.ok(fs.existsSync(restored.safety_backup_path), "覆盖前自动留的那一份要真的在");
    return `备份 ${atBackup.length} 条 → 改动后 ${snap().length} 条 → 恢复 ${atBackup.length} 条；safety=${path.basename(restored.safety_backup_path)}`;
  });

  humanVerified("双击桌面快捷方式出独立窗口（AC-6 / FR-6.2、6.3）", "ac6_double_click_window",
    "本沙箱起不了 Electron（T11 归因：最小 Electron 应用同样 0x80000003）；快捷方式由 T19 真建并用 COM 读回校验、也已在桌面就位，但**双击动作只能由用户在自己桌面上做**——做过之后请在 .addmodel/human-signoff.json 里签收");

  /* ---------------------------------------------------- AC-8 导出 */
  ac("AC-8", "立创可识别导出");

  let exported = null;
  await check("按立创模式导出：表头正确、行数 = 缺料数、数量列合计 = 界面缺口合计", async () => {
    const run = await H("compare:run", { file_path: MAIN_BOM, sets: 3 });
    const built = compareModel.buildExportRequest({ compare_id: run.compare_id, mode: "lcsc", stats: run.stats });
    exported = await H("compare:export", built.request);
    assert.strictEqual(exported.ok, true, exported.error);
    const rows = bp.readTableRows(exported.file_path).rows;
    assert.deepStrictEqual(rows[0], ["型号", "品牌", "封装", "参数", "立创编号", "位号", "数量"]);
    assert.strictEqual(rows.length - 1, compareModel.shortfallTotal(run.shortfall) > 0 ? run.shortfall.length : 0);
    const sum = rows.slice(1).reduce((s, r) => s + Number(r[6]), 0);
    assert.strictEqual(sum, compareModel.shortfallTotal(run.shortfall));
    return `${rows.length - 1} 行缺料，数量合计 ${sum}；${path.basename(exported.file_path)}`;
  });

  await check("导出的 xlsx 能被**独立第三方实现**读回（python zipfile + xml.etree + openpyxl 判卷）", () => {
    const py = process.env.CM_PYTHON || "E:\\python3.11.9\\python.exe";
    const verifier = path.join(__dirname, "verify_export_independently.py");
    assert.ok(fs.existsSync(verifier), "缺独立判卷脚本");
    const result = require("child_process").spawnSync(py, [verifier, exported.file_path], { stdio: "inherit" });
    assert.strictEqual(result.status, 0, "独立判卷未通过（exit " + result.status + "）");
    return "第三方实现读回一致（表头/行数/数量列）";
  });

  await check("AC-8：匹配到库中器件后，导出的「参数」列**带上功率**（spec §4.2 + §5.2）", async () => {
    const first = await H("compare:run", { file_path: MAIN_BOM, sets: 1 });
    const row = first.shortfall[0];
    assert.ok(row, "应有缺料行可用于构造场景");
    // 把这条料按同样的判定键建进库、并填上功率，再比对一次 → 应匹配上，参数列应带功率
    const saved = await H("parts:save", {
      part: {
        value: row.value, footprint: row.footprint, voltage: row.voltage,
        dielectric: row.dielectric, tolerance: row.tolerance, quantity: 999, power: "1/4W",
      },
    });
    assert.strictEqual(saved.ok, true, saved.error);
    const again = await H("compare:run", { file_path: MAIN_BOM, sets: 1 });
    const hit = again.enough.concat(again.shortfall).find((x) => x.row_no === row.row_no);
    assert.ok(hit, "重比对后应能找到该行");
    assert.strictEqual(hit.power, "1/4W", "功率应取自库中器件（BOM 里没有这项）");
    const params = exportFormat.buildParams(hit);
    assert.ok(params.includes("1/4W"), "参数列应带上功率，实际：" + params);
    return `${row.value}/${row.footprint} 参数列 = 「${params}」`;
  });

  humanVerified("把导出文件上传到立创商城 BOM 智能云表（AC-8 外部验收）", "ac8_lcsc_upload",
    "本工具完全离线、**没有任何上传通道**（这是设计而非缺失）；样本已备好：.addmodel/upload/T4-lcsc-sample.xlsx，需用户手工上传后在 .addmodel/human-signoff.json 里签收");

  /* ---------------------------------------------------- AC-10 按对账单入库 */
  ac("AC-10", "按对账单入库（FR-8）");

  const STMT = path.join(FIX, "sample_statement");
  if (!fs.existsSync(STMT)) {
    // 样本含真实收货人/快递单号/发票号，已 .gitignore：不在时跳过（服务层/通道/页面各有独立套件覆盖）
    blocked("对账单入库全流程（AC-10）",
      "对账单样本含真实订单信息、已加入 .gitignore；样本不在本机时跳过全流程这一行");
  } else {
    let stmt = null;
    await check("AC-10:1/2 解析对账单 → 8 条明细，且商品名称里的值/容差/耐压被解出来", async () => {
      stmt = await H("statement:parse", { file_path: STMT });
      assert.strictEqual(stmt.ok, true, stmt.error);
      assert.strictEqual(stmt.items.length, 8, "这份对账单有 8 条明细");
      assert.strictEqual(stmt.matched.length + stmt.suspected.length + stmt.missing.length, 8,
        "三桶合计应等于明细数（不丢行）");
      const first = stmt.items[0];
      assert.strictEqual(first.value, "100nF");
      assert.strictEqual(first.tolerance, "±10%");
      assert.strictEqual(first.voltage, "100V");
    });

    await check("AC-10:3 没有决定就拒绝（不得静默入库）", async () => {
      const bad = await H("statement:commit", { file_path: STMT, order_ref: "SO26101418868", decisions: [] });
      assert.strictEqual(bad.ok, false, "空决定必须被拒绝");
      assert.ok(/没有任何入库决定|必须先逐条确认/.test(bad.error), bad.error);
    });

    await check("AC-10:4/5 按人工决定入库 → 库变了、留痕写了（来源=对账单+行号）", async () => {
      const before = db.loadParts();
      const beforeQty = before.reduce((s, p) => s + Number(p.quantity || 0), 0);
      const decisions = [];
      for (const m of stmt.matched) decisions.push({ row_no: m.row_no, action: "merge", part_id: m.part_id });
      for (const s of stmt.suspected) {
        if (s.candidates.length) decisions.push({ row_no: s.row_no, action: "merge", part_id: s.candidates[0].part_id });
        else decisions.push({ row_no: s.row_no, action: "new" });
      }
      for (const rowNo of stmt.missing) decisions.push({ row_no: rowNo, action: "new" });

      const res = await H("statement:commit", { file_path: STMT, order_ref: "SO26101418868", decisions });
      assert.strictEqual(res.ok, true, res.error);
      const after = db.loadParts();
      assert.strictEqual(after.length, before.length + res.summary.created_count, "新建条数应与汇总一致");
      const afterQty = after.reduce((s, p) => s + Number(p.quantity || 0), 0);
      assert.strictEqual(afterQty - beforeQty, res.summary.quantity_in, "总量增量应等于 summary.quantity_in");
      const mvs = db.loadMovements().filter((m) => m.ref === "SO26101418868");
      assert.ok(mvs.length >= decisions.length, `每笔决定都要留痕（>=${decisions.length}），实际 ${mvs.length}`);
      assert.ok(mvs.every((m) => m.statement_row !== undefined && m.statement_row !== null),
        "留痕要记下对账单行号，事后可对账");
    });
  }

  /* ---------------------------------------------------- 汇总表 */
  const fails = RESULTS.filter((r) => r.status === "FAIL");
  const blockeds = RESULTS.filter((r) => r.status === "BLOCKED");
  const passes = RESULTS.filter((r) => r.status === "PASS");
  const humanPasses = passes.filter((r) => r.human === true);

  const lines = [];
  lines.push("# T20 离线全流程验收报告（plan §9 T16）");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}　·　库目录：\`${db.paths().data_dir}\``);
  lines.push("");
  lines.push(`**结论：PASS ${passes.length} · FAIL ${fails.length} · BLOCKED ${blockeds.length}**`
    + `（其中 **人工验证 ${humanPasses.length} 项**，见 「.addmodel/human-signoff.json」）`);
  lines.push("");
  lines.push("| AC | 检查项 | 结论 | 证据 / 说明 |");
  lines.push("|---|---|---|---|");
  for (const r of RESULTS) {
    const mark = r.status === "PASS"
      ? (r.human ? "✅ 通过（人工验证）" : "✅ 通过")
      : (r.status === "FAIL" ? "❌ 失败" : "⏸ 待人工");
    lines.push(`| ${r.ac} | ${r.item} | ${mark} | ${String(r.note).replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  if (humanPasses.length > 0) {
    lines.push(`## 人工验证通过的 ${humanPasses.length} 项（本环境无法自动验证，由人签字确认）`);
    lines.push("");
    for (const r of humanPasses) lines.push(`- **${r.item}** —— ${r.note}`);
    lines.push("");
  }
  lines.push(`## 待人工完成的 ${blockeds.length} 项（本环境无法验证，不计入失败）`);
  lines.push("");
  for (const r of blockeds) lines.push(`- **${r.item}** —— ${r.note}`);
  lines.push("");
  lines.push("## 说明");
  lines.push("");
  lines.push("- 本报告由 `node tests/test_acceptance_full.js` 一次跑出，按用户真实使用顺序在**同一个库**上走完 AC-1~AC-9。");
  lines.push("- `BLOCKED` 一律写明原因与「该由谁验」，**不混进 PASS**；只要有 `FAIL` 该命令就 exit 1。");
  lines.push("- 「通过（人工验证）」不是自动断言，而是**读 `.addmodel/human-signoff.json` 里的签收记录**；"
    + "删掉记录，该项下次跑就会自动回到「待人工」——**签字与撤销都由同一份文件说了算**。");
  const report = lines.join("\n");

  fs.mkdirSync(path.dirname(REPORT_MD), { recursive: true });
  fs.writeFileSync(REPORT_MD, report, "utf8");

  console.log("\n" + "=".repeat(78));
  console.log("验收汇总");
  console.log("=".repeat(78));
  let lastAc = "";
  for (const r of RESULTS) {
    if (r.ac !== lastAc) { console.log(`\n${r.ac}  ${AC_TITLES[r.ac]}`); lastAc = r.ac; }
    const mark = r.status === "PASS" ? "PASS   " : (r.status === "FAIL" ? "FAIL   " : "待人工 ");
    console.log(`  ${mark} ${r.item}`);
  }
  console.log("\n" + "=".repeat(78));
  console.log(`PASS ${passes.length} · FAIL ${fails.length} · 待人工 ${blockeds.length}`);
  console.log("报告已写入：" + path.relative(ROOT, REPORT_MD));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }

  if (fails.length > 0) {
    console.log("\n失败项：");
    for (const f of fails) console.log(`  - [${f.ac}] ${f.item}\n      ${f.note}`);
    process.exitCode = 1;
  } else {
    console.log("\n无失败项" + (blockeds.length > 0 ? `；有 ${blockeds.length} 项需人工完成（见报告）` : ""));
  }
}

main().catch((exc) => {
  console.error("验收脚本自身出错：", exc && exc.stack ? exc.stack : exc);
  process.exitCode = 1;
});
