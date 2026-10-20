'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const { createFontLibrary } = require('./fontlibrary');
const { normalizePresentation } = require('./pptxnormalize');
const { createSlotPool, downloadFile, runProcess } = require('./transfer');

const port = Number(process.env.PORT || 8080);
const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
const viewerKey = process.env.VIEWER_KEY || '';
const cacheDirectory = process.env.CACHE_DIR || path.join(os.tmpdir(), 'doc-viewer-cache');
const maxDownloadBytes = Number(process.env.MAX_DOWNLOAD_MB || 500) * 1024 * 1024;
const convertTimeoutMilliseconds = Number(process.env.CONVERT_TIMEOUT_SECONDS || 300) * 1000;
const downloadTimeoutMilliseconds = Number(process.env.DOWNLOAD_TIMEOUT_SECONDS || 600) * 1000;
const cacheDays = Number(process.env.CACHE_DAYS || 30);
const maxActiveJobs = Number(process.env.MAX_WAITING_JOBS || 20);
const sofficePath = process.env.SOFFICE_PATH || 'soffice';
const convertConcurrency = Math.max(1, Number(process.env.CONVERT_CONCURRENCY || 2));
const profileRoot = process.env.PROFILE_DIR || path.join(os.tmpdir(), 'doc-viewer-lo');
const warmupEnabled = process.env.WARMUP !== '0';
const fontDirectory = process.env.FONT_DIR || path.join(path.dirname(cacheDirectory), 'fonts');
const ooxmlExtensions = new Set(['docx', 'xlsx', 'pptx', 'ppsx', 'dotx']);
const fontHarvestExtensions = new Set(['pptx', 'ppsx']);
const downloadConnections = Math.max(1, Number(process.env.DOWNLOAD_CONNECTIONS || 6));
const downloadChunkBytes = Math.max(1, Number(process.env.DOWNLOAD_CHUNK_MB || 4)) * 1024 * 1024;
const downloadConcurrency = Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY || 2));
const pdfImageDpi = Number(process.env.PDF_IMAGE_DPI === undefined ? 150 : process.env.PDF_IMAGE_DPI);
const linearizeEnabled = process.env.LINEARIZE !== '0';

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const videoExtensions = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);
const officeExtensions = new Set(['doc', 'docx', 'dot', 'dotx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'pps', 'ppsx', 'odp', 'txt']);
const downloadOnlyExtensions = new Set(['avi', 'wmv', 'mkv', 'flv', 'zip', 'rar', '7z']);

const contentTypeByExtension = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  pdf: 'application/pdf',
};

const extensionByContentType = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm',
};

const jobs = new Map();
let activeJobs = 0;

function log(jobId, message) {
  console.log(`[${new Date().toISOString()}] ${jobId ? `[${jobId.slice(0, 8)}] ` : ''}${message}`);
}

function seconds(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

const fontLibrary = createFontLibrary({
  rootDirectory: fontDirectory,
  allowRestricted: process.env.ALLOW_RESTRICTED_FONTS === '1',
  maximumLibraryMegabytes: Number(process.env.FONT_LIBRARY_MAX_MB || 500),
  refreshFontCache: process.env.FONT_REFRESH !== '0',
  log: (message) => log('', message),
});

const convertPool = createSlotPool(convertConcurrency);
const downloadPool = createSlotPool(downloadConcurrency);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return match ? match[1].toLowerCase() : '';
}

function renderPage(title, bodyHtml, extraHead = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${extraHead}<style>
html,body{height:100%;margin:0}body{font-family:Segoe UI,Arial,sans-serif;background:#f4f6f8;color:#1f2933;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #dde3ea;border-radius:12px;padding:28px 32px;max-width:460px;width:calc(100% - 32px);box-sizing:border-box}
.card h1{font-size:18px;margin:0 0 8px}.card p{margin:0;color:#52606d;line-height:1.5;word-break:break-word}.card a{color:#0b6bcb}
.bar{height:4px;background:#e4e9ef;border-radius:2px;overflow:hidden;margin-top:18px}.bar span{display:block;height:100%;width:35%;background:#f08a00;animation:run 1.2s ease-in-out infinite}
@keyframes run{0%{margin-left:-35%}100%{margin-left:100%}}
.media{max-width:100%;max-height:100%;display:block}.stage{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#111}
</style></head><body>${bodyHtml}</body></html>`;
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function sendMessage(response, status, title, message) {
  sendHtml(response, status, renderPage(title, `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>`));
}

function keyIsValid(candidate) {
  if (!viewerKey) return true;
  const expected = Buffer.from(viewerKey);
  const actual = Buffer.from(String(candidate || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseAllowedSource(rawSource) {
  let source;
  try {
    source = new URL(rawSource);
  } catch {
    return null;
  }
  if (source.protocol !== 'https:' && source.protocol !== 'http:') return null;
  const host = source.host.toLowerCase();
  const hostname = source.hostname.toLowerCase();
  if (!allowedHosts.includes(host) && !allowedHosts.includes(hostname)) return null;
  return source;
}

function sniffExtension(headBytes, sourcePath) {
  if (headBytes.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (headBytes[0] === 0x89 && headBytes.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (headBytes[0] === 0xff && headBytes[1] === 0xd8 && headBytes[2] === 0xff) return 'jpg';
  if (headBytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (headBytes.subarray(0, 4).toString('latin1') === 'RIFF' && headBytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (headBytes.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (headBytes.readUInt32BE(0) === 0xd0cf11e0) return 'doc';
  if (headBytes[0] === 0x50 && headBytes[1] === 0x4b) return 'zip';
  return '';
}

async function sniffZipExtension(sourcePath) {
  const handle = await fsp.open(sourcePath, 'r');
  try {
    const { size } = await handle.stat();
    const headLength = Math.min(size, 262144);
    const tailLength = Math.min(size, 1048576);
    const head = Buffer.alloc(headLength);
    const tail = Buffer.alloc(tailLength);
    await handle.read(head, 0, headLength, 0);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const text = Buffer.concat([head, tail]).toString('latin1');
    if (text.includes('ppt/')) return 'pptx';
    if (text.includes('word/')) return 'docx';
    if (text.includes('xl/')) return 'xlsx';
    return '';
  } finally {
    await handle.close();
  }
}

function dispositionExtension(disposition) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition || '');
  return match ? extensionOf(decodeURIComponent(match[1])) : '';
}

async function download(source, targetPath, job) {
  return downloadFile({
    url: source.href,
    targetPath,
    connections: downloadConnections,
    chunkBytes: downloadChunkBytes,
    maxBytes: maxDownloadBytes,
    timeoutMilliseconds: downloadTimeoutMilliseconds,
    onTotal: (total) => { job.totalBytes = total; },
    onProgress: (bytes) => { job.receivedBytes += bytes; },
    onReset: () => { job.receivedBytes = 0; },
    onFallback: (error) => log(job.id, `tải song song lỗi (${error.message}), chuyển sang một luồng`),
  });
}

const pdfFilterNames = {
  pptx: 'impress_pdf_Export', ppt: 'impress_pdf_Export', pps: 'impress_pdf_Export', ppsx: 'impress_pdf_Export', odp: 'impress_pdf_Export',
  docx: 'writer_pdf_Export', doc: 'writer_pdf_Export', dotx: 'writer_pdf_Export', dot: 'writer_pdf_Export', rtf: 'writer_pdf_Export', odt: 'writer_pdf_Export', txt: 'writer_pdf_Export',
  xlsx: 'calc_pdf_Export', xls: 'calc_pdf_Export', ods: 'calc_pdf_Export', csv: 'calc_pdf_Export',
};

function pdfFilterFor(extension) {
  const name = pdfFilterNames[extension];
  if (!name || pdfImageDpi <= 0) return 'pdf';
  const options = { ReduceImageResolution: { type: 'boolean', value: 'true' }, MaxImageResolution: { type: 'long', value: String(pdfImageDpi) } };
  return `pdf:${name}:${JSON.stringify(options)}`;
}

function runSoffice(sourcePath, outputDirectory, slot, filter) {
  const profileDirectory = path.join(profileRoot, `slot-${slot}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const child = spawn(sofficePath, [
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
      `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
      '--convert-to', filter, '--outdir', outputDirectory, sourcePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...fontLibrary.environment() } });
    let errorTail = '';
    let timedOut = false;
    child.stderr.on('data', (data) => { errorTail = (errorTail + data).slice(-400); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, convertTimeoutMilliseconds);
    child.on('error', (error) => { clearTimeout(timer); finish({ spawnError: error.message, errorTail }); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (signal || code !== 0) await fsp.rm(profileDirectory, { recursive: true, force: true });
      finish({ code, signal, timedOut, errorTail });
    });
  });
}

async function convertToPdf(sourcePath, outputDirectory, slot) {
  const pdfPath = path.join(outputDirectory, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
  const firstFilter = pdfFilterFor(extensionOf(sourcePath));
  const filters = firstFilter === 'pdf' ? ['pdf'] : [firstFilter, 'pdf'];
  let lastError = 'Chuyển đổi thất bại.';
  for (let index = 0; index < filters.length; index++) {
    const outcome = await runSoffice(sourcePath, outputDirectory, slot, filters[index]);
    if (outcome.timedOut) throw new Error('Chuyển đổi quá thời gian cho phép.');
    if (outcome.spawnError) throw new Error(`Không chạy được bộ chuyển đổi: ${outcome.spawnError}`);
    if (outcome.code === 0 && fs.existsSync(pdfPath)) return pdfPath;
    lastError = outcome.code === 0
      ? 'Bộ chuyển đổi không tạo được PDF (tệp có thể hỏng hoặc không hỗ trợ).'
      : `Chuyển đổi thất bại (mã ${outcome.code}). ${outcome.errorTail.trim()}`;
    if (index < filters.length - 1) log('', 'chuyển với tùy chọn giảm ảnh thất bại, thử lại với cấu hình mặc định');
  }
  throw new Error(lastError);
}

async function optimizePdf(job, pdfPath) {
  if (!linearizeEnabled) return;
  const startedAt = Date.now();
  const outputPath = `${pdfPath}.linear`;
  const before = fs.statSync(pdfPath).size;
  const outcome = await runProcess('qpdf', ['--linearize', pdfPath, outputPath], 90000);
  if ((outcome.code === 0 || outcome.code === 3) && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    await fsp.rename(outputPath, pdfPath);
    log(job.id, `tối ưu PDF để xem từng trang: ${(before / 1048576).toFixed(1)} MB -> ${(fs.statSync(pdfPath).size / 1048576).toFixed(1)} MB trong ${seconds(startedAt)} giây`);
  } else {
    await fsp.rm(outputPath, { force: true });
    log(job.id, 'không tối ưu được PDF (bỏ qua, dùng bản gốc).');
  }
}

async function runJob(job, source, hints) {
  const directory = path.join(cacheDirectory, job.id);
  try {
    await fsp.rm(directory, { recursive: true, force: true });
    await fsp.mkdir(directory, { recursive: true });
    const rawPath = path.join(directory, 'source.bin');
    const label = hints.name || source.pathname.split('/').pop() || job.id;

    job.stage = 'waitdownload';
    const downloadSlot = await downloadPool.acquire(job);
    let received;
    try {
      job.stage = 'download';
      const downloadStartedAt = Date.now();
      received = await download(source, rawPath, job);
      log(job.id, `đã tải ${label}: ${(job.receivedBytes / 1048576).toFixed(1)} MB trong ${seconds(downloadStartedAt)} giây (${received.mode})`);
    } finally {
      downloadPool.release(downloadSlot);
    }

    let extension = hints.type || extensionOf(hints.name) || dispositionExtension(received.disposition)
      || extensionOf(source.pathname) || extensionByContentType[received.contentType] || '';
    if (!extension || extension === 'bin') {
      const handle = await fsp.open(rawPath, 'r');
      const headBytes = Buffer.alloc(16);
      await handle.read(headBytes, 0, 16, 0);
      await handle.close();
      extension = sniffExtension(headBytes, rawPath);
      if (extension === 'zip') extension = await sniffZipExtension(rawPath);
    }
    if (!extension) throw new Error('Không nhận ra loại tệp.');
    if (downloadOnlyExtensions.has(extension)) throw new Error(`Loại tệp .${extension} không xem trực tiếp được.`);

    let resultName;
    if (officeExtensions.has(extension)) {
      const officePath = path.join(directory, `source.${extension}`);
      await fsp.rename(rawPath, officePath);

      if (ooxmlExtensions.has(extension)) {
        job.stage = 'fonts';
        try {
          if (fontHarvestExtensions.has(extension)) {
            const harvested = await fontLibrary.harvest(officePath, label);
            if (harvested.added.length > 0) log(job.id, `thêm vào thư viện font: ${harvested.added.join(', ')}`);
            if (harvested.skipped.length > 0) log(job.id, `bỏ qua font nhúng: ${harvested.skipped.join('; ')}`);
          }
          const missing = await fontLibrary.reportMissing(officePath, label);
          if (missing.length > 0) log(job.id, `font tài liệu dùng nhưng chưa có (đã thay): ${missing.map((item) => `${item.family} -> ${item.substitute}`).join(', ')}`);
        } catch (error) {
          log(job.id, `bỏ qua bước font: ${error.message}`);
        }
      }

      if (fontHarvestExtensions.has(extension)) {
        try {
          const rewrittenPath = `${officePath}.fixed`;
          const converted = await normalizePresentation(officePath, rewrittenPath);
          if (converted > 0) {
            await fsp.rename(rewrittenPath, officePath);
            log(job.id, `đổi ${converted} hình ảnh xoay sang ảnh thường để LibreOffice dựng đúng`);
          }
        } catch (error) {
          log(job.id, `bỏ qua bước sửa hình ảnh xoay: ${error.message}`);
        }
      }

      job.stage = 'queued';
      const waitStartedAt = Date.now();
      const slot = await convertPool.acquire(job);
      job.stage = 'convert';
      log(job.id, `bắt đầu chuyển ${label} sang PDF (đã chờ ${seconds(waitStartedAt)} giây, khe ${slot})`);
      const convertStartedAt = Date.now();
      let pdfPath;
      try {
        pdfPath = await convertToPdf(officePath, directory, slot);
      } finally {
        convertPool.release(slot);
      }
      log(job.id, `chuyển xong ${label} trong ${seconds(convertStartedAt)} giây`);
      await fsp.rm(officePath, { force: true });
      job.stage = 'optimize';
      await optimizePdf(job, pdfPath);
      resultName = path.basename(pdfPath);
      extension = 'pdf';
    } else if (contentTypeByExtension[extension]) {
      resultName = `result.${extension}`;
      await fsp.rename(rawPath, path.join(directory, resultName));
      if (extension === 'pdf') {
        job.stage = 'optimize';
        await optimizePdf(job, path.join(directory, resultName));
      }
    } else {
      throw new Error(`Chưa hỗ trợ loại tệp .${extension}.`);
    }
    const meta = { file: resultName, contentType: contentTypeByExtension[extension] };
    await fsp.writeFile(path.join(directory, 'result.json'), JSON.stringify(meta));
    job.result = { filePath: path.join(directory, resultName), contentType: meta.contentType };
    job.state = 'ready';
    log(job.id, `sẵn sàng sau ${seconds(job.startedAt)} giây`);
  } catch (error) {
    job.state = 'failed';
    job.message = error.message;
    log(job.id, `thất bại sau ${seconds(job.startedAt)} giây: ${error.message}`);
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

function readCachedResult(id) {
  try {
    const directory = path.join(cacheDirectory, id);
    const meta = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
    const filePath = path.join(directory, meta.file);
    if (!fs.existsSync(filePath)) return null;
    return { id, state: 'ready', result: { filePath, contentType: meta.contentType } };
  } catch {
    return null;
  }
}

function ensureJob(id, source, hints, priority = 'high') {
  const known = jobs.get(id);
  if (known && known.state === 'ready' && known.result && !fs.existsSync(known.result.filePath)) jobs.delete(id);
  else if (known && known.state !== 'failed') {
    if (priority === 'high' && known.state === 'pending' && known.priority === 'low') {
      known.priority = 'high';
      downloadPool.promote(known);
      convertPool.promote(known);
    }
    return known;
  }
  const cached = readCachedResult(id);
  if (cached) {
    jobs.set(id, cached);
    return cached;
  }
  const job = { id, state: 'pending', stage: 'waitdownload', priority, startedAt: Date.now(), receivedBytes: 0, totalBytes: 0 };
  jobs.set(id, job);
  if (activeJobs >= maxActiveJobs) {
    job.state = 'failed';
    job.message = 'Máy chủ đang bận, vui lòng thử lại sau ít phút.';
    return job;
  }
  activeJobs += 1;
  runJob(job, source, hints).finally(() => { activeJobs -= 1; });
  return job;
}

function contentDisposition(downloadName) {
  return downloadName ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` : 'inline';
}

function serveFile(request, response, filePath, contentType, downloadName = '') {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendMessage(response, 404, 'Không tìm thấy', 'Tệp không còn trong bộ nhớ đệm.');
  }
  const entityTag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();
  const validators = { ETag: entityTag, 'Last-Modified': lastModified, 'Cache-Control': 'private, no-cache' };
  if (!request.headers.range) {
    const matchesEntityTag = request.headers['if-none-match'] === entityTag;
    const notModifiedSince = !request.headers['if-none-match'] && request.headers['if-modified-since'] && new Date(request.headers['if-modified-since']).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
    if (matchesEntityTag || notModifiedSince) {
      response.writeHead(304, validators);
      return response.end();
    }
  }
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(stat.size - Number(range[2]), 0);
    }
    if (start > end || start >= stat.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return response.end();
    }
    status = 206;
  }
  const headers = {
    ...validators,
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDisposition(downloadName),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  response.writeHead(status, headers);
  pipeline(fs.createReadStream(filePath, { start, end }), response).catch(() => {});
}

const assetContentTypes = {
  'viewer.css': 'text/css; charset=utf-8',
  'image-viewer.js': 'text/javascript; charset=utf-8',
  'video-viewer.js': 'text/javascript; charset=utf-8',
};
const assetCache = new Map();

function serveAsset(response, assetName) {
  const contentType = assetContentTypes[assetName];
  if (!contentType) return sendMessage(response, 404, 'Không tìm thấy', 'Đường dẫn không tồn tại.');
  if (!assetCache.has(assetName)) assetCache.set(assetName, fs.readFileSync(path.join(__dirname, 'public', assetName)));
  response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' });
  response.end(assetCache.get(assetName));
}

function renderViewerPage(kind, label, mediaUrl, proxyUrl, downloadUrl) {
  const attributes = `data-src="${escapeHtml(mediaUrl)}" data-proxy="${escapeHtml(proxyUrl)}" data-download="${escapeHtml(downloadUrl)}" data-name="${escapeHtml(label)}"`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(label)}</title><link rel="stylesheet" href="/assets/viewer.css"></head><body><div id="viewer" class="viewer viewer-${kind}" ${attributes}></div><script src="/assets/${kind}-viewer.js"></script></body></html>`;
}

function mediaKindOf(contentType) {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return '';
}

function resultUrl(job, label = '') {
  if (!mediaKindOf(job.result.contentType)) return `/file/${job.id}`;
  return label ? `/viewer/${job.id}?name=${encodeURIComponent(label)}` : `/viewer/${job.id}`;
}

async function handleMedia(request, response, query) {
  if (!keyIsValid(query.get('k'))) return sendMessage(response, 403, 'Không có quyền', 'Khóa truy cập không đúng.');
  const source = parseAllowedSource(query.get('src'));
  if (!source) return sendMessage(response, 400, 'Liên kết không hợp lệ', 'Liên kết không thuộc máy chủ tệp được phép.');
  const abortController = new AbortController();
  response.on('close', () => abortController.abort());
  const upstreamHeaders = {};
  if (request.headers.range) upstreamHeaders.Range = request.headers.range;
  let upstream;
  try {
    upstream = await fetch(source.href, { redirect: 'manual', headers: upstreamHeaders, signal: abortController.signal });
  } catch {
    return sendMessage(response, 502, 'Không lấy được tệp', 'Không kết nối được máy chủ tệp.');
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    return sendMessage(response, 502, 'Không lấy được tệp', `Máy chủ tệp trả về mã ${upstream.status}.`);
  }
  const headers = { 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': contentDisposition(query.get('download') ? (query.get('name') || 'tệp') : '') };
  for (const header of ['content-type', 'content-range', 'accept-ranges']) {
    if (upstream.headers.get(header)) headers[header] = upstream.headers.get(header);
  }
  if (upstream.headers.get('content-length') && !upstream.headers.get('content-encoding')) headers['content-length'] = upstream.headers.get('content-length');
  response.writeHead(upstream.status, headers);
  pipeline(Readable.fromWeb(upstream.body), response).catch(() => {});
}

function handleView(request, response, query) {
  if (!keyIsValid(query.get('k'))) return sendMessage(response, 403, 'Không có quyền', 'Khóa truy cập không đúng.');
  const source = parseAllowedSource(query.get('src'));
  if (!source) return sendMessage(response, 400, 'Liên kết không hợp lệ', 'Liên kết không thuộc máy chủ tệp được phép.');
  const hints = { type: (query.get('type') || '').toLowerCase().replace(/^\./, ''), name: query.get('name') || '' };
  const presetExtension = hints.type || extensionOf(hints.name) || extensionOf(source.pathname);
  const fileLabel = hints.name || source.pathname.split('/').pop() || 'tệp';

  if (imageExtensions.has(presetExtension)) {
    return sendHtml(response, 200, renderViewerPage('image', fileLabel, source.href, source.href, source.href));
  }
  if (videoExtensions.has(presetExtension)) {
    const mediaQuery = new URLSearchParams({ src: source.href, name: fileLabel });
    if (query.get('k')) mediaQuery.set('k', query.get('k'));
    const downloadQuery = new URLSearchParams(mediaQuery);
    downloadQuery.set('download', '1');
    return sendHtml(response, 200, renderViewerPage('video', fileLabel, source.href, `/media?${mediaQuery}`, `/media?${downloadQuery}`));
  }
  if (downloadOnlyExtensions.has(presetExtension)) {
    return sendHtml(response, 200, renderPage(fileLabel, `<div class="card"><h1>${escapeHtml(fileLabel)}</h1><p>Loại tệp này không xem trực tiếp được. <a href="${escapeHtml(source.href)}">Tải về</a></p></div>`));
  }

  const id = crypto.createHash('sha256').update(source.href).digest('hex').slice(0, 32);
  const job = ensureJob(id, source, hints, 'high');
  if (job.state === 'ready') {
    response.writeHead(302, { Location: resultUrl(job, fileLabel), 'Cache-Control': 'no-store' });
    return response.end();
  }
  const script = `<script>
var jobId=${JSON.stringify(id)};var fileLabel=${JSON.stringify(fileLabel).replace(/</g, '\\u003c')};
function check(){fetch('/status?id='+jobId,{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
if(s.state==='ready'){location.replace(s.next.indexOf('/viewer/')===0?s.next+'?name='+encodeURIComponent(fileLabel):s.next);return}
if(s.state==='failed'){document.getElementById('title').textContent='Không xem được tài liệu';document.getElementById('message').textContent=s.message;document.getElementById('bar').style.display='none';return}
var megabytes=function(n){return (n/1048576).toFixed(1)};
var text=s.stage==='convert'?'Đang chuyển tài liệu để xem':s.stage==='download'?'Đang tải tài liệu'+(s.totalBytes?' ('+megabytes(s.receivedBytes)+'/'+megabytes(s.totalBytes)+' MB)':''):s.stage==='fonts'?'Đang chuẩn bị font':s.stage==='optimize'?'Đang tối ưu để xem':s.stage==='waitdownload'?'Đang chờ tải'+(s.ahead>1?' (còn '+(s.ahead-1)+' tài liệu phía trước)':''):'Đang chờ đến lượt'+(s.ahead?' (còn '+s.ahead+' tài liệu phía trước)':'');
document.getElementById('message').textContent=text+'... '+(s.elapsedSeconds||0)+' giây';
setTimeout(check,1500)}).catch(function(){setTimeout(check,3000)})}
check();
</script>`;
  const body = `<div class="card"><h1 id="title">${escapeHtml(fileLabel)}</h1><p id="message">Đang chuẩn bị...</p><div class="bar" id="bar"><span></span></div></div>${script}`;
  sendHtml(response, 200, renderPage(fileLabel, body));
}

function handlePrefetch(request, response, query) {
  if (!keyIsValid(query.get('k'))) return sendJson(response, 403, { state: 'forbidden' });
  const source = parseAllowedSource(query.get('src'));
  if (!source) return sendJson(response, 400, { state: 'invalid' });
  const hints = { type: (query.get('type') || '').toLowerCase().replace(/^\./, ''), name: query.get('name') || '' };
  const presetExtension = hints.type || extensionOf(hints.name) || extensionOf(source.pathname);
  if (imageExtensions.has(presetExtension) || videoExtensions.has(presetExtension) || downloadOnlyExtensions.has(presetExtension)) return sendJson(response, 200, { state: 'skipped' });
  const id = crypto.createHash('sha256').update(source.href).digest('hex').slice(0, 32);
  const job = ensureJob(id, source, hints, 'low');
  sendJson(response, 202, { id, state: job.state });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method !== 'GET') return sendMessage(response, 405, 'Không hỗ trợ', 'Chỉ hỗ trợ GET.');
  if (url.pathname === '/healthz') return sendJson(response, 200, { ok: true });
  if (url.pathname === '/view') return handleView(request, response, url.searchParams);
  if (url.pathname === '/prefetch') return handlePrefetch(request, response, url.searchParams);
  if (url.pathname === '/status') {
    const job = jobs.get(url.searchParams.get('id') || '');
    if (!job) return sendJson(response, 404, { state: 'failed', message: 'Không tìm thấy yêu cầu. Hãy mở lại tài liệu.' });
    return sendJson(response, 200, {
      state: job.state,
      stage: job.stage,
      message: job.message,
      next: job.state === 'ready' ? resultUrl(job) : undefined,
      ahead: job.state !== 'pending' ? 0 : job.stage === 'queued' ? convertPool.ahead() : job.stage === 'waitdownload' ? downloadPool.ahead() : 0,
      elapsedSeconds: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
      receivedBytes: job.receivedBytes || 0,
      totalBytes: job.totalBytes || 0,
    });
  }
  if (url.pathname === '/fonts') {
    if (!keyIsValid(url.searchParams.get('k'))) return sendMessage(response, 403, 'Không có quyền', 'Khóa truy cập không đúng.');
    return sendJson(response, 200, fontLibrary.summary());
  }
  if (url.pathname === '/media') return handleMedia(request, response, url.searchParams);
  const assetMatch = /^\/assets\/([a-z-]+\.(?:css|js))$/.exec(url.pathname);
  if (assetMatch) return serveAsset(response, assetMatch[1]);
  const fileMatch = /^\/(file|viewer)\/([0-9a-f]{32})$/.exec(url.pathname);
  if (fileMatch) {
    const job = jobs.get(fileMatch[2]) || readCachedResult(fileMatch[2]);
    if (!job || job.state !== 'ready') return sendMessage(response, 404, 'Không tìm thấy', 'Tài liệu chưa sẵn sàng.');
    const downloadName = url.searchParams.get('download') ? (url.searchParams.get('name') || 'tệp') : '';
    if (fileMatch[1] === 'viewer') {
      const kind = mediaKindOf(job.result.contentType);
      if (!kind) return sendMessage(response, 404, 'Không tìm thấy', 'Tệp này không có trang xem.');
      const label = url.searchParams.get('name') || 'tệp';
      const fileUrl = `/file/${job.id}`;
      const downloadUrl = `${fileUrl}?download=1&name=${encodeURIComponent(label)}`;
      return sendHtml(response, 200, renderViewerPage(kind, label, fileUrl, fileUrl, downloadUrl));
    }
    return serveFile(request, response, job.result.filePath, job.result.contentType, downloadName);
  }
  sendMessage(response, 404, 'Không tìm thấy', 'Đường dẫn không tồn tại.');
});

async function cleanCache() {
  try {
    const cutoff = Date.now() - cacheDays * 86400000;
    for (const entry of await fsp.readdir(cacheDirectory)) {
      const entryPath = path.join(cacheDirectory, entry);
      const { mtimeMs } = await fsp.stat(entryPath);
      if (mtimeMs < cutoff) await fsp.rm(entryPath, { recursive: true, force: true });
    }
  } catch {
  }
}

if (allowedHosts.length === 0) {
  console.error('Thiếu ALLOWED_HOSTS (danh sách máy chủ tệp được phép, cách nhau bằng dấu phẩy).');
  process.exit(1);
}
async function warmUpConverter() {
  if (!warmupEnabled) return;
  const directory = path.join(os.tmpdir(), 'doc-viewer-warmup');
  await fsp.rm(directory, { recursive: true, force: true });
  await fsp.mkdir(directory, { recursive: true });
  const samplePath = path.join(directory, 'warmup.txt');
  await fsp.writeFile(samplePath, 'warmup\n');
  for (let index = 0; index < convertConcurrency; index++) {
    const slot = await convertPool.acquire({ priority: 'high' });
    const startedAt = Date.now();
    try {
      await convertToPdf(samplePath, directory, slot);
      log('', `khởi động sẵn LibreOffice (khe ${slot}) mất ${seconds(startedAt)} giây`);
    } catch (error) {
      log('', `khởi động sẵn LibreOffice không thành công: ${error.message}`);
    } finally {
      convertPool.release(slot);
    }
  }
  await fsp.rm(directory, { recursive: true, force: true });
}

fs.mkdirSync(cacheDirectory, { recursive: true });
cleanCache();
setInterval(cleanCache, 6 * 3600 * 1000).unref();
fontLibrary.initialize()
  .catch((error) => log('', `không khởi tạo được thư viện font: ${error.message}`))
  .finally(() => {
    server.listen(port, () => {
      log('', `doc-viewer lắng nghe cổng ${port} (chuyển đổi song song tối đa ${convertConcurrency})`);
      warmUpConverter().catch((error) => log('', `lỗi khởi động sẵn: ${error.message}`));
    });
  });
