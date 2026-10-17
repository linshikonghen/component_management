"use strict";
/**
 * ids.js — 运行号、时间戳、顺序 id 的**唯一实现**
 *
 * 为什么单独一个文件：实现期这几段逻辑被抄了**六份**（AGENTS.md 反重复规则明令禁止）——
 *   · `YYYYMMDD_HHMMSS` 时间戳：bom_parser.makeBatchId、compare.makeCompareId、
 *     ipc/handlers.makeRunId、handlers.defaultExportName、store.timestamp 各写了一份；
 *   · `p_0001` 顺序 id：parts.nextPartId 与 inventory.nextPartId **逐字相同**（只差变量名）。
 * 后果不是"代码难看"，而是**同一件事有两个真相**：哪天要改成毫秒级精度或换时区，
 * 必然会漏掉其中一两处，于是"批次号"和"文件名的戳"就不是同一个时间了。
 *
 * 本模块**纯函数、不 require 任何东西、不碰 fs**：
 * 时间由调用方传进来（`when`），所以测试可以钉死输出，不受运行时刻影响。
 */

/** 两位补零 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 本地时间戳 `YYYYMMDD_HHMMSS`（秒级）。
 * 用于：批次号 / 比对号 / 领料号 / 导出文件默认名 / 备份目录名——**全工程同一个戳**。
 */
function stamp(when) {
  const d = when instanceof Date ? when : new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 运行号：`batch_20261015_100000` / `compare_…` / `pick_…`（plan §3.2 的形态） */
function makeRunId(prefix, when) {
  return `${prefix}_${stamp(when)}`;
}

/**
 * 从一组记录里取出 id 字符串。`records` 可以是字符串数组，也可以是对象数组
 * （`key` 指定取哪个字段——例如变动记录用的是 `part_id`）。
 */
function collectIds(records, key = "id") {
  return (records || []).map((item) => {
    if (typeof item === "string") return item;
    return item == null ? "" : String(item[key] == null ? "" : item[key]);
  });
}

/**
 * 顺序 id：`${prefix}_0001`（按现有集合里的**最大号 + 1**，不足 4 位补零）。
 * `records` 可以是对象数组（取 `.id`）或 id 字符串数组——这样调用方不必自己解析。
 * @param {string} prefix 如 `p`（器件）/ `m`（变动记录）
 * @param {Array<object|string>} records 现有记录
 * @param {number} [width] 补零宽度，默认 4
 */
function nextSequentialId(prefix, records, width = 4) {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  let max = 0;
  for (const value of collectIds(records)) {
    const m = re.exec(value);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}_${String(max + 1).padStart(width, "0")}`;
}

/**
 * 器件 id：`p_0001`（plan §3.1）。
 *
 * **必须把变动记录里的 part_id 也算进去**：删掉的器件，它的变动记录是**故意保留**的
 * （见 parts.deletePart 的说明），若只看当前库，新器件就会拿回刚被删掉的 id，
 * 于是"继承"了别人整段历史（审计实测：删 p_0002 后新建器件拿回 p_0002，
 * 它的变动历史里赫然是旧器件的记录）。**id 一旦用过就永不复用。**
 */
function nextPartId(library, movements) {
  return nextSequentialId("p", collectIds(library, "id").concat(collectIds(movements, "part_id")));
}

module.exports = { pad2, stamp, makeRunId, collectIds, nextSequentialId, nextPartId };
