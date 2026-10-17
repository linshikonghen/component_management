"use strict";
/**
 * table_header.js — 「哪一行是表头」这一件事的**唯一实现**
 *
 * 起因（反重复规则）：对账单解析（lcsc_statement）与 BOM 嗅探（bom_parser）各自写过一份
 * 「取前 N 行里非空格子最多的那行」的启发式——两份实现、同一件事，已合并到这里。
 *
 * 为什么要"格子最多"而不是"第一个非空行"：真实对账单**第 0 行**有个零散单元格（`1:￥89.60`），
 * 第一个非空行根本不是表头（实测踩到过）。
 *
 * 注意：`bom_parser.locateHeaderRow` 是**另一件事**（"哪一行同时包含 BOM 必需列"），
 * 那是列校验的一部分，不该合并进来——两件事，两个函数。
 */

/**
 * @param {Array<Array>} rows 二维数组
 * @param {number} [scanRows] 只看前多少行（默认 12）
 * @returns {number} 表头行的下标；找不到返回 -1
 */
function locateHeaderRow(rows, scanRows) {
  const limit = Math.min(Number(scanRows) > 0 ? Number(scanRows) : 12, Array.isArray(rows) ? rows.length : 0);
  let bestIdx = -1;
  let bestCount = -1;
  for (let r = 0; r < limit; r += 1) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const n = row.filter((v) => v !== "" && v != null).length;
    if (n > bestCount) { bestCount = n; bestIdx = r; }
  }
  return bestIdx;
}

/** 只要那一行的内容（表头识别用） */
function headerCells(rows, scanRows) {
  const idx = locateHeaderRow(rows, scanRows);
  if (idx < 0) return [];
  return (Array.isArray(rows[idx]) ? rows[idx] : []).map((v) => String(v == null ? "" : v));
}

module.exports = { locateHeaderRow, headerCells };
