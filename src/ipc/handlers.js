"use strict";
/**
 * handlers.js — IPC 注册（**薄层**，plan §2 架构图：唯一的业务入口）
 *
 * 职责只有三件：①参数转交 service；②把结果/异常包成 `{ok:true,…}` / `{ok:false,error}`
 * （AGENTS.md 标准做法③）；③**按固定顺序落盘**。业务规则一律在 services 里，这里不写。
 *
 * 两条本层独有的约定：
 *
 * ① **落盘顺序：先写变动记录，再写 parts**（FR-4.5）
 *    parts 与 movements 是两个文件，rename 各自原子但两者之间仍有窗口。
 *    若先写 parts：崩在中间 → 库存变了却没有痕迹，**违背"任何数量变动都要留痕"**。
 *    若先写 movements：崩在中间 → 留一条对不上的痕迹（可人工核对、可删除），
 *    代价小得多。**两个坏结果里选轻的那个**，并在此写明理由。
 *
 * ② **运行号（batch_id / pick_id / compare_id）由本层生成**
 *    service 保持纯函数（不知道"这是哪一次操作"）。这样也避免每个 service 各造一个
 *    时间戳生成器——目前 bom_parser 与 compare 各有一个同形态函数，等它们在审的改动落定后
 *    应合并成一处（已记入待办）。
 *
 * 本模块**不 require electron**：Electron 相关的只有 `bom:pick_files` 的对话框，
 * 它以 `deps.pick_files` 注入 → 于是本层可以在纯 Node 下被完整测试（见 tests/test_ipc_handlers.js）。
 */

const path = require("path");

const bomParser = require("../services/bom_parser");
const compareSvc = require("../services/compare");
const exporter = require("../services/exporter");
const exportFormat = require("../services/export_format");
const inventory = require("../services/inventory");
const partsSvc = require("../services/parts");
const storeSvc = require("../services/store");
const ids = require("../services/ids");
const { CHANNELS } = require("./channels");

/** 比对结果缓存条数（compare:export 按 compare_id 取回当次结果） */
const COMPARE_CACHE_LIMIT = 5;

/** 记住最近发出的批次号条数（bom:commit 的闸门用，见下） */
const ISSUED_BATCH_LIMIT = 20;

/** 运行号：`${prefix}_YYYYMMDD_HHMMSS`（时间戳实现统一在 services/ids） */
function makeRunId(prefix, when) {
  return ids.makeRunId(prefix, when);
}

/**
 * 进程内唯一的运行号。
 *
 * 审计发现：时间戳只到**秒**，同一秒内做两次同类操作会拿到**同一个** ID——
 * 于是两次领料共用一个 `pick_id`、两份 BOM 共用一个 `batch_id`、
 * `compare:export` 可能导出另一次比对的结果（AC-7「同一批次」的语义直接被破坏）。
 * 真人手速下"同一秒两次"确实少见，但**少见不等于不会**：连点两次按钮就到了。
 *
 * 做法：先取标准形态；若该号已被本进程用过，就追加 `-2`/`-3`…（标准形态一字不变，
 * 只有真撞车时才多一个后缀），并登记进 `issuedRunIds`。
 */
function nextRunId(prefix, when, taken) {
  const base = ids.makeRunId(prefix, when);
  if (!taken.has(base)) { taken.add(base); return base; }
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  throw new Error(`运行号生成失败：${base} 在后缀 2~999 内都被占用了`);
}

function defaultExportName(mode, when) {
  const stamp = ids.stamp(when);
  // spec FR-2.8：不指定文件名时，默认名要含时间戳
  if (mode === "library") return `器件库_${stamp}.xlsx`; // FR-5.5：导出当前库
  return `${mode === "jlc" ? "嘉立创SMT" : "立创配单"}_${stamp}.xlsx`;
}

/**
 * 建一组 IPC handler。
 * @param {{store?: object, pick_files?: Function, now?: Function}} [deps]
 *   `pick_files` 由 main.js 用 Electron dialog 注入；缺省时返回空数组（无头环境）。
 */
function createHandlers(deps = {}) {
  const db = deps.store || storeSvc;
  const pickFiles = typeof deps.pick_files === "function" ? deps.pick_files : async () => [];
  const clock = typeof deps.now === "function" ? deps.now : () => new Date();
  const compareCache = new Map();
  // 本会话内 `bom:parse` 发出过的批次号，以及**该批次解析出来的行号集合**。
  // `bom:commit` 只认这些——这是"不得一键静默导入"（spec FR-1.3 / AGENTS.md 项目硬规则 2）
  // 在**接口层**的那一半：没经过解析（= 没进过核对流程）的批次号直接拒绝，堵住"绕过核对直接写库"。
  //
  // **v1.5 实现期补记（审计发现）**：只认 batch_id 太弱——调用方只要记住一个号，
  // 就能塞进**解析时根本没有的条目**。现在把该批次解析出的 `row_no` 集合一起记住，
  // 提交的每一行都必须来自这个集合。**为什么用 `row_no` 而不是整行**：
  // FR-1.6 允许核对阶段改 值/封装/耐压/材质/容差/库位/阈值/备注/本次入库量，
  // 逐字段比对会把合法编辑判成伪造；而 `row_no`（BOM 的 No. 列）**不在可改字段里**，
  // 正好当"这一行确实来自那份 BOM"的凭据。
  const issuedBatches = new Map();

  /** 本会话内发出的**全部**运行号（批次/比对/领料共用）——保证同秒重复运行也不会撞号 */
  const issuedRunIds = new Set();

  // ---------------------------------------------------------------------------
  // **入库幂等闸门**（对抗审计 A1/A2，2026-10-17 实测：同批次再提交一次，数量 8→16 / 55→110）
  //
  // AGENTS.md 硬规则 4：危险操作必须有**两层**闸门 —— 按钮 disabled（页面）+ 服务端拒绝（这里）。
  // 之前只有"解析过"一层：只要 batch_id 还在 issuedBatches 里，就能反复 commit，每次都再加一遍数量。
  // 现在：**同一批只允许入库一次**。重复提交直接拒绝，库一个字节都不动。
  //   · bom:commit      → 用 batch_id 当幂等键
  //   · statement:commit → 没有批次号，用「对账单路径 + 决定内容」的指纹当幂等键
  // 只在本进程内有效（重启清空）：同一份文件**重新解析**后再入库是合法的新操作（可能真又买了一次）。
  // ---------------------------------------------------------------------------
  const CONSUMED_LIMIT = 200;
  const consumedBatches = new Set();
  const consumedStatementCommits = new Set();

  /** 记一条已消费指纹；超过上限就丢最旧的（Set 保持插入序） */
  function rememberConsumed(set, key) {
    set.add(key);
    while (set.size > CONSUMED_LIMIT) set.delete(set.keys().next().value);
  }

  /** 决定的规范化指纹：字段顺序固定，避免"内容一样但键序不同"被判成新的一批 */
  function statementCommitFingerprint(filePath, decisions) {
    const canon = (Array.isArray(decisions) ? decisions : []).map((d) => {
      const item = d || {};
      const overrides = item.overrides && typeof item.overrides === "object"
        ? Object.keys(item.overrides).sort().map((k) => [k, item.overrides[k]])
        : [];
      return [Number(item.row_no), String(item.action || ""), String(item.part_id || ""), overrides];
    });
    return `${String(filePath || "")}\u0000${JSON.stringify(canon)}`;
  }

  function rememberBatch(batchId, items) {
    if (!batchId) return;
    // 记住这个批次解析出来的行号（当作"这些行确实来自那份 BOM"的凭据）
    const rows = new Set((Array.isArray(items) ? items : [])
      .map((it) => String((it && it.row_no) == null ? "" : it.row_no))
      .filter((r) => r !== ""));
    issuedBatches.set(String(batchId), rows);
    while (issuedBatches.size > ISSUED_BATCH_LIMIT) {
      issuedBatches.delete(issuedBatches.keys().next().value);
    }
  }

  const ok = (payload) => Object.assign({ ok: true }, payload || {});
  const fail = (error) => ({ ok: false, error: String((error && error.message) || error) });

  /**
   * 见文件头 ①：movements 先落盘，parts 后落盘。返回真正落库的变动记录（store 已赋 id/at）。
   *
   * **批量写 + 失败补偿**（审计发现：原来是逐条 appendMovement = N 次原子写）：
   * 一次入库会产生几十条变动记录，逐条写时中途失败会留下"前 k 条已落盘、器件一条没改"的
   * 幽灵留痕，而重试那批与它共用同一个 ref，事后分不出真假（实测过）。
   * 现在：①变动记录**一次**批量写；②若随后 parts 写失败，把刚写的那些变动记录**撤掉**——
   * 宁可"两边都没有"，也不要留下一批解释不了的历史。
   */
  function persist(result) {
    const pending = [];
    if (Array.isArray(result.movements)) pending.push(...result.movements);
    if (result.movement) pending.push(result.movement);
    const stored = pending.length > 0 ? db.appendMovements(pending) : [];
    if (!result.parts) return stored;
    try {
      db.saveParts(result.parts);
    } catch (exc) {
      // 补偿：器件没落盘，就把刚写的留痕撤掉（dropMovements 是可选能力，老 store 没有就跳过）
      if (stored.length > 0 && typeof db.dropMovements === "function") {
        try { db.dropMovements(stored.map((m) => m.id)); } catch (ignored) { /* 补偿失败不掩盖原始错误 */ }
      }
      throw exc;
    }
    return stored;
  }

  function rememberCompare(record) {
    compareCache.set(record.compare_id, record);
    while (compareCache.size > COMPARE_CACHE_LIMIT) {
      compareCache.delete(compareCache.keys().next().value);
    }
  }

  /** 导出路径：相对路径按"上次打开 BOM 的目录"解析；不指定则用含时间戳的默认名（FR-2.8） */
  function resolveOutputPath(requested, settings, mode = "lcsc") {
    const raw = String(requested == null ? "" : requested).trim();
    const baseDir = String((settings && settings.last_used_dir) || "").trim()
      || path.dirname(db.paths().data_dir);
    if (raw === "") return path.join(baseDir, defaultExportName(mode, clock()));
    const resolved = path.isAbsolute(raw) ? raw : path.join(baseDir, raw);
    return /\.xlsx$/i.test(resolved) ? resolved : `${resolved}.xlsx`;
  }

  const handlers = {
    /* ------------------------------------------------------------ BOM */

    "bom:pick_files": async () => {
      try {
        const file_paths = await pickFiles();
        return ok({ file_paths: Array.isArray(file_paths) ? file_paths : [] });
      } catch (exc) {
        return fail(exc);
      }
    },

    "bom:parse": async (req) => {
      const r = req || {};
      try {
        const parsed = bomParser.parseBomFile(r.file_path, r.sets, { now: clock() });
        if (parsed.ok) {
          // 同一秒内解析两份 BOM 会拿到同一个 batch_id（审计发现）→ 换成进程内唯一的号。
          // 否则两次入库的留痕会被 ref 归成"同一批"，AC-7 的批次语义就乱了。
          if (issuedRunIds.has(parsed.batch_id)) parsed.batch_id = nextRunId("batch", clock(), issuedRunIds);
          else issuedRunIds.add(parsed.batch_id);
          rememberBatch(parsed.batch_id, parsed.items);
        }
        return {
          ok: parsed.ok, error: parsed.error, batch_id: parsed.batch_id,
          items: parsed.items, warnings: parsed.warnings,
        };
      } catch (exc) {
        return fail(exc);
      }
    },

    "bom:commit": async (req) => {
      const r = req || {};
      try {
        // 服务端闸门（spec FR-1.3：入库必须经过解析/核对流程，不得一键静默导入）。
        // 只认本次会话 `bom:parse` 发出过的批次号；认不出就拒绝并说明该怎么办。
        const batchKey = String(r.batch_id == null ? "" : r.batch_id);
        // **幂等闸门**：这一批已经入过库了 → 直接拒绝（否则连点两次按钮数量就翻倍）
        if (consumedBatches.has(batchKey)) {
          return {
            ok: false,
            error: "这一批已经入过库了（同一次解析只允许入库一次，防止数量翻倍）。"
              + "要再入一次，请重新选择 BOM 文件并逐条核对后再提交。",
            added: 0, merged: 0, skipped: 0, parts: [],
          };
        }
        const parsedRows = issuedBatches.get(batchKey);
        if (!parsedRows) {
          return {
            ok: false,
            error: "这批条目没有经过解析与核对流程（batch_id 无效或已过期），已拒绝入库。"
              + "请重新选择 BOM 文件、逐条核对后再点「确认入库」。",
            added: 0, merged: 0, skipped: 0, parts: [],
          };
        }
        // 行号必须来自该批次解析出的集合（解析时没有 No. 列则跳过这条检查——那时无从校验）
        if (parsedRows.size > 0) {
          const foreign = (Array.isArray(r.items) ? r.items : [])
            .filter((it) => !parsedRows.has(String((it && it.row_no) == null ? "" : it.row_no)));
          if (foreign.length > 0) {
            return {
              ok: false,
              error: `入库条目里有 ${foreign.length} 行不是这份 BOM 解析出来的（第 `
                + `${foreign.slice(0, 5).map((it) => (it && it.row_no) || "（无行号）").join("、")} 行），已拒绝入库。`
                + "核对表只能提交它自己解析出来的行。",
              added: 0, merged: 0, skipped: 0, parts: [],
            };
          }
        }
        const result = inventory.commitBom(r.batch_id, r.items, db.loadParts(), {
          // movements 要传进去：新建器件的 id 不能复用"已删器件留在变动记录里的号"（审计发现）
          sets: r.sets, source: r.source, reason: r.reason, now: clock(), movements: db.loadMovements(),
        });
        persist(result);
        rememberConsumed(consumedBatches, batchKey); // 幂等：这一批之后不许再提交
        // plan §6：响应含 added/merged/skipped/parts（另给界面显示用的明细）
        return ok({
          added: result.added, merged: result.merged, skipped: result.skipped,
          parts: db.loadParts(), skip_details: result.skip_details, errors: result.errors,
          summary: result.summary,
        });
      } catch (exc) {
        return fail(exc);
      }
    },

    /* ------------------------------------------------------------ 比对 */

    "compare:run": async (req) => {
      const r = req || {};
      const empty = { compare_id: "", enough: [], shortfall: [], uncertain: [], stats: { total: 0, enough: 0, shortfall: 0, uncertain: 0, no_stock: 0, insufficient: 0 } };
      try {
        const sets = r.sets == null ? 1 : r.sets;
        const parsed = bomParser.parseBomFile(r.file_path, sets, { now: clock() });
        if (!parsed.ok) return Object.assign({ ok: false, error: parsed.error }, empty);
        const result = compareSvc.compareBom(parsed.items, db.loadParts(), sets);
        if (!result.ok) return Object.assign({ ok: false, error: result.error }, empty);
        // 人工裁决（比对页的「是同一颗/不是同一颗」按钮）：**只调整这份结果的分组与导出内容**，
        // 不写库、不产生变动记录（FR-2.5/2.6 仍然成立）。
        const adjusted = compareSvc.applyRulings(result, r.rulings == null ? null : r.rulings);
        if (!adjusted.ok) return Object.assign({ ok: false, error: adjusted.error }, empty);
        // 同一秒内重复比对也要拿到不同的 compare_id（否则 compare:export 可能导出另一次的结果）
        const compare_id = nextRunId("compare", clock(), issuedRunIds);
        // 缓存当次结果供 compare:export 使用（**只缓存，不落盘**：比对永远只读）
        rememberCompare({ compare_id, file_path: r.file_path, sets, result: adjusted });
        return ok({
          compare_id, enough: adjusted.enough, shortfall: adjusted.shortfall,
          uncertain: adjusted.uncertain, stats: adjusted.stats,
        });
      } catch (exc) {
        return fail(exc);
      }
    },

    "compare:export": async (req) => {
      const r = req || {};
      try {
        const cached = compareCache.get(String(r.compare_id));
        if (!cached) {
          return { ok: false, error: "找不到该比对结果（可能已过期），请重新比对后再导出", exported_count: 0, file_path: "" };
        }
        // **只读取设置**：`loadSettings()` 首次调用会写盘，而 spec FR-2.6 要求比对全过程只读
        // （验收用"前后字节快照"证明）——审计实测过：全新库里 compare:run 不产生文件，
        // compare:export 却凭空写出一个 settings.json。
        const settings = typeof db.peekSettings === "function" ? db.peekSettings() : db.loadSettings();
        const mode = String(r.mode == null || r.mode === "" ? settings.export_mode : r.mode);
        const items = r.include_uncertain === true
          ? cached.result.shortfall.concat(cached.result.uncertain)
          : cached.result.shortfall;
        const built = exportFormat.buildRows(items, mode); // 未知 mode 会在这里抛错
        const filePath = resolveOutputPath(r.output_path, settings, mode);
        exporter.writeXlsx(filePath, {
          sheet_name: mode === "jlc" ? "SMT 贴片" : "立创配单",
          rows: built.rows,
          date: clock(),
        });
        // spec FR-2.4：导出只含缺料（include_uncertain 为真时才把"疑似"一并带上）
        return ok({ exported_count: items.length, file_path: filePath, warnings: built.warnings, mode });
      } catch (exc) {
        return fail(exc);
      }
    },

    /* ------------------------------------------------------------ 器件 */

    "parts:list": async (req) => {
      const r = req || {};
      try {
        const settings = db.loadSettings();
        const result = partsSvc.listParts(db.loadParts(), r.query || {}, settings);
        return ok({
          parts: result.parts,
          low_stock_ids: result.low_stock_ids,
          total: result.total,
          all_total: result.all_total,
          // 「相似产品」检索（用户 2026-10-17 目标）：这些 id 是"写法不同但值相同/型号归一相同"的命中，
          // 界面标出来让用户知道为什么它出现在结果里（不是精确字面命中）。
          similar_ids: result.similar_ids,
          // 筛选下拉框的候选值（用**全部**器件算，不受当前筛选影响）
          facets: result.facets,
        });
      } catch (exc) {
        return fail(exc);
      }
    },

    "parts:save": async (req) => {
      const r = req || {};
      try {
        const parts = db.loadParts();
        // 合并人工闸门在**业务层**（对抗审计 C2：这里只透传人的选择）。
        // savePart 发现"同规格但没确认"会抛 code=NEEDS_CONFIRM_MERGE 的类型化错误，下面 catch 里
        // 映射成 `needs_confirm` 响应（契约不变：plan §6 parts:save 的 v2.2 响应字段）。
        // movements 要传进去：新器件的 id 不能复用"已删器件留在变动记录里的号"（审计发现）
        const result = partsSvc.savePart(r.part, parts, {
          now: clock(),
          movements: db.loadMovements(),
          confirm_merge: r.confirm_merge === true,
        });
        persist(result);
        return ok({ part: result.part, created: result.created, merged: result.merged, warnings: result.warnings });
      } catch (exc) {
        if (exc && exc.code === "NEEDS_CONFIRM_MERGE") {
          return ok({
            needs_confirm: true,
            created: false,
            merged: false,
            warnings: [],
            existing_part: exc.existing_part,
            message: exc.message,
          });
        }
        return fail(exc);
      }
    },

    "parts:delete": async (req) => {
      const r = req || {};
      try {
        const result = partsSvc.deletePart(r.part_id, db.loadParts(), { confirm: r.confirm === true });
        // 有库存的器件被删时，补一条 adjust 留痕（"这批库存去哪了"要能查，FR-4.5）
        const stored = persist({ parts: result.parts, movements: result.movement ? [result.movement] : [] });
        return ok({ removed: result.removed, movement: stored[0] || null });
      } catch (exc) {
        return fail(exc);
      }
    },

    /* ------------------------------------------------------------ 库存 */

    "stock:move": async (req) => {
      const r = req || {};
      try {
        // plan §6.3 的 `stock:move` 请求只有 part_id / delta / reason——**不再透传 kind/ref**
        // （审计发现：透传未登记字段能写出 kind:"out" 却 delta:+10 的自相矛盾记录；
        //  界面本来就只发出入库，不需要这两个字段）。
        //
        // **类型边界收紧**（对抗审计 C1，2026-10-17）：契约写明 delta 是 number，
        // 此前服务层用 `Number(delta)` 强转，于是 "5" / true / [2] / {valueOf:()=>3} / " 5 " 都能通过——
        // 契约说 number 就只收 number。业务校验（非 0 整数、库存不足、reason 必填）仍在
        // `inventory.moveStock` 里（**唯一实现**，这里不重复规则，只卡类型）。
        if (typeof r.delta !== "number" || !Number.isSafeInteger(r.delta)) {
          const gotType = r.delta === null ? "null" : (Array.isArray(r.delta) ? "array" : typeof r.delta);
          return fail(`数量变动必须是整数数字（plan §6.3：delta 为 number）；收到 ${gotType}：${String(r.delta)}`);
        }
        const result = inventory.moveStock(r.part_id, r.delta, r.reason, db.loadParts(), { now: clock() });
        const stored = persist(result);
        const part = db.loadParts().find((p) => p.id === stored[0].part_id);
        return ok({ part, movement: stored[0] });
      } catch (exc) {
        return fail(exc);
      }
    },

    "stock:pick_by_bom": async (req) => {
      const r = req || {};
      try {
        const sets = r.sets == null ? 1 : r.sets;
        const parsed = bomParser.parseBomFile(r.file_path, sets, { now: clock() });
        if (!parsed.ok) {
          return { ok: false, error: parsed.error, pick_id: "", picked: [], insufficient: [], unknown: [], movements: [] };
        }
        const pickId = nextRunId("pick", clock(), issuedRunIds);
        const result = inventory.pickByBom(parsed.items, sets, db.loadParts(), {
          pick_id: pickId, reason: r.reason, allow_partial: r.allow_partial === true, now: clock(),
        });
        if (!result.ok) {
          // plan §6：allow_partial=false 且库存不足 → 整单拒绝，**不产生任何变动**
          return {
            ok: false, error: result.error, pick_id: result.pick_id,
            picked: [], insufficient: result.insufficient, unknown: result.unknown, movements: [],
          };
        }
        persist(result);
        return ok({
          pick_id: result.pick_id, picked: result.picked, insufficient: result.insufficient,
          unknown: result.unknown, movements: db.loadMovements().filter((m) => m.ref === result.pick_id),
          parts: db.loadParts(),
        });
      } catch (exc) {
        return fail(exc);
      }
    },

    "movements:list": async (req) => {
      const r = req || {};
      try {
        return ok({ movements: inventory.filterMovements(db.loadMovements(), { part_id: r.part_id, ref: r.ref }) });
      } catch (exc) {
        return fail(exc);
      }
    },

    /* ------------------------------------------------------- 设置与备份 */

    "settings:get": async () => {
      try {
        return ok({ settings: db.loadSettings() });
      } catch (exc) {
        return fail(exc);
      }
    },

    "settings:set": async (req) => {
      const r = req || {};
      try {
        // 改 data_dir 属需人工确认操作（AGENTS.md）；界面确认后带 confirm_data_dir 再调一次
        const settings = db.saveSettings(r.settings, { confirm_data_dir: r.confirm_data_dir === true });
        return ok({ settings });
      } catch (exc) {
        return fail(exc);
      }
    },

    /**
     * FR-5.5：把**当前库**导出成表格文件（"我有什么"，与 compare:export 的"要买什么"不同）。
     * 契约扩展（plan §6 没有这个通道）→ 已登记在 `./extensions.js`，待 T5 并入 plan §6。
     */
    "parts:export": async (req) => {
      const r = req || {};
      try {
        const settings = db.loadSettings();
        const built = exportFormat.buildLibraryRows(db.loadParts(), settings);
        const target = resolveOutputPath(r.output_path, settings, "library");
        // 与 compare:export 同一个约定：rows 的第一行是表头（exporter 只收 rows）
        exporter.writeXlsx(target, { sheet_name: "器件库", rows: built.rows, date: clock() });
        return ok({ file_path: target, exported_count: built.data_count, warnings: built.warnings });
      } catch (exc) {
        return fail(exc);
      }
    },

    /* ------------------------------- 按对账单入库（plan §6；只入库，不碰导出/比对） */

  /**
   * 解析立创对账单并与库中器件对账，**只返回结果供人工核对**，不写任何东西。
   * 三桶：matched（严格命中，可直接合并）/ suspected（**必须人工裁决**）/ missing（新增）。
   */
  "statement:parse": async (req) => {
    const stmt = require("../services/lcsc_statement");
    const matcher = require("../services/statement_match");
    const parsed = stmt.parseStatementFile(String((req || {}).file_path || ""));
    if (!parsed.ok) return fail(parsed.error);
    const buckets = matcher.matchStatement(parsed.items, db.loadParts());
    return ok({
      items: parsed.items,
      warnings: parsed.warnings || [],
      matched: buckets.matched.map((m) => ({ row_no: m.item.row_no, part_id: m.part.id })),
      suspected: buckets.suspected.map((s) => ({
        row_no: s.item.row_no,
        // 候选带上**器件身份快照**：用户 2026-10-17 反馈疑似处理"谁是谁表述不清"——
        // 界面要把"对账单这一行"和"库里这条候选"分别说清楚，只给 part_id 说不明。
        candidates: s.candidates.map((c) => ({
          part_id: c.part.id,
          value: c.part.value == null ? "" : String(c.part.value),
          footprint: c.part.footprint == null ? "" : String(c.part.footprint),
          voltage: c.part.voltage == null ? "" : String(c.part.voltage),
          dielectric: c.part.dielectric == null ? "" : String(c.part.dielectric),
          tolerance: c.part.tolerance == null ? "" : String(c.part.tolerance),
          part_number: c.part.part_number == null ? "" : String(c.part.part_number),
          quantity: Number(c.part.quantity) || 0,
          diff: c.diff,
        })),
      })),
      missing: buckets.missing.map((m) => m.item.row_no),
    });
  },

  /**
   * 按**人工核对后的决定**入库：`decisions = [{ row_no, action: "merge"|"new"|"skip", part_id? }]`。
   * 没有决定就拒绝（FR-1.3：不得静默入库）；决定指向不存在的行/器件也拒绝（不猜）。
   * 落盘复用 `persist()`：变动记录先写、器件后写，器件写失败则撤掉刚写的留痕。
   */
  "statement:commit": async (req) => {
    const request = req || {};
    const stmt = require("../services/lcsc_statement");
    const commitSvc = require("../services/statement_commit");
    const ids = require("../services/ids");
    const parsed = stmt.parseStatementFile(String(request.file_path || ""));
    if (!parsed.ok) return fail(parsed.error);
    const decisions = Array.isArray(request.decisions) ? request.decisions : [];
    if (decisions.length === 0) {
      return fail("没有任何入库决定：核对表必须先逐条确认（不允许静默入库）");
    }
    // **幂等闸门**（对抗审计 A2）：同一份对账单 + 同一组决定只允许入库一次。
    // 审计实测：同一 file_path+decisions 连提两次，数量 55→110。
    const commitKey = statementCommitFingerprint(request.file_path, decisions);
    if (consumedStatementCommits.has(commitKey)) {
      return fail("这份对账单的这组入库决定已经提交过了（防止重复入库导致数量翻倍）。"
        + "要再入一次，请重新选择对账单解析，或修改决定后再提交。");
    }
    const byRow = new Map(parsed.items.map((it) => [it.row_no, it]));
    // **人工改动要带到入库里**（用户要求："按账单入库也需要人工修改功能"）：
    // decisions[].overrides = { intake_quantity?, value?, tolerance?, voltage?, current?, power?,
    //                           polarity?, footprint?, manufacturer_part? }
    // 不校验就采纳的话，界面改了也能被绕过（例如负数数量）。
    const EDITABLE = ["value", "tolerance", "voltage", "current", "power", "polarity", "footprint", "manufacturer_part"];
    const applyOverrides = (item, overrides) => {
      if (!overrides || typeof overrides !== "object") return item;
      const merged = Object.assign({}, item);
      for (const f of EDITABLE) {
        if (overrides[f] === undefined) continue;
        merged[f] = String(overrides[f]).trim();
      }
      if (overrides.intake_quantity !== undefined) {
        const n = Number(String(overrides.intake_quantity).trim());
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`第 ${Number(item.row_no) + 1} 行的人工入库量不合法：「${overrides.intake_quantity}」（必须是非负整数）`);
        }
        merged.quantity = n;
      }
      if (overrides.value !== undefined && String(overrides.value).trim() === "") {
        throw new Error(`第 ${item.row_no} 行的人工「值」不能为空（要跳过这行请用 skip）`);
      }
      merged.edited_by_human = true;
      return merged;
    };
    let editedCount = 0;
    const parts = db.loadParts();
    const indexById = new Map(parts.map((p) => [p.id, p]));
    const merged = [];
    const created = [];
    for (const d of decisions) {
      const raw = byRow.get(d && d.row_no);
      if (!raw) return fail(`对账单里没有第 ${Number(d && d.row_no) + 1} 行（拒绝按未知行入库）`);
      let item;
      try {
        item = applyOverrides(raw, d && d.overrides);
      } catch (exc) {
        return fail(exc.message);
      }
      if (d && d.overrides && Object.keys(d.overrides).length > 0) editedCount += 1;
      const action = String((d && d.action) || "");
      if (action === "skip") continue;
      if (action === "merge") {
        const part = indexById.get(String(d.part_id || ""));
        if (!part) return fail(`第 ${Number(d.row_no) + 1} 行要合并到不存在的器件「${d.part_id}」`);
        merged.push({ item, part });
      } else if (action === "new") {
        created.push(item);
      } else {
        return fail(`第 ${Number(d.row_no) + 1} 行的动作「${action}」不认识（只能是 merge / new / skip）`);
      }
    }
    const plan = commitSvc.planStatementCommit({
      parts,
      merged,
      created,
      order_ref: String(request.order_ref || ""),
      now: clock(),
      next_id: ids.nextPartId,
      existing_movements: db.loadMovements(),
    });
    const stored = persist(plan);
    rememberConsumed(consumedStatementCommits, commitKey); // 幂等：这组决定之后不许再提交
    return ok({
      summary: Object.assign({}, plan.summary, { edited_count: editedCount }),
      movement_ids: stored.map((m) => m.id),
      parts: db.loadParts(),
    });
  },

  "data:backup": async (req) => {      const r = req || {};
      try {
        const backupPath = db.backupTo(r.dir_path, { now: clock() });
        return ok({ backup_path: backupPath });
      } catch (exc) {
        return fail(exc);
      }
    },

    "data:restore": async (req) => {
      const r = req || {};
      try {
        const result = db.restoreFrom(r.file_path, { confirm: r.confirm === true, now: clock() });
        return ok(result);
      } catch (exc) {
        return fail(exc);
      }
    },
  };

  return { handlers, channels: CHANNELS, db, persist, resolveOutputPath, makeRunId, defaultExportName };
}

module.exports = { createHandlers, CHANNELS, makeRunId, defaultExportName };
