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
      // 人工匹配（缺料行 → 库里器件）：{ 行号: 器件id } —— 同样只存在这份比对里，不写库；
      // 是否把 BOM 值同步进库是随后的独立确认（compare:sync_fields）
      manual_matches: {},
      notice: "", // 最近一次"字段同步"的结果提示（不持久）
      parts_cache: null, // 器件选择器的候选缓存（库变了要置空）
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
        state.manual_matches = {}; // 人工匹配同理：换文件即失效
        state.notice = "";
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
      "比对与人工确认都不写库；只有你对「缺料」行人工匹配库里器件、并在弹窗里确认「替换并写库」时，"
      + "才会把 BOM 的判定键字段同步进那条器件（会写一条变动记录留痕）。补货与领料是另外的入口。"));
  }

  async function doCompare() {
    if (state.busy) return; // 防重入：请求在飞时连点不再发（连点两次会让晚到的旧结果覆盖新裁决）
    state.busy = true;
    try {
      showError("");
      if (!state.file_path) throw new Error("请先选择 BOM 文件");
      const sets = Number(state.sets);
      if (!Number.isInteger(sets) || sets < 1) throw new Error("套数必须是 ≥1 的整数");
      // 把人工裁决 + 人工匹配一起传回服务端：**规则实现只有一份**
      // （services/compare.applyRulings / applyManualMatches），导出（compare:export）用的也是
      // 服务端缓存里"调整后"的结果，保证界面与导出文件一致。
      const r = await call("compareRun", {
        file_path: state.file_path, sets,
        rulings: state.rulings, manual_matches: state.manual_matches,
      });
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
   * 「处置」格（三组共用）：
   *   疑似行（未裁决）        → 两个**确认键**（是同一颗 / 不是同一颗）
   *   已确认行（进了够用/缺料）→ 状态 + **保留的两个确认键**（可直接改选）+「改判」回疑似
   *   已手动匹配行（进了够用/缺料）→ 状态 + 「重新匹配…」+「退回」
   *   未匹配的缺料行          → 「人工匹配…」（只有 none / confirmed_different 允许，见 M.isManualMatchable）
   * 所有按钮共同点：确认/匹配只重算这份比对（服务端统一应用），**不写库**；
   * 唯一写库动作是「人工匹配后确认替换字段」（另一个显式通道 + 弹窗确认）。
   */
  function renderRuleCell(item, groupKey) {
    const td = el("td", "row-actions rule-actions");
    if (!item) return td;
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

    // 人工匹配行：显示被匹配器件身份 + 重新匹配 / 退回
    if (item.match_reason === "manual_match") {
      td.appendChild(el("div", "hint", M.manualMatchText(item)));
      const again = el("button", null, "重新匹配…");
      again.type = "button";
      again.title = "换一条库里器件作为本条缺料的匹配对象";
      again.addEventListener("click", () => openPartPicker(item.row_no));
      const back = el("button", null, "退回");
      back.type = "button";
      back.title = "撤销这次人工匹配，回到未匹配的缺料（已同步进库的字段不会回滚）";
      back.addEventListener("click", () => revertManualMatch(item.row_no));
      td.appendChild(again);
      td.appendChild(back);
      return td;
    }

    // 已确认的疑似行（进了够用/缺料）：状态 + 保留两个确认键（直接改选）+ 改判
    if (item.match_reason === "confirmed_same" || item.match_reason === "confirmed_different") {
      td.appendChild(el("div", "hint", M.decisionText(item)));
      const same = el("button", null, "是同一颗（按库存算）");
      same.type = "button";
      same.disabled = item.match_reason === "confirmed_same";
      same.title = same.disabled ? "当前就是「同一颗」" : "改为「是同一颗」：按库里候选的库存重算缺口（只读，不改库）";
      same.addEventListener("click", () => applyRuling(item.row_no, "same"));
      const diff = el("button", null, "不是同一颗（算缺料）");
      diff.type = "button";
      diff.disabled = item.match_reason === "confirmed_different";
      diff.title = diff.disabled ? "当前就是「不是同一颗」" : "改为「不是同一颗」：按缺料算（只读，不改库）";
      diff.addEventListener("click", () => applyRuling(item.row_no, "different"));
      const undo = el("button", null, "改判");
      undo.type = "button";
      undo.title = "撤销这次人工确认，回到疑似重新判断";
      undo.addEventListener("click", () => applyRuling(item.row_no, "__reset__"));
      td.appendChild(same);
      td.appendChild(diff);
      td.appendChild(undo);
      // 被否定后归入缺料的行，属于"未匹配的缺料"——同样允许人工匹配（用户 2026-10-17 裁定）
      if (M.isManualMatchable(item)) td.appendChild(manualMatchButton(item.row_no));
      return td;
    }

    // 真正的未匹配缺料行：给人工匹配入口（已匹配上只是库存不足的不给）
    if (groupKey === "shortfall" && M.isManualMatchable(item)) {
      td.appendChild(manualMatchButton(item.row_no));
    }
    return td;
  }

  function manualMatchButton(rowNo) {
    const button = el("button", null, "人工匹配…");
    button.type = "button";
    button.title = "从库里挑一条器件，把本行当作同一颗（只读比对；可选把 BOM 的判定键值同步进库）";
    button.addEventListener("click", () => openPartPicker(rowNo));
    return button;
  }

  /** 记录/撤销一行的人工裁决，然后带着全部裁决重新比对（服务端统一应用） */
  async function applyRuling(rowNo, ruling) {
    if (state.busy) return; // 比对在飞时不受理新的确认：避免"已记裁决但界面还是旧结果"
    // 裁决与人工匹配互斥：一行要么"疑似→确认/否定"，要么"缺料→人工匹配"
    delete state.manual_matches[rowNo];
    if (ruling === "__reset__") delete state.rulings[rowNo];
    else state.rulings[rowNo] = ruling;
    state.notice = "";
    await doCompare();
  }

  /* --------------------------------------- 人工匹配：选器件 + 字段同步 */

  /** 在结果里按行号找一行（跨三组；用于取 BOM 侧判定键值） */
  function findResultRow(rowNo) {
    const r = state.result || {};
    for (const key of ["enough", "shortfall", "uncertain"]) {
      for (const item of (r[key] || [])) {
        if (String(item.row_no) === String(rowNo)) return item;
      }
    }
    return null;
  }

  async function loadPartsForPicker() {
    if (state.parts_cache) return state.parts_cache;
    const r = await call("partsList", { query: { q: "" } });
    state.parts_cache = Array.isArray(r.parts) ? r.parts : [];
    return state.parts_cache;
  }

  /** 打开「从库里挑器件」弹窗（页内 DOM，不用原生对话框） */
  async function openPartPicker(rowNo) {
    if (state.busy) return;
    try {
      showError("");
      const parts = await loadPartsForPicker();
      renderPartPicker(rowNo, parts);
    } catch (exc) {
      showError(exc.message);
    }
  }

  function renderPartPicker(rowNo, parts) {
    const mask = el("div", "modal-mask");
    mask.id = "match-picker-mask";
    const panel = el("div", "modal match-picker");
    panel.appendChild(el("h3", null, `人工匹配：给 BOM 第 ${rowNo} 行挑一条库里器件`));
    panel.appendChild(el("p", "hint", "只用于「库里没有这颗料」或「疑似被否定」的缺料行；已匹配上只是库存不足的行不需要人工匹配。"));
    const search = el("input", "file-box");
    search.id = "match-search";
    search.placeholder = "搜索：值 / 型号 / 封装 / 分类 …";
    panel.appendChild(search);
    const list = el("div", "match-list");
    list.id = "match-list";
    panel.appendChild(list);
    const actions = el("div", "form-actions");
    const cancel = el("button", null, "取消");
    cancel.type = "button";
    cancel.id = "match-cancel";
    actions.appendChild(cancel);
    panel.appendChild(actions);
    mask.appendChild(panel);
    const close = () => { if (mask.parentNode) mask.parentNode.removeChild(mask); };
    cancel.addEventListener("click", close);
    mask.addEventListener("click", (ev) => { if (ev && ev.target === mask) close(); });
    document.body.appendChild(mask);

    const draw = (keyword) => {
      list.textContent = "";
      const kw = String(keyword || "").trim().toLowerCase();
      const shown = parts.filter((p) => {
        if (kw === "") return true;
        const hay = [p.value, p.part_number, p.footprint, p.category, p.supplier_part]
          .map((v) => String(v == null ? "" : v)).join(" ").toLowerCase();
        return hay.includes(kw);
      }).slice(0, 200);
      if (shown.length === 0) {
        list.appendChild(el("p", "hint", "没有匹配的器件（换个关键字试试）"));
        return;
      }
      for (const p of shown) {
        const option = el("button", "match-option");
        option.type = "button";
        option.title = `选择这条：${p.id}`;
        option.appendChild(el("strong", null, String(p.value == null || p.value === "" ? "（值空）" : p.value)));
        option.appendChild(el("span", null, ` ${p.footprint || "（无封装）"}${p.category ? " · " + p.category : ""}`));
        option.appendChild(el("span", "hint", `　库存 ${Number(p.quantity) || 0}${p.part_number ? " · " + p.part_number : ""}`));
        option.addEventListener("click", () => { close(); chooseManualMatch(rowNo, p); });
        list.appendChild(option);
      }
    };
    search.addEventListener("input", () => draw(search.value));
    draw("");
  }

  /** 选定器件 → 先问「要不要把 BOM 的判定键值同步进库」→ 再带着匹配关系重算 */
  async function chooseManualMatch(rowNo, part) {
    if (state.busy) return;
    const row = findResultRow(rowNo);
    if (!row) { showError("找不到这一行（比对结果可能已更新），请重新比对"); return; }
    state.manual_matches[rowNo] = part.id;
    state.notice = "";
    const fields = M.keyFieldsOf(row);
    try {
      const preview = await call("compareSyncFields", { part_id: part.id, row_no: rowNo, fields: fields, confirm: false });
      const changes = preview.changes || [];
      if (changes.length > 0) {
        const lines = M.formatFieldChanges(changes);
        const choice = await root.DialogUI.choose({
          title: "要不要把 BOM 的这些值同步到库里这条器件？",
          message: `比对第 ${rowNo} 行与「${String(part.value || "")} / ${String(part.footprint || "")}」（${part.id}）的判定键字段有差异：\n`
            + `${lines.join("\n")}\n`
            + "选「替换并写库」：只改这条器件的判定键五字段（值/封装/耐压/材质/容差），"
            + "并写一条变动记录留痕；以后同 BOM 会直接匹配上。\n"
            + "选「只本次匹配」：这次比对按它算，但库不变，以后同 BOM 仍会缺料。",
          options: [
            { value: "apply", text: "替换并写库", primary: true },
            { value: "keep", text: "只本次匹配，不替换" },
            { value: "cancel", text: "取消匹配" },
          ],
        });
        if (choice === "cancel") {
          delete state.manual_matches[rowNo];
          await doCompare();
          return;
        }
        if (choice === "apply") {
          try {
            const applied = await call("compareSyncFields", {
              part_id: part.id, row_no: rowNo, fields: fields, confirm: true,
            });
            if (applied.applied) {
              state.parts_cache = null; // 库变了，下次打开选择器要重新取
              // 字段已同步 → 这一行下一次比对会自然匹配，不再需要保留"人工匹配"关系
              delete state.manual_matches[rowNo];
              state.notice = `已把 ${applied.changes.length} 个字段同步到库里的「${String(applied.part.value || "")} / ${String(applied.part.footprint || "")}」：`
                + M.formatFieldChanges(applied.changes).join("；");
            } else {
              delete state.manual_matches[rowNo];
              state.notice = "库里字段已一致，无需替换（本行不会以人工匹配方式保留）";
            }
          } catch (syncError) {
            // 写库失败：报错、库不动；本次匹配仍保留（用户可退回或重试同步）
            showError(syncError.message);
          }
        }
      }
    } catch (exc) {
      // 预览/弹窗阶段失败：不保留"半截匹配"（写库失败是上面那个内层 catch，那边按设计保留匹配）
      delete state.manual_matches[rowNo];
      showError(exc.message);
    }
    await doCompare();
  }

  /** 「退回」人工匹配：只撤销匹配关系；已同步进库的字段不回滚（弹窗明确提示） */
  async function revertManualMatch(rowNo) {
    if (state.busy) return;
    const yes = await root.DialogUI.confirm({
      title: "退回这次人工匹配？",
      message: "退回后这一行会按原来的缺料/疑似规则重新计算。\n"
        + "注意：如果你刚才选了「替换并写库」，库里的字段不会自动改回去——"
        + "要改请到「库存 → 编辑」那条器件（同样会留痕）。",
      okText: "退回匹配",
      cancelText: "取消",
      danger: true,
    });
    if (!yes) return;
    delete state.manual_matches[rowNo];
    state.notice = "";
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
    const manualCount = ["enough", "shortfall"].reduce((sum, k) =>
      sum + (groupItems(k) || []).filter((it) => it.match_reason === "manual_match").length, 0);
    if (confirmedCount > 0 || manualCount > 0) {
      const bits = [];
      if (confirmedCount > 0) bits.push(`已人工确认 ${confirmedCount} 条疑似`);
      if (manualCount > 0) bits.push(`已人工匹配 ${manualCount} 条缺料`);
      body.appendChild(el("p", "hint",
        `${bits.join("、")}（确认/匹配只影响这份比对与导出；人工匹配关系不保存，字段是否写库以同步确认结果为准）。`));
    }
    if (state.notice) body.appendChild(el("div", "banner", state.notice));

    const active = M.GROUPS.find((g) => g.key === state.active_group) || M.GROUPS[0];
    body.appendChild(el("p", "hint", `${active.label}：${active.hint}`));
    if (active.key === "shortfall") {
      const matchable = groupItems("shortfall").filter((it) => M.isManualMatchable(it)).length;
      if (matchable > 0) {
        body.appendChild(el("p", "hint",
          `其中 ${matchable} 条是「库中没找到这颗料」或「疑似被否定」，行尾可点「人工匹配…」从库里指定同一颗；`
          + "已匹配上、只是库存不足的行不需要人工匹配。"));
      }
    }
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
