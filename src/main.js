"use strict";
/**
 * main.js — Electron 主进程入口（plan §2 架构图的最外层）
 *
 * 只做四件事：开窗口、注册 IPC、拦网络、把 Electron 的对话框能力注入给 IPC 层。
 * **业务逻辑一行都不在这里**（那属于 src/services）。
 *
 * 离线（spec FR-6.1）在这里落成**机制**而不是口号：
 *   `session.webRequest.onBeforeRequest` 直接取消一切 http/https/ws/ftp 请求。
 *   即使将来有人误加了一个远程 URL（图片、字体、CDN），它也拉不下来，并且会在日志里留痕。
 *
 * 启动参数：
 *   `--smoke`  窗口 ready-to-show 后打印耗时并退出（供无 GUI 环境做启动验收，NFR-1）
 */

const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, dialog, ipcMain, session } = require("electron");

const { createHandlers, CHANNELS } = require("./ipc/handlers");
const storeSvc = require("./services/store");

/** 主界面文件：窗口加载用它，导航白名单也用它（**同一个常量**，免得两处写法漂移） */
const INDEX_HTML = path.join(__dirname, "..", "renderer", "index.html");

const SMOKE = process.argv.includes("--smoke");
/** `--smoke-out=<文件>`：把启动结果写到文件。
 *  为什么需要它：Windows 上 Electron 是 GUI 子系统程序，从控制台启动时 stdout 常常拿不到，
 *  于是"启动是否成功"就不能只靠打印。写文件让这件事可以被脚本与同伴复验（NFR-1 用时也一并记录）。 */
const smokeOutArg = process.argv.find((arg) => arg.startsWith("--smoke-out="));
const SMOKE_OUT = smokeOutArg ? smokeOutArg.slice("--smoke-out=".length) : "";
const STARTED_AT = Date.now();
let mainWindow = null;

/**
 * **防多开**（用户 2026-10-17 要求）：同一时间只允许**一个**主界面实例在跑。
 *
 * 为什么必须做：数据是 JSON 文件（parts.json / movements.json / settings.json），
 * 两个实例各自「读入 → 在内存里改 → 整文件覆盖写」；进程之间没有任何锁，
 * 后写的实例会把先写的数据**整个盖掉**（新入库的料/变动记录可能直接消失）——
 * 这是实打实的数据损坏风险，比"多开一个窗口"严重得多。
 *
 * 做法：Electron 单实例锁。
 *   · 拿不到锁（已有实例在跑）→ 直接退出；让**已有实例**把窗口拉到前台
 *     （这样用户双击图标也有反馈，而不是"点了没反应"）。
 *   · `--smoke` 是启动验收模式（自己会退出、且不写库），**不参与**单实例锁——
 *     否则用户在用着应用时，验收脚本会被挡掉。
 */
let gotSingleInstanceLock = true;
if (!SMOKE) {
  gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    // 第一个实例：用户又启动了一次 → 恢复/显示/聚焦已有窗口（绝不再开第二个窗口）
    app.on("second-instance", () => {
      if (!mainWindow) return;
      if (typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }
}

/** smoke 结果：控制台 + 可选文件（失败也要留痕，否则"没输出"会被误当成"通过了"） */
function reportSmoke(payload) {
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, payload));
  console.log(`[smoke] ${line}`);
  if (SMOKE_OUT) {
    try {
      fs.mkdirSync(path.dirname(SMOKE_OUT), { recursive: true });
      fs.writeFileSync(SMOKE_OUT, line, "utf8");
    } catch (exc) {
      console.error("[smoke] 写结果文件失败：", exc.message);
    }
  }
}

/**
 * spec FR-6.1：完全离线。
 *
 * **说清楚这段到底拦了什么**（审计 R3 发现②：原注释自称"拦截一切外部请求"，
 * 而实现只订阅了 5 种 URL scheme，且没管"新窗口/顶层导航"——**注释比实现更满**）：
 *   ① `onBeforeRequest`：拦 http/https/ws/wss/ftp 的**网络请求**（XHR/fetch/img/script…）
 *      ——`file:` 不能拦（那是我们自己加载 index.html 用的），`data:`/`blob:` 不是网络。
 *   ② `setWindowOpenHandler`：**一律拒绝**开新窗口（`<a target="_blank">`、`window.open`）。
 *   ③ `will-navigate`：**只允许**导航到我们自己的 index.html，其余（含外部 http/https）一律阻止。
 * ②③ 是这一轮补上的：没有它们，"离线"只覆盖"页面自己发起的请求"，
 * 而"跳到外部页面"这条路是敞着的（当前 CSP + 渲染层没有链接使其不易触达，但**机制该完整**）。
 */
function blockAllNetwork() {
  const filter = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"] };
  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    console.warn(`[offline] 已拦截外部请求（本应用完全离线）：${details.url}`);
    callback({ cancel: true });
  });
  console.log("[offline] 已启用外部请求拦截（FR-6.1）");
}

/** 允许渲染进程导航到的唯一地址：我们自己的 index.html */
function isOwnPage(target) {
  try {
    const url = new URL(String(target));
    if (url.protocol !== "file:") return false;
    // 用 fileURLToPath 而不是手工拼 pathname：Windows 上 `file:///E:/x` 的 pathname 是 `/E:/x`，
    // 直接交给 path.resolve 会解析成"当前盘符下的 \E:\x"（我第一版就这么写错了，被测试抓出来）。
    return path.resolve(fileURLToPath(url)).toLowerCase() === path.resolve(INDEX_HTML).toLowerCase();
  } catch (ignored) {
    return false; // 解析不了的地址一律不放行
  }
}

/** 给一个窗口装上"不许开新窗口、不许离开本页"的两道闸（见 blockAllNetwork 的说明） */
function lockNavigation(win) {
  if (!win || !win.webContents) return;
  // ② 新窗口一律拒绝（返回 deny 而不是让它自己开）
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[offline] 已阻止打开新窗口：${url}`);
    return { action: "deny" };
  });
  // ③ 顶层导航：只放行自己的页面
  win.webContents.on("will-navigate", (event, url) => {
    if (isOwnPage(url)) return;
    console.warn(`[offline] 已阻止页面跳转（本应用完全离线）：${url}`);
    event.preventDefault();
  });
  console.log("[offline] 已启用新窗口/导航拦截（FR-6.1）");
}

/** 打开系统文件选择框（唯一需要 Electron 的能力，注入给 IPC 层用） */
async function pickBomFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择表格文件（BOM / 对账单）",
    buttonLabel: "选择",
    properties: ["openFile", "multiSelections"],
    filters: [
      // .xls 是**真 BIFF8 老格式**（用户反馈"选择器识别不到 xls"后补上）：
      // 零依赖读取器见 src/services/xls_biff.js。立创对账单也是 .xls，
      // 但它不是 BOM——选进来会得到一条专门的提示（见 bom_parser.readTableRows）。
      { name: "表格文件（BOM / 对账单）", extensions: ["xlsx", "xls", "csv", "txt"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
}

function registerIpc() {
  // `CM_BASE_DIR`：数据目录覆盖。两个用途：①便携（把库放 U 盘/别处）；
  // ②让无头测试能把数据写进临时目录，**绝不碰真实 data/**（AGENTS.md 硬规则）。
  const baseDir = (process.env.CM_BASE_DIR || "").trim();
  const store = baseDir ? storeSvc.createStore({ base_dir: baseDir }) : undefined;
  const { handlers } = createHandlers(store ? { pick_files: pickBomFiles, store } : { pick_files: pickBomFiles });
  for (const channel of CHANNELS) {
    if (typeof handlers[channel] !== "function") {
      throw new Error(`IPC 通道未实现：${channel}（channels.js 与 handlers.js 不一致）`);
    }
    ipcMain.handle(channel, async (_event, payload) => handlers[channel](payload));
  }
  console.log(`[ipc] 已注册 ${CHANNELS.length} 个通道${baseDir ? `（数据目录：${baseDir}）` : ""}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false, // 先不显示，等 ready-to-show：避免白屏（NFR-1 的"可见"应是渲染完成的界面）
    title: "元器件管理",
    // 任务栏/标题栏图标（assets/icon.ico 由 tools/make_icon.py 生成；缺失时 Electron 用默认图标）
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // 渲染进程与 preload 隔离
      nodeIntegration: false, // 渲染进程拿不到 require（AGENTS.md：禁 require('fs')）
      // preload 需要 require 本项目的通道清单（./ipc/channels），故关掉进程级沙箱；
      // 渲染进程侧的安全边界仍由 contextIsolation + nodeIntegration:false 保证。
      sandbox: false,
      spellcheck: false,
      webSecurity: true,
    },
  });

  mainWindow.loadFile(INDEX_HTML);
  lockNavigation(mainWindow); // FR-6.1：不许开新窗口、不许跳走

  mainWindow.once("ready-to-show", () => {
    const ms = Date.now() - STARTED_AT;
    mainWindow.show();
    console.log(`[启动] 主界面可见，用时 ${ms} ms（NFR-1 要求 ≤ 3000 ms）`);
    if (SMOKE) {
      reportSmoke({ ok: true, window_ms: ms, channels: CHANNELS.length, nfr1_ok: ms <= 3000 });
      // 给渲染进程一点时间把 IPC 数据拉完，便于把错误暴露在 smoke 输出里
      setTimeout(() => app.quit(), 800);
    }
  });

  // 启动失败也要留痕：否则"没输出"会被误读成"通过了"
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (SMOKE) reportSmoke({ ok: false, stage: "did-fail-load", code, desc, url });
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    if (SMOKE) reportSmoke({ ok: false, stage: "render-process-gone", reason: details && details.reason });
  });
  mainWindow.webContents.on("console-message", (_e, level, message) => {
    if (SMOKE && level >= 2) console.log(`[renderer] ${message}`); // 2 = warning/error
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

// 拿不到单实例锁的第二个实例：**不建窗口、不注册 IPC**（上面已 app.quit()，马上退出）
if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    blockAllNetwork();
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    // 单窗口桌面工具：关窗即退出（macOS 习惯除外）
    if (process.platform !== "darwin") app.quit();
  });
}

// 任何未捕获异常都留痕（smoke 模式下尤其重要：GUI 程序崩了控制台可能什么都看不到）
process.on("uncaughtException", (err) => {
  reportSmoke({ ok: false, stage: "uncaughtException", error: String((err && err.stack) || err) });
  process.exitCode = 1;
  app.quit();
});
