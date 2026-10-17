# 元器件管理 — 实现方案

> 版本：**v2.1**（与 spec 同步：核心承诺修订为「默认完全离线 + 云同步显式可选」；多仓库/云同步的契约（§6 新增通道、§4 `warehouses[]`、`cloud_client` 唯一出口）随实现同时写入，设计依据见 `docs/v2.0-更新提案.md`）
> 日期：2026-10-16（v1.6；初稿 2026-10-15）
> 配套：`spec.md`（WHAT，验收唯一信源）
> 定位：本文是实现的技术约束，**技术决策集中于此**

---

## 1. 技术栈选型

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Electron**（本机已装 42.5.0，`electron.exe` 实测可跑） | 用户选定；独立窗口 + 桌面快捷方式 |
| 主进程 | Node.js（Electron 内置，本机 v24.17.0） | 文件读写、xlsx 解析 |
| 渲染进程 | 原生 HTML/CSS/JS（**不引入前端框架**） | 界面不复杂；避免构建链，保证离线可跑 |
| 数据存储 | **JSON 文件** | 见 §1.1 决策 |
| xlsx 解析 | **自写零依赖解析器**（Node 内置 `zlib`） | 见 §1.3，**已实测通过** |
| 打包/快捷方式 | 直接运行 + `.lnk` 快捷方式 | 不做安装包（离线环境，避免下载） |

### 1.0 导出决策：写 xlsx（依据实测与官方文档）

用户要求**导出 xlsx 且立创商城能识别**。三个事实：

1. **立创按表头语义识别列**，不要求列名逐字一致（官方："如您的BOM原始表格中，型号列叫 MPN，
   系统识别到该表头，并判定该表头为型号"）
2. **立创侧固定五列**：原型号 / 原品牌 / 原封装 / 原参数 / 原C编码；**C 编码优先匹配**
3. **写入 xlsx 需要 zip 组装**——Node 内置 `zlib` 可做（`deflateRawSync`），
   **无需第三方库**（与 §1.3 读取同源）

**决策**：`exporter.js` 自写最小 xlsx **写入器**（zip writer + 单 sheet + sharedStrings 或 inlineStr）。

> 最小可行写法：全部用 `inlineStr`（`<c t="inlineStr"><is><t>…</t></is></c>`），
> 可**完全绕开 sharedStrings 表**，显著降低复杂度。
> 校验方式：导出的文件用 §1.3 的读取器读回来，逐格比对（自洽性验证），
> 再由用户实际上传立创验证一次（这是唯一的外部验收）。

**格式硬约束**（嘉立创官方，违反则工厂侧识别失败）——已写入 spec §4.2：

- 位号分隔符**仅** `,` 或空格（`;` `|` `。` `'` `:` `~` `>` 不支持）
- 不贴器件不能出现在 BOM；备注会被忽略；编号与封装冲突时以编号为准
- 参数必须带单位（`100nF ±10% 50V X7R`），分隔用空格

### 1.1 存储方案决策

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. SQLite（`better-sqlite3`）** | 事务安全、查询快、适合"变动记录" | 需原生模块编译，**离线安装必然失败**（本机无该包、无构建工具链） |
| **B. JSON 文件** | 零依赖、便携、可直接看/改 | 大数据量慢、事务需自己做 |

**决策：B（JSON 文件）**：

- 本机 npm 全局只有 `electron / pnpm / @anthropic-ai / @openai / @musistudio`，**没有 `better-sqlite3`**
- 数据规模预期在**数千条以内**，JSON 完全够用（spec NFR-2 只要求 1000 条流畅）
- 便携性契合"拷走即用"

> 缓解措施：存储层**封装成接口**（§4），若日后需要换 SQLite，只改一个文件。

### 1.2 离线约束（硬）

- 所有依赖必须**本地已存在**或随应用附带
- **禁止**运行时 `npm install`、禁止引用 CDN、禁止任何 `http(s)` 请求
- 验证方式：断网跑完整流程（spec AC-6）

### 1.3 xlsx 解析决策（**已实测，非推测**）

**背景**：`xlsx` / `SheetJS` npm 包**本机不存在**（全局 node_modules 与 npm cache 均已确认），离线无法安装。

**方案对比**：

| 方案 | 结论 |
|---|---|
| A. 引入 `SheetJS` | ❌ 离线装不上 |
| B. Electron 调本机 Python + `openpyxl` | ⚠️ 可行（`E:\python3.11.9` 有 openpyxl 3.1.5），但**多一个跨语言依赖**，打包分发时 Python 环境成负担 |
| **C. 自写零依赖解析器** | ✅ **已实测通过**——xlsx 本质是 zip 容器，Node 内置 `zlib` 足以解压 |

**实测证据**（`_probe_xlsx.js`，纯 Node，无任何 npm 依赖）：

> 该探针已归档，不在项目树内：
> `<协作工具目录>\_archive\tooling-20261014\component_management-probes-20261015\_probe_xlsx.js`

```
entries: 16
has workbook.xml      : true
has sharedStrings.xml : true
has sheet1.xml        : true
sharedStrings count   : 170
row 1 => ["No.","Quantity","Comment","Designator","Footprint","Value",
          "Manufacturer Part","Manufacturer","Supplier Part","Supplier"]
row 2 => ["1","8","10uF","C1,C2,C4,C5,C6,C7,C10,C11","C1210","10uF",
          "1210B106K500NT","FH(风华)","C116808","LCSC"]
```

**中文（`FH(风华)`）与列结构均正确解析。** 实现要点：

1. 定位 End Of Central Directory（`0x06054b50`），读中央目录
2. 逐条读中央目录头 → 取 local header 偏移 → 解出压缩数据
3. `zlib.inflateRawSync` 解压（method=0 为存储，method=8 为 deflate）
4. 解析 `xl/worksheets/sheetN.xml` 取单元格；`t="s"` 的索引查 `xl/sharedStrings.xml`
5. **注意**：`<c>` 可能缺 `r` 属性，需按列号推断（见 T3 实现注意）

> 该解析器只需支持**读**（BOM 导入）；导出用 §1.0 的写入器。

---

## 2. 系统架构

> **单实例（防多开，v2.6）**：主进程启动时用 `app.requestSingleInstanceLock()` 抢锁；抢不到的第二个实例
> **直接退出**（不建窗口、不注册 IPC），由已有实例收到 `second-instance` 后 `restore/show/focus` 把窗口拉到前台。
> 原因：数据是 JSON 文件、写入是"整文件覆盖"，两个实例同时跑会互相盖掉对方刚写的数据（丢单/丢留痕）。
> `--smoke`（启动验收，自己退出且不写库）不参与该锁，避免挡掉验收脚本。


```
┌─────────────────────────────────────────────┐
│ Electron 主进程 (main.js)                    │
│  - 创建窗口                                  │
│  - 注册 IPC 处理器（唯一的业务入口）          │
│  - **单实例锁**（防多开；第二个实例退出，     │
│    并把已有窗口拉到前台）                     │
└───────────────┬─────────────────────────────┘
                │ IPC (ipcMain / ipcRenderer, contextBridge)
┌───────────────▼─────────────────────────────┐
│ 渲染进程 (renderer/)                         │
│  - 页面：库存 / 导入 / 核对 / 比对 / 录入 / 设置 │
│  - 只做展示与交互，**不直接碰文件与数据库**    │
└─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│ 业务层 (src/services/) — 运行在主进程         │
│  - bom_parser.js    解析 BOM（列映射、校验）  │
│  - store.js         数据读写（存储层封装）     │
│  - inventory.js     入库/合并/出入库/变动记录  │
│  - compare.js       比对（**只读**）          │
│  - spec_parser.js   从 Comment 提取耐压/材质   │
│  - exporter.js      导出 xlsx（立创可识别）    │
└─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│ 数据层 (data/)                               │
│  - parts.json / movements.json / settings.json│
└─────────────────────────────────────────────┘
```

### 2.1 关键边界（安全与正确性）

| 边界 | 规则 |
|---|---|
| 渲染进程 | **禁止** `require('fs')`、禁止直接读数据文件；一律走 IPC |
| 比对模块 | **只读**——`compare.js` 不得 import 任何写函数 |
| 数据写入 | 一律经 `store.js`，**先写临时文件再原子替换**（防写坏） |
| 网络 | 主进程与渲染进程均**不引入任何网络模块** |

### 2.2 入口隔离（v1.3，对应 spec FR-7.6）

| 页面 | 允许的操作 | **禁止** |
|---|---|---|
| BOM 比对页 | 选文件、看结果、导出 | **不得**出现领料/出库按钮 |
| 按 BOM 领料页 | 扣减库存 | — |
| 器件详情 | 出库、编辑 | — |

> 理由：比对是只读的信任基础（spec FR-2.5）。若在比对页放领料入口，
> 用户看到"库存不足"后顺手点击就会误改库存。

---

## 3. 数据模型

### 3.1 `parts.json` — 器件库

```jsonc
{
  "schema_version": 1,
  "parts": [
    {
      "id": "p_0001",                    // 内部唯一 ID
      "category": "C",                   // 分类（由位号前缀推导，可手改）
      "value": "10uF",                   // 值
      "footprint": "C1210",              // 封装
      "voltage": "50V",                  // 耐压
      "dielectric": "X7R",               // 材质/介质
      "tolerance": "±10%",               // 容差
      "power": "",                       // 功率
      "current": "",                     // 载流（用户要求）
      "polarity": "无极性",               // 极性
      "mount_type": "SMD",               // SMD / THT
      "part_number": "1210B106K500NT",   // 厂商料号（主选）
      "manufacturer": "FH(风华)",         // 厂商
      "supplier_part": "C116808",        // 供应商编号
      "supplier": "LCSC",                // 供应商
      "mpn_list": [                      // v1.2：等价料号列表（AML 模式）
        { "part_number": "1210B106K500NT", "manufacturer": "FH(风华)",
          "supplier_part": "C116808", "supplier": "LCSC" }
      ],
      "quantity": 24,                    // 当前库存
      "min_quantity": 10,                // 低库存阈值（null=继承分类默认，见 spec §5.3）
      "location": "A-03",                // 库位
      "datasheet": "",                   // 本地数据手册路径
      "substitute": "",                  // 替代料
      "batch": "",                       // 批次/日期
      "note": "",                        // 备注
      "created_at": "2026-10-15T10:00:00+08:00",
      "updated_at": "2026-10-15T10:00:00+08:00"
    }
  ]
}
```

**唯一性键**（**已确认**，见 spec §5.2）：

```
dedupe_key = normalize(value) + "|" + normalize(footprint) + "|" +
             normalize(voltage) + "|" + normalize(dielectric) + "|" + normalize(tolerance)
```

**厂商料号（MPN）不参与判定**：同规格不同厂 → **一种料，多个 MPN**（AML 模式）。
行业依据：Cadence 器件库实践（一条器件记录关联多个 MPN）、
Oracle Agile PLM 的 AML 分层、无源器件参数组（含 Tolerance）共同定义等效性。

**单位归一化（`normalize` 必做）**：

| 原始 | 归一 |
|---|---|
| `0.1uF` / `100nF` | `100nF` |
| `1k` / `1kΩ` / `1000Ω` | `1kΩ` |
| `4.7uF` / `4700nF` | `4.7uF` |
| 大写/空格 | 小写、去空格 |

**纯数字（如 `100`）不自动推断单位**——按嘉立创官方建议记入"待确认"，提示补全。

> 兼容：顶层仍保留 `part_number`/`manufacturer`/`supplier_part` 作为**主选料号**（= `mpn_list[0]`），
> 便于导出与检索；`mpn_list` 承载全部等价料号。

### 3.2 `movements.json` — 变动记录

```jsonc
{
  "schema_version": 1,
  "movements": [
    {
      "id": "m_0001",
      "part_id": "p_0001",
      "kind": "in",                 // in(入库) / out(出库) / adjust(修正) / init
      "delta": 24,                  // 正数增，负数减
      "before": 0,
      "after": 24,
      "reason": "BOM 导入: sample_bom 套数3",
      "ref": "batch_20261015_100000",
      "at": "2026-10-15T10:00:00+08:00",
      // v1.4：人工改过数量时留痕（回答"为什么和 BOM 不一样"）
      "expected_quantity": 24,      // 原应入库量（= total_quantity）
      "intake_quantity": 10,        // 实际入库量
      "edited_by_human": true       // 该条在核对阶段被改过
    }
  ]
}
```

### 3.3 `settings.json` — 应用设置

```jsonc
{
  "schema_version": 1,
  "data_dir": "…",                      // 数据目录（可改）
  "default_min_quantity": {             // 按分类的默认阈值（spec §5.3 预置）
    "C": 20, "R": 50, "L": 10, "D": 10, "Q": 10, "U": 5,
    "CN": 5, "X": 3, "KEY": 5, "F": 5, "BUZZER": 2,
    "LED": 10, "H": 10, "_default": 5
  },
  "last_used_dir": "E:\\bom",           // 上次打开 BOM 的目录
  "export_mode": "lcsc"                 // lcsc(立创配单) / jlc(嘉立创SMT) 见 spec §4.2
}
```

> **v1.1 变更**：`remember_sets` **已移除**——用户确认套数每次手填（Q3 答复 A）。

---

## 4. 存储层接口（唯一写入口）

```js
// src/services/store.js
loadParts(): Part[]
saveParts(parts): void                    // 原子写：临时文件 + rename
loadMovements(): Movement[]
appendMovement(movement): void
loadSettings(): Settings
saveSettings(settings): void
backupTo(dirPath): string                 // 整库备份，返回备份路径
restoreFrom(filePath): void               // 恢复（先备份当前）
```

**原子写实现要求**：

```js
// 必须写成：写 tmp -> fsync -> rename（同目录内 rename 是原子的）
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
fs.renameSync(tmp, target)
```

> 理由：spec NFR-4「出错不损坏已有数据」。断电/写一半时，原文件仍完好。

---

## 5. 模块设计

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `bom_parser.js` | 读 xlsx/csv → 校验列 → 标准化为内部条目 | 不写库 |
| `spec_parser.js` | 从 `Comment` 提取耐压/材质/容差（**只给建议值**） | 不擅自判定，交人工确认 |
| `inventory.js` | 入库合并、出库、**按 BOM 领料**、变动记录 | 不做比对 |
| `compare.js` | BOM vs 库 分组（够用/缺料/疑似）+ **缺口计算** | **绝对只读** |
| `exporter.js` | 导出 xlsx（立创可识别） | 不决定内容（由调用方给） |
| `store.js` | 数据读写 | 不含业务规则 |

### 5.1 `spec_parser` 解析规则（依据真实数据）

真实 `Comment` 形如：

| 样例 | 应解析出 |
|---|---|
| `10uF/50V X7R` | value=`10uF`, voltage=`50V`, dielectric=`X7R` |
| `100nF/100V X7R` | value=`100nF`, voltage=`100V`, dielectric=`X7R` |
| `100uF/35V 固态高频低阻` | value=`100uF`, voltage=`35V`, note=`固态高频低阻` |
| `33pF/50V C0G` | value=`33pF`, voltage=`50V`, dielectric=`C0G` |
| `10uF`（无斜杠） | value=`10uF`，其余留空 |
| `HX-PH2.0-6PWZ-M`（连接器） | 整体作为 part_number，不解析 |

规则：

1. 按 `/` 切分；首段含单位（uF/nF/pF/uH/Ω/k/M）→ `value`
2. 含 `V` 且为数字+`V` → `voltage`
3. 匹配 `X7R|X5R|C0G|NP0|Y5V|X7T` → `dielectric`
4. 无法识别的余下文本 → `note`
5. **解析结果一律标为"建议"，界面高亮待人工确认**

### 5.2 分类推导

分类由**位号前缀**判定，前缀→分类映射表**集中一处**（禁止散落硬编码），
依据 spec §5.3 的 14 类表。取不中时落 `_default`。

> 注意前缀有重叠：`CN`（连接器）必须**先于** `C`（电容）匹配，`KEY` 先于 `K`，
> `BUZZER` 先于 `B`。按前缀长度**降序**匹配。

---

## 6. IPC 契约（前后端字段必须一致，snake_case）

> 所有通道经 `preload.js` 的 `contextBridge` 暴露；渲染进程禁止直接 `ipcRenderer`。

### 6.1 BOM 导入

```markdown
### bom:pick_files
| 方向 | 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| 请求 | - | - | - | 无参数，打开系统文件选择框 |
| 响应 | file_paths | string[] | - | 用户选择的文件路径（可多选） |

### bom:parse
| 方向 | 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| 请求 | file_path | string | 是 | BOM 文件路径 |
| 请求 | sets | number | 是 | 套数（≥1 整数） |
| 响应 | ok | boolean | - | 是否解析成功 |
| 响应 | error | string | - | 失败原因（缺列/空文件等） |
| 响应 | batch_id | string | - | 本次导入批次号 |
| 响应 | items | BomItem[] | - | 条目数组 |
| 响应 | warnings | string[] | - | 如"Quantity 与位号个数不符" |

### BomItem
| 方向 | 字段 | 类型 | 说明 |
|------|------|------|------|
| 响应 | row_no | number | 原 BOM 行号 |
| 响应 | designators | string[] | 位号列表 |
| 响应 | designator_count | number | 位号个数 |
| 响应 | quantity_per_board | number | BOM 单套数量（**只读**，v1.4） |
| 响应 | total_quantity | number | `quantity_per_board × sets` = 应入库量（**只读**，v1.4） |
| 响应 | **intake_quantity** | number | **本次入库量**（可改，默认 = `total_quantity`）；为 0 视同跳过 |
| 响应 | **edited_by_human** | boolean | 该条是否被人工改过（v1.4，入库需留痕） |
| 响应 | comment | string | 原始 Comment |
| 响应 | value | string | 值 |
| 响应 | footprint | string | 封装 |
| 响应 | voltage | string | 耐压（可能来自解析，需确认） |
| 响应 | dielectric | string | 材质 |
| 响应 | **tolerance** | string | **容差**（v1.5 实现期补记：从 `Comment` 解析的**建议值**，核对时可改。原契约漏此字段，见 §11） |
| 响应 | manufacturer_part | string | 厂商料号 |
| 响应 | manufacturer | string | 厂商 |
| 响应 | supplier_part | string | 供应商编号 |
| 响应 | supplier | string | 供应商 |
| 响应 | **location** | string | **库位**（v1.5 实现期补记：spec FR-1.6 允许核对时填/改，BOM 无此列故解析为空串） |
| 响应 | **min_quantity** | number \| string | **低库存阈值**（v1.5 实现期补记：同上，**留空 = 继承分类默认** FR-4.8） |
| 响应 | parse_confident | boolean | 解析是否可信 |
| 响应 | action | string | keep / skip（人工核对结果） |
| 响应 | note | string | 人工备注 |

> **v1.4 关键区分：`total_quantity`（只读） vs `intake_quantity`（可改）**
>
> 用户明确：导入时**人工确认**是强制步骤，且**核对阶段就能改数量等内容**，
> 但改的是**本次入库量**，**不是** BOM 原值：
>
> | 字段 | 谁能改 | 入库依据 |
> |---|---|---|
> | `quantity_per_board` | **不可改**（BOM 事实） | 仅用于显示算式 |
> | `total_quantity` | **不可改**（= 单套 × 套数） | 仅用于显示算式 |
> | **`intake_quantity`** | **可改**（默认 = `total_quantity`） | ✅ **实际入库量** |
>
> **实现约束**：`bom:commit` 一律以 `intake_quantity` 累加库存；
> 若 `intake_quantity != total_quantity`，必须置 `edited_by_human=true` 并写入变动记录备注
> （使事后能回答"这条为什么和 BOM 不一样"）。
> **禁止**用 `intake_quantity` 回写 BOM 文件——BOM 只读。

### bom:commit
| 方向 | 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| 请求 | batch_id | string | 是 | 批次号 |
| 请求 | items | BomItem[] | 是 | 人工确认后的条目（含 `intake_quantity`） |
| 请求 | sets | number | 否 | 套数（v1.5 实现期补记：用于留痕 `expected_quantity`，见 §6.5） |
| 请求 | source | string | 否 | BOM 来源文件名（v1.5 实现期补记：入库汇总要能看出这批是哪份 BOM 来的，FR-1.8） |
| 请求 | reason | string | 否 | 入库原因（v1.5 实现期补记：写入变动记录） |
| 响应 | ok | boolean | - | 是否成功 |
| 响应 | added | number | - | 新增条数 |
| 响应 | merged | number | - | 合并（累加）条数 |
| 响应 | skipped | number | - | 跳过条数 |
| 响应 | parts | Part[] | - | 变更后的库 |
```

> **v2.0（2026-10-17，对抗审计 A1）入库幂等**：同一个 `batch_id` **只允许成功提交一次**；
> 重复提交返回 `ok:false`（"这一批已经入过库了…"），库与变动记录**一个字节都不动**。
> 幂等表在进程内（重启清空）；重新解析后会得到新的 `batch_id`，那是合法的新操作。
> 两层闸门：页面「确认入库」按钮在请求在飞时 disabled（`state.busy`）+ 服务端拒绝重复提交。

### 6.2 比对（只读）

```markdown
### compare:run
| 方向 | 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| 请求 | file_path | string | 是 | 待比对 BOM |
| 请求 | sets | number | 否 | 套数（默认 1）；需求 = 单套数量 × sets |
| 响应 | ok | boolean | - | 是否成功 |
| 响应 | compare_id | string | - | 本次比对号 |
| 响应 | enough | CompareItem[] | - | **够用**（库中已有且库存 ≥ 需求） |
| 响应 | shortfall | CompareItem[] | - | **缺料**（库中没有，或库存 < 需求） |
| 响应 | uncertain | CompareItem[] | - | 疑似匹配，需人工确认 |
| 响应 | stats | object | - | { total, enough, shortfall, uncertain, no_stock, insufficient } |

### CompareItem
| 方向 | 字段 | 类型 | 说明 |
|------|------|------|------|
| 响应 | row_no | number | 原 BOM 行号 |
| 响应 | designators | string[] | 位号列表 |
| 响应 | quantity_per_board | number | BOM 单套数量 |
| 响应 | required_quantity | number | 需求 = quantity_per_board × sets |
| 响应 | value | string | 值 |
| 响应 | footprint | string | 封装 |
| 响应 | voltage | string | 耐压 |
| 响应 | dielectric | string | 材质 |
| 响应 | tolerance | string | 容差 |
| 响应 | **power** | string | **功率**（v1.5 实现期补记：spec §5.2 说它"进导出参数列"，**取自匹配到的库中器件**；BOM/核对表不提供） |
| 响应 | **current** | string | **载流**（同上，spec §5.2） |
| 响应 | part_number | string | 厂商料号 |
| 响应 | manufacturer | string | 厂商 |
| 响应 | supplier_part | string | 供应商编号 |
| 响应 | matched_part_id | string | 匹配到的库中器件 id（无则空） |
| 响应 | stock_quantity | number | 库中现有数量（无则 0） |
| 响应 | shortfall_quantity | number | **缺口 = max(0, required − stock)**；导出时即 spec §4.2 的 **`purchase_quantity`**（需采购数量） |
| 响应 | match_reason | string | exact / partial / none（partial 进 uncertain） |
| 响应 | missing_fields | string[] | 键字段缺失项（导致进 uncertain） |

### compare:export
| 方向 | 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| 请求 | compare_id | string | 是 | 比对号 |
| 请求 | output_path | string | 是 | 导出路径（.xlsx） |
| 请求 | mode | string | 是 | **lcsc**（立创配单）/ **jlc**（嘉立创SMT），见 spec §4.2 |
| 请求 | include_uncertain | boolean | 否 | 是否把"疑似"也一并导出（默认 false） |
| 响应 | ok | boolean | - | 是否成功 |
| 响应 | exported_count | number | - | 导出行数（= shortfall 条数） |
| 响应 | file_path | string | - | 实际写入路径 |

> **v1.2 修正**：原契约的 `format`（xlsx/csv）与 Q6 定的"**xlsx + 两种模式**"不符——
> 格式固定 xlsx，变化的是**模式**（lcsc/jlc）。另：导出行的"数量"列取
> `shortfall_quantity`（不是 `required_quantity`），见 spec §4.2 v1.2 关键修正。
```

> **契约约束**：`compare:run` 与 `compare:export` **不得**触发任何写库操作。
> 验收时用「比对前后库文件字节比对」证明（spec AC-2 FR-2.5）。

### 6.3 器件、库存与领料

```markdown
### parts:list
| 请求 | query | object | 否 | { q, category, footprint, **voltage**, low_stock_only, **sort_by, sort_dir** } |
| 响应 | parts | Part[] | - | 器件列表（**精确命中在前、相似命中在后**） |
| 响应 | low_stock_ids | string[] | - | 低库存器件 ID |
| 响应 | total | number | - | 本次返回条数（筛选/检索后） |
| 响应 | all_total | number | - | 库中总条数（不受检索/筛选影响，供界面显示"N / 共 M"） |
| 响应 | similar_ids | string[] | - | **v2.8 相似产品**：这些 id 是"字面没命中、但**值归一后相同**（0.1uF ↔ 100nF、4K7 ↔ 4.7kΩ、10K ↔ 10kΩ）或**型号归一后相同**"的命中，界面需标记为「相似」 |
| 响应 | facets | object | - | **v2.8 筛选候选值**：`{ categories: string[], footprints: string[], voltages: string[] }`（用**全部**器件算，供筛选下拉框） |

> **v2.8（2026-10-17，用户目标"领料和库存太繁琐，至少要有检索、筛选"）**：
> · 检索语义集中在 `src/services/part_search.js`（唯一定义处）：字面命中=exact；**相似产品**=值归一相同
>   （复用 `spec_parser.normalizeValue`，所以 `0.1uF`↔`100nF`、`4K7`↔`4.7kΩ`、大小写/Ω·R 差异都算同一个值）、
>   **容差归一相同**（`±1%`↔`+/-1%`↔`1%`，复用 `spec_parser.normalizeTolerance`）、
>   **封装/型号宽松归一相同**（全角→半角、去空格/连字符/下划线，`SOT23`↔`SOT-23`、MPN 去连字符），
>   或从**混合写法**里取出值再比（`100nF 50V`、`100nF/50V`）；空查询返回全部。
>   响应 `similar_ids` 标出相似命中，界面据此显示「相似」提示。
> · 筛选新增 `voltage`（耐压），并补 `facets` 供界面做分类/封装/耐压下拉（FR-5.3）。
> · **v2.9（行业常规补记）**：多关键字检索语义 = **AND**（空格/逗号/斜杠分隔的每个词都要命中同一器件，
>   不是 OR），且 AND 的单词允许上述写法差异；命中排序 = `exact > similar > tokenized`，同档内
>   「值/型号完全相等 > 前缀命中 > 普通子串」；空查询返回全部。界面按 `similar_ids` 标「相似」。
>   上述规则在 `docs/architecture.md` §4 有完整说明，`tests/test_part_search.js` 与 `tests/test_architecture.js` 钉住。
> · 排序仍在 `parts.listParts`（不放进 part_search，避免检索模块依赖排序字段表）。

### parts:save
| 请求 | part | Part | 是 | 新增或更新（有 id 则更新） |
| 请求 | confirm_merge | boolean | 否 | **v2.2**：新增一条与库中已有器件**同规格**时，必须显式传 true 才允许合并数量（与 parts:delete 的 confirm 同一取向） |
| 响应 | ok | boolean | - | |
| 响应 | part | Part | - | 保存后的记录（**needs_confirm=true 时无此字段**，因未落库） |
| 响应 | needs_confirm | boolean | - | **v2.2**：需要人工确认"是否合并到已有同规格器件"，此时**没有任何写入** |
| 响应 | existing_part | object | - | **v2.2**：`{ id, value, footprint, quantity }`，即库里那条同规格器件（供确认文案使用） |
| 响应 | message | string | - | **v2.2**：给用户看的确认文案（界面直接显示） |

> **v2.2（2026-10-17，用户实测反馈）**：手动录入一条与库中已有器件**同规格**的料时，原实现直接合并数量、
> 界面上没有任何确认通道（用户原话："提示疑似要人工确认，但实际直接合并，没有人工处理的通道"）。
> 现在改为**两层闸门**：服务端先回 `needs_confirm`（不落库）→ 界面弹确认 → 用户点确定后才带
> `confirm_merge: true` 重发。判定键复用 `compare.dedupeKey`（唯一实现），不另写规则。

> **v2.5（2026-10-17，用户裁定 + 追加要求）值与型号**：**「值」必填**；对"没有参数值"的料
> （MOS/IC/连接器/开关…），**值就是型号**。
> · 对账单导入：解析层用商品型号补值（A 方案）
> · **手动录入**：界面提示直接说明"没有参数值的元件，值就是型号"；只填了「型号」就保存时，
>   **先弹确认**问"是否直接把「型号」填进「值」"——**确定** = 填值并保存；**取消** = 不保存，
>   并把焦点放回「值」提示用户自己填
> · 业务层 `parts.savePart` 仍保留同一规则作为**兜底**（任何绕过界面的调用路径都得到"值=型号"，
>   并返回"已用型号作为值"的提示）
> · 想保留真正的参数值（如 `100nF`）时照旧填「值」，不受影响

> **v2.4（2026-10-17，对抗审计 C2）闸门下沉到业务层**：同规格合并的人工闸门现在在
> `src/services/parts.js` 的 `savePart` 里（没带 `confirm_merge: true` 就抛
> `code="NEEDS_CONFIRM_MERGE"` 的类型化错误，且**不改调用方传入的库**）；`ipc/handlers.js`
> 只透传人的选择、把该错误映射成 `needs_confirm` 响应。这样任何直接调用 savePart 的新路径
> （以后加的导入/脚本/页面）都绕不过人工确认，而不是只靠"必须走 IPC"的约定。

### parts:delete
| 请求 | part_id | string | 是 | |
| 请求 | confirm | boolean | 是 | 必须为 true（二次确认） |
| 响应 | ok | boolean | - | |

### parts:export
| 请求 | output_path | string | 否 | 导出路径；不传则用含时间戳的默认名 |
| 响应 | file_path | string | - | 实际写入路径 |
| 响应 | exported_count | number | - | 导出条数（**= 库中条数**，spec AC-5 第 5 行） |
| 响应 | warnings | string[] | - | 提示（当前为空） |

> **v1.5 实现期新增（spec FR-5.5 / AC-5 第 5 行）**：spec 要求"可导出当前库为表格文件"，
> 但原契约的 15 个通道里**没有任何写表格文件的通道**（`compare:export` 只导缺料清单，语义不同）。
> 列结构在 `src/services/export_format.js` 的 `LIBRARY_COLUMNS`（14 列，含"低库存"判定列）。

### stock:move
| 请求 | part_id | string | 是 | |
| 请求 | delta | number | 是 | 正数入库，负数出库 |
| 请求 | reason | string | 是 | 原因（留痕） |
| 响应 | ok | boolean | - | |
| 响应 | part | Part | - | 更新后的记录 |
| 响应 | movement | Movement | - | 生成的变动记录 |

> **v2.1（2026-10-17，对抗审计 C1）类型边界**：`delta` **只接受 JS number 且为安全整数**；
> 字符串 `"5"`、布尔、数组、`{valueOf}`、小数、NaN/Infinity 一律 `ok:false` 并说明原因
> （此前服务层 `Number(delta)` 强转会让这些值通过）。业务规则（非 0、库存不足、reason 必填）
> 仍在 `inventory.moveStock` 里，**不重复**。

### stock:pick_by_bom
| 请求 | file_path | string | 是 | 领料依据的 BOM |
| 请求 | sets | number | 是 | 套数 |
| 请求 | allow_partial | boolean | 否 | 库存不足时是否按现有量部分领用（默认 false=整单拒绝） |
| 请求 | reason | string | 是 | 领用原因（留痕） |
| 响应 | ok | boolean | - | 是否成功 |
| 响应 | pick_id | string | - | 本次领料批次号 |
| 响应 | picked | object[] | - | [{ part_id, part_number, required, deducted, after }] |
| 响应 | insufficient | object[] | - | [{ part_id, required, stock, shortfall }] 缺口清单 |
| 响应 | unknown | object[] | - | 库中**没有**的条目（列出，不静默跳过） |
| 响应 | movements | Movement[] | - | 产生的变动记录（带同一 pick_id 作 ref） |

> **v1.2 新增**：spec FR-7.4/7.5 要求"按 BOM 领料"与"逐条列出缺口"，此前无对应契约。
> 约束：`allow_partial=false` 时只要有一条不足就**整单拒绝**且不产生任何变动。

### movements:list
| 请求 | part_id | string | 否 | 不传=全部 |
| 请求 | ref | string | 否 | 按批次过滤（如 pick_id / batch_id） |
| 响应 | movements | Movement[] | - | 按时间倒序 |
```

### 6.4 设置与备份

```markdown
### settings:get  → { settings }
### settings:set
| 请求 | settings | object | 是 | 合并写入 |
| 请求 | confirm_data_dir | boolean | 否 | 改 `data_dir` 时必须为 true（v1.5 实现期补记，见 §6.5） |
| 响应 | settings | object | - | |

> **`settings:set` 字段级校验（v1.5 新增，对应 spec FR-4.7 / AC-9）**：
> `default_min_quantity` 的每个值（含 `_default`）**必须是 number**。
> 传入非数字（如 `"abc"`）→ **拒绝整个写入并返回 `ok=false` + `error`**，
> **已存的阈值保持原样**（不得部分写入、不得静默忽略）。
> 校验在**服务端**（IPC 层）做，不依赖界面限制。
> 另：`default_min_quantity` 的**初始值**取 spec §5.3 的 14 类表（首启写入）。

### statement:parse
| 请求 | file_path | string | 是 | 立创对账单 `.xls` 路径 |
| 响应 | items | object[] | - | 明细（**H–L 列**：category/name/value/tolerance/voltage/manufacturer_part/footprint/quantity） |
| 响应 | matched | object[] | - | 严格命中：`{ row_no, part_id }` |
| 响应 | suspected | object[] | - | **疑似（须人工裁决）**：`{ row_no, candidates: [{ part_id, value?, footprint?, voltage?, dielectric?, tolerance?, part_number?, quantity?, diff }] }`（v2.7 扩了候选器件的身份快照，界面才能把"对账单这一行 / 库里候选"分开说清） |
| 响应 | missing | number[] | - | 新增（对账单行号） |
| 响应 | warnings | string[] | - | 提示（如某行商品名称里没解出值） |

> **v1.7（§6.5 补记 9）**：本通道**只读**——解析+对账，不写任何文件（FR-8）。

### statement:commit
| 请求 | file_path | string | 是 | 同一个对账单（提交时重新解析，避免"界面上的数据"与"文件"不一致） |
| 请求 | order_ref | string | 否 | 订单号/对账单标识（写进留痕） |
| 请求 | decisions | object[] | 是 | `[{ row_no, action: "merge" \| "new" \| "skip", part_id?, **overrides?** }]`；**空数组直接拒绝**（不得静默入库） |
| 请求 | decisions[].**overrides** | object | 否 | **人工改过的字段**（v1.8）：`{ intake_quantity?, value?, tolerance?, voltage?, footprint?, manufacturer_part? }`。服务端**校验后合并**（入库量必须非负整数、值不得为空），并在 summary 里报 `edited_count` |
| 响应 | summary | object | - | `{ merged_count, created_count, quantity_in, order_ref }` |
| 响应 | movement_ids | string[] | - | 本次落盘的留痕 id |
| 响应 | parts | object[] | - | 入库后的器件库（全量） |

> **v1.7（§6.5 补记 10）**：落盘复用既有 `persist()`（变动记录先写、器件后写，器件写失败则**撤掉**刚写的留痕）；
> 决定指向**不存在的行或器件**一律拒绝（不猜）；数量 = 对账单「订购数量」；新建器件**不写位号**（FR-8.5）。

> **v1.9（2026-10-17，用户要求）**：核对表的「入库」勾选列**默认全选**，用户可以取消勾选只入库一部分。
> 未勾选的行不放进 `decisions`，服务端只处理 `decisions` 里的行（未勾选的行也不需要裁决）。
> **契约字段没有变化** —— `decisions` 本来就是"这次要入库的行"，不是对账单全量。

> **v2.0（2026-10-17，对抗审计 A2）入库幂等**：同一 `file_path` + **同一组 `decisions`**（含 overrides）
> 只允许成功提交一次；重复提交返回 `ok:false`（"已经提交过了…"），数量不得翻倍。
> 判等用规范化指纹（字段顺序固定）。重新解析文件、或改过决定（含 overrides）后再提交 = 合法新操作。
> 两层闸门：页面入库成功后按钮保持禁用、必须重新选文件（`state.committed`）+ 服务端拒绝重复。

### data:backup
| 请求 | dir_path | string | 是 | |
| 响应 | ok | boolean | - | |
| 响应 | backup_path | string | - | |

### data:restore
| 请求 | file_path | string | 是 | |
| 请求 | confirm | boolean | 是 | |
| 响应 | ok | boolean | - | |
```

### 6.5 v1.5 实现期契约补记（**改契约必须在此说明影响**）

> AGENTS.md：改 plan §6 = 破坏前后端约定，必须先改本文并说明影响。
> 实现期发现 **spec 要求的能力在原契约里没有载体**，或在语义上必须传的字段契约里没写。
> 下面逐条说明「为什么必须加」与「影响面」，共 **8 处**：

| # | 位置 | 补什么 | 为什么必须补（spec 出处） | 影响面 |
|---|---|---|---|---|
| 1 | 新通道 `parts:export` | 导出当前库为 xlsx | **FR-5.5 / AC-5 第 5 行**要求"可导出当前库为表格文件"；原 15 个通道无任何写表格文件的通道 | 通道数 15 → **16**；`channels.js` 的 `PLAN_CHANNELS` 已同步；preload 白名单自动跟随（清单是唯一信源） |
| 2 | `parts:list.query` | `sort_by` / `sort_dir` | **FR-5.1 / AC-5 第 1 行**要求"列表可按任意关键信息列排序"，原 query 只有 4 个筛选键 | 仅新增可选键，**不传时行为与原来完全一致**（不破坏既有调用） |
| 3 | `settings:set` | `confirm_data_dir` | AGENTS.md 把"更改数据目录位置"列为**需人工确认**操作，原契约无处传确认 | 仅新增可选键；**改 `data_dir` 而不传 → 服务端拒绝并说明**（比静默改目录安全） |
| 4 | `bom:commit` | `sets` / `source` / `reason` | **FR-1.8** 要能看出这批是哪份 BOM；**FR-4.5 / v1.4 留痕**要求入库记录带原因与 `expected_quantity`（= 单套量 × 套数） | 仅新增可选键；不传时留痕字段为空，**不影响入库本身的正确性** |
| 5 | `BomItem` | `location` / `min_quantity` | **FR-1.6** 明列核对阶段**可改**字段含「库位」「低库存阈值」，**AC-1** 也要求"试改库位/阈值均可改并生效" | **这是"静默丢数据"型缺口**：契约没有这两字段时，`inventory.newPartFromItem` 取不到它们，界面即便给输入框也会被丢弃。补齐后 `bom_parser` 以空值占位、`newPartFromItem`/`mergePartInfo` 读取并落库（合并时仍遵守"只补空不覆盖"） |
| 6 | `CompareItem` | `power` / `current` | **spec §4.2** 的参数列 = `value + voltage + dielectric + tolerance（+power）`；**spec §5.2** 补充字段表明确「功率」「载流」**进导出参数列**（虽不参与唯一性判定） | 同属"静默丢数据"：`export_format.buildParams` 早就带了 `power`，但 CompareItem 没有该字段 → 库中器件的功率/载流**永远进不了导出参数列**。**取值来源**：BOM 与核对表都不提供这两项（FR-1.6 的可改字段清单里没有），故取自**匹配到的库中器件**；没有匹配（缺料）则留空——那不是丢数据，而是本来就没有信息 |
| 7 | `parts:delete` | 响应新增 `movement`（**删除有库存的器件时补一条 `adjust` 留痕**） | **spec FR-4.5**「任何数量变化都要写 `movements.json`」——删掉一个还有 13 个库存的器件，总库存凭空少 13 而账面无解释，等于 FR-4.5 有个洞 | 响应**只在被删器件 quantity ≠ 0 时才多一个 `movement` 字段**（其它情况为 `null`），前端不读也不受影响；同时明确 **器件 id 永不复用**（`nextPartId` 把变动记录里的 `part_id` 也算进"用过的号"）——否则新器件会拿回刚删掉的 id 并"继承"别人的整段历史 |
| 8 | 运行号（`batch_id` / `compare_id` / `pick_id`） | 撞车时追加 `-2` / `-3` 后缀 | **spec AC-7**「同一批次」要求 ref 能唯一标识一次操作；plan §3.2 的运行号形态只到**秒** | 同一秒内做两次同类操作（连点两次按钮就会）会拿到同一个号 → 两次领料的留痕被并成一批、`compare:export` 可能导出另一次比对的结果。**标准形态一字不变**（`batch_YYYYMMDD_HHMMSS`），只有真撞车时多一个后缀；**这也是"取件单"里那条"秒级精度"发现的处置** |

> **不采纳的"扩展"**：`compare:export.include_uncertain` **本来就在本契约里**（§6.2），
> 实现期一度把它误登记为扩展，核对后已更正——**登记表与契约必须逐字对齐，不能凭印象**。
>
> **第 5 条的性质与其它四条不同**（值得单独说一句）：它不是"多加一个可选键"，而是
> **契约漏了字段导致数据被静默丢弃**。当时我在核对表里**故意不提供**这两个输入——
> 理由是"宁缺，也不给一个会丢数据的框"；界面少两列用户看得见，**数据悄悄没了用户看不见**。
> 现在补齐契约后才把两列加回核对表（`renderer/pages/import_wizard.js`），
> 并有一条端到端断言盯着"核对该值时，入库后器件上真的有"（`tests/test_import_gate.js`）。
>
> 一条纪律：**新增通道必须同时改本节与 `channels.js`**。
> `tests/test_ipc_handlers.js` 会断言「实际通道集合 == 契约 §6 ∪ 登记表」，
> 两边对不上（加了没登记、登记了没实现）测试立刻红。

---

## 7. 命名规范（强制）

| 项 | 规范 |
|---|---|
| IPC 通道名 | `模块:动作`，如 `bom:parse`、`compare:run` |
| 数据字段 | **snake_case**（`quantity_per_board`、`supplier_part`） |
| JS 变量/函数 | camelCase |
| 文件 | 小写 + 下划线：`bom_parser.js` |
| 常量 | UPPER_SNAKE_CASE |
| 前端模板绑定 | **必须与 §6 契约字段名完全一致**，禁止自转 camelCase |

---

## 8. 目录结构

```
component_management/                 ← 项目根（协作工作区）
├── AGENTS.md                         ← 项目协作规则（dsh 身份）
├── README.md                         ← **使用说明**（启动 / 七个页面 / 数据与备份 / 自查验收 / 已知限制）
├── package.json                      ← 零依赖；main 指向 src/main.js
├── docs/
│   ├── spec.md                       ← 本规格（WHAT）
│   └── plan.md                       ← 本方案（HOW）
├── src/
│   ├── main.js                       ← Electron 主进程入口（开窗 / IPC / 离线拦截）
│   ├── preload.js                    ← contextBridge 白名单（由 channels.js 派生）
│   ├── services/                     ← 业务逻辑（纯函数为主；唯一写入口是 store.js）
│   │   ├── store.js                  ← 存储层（**唯一写入口**，原子写）
│   │   ├── bom_parser.js
│   │   ├── spec_parser.js
│   │   ├── inventory.js              ← 入库 / 出库 / 领料（写路径，逐笔留痕）
│   │   ├── compare.js                ← **只读**（禁导任何写函数）
│   │   ├── low_stock.js              ← 阈值解析与低库存判定（v1.5 实现期新增）
│   │   ├── parts.js                  ← 手动录入 / 编辑 / 删除 / 查询（v1.5 实现期新增）
│   │   ├── exporter.js               ← xlsx 字节组装与写出（原子写）
│   │   ├── ids.js                    ← 运行号 / 时间戳 / 序 id 的**唯一实现**（v1.5 实现期新增）
│   │   ├── export_format.js          ← 导出列结构（lcsc/jlc 配单 + 库表；v1.5 实现期新增）
│   │   ├── zip_container.js          ← zip 信封读写（读/写共用，v1.5 实现期新增）
│   │   └── xlsx_xml.js               ← xlsx 文本与单元格坐标（读/写共用，v1.5 实现期新增）
│   └── ipc/
│       ├── channels.js               ← 通道清单（**唯一信源**，handlers 与 preload 共用）
│       ├── extensions.js             ← 契约扩展登记表（v1.5 实现期新增，见 §6.5）
│       └── handlers.js               ← IPC 注册（薄层，调 services）
├── renderer/                         ← 界面（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── app.js                        ← 外壳：页面切换 + 库存页
│   ├── style.css
│   ├── model/                        ← **页面规则**（纯逻辑、无 DOM、无 require → 可无头测试）
│   │   ├── import_model.js           ← 导入核对表规则（FR-1.3~1.8）
│   │   ├── compare_model.js          ← 比对结果页规则（FR-2）
│   │   ├── parts_model.js            ← 录入表单规则（FR-3 / FR-5）
│   │   ├── stock_model.js            ← 领料规则（FR-7）
│   │   ├── settings_model.js         ← 阈值与数据目录规则（FR-4）
│   │   └── backup_model.js           ← 备份/恢复规则（FR-6.4）
│   └── pages/                        ← 各页面（只做 DOM 装配，规则在 model/）
│       ├── import_wizard.js
│       ├── compare_report.js
│       ├── parts_editor.js
│       ├── stock_page.js
│       ├── settings_page.js
│       └── backup_page.js
├── assets/
│   └── icon.ico                      ← 应用图标（tools/make_icon.py 生成，零依赖）
├── data/                             ← 运行时数据（可配置到别处）
│   ├── parts.json
│   ├── movements.json
│   └── settings.json
├── tests/
│   ├── run_all.js                    ← 一条命令跑完全部套件（扫描 tests/test_*.js 自动发现）
│   ├── test_*.js                     ← 24 个套件（含 AC-1~AC-9 全流程验收、NFR 实测、AC 覆盖率审计、页面级 DOM 测试）
│   ├── fake_dom.js                   ← 手写极简 DOM（零依赖），供页面级测试把 renderer 脚本真跑起来
│   └── fixtures/                     ← 测试用 BOM（复制自 E:\bom）
└── tools/
    ├── verify_spec_docs.py           ← 规格一致性门禁（45 项）
    ├── audit_cross_docs.py           ← 跨文档审计（FR/AC 闭合、字段一致、能力载体）
    ├── make_icon.py                  ← 生成 assets/icon.ico（标准库手写 ICO）
    └── make-shortcut.ps1             ← 生成桌面快捷方式
```

> **v1.5 实现期补记**：`renderer/model/` 这一层是**实现期的结构决策**——页面规则（"本次入库量怎么校验"
> "缺料合计怎么算"）若写在 DOM 代码里就只能靠人点着看；抽成纯逻辑模块后可以**逐条无头断言**。
> 六个 model 文件都用 `module.exports`/`globalThis` 双挂载，**全文件无 `require`**，
> 因此渲染进程"不得 require"的静态检查不被削弱（见 `tests/test_parts_model.js`）。

---

## 9. 任务拆解

| # | 任务 | 依赖 | 优先级 | 建议模型 | 验收 |
|---|---|---|---|---|---|
| T1 | 项目骨架：Electron 起窗口 + 目录结构 | — | P0 | 通用 | 双击能出窗口 |
| T2 | `store.js` 存储层（原子写 + 三个数据文件） | T1 | P0 | 通用 | 写坏测试：中途失败原文件完好 |
| T3 | `bom_parser.js` 解析 + 列校验 | T2 | P0 | 通用 | 4 份真实 BOM 全解析；空文件/错列有明确报错 |
| T4 | `spec_parser.js` 从 Comment 提参数 | T3 | P1 | 通用 | §5.1 六个样例全部正确 |
| T5 | 导入向导 UI（选文件 + 套数） | T3 | P0 | 通用 | spec AC-1 |
| T6 | **人工核对表 UI**（强制步骤，不可绕过） | T5 | P0 | 通用 | 显示算式、**改本次入库量**、可跳过、入库前汇总（FR-1.8）；原值只读（FR-1.4） |
| T7 | `inventory.js` 入库合并 + 变动记录 | T2,T6 | P0 | 通用 | 重复导入不重复建条；留痕含 expected/intake |
| T8 | `compare.js` 比对（只读）+ 分组 + **缺口计算** | T2,T3 | P0 | 通用 | **前后库字节一致**；缺口 = max(0, 需求−库存) |
| T9 | 比对结果 UI + 两种模式导出 | T8 | P0 | 通用 | 导出仅含缺料、数量=缺口、lcsc/jlc 两模式 |
| T10 | 手动录入 UI | T7 | P1 | 通用 | spec AC-3 |
| T11 | 列表/搜索/筛选 + 详情 | T7 | P1 | 通用 | spec AC-5 |
| T12 | 低库存提示 | T7 | P0 | 通用 | spec AC-4 |
| **T12b** | **分类与阈值设置**（FR-4.6/4.7/4.8，v1.5 新增） | T7 | P0 | 通用 | ①首次启动设置页已有 **14 类预置阈值**（spec §5.3）；②改「电容」默认 20→30，未设个体值的电容按 30 判定；③某器件设个体阈值 10 后**不再**判低库存（个体覆盖）；④阈值填 `abc` **拒绝保存**且原值不变 |
| T13 | 出库/领用 + 按 BOM 领料 + 变动历史页 | T7 | **P0** | 通用 | spec FR-7.1~7.6 |
| T13b | `exporter.js` 自写 xlsx 写入器（inlineStr） | T2 | P0 | 通用 | 导出后**用本项目读取器读回**且逐格一致（§10.1 第 2 步） |
| T13c | 导出格式（lcsc 立创配单 / jlc 嘉立创SMT），含位号分隔符修正与**缺口数量列** | T13b,T9 | P0 | 通用 | spec §4.2 约束全满足；**FR-2.7 只需立创可识别**（v1.5 收窄，不再要求 EDA 回导） |
| T13d | **外部验收：真文件上传立创** | T13c | P0 | **人工** | spec AC-8；失败则回退 `.csv`（§10.1 第 4 步） |
| T14 | 备份/恢复 | T2 | P1 | 通用 | 备份后恢复数据一致 |
| T15 | 桌面快捷方式 + 图标 | T1 | P0 | 通用 | 双击启动 |
| T16 | 离线验收（断网全流程） | 全部 | P0 | 通用 | spec AC-6 |

**依赖图**

```
T1 → T2 → T3 → T4
      │    ├→ T5 → T6 → T7 → T10
      │    │         │     ├→ T11
      │    │         │     ├→ T12
      │    │         │     ├→ T12b（分类阈值设置）
      │    │         │     └→ T13（含按 BOM 领料）
      │    └→ T8 → T9 ─┐
      └→ T13b ────────┴→ T13c → T13d（外部验收·人工）
T1 → T15
全部 → T16
```

> **关键路径**：`T13b → T13c → T13d` 是**风险最高**的一段（自写 xlsx 写入器），
> 且 **T13d 需要用户本人操作**（上传立创）。建议**尽早做 T13b**：它不依赖 UI，
> 做完即可验证"能不能写出合规 xlsx"这个根本问题——**若失败，越早改 `.csv` 越省事**。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `better-sqlite3` 离线编译失败 | 存储不可用 | **已决策用 JSON**（§1.1） |
| Electron 首次 `npm install` 需网络 | 装不上 | 本机已有全局 electron 42.5.0；**直接复用它**，不装新依赖 |
| `xlsx` 库本机不存在 | 解析不可用 | ✅ **已实测解除**：自写零依赖解析器（§1.3） |
| **xlsx 写入未验证** | 导出文件损坏 / 立创不识别 | 见 §10.1 |
| BOM 格式变化（未来 EDA 改版） | 导入失败 | 列映射表化，可配置 |
| 数量单位混淆（`0.1uF` vs `100nF`） | 重复建条 | `normalize` 统一（§3.1） |
| Electron 版本兼容（42.5.0 较新） | API 差异 | 只用稳定 API（`BrowserWindow`、`ipcMain`、`dialog`），不用实验特性 |
| **比对页误操作改库存** | 破坏"比对只读"的信任基础 | spec FR-7.6 + §2.2：领料独立入口，比对页**不得**放领料按钮 |
| **人工核对被绕过** | 数量/参数未确认就入库 | spec FR-1.3 + AGENTS.md 硬规则 2：核对是**唯一**入库通道 |
| 项目未纳入 git | 无法回溯改动 | 见 §10.2 |

> ~~待办：开工前确认 `xlsx` 库可得性~~ → **已完成**，结论见 §1.3。

### 10.1 未验证环节：xlsx 写入（**本工程最高风险点**）

| 环节 | 状态 | 证据 |
|---|---|---|
| **读** xlsx | ✅ 已实测 | 纯 Node 解 zip + `zlib.inflateRawSync`，中文与列结构正确（§1.3） |
| **写** xlsx | ❌ **未验证** | 需手工拼 zip（`deflateRawSync`）+ XML，**尚无一行代码** |

**为什么风险高**：zip 格式细节多（CRC32、local header、central directory），
XML 转义稍错就让 Excel/立创打不开，而**失败是静默的**（文件生成成功但内容坏）。

**对策（分级验收，spec AC-8 已列）**：

1. **T13b 先做最小写入器**：只支持单 sheet + `inlineStr`，不追求通用
2. **自洽验证**：写完后**用本项目自己的读取器读回**，逐格比对
   （读取器已实测可靠，可作参照）——这一步**不依赖任何外部条件**，T13b 内即可完成
3. **外部验证**：真文件上传立创（**唯一**能证明"立创可识别"，需用户执行）
4. **回退方案**：若外部验证失败，改导出 `.csv`
   （立创明确支持 `.csv`，见 spec §4.2）——**代价可接受，不是死路**

### 10.2 版本控制

| 目录 | 是否 git 仓库 |
|---|---|
| `<协作工具目录>`（工具本体） | ✅ 是（`1c7de53` 起，含 `.gitignore`/`.gitattributes`） |
| `<项目根>`（本项目） | ✅ **是**（v1.5 实现期补记：`87dd590` 初版 → `35559bc` 开工提示词，工作树 clean。本行原写"❌ 否"，开工时已 `git init`） |

**要求版本控制的理由**（下面这起事故就是理由本身）：
本项目文档已发生过一次**不可逆损坏**（2026-10-15，PowerShell 按 GBK 读写 UTF-8 文件导致
中文全变乱码，见 `docs/复核报告.md` §十一）——**有版本控制就能一条命令恢复**。

**已入库的 `.gitignore` 含**：`node_modules/`、`data/`（运行时数据）、`.mimocode/`（MiMo 运行时）、
`*.bak-*`、`.corrupt-quarantine/`、`/.addmodel/hub.db`（协作中枢活状态，另有轮转备份）。

**另注：改中文文件禁用 PowerShell 的 `Set-Content`/`-replace`**
（按系统 ANSI 代码页读写，会破坏 UTF-8）。用编辑工具或 `io.open(..., encoding='utf-8')`。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-15 | v1.0 | 初稿，依据 4 份真实 BOM 实测 |
| 2026-10-15 | **v1.1** | 需求确认：①唯一性扩为**五元组**（+容差）并按 **AML 模式支持多 MPN**（附行业依据）；②**新增出库/领用**（T13 升 P0）；③套数不记忆（移除 `remember_sets`）；④阈值**按分类预置**（14 类）；⑤"信号"澄清为**用途 `purpose`**；⑥导出定 **xlsx 且立创可识别**（新增 T13b/T13c，含官方格式硬约束） |
| 2026-10-15 | **v1.1.1** | Q5 终澄清：用户原写"信号"是**笔误，实为「型号」（MPN）**。删除 `purpose`/`net` 字段设想（型号已在数据模型）；修复数据模型示例中 `category` 键重复的 JSON 错误 |
| 2026-10-15 | **v1.2** | 评审后复核优化：①`compare:run` 改为**够用/缺料/疑似**分组并新增 `required_quantity`/`stock_quantity`/`shortfall_quantity`，补全此前缺失的 **CompareItem 字段定义**；②`compare:export` 的 `format` 改为 **`mode`（lcsc/jlc）**，与 Q6 一致；③新增 **`stock:pick_by_bom`** 契约（此前 FR-7.4/7.5 无契约）；④`movements:list` 支持按 `ref` 过滤；⑤任务表同步 |
| 2026-10-15 | **v1.3** | 用户确认后补记三项遗留：①**入口隔离**（spec FR-7.6，比对页禁放领料按钮，§2.2）；②**xlsx 写入风险**显式建章（§10.1 分级验收 + `.csv` 回退 + 新增 T13d 外部验收）；③**版本控制现状**（§10.2）。另：风险表补 3 行，依赖图标注关键路径 |
| 2026-10-15 | **v1.4** | 用户重申并细化**导入核对**要求：①人工确认是**强制**步骤（不可绕过）；②核对阶段即可改，但改的是 **`intake_quantity`（本次入库量）**，`quantity_per_board`/`total_quantity` **只读**（BOM 原值不回写）；③改动**必须留痕**（`expected_quantity`/`intake_quantity`/`edited_by_human`）；④BomItem 新增 2 字段、Movement 新增 3 字段；⑤T6 验收强化；⑥§5.2 补分类前缀重叠匹配规则 |
| 2026-10-15 | **v1.5** | **采纳 mimo 详审（`R_dded4bac`）的两项 changes**：①**P0-1** FR-4.6/4.7/4.8 与 AC-9 此前**无实现载体** → 新增 **T12b 分类与阈值设置**（验收含 AC-9 四步），并给 `settings:set` 补**字段级校验**（`default_min_quantity` 非数字须拒绝且原值不变）；②**P0-2** FR-2.7 的"回导 EDA"要求经用户澄清系**规格措辞过宽**（用户："我只需要立创商城可以识别，除此之外无要求"）→ **收窄 FR-2.7**，不加 `eda` 模式；③修正任务书误记"14 个通道"（实为 15）；④依赖图补 T12b |
| 2026-10-15 | **v1.5（实现期补记）** | 开工实现期（T1 解析链；T13b 写入器复用同一底座）的补缺与现状校正，**不改 spec、不改版本号**：①**§6 补 `BomItem.tolerance`**——spec FR-1.6 明列「容差」为核对阶段可改字段，spec §5.2 又把容差列为五元组判定键成员，且 CompareItem 早已有该字段，原 BomItem 漏项会使解析出的容差无处安放、入库合并无法算判定键；②§8 目录结构补两个**读/写共用**模块 `zip_container.js`（zip 信封：EOCD/中央目录/CRC32/压缩方法）与 `xlsx_xml.js`（单元格坐标 + XML 实体编解码），理由是 xlsx 为本工程最高风险点（§10.1），读写各写一份必然"两份实现各错一半"（AGENTS.md 反重复）；③§10.2 版本控制现状由"❌ 否"更正为"✅ 已 git init"（`87dd590`→`35559bc`）；④**未改 spec**：实现期另发现 spec 附录 A/B 与实际数据不符（已立待确认任务），因 spec 是验收唯一信源，**留待用户确认后再动**。 |
| 2026-10-15 | **v1.5（实现期补记 2）** | **T5：plan 与代码对齐**（实现期结束时的文档补齐，**仍不改 spec、不改版本号**）：①**§6.5 新增"契约补记"节**，把实现期超出原契约的 **4 处**逐条写明"为什么必须补 + 影响面"——新通道 `parts:export`（FR-5.5 无载体）、`parts:list.sort_by/sort_dir`（FR-5.1）、`settings:set.confirm_data_dir`（AGENTS.md 需人工确认）、`bom:commit.sets/source/reason`（FR-1.8 与 v1.4 留痕）；**通道数 15 → 16**，`channels.js` 已同步，preload 白名单自动跟随。另**更正一处误登记**：曾把 `compare:export.include_uncertain` 当作扩展，核对后发现它**本来就在 §6.2 里**，已撤回。②**§8 目录树按实现结果补全**：新增 `services/{low_stock,parts,export_format}.js`、`ipc/{channels,extensions}.js`、`renderer/model/` 六个规则模块、`renderer/pages/` 六个页面、`assets/icon.ico`、`tests/` 与 `tools/` 的实际文件；并说明 `renderer/model/` 这一层的由来（页面规则抽成纯逻辑才可无头断言）。③**§9 任务表状态**：T0~T16 全部实现，其中 T13b（自写 xlsx 写入器）与 T13c（导出格式层）按 §10.1 的分级验收执行——**同源回读 + 跨实现判卷**双证；T16 离线全流程验收一次跑完 AC-1~AC-9（PASS 38 / FAIL 0 / 待人工 2）。④**验收口径**：`tests/run_all.js` 一条命令跑完 20 个套件；`tests/test_acceptance_full.js` 按用户真实使用顺序在同一个库上走完全流程并生成验收报告。⑤**仍待用户裁决**（**未擅改 spec**）：附录 A/B 与实测不符、阈值留空语义冲突（AC-4 vs FR-4.8/AC-9）、`BomItem.location/min_quantity` 缺载体。 |
| 2026-10-16 | **v1.5（实现期补记 3）** | **反重复清理与文档收口**（仍**不改 spec、不改版本号**）：①新增 `src/services/ids.js` 作为**运行号/时间戳/序 id 的唯一实现**——此前 `YYYYMMDD_HHMMSS` 在 5 处各写一份（`bom_parser.makeBatchId`、`compare.makeCompareId`、`ipc/handlers.makeRunId` 与 `defaultExportName`、`store.timestamp`）、`p_0001` 序 id 在 `parts.js` 与 `inventory.js` **逐字重复**（AGENTS.md 反重复规则明令禁止保留两份；同一件事有两个真相，改精度必漏一处）；②顺带修一处**时钟没接通**：`bom:parse` / `compare:run` / `stock:pick_by_bom` 三个 handler 调解析时未传注入的 `now`，于是运行号取自墙上时钟、测试无法钉死——现已统一传 `clock()`；③`tests/run_all.js` 由**逐条登记**改为**扫描 `tests/test_*.js`**：实现期每加一个套件都要回来改这个与测试内容无关的文件（改错过一次顺序），现在新套件放进去就会被跑到，**漏登记不会导致漏测**；④§8 目录树补 `ids.js`。**未采纳的建议**：`dialog:saveFile` 通道——收益（少手输一次路径）不足以抵消契约再扩一次通道的代价（plan §1 明确"不做安装包、直接运行"，导出默认名已含时间戳且可手输），故**不新增该通道**。 |
| 2026-10-16 | **v1.5（实现期补记 4）** | **对抗性审计 → 缺陷修复批次**（仍**不改 spec、不改版本号**）。背景：两轮**独立上下文**的对抗性审计（报告：`.addmodel/upload/audit-findings.md` + 评审件）报了 9 条**能举证的**真缺陷，全部**先自己复现再修**，并逐条固化成回归用例 `tests/test_audit_fixes.js`（17 条）。修复清单：①**按 BOM 领料同判定键多行重复扣减 → 库存变负**（`pickByBom` 按器件累计"本批已规划扣减"，只用剩余可用量判充足；`allow_partial=false` 的整单拒绝这才真正生效）；②**恢复备份"边读边写"**（改为**全部读入并校验后再写**；校验 schema_version 与形状；**恢复不覆盖 `data_dir`**——那是机器本地设置，照搬会写到别的路径并绕过确认闸门；**空库的备份（只有 manifest+settings）现在也能恢复**）；③**核对表「备注」静默丢弃**（FR-1.6 可改字段，补进 `newPartFromItem`/`mergePartInfo`）；④**疑似条目导出数量列恒为 0**（按 spec §4.2 公式补 `shortfall_quantity = max(0, 需求−候选库存)`）；⑤**变动记录逐条写**（新增 `store.appendMovements` 批量一次写 + parts 写失败时 `dropMovements` **补偿**——"要么两边都成，要么都不留"，不再留同 ref 的幽灵留痕）；⑥`stock:move` 不再透传契约外的 `kind`/`ref`，且 `kind` 与 `delta` 方向必须自洽；⑦**删除器件不留痕 + id 被复用**（补 `adjust` 留痕；`nextPartId` 把变动记录的 `part_id` 也算进"用过的号"）；⑧`stock:pick_by_bom` 服务端**补上 `reason` 必填校验**（原先只有界面拦）；⑨运行号撞车加后缀（见 §6.5 第 8 条）。**另**：`compare:export` 改用**只读**取设置（`store.peekSettings`），修掉"比对顺手写出一个 settings.json"（FR-2.6）。**审计里两条"未验证疑点"也已处置**：⑩变动记录排序改为**按真时间**（`Date.parse` 数值比较）——原来比字符串，`at` 混着不同时区偏移时（换机器恢复备份、系统时区/DST 变化）先后会排错；⑪`bom:commit` 闸门**从"只认 batch_id"加强为"还认该批次解析出的行号集合"**——只认号的话，调用方拿到一个号就能塞进**解析时根本没有的条目**；用 `row_no` 当凭据，是因为它**不在 FR-1.6 的可改字段里**，逐字段比对反而会把合法编辑判成伪造（两条都有回归用例）。 |
| 2026-10-16 | **v1.5（实现期补记 5）** | **第三轮对抗性审计（换面：`renderer/model`、xlsx 写入侧、`main.js`/`preload.js`）→ 修复**（仍**不改 spec、不改版本号**）。报告：`.addmodel/upload/audit-findings-r3.md`。①**离线机制补严**（FR-6.1）：原来只订阅了 5 种 URL scheme，**没有** `setWindowOpenHandler`、**没有** `will-navigate`——审计用桩 Electron 跑真 `main.js` 实测 `setWindowOpenHandler = NOT-SET`；且原注释自称"拦截**一切**外部请求"，**注释比实现更满**。现补上两道闸（新窗口一律 deny；顶层导航只放行自己的 index.html，用 `fileURLToPath` 解析）并把注释改成如实描述；②**写入器补单元格长度闸**：行/列数早有守卫、文本长度没有——超过 Excel 上限（32767）会让文件被判"损坏"。常量 `MAX_CELL_CHARS` 收进 `xlsx_xml`（读写两侧共用一处），写入器**默认报错**、导出层**截断+警示**（`buildLibraryRows` 也补上，此前只有配单导出做了）；③**参数列顺序改为照 spec 的拼写规范示例（line 272）与 AC-8 验收表（line 525）**：`值 → 容差 → 耐压 → 材质`（+功率、载流）。**这暴露了 spec 的第三处自相矛盾**：spec line 239 的列来源表写的是 `value + voltage + dielectric + tolerance`，与上述两处不同；取舍理由见下方"待裁决"——**已立任务等用户拍板**；④`settings_model.validateThreshold` 拒绝类型不对的值（`true`/`[]`/`["7"]` 不再被 `Number()` 强转）；⑤`settings_model.lowStockLines` 对数组元素补 `|| {}` 兜底（原来遇 `null` 抛 TypeError → **设置页整屏白**）；⑥`readZipEntries` 遇**重名条目**报错而不是静默覆盖（规范化：变体 zip 构造器抽到 `tests/fake_zip.js`，两处共用）。 |
| 2026-10-16 | **v1.5（实现期补记 6）** | **AC-8 外部验收通过 + 人工签收机制**（仍**不改 spec、不改版本号**）：①**用户实测：导出文件上传立创商城 BOM 智能云表，识别成功**——这是 AC-8 的**外部一级**验收，也是本工程此前唯一无法自证的环节（工具完全离线、没有任何上传通道，属设计而非缺失）。与内部的"独立实现判卷"（Python zipfile/xml.etree/openpyxl）合起来，AC-8 的两级都齐了。②为此新增**可撤销的人工签收机制**：`tests/test_acceptance_full.js` 读 `.addmodel/human-signoff.json`，某键 `verified:true` → 该项记为「✅ 通过（人工验证）」并把 at/by/note 写进报告证据列，没有记录 → 仍记「⏸ 待人工」。**为什么不直接在报告里写一句"已通过"**：报告每次运行都重新生成，手写的一句会被冲掉；而签收文件**可审计、可撤销**——删掉记录，该项下次跑就自动回到"待人工"。**这一版我发现并修掉自己一个静默 bug**：第一版把整个查找包在 try 里，自己写错变量名（用了未定义的 `PROJECT_ROOT`，本文件里叫 `ROOT`），ReferenceError 被吞掉 → 已签收的项**静默**显示成"待人工"；现在只有"文件不存在"才返回未签收，**记录损坏一律抛错**。③**快捷方式**：`tools/make-shortcut.ps1` 跑通并已在工作区生成 `元器件管理.lnk`（用 COM 读回校验：目标/工作目录/图标），并已复制到用户桌面。**记账**：脚本本身没坏——是**我这边的沙箱不允许写工作区之外的路径**（往桌面写普通文本同样被拒），所以"放到桌面"这一步必须由用户或提权执行；README 里写清了这条与自建快捷方式的位置。 |
| 2026-10-16 | **v1.6（实现期补记 7）** | **快捷方式图标根因 + 两处被实测暴露的问题**（仍**不改 spec 语义、不改版本号**）：①**图标为什么不生效——根因在沙箱 ACL，不在图标**：用户反馈桌面快捷方式显示 Electron/通用图标。定位过程（都是实测，非猜测）：Pillow 独立判卷证明 `assets/icon.ico` 结构合法（3 个尺寸、RGBA、像素正常）→ 用 Windows **shell 自己的 API**（`SHGetFileInfo`）取快捷方式的图标并与我的像素对比 → 渲染出的是**通用快捷方式图标**；再做**四组对照**：`electron.exe,0`（Electron 图标 ✓ 说明 IconLocation 生效）、`shell32.dll,13`（✓）、**工作区外**的现成 .ico（✓）、**工作区内**的 .ico（✗ 通用图标）—— 连 Pillow 现写的红方块 .ico 放进工作区也一样失败，换新文件名同样失败（排除缓存）⇒ **凡是位于工作区内的 .ico，Explorer 的图标渲染路径都读不到**（工作区被沙箱加了 ACL/完整性标签）。**修法**：`make-shortcut.ps1` 自动把图标复制到 `%LOCALAPPDATA%\component_management\icon.ico` 并用**那一份**（复制后做字节一致性校验，失败则明确提示）。修完复验：shell 渲染的中心像素由 `(250,250,250)`（通用）变为 **`(243,244,246)`（我的图标）** ✓ ②**我改脚本时把 UTF-8 BOM 弄丢了**：编辑工具保存后 .ps1 无 BOM，PS 5.1 按系统 GBK 解释中文 → 整片乱码 → **语法错误、脚本静默没生效**（表现是"改了但没变化"）。已补 BOM，并额外用 PS 5.1 自己的解析器做语法自检；此类文件（含中文的 .ps1）**必须存为带 BOM 的 UTF-8**，已列入踩坑清单。③**测试隔离断言改快照比对**：旧写法断言"项目 `data/` 必须不存在"，在**用户真的双击用过工具之后必然变红**（真实库本就该被建起来）——那是正常使用，不是测试污染。新增共享助手 `tests/real_data_guard.js`：套件加载时给 `data/` 拍快照（相对路径 + 大小 + mtime + 内容哈希），断言时再拍一次比对，**只守"本套件没碰真实库"**；`test_store.js` / `test_main_wiring.js` 两处改为调用它。 |
| 2026-10-16 | **v2.1** | **分类统一（用户裁定①）**：`category` 存立创中文名；`src/services/categories.js` 为映射与阈值的单一来源（类表照 spec §5.3）；`lcsc_statement.thresholdKey` 未命中时改查该模块；`parts.js` 保存时校验分类；AC-9 增补四行。 |
| 2026-10-16 | **v2.0** | **核心承诺修订（用户拍板）**：spec `FR-6.1` 由「完全离线」改为「默认完全离线 + 云同步显式可选」。同步模型采用**不可变 `movements` 追加**（离线照常、联网后按 id 去重幂等推拉、并集即合并、库存由 movements 校正），因此**无需冲突合并**；器件元数据冲突进人工裁决。服务端为**零依赖 Node 单文件**；令牌用 `safeStorage` 加密存于 `data/` 之外。实现按提案 §11.5 七步走：契约与 AC 行随各自实现同时落地。 |
| 2026-10-16 | **v1.8** | **核对表人工可改**（FR-8.8 / AC-10:7）：契约新增 `decisions[].overrides`（服务端校验后合并：入库量非负整数、值非空）；模型 `setFieldEdit/buildOverrides`、页面可改输入框与「改过」标记、summary 报 `edited_count`。另：**架构整理**——三份「找表头行」实现合并为 `services/table_header.js` 一份（反重复）；删掉未使用的死变量与第二份 id 生成器（id 唯一实现仍是 `services/ids.js`）。 |
| 2026-10-16 | **v1.7** | **新增「按对账单入库」（FR-8 + 契约 §6 两个通道）**：①§6 新增 `statement:parse` / `statement:commit`（补记 9/10 就地写在契约处）；②实现落在 `services/{xls_biff,lcsc_statement,statement_match,statement_commit}.js`，**四个模块各有独立套件**（9/9、11/11、11/11、9/9）；③**用用户给的真实对账单做基准**（25 列表头逐字、抽样逐格、数值自洽 50×0.0816=4.08）——这是对「上一轮只拿合成样例验解析器」那个盲区的直接纠正；④**导出与比对一行未改**（用户要求）。剩余：核对表界面与 新的 AC 组 见证（T48）。 |
| 2026-10-16 | **v1.6** | **用户裁决三处 spec 内部矛盾 → spec 首次变更、plan 同步**（这是本工程开工以来 **spec 第一次被修改**；按 AGENTS.md「spec 是验收唯一信源，要改必须先与用户确认」，本次改动**逐条取得用户裁定**后才动）：①**阈值留空 = 继承分类默认阈值**（FR-4.8）——AC-4 第 4 行原写"不提示"，与 FR-4.8/AC-9 第 3 行矛盾；**实现无需改动**（代码本来就是继承语义），改的是 AC-4 那一行的措辞，并写明"要显式不提示请填 0"；②**参数列顺序按立创规范**（§4.2 参数拼写规范示例 `100nF ±10% 50V X7R` = 值→容差→耐压→材质）——§4.2 列来源表原写 `value + voltage + dielectric + tolerance`，与示例及 AC-8 验收表矛盾；**实现无需改动**（v1.5 起代码即按立创示例输出），改的是列来源表那一行；③**附录 A 计数口径**改为**有效条目**（33/37/35/53；原写 34/36/54 是含表头的表格行数），**附录 B** 的"一致性 100%"按实测校正为"**修正版 3 处不符（No.1/2/12）**，其余 3 份 0 处"——并注明这 3 行正是 FR-1.5「数量与位号个数不符需人工裁决」的真实触发来源。**影响面**：三处都是"文档与实测/自身不一致"，**没有一处需要改实现**（改前已逐条核对代码行为与裁定语义一致）；spec 指纹由 `ea2d7da8a76ea980`（35117 字节，开工至 v1.5 全程未动）变为新值，验收与门禁全部重跑。 |

**第三处 spec 自相矛盾（`参数` 列顺序）——已由 v1.6 裁决解决**：spec 的列来源表原写 `value + voltage + dielectric + tolerance`，
而 §4.2 参数拼写规范示例与 AC-8 验收表都写 `100nF ±10% 50V X7R`（值→容差→耐压→材质）。
用户 2026-10-16 裁定**按立创规范**，spec 列来源表已改为与示例/AC-8 一致（见 `docs/spec.md` v1.6 行），
代码侧**无需改动**（自 v1.5 起即按立创示例输出，实测 `100nF ±10% 50V X7R` ✓）。**本条不再是待裁决项。**
