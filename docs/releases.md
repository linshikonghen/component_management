# 发布记录

> 这份文件只记**发布事实**（发到哪、发了什么、校验值、已知边界），便于日后核对"线上那份是不是我验过的那份"。

## v1.0.0 — 首个公开版

| 项 | 值 |
|---|---|
| 仓库（公开） | https://github.com/linshikonghen/component_management |
| 发布形式 | 源码快照（**2 个提交，无历史**）+ GitHub Release（两个安装包资产） |
| 发布人 | 用户本人（dsh 无法直接发布：沙箱到 GitHub 的 TLS 不通，`schannel: SEC_E_NO_CREDENTIALS`，匿名只读亦失败；`gh` CLI 未安装） |
| 日期 | 2026-10-16 |

### Release 资产

| 资产 | 大小 | 适用 | SHA256 |
|---|---|---|---|
| `component_management-v1.0.0-win-x64-lite.zip` | 247 KB | 目标机**已装 Electron** | `492F6E707536427A020BB8143D35EB9259C62957D46035EED780471134D2E965` |
| `component_management-v1.0.0-win-x64-full.zip` | 141.4 MB | **内置 Electron 运行时**，目标机无需预装 | `E5176797918AD703268765881E18A03A3AFE9C6A76A5A3D3C578D0F01C8C9D46` |

两个包都由 `tools/make_installer.ps1` 生成（零 npm 依赖，只用 Windows 自带的 `Compress-Archive`）。
载荷已抽查：`install.cmd` / `start.cmd` / `uninstall.cmd` / `README.txt`；完整版另含 `electron\electron.exe`。

### 源码快照：怎么脱敏的

公开仓库**不是**本地开发仓库的历史 ✗（本地仓库含公司 BOM 文件名、本机路径、协作取证 ✗），
而是由 `tools/make_public_snapshot.py` 生成的**单次初始提交快照** ✓：

| 处理 | 说明 |
|---|---|
| 只复制 | `src/ renderer/ docs/ tools/ assets/ tests/` + `package.json` `README.md` `.gitignore` |
| 排除 | `.addmodel/`（协作与取证）、`tests/fixtures/`（真实 BOM）、`dist/`、`data/`、二进制与数据文件 |
| 改名 | 公司 BOM 文件名 → `sample_bom`（33 处）｜对账单样本 → `sample_statement`（9 处） |
| 路径占位 | 本机绝对路径 → `<项目根>`（9 处）／`<协作工具目录>`（7 处）／`<用户目录>`（1 处） |
| **自检闸门** | 快照里若仍含真实 BOM 文件名、真实对账单样本名、本机用户名、本机绝对路径任一字样 → **脚本直接失败退出**，不放行 ✓ |
| 历史 | **2 个提交**（初始快照 + 项目介绍与使用说明）→ 无历史可泄 ✓ |
| 校验 | 索引与**全部提交历史**里 `.addmodel` 计数 = **0** ✓ ｜ 敏感项 **0** ✓ ｜ 文件 **93** 个 ✓ |

> 踩过的坑：在快照里跑验收时，验收套件按设计会生成 `.addmodel/upload/T20-acceptance-report.md`，
> 它被创建在快照内并被收进提交 ✗ → 已删除该文件、`--amend` 改写提交、并在快照 `.gitignore` 里加 `.addmodel/` ✓。

### 公开版测试

| 类别 | 数量 | 说明 |
|---|---|---|
| 公开可跑且全绿 | **15** 个套件 | 不依赖公司样本的部分 |
| 本地专属 | **20** 个套件（`tests/local_only/`） | 依赖公司 BOM / 对账单样本，公开版不含样本，故移出并在此说明 |

### 已知边界（诚实交代）

1. 安装包**未签名** → 可能触发 SmartScreen「未知发布者」，选"仍要运行"即可。
2. 安装为**纯文件安装**（不写注册表）；卸载会**先把 `data\` 搬出来再删程序**，不丢库 ✓。
3. **完整版（`-WithElectron`）路径的自动化断言**：最初只覆盖 lite 路径 ✗；
   现已补齐（`tests/test_installer_package.js` 末条用例，**默认跳过、按需开启**）：
   ```powershell
   $env:CM_FULL_PKG='1'; node tests/test_installer_package.js   # 约 16 秒 / 350 MB
   ```
   断言：生成 1 个 zip 且 > 50 MB ｜ 载荷含 `electron\electron.exe` ｜ 打包进去的 Electron
   **文件数与源目录逐一计数一致** ｜ 四个脚本齐全 ｜ `start.cmd` 优先用包内 `electron.exe` ｜ 载荷 `data` 为空。
   实跑：默认模式 10/10（并明确打印跳过原因）、开启模式 10/10（真构建一次）。
4. 真机安装验证由用户完成（dsh 环境无法启动 Electron）。
5. 本记录是发布事实的**唯一登记处**；下次发版请在其下方追加新条目，不要改旧条目。

---

## v1.1.0 — 检索/筛选/相似产品 · 首轮功能增强版

| 项 | 值 |
|---|---|
| 仓库（公开） | https://github.com/linshikonghen/component_management |
| 发布形式 | 源码快照（在 v1.0.0 公开历史之上**新增 1 个 release 提交**）+ GitHub Release（两个安装包资产） |
| 发布人 | 用户本人（dsh 沙箱到 GitHub 的网络/TLS 不通，无法直接推送；推送命令见任务证据 T116） |
| 日期 | 2026-10-17 |

### 本版更新（相对 v1.0.0）

- **检索与筛选**：库存页/领料页都能按 值/型号/封装/库位 搜索，并支持分类、封装、耐压、只看低库存筛选。
  检索带**相似产品**能力：`0.1uF`↔`100nF`、`4K7`↔`4.7kΩ`、`±1%`↔`+/-1%`、全角 `１００ｎＦ`、`SOT23`↔`SOT-23`
  视为同一种写法；多关键字是 **AND**（每个词都要命中同一器件），结果按"越精确越靠前"排序；搜索框按 Enter 立即检索。
- **领料动线**：库存页行内「领料」直达领料页并预选该器件；出/入库后保留检索/筛选状态；领料页有「清除检索/筛选」。
- **对账单入库体验**：解析提示收进折叠区（不再顶动表格）；疑似行写清"对账单这一行 vs 库里候选"；
  裁决后就地反馈并可改选；重复提交有幂等闸门。
- **稳定性**：单实例（防多开）；检索请求竞态防护（晚到旧响应不覆盖新结果）；入库/删除/恢复等危险操作防重入。
- **工程**：新增 `docs/architecture.md`（分层/依赖规则/检索规范/测试分层/打包流程）+ `tests/test_architecture.js`
  13 条强制规则；渲染层 `ui_util.js`、服务层 `value_util.js` 收敛为唯一实现（去重 8 份 el / 7 份 call / 多份小工具）。
- **界面细节**：表格列截断、空状态区分"没匹配 vs 库里没料"、解析提示布局等本次一并修复。

### Release 资产

| 资产 | 大小 | 适用 | SHA256 |
|---|---|---|---|
| `component_management-v1.1.0-win-x64-lite.zip` | 332 KB | 目标机**已装 Electron** | `DE527730FC5288F93D89917E15A5DB00707370DB32C3F872F037E9EF4C05DF61` |
| `component_management-v1.1.0-win-x64-full.zip` | 141.5 MB | **内置 Electron 运行时**，目标机无需预装 | `FB779EC85967C7BA545A78CDB8C73107F4177D4F3ADBB5BC2CDB7E0F19B7E6ED` |

两个包都由 `tools/make_installer.ps1` 生成（零 npm 依赖，只用 Windows 自带 `Compress-Archive`）；
`package.json` 版本已更新为 `1.1.0`。升级无需迁移数据（三个 JSON 的 `schema_version` 未变）。

### 源码快照（公开仓内容）

| 项 | 值 |
|---|---|
| 生成方式 | `python tools/make_public_snapshot.py`（脱敏 + 单次初始提交，可重跑） |
| 复制 | 117 个文件（`src/ renderer/ docs/ tools/ assets/ tests/` + `package.json` `README.md` `.gitignore`） |
| 本地专属套件 | **21 个**（依赖公司 BOM / 对账单样例，`tests/fixtures/` 已排除）→ 移到 `tests/local_only/`；公开版 `run_all` 只扫 `tests/*.js`（不递归），不会跑 |
| 公开版测试 | **26 个套件全部通过**（在快照目录实跑 `node tests/run_all.js` 验证） |
| 脱敏自检 | **0 处**公司 BOM 名 / 真实对账单名 / 本机用户名 / 本机绝对路径 |
| 历史 | 快照本地为单提交；推送时基于公开仓线上最新提交**新增 1 个 release 提交**（保留线上历史与 README） |

### 已知边界（诚实交代，与 v1.0.0 相同）

1. 安装包**未签名** → 可能触发 SmartScreen「未知发布者」，点「仍要运行」即可。
2. 安装是**纯文件安装**（不写注册表）；卸载会**先把 `data\` 搬出来再删程序**，不丢库。
3. 完整版（`-WithElectron`）路径的自动化断言默认跳过，需 `CM_FULL_PKG=1` 才真构建验证；
   本次已实跑 full 打包并校验包内 `electron\electron.exe` 与脚本齐全。
4. 真机安装验证由用户完成（dsh 环境无法启动 Electron GUI）。
5. 本记录是发布事实的唯一登记处；下次发版请在**下方追加**新条目，不改旧条目。

---

## v1.1.1 — 修复「BOM 比对全部误判缺料」

| 项 | 值 |
|---|---|
| 仓库（公开） | https://github.com/linshikonghen/component_management |
| 发布形式 | 源码快照（单提交，强制替换线上 main）+ GitHub Release（两个安装包资产） |
| 发布人 | 用户本人（dsh 沙箱到 GitHub 网络不通；推送/上传命令由 dsh 给出） |
| 日期 | 2026-10-17 |
| 触发 | 用户实测：`sample_bom` · 套数 1，耗材都已入库，但比对 **33 行全部判缺料** |

### 根因

比对只按「值+封装+耐压+材质+容差」五元组**字面**匹配，而两边来源不同、写法不同：

1. **封装写法不同**：BOM 来自立创 EDA（`R0603`、`C1210`、`SOT-23_L2.9-…`、`TQFN-16_L3.0-…-EP1.1`），
   库是从立创对账单入库（`0603`、`1210`、`SOT-23`、`TQFN-16-EP(3x3)`）→ 判定键永远对不上。
2. **BOM 值为空的行没有按「值=型号」参与判定**（MOS/连接器/开关/三极管等），库里这些料的值是型号。
3. 判定键对不上时没有利用两边都有的**型号(MPN)** 建立关联。

### 修复（`src/services/compare.js`，比对与按 BOM 领料共用）

- 封装归一：`_` 后缀/括号尺寸/`-EP` 不参与判定；贴片被动件 `R/C/L/D/F` 前缀去掉（`R0603`↔`0603`、`F1812`↔`1812`）；
  `SOT-23_L…`↔`SOT-23`、`TQFN-16_L…`↔`TQFN-16-EP(3x3)` 等可对上。
- 容差归一：`±1%` ↔ `+/-1%` ↔ `1%`。
- 值留空 → 按 v2.5 规则用**型号**兜底（值=型号）。
- 匹配优先级：判定键 `exact` → **型号 `mpn`**（两边显式"值"冲突时不硬配）→ 键字段缺失的 `partial`（疑似）→ `none`（缺料）。
- `inventory.pickByBom` 复用同一套索引/匹配：比对说够用的料，按 BOM 领料不会再报"库里没有"。
- 比对页显示「其中 N 条是按型号匹配」，让用户知道依据（只读比对，不改库）。
- 文档：`plan.md` §3.1 补封装/容差归一规则、§6 `compare:run` 补 v2.11 匹配优先级与 `match_reason` 值域（`exact/mpn/partial/none`）；spec 未改。

### 验证

- **真实数据复验**（真实 36 条库存 + 33 行 BOM，套数 1）：
  修复前 `shortfall 33 / enough 0` → 修复后 **`enough 26 / shortfall 5 / uncertain 2`**；
  5 条缺料经人工核对确属库中没有（HX-PH2.0-6P、90kΩ、XT60、PH2.0-2P、1.25T-2P），
  2 条疑似分别是「BOM 缺容差的 10kΩ」与「同封装候选（BZT52C12 vs 库里 ZMM10V）」，交人工裁决。
- **只读**：比对前后 `data/parts.json / movements.json / settings.json` SHA256 逐字节一致。
- 47 个测试套件全部通过（其中 compare 新增 7 条跨来源回归、inventory 新增 1 条跨来源领料、比对页新增 1 条提示）；
  验收 PASS 45 FAIL 0 待人工 0；AC 78 行有主无漂移；双文档门禁 PASS。

### Release 资产

| 资产 | 大小 | 适用 | SHA256 |
|---|---|---|---|
| `component_management-v1.1.1-win-x64-lite.zip` | 338 KB | 目标机**已装 Electron** | `6799BF26B2C20706DF535B1AAEAD1E924839D4446E86B4AFC485194C1671E38F` |
| `component_management-v1.1.1-win-x64-full.zip` | 141.5 MB | **内置 Electron 运行时**，目标机无需预装 | `6DDBA0452AB461BD878DB76A00443F7469DFCF6D5CCA5EE441CA60BEF74556EA` |

> 升级提示：`install.cmd` 会先删除目标目录（数据在目标目录的 `data\` 下），
> **升级前先用应用内「备份」或手动复制 `data\`**；或直接用新版绿色运行（把旧 `data\` 复制到新文件夹）。

### 已知边界

同 v1.0.0 / v1.1.0（安装包未签名、纯文件安装、卸载保留 data、真机安装由用户验证）。
本记录是发布事实的唯一登记处；下次发版在下方追加，不改旧条目。

## v1.1.2 — 比对「疑似」行给出确认键 + 标清库里候选

| 项 | 值 |
|---|---|
| 仓库（公开） | https://github.com/linshikonghen/component_management |
| 发布形式 | 源码快照（单提交，强制替换线上 main）+ GitHub Release（两个安装包资产） |
| 发布人 | 用户本人（dsh 沙箱到 GitHub 网络不通；推送/上传命令由 dsh 给出） |
| 日期 | 2026-10-17 |
| 触发 | 用户实测：比对结果里「疑似」只写"需人工确认"，但**没给确认键、也没说清疑似的是哪条候选** |

### 变更

- 服务层新增 `compare.applyRulings(result, rulings)`（**唯一实现**，比对仍只读）：
  `same` → 确认同一颗，按候选库存算 `缺口 = max(0, 需求 − 候选库存)`；`different` → 不是同一颗，进缺料（库存 0、缺口 = 需求）；
  未裁决/非法值留在疑似；`rulings` 非对象 → `{ok:false, error}`。
- 疑似行带**候选身份快照** `candidate_*`（值/封装/耐压/材质/容差/型号/供应商编号；每条 CompareItem 字段统一，无候选为空串）。
- `compare:run` 接收 `rulings`，缓存裁决后的结果；`compare:export` 因此导出**界面所见**的分组。比对只读不变：
  裁决/导出前后 `data/` 三个文件逐字节一致（真实库副本探针验证）。
- 结果页：疑似组新增「库里候选」列；三组新增「处置」列——疑似行给两个完整句子确认键
  **「是同一颗（按库存算）」/「不是同一颗（算缺料）」**，已确认行显示「已确认：同一颗 / 不是同一颗」+「改判」；
  已确认条数提示；`state.busy` 防重入（连点只发一次请求，晚到旧结果不覆盖新裁决）。
- 契约：`plan.md` §6.2 补 `compare:run.rulings`、`CompareItem.candidate_*`、`confirmed_by_human`、
  `match_reason` 枚举（v2.12）；spec 未改（FR-2.3 本来就要求「疑似需人工确认」）。
- 测试：服务规则 4 条（same/different/统计与非法值/候选快照）+ 模型文案 1 条 + IPC 端到端 1 条
  （含 parts.json 字节不变、导出条数=界面缺料条数）+ 页面 4 条（确认键全流程、未选文件报错、
  非法 rulings、后端报错可重试、连点防重入）。
- 开发仓库整理（不影响公开功能）：协作状态库瘦身（41.7MB→5.0MB，历史大 diff 外置归档）、
  删除 107 个一次性补丁/探针脚本、README/architecture 文档同步。

### 验证

- 开发仓库：47 个套件全绿；验收 **PASS 45 · FAIL 0 · 待人工 0**；AC 78 行全部有主、0 漂移；双文档门禁 PASS。
- 只读：真实库副本 + 真实 BOM 探针——裁决与导出前后 `parts/movements/settings` 三个文件 SHA256 一致；
  same→该行进够用、different→进缺料（库存 0/缺口=需求）；裁决后导出条数 = 界面缺料条数。
- 公开快照：单提交（无历史）、发布工具自检 0 处公司/本机字样；公开版 **26/26 个套件全绿**；
  安装包载荷抽检：install/start/uninstall/README.txt/icon 齐全，full 版含 `electron\electron.exe`，package.json version = 1.1.2。

### Release 资产

| 资产 | 大小 | 适用 | SHA256 |
|---|---|---|---|
| `component_management-v1.1.2-win-x64-lite.zip` | 345 KB | 目标机**已装 Electron** | `B8E87E99DF67E5FAA54A40B8536BF91BA24CE98F714A1A21F3D99EBB40CB3C5A` |
| `component_management-v1.1.2-win-x64-full.zip` | 141.5 MB | **内置 Electron 运行时**，目标机无需预装 | `B2BB54DB0DADE22200AADB4AF6CD14ED6617DF1623974E58FECE5FD761B00312` |

> 升级提示：`install.cmd` 会先删除目标目录（数据在目标目录的 `data\` 下），
> **升级前先用应用内「备份」或手动复制 `data\`**；或直接用新版绿色运行（把旧 `data\` 复制到新文件夹）。

### 已知边界

同 v1.0.0 / v1.1.0 / v1.1.1（安装包未签名、纯文件安装、卸载保留 data、真机安装由用户验证）。
本记录是发布事实的唯一登记处；下次发版在下方追加，不改旧条目。

