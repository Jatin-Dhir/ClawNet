import { useState } from 'react';
import { Badge, ConfirmButton, Empty, ErrorNote, Field, Loading, NodeId, NodePicker, Panel, Progress } from '../components.jsx';
import { NODE_ID, fmtBytes, fmtRate, fmtWhen, utf8Length } from '../format.js';
import { useDirectory, useNode, useSnapshot } from '../store.js';

const FINISHED = new Set(['completed', 'rejected', 'cancelled', 'failed']);
const STATE_TONE = { completed: 'ok', failed: 'bad', rejected: 'bad', cancelled: 'neutral', offered: 'warn', paused: 'warn', preparing: 'neutral', sending: 'info', receiving: 'info', verifying: 'info' };

function upsert(list, transfer) {
  const at = list.findIndex((t) => t.id === transfer.id && t.direction === transfer.direction);
  if (at === -1) return [transfer, ...list];
  const next = list.slice();
  next[at] = transfer;
  return next;
}

function applyFileEvent(data, event) {
  const d = event.data ?? {};
  if (d.transfer) return { ...data, transfers: upsert(data.transfers, d.transfer) };
  if (event.type === 'file.progress') {
    if (!data.transfers.some((t) => t.id === d.id && t.direction === d.direction)) return undefined;
    return { ...data, transfers: data.transfers.map((t) => (t.id === d.id && t.direction === d.direction ? { ...t, bytesDone: d.bytesDone, chunksDone: d.chunksDone, rateBps: d.rateBps, updatedAt: event.ts } : t)) };
  }
  // paused / resumed carry only an id; the transfer's full state comes from a refetch.
  return undefined;
}

export default function Files({ query }) {
  const { api } = useNode();
  const directory = useDirectory();
  const files = useSnapshot('/files', { events: ['file.*'], apply: applyFileEvent });
  const [to, setTo] = useState(() => {
    const q = query.get('to');
    return q && NODE_ID.test(q) ? q : '';
  });
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const transfers = files.data?.transfers ?? [];
  const incoming = transfers.filter((t) => t.direction === 'receive' && t.state === 'offered');
  const others = transfers.filter((t) => !(t.direction === 'receive' && t.state === 'offered'));
  const nameBytes = utf8Length(name.trim());

  const send = async (e) => {
    e.preventDefault();
    if (!to || path.trim() === '' || nameBytes > 255) {
      setSendError({ code: 'invalid_request', message: !to ? 'Choose the node to send to.' : path.trim() === '' ? 'Enter the path of a file on the node\'s machine.' : 'Shorten the name to 255 bytes.' });
      return;
    }
    setBusy(true);
    setSendError(null);
    try {
      const body = { to, path: path.trim() };
      if (name.trim() !== '') body.name = name.trim();
      const res = await api.post('/files', body);
      files.setData((data) => ({ ...data, transfers: upsert(data.transfers, res.transfer) }));
      setPath('');
      setName('');
    } catch (error) {
      setSendError(error.code === 'invalid_file' && error.details?.reason ? { ...error, message: `${error.message} (${error.details.reason})` } : error);
    } finally {
      setBusy(false);
    }
  };
  const act = async (t, action) => {
    setActionError(null);
    try {
      const res = await api.post(`/files/${t.id}/${action}`);
      files.setData((data) => ({ ...data, transfers: upsert(data.transfers, res.transfer) }));
    } catch (error) {
      setActionError(error);
    }
  };

  return (
    <div className="view">
      <header className="view-head">
        <h1>Files</h1>
        <p className="muted">Encrypted, resumable transfers between nodes. Each node reads and writes files on its own machine.</p>
      </header>

      <div className="two-col">
        <Panel title="Send a file">
          <form className="form-grid" onSubmit={send}>
            <Field label="To" htmlFor="file-to">
              <NodePicker id="file-to" nodes={directory.nodes} selfId={directory.self} value={to} onChange={setTo} />
            </Field>
            <Field label="Path on the node's machine" htmlFor="file-path" hint="The node process opens this path itself. It is not uploaded from this browser.">
              <input id="file-path" className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:/Users/me/Documents/map.pdf" autoComplete="off" spellCheck="false" />
            </Field>
            <Field label="Name shown to the receiver (optional)" htmlFor="file-name">
              <input id="file-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-invalid={nameBytes > 255 ? 'true' : undefined} />
            </Field>
            {nameBytes > 255 && <p className="hint hint-bad">At most 255 bytes.</p>}
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Offering' : 'Offer file'}</button>
            </div>
            <ErrorNote error={sendError} />
          </form>
        </Panel>
        <Panel title={`Incoming offers (${incoming.length})`}>
          {incoming.length === 0 ? <p className="muted">No offer is waiting. With files.accept set to ask, offers wait here for a decision.</p> : (
            <ul className="offers">
              {incoming.map((t) => (
                <li key={t.id} className="offer">
                  <p><strong className="break">{t.name}</strong> <span className="muted">{fmtBytes(t.size)}</span></p>
                  <p className="muted">from <NodeId id={t.peer} /> · {fmtWhen(t.createdAt)}</p>
                  <div className="actions">
                    <button type="button" className="btn btn-primary btn-xs" onClick={() => act(t, 'accept')}>Accept</button>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => act(t, 'reject')}>Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Transfers">
        <ErrorNote error={files.error} onRetry={files.refetch} />
        <ErrorNote error={actionError} />
        {files.loading && !files.data ? <Loading /> : others.length === 0 ? (
          <Empty title="No transfers">Offers you send and files you accept appear here with their progress.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Transfers, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">File</th><th scope="col">Direction</th><th scope="col">Peer</th><th scope="col">State</th>
                  <th scope="col" className="col-progress">Progress</th><th scope="col" className="num">Rate</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {others.map((t) => (
                  <tr key={`${t.direction}-${t.id}`}>
                    <th scope="row">
                      <span className="break">{t.name}</span>
                      {t.path && <span className="sub mono break" title={t.path}>{t.path}</span>}
                    </th>
                    <td>{t.direction === 'send' ? 'sending' : 'receiving'}</td>
                    <td><NodeId id={t.peer} /></td>
                    <td>
                      <Badge tone={STATE_TONE[t.state] ?? 'neutral'}>{t.state}</Badge>
                      {t.error && <span className="sub">{t.error}</span>}
                    </td>
                    <td className="col-progress">
                      <Progress value={t.bytesDone} max={t.size} tone={t.state === 'completed' ? 'ok' : t.state === 'failed' ? 'bad' : 'info'} label={`${t.name} progress`} />
                      <span className="sub num">{fmtBytes(t.bytesDone)} of {fmtBytes(t.size)} · {t.chunksDone}/{t.chunks} chunks</span>
                    </td>
                    <td className="num">{FINISHED.has(t.state) ? '-' : fmtRate(t.rateBps)}</td>
                    <td>{fmtWhen(t.updatedAt)}</td>
                    <td>{!FINISHED.has(t.state) && <ConfirmButton label="Cancel" confirmLabel="Cancel transfer" onConfirm={() => act(t, 'cancel')} />}</td>
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
