"use strict";
/**
 * parts_editor.js — 手动录入 / 编辑 / 详情页（spec FR-3 / FR-5.4）
 *
 * 四件事：
 *   ① 表单录入一条器件（FR-3.1）——不必碰 BOM
 *   ② 连续录入：保存后**保留分类等字段**，方便连录同类料（FR-3.3）
 *   ③ 器件详情：完整字段 + **该器件的变动历史（时间倒序）**（FR-5.4）
 *   ④ 编辑 / 删除（删除必须显式确认——AGENTS.md 把"删除任何器件记录"列为需人工确认操作）
 *
 * 校验**不在本文件重复实现**：服务端 `parts.savePart` 是唯一判据，返回 `{ok:false,error}` 就原样显示。
 * 界面只用默认值过滤做即时提示（少了哪个必填项不用等往返）。
 *
 * 从库存页点「编辑」进来时，用 `mount(target, { part })` 直接载入。
 */

(function (root) {
  "use strict";

  const M = root.PartsModel;
  if (!M) throw new Error("parts_model.js 必须先于 parts_editor.js 加载");

  let state = null;
  let container = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function reset(part) {
    state = {
      mode: part && part.id ? "edit" : "create",
      form: part && part.id ? M.formFromPart(part) : M.emptyForm(),
      movements: [],
      saved: null,
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
    const box = document.getElementById("parts-error");
    if (box) {
      box.textContent = message || "";
      box.hidden = !message;
    }
    state.error = message || "";
    if (message) console.error("[录入]", message);
  }

  /* ----------------------------------------------------------- 表单 */

  function renderFormBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, state.mode === "edit"
      ? `编辑器件 ${state.form.id || ""}`
      : "手动录入一条器件"));

    const grid = el("div", "form-grid");
    for (const field of M.FORM_FIELDS) {
      const wrap = el("div", "form-field");
      const label = el("label", null, field.required ? `${field.label} *` : field.label);
      label.htmlFor = `pf-${field.key}`;
      wrap.appendChild(label);

      let input;
      if (field.kind === "select") {
        input = el("select");
        const empty = el("option", null, "（未选 = 其它）");
        empty.value = "";
        input.appendChild(empty);
        for (const option of M.CATEGORY_OPTIONS) {
          const node = el("option", null, `${option.label}（${option.key}）`);
          node.value = option.key;
          if (option.key === state.form[field.key]) node.selected = true;
          input.appendChild(node);
        }
      } else {
        input = el("input");
        input.type = field.kind === "number" ? "number" : "text";
        if (field.kind === "number") { input.min = "0"; input.step = "1"; }
        input.value = state.form[field.key] == null ? "" : String(state.form[field.key]);
      }
      input.id = `pf-${field.key}`;
      input.dataset.field = field.key;
      input.addEventListener("input", () => { state.form[field.key] = input.value; refreshHint(); });
      input.addEventListener("change", () => { state.form[field.key] = input.value; refreshHint(); });
      wrap.appendChild(input);
      if (field.hint) wrap.appendChild(el("div", "hint", field.hint));
      grid.appendChild(wrap);
    }
    box.appendChild(grid);

    const hint = el("div", "gate-line");
    hint.id = "parts-hint";
    box.appendChild(hint);

    const actions = el("div", "form-actions");
    const save = el("button", "primary", state.mode === "edit" ? "保存修改" : "保存并继续录入");
    save.type = "button";
    save.id = "parts-save";
    save.addEventListener("click", doSave);
    actions.appendChild(save);

    if (state.mode === "edit") {
      const del = el("button", null, "删除这条");
      del.type = "button";
      del.id = "parts-delete";
      del.addEventListener("click", doDelete);
      actions.appendChild(del);
    }
    const clear = el("button", null, "清空");
    clear.type = "button";
    clear.addEventListener("click", () => { reset(null); renderAll(); });
    actions.appendChild(clear);
    box.appendChild(actions);

    if (state.saved) {
      const done = el("div", "banner");
      done.appendChild(el("strong", null, state.saved.message));
      if (state.saved.warnings && state.saved.warnings.length > 0) {
        const ul = el("ul");
        for (const w of state.saved.warnings) ul.appendChild(el("li", null, w));
        done.appendChild(ul);
      }
      box.appendChild(done);
    }
    return box;
  }

  function refreshHint() {
    const hint = document.getElementById("parts-hint");
    if (!hint) return;
    const missing = M.requiredMissing(state.form);
    hint.textContent = missing.length === 0
      ? "必填项已填齐。数量与阈值都必须是整数；阈值留空表示继承分类默认。"
      : `还缺必填项：${missing.join("、")}（保存时服务端还会再校验一次）`;
    hint.className = missing.length === 0 ? "gate-line" : "gate-line warn";
  }

  /* ----------------------------------------------------------- 详情 */

  function renderDetailBox() {
    if (state.mode !== "edit") return null;
    const box = el("div", "result");
    box.appendChild(el("h3", null, "详情"));

    const list = el("dl", "detail-list");
    const part = state.saved && state.saved.part ? state.saved.part : null;
    if (part) {
      for (const field of M.FORM_FIELDS) {
        list.appendChild(el("dt", null, field.label));
        const value = part[field.key];
        list.appendChild(el("dd", null, value === null || value === undefined || value === ""
          ? "—"
          : String(value)));
      }
      list.appendChild(el("dt", null, "创建时间"));
      list.appendChild(el("dd", null, part.created_at || "—"));
      list.appendChild(el("dt", null, "更新时间"));
      list.appendChild(el("dd", null, part.updated_at || "—"));
      if (Array.isArray(part.mpn_list) && part.mpn_list.length > 0) {
        list.appendChild(el("dt", null, "厂商料号（AML）"));
        const dd = el("dd");
        for (const mpn of part.mpn_list) {
          dd.appendChild(el("div", null,
            [mpn.part_number, mpn.manufacturer, mpn.supplier_part, mpn.supplier].filter((x) => x).join(" · ")));
        }
        list.appendChild(dd);
      }
    }
    box.appendChild(list);

    box.appendChild(el("h4", null, `变动历史（${state.movements.length} 条，按时间倒序）`));
    if (state.movements.length === 0) {
      box.appendChild(el("p", "hint", "这条器件还没有变动记录。"));
    } else {
      const scroller = el("div", "table-scroll");
      const table = el("table", "review-table");
      const thead = el("thead");
      const head = el("tr");
      for (const title of ["时间", "类型", "变动", "说明", "批次"]) head.appendChild(el("th", null, title));
      thead.appendChild(head);
      table.appendChild(thead);
      const tbody = el("tbody");
      for (const m of state.movements) {
        const tr = el("tr");
        tr.appendChild(el("td", null, m.at || ""));
        tr.appendChild(el("td", null, M.KIND_LABELS[m.kind] || m.kind || ""));
        tr.appendChild(el("td", "readonly-num", M.describeMovement(m)));
        const reason = el("td", null, [m.reason, M.movementTrace(m)].filter((x) => x).join("；") || "—");
        tr.appendChild(reason);
        tr.appendChild(el("td", null, m.ref || "—"));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroller.appendChild(table);
      box.appendChild(scroller);
    }
    return box;
  }

  /* ----------------------------------------------------------- 行为 */

  async function doSave() {
    try {
      showError("");
      const payload = M.toSavePayload(state.form);
      const r = await call("partsSave", payload);
      const verb = r.created ? "新增" : (r.merged ? "合并（同规格累加）" : "更新");
      state.saved = {
        part: r.part,
        warnings: r.warnings || [],
        message: `已${verb}：${r.part.value} / ${r.part.footprint}，当前库存 ${r.part.quantity}`,
      };
      if (typeof root.refreshInventory === "function") root.refreshInventory();

      if (state.mode === "edit") {
        state.form = M.formFromPart(r.part);
        await loadMovements(r.part.id);
        renderAll();
      } else {
        // FR-3.3 连续录入：保留分类等字段，清掉与具体料相关的
        state.form = M.keepForNextEntry(state.form);
        state.movements = [];
        renderAll();
        const first = document.getElementById("pf-value");
        if (first) first.focus();
      }
    } catch (exc) {
      showError(exc.message);
      refreshHint();
    }
  }

  async function loadMovements(partId) {
    try {
      const r = await call("movementsList", { part_id: partId });
      state.movements = r.movements || [];
    } catch (exc) {
      state.movements = [];
      showError(`变动历史读取失败：${exc.message}`);
    }
  }

  async function doDelete() {
    try {
      showError("");
      const part = state.saved && state.saved.part;
      const id = part ? part.id : state.form.id;
      if (!id) throw new Error("没有可删除的器件");
      // AGENTS.md：删除器件属需人工确认操作 → 必须显式确认
      const ok = root.confirm(`确定删除这条器件吗？\n\n${state.form.value} / ${state.form.footprint}（${id}）\n\n变动记录会保留作为历史。`);
      if (!ok) return;
      await call("partsDelete", { part_id: id, confirm: true });
      if (typeof root.refreshInventory === "function") root.refreshInventory();
      reset(null);
      renderAll();
      showError("");
      const box = document.getElementById("parts-body-host");
      if (box) {
        const note = el("div", "banner", `已删除 ${id}（变动记录保留）`);
        box.insertBefore(note, box.firstChild);
      }
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ----------------------------------------------------------- 装配 */

  function renderAll() {
    container.textContent = "";
    const wrap = el("div", "wizard");

    const error = el("div", "banner error");
    error.id = "parts-error";
    error.hidden = !state.error;
    error.textContent = state.error;
    wrap.appendChild(error);

    const host = el("div", "wizard-body");
    host.id = "parts-body-host";
    wrap.appendChild(host);

    host.appendChild(renderFormBox());
    const detail = renderDetailBox();
    if (detail) host.appendChild(detail);

    container.appendChild(wrap);
    refreshHint();
  }

  /**
   * @param {HTMLElement} target 容器
   * @param {{part?: object}} [options] 带 part = 编辑模式（库存页点「编辑」进来）
   */
  function mount(target, options) {
    container = target;
    reset(options && options.part);
    renderAll();
    if (state.mode === "edit" && state.form.id) {
      // 详情要显示服务端返回的完整字段 + 变动历史
      call("partsList", { query: {} })
        .then((r) => {
          const full = (r.parts || []).find((p) => p.id === state.form.id);
          if (full) state.saved = { part: full, warnings: [], message: "" };
          return loadMovements(state.form.id);
        })
        .then(() => renderAll())
        .catch((exc) => showError(exc.message));
    }
  }

  root.PartsPage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
