"use strict";
/**
 * test_main_wiring.js — T11（plan §9 的 T1）里**能无头验证的那一半**：main.js 的接线。
 *
 * 运行： node tests/test_main_wiring.js
 *
 * ⚠️ 先说清楚它**不能**证明什么：
 *   它不能证明"双击能出窗口"。本机（沙箱环境）**Electron 根本起不来**——
 *   连一个 10 行的最小 Electron 应用都以 0x80000003 退出（实测见 evidence），
 *   那是环境限制，不是本项目的缺陷。"能不能出窗口"只能由用户在自己的桌面上双击验证，
 *   或跑 `electron . --smoke --smoke-out=结果.json`（本任务新增的启动自检，会写出 window_ms 与 NFR-1 判定）。
 *
 * 它**能**证明的是接线没接错（这些错在真机上往往要等到点按钮才暴露）：
 *   · 15 个通道**全部**注册到 ipcMain（数量与名单与 plan §6 一致）
 *   · BrowserWindow 的 webPreferences 确实是 contextIsolation + 无 nodeIntegration
 *   · preload 路径与 index.html 路径**在磁盘上真实存在**（写错路径 = 白屏）
 *   · 离线拦截确实装上了（http/https/ws/ftp 全拦）——spec FR-6.1
 *   · ready-to-show 时会 show()，并写出 smoke 结果文件（NFR-1 的用时里就有它）
 *   · 通道真能跑通：直接 invoke 已注册的 settings:get → {ok:true} 且 14 类阈值（数据写在临时目录）
 *
 * 做法：把 `require("electron")` 换成桩模块（Module._load 钩子），再 require main.js。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_main_"));
// 加载时先拍真实 data/ 的快照，套件跑完再比对（见 tests/real_data_guard.js）
const { createRealDataGuard } = require("./real_data_guard");
const REAL_DATA = createRealDataGuard(PROJECT_ROOT);
process.env.CM_BASE_DIR = TMP; // 数据写临时目录，绝不碰真实 data/

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

/* ------------------------------------------------------------ Electron 桩 */

const recorded = {
  handled: new Map(),          // 通道 → 注册进去的 handler
  windowOptions: null,         // BrowserWindow 构造参数
  loadedFile: null,            // loadFile 的目标
  shown: false,                // show() 是否被调用
  readyListeners: [],          // once("ready-to-show") 的回调
  webPreferences: null,
  networkFilter: null,         // webRequest.onBeforeRequest 的 urls
  networkHandler: null,        // 拦截回调
  readyCalled: false,
  windowOpenHandler: undefined, // setWindowOpenHandler 装的回调（undefined = 没装）
  contentEvents: {},            // webContents.on 订阅过的事件名 → 次数
};

class FakeWebContents {
  constructor() { this.listeners = {}; }
  on(event, cb) {
    (this.listeners[event] = this.listeners[event] || []).push(cb);
    recorded.contentEvents[event] = (recorded.contentEvents[event] || 0) + 1;
    return this;
  }
  once(event, cb) { return this.on(event, cb); }
  /** 审计 R3 发现②：真实 Electron 有这个 API，桩也必须建模，否则装没装都测不出来 */
  setWindowOpenHandler(handler) { recorded.windowOpenHandler = handler; return this; }
  /** 触发某个已订阅的 webContents 事件（给断言用） */
  emit(event, ...args) {
    for (const cb of (this.listeners[event] || [])) cb(...args);
  }
}

class FakeBrowserWindow {
  constructor(options) {
    recorded.windowOptions = options;
    recorded.webPreferences = options && options.webPreferences;
    this.webContents = new FakeWebContents();
    this.listeners = {};
    FakeBrowserWindow.__last = this; // 供测试触发 ready-to-show
  }
  loadFile(target) { recorded.loadedFile = target; return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  once(event, cb) { (this.listeners[event] = this.listeners[event] || []).push(cb); return this; }
  on(event, cb) { (this.listeners[event] = this.listeners[event] || []).push(cb); return this; }
  show() { recorded.shown = true; }
  removeMenu() {}
  static getAllWindows() { return []; }
}

const fakeElectron = {
  app: {
    whenReady: () => { recorded.readyCalled = true; return Promise.resolve(); },
    on() {},
    quit() {},
    getPath: () => TMP,
  },
  BrowserWindow: FakeBrowserWindow,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: { handle: (channel, fn) => recorded.handled.set(channel, fn) },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest: (filter, cb) => { recorded.networkFilter = filter; recorded.networkHandler = cb; },
      },
    },
  },
};

// 只拦 "electron" 这一个模块名，其余照常加载
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const SMOKE_OUT = path.join(TMP, "smoke.json");
process.argv.push("--smoke", `--smoke-out=${SMOKE_OUT}`);

require("../src/main.js");

/* ------------------------------------------------------------------ 用例 */

section("§1 启动流程（用桩 Electron 跑 main.js）");

t("app.whenReady 被调用，且通道清单里的通道全部注册到 ipcMain", async () => {
  await new Promise((r) => setImmediate(r)); // 等 whenReady().then(...) 跑完
  assert.strictEqual(recorded.readyCalled, true, "没有走 app.whenReady");
  const { CHANNELS } = require("../src/ipc/channels");
  assert.strictEqual(recorded.handled.size, CHANNELS.length, `注册了 ${recorded.handled.size} 个通道`);
  for (const channel of CHANNELS) {
    assert.ok(recorded.handled.has(channel), "未注册通道：" + channel);
  }
});

t("BrowserWindow 的安全选项：contextIsolation 开、nodeIntegration 关", () => {
  assert.ok(recorded.webPreferences, "没捕获到 webPreferences");
  assert.strictEqual(recorded.webPreferences.contextIsolation, true);
  assert.strictEqual(recorded.webPreferences.nodeIntegration, false,
    "渲染进程绝不能拿到 require（AGENTS.md：禁 require('fs')）");
});

t("preload 与 index.html 的路径**真实存在**（写错就是白屏）", () => {
  const preload = recorded.webPreferences.preload;
  assert.ok(path.isAbsolute(preload), "preload 应是绝对路径：" + preload);
  assert.ok(fs.existsSync(preload), "preload 不存在：" + preload);
  assert.ok(recorded.loadedFile, "没有 loadFile");
  assert.ok(fs.existsSync(recorded.loadedFile), "页面不存在：" + recorded.loadedFile);
  assert.ok(recorded.loadedFile.endsWith(path.join("renderer", "index.html")), recorded.loadedFile);
});

t("离线拦截已装上：http/https/ws/ftp 全覆盖（spec FR-6.1）", () => {
  assert.ok(recorded.networkFilter, "没有安装 webRequest 拦截");
  const urls = recorded.networkFilter.urls.join(" ");
  for (const scheme of ["http://", "https://", "ws://", "wss://", "ftp://"]) {
    assert.ok(urls.includes(scheme), "未拦截 " + scheme);
  }
  // 拦截回调必须 cancel，而不是放行
  let decision = null;
  recorded.networkHandler({ url: "https://example.com/x" }, (d) => { decision = d; });
  assert.deepStrictEqual(decision, { cancel: true }, "外部请求必须被取消");
});

t("离线拦截**还有两道闸**：新窗口一律拒绝 + 顶层导航只许自己的页面（审计 R3 发现②）", () => {
  const wc = FakeBrowserWindow.__last.webContents;
  // ① 新窗口：必须装了 handler，且对任何 URL 都返回 deny
  assert.strictEqual(typeof recorded.windowOpenHandler, "function",
    "没有装 setWindowOpenHandler —— 只剩\"页面自己不发请求\"这种自觉，不符合 FR-6.1");
  assert.deepStrictEqual(recorded.windowOpenHandler({ url: "https://example.com/" }), { action: "deny" });
  assert.deepStrictEqual(recorded.windowOpenHandler({ url: "file:///C:/other.html" }), { action: "deny" });

  // ② 顶层导航：外部地址必须被 preventDefault
  assert.ok(recorded.contentEvents["will-navigate"] >= 1, "没有订阅 will-navigate");
  let prevented = 0;
  const fakeEvent = { preventDefault: () => { prevented += 1; } };
  wc.emit("will-navigate", fakeEvent, "https://example.com/evil");
  assert.strictEqual(prevented, 1, "外部导航必须被阻止");
  // 自己的页面必须放行（否则页面自己就跳不动了）
  const allowed = { preventDefault: () => { prevented += 1; } };
  wc.emit("will-navigate", allowed, "file:///" + recorded.loadedFile.replace(/\\/g, "/"));
  assert.strictEqual(prevented, 1, "导航到自己的 index.html 不该被阻止");
});

section("§2 ready-to-show：显示窗口 + 写 smoke 结果（NFR-1）");

t("触发 ready-to-show → show() 被调用，且 smoke 结果文件写出且 ok:true", async () => {
  const windowInstance = recorded.windowOptions ? true : false;
  assert.ok(windowInstance, "没构造出窗口");
  const listeners = FakeBrowserWindow.__last;
  assert.ok(listeners, "拿不到窗口实例");
  const cbs = listeners.listeners["ready-to-show"];
  assert.ok(cbs && cbs.length > 0, "没有注册 ready-to-show");
  assert.strictEqual(recorded.shown, false, "显示前不该 show");
  for (const cb of cbs) cb();
  assert.strictEqual(recorded.shown, true, "ready-to-show 后应显示窗口");
  assert.ok(fs.existsSync(SMOKE_OUT), "没写出 smoke 结果文件");
  const payload = JSON.parse(fs.readFileSync(SMOKE_OUT, "utf8"));
  assert.strictEqual(payload.ok, true);
  // 数量取自清单（含已登记扩展），不写死——否则每次加通道都要来改这个数字
  assert.strictEqual(payload.channels, require("../src/ipc/channels").CHANNELS.length);
  assert.ok(typeof payload.window_ms === "number", "应记录启动用时（NFR-1）");
  assert.strictEqual(payload.nfr1_ok, true, `NFR-1 要求 ≤3000ms，实测 ${payload.window_ms}ms`);
});

section("§3 通道真的能跑通（main.js → handler → service → store）");

t("直接 invoke 已注册的 settings:get → ok:true 且 14 类阈值（数据在临时目录）", async () => {
  const fn = recorded.handled.get("settings:get");
  const r = await fn({}, {});
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(Object.keys(r.settings.default_min_quantity).length, 14);
  assert.ok(r.settings.default_min_quantity.C === 20, "默认阈值应来自 spec §5.3");
});

t("直接 invoke bom:parse（真实样本）→ 33 条，且**没有碰真实 data/**", async () => {
  const fn = recorded.handled.get("bom:parse");
  const r = await fn({}, { file_path: path.join(__dirname, "fixtures", "sample_bom"), sets: 1 });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.items.length, 33);
  // 快照比对：用户真的用过工具后 data/ 本就存在，那是正常使用；
  // 这里守的是"本套件运行期间没碰过真实库"（见 tests/real_data_guard.js）
  REAL_DATA.assertUnchanged("T11 main 接线套件");
});

/* ------------------------------------------------------------------ 执行 */

runQueue().then(() => {
  Module._load = originalLoad;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T11（main 接线）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
});
