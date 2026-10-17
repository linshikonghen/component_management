"use strict";
/**
 * zip_container.js — 零依赖 zip 容器读写（只用 Node 内置 zlib）
 *
 * 为什么存在：xlsx 本质是 zip 容器。本机离线、无 npm 依赖，`xlsx`/`SheetJS` 装不上
 * （plan §1.3 已实测），因此读取与写入都必须自写。读写**同源**放在一个模块里，
 * 是为了让 zip 格式知识（签名、偏移、CRC32、压缩方法）只有**一处**实现——
 * 一旦分散到 bom_parser.js 与 exporter.js，就会出现"两份略有不同的 zip 解析"
 * （AGENTS.md 反重复规则明确禁止）。
 *
 * 边界：本模块是**纯 Buffer 运算，不碰文件系统**。落盘由调用方负责
 * （读取由 bom_parser 读入 Buffer；导出由 exporter 写到用户选定路径）。
 *
 * 支持范围（够用即止，不做通用 zip 库）：
 *   - 读取：method 0（store）/ 8（deflate），走中央目录（权威大小），校验 CRC32
 *   - 写入：method 8（deflate，压不动则退化为 store），UTF-8 文件名标志位
 *   - 不支持 ZIP64（>4GB / >65535 条目）——检出即抛明确错误，不静默出错
 */

const zlib = require("zlib");

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ZIP64_SENTINEL = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** CRC32（IEEE 802.3，zip 用），表驱动。与 zlib.crc32 结果一致。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** 定位 End Of Central Directory。注释最长 65535，故最多回看 22+65535 字节。 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  let loose = -1;
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    // 严格判据：EOCD 之后剩下的字节数必须正好等于注释长度
    if (i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
    if (loose < 0) loose = i;
  }
  return loose;
}

/** 读中央目录，返回条目元数据（不含数据本体）。 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) {
    throw new Error("不是有效的 zip/xlsx：未找到 End Of Central Directory（文件可能被截断或不是 zip）");
  }
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_SENTINEL || total === 0xffff) {
    throw new Error("暂不支持 ZIP64 格式的 zip/xlsx（条目数或偏移超出经典 zip 上限）");
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`zip 中央目录第 ${i + 1} 条损坏（偏移 ${p}）`);
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compSize: buf.readUInt32LE(p + 20),
      uncompSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOCAL) {
    throw new Error(`zip 条目「${entry.name}」的 local header 越界或签名不符`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  // 本地头里也存了一份文件名：与中央目录不一致 = 文件已损坏。
  // zip 没有文件名校验和，不比对就会**静默返回一个错误键名**的条目。
  const localName = buf.subarray(lo + 30, lo + 30 + nameLen).toString("utf8");
  if (localName !== entry.name) {
    throw new Error(`zip 条目名不一致（中央目录「${entry.name}」vs 本地头「${localName}」），文件已损坏`);
  }
  const start = lo + 30 + nameLen + extraLen;
  const end = start + entry.compSize;
  if (end > buf.length) {
    throw new Error(`zip 条目「${entry.name}」的压缩数据越界（需要到 ${end}，文件仅 ${buf.length}）`);
  }
  const raw = buf.subarray(start, end);
  let data;
  if (entry.method === METHOD_STORE) {
    data = Buffer.from(raw);
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      data = zlib.inflateRawSync(raw);
    } catch (exc) {
      throw new Error(`zip 条目「${entry.name}」解压失败：${exc.message}`);
    }
  } else {
    throw new Error(`zip 条目「${entry.name}」用了不支持的压缩方法 ${entry.method}（仅支持 0 存储 / 8 deflate）`);
  }
  // 两个自证：大小与 CRC32。缺一个就可能"读出坏数据却不报错"。
  if (entry.uncompSize > 0 && data.length !== entry.uncompSize) {
    throw new Error(
      `zip 条目「${entry.name}」解压后大小不符：期望 ${entry.uncompSize} 字节，实际 ${data.length}`
    );
  }
  if (entry.crc !== 0 && crc32(data) !== entry.crc) {
    throw new Error(`zip 条目「${entry.name}」CRC32 校验失败（数据已损坏）`);
  }
  return data;
}

/**
 * 解出全部条目。
 * @returns {Map<string, Buffer>} 条目名 -> 明文数据
 */
function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("readZipEntries 需要 Buffer");
  const out = new Map();
  for (const entry of readCentralDirectory(buf)) {
    // **重名条目必须报错**（审计 R3 发现⑥）：zip 允许同名条目，`Map.set` 会**静默覆盖**——
    // 于是读出来的是一份"少了一个条目、且不知道少了哪个"的包。
    // 本模块为"本地头与中央目录名不一致"专门做了硬错误（理由正是"缺一个就可能读出坏数据却不报错"），
    // 重名是同一类问题，不能例外。读取器要面对**别人产出的** xlsx，不能假设它规整。
    if (out.has(entry.name)) {
      throw new Error(`zip 里有重名条目「${entry.name}」：无法确定该用哪一份，拒绝解包（文件可能被篡改或损坏）`);
    }
    out.set(entry.name, extractEntry(buf, entry));
  }
  return out;
}

/** 只取一个条目；不存在返回 null（便于 `entries.get` 语义）。 */
function readZipEntry(buf, name) {
  const entry = readCentralDirectory(buf).find((e) => e.name === name);
  if (!entry) return null;
  return extractEntry(buf, entry);
}

/** 条目名列表（诊断用，不解压）。 */
function listZipEntryNames(buf) {
  return readCentralDirectory(buf).map((e) => e.name);
}

/** 把 Date 转成 MS-DOS 时间/日期（zip 头里的 2+2 字节字段）。 */
function toDosDateTime(when) {
  const d = when instanceof Date ? when : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    dosTime:
      ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f),
    dosDate: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

/**
 * 组装 zip。
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {{date?: Date, level?: number}} [options]
 * @returns {Buffer}
 */
function writeZip(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("writeZip: 至少要有一个条目");
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`writeZip: 条目数 ${entries.length} 超出经典 zip 上限 ${MAX_ENTRIES}`);
  }
  const { dosTime, dosDate } = toDosDateTime(options.date);
  const level = Number.isInteger(options.level) ? options.level : zlib.constants.Z_BEST_COMPRESSION;

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || entry.name === "") {
      throw new Error("writeZip: 每个条目必须有非空 name");
    }
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data == null ? "" : String(entry.data), "utf8");
    const crc = crc32(raw);

    // deflate 对短内容可能反而变大，此时退化为 store——两种都合法。
    let method = METHOD_DEFLATE;
    let body = zlib.deflateRawSync(raw, { level });
    if (body.length >= raw.length) {
      method = METHOD_STORE;
      body = raw;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6); // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    localChunks.push(local, nameBuf, body);
    centralChunks.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录起始偏移 == 所有 local 记录总长
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

module.exports = {
  crc32,
  readZipEntries,
  readZipEntry,
  listZipEntryNames,
  writeZip,
  METHOD_STORE,
  METHOD_DEFLATE,
};
