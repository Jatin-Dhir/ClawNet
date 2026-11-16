/**
 * The client of the control API (API.md): what every command that talks to a running node
 * uses. It finds the node through `runtime.json` and the token file in the data directory,
 * sends the bearer token in the `Authorization` header only, and reads the event stream
 * with a real server-sent-events parser.
 *
 * It uses `node:http` with a fresh connection per request, so that a finished command
 * leaves nothing behind that keeps the process alive.
 */

import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import { ApiError, CliError, NotRunningError } from './errors.js';

/** Name of the file in the data directory that says where a running node's API is. */
export const RUNTIME_FILE = 'runtime.json';

/** Name of the token file in the data directory. */
export const TOKEN_FILE = 'api-token';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE']);

/**
 * A parser of the server-sent-events format (the part of the HTML standard that matters
 * here): lines end in LF, CR or CRLF, a blank line ends an event, `:` starts a comment.
 */
export class SseParser {
  #buffer = '';
  #lastWasCr = false;
  #id = null;
  #type = '';
  #data = [];

  /**
   * @param {string} chunk more of the stream, in any split
   * @returns {Array<{ id: string | null, type: string, data: string }>} the events it completed
   */
  feed(chunk) {
    let text = this.#buffer + chunk;
    if (this.#lastWasCr && text.startsWith('\n')) text = text.slice(1);
    this.#lastWasCr = false;
    const events = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char !== '\n' && char !== '\r') continue;
      const event = this.#line(text.slice(start, i));
      if (event !== null) events.push(event);
      if (char === '\r') {
        if (i + 1 < text.length) {
          if (text[i + 1] === '\n') i += 1;
        } else {
          this.#lastWasCr = true;
        }
      }
      start = i + 1;
    }
    this.#buffer = text.slice(start);
    return events;
  }

  #line(line) {
    if (line === '') {
      if (this.#data.length === 0 && this.#type === '') {
        this.#id = null;
        return null;
      }
      const event = { id: this.#id, type: this.#type === '' ? 'message' : this.#type, data: this.#data.join('\n') };
      this.#id = null;
      this.#type = '';
      this.#data = [];
      return event;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') this.#id = value;
    else if (field === 'event') this.#type = value;
    else if (field === 'data') this.#data.push(value);
    return null;
  }
}

function connectionError(url, cause) {
  if (UNREACHABLE.has(cause?.code)) {
    return new NotRunningError(`cannot reach the node at ${url} (${cause.code}); is it running?`, { cause });
  }
  return new CliError(`request to ${url} failed: ${cause?.message ?? cause}`, { cause });
}

function errorFromResponse(status, text) {
  try {
    const { error } = JSON.parse(text);
    if (typeof error?.code === 'string') return new ApiError(status, error.code, String(error.message ?? ''), error.details);
  } catch {
    // Not an API error document: reported below with the status.
  }
  return new CliError(`the node answered ${status} with something that is not an API response`);
}

export class ApiClient {
  #url;
  #host;
  #port;
  #token;

  /**
   * @param {object} options
   * @param {string} options.url base URL of the node, `http://127.0.0.1:47480`
   * @param {string} options.token the bearer token
   * @throws {CliError} for a URL that is not plain http
   */
  constructor({ url, token }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new CliError(`not a valid API address: ${url}`);
    }
    if (parsed.protocol !== 'http:' || parsed.hostname === '') throw new CliError(`the API address must be http://host:port, not ${url}`);
    this.#url = `http://${parsed.host}`;
    this.#host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
    this.#port = Number(parsed.port || 80);
    this.#token = token;
  }

  /** @returns {string} the base URL */
  get url() {
    return this.#url;
  }

  /**
   * The address that opens the console already signed in: the token travels in the URL
   * fragment, which a browser never sends to any server (API.md section 3).
   *
   * @returns {string} a secret: print it only where the user asked for it
   */
  consoleUrl() {
    return `${this.#url}/#token=${this.#token}`;
  }

  /**
   * Find a running node by its data directory.
   *
   * @param {string} dataDir
   * @returns {Promise<ApiClient>}
   * @throws {NotRunningError} if `runtime.json` is missing: no node is running there
   * @throws {CliError} if the node has no API, or the token file cannot be read
   */
  static async fromDataDir(dataDir) {
    let runtime;
    try {
      const text = (await readFile(join(dataDir, RUNTIME_FILE))).subarray(0, MAX_RUNTIME_BYTES).toString('utf8');
      runtime = JSON.parse(text);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new NotRunningError(`no node is running with the data directory ${dataDir}`);
      throw new CliError(`cannot read ${join(dataDir, RUNTIME_FILE)}: ${error.message}`);
    }
    if (typeof runtime?.api !== 'string') throw new CliError(`the node in ${dataDir} runs without its control API`);
    let token;
    try {
      token = (await readFile(join(dataDir, TOKEN_FILE), 'utf8')).trim();
    } catch (error) {
      throw new CliError(`cannot read the API token ${join(dataDir, TOKEN_FILE)}: ${error.code ?? error.message}`);
    }
    return new ApiClient({ url: runtime.api, token });
  }

  /**
   * Make one request and return the parsed JSON answer.
   *
   * @param {string} method GET, POST or DELETE
   * @param {string} path under `/api/v1`, with its query string
   * @param {object} [body] sent as JSON
   * @param {{ timeoutMs?: number }} [options] how long to wait for the whole answer
   * @returns {Promise<any>}
   * @throws {ApiError} the node answered with an error document (`status`, `code`, `details`)
   * @throws {NotRunningError} the node cannot be reached
   * @throws {CliError} anything else
   */
  request(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: this.#host, port: this.#port, method, path: `/api/v1${path}`, headers, agent: false, timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new CliError('the answer is too large'));
          else chunks.push(chunk);
        });
        res.on('error', (error) => reject(connectionError(this.#url, error)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new CliError('the node answered with something that is not JSON'));
            }
          } else {
            reject(errorFromResponse(res.statusCode, text));
          }
        });
      });
      req.on('timeout', () => req.destroy(new CliError(`the node did not answer within ${timeoutMs} ms`)));
      req.on('error', (error) => reject(error instanceof CliError ? error : connectionError(this.#url, error)));
      req.end(payload);
    });
  }

  /**
   * Follow the event stream (API.md section 8).
   *
   * @param {object} [options]
   * @param {string[]} [options.types] event types or `prefix.*` patterns
   * @param {string} [options.lastEventId] `<boot>-<seq>` to resume after
   * @param {AbortSignal} [options.signal] ends the iteration
   * @returns {AsyncGenerator<{ id: string | null, type: string, event: any }>} one item per
   *   server-sent event, `event` being its parsed JSON; the iteration ends when the node
   *   closes the stream
   * @throws {ApiError} the node refused the stream
   * @throws {NotRunningError} the node cannot be reached
   */
  async *events({ types, lastEventId, signal } = {}) {
    if (signal?.aborted === true) return;
    const query = types !== undefined && types.length > 0 ? `?types=${encodeURIComponent(types.join(','))}` : '';
    const headers = { authorization: `Bearer ${this.#token}`, accept: 'text/event-stream' };
    if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
    const res = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: this.#host, port: this.#port, method: 'GET', path: `/api/v1/events${query}`, headers, agent: false,
      }, resolve);
      req.on('error', (error) => reject(signal?.aborted ? Object.assign(new Error('aborted'), { aborted: true }) : connectionError(this.#url, error)));
      signal?.addEventListener('abort', () => req.destroy(), { once: true });
      req.end();
    }).catch((error) => {
      if (error?.aborted === true) return null;
      throw error;
    });
    if (res === null) return;
    if (signal?.aborted === true) {
      res.destroy();
      return;
    }
    if (res.statusCode !== 200) {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      throw errorFromResponse(res.statusCode, Buffer.concat(chunks).toString('utf8'));
    }
    signal?.addEventListener('abort', () => res.destroy(), { once: true });
    res.setEncoding('utf8');
    const parser = new SseParser();
    try {
      for await (const chunk of res) {
        for (const item of parser.feed(chunk)) {
          let event = null;
          try {
            event = JSON.parse(item.data);
          } catch {
            // A frame that is not JSON is passed on with a null event.
          }
          yield { id: item.id, type: item.type, event };
        }
      }
    } catch (error) {
      // A stream that is cut ends the iteration; the caller decides whether to reconnect.
      if (signal?.aborted !== true && !UNREACHABLE.has(error?.code) && error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
    }
  }
}
