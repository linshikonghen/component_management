"use strict";
/**
 * test_renderer_pages.js — T30：**页面级（DOM）测试**
 *
 * 运行： node tests/test_renderer_pages.js
 *
 * 此前 23 个套件对 `renderer/pages/*.js` 只有**静态检查**（"它引用了正确的通道"），
 * 页面的装配代码**一次都没被执行过**。这个套件把它跑起来：
 *
 *   用 `node:vm` + 手写假 DOM（tests/fake_dom.js）加载页面脚本，
 *   `window.api` 接到**真实 IPC handlers**（临时库）——
 *   于是链路是「页面 → window.api → handlers → services → store」**全真**，没有第二套 mock 数据。
 *
 * ⚠️ 划界：这证明的是"**页面装配逻辑真跑过**"，
 * 仍**不等于**"在真窗口里点过"（Electron 在本环境起不来，已归因）。
 * 但"核对表渲染出 33 行 / 未裁决时入库按钮禁用 / 点入库后库里真的多条目"这些事，
 * 现在有断言盯着了，而不是靠静态检查推断。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");

const { createDocument } = require("./fake_dom");
const { CHANNELS, channelToMethod } = require("../src/ipc/channels");
const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");

const ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const FIXED_BOM = path.join(FIX, "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_pages_"));

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

/** 让页面里的 Promise / setTimeout(…,0) 跑完 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* --------------------------------------------------------------- 环境 */

let envNo = 0;
function freshEnv(bomPath = MAIN_BOM) {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({
    store: db,
    pick_files: async () => [bomPath],
    now: () => new Date(2026, 9, 15, 10, 0, 0),
  });
  return { db, handlers: env.handlers, base };
}

/** window.api：**由通道清单生成**，直接转发到真实 handlers（页面看到的和真应用一致） */
function makeApi(handlers) {
  const api = {};
  for (const channel of CHANNELS) {
    api[channelToMethod(channel)] = async (payload) => handlers[channel](payload);
  }
  return api;
}

/**
 * 建一个页面沙箱：假 DOM + 六个 model + 指定 api。**唯一实现**——
 * 正常用例传真 api，韧性用例传坏后端桩，两边共用同一份挂载逻辑
 * （§6 我一开始另写了一份 `sandboxWith`，与这里重复，已按 AGENTS.md 反重复规则合并）。
 * @param {object} doc 假 document
 * @param {object} api window.api（真 api 或桩）
 * @param {{confirm?: Function, refreshInventory?: Function}} [opts]
 */
function makeSandbox(doc, api, opts = {}) {
  const sandbox = {
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    api,
    confirm: opts.confirm || (() => true),
    refreshInventory: opts.refreshInventory || (() => {}),
    ImportModel: require("../renderer/model/import_model.js"),
    CompareModel: require("../renderer/model/compare_model.js"),
    PartsModel: require("../renderer/model/parts_model.js"),
    StockModel: require("../renderer/model/stock_model.js"),
    SettingsModel: require("../renderer/model/settings_model.js"),
    BackupModel: require("../renderer/model/backup_model.js"),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

/** 建一个"接了真后端"的页面沙箱 */
function createPageSandbox(handlers, opts = {}) {
  const doc = createDocument();
  return { sandbox: makeSandbox(doc, makeApi(handlers), opts), doc };
}

/** 把 renderer 下的脚本放进沙箱执行（和浏览器里 <script> 同一种跑法） */
function runScript(sandbox, relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  vm.runInContext(code, sandbox, { filename: relPath });
}

/** 按 index.html 里真实存在的 id / class 搭一个"壳"（app.js 需要它才能跑） */
function buildShellFromIndexHtml(doc) {
  const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const tag = m[1];
    const attrs = m[2];
    const id = /id="([^"]+)"/.exec(attrs);
    const cls = /class="([^"]+)"/.exec(attrs);
    const el = doc.createElement(tag);
    if (cls) el.className = cls[1];
    if (id) el.id = id[1];
    // 只搭有 id / class 的节点，够 getElementById 与 .nav 查询用（不做真实嵌套）
    if (id || cls) doc.body.appendChild(el);
  }
  return html;
}

/* ============================================================ 导入向导 */

section("§1 导入向导（pages/import_wizard.js）：核对表真的渲染出来");

let wizard = null;   // { sandbox, doc, db, handlers }

t("挂载第 1 步：出现选文件 / 套数 / 开始解析", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/import_wizard.js");
  assert.ok(sandbox.ImportPage, "import_wizard.js 应挂上 ImportPage");

  const host = doc.createElement("div");
  host.id = "import-wizard";
  doc.body.appendChild(host);
  sandbox.ImportPage.mount(host, {});
  await tick();

  assert.ok(doc.getElementById("import-file"), "应有文件框");
  assert.ok(doc.getElementById("import-sets"), "应有套数框");
  assert.ok(doc.getElementById("import-start"), "应有开始解析按钮");
  assert.strictEqual(doc.getElementById("import-sets").value, "1", "默认套数 1");
  wizard = { sandbox, doc, ...env };
});

t("点「选择文件」→ 文件框填上路径（走的是真 bom:pickFiles）", async () => {
  wizard.doc.getElementById("import-pick").click();
  await tick();
  assert.strictEqual(wizard.doc.getElementById("import-file").value, MAIN_BOM);
});

t("填套数 3 + 点解析 → 核对表渲染 **33 行**，算式列显示 `8 × 3 = 24`", async () => {
  wizard.doc.getElementById("import-sets").setValue("3");
  wizard.doc.getElementById("import-start").click();
  await tick();
  await tick();

  const rows = wizard.doc.querySelectorAll("#review-body tr");
  assert.strictEqual(rows.length, 33, `核对表应有 33 行，实际 ${rows.length}`);
  const formulaCells = wizard.doc.querySelectorAll("#review-body td.formula");
  assert.strictEqual(formulaCells[0].textContent, "8 × 3 = 24", "首行算式应为 8 × 3 = 24");
  // 可改列渲染成输入框（本次入库量那一列）
  const intake = wizard.doc.querySelectorAll("#review-body input.intake");
  assert.strictEqual(intake.length, 33, "每行都应有一个「本次入库量」输入框");
  assert.strictEqual(intake[0].value, "24", "默认值应等于应入库量");
});

t("**可改的格子必须看得出来能改**（用户实际反馈：以为「本次入库量」不能改）", () => {
  // ① 表头给可改列打了 editable 类（CSS 靠它加 ✎ 标记），只读列没有
  const ths = wizard.doc.querySelectorAll("#review-body thead th") || [];
  const editableHeads = [];
  const headRow = wizard.doc.querySelectorAll("thead th");
  for (const th of headRow) if (th.className && /editable/.test(th.className)) editableHeads.push(th.textContent);
  assert.ok(editableHeads.some((h) => h.includes("本次入库量")),
    "「本次入库量」表头应带 editable 类（否则看不出能改）：" + JSON.stringify(editableHeads));
  assert.ok(!editableHeads.some((h) => h.includes("应入库量")),
    "「应入库量」是只读事实，不该带 editable 类");
  assert.ok(!editableHeads.includes("裁决"), "裁决列不是文本框，不该带 editable 类");

  // ② 提示语必须说清「哪些能改、哪些只读」，且不得出现没被渲染的 markdown 星号
  const hint = wizard.doc.querySelector(".hint").textContent;
  assert.ok(hint.includes("✎") && hint.includes("可以直接改"), "提示应告诉用户带 ✎ 的列能改：" + hint);
  assert.ok(hint.includes("只读"), "提示应说明哪些是只读：" + hint);
  assert.ok(!hint.includes("**"), "提示里不能出现 markdown 星号（会当字面量显示出来）：" + hint);

  // ③ 可改格的样式必须**常显**（不能只在 hover 时才显出边框）——
  //    这是那次缺陷的根因：border: transparent + background: transparent。
  const css = fs.readFileSync(path.join(ROOT, "renderer", "style.css"), "utf8");
  const rule = /\.review-table td input\s*\{[^}]*\}/.exec(css);
  assert.ok(rule, "style.css 里应有 .review-table td input 规则");
  assert.ok(!/border:\s*1px solid transparent/.test(rule[0]),
    "可改格不能是透明边框（那样只有悬停才看得出来能改）：" + rule[0].replace(/\s+/g, " "));
  assert.ok(!/background:\s*transparent/.test(rule[0]),
    "可改格不能是透明底（与只读格区分不开）：" + rule[0].replace(/\s+/g, " "));
  assert.ok(/border:\s*1px solid var\(--line\)/.test(rule[0]), "可改格应有常显边框：" + rule[0].replace(/\s+/g, " "));
});

t("门禁显示「待入库 33」且入库按钮**可用**（主样本没有数量与位号不符的行）", async () => {
  const gate = wizard.doc.getElementById("import-gate").textContent;
  assert.ok(gate.includes("待入库 33"), "门禁文案应含待入库 33，实际：" + gate);
  assert.strictEqual(wizard.doc.getElementById("import-commit").disabled, false, "不该禁用");
});

t("勾一行「跳过」→ 门禁立刻变「待入库 32 · 跳过 1」（不重画表格）", async () => {
  const skips = wizard.doc.querySelectorAll("#review-body label.skip-toggle input");
  assert.strictEqual(skips.length, 33, "每行都应有跳过勾选框");
  skips[0].setChecked(true);
  await tick();
  const gate = wizard.doc.getElementById("import-gate").textContent;
  assert.ok(gate.includes("待入库 32"), "待入库应减 1，实际：" + gate);
  assert.ok(gate.includes("跳过 1"), "跳过应为 1，实际：" + gate);
  // 再取消，恢复 33
  skips[0].setChecked(false);
  await tick();
  assert.ok(wizard.doc.getElementById("import-gate").textContent.includes("待入库 33"), "取消后应恢复");
});

t("改「本次入库量」→ 输入框接受，且改非法值会被拒绝并回退显示", async () => {
  const intake = wizard.doc.querySelectorAll("#review-body input.intake")[0];
  intake.setValue("10");
  await tick();
  // 非法值：应弹错误横幅并把框里的值回退成 state 里的（10）
  intake.setValue("-5");
  await tick();
  const err = wizard.doc.getElementById("import-error");
  assert.strictEqual(err.hidden, false, "非法值应显示错误横幅");
  assert.ok(err.textContent.includes("非负整数"), "错误文案应说明必须是非负整数，实际：" + err.textContent);
  assert.strictEqual(intake.value, "10", "被拒绝后输入框应回退到上一个合法值");
});

/* ============================================================ FR-1.5 */

section("§2 FR-1.5（pages/import_wizard.js）：数量与位号不符 → 入库按钮必须禁用");

let fixed = null;

t("用修正版 BOM（3 行不符）解析 → 入库按钮**禁用**，门禁列出 blocker", async () => {
  const env = freshEnv(FIXED_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/import_wizard.js");
  const host = doc.createElement("div");
  host.id = "import-wizard2";
  doc.body.appendChild(host);
  sandbox.ImportPage.mount(host, {});
  await tick();
  doc.getElementById("import-pick").click();
  await tick();
  doc.getElementById("import-start").click();
  await tick();
  await tick();

  assert.strictEqual(doc.getElementById("import-commit").disabled, true, "未裁决前必须禁用");
  const gate = doc.getElementById("import-gate").textContent;
  assert.ok(/数量与位号个数不符/.test(gate), "应说明原因，实际：" + gate);
  assert.ok(/3 条/.test(gate), "应给出条数，实际：" + gate);
  const marked = doc.querySelectorAll("#review-body tr.mismatch");
  assert.strictEqual(marked.length, 3, "应标红 3 行");
  fixed = { sandbox, doc, ...env };
});

t("逐行勾「已核实」→ 入库按钮**启用**", async () => {
  const boxes = fixed.doc.querySelectorAll("#review-body label.adjudicate input");
  assert.strictEqual(boxes.length, 3, "应只有 3 个已核实勾选框（其余行无需裁决）");
  for (const box of boxes) box.setChecked(true);
  await tick();
  assert.strictEqual(fixed.doc.getElementById("import-commit").disabled, false, "裁决后应可入库");
});

t("点「确认入库」→ 库真的变了，且页面进入第 3 步显示汇总", async () => {
  fixed.doc.getElementById("import-commit").click();
  await tick();
  await tick();

  assert.strictEqual(fixed.db.loadParts().length, 34, "修正版 37 行 → 34 条（3 对同规格合并）");
  assert.strictEqual(fixed.db.loadMovements().length, 37, "37 行各留一条变动记录");
  const body = fixed.doc.getElementById("import-body").textContent;
  assert.ok(/新增 34/.test(body), "第 3 步应显示新增 34，实际：" + body.slice(0, 120));
  assert.ok(/合并（同规格累加）3 条/.test(body), "第 3 步应显示合并 3 条，实际：" + body.slice(0, 160));
  assert.ok(/跳过 0 条/.test(body), "第 3 步应显示跳过 0 条");
  assert.ok(/三数之和 = 37/.test(body), "应说明三数之和等于条目总数");
});

/* ============================================================ 手动录入 */

section("§3 手动录入页（pages/parts_editor.js）：填表保存 → 库里出现");

let editor = null;

t("填必填项 → 保存 → 库里出现该条，详情区显示字段", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor";
  doc.body.appendChild(host);
  sandbox.PartsPage.mount(host, {});
  await tick();

  doc.getElementById("pf-value").setValue("100nF");
  doc.getElementById("pf-footprint").setValue("C0603");
  doc.getElementById("pf-category").setValue("C");
  doc.getElementById("pf-quantity").setValue("120");
  doc.getElementById("pf-location").setValue("B-07");
  await tick();
  doc.getElementById("parts-save").click();
  await tick();
  await tick();

  const parts = env.db.loadParts();
  assert.strictEqual(parts.length, 1, "库里应有 1 条");
  assert.strictEqual(parts[0].value, "100nF");
  assert.strictEqual(parts[0].footprint, "C0603");
  assert.strictEqual(parts[0].category, "C");
  assert.strictEqual(parts[0].quantity, 120);
  assert.strictEqual(parts[0].location, "B-07");
  const body = doc.getElementById("parts-body-host").textContent;
  assert.ok(/已新增/.test(body), "应显示保存结果，实际：" + body.slice(0, 120));
  editor = { sandbox, doc, ...env };
});

t("保存后**保留分类/封装/库位**（FR-3.3 连续录入），清掉值", async () => {
  assert.strictEqual(editor.doc.getElementById("pf-category").value, "C", "分类应保留");
  assert.strictEqual(editor.doc.getElementById("pf-footprint").value, "C0603", "封装应保留");
  assert.strictEqual(editor.doc.getElementById("pf-location").value, "B-07", "库位应保留");
  assert.strictEqual(editor.doc.getElementById("pf-value").value, "", "值应清空");
});

t("删除需确认：先拒绝时不删，确认后才删", async () => {
  let answer = false;
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers, { confirm: () => answer });
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor2";
  doc.body.appendChild(host);

  // 先建一条，再以"编辑"方式载入（这样才有删除按钮）
  const saved = await env.handlers["parts:save"]({ part: { value: "1k", footprint: "R0603", quantity: 5 } });
  assert.strictEqual(saved.ok, true, saved.error);
  sandbox.PartsPage.mount(host, { part: saved.part });
  await tick();
  await tick();

  assert.ok(doc.getElementById("parts-delete"), "编辑模式下应有删除按钮");
  doc.getElementById("parts-delete").click();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 1, "未确认时不该删");

  answer = true;
  doc.getElementById("parts-delete").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 0, "确认后应删掉");
});

/* ============================================================ 库存页 */

section("§4 库存页（app.js）：1000 条渲染行数正确");

t("跑 app.js → 渲染 1000 行，统计卡显示 1000", async () => {
  const env = freshEnv(MAIN_BOM);
  // 直接写库（不经页面），造 1000 条
  const parts = [];
  for (let i = 1; i <= 1000; i += 1) {
    parts.push({
      id: `p_${String(i).padStart(4, "0")}`, category: "C", value: `${i}nF`, footprint: "C0603",
      voltage: "50V", dielectric: "", tolerance: "±10%", quantity: i % 50, min_quantity: null,
      location: `A-${i % 40}`, mpn_list: [], created_at: "2026-10-15T10:00:00+08:00", updated_at: "2026-10-15T10:00:00+08:00",
    });
  }
  env.db.saveParts(parts);

  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);          // app.js 需要 index.html 里的那些 id
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  const rows = doc.querySelectorAll("#parts-body tr");
  assert.strictEqual(rows.length, 1000, `应渲染 1000 行，实际 ${rows.length}`);
  assert.strictEqual(doc.getElementById("stat-parts").textContent, "1000");
  assert.ok(/就绪/.test(doc.getElementById("status").textContent), "状态栏应显示就绪");
  // 低库存标红（阈值默认 C=20，数量 i%50 → 有一批 < 20）
  const lowRows = doc.querySelectorAll("#parts-body tr.low");
  assert.ok(lowRows.length > 0, "应有标红的低库存行");
  console.log(`        （1000 行渲染完成；标红 ${lowRows.length} 行；统计卡 ${doc.getElementById("stat-parts").textContent}）`);
});

t("库存页「导出库表」按钮：点一下真的导出（走真 parts:export）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "22uF", footprint: "C1206", quantity: 3 } });
  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();

  doc.getElementById("export-library").click();
  await tick();
  await tick();
  const status = doc.getElementById("status").textContent;
  assert.ok(/已导出 1 条/.test(status), "状态栏应显示导出结果，实际：" + status);
  assert.ok(/\.xlsx/.test(status), "应显示文件路径，实际：" + status);
});

/* ============================================================ 其余四页 */

section("§5 其余四个页面也要真跑（否则「页面级测试」名不副实）");

t("比对页（pages/compare_report.js）：选文件→比对→三组计数与导出区渲染；且**不改库**", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "10uF", footprint: "C1210", voltage: "50V", quantity: 999 } });
  const before = fs.readFileSync(env.db.paths().parts);

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/compare_report.js");
  const host = doc.createElement("div");
  host.id = "compare-report";
  doc.body.appendChild(host);
  sandbox.ComparePage.mount(host);
  await tick();

  doc.getElementById("compare-file") && doc.querySelectorAll("#compare-body button");
  // 选文件（第 1 个按钮就是"选择文件…"）
  const pickButton = doc.querySelectorAll("#compare-body button")[0];
  pickButton.click();
  await tick();
  const start = doc.getElementById("compare-start");
  assert.ok(start, "应有「开始比对」按钮");
  start.click();
  await tick();
  await tick();

  // 汇总行 + 三组 tab
  const body = doc.getElementById("compare-body").textContent;
  assert.ok(/共 33 条/.test(body), "应显示汇总行，实际：" + body.slice(0, 140));
  const tabs = doc.querySelectorAll(".tabs button");
  assert.ok(tabs.length === 3, "应有三个分组按钮，实际 " + tabs.length);
  assert.ok(/缺料/.test(tabs.map((b) => b.textContent).join(" ")), "分组里应有缺料");
  // 导出区
  assert.ok(doc.getElementById("compare-export"), "应有导出按钮");
  assert.ok(doc.getElementById("compare-mode"), "应有模式选择");
  // 只读
  assert.ok(before.equals(fs.readFileSync(env.db.paths().parts)), "比对页不得改动库文件");
  console.log(`        （三组 tab：${tabs.map((b) => b.textContent).join(" / ")}）`);
});

t("领料页（pages/stock_page.js）：手选出库 → 库真的减，且最近变动里出现该条", async () => {
  const env = freshEnv(MAIN_BOM);
  const saved = await env.handlers["parts:save"]({ part: { value: "22uF", footprint: "C1206", quantity: 20 } });
  assert.strictEqual(saved.ok, true, saved.error);

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  const select = doc.getElementById("stock-part");
  assert.ok(select, "应有器件选择框");
  const option = select.children.find((o) => o.value === saved.part.id);
  assert.ok(option, "选择框里应有刚建的器件");
  select.choose(saved.part.id);
  doc.getElementById("stock-direction").choose("out");
  doc.getElementById("stock-amount").setValue("5");
  doc.getElementById("stock-reason").setValue("打样领用");
  await tick();
  doc.getElementById("stock-move-run").click();
  await tick();
  await tick();

  assert.strictEqual(env.db.loadParts()[0].quantity, 15, "出库 5 后应剩 15");
  const moves = env.db.loadMovements();
  assert.strictEqual(moves.length, 2, "init + out 各一条");
  assert.strictEqual(moves[moves.length - 1].reason, "打样领用");
  const body = doc.getElementById("stock-panel").textContent;
  assert.ok(/打样领用/.test(body), "最近变动记录里应出现原因，实际：" + body.slice(0, 200));
});

t("设置页（pages/settings_page.js）：渲染 14 个阈值框 → 改一个保存 → 设置真的变了", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/settings_page.js");
  const host = doc.createElement("div");
  host.id = "settings-panel";
  doc.body.appendChild(host);
  sandbox.SettingsPage.mount(host);
  await tick();
  await tick();

  const inputs = doc.querySelectorAll("input[type='number']").filter((el) => /^th-/.test(el.id));
  assert.strictEqual(inputs.length, 14, `应渲染 14 个分类阈值框，实际 ${inputs.length}`);
  const cInput = doc.getElementById("th-C");
  assert.strictEqual(cInput.value, "20", "电容默认阈值应是 20");
  cInput.setValue("30");
  await tick();
  const save = doc.getElementById("settings-save-thresholds");
  assert.strictEqual(save.disabled, false, "有改动后保存按钮应可用");
  save.click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadSettings().default_min_quantity.C, 30, "设置应真的被改");
  assert.ok(/已保存/.test(doc.getElementById("settings-notice").textContent), "应显示保存结果");
});

t("备份页（pages/backup_page.js）：填目录→备份→显示路径；恢复需勾确认", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "1k", footprint: "R0603", quantity: 3 } });
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/backup_page.js");
  const host = doc.createElement("div");
  host.id = "backup-panel";
  doc.body.appendChild(host);
  sandbox.BackupPage.mount(host);
  await tick();

  const dir = path.join(TMP, "backup-out");
  fs.mkdirSync(dir, { recursive: true });
  doc.getElementById("backup-dir").setValue(dir);
  await tick();
  doc.getElementById("backup-run").click();
  await tick();
  await tick();
  const body = doc.getElementById("backup-panel").textContent;
  assert.ok(/已备份到/.test(body), "应显示备份结果，实际：" + body.slice(0, 160));

  // 恢复：未勾确认时按钮禁用；勾了才可用
  doc.getElementById("restore-dir").setValue(path.join(dir, fs.readdirSync(dir)[0]));
  await tick();
  const restoreButton = doc.getElementById("restore-run");
  assert.strictEqual(restoreButton.disabled, true, "未勾确认前不得允许恢复");
  doc.getElementById("restore-confirm").setChecked(true);
  await tick();
  assert.strictEqual(restoreButton.disabled, false, "勾了确认后应可恢复");
  restoreButton.click();
  await tick();
  await tick();
  assert.ok(/已从/.test(doc.getElementById("backup-panel").textContent), "应显示恢复结果");
});

/* ============================ 首渲染韧性（同类隐患系统排查） */

section("§6 首渲染韧性：数据没回来 / 后端报错时，每个页面都不能崩");

/**
 * 上一轮抓到 `settings_page.js` 在「数据还没回来」时首渲染抛 TypeError——
 * 那类 bug 的共性是：`mount()` 先渲染一次、再等数据回来重画，而首渲染时状态还是 null。
 * 只在修复处加兜底是不够的（**其他页面可能就是同一个毛病**），所以这里把每个页面都过一遍：
 *
 *   ① `neverApi`：所有 IPC **永不返回**（模拟"数据还没回来"）→ 挂载不得抛异常，且要有内容渲染出来
 *   ② `failingApi`：所有 IPC **都返回 {ok:false}**（模拟后端不可用）→ 挂载不得抛异常，
 *      且要把错误**显示出来**（不能白屏——用户至少要知道发生了什么）
 */

/** 所有通道都永不 resolve 的 api */
function neverApi() {
  const api = {};
  for (const channel of CHANNELS) api[channelToMethod(channel)] = () => new Promise(() => {});
  return api;
}

/** 所有通道都返回失败的 api（错误文案带标记，便于断言它确实被显示出来）；同时记录调用次数 */
const FAIL_MARK = "【测试】后端不可用";
function failingApi() {
  const api = { calls: [] };
  for (const channel of CHANNELS) {
    const method = channelToMethod(channel);
    api[method] = async () => { api.calls.push(method); return { ok: false, error: FAIL_MARK }; };
  }
  return api;
}

/** 造一个页面沙箱，但 api 换成指定的桩（挂载逻辑与正常用例共用 makeSandbox） */
function sandboxWith(doc, api) {
  return makeSandbox(doc, api);
}

/** 页面清单：脚本 → 挂载方式 → 用哪个全局对象 */
const PAGE_SPECS = [
  { name: "导入向导", script: "renderer/pages/import_wizard.js", global: "ImportPage", id: "p-wizard" },
  { name: "比对页", script: "renderer/pages/compare_report.js", global: "ComparePage", id: "p-compare" },
  { name: "手动录入", script: "renderer/pages/parts_editor.js", global: "PartsPage", id: "p-parts" },
  { name: "领料页", script: "renderer/pages/stock_page.js", global: "StockPage", id: "p-stock" },
  { name: "设置页", script: "renderer/pages/settings_page.js", global: "SettingsPage", id: "p-settings" },
  { name: "备份页", script: "renderer/pages/backup_page.js", global: "BackupPage", id: "p-backup" },
];

/** 挂载一个页面，吞掉返回的 Promise；抛出的异常原样传给调用方 */
async function mountPage(sandbox, doc, spec) {
  runScript(sandbox, spec.script);
  const host = doc.createElement("div");
  host.id = spec.id;
  doc.body.appendChild(host);
  const page = sandbox[spec.global];
  assert.ok(page, `${spec.name}：脚本应挂上 ${spec.global}`);
  const ret = page.mount(host);
  if (ret && typeof ret.then === "function") await ret;
  await tick();
  await tick();
  return host;
}

t("① 数据没回来（所有 IPC 永不返回）：7 个界面挂载都不抛异常，且都有内容渲染出来", async () => {
  const problems = [];
  const lines = [];
  for (const spec of PAGE_SPECS) {
    const doc = createDocument();
    const sandbox = sandboxWith(doc, neverApi());
    try {
      const host = await mountPage(sandbox, doc, spec);
      const rendered = host.children.length;
      if (rendered === 0) problems.push(`${spec.name}：挂载后没有任何内容渲染`);
      lines.push(`${spec.name} ✓（${rendered} 个顶层节点）`);
    } catch (exc) {
      problems.push(`${spec.name}：挂载抛异常 ${exc && exc.message}`);
    }
  }
  // 库存页由 app.js 渲染（它自己装配，不需要 mount）
  {
    const doc = createDocument();
    const sandbox = sandboxWith(doc, neverApi());
    buildShellFromIndexHtml(doc);
    try {
      runScript(sandbox, "renderer/app.js");
      await tick();
      await tick();
      lines.push("库存页 ✓（app.js 装配未抛异常）");
    } catch (exc) {
      problems.push(`库存页：装配抛异常 ${exc && exc.message}`);
    }
  }
  console.log("        （" + lines.join("；") + "）");
  assert.deepStrictEqual(problems, [], "首渲染不得抛异常：\n  - " + problems.join("\n  - "));
});

t("② 后端全部报错：**凡是挂载时取过数据的**页面都必须把错误显示出来（不白屏）", async () => {
  const problems = [];
  const lines = [];
  for (const spec of PAGE_SPECS) {
    const doc = createDocument();
    const api = failingApi();
    const sandbox = sandboxWith(doc, api);
    try {
      const host = await mountPage(sandbox, doc, spec);
      // 再等一会儿，让 .catch 里的 showError 跑完
      await tick();
      const text = host.textContent;
      if (api.calls.length === 0) {
        // 挂载时根本不取数据的页面（例如向导第 1 步只等用户选文件）——没有失败可报，这是对的
        lines.push(`${spec.name} —（挂载时未调后端，无需报错）`);
        continue;
      }
      if (!text.includes(FAIL_MARK)) {
        problems.push(`${spec.name}：调了 ${api.calls.join("/")} 却没把失败显示出来（用户看到的是白屏）`);
      } else {
        lines.push(`${spec.name} ✓（${api.calls.length} 次调用失败均可见）`);
      }
    } catch (exc) {
      problems.push(`${spec.name}：挂载抛异常 ${exc && exc.message}`);
    }
  }
  {
    const doc = createDocument();
    const api = failingApi();
    const sandbox = sandboxWith(doc, api);
    buildShellFromIndexHtml(doc);
    try {
      runScript(sandbox, "renderer/app.js");
      await tick();
      await tick();
      await tick();
      const status = doc.getElementById("status").textContent;
      if (api.calls.length === 0) problems.push("库存页：app.js 启动竟然没取数据（那它在渲染什么？）");
      else if (!status.includes(FAIL_MARK)) problems.push(`库存页：状态栏没有显示错误，实际「${status}」`);
      else lines.push(`库存页 ✓（${api.calls.length} 次调用失败均可见）`);
    } catch (exc) {
      problems.push(`库存页：装配抛异常 ${exc && exc.message}`);
    }
  }
  console.log("        （" + lines.join("；") + "）");
  assert.deepStrictEqual(problems, [], "后端报错时不得崩、也不得白屏：\n  - " + problems.join("\n  - "));
});

t("反证：这两个桩确实「什么都没成功」（否则上面两条会假通过）", () => {
  const never = neverApi();
  const failing = failingApi();
  assert.strictEqual(Object.keys(never).length, CHANNELS.length, "永不返回的桩应覆盖全部通道");
  // `failingApi` 额外挂了一个 calls 记录数组，计数时要排除它
  const failingMethods = Object.keys(failing).filter((k) => k !== "calls");
  assert.strictEqual(failingMethods.length, CHANNELS.length, "报错的桩应覆盖全部通道");
  assert.ok(CHANNELS.length >= 16, "通道数不该缩水");
  for (const channel of CHANNELS) {
    const method = channelToMethod(channel);
    assert.strictEqual(typeof never[method], "function", method);
    assert.strictEqual(typeof failing[method], "function", method);
  }
  assert.deepStrictEqual(failing.calls, [], "刚造出来的桩不该有调用记录");
});

/* ============================ 关键交互（按 BOM 领料 / 导出 / 改数据目录） */

section("§7 关键交互：按 BOM 领料、比对页导出、改数据目录");

/** 按文字找按钮（有些按钮没有 id；比按节点下标取更耐改） */
function buttonByText(root, text) {
  for (const node of root.all("button")) if (node.textContent.includes(text)) return node;
  return null;
}

t("领料页「按 BOM 领料」：库存不足时**整单拒绝**并列出缺口；勾了「允许部分」才扣减", async () => {
  const env = freshEnv(MAIN_BOM);
  // 按 BOM 第一条的真实规格建一条库存 **3** 的料（该行需求 8 → 属于"库里有但不够"= insufficient）。
  // 注意语义：库中**没有**的条目算 unknown（只列出、不阻断），只有 insufficient 才触发整单拒绝
  // （plan §6 / inventory.pickByBom）——第一版我给了库存 10（够用）于是它被正常领走，断言就撞了。
  const parsed = await env.handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  assert.strictEqual(parsed.ok, true, parsed.error);
  const first = parsed.items[0];
  assert.ok(first.quantity_per_board > 3, "样本首行需求应大于 3，否则这条用例造不出「不足」");
  const saved = await env.handlers["parts:save"]({
    part: {
      value: first.value, footprint: first.footprint, voltage: first.voltage,
      dielectric: first.dielectric, tolerance: first.tolerance, quantity: 3,
    },
  });
  assert.strictEqual(saved.ok, true, saved.error);

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel2";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  // 领料页是两个 tab（手动出/入库、按 BOM 领料）——先切到「按 BOM 领料」那个 tab（真人也是这么点的）
  const pickTab = buttonByText(host, "按 BOM 领料");
  assert.ok(pickTab, "应有「按 BOM 领料」tab");
  pickTab.click();
  await tick();

  // 选文件（走真 bom:pickFiles）
  const pickButton = buttonByText(host, "选择文件");
  assert.ok(pickButton, "应有「选择文件…」按钮");
  pickButton.click();
  await tick();
  assert.strictEqual(doc.getElementById("stock-file").value, MAIN_BOM, "文件框应填上路径");
  doc.getElementById("stock-sets").setValue("1");
  doc.getElementById("stock-pick-reason").setValue("整机试产");
  await tick();

  // ① 未勾「允许部分」→ 整单拒绝
  doc.getElementById("stock-pick-run").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts()[0].quantity, 3, "整单拒绝时不得扣任何库存");
  assert.strictEqual(env.db.loadMovements().length, 1, "只应有建条时的 init 一条变动");
  let text = host.textContent;
  assert.ok(/库存不足|整单拒绝|缺口/.test(text), "应把失败原因/缺口显示出来，实际：" + text.slice(0, 200));

  // ② 勾「允许部分」→ 把能领的扣掉
  const partial = doc.getElementById("stock-allow-partial");
  assert.ok(partial, "应有「允许部分」勾选框");
  partial.setChecked(true);
  await tick();
  doc.getElementById("stock-pick-run").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts()[0].quantity, 0, "允许部分后应把可领的扣光（3 → 0）");
  const moves = env.db.loadMovements();
  assert.strictEqual(moves.length, 2, "应新增一条领料变动");
  assert.strictEqual(moves[1].reason, "整机试产");
  text = host.textContent;
  assert.ok(/整机试产/.test(text), "最近变动里应出现领料原因，实际：" + text.slice(0, 200));
  console.log("        （整单拒绝时库存不动；允许部分后 3 → 0，变动记录含原因）");
});

t("比对页「导出」：点一下真的落盘一个 xlsx（FR-2.4/2.8）", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/compare_report.js");
  const host = doc.createElement("div");
  host.id = "compare-report2";
  doc.body.appendChild(host);
  sandbox.ComparePage.mount(host);
  await tick();

  buttonByText(host, "选择文件").click();
  await tick();
  doc.getElementById("compare-sets").setValue("1");
  doc.getElementById("compare-start").click();
  await tick();
  await tick();

  const mode = doc.getElementById("compare-mode");
  if (mode) mode.choose("lcsc");
  await tick();
  doc.getElementById("compare-export").click();
  await tick();
  await tick();

  const exported = fs.readdirSync(env.base).filter((name) => /\.xlsx$/i.test(name));
  assert.strictEqual(exported.length, 1, `应导出 1 个 xlsx，实际 ${JSON.stringify(exported)}`);
  assert.ok(/立创配单_/.test(exported[0]), "默认名应含「立创配单」与时间戳，实际：" + exported[0]);
  // 成功结果是渲染成「已导出 N 条」（`#compare-export-notice` 只是点之前的提示语）
  const text = host.textContent;
  assert.ok(/已导出 33 条/.test(text), "页面应显示已导出 33 条，实际：" + text.slice(-200));
  console.log(`        （落盘文件：${exported[0]}；页面显示「已导出 33 条」）`);
});

t("设置页「改数据目录」：未勾确认按钮禁用，勾了才真的改（AGENTS.md 需人工确认项）", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/settings_page.js");
  const host = doc.createElement("div");
  host.id = "settings-panel2";
  doc.body.appendChild(host);
  sandbox.SettingsPage.mount(host);
  await tick();
  await tick();

  const newDir = path.join(TMP, "moved-data");
  fs.mkdirSync(newDir, { recursive: true });
  doc.getElementById("settings-data-dir").setValue(newDir);
  await tick();
  const saveButton = doc.getElementById("settings-save-dir");
  assert.strictEqual(saveButton.disabled, true, "未勾确认前不得允许更改数据目录");
  assert.ok(/勾选/.test(doc.getElementById("settings-dir-hint").textContent), "应提示先勾确认");

  doc.getElementById("settings-dir-confirm").setChecked(true);
  await tick();
  assert.strictEqual(saveButton.disabled, false, "勾了确认后应可保存");
  saveButton.click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadSettings().data_dir, newDir, "数据目录设置应真的被改");
  assert.ok(/数据目录已更改/.test(doc.getElementById("settings-notice").textContent),
    "应提示已更改并说明旧数据不会自动搬，实际：" + doc.getElementById("settings-notice").textContent);
});

/* ---------------------------------------------------------------- */

runQueue().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }
  console.log("\n" + "=".repeat(64));
  console.log(`T30（页面级 DOM 测试）结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
