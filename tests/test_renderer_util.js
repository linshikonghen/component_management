"use strict";
/**
 * test_renderer_util.js — 渲染层基建 renderer/lib/ui_util.js 的单元测试
 *
 * 为什么有它（自检重构 2026-10-17）：el() / call() / 请求守卫 / 去抖原来在 8 个页面里各写一份，
 * 现在集中一份；这里用假 DOM + vm 把四个函数的正常/异常路径都跑一遍，
 * 防止以后页面又"各写一份类似但略有不同"的实现（由 tests/test_architecture.js 静态兜底）。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { createDocument } = require("./fake_dom.js");

const ROOT = path.resolve(__dirname, "..");
const UI_UTIL = path.join(ROOT, "renderer", "lib", "ui_util.js");

function makeUtil() {
  const doc = createDocument();
  const sandbox = { document: doc, console, setTimeout, clearTimeout, Promise };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(UI_UTIL, "utf8"), sandbox, { filename: "renderer/lib/ui_util.js" });
  return { UI: sandbox.UIUtil, doc, sandbox };
}

let passCount = 0;
const failures = [];
const QUEUE = [];
function t(name, fn) { QUEUE.push({ name, fn }); }

t("el：建节点，className / 文本可选；文本会 String 化、null 不收", () => {
  const { UI } = makeUtil();
  const plain = UI.el("div");
  assert.strictEqual(plain.tagName, "DIV");
  assert.strictEqual(plain.className, "");
  assert.strictEqual(plain.textContent, "");

  const node = UI.el("button", "link primary", "点我");
  assert.strictEqual(node.tagName, "BUTTON");
  assert.strictEqual(node.className, "link primary");
  assert.strictEqual(node.textContent, "点我");

  assert.strictEqual(UI.el("span", null, 0).textContent, "0", "0 要收（!= null 判断）");
  assert.strictEqual(UI.el("span", null, null).textContent, "", "null 不收");
});

t("call：成功返回响应；ok:false 抛后端 error；方法不存在抛明确错误", async () => {
  const { UI } = makeUtil();
  const api = {
    partsList: async (payload) => ({ ok: true, echo: payload, parts: [] }),
    bad: async () => ({ ok: false, error: "后端说不行" }),
  };
  const ok = await UI.call(api, "partsList", { q: "x" });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.echo, { q: "x" });

  await assert.rejects(() => UI.call(api, "bad"), /后端说不行/);
  await assert.rejects(() => UI.call(api, "missing"), /IPC 方法不存在：missing/);
  await assert.rejects(() => UI.call(null, "x"), /IPC 方法不存在/);
});

t("requestGuard：只有最新一次请求算数；invalidate 作废在飞请求", () => {
  const { UI } = makeUtil();
  const guard = UI.requestGuard();
  const a = guard.next();
  assert.strictEqual(guard.isCurrent(a), true);
  const b = guard.next();
  assert.strictEqual(guard.isCurrent(a), false, "a 晚到时应被丢弃");
  assert.strictEqual(guard.isCurrent(b), true);
  guard.invalidate();
  assert.strictEqual(guard.isCurrent(b), false, "invalidate 后旧请求一律作废");
});

t("debounce：停顿后才执行一次；连续调用只算最后一次；cancel 取消", async () => {
  const { UI } = makeUtil();
  let calls = 0;
  const fn = UI.debounce(() => { calls += 1; }, 15);
  fn(); fn(); fn();
  assert.strictEqual(calls, 0, "立即不应该执行");
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(calls, 1, "连续 3 次只执行 1 次");

  fn();
  fn.cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(calls, 1, "cancel 后不应执行");
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
  console.log(`T113（渲染层基建 ui_util）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("全部通过");
})();
