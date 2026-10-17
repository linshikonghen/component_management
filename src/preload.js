"use strict";
/**
 * preload.js — contextBridge 白名单（plan §6：渲染进程禁止直接 ipcRenderer）
 *
 * 只做一件事：把 `CHANNELS` 里的通道逐个包成 `window.api.<方法>`。
 * **不暴露 `ipcRenderer` 本体**——否则渲染进程就能往任意通道发消息，
 * 白名单也就名存实亡。
 *
 * 通道名单来自 `ipc/channels.js`（与主进程注册用的是**同一份**），
 * 因此不存在"界面以为有、实际没注册"的漂移。
 * （这里**不写死通道数量**——写了就会过期；`tests/test_preload.js` 会逐个核对。）
 */

const { contextBridge, ipcRenderer } = require("electron");
const { CHANNELS, channelToMethod } = require("./ipc/channels");

const api = Object.create(null);
for (const channel of CHANNELS) {
  const method = channelToMethod(channel);
  api[method] = (payload) => ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld("api", api);
