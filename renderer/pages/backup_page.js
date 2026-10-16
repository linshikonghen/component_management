"use strict";
/**
 * backup_page.js — 备份 / 恢复页（spec FR-6.4 / AC-6）
 *
 * 两块：
 *   ① 立即备份：把整库复制进一个带时间戳的目录（原数据不动）
 *   ② 从备份恢复：**覆盖当前库** —— 警告 + 确认勾选，恢复前工具会自动留一份当前状态
 *
 * 规则全在 `renderer/model/backup_model.js`（有无头测试）；本文件只做 DOM 装配。
 * 恢复成功后刷新库存页——否则界面上还是旧数据，用户会以为没生效。
 */

(function (root) {
  "use strict";

  const M = root.BackupModel;
  if (!M) throw new Error("backup_model.js 必须先于 backup_page.js 加载");

  let state = null;
  let container = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function reset() {
    state = {
      settings: null,
      backup_dir: "",
      restore_dir: "",
      restore_confirmed: false,
      backup_result: null,
      restore_result: null,
      error: "",
    };
  }

  async function call(method, payload) {
    const api = root.api;
    if (!api || typeof api[method] !== "function") throw new Error(`IPC 方法不存在：${method}`);
    const r = await api[method](payload);
    if (!r || r.ok !== true) throw new Error((r && r.error) || `${method} 调用失败`);
    return r;
  }

  function showError(message) {
    const box = document.getElementById("backup-error");
    if (box) {
      box.textContent = message || "";
      box.hidden = !message;
    }
    state.error = message || "";
    if (message) console.error("[备份]", message);
  }

  /* --------------------------------------------------------- 备份 */

  function renderBackupBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "立即备份"));
    box.appendChild(el("p", "hint", M.BACKUP_HINT));

    const row = el("div", "form-row");
    row.appendChild(el("label", null, "备份到："));
    const input = el("input", "file-box");
    input.id = "backup-dir";
    input.placeholder = "如 D:\\元器件备份（会在这里新建一个带时间戳的子目录）";
    input.value = state.backup_dir;
    input.addEventListener("input", () => {
      state.backup_dir = input.value;
      refreshBackupHint();
    });
    row.appendChild(input);
    box.appendChild(row);

    const actions = el("div", "form-actions");
    const button = el("button", "primary", "立即备份");
    button.type = "button";
    button.id = "backup-run";
    button.addEventListener("click", doBackup);
    actions.appendChild(button);
    box.appendChild(actions);

    const hint = el("div", "gate-line");
    hint.id = "backup-hint";
    box.appendChild(hint);
    setTimeout(refreshBackupHint, 0);

    if (state.backup_result) {
      const done = el("div", "banner");
      done.appendChild(el("strong", null, M.backupSummary(state.backup_result)));
      box.appendChild(done);
    }
    return box;
  }

  function refreshBackupHint() {
    const hint = document.getElementById("backup-hint");
    const button = document.getElementById("backup-run");
    if (!hint || !button) return;
    const verdict = M.backupRequest(state.backup_dir);
    button.disabled = !verdict.ok;
    hint.textContent = verdict.ok ? "将把整库复制到该目录下的新子目录。" : verdict.error;
    hint.className = verdict.ok ? "gate-line" : "gate-line warn";
  }

  async function doBackup() {
    try {
      showError("");
      const built = M.backupRequest(state.backup_dir);
      if (!built.ok) throw new Error(built.error);
      const r = await call("dataBackup", built.request);
      state.backup_result = r;
      state.restore_dir = state.restore_dir || r.backup_path;
      renderAll();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* --------------------------------------------------------- 恢复 */

  function renderRestoreBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "从备份恢复"));

    const warn = el("div", "banner warn");
    warn.textContent = M.RESTORE_WARNING;
    box.appendChild(warn);

    const row = el("div", "form-row");
    row.appendChild(el("label", null, "备份目录："));
    const input = el("input", "file-box");
    input.id = "restore-dir";
    input.placeholder = "填「立即备份」给出的那个目录（里面有 parts.json / movements.json）";
    input.value = state.restore_dir;
    input.addEventListener("input", () => {
      state.restore_dir = input.value;
      state.restore_confirmed = false;
      const check = document.getElementById("restore-confirm");
      if (check) check.checked = false;
      refreshRestoreHint();
    });
    row.appendChild(input);
    box.appendChild(row);

    const confirmRow = el("div", "form-row");
    const label = el("label", "adjudicate");
    const check = el("input");
    check.type = "checkbox";
    check.id = "restore-confirm";
    check.checked = state.restore_confirmed;
    check.addEventListener("change", () => {
      state.restore_confirmed = check.checked;
      refreshRestoreHint();
    });
    label.appendChild(check);
    label.appendChild(el("span", null, "我明白这会覆盖当前数据，确认恢复"));
    confirmRow.appendChild(label);
    box.appendChild(confirmRow);

    const actions = el("div", "form-actions");
    const button = el("button", "primary", "从备份恢复");
    button.type = "button";
    button.id = "restore-run";
    button.addEventListener("click", doRestore);
    actions.appendChild(button);
    box.appendChild(actions);

    const hint = el("div", "gate-line");
    hint.id = "restore-hint";
    box.appendChild(hint);
    setTimeout(refreshRestoreHint, 0);

    if (state.restore_result) {
      const done = el("div", "banner");
      done.appendChild(el("strong", null, M.restoreSummary(state.restore_result)));
      box.appendChild(done);
    }
    return box;
  }

  function refreshRestoreHint() {
    const hint = document.getElementById("restore-hint");
    const button = document.getElementById("restore-run");
    if (!hint || !button) return;
    const verdict = M.restoreRequest(state.restore_dir, state.restore_confirmed);
    button.disabled = !verdict.ok;
    hint.textContent = verdict.ok ? "将覆盖当前库；覆盖前会自动另存一份当前状态。" : verdict.error;
    hint.className = verdict.ok ? "gate-line" : "gate-line warn";
  }

  async function doRestore() {
    try {
      showError("");
      const built = M.restoreRequest(state.restore_dir, state.restore_confirmed);
      if (!built.ok) throw new Error(built.error);
      const r = await call("dataRestore", built.request);
      state.restore_result = r;
      state.restore_confirmed = false;
      const check = document.getElementById("restore-confirm");
      if (check) check.checked = false;
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      renderAll();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ------------------------------------------------------- 装配 */

  function renderAll() {
    container.textContent = "";
    const wrap = el("div", "wizard");

    const error = el("div", "banner error");
    error.id = "backup-error";
    error.hidden = !state.error;
    error.textContent = state.error;
    wrap.appendChild(error);

    const body = el("div", "wizard-body");
    body.appendChild(el("div", "gate-line", M.dataDirLine(state.settings)));
    body.appendChild(renderBackupBox());
    body.appendChild(renderRestoreBox());
    wrap.appendChild(body);

    container.appendChild(wrap);
  }

  function mount(target) {
    container = target;
    reset();
    renderAll();
    call("settingsGet", {})
      .then((r) => { state.settings = r.settings; renderAll(); })
      .catch((exc) => showError(exc.message));
  }

  root.BackupPage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
