'use strict';

const fsp = require('node:fs/promises');
const { openZip } = require('./zipreader');
const { rewriteZip } = require('./zipwriter');

const maximumXmlBytes = 32 * 1024 * 1024;
const partPattern = /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;
const shapePattern = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<\/p:sp>/g;

function attributeOf(text, name) {
  const match = text.match(new RegExp(`\\b${name}="(-?\\d+)"`));
  return match ? Number(match[1]) : 0;
}

function isFullRectangle(geometry) {
  const paths = geometry.match(/<a:path\b[^>]*>[\s\S]*?<\/a:path>/g);
  if (!paths || paths.length !== 1) return false;
  if (/<a:(arcTo|cubicBezTo|quadBezTo)\b/.test(paths[0])) return false;

  const pathTag = paths[0].match(/<a:path\b[^>]*>/)[0];
  const width = attributeOf(pathTag, 'w');
  const height = attributeOf(pathTag, 'h');
  if (width <= 0 || height <= 0) return false;

  const corners = new Set();
  for (const point of paths[0].matchAll(/<a:pt x="(-?\d+)" y="(-?\d+)"\/>/g)) {
    const x = Number(point[1]);
    const y = Number(point[2]);
    const atLeft = Math.abs(x) <= 1;
    const atRight = Math.abs(x - width) <= 1;
    const atTop = Math.abs(y) <= 1;
    const atBottom = Math.abs(y - height) <= 1;
    if ((!atLeft && !atRight) || (!atTop && !atBottom)) return false;
    corners.add(`${atLeft ? 0 : 1},${atTop ? 0 : 1}`);
  }
  return corners.size === 4;
}

// LibreOffice không xoay ảnh nền (blipFill) của hình tự do khi hình có góc xoay, nên ảnh hiện nghiêng sai
// và bị cắt theo khung. Canva xuất mọi ảnh xoay (băng keo, tờ giấy, tem...) theo kiểu đó. Đổi sang <p:pic>
// cùng vị trí/góc xoay thì LibreOffice dựng đúng như PowerPoint.
function convertShape(shape) {
  if (!shape.includes('<a:custGeom>') || !shape.includes('<a:blipFill') || shape.includes('<p:txBody>')) return null;

  const transform = shape.match(/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/);
  if (!transform || attributeOf(transform[0].match(/<a:xfrm\b[^>]*>/)[0], 'rot') === 0) return null;

  const properties = shape.match(/<p:spPr>([\s\S]*?)<\/p:spPr>/);
  const names = shape.match(/<p:cNvPr\b[^>]*\/>/);
  if (!properties || !names || !/<p:nvPr\/>/.test(shape)) return null;

  const geometry = properties[1].match(/<a:custGeom>[\s\S]*?<\/a:custGeom>/);
  const fill = properties[1].match(/<a:blipFill\b[^>]*>[\s\S]*?<\/a:blipFill>/);
  if (!geometry || !fill || !isFullRectangle(geometry[0]) || /<a:tile\b/.test(fill[0])) return null;

  const remaining = properties[1]
    .replace(transform[0], '')
    .replace(geometry[0], '')
    .replace(fill[0], '')
    .replace(/<a:ln\b[^>]*>\s*<a:noFill\/>\s*<\/a:ln>/, '')
    .trim();
  if (remaining !== '') return null;

  const blip = fill[0].match(/<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>/);
  if (!blip) return null;

  const fillRectangle = fill[0].match(/<a:fillRect\b([^>]*)\/>/);
  const left = fillRectangle ? attributeOf(fillRectangle[1], 'l') : 0;
  const top = fillRectangle ? attributeOf(fillRectangle[1], 't') : 0;
  const right = fillRectangle ? attributeOf(fillRectangle[1], 'r') : 0;
  const bottom = fillRectangle ? attributeOf(fillRectangle[1], 'b') : 0;
  if (left > 0 || top > 0 || right > 0 || bottom > 0) return null;

  let crop = '';
  if (left !== 0 || top !== 0 || right !== 0 || bottom !== 0) {
    const imageWidth = 100000 - left - right;
    const imageHeight = 100000 - top - bottom;
    const cropOf = (value, size) => Math.round((-value * 100000) / size);
    crop = `<a:srcRect l="${cropOf(left, imageWidth)}" t="${cropOf(top, imageHeight)}" r="${cropOf(right, imageWidth)}" b="${cropOf(bottom, imageHeight)}"/>`;
  }

  return `<p:pic><p:nvPicPr>${names[0]}<p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill>${blip[0]}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${transform[0]}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function convertShapes(xml) {
  let converted = 0;
  const result = xml.replace(shapePattern, (shape) => {
    const replacement = convertShape(shape);
    if (replacement === null) return shape;
    converted++;
    return replacement;
  });
  return { xml: result, converted };
}

// Trả về số hình đã đổi; chỉ ghi targetPath khi có đổi.
async function normalizePresentation(sourcePath, targetPath) {
  const zip = await openZip(sourcePath);
  try {
    const replacements = new Map();
    let total = 0;
    for (const name of zip.entries.keys()) {
      if (!partPattern.test(name)) continue;
      const xml = (await zip.read(name, maximumXmlBytes)).toString('utf8');
      const { xml: updated, converted } = convertShapes(xml);
      if (converted > 0) {
        replacements.set(name, Buffer.from(updated, 'utf8'));
        total += converted;
      }
    }
    if (total === 0) return 0;

    try {
      await rewriteZip(zip, replacements, targetPath);
    } catch (error) {
      await fsp.rm(targetPath, { force: true });
      throw error;
    }
    return total;
  } finally {
    await zip.close();
  }
}

module.exports = { normalizePresentation, convertShapes };
