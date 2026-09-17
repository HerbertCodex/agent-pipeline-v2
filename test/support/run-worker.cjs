'use strict';
// Shared by the provider doubles of the test suite, which run in their own processes (CommonJS or ESM).
const { spawnSync } = require('node:child_process');
const { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

/**
 * Runs the offline fixture worker with `input` as its standard input and returns the finished process.
 *
 * The request is handed over as a regular file rather than through `spawnSync({ input })`. On macOS with
 * Node 22.16, a synchronous child fed through a pipe intermittently never saw the end of its input and
 * stalled until killed; a file descriptor always reaches end-of-file.
 *
 * @param {string} worker Absolute path of the worker script.
 * @param {string} input Request passed on standard input.
 * @param {number} [timeoutMs=30000] Hard limit; the worker is killed and `error.code` is `ETIMEDOUT` beyond it.
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runWorker(worker, input, timeoutMs = 30000) {
  const dir = mkdtempSync(join(tmpdir(), 'apv2-worker-'));
  const file = join(dir, 'request.json');
  writeFileSync(file, input, { mode: 0o600 });
  const fd = openSync(file, 'r');
  try {
    return spawnSync(process.execPath, [worker], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runWorker };
