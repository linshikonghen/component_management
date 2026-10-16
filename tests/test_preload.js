"use strict";
/**
 * test_preload.js — T34：**真的加载并执行 `src/preload.js`**
 *
 * 运行： node tests/test_preload.js
 *
 * 为什么需要：此前对 preload 只有三处**间接**覆盖（路径存在、不 require 网络模块、通道名不冲突），
 * **没有任何测试真的执行过它**。而 preload 是渲染进程与主进程之间唯一的门：
 *   · 它多暴露一个名字 = 越权面（比如把 `ipcRenderer` 本体递出去，白名单就名存实亡）；
 *   · 它少暴露一个名字 = 某个页面永久调不通；
 *   · 方法名与通道**错配** = 静默故障（页面调用看似成功，实际打到别的通道）。
 * 这三件事都能在无 Electron 的环境里验——把 `require("electron")` 换成桩即可
 * （手法与 `test_main_wiring.js` 相同：`Module._load` 钩子）。
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

const { CHANNELS, channelToMethod } = require("../src/ipc/channels");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(ROOT, "src", "preload.js");

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
function section(title) { console.log("\n=== " + title + " ==="); }

/* ------------------------------------------------------------ 载入 preload */

const recorded = { exposed: [], invocations: [] };
/** 累计计数**不随缓冲清空而重置**——`invocations` 在每个通道探针前会被清空，
 *  所以"一共发生过多少次 invoke"必须另记（第一版漏了这点，反证条自己红了）。 */
const totals = { invoke: 0 };

const fakeElectron = {
  contextBridge: {
    exposeInMainWorld(name, obj) { recorded.exposed.push({ name, obj }); },
  },
  ipcRenderer: {
    invoke(channel, payload) {
      totals.invoke += 1;
      recorded.invocations.push({ channel, payload });
      return Promise.resolve({ ok: true, echo: channel, got: payload });
    },
    // 下面这些**不该**被 preload 用到；真用到就说明白名单设计跑偏了
    send() { throw new Error("preload 不得直接 send"); },
    on() { throw new Error("preload 不得直接 on"); },
    once() { throw new Error("preload 不得直接 once"); },
    sendSync() { throw new Error("preload 不得直接 sendSync"); },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};
try {
  delete require.cache[require.resolve(PRELOAD)];
  require(PRELOAD);
} finally {
  Module._load = originalLoad;
}

/* ==================================================== §1 只暴露一个门面 */

section("§1 preload 只暴露一个门面，且不多不少");

t("exposeInMainWorld 恰好调用一次，名字是 api", () => {
  assert.strictEqual(recorded.exposed.length, 1, `应只暴露一次，实际 ${recorded.exposed.length} 次`);
  assert.strictEqual(recorded.exposed[0].name, "api");
});

t("暴露的键**恰好等于** 通道清单映射出的方法名（多一个=越权，少一个=页面坏）", () => {
  const exposed = Object.keys(recorded.exposed[0].obj).sort();
  const expected = CHANNELS.map(channelToMethod).sort();
  // 先把差集算出来，报错时能直接看出多了/少了哪个
  const extra = exposed.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !exposed.includes(k));
  assert.deepStrictEqual(extra, [], "白名单里多了不该暴露的名字：" + extra.join(", "));
  assert.deepStrictEqual(missing, [], "白名单里少了页面要用的方法：" + missing.join(", "));
  assert.strictEqual(exposed.length, CHANNELS.length, "方法数应等于通道数");
  assert.ok(CHANNELS.length >= 16, "通道数不该缩水，实际 " + CHANNELS.length);
});

t("危险名字一个都不能出现（尤其 ipcRenderer 本体）", () => {
  const obj = recorded.exposed[0].obj;
  const forbidden = [
    "ipcRenderer", "ipcRendererSend", "send", "sendSync", "on", "once", "off",
    "invoke", "handle", "require", "process", "module", "exports", "global", "Buffer",
    "__proto__", "constructor", "prototype",
  ];
  const leaked = forbidden.filter((name) => Object.prototype.hasOwnProperty.call(obj, name));
  assert.deepStrictEqual(leaked, [], "这些名字不该出现在白名单里：" + leaked.join(", "));
});

t("暴露对象没有原型（Object.create(null)）：读 `constructor` 拿不到函数", () => {
  const obj = recorded.exposed[0].obj;
  assert.strictEqual(Object.getPrototypeOf(obj), null, "原型应为 null");
  assert.strictEqual(obj.constructor, undefined, "不应能顺着原型链拿到 constructor");
  assert.strictEqual(typeof obj.toString, "undefined", "也不该有原型链上的 toString");
});

t("每个暴露的值都是函数（不能顺手塞个对象/字符串当「配置」漏出去）", () => {
  const obj = recorded.exposed[0].obj;
  for (const [name, fn] of Object.entries(obj)) {
    assert.strictEqual(typeof fn, "function", `${name} 应是函数，实际 ${typeof fn}`);
  }
});

/* ==================================================== §2 方法 ↔ 通道 */

section("§2 每个方法真的打到**对应**通道（错配就是静默故障）");

t("逐个方法调用：api.<method>(payload) → invoke(<channel>, payload)", () => {
  const obj = recorded.exposed[0].obj;
  const mismatched = [];
  for (const channel of CHANNELS) {
    const method = channelToMethod(channel);
    recorded.invocations.length = 0;
    const payload = { __probe: channel };
    obj[method](payload);
    const calls = recorded.invocations;
    if (calls.length !== 1) { mismatched.push(`${method}：调用了 ${calls.length} 次`); continue; }
    if (calls[0].channel !== channel) mismatched.push(`${method} 打到了 ${calls[0].channel}（应为 ${channel}）`);
    if (calls[0].payload !== payload) mismatched.push(`${method} 没有原样透传参数`);
  }
  assert.deepStrictEqual(mismatched, [], mismatched.join("；"));
  console.log(`        （逐个验证了 ${CHANNELS.length} 个方法→通道的映射）`);
});

t("返回值原样返回（页面拿到的是主进程的 promise 结果）", async () => {
  const obj = recorded.exposed[0].obj;
  const method = channelToMethod(CHANNELS[0]);
  const promise = obj[method]({ x: 1 });
  assert.strictEqual(typeof promise.then, "function", "应返回 thenable");
});

t("反证：桩确实被调用过（否则上面全是空跑）", () => {
  assert.strictEqual(recorded.exposed.length, 1, "桩应记录到一次 exposeInMainWorld");
  assert.ok(totals.invoke >= CHANNELS.length, `桩应记录到至少 ${CHANNELS.length} 次 invoke，实际 ${totals.invoke}`);
  assert.ok(recorded.invocations.every((c) => typeof c.channel === "string" && c.channel.includes(":")),
    "每次 invoke 的第一个参数都应是 `模块:动作` 形态的通道名");
});

/* ---------------------------------------------------------------- */

console.log("\n" + "=".repeat(64));
console.log(`T34（preload 白名单）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
