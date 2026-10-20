'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) value = crcTable[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function writeAll(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

// Ghi bản sao của zip đã mở bằng openZip: mục không đổi chép nguyên khối nén, mục trong replacements
// (tên -> Buffer) được nén lại.
async function rewriteZip(zip, replacements, targetPath) {
  const stream = fs.createWriteStream(targetPath);
  const central = [];
  let offset = 0;
  try {
    for (const entry of zip.entries.values()) {
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      const replacement = replacements.get(entry.name);

      let method;
      let checksum;
      let uncompressedSize;
      let payload;
      if (replacement) {
        method = 8;
        checksum = crc32(replacement);
        uncompressedSize = replacement.length;
        payload = zlib.deflateRawSync(replacement);
      } else {
        method = entry.method;
        checksum = entry.checksum;
        uncompressedSize = entry.uncompressedSize;
        payload = await zip.readRaw(entry.name);
      }
      const flags = 0x0800;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(entry.modifiedTime, 10);
      local.writeUInt16LE(entry.modifiedDate, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(uncompressedSize, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      await writeAll(stream, local);
      await writeAll(stream, nameBuffer);
      await writeAll(stream, payload);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(flags, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(entry.modifiedTime, 12);
      header.writeUInt16LE(entry.modifiedDate, 14);
      header.writeUInt32LE(checksum, 16);
      header.writeUInt32LE(payload.length, 20);
      header.writeUInt32LE(uncompressedSize, 24);
      header.writeUInt16LE(nameBuffer.length, 28);
      header.writeUInt32LE(offset, 42);
      central.push(header, nameBuffer);

      offset += 30 + nameBuffer.length + payload.length;
    }

    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip.entries.size, 8);
    end.writeUInt16LE(zip.entries.size, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    await writeAll(stream, centralBuffer);
    await writeAll(stream, end);
  } finally {
    await new Promise((resolve) => stream.end(resolve));
  }
}

module.exports = { rewriteZip, crc32 };
