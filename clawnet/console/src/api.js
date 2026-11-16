/**
 * The console's only link to the node: same-origin fetch calls to /api/v1 with the bearer
 * token, and one event stream read with fetch (API.md sections 3 and 8). EventSource is not
 * used because it cannot send the Authorization header.
 */

const TOKEN_KEY = 'clawnet.token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const BASE = '/api/v1';
/** API.md 8.4: a stream that shows nothing for this long is presumed dead. */
const STREAM_SILENCE_MS = 45000;
const DEFAULT_RETRY_MS = 2000;
const MAX_RETRY_MS = 15000;

let memoryToken = null;

/**
 * Take the token from the URL fragment (then remove the fragment from the address bar and
 * the history entry), or from sessionStorage. Never from localStorage or a query string.
 *
 * @returns {string | null}
 */
export function takeToken() {
  const hash = window.location.hash;
  if (hash.includes('token=')) {
    const match = /(?:^#|&)token=([^&]*)/.exec(hash);
    // Remove the fragment first, whatever it held, so a token never lingers in history.
    window.history.replaceState(null, '', window.location.pathname);
    const value = match ? decodeURIComponent(match[1]).toLowerCase() : '';
    if (TOKEN_PATTERN.test(value)) {
      storeToken(value);
      return value;
    }
  }
  if (memoryToken !== null) return memoryToken;
  try {
    const stored = window.sessionStorage.getItem(TOKEN_KEY);
    if (stored !== null && TOKEN_PATTERN.test(stored)) {
      memoryToken = stored;
      return stored;
    }
  } catch {
    // Storage can be blocked; the token then lives in memory only.
  }
  return null;
}

/** @param {string} token 64 lowercase hex characters */
export function storeToken(token) {
  memoryToken = token;
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Memory only.
  }
}

export function clearToken() {
  memoryToken = null;
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

/** @param {string} value */
export function isToken(value) {
  return TOKEN_PATTERN.test(value);
}

/** An error answer of the API (API.md section 4), or `unreachable` when nothing answered. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

/**
 * @param {string} token
 * @param {{ onUnauthorized: () => void }} hooks
 */
export function createClient(token, { onUnauthorized }) {
  async function request(method, path, body, { signal } = {}) {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError(0, 'unreachable', 'The node did not answer. It may have stopped.');
    }
    let payload = null;
    const text = await res.text();
    if (text !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (res.ok) return payload;
    if (res.status === 401) onUnauthorized();
    const err = payload?.error;
    throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? `HTTP ${res.status}`, err?.details);
  }
  return {
    get: (path, options) => request('GET', path, undefined, options),
    post: (path, body, options) => request('POST', path, body, options),
    del: (path, options) => request('DELETE', path, undefined, options),
  };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * The node's event stream, resumed with Last-Event-ID after every disconnect.
 *
 * Callbacks: `onEvent(event)` for bus events (`{ seq, ts, type, data }`), `onHello(hello)`,
 * `onGap(gap)` for `stream.gap`, `onState(state)` with `connecting`, `live`, `reconnecting`
 * or `unauthorized`.
 */
export class EventStream {
  #token;
  #hooks;
  #controller = new AbortController();
  #lastId = null;
  #retryMs = DEFAULT_RETRY_MS;

  constructor(token, hooks) {
    this.#token = token;
    this.#hooks = hooks;
  }

  start() {
    this.#run();
  }

  stop() {
    this.#controller.abort();
  }

  async #run() {
    const stopSignal = this.#controller.signal;
    let failures = 0;
    this.#hooks.onState('connecting');
    while (!stopSignal.aborted) {
      const attempt = new AbortController();
      const abortAttempt = () => attempt.abort();
      stopSignal.addEventListener('abort', abortAttempt, { once: true });
      let lastByteAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > STREAM_SILENCE_MS) attempt.abort();
      }, 5000);
      try {
        const headers = { authorization: `Bearer ${this.#token}`, accept: 'text/event-stream' };
        if (this.#lastId !== null) headers['last-event-id'] = this.#lastId;
        const res = await fetch(BASE + '/events', { headers, signal: attempt.signal, cache: 'no-store', credentials: 'omit' });
        if (res.status === 401) {
          this.#hooks.onState('unauthorized');
          return;
        }
        if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
        failures = 0;
        this.#hooks.onState('live');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          lastByteAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            this.#frame(block);
          }
          // A frame can never be this large; a stream that sends one is broken.
          if (buffer.length > 4 * 1024 * 1024) throw new Error('oversized frame');
        }
      } catch {
        // Fall through to the reconnect below; the reason does not change what we do.
      } finally {
        clearInterval(watchdog);
        stopSignal.removeEventListener('abort', abortAttempt);
      }
      if (stopSignal.aborted) return;
      failures += 1;
      this.#hooks.onState('reconnecting');
      await sleep(Math.min(MAX_RETRY_MS, this.#retryMs * Math.min(failures, 4)), stopSignal);
    }
  }

  #frame(block) {
    let id = null;
    let type = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry' && /^\d+$/.test(value)) this.#retryMs = Math.max(500, Math.min(MAX_RETRY_MS, Number(value)));
    }
    if (data.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (type === 'stream.hello') this.#hooks.onHello(payload);
    else if (type === 'stream.gap') this.#hooks.onGap(payload);
    else if (payload && typeof payload.seq === 'number' && typeof payload.type === 'string') {
      if (id !== null) this.#lastId = id;
      this.#hooks.onEvent(payload);
    }
  }
}
