import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, EventStream, clearToken, createClient, isToken, storeToken, takeToken } from './api.js';
import { RESYNC, NodeContext, StatusContext, createBus, createEventLog, createTrafficHistory, useEvents, useNode, useNow, useSnapshot } from './store.js';
import { fmtClock, fmtDuration } from './format.js';
import { Badge, Loading } from './components.jsx';
import Overview from './views/Overview.jsx';
import Peers from './views/Peers.jsx';
import Messages from './views/Messages.jsx';
import Channels from './views/Channels.jsx';
import Files from './views/Files.jsx';
import Diagnostics from './views/Diagnostics.jsx';
import EventLog from './views/EventLog.jsx';

// The map pulls in three; load it only when the operator opens it.
const Topology = lazy(() => import('./views/Topology.jsx'));

const VIEWS = [
  { path: '/', label: 'Overview', Component: Overview },
  { path: '/topology', label: 'Topology', Component: Topology },
  { path: '/peers', label: 'Peers', Component: Peers },
  { path: '/messages', label: 'Messages', Component: Messages },
  { path: '/channels', label: 'Channels', Component: Channels },
  { path: '/files', label: 'Files', Component: Files },
  { path: '/diagnostics', label: 'Diagnostics', Component: Diagnostics },
  { path: '/events', label: 'Event log', Component: EventLog },
];

export default function App() {
  const [token, setToken] = useState(() => takeToken());
  const [reason, setReason] = useState(null);
  if (token === null) {
    return <SignIn reason={reason} onToken={(value) => { storeToken(value); setReason(null); setToken(value); }} />;
  }
  return (
    <Session
      key={token}
      token={token}
      onSignOut={(why) => {
        clearToken();
        setReason(why);
        setToken(null);
      }}
    />
  );
}

function SignIn({ reason, onToken }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(reason);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const token = value.trim().toLowerCase();
    if (!isToken(token)) {
      setError('A token is 64 characters, 0-9 and a-f.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createClient(token, { onUnauthorized() {} }).get('/status');
      onToken(token);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'The node refused that token.' : err.message);
      setBusy(false);
    }
  };
  return (
    <main className="signin">
      <form className="signin-card" onSubmit={submit} noValidate>
        <p className="brand">ClawView</p>
        <h1>Sign in to this node</h1>
        <p className="muted">
          Open the console address the node printed: it carries the token after the <span className="mono">#</span>. On the node&apos;s machine,
          <span className="mono"> clawnet ui</span> prints it again. Or paste the API token here.
        </p>
        <label htmlFor="token">API token</label>
        <input
          id="token"
          type="password"
          className="mono"
          autoComplete="off"
          spellCheck="false"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'token-error' : undefined}
        />
        {error && <p id="token-error" className="hint hint-bad" role="alert">{error}</p>}
        <p className="hint">The token stays in this tab only and is sent only to this node.</p>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Checking' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function useLocation() {
  const read = () => ({ path: window.location.pathname, search: window.location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const onPop = () => setLoc(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to) => {
    if (to === window.location.pathname + window.location.search) return;
    window.history.pushState(null, '', to);
    setLoc(read());
  }, []);
  return [loc, navigate];
}

function Session({ token, onSignOut }) {
  const signOutRef = useRef(onSignOut);
  signOutRef.current = onSignOut;
  const [loc, navigate] = useLocation();
  const [streamState, setStreamState] = useState('connecting');
  const [boot, setBoot] = useState(null);
  const [lostAt, setLostAt] = useState(null);
  const shared = useMemo(() => ({
    api: createClient(token, { onUnauthorized: () => signOutRef.current('The node no longer accepts this token. It may have been rotated.') }),
    bus: createBus(),
    traffic: createTrafficHistory(),
    log: createEventLog(),
  }), [token]);

  useEffect(() => {
    const { api, bus, traffic, log } = shared;
    let currentBoot = null;
    let hadHello = false;
    const stream = new EventStream(token, {
      onState(state) {
        setStreamState(state);
        if (state === 'live') setLostAt(null);
        else if (state === 'reconnecting') setLostAt((at) => at ?? Date.now());
        else if (state === 'unauthorized') signOutRef.current('The node no longer accepts this token. It may have been rotated.');
      },
      onHello(hello) {
        if (currentBoot !== null && hello.boot !== currentBoot) {
          log.marker('The node restarted. Earlier events belong to its previous run.');
          bus.emit({ type: RESYNC });
        } else if (hadHello && !hello.resumed) {
          bus.emit({ type: RESYNC });
        }
        currentBoot = hello.boot;
        setBoot(hello.boot);
        if (!hadHello) {
          api.get('/diag/events?limit=200').then((res) => log.history(res.boot, res.events), () => {});
        }
        hadHello = true;
      },
      onGap(gap) {
        log.marker(gap.reason === 'overflow'
          ? `Missed events ${gap.from} to ${gap.to}: the node's buffer moved on while this page was away. Views reloaded.`
          : 'The node restarted while this page was away. Views reloaded.');
        bus.emit({ type: RESYNC });
      },
      onEvent(event) {
        log.event(currentBoot, event);
        if (event.type === 'traffic.sample') traffic.push(event);
        bus.emit(event);
      },
    });
    stream.start();
    return () => stream.stop();
  }, [shared, token]);

  const context = useMemo(() => ({ ...shared, navigate, streamState, boot }), [shared, navigate, streamState, boot]);
  return (
    <NodeContext.Provider value={context}>
      <Shell loc={loc} navigate={navigate} lostAt={lostAt} />
    </NodeContext.Provider>
  );
}

function Shell({ loc, navigate, lostAt }) {
  const { streamState } = useNode();
  const status = useSnapshot('/status', {
    events: ['link.up', 'link.down', 'routes.changed', 'message.queued', 'message.acked', 'message.expired', 'peer.dialing', 'peer.dial_failed'],
    debounceMs: 1000,
    intervalMs: 15000,
  });
  const [stopping, setStopping] = useState(null);
  useEvents(['node.stopping'], (event) => setStopping(STOP_REASONS[event.data?.reason] ?? `reason: ${event.data?.reason ?? 'not given'}`));
  // A node that comes back (same address, new boot) clears the notice.
  useEffect(() => {
    if (streamState === 'live') setStopping(null);
  }, [streamState]);
  const view = VIEWS.find((v) => v.path === loc.path) ?? null;
  const mainRef = useRef(null);
  const first = useRef(true);
  useEffect(() => {
    // After navigation, move focus to the new view so keyboard and reader users land on it.
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [loc.path]);
  useEffect(() => {
    document.title = `${view?.label ?? 'Not found'} - ${status.data?.shortId ?? 'node'} - ClawView`;
  }, [view, status.data?.shortId]);

  const s = status.data;
  const unreachable = status.error?.code === 'unreachable';
  const query = new URLSearchParams(loc.search);
  return (
    <StatusContext.Provider value={s}>
      <div className="app">
        <a className="skip" href="#main">Skip to content</a>
        <header className="topbar">
          <span className="brand">ClawView</span>
          <span className="topbar-node">
            {s ? (
              <>
                <span className="mono self-text" title={s.nodeId}>{s.shortId}</span>
                <span className="muted">{s.networkId}</span>
                {s.state !== 'running' && <Badge tone="warn">{s.state}</Badge>}
                <Uptime status={s} />
              </>
            ) : <span className="muted">Connecting to the node</span>}
          </span>
          <StreamPill state={unreachable ? 'unreachable' : streamState} />
        </header>
        <nav className="rail" aria-label="Views">
          <ul>
            {VIEWS.map((v) => (
              <li key={v.path}>
                <a
                  href={v.path}
                  aria-current={v.path === loc.path ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    navigate(v.path);
                  }}
                >
                  {v.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" ref={mainRef} tabIndex={-1} className="main">
          {stopping && <div className="banner banner-bad" role="status">The node is stopping ({stopping}). What you see is its last state; this page reconnects if it comes back.</div>}
          {!stopping && (unreachable || streamState === 'reconnecting') && (
            <div className="banner banner-warn" role="status">
              {unreachable ? 'The node does not answer. ' : 'The live event stream dropped. '}
              {lostAt ? `Since ${fmtClock(lostAt)}, w` : 'W'}hat you see may be out of date. Reconnecting every few seconds.
            </div>
          )}
          {view ? (
            <Suspense fallback={<div className="view"><Loading label="Loading the view" /></div>}>
              <view.Component key={view.path} query={query} navigate={navigate} />
            </Suspense>
          ) : (
            <div className="view">
              <h1>Nothing at {loc.path}</h1>
              <p className="muted">This console has no page there. <a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Go to the overview.</a></p>
            </div>
          )}
        </main>
      </div>
    </StatusContext.Provider>
  );
}

function Uptime({ status }) {
  const now = useNow(1000);
  // Use the node's clock: uptime is now(node) - startedAt, corrected by when we asked.
  const skew = useMemo(() => status.now - Date.now(), [status.now]);
  return <span className="muted" title={`Started ${new Date(status.startedAt).toLocaleString()}`}>up {fmtDuration(now + skew - status.startedAt)}</span>;
}

const STOP_REASONS = {
  api: 'asked to through the control API',
  signal: 'it received a stop signal',
  requested: 'a stop was requested',
};

const STREAM_TEXT = {
  connecting: ['neutral', 'Connecting'],
  live: ['ok', 'Live'],
  reconnecting: ['warn', 'Reconnecting'],
  unauthorized: ['bad', 'Signed out'],
  unreachable: ['bad', 'Node not answering'],
};

function StreamPill({ state }) {
  const [tone, text] = STREAM_TEXT[state] ?? STREAM_TEXT.connecting;
  return (
    <span className={`pill pill-${tone}`} role="status" title="State of the live event stream from the node">
      <span className="pill-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
