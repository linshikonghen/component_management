"use strict";
/**
 * xls_biff.js — **零依赖**读老式 `.xls`（OLE2 复合文档 + BIFF8 记录）
 *
 * 为什么自己写：立创商城导出的「物料明细对账单」是 `.xls`（真 BIFF8，不是改名的 xlsx），
 * 而本项目**零 npm 依赖、完全离线**（spec FR-6.1）——`xlsx`/`SheetJS` 装不上，LibreOffice 也不能假设用户机器上有。
 * 所以只做**够用的一件事**：把第一个工作表读成二维数组（与 `bom_parser.readXlsxRows` 同样的形状）。
 *
 * **只认立创对账单这一种文件**（用户 2026-10-16 决定）：本模块只负责"把格子读出来"，
 * "是不是对账单、哪列是数量"由上层 `lcsc_statement.js` 按**表头**判断——认不出就明确报错，绝不猜（猜错就是错账）。
 *
 * 不做的（明确列出，免得被当成万能读取器）：
 *   · 不写 .xls（只读）· 不支持 BIFF5/BIFF2 等更老版本（会按 BOF 版本号明确报错）
 *   · 不支持多工作表合并（只读第一个）· 不支持公式求值（公式取缓存值；取不到就留空）
 *   · 不还原格式/颜色/合并单元格
 *
 * 实现要点（都是 BIFF8 的坑，逐条注在代码里）：
 *   1. OLE2：512/4096 两种扇区大小、FAT 链 + DIFAT、**小流（<4096 字节）走 miniFAT**
 *   2. BIFF8 的字符串是 XLUnicodeString：1 字节/2 字节字符混用（中文=2 字节）
 *   3. **共享字符串表（SST）会跨 CONTINUE 记录**：切在字符中间时，续段开头要**重读一次编码标志位**；
 *      富文本/扩展块也会跨段。第一版漏了后者，导致串号错位（真实文件实测出来的）
 */const SECTOR_FREESECT = 0xFFFFFFFF;
const SECTOR_ENDOFCHAIN = 0xFFFFFFFE;

/* ------------------------------------------------------------ OLE2 容器 */

function isOle(buf) {
  return buf.length >= 8 && buf.readUInt32LE(0) === 0xE011CFD0 && buf.readUInt32LE(4) === 0xE11AB1A1;
}

function readOle(buf) {
  if (!isOle(buf)) throw new Error("不是 OLE2 复合文档（.xls 文件头不对，可能是改名的 xlsx/csv）");
  const sectorSize = 1 << buf.readUInt16LE(30);
  const miniSize = 1 << buf.readUInt16LE(32);
  if (sectorSize !== 512 && sectorSize !== 4096) {
    throw new Error(`OLE2 扇区大小异常：${sectorSize}`);
  }
  const numFat = buf.readUInt32LE(44);
  const firstDir = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56);
  const firstMiniFat = buf.readUInt32LE(60);
  const numMiniFat = buf.readUInt32LE(64);
  const firstDifat = buf.readUInt32LE(68);
  const numDifat = buf.readUInt32LE(72);
  const off = (sector) => (sector + 1) * sectorSize;

  // DIFAT：头部内嵌 109 项，其余在 DIFAT 扇区链里
  const difat = [];
  for (let i = 0; i < 109; i += 1) {
    const v = buf.readUInt32LE(76 + i * 4);
    if (v === SECTOR_FREESECT) break;
    difat.push(v);
  }
  let df = firstDifat;
  for (let i = 0; i < numDifat && df !== SECTOR_FREESECT && df !== SECTOR_ENDOFCHAIN; i += 1) {
    const base = off(df);
    const per = sectorSize / 4 - 1;
    for (let k = 0; k < per; k += 1) {
      const v = buf.readUInt32LE(base + k * 4);
      if (v !== SECTOR_FREESECT) difat.push(v);
    }
    df = buf.readUInt32LE(base + per * 4);
  }

  const fat = [];
  for (const sec of (numFat ? difat.slice(0, numFat) : difat)) {
    const base = off(sec);
    for (let k = 0; k < sectorSize / 4; k += 1) fat.push(buf.readUInt32LE(base + k * 4));
  }

  const chain = (start, table) => {
    const out = [];
    let s = start;
    let guard = 0;
    while (s !== SECTOR_ENDOFCHAIN && s !== SECTOR_FREESECT && guard < 1e6) {
      out.push(s);
      s = table[s];
      guard += 1;
    }
    return out;
  };
  const readChain = (start, table, size) => {
    const parts = chain(start, table).map((s) => {
      const from = off(s);
      return buf.slice(from, Math.min(from + sectorSize, buf.length));
    });
    const all = Buffer.concat(parts);
    return size == null ? all : all.slice(0, size);
  };

  // 目录项：128 字节一条；名字是 UTF-16，长度含结尾的 2 字节
  const dirBuf = readChain(firstDir, fat);
  const entries = [];
  for (let p = 0; p + 128 <= dirBuf.length; p += 128) {
    const nameLen = dirBuf.readUInt16LE(p + 64);
    if (nameLen < 2) continue;
    entries.push({
      name: dirBuf.slice(p, p + nameLen - 2).toString("utf16le"),
      type: dirBuf.readUInt8(p + 66),
      start: dirBuf.readUInt32LE(p + 116),
      size: dirBuf.readUInt32LE(p + 120),
    });
  }
  const root = entries.find((e) => e.type === 5);

  let miniFat = [];
  if (numMiniFat > 0) {
    const b = readChain(firstMiniFat, fat);
    for (let k = 0; k + 4 <= b.length; k += 4) miniFat.push(b.readUInt32LE(k));
  }

  const readStream = (entry) => {
    // **小流走 miniFAT**：Workbook 通常大于 4096 走主 FAT，但小文件会在 mini 流里
    if (root && entry.size < miniCutoff) {
      const miniStream = readChain(root.start, fat);
      const secs = chain(entry.start, miniFat);
      const parts = secs.map((s) => miniStream.slice(s * miniSize, Math.min((s + 1) * miniSize, miniStream.length)));
      return Buffer.concat(parts).slice(0, entry.size);
    }
    return readChain(entry.start, fat, entry.size);
  };

  return { entries, readStream };
}

/* --------------------------------------------------------------- BIFF8 */

function biffRecords(stream) {
  const out = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const type = stream.readUInt16LE(p);
    const len = stream.readUInt16LE(p + 2);
    if (p + 4 + len > stream.length) break; // 截断的尾巴直接丢，不猜
    out.push({ type, data: stream.slice(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return out;
}

/** RK 编码：最低两位是标志（bit1=整数, bit0=除以100） */
function rkToNumber(rk) {
  const isInt = (rk & 0x02) !== 0;
  const div100 = (rk & 0x01) !== 0;
  let v;
  if (isInt) {
    v = rk >> 2; // 算术右移保留符号
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(rk & 0xFFFFFFFC, 4);
    v = b.readDoubleLE(0);
  }
  return div100 ? v / 100 : v;
}

/**
 * 解共享字符串表。**跨 CONTINUE 的三种切法都要处理**（这是本模块最容易错的地方）：
 *   a. 切在两个字符串之间：新段从头开始读下一个字符串（无额外标志位）
 *   b. 切在**字符数据中间**：新段开头有一个 1 字节编码标志位，只对剩余字符有效
 *   c. 切在**富文本/扩展块中间**：纯字节，按长度续读（**没有**标志位）
 * 第一版漏了 c，真实文件上表现为"串号整体错位"（335 个串只解出 77 个）。
 */
function readSst(recs, startIdx) {
  const chunks = [recs[startIdx].data];
  for (let k = startIdx + 1; k < recs.length && recs[k].type === 0x003C; k += 1) chunks.push(recs[k].data);

  let ci = 0;
  let pos = 0;
  let cur = chunks[0];
  const nextChunk = () => {
    if (ci + 1 >= chunks.length) return false;
    ci += 1;
    cur = chunks[ci];
    pos = 0;
    return true;
  };
  /** 在"纯字节"区域里跳过 n 个字节（可跨段）——用于富文本/扩展块 */
  const skipBytes = (n) => {
    let left = n;
    while (left > 0) {
      const avail = cur.length - pos;
      if (avail <= 0) { if (!nextChunk()) return; continue; }
      const take = Math.min(left, avail);
      pos += take;
      left -= take;
    }
  };
  /** 读 n 个字节（可跨段），返回 Buffer */
  const takeBytes = (n) => {
    const parts = [];
    let left = n;
    while (left > 0) {
      const avail = cur.length - pos;
      if (avail <= 0) { if (!nextChunk()) break; continue; }
      const take = Math.min(left, avail);
      parts.push(cur.slice(pos, pos + take));
      pos += take;
      left -= take;
    }
    return Buffer.concat(parts);
  };

  const first = recs[startIdx].data;
  const unique = first.readUInt32LE(0); // cstUnique：唯一串个数
  pos = 8;

  const strings = [];
  for (let n = 0; n < unique; n += 1) {
    // 头部：cch(2) + grbit(1)；若这一段读不下 3 字节，续段**不带**标志位
    if (cur.length - pos < 3 && !nextChunk()) break;
    const cch = cur.readUInt16LE(pos);
    let grbit = cur.readUInt8(pos + 2);
    pos += 3;
    let richRuns = 0;
    let extSize = 0;
    if (grbit & 0x08) { richRuns = takeBytes(2).readUInt16LE(0); }
    if (grbit & 0x04) { extSize = takeBytes(4).readInt32LE(0); }
    let wide = (grbit & 0x01) === 1;

    let text = "";
    let left = cch;
    while (left > 0) {
      const unit = wide ? 2 : 1;
      const avail = Math.floor((cur.length - pos) / unit);
      if (avail <= 0) {
        // 情况 b：切在字符中间 → 续段开头的 1 字节标志位
        if (!nextChunk()) break;
        wide = (cur.readUInt8(0) & 0x01) === 1;
        pos = 1;
        continue;
      }
      const take = Math.min(left, avail);
      text += wide
        ? cur.slice(pos, pos + take * 2).toString("utf16le")
        : cur.slice(pos, pos + take).toString("latin1");
      pos += take * unit;
      left -= take;
      if (left > 0) {
        if (!nextChunk()) break;
        wide = (cur.readUInt8(0) & 0x01) === 1;
        pos = 1;
      }
    }
    // 情况 c：富文本/扩展块按字节续读（没有标志位）
    if (richRuns > 0) skipBytes(richRuns * 4);
    if (extSize > 0) skipBytes(extSize);
    strings.push(text);
  }
  return strings;
}

/** BIFF8 的 XLUnicodeString（不含 cch 前缀，用于 LABEL 等记录） */
function readUnicodeString(buf, p0) {
  let p = p0;
  const cch = buf.readUInt16LE(p);
  const grbit = buf.readUInt8(p + 2);
  p += 3;
  let richRuns = 0;
  let extSize = 0;
  if (grbit & 0x08) { richRuns = buf.readUInt16LE(p); p += 2; }
  if (grbit & 0x04) { extSize = buf.readInt32LE(p); p += 4; }
  const wide = (grbit & 0x01) === 1;
  const value = wide
    ? buf.slice(p, p + cch * 2).toString("utf16le")
    : buf.slice(p, p + cch).toString("latin1");
  return value;
}

/**
 * 读第一个工作表为二维数组（与 `bom_parser.readXlsxRows` 同形状）。
 * @param {Buffer} buf .xls 文件字节
 * @returns {Array<Array<string|number>>} 行 → 列；格子按出现的最大列补齐
 */
function readXlsRows(buf) {
  const ole = readOle(buf);
  const wb = ole.entries.find((e) => e.type === 2 && /^(Workbook|Book)$/i.test(e.name));
  if (!wb) throw new Error("OLE2 里没有 Workbook 流（不是 Excel 工作簿？）");
  const stream = ole.readStream(wb);
  const recs = biffRecords(stream);

  const bof = recs.find((r) => r.type === 0x0809);
  if (bof && bof.data.length >= 4) {
    const ver = bof.data.readUInt16LE(0);
    if (ver < 0x0600) throw new Error(`只支持 BIFF8 及以上的 .xls（本文件 BIFF 版本 0x${ver.toString(16)}）`);
  }

  const sstIdx = recs.findIndex((r) => r.type === 0x00FC);
  const sst = sstIdx >= 0 ? readSst(recs, sstIdx) : [];

  const cells = [];
  let pendingFormula = null; // FORMULA 的字符串结果放在紧随其后的 STRING 记录里
  for (const rec of recs) {
    const d = rec.data;
    if (rec.type === 0x00FD && d.length >= 10) { // LABELSST：指向共享串
      cells.push({ row: d.readUInt16LE(0), col: d.readUInt16LE(2), v: sst[d.readUInt32LE(6)] });
    } else if (rec.type === 0x0203 && d.length >= 14) { // NUMBER
      cells.push({ row: d.readUInt16LE(0), col: d.readUInt16LE(2), v: d.readDoubleLE(6) });
    } else if (rec.type === 0x027E && d.length >= 10) { // RK
      cells.push({ row: d.readUInt16LE(0), col: d.readUInt16LE(2), v: rkToNumber(d.readUInt32LE(6)) });
    } else if (rec.type === 0x00BD && d.length >= 6) { // MULRK：一行多列的紧凑数值
      const row = d.readUInt16LE(0);
      const firstCol = d.readUInt16LE(2);
      const n = Math.floor((d.length - 6) / 6);
      for (let k = 0; k < n; k += 1) {
        cells.push({ row, col: firstCol + k, v: rkToNumber(d.readUInt32LE(4 + k * 6 + 2)) });
      }
    } else if (rec.type === 0x0204 && d.length >= 9) { // LABEL（BIFF8 里也是 Unicode 串）
      cells.push({ row: d.readUInt16LE(0), col: d.readUInt16LE(2), v: readUnicodeString(d, 6) });
    } else if (rec.type === 0x0006 && d.length >= 20) { // FORMULA：按结果类型取值
      const kind = d.readUInt8(12);
      const row = d.readUInt16LE(0);
      const col = d.readUInt16LE(2);
      if (kind === 0) cells.push({ row, col, v: d.readDoubleLE(6) });        // 数值
      else if (kind === 1) cells.push({ row, col, v: d.readUInt8(6) !== 0 }); // 布尔
      else if (kind === 2) cells.push({ row, col, v: "#ERR" });
      else if (kind === 3) pendingFormula = { row, col };                     // 空串
      else pendingFormula = { row, col };                                     // 字符串在 STRING 记录里
    } else if (rec.type === 0x0207 && pendingFormula) { // STRING：公式的字符串结果
      cells.push({ row: pendingFormula.row, col: pendingFormula.col, v: readUnicodeString(d, 0) });
      pendingFormula = null;
    }
  }

  if (cells.length === 0) return [];
  // 组装成二维数组（BIFF 只记非空格子，这里按行列填回去）
  const maxRow = cells.reduce((m, c) => Math.max(m, c.row), 0);
  const maxCol = cells.reduce((m, c) => Math.max(m, c.col), 0);
  const rows = [];
  for (let r = 0; r <= maxRow; r += 1) rows.push(new Array(maxCol + 1).fill(""));
  for (const c of cells) rows[c.row][c.col] = c.v == null ? "" : c.v;
  return rows;
}

module.exports = { readXlsRows, isOle, readOle, biffRecords, rkToNumber, readSst };
