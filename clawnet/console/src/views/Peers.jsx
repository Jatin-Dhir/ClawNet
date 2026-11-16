import { useState } from 'react';
import { Badge, ConfirmButton, Empty, ErrorNote, Loading, NodeId, Panel } from '../components.jsx';
import { fmtAgo, fmtBytes, fmtDuration, fmtInt, fmtMs, fmtWhen } from '../format.js';
import { useNode, useNow, useSnapshot } from '../store.js';

const ADDRESS = /^tcp:\/\/[^\s/]+:\d{1,5}$/;

/** Keep the snapshot current: metrics and per-link traffic in place, link changes refetch. */
function applyPeerEvent(data, event) {
  const d = event.data ?? {};
  if (event.type === 'link.metric') {
    if (!data.peers.some((p) => p.id === d.peer)) return undefined;
    return { ...data, peers: data.peers.map((p) => (p.id === d.peer ? { ...p, rttMs: d.rttMs, srttMs: d.srttMs, cost: d.cost, misses: d.misses } : p)) };
  }
  if (event.type === 'traffic.sample') {
    const byPeer = new Map((d.links ?? []).map((l) => [l.peer, l]));
    if (byPeer.size === 0) return data;
    return {
      ...data,
      peers: data.peers.map((p) => {
        const l = byPeer.get(p.id);
        if (!l) return p;
        return { ...p, packetsIn: p.packetsIn + l.packetsIn, packetsOut: p.packetsOut + l.packetsOut, bytesIn: p.bytesIn + l.bytesIn, bytesOut: p.bytesOut + l.bytesOut, lastRxAt: l.packetsIn > 0 ? event.ts : p.lastRxAt };
      }),
    };
  }
  return undefined;
}

export default function Peers() {
  const { api } = useNode();
  const now = useNow(1000);
  const peers = useSnapshot('/peers', {
    events: ['link.up', 'link.down', 'link.metric', 'link.throttled', 'peer.dialing', 'peer.dial_failed', 'traffic.sample'],
    apply: applyPeerEvent,
  });
  const known = useSnapshot('/peers/known', { events: ['link.up', 'link.down', 'peer.dial_failed', 'discovery.candidate', 'peer.record'], debounceMs: 2000 });
  const [address, setAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  const connect = async (e) => {
    e.preventDefault();
    const addr = address.trim();
    if (!ADDRESS.test(addr)) {
      setActionError({ code: 'invalid_request', message: 'Use the form tcp://host:port.' });
      return;
    }
    setConnecting(true);
    setActionError(null);
    setResult(null);
    try {
      const res = await api.post('/peers/connect', { address: addr });
      setResult(`Linked to ${res.peer.id.slice(0, 8)} over ${res.peer.addr}. The address is now sticky: the node redials it until you disconnect.`);
      setAddress('');
    } catch (err) {
      setActionError(err.code === 'connect_failed' && err.details?.reason ? { ...err, message: `${err.message} (${err.details.reason})` } : err);
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async (id) => {
    setActionError(null);
    try {
      await api.post(`/peers/${id}/disconnect`);
    } catch (err) {
      setActionError(err);
    }
  };

  const list = peers.data?.peers ?? [];
  const dialing = peers.data?.dialing ?? [];
  return (
    <div className="view">
      <header className="view-head">
        <h1>Peers</h1>
        <p className="muted">Direct links of this node. Traffic counts since each link came up, updated from traffic samples.</p>
      </header>

      <Panel title={`Links${peers.data ? ` (${list.length})` : ''}`}>
        <ErrorNote error={peers.error} onRetry={peers.refetch} />
        <ErrorNote error={actionError} />
        {peers.loading && !peers.data ? <Loading /> : list.length === 0 ? (
          <Empty title="No links">This node is not linked to any peer. Connect to an address below, or wait for discovery.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Links</caption>
              <thead>
                <tr>
                  <th scope="col">Peer</th><th scope="col">Direction</th><th scope="col">Address</th><th scope="col">State</th>
                  <th scope="col" className="num">RTT</th><th scope="col" className="num">Smoothed</th><th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">In</th><th scope="col" className="num">Out</th><th scope="col" className="num">Up for</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <th scope="row"><NodeId id={p.id} /> {p.sticky && <Badge tone="info" title="Added by hand; redialed until disconnected">sticky</Badge>}</th>
                    <td>{p.direction === 'out' ? 'outbound' : 'inbound'}</td>
                    <td className="mono">{p.addr}</td>
                    <td>
                      {p.throttled ? <Badge tone="warn">throttled</Badge> : p.misses > 0 ? <Badge tone="warn">{p.misses} missed</Badge> : <Badge tone="ok">up</Badge>}
                      {p.queuedBytes > 0 && <span className="muted"> {fmtBytes(p.queuedBytes)} queued</span>}
                    </td>
                    <td className="num">{fmtMs(p.rttMs)}</td>
                    <td className="num">{fmtMs(p.srttMs)}</td>
                    <td className="num">{p.cost}</td>
                    <td className="num" title={`${fmtInt(p.packetsIn)} packets, last received ${fmtAgo(p.lastRxAt, now)}`}>{fmtBytes(p.bytesIn)}<span className="sub">{fmtInt(p.packetsIn)} pkt</span></td>
                    <td className="num" title={`${fmtInt(p.packetsOut)} packets`}>{fmtBytes(p.bytesOut)}<span className="sub">{fmtInt(p.packetsOut)} pkt</span></td>
                    <td className="num" title={`since ${fmtWhen(p.since)}`}>{fmtDuration(now - p.since)}</td>
                    <td><ConfirmButton label="Disconnect" confirmLabel="Disconnect now" onConfirm={() => disconnect(p.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="two-col">
        <Panel title="Connect">
          <form className="form-row" onSubmit={connect}>
            <label htmlFor="peer-addr" className="sr-only">Peer address</label>
            <input id="peer-addr" className="mono" placeholder="tcp://127.0.0.1:47470" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck="false" autoComplete="off" />
            <button type="submit" className="btn btn-primary" disabled={connecting}>{connecting ? 'Dialing' : 'Connect'}</button>
          </form>
          <p className="hint">The node dials and waits for the handshake. A manual address stays sticky until you disconnect that peer.</p>
          {result && <p className="ok-note" role="status">{result}</p>}
        </Panel>
        <Panel title={`Dials in progress (${dialing.length})`}>
          {dialing.length === 0 ? <p className="muted">None.</p> : (
            <ul className="plain-list">
              {dialing.map((d) => (
                <li key={`${d.addr}-${d.since}`}>
                  <span className="mono">{d.addr}</span> {d.id && <NodeId id={d.id} />} <span className="muted">{d.source}, attempt {d.attempt}, since {fmtAgo(d.since, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={`Address book${known.data ? ` (${known.data.addresses.length})` : ''}`}>
        <ErrorNote error={known.error} onRetry={known.refetch} />
        {known.loading && !known.data ? <Loading /> : known.data?.addresses.length === 0 ? <p className="muted">No addresses known.</p> : known.data && (
          <div className="table-wrap">
            <table className="table compact">
              <caption className="sr-only">Known addresses</caption>
              <thead><tr><th scope="col">Address</th><th scope="col">Node</th><th scope="col">Learned from</th><th scope="col">Last success</th><th scope="col">Failures</th><th scope="col">Next attempt</th></tr></thead>
              <tbody>
                {known.data.addresses.map((a) => (
                  <tr key={a.addr}>
                    <td className="mono">{a.addr}</td>
                    <td>{a.id ? <NodeId id={a.id} /> : <span className="muted">unknown</span>}</td>
                    <td>{a.sources.join(', ')}</td>
                    <td>{a.lastOkAt ? fmtAgo(a.lastOkAt, now) : <span className="muted">never</span>}</td>
                    <td>{a.fails > 0 ? <span title={a.lastError ?? ''}>{a.fails}{a.lastError ? `, ${a.lastError}` : ''}</span> : <span className="muted">0</span>}</td>
                    <td>{a.nextAttemptAt > now ? `in ${fmtDuration(a.nextAttemptAt - now)}` : <span className="muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
