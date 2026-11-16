/**
 * What the command line reports to its user, and the exit code each kind of failure
 * produces: 1 for a failure, 2 for a usage error, 3 when no node is running.
 */

/** Exit codes of the `clawnet` command. */
export const ExitCode = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 2, NOT_RUNNING: 3 });

/** A failure that is the user's to read: the message is printed, never a stack. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, cause?: unknown }} [options]
   */
  constructor(message, { exitCode = ExitCode.FAILURE, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** The command line itself is wrong: unknown command or option, missing argument. */
export class UsageError extends CliError {
  /** @param {string} message */
  constructor(message) {
    super(message, { exitCode: ExitCode.USAGE });
    this.name = 'UsageError';
  }
}

/** A client command found no node to talk to. */
export class NotRunningError extends CliError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { exitCode: ExitCode.NOT_RUNNING, ...options });
    this.name = 'NotRunningError';
  }
}

/** The node answered with an error document (API.md section 4). */
export class ApiError extends CliError {
  /**
   * @param {number} status HTTP status
   * @param {string} code the stable error code
   * @param {string} message
   * @param {object | undefined} [details]
   */
  constructor(status, code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
