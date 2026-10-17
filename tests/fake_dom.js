"use strict";
/**
 * fake_dom.js — **极简 DOM**（测试专用，不用任何 npm 包——本项目零依赖）
 *
 * 为什么需要它：`renderer/pages/*.js` 的装配代码此前**从未被执行过**——
 * 22 个套件里对它们只有静态检查（"文件里引用了正确的通道"）。
 * "页面真的能渲染出 33 行核对表 / 未裁决时按钮真的禁用"这类事，只有让页面代码跑起来才知道。
 * Electron 在本环境起不来（已归因），所以这里手搓一个够用的 DOM，
 * 用 `node:vm` 把页面脚本放进来真跑，`window.api` 接到**真实 IPC handlers**。
 *
 * **范围**：只实现本项目页面实际用到的那点 API（见 renderer 的用法清点），
 * 不做样式计算、不做布局、不做事件冒泡（事件直接在目标上派发）。
 * 选择器只支持 `#id` / `.class` / `tag` / `tag.class` 以及空格分隔的后代组合——
 * 够用即可；**不追求通用**，也不假装通用。
 */

class ClassList {
  constructor(el) { this.el = el; }

  _list() {
    return String(this.el.className || "").split(/\s+/).filter((s) => s !== "");
  }

  _write(list) { this.el.className = list.join(" "); }

  contains(name) { return this._list().includes(String(name)); }

  add(...names) {
    const list = this._list();
    for (const n of names) if (!list.includes(String(n))) list.push(String(n));
    this._write(list);
  }

  remove(...names) {
    const drop = names.map(String);
    this._write(this._list().filter((n) => !drop.includes(n)));
  }

  toggle(name, force) {
    const has = this.contains(name);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this.add(name); else this.remove(name);
    return want;
  }
}

class Element {
  constructor(tagName, doc) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.classList = new ClassList(this);
    this.className = "";
    this._text = "";
    this._listeners = new Map();
    // 常见属性给个初值，免得页面读到时是 undefined（真实 DOM 里它们是空串/false）
    this._value = undefined;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.type = "";
    this.placeholder = "";
    this.title = "";
    this.min = "";
    this.step = "";
    this.htmlFor = "";
    this.colSpan = 1;
    this._id = "";
  }

  /**
   * `value` 用访问器，**忠于真实 DOM 的两条语义**（否则页面会显得"坏了"，其实是桩不真）：
   *   ① 表单控件的默认值是**空串**，不是 undefined（页面普遍会 `el.value.trim()`）；
   *   ② `<select>` 的 value 由**被选中的 option** 决定（选中第一个/显式选中的那个）。
   * 第一版没做这两点，结果 app.js 的 `search.value.trim()` 抛错、"分类保留"断言读到 undefined——
   * 两次都是我桩的问题，不是页面的问题。
   */
  get value() {
    if (this.tagName === "SELECT") {
      if (this._value !== undefined) return this._value;
      const options = this.children.filter((c) => c.tagName === "OPTION");
      const chosen = options.find((o) => o.selected) || options[0];
      return chosen ? chosen.value : "";
    }
    return this._value === undefined ? "" : this._value;
  }

  set value(v) {
    this._value = v == null ? "" : String(v);
    if (this.tagName === "SELECT") {
      for (const option of this.children) {
        if (option.tagName === "OPTION") option.selected = option.value === this._value;
      }
    }
  }

  /** id 用访问器：赋 id 时登记到 document，getElementById 才找得到（页面都是先建后赋 id） */
  get id() { return this._id; }
  set id(v) {
    if (this.ownerDocument) this.ownerDocument._unregister(this._id, this);
    this._id = String(v);
    if (this.ownerDocument) this.ownerDocument._register(this._id, this);
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(v) {
    // 清空子节点时同步注销它们的 id（真实 DOM 移出树后就查不到了；弹窗"弹出自移除"依赖这个语义）
    if (this.ownerDocument) {
      for (const child of this.children) unregisterSubtree(this.ownerDocument, child);
    }
    this.children = [];
    this._text = v == null ? "" : String(v);
  }

  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children.slice(); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  insertBefore(child, ref) {
    const at = ref ? this.children.indexOf(ref) : -1;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }

  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    // 与真实 DOM 一致：移出树后 getElementById 不该再找得到（含子树里的 id）
    if (this.ownerDocument) unregisterSubtree(this.ownerDocument, child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }

  /** 派发一个事件（不冒泡；被测代码都直接绑在触发元素上） */
  dispatch(type, extra = {}) {
    const event = Object.assign({
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
    }, extra);
    for (const handler of (this._listeners.get(type) || []).slice()) handler(event);
    return event;
  }

  /** 便捷：模拟点击 / 输入（置值后派发 input 事件，和真人操作一致） */
  click() { return this.dispatch("click"); }
  setValue(v) { this.value = v; return this.dispatch("input"); }
  setChecked(v) { this.checked = Boolean(v); return this.dispatch("change"); }

  /**
   * 模拟用户在下拉框里选一项：真实浏览器对 `<select>` 会**同时**发 `input` 与 `change`，
   * 只发一个会让"绑了 change 的代码"看起来没反应（我的领料页用例就这么冤枉过一次）。
   */
  choose(v) {
    this.value = v;
    this.dispatch("input");
    return this.dispatch("change");
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSimple(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) { return queryAll(this, selector); }
  querySelector(selector) { return queryAll(this, selector)[0] || null; }

  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }

  /** 测试便捷：按标签名收集后代 */
  all(tagName) { return descendants(this).filter((el) => el.tagName === String(tagName).toUpperCase()); }
}

/* --------------------------------------------------- 选择器（够用即可） */

function parseSimple(selector) {
  const text = String(selector).trim();
  const id = /#([\w-]+)/.exec(text);
  const tag = /^([a-zA-Z][\w-]*)/.exec(text);
  const classes = [...text.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return { id: id ? id[1] : null, tag: tag ? tag[1].toUpperCase() : null, classes };
}

function matchesSimple(el, selector) {
  const { id, tag, classes } = parseSimple(selector);
  if (id !== null && el.id !== id) return false;
  if (tag !== null && el.tagName !== tag) return false;
  for (const cls of classes) if (!el.classList.contains(cls)) return false;
  return true;
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) { out.push(child); walk(child); }
  };
  walk(root);
  return out;
}

/** 只支持空格分隔的后代组合，例如 `#parts th.sortable` */
function queryAll(root, selector) {
  const steps = String(selector).trim().split(/\s+/).filter((s) => s !== "");
  let current = [root];
  for (const step of steps) {
    const next = [];
    for (const node of current) {
      for (const el of descendants(node)) if (matchesSimple(el, step)) next.push(el);
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

/* --------------------------------------------------------------- document */

/** 把一个子树里所有带 id 的节点从 document 的 id 表里注销（移出树后不该再被 getElementById 找到） */
function unregisterSubtree(doc, node) {
  if (!doc || !node) return;
  if (node.id) doc._unregister(node.id, node);
  for (const child of node.children || []) unregisterSubtree(doc, child);
}

function createDocument() {
  const byId = new Map();
  const doc = {
    _register(id, el) { if (id) byId.set(id, el); },
    _unregister(id) { if (id) byId.delete(id); },
    // 文档级事件：真实 DOM 有 document.addEventListener；页内确认框用它支持 Esc 关闭
    _docListeners: new Map(),
    addEventListener(type, handler) {
      if (!this._docListeners.has(type)) this._docListeners.set(type, []);
      this._docListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = this._docListeners.get(type) || [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, ev) {
      const event = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev || {});
      for (const handler of (this._docListeners.get(type) || []).slice()) handler(event);
    },
    createElement(tag) { return new Element(tag, doc); },
    getElementById(id) { return byId.get(String(id)) || null; },
    querySelectorAll(selector) { return queryAll(doc.body, selector); },
    querySelector(selector) { return queryAll(doc.body, selector)[0] || null; },
    activeElement: null,
  };
  doc.body = new Element("body", doc);
  return doc;
}

module.exports = { createDocument, Element, matchesSimple, queryAll };
