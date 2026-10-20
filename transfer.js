'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const maximumChunkAttempts = 3;

function createSlotPool(count) {
  const free = Array.from({ length: count }, (unused, index) => index);
  const high = [];
  const low = [];

  function dispatch() {
    while (free.length > 0) {
      const entry = high.shift() || low.shift();
      if (!entry) return;
      entry.resolve(free.shift());
    }
  }

  return {
    acquire(job) {
      return new Promise((resolve) => {
        const entry = { resolve, job };
        (job && job.priority === 'low' ? low : high).push(entry);
        dispatch();
      });
    },
    release(slot) {
      free.push(slot);
      dispatch();
    },
    promote(job) {
      const index = low.findIndex((entry) => entry.job === job);
      if (index >= 0) high.push(...low.splice(index, 1));
    },
    ahead() {
      return high.length + low.length + (count - free.length);
    },
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function headerInfo(response) {
  return {
    contentType: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    disposition: response.headers.get('content-disposition') || '',
  };
}

async function probeRanges(url, signal) {
  const response = await fetch(url, { redirect: 'manual', headers: { Range: 'bytes=0-0' }, signal });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  await response.arrayBuffer();
  const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') || '');
  if (!match) return null;
  return { total: Number(match[1]), ...headerInfo(response) };
}

async function downloadParallel(options, total) {
  const { url, targetPath, connections, chunkBytes, onProgress, signal } = options;
  const handle = await fsp.open(targetPath, 'w');
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, signal]);
  const chunkCount = Math.ceil(total / chunkBytes);
  let nextIndex = 0;
  let failure = null;

  async function fetchChunk(index) {
    const start = index * chunkBytes;
    const end = Math.min(total - 1, start + chunkBytes - 1);
    const expected = end - start + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, { redirect: 'manual', headers: { Range: `bytes=${start}-${end}` }, signal: combined });
        if (response.status !== 206) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`Máy chủ tệp trả về mã ${response.status} cho yêu cầu theo đoạn.`), { fatal: true });
        }
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length !== expected) throw new Error('đoạn tải không đủ byte');
        await handle.write(data, 0, data.length, start);
        onProgress(data.length);
        return;
      } catch (error) {
        if (combined.aborted || error.fatal || attempt >= maximumChunkAttempts) throw error;
        await sleep(400 * attempt);
      }
    }
  }

  async function worker() {
    while (!failure) {
      const index = nextIndex++;
      if (index >= chunkCount) return;
      try {
        await fetchChunk(index);
      } catch (error) {
        failure = failure || error;
        controller.abort();
        return;
      }
    }
  }

  try {
    await handle.truncate(total);
    await Promise.all(Array.from({ length: Math.min(connections, chunkCount) }, worker));
  } finally {
    await handle.close();
  }
  if (failure) throw failure;
}

async function downloadSingle(options) {
  const { url, targetPath, maxBytes, onProgress, signal } = options;
  const response = await fetch(url, { redirect: 'manual', signal });
  if (!response.ok) throw new Error(`Máy chủ tệp trả về mã ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) throw new Error('Tệp lớn hơn giới hạn cho phép.');
  options.onTotal(declaredLength);
  let total = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* limit(chunks) {
      for await (const chunk of chunks) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('Tệp lớn hơn giới hạn cho phép.');
        onProgress(chunk.length);
        yield chunk;
      }
    },
    fs.createWriteStream(targetPath),
  );
  return headerInfo(response);
}

async function downloadFile(options) {
  const { url, connections, chunkBytes, maxBytes, timeoutMilliseconds, onTotal, onProgress, onReset, onFallback } = options;
  const signal = AbortSignal.timeout(timeoutMilliseconds);
  const common = { ...options, signal };

  if (connections > 1) {
    let probe = null;
    try {
      probe = await probeRanges(url, AbortSignal.timeout(Math.min(timeoutMilliseconds, 30000)));
    } catch {
      probe = null;
    }
    if (probe && probe.total >= chunkBytes * 2) {
      if (probe.total > maxBytes) throw new Error('Tệp lớn hơn giới hạn cho phép.');
      onTotal(probe.total);
      try {
        await downloadParallel(common, probe.total);
        return { contentType: probe.contentType, disposition: probe.disposition, mode: `song song ${Math.min(connections, Math.ceil(probe.total / chunkBytes))} luồng` };
      } catch (error) {
        if (signal.aborted) throw error;
        onFallback(error);
        onReset();
      }
    }
  }
  const headers = await downloadSingle({ ...common, onTotal });
  return { ...headers, mode: 'một luồng' };
}

function runProcess(command, args, timeoutMilliseconds) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      resolve({ code: -1 });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });
}

module.exports = { createSlotPool, downloadFile, runProcess };
