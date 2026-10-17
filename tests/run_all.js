"use strict";
/**
 * run_all.js — 一条命令跑完全部测试
 *
 * 运行： node tests/run_all.js        （或 npm test）
 *
 * 为什么用 `stdio: "inherit"` 而不是默认的管道：本机沙箱下，
 * 子进程的管道 stdio 可能因命名管道受限而 EPERM；inherit 让子进程直接写同一个控制台，
 * 既避开该限制，也让输出保持原样（保留每个套件自己的 PASS/FAIL 行）。
 *
 * **v1.5 实现期补记：套件由「逐条登记」改为「扫描目录」。**
 * 原先这里写死一张 SUITES 表，于是每加一个测试套件都要回来改这个文件——
 * 实现期这件事我做了十几次，每次都要改一个与测试内容无关的文件（还改错过一次顺序）。
 * 现在改成扫描 `tests/test_*.js`：**新套件放进去就会被跑到**，不会因为忘记登记而"静默不跑"。
 * 中文显示名放在下面的 SUITE_LABELS 里，**只是显示用**：没登记名字的套件会退回文件名，
 * 照跑不误（漏登记不会导致漏测）。
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/** 显示名（可选）。缺了就用文件名——**不影响是否被执行**。 */
const SUITE_LABELS = {
  "test_bom_parser.js": "T1  解析链（xlsx 读取器 + 列校验）",
  "test_exporter_roundtrip.js": "T2  T13b xlsx 写入器",
  "test_export_format.js": "T4  T13c 导出格式层",
  "test_store.js": "T6  store 存储层",
  "test_compare.js": "T7  compare 比对（只读）",
  "test_inventory.js": "T8  inventory 入库/出库/领料",
  "test_low_stock.js": "T9  low_stock 阈值与低库存",
  "test_parts.js": "T10 parts 手动录入/查询",
  "test_ipc_handlers.js": "T11 IPC 薄层（16 通道）",
  "test_main_wiring.js": "T11 main.js 接线（桩 Electron）",
  "test_import_model.js": "T12 核对表规则（模型）",
  "test_import_gate.js": "T12 导入闸门与端到端",
  "test_compare_model.js": "T13 比对页规则与导出",
  "test_parts_model.js": "T14 录入与详情 UI（模型）",
  "test_stock_model.js": "T16 领料页规则（AC-7）",
  "test_settings_model.js": "T17 设置页规则（AC-4/AC-9）",
  "test_backup_model.js": "T18 备份/恢复页（AC-6）",
  "test_shortcut.js": "T19 快捷方式与图标",
  "test_acceptance_full.js": "T20 离线全流程验收（AC-1~AC-9）",
  "test_parts_export.js": "T21 库表导出（FR-5.5）",
  "test_ids.js": "T25 运行号/时间戳/id（唯一实现）",
  "test_nfr.js": "T27 NFR 实测（性能/健壮性）",
  "test_ac_coverage.js": "T28 AC 覆盖率审计（每行验收都要有主）",
  "test_renderer_pages.js": "T30 页面级 DOM 测试（假 DOM 真跑页面）",
  "test_preload.js": "T34 preload 白名单（不多不少 + 方法↔通道）",
  "test_xlsx_robustness.js": "T35 xlsx 读取器鲁棒性（别的工具的写法）",
  "test_audit_fixes.js": "T36 对抗性审计发现 → 修复回归",
};

/** 扫描 tests/ 下的 test_*.js；按文件名排序，保证每次运行顺序一致 */
function discoverSuites() {
  const dir = __dirname;
  return fs.readdirSync(dir)
    .filter((name) => /^test_.*\.js$/.test(name))
    .sort()
    .map((file) => ({ file, title: SUITE_LABELS[file] || file }));
}

const suites = discoverSuites();
if (suites.length === 0) {
  console.error("没扫到任何测试套件（tests/test_*.js）——这本身就该报错，而不是「0 个套件全部通过」");
  process.exit(1);
}
const unlabeled = suites.filter((s) => !SUITE_LABELS[s.file]).map((s) => s.file);
if (unlabeled.length > 0) {
  console.log(`提示：以下套件没有中文显示名（照常执行，只是名字用文件名）：${unlabeled.join(", ")}`);
}

const results = [];
for (const { title, file } of suites) {
  console.log("\n" + "#".repeat(72));
  console.log(`# ${title}  →  ${file}`);
  console.log("#".repeat(72));
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
  const ms = Date.now() - started;
  results.push({ title, file, code: result.status, ms });
}

console.log("\n" + "=".repeat(72));
console.log("汇总");
console.log("=".repeat(72));
let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? "PASS" : "FAIL";
  if (r.code !== 0) failed += 1;
  console.log(`  ${mark}  ${r.title.padEnd(34, " ")} ${String(r.ms).padStart(6)} ms  (exit ${r.code})`);
}
console.log("=".repeat(72));
console.log(failed === 0
  ? `${results.length} 个套件全部通过（扫描 tests/test_*.js 得到）`
  : `${failed} / ${results.length} 个套件失败`);
process.exitCode = failed === 0 ? 0 : 1;
