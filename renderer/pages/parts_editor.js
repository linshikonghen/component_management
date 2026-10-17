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

  const el = root.UIUtil.el;

  function reset(part) {
    state = {
      mode: part && part.id ? "edit" : "create",
      form: part && part.id ? M.formFromPart(part) : M.emptyForm(),
      movements: [],
      saved: null,
      error: "",
      saving: false, // 防重入：保存进行中（含等确认框）时不再接受第二次保存
    };
  }

  const call = function (method, payload) {
    return root.UIUtil.call(root.api, method, payload);
  };

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
        // 选中的判定值：旧数据存的是位号前缀 / `_default` / 表外类型 →
        // 先映射成**下拉项的 key**（`R` → 贴片电阻），映射不出来就原样用它自己
        //（不能"未选"了事：那会让有分类的器件看起来像没分类，而且表外类型会被显示成别的分类）
        const stored = state.form[field.key];
        const rawStored = String(stored == null ? "" : stored).trim();
        const shown = M.categoryDisplayValue(stored);
        const known = M.CATEGORY_OPTIONS.some((o) => o.key === shown);
        if (rawStored !== "" && !known) {
          // 表外类型（未收录的商品类型 / 旧位号前缀）：**照原样**加一项并选中它。
          // 为什么不映射成「其它」：那会把用户的分类悄悄改成别的分类，用户一保存就丢了原值 ✗
          const extra = el("option", null, `${M.categoryDisplayLabel(stored)}（表外类型）`);
          extra.value = rawStored;
          extra.selected = true;
          input.appendChild(extra);
        }
        const empty = el("option", null, "（未选 = 其它）");
        empty.value = "";
        if (rawStored === "") empty.selected = true; // 没分类就是「未选」，别替用户选成「其它」
        input.appendChild(empty);
        for (const option of M.CATEGORY_OPTIONS) {
          const node = el("option", null, option.label);
          node.value = option.key;
          if (rawStored !== "" && option.key === shown) node.selected = true;
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
      // 快捷选择（用户实测：± 这个符号键盘打不出来，会输 +-）——点一下填进输入框，
      // 走与手输**完全相同**的状态更新路径（state.form + refreshHint），不另开一条赋值逻辑 ✓
      if (field.kind !== "select" && Array.isArray(field.quick) && field.quick.length > 0) {
        const quickBox = el("div", "quick-picks");
        for (const qv of field.quick) {
          const btn = el("button", "link", qv);
          btn.type = "button";
          btn.dataset.quick = qv;
          btn.addEventListener("click", () => {
            input.value = qv;
            state.form[field.key] = qv;
            refreshHint();
          });
          quickBox.appendChild(btn);
        }
        wrap.appendChild(quickBox);
      }
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
    let text;
    if (missing.length === 0) {
      text = "必填项已填齐。数量与阈值都必须是整数；阈值留空表示继承分类默认。";
    } else if (missing.length === 1 && missing[0] === "值" && String(state.form.part_number || "").trim() !== "") {
      // 用户裁定 + 要求（2026-10-17）：没有参数值的元件，**值 = 型号**；
      // 只填型号就保存时，界面会**问一次**"是否直接把型号填进值"（取消则不保存、提示用户自己填）。
      text = "还缺「值」——没有参数值的元件，值就是型号；保存时会问你「是否直接把「型号」填进「值」」。";
    } else {
      text = `还缺必填项：${missing.join("、")}（保存时服务端还会再校验一次）`;
    }
    hint.textContent = text;
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
    // 防重入：保存进行中（尤其等确认框的时候）再点保存不再发请求——避免两次保存排队/叠加弹窗
    if (state.saving) return;
    state.saving = true;
    const saveBtn = document.getElementById("parts-save");
    if (saveBtn) saveBtn.disabled = true;
    try {
      showError("");
      // **只填型号时的确认**（用户 2026-10-17 要求）：
      // 这类"没有参数值"的料（MOS/IC/连接器/开关…），值 = 型号。
      // 值留空、型号有值 → 保存前**问一次**：确定 = 直接把型号填进值并保存；取消 = 不保存，提示用户自己填值。
      // （业务层也保留同一规则的兜底：任何绕过界面的调用路径仍然"值必填、值=型号"。）
      if (String(state.form.value || "").trim() === "" && String(state.form.part_number || "").trim() !== "") {
        if (!root.DialogUI || typeof root.DialogUI.confirm !== "function") {
          showError("界面组件 dialog.js 没有加载（请完全退出应用再重新打开）；这次没有保存。");
          return;
        }
        const useMpn = await root.DialogUI.confirm({
          title: "值留空：直接用「型号」作为值？",
          message: "这条料没有填「值」。这类没有参数值的料（MOS/IC/连接器/开关…），值就是型号。\n"
            + `确定 = 把「型号」${state.form.part_number} 填进「值」并保存；取消 = 不保存，回去自己填值。`,
          okText: "用型号作为值并保存",
          cancelText: "取消（我自己填值）",
        });
        if (!useMpn) {
          showError(`已取消保存：请先在「值」里填上值（型号是 ${state.form.part_number}；这次没有保存）。`);
          const valueInput = document.getElementById("pf-value");
          if (valueInput) {
            valueInput.value = "";
            valueInput.focus();
          }
          return;
        }
        // 确定：把型号填进「值」——表单上也能看见，而不是只在后台悄悄替换
        state.form.value = String(state.form.part_number).trim();
        const shown = document.getElementById("pf-value");
        if (shown) shown.value = state.form.value;
        refreshHint();
      }
      const payload = M.toSavePayload(state.form);
      let r = await call("partsSave", payload);
      // **合并确认**（用户实测："说疑似要人工确认，实际直接合并，没有人工处理的通道"）：
      // 服务端发现库里已有同规格器件时会回 needs_confirm（**不落库**）；这里问人，
      // 用户选"合并"才带 confirm_merge 重发 —— 绝不擅自把数量并进另一条料。
      //
      // 为什么用页内弹窗而不是原生 confirm（用户 2026-10-17 再实测）：
      //   原生 window.confirm 是**阻塞式模态**，弹出后若窗口没把它显示出来，整个界面会永久卡住
      //   （看不到弹窗、点不了按钮、不能继续输入）—— 就是用户报的"录入后整个手动界面会卡住"。
      if (r.needs_confirm) {
        // 缺失守卫（对抗审计 C4）：dialog.js 没加载时给出明确提示，而不是一句 TypeError
        if (!root.DialogUI || typeof root.DialogUI.confirm !== "function") {
          showError("界面组件 dialog.js 没有加载（请完全退出应用再重新打开）；这次没有合并、也没有新建。");
          return;
        }
        const asked = await root.DialogUI.confirm({
          title: "库里已有同规格器件",
          message: `${r.message || "判定键（值+封装+耐压+材质+容差）与库里已有器件相同。"}\n`
            + "确定 = 合并进那一条（数量相加）；取消 = 这次不保存。",
          okText: "合并（数量相加）",
          cancelText: "取消（不保存）",
        });
        if (!asked) {
          showError("已取消：没有合并、也没有新建。要新增一条不同规格的料，请改值/封装/耐压/材质/容差。");
          return;
        }
        payload.confirm_merge = true;
        r = await call("partsSave", payload);
        if (r.needs_confirm) throw new Error("服务端仍在要求确认（异常：确认标记没有生效）");
      }
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
    } finally {
      // 无论成功失败都解除防重入（renderAll 已重建按钮时，旧引用失效也没关系）
      state.saving = false;
      const btn = document.getElementById("parts-save");
      if (btn) btn.disabled = false;
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
      // AGENTS.md：删除器件属需人工确认操作 → 必须显式确认（页内弹窗，不用原生 confirm：会卡住界面）
      // 缺失守卫（对抗审计 C4）：没有确认框组件就不许删（宁可拒绝，不可无确认地删）
      if (!root.DialogUI || typeof root.DialogUI.confirm !== "function") {
        showError("界面组件 dialog.js 没有加载（请完全退出应用再重新打开）；为安全起见这次不删除。");
        return;
      }
      const ok = await root.DialogUI.confirm({
        title: "确定删除这条器件吗？",
        message: `${state.form.value} / ${state.form.footprint}（${id}）\n变动记录会保留作为历史。`,
        okText: "删除",
        cancelText: "取消",
        danger: true,
      });
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
