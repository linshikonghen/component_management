/**
 * ui_util.js — 渲染层最小基建（唯一实现处，页面不要各写一份）
 *
 * 为什么要有它（自检结论 2026-10-17）：重构前 `el()` 在 8 个渲染文件里各有一份、
 * `call()` 在 7 个文件里各有一份、去抖与「晚到旧响应不许覆盖新结果」的请求守卫
 * 也在两个页面各写一遍 —— 违反 AGENTS.md 的「反重复规则」。
 *
 * 这里只放**跟业务无关**的三件小工具：
 *   ① el(tag, className, text)         建一个节点（className/text 都可选）
 *   ② call(api, method, payload)       统一 IPC 约定：失败抛 Error，成功返回响应
 *   ③ requestGuard() / debounce()      并发请求守卫 + 去抖（搜索/筛选这类输入用）
 *
 * 加载顺序（index.html）：ui_util.js → dialog.js → model/* → pages/* → app.js
 * 本文件**不含 require / fetch / 网络**（渲染进程的硬约束，由 T11 / test_acceptance_full 守着）。
 */
(function (root) {
  "use strict";

  /** 建一个元素：cls 为 class 字符串，text 为文本内容（null/undefined 不收） */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  /**
   * 调 IPC：统一按 `{ ok, error }` 约定处理。
   * @param {object} api      preload 暴露的白名单（window.api）
   * @param {string} method   方法名（preload 里 camelCase 后的名字）
   * @param {object} payload  请求体
   * @returns {Promise<object>} 成功响应（含 ok:true）
   * @throws  Error: 方法不存在 / 后端 ok:false / 调用异常
   */
  async function call(api, method, payload) {
    if (!api || typeof api[method] !== "function") {
      throw new Error(`IPC 方法不存在：${method}`);
    }
    const result = await api[method](payload);
    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || `${method} 调用失败`);
    }
    return result;
  }

  /** preload 桥是否存在（页面挂载时的预检；不直接碰 window.api，保持唯一通道） */
  function available(api) {
    return Boolean(api) && typeof api === "object";
  }

  /** 桥里是否有某个方法（页面预检用） */
  function has(api, method) {
    return available(api) && typeof api[method] === "function";
  }

  /**
   * 调 IPC 但**不把 ok:false 当异常**：用于"业务性拒绝"要展示细节的场景
   * （例如按 BOM 领料被整单拒绝时，界面要列缺口，不能只显示一句错误）。
   * 方法不存在仍然抛错（那是接线问题，不是业务结果）。
   */
  async function callRaw(api, method, payload) {
    if (!api || typeof api[method] !== "function") {
      throw new Error(`IPC 方法不存在：${method}`);
    }
    return api[method](payload);
  }

  /**
   * 请求序号守卫：并发/晚到响应时只允许「最新一次」写回界面。
   * 用法：`const guard = UIUtil.requestGuard(); const seq = guard.next(); await ...;
   *        if (!guard.isCurrent(seq)) return;`
   * `invalidate()` 用于「清除筛选」这类操作：主动作废还在飞的请求。
   */
  function requestGuard() {
    let seq = 0;
    return {
      next() { seq += 1; return seq; },
      isCurrent(token) { return token === seq; },
      invalidate() { seq += 1; },
    };
  }

  /** 去抖：连续输入只在停下来 ms 之后执行一次；返回的函数带 cancel() */
  function debounce(fn, ms) {
    const wait = Number(ms) > 0 ? Number(ms) : 0;
    let timer = null;
    const wrapped = function () {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn();
      }, wait);
    };
    wrapped.cancel = function () {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    };
    return wrapped;
  }

  root.UIUtil = {
    el: el,
    call: call,
    callRaw: callRaw,
    available: available,
    has: has,
    requestGuard: requestGuard,
    debounce: debounce,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
