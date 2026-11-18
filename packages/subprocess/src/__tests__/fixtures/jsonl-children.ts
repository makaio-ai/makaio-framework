/**
 * Child scripts for real-process transport tests, run with `node -e`, and the
 * helpers those tests use to probe, deny and clean up real processes.
 *
 * Every script that reports a descendant writes `{"grandchild": <pid>}` as its
 * first stdout line, so a test can check that descendant afterwards and clean
 * it up. Writes that must reach the pipe before the child exits use the write
 * callback: stdout to a pipe is asynchronous on some hosts.
 */
import type { ProcessSignalPort } from '../../process-tree.js';

/**
 * Build a statement that spawns a long-running grandchild with the given stdio.
 * @param stdio - JSON of the grandchild's `stdio` option.
 * @returns Script source that leaves the grandchild in the variable `grandchild`.
 */
function spawnSleepingGrandchild(stdio: string): string {
  return `
const grandchild = require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: ${stdio} },
);
grandchild.unref();`;
}

/** Writes one message and stays alive. */
export const READY_AND_STAY = `
process.stdout.write('{"ready":true}\\n');
setInterval(() => {}, 1000);
`;

/** Writes one message and exits cleanly as soon as it reached the pipe. */
export const LAST_MESSAGE_THEN_EXIT = `
process.stdout.write('{"last":true}\\n', () => process.exit(0));
`;

/**
 * Leaves a grandchild holding stdout, reports it, writes an unterminated rest
 * and exits cleanly: stdout never reaches its end while the grandchild lives.
 */
export const GRANDCHILD_HOLDS_STDOUT = `
${spawnSleepingGrandchild("['ignore', 'inherit', 'ignore']")}
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\npartial', () => process.exit(0));
`;

/** Leaves a grandchild holding only stderr, reports it and exits cleanly. */
export const GRANDCHILD_HOLDS_STDERR = `
${spawnSleepingGrandchild("['ignore', 'ignore', 'inherit']")}
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n', () => process.exit(0));
`;

/** Starts a grandchild that holds no stdio, reports it and stays alive. */
export const GRANDCHILD_AND_STAY = `
${spawnSleepingGrandchild("'ignore'")}
process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n');
setInterval(() => {}, 1000);
`;

/** Closes its stdout and keeps running. */
export const CLOSE_STDOUT_AND_STAY = `
require('node:fs').closeSync(1);
setInterval(() => {}, 1000);
`;

/** Closes its stdin, reports that it did, and keeps running. */
export const CLOSE_STDIN_AND_STAY = `
require('node:fs').closeSync(0);
process.stdout.write('{"stdinClosed":true}\\n');
setInterval(() => {}, 1000);
`;

/**
 * Starts a grandchild that ignores SIGTERM and holds no stdio of the child,
 * reports it once the grandchild installed its handler, and stays alive. The
 * child itself still dies on SIGTERM, like a launcher in front of a stubborn
 * process.
 */
export const GRANDCHILD_IGNORES_SIGTERM = `
const grandchild = require('node:child_process').spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000);"],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
grandchild.unref();
grandchild.stdout.once('data', () => {
  grandchild.stdout.destroy();
  process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n');
});
setInterval(() => {}, 1000);
`;

/** Ignores SIGTERM, reports readiness and stays alive. */
export const IGNORE_SIGTERM_AND_STAY = `
process.on('SIGTERM', () => {});
process.stdout.write('{"ready":true}\\n');
setInterval(() => {}, 1000);
`;

/**
 * Report whether a process still exists.
 * @param pid - Process to probe.
 * @returns `false` once the process is gone.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * Kill a process a test left behind, ignoring one that is already gone.
 * @param pid - Process to kill.
 */
export function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Build a signal port that refuses real signals with `EPERM` while still
 * answering existence probes truthfully.
 * @param denies - Whether a signal is refused right now; refuses every signal by default.
 * @returns The denying port.
 */
export function denyingPort(denies: () => boolean = () => true): ProcessSignalPort {
  return {
    kill: (pid, signal) => {
      if (signal !== 0 && denies()) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      process.kill(pid, signal);
    },
  };
}
