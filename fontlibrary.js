'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { openZip } = require('./zipreader');

const embeddedFontFlagCompressed = 0x4;
const embeddedFontFlagXor = 0x10000000;
const embeddingRestricted = 0x2;
const fontSignatures = new Set(['00010000', '4f54544f', '74727565', '74746366']);
const maximumFontBytes = 25 * 1024 * 1024;
const maximumFontsPerDocument = 40;
const maximumXmlBytes = 8 * 1024 * 1024;
const maximumXmlPartsPerDocument = 400;
const maximumMissingRecords = 200;

function slugOf(text) {
  const slug = String(text).toLowerCase().replace(/đ/g, 'd').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'font';
}

function parseEmbeddedOpenType(buffer) {
  if (buffer.length < 90) return { reason: 'tệp quá ngắn' };
  const eotSize = buffer.readUInt32LE(0);
  const fontDataSize = buffer.readUInt32LE(4);
  const flags = buffer.readUInt32LE(12);
  const weight = buffer.readUInt32LE(28);
  const italic = buffer[27] !== 0;
  const fsType = buffer.readUInt16LE(32);
  const magic = buffer.readUInt16LE(34);
  if (magic !== 0x504c) return { reason: 'không phải EOT' };
  if (eotSize !== buffer.length || fontDataSize === 0 || fontDataSize > buffer.length - 90) return { reason: 'kích thước EOT không khớp' };

  let position = 82;
  const readName = () => {
    if (position + 2 > buffer.length) return '';
    const size = buffer.readUInt16LE(position);
    const text = buffer.toString('utf16le', position + 2, position + 2 + size);
    position += 2 + size + 2;
    return text.replace(/\0+$/, '');
  };
  const family = readName();
  const style = readName();

  if (flags & embeddedFontFlagCompressed) return { family, style, fsType, reason: 'font nén MTX (chưa hỗ trợ)' };
  let data = Buffer.from(buffer.subarray(buffer.length - fontDataSize));
  if (flags & embeddedFontFlagXor) for (let index = 0; index < data.length; index++) data[index] ^= 0x50;
  if (!fontSignatures.has(data.subarray(0, 4).toString('hex'))) return { family, style, fsType, reason: 'chữ ký font không hợp lệ' };
  return { family, style, weight, italic, fsType, data, extension: data.subarray(0, 4).toString('latin1') === 'OTTO' ? 'otf' : 'ttf' };
}

function collectUsedFonts(xmlText, names) {
  for (const pattern of [/<a:latin typeface="([^"]+)"/g, /w:(?:ascii|hAnsi)="([^"]+)"/g, /<name val="([^"]+)"/g]) {
    for (const match of xmlText.matchAll(pattern)) {
      const name = match[1].trim();
      if (name && !name.startsWith('+') && name.length <= 80) names.add(name);
    }
  }
}

function usedFontPartNames(entryNames) {
  return entryNames.filter((name) =>
    /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(name) || /^ppt\/theme\/[^/]+\.xml$/.test(name)
    || /^word\/(document|styles|fontTable)\.xml$/.test(name) || /^word\/theme\/[^/]+\.xml$/.test(name)
    || /^xl\/(styles|theme\/theme1)\.xml$/.test(name)).slice(0, maximumXmlPartsPerDocument);
}

function runCommand(command, args, environment, timeoutMilliseconds) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(command, args, { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve({ ok: false, output: '' });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds);
    child.stdout.on('data', (data) => { output += data; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, output: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output }); });
  });
}

function createFontLibrary(options) {
  const rootDirectory = options.rootDirectory;
  const libraryDirectory = path.join(rootDirectory, 'library');
  const manualDirectory = path.join(rootDirectory, 'manual');
  const configPath = path.join(rootDirectory, 'fonts.conf');
  const indexPath = path.join(rootDirectory, 'index.json');
  const allowRestricted = options.allowRestricted === true;
  const maximumLibraryBytes = (options.maximumLibraryMegabytes || 500) * 1024 * 1024;
  const refreshFontCache = options.refreshFontCache !== false;
  const log = options.log || (() => {});

  let index = { fonts: [], missing: [] };
  let refreshChain = Promise.resolve();

  const environment = () => ({ FONTCONFIG_FILE: configPath });

  function writeConfig() {
    const text = '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n'
      + '  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n'
      + `  <dir>${libraryDirectory}</dir>\n  <dir>${manualDirectory}</dir>\n`
      + `  <cachedir>${path.join(rootDirectory, '.cache')}</cachedir>\n</fontconfig>\n`;
    fs.writeFileSync(configPath, text);
  }

  function saveIndex() {
    const temporaryPath = `${indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(index));
    fs.renameSync(temporaryPath, indexPath);
  }

  function refresh() {
    if (!refreshFontCache) return refreshChain;
    refreshChain = refreshChain.then(async () => {
      const result = await runCommand('fc-cache', ['-f', libraryDirectory, manualDirectory], environment(), 60000);
      if (!result.ok) log('không chạy được fc-cache (bỏ qua).');
    });
    return refreshChain;
  }

  function libraryBytes() {
    return index.fonts.reduce((sum, font) => sum + font.bytes, 0);
  }

  async function initialize() {
    fs.mkdirSync(libraryDirectory, { recursive: true });
    fs.mkdirSync(manualDirectory, { recursive: true });
    try {
      const loaded = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      index = { fonts: Array.isArray(loaded.fonts) ? loaded.fonts : [], missing: Array.isArray(loaded.missing) ? loaded.missing : [] };
    } catch {
      index = { fonts: [], missing: [] };
    }
    index.fonts = index.fonts.filter((font) => fs.existsSync(path.join(libraryDirectory, font.file)));
    writeConfig();
    await refresh();
    log(`thư viện font: ${index.fonts.length} font (${(libraryBytes() / 1048576).toFixed(1)} MB) tại ${rootDirectory}`);
  }

  async function harvest(documentPath, label) {
    const outcome = { added: [], existing: 0, skipped: [] };
    let zip;
    try {
      zip = await openZip(documentPath);
    } catch (error) {
      outcome.skipped.push(`không đọc được zip: ${error.message}`);
      return outcome;
    }
    try {
      const names = [...zip.entries.keys()].filter((name) => /^ppt\/fonts\/[^/]+\.fntdata$/i.test(name)).slice(0, maximumFontsPerDocument);
      for (const name of names) {
        let parsed;
        try {
          const buffer = await zip.read(name, maximumFontBytes);
          parsed = parseEmbeddedOpenType(buffer);
        } catch (error) {
          outcome.skipped.push(`${name}: ${error.message}`);
          continue;
        }
        const display = parsed.family ? `${parsed.family} ${parsed.style || ''}`.trim() : name;
        if (!parsed.data) { outcome.skipped.push(`${display}: ${parsed.reason}`); continue; }
        if ((parsed.fsType & embeddingRestricted) !== 0 && !allowRestricted) { outcome.skipped.push(`${display}: font cấm nhúng (fsType ${parsed.fsType})`); continue; }

        const sha256 = crypto.createHash('sha256').update(parsed.data).digest('hex');
        if (index.fonts.some((font) => font.sha256 === sha256)) { outcome.existing += 1; continue; }
        if (libraryBytes() + parsed.data.length > maximumLibraryBytes) { outcome.skipped.push(`${display}: thư viện đã đầy`); continue; }

        const directory = path.join(libraryDirectory, slugOf(parsed.family));
        await fsp.mkdir(directory, { recursive: true });
        const fileName = `${slugOf(parsed.style || 'regular')}-${sha256.slice(0, 8)}.${parsed.extension}`;
        await fsp.writeFile(path.join(directory, fileName), parsed.data);
        const record = {
          family: parsed.family, style: parsed.style, weight: parsed.weight, italic: parsed.italic, fsType: parsed.fsType,
          sha256, file: path.join(slugOf(parsed.family), fileName), bytes: parsed.data.length, source: label, addedAt: new Date().toISOString(),
        };
        index.fonts.push(record);
        outcome.added.push(display);
      }
    } finally {
      await zip.close();
    }
    if (outcome.added.length > 0) {
      saveIndex();
      await refresh();
    }
    return outcome;
  }

  async function usedFonts(documentPath) {
    const names = new Set();
    let zip;
    try {
      zip = await openZip(documentPath);
    } catch {
      return [];
    }
    try {
      for (const part of usedFontPartNames([...zip.entries.keys()])) {
        try {
          const buffer = await zip.read(part, maximumXmlBytes);
          collectUsedFonts(buffer.toString('utf8'), names);
        } catch {
        }
      }
    } finally {
      await zip.close();
    }
    return [...names].slice(0, 100);
  }

  async function resolveFamily(name) {
    const result = await runCommand('fc-match', ['-f', '%{family[0]}', name], environment(), 10000);
    return result.ok ? result.output.trim() : '';
  }

  async function reportMissing(documentPath, label) {
    const missing = [];
    for (const name of await usedFonts(documentPath)) {
      const resolved = await resolveFamily(name);
      if (!resolved || resolved.toLowerCase() === name.toLowerCase()) continue;
      missing.push({ family: name, substitute: resolved });
      const known = index.missing.find((record) => record.family.toLowerCase() === name.toLowerCase());
      if (known) { known.count += 1; known.lastSeen = new Date().toISOString(); known.substitute = resolved; known.lastDocument = label; }
      else index.missing.push({ family: name, substitute: resolved, count: 1, lastSeen: new Date().toISOString(), lastDocument: label });
    }
    if (missing.length > 0) {
      index.missing.sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
      index.missing = index.missing.slice(0, maximumMissingRecords);
      saveIndex();
    }
    return missing;
  }

  function summary() {
    return {
      library: index.fonts.map((font) => ({ family: font.family, style: font.style, weight: font.weight, italic: font.italic, fsType: font.fsType, bytes: font.bytes, source: font.source, addedAt: font.addedAt })),
      missing: index.missing,
    };
  }

  return { initialize, harvest, reportMissing, environment, summary };
}

module.exports = { createFontLibrary, parseEmbeddedOpenType, slugOf };
