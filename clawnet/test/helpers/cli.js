/**
 * Helpers for end-to-end tests: real `clawnet` processes started and driven through the
 * command line, one data directory each, ephemeral ports from the `ready` line.
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { ApiClient } from '../../src/cli/client.js';
import { FAST_TIMERS } from './cluster.js';

export const BIN = fileURLToPath(new URL('../../bin/clawnet.js', import.meta.url));

/** The environment of a child: ours, without any CLAWNET_* setting that would override a test's. */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CLAWNET_')));
  return { ...env, ...extra };
}

/**
 * Run one `clawnet` command to completion.
 *
 * @param {string[]} args
 * @param {{ env?: object, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runCli(args, { env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, ...args], { env: cleanEnv(env), timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') reject(error);
      else resolve({ code: error === null ? 0 : error.code, stdout, stderr });
    });
  });
}

/** `runCli` with a data directory, parsing `--json` standard output. */
export async function cliJson(dataDir, args, options) {
  const result = await runCli(['--data-dir', dataDir, '--json', ...args], options);
  if (result.code !== 0) throw new Error(`clawnet ${args.join(' ')} exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** @returns {boolean} whether a process with this pid exists */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Initialise a data directory (no passphrase) and give it timers that make tests fast. */
export async function initNode(dir, { network = 'e2e-net', config = {} } = {}) {
  const init = await runCli(['--data-dir', dir, 'init', '--no-passphrase', '--network', network]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  const path = join(dir, 'config.json');
  const base = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify({
    ...base,
    discovery: { pex: false, allowLoopback: true },
    timers: { ...FAST_TIMERS },
    ...config,
  }, null, 2)}\n`);
  return /node id ([a-z2-7]{52})/.exec(init.stdout)[1];
}

/**
 * Start `clawnet start` as a child and wait for its ready line.
 *
 * @param {import('node:test').TestContext} t its end kills a node that is still running
 * @param {string} dataDir
 * @param {string[]} [extra] more `start` arguments
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, pid: number, ready: object,
 *   stdout: string[], stderr: () => string, exited: Promise<number | null>, client: () => Promise<ApiClient> }>}
 */
export async function startNode(t, dataDir, extra = []) {
  const child = spawn(process.execPath, [BIN, '--data-dir', dataDir, 'start', '--listen', '127.0.0.1:0', '--api-port', '0', '--no-multicast', ...extra], {
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  // Only a process this test started is ever stopped, and only if it is still there.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  const ready = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error(`no ready line within 20 s; stderr: ${stderr.join('').slice(-1500)}`)), 20_000);
    lines.on('line', (line) => {
      stdout.push(line);
      try {
        const message = JSON.parse(line);
        if (message.event === 'ready') {
          clearTimeout(timer);
          resolve(message);
        }
      } catch {
        // Not the ready line.
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the node exited with ${code} before it was ready; stderr: ${stderr.join('').slice(-1500)}`));
    });
  });
  return { child, pid: child.pid, ready, stdout, stderr: () => stderr.join(''), exited, client: () => ApiClient.fromDataDir(dataDir) };
}

/** Poll until `check` returns something truthy; returns it. */
export async function eventually(check, { timeoutMs = 15_000, intervalMs = 100, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
