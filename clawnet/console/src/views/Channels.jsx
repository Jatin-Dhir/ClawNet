import { useLayoutEffect, useRef, useState } from 'react';
import { Badge, ConfirmButton, CopyButton, Empty, ErrorNote, Loading, NodeId } from '../components.jsx';
import { fmtWhen, utf8Length } from '../format.js';
import { useNode, useSnapshot } from '../store.js';

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEXT = 16384;

function keyBytes(text) {
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return -1;
    return window.atob(text).length;
  } catch {
    return -1;
  }
}

function randomKey() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return window.btoa(String.fromCharCode(...bytes));
}

export default function Channels({ query, navigate }) {
  const { api } = useNode();
  const channels = useSnapshot('/channels', { events: ['cast.joined', 'cast.left', 'cast.message'], debounceMs: 500 });
  const selected = query.get('channel');
  const list = channels.data?.channels ?? [];
  const current = list.find((c) => c.name === selected) ?? null;

  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [generated, setGenerated] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const trimmedKey = key.trim();
  const keyProblem = trimmedKey !== '' && keyBytes(trimmedKey) !== 32 ? 'A key is 32 bytes written in Base64 (44 characters ending in =).' : null;
  const nameProblem = name !== '' && !NAME.test(name) ? 'Lowercase letters, digits, dot, dash and underscore; up to 64; starts with a letter or digit.' : null;

  const join = async (e) => {
    e.preventDefault();
    if (!NAME.test(name) || keyProblem) {
      document.getElementById(keyProblem && NAME.test(name) ? 'ch-key' : 'ch-name')?.focus();
      if (name === '') setJoinError({ code: 'invalid_request', message: 'Enter a channel name.' });
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      const res = await api.post('/channels', trimmedKey ? { name, key: trimmedKey } : { name });
      channels.refetch();
      setName('');
      setKey('');
      setGenerated(false);
      navigate(`/channels?channel=${encodeURIComponent(res.channel.name)}`);
    } catch (error) {
      setJoinError(error);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="view view-split">
      <header className="view-head">
        <h1>Channels</h1>
        <p className="muted">ClawCast: signed messages to everyone who joined the same name and key. Without a key, any node can read a channel.</p>
      </header>
      <div className="split">
        <aside className="split-list" aria-label="Joined channels">
          <form className="join" onSubmit={join} noValidate>
            <p className="form-title">Join a channel</p>
            <label htmlFor="ch-name">Name</label>
            <input id="ch-name" className="mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="ops" autoComplete="off" spellCheck="false" aria-invalid={nameProblem ? 'true' : undefined} />
            {nameProblem && <p className="hint hint-bad">{nameProblem}</p>}
            <label htmlFor="ch-key">Key <span className="muted">(optional)</span></label>
            <div className="input-row">
              <input id="ch-key" type={generated ? 'text' : 'password'} className="mono" value={key} onChange={(e) => { setKey(e.target.value); setGenerated(false); }} placeholder="Base64, 32 bytes" autoComplete="off" spellCheck="false" aria-invalid={keyProblem ? 'true' : undefined} />
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => { setKey(randomKey()); setGenerated(true); }}>New key</button>
            </div>
            {keyProblem && <p className="hint hint-bad">{keyProblem}</p>}
            {generated && (
              <p className="hint">Give this key to the other members another way, then join. The node stores it encrypted and never shows it again. <CopyButton text={key} label="Copy key" /></p>
            )}
            <button type="submit" className="btn btn-primary" disabled={joining}>{joining ? 'Joining' : 'Join'}</button>
            <ErrorNote error={joinError} />
          </form>
          <ErrorNote error={channels.error} onRetry={channels.refetch} />
          {channels.loading && !channels.data ? <Loading /> : list.length === 0 ? <p className="muted pad">Not in any channel.</p> : (
            <ul className="convo-list">
              {list.map((c) => (
                <li key={c.chan}>
                  <button type="button" className="convo" aria-current={c.name === selected ? 'true' : undefined} onClick={() => navigate(`/channels?channel=${encodeURIComponent(c.name)}`)}>
                    <span className="convo-top"><span className="mono">#{c.name}</span>{c.encrypted ? <Badge tone="ok">key</Badge> : <Badge tone="neutral">open</Badge>}</span>
                    <span className="convo-meta muted">{c.messages} message{c.messages === 1 ? '' : 's'}{c.lastMessageAt ? ` · last ${fmtWhen(c.lastMessageAt)}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="split-main" aria-label="Channel">
          {current ? (
            <ChannelHistory key={current.chan} channel={current} onLeft={() => { channels.refetch(); navigate('/channels'); }} />
          ) : selected && channels.data ? (
            <Empty title={`Not joined to #${selected}`}>Join it on the left to read and publish.</Empty>
          ) : (
            <Empty title="No channel open">Join a channel, or choose one you are in.</Empty>
          )}
        </section>
      </div>
    </div>
  );
}

function ChannelHistory({ channel, onLeft }) {
  const { api } = useNode();
  const path = `/channels/${encodeURIComponent(channel.name)}/messages`;
  const history = useSnapshot(`${path}?limit=50`, {
    events: ['cast.message'],
    apply: (data, event) => {
      const m = event.data?.message;
      if (!m || m.chan !== channel.chan || data.items.some((x) => x.seq === m.seq)) return data;
      return { ...data, items: [m, ...data.items] };
    },
  });
  const [older, setOlder] = useState({ items: [], next: undefined, loading: false, error: null });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scroller = useRef(null);
  const stick = useRef(true);
  const items = [...(history.data?.items ?? []), ...older.items].reverse();
  const nextBefore = older.next === undefined ? history.data?.nextBefore : older.next;
  const bytes = utf8Length(text);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const loadOlder = async () => {
    setOlder((o) => ({ ...o, loading: true, error: null }));
    try {
      const res = await api.get(`${path}?limit=50&before=${nextBefore}`);
      stick.current = false;
      setOlder((o) => ({ items: [...o.items, ...res.items], next: res.nextBefore, loading: false, error: null }));
    } catch (err) {
      setOlder((o) => ({ ...o, loading: false, error: err }));
    }
  };
  const publish = async (e) => {
    e.preventDefault();
    if (text.trim() === '' || bytes > MAX_TEXT || busy) {
      document.getElementById('cast-text')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(path, { text });
      setText('');
      stick.current = true;
      history.setData((data) => (data.items.some((x) => x.seq === res.message.seq) ? data : { ...data, items: [res.message, ...data.items] }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    setError(null);
    try {
      await api.del(`/channels/${encodeURIComponent(channel.name)}`);
      onLeft();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="thread">
      <header className="thread-head row">
        <span><span className="mono">#{channel.name}</span> <span className="muted mono">{channel.chan}</span></span>
        <ConfirmButton label="Leave" confirmLabel="Leave and delete local history" onConfirm={leave} />
      </header>
      <div className="thread-body" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {nextBefore !== null && nextBefore !== undefined && (
          <div className="center"><button type="button" className="btn btn-ghost btn-xs" onClick={loadOlder} disabled={older.loading}>{older.loading ? 'Loading' : 'Load older messages'}</button></div>
        )}
        <ErrorNote error={older.error} />
        <ErrorNote error={history.error} onRetry={history.refetch} />
        {history.loading && !history.data && <Loading />}
        {history.data && items.length === 0 && <p className="muted center">Nothing published here yet.</p>}
        <ol className="casts" aria-live="polite" aria-relevant="additions">
          {items.map((m) => (
            <li key={m.seq} className={m.mine ? 'cast mine' : 'cast'}>
              <p className="cast-meta"><NodeId id={m.origin} self={m.mine} /> <span className="muted">#{m.n} · {fmtWhen(m.ts)}</span></p>
              <p className="msg-text">{m.text}</p>
            </li>
          ))}
        </ol>
      </div>
      <form className="composer" onSubmit={publish}>
        <label htmlFor="cast-text" className="sr-only">Publish to #{channel.name}</label>
        <textarea id="cast-text" rows={2} value={text} placeholder={`Publish to #${channel.name}`} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) publish(e); }} />
        <div className="composer-side">
          <span className={`muted num${bytes > MAX_TEXT ? ' over' : ''}`}>{bytes > MAX_TEXT * 0.8 ? `${bytes} / ${MAX_TEXT} bytes` : 'Enter publishes'}</span>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Publishing' : 'Publish'}</button>
        </div>
      </form>
      <ErrorNote error={error} />
    </div>
  );
}
