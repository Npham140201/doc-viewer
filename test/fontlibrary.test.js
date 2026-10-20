'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFontLibrary, parseEmbeddedOpenType, slugOf } = require('../fontlibrary');
const { openZip } = require('../zipreader');
const { makeZip, fakeFont, makeEmbeddedOpenType, makePresentation } = require('./helpers');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'font-library-test-'));
}

function writePresentation(directory, fonts) {
  const filePath = path.join(directory, 'sample.pptx');
  fs.writeFileSync(filePath, makePresentation(fonts));
  return filePath;
}

test('đọc được mục trong tệp zip (nén deflate)', async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, 'a.zip');
  fs.writeFileSync(filePath, makeZip([['a.txt', 'xin chào'], ['b/c.txt', 'x'.repeat(5000)]]));
  const zip = await openZip(filePath);
  assert.equal((await zip.read('a.txt', 1000)).toString('utf8'), 'xin chào');
  assert.equal((await zip.read('b/c.txt', 10000)).length, 5000);
  assert.equal(await zip.read('khong-co.txt', 1000), null);
  await assert.rejects(() => zip.read('b/c.txt', 100), /quá lớn/);
  await zip.close();
});

test('tệp không phải zip bị từ chối', async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, 'x.zip');
  fs.writeFileSync(filePath, Buffer.from('không phải zip'.repeat(20)));
  await assert.rejects(() => openZip(filePath), /Không phải tệp zip/);
});

test('parseEmbeddedOpenType: font thường, XOR, nén, chữ ký sai', () => {
  const plain = parseEmbeddedOpenType(makeEmbeddedOpenType({ family: 'Poppins', style: 'Bold', weight: 700, fontData: fakeFont('a') }));
  assert.equal(plain.family, 'Poppins');
  assert.equal(plain.style, 'Bold');
  assert.equal(plain.extension, 'ttf');
  assert.deepEqual(plain.data, fakeFont('a'));

  const obfuscated = parseEmbeddedOpenType(makeEmbeddedOpenType({ family: 'Agrandir', fontData: fakeFont('b', 'otf'), xor: true }));
  assert.equal(obfuscated.extension, 'otf');
  assert.deepEqual(obfuscated.data, fakeFont('b', 'otf'));

  assert.match(parseEmbeddedOpenType(makeEmbeddedOpenType({ family: 'X', fontData: fakeFont('c'), compressed: true })).reason, /nén MTX/);
  assert.match(parseEmbeddedOpenType(makeEmbeddedOpenType({ family: 'X', fontData: Buffer.from('not a font at all'.padEnd(100)) })).reason, /chữ ký/);
  assert.match(parseEmbeddedOpenType(makeEmbeddedOpenType({ family: 'X', fontData: fakeFont('d'), magic: 0x1234 })).reason, /không phải EOT/);
});

test('harvest lưu font, loại trùng theo băm, tôn trọng fsType, bỏ qua tệp hỏng', async () => {
  const root = temporaryDirectory();
  const library = createFontLibrary({ rootDirectory: root, refreshFontCache: false });
  await library.initialize();

  const filePath = writePresentation(temporaryDirectory(), [
    { family: 'Poppins', style: 'Regular', fontData: fakeFont('p-regular') },
    { family: 'Poppins', style: 'Bold', weight: 700, fontData: fakeFont('p-bold') },
    { family: 'Agrandir', style: 'Bold', fontData: fakeFont('a-bold', 'otf'), xor: true },
    { family: 'Cấm nhúng', fontData: fakeFont('restricted'), fsType: 2 },
    { family: 'Nén', fontData: fakeFont('compressed'), compressed: true },
    { family: '../../etc/evil', fontData: fakeFont('evil') },
  ]);

  const first = await library.harvest(filePath, 'mau.pptx');
  assert.deepEqual(first.added.sort(), ['../../etc/evil Regular', 'Agrandir Bold', 'Poppins Bold', 'Poppins Regular']);
  assert.equal(first.skipped.length, 2);
  assert.ok(first.skipped.some((reason) => /cấm nhúng/.test(reason)));
  assert.ok(first.skipped.some((reason) => /nén MTX/.test(reason)));

  for (const record of library.summary().library) {
    assert.ok(!record.family.includes('/') || record.family === '../../etc/evil');
  }
  const stored = fs.readdirSync(path.join(root, 'library'));
  assert.deepEqual(stored.sort(), ['agrandir', 'etc-evil', 'poppins']);
  assert.equal(fs.readdirSync(path.join(root, 'library', 'poppins')).length, 2);
  assert.equal(fs.existsSync(path.join(root, '..', 'etc')), false);

  const second = await library.harvest(filePath, 'mau.pptx');
  assert.equal(second.added.length, 0);
  assert.equal(second.existing, 4);

  const reloaded = createFontLibrary({ rootDirectory: root, refreshFontCache: false });
  await reloaded.initialize();
  assert.equal(reloaded.summary().library.length, 4);
  assert.ok(fs.readFileSync(path.join(root, 'fonts.conf'), 'utf8').includes(path.join(root, 'library')));
});

test('font bị cấm vẫn dùng được khi bật allowRestricted', async () => {
  const root = temporaryDirectory();
  const library = createFontLibrary({ rootDirectory: root, refreshFontCache: false, allowRestricted: true });
  await library.initialize();
  const filePath = writePresentation(temporaryDirectory(), [{ family: 'Hạn chế', fontData: fakeFont('r'), fsType: 2 }]);
  assert.equal((await library.harvest(filePath, 'x.pptx')).added.length, 1);
});

test('thư viện đầy thì không thêm font mới', async () => {
  const root = temporaryDirectory();
  const library = createFontLibrary({ rootDirectory: root, refreshFontCache: false, maximumLibraryMegabytes: 0.0001 });
  await library.initialize();
  const filePath = writePresentation(temporaryDirectory(), [{ family: 'Lớn', fontData: fakeFont('big') }]);
  const outcome = await library.harvest(filePath, 'x.pptx');
  assert.equal(outcome.added.length, 0);
  assert.match(outcome.skipped[0], /đã đầy/);
});

test('tệp không phải zip: harvest không ném lỗi', async () => {
  const root = temporaryDirectory();
  const library = createFontLibrary({ rootDirectory: root, refreshFontCache: false });
  await library.initialize();
  const filePath = path.join(temporaryDirectory(), 'bad.pptx');
  fs.writeFileSync(filePath, Buffer.from('không phải zip'.repeat(20)));
  const outcome = await library.harvest(filePath, 'bad.pptx');
  assert.equal(outcome.added.length, 0);
  assert.equal(outcome.skipped.length, 1);
});

test('slugOf chống ký tự lạ', () => {
  assert.equal(slugOf('Agrandir Bold'), 'agrandir-bold');
  assert.equal(slugOf('../../x'), 'x');
  assert.equal(slugOf('!!!'), 'font');
  assert.equal(slugOf('Cấm nhúng'), 'cam-nhung');
});
