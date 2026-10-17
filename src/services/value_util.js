"use strict";
/**
 * value_util.js — 服务层小工具（唯一实现处）
 *
 * 为什么要有它（自检结论 2026-10-17）：`str()` 在 5 个 service 里各写一遍、`toInt()` 4 份、
 * `isBlank()` 4 份、`clone()` 3 份，实现几乎逐字相同 —— 违反 AGENTS.md「反重复规则」。
 * 这里集中成一份；各 service 只 `require("./value_util")`，不再保留本地副本。
 *
 * 约定（与既有行为一致，改动须先看调用方）：
 *   · str(v)      null/undefined → ""，其余 String(v) 后 trim
 *   · toInt(v, d) 可转成有限数 → 截断取整；否则返回默认值 d
 *   · isBlank(v)  null/undefined，或"字符串且空白" → true（数字 0 不算空）
 *   · clone(v)    JSON 深拷贝（本项目的记录都是 JSON 可序列化数据）
 */

/** null/undefined → ""，其余 String + trim */
function str(value) {
  return value == null ? "" : String(value).trim();
}

/** 可转有限数 → Math.trunc；否则默认值 */
function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** 空值判定：null/undefined 或纯空白字符串（数字 0、false 不算空） */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/** JSON 深拷贝（记录都是纯 JSON 数据；调用方拿到副本后可安全修改） */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { str, toInt, isBlank, clone };
