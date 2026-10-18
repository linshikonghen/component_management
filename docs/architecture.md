# 架构说明（Application Architecture）

> 本文件是**目录职责、依赖方向与实现约定**的说明，与 `docs/spec.md`（WHAT，验收信源）、
> `docs/plan.md`（HOW，技术方案与 §6 IPC 契约）互补。分层规则不是口号：
> `tests/test_architecture.js` 会**静态检查**下面这些约束，违反即测试红。

## 1. 设计原则（为什么这样分层）

这个应用是**本地离线、零 npm 依赖**的 Electron 桌面程序，按 Node/Electron 主流的进程分离与分层方式组织：
主进程只做“生命周期 + 安全 + 调度”，渲染进程只做“界面”，业务规则集中在可单测的 service 层。
目标是：**规则可测、界面可换、危险操作有唯一入口、契约只有一处定义。**

| 原则 | 落地方式 |
|---|---|
| 进程隔离 | 主进程拥有文件与数据；渲染进程只能通过 `preload` 白名单 IPC 取数据（`nodeIntegration:false` + `contextIsolation:true`） |
| 单一职责 | main / preload / ipc / services / renderer(lib·model·pages) 各司其职，见下表 |
| 单一契约 | IPC 通道名只在 `src/ipc/channels.js` 定义；请求/响应字段以 `plan.md` §6 为准 |
| 反重复 | 小工具只有一份：`src/services/value_util.js`、`renderer/lib/ui_util.js`；页面不许再各写一份 |
| 危险操作闸门 | 删除/恢复/入库/合并等要人工确认（页内弹窗 + 服务端拒绝或确认参数两层） |
| 可验证 | `run_all` 全绿 ≠ 正确：还有 acceptance、架构静态检查、NFR、页面级 DOM 测试 |

## 2. 目录与职责

```
component_management/
├── src/
│   ├── main.js              Electron 主进程入口：窗口、安全策略、单实例、IPC 注册、菜单/生命周期
│   ├── preload.js           contextBridge 白名单：把 channels 暴露成 window.api.<方法>，不暴露 Node
│   ├── ipc/
│   │   ├── channels.js      IPC 通道清单（**契约单一来源**；顺序即注册顺序）
│   │   ├── handlers.js      薄层：收请求 → 调 service → 统一转 {ok,error}；不写业务算法
│   │   └── extensions.js    通道名 → 方法名等转换
│   └── services/            业务逻辑（不依赖 Electron / DOM / 网络，可单测）
│       ├── store.js         原子读写 JSON、备份、数据目录
│       ├── parts.js         器件增删改查、合并闸门、字段校验
│       ├── part_search.js   检索与筛选（命中等级/相似产品/多关键字 AND/排序；见 §4）
│       ├── value_util.js    服务层小工具（str/toInt/isBlank/clone，唯一实现）
│       ├── compare.js       BOM 比对（只读，禁止写库）
│       ├── bom_parser.js / lcsc_statement.js / xls_biff.js / xlsx_xml.js / zip_container.js / table_header.js  解析器
│       ├── statement_match.js / statement_commit.js   对账单匹配与入库（含幂等）
│       ├── inventory.js / low_stock.js / categories.js / spec_parser.js / ids.js / exporter.js / export_format.js
│       └── ...
├── renderer/                渲染进程（纯界面，禁止 require / fs / fetch）
│   ├── index.html           页面骨架 + CSP + 脚本加载顺序
│   ├── app.js               外壳：导航、库存页装配、启动提示
│   ├── lib/                 渲染层基建（先于页面加载）
│   │   ├── ui_util.js       el() / call() / requestGuard() / debounce() 唯一实现
│   │   └── dialog.js        页内确认框（禁用原生 confirm —— 会卡住渲染进程）
│   ├── model/               纯规则（无 DOM、无网络，可在 Node 里单测）
│   └── pages/               页面装配（DOM 只在这里；数据走 IPC；规则调 model）
├── docs/                    spec.md（WHAT）· plan.md（HOW/契约）· architecture.md（本文件）
├── tests/                   单元 / 页面 / 接线 / 验收 / 架构 / NFR
├── tools/                   打包、文档校验、图标、公共快照等脚本（Windows 自带工具 + Python 标准库）
├── assets/                  图标等静态资源
└── data/                    运行时数据（不入库；用户数据）
```

## 3. 依赖方向（只允许自上而下）

```
renderer/pages ──→ renderer/model           （规则）
renderer/pages ──→ renderer/lib/ui_util     （DOM 构造、IPC 调用、守卫、去抖）
renderer/app   ──→ renderer/lib/ui_util + 库存页渲染
      │
      └─ IPC（window.api）→ src/preload.js ──→ src/ipc/channels.js（契约）
                                    │
                                    ▼
                     src/ipc/handlers.js ──→ src/services/*
                                    │              │
                                    │              └─→ src/services/value_util.js
                                    ▼
                                src/services/store.js ──→ data/*.json（原子写）
src/main.js ──→ src/ipc/{channels,handlers} + src/services/store.js（仅生命周期/数据目录）
```

**禁止的依赖**（`tests/test_architecture.js` 静态拦截）：

- `renderer/**` 里出现 `require(` / `fs` / `fetch(` / `XMLHttpRequest`（渲染进程拿不到 Node，也不许联网）
- `renderer/pages/**` 直接摸 `root.api`（必须经 `renderer/lib/ui_util.js::call` 这一条通道）
- 页面里再定义 `el()` / `call()`（唯一实现只允许在 `renderer/lib/ui_util.js`）
- `src/services/**` 依赖 Electron（`require("electron")`）、DOM（`document.`/`window.`）、网络或 `../ipc/*`
- `src/ipc/handlers.js` 直接 require `fs`/`zlib`/`child_process`（解析与落盘都属于 service）
- `src/preload.js` 里硬编码通道名字符串（契约只有 `channels.js` 一处）
- 服务层再各写一份 `str/toInt/isBlank/clone`（唯一实现 `value_util.js`）
- 渲染进程出现 `console.log`（错误日志用 `console.error`，由页面 showError 统一走）

## 4. 检索规范（行业常规）

检索语义**只有一处实现**：`src/services/part_search.js`；库存页与领料页都通过 `parts:list` 的 query 走同一套规则。

### 4.1 命中等级（越靠前越精确）

| 等级 | 含义 | 例子 |
|---|---|---|
| `exact` | 字面命中：跨关键信息字段的子串（FR-5.2） | 搜 `100nF` 命中字面 `100nF` |
| `similar` | **写法不同但同一个值/容差/型号**：值归一、容差归一、封装型号宽松归一 | `0.1uF`↔`100nF`、`4K7`↔`4.7kΩ`、`±1%`↔`+/-1%`、`SOT23`↔`SOT-23` |
| `tokenized` | **多关键字 AND**：空格/逗号/斜杠分隔的每个词都命中同一器件（不是 OR） | `贴片 0603`、`100nF 50V` |
| `all` | 空查询返回全部 | — |

- **多关键字 AND 允许写法差异**：`100nF 50V` 能匹配库里写成 `0.1uF / 50V` 的料，但**不能**匹配 `100nF / 25V`
  （AND 语义优先；这一点有反例测试）。
- **排序**：`exact > similar > tokenized`；同档内「值/型号完全相等 > 前缀命中 > 普通子串」，最后保持库内稳定顺序。
- 界面把 `similar` 命中标出来（行底色 + 行首「相似」+ 悬停说明），`tokenized` 不标相似。

### 4.2 写法归一规则（复用 `spec_parser`）

| 写法差异 | 归一到 | 例 |
|---|---|---|
| 单位前缀 | 标准值 | `0.1uF`→`100nF`、`100µF`→`100uF` |
| EIA 简写 / Ω·R / 大小写 | 标准值 | `4K7`→`4.7kΩ`、`0R`→`0Ω`、`10K`→`10kΩ` |
| 容差写法 | 标准写法 | `+/-1%`→`±1%`、`1%`→`±1%` |
| 全角字符 | 半角 | `１００ｎＦ`→`100nF` |
| 连字符/空格/下划线 | 宽松文本 | `SOT23`↔`SOT-23`、MPN 去连字符 |

### 4.3 筛选与界面约定

- 筛选（FR-5.3）：分类 / 封装 / 耐压 / 只看低库存；**可组合**（AND），改完立即生效。
- 下拉候选由服务端 `facets` 提供（用**全部**器件算，不受当前筛选影响）。
- 检索输入：**200ms 去抖**（NFR-2），**按 Enter 立即检索**（跳过去抖）；`aria-label` 供读屏。
- 结果反馈：结果行说清「显示 N 条 / 库中共 M 条」+ 当前筛选条件 + 相似命中数；无结果时提示可比对写法。
- 空状态区分「库里真没料」与「检索/筛选没匹配」，后者提示清除筛选/换写法。
- 并发保护：搜索/筛选请求带序号（`requestGuard`），**晚到的旧响应不许覆盖新结果**。

## 5. 错误与数据写入约定

- service 抛错 → IPC 层统一 `{ ok: false, error }` → 页面显示；不吞错、不假装成功。
- 写 JSON 一律 `store.js`：同目录临时文件 + `rename` 原子替换；数量变动必须写 `movements.json` 留痕。
- 比对/解析等只读路径禁止写库（`compare.js` 不导入写函数，验收用前后字节快照证明）。
  **唯一例外**（spec FR-2.15）：比对页缺料行「人工匹配」后可选择把 BOM 判定键值同步进被匹配器件，
  走独立通道 `compare:sync_fields`（`confirm !== true` 只预览、零写入；写入时先留 movements 再写 parts）。
  `compare:run` / `compare:export` 本身仍然零写入。
- 危险操作（删除器件、恢复备份、合并同规格、入库）必须有闸门：页内确认 + 服务端拒绝/确认参数两层。

## 6. 测试分层

| 层 | 目录 | 说明 |
|---|---|---|
| 单元（服务/模型） | `tests/test_parts.js`、`test_part_search.js`、`test_value_util.js`… | 无 DOM，直接 require |
| 页面（DOM 装配） | `test_renderer_pages.js`（fake_dom）、`test_statement_page.js` | 真实执行页面脚本，断言可控 DOM |
| 渲染基建 | `test_renderer_util.js` | `el/call/requestGuard/debounce` 的正常与异常路径 |
| 接线（Electron 主进程） | `test_main_wiring.js`、`test_installer_package.js` | 假 Electron / 真脚本 |
| 架构 | `test_architecture.js` | 静态检查分层与“唯一实现”规则 |
| 验收 / AC 覆盖 | `test_acceptance_full.js`、`test_ac_coverage.js` | spec AC 逐行有主 |
| 性能 | `test_nfr.js` | 列表/搜索预算（1000 条库） |

`node tests/run_all.js` 扫描并运行所有套件；发布前还要跑 `test_acceptance_full.js`、`test_ac_coverage.js`、
`tools/verify_spec_docs.py`、`tools/audit_cross_docs.py`、`test_no_markdown_stars.js`。

## 7. 构建与发布（离线、零 npm 依赖）

- 本机运行：`npm start`（或直接调用全局 Electron 的 `electron.exe .`）；`npm run smoke` 走无界面冒烟。
- 打包：`powershell -ExecutionPolicy Bypass -File tools\make_installer.ps1`（lite，目标机需已装 Electron）
  或加 `-WithElectron`（full，自带运行时）。产物为 zip，默认输出到 `%USERPROFILE%\component_management_package`，
  可用 `-OutDir` 指定；`dist/` 是**不入库**的发布产物目录。
- 公共快照：`python tools/make_public_snapshot.py` 生成脱敏、单提交的公开副本。

## 8. 变更流程

任何影响行为/契约的改动：先在协作中枢认领任务 → 改代码 + 补测试/relevant evidence →
`task submit` 带 diff 与证据 → 由**另一位**代理评审通过后才算完成（禁止自审）。
契约字段改名必须先改 `plan.md` §6；`spec.md` 是验收唯一信源，改动需用户确认。

## 9. 参考（行业惯例）

- Electron 进程模型与安全：沙盒/上下文隔离 <https://www.electronjs.org/docs/latest/tutorial/sandbox>、
  安全检查清单 <https://www.electronjs.org/docs/latest/tutorial/security>
- Electron 安全注意事项（第三方整理）<https://quasar.dev/quasar-cli-vite/developing-electron-apps/electron-security-concerns>
- 搜索/筛选/分面（faceted search）的测试模式参考 <https://docs.testchimp.io/guides/patterns/testing-search-filters/>

## 10. 工作区整洁与取证约定（2026-10-17 清理后）

应用代码之外，工作区里还有**协作状态**与**取证产物**。它们不是产品代码，但同样要能追溯；
约定如下（一次性补丁/探针脚本不入库、用完即删，见 `.gitignore`）：

| 位置 | 作用 | 约定 |
|---|---|---|
| `.addmodel/hub.db` | 协作中枢（SQLite：任务/评审/事件/锁） | **不入库**（活状态）。早期任务把整份仓库 diff 内联进 `reviews.diff`；2026-10-17 清理：26 条 >50KB 的 diff 逐字节外置到 `_archive/review-diffs-20261017.tar.gz`，DB 里留指针 + sha256（41.7MB → 5.0MB），任务/评审/事件条数不变 |
| `.addmodel/backups/` | hub 自动轮转备份 | 只留**最近 1 份**（清理前 5 份共 47.9MB → 1 份约 4.8MB） |
| `.addmodel/upload/` | 取证与门禁输出（提交/评审引用的 txt/md/diff/截图） | **保留**，按任务号追溯；一次性 `_*.py` / `_*.js` 脚本**用完即删**；长内容走文件、不入库脚本 |
| `.addmodel/upload/_archive/` | 历史取证归档（gitignore） | 旧任务证据、评审 diff 压缩包、历史交接单；新证据先写 `upload/` 根，不要直接写这里 |
| `.addmodel/upload/saved/` | 需要跨会话交接的脚本/补丁 | 只存"还要再用"的；执行完移入 `_archive/` 并在工作单注明 |
| `data/` | 用户真实数据 | 不入库；删除/合并器件必须用户确认后走正式通道（留变动记录） |
| `backups/`、`dist/`、`.mimocode/` | 本机运行/发布产物、外部工具目录 | 均不入库，可重建 |

**清理原则**：删前先归档（能压缩的压缩），**删摘要不删事实**——每次清理都要能回答
"原来是什么、现在在哪里"。追溯入口：`_archive/` 下的 INDEX 与本表。

## 11. 行业标准合规与已知取舍（2026-10-18 全面审计）

本轮按「先测试 → 全面审计 → 再 git」的顺序做了一次全项目体检，结论与**有意保留的取舍**如下。
**取舍不是遗漏**：每条都写了"为什么这样"，评审时不必再当缺陷提。

### 11.1 合规项（已对齐行业常规）

| 维度 | 现状 |
|---|---|
| 分层与依赖方向 | `renderer → lib/model → IPC → services → store`，`test_architecture.js` 13 条静态规则强制；services 不依赖 Electron/DOM/IPC，renderer 无 require/fetch |
| 进程隔离与安全基线 | `contextIsolation: true` · `nodeIntegration: false` · `webSecurity: true` · `setWindowOpenHandler` 全拒 · `will-navigate` 白名单 · 主进程 `webRequest.onBeforeRequest` 拦截外部请求 · 页面 CSP `default-src 'self'; connect-src 'none'` |
| 契约单一来源 | IPC 通道只在 `src/ipc/channels.js`；preload 由清单生成、不硬编码；请求/响应字段以 `plan.md` §6 为准，`test_ipc_handlers.js` 断言通道集合 == plan §6 |
| 唯一实现（反重复） | 服务层小工具 `value_util.js`、渲染基建 `ui_util.js`、判定键 `compare.dedupeKey`、id/时间戳 `ids.js`、表头识别 `table_header.js`、EXCEL 单元格坐标 `xlsx_xml.js`；均有静态检查或断言 |
| 写入安全 | 一律 `store.js` 原子写（同目录 tmp → fsync → rename）；数量变动必留 `movements`；`persist()` 先 movements 后 parts，失败补偿 |
| 危险操作闸门 | 删除/恢复/改数据目录/同规格合并在**服务端**拒绝（不只靠按钮 disabled），并有页面确认 |
| 测试分层 | 单元（服务/模型）/ 页面级假 DOM / 接线（桩 Electron）/ 架构静态 / 验收（AC 逐行）/ NFR；`run_all` 扫描式发现，漏登记不会漏测 |
| CI | `.github/workflows/ci.yml`：windows-latest 跑全量套件 + 文案星号 + 双文档门禁 + 安装包回归 |
| 依赖 | 零 npm 依赖（`dependencies`/`devDependencies` 均为空，有断言）；xlsx 读写自写（`zip_container` + `xlsx_xml`） |
| 版本与发布 | `package.json` 版本 + `docs/releases.md` 发布事实登记（含资产 SHA256）+ 脱敏公开快照（单提交、自检闸门） |

### 11.2 有意保留的取舍（不是缺陷）

| 取舍 | 为什么这样 |
|---|---|
| `sandbox: false` | preload 需要 `require` 本项目的 `./ipc/channels`（纯数据清单）。渲染进程侧的隔离仍由 `contextIsolation: true` + `nodeIntegration: false` + 不暴露 `ipcRenderer` 保证；若将来把通道清单内联进 preload，可改回 `sandbox: true`（记为改进项，非当前风险） |
| `renderer/model/*` 各自带 `toInt` / `isBlank` | 这些 model 要求**同时**在浏览器（`<script>`）与 Node（`require`）下可加载，且渲染层明文禁止 `require` ⇒ 不能共享 `ui_util` 或服务层 `value_util`。服务层唯一实现仍是 `value_util.js`（有断言）；渲染层的重复是**加载模型的代价**，且每个都是 3 行小函数 |
| 服务层导出面偏宽（约 50 个导出无外部引用） | 这些是"模块内的原语 + 对外只暴露少量入口"的常规模式（如 `part_search` 导出内部规则便于将来单测）。**没有一个是死代码**（审计确认：0 个函数既不被内部调用也无外部引用）；删导出只减 API 面、不减代码，收益低于风险，故保留 |
| 没有 `LICENSE` / `CHANGELOG` / `CONTRIBUTING` | 本项目是**个人自用工具**，非开源协作项目（公开仓库是脱敏快照、无历史）。发布信息集中在 `docs/releases.md`；仓库若将来要开源，补 `LICENSE` 即可（代码与文档不依赖它） |
| `dist/` 保留两代安装包 | `dist/` 已 gitignore、可重建；保留 v1.1.1/v1.1.2 便于对照（约 283MB 磁盘，不影响仓库） |
| 比对只读的**唯一例外** | `compare:sync_fields`（用户 2026-10-17 明确要求：人工匹配后可选把 BOM 判定键值同步回库）。两层闸门：先预览（零写入）→ 显式 `confirm: true` 才写，且强制留 `adjust`（delta=0）变动记录。`compare:run` / `compare:export` 仍字节不变 |

### 11.3 发现的真实问题与处置

| 问题 | 处置 |
|---|---|
| 文档里 4 处**过时数字**（plan 说 24 套件、README 说 AC 78 行、PUBLIC_README 说 35 套件、CI 注释说 15 套件） | 已全部按实测修正（47 套件 / AC 83 行 / 公开版 26 套件） |
| `.addmodel/upload/` 残留 4 个一次性脚本/临时文件（`_probe_manual_match.js`、`_probe_t119.js`、`_commitmsg31.txt`、`_ui_probe_statement.html`） | 已删除（均为 untracked；探针结论已写进 T119 证据文件，不丢事实） |
| `.addmodel/backups/` 留着 2 份 hub 备份 | 只留最新 1 份（旧份删除，约省 4.8MB） |
| 代码无冲突标记、无 `.orig/.rej`、无 UTF-8 损坏、工作树干净 | 审计确认无需处置 |


