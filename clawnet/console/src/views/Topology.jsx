import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, CopyButton, Empty, ErrorNote, Loading, NodeId } from '../components.jsx';
import { fmtClock, fmtDuration, fmtInt, short } from '../format.js';
import { useEvents, useReducedMotion, useSnapshot } from '../store.js';
import { PACKET_KINDS } from '../topology/kinds.js';
import { TopologyScene, webglAvailable } from '../topology/scene.js';

const KIND_TEXT = {
  sent: 'sent by this node (route beyond the first hop is predicted)',
  forwarded: 'forwarded for another node',
  delivered: 'delivered to this node',
  queued: 'parked in the transit queue',
  dropped: 'dropped here',
};
const COUNT_WINDOW_MS = 10000;
const TICKER = 8;

/** Turn a packet event into a kind and the route of node ids it concerns. */
function packetRoute(event, selfId) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'packet.sent':
      return { kind: 'sent', route: Array.isArray(d.path) && d.path[0] === selfId && d.path.length > 1 ? d.path : [selfId, d.nextHop].filter(Boolean), dimAfter: 1 };
    case 'packet.forwarded':
      return { kind: 'forwarded', route: [d.from, selfId, d.nextHop].filter(Boolean) };
    case 'packet.delivered':
      return { kind: 'delivered', route: [d.from, selfId].filter(Boolean) };
    case 'packet.queued':
      return { kind: 'queued', route: [d.from && d.from !== selfId ? d.from : null, selfId].filter(Boolean), hold: 1600 };
    case 'packet.dropped':
      return { kind: 'dropped', route: [d.from && d.from !== selfId ? d.from : null, selfId].filter(Boolean), hold: 1400 };
    default:
      return null;
  }
}

export default function Topology({ query, navigate }) {
  const reduced = useReducedMotion();
  const [webgl] = useState(() => webglAvailable());
  const [lost, setLost] = useState(false);
  const mode = query.get('view') === 'list' || !webgl || lost ? 'list' : '3d';
  const selected = query.get('node');
  const topo = useSnapshot('/topology', { events: ['topology.changed', 'routes.changed', 'link.up', 'link.down'], debounceMs: 250 });
  const data = topo.data;
  const selfId = data?.self ?? null;

  const setQuery = (changes) => {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const text = next.toString();
    navigate(`/topology${text ? `?${text}` : ''}`);
  };
  const selectRef = useRef(null);
  selectRef.current = (id) => setQuery({ node: id });

  const hostRef = useRef(null);
  const sceneRef = useRef(null);
  useEffect(() => {
    if (mode !== '3d' || !hostRef.current) return undefined;
    let scene;
    try {
      scene = new TopologyScene({
        container: hostRef.current,
        reducedMotion: reduced,
        onSelect: (id) => selectRef.current(id),
        onHover: () => {},
        onContextLost: () => setLost(true),
      });
    } catch {
      setLost(true);
      return undefined;
    }
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
  }, [mode, reduced]);
  useEffect(() => {
    if (data) sceneRef.current?.setGraph(data);
  }, [data, mode, reduced]);
  useEffect(() => {
    sceneRef.current?.select(selected);
  }, [selected, mode, reduced, data]);

  // Packet events: animate at once, and count them for the legend without re-rendering per event.
  const counts = useRef([]);
  const recent = useRef([]);
  const [, setTick] = useState(0);
  useEvents(['packet.*'], (event) => {
    if (!selfId) return;
    const p = packetRoute(event, selfId);
    if (!p) return;
    sceneRef.current?.pulse(p.kind, p.route, { hold: p.hold, dimAfter: p.dimAfter });
    counts.current.push({ at: Date.now(), kind: p.kind });
    recent.current = [{ key: `${event.seq}`, ts: event.ts, kind: p.kind, route: p.route, reason: event.data?.reason, type: event.data?.type }, ...recent.current].slice(0, TICKER);
  });
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      const cutoff = Date.now() - COUNT_WINDOW_MS;
      counts.current = counts.current.filter((c) => c.at >= cutoff);
      setTick((t) => t + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);
  // Recounted on every render; the half-second tick above is what renders.
  const tally = Object.fromEntries(Object.keys(PACKET_KINDS).map((k) => [k, 0]));
  for (const c of counts.current) tally[c.kind] += 1;

  const nodeCount = data?.nodes.length ?? 0;
  const linkCount = data?.links.length ?? 0;
  return (
    <div className="view view-topology">
      <header className="view-head row">
        <div>
          <h1>Topology</h1>
          <p className="muted">
            This node&apos;s link-state view{data ? `: ${nodeCount} node${nodeCount === 1 ? '' : 's'}, ${linkCount} link${linkCount === 1 ? '' : 's'}, revision ${data.rev}` : ''}.
            Rings are hops from here; edges show advertised cost.
          </p>
        </div>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Display">
            <button type="button" aria-pressed={mode === '3d'} disabled={!webgl || lost} onClick={() => setQuery({ view: null })}>3D map</button>
            <button type="button" aria-pressed={mode === 'list'} onClick={() => setQuery({ view: 'list' })}>List</button>
          </div>
          {mode === '3d' && <button type="button" className="btn btn-ghost" onClick={() => sceneRef.current?.resetView()}>Reset view</button>}
        </div>
      </header>
      {(!webgl || lost) && (
        <div className="banner banner-warn" role="status">
          {lost ? 'The browser took the 3D context away (GPU reset or memory pressure). ' : 'This browser cannot draw WebGL. '}
          Showing the same view as a list. {lost && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setLost(false)}>Try 3D again</button>}
        </div>
      )}
      <ErrorNote error={topo.error} onRetry={topo.refetch} />
      <div className="topo-layout">
        <div className="topo-main">
          {mode === '3d' ? (
            <div className="topo-host" ref={hostRef}>
              {!data && <div className="topo-wait"><Loading label="Loading the topology" /></div>}
            </div>
          ) : (
            data ? <TopologyList data={data} selected={selected} onSelect={(id) => setQuery({ node: id })} /> : <Loading label="Loading the topology" />
          )}
        </div>
        <aside className="topo-side" aria-label="Map details">
          <section className="side-block" aria-labelledby="legend-h">
            <h2 id="legend-h">Packets at this node, last 10 s</h2>
            <ul className="legend-list">
              {Object.entries(PACKET_KINDS).map(([kind, color]) => (
                <li key={kind} title={KIND_TEXT[kind]}>
                  <i className="swatch" style={{ background: color }} />
                  <span>{kind}</span>
                  <span className="num">{fmtInt(tally[kind])}</span>
                </li>
              ))}
            </ul>
            <p className="hint">Only what this node itself sent, forwarded, received or dropped. File chunks count in traffic, not here.</p>
          </section>
          {selected ? (
            <NodeDetail id={selected} selfId={selfId} navigate={navigate} onClose={() => setQuery({ node: null })} />
          ) : (
            <section className="side-block">
              <h2>Selected node</h2>
              <p className="muted">{mode === '3d' ? 'Click a node, or choose one in the list view.' : 'Choose a node in the list.'}</p>
            </section>
          )}
          <section className="side-block" aria-labelledby="ticker-h">
            <h2 id="ticker-h">Latest packet events</h2>
            {recent.current.length === 0 ? (
              <p className="muted">None yet. Send a message or a ping to see traffic.</p>
            ) : (
              <ol className="ticker">
                {recent.current.map((r) => (
                  <li key={r.key}>
                    <span className="mono muted">{fmtClock(r.ts)}</span>
                    <span className={`kind kind-${r.kind}`}>{r.kind}</span>
                    <span className="mono">{r.route.map(short).join(' > ')}</span>
                    {r.reason && <span className="muted">{r.reason}</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function TopologyList({ data, selected, onSelect }) {
  const neighbours = useMemo(() => {
    const map = new Map();
    for (const link of data.links) {
      for (const [from, to, cost] of [[link.a, link.b, link.costAB], [link.b, link.a, link.costBA]]) {
        if (!map.has(from)) map.set(from, []);
        map.get(from).push({ id: to, cost, state: link.state });
      }
    }
    return map;
  }, [data.links]);
  const rows = [...data.nodes].sort((a, b) => (a.self ? -1 : b.self ? 1 : (a.reachable === b.reachable ? (a.hops ?? 99) - (b.hops ?? 99) || a.id.localeCompare(b.id) : a.reachable ? -1 : 1)));
  if (rows.length <= 1 && data.links.length === 0) {
    return <Empty title="No other node known yet">This node has no links and has received no link-state advertisements.</Empty>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Nodes known to this node, nearest first</caption>
        <thead>
          <tr>
            <th scope="col">Node</th><th scope="col" className="num">Hops</th><th scope="col" className="num">Route cost</th>
            <th scope="col">Next hop</th><th scope="col">Advertised links (cost)</th><th scope="col" className="num">LSA age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id} className={n.id === selected ? 'is-selected' : undefined}>
              <th scope="row">
                <button type="button" className="link-btn" onClick={() => onSelect(n.id)} aria-pressed={n.id === selected}>
                  <NodeId id={n.id} self={n.self} />
                </button>
                {n.linked && <Badge tone="info">linked</Badge>}
                {!n.reachable && !n.self && <Badge tone="warn">no route</Badge>}
              </th>
              <td className="num">{n.hops ?? '-'}</td>
              <td className="num">{n.cost ?? '-'}</td>
              <td>{n.nextHop ? <span className="mono">{short(n.nextHop)}</span> : <span className="muted">-</span>}</td>
              <td className="mono">
                {(neighbours.get(n.id) ?? []).map((l) => `${short(l.id)} (${l.cost ?? '?'}${l.state === 'half' ? ', half' : ''})`).join(', ') || <span className="muted">none</span>}
              </td>
              <td className="num">{typeof n.receivedAgoMs === 'number' ? fmtDuration(n.receivedAgoMs) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NodeDetail({ id, selfId, navigate, onClose }) {
  const detail = useSnapshot(`/topology/nodes/${encodeURIComponent(id)}`, { events: ['topology.changed', 'routes.changed'], debounceMs: 800 });
  const d = detail.data;
  const node = d?.node;
  const isSelf = id === selfId;
  return (
    <section className="side-block" aria-labelledby="detail-h">
      <div className="row">
        <h2 id="detail-h">Selected node</h2>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onClose}>Clear</button>
      </div>
      <p><span className="mono break">{id}</span> <CopyButton text={id} label="Copy node id" /></p>
      {detail.loading && !d && <Loading />}
      <ErrorNote error={detail.error} onRetry={detail.refetch} />
      {d && (
        <>
          <p className="badges">
            {isSelf && <Badge tone="self">this node</Badge>}
            {node?.linked && <Badge tone="info">direct link</Badge>}
            {node && !isSelf && (node.reachable ? <Badge tone="ok">reachable</Badge> : <Badge tone="warn">no route</Badge>)}
            {!node && <Badge tone="neutral">peer record only</Badge>}
          </p>
          <dl className="kv kv-tight">
            {d.route && (
              <>
                <dt>Route</dt><dd>{d.route.hops} hop{d.route.hops === 1 ? '' : 's'}, cost {d.route.cost}</dd>
                <dt>Path</dt><dd className="mono">{d.route.path.map(short).join(' > ')}</dd>
              </>
            )}
            {node?.caps && <><dt>Caps</dt><dd>{Object.entries(node.caps).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none'}</dd></>}
            {d.lsa && (
              <>
                <dt>LSA</dt><dd>seq <span className="mono">{d.lsa.seq}</span>{typeof node?.receivedAgoMs === 'number' ? `, received ${fmtDuration(node.receivedAgoMs)} ago` : ''}</dd>
                <dt>Links</dt>
                <dd className="mono">{(d.lsa.links ?? []).map((l) => `${short(l.peer)} (${l.cost})`).join(', ') || 'none'}</dd>
              </>
            )}
            {node?.addrs?.length > 0 && <><dt>Addresses</dt><dd className="mono">{node.addrs.join(', ')}</dd></>}
          </dl>
          {!isSelf && (
            <div className="actions">
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(`/messages?peer=${id}`)}>Message</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(`/diagnostics?tool=ping&to=${id}`)}>Ping</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(`/diagnostics?tool=trace&to=${id}`)}>Trace</button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => navigate(`/files?to=${id}`)}>Send file</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
