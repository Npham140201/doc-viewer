'use strict';

const zlib = require('node:zlib');

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += 30 + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, end]);
}

function fakeFont(seed, kind = 'ttf') {
  const signature = kind === 'otf' ? Buffer.from('OTTO', 'latin1') : Buffer.from([0, 1, 0, 0]);
  return Buffer.concat([signature, Buffer.from(`font-data-${seed}`.padEnd(200, '.'), 'utf8')]);
}

function utf16Field(text) {
  const bytes = Buffer.from(text, 'utf16le');
  const size = Buffer.alloc(2);
  size.writeUInt16LE(bytes.length, 0);
  return Buffer.concat([size, bytes, Buffer.alloc(2)]);
}

function makeEmbeddedOpenType(options) {
  const fontData = options.xor ? Buffer.from(options.fontData.map((byte) => byte ^ 0x50)) : options.fontData;
  const header = Buffer.alloc(82);
  header.writeUInt32LE(0x00020002, 8);
  header.writeUInt32LE((options.compressed ? 0x4 : 0) | (options.xor ? 0x10000000 : 0), 12);
  header[27] = options.italic ? 1 : 0;
  header.writeUInt32LE(options.weight || 400, 28);
  header.writeUInt16LE(options.fsType || 0, 32);
  header.writeUInt16LE(options.magic === undefined ? 0x504c : options.magic, 34);
  const names = Buffer.concat([utf16Field(options.family), utf16Field(options.style || 'Regular'), utf16Field('Version 1.0'), utf16Field(options.family), Buffer.alloc(20)]);
  const total = Buffer.concat([header, names, fontData]);
  total.writeUInt32LE(total.length, 0);
  total.writeUInt32LE(fontData.length, 4);
  return total;
}

function makePresentation(fonts) {
  const entries = [
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', '<p:presentation/>'],
    ['ppt/slides/slide1.xml', '<p:sld><a:latin typeface="Poppins"/><a:latin typeface="Calibri"/><a:latin typeface="Agrandir"/></p:sld>'],
  ];
  fonts.forEach((font, index) => entries.push([`ppt/fonts/font${index + 1}.fntdata`, makeEmbeddedOpenType(font)]));
  return makeZip(entries);
}

module.exports = { makeZip, fakeFont, makeEmbeddedOpenType, makePresentation };
