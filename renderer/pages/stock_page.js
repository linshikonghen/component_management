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
  /** 检索请求守卫：晚到的旧响应不许覆盖新候选（实现见 renderer/ui_util.js） */
  const moveGuard = root.UIUtil.requestGuard();

  const el = root.UIUtil.el;

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
      busy: false, // 防重入：出/入库或领料请求在飞时，按钮 disabled（对抗审计 B1）
      // **检索 / 筛选**（用户 2026-10-17 目标：领料太繁琐，至少要有检索、筛选）：
      // 语义在服务层 part_search.js（与库存页同一套：0.1uF 也能搜到 100nF），这里只存状态
      move_query: { q: "", category: "", footprint: "" },
      move_options: null,     // null = 还没筛过 → 用全部 parts
      move_similar_ids: [],
      move_facets: null,      // { categories, footprints, voltages } 供下拉框
      move_filtering: false,
    };
  }

  const call = function (method, payload) {
    return root.UIUtil.call(root.api, method, payload);
  };

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
    moveGuard.invalidate(); // 作废在飞的检索请求
    const r = await call("partsList", { query: {} });
    state.parts = r.parts || [];
    state.low_ids = r.low_stock_ids || [];
    state.move_facets = r.facets || null; // 分类/封装下拉的候选值（服务端用全量算）
    state.move_options = null;            // 回到"未筛选"（下次渲染用全部 parts）
    state.move_similar_ids = [];
  }

  /** 当前要显示的候选器件（筛过就用筛过的，否则全部） */
  function moveCandidateParts() {
    return Array.isArray(state.move_options) ? state.move_options : state.parts;
  }

  /** 领料页当前是否有检索/筛选条件（出库成功后要把候选列表按原条件重建，不能悄悄变回全部） */
  function hasMoveQuery() {
    const q = state.move_query || {};
    return String(q.q || "") !== "" || String(q.category || "") !== "" || String(q.footprint || "") !== "";
  }

  async function loadMovements() {
    const r = await call("movementsList", {});
    state.movements = (r.movements || []).slice(0, 10);
  }

  /* ------------------------------------------------- 手动出/入库 */

  /** 重建"器件"下拉（只更新这一块，避免整页重画把输入框焦点弄丢） */
  function updateMovePartSelect() {
    const select = document.getElementById("stock-part");
    const hint = document.getElementById("stock-part-hint");
    if (!select) return;
    const parts = moveCandidateParts();
    const lowSet = new Set(state.low_ids || []);
    select.textContent = "";
    const placeholder = el("option", null, "（请选择）");
    placeholder.value = "";
    select.appendChild(placeholder);
    for (const part of parts) {
      const option = el("option", null, M.partOptionText(part, state.low_ids));
      option.value = part.id;
      if (part.id === state.move.part_id) option.selected = true;
      select.appendChild(option);
    }
    // 选中项被筛掉了 → 清掉选择，避免"界面上看不见却还选着某条"
    const stillThere = parts.some((p) => p.id === state.move.part_id);
    if (!stillThere) state.move.part_id = "";
    select.value = stillThere ? state.move.part_id : "";

    if (hint) {
      const similar = (state.move_similar_ids || []).length;
      let text = `可选 ${parts.length} 条`;
      if (state.move_query.q !== "" || state.move_query.category !== "" || state.move_query.footprint !== "") {
        text += `（库里共 ${state.parts.length} 条；已按检索/筛选收窄）`;
      }
      if (similar > 0) text += `；其中 ${similar} 条为相似命中（写法不同、值相同）`;
      else if (state.move_query.q !== "" && parts.length === 0) {
        text += "；没有匹配的器件（换个写法试试：0.1uF 与 100nF、4K7 与 4.7kΩ 视为同一个值）";
      }
      const low = parts.filter((p) => lowSet.has(p.id)).length;
      if (low > 0) text += `；其中 ${low} 条低于库存阈值`;
      hint.textContent = text;
    }
  }

  /** 向服务端要"检索/筛选后的候选"（语义在 part_service，不在界面里重复实现） */
  async function refreshMoveOptions() {
    const gen = moveGuard.next();
    state.move_filtering = true;
    try {
      const r = await call("partsList", {
        query: {
          q: state.move_query.q,
          category: state.move_query.category,
          footprint: state.move_query.footprint,
        },
      });
      // 竞态防护：等待期间用户又检索/改筛选/点了清除 → 本次结果作废
      if (!moveGuard.isCurrent(gen)) return;
      state.move_options = r.parts || [];
      state.move_similar_ids = r.similar_ids || [];
      state.move_facets = r.facets || state.move_facets;
      if (state.tab === "move") updateMovePartSelect();
    } catch (exc) {
      showError((exc && exc.message) || String(exc));
    } finally {
      state.move_filtering = false;
    }
  }

  /** 检索输入去抖 200ms（实现见 renderer/ui_util.js） */
  const scheduleMoveFilter = root.UIUtil.debounce(refreshMoveOptions, 200);

  function renderMoveBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "手动出 / 入库"));

    if (state.parts.length === 0) {
      box.appendChild(el("p", "hint", "库里还没有器件。先去「导入 BOM」或「手动录入」。"));
      return box;
    }

    // **检索 + 筛选**（用户目标：领料太繁琐）：先按 值/型号/封装 搜，再按分类/封装筛
    const filterRow = el("div", "form-row");
    filterRow.id = "stock-filter-row";
    filterRow.appendChild(el("label", null, "检索："));
    const search = el("input");
    search.id = "stock-part-search";
    search.type = "search";
    search.className = "file-box-wide";
    search.placeholder = "搜 值/型号/封装/库位…（0.1uF 也能搜到 100nF）";
    search.value = state.move_query.q;
    search.addEventListener("input", () => {
      state.move_query.q = search.value.trim();
      scheduleMoveFilter();
    });
    // 行业常规：按 Enter 立即检索（跳过 200ms 去抖）
    search.addEventListener("keydown", (event) => {
      if (event && (event.key === "Enter" || event.keyCode === 13)) {
        scheduleMoveFilter.cancel();
        refreshMoveOptions();
      }
    });
    if (typeof search.setAttribute === "function") search.setAttribute("aria-label", "检索器件");
    filterRow.appendChild(search);

    const facets = state.move_facets || { categories: [], footprints: [] };
    for (const [key, id, label, values] of [
      ["category", "stock-filter-category", "分类：", facets.categories || []],
      ["footprint", "stock-filter-footprint", "封装：", facets.footprints || []],
    ]) {
      filterRow.appendChild(el("label", null, label));
      const pick = el("select", "filter-select");
      pick.id = id;
      const all = el("option", null, "全部");
      all.value = "";
      pick.appendChild(all);
      for (const value of values) {
        const option = el("option", null, value);
        option.value = value;
        if (value === state.move_query[key]) option.selected = true;
        pick.appendChild(option);
      }
      pick.addEventListener("change", () => {
        state.move_query[key] = pick.value;
        refreshMoveOptions();
      });
      filterRow.appendChild(pick);
    }
    const clearMoveFilter = el("button", "link", "清除检索/筛选");
    clearMoveFilter.type = "button";
    clearMoveFilter.id = "stock-filter-clear";
    clearMoveFilter.addEventListener("click", () => {
      state.move_query = { q: "", category: "", footprint: "" };
      state.move_options = null;   // 回到"全部候选"
      state.move_similar_ids = [];
      moveGuard.invalidate();      // 作废还在飞的检索请求（否则它晚到会覆盖"全部候选"）
      renderAll();                 // 检索框/下拉/候选一起复位
    });
    filterRow.appendChild(clearMoveFilter);
    box.appendChild(filterRow);

    const row1 = el("div", "form-row");
    row1.appendChild(el("label", null, "器件："));
    const select = el("select");
    select.id = "stock-part";
    select.className = "wide-select";
    select.addEventListener("change", () => {
      state.move.part_id = select.value;
      updateMovePartSelect();
    });
    row1.appendChild(select);
    box.appendChild(row1);

    // 结果提示：找到几条 + **相似命中**说明（与库存页同一套语义）
    const hint = el("p", "hint");
    hint.id = "stock-part-hint";
    box.appendChild(hint);
    updateMovePartSelect();

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
    // 防重入（对抗审计 B1；与 T94 parts_editor 的 state.saving 同一模式）：
    // stock:move 每次都是独立操作，双击两下就真的扣两次库存 → 按钮层必须先挡住
    if (state.busy) return;
    state.busy = true;
    const runBtn = document.getElementById("stock-move-run");
    if (runBtn) runBtn.disabled = true;
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
      // loadParts 会把候选复位成"全部"；若用户还在检索/筛选状态，按原条件重建候选，
      // 否则会出现"搜索框里还有词、候选却是全库"的不一致（用户目标：检索要好用）
      if (hasMoveQuery()) await refreshMoveOptions();
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      renderAll();
    } catch (exc) {
      showError(exc.message);
    } finally {
      state.busy = false;
      const btn = document.getElementById("stock-move-run");
      if (btn) btn.disabled = false; // 成功时 renderAll 已重建按钮；失败时把原按钮恢复
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
    // 防重入：整单领料会扣一串库存，双击两次就领两遍（stock:pick_by_bom 是独立操作）
    if (state.busy) return;
    state.busy = true;
    const runBtn = document.getElementById("stock-pick-run");
    if (runBtn) runBtn.disabled = true;
    try {
      showError("");
      const built = M.toPickRequest(state.pick);
      if (!built.ok) throw new Error(built.error);
      // 领料失败（整单拒绝）时 IPC 返回 ok:false —— 那是**结果**不是异常，要连同缺口一起展示
      // 领料被“整单拒绝”时要展示缺口（业务结果，不是异常）→ callRaw 取原始响应；
      // 仍然只走 renderer/lib/ui_util.js 这一条 IPC 通道（docs/architecture.md §3）
      const raw = await root.UIUtil.callRaw(root.api, "stockPickByBom", built.request);
      state.result = { kind: "pick", raw };
      await Promise.all([loadParts(), loadMovements()]);
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      if (raw && raw.ok !== true) showError(raw.error || "领料未执行");
      renderAll();
    } catch (exc) {
      showError(exc.message);
    } finally {
      state.busy = false;
      const btn = document.getElementById("stock-pick-run");
      if (btn) btn.disabled = false;
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

  /**
   * 从库存页点「领料」：切到本页并**预选**该器件（用户目标：领料别太繁琐，不要让人再翻全库列表）。
   * 若当前检索/筛选条件把这条器件排除在外，就清掉检索/筛选——用户点「领料」就是要这一条。
   */
  function focusPart(partId) {
    const id = String(partId || "");
    if (id === "") return;
    state.tab = "move";
    const inCandidates = moveCandidateParts().some((part) => part.id === id);
    if (!inCandidates) {
      state.move_query = { q: "", category: "", footprint: "" };
      state.move_options = null;
      state.move_similar_ids = [];
      moveGuard.invalidate(); // 作废在飞的检索请求，避免它回来把候选又改掉
    }
    state.move.part_id = id;
    renderAll();
  }

  function mount(target) {
    container = target;
    reset();
    renderAll();
    Promise.all([loadParts(), loadMovements()])
      .then(() => renderAll())
      .catch((exc) => showError(exc.message));
  }

  root.StockPage = { mount, focusPart };
})(typeof globalThis !== "undefined" ? globalThis : this);
