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

