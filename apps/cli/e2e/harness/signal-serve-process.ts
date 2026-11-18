/**
 * Process harness for the serve signal-handling E2E tests.
 *
 * Starts the `serve-signal-entry.ts` fixture as an isolated child process whose
 * PID is the host's own (not a wrapper that relays signals), so a test can
 * deliver real OS signals to the host exactly as a terminal or a supervisor
 * would, and tracks every PID the fixture's children record so that nothing
 * outlives a test.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';
import { createOutputCapture } from '../../../../e2e/shared/spawn-helpers.js';
import { killQuietly, waitUntil } from '../../../../e2e/shared/process-probe.js';
import { CHILD_PID_FILE_ENV } from './serve-signal-env.js';
import { isolatedServeEnv } from './spawn-serve.js';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveWorkspaceRoot(path.resolve(HARNESS_DIR, '../..'));
const ENTRY = path.resolve(HARNESS_DIR, 'serve-signal-entry.ts');

/** How a host process ended. */
export interface HostExit {
  /** Exit code, or `null` when a signal ended the process. */
  readonly code: number | null;
  /** Terminating signal, or `null` when the process exited by itself. */
  readonly signal: NodeJS.Signals | null;
}

/** Options of {@link startSignalServe}. */
export interface SignalServeOptions {
  /** Extra `serve` arguments, e.g. `--ignore-hangup`. */
  readonly args?: readonly string[];
  /** Fixture environment variables (see `serve-signal-entry.ts`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Start the host with `SIGHUP` ignored, as `nohup` does. */
  readonly launchIgnoringHangup?: boolean;
}

/** A running serve host under test. */
export interface SignalServeHost {
  /** PID of the host process itself. */
  readonly pid: number;
  /** Everything the host wrote to stdout and stderr so far (the most recent 128 000 characters). */
  output(): string;
  /**
   * Wait until the output matches.
   * @param matcher - Text or pattern to look for.
   * @param timeoutMs - How long to wait.
   * @returns Resolves once the output matches; rejects with the output on timeout or when the host ended first.
   */
  waitForOutput(matcher: string | RegExp, timeoutMs: number): Promise<void>;
  /** Resolves with how the host ended, once its output is complete. */
  readonly exited: Promise<HostExit>;
  /** Whether the host has ended. */
  hasExited(): boolean;
  /**
   * Deliver a real OS signal to the host.
   * @param signal - Signal to send.
   */
  signal(signal: NodeJS.Signals): void;
  /** PIDs the fixture children recorded. */
  childPids(): number[];
  /**
   * Wait for the fixture child to record its PID.
   * @param timeoutMs - How long to wait.
   * @returns The PID of the first recorded child.
   */
  waitForChildPid(timeoutMs: number): Promise<number>;
  /** Kill the host and every recorded child, then remove the temporary files. Safe to call repeatedly. */
  dispose(): Promise<void>;
}

/**
 * Start the serve fixture as an isolated host process.
 * @param options - Arguments, fixture environment and launch mode.
 * @returns The running host.
 */
export function startSignalServe(options: SignalServeOptions = {}): SignalServeHost {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-serve-signals-'));
  const pidFile = path.join(tempDir, 'children.pids');
  fs.writeFileSync(pidFile, '');

  const { env, homeDir } = isolatedServeEnv(tempDir, { [CHILD_PID_FILE_ENV]: pidFile, ...options.env });
  fs.mkdirSync(homeDir, { recursive: true });
  const entryArgs = ['--import', 'tsx', ENTRY, ...(options.args ?? [])];
  // `exec` keeps the host's PID; the ignored disposition is inherited across it.
  const [command, args] = options.launchIgnoringHangup
    ? (['/bin/sh', ['-c', 'trap "" HUP; exec "$0" "$@"', process.execPath, ...entryArgs]] as const)
    : ([process.execPath, entryArgs] as const);
  const child: ChildProcess = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (pid === undefined) throw new Error('Failed to spawn the serve fixture');

  const capture = createOutputCapture('serve-signals');
  child.stdout?.on('data', capture.append);
  child.stderr?.on('data', capture.append);

  // `close`, not `exit`: it comes after the last output was read, so a test
  // that reads the output once the host has ended sees all of it.
  const exited = new Promise<HostExit>((resolve) => {
    child.once('close', (code, signal) => {
      capture.rejectPending((matcher, output) => {
        return new Error(`The host ended before its output matched ${String(matcher)}. Output:\n${output}`);
      });
      resolve({ code, signal });
    });
  });

  const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const childPids = (): number[] =>
    fs
      .readFileSync(pidFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);

  return {
    pid,
    output: capture.get,
    async waitForOutput(matcher, timeoutMs) {
      await capture.waitFor(matcher, timeoutMs);
    },
    exited,
    hasExited,
    signal(signal) {
      process.kill(pid, signal);
    },
    childPids,
    async waitForChildPid(timeoutMs) {
      await waitUntil(() => childPids().length > 0, timeoutMs, 'the fixture child to record its PID');
      const [first] = childPids();
      if (first === undefined) throw new Error('The PID file lost its entry');
      return first;
    },
    async dispose() {
      if (!hasExited()) child.kill('SIGKILL');
      for (const childPid of childPids()) killQuietly(childPid);
      await exited;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
