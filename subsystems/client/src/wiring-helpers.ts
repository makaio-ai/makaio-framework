/**
 * Shared wiring helper utilities for client hook command construction.
 *
 * These pure functions encode the two patterns that are identical across every
 * client wiring module:
 *
 * 1. {@link buildClientCommand} — build a shell-safe client command string.
 *
 * 2. {@link buildHookCommand} — build the full hook command string for a single
 *    session-event wiring entry: `<makaioCommand> <sentinel> <eventName>`.
 *
 * 3. {@link deriveSessionEventDescriptors} — filter a client definition's
 *    `hookEvents` array down to the events that have a `frameworkSubject` and
 *    return them as `{ eventName }` descriptors, which is the form consumed by
 *    the per-client `buildWiringList`, `applyWiring`, and `removeWiring`
 *    functions.
 *
 * Both helpers are framework-boundary safe: they depend only on
 * `@makaio/contracts` types and have no host or client-specific imports.
 * @packageDocumentation
 */

import type { ClientDefinition } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal descriptor for a single session-event wiring entry.
 *
 * Produced by {@link deriveSessionEventDescriptors} and consumed by the
 * per-client `buildWiringList`, `applyWiring`, and `removeWiring` functions to
 * iterate over the events that need hook installation.
 */
export interface SessionEventDescriptor {
  /** Native event name as declared in the client definition (e.g. `'SessionStart'`). */
  readonly eventName: string;
  /**
   * Hook interaction mode for this event.
   *
   * - `'event'` — fire-and-forget: install `makaio hook received ...`
   * - `'request'` — request/response: install `makaio hook handle ...`
   */
  readonly mode: 'event' | 'request';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a shell-safe client command string from an executable and argv tokens.
 *
 * Native client settings store command strings rather than argv arrays, so the
 * executable and arguments must be rendered with shell quoting before they are
 * persisted.
 *
 * When `envPairs` is provided, each `KEY=value` string is prepended before the
 * executable as inline environment variable assignments — the standard POSIX
 * shell pattern for per-command env overrides.
 * @param makaioCommand - Makaio CLI binary name or absolute path.
 * @param args - Argument tokens appended after the Makaio command.
 * @param envPairs - Optional `KEY=value` pairs prepended before the executable.
 * @returns Shell-safe command string.
 */
export function buildClientCommand(
  makaioCommand: string,
  args: readonly string[],
  envPairs?: readonly string[],
): string {
  const tokens = [...(envPairs ?? []), makaioCommand, ...args];
  return tokens.map(renderShellArg).join(' ');
}

/**
 * Build the full hook command string for a single session-event wiring entry.
 *
 * The resulting command takes the form:
 * `[envPairs...] <makaioCommand> <sentinel> <eventName>`
 *
 * For example, given `'makaio'`, `'hook received claude-code'`, `'SessionStart'`
 * the function returns `'makaio hook received claude-code SessionStart'`.
 * @param makaioCommand - Makaio CLI binary name or path (e.g. `'makaio'`).
 * @param sentinel - Client-specific sentinel string embedded in every Makaio
 *   hook command (e.g. `'hook received claude-code'`).
 * @param eventName - Native hook event name (e.g. `'SessionStart'`).
 * @param envPairs - Optional `KEY=value` pairs prepended before the executable.
 * @param rootFlags - Optional root-level CLI flags inserted between the
 *   executable and the sentinel (e.g. `['--debounce-failure']`).
 * @returns Full hook command string to write into the client's native config.
 */
export function buildHookCommand(
  makaioCommand: string,
  sentinel: string,
  eventName: string,
  envPairs?: readonly string[],
  rootFlags?: readonly string[],
): string {
  return buildClientCommand(makaioCommand, [...(rootFlags ?? []), ...sentinel.split(' '), eventName], envPairs);
}

/**
 * Derive the ordered list of session-event wiring descriptors from a client
 * definition.
 *
 * Only hook events that carry a `frameworkSubject` are included — events
 * without one are client-internal and do not need framework wiring.
 * @param clientDefinition - The parsed static client definition whose
 *   `runtimeCapabilities.hookEvents` array is the source of truth.
 * @returns Read-only array of `{ eventName, mode }` descriptors in declaration order.
 */
export function deriveSessionEventDescriptors(
  clientDefinition: ClientDefinition,
): ReadonlyArray<SessionEventDescriptor> {
  return clientDefinition.runtimeCapabilities.hookEvents
    .filter((e) => e.frameworkSubject !== undefined)
    .map((e) => ({ eventName: e.name, mode: e.mode }));
}

/**
 * Render one shell command argument.
 *
 * Client configs store command strings, not argv arrays. Keep common executable
 * names readable while quoting paths or values that a shell would otherwise
 * split or expand.
 * @param value - Argument value to render
 * @returns Shell-safe argument token
 */
function renderShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
