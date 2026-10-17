"use strict";
/**
 * dialog.js — 页内确认框（**不依赖原生 window.confirm**）
 *
 * 为什么要有它（用户 2026-10-17 实测）：
 *   手动录入保存后整个界面"卡住"、不能继续输入。根因是保存路径里用了原生 `window.confirm`：
 *   它是**阻塞式模态**——一旦弹出而窗口没能把它显示出来（Electron 某些环境/窗口状态下会这样），
 *   整个渲染进程就永久卡死：用户看不到弹窗、点不了任何按钮、也输不了字。
 *   页内弹窗是普通 DOM：一定可见、可测试、样式与应用一致，且不会卡住主线程。
 *
 * 用法（一处实现，多处复用；禁止在页面里再写"类似但略有不同"的弹窗）：
 *   const yes = await window.DialogUI.confirm({
 *     title: "确定删除这条器件吗？", message: "…", okText: "删除", cancelText: "取消", danger: true,
 *   });
 *   const choice = await window.DialogUI.choose({            // 需要三选一/多选一时用这个
 *     title: "…", message: "…",
 *     options: [{ value: "merge", text: "合并" }, { value: "cancel", text: "取消", primary: true }],
 *   });  // → 选中项的 value；**按 Esc 或点遮罩 = 最后一项**（约定：把"取消"放最后）
 */
(function (root) {
  const el = root.UIUtil.el;

  let activeMask = null; // 同一时刻只允许一个弹窗

  /** 文档级键盘/事件能力（测试用假 DOM 可能没有；没有就跳过，不影响弹窗本身） */
  const DOC_EVENTS = typeof document.addEventListener === "function";

  function choose(opts) {
    const options = Array.isArray(opts && opts.options) ? opts.options : [];
    // 约定：取消类选项放最后 → 返回它的 value 作为"没选"的兜底
    const fallback = options.length ? options[options.length - 1].value : undefined;
    return new Promise((resolve) => {
      if (activeMask) return resolve(fallback); // 已经有一个弹窗在等 → 不叠弹窗
      const done = (value) => {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        activeMask = null;
        if (DOC_EVENTS) document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (ev) => {
        if (!ev || ev.key !== "Escape") return;
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        done(fallback);
      };

      const mask = el("div", "modal-mask");
      mask.id = "dialog-mask";
      const panel = el("div", "modal");
      if (opts && opts.title) panel.appendChild(el("h3", null, opts.title));
      if (opts && opts.message) {
        // 多行消息：按行拆成 <p>，避免 \n 在 HTML 里被折叠成空格（原来 confirm 里的换行就靠它）
        for (const line of String(opts.message).split("\n")) {
          if (line.trim() === "") continue;
          panel.appendChild(el("p", "hint", line));
        }
      }
      const actions = el("div", "form-actions");
      options.forEach((opt, idx) => {
        const btn = el("button", opt.primary ? "primary" : null, opt.text);
        btn.type = "button";
        // 约定：第一个按钮 = 主按钮（继续做），最后一个 = 取消
        btn.id = idx === 0 ? "dialog-ok" : (idx === options.length - 1 ? "dialog-cancel" : `dialog-option-${idx}`);
        if (opt.danger) btn.className = (btn.className ? btn.className + " " : "") + "danger";
        btn.addEventListener("click", () => done(opt.value));
        actions.appendChild(btn);
      });
      panel.appendChild(actions);
      mask.appendChild(panel);
      // 点遮罩 = 取消（和系统弹窗的直觉一致）
      mask.addEventListener("click", (ev) => {
        if (ev && ev.target === mask) done(fallback);
      });
      if (DOC_EVENTS) document.addEventListener("keydown", onKey, true);
      document.body.appendChild(mask);
      activeMask = mask;
    });
  }

  /** 两选一：返回 true=主按钮 / false=取消 */
  function confirmDialog(opts) {
    const o = opts || {};
    return choose({
      title: o.title,
      message: o.message,
      options: [
        { value: "ok", text: o.okText || "确定", primary: o.primary !== false, danger: o.danger === true },
        { value: "cancel", text: o.cancelText || "取消" },
      ],
    }).then((v) => v === "ok");
  }

  root.DialogUI = { choose, confirm: confirmDialog };
})(typeof globalThis !== "undefined" ? globalThis : this);
