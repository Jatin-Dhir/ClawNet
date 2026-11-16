import { useState } from 'react';
import { Empty } from '../components.jsx';
import { compactData, fmtClock } from '../format.js';
import { matchesType, useEventLog, useNode } from '../store.js';

const SHOW = 300;

export default function EventLog() {
  const { log } = useNode();
  const entries = useEventLog();
  const [filter, setFilter] = useState('');
  const [hideNoise, setHideNoise] = useState(true);
  const [frozen, setFrozen] = useState(null);
  const [open, setOpen] = useState(null);

  const source = frozen ?? entries;
  const patterns = filter.split(',').map((s) => s.trim()).filter(Boolean).map((p) => (p.includes('*') || p.includes('.') ? p : `${p}.*`));
  const visible = [];
  for (let i = source.length - 1; i >= 0 && visible.length < SHOW; i--) {
    const e = source[i];
    if (e.kind === 'event') {
      if (hideNoise && (e.type === 'traffic.sample' || e.type === 'link.metric')) continue;
      if (patterns.length && !matchesType(e.type, patterns) && !patterns.some((p) => e.type.startsWith(p.replace(/\.\*$/, '')))) continue;
    }
    visible.push(e);
  }
  return (
    <div className="view">
      <header className="view-head">
        <h1>Event log</h1>
        <p className="muted">Everything the node&apos;s event bus emits, newest first. Holds the last 1,000 events seen by this page, plus the 200 before it opened.</p>
      </header>
      <div className="form-row sticky-bar">
        <label htmlFor="ev-filter" className="sr-only">Filter by type</label>
        <input id="ev-filter" className="mono" placeholder="Filter by type: packet, link.*, chat.message" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check"><input type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} /> Hide traffic samples and link metrics</label>
        <button type="button" className="btn btn-ghost" aria-pressed={frozen !== null} onClick={() => setFrozen(frozen ? null : entries)}>{frozen ? 'Resume' : 'Pause'}</button>
        <button type="button" className="btn btn-ghost" onClick={() => { log.clear(); setFrozen(null); }}>Clear</button>
      </div>
      {frozen && <p className="banner banner-info" role="status">Paused at {frozen.length} entries. New events are still collected and appear when you resume.</p>}
      {visible.length === 0 ? (
        <Empty title={entries.length === 0 ? 'No events yet' : 'No event matches'}>{entries.length === 0 ? 'Events appear here as the node emits them.' : 'Change the filter to see more.'}</Empty>
      ) : (
        <ol className="log">
          {visible.map((e) => e.kind === 'marker' ? (
            <li key={e.key} className="log-marker"><span className="mono">{fmtClock(e.ts)}</span> {e.text}</li>
          ) : (
            <li key={e.key} className={`log-row type-${e.type.split('.')[0]}`}>
              <button type="button" className="log-btn" aria-expanded={open === e.key} onClick={() => setOpen(open === e.key ? null : e.key)}>
                <span className="mono muted log-seq">{e.seq}</span>
                <span className="mono muted">{fmtClock(e.ts, true)}</span>
                <span className="mono log-type">{e.type}</span>
                <span className="mono log-data">{compactData(e.data)}</span>
              </button>
              {open === e.key && <pre className="log-json">{JSON.stringify(e.data, null, 2)}</pre>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
