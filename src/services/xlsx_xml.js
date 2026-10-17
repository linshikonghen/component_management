"use strict";
/**
 * xlsx_xml.js — xlsx 的**文本与单元格坐标**层（读取器与写入器共用）
 *
 * 为什么单独一层：这些函数读取侧（bom_parser）与写入侧（exporter）都要用——
 * 例如 `A1` 这种单元格引用，读要"引用→列号"，写要"列号→引用"；XML 实体
 * 读要解码、写要编码。若各写一份，就会出现在**同一格式上两份略有差异的实现**
 * （AGENTS.md 反重复规则禁止），而 xlsx 恰恰是本工程最高风险点（plan §10.1），
 * 最不能容忍"两份实现各错一半"。
 *
 * 边界：只做纯字符串/数字变换，**不碰文件系统、不碰 zip**（那是 zip_container 的事）。
 */

/** `<t>` 元素里所有文本（`inlineStr` 与 `sharedStrings` 都用得上，富文本多段会拼接） */
function collectText(xml) {
  const re = /<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let out = "";
  let m = re.exec(xml);
  while (m) {
    out += m[1] ? decodeXmlEntities(m[1]) : "";
    m = re.exec(xml);
  }
  return out;
}

/** XML 实体解码（含数字实体），读写必须可逆：见 encodeXmlEntities */
function decodeXmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: {
        if (entity[0] !== "#") return whole;
        const code = entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
    }
  });
}

/** XML 实体编码。`&` 必须**第一个**换，否则会把后面换出来的 `&amp;` 再转义一次。 */
function encodeXmlEntities(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 不允许的控制字符（除 \t \n \r）会让文件直接打不开，必须剔除。
    // 另外 U+FFFE / U+FFFF 是 XML 1.0 的**非字符**，同样非法（外部解析器会拒）——
    // 这类字符肉眼不可见，混进 BOM 单元格就只能靠这里兜住。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
}

/** `A1` → 0，`AA10` → 26（只取字母部分） */
function columnIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref || ""));
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 → `A`，26 → `AA`（columnIndex 的逆） */
function columnName(index) {
  let n = Number(index);
  if (!Number.isInteger(n) || n < 0) throw new Error(`columnName: 列号必须是非负整数（收到 ${index}）`);
  let out = "";
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `A1` 形式单元格引用 */
function cellRef(colIndex, rowNumber) {
  return `${columnName(colIndex)}${rowNumber}`;
}

/**
 * **Excel 单元格文本上限：32767 个字符**（xlsx 格式的硬限制，不是我们的偏好）。
 *
 * 放在这一层（xlsx 格式知识层）是因为**读/写两侧都要知道它**：
 *   · 写入器（exporter）拿它当**默认守卫**：超了就报错，而不是产出一个"用户打不开"的文件；
 *   · 导出层（export_format）拿它当**截断阈值**：截断后带警示，让用户拿到能打开的清单。
 * 两处用**同一个常量**，免得"两套上限"各说各话。
 */
const MAX_CELL_CHARS = 32767;

module.exports = {
  collectText,
  decodeXmlEntities,
  encodeXmlEntities,
  columnIndex,
  columnName,
  cellRef,
  MAX_CELL_CHARS,
};
