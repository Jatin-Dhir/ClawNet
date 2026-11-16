import { Badge, CopyButton, ErrorNote, Loading, Panel, Sparkline } from '../components.jsx';
import { fmtBytes, fmtInt, fmtNum, fmtRate, fmtWhen } from '../format.js';
import { useNow, useSnapshot, useStatus, useTraffic } from '../store.js';
import { PACKET_KINDS } from '../topology/kinds.js';

const WINDOW_MS = 60000;
const IDLE_MS = 1500;
const FORWARDER = ['originated', 'forwarded', 'delivered', 'queued', 'dropped'];
const FORWARDER_COLOR = { originated: PACKET_KINDS.sent, forwarded: PACKET_KINDS.forwarded, delivered: PACKET_KINDS.delivered, queued: PACKET_KINDS.queued, dropped: PACKET_KINDS.dropped };

export default function Overview() {
  const status = useStatus();
  const identity = useSnapshot('/identity');
  const counters = useSnapshot('/diag/counters', { intervalMs: 2000 });
  const traffic = useTraffic();
  const now = useNow(1000);

  if (!status) return <div className="view"><h1>Overview</h1><Loading label="Asking the node for its status" /></div>;
  const id = identity.data;
  const last = traffic.at(-1);
  const idle = !last || now - last.ts > IDLE_MS;
  const per = (n) => (idle ? 0 : (n / last.intervalMs) * 1000);
  const totals = counters.data?.totals ?? {};
  const points = (field) => traffic.map((s) => ({ t: s.ts, v: (s[field] / s.intervalMs) * 1000 }));
  const suppressed = traffic.filter((s) => now - s.ts < WINDOW_MS).reduce((sum, s) => sum + s.suppressed, 0);

  return (
    <div className="view">
      <header className="view-head">
        <h1>Overview</h1>
      </header>

      <Panel title="Identity" className="identity">
        <dl className="kv kv-wide">
          <dt>Node id</dt>
          <dd><span className="mono break">{status.nodeId}</span> <CopyButton text={status.nodeId} label="Copy node id" /></dd>
          <dt>Network</dt><dd className="mono">{status.networkId}</dd>
          <dt>Agent</dt><dd className="mono">{status.agent}</dd>
          <dt>Started</dt><dd>{fmtWhen(status.startedAt)} <span className="muted">boot <span className="mono">{status.boot}</span></span></dd>
          <dt>Peer listener</dt><dd className="mono">{status.listen ?? 'not listening'}</dd>
          <dt>Announces</dt><dd className="mono">{status.addresses.length ? status.addresses.join(', ') : <span className="muted">no addresses</span>}</dd>
          <dt>Capabilities</dt>
          <dd className="badges">
            {['relay', 'transit', 'mailbox'].map((cap) => <Badge key={cap} tone={status.caps[cap] ? 'ok' : 'neutral'}>{cap} {status.caps[cap] ? 'on' : 'off'}</Badge>)}
          </dd>
          <dt>Keys</dt>
          <dd>
            {id ? (id.keystoreEncrypted ? <Badge tone="ok">encrypted with a passphrase</Badge> : <Badge tone="warn">protected by file permissions only</Badge>) : <span className="muted">-</span>}
          </dd>
          <dt>Services</dt><dd className="mono">{status.services.join(' · ')}</dd>
        </dl>
        <ErrorNote error={identity.error} onRetry={identity.refetch} />
      </Panel>

      <div className="stat-row">
        <Stat label="Links" value={`${status.peers.linked}`} unit={`of ${status.peers.target} wanted`}
          note={`max ${status.peers.max} · ${status.peers.dialing} dialing · ${status.peers.known} address${status.peers.known === 1 ? '' : 'es'} known`}
          tone={status.peers.linked === 0 ? 'bad' : status.peers.linked < status.peers.target ? 'warn' : null} />
        <Stat label="Reachable nodes" value={`${status.routing.reachable}`} unit={`of ${Math.max(0, status.routing.nodes - 1)} known`}
          note={`routing revision ${status.routing.rev}`} tone={status.routing.reachable < status.routing.nodes - 1 ? 'warn' : null} />
        <Stat label="Outbox" value={fmtInt(status.messaging.outbox)} unit="undelivered"
          note={`${fmtBytes(status.messaging.outboxBytes)} · ${status.messaging.waiting} waiting for a route`} tone={status.messaging.waiting > 0 ? 'warn' : null} />
      </div>

      <Panel title="Traffic" actions={<span className="muted">{idle ? 'idle: no traffic sample in the last second' : 'live, from traffic samples'}</span>}>
        <div className="traffic">
          <div>
            <dl className="kv">
              <dt>Bytes in</dt><dd className="num">{fmtRate(per(last?.bytesIn ?? 0))}</dd>
              <dt>Bytes out</dt><dd className="num">{fmtRate(per(last?.bytesOut ?? 0))}</dd>
              <dt>Packets in</dt><dd className="num">{fmtNum(per(last?.packetsIn ?? 0))}/s</dd>
              <dt>Packets out</dt><dd className="num">{fmtNum(per(last?.packetsOut ?? 0))}/s</dd>
            </dl>
            <div className="spark-wrap">
              <Sparkline
                label="Bytes per second in and out over the last minute"
                now={now}
                windowMs={WINDOW_MS}
                series={[
                  { label: 'in', color: 'var(--c-delivered)', points: points('bytesIn') },
                  { label: 'out', color: 'var(--c-sent)', points: points('bytesOut') },
                ]}
              />
              <p className="legend">
                <span><i style={{ background: 'var(--c-delivered)' }} />bytes in</span>
                <span><i style={{ background: 'var(--c-sent)' }} />bytes out</span>
                <span className="muted">last 60 s</span>
              </p>
            </div>
          </div>
          <div>
            <table className="table compact">
              <caption className="sr-only">Packets handled by the forwarder</caption>
              <thead><tr><th scope="col">Forwarder</th><th scope="col" className="num">per second</th><th scope="col" className="num">since start</th></tr></thead>
              <tbody>
                {FORWARDER.map((k) => (
                  <tr key={k}>
                    <th scope="row"><i className="swatch" style={{ background: FORWARDER_COLOR[k] }} />{k}</th>
                    <td className="num">{fmtNum(per(last?.forwarder?.[k] ?? 0))}</td>
                    <td className="num">{fmtInt(totals[`forwarder.${k}`])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="kv kv-tight">
              <dt>Received since start</dt><dd className="num">{fmtBytes(totals['peers.bytesIn'])} in {fmtInt(totals['peers.packetsIn'])} packets</dd>
              <dt>Sent since start</dt><dd className="num">{fmtBytes(totals['peers.bytesOut'])} in {fmtInt(totals['peers.packetsOut'])} packets</dd>
              {suppressed > 0 && (<><dt>Withheld events</dt><dd className="num">{fmtInt(suppressed)} packet events in the last minute (node rate cap)</dd></>)}
            </dl>
            <ErrorNote error={counters.error} onRetry={counters.refetch} />
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Stat({ label, value, unit, note, tone }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value"><span className="num">{value}</span> <span className="stat-unit">{unit}</span></p>
      <p className="stat-note">{note}</p>
    </div>
  );
}
