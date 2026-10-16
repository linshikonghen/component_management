"use strict";
/**
 * stock_page.js — 领料页（spec FR-7 / AC-7）
 *
 * **这一页是领料的唯一入口**（FR-7.6：领料与比对入口隔离，比对页不得有领料按钮）。
 * 两个入口：
 *   ① 手动出/入库：选器件 + 方向 + 数量 + 原因（FR-7.1/7.2/7.3）
 *   ② 按 BOM 领料：选 BOM + 套数 +（可选）允许部分领用 + 原因（FR-7.4/7.5）
 *
 * 规则全在 `renderer/model/stock_model.js`（有无头测试）；本文件只做 DOM 装配。
 * 每次操作后都刷新「最近变动记录」——这样"库存 −5、留了一条 out 记录"是**看得见**的（AC-7 的验收方式）。
 */

(function (root) {
  "use strict";

  const M = root.StockModel;
  const PM = root.PartsModel;
  if (!M) throw new Error("stock_model.js 必须先于 stock_page.js 加载");

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
      tab: "move",
      parts: [],
      low_ids: [],
      move: { part_id: "", direction: "out", amount: "", reason: "" },
      pick: { file_path: "", sets: 1, reason: "", allow_partial: false },
      movements: [],
      result: null,
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
    const box = document.getElementById("stock-error");
    if (box) {
      box.textContent = message || "";
      box.hidden = !message;
    }
    state.error = message || "";
    if (message) console.error("[领料]", message);
  }

  /* ---------------------------------------------------------- 数据 */

  async function loadParts() {
    const r = await call("partsList", { query: {} });
    state.parts = r.parts || [];
    state.low_ids = r.low_stock_ids || [];
  }

  async function loadMovements() {
    const r = await call("movementsList", {});
    state.movements = (r.movements || []).slice(0, 10);
  }

  /* ------------------------------------------------- 手动出/入库 */

  function renderMoveBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "手动出 / 入库"));

    if (state.parts.length === 0) {
      box.appendChild(el("p", "hint", "库里还没有器件。先去「导入 BOM」或「手动录入」。"));
      return box;
    }

    const row1 = el("div", "form-row");
    row1.appendChild(el("label", null, "器件："));
    const select = el("select");
    select.id = "stock-part";
    select.className = "wide-select";
    const placeholder = el("option", null, "（请选择）");
    placeholder.value = "";
    select.appendChild(placeholder);
    for (const part of state.parts) {
      const option = el("option", null, M.partOptionText(part, state.low_ids));
      option.value = part.id;
      if (part.id === state.move.part_id) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => { state.move.part_id = select.value; });
    row1.appendChild(select);
    box.appendChild(row1);

    const row2 = el("div", "form-row");
    row2.appendChild(el("label", null, "方向："));
    const dir = el("select");
    dir.id = "stock-direction";
    for (const d of M.DIRECTIONS) {
      const option = el("option", null, `${d.label} — ${d.hint}`);
      option.value = d.key;
      if (d.key === state.move.direction) option.selected = true;
      dir.appendChild(option);
    }
    dir.addEventListener("change", () => { state.move.direction = dir.value; });
    row2.appendChild(dir);

    row2.appendChild(el("label", null, "数量："));
    const amount = el("input", "sets-input");
    amount.id = "stock-amount";
    amount.type = "number";
    amount.min = "1";
    amount.step = "1";
    amount.value = state.move.amount === "" ? "" : String(state.move.amount);
    amount.addEventListener("input", () => { state.move.amount = amount.value; });
    row2.appendChild(amount);
    box.appendChild(row2);

    const row3 = el("div", "form-row");
    row3.appendChild(el("label", null, "原因："));
    const reason = el("input", "file-box");
    reason.id = "stock-reason";
    reason.placeholder = "如：打样领用 / 补货入库（必填，出入库记录要能对账）";
    reason.value = state.move.reason;
    reason.addEventListener("input", () => { state.move.reason = reason.value; });
    row3.appendChild(reason);
    box.appendChild(row3);

    const actions = el("div", "form-actions");
    const run = el("button", "primary", "执行");
    run.type = "button";
    run.id = "stock-move-run";
    run.addEventListener("click", doMove);
    actions.appendChild(run);
    box.appendChild(actions);

    if (state.result && state.result.kind === "move") {
      const done = el("div", "banner");
      done.appendChild(el("strong", null, state.result.message));
      if (state.result.movement) {
        done.appendChild(el("div", "gate-line", PM.describeMovement(state.result.movement)
          + ` · 原因：${state.result.movement.reason || "—"}`));
      }
      box.appendChild(done);
    }
    return box;
  }

  async function doMove() {
    try {
      showError("");
      const built = M.toMoveRequest(state.move);
      if (!built.ok) throw new Error(built.error);
      const r = await call("stockMove", built.request);
      state.result = {
        kind: "move",
        message: `已${built.request.delta < 0 ? "出库" : "入库"}：${r.part.value} / ${r.part.footprint}，`
          + `库存 ${built.request.delta < 0 ? r.movement.before + " → " + r.movement.after : r.movement.before + " → " + r.movement.after}`,
        movement: r.movement,
      };
      state.move.amount = "";
      await Promise.all([loadParts(), loadMovements()]);
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      renderAll();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ------------------------------------------------- 按 BOM 领料 */

  function renderPickBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "按 BOM 领料"));
    box.appendChild(el("p", "hint",
      "按一份 BOM 与套数一次性扣减；库存不足默认整单拒绝（库存一点不动），勾选「允许部分领用」才按现有量扣。"));

    const row1 = el("div", "form-row");
    row1.appendChild(el("label", null, "BOM 文件："));
    const fileBox = el("input", "file-box");
    fileBox.id = "stock-file";
    fileBox.readOnly = true;
    fileBox.value = state.pick.file_path || "";
    fileBox.placeholder = "（未选择）";
    const pick = el("button", null, "选择文件…");
    pick.type = "button";
    pick.addEventListener("click", async () => {
      try {
        showError("");
        const r = await call("bomPickFiles", {});
        if (!r.file_paths || r.file_paths.length === 0) return;
        state.pick.file_path = r.file_paths[0];
        fileBox.value = state.pick.file_path;
      } catch (exc) {
        showError(exc.message);
      }
    });
    row1.appendChild(fileBox);
    row1.appendChild(pick);
    box.appendChild(row1);

    const row2 = el("div", "form-row");
    row2.appendChild(el("label", null, "套数："));
    const sets = el("input", "sets-input");
    sets.id = "stock-sets";
    sets.type = "number";
    sets.min = "1";
    sets.step = "1";
    sets.value = String(state.pick.sets);
    sets.addEventListener("input", () => { state.pick.sets = sets.value; });
    row2.appendChild(sets);

    const partialLabel = el("label", "adjudicate");
    const partial = el("input");
    partial.type = "checkbox";
    partial.id = "stock-allow-partial";
    partial.checked = state.pick.allow_partial;
    partial.addEventListener("change", () => { state.pick.allow_partial = partial.checked; });
    partialLabel.appendChild(partial);
    partialLabel.appendChild(el("span", null, "允许部分领用（按现有量扣）"));
    row2.appendChild(partialLabel);
    box.appendChild(row2);

    const row3 = el("div", "form-row");
    row3.appendChild(el("label", null, "领用原因："));
    const reason = el("input", "file-box");
    reason.id = "stock-pick-reason";
    reason.placeholder = "如：打样领用（必填，每条扣减都带这个原因）";
    reason.value = state.pick.reason;
    reason.addEventListener("input", () => { state.pick.reason = reason.value; });
    row3.appendChild(reason);
    box.appendChild(row3);

    const actions = el("div", "form-actions");
    const run = el("button", "primary", "执行领料");
    run.type = "button";
    run.id = "stock-pick-run";
    run.addEventListener("click", doPick);
    actions.appendChild(run);
    box.appendChild(actions);

    if (state.result && state.result.kind === "pick") {
      const r = state.result.raw;
      const summary = M.pickSummary(r);
      const done = el("div", "banner " + (summary.ok ? "" : "warn"));
      done.appendChild(el("strong", null, summary.message));
      box.appendChild(done);

      if (r.picked && r.picked.length > 0) {
        box.appendChild(el("h4", null, "扣减明细"));
        const table = el("table", "review-table");
        const thead = el("thead");
        const head = el("tr");
        for (const title of ["器件", "型号", "需", "实扣", "扣后库存"]) head.appendChild(el("th", null, title));
        thead.appendChild(head);
        table.appendChild(thead);
        const tbody = el("tbody");
        for (const x of r.picked) {
          const tr = el("tr");
          tr.appendChild(el("td", null, x.part_id));
          tr.appendChild(el("td", null, x.part_number || "—"));
          tr.appendChild(el("td", "readonly-num", x.required));
          tr.appendChild(el("td", "readonly-num", x.deducted));
          tr.appendChild(el("td", "readonly-num", x.after));
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        box.appendChild(table);
      }

      const insuff = M.insufficientLines(r);
      if (insuff.length > 0) {
        box.appendChild(el("h4", null, `库存不足（${insuff.length} 条）`));
        const ul = el("ul");
        for (const line of insuff) ul.appendChild(el("li", null, `${line.part_id}：${line.text}`));
        box.appendChild(ul);
      }

      const unknown = M.unknownLines(r);
      if (unknown.length > 0) {
        box.appendChild(el("h4", null, `库中没有的条目（${unknown.length} 条，未扣减）`));
        const ul = el("ul");
        for (const line of unknown) ul.appendChild(el("li", null, line.text));
        box.appendChild(ul);
      }
    }
    return box;
  }

  async function doPick() {
    try {
      showError("");
      const built = M.toPickRequest(state.pick);
      if (!built.ok) throw new Error(built.error);
      // 领料失败（整单拒绝）时 IPC 返回 ok:false —— 那是**结果**不是异常，要连同缺口一起展示
      const raw = await root.api.stockPickByBom(built.request);
      state.result = { kind: "pick", raw };
      await Promise.all([loadParts(), loadMovements()]);
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      if (raw && raw.ok !== true) showError(raw.error || "领料未执行");
      renderAll();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ----------------------------------------------------- 最近变动 */

  function renderMovementsBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "最近变动记录（10 条）"));
    if (state.movements.length === 0) {
      box.appendChild(el("p", "hint", "还没有变动记录。"));
      return box;
    }
    const table = el("table", "review-table");
    const thead = el("thead");
    const head = el("tr");
    for (const title of ["时间", "类型", "变动", "原因", "批次"]) head.appendChild(el("th", null, title));
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const m of state.movements) {
      const tr = el("tr");
      tr.appendChild(el("td", null, m.at || ""));
      tr.appendChild(el("td", null, (PM && PM.KIND_LABELS[m.kind]) || m.kind || ""));
      tr.appendChild(el("td", "readonly-num", PM ? PM.describeMovement(m) : String(m.delta)));
      tr.appendChild(el("td", null, m.reason || "—"));
      tr.appendChild(el("td", null, m.ref || "—"));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  /* ------------------------------------------------------- 装配 */

  function renderAll() {
    container.textContent = "";
    const wrap = el("div", "wizard");

    const error = el("div", "banner error");
    error.id = "stock-error";
    error.hidden = !state.error;
    error.textContent = state.error;
    wrap.appendChild(error);

    const tabs = el("div", "tabs");
    for (const tab of [{ key: "move", label: "手动出 / 入库" }, { key: "pick", label: "按 BOM 领料" }]) {
      const button = el("button", "tab" + (state.tab === tab.key ? " active" : ""), tab.label);
      button.type = "button";
      button.addEventListener("click", () => { state.tab = tab.key; renderAll(); });
      tabs.appendChild(button);
    }
    wrap.appendChild(tabs);

    const body = el("div", "wizard-body");
    body.appendChild(state.tab === "move" ? renderMoveBox() : renderPickBox());
    body.appendChild(renderMovementsBox());
    wrap.appendChild(body);

    container.appendChild(wrap);
  }

  function mount(target) {
    container = target;
    reset();
    renderAll();
    Promise.all([loadParts(), loadMovements()])
      .then(() => renderAll())
      .catch((exc) => showError(exc.message));
  }

  root.StockPage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
