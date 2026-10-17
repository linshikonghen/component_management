/**
 * backup_model.js — 备份 / 恢复页的**规则**（spec FR-6.4 / AC-6）
 *
 * 与其它 model 同一做法：规则抽出来无头可测，页面只做装配。
 * 本文件**不碰 DOM、不 require 任何东西**（Node 走 module.exports，浏览器挂 globalThis）。
 *
 * 两条要紧的语义（都不在界面，而在服务端 store.js，这里只负责"说清楚 + 拦住"）：
 *   ① 备一次 = 把 settings/parts/movements 三个文件复制进一个带时间戳的目录（还写一份 manifest）
 *   ② **恢复前自动把当前状态另存一份**（AC-6 明确要求），万一恢复错了还有回头路
 */

(function attach(root) {
  "use strict";

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    return typeof value === "string" && value.trim() === "";
  }

  function toInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  const BACKUP_HINT = "备份会新建一个「元器件事务_backup_时间戳」目录，把整库（器件 / 变动记录 / 设置）复制进去。原数据不动。";

  const RESTORE_WARNING =
    "恢复会用备份里的数据覆盖当前库（器件、变动记录、设置全部替换）。"
    + "工具会在覆盖前自动把当前状态另存一份，所以万一恢复错了还能回到现在这个样子。";

  /** 路径合法性（两种操作共用；只做"明显不对"的拦截，真实存在性由服务端判断） */
  function validatePath(raw, what) {
    const value = String(raw == null ? "" : raw).trim();
    if (value === "") return { ok: false, value: "", error: `${what}不能为空` };
    if (/[<>"|?*]/.test(value)) return { ok: false, value, error: `${what}里不能有 < > " | ? * 这些字符（收到「${value}」）` };
    return { ok: true, value, error: "" };
  }

  function backupRequest(raw) {
    const check = validatePath(raw, "备份目录");
    if (!check.ok) return { ok: false, error: check.error, request: null };
    return { ok: true, error: "", request: { dir_path: check.value } };
  }

  /**
   * 恢复请求。**未确认时不给载荷**——恢复会覆盖当前数据，属需人工确认操作（AGENTS.md）。
   */
  function restoreRequest(raw, confirmed) {
    const check = validatePath(raw, "备份目录");
    if (!check.ok) return { ok: false, needs_confirm: false, error: check.error, request: null };
    if (confirmed !== true) {
      return { ok: false, needs_confirm: true, error: "恢复备份需要先勾选确认", request: null };
    }
    return { ok: true, needs_confirm: false, error: "", request: { file_path: check.value, confirm: true } };
  }

  /** 备份结果摘要 */
  function backupSummary(result) {
    const r = result || {};
    if (r.ok !== true) return `备份失败：${r.error || "未知原因"}`;
    return `已备份到 ${r.backup_path}`;
  }

  /** 恢复结果摘要：说清恢复了多少、以及"恢复前那一份"在哪 */
  function restoreSummary(result) {
    const r = result || {};
    if (r.ok !== true) return `恢复失败：${r.error || "未知原因"}`;
    const files = Array.isArray(r.restored_files) ? r.restored_files.length : 0;
    const parts = [];
    parts.push(`已从 ${r.restored_from} 恢复 ${files} 个文件`);
    parts.push(`现在库里有 ${toInt(r.parts_count)} 条器件、${toInt(r.movements_count)} 条变动记录`);
    if (!isBlank(r.safety_backup_path)) {
      parts.push(`覆盖前的状态已自动另存到 ${r.safety_backup_path}（想反悔就把它再恢复一次）`);
    }
    return parts.join("；");
  }

  /** 当前数据在哪（界面上要显示，用户才知道备份的是什么） */
  function dataDirLine(settings) {
    const dir = settings && settings.data_dir;
    return isBlank(dir) ? "当前数据目录：（默认 data/）" : `当前数据目录：${dir}`;
  }

  const api = {
    BACKUP_HINT,
    RESTORE_WARNING,
    validatePath,
    backupRequest,
    restoreRequest,
    backupSummary,
    restoreSummary,
    dataDirLine,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BackupModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
