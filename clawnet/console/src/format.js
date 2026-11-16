/** Formatting for numbers, sizes, times and node ids; all through Intl. */
/* global Intl -- an ECMAScript built-in that the shared eslint globals list leaves out */

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const clockMs = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false });
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export const NODE_ID = /^[a-z2-7]{52}$/;

export function short(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '-';
}

export function fmtInt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? integer.format(n) : '-';
}

export function fmtNum(n) {
  return typeof n === 'number' && Number.isFinite(n) ? twoDecimals.format(n) : '-';
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  let value = n;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${integer.format(value)} B` : `${oneDecimal.format(value)} ${UNITS[unit]}`;
}

export function fmtRate(bytesPerSec) {
  return typeof bytesPerSec === 'number' ? `${fmtBytes(bytesPerSec)}/s` : '-';
}

export function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
  if (ms < 10) return `${twoDecimals.format(ms)} ms`;
  if (ms < 1000) return `${integer.format(ms)} ms`;
  return `${oneDecimal.format(ms / 1000)} s`;
}

export function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} d ${h} h ${m} m`;
  if (h > 0) return `${h} h ${m} m ${sec} s`;
  if (m > 0) return `${m} m ${sec} s`;
  return `${sec} s`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (typeof ts !== 'number' || ts <= 0) return 'never';
  const diff = Math.max(0, now - ts);
  if (diff < 1500) return 'just now';
  return `${fmtDuration(diff)} ago`;
}

export function fmtClock(ts, withMs = false) {
  if (typeof ts !== 'number' || ts <= 0) return '-';
  return (withMs ? clockMs : clock).format(ts);
}

export function fmtWhen(ts) {
  if (typeof ts !== 'number' || ts <= 0) return '-';
  const sameDay = new Date(ts).toDateString() === new Date().toDateString();
  return sameDay ? clock.format(ts) : dateTime.format(ts);
}

/** Byte length of a string in UTF-8, which is what the API's text limits count. */
export function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

/** A compact one-line rendering of an event's data for log rows. */
export function compactData(data) {
  if (data === null || data === undefined) return '';
  const text = JSON.stringify(data, (key, value) => (typeof value === 'string' && NODE_ID.test(value) ? short(value) : value));
  return text.length > 220 ? text.slice(0, 219) + String.fromCodePoint(0x2026) : text;
}
