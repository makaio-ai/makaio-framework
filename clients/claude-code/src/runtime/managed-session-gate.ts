import { ClientSubjects } from '@makaio/subsystem-client';
import { type ClaudeCodeNormalizedEvent, type ClaudeCodeNormalizedSubject } from './hook-normalizer.js';

/**
 * Type-level narrowing helper for switch-case dispatch in
 * {@link ClaudeCodeClientService.emitNormalizedEvent}: extracts the specific
 * event type whose subject matches the given subject constant.
 *
 * The TS compiler does not narrow SubjectDefinition object discriminants in
 * switch cases, so the cast must be explicit; this alias centralises the
 * pattern so each case site is one line.
 */
export type NarrowedEvent<S extends ClaudeCodeNormalizedSubject> = Extract<ClaudeCodeNormalizedEvent, { subject: S }>;

/**
 * Subjects emitted by the `claude-agent-sdk` adapter for managed sessions
 * (see `adapters/implementations/claude-agent-sdk/src/agent.ts`
 * lines 108, 117, 125, 134 — emits `session.started`, `turn.started`,
 * `turn.completed`, `userPrompt.submitted` via `wireClientSessionObservations`).
 *
 * When a native hook payload's `adapterSessionId` is recorded as belonging
 * to an adapter-managed runtime, events whose subject appears in this set are
 * suppressed so downstream consumers receive exactly one event per session
 * lifecycle signal.  Subjects absent from the set — `tool.pre`, `tool.post`,
 * `subagent.started`, `subagent.completed`, `compaction.pre` — have no
 * adapter-path equivalent and are forwarded unconditionally.
 *
 * `session.started` is in this set (the adapter emits it once at thread start),
 * but the gate exempts it when `startMode` is `'compact'` or `'clear'`.
 * The reason: the adapter emits `session.started` only once — at thread start,
 * without a `startMode` — and never again for compaction or clear restarts.
 * Those transitions happen inside the running thread, so the hook-derived
 * `session.started{startMode:'compact'|'clear'}` is the sole signal for them
 * and must always be forwarded even for adapter-managed sessions.
 */
export const ADAPTER_EMITTED_SUBJECTS: ReadonlySet<ClaudeCodeNormalizedSubject> = new Set([
  ClientSubjects.session.started,
  ClientSubjects.session.turn.started,
  ClientSubjects.session.turn.completed,
  ClientSubjects.session.userPrompt.submitted,
]);

/**
 * Returns true when a normalized event should be suppressed by the
 * adapter-managed gate — that is, when the session is adapter-managed AND the
 * subject is one the adapter emits AND the event is not a compaction or clear
 * restart start (which have no adapter counterpart and must always be forwarded).
 * @param normalized - Normalized hook event to evaluate
 * @param isManaged - Whether the originating session is adapter-managed
 * @returns True when the event should be dropped from the native-hook path
 */
export function shouldSuppressForManagedSession(normalized: ClaudeCodeNormalizedEvent, isManaged: boolean): boolean {
  if (!isManaged || !ADAPTER_EMITTED_SUBJECTS.has(normalized.subject)) return false;
  if (normalized.subject !== ClientSubjects.session.started) return true;
  const { startMode } = normalized.payload as { startMode?: string };
  return startMode !== 'compact' && startMode !== 'clear';
}
