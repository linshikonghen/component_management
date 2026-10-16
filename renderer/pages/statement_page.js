"use strict";
/**
 * statement_page.js — 按对账单入库（spec FR-8 / AC-10）
 *
 * 规则全在 `renderer/model/statement_model.js`（有无头测试）；本文件只做 DOM 装配。
 * 数据一律走 `window.api.*`（preload 白名单）：`bomPickFiles` 选文件、`statementParse` 只读对账、
 * `statementCommit` 按人工决定入库。
 *
 * **每一步都给可见反馈**（用户实测反馈："选择器选了没反应"）：选完文件立刻显示
 * "已选：<路径>，正在解析…"，解析完显示"已解析 N 条：命中 x / 疑似 y / 新增 z"，
 * 失败把原因写在**醒目位置**（不再是页面底部一行小字）。
 * 另外：若 preload 没暴露这些接口（没重启 / 旧进程），**直接说清楚**，而不是静默无事发生。
 *
 * **人工闸门**（FR-8.7 / AC-10:3）：只要还有疑似未裁决，入库按钮就是禁用的，
 * 上方那行字会写明"还有几条、是哪几行"——不让人以为能点。
 */
(function (root) {
  const M = root.StatementModel;
  const api = root.api;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function mount(container) {
    const state = { filePath: "", parsed: null, rows: [], busy: false };

    container.textContent = "";

    const head = el("div", "review-head");
    const pick = el("button", "primary", "选择对账单（.xls）");
    pick.type = "button";
    pick.id = "statement-pick";
    const fileBox = el("input", "file-box");
    fileBox.readOnly = true;
    fileBox.placeholder = "尚未选择对账单";
    fileBox.id = "statement-file";
    head.appendChild(pick);
    head.appendChild(fileBox);
    container.appendChild(head);

    // **状态行**：把"正在做什么 / 刚发生了什么"一直挂在最显眼的位置
    const status = el("p", "hint");
    status.id = "statement-status";
    status.textContent = "点「选择对账单（.xls）」选立创导出的物料明细对账单。带 ✎ 的列可以直接改（本次入库量、值/容差/耐压/封装/商品型号）；订购数量与分类是对账单事实，只读。改过的行会留痕。只用于入库，不动导出与比对。";
    container.appendChild(status);

    const gate = el("p", "gate", "");
    gate.id = "statement-gate";
    container.appendChild(gate);

    const errorBox = el("p", "error");
    errorBox.id = "statement-error";
    container.appendChild(errorBox);

    const scroller = el("div", "table-scroll");
    scroller.id = "statement-body";
    container.appendChild(scroller);

    const actions = el("div", "form-actions");
    const commit = el("button", "primary", "确认入库");
    commit.type = "button";
    commit.id = "statement-commit";
    commit.disabled = true;
    actions.appendChild(commit);
    container.appendChild(actions);

    const result = el("p", "result");
    result.id = "statement-result";
    container.appendChild(result);

    function showError(msg) { errorBox.textContent = msg ? String(msg) : ""; }
    function setStatus(msg) { status.textContent = String(msg == null ? "" : msg); }

    // preload 没暴露接口时**明确说出来**（否则表现就是"点了没反应"）
    const missingApi = [];
    if (!api) missingApi.push("window.api");
    else {
      if (typeof api.bomPickFiles !== "function") missingApi.push("bomPickFiles");
      if (typeof api.statementParse !== "function") missingApi.push("statementParse");
      if (typeof api.statementCommit !== "function") missingApi.push("statementCommit");
    }
    if (missingApi.length > 0) {
      setStatus("当前进程里还没有「按对账单入库」需要的接口：" + missingApi.join(" / "));
      showError("预加载接口缺失。请完全退出应用再重新打开（preload 只在启动时加载一次）。");
      pick.disabled = true;
      commit.disabled = true;
      return;
    }

    function renderTable() {
      scroller.textContent = "";
      if (!state.rows.length) return;
      const table = el("table", "review-table");
      const thead = el("thead");
      const headRow = el("tr");
      for (const col of M.COLUMNS) headRow.appendChild(el("th", null, col.label));
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      for (const row of state.rows) {
        const tr = el("tr");
        tr.dataset.row = String(row.row_no);
        if (row.edited) tr.className = "mismatch-changed"; // 与 BOM 核对表同样的"改过"视觉标记
        for (const col of M.COLUMNS) {
          const td = el("td");
          if (col.key === "bucket") td.textContent = M.BUCKET_LABEL[row.bucket] || row.bucket;
          else if (col.key === "decision") {
            td.textContent = M.DECISION_LABEL[row.decision] || row.decision;
            // **疑似**那一行给两个按钮：就是它（合并到候选）/ 不是它（新建）
            if (row.bucket === "suspected") {
              const cand = (row.candidates || [])[0];
              const merge = el("button", "link", cand ? "就是它（合并）" : "无法合并");
              merge.type = "button";
              merge.disabled = !cand;
              merge.addEventListener("click", () => decide(row.row_no, "merge", cand && cand.part_id));
              const create = el("button", "link", "不是它（新建）");
              create.type = "button";
              create.addEventListener("click", () => decide(row.row_no, "new"));
              td.appendChild(merge);
              td.appendChild(create);
              if (cand && cand.diff && cand.diff.length) {
                td.appendChild(el("span", "candidate", "库里差：" + cand.diff.join("；")));
              }
            }
          } else if (col.editable) {
            // **可改格**：常显边框 + 白底（沿用之前"看不出能改"那次的教训，不再只在 hover 才显形）
            const input = el("input", "edit-cell");
            input.type = col.numeric ? "number" : "text";
            if (col.numeric) input.min = "0";
            input.value = row[col.key] == null ? "" : String(row[col.key]);
            input.dataset.row = String(row.row_no);
            input.dataset.field = col.key;
            input.addEventListener("change", () => editField(row.row_no, col.key, input.value));
            td.appendChild(input);
          } else {
            td.textContent = row[col.key] == null ? "" : String(row[col.key]);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroller.appendChild(table);
    }

    function refreshGate() {
      gate.textContent = state.rows.length === 0 ? "" : M.gateText(state.rows);
      // **没有可入库的行时一律禁用**（页面级测试抓到：第一版在"还没选文件"时按钮是可点的）
      commit.disabled = state.busy || state.rows.length === 0 || !M.canCommit(state.rows);
    }

    /** 改一个字段：校验不过就报错并把格子恢复成原值（不假装改成功） */
    function editField(rowNo, field, raw) {
      const r = M.setFieldEdit(state.rows, rowNo, field, raw);
      if (!r.ok) {
        showError(r.error);
        renderTable(); // 恢复显示（把不合法的输入顶掉）
        refreshGate();
        return;
      }
      showError("");
      state.rows = r.rows;
      renderTable();
      refreshGate();
      setStatus(M.canCommit(state.rows)
        ? "已记录你的修改，可以入库了。"
        : "已记录你的修改；还有疑似的行需要裁决才能入库。");
    }

    function decide(rowNo, action, partId) {
      const r = M.setDecision(state.rows, rowNo, action, partId);
      if (!r.ok) { showError(r.error); return; }
      showError("");
      state.rows = r.rows;
      renderTable();
      refreshGate();
    }

    /** 选完文件 → 解析 → 渲染；每一步都往状态行写一句话 */
    async function loadFile(filePath) {
      state.filePath = filePath;
      fileBox.value = filePath;
      setStatus(`已选：${filePath}　正在解析…`);
      showError("");
      result.textContent = "";
      try {
        const parsed = await api.statementParse({ file_path: filePath });
        if (!parsed || parsed.ok !== true) {
          state.rows = [];
          renderTable();
          refreshGate();
          setStatus("这份文件没有可用于入库的明细。");
          showError((parsed && parsed.error) || "解析失败（未返回原因）");
          return;
        }
        state.parsed = parsed;
        state.rows = M.buildRows(parsed);
        renderTable();
        refreshGate();
        setStatus(`已解析 ${parsed.items.length} 条：命中 ${parsed.matched.length} · 疑似 ${parsed.suspected.length} · 新增 ${parsed.missing.length}。`
          + (M.canCommit(state.rows) ? "可直接入库。" : "请先裁决疑似的行，然后才能入库。"));
        if ((parsed.warnings || []).length) showError(parsed.warnings.join("；"));
      } catch (exc) {
        state.rows = [];
        renderTable();
        refreshGate();
        setStatus("解析失败。");
        showError((exc && exc.message) || String(exc));
      }
    }

    pick.addEventListener("click", async () => {
      showError("");
      setStatus("正在打开文件选择框…");
      let res = null;
      try {
        res = await api.bomPickFiles();
      } catch (exc) {
        setStatus("打开文件选择框失败。");
        showError((exc && exc.message) || String(exc));
        return;
      }
      // **契约是 `{ ok, file_paths }`**（见 src/ipc/handlers.js 的 bom:pickFiles 与导入向导的用法）。
      // 我第一版把它当成**裸数组**解，于是 `paths.length` 是 undefined → 被误报成"已取消"——
      // 用户实测反馈"选择器选了没反应"，其实是这里解包错了（对话框本身是好的）。
      if (!res || res.ok !== true) {
        setStatus("打开文件选择框失败。");
        showError((res && res.error) || "打开文件选择框失败（未返回原因）");
        return;
      }
      const paths = Array.isArray(res.file_paths) ? res.file_paths : [];
      if (paths.length === 0) {
        setStatus("没有选择文件（已取消）。");
        return;
      }
      if (paths.length > 1) {
        // 与导入向导同样的诚实处理：多选了就说清楚只处理第一个，不静默丢弃
        showError(`一次选择了 ${paths.length} 个文件，本版先处理第一个：${paths[0]}`);
      }
      await loadFile(paths[0]);
    });

    commit.addEventListener("click", async () => {
      if (state.rows.length === 0) { showError("请先选择对账单"); return; }
      if (!M.canCommit(state.rows)) { showError("还有疑似未裁决，不能入库"); return; }
      state.busy = true;
      refreshGate();
      setStatus("正在入库…");
      try {
        const decisions = M.buildDecisions(state.rows);
        const res = await api.statementCommit({
          file_path: state.filePath,
          order_ref: (state.parsed && state.parsed.items && state.parsed.items[0] && state.parsed.items[0].order_ref) || "",
          decisions,
        });
        if (!res || res.ok !== true) {
          setStatus("入库失败。");
          showError((res && res.error) || "入库失败（未返回原因）");
          return;
        }
        showError("");
        setStatus("入库完成。");
        result.textContent = M.summaryText(res.summary) + "。请到「库存」页查看。";
      } catch (exc) {
        setStatus("入库失败。");
        showError((exc && exc.message) || String(exc));
      } finally {
        state.busy = false;
        refreshGate();
      }
    });

    refreshGate();
  }

  root.StatementPage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
