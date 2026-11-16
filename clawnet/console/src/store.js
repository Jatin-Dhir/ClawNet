/**
 * Live state for the views: an in-page event bus fed by the node's event stream, and the
 * snapshot-then-events pattern of API.md section 9 as a hook.
 */

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export const NodeContext = createContext(null);
export const StatusContext = createContext(null);

/** @returns {{ api, bus, streamState, traffic, log, navigate, boot }} */
export function useNode() {
  return useContext(NodeContext);
}

/** The latest GET /status answer, or null before the first one. */
export function useStatus() {
  return useContext(StatusContext);
}

/** A synthetic bus event telling every snapshot to refetch (gap, restart, reconnect). */
export const RESYNC = '@resync';

/** Does `type` match one of `patterns` (exact types, or prefixes ending in `.*`)? */
export function matchesType(type, patterns) {
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern) return true;
  }
  return false;
}

export function createBus() {
  const listeners = new Set();
  return {
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

/** A tiny external store for useSyncExternalStore. */
function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const TRAFFIC_KEEP = 240;

/** The last two minutes of `traffic.sample` events, kept from page load on. */
export function createTrafficHistory() {
  const store = createStore([]);
  return {
    store,
    push(event) {
      const d = event.data;
      if (!d || !Array.isArray(d.links)) return;
      let packetsIn = 0;
      let packetsOut = 0;
      let bytesIn = 0;
      let bytesOut = 0;
      for (const link of d.links) {
        packetsIn += link.packetsIn ?? 0;
        packetsOut += link.packetsOut ?? 0;
        bytesIn += link.bytesIn ?? 0;
        bytesOut += link.bytesOut ?? 0;
      }
      const sample = { ts: event.ts, intervalMs: d.intervalMs || 500, packetsIn, packetsOut, bytesIn, bytesOut, forwarder: d.forwarder ?? {}, suppressed: d.suppressed ?? 0 };
      const next = store.get().concat(sample);
      store.set(next.length > TRAFFIC_KEEP ? next.slice(next.length - TRAFFIC_KEEP) : next);
    },
  };
}

export function useTraffic() {
  const { traffic } = useNode();
  return useSyncExternalStore(traffic.store.subscribe, traffic.store.get);
}

const LOG_KEEP = 1000;

/** Recent events and stream markers for the event log, newest last. */
export function createEventLog() {
  const store = createStore([]);
  const seen = new Set();
  const add = (entries) => {
    let next = store.get().concat(entries);
    if (next.length > LOG_KEEP) {
      for (const dropped of next.slice(0, next.length - LOG_KEEP)) seen.delete(dropped.key);
      next = next.slice(next.length - LOG_KEEP);
    }
    store.set(next);
  };
  return {
    store,
    event(boot, event) {
      const key = `${boot}-${event.seq}`;
      if (seen.has(key)) return;
      seen.add(key);
      add([{ key, kind: 'event', ...event }]);
    },
    /** History fetched from /diag/events: merged in seq order before the live tail. */
    history(boot, events) {
      const fresh = [];
      for (const event of events) {
        const key = `${boot}-${event.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({ key, kind: 'event', ...event });
      }
      if (fresh.length === 0) return;
      const merged = fresh.concat(store.get()).sort((a, b) => (a.ts - b.ts) || ((a.seq ?? 0) - (b.seq ?? 0)));
      store.set(merged.slice(-LOG_KEEP));
    },
    marker(text) {
      const key = `m-${Date.now()}-${Math.random()}`;
      add([{ key, kind: 'marker', ts: Date.now(), text }]);
    },
    clear() {
      seen.clear();
      store.set([]);
    },
  };
}

export function useEventLog() {
  const { log } = useNode();
  return useSyncExternalStore(log.store.subscribe, log.store.get);
}

/**
 * Call `handler(event)` for every live event whose type matches `patterns`.
 *
 * @param {string[]} patterns
 * @param {(event: object) => void} handler
 */
export function useEvents(patterns, handler) {
  const { bus } = useNode();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = patterns.join(',');
  useEffect(() => {
    const list = key === '' ? [] : key.split(',');
    return bus.on((event) => {
      if (event.type !== RESYNC && matchesType(event.type, list)) handlerRef.current(event);
    });
  }, [bus, key]);
}

/**
 * A snapshot endpoint kept current by events (API.md section 9).
 *
 * `apply(data, event)` returns the new data, the same object to ignore the event, or
 * `undefined` to ask for a refetch. Without `apply`, every matching event refetches
 * (throttled to one request per `debounceMs`). Events older than the snapshot's `asOf.seq`
 * are skipped; events that arrive while a request is in flight are applied on top of it.
 *
 * @param {string | null} path relative to /api/v1; null disables the hook
 * @param {{ events?: string[], apply?: Function, debounceMs?: number, intervalMs?: number }} [options]
 */
export function useSnapshot(path, { events = [], apply, debounceMs = 300, intervalMs = 0 } = {}) {
  const { api, bus } = useNode();
  const [state, setState] = useState({ data: null, error: null, loading: path !== null });
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const controls = useRef({ refetch: () => {}, setData: () => {} });
  const key = events.join(',');

  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }
    // A different path is a different resource: never show the previous one's data.
    setState({ data: null, error: null, loading: true });
    const patterns = key === '' ? [] : key.split(',');
    let disposed = false;
    let requestNo = 0;
    let timer = null;
    let inFlight = false;
    let buffer = [];
    let asOfSeq = null;
    let current = null;

    const commit = (data) => {
      current = data;
      setState({ data, error: null, loading: false });
    };
    const schedule = () => {
      if (timer !== null || disposed) return;
      timer = setTimeout(() => {
        timer = null;
        load();
      }, debounceMs);
    };
    const step = (data, event) => {
      if (asOfSeq !== null && event.seq <= asOfSeq) return data;
      const fn = applyRef.current;
      return fn ? fn(data, event) : undefined;
    };
    async function load() {
      const mine = ++requestNo;
      inFlight = true;
      buffer = [];
      try {
        const data = await api.get(path);
        if (disposed || mine !== requestNo) return;
        inFlight = false;
        asOfSeq = typeof data?.asOf?.seq === 'number' ? data.asOf.seq : null;
        let next = data;
        let stale = false;
        for (const event of buffer) {
          const applied = step(next, event);
          if (applied === undefined) {
            stale = true;
            break;
          }
          next = applied;
        }
        buffer = [];
        commit(next);
        if (stale) schedule();
      } catch (error) {
        if (disposed || mine !== requestNo || error?.name === 'AbortError') return;
        inFlight = false;
        setState((s) => ({ data: s.data, error, loading: false }));
      }
    }

    controls.current = {
      refetch: () => load(),
      setData: (fn) => {
        if (current === null) return;
        commit(fn(current));
      },
    };

    const off = bus.on((event) => {
      if (event.type === RESYNC) {
        schedule();
        return;
      }
      if (!matchesType(event.type, patterns)) return;
      if (inFlight) {
        buffer.push(event);
        return;
      }
      if (current === null) return;
      const next = step(current, event);
      if (next === undefined) schedule();
      else if (next !== current) commit(next);
    });
    load();
    const interval = intervalMs > 0 ? setInterval(() => {
      if (!document.hidden && !inFlight) load();
    }, intervalMs) : null;
    return () => {
      disposed = true;
      off();
      if (timer !== null) clearTimeout(timer);
      if (interval !== null) clearInterval(interval);
    };
  }, [api, bus, path, key, debounceMs, intervalMs]);

  return { ...state, refetch: () => controls.current.refetch(), setData: (fn) => controls.current.setData(fn) };
}

/** Every node this node knows of, for pickers: from GET /topology, refreshed on change. */
export function useDirectory() {
  const snap = useSnapshot('/topology', { events: ['topology.changed', 'routes.changed'], debounceMs: 1000 });
  const nodes = snap.data?.nodes ?? [];
  return { nodes, self: snap.data?.self ?? null, loading: snap.loading, error: snap.error };
}

/** The current time, updated every `ms` while the page is visible. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Whether the user asked the system for reduced motion; follows changes. */
export function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setReduced(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
