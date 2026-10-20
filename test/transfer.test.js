'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createSlotPool, downloadFile } = require('../transfer');

function startServer(data, behavior = {}) {
  const state = { requests: 0, concurrent: 0, maxConcurrent: 0, failuresLeft: behavior.failFirstChunks || 0 };
  const server = http.createServer((request, response) => {
    state.requests += 1;
    state.concurrent += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    response.on('close', () => { state.concurrent -= 1; });
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    setTimeout(() => {
      if (behavior.ignoreRange || !range) {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
        return response.end(data);
      }
      if (state.failuresLeft > 0 && Number(range[1]) > 0) {
        state.failuresLeft -= 1;
        response.writeHead(500);
        return response.end();
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), data.length - 1);
      response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      response.end(data.subarray(start, end + 1));
    }, behavior.delay || 30);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/file` })));
}

function options(url, targetPath, extra = {}) {
  const progress = { total: 0, received: 0, resets: 0, fallbacks: 0 };
  return {
    progress,
    value: {
      url, targetPath, connections: 4, chunkBytes: 1024 * 1024, maxBytes: 100 * 1024 * 1024, timeoutMilliseconds: 20000,
      onTotal: (total) => { progress.total = total; },
      onProgress: (bytes) => { progress.received += bytes; },
      onReset: () => { progress.received = 0; progress.resets += 1; },
      onFallback: () => { progress.fallbacks += 1; },
      ...extra,
    },
  };
}

const sample = crypto.randomBytes(7 * 1024 * 1024 + 12345);
const sampleHash = crypto.createHash('sha256').update(sample).digest('hex');
const temporary = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-test-')), 'out.bin');
const hashOf = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

test('tải song song: đúng nội dung, dùng nhiều kết nối cùng lúc', async () => {
  const { server, state, url } = await startServer(sample);
  const target = temporary();
  const { progress, value } = options(url, target);
  const result = await downloadFile(value);
  server.close();
  assert.equal(hashOf(target), sampleHash);
  assert.equal(progress.received, sample.length);
  assert.equal(progress.total, sample.length);
  assert.match(result.mode, /song song 4 luồng/);
  assert.ok(state.maxConcurrent >= 3, `chỉ có ${state.maxConcurrent} kết nối đồng thời`);
});

test('máy chủ không hỗ trợ Range: tự quay về tải một luồng', async () => {
  const { server, url } = await startServer(sample, { ignoreRange: true });
  const target = temporary();
  const { progress, value } = options(url, target);
  const result = await downloadFile(value);
  server.close();
  assert.equal(hashOf(target), sampleHash);
  assert.equal(result.mode, 'một luồng');
  assert.equal(progress.received, sample.length);
});

test('đoạn lỗi tạm thời được thử lại', async () => {
  const { server, url } = await startServer(sample, { failFirstChunks: 2 });
  const target = temporary();
  const { value } = options(url, target);
  await downloadFile(value);
  server.close();
  assert.equal(hashOf(target), sampleHash);
});

test('tệp nhỏ dùng một luồng', async () => {
  const small = crypto.randomBytes(200 * 1024);
  const { server, url } = await startServer(small);
  const target = temporary();
  const { value } = options(url, target);
  const result = await downloadFile(value);
  server.close();
  assert.equal(result.mode, 'một luồng');
  assert.equal(hashOf(target), crypto.createHash('sha256').update(small).digest('hex'));
});

test('tệp vượt giới hạn bị từ chối', async () => {
  const { server, url } = await startServer(sample);
  const { value } = options(url, temporary(), { maxBytes: 1024 * 1024 });
  await assert.rejects(() => downloadFile(value), /lớn hơn giới hạn/);
  server.close();
});

test('hàng đợi khe: việc ưu tiên cao đi trước, nâng ưu tiên được', async () => {
  const pool = createSlotPool(1);
  const first = await pool.acquire({ priority: 'high' });
  const order = [];
  const lowJob = { priority: 'low' };
  const lowOther = { priority: 'low' };
  const lowPromise = pool.acquire(lowJob).then((slot) => { order.push('low'); pool.release(slot); });
  const otherPromise = pool.acquire(lowOther).then((slot) => { order.push('other'); pool.release(slot); });
  const highPromise = pool.acquire({ priority: 'high' }).then((slot) => { order.push('high'); pool.release(slot); });
  assert.equal(pool.ahead(), 4);
  pool.promote(lowOther);
  pool.release(first);
  await Promise.all([lowPromise, otherPromise, highPromise]);
  assert.deepEqual(order, ['high', 'other', 'low']);
  assert.equal(pool.ahead(), 0);
});
