/**
 * POSIX shell script template for native Git hook wrappers.
 *
 * Each wrapper script:
 * 1. Optionally chains to the pre-existing hook (backed up on install).
 * 2. Synchronously forwards the event to the Makaio receiver binary with a
 *    tight fail-open delivery budget.
 * 3. Exits with the pre-existing hook's exit code so Git semantics are preserved.
 *
 * The wrapper is deliberately defensive: it uses `set +e` to avoid aborting
 * on unset variables, captures stdin to a temp file so both the original hook
 * and the receiver can consume it, and ignores receiver failures or timeouts.
 * @packageDocumentation
 */

import type { GitHookName } from './hook-state.js';

/**
 * Options for rendering a hook wrapper script.
 */
export interface WrapperTemplateOptions {
  /** The Git hook name this wrapper handles (e.g. `'post-commit'`). */
  readonly hookName: GitHookName;
  /**
   * Absolute path to the install state file.
   *
   * Passed to the receiver binary via `--state` so it can read the receiver
   * command from a stable location without embedding it in the wrapper.
   */
  readonly stateFile: string;
  /**
   * Absolute path to the backed-up pre-existing hook, when one existed.
   *
   * When `undefined`, the wrapper skips the original-hook chain step.
   */
  readonly originalHook: string | undefined;
  /**
   * Receiver command and any fixed arguments (e.g. `['/usr/local/bin/makaio-git-hook-receiver']`).
   *
   * Shell-quoted before insertion into the wrapper so spaces in paths are safe.
   */
  readonly receiverCommand: readonly string[];
  /**
   * Maximum receiver delivery time before the wrapper fails open.
   *
   * Defaults to two seconds for installed hooks.
   */
  readonly receiverTimeoutSeconds?: number;
}

/**
 * Render a POSIX-compatible shell wrapper for a native Git hook.
 *
 * The rendered script captures stdin, chains to any pre-existing hook, and
 * calls the Makaio receiver on a bounded fail-open path. Receiver failures are
 * silenced so they cannot fail Git operations.
 * @param options - Wrapper rendering options.
 * @returns POSIX shell script text for the hook wrapper.
 */
export function renderHookWrapper(options: WrapperTemplateOptions): string {
  const receiver = options.receiverCommand.map(shellQuote).join(' ');
  const original = options.originalHook ? shellQuote(options.originalHook) : '';
  const receiverTimeoutSeconds = options.receiverTimeoutSeconds ?? 2;
  if (!Number.isSafeInteger(receiverTimeoutSeconds) || receiverTimeoutSeconds < 1) {
    throw new Error('[git-hooks] Receiver timeout must be a positive integer number of seconds.');
  }
  return `#!/bin/sh
# makaio git-hooks wrapper - ${options.hookName}
set +e
HOOK_NAME=${shellQuote(options.hookName)}
STATE_FILE=${shellQuote(options.stateFile)}
ORIGINAL_HOOK=${original}
RECEIVER_TIMEOUT_SECONDS=${receiverTimeoutSeconds}
RECEIVER_KILL_GRACE_SECONDS=1
TMP_STDIN="$(mktemp "\${TMPDIR:-/tmp}/makaio-git-hook.XXXXXX")" || exit 0
trap 'rm -f "$TMP_STDIN"' EXIT HUP INT TERM
cat > "$TMP_STDIN" || true
ORIGINAL_EXIT=0
if [ -n "$ORIGINAL_HOOK" ] && [ -x "$ORIGINAL_HOOK" ]; then
  "$ORIGINAL_HOOK" "$@" < "$TMP_STDIN"
  ORIGINAL_EXIT=$?
fi
(
  ${receiver} --event "$HOOK_NAME" --state "$STATE_FILE" -- "$@" < "$TMP_STDIN" >/dev/null 2>&1 &
  RECEIVER_PID=$!
  (
    WATCHDOG_SLEEP_PID=
    stop_watchdog_sleep() {
      if [ -n "$WATCHDOG_SLEEP_PID" ]; then
        kill "$WATCHDOG_SLEEP_PID" 2>/dev/null || true
        WATCHDOG_SLEEP_PID=
      fi
    }
    trap 'stop_watchdog_sleep' EXIT HUP INT TERM
    sleep "$RECEIVER_TIMEOUT_SECONDS" &
    WATCHDOG_SLEEP_PID=$!
    wait "$WATCHDOG_SLEEP_PID" 2>/dev/null || exit 0
    WATCHDOG_SLEEP_PID=
    kill "$RECEIVER_PID" 2>/dev/null || true
    sleep "$RECEIVER_KILL_GRACE_SECONDS" &
    WATCHDOG_SLEEP_PID=$!
    wait "$WATCHDOG_SLEEP_PID" 2>/dev/null || exit 0
    WATCHDOG_SLEEP_PID=
    kill -KILL "$RECEIVER_PID" 2>/dev/null || true
  ) </dev/null >/dev/null 2>&1 &
  RECEIVER_WATCHDOG_PID=$!
  wait "$RECEIVER_PID" 2>/dev/null
  RECEIVER_STATUS=$?
  kill "$RECEIVER_WATCHDOG_PID" 2>/dev/null || true
  wait "$RECEIVER_WATCHDOG_PID" 2>/dev/null || true
  exit "$RECEIVER_STATUS"
) || true
exit "$ORIGINAL_EXIT"
`;
}

/**
 * Quote a string for safe embedding in a POSIX shell script.
 *
 * Uses single-quote wrapping with `'\''` escaping for embedded single quotes.
 * @param value - String value to quote.
 * @returns Shell-safe single-quoted string.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
