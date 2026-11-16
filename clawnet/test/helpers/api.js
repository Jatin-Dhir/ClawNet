/**
 * Helpers for tests of the control API: a real node with the default services on
 * 127.0.0.1:0, raw HTTP calls that can set any header, and an event-stream reader.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SseParser } from '../../src/cli/client.js';
import { createDiagService } from '../../src/core/diag/diag.js';
import { createMessagesService } from '../../src/core/messaging/conversations.js';
import { ClawNode } from '../../src/core/node.js';
import { createApiService } from '../../src/gate/api-server.js';
import { FAST_TIMERS, mergeConfig, SILENT_LOGGER } from './cluster.js';
import { removeDir } from './tmp.js';

/** A directory that looks like a built console, with a file outside it to be found by traversal. */
export async function makeUiDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'clawnet-ui-'));
  t.after(() => removeDir(root));
  const ui = join(root, 'ui');
  await mkdir(join(ui, 'assets'), { recursive: true });
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>ClawView</title><script src="/assets/app.js"></script>');
  await writeFile(join(ui, 'assets', 'app.js'), 'console.log("console");');
  await writeFile(join(ui, 'assets', 'style.css'), 'body{margin:0}');
  await writeFile(join(ui, 'assets', 'data.bin'), Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'secret.txt'), 'OUTSIDE-THE-CONSOLE-DIRECTORY');
  return { root, ui };
}

/**
 * Start a node with the messages, diag and api services.
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {object} [options.config] partial config merged over the test defaults
 * @param {object} [options.api] options of `createApiService`
 * @param {object[]} [options.services] more services, before the API
 * @param {string} [options.dataDir] reuse a data directory
 * @returns {Promise<{ node: ClawNode, port: number, token: string, dataDir: string, url: string }>}
 */
export async function startApiNode(t, { config = {}, api = {}, services = [], dataDir } = {}) {
  const dir = dataDir ?? await mkdtemp(join(tmpdir(), 'clawnet-api-'));
  const base = {
    networkId: 'api-test',
    listen: { host: '127.0.0.1', port: 0 },
    api: { enabled: true, host: '127.0.0.1', port: 0 },
    discovery: { multicast: { enabled: false }, pex: false, bootstrap: [], allowLoopback: true },
    peers: { target: 0 },
    timers: { ...FAST_TIMERS },
  };
  const node = new ClawNode({
    config: mergeConfig(base, config),
    dataDir: dir,
    services: [createMessagesService(), createDiagService(), ...services, createApiService({ requestsPerSec: 1_000_000, authFailuresPerSec: 1_000_000, ...api })],
    logger: SILENT_LOGGER,
  });
  // The node is stopped before its directory goes: it flushes its stores on the way out.
  t.after(async () => {
    await node.stop().catch(() => {});
    if (dataDir === undefined) await removeDir(dir);
  });
  await node.start();
  const service = node.service('api');
  const token = service.url === null ? null : (await readFile(join(dir, 'api-token'), 'utf8')).trim();
  return { node, port: service.address?.port ?? 0, token, dataDir: dir, url: service.url };
}

/**
 * One HTTP request with full control over the headers.
 *
 * @returns {Promise<{ status: number, headers: object, text: string, json: any }>}
 */
export function call(port, { method = 'GET', path, headers = {}, token, body, raw }) {
  const payload = raw ?? (body === undefined ? null : JSON.stringify(body));
  const sent = { ...headers };
  if (token !== undefined) sent.authorization = `Bearer ${token}`;
  if (payload !== null && sent['content-type'] === undefined) sent['content-type'] = 'application/json';
  if (payload !== null) sent['content-length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: sent, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Not JSON: static files and plain-text pages.
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Send bytes over a plain socket and return everything the server answers before it closes. */
export function rawSocket(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks = [];
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    setTimeout(() => socket.end(), 1500).unref();
  });
}

/** @returns {number} the status of a raw HTTP/1.x answer */
export function statusOf(answer) {
  return Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? 0);
}

/**
 * Open the event stream and read it.
 *
 * @returns {Promise<{ status: number, headers: object, events: object[], comments: () => number,
 *   take: (n: number, ms?: number) => Promise<object[]>, closed: () => boolean,
 *   waitClosed: (ms?: number) => Promise<void>, close: () => void }>}
 */
export function openStream(port, { token, headers = {}, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { accept: 'text/event-stream', ...headers };
    if (token !== undefined) sent.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: `/api/v1/events${query}`, headers: sent, agent: false }, (res) => {
      const parser = new SseParser();
      const events = [];
      let comments = 0;
      let closed = false;
      let wake = () => {};
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        comments += (chunk.match(/^: ka$/gm) ?? []).length;
        for (const item of parser.feed(chunk)) events.push({ id: item.id, type: item.type, data: JSON.parse(item.data) });
        wake();
      });
      const done = () => {
        closed = true;
        wake();
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
      let cursor = 0;
      const waitFor = (predicate, ms) => new Promise((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          wake = () => {};
          rejectWait(new Error(`timed out after ${ms} ms; have ${JSON.stringify(events.slice(cursor).map((e) => e.type))}`));
        }, ms);
        const check = () => {
          if (predicate()) {
            clearTimeout(timer);
            wake = () => {};
            resolveWait();
          }
        };
        wake = check;
        check();
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        res,
        events,
        comments: () => comments,
        closed: () => closed,
        async take(n, ms = 3000) {
          await waitFor(() => events.length - cursor >= n || closed, ms);
          const out = events.slice(cursor, cursor + n);
          cursor += out.length;
          return out;
        },
        waitClosed: (ms = 3000) => waitFor(() => closed, ms),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}
