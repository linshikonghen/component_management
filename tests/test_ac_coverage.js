"use strict";
/**
 * test_ac_coverage.js — T28：**AC 覆盖率审计**
 *
 * 运行： node tests/test_ac_coverage.js
 *
 * 解决的问题：spec 里的 AC-1~AC-9 一共 60+ 行验收标准，"到底验全了没有"此前只能靠我的印象。
 * 这个套件把**每一行**都映射到一个具体测试件（或明确标成"只能人工验"/"被 spec 冲突卡住"），
 * 并机器断言：
 *
 *   ① **没有一行是没主的**——spec 里新增/改动了 AC 行而没人映射 → 直接红；
 *   ② **没有陈旧的映射**——映射表里指向不存在的行 → 直接红；
 *   ③ **映射指向的测试文件必须真实存在** → 防止"写了 by 却没这个文件"；
 *   ④ **漂移检测**——每条映射带一个 `must` 关键词，必须仍出现在该行原文里；
 *      若 spec 把那行改了（比如把"套数填 3"改成别的），关键词对不上 → 红，逼人重新看一遍映射。
 *
 * 状态含义（不含糊）：
 *   auto     有自动化断言覆盖（在无头环境可复现）
 *   partial  自动化覆盖了一部分，另一半只能人工（例如"断网"要真断、"双击"要真桌面）
 *   manual   只能人工验（本环境做不到）
 *   conflict 被 spec 自身的矛盾卡住，需用户裁决（映射里给出任务号）
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SPEC = path.join(ROOT, "docs", "spec.md");
const TESTS_DIR = __dirname;

/** 每条：by=覆盖它的测试件（可多个，用 + 连接）/ status / must=该行原文里必须仍出现的片段 */
const COVERAGE = {
  /* ------------------------------------------------ AC-1 BOM 导入入库（17 行） */
  "AC-1:1": { by: "test_bom_parser.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "套数填" },
  "AC-1:2": { by: "test_import_model.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "10uF" },
  "AC-1:3": { by: "test_import_gate.js + test_ipc_handlers.js", status: "auto", must: "绕过核对直接入库" },
  "AC-1:4": { by: "test_import_gate.js + test_renderer_pages.js", status: "auto", must: "24 改成 10" },
  "AC-1:5": { by: "test_import_gate.js", status: "auto", must: "原应入库量 24" },
  "AC-1:6": { by: "test_import_model.js + test_acceptance_full.js", status: "auto", must: "试改 值/封装/耐压/材质/容差/型号/厂商/库位/阈值/备注" },
  "AC-1:7": { by: "test_import_model.js", status: "auto", must: "BOM 原数量、位号" },
  "AC-1:8": { by: "test_import_model.js", status: "auto", must: "abc" },
  "AC-1:9": { by: "test_import_gate.js", status: "auto", must: "视同跳过并提示" },
  "AC-1:10": { by: "test_acceptance_full.js", status: "auto", must: "不点确认" },
  "AC-1:11": { by: "test_bom_parser.js", status: "auto", must: "空文件" },
  "AC-1:12": { by: "test_bom_parser.js + test_acceptance_full.js", status: "auto", must: "非 BOM 格式" },
  "AC-1:13": { by: "test_inventory.js", status: "auto", must: "连续两次导入同一 BOM" },
  "AC-1:14": { by: "test_import_gate.js", status: "auto", must: "跳过 2 条" },
  "AC-1:15": { by: "test_import_gate.js + test_renderer_pages.js", status: "auto", must: "三数之和 = 条目总数" },
  "AC-1:16": { by: "test_import_gate.js + test_import_model.js + test_renderer_pages.js", status: "auto", must: "位号只有 6 个" },
  "AC-1:17": { by: "test_import_gate.js", status: "auto", must: "全部条目都被跳过" },

  /* ------------------------------------------------ AC-2 BOM 比对（10 行） */
  "AC-2:1": { by: "test_compare_model.js", status: "auto", must: "两个独立入口" },
  "AC-2:2": { by: "test_compare.js", status: "auto", must: "前 5 条" },
  "AC-2:3": { by: "test_compare.js", status: "auto", must: "只存 3 个" },
  "AC-2:4": { by: "test_export_format.js + test_compare.js", status: "auto", must: "数量列为 21" },
  "AC-2:5": { by: "test_compare.js", status: "auto", must: "库中无该条" },
  "AC-2:6": { by: "test_compare.js + test_acceptance_full.js", status: "auto", must: "字节级无变化" },
  "AC-2:7": { by: "test_compare.js", status: "auto", must: "无新增变动记录" },
  "AC-2:8": { by: "test_compare.js + test_acceptance_full.js", status: "auto", must: "比对时库为空" },
  "AC-2:9": { by: "test_compare_model.js + test_compare.js", status: "auto", must: "无需采购" },
  "AC-2:10": { by: "test_compare_model.js + test_ids.js", status: "auto", must: "含时间戳" },
  // v2.2（用户 2026-10-17 需求）：缺料人工匹配 / 疑似中转 / 字段同步（预览闸门与拒绝伪造各一行）
  "AC-2:11": { by: "test_compare.js + test_ipc_handlers.js + test_renderer_pages.js", status: "auto", must: "按被匹配器件库存" },
  "AC-2:12": { by: "test_compare.js + test_renderer_pages.js", status: "auto", must: "保留两个确认按钮" },
  "AC-2:13": { by: "test_ipc_handlers.js + test_renderer_pages.js", status: "auto", must: "movements 新增 1 条" },
  "AC-2:14": { by: "test_ipc_handlers.js", status: "auto", must: "一个字节都不变" },
  "AC-2:15": { by: "test_compare.js + test_ipc_handlers.js", status: "auto", must: "服务端也拒绝" },

  /* ------------------------------------------------ AC-3 手动录入（5 行） */
  "AC-3:1": { by: "test_parts.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "直接手动录入 1 条" },
  "AC-3:2": { by: "test_parts.js", status: "auto", must: "同规格料" },
  "AC-3:3": { by: "test_parts_model.js + test_renderer_pages.js", status: "auto", must: "连续录入" },
  "AC-3:4": { by: "test_parts.js", status: "auto", must: "设低库存阈值" },
  "AC-3:5": { by: "test_parts.js + test_acceptance_full.js", status: "auto", must: "留空提交" },

  /* ------------------------------------------------ AC-4 低库存提示（5 行） */
  "AC-4:1": { by: "test_low_stock.js", status: "auto", must: "当前数量 5" },
  "AC-4:2": { by: "test_settings_model.js", status: "partial", must: "重启应用", note: "启动汇总提示的逻辑已测；真「重启」需在桌面上验" },
  "AC-4:3": { by: "test_low_stock.js + test_acceptance_full.js", status: "auto", must: "入库补到 20" },
  "AC-4:4": { by: "test_low_stock.js", status: "auto", must: "阈值留空", note: "用户 2026-10-17 裁定：**FR-4.8 为准**（留空 = 继承分类默认；要「不提示」请显式填 0）。spec 的 AC-4 该行已在 v1.6 统一为「继承分类默认」，实现与测试一致（test_low_stock.js：个体留空→继承 / 显式 0→永不提示）" },
  "AC-4:5": { by: "test_inventory.js", status: "auto", must: "做一次入库" },

  /* ------------------------------------------------ AC-5 查询（6 行） */
  "AC-5:1": { by: "test_parts.js + test_nfr.js", status: "auto", must: "列标题排序" },
  "AC-5:2": { by: "test_parts.js + test_nfr.js + test_part_search.js", status: "auto", must: "100nF", note: "v2.8 起检索带「相似产品」：100nF 也会带出 0.1uF（值归一相同），界面标「相似」" },
  "AC-5:3": { by: "test_parts.js + test_nfr.js + test_part_search.js + test_renderer_pages.js", status: "auto", must: "C0603", note: "v2.8 起分类/封装/耐压筛选在库存页可用（下拉由 facets 填充；改筛选即重查）" },
  "AC-5:4": { by: "test_parts.js + test_acceptance_full.js", status: "auto", must: "打开某器件详情" },
  "AC-5:5": { by: "test_parts_export.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "导出当前库" },
  "AC-5:6": { by: "test_parts.js + test_part_search.js + test_renderer_pages.js", status: "auto", must: "搜索不存在的关键字", note: "v2.8：无结果时提示可比对写法（0.1uF/100nF、4K7/4.7kΩ 视为同一个值），不误报" },

  /* ------------------------------------------------ AC-6 应用形态（6 行） */
  "AC-6:1": { by: "test_acceptance_full.js + test_nfr.js", status: "partial", must: "断开网络", note: "离线三道保障已审计（源码无请求/CSP connect-src none/运行时拦截）+ 全流程在无网沙箱跑通；真「断网」仍建议在桌面复跑一次" },
  "AC-6:2": { by: "需真桌面", status: "manual", must: "双击启动", note: "本沙箱起不了 Electron（已归因：最小 Electron 应用同样 0x80000003）" },
  "AC-6:3": { by: "test_shortcut.js", status: "partial", must: "桌面快捷方式", note: "快捷方式真建 + COM 读回校验已完成（T19）；「双击」动作需人工" },
  "AC-6:4": { by: "test_store.js + test_backup_model.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "备份后改数据" },
  "AC-6:5": { by: "test_store.js", status: "auto", must: "关闭再打开" },
  "AC-6:6": { by: "需真桌面", status: "manual", must: "被其他程序占用", note: "需用真实文件锁（Excel 打开 data 文件）模拟，无头环境造不出可靠的占用" },

  /* ------------------------------------------------ AC-7 出库/领用（7 行） */
  "AC-7:1": { by: "test_stock_model.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "出库 5 个" },
  "AC-7:2": { by: "test_stock_model.js", status: "auto", must: "尝试出库 10" },
  "AC-7:3": { by: "test_stock_model.js", status: "auto", must: "BOM 需 24 个，库存 20" },
  "AC-7:4": { by: "test_stock_model.js", status: "auto", must: "未入库条目" },
  "AC-7:5": { by: "test_stock_model.js + test_acceptance_full.js", status: "auto", must: "同一批次" },
  "AC-7:6": { by: "test_compare_model.js + test_stock_model.js", status: "auto", must: "领料/出库" },
  "AC-7:7": { by: "test_compare_model.js + test_stock_model.js", status: "auto", must: "试图从比对页触发领料" },

  /* ------------------------------------------------ AC-8 立创可识别导出（6 行） */
  "AC-8:1": { by: "test_export_format.js", status: "auto", must: "打开逐列检查" },
  "AC-8:2": { by: "test_export_format.js", status: "auto", must: "分隔符" },
  "AC-8:3": { by: "test_export_format.js", status: "auto", must: "参数" },
  "AC-8:4": { by: "test_exporter_roundtrip.js + test_acceptance_full.js", status: "auto", must: "自己的读取器读回" },
  "AC-8:5": { by: "需用户上传", status: "manual", must: "实际上传立创商城", note: "工具完全离线、没有任何上传通道（设计如此）；样本已备好 .addmodel/upload/T4-lcsc-sample.xlsx" },
  "AC-8:6": { by: "test_export_format.js", status: "auto", must: "无立创编号" },

  /* ------------------------------------------------ AC-9 分类与阈值（5 行） */
/* ------------------------------------------- AC-10 按对账单入库（6 行） */
  "AC-10:1": { by: "test_lcsc_statement.js", status: "auto", must: "真实样本 8 条" },
  "AC-10:2": { by: "test_statement_match.js", status: "auto", must: "品牌与立创 C 编码不同也照样命中" },
  "AC-10:3": { by: "test_statement_commit.js + test_ipc_handlers.js", status: "auto", must: "必须有决定才动" },
  "AC-10:4": { by: "test_statement_commit.js", status: "auto", must: "只补空、不覆盖" },
  "AC-10:5": { by: "test_statement_commit.js", status: "auto", must: "订单号、对账单行号" },
  "AC-10:6": { by: "test_lcsc_statement.js", status: "auto", must: "绝不猜哪列是数量" },
  "AC-10:7": { by: "test_statement_model.js + test_statement_page.js", status: "auto", must: "核对表里「本次入库量/值/容差/耐压/封装/商品型号」可改" },
  "AC-9:1": { by: "test_store.js + test_settings_model.js + test_acceptance_full.js", status: "auto", must: "首次启动" },
  "AC-9:2": { by: "test_settings_model.js + test_acceptance_full.js + test_renderer_pages.js", status: "auto", must: "从 20 改为 30" },
  "AC-9:3": { by: "test_low_stock.js", status: "auto", must: "分类默认 20，库存 15" },
  "AC-9:4": { by: "test_low_stock.js + test_acceptance_full.js", status: "auto", must: "个体阈值 10" },
  "AC-9:5": { by: "test_store.js + test_settings_model.js", status: "auto", must: "非数字" },
  "AC-9:6": { by: "test_categories.js", status: "auto", must: "一律存**立创中文名**" },
  "AC-9:7": { by: "test_categories.js", status: "auto", must: "只在 `src/services/categories.js`" },
  "AC-9:8": { by: "test_statement_threshold_key.js", status: "auto", must: "排母→H、MOSFET→Q、开关→KEY" },
  "AC-9:9": { by: "test_category_guard_server.js", status: "auto", must: "乱输**拒绝并明确报错**" }
};

/* ------------------------------------------------------------ 解析 spec */

/**
 * 把 spec 的 AC 段落解析成行。
 * **段落边界是「任何 2~3 级标题」**，不是"下一个 AC 标题"——
 * AC-9 之后紧跟的是 `## 8. 界面与导航`、`## 附录` 等章节，只认 AC 标题会把那些表也算进 AC-9
 * （我第一版就错了两次：先按下一个 AC 标题切，再只认 `###`，都漏了 `##`）。
 */
function parseAcRows() {
  const text = fs.readFileSync(SPEC, "utf8");
  const lines = text.split(/\r?\n/);
  const rows = [];
  let current = null;
  let index = 0;
  for (const line of lines) {
    const heading = /^###\s+(AC-\d+)\b/.exec(line);
    if (/^#{2,3}\s/.test(line) && !heading) { current = null; index = 0; continue; }
    if (heading) { current = heading[1]; index = 0; continue; }
    if (!current || !line.startsWith("|")) continue;
    const cols = line.split("|").map((s) => s.trim()).filter((s) => s !== "");
    if (cols.length < 3) continue;
    if (cols[0] === "需求" || /^[-:\s]+$/.test(cols[0])) continue;
    index += 1;
    rows.push({ key: `${current}:${index}`, ac: current, raw: cols.join(" "), demand: cols[0], verify: cols[1] });
  }
  return rows;
}

const rows = parseAcRows();
const results = [];
const failures = [];

function check(kind, ok, message) {
  results.push({ kind, ok, message });
  if (!ok) failures.push(message);
}

/* ------------------------------------------------------------ 审计 */

console.log("T28 AC 覆盖率审计 —— spec 的每一行验收标准都要有主\n");

check("解析", rows.length > 0, "没有从 spec 解析到任何 AC 行（解析逻辑坏了）");
check("解析", rows.length >= 60, `解析到 ${rows.length} 行 AC，明显偏少（应为 60+）`);

// ① 每一行 spec 都有映射
const unmapped = rows.filter((r) => !COVERAGE[r.key]);
check("完整性", unmapped.length === 0,
  `spec 里这些 AC 行没有映射：${unmapped.map((r) => `${r.key}（${r.demand}：${r.verify}）`).join("；")}`);

// ② 没有陈旧映射
const stale = Object.keys(COVERAGE).filter((key) => !rows.some((r) => r.key === key));
check("完整性", stale.length === 0, `映射表里有 ${stale.length} 条指向不存在的行：${stale.join(", ")}`);

// ③ 映射里的测试文件必须真实存在；④ must 关键词必须在原文里
for (const row of rows) {
  const entry = COVERAGE[row.key];
  if (!entry) continue;
  for (const token of entry.by.split("+").map((s) => s.trim())) {
    if (!/\.js$/.test(token)) continue; // 非文件名（如"需真桌面"）不查存在性
    // 公开脱敏快照里，依赖公司样例的套件会被移到 tests/local_only/（公开版 run_all 不跑它们）；
    // 覆盖率见证仍应算「存在」，否则公开版会误报。
    const witness = path.join(TESTS_DIR, token);
    const witnessLocalOnly = path.join(TESTS_DIR, "local_only", token);
    check("文件存在", fs.existsSync(witness) || fs.existsSync(witnessLocalOnly),
      `${row.key} 指向的测试件不存在：${token}`);
  }
  if (entry.must) {
    check("漂移检测", row.raw.includes(entry.must),
      `${row.key} 的 must 关键词「${entry.must}」已不在该行原文里（spec 改过这行？请重新核对映射）`);
  }
  if (entry.status === "conflict") {
    check("冲突登记", Boolean(entry.task) && /^T_/.test(entry.task), `${row.key} 标了 conflict 却没给任务号`);
  }
  if (entry.status === "manual" || entry.status === "partial") {
    check("说明", Boolean(entry.note), `${row.key} 标了 ${entry.status} 却没写为什么（不能只标不解释）`);
  }
}

/* ------------------------------------------------------------ 汇总表 */

const byStatus = { auto: 0, partial: 0, manual: 0, conflict: 0 };
for (const row of rows) {
  const entry = COVERAGE[row.key];
  if (entry) byStatus[entry.status] += 1;
}

console.log("行     需求 / 验收方式（截断）                          状态      覆盖它的测试件");
console.log("-".repeat(110));
for (const row of rows) {
  const entry = COVERAGE[row.key] || { status: "未映射", by: "—" };
  const label = `${row.demand}｜${row.verify}`.slice(0, 42).padEnd(44, " ");
  console.log(`${row.key.padEnd(6)} ${label} ${entry.status.padEnd(9)} ${entry.by}`);
  if (entry.note) console.log(`       └ ${entry.note}`);
}

console.log("\n" + "=".repeat(72));
console.log(`AC 行数：${rows.length}　映射：${Object.keys(COVERAGE).length}`);
console.log(`按状态：auto ${byStatus.auto} ｜ partial ${byStatus.partial} ｜ manual ${byStatus.manual} ｜ conflict ${byStatus.conflict}`);
console.log(`其中需要人工完成的：${byStatus.partial} 项部分 + ${byStatus.manual} 项完全人工 = ${byStatus.partial + byStatus.manual} 项`);
console.log(`被 spec 冲突卡住的：${byStatus.conflict} 项${byStatus.conflict ? "（已立任务，等用户裁决）" : ""}`);

const failedChecks = results.filter((r) => !r.ok);
console.log("=".repeat(72));
if (failedChecks.length > 0) {
  console.log(`审计未通过（${failedChecks.length} 条）：`);
  for (const f of failedChecks) console.log(`  - [${f.kind}] ${f.message}`);
  process.exitCode = 1;
} else {
  console.log(`审计通过：${Object.keys(COVERAGE).length} 行 AC 全部有主，且无人为漂移`);
  console.log(`  自动化覆盖 ${byStatus.auto} 行；需人工 ${byStatus.partial + byStatus.manual} 行；待裁决 ${byStatus.conflict} 行`);
}
