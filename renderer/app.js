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

/** IPC 一律返回 {ok, error}；这里统一处理失败，避免每处都写一遍 */
async function call(method, payload) {
  const api = window.api;
  if (!api || typeof api[method] !== "function") {
    throw new Error(`IPC 方法不存在：${method}（preload 白名单里没有它）`);
  }
  const result = await api[method](payload);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || `${method} 调用失败`);
  }
  return result;
}

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

function renderParts(parts, lowIds) {
  const low = new Set(lowIds || []);
  const tbody = document.getElementById("parts-body");
  tbody.textContent = "";
  if (!parts || parts.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 11;
    td.className = "empty";
    td.textContent = "库里还没有器件：去「导入 BOM」开始，或用「手动录入」加一条。";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const part of parts) {
    const tr = document.createElement("tr");
    if (low.has(part.id)) tr.classList.add("low");
    tr.appendChild(cell(part.value));
    tr.appendChild(cell(part.footprint));
    tr.appendChild(cell(part.voltage));
    tr.appendChild(cell(part.dielectric));
    tr.appendChild(cell(part.tolerance));
    tr.appendChild(cell(part.category));
    tr.appendChild(cell(part.part_number));
    tr.appendChild(cell(part.manufacturer));
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
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "删除";
    del.addEventListener("click", () => deletePart(part));
    actions.appendChild(edit);
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

/** 删除一条器件：AGENTS.md 要求人工确认 */
async function deletePart(part) {
  try {
    const ok = window.confirm(`确定删除这条器件吗？\n\n${part.value} / ${part.footprint}（${part.id}）\n\n变动记录会保留作为历史。`);
    if (!ok) return;
    await call("partsDelete", { part_id: part.id, confirm: true });
    setStatus(`已删除 ${part.id}`, false);
    refreshInventory();
  } catch (exc) {
    setStatus(`删除失败：${exc.message}`, true);
  }
}

/** FR-5.5：把当前库导出成表格文件（条数与库中一致） */
async function exportLibrary() {
  try {
    setStatus("正在导出库表…", false);
    const r = await call("partsExport", {});
    setStatus(`已导出 ${r.exported_count} 条 → ${r.file_path}`, false);
  } catch (exc) {
    setStatus(`导出失败：${exc.message}`, true);
  }
}

async function refreshInventory() {
  try {
    setStatus("正在加载…", false);
    const query = { q: document.getElementById("search").value.trim() };
    if (sortState.sort_by) {
      query.sort_by = sortState.sort_by;
      query.sort_dir = sortState.sort_dir;
    }
    const [list, moves, settings] = await Promise.all([
      call("partsList", { query }),
      call("movementsList", {}),
      call("settingsGet", {}),
    ]);

    renderParts(list.parts, list.low_stock_ids);
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
    setStatus(`加载失败：${exc.message}`, true);
  }
}

/* ------------------------------------------------------------ 页面切换 */

const PAGES = ["inventory", "import", "compare", "parts", "stock", "settings", "backup", "statement"];
let currentPage = "inventory";
let pendingPart = null; // 库存页点「编辑」时暂存，切页后交给录入页
const mounted = { import: false, compare: false, stock: false, settings: false, backup: false, statement: false };
let startupNoticeShown = false; // FR-4.3：启动汇总提示只显示一次

/** FR-5.1：点表头排序，再点同一列反向 */
let sortState = { sort_by: "", sort_dir: "asc" };

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
  if (name === "stock" && !mounted.stock) {
    window.StockPage.mount(document.getElementById("stock-panel"));
    mounted.stock = true;
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
  document.getElementById("search").addEventListener("input", () => {
    // 简单防抖：输入停顿 200ms 再查（NFR-2：1000 条以内要即时响应）
    clearTimeout(window.__searchTimer);
    window.__searchTimer = setTimeout(refreshInventory, 200);
  });
  // 供向导/录入页在数据变化后刷新库存页
  window.refreshInventory = refreshInventory;
}

bindShell();
applySortIndicators();
showPage("inventory");
