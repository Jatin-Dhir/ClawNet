import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge, Empty, ErrorNote, Loading, NodeId, NodePicker } from '../components.jsx';
import { NODE_ID, fmtWhen, short, utf8Length } from '../format.js';
import { useDirectory, useNode, useSnapshot } from '../store.js';

const MAX_TEXT = 16384;
const STEPS = ['queued', 'sent', 'delivered'];

export default function Messages({ query, navigate }) {
  const directory = useDirectory();
  const peerParam = query.get('peer');
  const peer = peerParam && NODE_ID.test(peerParam) ? peerParam : null;
  const conversations = useSnapshot('/conversations', { events: ['chat.message', 'chat.state'], debounceMs: 400 });
  const [draftPeer, setDraftPeer] = useState('');
  const list = conversations.data?.conversations ?? [];
  const open = (id) => navigate(`/messages?peer=${id}`);

  return (
    <div className="view view-split">
      <header className="view-head">
        <h1>Messages</h1>
        <p className="muted">End-to-end encrypted chat with other nodes. Delivered means the recipient acknowledged it.</p>
      </header>
      <div className="split">
        <aside className="split-list" aria-label="Conversations">
          <form className="new-convo" onSubmit={(e) => { e.preventDefault(); if (draftPeer) open(draftPeer); else document.getElementById('new-peer')?.focus(); }}>
            <label htmlFor="new-peer">New conversation</label>
            <NodePicker id="new-peer" nodes={directory.nodes} selfId={directory.self} value={draftPeer} onChange={setDraftPeer} />
            <button type="submit" className="btn btn-ghost btn-xs">Open</button>
          </form>
          <ErrorNote error={conversations.error} onRetry={conversations.refetch} />
          {conversations.loading && !conversations.data ? <Loading /> : list.length === 0 ? (
            <p className="muted pad">No conversations yet.</p>
          ) : (
            <ul className="convo-list">
              {list.map((c) => (
                <li key={c.peer}>
                  <button type="button" className="convo" aria-current={c.peer === peer ? 'true' : undefined} onClick={() => open(c.peer)}>
                    <span className="convo-top"><NodeId id={c.peer} /><span className="muted">{fmtWhen(c.lastAt)}</span></span>
                    <span className="convo-last">{c.last.direction === 'out' ? 'You: ' : ''}{c.last.text}</span>
                    <span className="convo-meta muted">{c.count} message{c.count === 1 ? '' : 's'} · last {c.last.state}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="split-main" aria-label="Conversation">
          {peer ? <Thread key={peer} peer={peer} /> : (
            <Empty title="No conversation open">Choose one on the left, or start a new one with any node this node knows.</Empty>
          )}
        </section>
      </div>
    </div>
  );
}

function upsert(items, message) {
  const at = items.findIndex((m) => m.id === message.id && m.direction === message.direction);
  if (at === -1) return [message, ...items];
  const next = items.slice();
  next[at] = { ...items[at], ...message };
  return next;
}

function Thread({ peer }) {
  const { api } = useNode();
  const thread = useSnapshot(`/conversations/${peer}?limit=50`, {
    events: ['chat.message', 'chat.state'],
    apply: (data, event) => {
      const d = event.data ?? {};
      if (event.type === 'chat.message') {
        if (d.message?.peer !== peer) return data;
        return { ...data, items: upsert(data.items, d.message) };
      }
      if (d.peer !== peer) return data;
      if (!data.items.some((m) => m.id === d.id)) return undefined;
      return { ...data, items: data.items.map((m) => (m.id === d.id && m.direction === 'out' ? { ...m, state: d.state } : m)) };
    },
  });
  const [older, setOlder] = useState({ items: [], next: undefined, loading: false, error: null });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const scroller = useRef(null);
  const stick = useRef(true);

  const items = [...(thread.data?.items ?? []), ...older.items].reverse();
  const nextBefore = older.next === undefined ? thread.data?.nextBefore : older.next;
  const bytes = utf8Length(text);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  useEffect(() => setSendError(null), [text]);

  const loadOlder = async () => {
    setOlder((o) => ({ ...o, loading: true, error: null }));
    try {
      const res = await api.get(`/conversations/${peer}?limit=50&before=${nextBefore}`);
      stick.current = false;
      setOlder((o) => ({ items: [...o.items, ...res.items], next: res.nextBefore, loading: false, error: null }));
    } catch (error) {
      setOlder((o) => ({ ...o, loading: false, error }));
    }
  };
  const send = async () => {
    const body = text;
    if (body.trim() === '' || bytes > MAX_TEXT || sending) {
      document.getElementById('compose')?.focus();
      return;
    }
    setSending(true);
    try {
      const res = await api.post('/messages', { to: peer, text: body });
      setText('');
      stick.current = true;
      thread.setData((data) => ({ ...data, items: upsert(data.items, res.message) }));
    } catch (error) {
      setSendError(error);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="thread">
      <header className="thread-head">
        <NodeId id={peer} copy />
      </header>
      <div
        className="thread-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {nextBefore !== null && nextBefore !== undefined && (
          <div className="center">
            <button type="button" className="btn btn-ghost btn-xs" onClick={loadOlder} disabled={older.loading}>{older.loading ? 'Loading' : 'Load older messages'}</button>
          </div>
        )}
        <ErrorNote error={older.error} />
        <ErrorNote error={thread.error} onRetry={thread.refetch} />
        {thread.loading && !thread.data && <Loading />}
        {thread.data && items.length === 0 && <p className="muted center">No messages with {short(peer)} yet. The first one you send starts the conversation.</p>}
        <ol className="messages" aria-live="polite" aria-relevant="additions">
          {items.map((m) => (
            <li key={`${m.direction}-${m.id}`} className={`msg msg-${m.direction}`}>
              <p className="msg-text">{m.text}</p>
              <p className="msg-meta">
                <span title={`sender clock ${new Date(m.ts).toLocaleString()}`}>{fmtWhen(m.at)}</span>
                {m.direction === 'out' ? <Delivery state={m.state} /> : <span className="muted">received</span>}
              </p>
            </li>
          ))}
        </ol>
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label htmlFor="compose" className="sr-only">Message to {short(peer)}</label>
        <textarea
          id="compose"
          rows={2}
          value={text}
          placeholder={`Message ${short(peer)}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-side">
          <span className={`muted num${bytes > MAX_TEXT ? ' over' : ''}`}>{bytes > MAX_TEXT * 0.8 ? `${bytes} / ${MAX_TEXT} bytes` : 'Enter sends, Shift+Enter new line'}</span>
          <button type="submit" className="btn btn-primary" disabled={sending}>{sending ? 'Sending' : 'Send'}</button>
        </div>
      </form>
      <ErrorNote error={sendError} />
    </div>
  );
}

/** queued > sent > delivered, with custody and expired as the other outcomes. */
function Delivery({ state }) {
  if (state === 'expired') return <Badge tone="bad">expired, never delivered</Badge>;
  if (state === 'custody') return <Badge tone="info" title="A mailbox node holds a copy until the recipient is reachable">held in custody</Badge>;
  const reached = STEPS.indexOf(state);
  return (
    <span className="steps" aria-label={`delivery: ${state}`}>
      {STEPS.map((step, i) => (
        <span key={step} className={i <= reached ? (state === 'delivered' ? 'step done ok' : 'step done') : 'step'}>{step}</span>
      ))}
    </span>
  );
}
