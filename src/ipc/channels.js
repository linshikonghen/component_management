"use strict";
/**
 * channels.js — IPC 通道名单（**唯一清单**，plan §6）
 *
 * 为什么单独一个文件：这份名单有两个消费者——
 *   `ipc/handlers.js`（主进程注册）与 `preload.js`（渲染进程白名单暴露）。
 * 若各写一份，就会出现"主进程注册了但界面调不到"或"界面以为有、实际没注册"的漂移。
 * 放在这里，两边都 require 它，**名单只有一处**。
 *
 * 本文件**不 require 任何东西**（连 electron 都不）——它是纯数据，
 * 于是 preload 引用它不会把 fs / 业务代码带进预加载上下文。
 */

/** plan §6 的全部 IPC 通道（模块:动作）+ **已登记的契约扩展**（见 ./extensions.js） */
const { EXTENSION_CHANNELS } = require("./extensions");

const PLAN_CHANNELS = [
  "bom:pickFiles",
  "bom:parse",
  "bom:commit",
  "compare:run",
  "compare:export",
  "parts:list",
  "parts:save",
  "parts:delete",
  "parts:export",
  "stock:move",
  "stock:pick_by_bom",
  "movements:list",
  "settings:get",
  "settings:set",
  "data:backup",
  "data:restore",
  // 按对账单入库（用户 2026-10-16 需求，plan §6）——**只用入库**，不碰导出与比对
  "statement:parse",
  "statement:commit",
];

/**
 * 实际注册的通道 = plan §6 ∪ 已登记扩展。
 * 注意：`channels.js` 原先刻意"不 require 任何东西"（怕把 fs 带进 preload），
 * 但 `extensions.js` 是纯数据、且 channels.js 自己就要被 preload 引入，
 * 所以这里 require 它是安全的——preload 那条边界仍由"extensions 不 require 任何模块"保证。
 *
 * v1.5（实现期补记 2）：`parts:export` 已并入 plan §6，登记表随之清空（见 extensions.js）。
 */
const CHANNELS = PLAN_CHANNELS.concat(EXTENSION_CHANNELS);

/**
 * 通道名 → 渲染进程里的方法名（`parts:list` → `partsList`，`stock:pick_by_bom` → `stockPickByBom`）。
 * 渲染进程只用 `window.api.partsList(...)` 这种形式，**看不到也不该看到** ipcRenderer。
 */
function channelToMethod(channel) {
  const [mod, action] = String(channel).split(":");
  const camel = String(action || "").split("_")
    .map((part) => (part === "" ? "" : part[0].toUpperCase() + part.slice(1)))
    .join("");
  return `${mod}${camel}`;
}

module.exports = { CHANNELS, PLAN_CHANNELS, channelToMethod };
