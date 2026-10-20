'use strict';

const fs = require('node:fs');
const { makePresentation } = require('./helpers');

const [fontPath, outputPath, family] = process.argv.slice(2);
if (!fontPath || !outputPath) {
  console.error('Cách dùng: node test/make-font-pptx.js <tệp-font.ttf> <ra.pptx> [tên-font]');
  process.exit(1);
}
fs.writeFileSync(outputPath, makePresentation([{ family: family || 'Poppins', style: 'Regular', fontData: fs.readFileSync(fontPath) }]));
console.log(`đã tạo ${outputPath}`);
