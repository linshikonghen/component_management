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
  // 渲染层基建（el / call / 请求守卫 / 去抖）唯一实现：renderer/lib/ui_util.js
  runScript(sandbox, "renderer/lib/ui_util.js");
  return sandbox;
}

/** 建一个"接了真后端"的页面沙箱 */
function createPageSandbox(handlers, opts = {}) {
  const doc = createDocument();
  const sandbox = makeSandbox(doc, makeApi(handlers), opts);
  // 页面里禁止用原生 window.confirm（在 Electron 里会卡住界面）；统一用页内弹窗 renderer/lib/dialog.js
  runScript(sandbox, "renderer/lib/dialog.js");
  return { sandbox, doc };
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

t("点「选择文件」→ 文件框填上路径（走的是真 bom:pick_files）", async () => {
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

t("**双击**「确认入库」→ 只提交一次（防重入，对抗审计 A1；T94 同款 busy 模式）", async () => {
  const env = freshEnv(MAIN_BOM);
  let commitCalls = 0;
  const realCommit = env.handlers["bom:commit"];
  // 包一层计数（makeApi 调用时才查 handlers[channel]，所以这里包装是生效的）
  env.handlers["bom:commit"] = async (req) => { commitCalls += 1; return realCommit(req); };
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/import_wizard.js");
  const host = doc.createElement("div");
  host.id = "import-wizard-dbl";
  doc.body.appendChild(host);
  sandbox.ImportPage.mount(host, {});
  await tick();
  doc.getElementById("import-pick").click();
  await tick();
  doc.getElementById("import-start").click();
  await tick();
  await tick();

  const btn = doc.getElementById("import-commit");
  assert.strictEqual(btn.disabled, false, "解析完应可入库");
  btn.click();
  btn.click(); // 同一轮连点两下（审核前双击就会提交两次 → 数量翻倍）
  await tick();
  await tick();
  await tick();
  assert.strictEqual(commitCalls, 1, "只允许提交一次（实际 " + commitCalls + " 次）");
  assert.strictEqual(env.db.loadParts().length, 32, "库只应入一次（32 条），不得因双击翻倍");
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
  doc.getElementById("pf-category").setValue("贴片电容(MLCC)");
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
  assert.strictEqual(parts[0].category, "贴片电容(MLCC)", "落库值应是立创中文名（v2.1 裁定①）");
  assert.strictEqual(parts[0].quantity, 120);
  assert.strictEqual(parts[0].location, "B-07");
  const body = doc.getElementById("parts-body-host").textContent;
  assert.ok(/已新增/.test(body), "应显示保存结果，实际：" + body.slice(0, 120));
  editor = { sandbox, doc, ...env };
});

t("保存后**保留分类/封装/库位**（FR-3.3 连续录入），清掉值", async () => {
  assert.strictEqual(editor.doc.getElementById("pf-category").value, "贴片电容(MLCC)", "分类应保留（中文名）");
  assert.strictEqual(editor.doc.getElementById("pf-footprint").value, "C0603", "封装应保留");
  assert.strictEqual(editor.doc.getElementById("pf-location").value, "B-07", "库位应保留");
  assert.strictEqual(editor.doc.getElementById("pf-value").value, "", "值应清空");
});

t("编辑旧数据的分类下拉：**显示的就是存的**（旧前缀映射到该类代表项），表外类型原样成项、未分类保持未选", async () => {
  // 事故复盘（独立复核抓到）：曾把旧值映射成"类的中文名"（R→电阻），而下拉的 key 是商品名（贴片电阻）
  // → select 找不到匹配项，**编辑页显示成「（未选 = 其它）」**，用户一保存分类就变样。
  // 这里用**真实页面 + 真 handlers** 把各种旧数据形态过一遍。
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor-legacy";
  doc.body.appendChild(host);
  const cases = [
    ["R", "贴片电阻", "旧位号前缀 → 该类代表项"],
    ["SW", "翘板船型开关", "旧位号前缀（开关）→ 该类代表项"],
    ["C", "贴片电容(MLCC)", "旧类键 → 该类代表项"],
    ["_default", "其它", "旧哨兵 → 其它"],
    ["固态电容", "固态电容", "表外商品类型 → 原样成项（不许伪装成其它）"],
    ["测试点", "测试点", "未收录类型 → 原样成项"],
    ["贴片电阻", "贴片电阻", "已是中文名 → 原样"],
  ];
  for (const [stored, want, why] of cases) {
    const saved = await env.handlers["parts:save"]({
      part: { category: stored, value: "v" + stored + "x", footprint: "F", quantity: 1 },
    });
    assert.strictEqual(saved.ok, true, `${stored} 应能入库：${saved.error}`);
    sandbox.PartsPage.mount(host, { part: saved.part });
    await tick();
    await tick();
    const select = host.querySelectorAll("select")[0];
    assert.strictEqual(select.value, want, `${why}（存的 ${JSON.stringify(stored)}）`);
    assert.ok(select.children.find((o) => o.selected), `${stored} 应有一项被选中`);
  }
  // 「未分类」只能在**新增**时出现（入库后端会把空分类规整成 `_default`，所以不能走 parts:save 造）
  sandbox.PartsPage.mount(host, {});
  await tick();
  const blank = host.querySelectorAll("select")[0];
  assert.strictEqual(blank.value, "", "未分类应停在「（未选 = 其它）」这一项，不许替用户选成其它");
});

t("手动录入第二次同规格 → 页内确认框：取消则不合并，选合并才合并（且**不弹原生 confirm**）", async () => {
  const env = freshEnv(MAIN_BOM);
  let nativeCalled = 0;
  const { sandbox, doc } = createPageSandbox(env.handlers, {
    // 原生 confirm 一旦被调用就记一笔：它正是"录入后界面卡住"的元凶，保存路径不许再用它
    confirm: () => { nativeCalled += 1; throw new Error("不许用原生 window.confirm（会卡住界面）"); },
  });
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor-merge";
  doc.body.appendChild(host);
  sandbox.PartsPage.mount(host, {});
  await tick();

  const fillAndSave = async () => {
    doc.getElementById("pf-value").setValue("100nF");
    doc.getElementById("pf-footprint").setValue("C0603");
    doc.getElementById("pf-quantity").setValue("10");
    await tick();
    doc.getElementById("parts-save").click();
    await tick();
    await tick();
  };

  await fillAndSave();
  assert.strictEqual(env.db.loadParts().length, 1, "第一次应新建");
  assert.strictEqual(env.db.loadParts()[0].quantity, 10);

  // 第二次同规格：出现**页内弹窗**（不是原生 confirm），文案说清是合并
  await fillAndSave();
  const mask = doc.getElementById("dialog-mask");
  assert.ok(mask, "同规格保存应弹出页内确认框");
  assert.strictEqual(nativeCalled, 0, "保存路径不许调用原生 window.confirm（会卡住界面）");
  const okBtn = doc.getElementById("dialog-ok");
  const cancelBtn = doc.getElementById("dialog-cancel");
  assert.ok(okBtn && cancelBtn, "弹窗要有 合并 与 取消 两个按钮");
  assert.ok(/合并/.test(okBtn.textContent), "主按钮文案应说明是合并：" + okBtn.textContent);
  assert.ok(/已有同规格/.test(mask.textContent), "弹窗要说清「库里已有同规格」：" + mask.textContent);

  // 先取消 → 什么都不变，弹窗消失
  cancelBtn.click();
  await tick();
  await tick();
  assert.strictEqual(doc.getElementById("dialog-mask"), null, "选完弹窗要关掉");
  assert.strictEqual(env.db.loadParts().length, 1, "取消时不得新建");
  assert.strictEqual(env.db.loadParts()[0].quantity, 10, "取消时不得合并数量");
  assert.ok(/已取消/.test(doc.getElementById("parts-error").textContent), "取消后要有明确反馈");

  // 再存一次，选合并 → 数量累加
  await fillAndSave();
  assert.ok(doc.getElementById("dialog-ok"), "应再次弹窗");
  doc.getElementById("dialog-ok").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 1, "合并后仍是一条");
  assert.strictEqual(env.db.loadParts()[0].quantity, 20, "合并后数量 10+10=20");
  assert.strictEqual(nativeCalled, 0, "全程不得调用原生 confirm");
});

t("回归守卫：页面代码里禁止再用原生 window.confirm / root.confirm（在 Electron 里会卡住界面）", () => {
  // 用户 2026-10-17 实测「录入后整个手动界面会卡住，不能连续输入」：根因是保存路径用了原生 confirm
  // （阻塞式模态；窗口没把它显示出来时整个渲染进程永久卡死）。统一改用 renderer/lib/dialog.js 的页内弹窗。
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.join(dir, name);
      const abs = path.join(ROOT, rel);
      if (fs.statSync(abs).isDirectory()) walk(rel);
      else if (rel.endsWith(".js")) files.push(rel.split(path.sep).join("/"));
    }
  })("renderer");
  assert.ok(files.length >= 10, "应扫到 renderer 下的脚本：" + files.length);
  const offenders = [];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    if (/window\.confirm\s*\(|root\.confirm\s*\(/.test(code)) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [], "这些页面还在用原生 confirm（改用 DialogUI.confirm）：" + offenders.join(", "));
  assert.ok(/DialogUI/.test(fs.readFileSync(path.join(ROOT, "renderer", "lib", "dialog.js"), "utf8")), "页内弹窗模块应在");
});

t("删除需确认：先拒绝时不删，确认后才删", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
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
  assert.ok(doc.getElementById("dialog-mask"), "删除应弹页内确认框（不用原生 confirm）");
  doc.getElementById("dialog-cancel").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 1, "未确认时不该删");

  doc.getElementById("parts-delete").click();
  await tick();
  doc.getElementById("dialog-ok").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 0, "确认后应删掉");
});

t("页内确认框：按 Esc = 取消（不误删/不误合并），且原生 confirm 全程未被调用", async () => {
  const env = freshEnv(MAIN_BOM);
  let nativeCalled = 0;
  const saved = await env.handlers["parts:save"]({ part: { value: "2k", footprint: "R0603", quantity: 3 } });
  assert.strictEqual(saved.ok, true, saved.error);
  const { sandbox, doc } = createPageSandbox(env.handlers, {
    confirm: () => { nativeCalled += 1; throw new Error("不许用原生 window.confirm"); },
  });
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor-esc";
  doc.body.appendChild(host);
  sandbox.PartsPage.mount(host, { part: saved.part });
  await tick();
  await tick();

  doc.getElementById("parts-delete").click();
  await tick();
  assert.ok(doc.getElementById("dialog-mask"), "删除应先弹页内确认框");
  doc.dispatch("keydown", { key: "Escape" });
  await tick();
  await tick();
  assert.strictEqual(doc.getElementById("dialog-mask"), null, "Esc 应关掉弹窗");
  assert.strictEqual(env.db.loadParts().length, 1, "Esc 取消后不该删");
  assert.strictEqual(nativeCalled, 0, "不许调用原生 confirm");
});

t("保存防重入：快速点两次保存只会落一条（数量不翻倍）", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor-double";
  doc.body.appendChild(host);
  sandbox.PartsPage.mount(host, {});
  await tick();

  doc.getElementById("pf-value").setValue("47uF");
  doc.getElementById("pf-footprint").setValue("C1210");
  doc.getElementById("pf-quantity").setValue("10");
  await tick();
  const saveBtn = doc.getElementById("parts-save");
  saveBtn.click();
  saveBtn.click(); // 同一轮里连点两下
  await tick();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 1, "只应新建一条");
  assert.strictEqual(env.db.loadParts()[0].quantity, 10, "数量不应翻倍（第二次点击必须被挡掉）");
});

t("DialogUI 缺失守卫：dialog.js 没加载时**明确报错且不执行危险动作**（对抗审计 C4）", async () => {
  // 录入页：删掉 DialogUI 后点「删除这条」→ 必须拒绝并且给出明确提示（不是 TypeError、不是静默删除）
  const env = freshEnv(MAIN_BOM);
  const saved = await env.handlers["parts:save"]({ part: { value: "8.2k", footprint: "R0603", quantity: 1 } });
  assert.strictEqual(saved.ok, true, saved.error);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor-nodialog";
  doc.body.appendChild(host);
  sandbox.PartsPage.mount(host, { part: saved.part });
  await tick();
  await tick();
  // 模拟 dialog.js 没加载：必须在 vm 上下文里删，从外部 delete sandbox.X 在 vm 里看不到
  vm.runInContext("delete globalThis.DialogUI", sandbox);
  doc.getElementById("parts-delete").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 1, "没有确认框时不得删除");
  const errText = doc.getElementById("parts-error").textContent || "";
  assert.ok(/dialog\.js/.test(errText), "要明确说是确认框组件没加载：" + errText);
  assert.ok(!/TypeError/.test(errText), "不能只抛 TypeError：" + errText);

  // 库存页：同理，行内删除也要拒绝
  const env2 = freshEnv(MAIN_BOM);
  await env2.handlers["parts:save"]({ part: { value: "9.1k", footprint: "R0603", quantity: 1 } });
  const { sandbox: sb2, doc: doc2 } = createPageSandbox(env2.handlers);
  buildShellFromIndexHtml(doc2);
  runScript(sb2, "renderer/app.js");
  await tick();
  vm.runInContext("delete globalThis.DialogUI", sb2); // 模拟 dialog.js 没加载
  const row = doc2.querySelectorAll("#parts-body tr")[0];
  const delBtn = row.querySelectorAll("button").filter((b) => /删除/.test(b.textContent))[0];
  assert.ok(delBtn, "行里应有删除按钮");
  delBtn.click();
  await tick();
  await tick();
  assert.strictEqual(env2.db.loadParts().length, 1, "没有确认框时不得删除");
  const status = doc2.getElementById("status").textContent || "";
  assert.ok(/dialog\.js/.test(status), "状态栏要说明确认框组件没加载：" + status);
});

t("手动录入「只有型号、没有值」的 MOS → **保存前先问**：确定=用型号当值并保存；取消=不保存并提示填值（用户要求）", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/parts_editor.js");
  const host = doc.createElement("div");
  host.id = "parts-editor-mpnvalue";
  doc.body.appendChild(host);
  sandbox.PartsPage.mount(host, {});
  await tick();
  // 只填 型号 / 封装 / 数量（值留空）——用户实测就是这么被「值必填」拦下的
  doc.getElementById("pf-part_number").setValue("AO3401A");
  doc.getElementById("pf-footprint").setValue("SOT-23");
  doc.getElementById("pf-quantity").setValue("5");
  await tick();
  // ① 界面提示要直接说清"没有参数值的元件，值就是型号"
  const hint = doc.getElementById("parts-hint").textContent;
  assert.ok(/值就是型号/.test(hint), "提示要说明「没有参数值的元件，值就是型号」：" + hint);

  // ② 先点取消 → 不保存、不偷偷用型号当值，并提示用户自己填值
  doc.getElementById("parts-save").click();
  await tick();
  await tick();
  const mask = doc.getElementById("dialog-mask");
  assert.ok(mask, "只填型号保存时，必须先弹确认询问");
  assert.ok(/型号/.test(mask.textContent) && /填进「值」/.test(mask.textContent),
    "询问文案要说清「是否直接把型号填进值」：" + mask.textContent);
  doc.getElementById("dialog-cancel").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 0, "取消时不得保存");
  const errText = doc.getElementById("parts-error").textContent;
  assert.ok(/请先在「值」里填上值/.test(errText), "取消后要提示用户自己填值：" + errText);

  // ③ 再点保存并确定 → 值 = 型号，保存成功
  doc.getElementById("parts-save").click();
  await tick();
  await tick();
  assert.ok(doc.getElementById("dialog-mask"), "应再次弹确认");
  doc.getElementById("dialog-ok").click();
  await tick();
  await tick();
  const parts = env.db.loadParts();
  assert.strictEqual(parts.length, 1, "确定后应保存成功");
  assert.strictEqual(parts[0].value, "AO3401A", "值 = 型号");
  assert.strictEqual(parts[0].part_number, "AO3401A", "型号保留");
});

t("**双击**库存页行内「删除」→ 只弹一次确认、只删一次（防重入，对抗审计 B1）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "5.6k", footprint: "R0603", quantity: 2 } });
  let deleteCalls = 0;
  const realDelete = env.handlers["parts:delete"];
  env.handlers["parts:delete"] = async (req) => { deleteCalls += 1; return realDelete(req); };
  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();
  const delButton = () => {
    const row = doc.querySelectorAll("#parts-body tr")[0];
    assert.ok(row, "应有器件行");
    return row.querySelectorAll("button").filter((b) => /删除/.test(b.textContent))[0];
  };
  const btn = delButton();
  assert.ok(btn, "行里应有删除按钮");
  btn.click();
  btn.click(); // 同一轮连点两下：第二下必须被 busy 挡住（不再弹第二个确认框）
  await tick();
  await tick();
  assert.ok(doc.getElementById("dialog-mask"), "应弹页内确认框");
  doc.getElementById("dialog-ok").click();
  await tick();
  await tick();
  assert.strictEqual(deleteCalls, 1, "只允许删除一次（实际 " + deleteCalls + " 次）");
  assert.strictEqual(env.db.loadParts().length, 0, "器件应被删除");
});

t("库存页「删除」也走页内确认框：取消不删、确认才删", async () => {
  const env = freshEnv(MAIN_BOM);
  let nativeCalled = 0;
  await env.handlers["parts:save"]({ part: { value: "3k", footprint: "R0603", quantity: 4 } });
  const { sandbox, doc } = createPageSandbox(env.handlers, {
    confirm: () => { nativeCalled += 1; throw new Error("不许用原生 window.confirm"); },
  });
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  const delButton = () => {
    const row = doc.querySelectorAll("#parts-body tr")[0];
    assert.ok(row, "应有器件行");
    return row.querySelectorAll("button").filter((b) => /删除/.test(b.textContent))[0];
  };
  const btn = delButton();
  assert.ok(btn, "行里应有删除按钮");
  btn.click();
  await tick();
  await tick();
  assert.ok(doc.getElementById("dialog-mask"), "删除应弹页内确认框");
  doc.getElementById("dialog-cancel").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 1, "取消不该删");

  delButton().click();
  await tick();
  await tick();
  doc.getElementById("dialog-ok").click();
  await tick();
  await tick();
  assert.strictEqual(env.db.loadParts().length, 0, "确认后应删掉");
  assert.strictEqual(nativeCalled, 0, "不许调用原生 confirm");
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

t("库存页**检索相似产品**（用户目标）：写法不同但值相同 → 标「相似」；结果行说清 N/共 M 与相似提示", async () => {
  const env = freshEnv(MAIN_BOM);
  // 两条写法不同、值相同（0.1uF ↔ 100nF）；用不同封装避开同规格合并闸门
  await env.handlers["parts:save"]({ part: { value: "0.1uF", footprint: "C0603", voltage: "50V", quantity: 10 } });
  await env.handlers["parts:save"]({ part: { value: "100nF", footprint: "C0805", voltage: "50V", quantity: 5 } });
  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  doc.getElementById("search").setValue("0.1uF");
  await tick();
  await new Promise((r) => setTimeout(r, 260)); // 搜索有 200ms 去抖
  await tick();
  await tick();
  const rows = doc.querySelectorAll("#parts-body tr");
  assert.strictEqual(rows.length, 2, "0.1uF 应带出 100nF（相似），共 2 行：" + rows.length);
  const similarRows = doc.querySelectorAll("#parts-body tr.similar");
  assert.strictEqual(similarRows.length, 1, "应恰好 1 行标为相似：" + similarRows.length);
  const line = doc.getElementById("result-line").textContent;
  assert.ok(/显示 2 条 \/ 库中共 2 条/.test(line), "结果行要显示 N/共 M：" + line);
  assert.ok(/相似命中/.test(line), "结果行要说明有相似命中：" + line);
  assert.ok(/0\.1uF/.test(line), "结果行要带上检索词：" + line);
});

t("库存页**空状态**要区分「库里真没料」与「检索/筛选没匹配」（检索/筛选要好用，不能误人）", async () => {
  // A. 空库 → 提示去导入/录入
  const emptyEnv = freshEnv(MAIN_BOM);
  const a = createPageSandbox(emptyEnv.handlers);
  buildShellFromIndexHtml(a.doc);
  runScript(a.sandbox, "renderer/app.js");
  await tick();
  await tick();
  const emptyText = a.doc.getElementById("parts-body").textContent;
  assert.ok(/库里还没有器件/.test(emptyText), "空库应提示去导入/录入：" + emptyText);

  // B. 有料但搜不到 → 提示「没有匹配的器件」+ 清除筛选/换写法建议（不是"库里还没有器件"）
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0603", quantity: 2 } });
  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();
  doc.getElementById("search").setValue("不存在的料");
  await new Promise((r) => setTimeout(r, 260));
  await tick();
  await tick();
  const noMatch = doc.getElementById("parts-body").textContent;
  assert.ok(/没有匹配的器件/.test(noMatch), "检索无结果应说清是「没有匹配」：" + noMatch);
  assert.ok(/清除筛选/.test(noMatch), "同时提示可清除筛选：" + noMatch);
  assert.ok(/0\.1uF 与 100nF/.test(noMatch), "并提示可比对写法：" + noMatch);
  // 清空搜索 → 恢复
  doc.getElementById("search").setValue("");
  await new Promise((r) => setTimeout(r, 260));
  await tick();
  await tick();
  assert.strictEqual(doc.querySelectorAll("#parts-body tr").length, 1, "清空搜索后应恢复 1 条");
  assert.ok(!/没有匹配/.test(doc.getElementById("parts-body").textContent));
});

t("库存页**筛选**（FR-5.3）：分类/封装/耐压下拉由 facets 填充；改了筛选立刻按条件重查；清除筛选恢复全部", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "10uF", footprint: "C1210", voltage: "50V", quantity: 3 } });
  await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "1kΩ", footprint: "R0603", voltage: "", quantity: 8 } });
  const queries = [];
  const realList = env.handlers["parts:list"];
  env.handlers["parts:list"] = async (req) => { queries.push(JSON.parse(JSON.stringify((req && req.query) || {}))); return realList(req); };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  // ① 下拉由 facets 填充（全部 + 实际值）
  const category = doc.getElementById("filter-category");
  const options = category.children.map((o) => o.value);
  assert.deepStrictEqual(options, ["", "贴片电容(MLCC)", "贴片电阻"], "分类下拉 = 全部 + facets：" + JSON.stringify(options));
  const footprint = doc.getElementById("filter-footprint");
  assert.deepStrictEqual(footprint.children.map((o) => o.value), ["", "C1210", "R0603"]);

  // ② 改分类 → 带 category 重查，结果收窄
  category.choose("贴片电阻");
  await tick();
  await tick();
  assert.strictEqual(queries[queries.length - 1].category, "贴片电阻", "应把 category 传给 parts:list");
  assert.strictEqual(doc.querySelectorAll("#parts-body tr").length, 1, "只应剩电阻那条");
  const line = doc.getElementById("result-line").textContent;
  assert.ok(/筛选：分类 贴片电阻/.test(line), "结果行要写明当前筛选：" + line);

  // ③ 只看低库存（勾选后 query 带 low_stock_only）
  const lowBox = doc.getElementById("filter-low-only");
  lowBox.setChecked(true);
  await tick();
  await tick();
  assert.strictEqual(queries[queries.length - 1].low_stock_only, true, "应把 low_stock_only 传给 parts:list");

  // ④ 清除筛选 → 搜索与筛选条件都清空、重新查全部
  doc.getElementById("filter-clear").click();
  await tick();
  await tick();
  const last = queries[queries.length - 1];
  assert.strictEqual(last.category, undefined, "清除后不该再带 category");
  assert.strictEqual(last.low_stock_only, undefined, "清除后不该再带 low_stock_only");
  assert.strictEqual(doc.getElementById("filter-category").value, "", "分类下拉应回到「全部」");
  assert.strictEqual(doc.getElementById("filter-low-only").checked, false, "低库存勾选应被清掉");
  assert.strictEqual(doc.querySelectorAll("#parts-body tr").length, 2, "清除后恢复全部 2 条");
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

t("**双击**「导出库表」→ 只导出一次（防重入，对抗审计 B1）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "33uF", footprint: "C1206", quantity: 3 } });
  let exportCalls = 0;
  const realExport = env.handlers["parts:export"];
  env.handlers["parts:export"] = async (req) => { exportCalls += 1; return realExport(req); };
  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  const btn = doc.getElementById("export-library");
  btn.click();
  btn.click(); // 同一轮连点两下
  await tick();
  await tick();
  await tick();
  assert.strictEqual(exportCalls, 1, "只允许导出一次（实际 " + exportCalls + " 次）");
  const files = fs.readdirSync(env.base).filter((name) => /器件库_.*\.xlsx$/.test(name));
  assert.strictEqual(files.length, 1, "只应落盘一个导出文件，实际 " + JSON.stringify(files));
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

/** 准备"BOM 已入库"的库，返回库存总量 */
async function seedFromMainBom(env) {
  const parsed = await env.handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const committed = await env.handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.strictEqual(committed.ok, true, committed.error);
  return env.db.loadParts().reduce((sum, p) => sum + Number(p.quantity || 0), 0);
}

t("**双击**「按 BOM 领料」→ 只领一次（防重入，对抗审计 B1）", async () => {
  // 对照组：同样的库 + **只领一次**，得到"正确的领料后库存"
  const ctrl = freshEnv(MAIN_BOM);
  await seedFromMainBom(ctrl);
  const ctrlPick = await ctrl.handlers["stock:pick_by_bom"]({
    file_path: MAIN_BOM, sets: 1, reason: "双击防重入测试", allow_partial: true,
  });
  assert.strictEqual(ctrlPick.ok, true, ctrlPick.error);
  const ctrlQty = ctrl.db.loadParts().reduce((sum, p) => sum + Number(p.quantity || 0), 0);

  const env = freshEnv(MAIN_BOM);
  const beforeQty = await seedFromMainBom(env);
  let pickCalls = 0;
  const realPick = env.handlers["stock:pick_by_bom"];
  env.handlers["stock:pick_by_bom"] = async (req) => { pickCalls += 1; return realPick(req); };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-pick-dbl";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();
  const tabs = doc.querySelectorAll("button").filter((b) => /按 BOM 领料/.test(String(b.textContent)));
  assert.ok(tabs.length >= 1, "应有「按 BOM 领料」页签");
  tabs[0].click();
  await tick();
  buttonByText(host, "选择文件").click();
  await tick();
  doc.getElementById("stock-sets").setValue("1");
  doc.getElementById("stock-pick-reason").setValue("双击防重入测试");
  await tick();
  const btn = doc.getElementById("stock-pick-run");
  assert.ok(btn, "应有领料按钮");
  btn.click();
  btn.click(); // 同一轮连点两下
  await tick();
  await tick();
  await tick();
  assert.strictEqual(pickCalls, 1, "只允许领料一次（实际 " + pickCalls + " 次）");
  const afterQty = env.db.loadParts().reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  assert.ok(afterQty < beforeQty, "领料应该真的扣了库存（" + beforeQty + " → " + afterQty + "）");
  // 关键断言：双击后的库存必须与"只点一次"的对照组**完全一致**（不许多扣一遍）
  assert.strictEqual(afterQty, ctrlQty, "双击不应多扣库存：对照组 " + ctrlQty + "，实际 " + afterQty);
});

t("领料页**检索/筛选**（用户目标）：搜 0.1uF 能带出 100nF（相似）；分类筛选收窄候选；候选项与提示同步刷新", async () => {
  const env = freshEnv(MAIN_BOM);
  const cap = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", voltage: "50V", quantity: 10 } });
  const cap2 = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0805", voltage: "50V", quantity: 5 } });
  const res = await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 8 } });
  assert.strictEqual(cap.ok && cap2.ok && res.ok, true, "夹具建库失败");

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-search";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  // ① 控件都在（检索框 + 分类/封装筛选 + 候选提示）
  const search = doc.getElementById("stock-part-search");
  const filterCategory = doc.getElementById("stock-filter-category");
  const partSelect = doc.getElementById("stock-part");
  const hint = doc.getElementById("stock-part-hint");
  assert.ok(search, "应有检索框");
  assert.ok(filterCategory, "应有分类筛选");
  assert.ok(partSelect, "应有器件下拉");
  assert.ok(hint, "应有候选/相似提示");
  assert.strictEqual(partSelect.children.length, 4, "初始：占位 + 3 条候选，实际 " + partSelect.children.length);
  assert.ok(/可选 3 条/.test(hint.textContent), "初始提示应说可选条数：" + hint.textContent);

  // ② 搜 0.1uF → 精确 1 条 + 相似 1 条（100nF）
  search.setValue("0.1uF");
  await new Promise((r) => setTimeout(r, 320)); // 去抖 200ms + IPC
  await tick();
  await tick();
  const optionValues = partSelect.children.map((o) => o.value);
  assert.strictEqual(optionValues.length, 3, "应剩 占位 + 2 条（精确 + 相似），实际 " + JSON.stringify(optionValues));
  assert.ok(optionValues.includes(cap.part.id), "应含 0.1uF 那条");
  assert.ok(optionValues.includes(cap2.part.id), "相似应带出 100nF 那条");
  assert.ok(/可选 2 条/.test(hint.textContent), "提示应更新为 2 条：" + hint.textContent);
  assert.ok(/相似命中/.test(hint.textContent), "提示要说明有相似命中：" + hint.textContent);

  // ③ 检索 + 筛选是**同时生效**的：搜索词还在（0.1uF）+ 分类=贴片电阻 → 没有匹配（正确收窄）
  filterCategory.choose("贴片电阻");
  await tick();
  await tick();
  const combined = partSelect.children.map((o) => o.value);
  assert.deepStrictEqual(combined, [""], "搜索词与分类是 AND 关系，应无匹配：" + JSON.stringify(combined));
  assert.ok(/没有匹配的器件/.test(hint.textContent), "无匹配时提示应给出可比对写法建议：" + hint.textContent);

  // ④ 清空搜索（分类仍=贴片电阻）→ 候选只剩电阻那条
  search.setValue("");
  await new Promise((r) => setTimeout(r, 320));
  await tick();
  await tick();
  const afterCategory = partSelect.children.map((o) => o.value);
  assert.deepStrictEqual(afterCategory, ["", res.part.id], "清空搜索后只剩电阻那条：" + JSON.stringify(afterCategory));
  assert.ok(/可选 1 条/.test(hint.textContent), "提示应更新为 1 条：" + hint.textContent);

  // ⑤ 选中一条后仍能正常选择（选择器状态不被重建弄坏）
  partSelect.choose(res.part.id);
  await tick();
  assert.strictEqual(partSelect.value, res.part.id, "选择值应保持");
});

t("领料页：**检索找料 → 选中 → 出库** 全流程可用；「清除检索/筛选」能复位候选", async () => {
  const env = freshEnv(MAIN_BOM);
  const cap = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", voltage: "50V", quantity: 20 } });
  const cap2 = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0805", voltage: "50V", quantity: 7 } });
  const res = await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 5 } });
  assert.strictEqual(cap.ok && cap2.ok && res.ok, true, "夹具建库失败");

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-flow";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  // ① 检索 0.1uF → 候选中挑"相似"的 100nF（用户真实场景：手里写的是 100nF，库里记的是 0.1uF 或反之）
  doc.getElementById("stock-part-search").setValue("0.1uF");
  await new Promise((r) => setTimeout(r, 320));
  await tick();
  await tick();
  doc.getElementById("stock-part").choose(cap2.part.id);
  doc.getElementById("stock-amount").setValue("2");
  doc.getElementById("stock-reason").setValue("按检索领用");
  await tick();
  doc.getElementById("stock-move-run").click();
  await new Promise((r) => setTimeout(r, 80));
  await tick();
  await tick();
  const after = env.db.loadParts().find((x) => x.id === cap2.part.id);
  assert.strictEqual(after.quantity, 5, "100nF 应 7 - 2 = 5");
  const moves = env.db.loadMovements().filter((m) => /按检索领用/.test(String(m.reason)));
  assert.strictEqual(moves.length, 1, "应有 1 条留痕");
  assert.strictEqual(moves[0].part_id, cap2.part.id);

  // ② 清除检索/筛选 → 候选回到全部 3 条
  assert.ok(doc.getElementById("stock-filter-clear"), "应有「清除检索/筛选」按钮");
  doc.getElementById("stock-filter-clear").click();
  await tick();
  await tick();
  const select = doc.getElementById("stock-part");
  assert.strictEqual(select.children.length, 4, "清除后：占位 + 全部 3 条候选，实际 " + select.children.length);
  assert.strictEqual(doc.getElementById("stock-part-search").value, "", "检索框应被清空");
});

t("库存页：按 **Enter 立即检索**（跳过去抖 200ms，常搜的人不用干等）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0603", quantity: 2 } });
  await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 3 } });
  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  const search = doc.getElementById("search");
  search.setValue("100nF");
  search.dispatch("keydown", { key: "Enter" }); // 不等 200ms 去抖
  await tick();
  await tick();
  assert.strictEqual(doc.querySelectorAll("#parts-body tr").length, 1, "Enter 后应立刻只剩 1 条");
  assert.ok(/搜索「100nF」/.test(doc.getElementById("result-line").textContent));
});

t("领料页：检索框按 **Enter 立即检索**（跳过去抖）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0603", quantity: 2 } });
  await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 3 } });
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-enter";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  const search = doc.getElementById("stock-part-search");
  search.setValue("100nF");
  search.dispatch("keydown", { key: "Enter" }); // 不等 200ms
  await tick();
  await tick();
  const options = doc.getElementById("stock-part").children.map((o) => o.value);
  assert.strictEqual(options.length, 2, "Enter 后应立刻只剩「占位 + 100nF」：" + JSON.stringify(options));
});

t("领料页**检索竞态**：慢响应晚到不许覆盖「清除检索/筛选」后的全部候选（真 bug 防回归）", async () => {
  const env = freshEnv(MAIN_BOM);
  const a = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", quantity: 10 } });
  const b = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0805", quantity: 5 } });
  const c = await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 8 } });
  assert.strictEqual(a.ok && b.ok && c.ok, true, "夹具建库失败");

  // 把「搜 0.1uF」的 parts:list 拖慢（模拟慢机器/IPC 排队），其它请求照常
  const realList = env.handlers["parts:list"];
  env.handlers["parts:list"] = async (req) => {
    const q = String((req && req.query && req.query.q) || "");
    if (q === "0.1uF") {
      await new Promise((r) => setTimeout(r, 250));
    }
    return realList(req);
  };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-race";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  // 输入 0.1uF → 200ms 去抖后发出（慢）请求；请求还在飞时点「清除检索/筛选」
  doc.getElementById("stock-part-search").setValue("0.1uF");
  await new Promise((r) => setTimeout(r, 260)); // 去抖已触发、请求在飞
  doc.getElementById("stock-filter-clear").click();
  await new Promise((r) => setTimeout(r, 400)); // 让慢响应到达并被丢弃
  await tick();
  await tick();

  const select = doc.getElementById("stock-part");
  assert.strictEqual(select.children.length, 4, "清除后应保持「占位 + 全部 3 条」，晚到响应不许覆盖：" + select.children.length);
  assert.strictEqual(doc.getElementById("stock-part-search").value, "", "检索框应仍为空");
  assert.ok(/可选 3 条/.test(doc.getElementById("stock-part-hint").textContent), "提示应仍是全部 3 条：" + doc.getElementById("stock-part-hint").textContent);
});

t("库存页**请求竞态**：慢的搜索响应晚到不许覆盖后来的筛选结果（真 bug 防回归）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", quantity: 10 } });
  await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0805", quantity: 5 } });
  await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 8 } });

  // 「搜 0.1uF」的请求拖慢 250ms；「筛选分类=贴片电阻」的请求照常（快）
  const realList = env.handlers["parts:list"];
  env.handlers["parts:list"] = async (req) => {
    const q = String((req && req.query && req.query.q) || "");
    if (q === "0.1uF") await new Promise((r) => setTimeout(r, 250));
    return realList(req);
  };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  doc.getElementById("search").setValue("0.1uF");
  await new Promise((r) => setTimeout(r, 260)); // 去抖已触发、慢请求在飞
  // 在慢请求还在飞时点「清除筛选」→ 立刻发新的（快）请求，应显示全部 3 条
  doc.getElementById("filter-clear").click();
  await tick();
  await tick();
  await new Promise((r) => setTimeout(r, 400)); // 慢响应（0.1uF：2 条）晚到，必须被丢弃
  await tick();
  await tick();

  const rows = doc.querySelectorAll("#parts-body tr");
  assert.strictEqual(rows.length, 3, "晚到的搜索响应不许覆盖清除后的全部结果（应 3 条），实际 " + rows.length);
  const line = doc.getElementById("result-line").textContent;
  assert.strictEqual(doc.getElementById("search").value, "", "清除后搜索框应为空");
  assert.ok(/显示 3 条 \/ 库中共 3 条/.test(line), "结果行应是全部 3 条：" + line);
  assert.ok(!/搜索/.test(line), "结果行不该再带旧搜索词：" + line);
});

t("领料页：**出/入库成功后保留检索/筛选状态**（搜索框有词，候选不能悄悄变回全库）", async () => {
  const env = freshEnv(MAIN_BOM);
  const cap = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", voltage: "50V", quantity: 20 } });
  const cap2 = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "100nF", footprint: "C0805", voltage: "50V", quantity: 7 } });
  const res = await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 5 } });
  assert.strictEqual(cap.ok && cap2.ok && res.ok, true, "夹具建库失败");

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-keep-filter";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  // 检索 0.1uF → 候选 2 条；选中 0.1uF 那条出库 1
  doc.getElementById("stock-part-search").setValue("0.1uF");
  await new Promise((r) => setTimeout(r, 320));
  await tick();
  await tick();
  assert.strictEqual(doc.getElementById("stock-part").children.length, 3, "检索后应为 占位 + 2 条");
  doc.getElementById("stock-part").choose(cap.part.id);
  doc.getElementById("stock-amount").setValue("1");
  doc.getElementById("stock-reason").setValue("检索状态保持测试");
  await tick();
  doc.getElementById("stock-move-run").click();
  await new Promise((r) => setTimeout(r, 120));
  await tick();
  await tick();

  // 出库成功：检索框还在、候选仍是那 2 条（不许变回全库 3 条）
  assert.strictEqual(doc.getElementById("stock-part-search").value, "0.1uF", "检索框内容应保留");
  assert.strictEqual(doc.getElementById("stock-part").children.length, 3,
    "出库后候选应仍按检索条件（占位 + 2 条），不许悄悄变回全库：" + doc.getElementById("stock-part").children.length);
  assert.ok(/可选 2 条/.test(doc.getElementById("stock-part-hint").textContent),
    "提示应仍是 2 条：" + doc.getElementById("stock-part-hint").textContent);
  const after = env.db.loadParts().find((x) => x.id === cap.part.id);
  assert.strictEqual(after.quantity, 19, "出库应真的生效（20→19）");
});

t("库存页行内「领料」→ 直接跳到领料页并**预选**该器件（用户目标：领料别太繁琐，少翻全库列表）", async () => {
  const env = freshEnv(MAIN_BOM);
  const saved = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", quantity: 10 } });
  await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 5 } });
  assert.strictEqual(saved.ok, true, saved.error);

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js"); // 先准备好 StockPage
  buildShellFromIndexHtml(doc);
  runScript(sandbox, "renderer/app.js");
  await tick();
  await tick();

  const rows = doc.querySelectorAll("#parts-body tr");
  const target = rows.filter((tr) => /0\.1uF/.test(tr.textContent))[0];
  assert.ok(target, "库存表里应有 0.1uF 那一行");
  const pick = target.querySelectorAll("button").filter((b) => /领料/.test(b.textContent))[0];
  assert.ok(pick, "行内应有「领料」按钮");
  pick.click();
  await tick();
  await tick();
  await new Promise((r) => setTimeout(r, 30));
  await tick();

  assert.strictEqual(doc.getElementById("page-stock").hidden, false, "应切到领料页");
  assert.strictEqual(doc.getElementById("page-inventory").hidden, true, "库存页应隐藏");
  assert.strictEqual(doc.getElementById("stock-part").value, saved.part.id, "领料页器件下拉应预选该器件");
  assert.ok(/手动出 \/ 入库/.test(doc.getElementById("stock-panel").textContent), "应显示手动出入库区");
});

t("领料页已挂载且正在检索时，从库存点「领料」→ 清掉检索并选中目标（不能因为筛选把目标藏起来）", async () => {
  const env = freshEnv(MAIN_BOM);
  const cap = await env.handlers["parts:save"]({ part: { category: "贴片电容(MLCC)", value: "0.1uF", footprint: "C0603", quantity: 10 } });
  const res = await env.handlers["parts:save"]({ part: { category: "贴片电阻", value: "10kΩ", footprint: "R0603", quantity: 5 } });
  assert.strictEqual(cap.ok && res.ok, true, "夹具建库失败");

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-focus";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();

  // 先在领料页检索一个把目标排除在外的词
  doc.getElementById("stock-part-search").setValue("0.1uF");
  await new Promise((r) => setTimeout(r, 320));
  await tick();
  await tick();
  assert.strictEqual(doc.getElementById("stock-part").children.length, 2, "检索后只剩 1 条候选（占位+1），实际 " + doc.getElementById("stock-part").children.length);

  // 库存页点「领料」目标 = 10kΩ（不在当前检索结果里）→ 清检索、选中目标
  sandbox.StockPage.focusPart(res.part.id);
  await tick();
  assert.strictEqual(doc.getElementById("stock-part-search").value, "", "应清掉检索词");
  assert.strictEqual(doc.getElementById("stock-part").value, res.part.id, "应选中目标器件");
  assert.strictEqual(doc.getElementById("stock-part").children.length, 3, "候选恢复为占位 + 全部 2 条，实际 " + doc.getElementById("stock-part").children.length);
});

t("**双击**「出/入库」按钮 → 只执行一次（防重入，对抗审计 B1；T94 同款 busy 模式）", async () => {
  const env = freshEnv(MAIN_BOM);
  const saved = await env.handlers["parts:save"]({ part: { value: "4.7uF", footprint: "C0805", quantity: 20 } });
  assert.strictEqual(saved.ok, true, saved.error);
  let moveCalls = 0;
  const realMove = env.handlers["stock:move"];
  env.handlers["stock:move"] = async (req) => { moveCalls += 1; return realMove(req); };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/stock_page.js");
  const host = doc.createElement("div");
  host.id = "stock-panel-dbl";
  doc.body.appendChild(host);
  sandbox.StockPage.mount(host);
  await tick();
  await tick();
  doc.getElementById("stock-part").choose(saved.part.id);
  doc.getElementById("stock-direction").choose("out");
  doc.getElementById("stock-amount").setValue("5");
  doc.getElementById("stock-reason").setValue("双击防重入测试");
  await tick();
  const btn = doc.getElementById("stock-move-run");
  btn.click();
  btn.click(); // 同一轮连点两下
  await tick();
  await tick();
  await tick();
  assert.strictEqual(moveCalls, 1, "只允许调用一次 stock:move（实际 " + moveCalls + " 次）");
  assert.strictEqual(env.db.loadParts()[0].quantity, 15, "只扣一次：20 - 5 = 15");
});

t("设置页（pages/settings_page.js）：阈值框数取自 §5.3 类表 → 改一个保存 → 设置真的变了", async () => {
  const env = freshEnv(MAIN_BOM);
  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/settings_page.js");
  const host = doc.createElement("div");
  host.id = "settings-panel";
  doc.body.appendChild(host);
  sandbox.SettingsPage.mount(host);
  await tick();
  await tick();

  const rows = sandbox.PartsModel.CATEGORY_CLASS_ROWS;
  const inputs = doc.querySelectorAll("input[type='number']").filter((el) => /^th-/.test(el.id));
  assert.strictEqual(inputs.length, rows.length,
    `阈值框数应等于 §5.3 的类数（${rows.length}），实际 ${inputs.length}`);
  assert.strictEqual(rows.length, 14, "spec §5.3 是 14 类");
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

t("**双击**「恢复」→ 只恢复一次（防重入，对抗审计 B1；恢复是覆盖性危险操作）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "6.8k", footprint: "R0603", quantity: 2 } });
  let restoreCalls = 0;
  const realRestore = env.handlers["data:restore"];
  env.handlers["data:restore"] = async (req) => { restoreCalls += 1; return realRestore(req); };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/backup_page.js");
  const host = doc.createElement("div");
  host.id = "backup-panel-restore-dbl";
  doc.body.appendChild(host);
  sandbox.BackupPage.mount(host);
  await tick();

  // 先做一次备份，然后在恢复区选中它并勾确认
  const dir = path.join(TMP, "backup-out-restore-dbl");
  fs.mkdirSync(dir, { recursive: true });
  doc.getElementById("backup-dir").setValue(dir);
  await tick();
  doc.getElementById("backup-run").click();
  await tick();
  await tick();
  const backupName = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory())[0];
  assert.ok(backupName, "应先有一份备份");
  doc.getElementById("restore-dir").setValue(path.join(dir, backupName));
  doc.getElementById("restore-confirm").setChecked(true);
  await tick();
  const btn = doc.getElementById("restore-run");
  assert.strictEqual(btn.disabled, false, "勾了确认后应可恢复");
  btn.click();
  btn.click(); // 同一轮连点两下
  await tick();
  await tick();
  await tick();
  assert.strictEqual(restoreCalls, 1, "只允许恢复一次（实际 " + restoreCalls + " 次）");
});

t("**双击**「立即备份」→ 只备份一次（防重入，对抗审计 B1）", async () => {
  const env = freshEnv(MAIN_BOM);
  await env.handlers["parts:save"]({ part: { value: "2k", footprint: "R0603", quantity: 3 } });
  let backupCalls = 0;
  const realBackup = env.handlers["data:backup"];
  env.handlers["data:backup"] = async (req) => { backupCalls += 1; return realBackup(req); };

  const { sandbox, doc } = createPageSandbox(env.handlers);
  runScript(sandbox, "renderer/pages/backup_page.js");
  const host = doc.createElement("div");
  host.id = "backup-panel-dbl";
  doc.body.appendChild(host);
  sandbox.BackupPage.mount(host);
  await tick();
  const dir = path.join(TMP, "backup-out-dbl");
  fs.mkdirSync(dir, { recursive: true });
  doc.getElementById("backup-dir").setValue(dir);
  await tick();
  const btn = doc.getElementById("backup-run");
  btn.click();
  btn.click();
  await tick();
  await tick();
  await tick();
  assert.strictEqual(backupCalls, 1, "只允许备份一次（实际 " + backupCalls + " 次）");
  const entries = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  assert.strictEqual(entries.length, 1, "目录里只应有一份备份，实际 " + entries.length);
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

  // 选文件（走真 bom:pick_files）
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
