"use strict";
/**
 * store.js — 存储层（**唯一写入口**，plan §4）
 *
 * 三条不可退让的规则：
 *   ① **原子写**：同目录 tmp → fsync → rename。断电/写一半时原文件仍完好（spec NFR-4）。
 *      Windows 上 rename 覆盖已存在文件是原子的（libuv 用 MoveFileEx REPLACE_EXISTING）；
 *      若目标正被 Excel 等程序独占，rename 会失败 → 我们**报错并清理 tmp**，绝不留下半个文件。
 *   ② **损坏不静默**：JSON 坏了、schema_version 不认识 → **抛错**。
 *      绝不能"读失败就当空库"——用户看到空库会以为数据没了并重新导入，那才是真的丢数据
 *      （spec AC-6 异常路径「数据文件被其他程序占用时启动 → 给出明确提示，不静默丢数据」）。
 *      读取路径**只读不写**，不擅自搬动用户文件。
 *   ③ **危险操作要显式确认**：`restoreFrom` 与"改 data_dir"必须显式传 confirm，
 *      且恢复前**自动留一份当前备份**（spec AC-6 / NFR-5、AGENTS.md「需人工确认的操作」）。
 *
 * 接口严格照 plan §4（无参形式），同时提供 `createStore({ base_dir })` 以便测试用临时目录——
 * 测试**绝不碰真实 data/**（AGENTS.md：data/ 下真实数据不得用于测试）。
 *
 * 本模块**不含业务规则**（plan §5）：它只管"安全地读写这三个文件"，不判断该不该入库、
 * 不算缺口、不推导分类——那些属于 inventory/compare/categories。
 */

const fs = require("fs");
const path = require("path");
const ids = require("./ids");

const SCHEMA_VERSION = 1;
const PARTS_FILE = "parts.json";
const MOVEMENTS_FILE = "movements.json";
const SETTINGS_FILE = "settings.json";
const BACKUP_DIR_PREFIX = "component_management_backup_";

/** 变动记录种类（plan §3.2 枚举，不得自创） */
const MOVEMENT_KINDS = ["in", "out", "adjust", "init"];

/**
 * 首启写入的设置默认值（plan §3.3 schema + spec §5.3 的 14 类阈值）。
 * 键 = 分类标识（C/R/L/…/_default），值 = 该分类默认低库存阈值。
 */
const DEFAULT_SETTINGS = Object.freeze({
  schema_version: SCHEMA_VERSION,
  data_dir: "",
  default_min_quantity: Object.freeze({
    C: 20, R: 50, L: 10, D: 10, Q: 10, U: 5,
    CN: 5, X: 3, KEY: 5, F: 5, BUZZER: 2,
    LED: 10, H: 10, _default: 5,
  }),
  last_used_dir: "",
  export_mode: "lcsc",
});

/** 允许出现在 settings.json 里的顶层键（plan §3.3） */
const SETTINGS_KEYS = ["schema_version", "data_dir", "default_min_quantity", "last_used_dir", "export_mode"];
const EXPORT_MODES = ["lcsc", "jlc"];

/* ------------------------------------------------------------------ 小工具 */

/** 本地时间的 ISO 串（带时区偏移，如 2026-10-15T10:00:00+08:00，照 plan §3.2 形态） */
function nowIso(when) {
  const d = when instanceof Date ? when : new Date();
  const p = ids.pad2; // 补零实现也统一在 ./ids（别再抄第七份）
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** 解析数据目录：空 = 用默认目录；相对路径按 base_dir 解析 */
function resolveDataDir(baseDir, configured) {
  const raw = String(configured == null ? "" : configured).trim();
  if (raw === "") return path.join(baseDir, "data");
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
}

/** `p_0001` / `m_0001` 的下一号（照 plan §3.1/§3.2 的 id 形态）——序 id 实现统一在 `./ids` */
function nextId(existing, prefix) {
  return ids.nextSequentialId(prefix, existing);
}

/* -------------------------------------------------------------- 工厂实现 */

/**
 * 建一个绑定到某个 base_dir 的存储实例。
 * @param {{base_dir?: string}} [options] 默认 base_dir = 项目根（本文件的上两级）
 */
function createStore(options = {}) {
  const baseDir = options.base_dir
    ? path.resolve(options.base_dir)
    : path.resolve(__dirname, "..", "..");

  /** settings.json 固定在**默认目录**（否则"数据目录"配置自己就没地方放了） */
  const settingsPath = () => path.join(baseDir, "data", SETTINGS_FILE);

  /** parts/movements 跟随 settings.data_dir（默认同目录） */
  const dataDir = () => resolveDataDir(baseDir, readSettingsFile().data_dir);
  const partsPath = () => path.join(dataDir(), PARTS_FILE);
  const movementsPath = () => path.join(dataDir(), MOVEMENTS_FILE);

  /** 内部用：直接读 settings 文件，**不在读的时候写默认值**（避免读函数有副作用） */
  function readSettingsFile() {
    const file = settingsPath();
    if (!fs.existsSync(file)) return clone(DEFAULT_SETTINGS);
    const raw = readJson(file);
    return normalizeSettings(raw, file);
  }

  /**
   * **只读**取设置：文件不存在时返回默认值但**不落盘**。
   * 给"只读路径"用（`compare:export` 这类）——`loadSettings()` 会在首次调用时写盘，
   * 而 spec FR-2.6 要求比对全过程只读（验收用前后字节快照证明）。
   */
  function peekSettings() {
    return readSettingsFile();
  }

  /* -------------------------------------------------- 数据文件形状校验 */

  /**
   * parts.json 的形状与版本校验。**load 与 restore 共用同一份**——
   * 恢复时若不校验，就会把一个"读不出来的库"原样写进去（实测过：schema_version=99 的备份
   * 恢复报成功，之后 loadParts() 直接抛错，库彻底读不出来）。
   */
  function assertPartsPayload(raw, file) {
    if (!isPlainObject(raw)) throw new Error(`数据文件格式不对（应为对象）：${file}`);
    assertSchemaVersion(raw, file);
    if (!Array.isArray(raw.parts)) throw new Error(`数据文件格式不对（parts 应为数组）：${file}`);
    return raw.parts;
  }

  function assertMovementsPayload(raw, file) {
    if (!isPlainObject(raw)) throw new Error(`数据文件格式不对（应为对象）：${file}`);
    assertSchemaVersion(raw, file);
    if (!Array.isArray(raw.movements)) throw new Error(`数据文件格式不对（movements 应为数组）：${file}`);
    return raw.movements;
  }

  /** 单条变动记录的校验（appendMovement / appendMovements 共用） */
  function assertMovementShape(movement) {
    if (!isPlainObject(movement)) throw new Error("变动记录必须是对象");
    if (!movement.part_id) throw new Error("变动记录缺少 part_id");
    if (!MOVEMENT_KINDS.includes(movement.kind)) {
      throw new Error(`变动记录 kind「${movement.kind}」不合法（只能是 ${MOVEMENT_KINDS.join(" / ")}，plan §3.2）`);
    }
  }

  function readJson(file) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (exc) {
      throw new Error(`读取失败：${file}（${exc.message}）`);
    }
    try {
      return JSON.parse(text);
    } catch (exc) {
      throw new Error(
        `数据文件已损坏，无法解析：${file}（${exc.message}）。`
        + "文件保持原样未改动，请先备份或修复后再启动（不会按空库处理）"
      );
    }
  }

  function assertSchemaVersion(obj, file) {
    const v = obj && obj.schema_version;
    if (v == null) return; // 没写版本号的按当前版本处理（宽容读）
    if (v !== SCHEMA_VERSION) {
      throw new Error(
        `数据文件版本不支持：${file} 是 schema_version=${v}，本程序只认 ${SCHEMA_VERSION}。`
        + "请勿用新版本写过的数据喂给旧版本（拒绝读入而不是猜着读）"
      );
    }
  }

  /** 原子写：同目录 tmp → fsync → rename */
  function writeJsonAtomic(file, value) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    let text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch (exc) {
      // 序列化就失败时**根本不该动目标文件**（例如循环引用）
      throw new Error(`数据无法序列化，未写入任何文件：${exc.message}`);
    }
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd); // 先落盘，再改名——否则断电可能留下"名字对了但内容是空的"文件
    } catch (exc) {
      try { fs.closeSync(fd); } catch (ignored) { /* 见下 */ }
      try { fs.unlinkSync(tmp); } catch (ignored) { /* 清理失败不掩盖原错误 */ }
      throw new Error(`写入临时文件失败：${tmp}（${exc.message}）`);
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmp, file);
    } catch (exc) {
      try { fs.unlinkSync(tmp); } catch (ignored) { /* 同上 */ }
      throw new Error(
        `替换数据文件失败（目标可能正被其他程序打开）：${file}（${exc.message}）。`
        + "原文件未被改动，临时文件已清理"
      );
    }
    return { file, bytes: Buffer.byteLength(text, "utf8") };
  }

  function normalizeSettings(raw, file) {
    if (!isPlainObject(raw)) {
      throw new Error(`数据文件格式不对（应为对象）：${file}`);
    }
    assertSchemaVersion(raw, file);
    const merged = Object.assign(clone(DEFAULT_SETTINGS), raw);
    // 分类默认阈值：只保留已知键，且必须是有限数字（见 §6.4 校验）
    merged.default_min_quantity = Object.assign(
      {}, clone(DEFAULT_SETTINGS.default_min_quantity), isPlainObject(raw.default_min_quantity) ? raw.default_min_quantity : {}
    );
    return merged;
  }

  /* ------------------------------------------------------------ 器件库 */

  function loadParts() {
    const file = partsPath();
    if (!fs.existsSync(file)) return [];
    return assertPartsPayload(readJson(file), file);
  }

  function saveParts(parts) {
    if (!Array.isArray(parts)) throw new Error("saveParts: parts 必须是数组");
    return writeJsonAtomic(partsPath(), { schema_version: SCHEMA_VERSION, parts });
  }

  /* ---------------------------------------------------------- 变动记录 */

  function loadMovements() {
    const file = movementsPath();
    if (!fs.existsSync(file)) return [];
    return assertMovementsPayload(readJson(file), file);
  }

  function saveMovements(movements) {
    if (!Array.isArray(movements)) throw new Error("saveMovements: movements 必须是数组");
    return writeJsonAtomic(movementsPath(), { schema_version: SCHEMA_VERSION, movements });
  }

  /**
   * 追加一条变动记录（spec FR-4.5：任何数量变动都要留痕）。
   * id 与时间缺失时自动补；kind 必须在 plan §3.2 的枚举内（防止写入无法解释的记录）。
   */
  function appendMovement(movement) {
    return appendMovements([movement])[0];
  }

  /**
   * **批量**追加变动记录：**一次原子写**。
   *
   * 为什么必须有这个接口：入库/领料一次会产生几十条变动记录，
   * 若逐条调 `appendMovement`（每条都要 load 整个文件 + 原子写），中途失败就会留下
   * "前 k 条已落盘、器件一条没改"的幽灵留痕，而重试产生的那批与它**共用同一个 ref**，
   * 事后分不出真假（实测过）。批量接口把这个窗口从 N 次写收敛成 1 次写。
   */
  function appendMovements(list) {
    if (!Array.isArray(list)) throw new Error("appendMovements: 需要数组");
    if (list.length === 0) return []; // 空列表**不碰文件**（避免只读路径留下空文件）
    const movements = loadMovements();
    const records = [];
    for (const item of list) {
      assertMovementShape(item);
      const record = Object.assign({}, item);
      // id 要连"本批已生成的"一起算，否则同一批里会撞号
      if (!record.id) record.id = nextId(movements.concat(records), "m");
      if (!record.at) record.at = nowIso();
      records.push(record);
    }
    writeJsonAtomic(movementsPath(), { schema_version: SCHEMA_VERSION, movements: movements.concat(records) });
    return records;
  }

  /**
   * 按 id 删除若干条变动记录。**只给"补偿"用**：
   * 数量变动"先写留痕再改器件"，若器件那一步写失败，就得把刚写的留痕撤掉——
   * 否则库里会留下"有记录、没变化"的幽灵（FR-4.5 要求记录能对上真实变化）。
   */
  function dropMovements(ids) {
    const drop = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (drop.size === 0) return 0;
    const movements = loadMovements();
    const kept = movements.filter((m) => !drop.has(String(m.id)));
    if (kept.length === movements.length) return 0;
    writeJsonAtomic(movementsPath(), { schema_version: SCHEMA_VERSION, movements: kept });
    return movements.length - kept.length;
  }

  /* ---------------------------------------------------------------- 设置 */

  /** 首次调用会**写入**默认设置（plan §6.4：初始值取 spec §5.3 的 14 类表） */
  function loadSettings() {
    const file = settingsPath();
    if (!fs.existsSync(file)) {
      const initial = clone(DEFAULT_SETTINGS);
      writeJsonAtomic(file, initial);
      return initial;
    }
    return readSettingsFile();
  }

  /**
   * `settings:set` 的**合并写入**（plan §6.4）+ 字段级校验。
   * 校验失败时**整笔拒绝**并抛错，**已存设置保持原样**（不得部分写入、不得静默忽略）。
   * @param {object} patch 只含要改的键
   * @param {{confirm_data_dir?: boolean}} [opts] 改 data_dir 属需人工确认操作（AGENTS.md）
   */
  function saveSettings(patch, opts = {}) {
    if (!isPlainObject(patch)) throw new Error("saveSettings: 传入的设置必须是对象");
    const unknown = Object.keys(patch).filter((k) => !SETTINGS_KEYS.includes(k));
    if (unknown.length > 0) {
      throw new Error(`saveSettings: 未知设置项 ${unknown.join("、")}（plan §3.3 只定义了 ${SETTINGS_KEYS.join("、")}）`);
    }
    const current = readSettingsFile();
    const next = Object.assign({}, current);

    if (Object.prototype.hasOwnProperty.call(patch, "default_min_quantity")) {
      const incoming = patch.default_min_quantity;
      if (!isPlainObject(incoming)) {
        throw new Error("设置保存失败：default_min_quantity 必须是对象（分类 → 数字阈值）");
      }
      const bad = Object.entries(incoming)
        .filter(([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      if (bad.length > 0) {
        // plan §6.4 v1.5：非数字必须**拒绝整个写入**，且已存阈值保持原样（AC-9 异常路径）
        throw new Error(`设置保存失败：低库存阈值必须是非负数字，收到 ${bad.join("、")}；已存设置未改动`);
      }
      next.default_min_quantity = Object.assign({}, current.default_min_quantity, incoming);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "export_mode")) {
      if (!EXPORT_MODES.includes(patch.export_mode)) {
        throw new Error(`设置保存失败：export_mode 只能是 ${EXPORT_MODES.join(" / ")}（spec §4.2）`);
      }
      next.export_mode = patch.export_mode;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "last_used_dir")) {
      next.last_used_dir = String(patch.last_used_dir == null ? "" : patch.last_used_dir);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "data_dir")) {
      const incoming = String(patch.data_dir == null ? "" : patch.data_dir);
      if (incoming !== current.data_dir) {
        if (opts.confirm_data_dir !== true) {
          throw new Error(
            "更改数据目录属需人工确认的操作：请显式传 { confirm_data_dir: true }。"
            + "（换目录后 parts/movements 会指向新位置，看不到旧数据≠数据丢失）"
          );
        }
        next.data_dir = incoming;
      }
    }
    writeJsonAtomic(settingsPath(), next);
    return next;
  }

  /* ------------------------------------------------------------ 备份恢复 */

  function timestamp(when) {
    return ids.stamp(when);
  }

  /** 整库备份（plan §4）。返回备份目录路径。 */
  function backupTo(dirPath, opts = {}) {
    if (!dirPath || typeof dirPath !== "string") throw new Error("backupTo: 缺少备份目录");
    // 先确保 settings.json 存在（首启会写默认值）：否则首次备份会**静默少备份一个文件**，
    // 将来恢复出来就是"旧数据 + 新设置"的混合体。设置若已损坏则退化为不写——
    // 备份的首要目的是"把现场原样救出来"，不能因为设置坏了就拒绝备份。
    try {
      loadSettings();
    } catch (ignored) { /* 见上：坏设置不该阻断备份 */ }
    const target = path.join(path.resolve(dirPath), BACKUP_DIR_PREFIX + timestamp(opts.now));
    fs.mkdirSync(target, { recursive: true });
    const files = [
      [settingsPath(), path.join(target, SETTINGS_FILE)],
      [partsPath(), path.join(target, PARTS_FILE)],
      [movementsPath(), path.join(target, MOVEMENTS_FILE)],
    ];
    const copied = [];
    for (const [from, to] of files) {
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, to);
        copied.push(path.basename(to));
      }
    }
    const manifest = {
      backed_up_at: nowIso(opts.now),
      source_data_dir: dataDir(),
      files: copied,
      parts_count: safeCount(partsPath(), "parts"),
      movements_count: safeCount(movementsPath(), "movements"),
      app_schema_version: SCHEMA_VERSION,
    };
    writeJsonAtomic(path.join(target, "manifest.json"), manifest);
    return target;
  }

  function safeCount(file, key) {
    try {
      if (!fs.existsSync(file)) return 0;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(raw[key]) ? raw[key].length : 0;
    } catch (ignored) {
      return -1; // -1 = 读不出来；备份不该因为源文件坏了而失败
    }
  }

  /**
   * 从备份目录恢复（plan §4）。**恢复前自动留一份当前备份**（spec AC-6）。
   * 属危险操作（会覆盖当前数据），需显式 confirm（spec NFR-5）。
   *
   * **两条硬性设计**（都是实测出问题后才立的）：
   *  ① **先把要恢复的文件全部读进内存并校验，再开始写**。原来是"边读边写"，
   *     读到 parts.json 才发现损坏时，settings.json 已经换成备份里的了 ——
   *     若那份 settings 的 data_dir 指向别处，用户随后的 loadParts() 会返回 **0 条**，
   *     看起来就是"数据没了"（NFR-4 直接破）。
   *  ② **恢复不覆盖 `data_dir`**：数据目录是"这台机器上的这个位置"，不随备份走。
   *     照搬会写到别的盘/别的机器路径上，还绕过了 `settings:set` 的 confirm_data_dir 闸门。
   */
  function restoreFrom(backupPath, opts = {}) {
    if (!backupPath || typeof backupPath !== "string") throw new Error("restoreFrom: 缺少备份路径");
    if (opts.confirm !== true) {
      throw new Error("恢复备份会覆盖当前数据，属需人工确认的操作：请显式传 { confirm: true }");
    }
    const src = path.resolve(backupPath);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      throw new Error(`restoreFrom: 备份目录不存在或不是目录：${src}`);
    }
    const hasParts = fs.existsSync(path.join(src, PARTS_FILE));
    const hasMovements = fs.existsSync(path.join(src, MOVEMENTS_FILE));
    const hasSettings = fs.existsSync(path.join(src, SETTINGS_FILE));
    const manifestPath = path.join(src, "manifest.json");
    const hasManifest = fs.existsSync(manifestPath);
    // 合法备份**至少有 manifest**（backupTo 一定会写它）。这也修掉一个死角：
    // 空库（还没录料）做的备份只有 manifest + settings，原来是**恢复不了的**——
    // 而它恰恰是本工具自己的备份。
    if (!hasManifest && !hasParts && !hasMovements) {
      throw new Error(`restoreFrom: 该目录里没有 manifest.json / ${PARTS_FILE} / ${MOVEMENTS_FILE}，不是本工具的整库备份：${src}`);
    }

    // ---------- 阶段一：全部读入内存 + 校验（此阶段不写任何文件） ----------
    let manifest = null;
    if (hasManifest) {
      manifest = readJson(manifestPath);
      if (isPlainObject(manifest) && Number(manifest.app_schema_version) > SCHEMA_VERSION) {
        throw new Error(`restoreFrom: 备份由更新版本的程序产生（app_schema_version=${manifest.app_schema_version}，`
          + `本程序只认 ${SCHEMA_VERSION}），拒绝恢复以免写坏库`);
      }
    }
    const payload = {};
    if (hasParts) payload.parts = assertPartsPayload(readJson(path.join(src, PARTS_FILE)), path.join(src, PARTS_FILE));
    if (hasMovements) {
      payload.movements = assertMovementsPayload(readJson(path.join(src, MOVEMENTS_FILE)), path.join(src, MOVEMENTS_FILE));
    }
    let settingsPatch = null;
    if (hasSettings) {
      const restoredSettings = normalizeSettings(readJson(path.join(src, SETTINGS_FILE)), path.join(src, SETTINGS_FILE));
      restoredSettings.data_dir = readSettingsFile().data_dir; // ← data_dir 保持本机现值，不跟着备份走
      settingsPatch = restoredSettings;
    }

    // ---------- 阶段二：留安全备份，然后落盘 ----------
    // 先给"当前状态"留一份，再覆盖——否则恢复错了就没有回去的路
    const safety = backupTo(path.join(path.dirname(src), `${path.basename(src)}.pre-restore-${timestamp(opts.now)}`));

    const restored = [];
    if (settingsPatch) { saveSettings(settingsPatch); restored.push(SETTINGS_FILE); }
    if (payload.parts !== undefined) { saveParts(payload.parts); restored.push(PARTS_FILE); }
    if (payload.movements !== undefined) { saveMovements(payload.movements); restored.push(MOVEMENTS_FILE); }
    return {
      restored_from: src,
      safety_backup_path: safety,
      restored_files: restored,
      parts_count: payload.parts ? payload.parts.length : 0,
      movements_count: payload.movements ? payload.movements.length : 0,
      manifest,
    };
  }

  return {
    base_dir: baseDir,
    // 路径只暴露只读函数，便于调用方（如 IPC 层）报错时告知用户文件在哪
    paths: () => ({ settings: settingsPath(), data_dir: dataDir(), parts: partsPath(), movements: movementsPath() }),
    loadParts,
    saveParts,
    loadMovements,
    saveMovements,
    appendMovement,
    appendMovements,
    dropMovements,
    loadSettings,
    peekSettings,
    saveSettings,
    backupTo,
    restoreFrom,
  };
}

const defaultStore = createStore();

module.exports = Object.assign({ createStore, DEFAULT_SETTINGS, MOVEMENT_KINDS, SCHEMA_VERSION, nowIso, nextId }, defaultStore);
