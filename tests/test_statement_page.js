"use strict";
/**
 * T51（对账单入库页）—— 页面级测试 + 两条静态回归断言
 *
 * 为什么要有这条套件：上轮我在**同一轮里引入过两个真 bug**（漏引模型脚本、`mounted.stock` 被挪走），
 * 而它们全都是我**逐行复核 diff** 才发现的——页面这薄层当时 0 自动化覆盖。这个文件就是补那一课。
 *
 * 骨架说明：通用 DOM 由 `tests/fake_dom.js` 提供（`test_renderer_pages.js` 用）；
 * 这里用一个**专属极简骨架**，因为本页需要**同步捕获事件监听器**并在测试里主动触发，
 * 骨架只要能满足这几个动作即可（createElement / appendChild / addEventListener / dataset / disabled / value）。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE = path.join(ROOT, "renderer", "pages", "statement_page.js");
const UI_UTIL = path.join(ROOT, "renderer", "lib", "ui_util.js");
const MODEL = path.join(ROOT, "renderer", "model", "statement_model.js");

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

/* --------------------------------------------------- 极简 DOM 骨架 */

function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.children = [];
      this.listeners = {};
      this.dataset = {};
      this.className = "";
      this._text = "";
      this.disabled = false;
      this.value = "";
      this.placeholder = "";
      this.id = "";
      this.type = "";
      this.readOnly = false;
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v == null ? "" : v); this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    /** 测试用：触发事件（同步） */
    fire(type, event) { for (const fn of (this.listeners[type] || [])) fn(event || { target: this }); }
  }
  return {
    createElement: (tag) => new Node(tag),
    /** 深度遍历（找按钮/文本用） */
    all(node, out) {
      const acc = out || [];
      for (const c of node.children) { acc.push(c); this.all(c, acc); }
      return acc;
    },
    findByText(node, text) {
      return this.all(node, []).find((n) => n.tagName === "BUTTON" && String(n.textContent).includes(text));
    },
  };
}

/** 一份"1 命中 / 1 疑似 / 1 新增"的解析结果 */
const PARSED = {
  ok: true,
  items: [
    { row_no: 2, category: "贴片电容(MLCC)", threshold_key: "C", value: "100nF", tolerance: "±10%", voltage: "100V", manufacturer_part: "M1", footprint: "0603", quantity: 50 },
    { row_no: 3, category: "贴片电容(MLCC)", threshold_key: "C", value: "22uF", tolerance: "±20%", voltage: "25V", manufacturer_part: "M2", footprint: "1206", quantity: 5 },
    { row_no: 6, category: "贴片电阻", threshold_key: "R", value: "10k", tolerance: "", voltage: "", manufacturer_part: "M3", footprint: "0603", quantity: 10 },
  ],
  matched: [{ row_no: 2, part_id: "p_0001" }],
  suspected: [{
    row_no: 3,
    candidates: [{
      part_id: "p_0007",
      value: "22uF", footprint: "1206", voltage: "", dielectric: "", tolerance: "±20%",
      part_number: "M2", quantity: 5,
      diff: ["voltage: 库里「空」 vs 对账单「25V」"],
    }],
  }],
  missing: [6],
  warnings: [],
};

/** 装载页面并返回 { page, dom, container, calls } */
function load(canned, mutateApi) {
  const dom = makeDom();
  const calls = { parse: [], commit: [] };
  const api = {
    // **桩必须照真实契约来**：bom:pick_files 返回 { ok, file_paths }（见 src/ipc/handlers.js）。
    // 我第一版这里返回裸数组，于是页面代码以为自己解包对了 —— 契约漂移就是这么溜过测试的。
    bomPickFiles: async () => ({ ok: true, file_paths: ["E:\\kke\\stmt.xls"] }),
    statementParse: async (req) => { calls.parse.push(req); return canned || PARSED; },
    statementCommit: async (req) => {
      calls.commit.push(req);
      return { ok: true, summary: { merged_count: 1, created_count: 1, quantity_in: 60, order_ref: "SO26101418868" } };
    },
  };
  if (typeof mutateApi === "function") mutateApi(api);
  const root = { api, document: dom };
  // 注意：`document` 必须挂在**沙箱全局**上——页面代码里是裸 `document`，
  // 而不是 `globalThis.document`（第一版只挂在 root 上，于是 document is not defined）。
  const sbox = { globalThis: root, document: dom, module: undefined, console };
  root.globalThis = root;
  // 先装模型（页面依赖 window.StatementModel），再装页面
  const vm = require("node:vm");
  // 渲染层基建（el 等）唯一实现，页面脚本依赖它
  vm.runInNewContext(fs.readFileSync(UI_UTIL, "utf8"), sbox);
  vm.runInNewContext(fs.readFileSync(MODEL, "utf8"), sbox);
  vm.runInNewContext(fs.readFileSync(PAGE, "utf8"), sbox);
  const container = dom.createElement("div");
  root.StatementPage.mount(container);
  return { root, dom, container, calls };
}

t("**裁决入口必须看得见**（用户实测：「叫我裁决完入库，但去哪裁决？」）", async () => {
  // 事故复盘：对账单核对表列变多以后（加/电流/功率/极性/其它 后 16 列），裁决按钮被挤到最右边，
  // 要横向滚动才看得到 → 用户找不到入口。假 DOM 没有布局，所以这里用**三条可检查的性质**钉住：
  //   ① 处置列是最后一列（CSS 的「固定在右侧」规则才落在正确的列上）
  //   ② 渲染出来的 th/td 带 decision-col 类（CSS 才命中）
  //   ③ 样式表里确实有 decision-col 的 sticky right 规则
  const M = require(MODEL);
  assert.strictEqual(M.COLUMNS[M.COLUMNS.length - 1].key, "decision", "处置列必须是最后一列");
  const css = fs.readFileSync(path.join(ROOT, "renderer", "style.css"), "utf8");
  assert.ok(/\.review-table td\.decision-col[^}]*position:\s*sticky/s.test(css), "样式表要把处置列固定在右侧");
  assert.ok(/right:\s*0/.test(css), "固定方向是 right: 0");

  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const tagged = dom.all(container, []).filter((n) => String(n.className).includes("decision-col"));
  assert.ok(tagged.length >= 2, "表头与每个数据行的处置格都要带 decision-col：" + tagged.length);
  assert.ok(tagged.some((n) => n.tagName === "TH"), "表头要带 decision-col（sticky 表头才不会错位）");
});

t("**疑似说明必须能换行显示**（用户实测：只看到「…；库里候」就没了，拖到底也不行）", async () => {
  // 根因：全局 `th, td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px }`
  // 会把疑似说明截断。这里用静态断言钉住覆盖规则，防止以后有人删掉。
  const css = fs.readFileSync(path.join(ROOT, "renderer", "style.css"), "utf8");
  assert.ok(/th,\s*td\s*\{[^}]*white-space:\s*nowrap/s.test(css), "全局 td 的 nowrap 规则应还在（本覆盖针对它）");
  assert.ok(/\.suspect-box\s*\{[^}]*white-space:\s*normal/s.test(css),
    "suspect-box 必须 white-space: normal（否则长文本被截断）");
  // 可能有多条 td.decision-col 规则（基础 sticky 规则 + 换行覆盖规则）→ 找"覆盖规则"那一条
  const decisionRules = css.match(/\.review-table td\.decision-col[^{]*\{[^}]*\}/gs) || [];
  assert.ok(decisionRules.length >= 1, "应有 td.decision-col 的规则");
  const joined = decisionRules.join("\n").replace(/\s+/g, " ");
  const wrapRule = decisionRules.find((r) =>
    /white-space:\s*normal/.test(r) && /overflow:\s*visible/.test(r) && /max-width:\s*none/.test(r));
  assert.ok(wrapRule, "应有一条把处置列改成「换行 + 不截断」的覆盖规则，实际：" + joined);
  assert.ok(/min-width:\s*2\d\dpx/.test(joined), "处置列要有足够宽度给长身份信息：" + joined);

  // 页面上疑似单元额外带 title（悬停可看全文）
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const box = dom.all(container, []).find((n) => String(n.className).includes("suspect-box"));
  assert.ok(box, "疑似行应有 suspect-box");
  assert.ok(/对账单这一行：/.test(String(box.title || "")), "悬停提示也应带完整说明：" + box.title);
});

t("门禁文案要告诉用户**去哪儿点**（不只是「需要裁决」）", () => {
  const M = require(MODEL);
  const rows = M.buildRows(PARSED);
  const text = M.gateText(rows);
  assert.ok(/需要你裁决/.test(text), text);
  assert.ok(/处置/.test(text), "要说清在「处置」列点：" + text);
  assert.ok(/是同一颗|不是同一颗/.test(text), "要给出按钮的名字：" + text);
  assert.ok(/只看待裁决/.test(text), "要提到筛选开关：" + text);
  assert.ok(!text.includes("**"), "界面文案不得含 markdown 星号");
});

t("「只看待裁决的行」开关：勾上只剩疑似行，取消恢复全部（73 行里找第 56 行的痛点）", async () => {
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const countRows = () => dom.all(container, []).filter((n) => n.tagName === "TR").length - 1; // 减表头

  assert.strictEqual(countRows(), 3, "默认显示全部 3 行");
  const box = dom.all(container, []).find((n) => n.id === "statement-only-pending");
  assert.ok(box, "要有「只看待裁决的行」复选框");
  box.checked = true;
  box.fire("change");
  assert.strictEqual(countRows(), 1, "勾上只剩疑似那 1 行");
  const body = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/待裁决/.test(body), "留下的是疑似行");
  box.checked = false;
  box.fire("change");
  assert.strictEqual(countRows(), 3, "取消勾选恢复全部");
});

/* ------------------------------------------------------------ 用例 */

t("页面自带两个关键控件：选择按钮与「确认入库」，且入库**默认禁用**（还没选文件）", () => {
  const { dom, container } = load();
  const pick = dom.findByText(container, "选择对账单");
  const commit = dom.findByText(container, "确认入库");
  assert.ok(pick, "应有「选择对账单」按钮");
  assert.ok(commit, "应有「确认入库」按钮");
  assert.strictEqual(commit.disabled, true, "还没选文件时不得可点");
  assert.ok(/选择对账单（\.xls）/.test(dom.all(container, []).map((n) => n.textContent).join(" ")),
    "应有初始提示（状态行要写清该点哪个按钮）");
});

t("选文件 → 调 statementParse → 渲染 3 行三桶表格", async () => {
  const { dom, container, calls } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.parse.length, 1, "应调用一次 statementParse");
  assert.strictEqual(calls.parse[0].file_path, "E:\\kke\\stmt.xls");
  const texts = dom.all(container, []).map((n) => n.textContent);
  assert.ok(texts.includes("命中"), "应有「命中」桶");
  assert.ok(texts.includes("疑似"), "应有「疑似」桶");
  assert.ok(texts.includes("新增"), "应有「新增」桶");
  assert.ok(texts.some((x) => /待裁决/.test(x)), "疑似行应显示「待裁决」");
});

t("**疑似未裁决 → 入库按钮禁用**，门禁文案写明「需要你裁决」（人工闸门落到按钮）", async () => {
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const commit = dom.findByText(container, "确认入库");
  assert.strictEqual(commit.disabled, true, "还有疑似未裁决时必须禁用");
  const gate = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/需要你裁决/.test(gate), "门禁文案应说明需要裁决：" + gate);
  assert.ok(!/\*\*/.test(gate), "界面文字里不能出现 markdown 星号");
});

t("裁决疑似（不是同一颗→新建）→ 门禁变为可提交，且**提交内容正确**", async () => {
  const { dom, container, calls } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const notIt = dom.findByText(container, "不是同一颗 → 新建一条");
  assert.ok(notIt, "疑似行应有「不是同一颗 → 新建一条」按钮");
  notIt.fire("click");
  const commit = dom.findByText(container, "确认入库");
  assert.strictEqual(commit.disabled, false, "裁决完应可提交");
  commit.fire("click");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.commit.length, 1, "应调用一次 statementCommit");
  // 用 JSON 比较而不是 deepStrictEqual：页面在 vm 沙箱里跑，跨 realm 的对象原型不同，
  // deepStrictEqual 会因为"原型不同"而失败（内容其实一致）——这是测试写法问题，不是页面问题。
  assert.strictEqual(
    JSON.stringify(calls.commit[0].decisions),
    JSON.stringify([
      { row_no: 2, action: "merge", part_id: "p_0001" },
      { row_no: 3, action: "new" },
      { row_no: 6, action: "new" },
    ]),
    "提交的决定应与表格状态一致：" + JSON.stringify(calls.commit[0].decisions),
  );
  const done = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/入库完成/.test(done), "应显示入库汇总：" + done);
});

t("**勾选部分入库**（用户 2026-10-17「默认全选」）：默认全勾；取消一行 → 该行不进提交", async () => {
  const { dom, container, calls } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const boxes = () => dom.all(container, []).filter((n) => n.tagName === "INPUT" && n.type === "checkbox");
  const rowBoxes = () => boxes().filter((n) => /^statement-select-\d+$/.test(String(n.id)));
  assert.strictEqual(rowBoxes().length, 3, "3 行应有 3 个「入库」勾选框");
  assert.ok(rowBoxes().every((b) => b.checked === true), "默认应全部勾选（用户要求：默认全选）");
  const head = boxes().find((n) => n.id === "statement-select-all");
  assert.ok(head, "表头应有「全选」勾选框");
  assert.strictEqual(head.checked, true, "全选框默认勾上");

  // 先裁决疑似（否则不能提交），再取消勾选一条「新增」行
  dom.findByText(container, "不是同一颗 → 新建一条").fire("click");
  const row6 = rowBoxes().find((b) => b.id === "statement-select-6");
  assert.ok(row6, "第 6 行应有勾选框");
  row6.checked = false;
  row6.fire("change");
  const gate = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/未勾选 1 条/.test(gate), "门禁要显示未勾选条数：" + gate);
  const head2 = boxes().find((n) => n.id === "statement-select-all");
  assert.strictEqual(head2.checked, false, "有一行没勾时，全选框不应再是勾上的");

  const commit = dom.findByText(container, "确认入库");
  assert.strictEqual(commit.disabled, false, "还有勾选的行 → 可以入库");
  commit.fire("click");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(
    JSON.stringify(calls.commit[0].decisions),
    JSON.stringify([
      { row_no: 2, action: "merge", part_id: "p_0001" },
      { row_no: 3, action: "new" },
    ]),
    "未勾选的行不能进提交：" + JSON.stringify(calls.commit[0].decisions),
  );
});

t("「全选」一键全不选 → 入库按钮禁用并提示去哪勾；再一键全选 → 恢复可提交", async () => {
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const headBox = () => dom.all(container, []).filter((n) => n.tagName === "INPUT" && n.type === "checkbox")
    .find((n) => n.id === "statement-select-all");

  // 先裁决疑似，避免"疑似未裁决"混进来干扰判断
  dom.findByText(container, "不是同一颗 → 新建一条").fire("click");
  const commit = dom.findByText(container, "确认入库");
  assert.strictEqual(commit.disabled, false, "全选且裁决完 → 可提交");

  const head = headBox();
  head.checked = false;
  head.fire("change");
  assert.strictEqual(dom.findByText(container, "确认入库").disabled, true, "一条都没勾 → 不得入库");
  const text = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/还没有勾选/.test(text), "文案要说清没勾选、在哪勾：" + text);

  const head2 = headBox();
  head2.checked = true;
  head2.fire("change");
  assert.strictEqual(dom.findByText(container, "确认入库").disabled, false, "全选后恢复可提交");
});

t("入库成功后按钮保持禁用；同一批再点**不会再次提交**（对抗审计 A2 的 UI 一层）", async () => {
  const { dom, container, calls } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  dom.findByText(container, "不是同一颗 → 新建一条").fire("click");
  const commit = dom.findByText(container, "确认入库");
  assert.strictEqual(commit.disabled, false, "裁决完应可提交");
  commit.fire("click");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.commit.length, 1, "第一次应提交");
  assert.strictEqual(dom.findByText(container, "确认入库").disabled, true,
    "入库成功后按钮必须保持禁用（这批已经入过库）");
  dom.findByText(container, "确认入库").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.commit.length, 1, "第二次点击不得再次提交（否则数量翻倍）");
  const text = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/已入库/.test(text), "状态行应说明这批已入库：" + text);
});

t("**解析提示不再塞进表格上方**（用户实测：导入后 UI 巨大变化 / 滚动条一开始没有、操作一下才出现）", async () => {
  // 真实对账单 25 行会产生 11 条、600+ 字提示；原来被塞进表格上方的错误行 → 表格被顶下去，
  // 一次交互 showError("") 清掉后又整块上移。现在：提示单独一块、放**表格之后**、默认折叠。
  const canned = JSON.parse(JSON.stringify(PARSED));
  canned.warnings = [
    "第 3 行：商品名称里没有参数值，按约定用「商品型号」M2 作为值（可在核对表里改）",
    "第 6 行：商品名称里没有参数值，按约定用「商品型号」M3 作为值（可在核对表里改）",
  ];
  const { dom, container } = load(canned);
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));

  const byId = (id) => dom.all(container, []).find((n) => n.id === id);
  const box = byId("statement-warnings");
  const toggle = byId("statement-warnings-toggle");
  const body = byId("statement-warnings-body");
  const errorBox = byId("statement-error");
  assert.ok(box && toggle && body, "应有独立的解析提示区（摘要 + 逐条）");
  assert.strictEqual(box.hidden, false, "有提示时提示区应显示");
  assert.ok(/解析提示 2 条/.test(toggle.textContent), "摘要要说清有几条：" + toggle.textContent);
  assert.strictEqual(body.hidden, true, "默认折叠（不占多行）");
  assert.ok(!/商品型号/.test(String(errorBox.textContent || "")), "提示不许再塞进错误行（那会顶动表格）：" + errorBox.textContent);

  // 顺序：提示区必须在表格容器**之后**（出现/消失/展开都不移动表格）
  const all = dom.all(container, []);
  const scrollerIndex = all.findIndex((n) => n.id === "statement-body");
  const boxIndex = all.findIndex((n) => n.id === "statement-warnings");
  assert.ok(scrollerIndex >= 0 && boxIndex > scrollerIndex, "提示区要排在表格容器之后，否则又会把表格顶下去");

  // 点开 → 逐条可见；再点 → 收起
  toggle.fire("click");
  assert.strictEqual(body.hidden, false, "点开后应显示逐条");
  assert.strictEqual(dom.all(body, []).filter((n) => n.tagName === "LI").length, 2, "应有 2 条");
  toggle.fire("click");
  assert.strictEqual(body.hidden, true, "再点应收起");

  // **交互不会把提示清掉**（以前 showError("") 会连提示一起清）
  dom.findByText(container, "不是同一颗 → 新建一条").fire("click");
  const box2 = byId("statement-warnings");
  assert.ok(box2 && box2.hidden === false, "操作一行之后提示区仍在（不是被误清）");
});

t("解析失败时提示区一并清空（失败不显示上一次的提示）", async () => {
  const { dom, container } = load({ ok: false, error: "不是立创商城的物料明细对账单：缺少表头 商品名称", items: [], warnings: [] });
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const box = dom.all(container, []).find((n) => n.id === "statement-warnings");
  assert.ok(box && box.hidden === true, "解析失败时提示区应隐藏");
});

t("选到不是对账单的文件 → 明确报错、表格清空、按钮仍禁用（不假装成功）", async () => {
  const { dom, container } = load({ ok: false, error: "不是立创商城的物料明细对账单：缺少表头 商品名称", items: [], warnings: [] });
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const text = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/物料明细对账单/.test(text), "应把后端的报错显示出来：" + text);
  assert.strictEqual(dom.findByText(container, "确认入库").disabled, true, "失败后不得可点");
});

/* ------------------------------------ 用户第二次实测反馈（2026-10-16 晚） */

t("**回归**：bomPickFiles 的返回**按契约解包**（{ ok, file_paths }）——不许再被误报成「已取消」", async () => {
  // 用户实测：选完文件后显示"没有选择文件（已取消）"。真因是我把返回当裸数组解包，
  // paths.length 为 undefined → 落到"取消"分支（对话框其实是好的）。
  const { dom, container, calls } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.parse.length, 1, "应按契约取到 file_paths[0] 并解析");
  assert.strictEqual(calls.parse[0].file_path, "E:\\kke\\stmt.xls");
  const texts = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(!/已取消/.test(texts), "取到文件后不该说已取消：" + texts);
});

t("返回 ok:false 或 file_paths 为空 → 分别是「失败」与「取消」，不混为一谈", async () => {
  const failed = load(null, (api) => { api.bomPickFiles = async () => ({ ok: false, error: "对话框打不开" }); });
  failed.dom.findByText(failed.container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  let texts = failed.dom.all(failed.container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/对话框打不开/.test(texts), "应显示真实失败原因：" + texts);
  assert.ok(!/已取消/.test(texts), "失败不能说成取消：" + texts);

  const cancelled = load(null, (api) => { api.bomPickFiles = async () => ({ ok: true, file_paths: [] }); });
  cancelled.dom.findByText(cancelled.container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  texts = cancelled.dom.all(cancelled.container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/已取消/.test(texts), "真的取消才显示已取消：" + texts);
});

t("**回归**：`.page[hidden]` 必须 `display:none`——否则所有页面一直堆着（用户实测）", () => {
  // 用户实测："打开 bom，然后再打开设置，BOM 页没关，同时只有一个页面存在"。
  // 根因：style.css 里 `.page { display: block; }` 是**作者样式**，优先级高于 UA 的 `[hidden]`，
  // 于是 hidden 属性形同虚设，所有页面都显示。
  const css = fs.readFileSync(path.join(ROOT, "renderer", "style.css"), "utf8");
  assert.ok(/\.page\s*\{\s*display:\s*block/.test(css), "前提：.page 有 display:block（所以才必须显式压回 hidden）");
  assert.ok(/\.page\[hidden\]\s*\{\s*display:\s*none/.test(css),
    "style.css 必须显式写 .page[hidden] { display: none; }，否则 hidden 属性不起作用");
});

t("**人工可改**：可改列是真输入框；改完提交时带上 overrides（否则等于假编辑）", async () => {
  const { dom, container, calls } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));

  // 还有疑似未裁决时入库按钮是禁用的（人工闸门）——先裁决掉，否则点入库不会提交
  dom.findByText(container, "不是同一颗 → 新建一条").fire("click");
  // **注意**：裁决会让表格重画，所以下面必须**重新取**节点（第一版抓的旧引用已脱离文档，
  // 改它的 value 等于改了个空气 —— 提交里自然就没有 overrides）。
  const pickCells = () => dom.all(container, []).filter((n) => n.tagName === "INPUT" && String(n.className).includes("edit-cell"));
  const cells = pickCells();
  assert.ok(cells.length >= 6, "可改字段应渲染成输入框（每行 6 个：值/容差/耐压/型号/封装/入库量），实际 " + cells.length);
  const intake = cells.find((n) => n.dataset && n.dataset.field === "intake_quantity");
  assert.ok(intake, "本次入库量应是可改输入框");
  assert.strictEqual(intake.value, "50", "初值 = 订购数量");

  // 改完也会重画 → 每次都重新取节点
  let box = pickCells().find((n) => n.dataset && n.dataset.field === "intake_quantity");
  box.value = "8";
  box.fire("change");
  const commit = dom.findByText(container, "确认入库");
  assert.strictEqual(commit.disabled, false, "裁决后应可提交");
  commit.fire("click");
  await new Promise((r) => setImmediate(r));
  const d = calls.commit[0].decisions.find((x) => x.row_no === 2);
  // 用 JSON 比较：提交对象来自 vm 沙箱，跨 realm 的 deepStrictEqual 会因原型不同而失败（值其实一致）
  assert.strictEqual(JSON.stringify(d.overrides), JSON.stringify({ intake_quantity: 8 }),
    "人工改的入库量必须提交上去：" + JSON.stringify(d.overrides));
});

t("**人工可改**：非法数量被拒 → 报错 + 格子恢复原值（不假装改成功）", async () => {
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const pick = (n) => n.tagName === "INPUT" && n.dataset && n.dataset.field === "intake_quantity";
  const intake = dom.all(container, []).find(pick);
  intake.value = "-3";
  intake.fire("change");
  const texts = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/不能为负/.test(texts), "应报错：" + texts);
  assert.strictEqual(dom.all(container, []).find(pick).value, "50", "拒绝后格子应恢复原值");
});

/* ------------------------------------------- 用户实测反馈的两条（2026-10-16） */

t("疑似处置把「谁是谁」说清：分别写出对账单这一行与库里候选，按钮是完整句子（用户反馈表述不清）", async () => {
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const text = dom.all(container, []).map((n) => n.textContent).join(" | ");

  // ① 两个"是谁"都要在页面上：
  assert.ok(/对账单这一行：/.test(text), "要写出对账单这一行的身份：" + text);
  assert.ok(/库里候选：/.test(text), "要写出库里候选的身份：" + text);
  // ② 候选身份要具体到值/封装/库存/编号（不能只有 part_id）
  assert.ok(/p_0007/.test(text), "候选要带库中编号：" + text);
  assert.ok(/库存 5/.test(text), "候选要带当前库存：" + text);
  assert.ok(/22uF \/ 1206/.test(text), "候选要带值/封装：" + text);
  assert.ok(/差在哪：/.test(text), "差异要明说（差在哪）：" + text);
  // ③ 按钮是完整句子，不再用"就是它/不是它"
  assert.ok(dom.findByText(container, "是同一颗 → 合并进库里这条"), "要有「是同一颗 → 合并进库里这条」");
  assert.ok(dom.findByText(container, "不是同一颗 → 新建一条"), "要有「不是同一颗 → 新建一条」");
  assert.ok(!/就是它|不是它（/i.test(text), "旧的含糊文案不该再出现：" + text);
});

t("**裁决后就地反馈**：行高亮 + 处置格「已选择」徽标 + 状态行说明；可「改选」回到未裁决（用户：反馈差）", async () => {
  const { dom, container } = load();
  dom.findByText(container, "选择对账单").fire("click");
  await new Promise((r) => setImmediate(r));
  const byId = (id) => dom.all(container, []).find((n) => n.id === id);
  const rowEl = () => dom.all(container, []).find((n) => n.tagName === "TR" && n.dataset && String(n.dataset.row) === "3");

  // —— 点「是同一颗 → 合并进库里这条」
  dom.findByText(container, "是同一颗 → 合并进库里这条").fire("click");
  await new Promise((r) => setImmediate(r));
  const tr = rowEl();
  assert.ok(tr, "第 3 行应还在表里");
  assert.ok(/decided-merge/.test(String(tr.className)), "裁决完整行要有底色（类名 decided-merge）：" + tr.className);
  const badge = byId("statement-decided-3");
  assert.ok(badge, "处置格应出现「已选择」徽标");
  assert.ok(/已选择：合并进库里这条/.test(badge.textContent) && /p_0007/.test(badge.textContent),
    "徽标要写清选了什么（含库中编号）：" + badge.textContent);
  const status = byId("statement-status").textContent;
  assert.ok(/第 4 行已标记：合并进库里这条（p_0007）/.test(status), "状态行要就地说明刚点了什么：" + status);
  assert.ok(dom.findByText(container, "改选（回到未裁决）"), "应提供「改选」按钮（点错能改）");

  // —— 点「改选」→ 回到待裁决（按钮回来、行底色去掉、提交重新被拦）
  dom.findByText(container, "改选（回到未裁决）").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.ok(!/decided-merge/.test(String(rowEl().className)), "改选后行底色应去掉：" + rowEl().className);
  assert.ok(!byId("statement-decided-3"), "改选后「已选择」徽标应消失");
  assert.ok(/第 4 行已改回「待裁决」/.test(byId("statement-status").textContent), "状态行要说明已改回：" + byId("statement-status").textContent);
  assert.strictEqual(dom.findByText(container, "确认入库").disabled, true, "回到待裁决后入库按钮应重新禁用");
  assert.ok(dom.findByText(container, "是同一颗 → 合并进库里这条"), "改选后应重新出现两个裁决按钮");
});

t("**回归**：每一步都要有状态反馈（点选择 → 已选路径 → 解析结果）", async () => {
  // 用户实测："选择器选了没反应"。根因之一是中途没有任何可见反馈，
  // 只有解析成功才画表格，失败只有页面底部一行小字。
  // 断言方式：把解析换成一个"我先不给结果"的 promise，才能观察到中间态。
  let release = null;
  const { dom, container } = load(null, (api) => {
    api.statementParse = () => new Promise((resolve) => { release = resolve; });
  });
  dom.findByText(container, "选择对账单").fire("click");
  let texts = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/正在打开文件选择框/.test(texts), "点选择时应立刻有反馈：" + texts);

  await new Promise((r) => setImmediate(r)); // 让 bomPickFiles 的 promise 落地
  texts = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/已选：/.test(texts), "选完文件后应立刻显示已选路径与进度：" + texts);
  assert.ok(/正在解析/.test(texts), "应显示正在解析：" + texts);

  release({ ok: true, items: [], matched: [], suspected: [], missing: [], warnings: [] });
  await new Promise((r) => setImmediate(r));
  texts = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/已解析 0 条/.test(texts), "解析完应写清条数：" + texts);
});

t("**回归**：preload 没暴露接口时明确报错并禁用按钮（不让它变成「点了没反应」）", () => {
  const { dom, container } = load(null, (api) => { delete api.statementParse; });
  const texts = dom.all(container, []).map((n) => n.textContent).join(" | ");
  assert.ok(/接口缺失/.test(texts), "应明确说接口缺失：" + texts);
  assert.ok(/重新打开/.test(texts), "应告诉用户怎么办（完全退出再打开）：" + texts);
  assert.strictEqual(dom.findByText(container, "确认入库").disabled, true, "接口缺失时不得可点");
  assert.strictEqual(dom.findByText(container, "选择对账单").disabled, true, "接口缺失时选择按钮也该禁用");
});

t("**回归**：对账单页必须是「独立页面」——与其它页一样带 hidden 与统一 header 结构", () => {
  // 用户实测："每一项任务点击都直接加在面板下面"。根因：我插入的 <section> 漏了 hidden，
  // 于是它在启动时就露出来、堆在当前页面下方。
  const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  const sections = [...html.matchAll(/<section id="(page-[\w-]+)" class="page"([^>]*)>/g)];
  assert.ok(sections.length >= 8, "应能解析出全部页面段落，实际 " + sections.length);
  for (const [, id, attrs] of sections) {
    if (id === "page-inventory") continue;
    assert.ok(/hidden/.test(attrs), `${id} 缺少 hidden（会堆在其它页面下方）`);
  }
  const stmt = sections.find(([, id]) => id === "page-statement");
  assert.ok(stmt && /hidden/.test(stmt[2]), "对账单页必须带 hidden");
  assert.ok(/<section id="page-statement" class="page" hidden>[\s\S]*?<header class="page-head">[\s\S]*?<h1>按对账单入库<\/h1>/.test(html),
    "对账单页应使用与其它页一致的 header/h1 结构");
});

/* ------------------------------------------- 两条静态回归（上轮两个真 bug） */

t("**回归**：index.html 里 model 脚本必须在 page 脚本**之前**（否则页面挂载即崩）", () => {
  const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  const iModel = html.indexOf("model/statement_model.js");
  const iPage = html.indexOf("pages/statement_page.js");
  assert.ok(iModel !== -1, "index.html 必须引入 model/statement_model.js");
  assert.ok(iPage !== -1, "index.html 必须引入 pages/statement_page.js");
  assert.ok(iModel < iPage, "模型脚本必须在页面脚本之前加载（上轮就是这里漏了，页面一挂载就崩）");
});

t("**回归**：app.js 的 mounted.stock 必须在 stock 分支里、statement 用**独立守卫**", () => {
  const app = fs.readFileSync(path.join(ROOT, "renderer", "app.js"), "utf8");
  // stock 分支现在同时负责「是否挂载」和「是否带着库存页点来的器件」两件事：
  // 先定位整个分支，再查内部守卫（上一轮 mounted.stock 被挪到 statement 分支，导致先访问对账单页后领料页永不挂载）
  const m = /if \(name === "stock"\) \{([\s\S]*?)\n  \}/.exec(app);
  assert.ok(m, "应能定位 stock 分支");
  assert.ok(/if \(!mounted\.stock\) \{/.test(m[1]), "stock 分支内必须有「未挂载才挂载」的守卫");
  assert.ok(/mounted\.stock = true;/.test(m[1]), "mounted.stock 必须在 stock 分支内");
  assert.ok(/if \(name === "statement" && !mounted\.statement\)/.test(app), "statement 页应有自己的挂载守卫");
  assert.ok(/statement: false/.test(app), "mounted 表里应有 statement");
});

(async () => {
  for (const item of QUEUE) {
    try { await item.fn(); passCount += 1; console.log("  PASS  " + item.name); }
    catch (exc) {
      failures.push(item.name);
      console.log("  FAIL  " + item.name + "\n        " + String(exc.message).split("\n")[0]);
    }
  }
  console.log("\n" + "=".repeat(64));
  console.log(`T51（对账单入库页 + 静态回归）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
