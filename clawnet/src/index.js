/**
 * The public entry point of the ClawNet engine (ARCHITECTURE.md 5.9).
 *
 * It exposes the node runtime, configuration, key storage, identities, the error classes
 * and the protocol constants. It imports no service module: services (casts, files,
 * relay, diagnostics, the control API) are handed to `ClawNode` by whoever assembles a
 * node, so the engine works the same with or without them.
 */

export {
  ApiReply,
  ClawNode,
  createLogger,
  EVENT_BUS_CAPACITY,
  Router,
  SERVICE_NAME_PATTERN,
  STOP_TIMEOUT_MS,
  TimerSet,
  TRAFFIC_SAMPLE_MS,
} from './core/node.js';
export { defaultConfig, loadConfig, resolveDataDir, validateConfig } from './core/config.js';
export { Keystore } from './vault/keystore.js';
export { Identity } from './core/crypto/identity.js';
export {
  AuthError,
  CanonicalError,
  ClawNetError,
  ConfigError,
  CryptoError,
  HandshakeError,
  ProtocolError,
  StateError,
  StoreError,
  WireError,
} from './core/errors.js';
export {
  CHANNEL_ID_PATTERN,
  Domain,
  isRoutedType,
  Limits,
  MESSAGE_ID_PATTERN,
  NODE_ID_PATTERN,
  NoiseProtocol,
  PACKET_TYPE_NAMES,
  PacketType,
  PROTOCOL,
  RecordType,
  SealScheme,
} from './core/wire/types.js';
