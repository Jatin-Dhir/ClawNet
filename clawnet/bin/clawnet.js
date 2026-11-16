#!/usr/bin/env node
/**
 * The `clawnet` executable. All of the work is in src/cli/main.js; this file only turns
 * its result into the process exit code.
 */

import { main } from '../src/cli/main.js';

// A reader that went away (`clawnet events | head`) is not an error worth a stack trace.
process.stdout.on('error', () => {});

const code = await main(process.argv.slice(2));
process.exitCode = code;
// Everything a command opened is closed by now; this only bounds a straggler (a socket
// still draining) so that a finished command never hangs the shell.
setTimeout(() => process.exit(code), 3000).unref();
