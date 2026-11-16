/**
 * The `clawnet` command line: argument parsing, dispatch and exit codes. Everything a
 * command touches (streams, environment, signals, exit) arrives through `io`, so tests
 * run whole commands in-process.
 *
 * Exit codes: 0 success, 1 failure, 2 usage error, 3 no node is running.
 */

import { parseArgs } from 'node:util';

import { resolveDataDir } from '../core/config.js';
import { DEFAULT_AGENT } from '../core/peer/peer-manager.js';
import { ApiClient } from './client.js';
import { COMMANDS, findCommand } from './commands.js';
import { CliError, ExitCode, UsageError } from './errors.js';

/** Options every command accepts. */
const GLOBAL_OPTIONS = Object.freeze({
  'data-dir': { type: 'string', short: 'd' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
});

/**
 * The real process as `io`.
 *
 * @returns {object} `{ stdout, stderr, stdin, env, signals, exit }`
 */
export function processIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    signals: process,
    exit: (code) => process.exit(code),
  };
}

/** @returns {string} the overview printed by `clawnet help` */
export function helpText() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`);
  return [
    'usage: clawnet [--data-dir <dir>] [--json] <command> [arguments]',
    '',
    'commands:',
    ...lines,
    '',
    'Client commands talk to the node running with the same data directory.',
    'Node ids may be shortened to any unique prefix of at least 8 characters.',
    '--json prints one JSON document on standard output.',
    'exit codes: 0 success, 1 failure, 2 usage error, 3 no node is running',
    '',
    'clawnet help <command> shows one command.',
    '',
  ].join('\n');
}

function commandHelp(name, command) {
  const usage = command.usage ?? name;
  return `usage: clawnet [--data-dir <dir>] [--json] ${usage}\n\n${command.summary}\n`;
}

/** Split argv into the command word and the rest; global options may come first. */
function splitCommand(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-dir' || arg === '-d') {
      i += 1;
    } else if (!arg.startsWith('-')) {
      return { name: arg, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    }
  }
  return { name: null, rest: argv };
}

/**
 * Parse a command line.
 *
 * @param {string[]} argv arguments after the program name
 * @returns {{ name: string | null, command?: object, values: object, args: string[] }}
 * @throws {UsageError} for an unknown command or option, or a wrong number of arguments
 */
export function parseCommandLine(argv) {
  const { name, rest } = splitCommand(argv);
  if (name === null) {
    const { values } = safeParse(rest, GLOBAL_OPTIONS, false);
    return { name: null, values, args: [] };
  }
  if (name === 'help') {
    const { positionals } = safeParse(rest, GLOBAL_OPTIONS, true);
    return { name: 'help', values: {}, args: positionals };
  }
  const command = findCommand(name);
  if (command === undefined) throw new UsageError(`unknown command "${name}"`);
  const { values, positionals } = safeParse(rest, { ...GLOBAL_OPTIONS, ...command.options }, true);
  if (values.help !== true && (positionals.length < command.min || positionals.length > command.max)) {
    throw new UsageError(`${name}: ${command.max === 0 ? 'takes no arguments' : `expected ${command.min === command.max ? command.min : `${command.min} or more`} argument${command.max === 1 ? '' : 's'}`}\nusage: clawnet ${command.usage ?? name}`);
  }
  return { name, command, values, args: positionals };
}

function safeParse(args, options, allowPositionals) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (error) {
    throw new UsageError(error.message.replace(/\. To specify a positional argument starting with a '-'.*$/, ''));
  }
}

/**
 * Run the command line.
 *
 * @param {string[]} argv arguments after the program name
 * @param {object} [io] see `processIo`
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = processIo()) {
  try {
    const parsed = parseCommandLine(argv);
    if (parsed.values.version === true) {
      io.stdout.write(`${DEFAULT_AGENT}
`);
      return ExitCode.OK;
    }
    if (parsed.name === null || parsed.name === 'help' || parsed.values.help === true) {
      const target = parsed.name === 'help' ? parsed.args[0] : parsed.name;
      const command = target === undefined || target === null ? undefined : findCommand(target);
      if (target !== undefined && target !== null && command === undefined) throw new UsageError(`unknown command "${target}"`);
      io.stdout.write(command === undefined ? helpText() : commandHelp(target, command));
      return parsed.name === null && parsed.values.help !== true ? ExitCode.USAGE : ExitCode.OK;
    }
    const { command, values, args } = parsed;
    const dataDir = resolveDataDir({ explicit: values['data-dir'], env: io.env });
    let client = null;
    const context = {
      io,
      values,
      args,
      json: values.json === true,
      dataDir,
      async client() {
        client ??= await ApiClient.fromDataDir(dataDir);
        return client;
      },
    };
    return (await command.run(context)) ?? ExitCode.OK;
  } catch (error) {
    return report(error, io);
  }
}

/** Print a failure for people: one line, no stack, unless debugging is asked for. */
function report(error, io) {
  if (error instanceof UsageError) {
    io.stderr.write(`clawnet: ${error.message}\nTry "clawnet help".\n`);
    return error.exitCode;
  }
  if (error instanceof CliError) {
    io.stderr.write(`clawnet: ${error.message}\n`);
    return error.exitCode;
  }
  if (typeof error?.code === 'string' && error.code.startsWith('ERR_') && typeof error.message === 'string') {
    io.stderr.write(`clawnet: ${error.message}\n`);
    if (io.env.CLAWNET_DEBUG === '1') io.stderr.write(`${error.stack}\n`);
    return ExitCode.FAILURE;
  }
  io.stderr.write(`clawnet: unexpected error: ${error?.message ?? error}\n`);
  if (io.env.CLAWNET_DEBUG === '1') io.stderr.write(`${error?.stack}\n`);
  return ExitCode.FAILURE;
}
