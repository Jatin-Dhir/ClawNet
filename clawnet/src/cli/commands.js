/**
 * The commands of `clawnet`: what each takes, and what it does. Client commands only call
 * the control API (API.md) and print what it answers; no protocol logic lives here.
 */

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isNodeId } from '../core/wire/schema.js';
import { RUNTIME_FILE } from './client.js';
import { startDevnet, TOPOLOGIES } from './devnet.js';
import { CliError, ExitCode, UsageError } from './errors.js';
import {
  conversationsText, countersText, identityText, messagesText, outboxText, peersText, pingText, routesText,
  short, statusText, topologyText, traceText,
} from './format.js';
import { initIdentity, promptHidden, PASSPHRASE_ENV, readSecretFile, runNode } from './lifecycle.js';

const STOP_WAIT_MS = 15_000;
const PID_WAIT_MS = 5000;
const MIN_PREFIX = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** An integer option, or `fallback` when it was not given. */
function intOption(values, name, { min, max, fallback }) {
  const text = values[name];
  if (text === undefined) return fallback;
  if (!/^[0-9]{1,15}$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new UsageError(`--${name} must be a number from ${min} to ${max}`);
  }
  return Number(text);
}

/**
 * Turn what the user typed into a full NodeId. A full id is passed through; anything
 * shorter (at least 8 characters) must be the start of exactly one id the node knows.
 *
 * @param {import('./client.js').ApiClient} client
 * @param {string} text
 * @returns {Promise<string>}
 * @throws {UsageError} if it is not an id, or matches none or several
 */
export async function resolveNodeId(client, text) {
  if (isNodeId(text)) return text;
  if (!/^[a-z2-7]+$/.test(text) || text.length < MIN_PREFIX || text.length > 52) {
    throw new UsageError(`"${text}" is not a node id; give the full id or at least ${MIN_PREFIX} characters of it`);
  }
  const [topology, peers] = await Promise.all([client.request('GET', '/topology'), client.request('GET', '/peers')]);
  const known = new Set([...topology.nodes.map((node) => node.id), ...peers.peers.map((peer) => peer.id)]);
  const matches = [...known].filter((id) => id.startsWith(text));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new UsageError(`no node known to this node starts with "${text}"`);
  throw new UsageError(`"${text}" is ambiguous: ${matches.map(short).join(', ')}`);
}

function normalizeAddress(text) {
  return text.includes('://') ? text : `tcp://${text}`;
}

/** Write a document in `--json` mode, else the text. */
function print(ctx, document, text) {
  ctx.io.stdout.write(ctx.json ? `${JSON.stringify(document)}\n` : text);
}

/** A client command that GETs one document and prints it. */
function getCommand(summary, path, render) {
  return {
    summary,
    min: 0,
    max: 0,
    async run(ctx) {
      const document = await (await ctx.client()).request('GET', path);
      print(ctx, document, render(document));
      return ExitCode.OK;
    },
  };
}

/** @type {Record<string, { summary: string, usage?: string, options?: object, min: number, max: number, run: Function }>} */
export const COMMANDS = {
  init: {
    summary: 'create a data directory with a new identity',
    usage: 'init [--network <id>] [--passphrase-file <file> | --no-passphrase]',
    options: {
      'passphrase-file': { type: 'string' },
      'no-passphrase': { type: 'boolean' },
      network: { type: 'string' },
    },
    min: 0,
    max: 0,
    async run(ctx) {
      const { values } = ctx;
      if (values['passphrase-file'] !== undefined && values['no-passphrase'] === true) {
        throw new UsageError('use either --passphrase-file or --no-passphrase, not both');
      }
      let passphrase;
      if (values['no-passphrase'] !== true) {
        if (values['passphrase-file'] !== undefined) {
          passphrase = await readSecretFile(values['passphrase-file'], 'passphrase');
        } else if (typeof ctx.io.env[PASSPHRASE_ENV] === 'string' && ctx.io.env[PASSPHRASE_ENV] !== '') {
          passphrase = ctx.io.env[PASSPHRASE_ENV];
        } else if (ctx.io.stdin?.isTTY === true) {
          const first = await promptHidden(ctx.io, 'New passphrase (empty for none): ');
          if (first !== '') {
            if ((await promptHidden(ctx.io, 'Repeat passphrase: ')) !== first) throw new CliError('the passphrases differ');
            passphrase = first;
          }
        } else {
          throw new UsageError('choose how to protect the keystore: --passphrase-file <file> or --no-passphrase');
        }
      }
      const result = await initIdentity({ dataDir: ctx.dataDir, passphrase, networkId: values.network });
      if (!result.encrypted) {
        ctx.io.stderr.write('warning: the keystore is not encrypted; only file permissions protect the identity\n');
      }
      print(ctx, result, `initialised ${result.dataDir}\nnode id ${result.nodeId}\n`);
      return ExitCode.OK;
    },
  },

  start: {
    summary: 'run a node in the foreground',
    usage: 'start [--listen host:port] [--api-port n] [--bootstrap addr]... [--network id]\n        [--network-key-file f] [--multicast | --no-multicast] [--passphrase-file f]',
    options: {
      listen: { type: 'string' },
      'api-port': { type: 'string' },
      bootstrap: { type: 'string', multiple: true },
      network: { type: 'string' },
      'network-key-file': { type: 'string' },
      multicast: { type: 'boolean' },
      'no-multicast': { type: 'boolean' },
      'passphrase-file': { type: 'string' },
    },
    min: 0,
    max: 0,
    run: (ctx) => runNode({ dataDir: ctx.dataDir, values: ctx.values, io: ctx.io }),
  },

  id: getCommand('print this node\'s id', '/identity', identityText),
  status: getCommand('summary of the running node', '/status', statusText),
  peers: getCommand('links and dials in progress', '/peers', peersText),
  routes: getCommand('the routing table', '/topology/routes', routesText),
  topology: getCommand('nodes and links this node knows of', '/topology', topologyText),
  outbox: getCommand('messages not yet acknowledged', '/outbox', outboxText),
  counters: getCommand('counters and rates', '/diag/counters', countersText),
  config: getCommand('the effective configuration', '/config', (document) => `${JSON.stringify(document.config, null, 2)}\n`),

  connect: {
    summary: 'dial a peer',
    usage: 'connect <tcp://host:port>',
    min: 1,
    max: 1,
    async run(ctx) {
      const { peer } = await (await ctx.client()).request('POST', '/peers/connect', { address: normalizeAddress(ctx.args[0]) }, { timeoutMs: 60_000 });
      print(ctx, { peer }, `linked to ${peer.id} at ${peer.addr}\n`);
      return ExitCode.OK;
    },
  },

  disconnect: {
    summary: 'close the link to a peer',
    usage: 'disconnect <id>',
    min: 1,
    max: 1,
    async run(ctx) {
      const client = await ctx.client();
      const id = await resolveNodeId(client, ctx.args[0]);
      const result = await client.request('POST', `/peers/${id}/disconnect`, {});
      print(ctx, result, `disconnected from ${short(id)}\n`);
      return ExitCode.OK;
    },
  },

  send: {
    summary: 'send an end-to-end encrypted message',
    usage: 'send <id> <text...>',
    min: 2,
    max: Infinity,
    async run(ctx) {
      const client = await ctx.client();
      const to = await resolveNodeId(client, ctx.args[0]);
      const { message } = await client.request('POST', '/messages', { to, text: ctx.args.slice(1).join(' ') });
      print(ctx, { message }, `message ${message.id} to ${short(to)}: ${message.state}\n`);
      return ExitCode.OK;
    },
  },

  inbox: {
    summary: 'conversations, or the messages with one node',
    usage: 'inbox [<id>] [--limit n] [--before seq]',
    options: { limit: { type: 'string' }, before: { type: 'string' } },
    min: 0,
    max: 1,
    async run(ctx) {
      const client = await ctx.client();
      if (ctx.args.length === 0) {
        const document = await client.request('GET', '/conversations');
        print(ctx, document, conversationsText(document));
        return ExitCode.OK;
      }
      const id = await resolveNodeId(client, ctx.args[0]);
      const limit = intOption(ctx.values, 'limit', { min: 1, max: 500, fallback: undefined });
      const before = intOption(ctx.values, 'before', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: undefined });
      const query = new URLSearchParams();
      if (limit !== undefined) query.set('limit', String(limit));
      if (before !== undefined) query.set('before', String(before));
      const document = await client.request('GET', `/conversations/${id}${query.size > 0 ? `?${query}` : ''}`);
      print(ctx, document, messagesText(document));
      return ExitCode.OK;
    },
  },

  ping: {
    summary: 'measure the round trip to a node',
    usage: 'ping <id> [-c count] [--interval ms] [--timeout ms]',
    options: { count: { type: 'string', short: 'c' }, interval: { type: 'string' }, timeout: { type: 'string' } },
    min: 1,
    max: 1,
    async run(ctx) {
      const client = await ctx.client();
      const to = await resolveNodeId(client, ctx.args[0]);
      const body = { to };
      const count = intOption(ctx.values, 'count', { min: 1, max: 100, fallback: undefined });
      const intervalMs = intOption(ctx.values, 'interval', { min: 10, max: 60000, fallback: undefined });
      const timeoutMs = intOption(ctx.values, 'timeout', { min: 100, max: 60000, fallback: undefined });
      if (count !== undefined) body.count = count;
      if (intervalMs !== undefined) body.intervalMs = intervalMs;
      if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
      const budget = (count ?? 4) * ((intervalMs ?? 1000) + (timeoutMs ?? 5000)) + 10_000;
      const result = await client.request('POST', '/diag/ping', body, { timeoutMs: budget });
      print(ctx, result, pingText(result));
      return result.received > 0 ? ExitCode.OK : ExitCode.FAILURE;
    },
  },

  trace: {
    summary: 'show the path to a node, hop by hop',
    usage: 'trace <id> [--max-hops n] [--timeout ms]',
    options: { 'max-hops': { type: 'string' }, timeout: { type: 'string' } },
    min: 1,
    max: 1,
    async run(ctx) {
      const client = await ctx.client();
      const to = await resolveNodeId(client, ctx.args[0]);
      const body = { to };
      const maxHops = intOption(ctx.values, 'max-hops', { min: 1, max: 32, fallback: undefined });
      const timeoutMs = intOption(ctx.values, 'timeout', { min: 100, max: 60000, fallback: undefined });
      if (maxHops !== undefined) body.maxHops = maxHops;
      if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
      const result = await client.request('POST', '/diag/traceroute', body, { timeoutMs: (maxHops ?? 32) * (timeoutMs ?? 3000) + 10_000 });
      print(ctx, result, traceText(result));
      return result.reached ? ExitCode.OK : ExitCode.FAILURE;
    },
  },

  events: {
    summary: 'follow the live event stream, one JSON event per line',
    usage: 'events [--types a,b.*] [--count n] [--replay]',
    options: { types: { type: 'string' }, count: { type: 'string' }, replay: { type: 'boolean' } },
    min: 0,
    max: 0,
    async run(ctx) {
      const client = await ctx.client();
      const types = ctx.values.types === undefined ? undefined : ctx.values.types.split(',').map((type) => type.trim());
      const limit = intOption(ctx.values, 'count', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: Infinity });
      let lastEventId;
      if (ctx.values.replay === true) lastEventId = `${(await client.request('GET', '/status')).boot}-0`;
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      ctx.io.signals.on('SIGINT', onSignal);
      let printed = 0;
      try {
        for await (const item of client.events({ types, lastEventId, signal: controller.signal })) {
          if (item.type === 'stream.hello' || item.event === null) continue;
          // Bus events are `{ seq, ts, type, data }`; the stream's own notices (a gap) are
          // `data` alone, so they are wrapped to look the same.
          const line = item.type === 'stream.gap' ? { type: 'stream.gap', data: item.event } : item.event;
          ctx.io.stdout.write(`${JSON.stringify(line)}\n`);
          printed += 1;
          if (printed >= limit) {
            controller.abort();
            break;
          }
        }
      } finally {
        ctx.io.signals.off('SIGINT', onSignal);
      }
      return ExitCode.OK;
    },
  },

  stop: {
    summary: 'stop the running node and wait until it has exited',
    min: 0,
    max: 0,
    async run(ctx) {
      const client = await ctx.client();
      let pid = null;
      try {
        pid = JSON.parse(await readFile(join(ctx.dataDir, RUNTIME_FILE), 'utf8')).pid ?? null;
      } catch {
        // Without a pid the wait below only covers runtime.json.
      }
      await client.request('POST', '/shutdown', {});
      const runtimePath = join(ctx.dataDir, RUNTIME_FILE);
      const deadline = Date.now() + STOP_WAIT_MS;
      while (await exists(runtimePath)) {
        if (Date.now() > deadline) throw new CliError(`the node did not stop within ${STOP_WAIT_MS / 1000} s`);
        await sleep(50);
      }
      const pidDeadline = Date.now() + PID_WAIT_MS;
      // A node running inside this very process (a test, an embedding program) cannot be waited for.
      while (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid) && Date.now() < pidDeadline) await sleep(25);
      print(ctx, { stopped: true }, 'stopped\n');
      return ExitCode.OK;
    },
  },

  ui: {
    summary: 'print the console address, with its token in the URL fragment',
    usage: 'ui [--open]',
    options: { open: { type: 'boolean' } },
    min: 0,
    max: 0,
    async run(ctx) {
      const url = (await ctx.client()).consoleUrl();
      print(ctx, { url }, `${url}\n`);
      if (ctx.values.open === true) openBrowser(url);
      return ExitCode.OK;
    },
  },

  devnet: {
    summary: 'start several nodes on this machine, joined into a network',
    usage: 'devnet --nodes <n> [--topology line|ring|star|mesh] [--base-dir <dir>]',
    options: { nodes: { type: 'string' }, topology: { type: 'string' }, 'base-dir': { type: 'string' } },
    min: 0,
    max: 0,
    run: (ctx) => runDevnet(ctx),
  },
};

/** Open a URL in the default browser. The URL carries the token, so it is never logged. */
function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

async function runDevnet(ctx) {
  const { values, io } = ctx;
  if (values.nodes === undefined) throw new UsageError('devnet needs --nodes <n>');
  const nodes = intOption(values, 'nodes', { min: 1, max: 32, fallback: undefined });
  const topology = values.topology ?? 'mesh';
  if (!TOPOLOGIES.includes(topology)) throw new UsageError(`--topology must be one of ${TOPOLOGIES.join(', ')}`);

  let interrupted = null;
  const interruption = new Promise((resolve) => {
    interrupted = () => resolve();
  });
  const names = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
  for (const name of names) io.signals.on(name, interrupted);
  let devnet = null;
  try {
    const starting = startDevnet({ nodes, baseDir: values['base-dir'], topology, env: io.env });
    // A Ctrl+C while the nodes are still starting stops them as well.
    const early = await Promise.race([starting.then(() => null), interruption.then(() => 'interrupted')]);
    if (early === 'interrupted') {
      await starting.then((started) => started.stop(), () => {});
      return ExitCode.OK;
    }
    devnet = await starting;
    if (ctx.json) {
      io.stdout.write(`${JSON.stringify({ baseDir: devnet.baseDir, topology, nodes: devnet.nodes })}\n`);
    } else {
      io.stdout.write(`ClawNet devnet: ${devnet.nodes.length} node${devnet.nodes.length === 1 ? '' : 's'}, ${topology} topology, in ${devnet.baseDir}\n`);
      io.stdout.write('Every listener is on 127.0.0.1; nothing here is reachable from another machine.\n');
      io.stdout.write('Open a console URL in a browser; it signs in with the token after the #.\n\n');
      for (const node of devnet.nodes) {
        io.stdout.write(`node ${node.index}  ${short(node.nodeId)}  peers ${node.listen}  pid ${node.pid}\n`);
        io.stdout.write(`        console ${node.console}\n`);
      }
      io.stdout.write('\nPress Ctrl+C to stop all nodes.\n');
    }
    await Promise.race([interruption, devnet.exited]);
    return ExitCode.OK;
  } finally {
    for (const name of names) io.signals.off(name, interrupted);
    if (devnet !== null) await devnet.stop();
  }
}

/**
 * Find a command by name.
 *
 * @param {string} name
 * @returns {object | undefined}
 */
export function findCommand(name) {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}
