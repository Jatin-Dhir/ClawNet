import { useRef, useState } from 'react';
import { Badge, Empty, ErrorNote, Field, Loading, NodeId, NodePicker, Panel } from '../components.jsx';
import { NODE_ID, fmtAgo, fmtBytes, fmtInt, fmtMs, fmtNum, short } from '../format.js';
import { useDirectory, useEvents, useNode, useNow, useSnapshot } from '../store.js';

const TOOLS = [
  ['ping', 'Ping'],
  ['trace', 'Traceroute'],
  ['routes', 'Routes'],
  ['outbox', 'Outbox'],
  ['counters', 'Counters'],
  ['sync', 'Sync'],
];

export default function Diagnostics({ query, navigate }) {
  const tool = TOOLS.some(([k]) => k === query.get('tool')) ? query.get('tool') : 'ping';
  const toParam = query.get('to');
  const initialTo = toParam && NODE_ID.test(toParam) ? toParam : '';
  const go = (k) => navigate(`/diagnostics?tool=${k}${initialTo ? `&to=${initialTo}` : ''}`);
  return (
    <div className="view">
      <header className="view-head">
        <h1>Diagnostics</h1>
        <p className="muted">Probe other nodes and read this node&apos;s routing table, outbox, counters and sync statistics.</p>
      </header>
      <div className="tabs" role="tablist" aria-label="Diagnostic tools">
        {TOOLS.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={k === tool} aria-controls="tool-panel" tabIndex={k === tool ? 0 : -1}
            onClick={() => go(k)}
            onKeyDown={(e) => {
              const i = TOOLS.findIndex(([x]) => x === tool);
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const next = TOOLS[(i + (e.key === 'ArrowRight' ? 1 : TOOLS.length - 1)) % TOOLS.length][0];
                go(next);
                requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div id="tool-panel" role="tabpanel" aria-labelledby={`tab-${tool}`}>
        {tool === 'ping' && <Ping initialTo={initialTo} />}
        {tool === 'trace' && <Trace initialTo={initialTo} />}
        {tool === 'routes' && <Routes />}
        {tool === 'outbox' && <Outbox />}
        {tool === 'counters' && <Counters />}
        {tool === 'sync' && <Sync />}
      </div>
    </div>
  );
}

function intIn(text, min, max) {
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function Ping({ initialTo }) {
  const { api } = useNode();
  const directory = useDirectory();
  const [to, setTo] = useState(initialTo);
  const [count, setCount] = useState('4');
  const [interval, setIntervalMs] = useState('1000');
  const [running, setRunning] = useState(null);
  const [live, setLive] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const runRef = useRef(null);
  useEvents(['diag.ping'], (event) => {
    if (runRef.current && event.data?.dst === runRef.current) setLive((l) => [...l, event.data]);
  });
  const n = intIn(count, 1, 100);
  const iv = intIn(interval, 10, 60000);
  const run = async (e) => {
    e.preventDefault();
    if (!to || n === null || iv === null) {
      setError({ code: 'invalid_request', message: !to ? 'Choose the node to ping.' : n === null ? 'Probes must be a whole number from 1 to 100.' : 'Interval must be a whole number of milliseconds from 10 to 60000.' });
      return;
    }
    runRef.current = to;
    setRunning(to);
    setLive([]);
    setResult(null);
    setError(null);
    try {
      setResult(await api.post('/diag/ping', { to, count: n, intervalMs: iv }));
    } catch (err) {
      setError(err);
    } finally {
      runRef.current = null;
      setRunning(null);
    }
  };
  const probes = result ? result.probes : live;
  return (
    <div className="two-col wide-right">
      <Panel title="Ping">
        <form className="form-grid" onSubmit={run}>
          <Field label="Node" htmlFor="ping-to"><NodePicker id="ping-to" nodes={directory.nodes} selfId={directory.self} value={to} onChange={setTo} /></Field>
          <div className="form-pair">
            <Field label="Probes (1-100)" htmlFor="ping-count"><input id="ping-count" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} aria-invalid={n === null ? 'true' : undefined} /></Field>
            <Field label="Interval, ms" htmlFor="ping-iv"><input id="ping-iv" inputMode="numeric" value={interval} onChange={(e) => setIntervalMs(e.target.value)} aria-invalid={iv === null ? 'true' : undefined} /></Field>
          </div>
          <div><button type="submit" className="btn btn-primary" disabled={Boolean(running)}>{running ? 'Pinging' : 'Ping'}</button></div>
          <ErrorNote error={error} />
        </form>
      </Panel>
      <Panel title="Replies">
        {result && (
          <p className="summary">
            <span className="num">{result.received}/{result.sent}</span> answered, <span className="num">{fmtNum(result.lossPct)}%</span> lost
            {result.rttMs && <> · round trip <span className="num">{fmtMs(result.rttMs.min)} / {fmtMs(result.rttMs.avg)} / {fmtMs(result.rttMs.max)}</span> <span className="muted">min/avg/max</span></>}
          </p>
        )}
        {probes.length === 0 ? <p className="muted">{running ? `Waiting for the first reply from ${short(running)}.` : 'Run a ping to see each probe here as it returns.'}</p> : (
          <table className="table compact">
            <thead><tr><th scope="col" className="num">Probe</th><th scope="col" className="num">Round trip</th><th scope="col" className="num">Hops</th></tr></thead>
            <tbody>
              {probes.map((p) => (
                <tr key={p.seq}><td className="num">{p.seq}</td><td className="num">{p.rttMs === null ? <Badge tone="bad">no answer</Badge> : fmtMs(p.rttMs)}</td><td className="num">{p.hops ?? '-'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Trace({ initialTo }) {
  const { api } = useNode();
  const directory = useDirectory();
  const [to, setTo] = useState(initialTo);
  const [running, setRunning] = useState(null);
  const [live, setLive] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const runRef = useRef(null);
  useEvents(['diag.trace_hop'], (event) => {
    if (runRef.current && event.data?.dst === runRef.current) setLive((l) => [...l, event.data]);
  });
  const run = async (e) => {
    e.preventDefault();
    if (!to) {
      setError({ code: 'invalid_request', message: 'Choose the node to trace.' });
      return;
    }
    runRef.current = to;
    setRunning(to);
    setLive([]);
    setResult(null);
    setError(null);
    try {
      setResult(await api.post('/diag/traceroute', { to }));
    } catch (err) {
      setError(err);
    } finally {
      runRef.current = null;
      setRunning(null);
    }
  };
  const hops = result ? result.hops : live;
  return (
    <div className="two-col wide-right">
      <Panel title="Traceroute">
        <form className="form-grid" onSubmit={run}>
          <Field label="Node" htmlFor="trace-to" hint="Each hop answers with a sealed reply. Three silent hops in a row end the trace.">
            <NodePicker id="trace-to" nodes={directory.nodes} selfId={directory.self} value={to} onChange={setTo} />
          </Field>
          <div><button type="submit" className="btn btn-primary" disabled={Boolean(running)}>{running ? 'Tracing' : 'Trace'}</button></div>
          <ErrorNote error={error} />
        </form>
      </Panel>
      <Panel title="Path">
        {result && <p className="summary">{result.reached ? <Badge tone="ok">reached</Badge> : <Badge tone="bad">not reached</Badge>} <span className="muted">in {result.hops.filter((h) => h.node).length} answered hop(s)</span></p>}
        {hops.length === 0 ? <p className="muted">{running ? 'Waiting for the first hop.' : 'Run a trace to see the measured path, hop by hop.'}</p> : (
          <ol className="hops">
            {hops.map((h) => (
              <li key={h.n}>
                <span className="num hop-n">{h.n}</span>
                {h.node ? <NodeId id={h.node} /> : <span className="muted">no answer</span>}
                <span className="num muted">{fmtMs(h.rttMs)}</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

function Routes() {
  const routes = useSnapshot('/topology/routes', { events: ['routes.changed'], debounceMs: 300 });
  const list = routes.data?.routes ?? [];
  return (
    <Panel title={`Routing table${routes.data ? ` · revision ${routes.data.rev}` : ''}`}>
      <ErrorNote error={routes.error} onRetry={routes.refetch} />
      {routes.loading && !routes.data ? <Loading /> : list.length === 0 ? <Empty title="No routes">This node has no route to any other node.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Destination</th><th scope="col">Next hop</th><th scope="col" className="num">Cost</th><th scope="col" className="num">Hops</th><th scope="col">Path</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.dst}>
                  <th scope="row"><NodeId id={r.dst} /></th>
                  <td><NodeId id={r.nextHop} /></td>
                  <td className="num">{r.cost}</td>
                  <td className="num">{r.hops}</td>
                  <td className="mono">{r.path.map(short).join(' > ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Outbox() {
  const now = useNow(1000);
  const outbox = useSnapshot('/outbox', { events: ['message.*', 'custody.*'], debounceMs: 500 });
  const entries = outbox.data?.entries ?? [];
  return (
    <Panel title={`Outbox${outbox.data ? ` · ${outbox.data.total} undelivered` : ''}`}>
      <ErrorNote error={outbox.error} onRetry={outbox.refetch} />
      {outbox.loading && !outbox.data ? <Loading /> : entries.length === 0 ? <Empty title="Outbox empty">Every reliable message this node sent has been acknowledged.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Message</th><th scope="col">To</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col" className="num">Tries</th><th scope="col">Next try</th><th scope="col" className="num">Size</th><th scope="col">Custody</th></tr></thead>
            <tbody>
              {entries.map((m) => (
                <tr key={m.id}>
                  <th scope="row" className="mono">{m.id.slice(0, 12)}</th>
                  <td><NodeId id={m.dst} /></td>
                  <td>{m.kind}</td>
                  <td>{m.state === 'waiting' ? <Badge tone="warn">no route</Badge> : <Badge tone="info">retrying</Badge>}</td>
                  <td className="num">{m.attempts}</td>
                  <td>{m.nextAttemptAt === null ? 'when a route appears' : m.nextAttemptAt > now ? `in ${fmtMs(m.nextAttemptAt - now)}` : 'now'}</td>
                  <td className="num">{fmtBytes(m.bytes)}</td>
                  <td>{m.custodian ? <><NodeId id={m.custodian} /> {m.custodyState}</> : <span className="muted">{m.custody ? 'allowed' : 'no'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Counters() {
  const counters = useSnapshot('/diag/counters', { intervalMs: 2000 });
  const [filter, setFilter] = useState('');
  const [moving, setMoving] = useState(false);
  const data = counters.data;
  const f = filter.trim().toLowerCase();
  const rows = data ? Object.keys(data.totals).sort().filter((k) => (!f || k.toLowerCase().includes(f)) && (!moving || data.rates[k])) : [];
  return (
    <Panel
      title="Counters"
      actions={data && <span className="muted">rates over the last {fmtMs(data.windowMs)} · refreshed every 2 s · read {fmtAgo(data.at)}</span>}
    >
      <div className="form-row">
        <label htmlFor="ctr-filter" className="sr-only">Filter counters</label>
        <input id="ctr-filter" className="mono" placeholder="Filter, for example forwarder or peers.bytes" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check"><input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} /> Only counters that moved</label>
      </div>
      <ErrorNote error={counters.error} onRetry={counters.refetch} />
      {!data ? <Loading /> : rows.length === 0 ? <p className="muted">No counter matches.</p> : (
        <div className="table-wrap tall">
          <table className="table compact">
            <thead><tr><th scope="col">Counter</th><th scope="col" className="num">Total</th><th scope="col" className="num">Per second</th></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k}>
                  <th scope="row" className="mono">{k}</th>
                  <td className="num">{fmtInt(data.totals[k])}</td>
                  <td className="num">{data.rates[k] ? fmtNum(data.rates[k]) : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Sync() {
  const sync = useSnapshot('/diag/sync', { intervalMs: 3000 });
  const data = sync.data;
  return (
    <div className="two-col wide-right">
      <Panel title="Datasets">
        <ErrorNote error={sync.error} onRetry={sync.refetch} />
        {!data ? <Loading /> : (
          <table className="table compact">
            <thead><tr><th scope="col">Dataset</th><th scope="col" className="num">Records held</th></tr></thead>
            <tbody>{data.datasets.map((d) => <tr key={d.name}><th scope="row" className="mono">{d.name}</th><td className="num">{fmtInt(d.entries)}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
      <Panel title="Sync engine" actions={<span className="muted">refreshed every 3 s</span>}>
        {!data ? <Loading /> : (
          <dl className="kv kv-grid">
            {Object.entries(data.engine).map(([k, v]) => (
              <div key={k}><dt className="mono">{k}</dt><dd className="num">{typeof v === 'number' ? fmtInt(v) : JSON.stringify(v)}</dd></div>
            ))}
          </dl>
        )}
      </Panel>
    </div>
  );
}
