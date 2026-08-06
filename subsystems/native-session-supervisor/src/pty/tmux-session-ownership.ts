/**
 * Ownership metadata for tmux sessions this subsystem creates, and the
 * stale-session cleanup that reads it.
 *
 * A named tmux server can outlive the runtime that populated it, so every
 * session created here carries two user options: a marker saying it is managed,
 * and the PID of the process that asked for it. Together they are what makes a
 * leftover session identifiable as *ours and abandoned* rather than as somebody
 * else's work to be destroyed.
 * @packageDocumentation
 */

import { probeProcessPresence } from './process-probe.js';
import { runTmuxCommand } from './tmux-commands.js';

/** tmux user option marking a session as created by this subsystem. */
export const MANAGED_SESSION_OPTION = '@makaio-managed';

/** tmux user option recording the PID that requested a managed session. */
export const OWNER_PID_OPTION = '@makaio-owner-pid';

/**
 * Parse a positive integer from tmux user-option output.
 * @param value - Raw tmux format value.
 * @returns Parsed positive integer, or `undefined` when invalid.
 */
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Check whether an owner process is still alive.
 *
 * Cleanup destroys a session, so it may only act on proven absence: a PID that
 * exists, or whose holder cannot be inspected, counts as alive here.
 * @param pid - Process identifier recorded in tmux metadata.
 * @returns `true` unless no process holds the PID any more.
 */
function isProcessAlive(pid: number): boolean {
  return probeProcessPresence(pid) !== 'absent';
}

/**
 * Remove stale Makaio-owned tmux sessions from a server.
 *
 * Only sessions carrying both the managed marker and an owner PID are eligible.
 * Unmarked user sessions and sessions owned by a live process are preserved.
 * @param serverName - Tmux server socket name.
 * @param commandTimeoutMs - Milliseconds each tmux invocation may block.
 */
export function cleanupStaleOwnedTmuxSessions(serverName: string, commandTimeoutMs: number): void {
  const listing = runTmuxCommand(
    serverName,
    ['list-sessions', '-F', `#{session_name}\t#{${MANAGED_SESSION_OPTION}}\t#{${OWNER_PID_OPTION}}`],
    commandTimeoutMs,
  );
  if (listing.kind !== 'answered' || listing.stdout === '') {
    return;
  }

  for (const line of listing.stdout.split('\n')) {
    const [sessionName, managedMarker, ownerPidRaw] = line.split('\t');
    if (!sessionName || managedMarker !== '1') {
      continue;
    }

    const ownerPid = parsePositiveInteger(ownerPidRaw);
    if (ownerPid === undefined || isProcessAlive(ownerPid)) {
      continue;
    }

    runTmuxCommand(serverName, ['kill-session', '-t', sessionName], commandTimeoutMs);
  }
}
