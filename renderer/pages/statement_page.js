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
  const UI = root.UIUtil;
  const el = UI.el;
  /** IPC 唯一入口：所有数据访问都经 renderer/lib/ui_util.js（docs/architecture.md §3） */
  const call = function (method, payload) { return UI.call(root.api, method, payload); };

  function mount(container) {
    // committed：这批已经入库成功 → 按钮保持禁用，必须重新选文件才能再入（服务端也有幂等闸门，这是第一层）
    const state = {
      filePath: "", parsed: null, rows: [], busy: false, onlyPending: false, committed: false,
      warnings: [],     // 解析提示（对账单里"没有值就用型号当值"这类信息，不是错误）
      warningsOpen: false,
    };

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
    status.textContent = "点「选择对账单（.xls）」选立创导出的物料明细对账单。带 ✎ 的列可以直接改（本次入库量、值/容差/耐压/电流/功率/极性/封装/商品型号）；订购数量与分类是对账单事实，只读。改过的行会留痕。只用于入库，不动导出与比对。";
    container.appendChild(status);

    // **裁决入口**（用户实测："叫我裁决完入库，但去哪裁决？"）：
    // 行数多的时候（实测 73 行、其中 1 条疑似）光靠翻表格找不到，所以给一个只看待裁决的开关
    const judgeBar = el("div", "form-row");
    judgeBar.id = "statement-judge-bar";
    const onlyPending = el("input");
    onlyPending.type = "checkbox";
    onlyPending.id = "statement-only-pending";
    onlyPending.addEventListener("change", () => {
      state.onlyPending = onlyPending.checked;
      renderTable();
      refreshGate();
    });
    const onlyLabel = el("label", "adjudicate");
    onlyLabel.appendChild(onlyPending);
    onlyLabel.appendChild(el("span", null, "只看「疑似（待裁决）」的行"));
    judgeBar.appendChild(onlyLabel);
    container.appendChild(judgeBar);

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

    // **解析提示区**（用户 2026-10-17 实测："导入账单过程中 UI 发生一次巨大变化，一开始没有下（面）滚动条，
    // 合并了一个之后突然有了"）。根因：解析提示（25 行对账单有 11 条、600+ 字）原来被塞进表格**上方**的
    // 错误行，把表格顶下去约十来行；任何一次交互 `showError("")` 又把它们清掉 → 表格整块上移、滚动条才露出来,
    // 看起来就是"UI 巨大变化"。
    // 现在：提示单独一块、放在**表格之后**（出现/消失/展开都不会移动表格），默认**折叠**（只有一行摘要），
    // 想看再点开；它也不再被交互时的 `showError("")` 顺手清掉（那是"错误"清空，不是提示）。
    const warningsBox = el("div", "banner warn");
    warningsBox.id = "statement-warnings";
    warningsBox.hidden = true;
    const warningsToggle = el("button", "link", "");
    warningsToggle.type = "button";
    warningsToggle.id = "statement-warnings-toggle";
    const warningsBody = el("ul");
    warningsBody.id = "statement-warnings-body";
    warningsBody.hidden = true;
    warningsToggle.addEventListener("click", () => {
      state.warningsOpen = !state.warningsOpen;
      renderWarnings();
    });
    warningsBox.appendChild(warningsToggle);
    warningsBox.appendChild(warningsBody);
    container.appendChild(warningsBox);

    function showError(msg) { errorBox.textContent = msg ? String(msg) : ""; }
    function setStatus(msg) { status.textContent = String(msg == null ? "" : msg); }

    // preload 没暴露接口时**明确说出来**（否则表现就是"点了没反应"）
    const missingApi = [];
    if (!UI.available(root.api)) missingApi.push("window.api");
    else {
      if (!UI.has(root.api, "bomPickFiles")) missingApi.push("bomPickFiles");
      if (!UI.has(root.api, "statementParse")) missingApi.push("statementParse");
      if (!UI.has(root.api, "statementCommit")) missingApi.push("statementCommit");
    }
    if (missingApi.length > 0) {
      setStatus("当前进程里还没有「按对账单入库」需要的接口：" + missingApi.join(" / "));
      showError("预加载接口缺失。请完全退出应用再重新打开（preload 只在启动时加载一次）。");
      pick.disabled = true;
      commit.disabled = true;
      return;
    }

    /** 解析提示区：默认折叠成一行摘要，点开可看逐条（**不会顶动表格**） */
    function renderWarnings() {
      const list = Array.isArray(state.warnings) ? state.warnings : [];
      warningsBox.hidden = list.length === 0;
      warningsBody.textContent = "";
      if (list.length === 0) {
        warningsToggle.textContent = "";
        return;
      }
      warningsToggle.textContent = `解析提示 ${list.length} 条（${state.warningsOpen ? "点此收起" : "点此查看"}）`;
      warningsBody.hidden = !state.warningsOpen;
      if (state.warningsOpen) {
        for (const text of list) warningsBody.appendChild(el("li", null, text));
      }
    }

    function renderTable() {
      scroller.textContent = "";
      if (!state.rows.length) return;
      // 「只看待裁决」：73 行里找第 56 行太痛苦（用户实测反馈）→ 一个开关把范围缩到疑似那几行
      // 只看待裁决：未勾选的行这次不入库，也就不必裁决 → 一并隐藏（勾回来它还会出现）
      const rows = state.onlyPending
        ? state.rows.filter((r) => r.decision === "pending" && r.selected !== false)
        : state.rows;
      if (rows.length === 0) {
        scroller.appendChild(el("p", "hint", "没有待裁决的行了 —— 取消勾选可以看全部。"));
        return;
      }
      const table = el("table", "review-table");
      const thead = el("thead");
      const headRow = el("tr");
      for (const col of M.COLUMNS) {
        const th = el("th", null, col.label);
        if (col.key === "decision") th.className = "decision-col";
        if (col.key === "selected") {
          // 「全选」：默认全部勾选（用户 2026-10-17：默认全选，可只勾选部分入库）
          th.textContent = "";
          const all = el("input");
          all.type = "checkbox";
          all.id = "statement-select-all";
          all.checked = rows.every((r) => r.selected !== false);
          all.addEventListener("change", () => {
            // 只对**当前看得到的行**生效（配合「只看待裁决」筛选，所见即所选）
            const visibleNos = rows.map((r) => r.row_no);
            state.rows = M.setSelectedMany(state.rows, visibleNos, all.checked);
            renderTable();
            refreshGate();
          });
          th.appendChild(all);
          th.appendChild(el("span", "hint", " 全选"));
        }
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      for (const row of rows) {
        const tr = el("tr");
        tr.dataset.row = String(row.row_no);
        if (row.edited) tr.className = "mismatch-changed"; // 与 BOM 核对表同样的"改过"视觉标记
        if (row.selected === false) tr.className = (tr.className ? tr.className + " " : "") + "unselected";
        // 已裁决的疑似行加底色：用户说"点了之后反馈差"，行高亮是最快的视觉反馈
        if (row.bucket === "suspected" && (row.decision === "merge" || row.decision === "new")) {
          tr.className = (tr.className ? tr.className + " " : "") + (row.decision === "merge" ? "decided-merge" : "decided-new");
        }
        for (const col of M.COLUMNS) {
          const td = el("td");
          if (col.key === "decision") td.className = "decision-col";
          if (col.key === "selected") {
            // 每行一个「这次要不要入库」的勾选框：默认全部勾上；取消勾选 = 这次不入库（不必裁决）
            const box = el("input");
            box.type = "checkbox";
            box.id = `statement-select-${row.row_no}`;
            box.checked = row.selected !== false;
            box.addEventListener("change", () => {
              state.rows = M.setSelected(state.rows, row.row_no, box.checked);
              renderTable();
              refreshGate();
            });
            td.appendChild(box);
          } else if (col.key === "bucket") td.textContent = M.BUCKET_LABEL[row.bucket] || row.bucket;
          else if (col.key === "decision") {
            // **疑似**：光看"就是它/不是它"不知道"谁是谁"（用户 2026-10-17 反馈）——
            // 这里把**对账单这一行**和**库里候选这条**分别写出来，按钮也写成完整句子。
            if (row.bucket === "suspected") {
              const cand = (row.candidates || [])[0];
              const box = el("div", "suspect-box");
              const identity = M.suspectText(row);
              box.title = identity; // 悬停也能看全文（列窄被换行时方便逐个看）
              if (row.decision === "pending") {
                box.appendChild(el("div", "suspect-title", "两边是同一种料吗？"));
                box.appendChild(el("div", "suspect-mine", identity));
                if (cand && cand.diff && cand.diff.length) {
                  box.appendChild(el("div", "suspect-diff", "差在哪：" + cand.diff.join("；")));
                }
                const merge = el("button", "link suspect-btn", cand ? "是同一颗 → 合并进库里这条" : "库里没有候选 → 只能新建");
                merge.type = "button";
                merge.disabled = !cand;
                merge.addEventListener("click", () => decide(row.row_no, "merge", cand && cand.part_id));
                const create = el("button", "link suspect-btn", "不是同一颗 → 新建一条");
                create.type = "button";
                create.addEventListener("click", () => decide(row.row_no, "new"));
                box.appendChild(merge);
                box.appendChild(create);
              } else {
                // **裁决完就地给明显反馈**（用户 2026-10-17："点了之后反馈差，要看最上方提示数量才知道点到了没"）：
                // 1) 处置格里换成醒目的"已选择"徽标（写清选了什么）
                // 2) 整行加底色（扫一眼就能看出哪几行已裁决）
                // 3) 状态行同时说一句；还给「改选」按钮（点错了能回到待裁决）
                const badge = el("div", row.decision === "merge" ? "decided-badge decided-merge" : "decided-badge decided-new");
                badge.id = `statement-decided-${row.row_no}`;
                if (row.decision === "merge") {
                  badge.textContent = `已选择：合并进库里这条${cand ? `（${cand.part_id}）` : ""}`;
                } else {
                  badge.textContent = "已选择：新建一条";
                }
                box.appendChild(badge);
                box.appendChild(el("div", "suspect-mine", identity));
                const again = el("button", "link suspect-btn", "改选（回到未裁决）");
                again.type = "button";
                again.addEventListener("click", () => reset(row.row_no));
                box.appendChild(again);
              }
              td.appendChild(box);
            } else {
              // 已裁决/命中的行：只说结果
              td.textContent = M.DECISION_LABEL[row.decision] || row.decision;
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
      commit.disabled = state.busy || state.committed || state.rows.length === 0 || !M.canCommit(state.rows);
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
      // **就地反馈**：除了行底色 + 处置格徽标，状态行也立刻说一句（不用去看最上面数量变化）
      const row = state.rows.find((x) => x.row_no === rowNo);
      const target = action === "merge"
        ? `合并进库里这条${partId ? `（${partId}）` : ""}`
        : "新建一条";
      setStatus(`第 ${Number(rowNo) + 1} 行已标记：${target}`
        + (row && row.selected === false ? "（注意：这行当前未勾选，这次不会入库）" : "")
        + "。点错了可在处置列点「改选（回到未裁决）」。");
    }

    /** 撤销一行裁决（回到待裁决） */
    function reset(rowNo) {
      const r = M.resetDecision(state.rows, rowNo);
      if (!r.ok) { showError(r.error); return; }
      showError("");
      state.rows = r.rows;
      renderTable();
      refreshGate();
      setStatus(`第 ${Number(rowNo) + 1} 行已改回「待裁决」，请重新选择。`);
    }

    /** 选完文件 → 解析 → 渲染；每一步都往状态行写一句话 */
    async function loadFile(filePath) {
      state.filePath = filePath;
      state.committed = false; // 重新选文件 = 一次新的入库机会
      fileBox.value = filePath;
      setStatus(`已选：${filePath}　正在解析…`);
      showError("");
      result.textContent = "";
      try {
        const parsed = await call("statementParse", { file_path: filePath });
        state.parsed = parsed;
        state.rows = M.buildRows(parsed);
        state.warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice() : [];
        state.warningsOpen = false;
        renderTable();
        refreshGate();
        renderWarnings();
        const warningNote = state.warnings.length > 0 ? `；解析提示 ${state.warnings.length} 条（见表格下方，可点开）` : "";
        setStatus(`已解析 ${parsed.items.length} 条：命中 ${parsed.matched.length} · 疑似 ${parsed.suspected.length} · 新增 ${parsed.missing.length}。`
          + "左「入库」列默认全选（可以取消勾选只入库一部分）；"
          + (M.canCommit(state.rows) ? "可直接入库。" : "请先裁决勾选了的疑似行，然后才能入库。")
          + warningNote);
        showError(""); // 提示进提示区；错误行只放真正的错误（不再把表格顶下去）
      } catch (exc) {
        state.rows = [];
        state.warnings = [];
        renderTable();
        refreshGate();
        renderWarnings();
        setStatus("解析失败。");
        showError((exc && exc.message) || String(exc));
      }
    }

    pick.addEventListener("click", async () => {
      showError("");
      setStatus("正在打开文件选择框…");
      let res = null;
      try {
        res = await call("bomPickFiles");
      } catch (exc) {
        setStatus("打开文件选择框失败。");
        showError((exc && exc.message) || String(exc));
        return;
      }
      // **契约是 `{ ok, file_paths }`**（见 src/ipc/handlers.js 的 bom:pick_files 与导入向导的用法）。
      // 我第一版把它当成**裸数组**解，于是 `paths.length` 是 undefined → 被误报成"已取消"——
      // 用户实测反馈"选择器选了没反应"，其实是这里解包错了（对话框本身是好的）。
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
      if (state.busy) return; // 防重入：请求在飞时再点不再发（服务端幂等是第二层）
      if (state.committed) { showError("这批已经入库成功了；要再入一次请重新选择对账单。"); return; }
      if (state.rows.length === 0) { showError("请先选择对账单"); return; }
      if (M.selectedRows(state.rows).length === 0) {
        showError("还没有勾选要入库的行 —— 在表格最左边「入库」列勾上（默认是全部勾选）");
        return;
      }
      if (!M.canCommit(state.rows)) { showError("还有勾选了的疑似没裁决，不能入库"); return; }
      state.busy = true;
      refreshGate();
      setStatus("正在入库…");
      try {
        const decisions = M.buildDecisions(state.rows);
        const res = await call("statementCommit", {
          file_path: state.filePath,
          order_ref: (state.parsed && state.parsed.items && state.parsed.items[0] && state.parsed.items[0].order_ref) || "",
          decisions,
        });
        showError("");
        state.committed = true; // 成功之后按钮保持禁用（防止同一批再提交一次）
        setStatus("入库完成（这批已入库，若需再入请重新选择对账单）。");
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
