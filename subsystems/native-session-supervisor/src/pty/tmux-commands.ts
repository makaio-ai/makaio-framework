/**
 * Bounded tmux CLI invocation with a classified outcome.
 *
 * Every tmux call this backend makes is synchronous, so an unresponsive `tmux`
 * blocks the event loop rather than merely the caller. Each invocation is
 * therefore bounded by an explicit timeout, and the timeout expiry is one of the
 * outcomes callers can read.
 *
 * The classification exists because collapsing every failure to "no output"
 * makes two very different facts indistinguishable: *the server told us the
 * session is gone* and *we never reached a server*. Only the first is evidence
 * that a session ended; treating the second as the same thing manufactures an
 * end that nobody observed.
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';

/**
 * Default milliseconds any single tmux invocation may block for.
 *
 * This is the subsystem's own safety bound, not any caller's policy budget: it
 * exists so a wedged `tmux` cannot hold the event loop indefinitely. Callers
 * that own a tighter budget pass it in and their value wins.
 */
export const DEFAULT_TMUX_COMMAND_TIMEOUT_MS = 5_000;

/**
 * What happened when a tmux command was run.
 *
 * The three failure shapes are kept apart because they answer different
 * questions about the target's existence.
 */
export type TmuxCommandOutcome =
  /** The command ran and succeeded; `stdout` is its trimmed output. */
  | { readonly kind: 'answered'; readonly stdout: string }
  /**
   * The command reached a live tmux server and the server reported that the
   * target does not exist. Absence is **proven** by the party that would know.
   */
  | { readonly kind: 'answered-negative' }
  /**
   * The command reached a live tmux server and failed for some other reason.
   * The target may well still exist, so nothing about its lifetime is known.
   */
  | { readonly kind: 'answered-other-error' }
  /**
   * Nothing was asked: the socket was absent, the executable could not be run,
   * the spawn failed, or the call hit its timeout. A missing server does not
   * prove a pane's process died — tmux hangs up on its panes, but a process can
   * survive that — so this says nothing at all.
   */
  | { readonly kind: 'unanswerable' };

/**
 * tmux's reply when a live server cannot resolve the requested target.
 *
 * tmux reports the most specific level it failed to resolve, so a session
 * target can come back as a missing window or pane depending on the subcommand.
 */
const TMUX_TARGET_ABSENT_RE = /can't find (?:session|window|pane)/i;

/**
 * tmux's reply when no server is listening on the requested socket.
 *
 * Deliberately classified as *unanswerable* rather than as proven absence: the
 * message is produced by the tmux client, not by a server that inspected its
 * sessions.
 */
const TMUX_NO_SERVER_RE = /no server running on|error connecting to/i;

/**
 * Read the stderr text off a failed `execFileSync` rejection.
 * @param error - Value thrown by `execFileSync`.
 * @returns Captured stderr, or an empty string when none was captured.
 */
function readStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const { stderr } = error as { stderr?: unknown };
  if (typeof stderr === 'string') return stderr;
  if (stderr instanceof Buffer) return stderr.toString('utf8');
  return '';
}

/**
 * Whether a failed invocation actually reached the tmux process.
 *
 * `execFileSync` reports a numeric `status` only when the child ran and exited
 * on its own. A spawn failure and a timeout both leave it `null`, which is
 * exactly the "nothing was asked" case.
 * @param error - Value thrown by `execFileSync`.
 * @returns `true` when tmux ran and produced an exit status.
 */
function commandProducedExitStatus(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status } = error as { status?: unknown };
  return typeof status === 'number';
}

/**
 * Classify a failed tmux invocation into one of the three failure outcomes.
 * @param error - Value thrown by `execFileSync`.
 * @returns The failure outcome describing what, if anything, was learned.
 */
function classifyFailure(error: unknown): TmuxCommandOutcome {
  if (!commandProducedExitStatus(error)) {
    return { kind: 'unanswerable' };
  }

  const stderr = readStderr(error);
  // Order matters: a missing server also fails to find the target, but nothing
  // inspected the server's session list, so it must not read as proven absence.
  if (TMUX_NO_SERVER_RE.test(stderr)) {
    return { kind: 'unanswerable' };
  }
  if (TMUX_TARGET_ABSENT_RE.test(stderr)) {
    return { kind: 'answered-negative' };
  }
  return { kind: 'answered-other-error' };
}

/**
 * Run a tmux command on the given server and classify the result.
 *
 * Arguments are passed as an array so they are never interpolated through a
 * shell. The timeout bounds how long the call may block; it does not make the
 * call event-loop-responsive, because a synchronous child process cannot be
 * interrupted by a concurrent timer.
 * @param serverName - Tmux server socket name (passed as `-L <serverName>`).
 * @param args - Remaining tmux subcommand and arguments.
 * @param timeoutMs - Milliseconds this invocation may block before it is killed.
 * @returns The classified outcome of the invocation.
 */
export function runTmuxCommand(serverName: string, args: string[], timeoutMs: number): TmuxCommandOutcome {
  try {
    const stdout = execFileSync('tmux', ['-L', serverName, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { kind: 'answered', stdout: stdout.trim() };
  } catch (error) {
    return classifyFailure(error);
  }
}

/**
 * Run a tmux command, throwing when it does not succeed.
 *
 * Used by the call sites whose failure is a genuine operational error rather
 * than a statement about a session's existence.
 * @param serverName - Tmux server socket name (passed as `-L <serverName>`).
 * @param args - Remaining tmux subcommand and arguments.
 * @param timeoutMs - Milliseconds this invocation may block before it is killed.
 * @returns Trimmed stdout string (may be empty).
 * @throws If tmux could not be run, timed out, or exited non-zero.
 */
export function tmuxExec(serverName: string, args: string[], timeoutMs: number): string {
  const output = execFileSync('tmux', ['-L', serverName, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
  return output.trim();
}

/**
 * Run a tmux command, returning the raw (untrimmed) stdout string.
 *
 * Used for `capture-pane`, where trailing newlines are significant for
 * incremental diffing. Output content carries no existence claim, so a failure
 * collapses to `null` here without losing information a caller could act on.
 * @param serverName - Tmux server socket name.
 * @param args - Remaining tmux subcommand and arguments.
 * @param timeoutMs - Milliseconds this invocation may block before it is killed.
 * @returns Raw stdout string, or `null` if the command did not succeed.
 */
export function tmuxCapture(serverName: string, args: string[], timeoutMs: number): string | null {
  try {
    return execFileSync('tmux', ['-L', serverName, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
}
