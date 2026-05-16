import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { EventHandler } from '@makaio/core';

// ---------------------------------------------------------------------------
// Hook Types
// ---------------------------------------------------------------------------

/**
 * Claude Agent SDK hook event names that map to Makaio bus subjects.
 *
 * `SubagentStart` and `SubagentStop` are intentionally omitted — they are
 * not available in the SDK context.
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'Notification';

/**
 * Normalised event data delivered to hook callbacks.
 *
 * The `payload` field contains the raw bus event payload so that callers can
 * inspect subject-specific fields without the SDK having to re-type every
 * possible bus schema.
 */
export interface HookEventData {
  /** The Claude SDK hook event name that triggered this callback. */
  readonly type: HookEvent;
  /** Makaio session ID, when present on the bus payload. */
  readonly sessionId?: string;
  /** Makaio agent ID, when present on the bus payload. */
  readonly agentId?: string;
  /** Raw bus event payload. */
  readonly payload: Record<string, unknown>;
}

/**
 * Callback invoked when a hook event fires.
 *
 * May be synchronous or return a Promise. Returned Promises are not awaited
 * by the bus handler — any rejection is caught and logged, so async callbacks
 * do not block or fail the event dispatch.
 * @param event - Normalised hook event data.
 */
export type HookCallback = (event: HookEventData) => void | Promise<void>;

/**
 * Map of Claude SDK hook event names to one or more callbacks.
 *
 * Unknown keys are silently ignored — this allows callers to register future
 * hook names without the SDK rejecting the config.
 */
export interface HookConfig {
  readonly [event: string]: HookCallback | readonly HookCallback[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a callback entry to a flat array.
 * @param entry - A single callback or an array of callbacks.
 * @returns Always an array.
 */
const toCallbackArray = (entry: HookCallback | readonly HookCallback[]): readonly HookCallback[] =>
  Array.isArray(entry) ? entry : [entry as HookCallback];

/**
 * Build a bus event handler that maps the raw context payload to
 * {@link HookEventData} and invokes each registered callback.
 *
 * The handler is intentionally fire-and-forget from the bus perspective:
 * callback rejections are logged but do not propagate to the bus.
 * @param type - The SDK hook event name to embed in the event data.
 * @param callbacks - Callbacks to invoke.
 * @returns A bus-compatible event handler.
 */
const makeHandler =
  (type: HookEvent, callbacks: readonly HookCallback[]): EventHandler<Record<string, unknown>> =>
  (ctx): void => {
    const { payload } = ctx;
    const eventData: HookEventData = {
      type,
      sessionId: typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined,
      agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : undefined,
      payload,
    };

    for (const cb of callbacks) {
      Promise.resolve(cb(eventData)).catch((err: unknown) => {
        console.error(`[agent-sdk] Hook callback error for "${type}":`, err);
      });
    }
  };

// ---------------------------------------------------------------------------
// Subject map
// ---------------------------------------------------------------------------

/**
 * Mapping from Claude SDK hook event names to the corresponding bus subjects.
 *
 * Hook events with no Makaio bus equivalent are absent from this map and
 * will be silently ignored by {@link registerHooks}.
 */
const HOOK_SUBJECT_MAP = {
  PreToolUse: AgentSubjects.tool.use,
  PostToolUse: AgentSubjects.tool.completed,
  SessionStart: AgentSubjects.started,
  SessionEnd: AgentSubjects.complete,
  Stop: AgentSubjects.complete,
  Notification: AgentSubjects.message,
} as const satisfies Partial<Record<HookEvent, unknown>>;

type HookSubject = (typeof HOOK_SUBJECT_MAP)[keyof typeof HOOK_SUBJECT_MAP];

/**
 * Subscribe a hook handler to one of the event subjects in {@link HOOK_SUBJECT_MAP}.
 *
 * Hook handlers are subject-agnostic by design: they only read common event
 * payload fields (`sessionId`, `agentId`) and retain the raw payload for caller
 * inspection, so one factory can safely serve every mapped hook event.
 * @param bus - The Makaio bus instance to subscribe on.
 * @param subject - Hook-mapped event subject.
 * @param handler - Subject-agnostic hook event handler.
 * @param filter - Session filter for the subscription.
 * @returns Cleanup function that removes the subscription.
 */
const subscribeHookSubject = <Subject extends HookSubject>(
  bus: IMakaioBus,
  subject: Subject,
  handler: EventHandler<Record<string, unknown>>,
  filter: { sessionId: string },
): (() => void) => bus.on(subject as never, handler as never, { filter });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register Claude SDK hook callbacks as bus event subscriptions.
 *
 * For each hook event in `hooks` that has a Makaio bus equivalent, this
 * function registers a `bus.on()` handler filtered to the given `sessionId`.
 * Hook events without a bus equivalent (e.g. future names) are silently
 * ignored.
 *
 * `SessionEnd` and `Stop` both map to `agent.complete` — if both are
 * present in the config, both callback sets are independently subscribed to
 * the same subject.
 *
 * The returned cleanup function unsubscribes all registered handlers in a
 * single call.
 * @param bus - The Makaio bus instance to subscribe on.
 * @param sessionId - Session ID used to filter bus events.
 * @param hooks - Map of hook event names to callbacks.
 * @returns A cleanup function that removes all registered subscriptions.
 */
export function registerHooks(bus: IMakaioBus, sessionId: string, hooks: HookConfig): () => void {
  const filter = { sessionId };
  const unsubscribers: Array<() => void> = [];

  for (const [eventName, callbackEntry] of Object.entries(hooks)) {
    if (!Object.hasOwn(HOOK_SUBJECT_MAP, eventName)) {
      // No bus equivalent — silently ignore.
      continue;
    }

    const hookEvent = eventName as keyof typeof HOOK_SUBJECT_MAP;
    const subject = HOOK_SUBJECT_MAP[hookEvent];
    const callbacks = toCallbackArray(callbackEntry);

    if (callbacks.length === 0) continue;

    const handler = makeHandler(hookEvent, callbacks);
    unsubscribers.push(subscribeHookSubject(bus, subject, handler, filter));
  }

  return () => {
    for (const unsub of unsubscribers) unsub();
  };
}
