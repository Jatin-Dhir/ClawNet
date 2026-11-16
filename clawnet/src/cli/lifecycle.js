/**
 * Creating an identity and running a node in the foreground: the two commands that do not
 * talk to a running node.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkNetworkId, formatNetworkIdFile, loadConfig } from '../core/config.js';
import { Identity } from '../core/crypto/identity.js';
import { AuthError, ClawNetError, ConfigError, StateError } from '../core/errors.js';
import { ClawNode } from '../core/node.js';
import { defaultServices } from '../services.js';
import { Keystore } from '../vault/keystore.js';
import { atomicCreateFile, atomicWriteFile, ensurePrivateDir } from '../vault/store.js';
import { CliError, ExitCode, UsageError } from './errors.js';

/** Name of the keystore in a data directory. */
export const KEYSTORE_FILE = 'keystore.json';

/** Environment variable that carries the passphrase when there is no file and no terminal. */
export const PASSPHRASE_ENV = 'CLAWNET_PASSPHRASE';

const MAX_SECRET_FILE_BYTES = 4096;
const DEFAULT_NETWORK_ID = 'clawnet-main';

/**
 * Read a secret (a passphrase or a network key) from a file. One trailing line break is
 * removed, nothing else, so a passphrase may begin or end with spaces.
 *
 * @param {string} file
 * @param {string} what for the error message
 * @returns {Promise<string>}
 * @throws {CliError} if the file cannot be read, is too large or is empty
 */
export async function readSecretFile(file, what) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new CliError(`cannot read the ${what} file ${file}: ${error.code ?? error.message}`);
  }
  if (bytes.length > MAX_SECRET_FILE_BYTES) throw new CliError(`the ${what} file ${file} is larger than ${MAX_SECRET_FILE_BYTES} bytes`);
  const text = bytes.toString('utf8').replace(/\r?\n$/, '');
  if (text === '') throw new CliError(`the ${what} file ${file} is empty`);
  return text;
}

/**
 * Ask for a secret on the terminal without echoing it.
 *
 * @param {{ stdin: any, stderr: { write: Function } }} io
 * @param {string} label
 * @returns {Promise<string>}
 * @throws {CliError} if there is no terminal, or the user interrupts
 */
export function promptHidden(io, label) {
  const { stdin, stderr } = io;
  if (stdin?.isTTY !== true || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new UsageError('a passphrase is needed: use --passphrase-file or set CLAWNET_PASSPHRASE (there is no terminal to ask on)'));
  }
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = (settle) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      settle();
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(text));
        if (char === '\x03') return finish(() => reject(new CliError('interrupted')));
        if (char === '\x7f' || char === '\b') text = text.slice(0, -1);
        else text += char;
      }
      return undefined;
    };
    stderr.write(label);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Create the data directory, the network record, a starter configuration and the keystore
 * with a new identity. Nothing existing is overwritten.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} [options.passphrase] encrypts the keystore; omit to store it unencrypted
 * @param {string} [options.networkId] the network this identity belongs to
 * @returns {Promise<{ nodeId: string, encrypted: boolean, dataDir: string }>}
 * @throws {CliError} if the directory already holds an identity
 */
export async function initIdentity({ dataDir, passphrase, networkId = DEFAULT_NETWORK_ID }) {
  await ensurePrivateDir(dataDir);
  const keystorePath = join(dataDir, KEYSTORE_FILE);
  if (await Keystore.exists(keystorePath)) {
    throw new CliError(`${dataDir} already holds an identity; refusing to overwrite it (use another --data-dir)`);
  }
  // The network is recorded before the identity exists, so no identity is ever without one.
  const { recorded, file } = checkNetworkId({ dataDir, networkId });
  if (recorded === null) await atomicWriteFile(file, formatNetworkIdFile(networkId));
  try {
    await atomicCreateFile(join(dataDir, 'config.json'), `${JSON.stringify({ networkId }, null, 2)}\n`);
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
  }
  const identity = Identity.generate();
  const secret = identity.toSecret();
  const bytes = Buffer.concat([secret.signSeed, secret.linkPrivate, secret.e2ePrivate]);
  try {
    await Keystore.create(keystorePath, bytes, { passphrase });
  } finally {
    bytes.fill(0);
    for (const key of Object.values(secret)) key.fill(0);
  }
  return { nodeId: identity.nodeId, encrypted: passphrase !== undefined, dataDir };
}

/** @returns {{ host: string, port: number }} from `host:port`, `[v6]:port` or a bare port */
export function parseListen(text) {
  const match = /^(?:(\[[0-9a-fA-F:.]+\]|[^:[\]]+):)?([0-9]{1,5})$/.exec(text);
  if (match === null || Number(match[2]) > 65535) throw new UsageError(`--listen must look like host:port, not "${text}"`);
  const host = match[1] === undefined ? '0.0.0.0' : match[1].replace(/^\[|\]$/g, '');
  return { host, port: Number(match[2]) };
}

/** Turn the `start` flags into a configuration layer. */
async function overridesFrom(values) {
  const overrides = {};
  if (values.listen !== undefined) overrides.listen = parseListen(values.listen);
  if (values['api-port'] !== undefined) {
    if (!/^[0-9]{1,5}$/.test(values['api-port']) || Number(values['api-port']) > 65535) throw new UsageError('--api-port must be a port number');
    overrides.api = { port: Number(values['api-port']) };
  }
  if (values.network !== undefined) overrides.networkId = values.network;
  if (values['network-key-file'] !== undefined) overrides.networkKey = await readSecretFile(values['network-key-file'], 'network key');
  const discovery = {};
  if (values.bootstrap !== undefined) discovery.bootstrap = values.bootstrap;
  if (values.multicast === true && values['no-multicast'] === true) throw new UsageError('use either --multicast or --no-multicast, not both');
  if (values['no-multicast'] === true) discovery.multicast = { enabled: false };
  if (values.multicast === true) discovery.multicast = { enabled: true };
  if (Object.keys(discovery).length > 0) overrides.discovery = discovery;
  return overrides;
}

/**
 * Run a node in the foreground until it is stopped (a signal, or `POST /shutdown`).
 *
 * Prints one line on standard output when the node is ready, and nothing else there.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {object} options.values the parsed `start` flags
 * @param {object} options.io see main.js
 * @returns {Promise<number>} the exit code
 * @throws {CliError} for anything the user can fix
 */
export async function runNode({ dataDir, values, io }) {
  const keystorePath = join(dataDir, KEYSTORE_FILE);
  if (!(await Keystore.exists(keystorePath))) {
    throw new CliError(`no identity in ${dataDir}; create one with "clawnet init" first`);
  }
  let passphrase;
  if (await Keystore.isEncrypted(keystorePath)) {
    if (values['passphrase-file'] !== undefined) passphrase = await readSecretFile(values['passphrase-file'], 'passphrase');
    else if (typeof io.env[PASSPHRASE_ENV] === 'string' && io.env[PASSPHRASE_ENV] !== '') passphrase = io.env[PASSPHRASE_ENV];
    else passphrase = await promptHidden(io, 'Passphrase: ');
  }
  const config = loadConfig({ dataDir, overrides: await overridesFrom(values), env: io.env });
  const node = new ClawNode({ config, dataDir, passphrase, services: defaultServices() });

  let signals = 0;
  let stopError = null;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) {
      io.exit(ExitCode.FAILURE);
      return;
    }
    node.stop({ reason: 'signal' }).catch((error) => {
      stopError = error;
    });
  };
  const names = ['SIGINT', 'SIGTERM', 'SIGBREAK'];
  for (const name of names) io.signals.on(name, onSignal);
  try {
    try {
      await node.start();
    } catch (error) {
      throw describeStartFailure(error, dataDir);
    }
    const stopped = new Promise((resolve) => {
      if (node.state === 'stopped') resolve();
      else node.events.on('node.stopped', () => resolve());
    });
    const api = node.service('api');
    io.stdout.write(`${JSON.stringify({
      event: 'ready',
      nodeId: node.id,
      listen: node.status().listen,
      api: api?.url ?? null,
      dataDir,
    })}\n`);
    await stopped;
  } finally {
    for (const name of names) io.signals.off(name, onSignal);
  }
  if (stopError !== null) throw new CliError(`the node did not stop cleanly: ${stopError.message}`);
  return ExitCode.OK;
}

/** A start failure the user can act on, without a stack trace. */
function describeStartFailure(error, dataDir) {
  if (error instanceof AuthError) return new CliError(`cannot unlock the keystore in ${dataDir}: wrong passphrase, or the file was changed`);
  if (error instanceof StateError && error.message.startsWith('locked:')) {
    return new CliError(`the data directory ${dataDir} is already in use (${error.message.replace(/^locked: /, '')})`);
  }
  if (error instanceof StateError && error.message.startsWith('api-listen-failed:')) {
    return new CliError(error.message.replace(/^api-listen-failed: /, 'the control API '));
  }
  if (error instanceof ConfigError || error instanceof ClawNetError) return new CliError(error.message, { cause: error });
  return error;
}
