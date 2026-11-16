/**
 * Error types for the ClawNet engine.
 *
 * Every error the engine throws on purpose is a ClawNetError with a stable `code`, so
 * callers branch on `err.code` instead of matching message text. Messages are written
 * for the operator; they never contain key material or message plaintext.
 */

export class ClawNetError extends Error {
  /**
   * @param {string} code    stable, machine-readable identifier
   * @param {string} message human-readable explanation
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A value cannot be represented in canonical JSON, or input is not in canonical form. */
export class CanonicalError extends ClawNetError {
  constructor(message, options) {
    super('ERR_CANONICAL', message, options);
  }
}

/** Bytes received from a peer do not form a valid frame, packet or record. */
export class WireError extends ClawNetError {
  constructor(message, options) {
    super('ERR_WIRE', message, options);
  }
}

/** A cryptographic operation was given invalid input (wrong key length, bad encoding). */
export class CryptoError extends ClawNetError {
  constructor(message, options) {
    super('ERR_CRYPTO', message, options);
  }
}

/** Authentication failed: an AEAD tag or a signature did not verify. */
export class AuthError extends ClawNetError {
  constructor(message, options) {
    super('ERR_AUTH', message, options);
  }
}

/** A link handshake could not be completed or the peer was refused. */
export class HandshakeError extends ClawNetError {
  /**
   * @param {string} reason short machine-readable reason, e.g. "bad-card", "blocked", "timeout"
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(reason, message, options) {
    super('ERR_HANDSHAKE', message, options);
    this.reason = reason;
  }
}

/** A peer broke the protocol after the handshake (bad packet, limit exceeded). */
export class ProtocolError extends ClawNetError {
  constructor(message, options) {
    super('ERR_PROTOCOL', message, options);
  }
}

/** Configuration is missing, malformed or out of range. */
export class ConfigError extends ClawNetError {
  constructor(message, options) {
    super('ERR_CONFIG', message, options);
  }
}

/** Durable state could not be read or written. */
export class StoreError extends ClawNetError {
  constructor(message, options) {
    super('ERR_STORE', message, options);
  }
}

/** The requested operation cannot proceed in the current state (not started, unknown peer). */
export class StateError extends ClawNetError {
  constructor(message, options) {
    super('ERR_STATE', message, options);
  }
}
