'use strict';

const fsp = require('node:fs/promises');
const zlib = require('node:zlib');

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectorySignature = 0x02014b50;
const localHeaderSignature = 0x04034b50;
const maximumCommentLength = 65535;

async function openZip(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, maximumCommentLength + 22);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let endOffset = -1;
    for (let index = tailLength - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === endOfCentralDirectorySignature) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw new Error('Không phải tệp zip.');

    const entryCount = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('Zip64 chưa được hỗ trợ.');

    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);

    const entries = new Map();
    let position = 0;
    for (let index = 0; index < entryCount && position + 46 <= central.length; index++) {
      if (central.readUInt32LE(position) !== centralDirectorySignature) break;
      const flags = central.readUInt16LE(position + 8);
      const method = central.readUInt16LE(position + 10);
      const compressedSize = central.readUInt32LE(position + 20);
      const uncompressedSize = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const localOffset = central.readUInt32LE(position + 42);
      const name = central.toString('utf8', position + 46, position + 46 + nameLength);
      entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
      position += 46 + nameLength + extraLength + commentLength;
    }

    async function read(name, maximumBytes) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.flags & 1) throw new Error('Mục zip bị mã hóa.');
      if (entry.uncompressedSize > maximumBytes) throw new Error('Mục zip quá lớn.');
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, entry.localOffset);
      if (local.readUInt32LE(0) !== localHeaderSignature) throw new Error('Tiêu đề mục zip không hợp lệ.');
      const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const compressed = Buffer.alloc(entry.compressedSize);
      await handle.read(compressed, 0, entry.compressedSize, dataStart);
      if (entry.method === 0) return compressed;
      if (entry.method === 8) return zlib.inflateRawSync(compressed, { maxOutputLength: maximumBytes });
      throw new Error(`Kiểu nén zip ${entry.method} chưa được hỗ trợ.`);
    }

    return { entries, read, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

module.exports = { openZip };
