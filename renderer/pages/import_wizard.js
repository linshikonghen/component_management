"use strict";
/**
 * import_wizard.js — 导入 BOM 的三步向导（spec FR-1 / §8 导航映射）
 *
 *   ① 选文件 + 套数 → 解析
 *   ② **人工核对表**（本工具唯一允许写入库存的入口，spec FR-1.3）
 *   ③ 入库汇总（新增 / 合并 / 跳过）
 *
 * 规则全部来自 `renderer/model/import_model.js`（那份有逐条无头测试），
 * 本文件只做 DOM 装配与事件绑定——**不在这里判断业务规则**，
 * 否则"规则"就会有两份（一份在模型里被测试，一份在这里被上线）。
 *
 * 安全：所有来自 BOM 的文本一律用 `textContent` / `input.value` 写入，绝不拼接 HTML，
 * 因此 BOM 单元格里塞 `<script>` 也只是普通文本。
 *
 * 渲染策略：表格**只整体渲染一次**；输入改动只更新对应 state 与"能否入库"那一条状态区，
 * 不重画表格——否则每敲一个字符光标就会跳走。
 */

(function (root) {
  "use strict";

  const M = root.ImportModel;
  if (!M) throw new Error("import_model.js 必须先于 import_wizard.js 加载");

  const COLUMNS = [
    { key: "row_no", label: "行", readonly: true },
    { key: "value", label: "值", editable: true },
    { key: "footprint", label: "封装", editable: true },
    { key: "voltage", label: "耐压", editable: true },
    { key: "dielectric", label: "材质", editable: true },
    { key: "tolerance", label: "容差", editable: true },
    { key: "designators", label: "位号", readonly: true },
    { key: "quantity_per_board", label: "BOM 原数量", readonly: true },
    { key: "_formula", label: "算式", readonly: true },
    { key: "total_quantity", label: "应入库量", readonly: true },
    { key: "intake_quantity", label: "本次入库量", editable: true, intake: true },
    { key: "manufacturer_part", label: "型号", editable: true },
    { key: "manufacturer", label: "厂商", editable: true },
    // v1.5 实现期补记：spec FR-1.6 允许核对时改「库位」「低库存阈值」，契约补齐后加回这两列
    { key: "location", label: "库位", editable: true },
    { key: "min_quantity", label: "低库存阈值", editable: true, hint: "留空=继承分类默认" },
    { key: "note", label: "备注", editable: true },
  ];

  let state = null;
  let container = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function reset() {
    state = { step: 1, file_path: "", sets: 1, batch_id: "", items: [], warnings: [], result: null, error: "" };
  }

  /** 统一包裹 IPC 调用：把 {ok,error} 变成"要么返回数据、要么抛出可显示的错误" */
  async function call(method, payload) {
    const api = root.api;
    if (!api || typeof api[method] !== "function") throw new Error(`IPC 方法不存在：${method}`);
    const r = await api[method](payload);
    if (!r || r.ok !== true) throw new Error((r && r.error) || `${method} 调用失败`);
    return r;
  }

  /* ------------------------------------------------------------ 骨架 */

  function renderShell() {
    container.textContent = "";
    const wrap = el("div", "wizard");

    const steps = el("ol", "steps");
    ["选择文件与套数", "人工核对（必须逐条确认）", "入库结果"].forEach((label, i) => {
      const li = el("li", "step", `${i + 1}. ${label}`);
      li.dataset.step = String(i + 1);
      steps.appendChild(li);
    });
    wrap.appendChild(steps);

    const error = el("div", "banner error");
    error.id = "import-error";
    error.hidden = true;
    wrap.appendChild(error);

    const body = el("div", "wizard-body");
    body.id = "import-body";
    wrap.appendChild(body);

    container.appendChild(wrap);
  }

  function showError(message) {
    const box = document.getElementById("import-error");
    box.textContent = message || "";
    box.hidden = !message;
    if (message) console.error("[导入]", message);
  }

  function setStep(step) {
    state.step = step;
    for (const li of container.querySelectorAll(".step")) {
      li.classList.toggle("active", Number(li.dataset.step) === step);
    }
  }

  /* --------------------------------------------------- 第 1 步：选文件 */

  function renderStep1() {
    setStep(1);
    const body = document.getElementById("import-body");
    body.textContent = "";

    const row = el("div", "form-row");
    const fileLabel = el("label", null, "BOM 文件：");
    const fileBox = el("input", "file-box");
    fileBox.id = "import-file";
    fileBox.readOnly = true;
    fileBox.value = state.file_path || "";
    fileBox.placeholder = "（未选择）";
    const pick = el("button", null, "选择文件…");
    pick.type = "button";
    pick.id = "import-pick";
    pick.addEventListener("click", async () => {
      try {
        showError("");
        const r = await call("bomPickFiles", {});
        if (!r.file_paths || r.file_paths.length === 0) return; // 用户取消
        state.file_path = r.file_paths[0];
        fileBox.value = state.file_path;
        if (r.file_paths.length > 1) {
          // FR-1.1 支持多选；本版先明确告知只处理第一个，不做静默丢弃
          showError(`一次选择了 ${r.file_paths.length} 个文件，本版先处理第一个：${state.file_path}`);
        }
      } catch (exc) {
        showError(exc.message);
      }
    });
    row.appendChild(fileLabel);
    row.appendChild(fileBox);
    row.appendChild(pick);
    body.appendChild(row);

    const setsRow = el("div", "form-row");
    setsRow.appendChild(el("label", null, "套数（本次做几块板）："));
    const sets = el("input", "sets-input");
    sets.id = "import-sets";
    sets.type = "number";
    sets.min = "1";
    sets.step = "1";
    sets.value = String(state.sets);
    sets.addEventListener("input", () => { state.sets = Number(sets.value); });
    setsRow.appendChild(sets);
    setsRow.appendChild(el("span", "hint", "应入库量 = BOM 单套数量 × 套数；套数必须是 ≥1 的整数"));
    body.appendChild(setsRow);

    const actions = el("div", "form-actions");
    const start = el("button", "primary", "开始解析并进入核对");
    start.type = "button";
    start.id = "import-start";
    start.addEventListener("click", startParse);
    actions.appendChild(start);
    body.appendChild(actions);

    body.appendChild(el("p", "hint",
      "提示：解析只是读出 BOM 内容，不会改动库存。真正入库要等你在核对表里逐条确认后点「确认入库」。"));
  }

  async function startParse() {
    try {
      showError("");
      if (!state.file_path) throw new Error("请先选择 BOM 文件");
      const sets = Number(state.sets);
      if (!Number.isInteger(sets) || sets < 1) throw new Error("套数必须是 ≥1 的整数");
      const r = await call("bomParse", { file_path: state.file_path, sets });
      state.batch_id = r.batch_id;
      state.warnings = r.warnings || [];
      // adjudicated 是核对阶段的本地标记（不进 IPC，契约里没有这个字段）
      state.items = (r.items || []).map((it) => Object.assign({}, it, { adjudicated: false }));
      renderStep2();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ------------------------------------------------- 第 2 步：核对表 */

  function renderStep2() {
    setStep(2);
    const body = document.getElementById("import-body");
    body.textContent = "";

    const head = el("div", "review-head");
    head.appendChild(el("div", "review-title",
      `${state.file_path.split(/[\\/]/).pop()} · 套数 ${state.sets} · 共 ${state.items.length} 条`));
    const back = el("button", null, "← 返回重新选择");
    back.type = "button";
    back.addEventListener("click", () => renderStep1());
    head.appendChild(back);
    body.appendChild(head);

    if (state.warnings.length > 0) {
      const warn = el("div", "banner warn");
      warn.appendChild(el("strong", null, `解析提示 ${state.warnings.length} 条：`));
      const list = el("ul");
      for (const w of state.warnings) list.appendChild(el("li", null, w));
      warn.appendChild(list);
      body.appendChild(warn);
    }

    body.appendChild(el("p", "hint",
      "「应入库量 / BOM 原数量 / 位号」是 BOM 事实，只读（灰底）；"
      + "带 ✎ 的列可以直接改 —— 「本次入库量」改的是本次实际入库量，"
      + "改完会留痕（原应入库量 / 实际入库量 / 已人工修改），绝不回写 BOM 文件。"));

    const scroller = el("div", "table-scroll");
    const table = el("table", "review-table");
    const thead = el("thead");
    const headRow = el("tr");
    for (const col of COLUMNS) {
      const th = el("th", col.editable ? "editable" : null, col.label);
      headRow.appendChild(th);
    }
    headRow.appendChild(el("th", null, "裁决"));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    tbody.id = "review-body";
    state.items.forEach((item, idx) => tbody.appendChild(renderRow(item, idx)));
    table.appendChild(tbody);
    scroller.appendChild(table);
    body.appendChild(scroller);

    const gate = el("div", "gate");
    gate.id = "import-gate";
    body.appendChild(gate);

    const actions = el("div", "form-actions");
    const commit = el("button", "primary", "确认入库");
    commit.type = "button";
    commit.id = "import-commit";
    commit.addEventListener("click", doCommit);
    actions.appendChild(commit);
    body.appendChild(actions);

    refreshGate();
  }

  function renderRow(item, idx) {
    const tr = el("tr");
    tr.dataset.idx = String(idx);
    const mismatch = M.hasQuantityMismatch(item);
    if (mismatch) tr.classList.add("mismatch");
    if (item.action === "skip") tr.classList.add("skipped");

    for (const col of COLUMNS) {
      const td = el("td");
      if (col.key === "_formula") {
        td.textContent = M.formulaText(item, state.sets);
        td.className = "formula";
      } else if (col.editable) {
        const input = el("input");
        input.type = col.intake || col.key === "min_quantity" ? "number" : "text";
        if (col.intake) { input.min = "0"; input.className = "intake"; }
        if (col.key === "min_quantity") { input.min = "0"; input.placeholder = "留空=继承"; }
        input.value = item[col.key] == null ? "" : String(item[col.key]);
        input.dataset.idx = String(idx);
        input.dataset.field = col.key;
        input.addEventListener("input", onFieldInput);
        input.addEventListener("change", onFieldInput);
        td.appendChild(input);
      } else if (col.key === "designators") {
        td.textContent = (item.designators || []).join(",");
        td.className = "designators";
      } else if (col.key === "quantity_per_board" || col.key === "total_quantity") {
        td.textContent = String(item[col.key]);
        td.className = "readonly-num";
      } else {
        td.textContent = item[col.key] == null ? "" : String(item[col.key]);
      }
      tr.appendChild(td);
    }

    // 裁决列：数量与位号不符时给一个"已核实"勾选（FR-1.5 要求人工裁决）
    const judge = el("td", "judge");
    if (mismatch) {
      const label = el("label", "adjudicate");
      const check = el("input");
      check.type = "checkbox";
      check.checked = M.isAdjudicated(item);
      check.dataset.idx = String(idx);
      check.addEventListener("change", onAdjudicate);
      label.appendChild(check);
      label.appendChild(el("span", null, "已核实"));
      judge.appendChild(label);
      judge.appendChild(el("div", "mismatch-note",
        `数量 ${item.quantity_per_board} 与位号个数 ${item.designator_count} 不符`));
    }
    const skipLabel = el("label", "skip-toggle");
    const skipBox = el("input");
    skipBox.type = "checkbox";
    skipBox.checked = item.action === "skip";
    skipBox.dataset.idx = String(idx);
    skipBox.addEventListener("change", onToggleSkip);
    skipLabel.appendChild(skipBox);
    skipLabel.appendChild(el("span", null, "跳过"));
    judge.appendChild(skipLabel);
    tr.appendChild(judge);

    return tr;
  }

  function onFieldInput(event) {
    const idx = Number(event.target.dataset.idx);
    const field = event.target.dataset.field;
    const result = M.applyEdit(state.items[idx], field, event.target.value);
    if (!result.ok) {
      // 被拒绝时必须**看得见**，而且不能假装改成功了
      showError(result.error);
      event.target.value = state.items[idx][field] == null ? "" : String(state.items[idx][field]);
      return;
    }
    showError("");
    state.items[idx] = result.item;
    const row = event.target.closest("tr");
    row.classList.toggle("mismatch-changed", result.item.edited_by_human === true);
    refreshGate();
  }

  function onToggleSkip(event) {
    const idx = Number(event.target.dataset.idx);
    state.items[idx] = M.toggleSkip(state.items[idx], event.target.checked, state.items[idx].note);
    const row = event.target.closest("tr");
    row.classList.toggle("skipped", state.items[idx].action === "skip");
    refreshGate();
  }

  function onAdjudicate(event) {
    const idx = Number(event.target.dataset.idx);
    state.items[idx] = M.setAdjudicated(state.items[idx], event.target.checked);
    const row = event.target.closest("tr");
    row.classList.toggle("adjudicated", event.target.checked);
    refreshGate();
  }

  /** 只更新"能否入库"这一条状态，不重画表格（否则输入焦点会丢） */
  function refreshGate() {
    const gate = document.getElementById("import-gate");
    if (!gate) return;
    const verdict = M.canCommit(state.items);
    const s = verdict.summary;
    gate.textContent = "";
    gate.appendChild(el("span", "gate-line",
      `待入库 ${s.keep} 条 · 跳过 ${s.skip} 条（其中入库量为 0 的 ${s.skip_zero} 条）`
      + (s.invalid > 0 ? ` · 非法 ${s.invalid} 条` : "")
      + ` · 合计 ${s.total} 条`));

    const button = document.getElementById("import-commit");
    if (button) button.disabled = !verdict.ok;

    if (!verdict.ok) {
      const box = el("div", "banner warn");
      box.appendChild(el("strong", null, "还不能入库："));
      const list = el("ul");
      for (const b of verdict.blockers) list.appendChild(el("li", null, b));
      box.appendChild(list);
      gate.appendChild(box);
    }
  }

  /* --------------------------------------------------- 第 3 步：汇总 */

  async function doCommit() {
    try {
      showError("");
      const verdict = M.canCommit(state.items);
      if (!verdict.ok) throw new Error(verdict.blockers.join("；"));
      const r = await call("bomCommit", {
        batch_id: state.batch_id,
        items: M.toCommitItems(state.items),
        sets: state.sets,
        source: state.file_path.split(/[\\/]/).pop(),
      });
      state.result = r;
      renderStep3();
      if (typeof root.refreshInventory === "function") root.refreshInventory();
    } catch (exc) {
      showError(exc.message);
    }
  }

  function renderStep3() {
    setStep(3);
    const body = document.getElementById("import-body");
    body.textContent = "";
    const r = state.result;

    const box = el("div", "result");
    box.appendChild(el("h3", null, "入库完成"));
    const list = el("ul", "result-list");
    list.appendChild(el("li", null, `新增 ${r.added} 条`));
    list.appendChild(el("li", null, `合并（同规格累加）${r.merged} 条`));
    list.appendChild(el("li", null, `跳过 ${r.skipped} 条`));
    list.appendChild(el("li", "muted", `三数之和 = ${r.added + r.merged + r.skipped}，等于本次条目总数 ${(r.summary && r.summary.total) || state.items.length}`));
    box.appendChild(list);

    if (r.skip_details && r.skip_details.length > 0) {
      box.appendChild(el("h4", null, "跳过的条目"));
      const ul = el("ul");
      for (const d of r.skip_details) ul.appendChild(el("li", null, `第 ${d.row_no} 行：${d.reason}`));
      box.appendChild(ul);
    }
    if (r.errors && r.errors.length > 0) {
      const warn = el("div", "banner warn");
      warn.appendChild(el("strong", null, "以下条目未入库："));
      const ul = el("ul");
      for (const e of r.errors) ul.appendChild(el("li", null, e));
      warn.appendChild(ul);
      box.appendChild(warn);
    }

    const actions = el("div", "form-actions");
    const again = el("button", "primary", "再导入一份");
    again.type = "button";
    again.addEventListener("click", () => { reset(); renderStep1(); });
    actions.appendChild(again);
    box.appendChild(actions);
    body.appendChild(box);
  }

  /* ------------------------------------------------------------ 挂载 */

  function mount(target, options) {
    container = target;
    reset();
    if (options && options.file_path) state.file_path = options.file_path;
    renderShell();
    renderStep1();
  }

  root.ImportPage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
