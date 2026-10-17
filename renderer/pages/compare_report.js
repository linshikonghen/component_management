"use strict";
/**
 * compare_report.js — 比对结果页（spec FR-2 / §8 导航映射）
 *
 *   ① 选 BOM + 套数 → 比对（**只读**）
 *   ② 三组结果：够用 / 缺料 / 疑似（FR-2.3），缺料段突出显示需求 · 库存 · **缺口**
 *   ③ 导出：立创配单 / 嘉立创 SMT（FR-2.7），可勾选连带疑似条目，可自定义文件名（FR-2.8）
 *
 * ⚠️ **本页只读**（FR-2.5/2.6）：只算"要买什么、买多少"。
 * **领料（FR-7）是独立入口，本页不提供、也不引用它的通道**（FR-7.6）——
 * 这条由 `tests/test_compare_model.js` 静态断言盯着：本文件里不得出现
 * `stockPickByBom` / `stock:pick_by_bom`，也就是**根本没有那条代码路径**。
 *
 * 规则全部来自 `renderer/model/compare_model.js`（有逐条无头测试）。
 */

(function (root) {
  "use strict";

  const M = root.CompareModel;
  if (!M) throw new Error("compare_model.js 必须先于 compare_report.js 加载");

  let state = null;
  let container = null;

  const el = root.UIUtil.el;

  function reset() {
    state = {
      step: 1, file_path: "", sets: 1, compare_id: "",
      result: null, active_group: "shortfall",
      // 人工裁决（疑似行确认）：{ 行号: "same" | "different" } —— 只影响这份比对/导出，不写库
      rulings: {},
      busy: false, // 防重入：比对请求在飞时，再点确认键/开始比对不再发请求（与领料/备份页同款）
      mode: "lcsc", include_uncertain: false, output_path: "", exported: null, error: "",
    };
  }

  const call = function (method, payload) {
    return root.UIUtil.call(root.api, method, payload);
  };

  /* ------------------------------------------------------------ 骨架 */

  function renderShell() {
    container.textContent = "";
    const wrap = el("div", "wizard");

    const steps = el("ol", "steps");
    ["选择文件与套数", "比对结果（只读）", "导出采购清单"].forEach((label, i) => {
      const li = el("li", "step", `${i + 1}. ${label}`);
      li.dataset.step = String(i + 1);
      steps.appendChild(li);
    });
    wrap.appendChild(steps);

    const error = el("div", "banner error");
    error.id = "compare-error";
    error.hidden = true;
    wrap.appendChild(error);

    const body = el("div", "wizard-body");
    body.id = "compare-body";
    wrap.appendChild(body);

    container.appendChild(wrap);
  }

  function showError(message) {
    const box = document.getElementById("compare-error");
    box.textContent = message || "";
    box.hidden = !message;
    if (message) console.error("[比对]", message);
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
    const body = document.getElementById("compare-body");
    body.textContent = "";

    const fileRow = el("div", "form-row");
    fileRow.appendChild(el("label", null, "BOM 文件："));
    const fileBox = el("input", "file-box");
    fileBox.id = "compare-file";
    fileBox.readOnly = true;
    fileBox.value = state.file_path || "";
    fileBox.placeholder = "（未选择）";
    const pick = el("button", null, "选择文件…");
    pick.type = "button";
    pick.addEventListener("click", async () => {
      try {
        showError("");
        const r = await call("bomPickFiles", {});
        if (!r.file_paths || r.file_paths.length === 0) return;
        state.file_path = r.file_paths[0];
        fileBox.value = state.file_path;
        state.rulings = {}; // 换文件 = 重新开始，旧裁决不带到新比对
      } catch (exc) {
        showError(exc.message);
      }
    });
    fileRow.appendChild(fileBox);
    fileRow.appendChild(pick);
    body.appendChild(fileRow);

    const setsRow = el("div", "form-row");
    setsRow.appendChild(el("label", null, "套数："));
    const sets = el("input", "sets-input");
    sets.id = "compare-sets";
    sets.type = "number";
    sets.min = "1";
    sets.step = "1";
    sets.value = String(state.sets);
    sets.addEventListener("input", () => { state.sets = Number(sets.value); });
    setsRow.appendChild(sets);
    setsRow.appendChild(el("span", "hint", "需求 = BOM 单套数量 × 套数；缺口 = 需求 − 现有库存"));
    body.appendChild(setsRow);

    const actions = el("div", "form-actions");
    const start = el("button", "primary", "开始比对");
    start.type = "button";
    start.id = "compare-start";
    start.addEventListener("click", doCompare);
    actions.appendChild(start);
    body.appendChild(actions);

    body.appendChild(el("p", "hint",
      "比对只读：它不会改动库里的任何数据，也不产生库存变动记录。补货与领料是另外的入口。"));
  }

  async function doCompare() {
    if (state.busy) return; // 防重入：请求在飞时连点不再发（连点两次会让晚到的旧结果覆盖新裁决）
    state.busy = true;
    try {
      showError("");
      if (!state.file_path) throw new Error("请先选择 BOM 文件");
      const sets = Number(state.sets);
      if (!Number.isInteger(sets) || sets < 1) throw new Error("套数必须是 ≥1 的整数");
      // 把人工裁决一起传回服务端：**规则实现只有一份**（services/compare.applyRulings），
      // 导出（compare:export）用的也是服务端缓存里"调整后"的结果，保证界面与导出文件一致。
      const r = await call("compareRun", { file_path: state.file_path, sets, rulings: state.rulings });
      state.compare_id = r.compare_id;
      state.result = r;
      const nonEmpty = ["shortfall", "uncertain", "enough"].filter((k) => (r[k] || []).length > 0);
      state.active_group = nonEmpty.includes(state.active_group) ? state.active_group : (nonEmpty[0] || "enough");
      renderStep2();
    } catch (exc) {
      showError(exc.message);
    } finally {
      state.busy = false;
    }
  }

  /* ------------------------------------------------- 第 2 步：结果 */

  const GROUP_COLUMNS = {
    enough: ["行", "值", "封装", "参数", "型号", "立创编号", "位号", "需求", "库存", "处置"],
    shortfall: ["行", "值", "封装", "参数", "型号", "立创编号", "位号", "需求", "库存", "缺口", "处置"],
    uncertain: ["行", "值", "封装", "型号", "需求", "库里候选", "为什么进疑似", "处置"],
  };

  function groupItems(key) {
    const r = state.result;
    return (r && r[key]) || [];
  }

  function cellValue(item, column, key) {
    switch (column) {
      case "行": return item.row_no;
      case "值": return item.value;
      case "封装": return item.footprint;
      case "参数": return [item.value, item.voltage, item.dielectric, item.tolerance].filter((v) => v).join(" ");
      case "型号": return item.part_number;
      case "立创编号": return item.supplier_part;
      case "位号": return (item.designators || []).join(",");
      case "需求": return item.required_quantity;
      case "库存": return item.stock_quantity;
      case "缺口": return item.shortfall_quantity;
      case "为什么进疑似": return M.uncertainReason(item);
      case "库里候选": return M.candidateText(item);
      default: return "";
    }
  }

  function renderGroupTable(key) {
    const columns = GROUP_COLUMNS[key];
    const items = groupItems(key);
    const box = el("div", "table-scroll");
    const table = el("table", "review-table");
    const thead = el("thead");
    const headRow = el("tr");
    for (const col of columns) headRow.appendChild(el("th", null, col));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    if (items.length === 0) {
      const tr = el("tr");
      const td = el("td", "empty", key === "shortfall" ? "没有缺料，无需采购。" : "（空）");
      td.colSpan = columns.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      for (const item of items) {
        const tr = el("tr");
        if (key === "shortfall" && item.stock_quantity > 0) tr.classList.add("low");
        for (const col of columns) {
          if (col === "处置") {
            tr.appendChild(renderRuleCell(item, key));
            continue;
          }
          const td = el("td", null, cellValue(item, col, key));
          if (["需求", "库存", "缺口"].includes(col)) td.className = "readonly-num";
          if (col === "缺口") td.classList.add("warn");
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    box.appendChild(table);
    return box;
  }

  /**
   * 「处置」格：
   *   疑似行 → 两个**确认键**（用户反馈：说"待人工确认"却不给确认的地方）；
   *   已确认行 → 显示确认结果 + 「改判」（撤销人工裁决）。
   * 裁决只重算这份比对（服务端 applyRulings），不写库、不产生变动记录。
   */
  function renderRuleCell(item, groupKey) {
    const td = el("td", "row-actions rule-actions");
    if (groupKey === "uncertain") {
      const same = el("button", null, "是同一颗（按库存算）");
      same.type = "button";
      same.title = `确认与库中候选 ${item.matched_part_id || ""} 是同一颗料：按候选库存算缺口（只读，不改库）`;
      same.addEventListener("click", () => applyRuling(item.row_no, "same"));
      const diff = el("button", null, "不是同一颗（算缺料）");
      diff.type = "button";
      diff.title = "确认不是同一颗料：按缺料计入采购清单（只读，不改库）";
      diff.addEventListener("click", () => applyRuling(item.row_no, "different"));
      td.appendChild(same);
      td.appendChild(diff);
      return td;
    }
    if (item && item.confirmed_by_human) {
      td.appendChild(el("span", "hint",
        item.match_reason === "confirmed_same" ? "已确认：同一颗" : "已确认：不是同一颗"));
      const undo = el("button", null, "改判");
      undo.type = "button";
      undo.title = "撤销这次人工确认，回到疑似重新判断";
      undo.addEventListener("click", () => applyRuling(item.row_no, "__reset__"));
      td.appendChild(undo);
    }
    return td;
  }

  /** 记录/撤销一行的人工裁决，然后带着全部裁决重新比对（服务端统一应用） */
  async function applyRuling(rowNo, ruling) {
    if (state.busy) return; // 比对在飞时不受理新的确认：避免"已记裁决但界面还是旧结果"
    if (ruling === "__reset__") delete state.rulings[rowNo];
    else state.rulings[rowNo] = ruling;
    await doCompare();
  }

  function renderStep2() {
    setStep(2);
    const body = document.getElementById("compare-body");
    body.textContent = "";
    const r = state.result;

    const head = el("div", "review-head");
    head.appendChild(el("div", "review-title", state.file_path.split(/[\\/]/).pop() + ` · 套数 ${state.sets}`));
    const back = el("button", null, "← 重新选择");
    back.type = "button";
    back.addEventListener("click", () => renderStep1());
    head.appendChild(back);
    body.appendChild(head);

    body.appendChild(el("div", "gate-line", M.summaryLine(r.stats)));

    // 跨来源匹配提示（v2.11）：BOM 的封装名是 EDA 写法、库里可能是立创对账单写法，
    // 两者靠"型号(MPN)相同"对上时要把依据写出来，否则用户会疑惑"封装名都不一样怎么算够用"。
    const mpnMatched = ["enough", "shortfall"].reduce((sum, k) =>
      sum + (groupItems(k) || []).filter((it) => it.match_reason === "mpn").length, 0);
    if (mpnMatched > 0) {
      body.appendChild(el("p", "hint",
        `其中 ${mpnMatched} 条是「按型号匹配」：BOM 的封装名（EDA 写法）与库里的封装名写法不同，`
        + "按型号(MPN)相同确认为同一颗料（只读比对，不会改库）。"));
    }

    const msg = el("div", "banner " + (r.stats.shortfall > 0 ? "warn" : ""));
    msg.textContent = M.purchaseMessage(r.stats);
    body.appendChild(msg);

    // 分组切换
    const tabs = el("div", "tabs");
    for (const g of M.GROUPS) {
      const count = groupItems(g.key).length;
      const button = el("button", "tab" + (state.active_group === g.key ? " active" : ""), `${g.label} ${count}`);
      button.type = "button";
      button.title = g.hint;
      button.addEventListener("click", () => { state.active_group = g.key; renderStep2(); });
      tabs.appendChild(button);
    }
    body.appendChild(tabs);

    const confirmedCount = ["enough", "shortfall"].reduce((sum, k) =>
      sum + (groupItems(k) || []).filter((it) => it.confirmed_by_human).length, 0);
    if (confirmedCount > 0) {
      body.appendChild(el("p", "hint",
        `已人工确认 ${confirmedCount} 条疑似（确认结果只影响这份比对与导出，不会写入库存库）。`));
    }

    const active = M.GROUPS.find((g) => g.key === state.active_group) || M.GROUPS[0];
    body.appendChild(el("p", "hint", `${active.label}：${active.hint}`));
    body.appendChild(renderGroupTable(active.key));

    if (state.active_group === "shortfall" && groupItems("shortfall").length > 0) {
      const total = M.shortfallTotal(groupItems("shortfall"));
      const req = M.requiredTotal(groupItems("shortfall"));
      const stock = M.stockTotal(groupItems("shortfall"));
      body.appendChild(el("div", "gate-line",
        `缺料合计：需求 ${req} 个 · 库中已有 ${stock} 个 · 需采购 ${total} 个（导出「数量」列即此合计）`));
    }

    body.appendChild(renderExportBox());
  }

  /* ------------------------------------------------- 第 3 步：导出 */

  function renderExportBox() {
    const box = el("div", "result");
    box.appendChild(el("h3", null, "导出采购清单"));

    const modeRow = el("div", "form-row");
    modeRow.appendChild(el("label", null, "导出模式："));
    const select = el("select");
    select.id = "compare-mode";
    for (const m of M.MODES) {
      const option = el("option", null, m.label);
      option.value = m.key;
      if (m.key === state.mode) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => { state.mode = select.value; refreshExportState(); });
    modeRow.appendChild(select);
    modeRow.appendChild(el("span", "hint", "详见 spec §4.2：立创按表头语义识别列；嘉立创 SMT 列序固定"));
    box.appendChild(modeRow);

    const uncertainRow = el("div", "form-row");
    const label = el("label", "adjudicate");
    const check = el("input");
    check.type = "checkbox";
    check.id = "compare-include-uncertain";
    check.checked = state.include_uncertain;
    check.addEventListener("change", () => { state.include_uncertain = check.checked; refreshExportState(); });
    label.appendChild(check);
    label.appendChild(el("span", null, "连同「疑似」条目一起导出"));
    uncertainRow.appendChild(label);
    box.appendChild(uncertainRow);

    const pathRow = el("div", "form-row");
    pathRow.appendChild(el("label", null, "文件名（可留空）："));
    const path = el("input", "file-box");
    path.id = "compare-output";
    path.placeholder = `留空则用默认名 ${M.defaultFileName(state.mode)}`;
    path.value = state.output_path;
    path.addEventListener("input", () => { state.output_path = path.value; });
    pathRow.appendChild(path);
    box.appendChild(pathRow);

    const actions = el("div", "form-actions");
    const exportButton = el("button", "primary", "导出");
    exportButton.type = "button";
    exportButton.id = "compare-export";
    exportButton.addEventListener("click", doExport);
    actions.appendChild(exportButton);
    box.appendChild(actions);

    const notice = el("div", "gate-line");
    notice.id = "compare-export-notice";
    box.appendChild(notice);

    if (state.exported) {
      const done = el("div", "banner");
      done.appendChild(el("strong", null, `已导出 ${state.exported.exported_count} 条`));
      done.appendChild(el("div", "path", state.exported.file_path));
      if (state.exported.warnings && state.exported.warnings.length > 0) {
        const ul = el("ul");
        for (const w of state.exported.warnings.slice(0, 8)) ul.appendChild(el("li", null, w));
        if (state.exported.warnings.length > 8) {
          ul.appendChild(el("li", null, `…另有 ${state.exported.warnings.length - 8} 条提示`));
        }
        done.appendChild(ul);
      }
      box.appendChild(done);
    }

    setTimeout(refreshExportState, 0);
    return box;
  }

  function refreshExportState() {
    const button = document.getElementById("compare-export");
    const notice = document.getElementById("compare-export-notice");
    if (!button || !notice) return;
    const verdict = M.canExport({ stats: state.result.stats, include_uncertain: state.include_uncertain });
    button.disabled = !verdict.ok;
    notice.textContent = verdict.reason || `将导出 ${groupItems("shortfall").length} 条缺料`
      + (state.include_uncertain ? ` + ${groupItems("uncertain").length} 条疑似` : "");
  }

  async function doExport() {
    try {
      showError("");
      const built = M.buildExportRequest({
        compare_id: state.compare_id,
        mode: state.mode,
        include_uncertain: state.include_uncertain,
        output_path: state.output_path,
        stats: state.result.stats,
      });
      if (!built.ok) throw new Error(built.error);
      const r = await call("compareExport", built.request);
      state.exported = r;
      renderStep2();
    } catch (exc) {
      showError(exc.message);
    }
  }

  /* ------------------------------------------------------------ 挂载 */

  function mount(target) {
    container = target;
    reset();
    renderShell();
    renderStep1();
  }

  root.ComparePage = { mount };
})(typeof globalThis !== "undefined" ? globalThis : this);
