import { useEffect, useId, useRef, useState } from 'react';
import { NODE_ID, short } from './format.js';

/** A NodeId shown by its first 8 characters; the full id is in the title and copyable. */
export function NodeId({ id, self = false, copy = false }) {
  if (typeof id !== 'string') return <span className="muted">-</span>;
  return (
    <span className="node-id" title={id}>
      <span className={self ? 'mono self-text' : 'mono'}>{short(id)}</span>
      {self && <span className="tag">this node</span>}
      {copy && <CopyButton text={id} label="Copy node id" />}
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(timer);
  }, [done]);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs"
      aria-label={label}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false));
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** tone: ok, warn, bad, info, neutral, self */
export function Badge({ tone = 'neutral', children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function Panel({ title, actions, children, className = '', id }) {
  const headingId = useId();
  return (
    <section className={`panel ${className}`} aria-labelledby={title ? headingId : undefined} id={id}>
      {(title || actions) && (
        <header className="panel-head">
          {title && <h2 id={headingId}>{title}</h2>}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-body">{children}</p>}
    </div>
  );
}

export function Loading({ label = 'Loading' }) {
  return <p className="loading" role="status">{label}</p>;
}

/** What the operator can do about each API error code (API.md section 4). */
const RECOVERY = {
  unreachable: 'Check that the node process is still running; this page retries on its own.',
  unknown_destination: 'This node has no identity card for that id yet. Check the id, or wait until the node appears in Topology.',
  outbox_full: 'Wait for queued messages to be delivered or expire, then send again.',
  busy: 'Another diagnostic is running on this node. Try again when it finishes.',
  not_joined: 'Join the channel first.',
  already_joined: 'Leave the channel first to join it with a different key.',
  invalid_state: 'The transfer changed state meanwhile; the list shows its current state.',
  peer_limit: 'Disconnect a peer, or raise peers.max in the node configuration.',
  connect_failed: 'Check the address and that both nodes use the same network id and key.',
  invalid_file: 'Check that the path names a readable file on the node\'s machine, within files.maxSizeBytes.',
  not_running: 'The node is starting or stopping. Try again in a moment.',
  too_many_streams: 'Close other console tabs open on this node.',
  storage: 'The node could not write to its data directory. Check free space and permissions.',
  internal: 'The node logged the details. Check its log file.',
};

/** An API error, worded for the operator; `code` stays visible because scripts use it. */
export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  const unreachable = error.code === 'unreachable';
  const retry = error.details?.retryInMs ? `Try again in ${Math.ceil(error.details.retryInMs / 1000)} s.` : null;
  const advice = retry ?? RECOVERY[error.code] ?? null;
  return (
    <div className="error-note" role="alert">
      <span className="mono error-code">{unreachable ? 'no answer' : error.code}</span>
      <span>{error.message}{advice ? ` ${advice}` : ''}</span>
      {onRetry && <button type="button" className="btn btn-ghost btn-xs" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/**
 * Choose a destination: any node this node knows of, or a pasted NodeId.
 * Calls `onChange` with a full NodeId, or '' while the choice is incomplete.
 */
export function NodePicker({ id, nodes, selfId, value, onChange, allowSelf = false }) {
  const others = nodes
    .filter((n) => allowSelf || n.id !== selfId)
    .sort((a, b) => (a.reachable === b.reachable ? (a.hops ?? 99) - (b.hops ?? 99) || a.id.localeCompare(b.id) : a.reachable ? -1 : 1));
  const known = others.some((n) => n.id === value);
  const [manual, setManual] = useState(value !== '' && !known);
  const [typed, setTyped] = useState(manual ? value : '');
  const typedValid = NODE_ID.test(typed.trim());
  const showTyped = manual && !known;
  return (
    <div className="picker">
      <select
        id={id}
        value={known ? value : manual ? '__other' : ''}
        onChange={(e) => {
          if (e.target.value === '__other') {
            setManual(true);
            onChange(typedValid ? typed.trim() : '');
          } else {
            setManual(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">Choose a node</option>
        {others.map((n) => (
          <option key={n.id} value={n.id}>
            {n.shortId ?? short(n.id)}
            {n.id === selfId ? ' (this node)' : n.reachable ? ` - ${n.hops} hop${n.hops === 1 ? '' : 's'}, cost ${n.cost}` : ' - no route'}
          </option>
        ))}
        <option value="__other">Another node id</option>
      </select>
      {showTyped && (
        <input
          type="text"
          className="mono"
          aria-label="Node id, 52 characters"
          placeholder="52-character node id"
          spellCheck="false"
          autoComplete="off"
          value={typed}
          onChange={(e) => {
            const next = e.target.value;
            setTyped(next);
            onChange(NODE_ID.test(next.trim()) ? next.trim() : '');
          }}
          aria-invalid={typed !== '' && !typedValid}
        />
      )}
      {showTyped && typed !== '' && !typedValid && <p className="hint hint-bad">A node id is 52 characters from a-z and 2-7.</p>}
    </div>
  );
}

/** A destructive action that asks once, inline, before it acts. */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled }) {
  const [asking, setAsking] = useState(false);
  const yesRef = useRef(null);
  useEffect(() => {
    if (asking) yesRef.current?.focus();
  }, [asking]);
  if (!asking) {
    return <button type="button" className="btn btn-ghost btn-xs" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  }
  return (
    <span className="confirm">
      <button ref={yesRef} type="button" className="btn btn-danger btn-xs" onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAsking(false)}>Keep</button>
    </span>
  );
}

/**
 * Lines over a time window. `series`: [{ label, color, points: [{ t, v }] }].
 * Gaps longer than `gapMs` are drawn at zero, because the node sends no sample when idle.
 */
export function Sparkline({ series, windowMs, now, height = 56, label }) {
  const width = 600;
  let max = 0;
  for (const s of series) for (const p of s.points) max = Math.max(max, p.v);
  const scale = max > 0 ? (height - 4) / max : 0;
  const x = (t) => ((t - (now - windowMs)) / windowMs) * width;
  const paths = series.map((s) => {
    let d = '';
    let prev = null;
    for (const p of s.points) {
      if (p.t < now - windowMs) continue;
      const px = x(p.t).toFixed(1);
      const py = (height - 2 - p.v * scale).toFixed(1);
      if (prev === null) d += `M${px},${height - 2} L${px},${py}`;
      else if (p.t - prev > 1500) d += ` L${x(prev + 500).toFixed(1)},${height - 2} L${x(p.t - 500).toFixed(1)},${height - 2} L${px},${py}`;
      else d += ` L${px},${py}`;
      prev = p.t;
    }
    if (prev !== null && now - prev > 1500) d += ` L${x(prev + 500).toFixed(1)},${height - 2} L${width},${height - 2}`;
    return { ...s, d };
  });
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line x1="0" x2={width} y1={height - 1.5} y2={height - 1.5} className="spark-base" />
      {paths.map((p) => p.d && <path key={p.label} d={p.d} stroke={p.color} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

/** A bar showing done / total; the number beside it carries the value. */
export function Progress({ value, max, tone = 'info', label }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <div className={`progress-fill tone-${tone}`} style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  );
}
