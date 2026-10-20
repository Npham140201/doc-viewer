'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeZip } = require('./helpers');
const { openZip } = require('../zipreader');
const { normalizePresentation, convertShapes } = require('../pptxnormalize');

function freeform({ id, rotation, fillRect = '<a:fillRect l="0" t="0" r="0" b="0"/>', points, extra = '' }) {
  const corners = points || '<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="400" y="0"/></a:lnTo><a:lnTo><a:pt x="400" y="200"/></a:lnTo><a:lnTo><a:pt x="0" y="200"/></a:lnTo><a:lnTo><a:pt x="0" y="0"/></a:lnTo><a:close/>';
  return `<p:sp><p:nvSpPr><p:cNvPr name="Freeform ${id}" id="${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>` +
    `<a:xfrm flipH="false" flipV="false" rot="${rotation}"><a:off x="100" y="50"/><a:ext cx="400" cy="200"/></a:xfrm>` +
    `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect r="r" b="b" t="t" l="l"/><a:pathLst><a:path h="200" w="400">${corners}</a:path></a:pathLst></a:custGeom>` +
    `<a:blipFill><a:blip r:embed="rId5"/><a:stretch>${fillRect}</a:stretch></a:blipFill>${extra}</p:spPr></p:sp>`;
}

function slide(...shapes) {
  return `<p:sld><p:cSld><p:spTree>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
}

test('hình ảnh xoay (kể cả góc âm) đổi thành ảnh thường, giữ nguyên vị trí và góc xoay', () => {
  const { xml, converted } = convertShapes(slide(freeform({ id: 5, rotation: -3973175 })));
  assert.equal(converted, 1);
  assert.match(xml, /<p:pic>/);
  assert.doesNotMatch(xml, /<p:sp>/);
  assert.match(xml, /rot="-3973175"/);
  assert.match(xml, /<a:off x="100" y="50"\/><a:ext cx="400" cy="200"\/>/);
  assert.match(xml, /<p:cNvPr name="Freeform 5" id="5"\/>/);
  assert.match(xml, /<a:blip r:embed="rId5"\/>/);
  assert.doesNotMatch(xml, /srcRect/);
});

test('fillRect âm (ảnh lớn hơn khung) đổi thành srcRect cắt đúng tỉ lệ', () => {
  const { xml } = convertShapes(slide(freeform({ id: 3, rotation: 4990716, fillRect: '<a:fillRect l="-10050" t="0" r="-10050" b="0"/>' })));
  assert.match(xml, /<a:srcRect l="8368" t="0" r="8368" b="0"\/>/);
});

test('không đụng hình không xoay, có chữ, không phải hình chữ nhật, hoặc fillRect dương', () => {
  const unrotated = freeform({ id: 1, rotation: 0 });
  const withText = freeform({ id: 2, rotation: 100000 }).replace('</p:sp>', '<p:txBody><a:p/></p:txBody></p:sp>');
  const triangle = freeform({ id: 3, rotation: 100000, points: '<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="400" y="0"/></a:lnTo><a:lnTo><a:pt x="200" y="200"/></a:lnTo><a:close/>' });
  const inset = freeform({ id: 4, rotation: 100000, fillRect: '<a:fillRect l="5000" t="0" r="0" b="0"/>' });
  const bordered = freeform({ id: 5, rotation: 100000, extra: '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>' });
  const original = slide(unrotated, withText, triangle, inset, bordered);
  const { xml, converted } = convertShapes(original);
  assert.equal(converted, 0);
  assert.equal(xml, original);
});

test('chuẩn hóa tệp pptx: chỉ ghi lại phần slide đổi, mục khác giữ nguyên, tệp mở lại được', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-normalize-'));
  try {
    const mediaBytes = Buffer.alloc(5000, 7);
    const sourcePath = path.join(directory, 'source.pptx');
    fs.writeFileSync(sourcePath, makeZip([
      ['[Content_Types].xml', '<Types/>'],
      ['ppt/slides/slide1.xml', slide(freeform({ id: 5, rotation: -3973175 }))],
      ['ppt/slides/slide2.xml', slide(freeform({ id: 6, rotation: 0 }))],
      ['ppt/media/image1.png', mediaBytes],
    ]));

    const targetPath = path.join(directory, 'fixed.pptx');
    assert.equal(await normalizePresentation(sourcePath, targetPath), 1);

    const zip = await openZip(targetPath);
    try {
      assert.deepEqual([...zip.entries.keys()], ['[Content_Types].xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/media/image1.png']);
      assert.match((await zip.read('ppt/slides/slide1.xml', 1e6)).toString('utf8'), /<p:pic>/);
      assert.match((await zip.read('ppt/slides/slide2.xml', 1e6)).toString('utf8'), /<p:sp>/);
      assert.ok((await zip.read('ppt/media/image1.png', 1e6)).equals(mediaBytes));
    } finally {
      await zip.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('không có hình cần đổi thì không ghi tệp mới', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-normalize-'));
  try {
    const sourcePath = path.join(directory, 'source.pptx');
    fs.writeFileSync(sourcePath, makeZip([['ppt/slides/slide1.xml', slide(freeform({ id: 1, rotation: 0 }))]]));
    const targetPath = path.join(directory, 'fixed.pptx');
    assert.equal(await normalizePresentation(sourcePath, targetPath), 0);
    assert.equal(fs.existsSync(targetPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
