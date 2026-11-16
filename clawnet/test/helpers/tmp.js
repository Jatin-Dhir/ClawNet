/**
 * Temporary directories for tests.
 *
 * Every test that touches disk gets its own directory under the OS temp dir and removes
 * it when the test ends, so tests never share state and never write into the repository.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a temporary directory and register its removal with the test context.
 *
 * @param {import('node:test').TestContext} t  the test (or suite) context
 * @param {string} [label] short tag that shows up in the directory name
 * @returns {Promise<string>} absolute path
 */
export async function tempDir(t, label = 'test') {
  const dir = await mkdtemp(join(tmpdir(), `clawnet-${label}-`));
  t.after(() => removeDir(dir));
  return dir;
}

/**
 * Remove a directory tree. Retries because Windows can briefly hold files open after a
 * process or socket that used them has closed.
 *
 * @param {string} dir
 */
export async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
