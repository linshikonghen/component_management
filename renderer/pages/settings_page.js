"use strict";
/**
 * settings_page.js — 设置页（spec FR-4 / AC-4 / AC-9）
 *
 * 三块：
 *   ① **14 类默认阈值**（FR-4.6/4.7、AC-9）：改完保存，未设个体阈值的器件立刻按新值判定
 *   ② **低库存清单**（FR-4.2）：主动列出，不用用户去查
 *   ③ **数据目录**（AGENTS.md：需人工确认）：带确认勾选 + "数据不会自动搬过去"的警告
 *
 * 规则全在 `renderer/model/settings_model.js`（有无头测试）；分类标签取自
 * `PartsModel.CATEGORY_CLASS_ROWS`（阈值行=§5.3 的 14 个类键，不抄第二份）。
 * "某条算不算低库存"由服务端判定，本页只展示 —— 界面**不重复实现**阈值语义。
 */

(function (root) {
  "use strict";

  const M = root.SettingsModel;
  const PM = root.PartsModel;
  if (!M) throw new Error("settings_model.js 必须先于 settings_page.js 加载");
  if (!PM) throw new Error("parts_model.js 必须先于 settings_page.js 加载（分类标签从这里取）");

  let state = null;
  let container = null;

  const el = root.UIUtil.el;

  function reset() {
    state = {
      settings: null,
      form: {},
      parts: [],
      low_ids: [],
      data_dir_input: "",
      dir_confirmed: false,
      notice: "",
      error: "",
    };
  }

  const call = function (method, payload) {
    return root.UIUtil.call(root.api, method, payload);
  };

  function showError(message) {
    const box = document.getElementById("settings-error");
    if (box) {
      box.textContent = message || "";
      box.hidden = !message;
    }
    state.error = message || "";
    if (message) console.error("[设置]", message);
  }

  function showNotice(message) {
    state.notice = message || "";
  }

  async function loadAll() {
    const [settings, list] = await Promise.all([
      call("settingsGet", {}),
      call("partsList", { query: {} }),
    ]);
    state.settings = settings.settings;
    state.parts = list.parts || [];
    state.low_ids = list.low_stock_ids || [];
    state.form = {};
    for (const row of M.thresholdRows(state.settings, PM.CATEGORY_CLASS_ROWS)) {
      state.form[row.key] = row.value === "" ? "" : String(row.value);
    }
    state.data_dir_input = state.settings.data_dir || "";
  }

  /* --------------------------------------------------- 分类默认阈值 */

  function renderThresholdBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "分类默认低库存阈值"));
    box.appendChild(el("p", "hint",
      `spec §5.3 预置的 ${PM.CATEGORY_CLASS_ROWS.length} 类。器件自己的阈值留空时按这里判定；`
      + "器件设了个体阈值则个体优先（FR-4.8）。填 0 表示这一类不提示。"
      + "括号里是阈值内部键（位号 / 类键），不是分类的落库值。"));

    const grid = el("div", "form-grid");
    for (const cat of PM.CATEGORY_CLASS_ROWS) {
      const wrap = el("div", "form-field");
      const label = el("label", null, `${cat.label}（位号 ${cat.key}）`);
      label.htmlFor = `th-${cat.key}`;
      wrap.appendChild(label);
      const input = el("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.id = `th-${cat.key}`;
      input.dataset.key = cat.key;
      input.value = state.form[cat.key] == null ? "" : state.form[cat.key];
      input.addEventListener("input", () => {
        state.form[cat.key] = input.value;
        refreshChangeHint();
      });
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    box.appendChild(grid);

    const hint = el("div", "gate-line");
    hint.id = "threshold-change-hint";
    box.appendChild(hint);

    const actions = el("div", "form-actions");
    const save = el("button", "primary", "保存阈值");
    save.type = "button";
    save.id = "settings-save-thresholds";
    save.addEventListener("click", doSaveThresholds);
    actions.appendChild(save);
    const reload = el("button", null, "放弃改动");
    reload.type = "button";
    reload.addEventListener("click", () => { loadAll().then(renderAll).catch((e) => showError(e.message)); });
    actions.appendChild(reload);
    box.appendChild(actions);

    setTimeout(refreshChangeHint, 0);
    return box;
  }

  function refreshChangeHint() {
    const hint = document.getElementById("threshold-change-hint");
    if (!hint) return;
    const verdict = M.changedThresholds(state.form, state.settings, PM.CATEGORY_CLASS_ROWS);
    if (!verdict.ok) {
      hint.textContent = `有 ${verdict.errors.length} 处不合法：${verdict.errors.join("；")}`;
      hint.className = "gate-line warn";
      const button = document.getElementById("settings-save-thresholds");
      if (button) button.disabled = true;
      return;
    }
    const count = Object.keys(verdict.changes).length;
    hint.textContent = count === 0 ? "没有改动。" : `将修改 ${count} 项：${M.changeSummary(verdict.changes, PM.CATEGORY_CLASS_ROWS)}`;
    hint.className = "gate-line";
    const button = document.getElementById("settings-save-thresholds");
    if (button) button.disabled = count === 0;
  }

  async function doSaveThresholds() {
    try {
      showError("");
      const verdict = M.changedThresholds(state.form, state.settings, PM.CATEGORY_CLASS_ROWS);
      if (!verdict.ok) throw new Error(verdict.errors.join("；"));
      const payload = M.thresholdPayload(verdict.changes);
      if (!payload) return;
      await call("settingsSet", payload);
      const summary = M.changeSummary(verdict.changes, PM.CATEGORY_CLASS_ROWS);
      // 阈值变了 → 低库存判定要立刻跟着变（AC-9：保存后未设个体阈值的器件按新值判定）
      await loadAll();
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      showNotice(`已保存：${summary}。低库存判定已按新阈值重算。`);
      renderAll();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ----------------------------------------------------- 低库存清单 */

  function renderLowStockBox() {
    const box = el("div", "result");
    const lines = M.lowStockLines(state.parts, state.low_ids);
    box.appendChild(el("h3", null, `低库存器件（${lines.length} 条）`));
    if (lines.length === 0) {
      box.appendChild(el("p", "hint", "没有低库存器件。"));
      return box;
    }
    const table = el("table", "review-table");
    const thead = el("thead");
    const head = el("tr");
    for (const title of ["值", "封装", "分类", "现有", "判定依据"]) head.appendChild(el("th", null, title));
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const line of lines) {
      const tr = el("tr");
      tr.className = "low";
      tr.appendChild(el("td", null, line.value));
      tr.appendChild(el("td", null, line.footprint));
      tr.appendChild(el("td", null, line.category));
      tr.appendChild(el("td", "readonly-num warn", line.quantity));
      tr.appendChild(el("td", null, line.min_quantity === null ? "按分类默认阈值" : `个体阈值 ${line.min_quantity}`));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  /* ----------------------------------------------------- 数据目录 */

  function renderDataDirBox() {
    // `mount()` 会先渲染一次、再等 `loadAll()` 回来重画，所以**首次渲染时 state.settings 还是 null**。
    // 这里曾经直接读 `state.settings.data_dir` → 打开设置页第一下就抛 TypeError（页面白着）。
    // DOM 测试（tests/test_renderer_pages.js）把这条抓出来了。
    const settings = state.settings || {};
    const box = el("div", "result");
    box.appendChild(el("h3", null, "数据目录"));
    box.appendChild(el("div", "gate-line", `当前：${settings.data_dir || "（默认 data/）"}`));

    const row = el("div", "form-row");
    row.appendChild(el("label", null, "改为："));
    const input = el("input", "file-box");
    input.id = "settings-data-dir";
    input.placeholder = "如 D:\\元器件数据（留空=用应用目录下的 data/）";
    input.value = state.data_dir_input;
    input.addEventListener("input", () => {
      state.data_dir_input = input.value;
      state.dir_confirmed = false;
      const check = document.getElementById("settings-dir-confirm");
      if (check) check.checked = false;
      refreshDirHint();
    });
    row.appendChild(input);
    box.appendChild(row);

    const warn = el("div", "banner warn");
    warn.id = "settings-dir-warning";
    warn.textContent = M.DATA_DIR_WARNING;
    box.appendChild(warn);

    const confirmRow = el("div", "form-row");
    const label = el("label", "adjudicate");
    const check = el("input");
    check.type = "checkbox";
    check.id = "settings-dir-confirm";
    check.checked = state.dir_confirmed;
    check.addEventListener("change", () => { state.dir_confirmed = check.checked; refreshDirHint(); });
    label.appendChild(check);
    label.appendChild(el("span", null, "我明白数据不会自动搬过去，确认更改"));
    confirmRow.appendChild(label);
    box.appendChild(confirmRow);

    const actions = el("div", "form-actions");
    const button = el("button", "primary", "更改数据目录");
    button.type = "button";
    button.id = "settings-save-dir";
    button.addEventListener("click", doSaveDataDir);
    actions.appendChild(button);
    box.appendChild(actions);

    const hint = el("div", "gate-line");
    hint.id = "settings-dir-hint";
    box.appendChild(hint);
    setTimeout(refreshDirHint, 0);
    return box;
  }

  function refreshDirHint() {
    const hint = document.getElementById("settings-dir-hint");
    const button = document.getElementById("settings-save-dir");
    if (!hint || !button) return;
    const verdict = M.dataDirPayload(state.data_dir_input, (state.settings || {}).data_dir, state.dir_confirmed);
    if (verdict.ok) {
      hint.textContent = "将写入新的数据目录（下次读写就生效）。";
      hint.className = "gate-line";
      button.disabled = false;
      return;
    }
    hint.textContent = verdict.needs_confirm ? "请先勾选上面的确认框。" : verdict.error;
    hint.className = "gate-line warn";
    button.disabled = true;
  }

  async function doSaveDataDir() {
    try {
      showError("");
      const verdict = M.dataDirPayload(state.data_dir_input, (state.settings || {}).data_dir, state.dir_confirmed);
      if (!verdict.ok) throw new Error(verdict.error);
      await call("settingsSet", verdict.payload);
      await loadAll();
      state.dir_confirmed = false;
      const check = document.getElementById("settings-dir-confirm");
      if (check) check.checked = false;
      showNotice("数据目录已更改。原目录里的文件没有被移动，需要搬家请用「备份 / 恢复」。");
      renderAll();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ------------------------------------------------------- 装配 */

  function renderAll() {
    container.textContent = "";
    const wrap = el("div", "wizard");

    const notice = el("div", "banner");
    notice.id = "settings-notice";
    notice.hidden = !state.notice;
    notice.textContent = state.notice;
    wrap.appendChild(notice);

    const error = el("div", "banner error");
    error.id = "settings-error";
    error.hidden = !state.error;
    error.textContent = state.error;
    wrap.appendChild(error);

    const body = el("div", "wizard-body");
    body.appendChild(renderThresholdBox());
    body.appendChild(renderLowStockBox());
    body.appendChild(renderDataDirBox());
    wrap.appendChild(body);

    container.appendChild(wrap);
  }

  function mount(target) {
    container = target;
    reset();
    renderAll();
    loadAll()
      .then(() => renderAll())
      .catch((exc) => showError(exc.message));
  }

  root.SettingsPage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
