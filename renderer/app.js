"use strict";
/**
 * app.js — 渲染进程外壳：页面切换 + 库存页渲染
 *
 * 硬规则（AGENTS.md）：**渲染进程禁止 require('fs')、禁止直接读数据文件**，
 * 一切数据都走 `window.api.<方法>`（preload 暴露的 IPC 白名单）。
 * 本文件里没有 require、没有 fetch、没有 XMLHttpRequest —— 想联网也没有通道。
 *
 * 页面分工：
 *   库存页   本文件渲染
 *   导入向导 renderer/pages/import_wizard.js（规则在 renderer/model/import_model.js，有无头测试）
 */

/** IPC 调用：实现统一在 renderer/ui_util.js（页面里不再各写一份） */
const UI = window.UIUtil;
const call = function (method, payload) {
  return UI.call(window.api, method, payload);
};

function setStatus(text, isError) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text == null || text === "" ? "—" : String(text);
  return td;
}

function renderParts(parts, lowIds, similarIds) {
  const low = new Set(lowIds || []);
  const similar = new Set(similarIds || []);
  const tbody = document.getElementById("parts-body");
  tbody.textContent = "";
  if (!parts || parts.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 11;
    td.className = "empty";
    // 空状态要说清"是库里真的空"还是"是检索/筛选没匹配到"（用户目标：检索/筛选要好用，不能误导）
    const filtering = hasActiveSearchOrFilter();
    td.textContent = filtering
      ? "没有匹配的器件：可以「清除筛选」，或换个写法试试（0.1uF 与 100nF、4K7 与 4.7kΩ 视为同一个值）。"
      : "库里还没有器件：去「导入 BOM」开始，或用「手动录入」加一条。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const part of parts) {
    const tr = document.createElement("tr");
    if (low.has(part.id)) tr.classList.add("low");
    // **相似命中**：字面没命中，但值归一后相同（0.1uF ↔ 100nF / 4K7 ↔ 4.7kΩ）或型号归一相同 →
    // 标出来，用户才知道它为什么出现在结果里（不是精确匹配）
    if (similar.has(part.id)) {
      tr.classList.add("similar");
      tr.title = "相似命中：值与检索词归一后相同（例如 0.1uF 与 100nF 是同一个值），或型号归一后相同";
    }
    tr.appendChild(cell(part.value));
    tr.appendChild(cell(part.footprint));
    tr.appendChild(cell(part.voltage));
    tr.appendChild(cell(part.dielectric));
    tr.appendChild(cell(part.tolerance));
    tr.appendChild(cell(part.category));
    tr.appendChild(cell(part.part_number));
    // 「厂商」列已按用户要求去掉（2026-10-17：厂商不重要；字段仍在数据模型里，只是列表不显示）
    const qty = cell(part.quantity);
    qty.className = "num";
    if (low.has(part.id)) qty.classList.add("warn");
    tr.appendChild(qty);
    tr.appendChild(cell(part.location));

    // 操作列：编辑（进手动录入页并载入）/ 删除（需确认）
    const actions = document.createElement("td");
    actions.className = "row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openPart(part));
    // 「领料」：带着这条器件跳到领料页并预选（用户目标：领料别太繁琐，少翻一次全库列表）
    const pick = document.createElement("button");
    pick.type = "button";
    pick.textContent = "领料";
    pick.title = "去领料页并预选这条器件";
    pick.addEventListener("click", () => openStockFor(part));
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "删除";
    del.addEventListener("click", () => deletePart(part, del));
    actions.appendChild(edit);
    actions.appendChild(pick);
    actions.appendChild(del);
    tr.appendChild(actions);

    tbody.appendChild(tr);
  }
}

/** 打开某条器件（切到手动录入页并载入）*/
function openPart(part) {
  pendingPart = part;
  showPage("parts");
}

/** 把某条器件带到领料页并预选（库存页行内「领料」） */
function openStockFor(part) {
  window.__pendingStockPart = part && part.id ? part.id : "";
  showPage("stock");
}

/**
 * 危险/异步动作的防重入标记（对抗审计 B1）。
 * 库存页的「删除」「导出库表」都是"点一下执行一次"的动作：双击就会删两次/导两份。
 * 与 T94 parts_editor 的 state.saving 同一模式（局部 busy + 按钮 disabled），不另写变体。
 */
let actionBusy = false;

/** 删除一条器件：AGENTS.md 要求人工确认（用页内弹窗，不用原生 confirm——原生弹窗在 Electron 里会卡住界面） */
async function deletePart(part, button) {
  if (actionBusy) return;
  actionBusy = true;
  if (button) button.disabled = true;
  try {
    // 缺失守卫（对抗审计 C4）：为安全起见没有确认框就不删（宁可拒绝，不可无确认地删）
    if (!window.DialogUI || typeof window.DialogUI.confirm !== "function") {
      setStatus("界面组件 dialog.js 没有加载（请完全退出应用再重新打开）；为安全起见这次不删除。", true);
      return;
    }
    const ok = await window.DialogUI.confirm({
      title: "确定删除这条器件吗？",
      message: `${part.value} / ${part.footprint}（${part.id}）\n变动记录会保留作为历史。`,
      okText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    await call("partsDelete", { part_id: part.id, confirm: true });
    setStatus(`已删除 ${part.id}`, false);
    refreshInventory();
  } catch (exc) {
    setStatus(`删除失败：${exc.message}`, true);
  } finally {
    actionBusy = false;
    if (button) button.disabled = false; // 成功时整表已重渲染，这里是失败/取消路径的恢复
  }
}

/** FR-5.5：把当前库导出成表格文件（条数与库中一致） */
async function exportLibrary() {
  if (actionBusy) return;
  actionBusy = true;
  const btn = document.getElementById("export-library");
  if (btn) btn.disabled = true;
  try {
    setStatus("正在导出库表…", false);
    const r = await call("partsExport", {});
    setStatus(`已导出 ${r.exported_count} 条 → ${r.file_path}`, false);
  } catch (exc) {
    setStatus(`导出失败：${exc.message}`, true);
  } finally {
    actionBusy = false;
    if (btn) btn.disabled = false;
  }
}

/** 当前是否处于"检索/筛选"状态（决定空状态文案、结果行措辞） */
function hasActiveSearchOrFilter() {
  const search = document.getElementById("search");
  const q = search ? String(search.value || "").trim() : "";
  return q !== "" || filterState.category !== "" || filterState.footprint !== ""
    || filterState.voltage !== "" || filterState.lowOnly === true;
}

/** 分类的显示名：`_default` 是"未选分类"的哨兵值，界面上显示成可读文字（查询仍用原值） */
function categoryLabel(value) {
  return value === "_default" ? "其它（未分类）" : value;
}

/** 筛选下拉框的「全部 + 候选值」填充（值来自服务端 facets = 用全部器件算，不受当前筛选影响） */
function fillFacetSelects(facets) {
  const spec = [
    ["filter-category", "全部分类", (facets && facets.categories) || []],
    ["filter-footprint", "全部封装", (facets && facets.footprints) || []],
    ["filter-voltage", "全部耐压", (facets && facets.voltages) || []],
  ];
  for (const [id, allLabel, values] of spec) {
    const select = document.getElementById(id);
    if (!select) continue;
    const current = select.value;
    while (select.children.length > 1) select.removeChild(select.children[select.children.length - 1]);
    // 「全部」那一项：真实页面里写在 index.html 里；无头测试的壳可能没建 option → 这里补一个
    //（不要在 children[0] 上直接赋值：壳里可能根本没有子节点，会抛 TypeError 让整页加载失败）
    let placeholder = select.children[0];
    if (!placeholder) {
      placeholder = document.createElement("option");
      select.appendChild(placeholder);
    }
    placeholder.value = "";
    placeholder.textContent = allLabel;
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = id === "filter-category" ? categoryLabel(value) : value;
      select.appendChild(option);
    }
    select.value = values.includes(current) ? current : "";
  }
}

/** 结果行：条数 / 筛选条件 / **相似命中**说明（用户目标：检索相似产品要能看出来） */
function updateResultLine(list) {
  const node = document.getElementById("result-line");
  if (!node) return;
  const rows = Array.isArray(list.parts) ? list.parts : [];
  const total = list.total == null ? rows.length : list.total;
  const allTotal = list.all_total == null ? total : list.all_total;
  const similarCount = (list.similar_ids || []).length;
  const q = document.getElementById("search").value.trim();
  const active = [];
  if (filterState.category) active.push("分类 " + categoryLabel(filterState.category));
  if (filterState.footprint) active.push("封装 " + filterState.footprint);
  if (filterState.voltage) active.push("耐压 " + filterState.voltage);
  if (filterState.lowOnly) active.push("只看低库存");
  let text = `显示 ${total} 条 / 库中共 ${allTotal} 条`;
  if (active.length > 0) text += `（筛选：${active.join("、")}）`;
  if (q !== "") text += `；搜索「${q}」`;
  if (similarCount > 0) {
    text += `；其中 ${similarCount} 条为「相似命中」（写法不同、值相同，行首已标「相似」）`;
  } else if (q !== "" && total === 0) {
    text += "；没有结果（换个写法试试：0.1uF 与 100nF、4K7 与 4.7kΩ 视为同一个值）";
  }
  node.textContent = text;
}

/** 晚到的旧响应（搜索去抖/筛选连点）不许覆盖新结果 —— 守卫实现见 renderer/ui_util.js */
const inventoryGuard = UI.requestGuard();

async function refreshInventory() {
  const seq = inventoryGuard.next();
  try {
    setStatus("正在加载…", false);
    const q = document.getElementById("search").value.trim();
    const query = { q };
    // FR-5.3：筛选条件（服务端处理；分类精确、封装/耐压大小写不敏感）
    if (filterState.category) query.category = filterState.category;
    if (filterState.footprint) query.footprint = filterState.footprint;
    if (filterState.voltage) query.voltage = filterState.voltage;
    if (filterState.lowOnly) query.low_stock_only = true;
    if (sortState.sort_by) {
      query.sort_by = sortState.sort_by;
      query.sort_dir = sortState.sort_dir;
    }
    const [list, moves, settings] = await Promise.all([
      call("partsList", { query }),
      call("movementsList", {}),
      call("settingsGet", {}),
    ]);
    // 竞态防护：期间用户又改了搜索/筛选（发了更新的请求）→ 本次结果作废，不许回写
    if (!inventoryGuard.isCurrent(seq)) return;

    fillFacetSelects(list.facets);
    renderParts(list.parts, list.low_stock_ids, list.similar_ids);
    updateResultLine(list);
    document.getElementById("stat-parts").textContent = String(list.total == null ? list.parts.length : list.total);
    document.getElementById("stat-low").textContent = String((list.low_stock_ids || []).length);
    document.getElementById("stat-moves").textContent = String((moves.movements || []).length);
    document.getElementById("stat-dir").textContent =
      (settings.settings && settings.settings.data_dir) || "（默认 data/）";

    const lowCount = (list.low_stock_ids || []).length;
    document.getElementById("low-summary").textContent = lowCount > 0
      ? `⚠ ${lowCount} 种器件低于低库存阈值（表中已标红）`
      : "";

    // FR-4.3：启动时若有低库存器件，**提示一次**（切页来回不再重复弹）
    const notice = document.getElementById("startup-notice");
    if (notice) {
      const text = window.SettingsModel.startupNotice(lowCount, startupNoticeShown);
      if (text) {
        notice.textContent = text;
        notice.hidden = false;
        startupNoticeShown = true;
      } else if (lowCount === 0) {
        notice.hidden = true;
      }
    }
    setStatus(`就绪 · ${new Date().toLocaleTimeString("zh-CN")}`, false);
  } catch (exc) {
    if (!inventoryGuard.isCurrent(seq)) return; // 旧请求失败也不覆盖新状态
    setStatus(`加载失败：${exc.message}`, true);
  }
}

/** 搜索输入去抖（200ms）；实现统一在 renderer/ui_util.js */
const refreshInventorySoon = UI.debounce(refreshInventory, 200);

/* ------------------------------------------------------------ 页面切换 */

const PAGES = ["inventory", "import", "compare", "parts", "stock", "settings", "backup", "statement"];
let currentPage = "inventory";
let pendingPart = null; // 库存页点「编辑」时暂存，切页后交给录入页
const mounted = { import: false, compare: false, stock: false, settings: false, backup: false, statement: false };
let startupNoticeShown = false; // FR-4.3：启动汇总提示只显示一次

/** FR-5.1：点表头排序，再点同一列反向 */
let sortState = { sort_by: "", sort_dir: "asc" };

/**
 * FR-5.3 筛选条件（用户 2026-10-17 目标：库存/领料太繁琐，至少要有检索、筛选）
 * 分类 / 封装 / 耐压 / 只看低库存；检索语义（含"相似产品"）在服务层 part_search.js
 */
let filterState = { category: "", footprint: "", voltage: "", lowOnly: false };

function applySortIndicators() {
  for (const th of document.querySelectorAll("#parts th.sortable")) {
    const field = th.dataset.field;
    const active = sortState.sort_by === field;
    th.textContent = th.textContent.replace(/[ ▲▼]+$/, "");
    if (active) th.textContent += sortState.sort_dir === "desc" ? " ▼" : " ▲";
    th.classList.toggle("sorted", active);
  }
}

function showPage(name) {
  if (!PAGES.includes(name)) return;
  currentPage = name;
  for (const page of PAGES) {
    const section = document.getElementById(`page-${page}`);
    if (section) section.hidden = page !== name;
  }
  for (const button of document.querySelectorAll(".nav")) {
    button.classList.toggle("active", button.dataset.page === name);
  }
  if (name === "inventory") refreshInventory();
  if (name === "import" && !mounted.import) {
    window.ImportPage.mount(document.getElementById("import-wizard"), {});
    mounted.import = true;
  }
  if (name === "compare" && !mounted.compare) {
    window.ComparePage.mount(document.getElementById("compare-report"));
    mounted.compare = true;
  }
  if (name === "parts") {
    // 每次都重新挂载：从库存页带过来的 part 可能是另一条
    window.PartsPage.mount(document.getElementById("parts-editor"), { part: pendingPart });
    pendingPart = null;
  }
  if (name === "stock") {
    const pendingStockPart = window.__pendingStockPart || "";
    window.__pendingStockPart = "";
    if (!mounted.stock) {
      window.StockPage.mount(document.getElementById("stock-panel"));
      mounted.stock = true;
    }
    // 库存页点「领料」过来：直接选中那条器件（领料页自己有检索/筛选，预选后仍可改）
    if (pendingStockPart !== "") window.StockPage.focusPart(pendingStockPart);
  }
  if (name === "statement" && !mounted.statement) {
    window.StatementPage.mount(document.getElementById("statement-page"), {});
    mounted.statement = true;
  }
  if (name === "settings" && !mounted.settings) {
    window.SettingsPage.mount(document.getElementById("settings-panel"));
    mounted.settings = true;
  }
  if (name === "backup" && !mounted.backup) {
    window.BackupPage.mount(document.getElementById("backup-panel"));
    mounted.backup = true;
  }
}

function bindShell() {
  for (const button of document.querySelectorAll(".nav")) {
    button.addEventListener("click", () => showPage(button.dataset.page));
  }
  for (const th of document.querySelectorAll("#parts th.sortable")) {
    th.addEventListener("click", () => {
      // 排序规则在 parts_model.js（单一实现，有无头测试）
      sortState = window.PartsModel.nextSort(sortState, th.dataset.field);
      applySortIndicators();
      refreshInventory();
    });
  }
  document.getElementById("refresh").addEventListener("click", refreshInventory);
  document.getElementById("export-library").addEventListener("click", exportLibrary);

  // FR-5.3：筛选控件（改了就重查；不用按"刷新"）
  for (const [id, key] of [["filter-category", "category"], ["filter-footprint", "footprint"], ["filter-voltage", "voltage"]]) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.addEventListener("change", () => {
      filterState[key] = node.value;
      refreshInventory();
    });
  }
  const lowOnly = document.getElementById("filter-low-only");
  if (lowOnly) {
    lowOnly.addEventListener("change", () => {
      filterState.lowOnly = lowOnly.checked === true;
      refreshInventory();
    });
  }
  const clearFilters = document.getElementById("filter-clear");
  if (clearFilters) {
    clearFilters.addEventListener("click", () => {
      filterState = { category: "", footprint: "", voltage: "", lowOnly: false };
      const search = document.getElementById("search");
      if (search) search.value = "";
      for (const id of ["filter-category", "filter-footprint", "filter-voltage"]) {
        const node = document.getElementById(id);
        if (node) node.value = "";
      }
      if (lowOnly) lowOnly.checked = false;
      refreshInventory();
    });
  }
  const searchInput = document.getElementById("search");
  searchInput.addEventListener("input", () => {
    // 输入停顿 200ms 再查（NFR-2：1000 条以内要即时响应）；去抖实现见 renderer/ui_util.js
    refreshInventorySoon();
  });
  // 行业常规：按 Enter 立即检索（跳过去抖），常搜的人不用干等 200ms
  searchInput.addEventListener("keydown", (event) => {
    if (event && (event.key === "Enter" || event.keyCode === 13)) {
      refreshInventorySoon.cancel();
      refreshInventory();
    }
  });
  // 供向导/录入页在数据变化后刷新库存页
  window.refreshInventory = refreshInventory;
}

bindShell();
applySortIndicators();
showPage("inventory");
