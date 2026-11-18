/**
 * Where the phone keeps its state: a small JSON key-value store over the browser's
 * localStorage (available on plain-http pages, unlike most newer storage APIs), or over a
 * Map for tests and for browsers that refuse storage.
 *
 * Everything lives under one prefix. Values are JSON; a value that cannot be read back is
 * treated as absent rather than trusted.
 *
 * What is kept, and why it matters (web/README.md):
 *   identity   the three private keys and the network they belong to. Whoever reads
 *              them is this phone on the network. Protected by the phone's own lock and
 *              the browser's per-site storage, not by a passphrase.
 *   network    the network id and, for a private network, its key.
 *   seq        the sequence numbers of this node's own records, so a reload never goes
 *              back.
 *   outbox, seen, chats  messages waiting for an acknowledgement, the replay cache, the
 *              conversation history.
 */

const PREFIX = 'clawnet.';

/**
 * @param {Storage | Map<string, string> | null} [backend] default: localStorage when the
 *   browser offers it, else an in-memory Map (nothing then survives a reload)
 * @returns {{ get(key: string): any, set(key: string, value: any): boolean, remove(key: string): void,
 *   clear(): void, persistent: boolean }}
 */
export function createStorage(backend) {
  const store = backend === undefined ? defaultBackend() : backend ?? new Map();
  const isMap = store instanceof Map;
  return {
    persistent: !isMap,
    get(key) {
      let text;
      try {
        text = isMap ? store.get(PREFIX + key) : store.getItem(PREFIX + key);
      } catch {
        return null;
      }
      if (typeof text !== 'string') return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    set(key, value) {
      const text = JSON.stringify(value);
      try {
        if (isMap) store.set(PREFIX + key, text);
        else store.setItem(PREFIX + key, text);
        return true;
      } catch {
        // Quota or a private-browsing refusal: the caller keeps working from memory.
        return false;
      }
    },
    remove(key) {
      try {
        if (isMap) store.delete(PREFIX + key);
        else store.removeItem(PREFIX + key);
      } catch {
        // Nothing to do.
      }
    },
    clear() {
      try {
        if (isMap) {
          for (const key of [...store.keys()]) if (key.startsWith(PREFIX)) store.delete(key);
        } else {
          const keys = [];
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i);
            if (key !== null && key.startsWith(PREFIX)) keys.push(key);
          }
          for (const key of keys) store.removeItem(key);
        }
      } catch {
        // Nothing to do.
      }
    },
  };
}

function defaultBackend() {
  try {
    const local = globalThis.localStorage;
    if (local !== undefined && local !== null) {
      const probe = `${PREFIX}probe`;
      local.setItem(probe, '1');
      local.removeItem(probe);
      return local;
    }
  } catch {
    // Storage disabled.
  }
  return new Map();
}
