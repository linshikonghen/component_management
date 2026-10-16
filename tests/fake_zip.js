"use strict";
/**
 * fake_zip.js — **测试专用**的最小 zip 写入器（用来造"别的工具会产出"的变体）
 *
 * 为什么要自己写：项目自带的 `zip_container.writeZip` 只会产出**规整**的包
 * （不压缩就退化 store、没有数据描述符、不会有重名条目）。而读取器要面对的是
 * **别人产出的** xlsx——那些包可能有数据描述符、可能整包不压缩、可能（被篡改后）有重名条目。
 * 想测这些情形，就得能造出它们。
 *
 * **与 `zip_container.crc32` 共用同一个 CRC 实现**：CRC 算法只有一份真相，
 * 这里不重写第二份（否则"造变体的工具"和"读变体的工具"可能各自错一半）。
 */

const zlib = require("zlib");
const { crc32 } = require("../src/services/zip_container");

/**
 * @param {Array<{name: string, data: string|Buffer}>} entries
 * @param {{store?: boolean, dataDescriptor?: boolean}} [opts]
 *   store=true 全条目用 method 0（不压缩）；
 *   dataDescriptor=true 打开通用标志位 bit 3：**本地头里 crc/尺寸写 0**，真值只写在中央目录后
 *   （流式写入器在写完数据前不知道尺寸，就这么干）。读取方必须信中央目录。
 * @returns {Buffer}
 */
function buildZip(entries, opts = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const crc = crc32(raw);
    let method = 8;
    let body = zlib.deflateRawSync(raw);
    if (opts.store) { method = 0; body = raw; }

    const flags = 0x0800 | (opts.dataDescriptor ? 0x0008 : 0); // UTF-8 名字 (+ bit3)
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0x21, 12); // 固定一个 DOS 日期，保证可复现
    // ← 数据描述符模式下，本地头这三项按规范写 0
    head.writeUInt32LE(opts.dataDescriptor ? 0 : crc, 14);
    head.writeUInt32LE(opts.dataDescriptor ? 0 : body.length, 18);
    head.writeUInt32LE(opts.dataDescriptor ? 0 : raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const localOffset = offset;
    local.push(head, nameBuf, body);
    offset += head.length + nameBuf.length + body.length;

    if (opts.dataDescriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); // 可选签名
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(raw.length, 12);
      local.push(dd);
      offset += dd.length;
    }

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);          // ← 中央目录里永远是**真值**（权威）
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, nameBuf);
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(local), cdBuf, eocd]);
}

module.exports = { buildZip };
