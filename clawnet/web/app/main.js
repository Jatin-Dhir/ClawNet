/**
 * The phone app: four views over one PhoneNode (web/core/node.js).
 *
 *   #/           home: the link to the computer, and the nodes this phone can reach
 *   #/chat/<id>  a conversation with one node
 *   #/phone      this phone: its id, its network, starting over
 *   (setup)      shown instead of all three until the phone has an identity
 *
 * Everything dynamic is set with textContent or attributes, never innerHTML: messages
 * and node names come from other people.
 */

/* global Intl -- a browser built-in that the repository's lint globals leave out */

import { PhoneNode } from '../core/node.js';
import { createStorage } from '../core/storage.js';
import { icon } from './icons.js';

const MAX_TEXT_BYTES = 16384;
const BAD_KEY = 'That is not a network key. A key is 44 letters, digits, + and /, ending in =.';

const bar = document.getElementById('bar');
const page = document.getElementById('page');
const announcer = document.getElementById('announcer');
const encoder = new TextEncoder();
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const storage = createStorage();
const app = {
  config: null,
  node: null,
  view: null,
  chat: null,
  read: storage.get('read') ?? {},
  installHintDismissed: storage.get('install-hint') === 'dismissed',
  renderQueued: false,
};

// ------------------------------------------------------------------ boot

boot();

async function boot() {
  try {
    app.config = await loadConfig();
    storage.set('config', app.config);
  } catch {
    // Offline: the identity and the messages are on this phone, so open with the last
    // settings the computer gave and let the node keep trying to link.
    const cached = storage.get('config');
    if (cached === null || typeof cached.networkId !== 'string' || !Number.isInteger(cached?.websocket?.port)) {
      showUnreachable();
      window.addEventListener('online', () => location.reload(), { once: true });
      return;
    }
    app.config = cached;
  }
  app.node = new PhoneNode({ storage });
  app.node.subscribe(onNodeEvent);
  window.addEventListener('hashchange', () => render({ navigation: true }));
  const wake = () => {
    if (document.visibilityState === 'visible') app.node?.reconnectNow();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  if (app.node.identity !== null && app.node.identity.networkId === app.config.networkId) startNode();
  render({ navigation: true });
}

async function loadConfig() {
  const response = await fetch('/config.json', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`config ${response.status}`);
  const config = await response.json();
  if (typeof config?.networkId !== 'string' || !Number.isInteger(config?.websocket?.port)) throw new Error('config');
  return config;
}

function socketUrl() {
  // location.hostname keeps the brackets of an IPv6 address.
  return `ws://${location.hostname}:${app.config.websocket.port}${app.config.websocket.path ?? '/'}`;
}

function startNode() {
  try {
    app.node.start(socketUrl());
  } catch {
    // No identity yet: the setup view handles it.
  }
}

function showUnreachable() {
  setBar([wordmark()]);
  setPage(
    h('section', { class: 'setup-head' },
      h('h1', {}, 'Can’t reach the computer'),
      h('p', { class: 'lede' }, 'This page comes from a computer running ClawNet, and it is not answering. Check that ClawNet is still running there and that this phone is on the same Wi-Fi, then try again.'),
    ),
    h('button', { class: 'btn btn-primary btn-wide', type: 'button', onclick: () => location.reload() }, icon('refresh-cw'), 'Try again'),
  );
}

// ------------------------------------------------------------------ events and routing

function onNodeEvent(event) {
  if (event.type === 'message') {
    const viewing = app.view === 'chat' && app.chat === event.peer && document.visibilityState === 'visible';
    if (viewing) markRead(event.peer);
    else announce(`New message from ${displayName(event.peer)}`);
  }
  if (event.type === 'delivered') announce('Message delivered');
  if (event.type === 'storage-failed' && !app.storageWarned) {
    // Once per visit: the browser's storage for this page is full or switched off.
    app.storageWarned = true;
    toast('This browser would not save the latest changes. They stay while the app is open and are lost when it closes.', { long: true });
  }
  scheduleRender();
}

function scheduleRender() {
  if (app.renderQueued) return;
  app.renderQueued = true;
  requestAnimationFrame(() => {
    app.renderQueued = false;
    render({ navigation: false });
  });
}

function currentRoute() {
  const hash = location.hash.replace(/^#/, '');
  const chat = /^\/chat\/([a-z2-7]{51}[aq])$/.exec(hash);
  if (chat !== null) return { name: 'chat', peer: chat[1] };
  if (hash === '/phone') return { name: 'phone' };
  return { name: 'home' };
}

function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else render({ navigation: true });
}

function render({ navigation }) {
  const node = app.node;
  if (node === null) return;
  const identity = node.identity;
  if (identity === null) {
    if (app.view !== 'setup') renderSetup();
    return;
  }
  if (identity.networkId !== app.config.networkId) {
    if (app.view !== 'mismatch') renderMismatch();
    return;
  }
  const route = currentRoute();
  const changed = navigation || app.view !== route.name || (route.name === 'chat' && app.chat !== route.peer);
  const back = changed && app.view !== null && rank(route.name) < rank(app.view);
  if (route.name === 'chat') renderChat(route.peer, changed);
  else if (route.name === 'phone') renderPhone(changed);
  else renderHome(changed);
  if (changed) {
    page.classList.remove('view-enter', 'view-enter-back');
    void page.offsetWidth;
    page.classList.add(back ? 'view-enter-back' : 'view-enter');
  }
}

function rank(name) {
  return { home: 0, phone: 1, chat: 1 }[name] ?? 0;
}

// ------------------------------------------------------------------ setup

function renderSetup() {
  app.view = 'setup';
  app.chat = null;
  page.className = 'page';
  setBar([wordmark()]);
  const keyRequired = app.config.keyRequired === true;
  const error = h('p', { class: 'error-text', id: 'setup-error', role: 'alert', hidden: true });
  const keyInput = keyRequired
    ? h('input', {
        class: 'input mono',
        id: 'network-key',
        name: 'network-key',
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        inputmode: 'text',
        placeholder: '44 characters, ending in =',
        'aria-describedby': 'network-key-hint',
      })
    : null;
  const submit = h('button', { class: 'btn btn-primary btn-wide', type: 'submit' }, 'Create this phone’s identity');
  const form = h('form', { class: 'setup-actions', novalidate: true },
    keyRequired ? h('div', { class: 'field' },
      h('label', { for: 'network-key' }, 'Network key'),
      keyInput,
      h('p', { class: 'hint', id: 'network-key-hint' }, 'This network is private. Ask whoever runs it for its key: 44 letters, digits, + and /, ending in =. It stays on this phone.'),
    ) : null,
    error,
    submit,
    h('p', { class: 'small' }, 'The keys are made on this phone and never leave it.'),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    error.hidden = true;
    keyInput?.setAttribute('aria-invalid', 'false');
    const key = keyInput?.value.trim() ?? null;
    if (keyRequired && (key === null || key === '')) {
      showError(error, 'Enter the network key first.', keyInput);
      return;
    }
    try {
      app.node.createIdentity({ networkId: app.config.networkId, networkKey: key });
    } catch (err) {
      showError(error, err.code === 'bad-key' ? BAD_KEY : 'Could not set up this phone. Its browser refused to store the keys.', keyInput);
      return;
    }
    app.view = null;
    startNode();
    go('#/');
  });

  setPage(
    h('section', { class: 'setup-head' },
      h('span', { class: 'ring ring-self ring-big', 'aria-hidden': 'true' }),
      h('h1', {}, 'Make this phone a ClawNet node'),
      h('p', { class: 'lede' }, 'It gets keys of its own and links to the computer that sent you this page. What you write is encrypted for the node that reads it; the computer passes it on without being able to read it.'),
    ),
    h('div', { class: 'network-name' }, h('span', { class: 'muted' }, 'Network'), h('span', { class: 'num' }, app.config.networkId)),
    installHint(),
    storage.persistent ? null : note('warn', 'circle-alert', h('span', {}, 'This browser is not keeping data for this page, as in private browsing. The keys will be gone when the page closes.')),
    form,
  );
  focusPage();
}

/** iPhone only: the home-screen app has storage of its own, so set up there. */
function installHint() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!ios || standalone || app.installHintDismissed) return null;
  const box = note('info', 'share', h('div', { class: 'note-body' },
    h('strong', {}, 'Install it first'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Tap Share in Safari'),
      h('li', {}, 'Choose Add to Home Screen'),
      h('li', {}, 'Open ClawNet from the home screen'),
    ),
    h('span', {}, 'The home-screen app keeps its own keys, separate from Safari’s, so set this phone up there.'),
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => {
        app.installHintDismissed = true;
        storage.set('install-hint', 'dismissed');
        box.remove();
      },
    }, 'Set up in Safari instead'),
  ));
  return box;
}

function renderMismatch() {
  app.view = 'mismatch';
  page.className = 'page';
  setBar([wordmark()]);
  const identity = app.node.identity;
  setPage(
    h('section', { class: 'setup-head' },
      h('h1', {}, 'This phone belongs to another network'),
      h('p', { class: 'lede' }, `Its identity was made for the network ${identity.networkId}, and this computer runs ${app.config.networkId}. A node belongs to one network.`),
    ),
    note('warn', 'circle-alert', h('span', {}, 'To join this network, delete this phone’s identity and make a new one. Its messages are deleted with it.')),
    h('button', { class: 'btn btn-danger btn-wide', type: 'button', onclick: () => confirmReset() }, 'Delete this phone’s identity'),
  );
}

// ------------------------------------------------------------------ home

function renderHome(changed) {
  const node = app.node;
  if (changed) {
    app.view = 'home';
    app.chat = null;
    page.className = 'page';
    setBar([wordmark(), h('span', { class: 'bar-title' }), selfChip()]);
    setPage(
      h('section', { class: 'link-card', id: 'link-card', 'aria-live': 'polite' }),
      h('section', { class: 'nodes-section' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Nodes'), h('span', { class: 'count', id: 'node-count' })),
        h('div', { id: 'node-area' }),
      ),
    );
    focusPage();
  }
  renderLinkCard(document.getElementById('link-card'));
  const nodes = node.nodes();
  const reachable = nodes.filter((n) => n.reachable).length;
  document.getElementById('node-count').textContent = nodes.length === 0 ? '' : `${reachable} of ${nodes.length} reachable`;
  const area = document.getElementById('node-area');
  if (nodes.length === 0) {
    const linked = node.status().state === 'linked';
    area.replaceChildren(h('div', { class: 'empty' },
      h('strong', {}, linked ? 'Only this phone and its computer so far' : 'No nodes yet'),
      h('span', {}, linked ? 'Other nodes appear here as the computer tells this phone about them, usually within a few seconds.' : 'Nodes appear here once this phone links to the computer.'),
    ));
    return;
  }
  let list = area.querySelector('ul');
  if (list === null) {
    list = h('ul', { class: 'nodes', 'aria-label': 'Nodes' });
    area.replaceChildren(list);
  }
  const conversations = new Map(node.conversations().map((c) => [c.peer, c]));
  syncList(list, nodes, (n) => n.id, createNodeRow, (row, n) => updateNodeRow(row, n, conversations.get(n.id)));
}

function renderLinkCard(card) {
  const node = app.node;
  const status = node.status();
  const peer = status.peer;
  const state = status.state === 'linked' ? 'linked' : status.state === 'connecting' || status.state === 'idle' ? 'connecting' : 'offline';
  const computerName = peer === null ? 'the computer' : displayName(peer.id);
  const label = state === 'linked' && peer?.rttMs != null ? `${peer.rttMs} ms` : state === 'linked' ? 'linked' : state === 'connecting' ? 'linking' : 'no link';
  const route = h('div', { class: 'route', 'data-state': state, role: 'img', 'aria-label': state === 'linked' ? `This phone is linked to ${computerName}, ${label}` : state === 'connecting' ? 'This phone is linking to the computer' : 'This phone has no link' },
    h('span', { class: 'route-node' }, h('span', { class: 'ring ring-self' }), h('span', {}, 'This phone')),
    h('span', { class: 'route-edge' }, h('span', { class: state === 'linked' ? 'num' : '' }, label)),
    h('span', { class: 'route-node' }, h('span', { class: `ring ${state === 'linked' ? 'ring-ok' : 'ring-away'}` }), h('span', { class: peer === null || app.node.nodes().find((n) => n.id === peer.id)?.name ? '' : 'mono' }, peer === null ? 'computer' : computerName)),
  );
  const text = statusText(status);
  const signature = JSON.stringify([state, label, computerName, text, status.pending]);
  if (card.dataset.signature === signature) return;
  card.dataset.signature = signature;
  const children = [route, h('div', { class: 'link-status' }, h('div', {}, h('p', {}, text.title), text.detail ? h('p', { class: 'detail' }, text.detail) : null))];
  if (state === 'offline') {
    children.push(h('button', { class: 'btn', type: 'button', onclick: () => app.node.reconnectNow() }, icon('refresh-cw', { size: 18 }), 'Try now'));
  }
  if (status.pending > 0) {
    children.push(h('p', { class: 'small' }, `${status.pending} ${status.pending === 1 ? 'message is' : 'messages are'} waiting to be delivered.`));
  }
  card.replaceChildren(...children);
}

function statusText(status) {
  const keyed = app.config.keyRequired === true;
  if (status.state === 'linked') {
    return { title: `Linked through ${displayName(status.peer.id)}`, detail: 'Messages go through this computer. It cannot read them.' };
  }
  if (status.state === 'connecting' || status.state === 'idle') return { title: 'Linking to the computer…', detail: null };
  const tryAgain = 'This phone tries again by itself.';
  switch (status.reason) {
    case 'connect-failed':
      return { title: 'Can’t reach the computer', detail: `Check that ClawNet is running on it and that this phone is on the same Wi-Fi. ${tryAgain}` };
    case 'handshake-timeout':
      return { title: 'The computer did not answer in time', detail: tryAgain };
    case 'closed':
    case 'noise':
      return keyed
        ? { title: 'The computer refused the link', detail: 'Usually the network key on this phone is not the network’s key. Check it under This phone.' }
        : { title: 'The computer closed the link while setting it up', detail: tryAgain };
    case 'network-mismatch':
      return { title: 'The computer is on a different network', detail: 'This phone was set up for another network. To join this one, delete its identity under This phone and set it up again.' };
    case 'clock-skew':
      return { title: 'The clocks differ too much', detail: 'This phone and the computer must agree on the time within five minutes. Set both to update their time automatically.' };
    case 'blocked':
    case 'not-allowed':
      return { title: 'The computer does not accept this phone', detail: 'Ask whoever runs ClawNet on the computer to allow this phone. Its node id is under This phone.' };
    case 'full':
      return { title: 'The computer has no room for another link', detail: tryAgain };
    case 'timeout':
      return { title: 'The link went quiet and closed', detail: tryAgain };
    case 'shutdown':
      return { title: 'The computer stopped ClawNet', detail: tryAgain };
    default:
      return { title: 'The link closed', detail: tryAgain };
  }
}

function createNodeRow() {
  const row = h('button', { class: 'node-row', type: 'button' },
    h('span', { class: 'ring' }),
    h('span', { class: 'node-main' },
      h('span', { class: 'node-name' }, h('span', {}), h('span', { class: 'node-kind' })),
      h('span', { class: 'node-preview' }),
    ),
    h('span', { class: 'sr-only row-state' }),
    h('span', { class: 'unread', hidden: true }),
    h('span', { class: 'chev' }, icon('chevron-right', { size: 18 })),
  );
  row.addEventListener('click', () => go(`#/chat/${row.dataset.key}`));
  return h('li', {}, row);
}

function updateNodeRow(item, n, conversation) {
  const row = item.firstChild;
  row.dataset.key = n.id;
  const ring = row.querySelector('.ring');
  ring.className = `ring ${n.reachable ? 'ring-ok' : 'ring-away'}`;
  const name = row.querySelector('.node-name > span');
  name.textContent = n.name ?? n.short;
  name.className = n.name === null ? 'mono' : '';
  row.querySelector('.node-kind').textContent = n.phone ? 'phone' : n.linked ? 'your computer' : 'computer';
  const last = conversation?.last ?? null;
  const unread = last !== null && last.direction === 'in' && last.at > (app.read[n.id] ?? 0);
  row.dataset.unread = String(unread);
  row.querySelector('.unread').hidden = !unread;
  const preview = row.querySelector('.node-preview');
  preview.textContent = last !== null ? `${last.direction === 'out' ? 'You: ' : ''}${last.text.replace(/\s+/g, ' ')}` : n.reachable ? (n.canMessage ? 'Reachable' : 'Reachable; its keys have not arrived yet') : 'Not reachable right now';
  // For screen readers: what the coloured ring shows, unless the preview already says it.
  const state = [];
  if (last !== null) state.push(n.reachable ? 'reachable' : 'not reachable');
  if (unread) state.push('new message');
  row.querySelector('.row-state').textContent = state.length === 0 ? '' : `, ${state.join(', ')}`;
}

// ------------------------------------------------------------------ conversation

function renderChat(peer, changed) {
  const node = app.node;
  const info = node.nodes().find((n) => n.id === peer) ?? null;
  if (changed) {
    app.view = 'chat';
    app.chat = peer;
    page.className = 'chat';
    const textarea = h('textarea', {
      id: 'composer',
      rows: 1,
      placeholder: 'Message',
      'aria-label': `Message to ${displayName(peer)}`,
      autocomplete: 'off',
    });
    const send = h('button', { class: 'send', type: 'submit', disabled: true, 'aria-label': 'Send' }, icon('send', { size: 20 }));
    const limit = h('p', { class: 'composer-limit', hidden: true, 'aria-live': 'polite' });
    const form = h('form', { class: 'composer' }, textarea, send);
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
      textarea.style.overflowY = textarea.scrollHeight > 140 ? 'auto' : 'hidden';
      const bytes = encoder.encode(textarea.value).length;
      send.disabled = textarea.value.trim() === '' || bytes > MAX_TEXT_BYTES;
      limit.hidden = bytes < MAX_TEXT_BYTES - 2000;
      limit.textContent = bytes > MAX_TEXT_BYTES ? `Too long by ${bytes - MAX_TEXT_BYTES} bytes` : `${MAX_TEXT_BYTES - bytes} bytes left`;
    };
    textarea.addEventListener('input', resize);
    textarea.addEventListener('keydown', (event) => {
      // On a keyboard, Enter sends and Shift+Enter starts a new line; phones keep the return key.
      if (event.key === 'Enter' && !event.shiftKey && matchMedia('(pointer: fine)').matches) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = textarea.value;
      if (text.trim() === '') return;
      try {
        node.sendText(peer, text);
      } catch (err) {
        showChatProblem(err);
        return;
      }
      textarea.value = '';
      resize();
      document.getElementById('chat-problem')?.remove();
      scrollMessages(true);
    });
    setBar([
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to nodes', onclick: () => go('#/') }, icon('chevron-left', { size: 24 })),
      h('div', { class: 'bar-title' }, h('strong', { id: 'chat-name' }), h('span', { class: 'bar-sub', id: 'chat-sub' })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Rename this node', onclick: () => renameNode(peer) }, icon('pencil', { size: 20 })),
    ]);
    setPage(
      h('div', { class: 'messages', id: 'messages', role: 'log', 'aria-label': 'Messages', 'aria-live': 'off' },
        h('div', { id: 'chat-path' }),
        h('p', { class: 'chat-note', id: 'chat-note' }),
        h('div', { id: 'message-list', class: 'messages-inner' }),
      ),
      h('div', {}, limit, form),
    );
    app.chatFirstRender = true;
    focusPage();
  }
  const name = displayName(peer);
  const nameEl = document.getElementById('chat-name');
  nameEl.textContent = name;
  nameEl.className = info?.name ? '' : 'mono';
  const reach = info === null ? 'Not known to this phone yet' : info.reachable ? 'Reachable' : 'Not reachable right now';
  document.getElementById('chat-sub').textContent = info?.name ? `${info.short}, ${reach.toLowerCase()}` : reach;

  const pathBox = document.getElementById('chat-path');
  const path = node.route(peer);
  pathBox.replaceChildren(path === null ? h('span') : routeMini(path));
  pathBox.className = path === null ? '' : 'chat-path';

  const messages = node.messages(peer);
  const noteEl = document.getElementById('chat-note');
  noteEl.textContent = messages.length === 0
    ? (info?.canMessage === false || info === null ? 'This phone does not have this node’s keys yet. They arrive by themselves, usually soon after it becomes reachable.' : 'No messages yet. They are end-to-end encrypted: nodes in between pass them on without being able to read them.')
    : info !== null && !info.reachable ? 'Not reachable right now. Messages wait on this phone and are sent while the app is open and a route exists.' : '';
  noteEl.hidden = noteEl.textContent === '';

  const listEl = document.getElementById('message-list');
  const nearBottom = isNearBottom();
  const first = app.chatFirstRender === true;
  syncList(listEl, messages, (m) => m.id, (m) => createMessage(m, !first), updateMessage);
  // Announce new messages from now on, not the history that was just drawn.
  if (first) document.getElementById('messages').setAttribute('aria-live', 'polite');
  app.chatFirstRender = false;
  markRead(peer);
  if (first || nearBottom) scrollMessages(first);
}

function routeMini(path) {
  const parts = [];
  path.forEach((id, index) => {
    if (index > 0) parts.push(h('span', { class: 'route-edge' }));
    const self = index === 0;
    parts.push(h('span', { class: 'route-node' },
      h('span', { class: `ring ${self ? 'ring-self' : 'ring-ok'}` }),
      h('span', { class: self ? '' : (app.node.nodes().find((n) => n.id === id)?.name ? '' : 'mono') }, self ? 'you' : displayName(id)),
    ));
  });
  const names = path.map((id, i) => (i === 0 ? 'you' : displayName(id))).join(', then ');
  return h('div', { class: 'route route-mini', role: 'img', 'aria-label': `Route: ${names}` }, ...parts);
}

function createMessage(message, fresh) {
  const el = h('div', { class: `msg ${message.direction === 'out' ? 'msg-out' : 'msg-in'}${fresh ? ' msg-new' : ''}` },
    h('p', { class: 'msg-text' }),
    h('p', { class: 'msg-meta' }),
  );
  el.querySelector('.msg-text').textContent = message.text;
  return el;
}

function updateMessage(el, message) {
  const meta = el.querySelector('.msg-meta');
  const state = message.direction === 'out' ? message.state : 'received';
  if (meta.dataset.state === state && meta.dataset.at === String(message.at)) return;
  meta.dataset.state = state;
  meta.dataset.at = String(message.at);
  const when = h('time', { datetime: new Date(message.ts).toISOString() }, formatTime(message.ts));
  const who = h('span', { class: 'sr-only' }, message.direction === 'out' ? 'You' : displayName(message.peer));
  if (message.direction === 'in') {
    meta.replaceChildren(who, when);
    return;
  }
  const states = {
    queued: ['clock', 'Waiting for a link'],
    sent: ['check', 'Sent'],
    delivered: ['check-check', 'Delivered'],
    expired: ['circle-alert', 'Not delivered'],
  };
  const [name, label] = states[state] ?? states.sent;
  meta.replaceChildren(who, when, h('span', {}, label), icon(name, { size: 15 }));
}

function showChatProblem(err) {
  const text = err.code === 'unknown-destination'
    ? 'This phone does not have this node’s keys yet. Try again when it shows as reachable.'
    : err.code === 'outbox-full'
      ? 'Too many messages are waiting to be delivered. Wait until some are delivered.'
      : err.message;
  document.getElementById('chat-problem')?.remove();
  const box = note('bad', 'circle-alert', h('span', {}, text));
  box.id = 'chat-problem';
  box.setAttribute('role', 'alert');
  document.getElementById('messages').append(box);
  scrollMessages(false);
}

function isNearBottom() {
  const box = document.getElementById('messages');
  return box === null || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function scrollMessages(instant) {
  const box = document.getElementById('messages');
  if (box === null) return;
  requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: instant || reducedMotion() ? 'auto' : 'smooth' }));
}

function markRead(peer) {
  const last = app.node.messages(peer).at(-1);
  if (last === undefined) return;
  if ((app.read[peer] ?? 0) >= last.at) return;
  app.read[peer] = last.at;
  storage.set('read', app.read);
}

function renameNode(peer) {
  const input = h('input', { class: 'input', id: 'rename', type: 'text', maxlength: 40, autocomplete: 'off', value: app.node.nodes().find((n) => n.id === peer)?.name ?? '' });
  openDialog({
    title: 'Name this node',
    body: [
      h('div', { class: 'field' },
        h('label', { for: 'rename' }, 'Name'),
        input,
        h('p', { class: 'hint' }, 'Only this phone sees it. Leave it empty to show the node id.'),
      ),
    ],
    confirm: 'Save',
    initialFocus: input,
    onConfirm: () => {
      app.node.setName(peer, input.value);
      toast('Name saved');
    },
  });
}

// ------------------------------------------------------------------ this phone

function renderPhone(changed) {
  const node = app.node;
  const identity = node.identity;
  const status = node.status();
  if (changed) {
    app.view = 'phone';
    app.chat = null;
    page.className = 'page';
    setBar([
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back to nodes', onclick: () => go('#/') }, icon('chevron-left', { size: 24 })),
      h('div', { class: 'bar-title' }, h('strong', {}, 'This phone')),
    ]);
  }
  const signature = JSON.stringify([status.peer?.id ?? null, status.pending, node.network?.hasKey ?? false]);
  if (!changed && app.phoneSignature === signature) return;
  app.phoneSignature = signature;
  const keyRow = app.config.keyRequired === true
    ? h('div', { class: 'fact-row' }, h('span', {}, node.network?.hasKey ? 'Set on this phone' : 'Not set'), h('button', { class: 'btn', type: 'button', onclick: changeKey }, 'Change'))
    : h('span', {}, 'None: this network is open to any node');
  setPage(
    h('dl', { class: 'facts' },
      fact('Node id', h('div', { class: 'fact-row' },
        h('span', { class: 'node-id' }, identity.nodeId),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Copy the node id', onclick: () => copyText(identity.nodeId) }, icon('copy', { size: 20 })),
      )),
      fact('Network', h('span', { class: 'num' }, identity.networkId)),
      fact('Network key', keyRow),
      fact('Linked through', status.peer === null ? h('span', { class: 'muted' }, 'No link right now') : h('span', { class: displayName(status.peer.id) === status.peer.short ? 'mono' : '' }, displayName(status.peer.id))),
      fact('Waiting to be delivered', h('span', { class: 'num' }, String(status.pending))),
    ),
    note('info', 'circle-alert', h('span', {}, 'This phone’s keys and messages are kept in this browser on this phone and nowhere else. Removing the website’s data, or the home-screen app, removes them. The app works while it is open; closed, it neither sends nor receives.')),
    h('section', { class: 'danger-zone' },
      h('h2', {}, 'Start over'),
      h('p', { class: 'small' }, 'Deletes this phone’s keys, its network key and every message on it. Other nodes will see it as a new node.'),
      h('button', { class: 'btn btn-danger btn-wide', type: 'button', onclick: () => confirmReset() }, 'Delete this phone’s identity'),
    ),
  );
  if (changed) focusPage();
}

function fact(label, value) {
  return h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, value));
}

function changeKey() {
  const input = h('input', { class: 'input mono', id: 'new-key', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: '44 characters, ending in =' });
  const error = h('p', { class: 'error-text', role: 'alert', hidden: true });
  openDialog({
    title: 'Change the network key',
    body: [h('div', { class: 'field' }, h('label', { for: 'new-key' }, 'Network key'), input, error)],
    confirm: 'Save key',
    initialFocus: input,
    onConfirm: () => {
      try {
        app.node.setNetworkKey(input.value);
      } catch {
        showError(error, BAD_KEY, input);
        return false;
      }
      app.node.stop();
      startNode();
      toast('Key saved');
      return true;
    },
  });
}

function confirmReset() {
  openDialog({
    title: 'Delete this phone’s identity?',
    body: [h('p', {}, 'Its keys and every message on this phone are deleted. This cannot be undone.')],
    confirm: 'Delete',
    danger: true,
    onConfirm: () => {
      app.node.reset();
      app.read = {};
      app.view = null;
      history.replaceState(null, '', location.pathname);
      render({ navigation: true });
    },
  });
}

// ------------------------------------------------------------------ shared pieces

function setBar(children) {
  bar.replaceChildren(...children.filter(Boolean));
}

/** Replace the page's content; null and false entries (optional parts) are left out. */
function setPage(...children) {
  page.replaceChildren(...children.filter(Boolean));
}

function wordmark() {
  return h('span', { class: 'wordmark' }, 'ClawNet');
}

function selfChip() {
  const identity = app.node.identity;
  return h('a', { class: 'btn', href: '#/phone', 'aria-label': `This phone, node ${identity.short}` },
    h('span', { class: 'ring ring-self' }),
    h('span', { class: 'mono self-text' }, identity.short),
  );
}

function displayName(id) {
  const known = app.node.nodes().find((n) => n.id === id);
  return known?.name ?? id.slice(0, 8);
}

function note(tone, iconName, body) {
  return h('div', { class: `note note-${tone}` }, icon(iconName, { size: 18 }), body);
}

function showError(el, text, input) {
  el.textContent = text;
  el.hidden = false;
  input?.setAttribute('aria-invalid', 'true');
  input?.focus();
}

function formatTime(ts) {
  const date = new Date(ts);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? timeFormat.format(date) : dayFormat.format(date);
}

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function focusPage() {
  page.focus({ preventScroll: true });
}

function announce(text) {
  announcer.textContent = '';
  setTimeout(() => {
    announcer.textContent = text;
  }, 50);
}

let toastTimer = null;
function toast(text, { long = false } = {}) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast' }, text);
  document.body.append(el);
  announce(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), long ? 6000 : 2000);
}

/** navigator.clipboard needs a secure context, which a page on plain http is not. */
function copyText(text) {
  const area = h('textarea', { readonly: true, class: 'sr-only' });
  area.value = text;
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  toast(ok ? 'Copied' : 'Copying is not available here. Press and hold the id to select and copy it.', { long: !ok });
}

/**
 * A modal dialog. `onConfirm` may return false to keep it open (a validation error).
 */
function openDialog({ title, body, confirm, danger = false, onConfirm, initialFocus }) {
  const dialog = h('dialog', { 'aria-labelledby': 'dialog-title' });
  const form = h('form', { method: 'dialog' },
    h('h2', { id: 'dialog-title' }, title),
    ...body,
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn', type: 'button', value: 'cancel', onclick: () => dialog.close('cancel') }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit', value: 'ok' }, confirm),
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (onConfirm() === false) return;
    dialog.close('ok');
  });
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  initialFocus?.focus();
}

/**
 * Keep a list's children in step with `items`, reusing the element of each key, so a
 * refresh does not steal focus or restart animations.
 */
function syncList(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of [...container.children]) existing.set(child.dataset.key, child);
  let previous = null;
  for (const item of items) {
    const key = keyOf(item);
    let el = existing.get(key);
    if (el === undefined) {
      el = create(item);
      el.dataset.key = key;
    }
    existing.delete(key);
    update(el, item);
    const expected = previous === null ? container.firstChild : previous.nextSibling;
    if (expected !== el) container.insertBefore(el, expected);
    previous = el;
  }
  for (const el of existing.values()) el.remove();
}

/**
 * Create an element. Strings become text nodes; `on*` attributes become listeners;
 * `true` sets a boolean attribute and false or null leaves it out.
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value);
    else if (name === 'value') el.value = value;
    else if (value === true) el.setAttribute(name, '');
    else el.setAttribute(name, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}
