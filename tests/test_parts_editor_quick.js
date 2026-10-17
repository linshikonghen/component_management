"use strict";
/**
 * 手动录入页：容差快捷按钮**点一下就填进去**（用户实测：± 打不出来）
 *
 * 做法：像 T51 那样在 vm 沙箱里真跑页面（极简骨架 + 同步捕获监听器），
 * API 用 Proxy 兜底（页面用到哪个方法都给一个返回 ok 的异步桩），
 * 断言：容差字段旁有快捷按钮 → 点 ±10% → 输入框的值与表单状态都变成 ±10%。
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.children = [];
      this.listeners = {};
      this.dataset = {};
      this.className = "";
      this._text = "";
      this.value = "";
      this.type = "";
      this.id = "";
      this.selected = false;
      this.disabled = false;
      this.htmlFor = "";
      this.min = ""; this.step = "";
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v == null ? "" : v); this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type) { for (const fn of (this.listeners[type] || [])) fn({ target: this }); }
  }
  const byId = {};
  return {
    createElement: (tag) => { const n = new Node(tag); return n; },
    // 页面会按 id 取容器/元素：给一个按需创建的桩，避免因骨架不全会误红
    getElementById: (id) => (byId[id] = byId[id] || new Node("div")),
  };
}

function load() {
  const dom = makeDom();
  // 任何未预料到的 api 调用都给一个"成功但空"的桩，避免因接口面未知而误红
  const api = new Proxy({}, {
    get: () => async () => ({ ok: true, parts: [], movements: [], items: [], total: 0 }),
  });
  const root = { api, document: dom };
  const sbox = { globalThis: root, document: dom, module: undefined, console };
  // 渲染层基建（el / call）唯一实现：页面脚本依赖它先加载（index.html 里也是这个顺序）
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "renderer", "lib", "ui_util.js"), "utf8"), sbox);
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "renderer", "model", "parts_model.js"), "utf8"), sbox);
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "renderer", "pages", "parts_editor.js"), "utf8"), sbox);
  const container = dom.createElement("div");
  root.PartsPage.mount(container, {});
  return { dom, container };
}

function all(dom, node, out) {
  const acc = out || [];
  for (const c of node.children) { acc.push(c); all(dom, c, acc); }
  return acc;
}

t("容差字段旁有快捷按钮（±1% / ±5% / ±10% / ±20%）", () => {
  const { dom, container } = load();
  const nodes = all(dom, container, []);
  const quicks = nodes.filter((n) => n.dataset && n.dataset.quick);
  const got = quicks.map((n) => n.dataset.quick);
  for (const v of ["±1%", "±5%", "±10%", "±20%"]) {
    assert.ok(got.includes(v), "缺少快捷值 " + v + "（实际：" + got.join(",") + "）");
  }
});

t("点 ±10% → 容差输入框的值变成 ±10%（走与手输相同的更新路径）", () => {
  const { dom, container } = load();
  const nodes = all(dom, container, []);
  const input = nodes.find((n) => n.dataset && n.dataset.field === "tolerance");
  assert.ok(input, "应有容差输入框");
  assert.strictEqual(input.value, "", "初始应为空");
  const btn = nodes.find((n) => n.dataset && n.dataset.quick === "±10%");
  btn.fire("click");
  assert.strictEqual(input.value, "±10%", "点一下应填进去");
});

t("快捷按钮不会顶掉已有输入（点 ±20% 覆盖 ±1%）", () => {
  const { dom, container } = load();
  const nodes = all(dom, container, []);
  const input = nodes.find((n) => n.dataset && n.dataset.field === "tolerance");
  nodes.find((n) => n.dataset.quick === "±1%").fire("click");
  assert.strictEqual(input.value, "±1%");
  nodes.find((n) => n.dataset.quick === "±20%").fire("click");
  assert.strictEqual(input.value, "±20%", "再点应替换");
});

console.log("=".repeat(64));
console.log("容差快捷按钮：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
