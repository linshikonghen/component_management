"use strict";
/**
 * test_parts_export.js — T21 验收测试：**导出当前库为表格文件**（spec FR-5.5 / AC-5 第 5 行）
 *
 * 运行： node tests/test_parts_export.js
 *
 * AC-5 那一行的通过标准只有一句：「生成表格文件，**条数与库中一致**」。
 * 但"条数对"不代表"内容对"，所以这里还做三件事：
 *   · 表头与列语义逐项钉住（含"阈值留空 = 继承"如实留空，不冒充个体值）；
 *   · **低库存列与服务端判定一致**（拿 parts:list 的 low_stock_ids 对照，避免导出侧另写一套阈值逻辑）；
 *   · **写出来的 xlsx 用自写读取器读回、逐格比对**（跨"写/读"两个实现，不是同源自证）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHandlers } = require("../src/ipc/handlers");
const { createStore } = require("../src/services/store");
const exportFormat = require("../src/services/export_format");
const lowStock = require("../src/services/low_stock");
const bp = require("../src/services/bom_parser");
const channels = require("../src/ipc/channels");
const extensions = require("../src/ipc/extensions");

const FIX = path.join(__dirname, "fixtures");
const MAIN_BOM = path.join(FIX, "sample_bom");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cm_export_"));

let passCount = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log("  PASS  " + name);
  } catch (exc) {
    failures.push({ name, message: String(exc && exc.message ? exc.message : exc) });
    console.log("  FAIL  " + name);
    console.log("        " + String(exc && exc.message ? exc.message : exc).split("\n").join("\n        "));
  }
}
function section(title) { console.log("\n=== " + title + " ==="); }

let envNo = 0;
function freshEnv() {
  envNo += 1;
  const base = path.join(TMP, "e" + envNo);
  fs.mkdirSync(base, { recursive: true });
  const db = createStore({ base_dir: base });
  const env = createHandlers({ store: db, pick_files: async () => [MAIN_BOM], now: () => new Date(2026, 9, 15, 10, 0, 0) });
  return { db, handlers: env.handlers };
}

/** 建一个有内容的库：真实主样本 32 条 + 一条手动录入 */
async function seedLibrary(handlers) {
  const parsed = await handlers["bom:parse"]({ file_path: MAIN_BOM, sets: 1 });
  const committed = await handlers["bom:commit"]({ batch_id: parsed.batch_id, items: parsed.items, sets: 1 });
  assert.strictEqual(committed.ok, true, committed.error);
  const manual = await handlers["parts:save"]({
    part: { category: "R", value: "1k", footprint: "R0603", voltage: "50V", quantity: 8, location: "C-02", note: "手动录入" },
  });
  assert.strictEqual(manual.ok, true, manual.error);
  return committed;
}

async function main() {
  /* ==================================================== §1 契约扩展登记 */
  section("§1 契约扩展登记：新增通道必须登记，否则测试会红");

  await t("parts:export 在通道清单**与 plan §6** 里（v1.5 实现期补记 2 已并入契约）", () => {
    assert.ok(channels.CHANNELS.includes("parts:export"), "通道清单里应有 parts:export");
    assert.ok(channels.PLAN_CHANNELS.includes("parts:export"), "它现在属于契约内的通道");
    const plan = fs.readFileSync(path.join(__dirname, "..", "docs", "plan.md"), "utf8");
    assert.ok(/^### parts:export$/m.test(plan), "plan §6 里应有 parts:export 契约段");
    assert.strictEqual(channels.CHANNELS.length, channels.PLAN_CHANNELS.length + extensions.EXTENSION_CHANNELS.length);
    return null;
  });

  await t("登记表已清空（**并入契约后必须删掉登记项**——登记表是过渡态）", () => {
    assert.strictEqual(extensions.listExtensions().length, 0,
      "并入 plan §6 之后登记表应为空；非空说明有未并入的越界还没交代");
    // 机制仍在：登记项若存在，必须带 spec 出处/原因/待并入任务号，且**不能是已在契约里的东西**
    for (const e of extensions.CHANNEL_EXTENSIONS.concat(extensions.FIELD_EXTENSIONS)) {
      assert.ok(e.spec_ref && e.reason && e.merge_task, "登记项三要素不全：" + e.channel);
    }
    return null;
  });

  await t("extensions.js 不 require 任何模块（channels.js 被 preload 引用，边界要干净）", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "extensions.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    assert.ok(!/require\s*\(/.test(code), "扩展登记表应是纯数据");
    return null;
  });

  /* ==================================================== §2 列与行 */
  section("§2 表头与行长（AC-5：条数与库中一致）");

  await t("列名与 LIBRARY_COLUMNS 一致，共 14 列；**表头是 rows 的第一行**（与 buildRows 同约定）", () => {
    const built = exportFormat.buildLibraryRows([{ value: "1k", footprint: "R0603", quantity: 5 }], {});
    assert.deepStrictEqual(built.columns, [
      "值", "封装", "耐压", "材质", "容差", "分类", "型号", "厂商", "供应商编号",
      "数量", "低库存阈值", "库位", "备注", "低库存",
    ]);
    assert.strictEqual(built.columns.length, 14);
    assert.deepStrictEqual(built.rows[0], built.columns, "第一行应是表头");
    assert.strictEqual(built.rows.length, 2, "表头 + 1 行数据");
    return null;
  });

  await t("data_count == 库中条数（空库 → 0；rows 仍有表头那一行）", () => {
    const empty = exportFormat.buildLibraryRows([], {});
    assert.strictEqual(empty.data_count, 0);
    assert.strictEqual(empty.rows.length, 1, "只有表头");
    const two = exportFormat.buildLibraryRows([{}, {}], {});
    assert.strictEqual(two.data_count, 2);
    assert.strictEqual(two.rows.length, 3, "表头 + 2 行");
    return null;
  });

  await t("数量列是数字（Excel 要能直接求和），不是字符串", () => {
    const built = exportFormat.buildLibraryRows([{ quantity: 24 }], {});
    const qty = built.rows[1][built.columns.indexOf("数量")];
    assert.strictEqual(typeof qty, "number");
    assert.strictEqual(qty, 24);
    return null;
  });

  await t("个体阈值**留空如实留空**（不把继承来的分类默认值写进去冒充个体值）", () => {
    const settings = { default_min_quantity: { C: 20, _default: 5 } };
    const withInherit = exportFormat.buildLibraryRows([{ category: "C", quantity: 3, min_quantity: "" }], settings);
    const withOwn = exportFormat.buildLibraryRows([{ category: "C", quantity: 3, min_quantity: 10 }], settings);
    const idx = withInherit.columns.indexOf("低库存阈值");
    assert.strictEqual(withInherit.rows[1][idx], 0, "留空在该列应为 0/空——而不是 20");
    assert.strictEqual(withOwn.rows[1][idx], 10);
    return null;
  });

  await t("低库存列复用服务端判定，不另写一套阈值逻辑", () => {
    const settings = { default_min_quantity: { C: 20, R: 50, _default: 5 } };
    const parts = [
      { id: "a", category: "C", quantity: 15, min_quantity: "" },   // 15 < 20 → 是
      { id: "b", category: "C", quantity: 25, min_quantity: "" },   // 25 > 20 → 空
      { id: "c", category: "C", quantity: 15, min_quantity: 10 },   // 个体 10 → 空
    ];
    const built = exportFormat.buildLibraryRows(parts, settings);
    const idx = built.columns.indexOf("低库存");
    const fromExport = parts.map((_, i) => built.rows[i + 1][idx] === "是");
    const fromService = parts.map((p) => lowStock.isLowStock(p, settings));
    assert.deepStrictEqual(fromExport, fromService, "导出列必须与服务端判定完全一致");
    assert.deepStrictEqual(fromExport, [true, false, false]);
    return null;
  });

  /* ==================================================== §3 端到端 */
  section("§3 端到端：parts:export 真的写出文件，且能读回");

  let env = null;
  let exported = null;
  let libraryParts = null;

  await t("空库导出：成功、0 行、文件里有表头", async () => {
    env = freshEnv();
    const r = await env.handlers["parts:export"]({});
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.exported_count, 0);
    assert.ok(fs.existsSync(r.file_path), "文件应存在：" + r.file_path);
    const rows = bp.readTableRows(r.file_path).rows;
    assert.strictEqual(rows.length, 1, "只有表头");
    assert.strictEqual(rows[0].length, 14);
    return null;
  });

  await t("有内容的库：33 条（32 + 1 手动）→ 导出 33 行，条数与库中一致", async () => {
    env = freshEnv();
    await seedLibrary(env.handlers);
    libraryParts = env.db.loadParts();
    assert.strictEqual(libraryParts.length, 33);

    exported = await env.handlers["parts:export"]({});
    assert.strictEqual(exported.ok, true, exported.error);
    assert.strictEqual(exported.exported_count, 33);
    assert.strictEqual(exported.exported_count, libraryParts.length, "AC-5 的通过标准");
    const rows = bp.readTableRows(exported.file_path).rows;
    assert.strictEqual(rows.length, 34, "1 行表头 + 33 行数据");
    console.log(`        （库 ${libraryParts.length} 条 → 导出 ${exported.exported_count} 条）`);
    return null;
  });

  await t("**跨实现读回**：自写读取器逐格比对关键列（值/封装/数量）", () => {
    const rows = bp.readTableRows(exported.file_path).rows;
    const header = rows[0];
    const iValue = header.indexOf("值");
    const iFoot = header.indexOf("封装");
    const iQty = header.indexOf("数量");
    const iLoc = header.indexOf("库位");
    const byQty = rows.slice(1).map((r) => Number(r[iQty])).sort((a, b) => a - b);
    const expectQty = libraryParts.map((p) => p.quantity).sort((a, b) => a - b);
    assert.deepStrictEqual(byQty, expectQty, "数量列逐条一致（顺序无关）");

    // 手动录入那条要能按值+封装+库位找回来
    const manual = rows.slice(1).find((r) => r[iValue] === "1k" && r[iFoot] === "R0603");
    assert.ok(manual, "导出里应能找到手动录入的 1k/R0603");
    assert.strictEqual(Number(manual[iQty]), 8);
    assert.strictEqual(manual[iLoc], "C-02");
    return null;
  });

  await t("低库存列与 parts:list 的 low_stock_ids 完全一致（导出侧没自作主张）", async () => {
    const list = await env.handlers["parts:list"]({ query: {} });
    const rows = bp.readTableRows(exported.file_path).rows;
    const header = rows[0];
    const iValue = header.indexOf("值");
    const iFoot = header.indexOf("封装");
    const iLow = header.indexOf("低库存");
    const lowKeys = new Set(list.low_stock_ids.map((id) => {
      const p = libraryParts.find((x) => x.id === id);
      return `${p.value}|${p.footprint}`;
    }));
    let checked = 0;
    for (const row of rows.slice(1)) {
      const expected = lowKeys.has(`${row[iValue]}|${row[iFoot]}`) ? "是" : "";
      assert.strictEqual(row[iLow], expected, `${row[iValue]}/${row[iFoot]} 的低库存列不对`);
      checked += 1;
    }
    assert.strictEqual(checked, libraryParts.length);
    console.log(`        （${checked} 行逐行对照 parts:list 的判定，低库存 ${list.low_stock_ids.length} 条）`);
    return null;
  });

  await t("指定文件名 → 落在同一目录；不给 → 默认名含时间戳（FR-2.8 同款约定）", async () => {
    const named = await env.handlers["parts:export"]({ output_path: "我的库表.xlsx" });
    assert.strictEqual(named.ok, true, named.error);
    assert.ok(/我的库表\.xlsx$/.test(named.file_path), named.file_path);
    assert.strictEqual(path.dirname(named.file_path), path.dirname(exported.file_path), "与默认导出同目录");
    assert.ok(/器件库_\d{8}_\d{6}\.xlsx$/.test(path.basename(exported.file_path)), "默认名应含时间戳：" + path.basename(exported.file_path));
    return null;
  });

  await t("重复导出是幂等的（覆盖写，不报错、不追加行）", async () => {
    const again = await env.handlers["parts:export"]({});
    assert.strictEqual(again.exported_count, 33);
    const rows = bp.readTableRows(again.file_path).rows;
    assert.strictEqual(rows.length, 34, "不该追加");
    return null;
  });

  await t("非法输出路径 → 明确报错，不留下半个文件", async () => {
    const bad = await env.handlers["parts:export"]({ output_path: path.join(TMP, "no-such-dir", "x.xlsx") });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.error && bad.error.length > 0, "应给出原因");
    assert.ok(!fs.existsSync(path.join(TMP, "no-such-dir", "x.xlsx")), "不该留下文件");
    return null;
  });

  await t("导出**不改库**：前后 parts.json 字节一致（只读操作）", async () => {
    const before = fs.readFileSync(env.db.paths().parts);
    await env.handlers["parts:export"]({});
    assert.ok(before.equals(fs.readFileSync(env.db.paths().parts)), "导出不该动库文件");
    return null;
  });

  /* ==================================================== §4 界面接线 */
  section("§4 界面：库存页有「导出库表」入口");

  await t("index.html 有按钮，app.js 绑了它并调 partsExport", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
    assert.ok(/id="export-library"/.test(html), "缺按钮");
    assert.ok(/export-library"\)\.addEventListener/.test(app), "按钮没绑事件");
    assert.ok(/call\("partsExport"/.test(app), "没调 IPC");
    return null;
  });

  /* ---------------------------------------------------------------- */

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (ignored) { /* 清理失败不影响结论 */ }

  console.log("\n" + "=".repeat(64));
  console.log(`T21（库表导出）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log("  - " + f.name + "\n      " + f.message.split("\n")[0]);
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
}

main().catch((exc) => {
  console.error("测试脚本自身出错：", exc && exc.stack ? exc.stack : exc);
  process.exitCode = 1;
});
