import type { z } from 'zod';
import type {
  MakaioSessionSchema,
  MakaioSessionAgentSchema,
  MakaioSessionEventSchema,
  SessionPreviewDataSchema,
  SessionWithPreviewSchema,
} from './schemas.js';
import { SESSION_EVENT_TYPES } from './schemas/event.js';
import type { SessionEventEnvelopeSchema, SessionEventTypeMap } from './schemas/event.js';

/**
 * A makaio orchestration session.
 *
 * Represents a logical conversation context that may span multiple agents
 * and adapters over time. Sessions track which agents have participated
 * and the overall lifecycle state.
 *
 * Declared as an `interface` (rather than a plain `type` alias) to allow
 * host-tier code to add host-owned fields via TypeScript declaration
 * merging without touching framework source. Host consumers augment this
 * interface inside a `declare module '@makaio/contracts'` block.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, import/namespace -- Intentional seam for declaration merging; z.infer is a TypeScript type utility, not a runtime member
export interface IMakaioSession extends z.infer<typeof MakaioSessionSchema> {}

/**
 * Preview data for session list display.
 * Only populated when includePreview: true is passed to list.
 */
export type SessionPreviewData = z.infer<typeof SessionPreviewDataSchema>;

/**
 * Session with optional preview data for list display.
 */
export type SessionWithPreview = z.infer<typeof SessionWithPreviewSchema>;

/**
 * An agent attached to a makaio session.
 *
 * Records which adapter instance and agent execution unit participated
 * in a session, along with when they were added.
 */
export type MakaioSessionAgent = z.infer<typeof MakaioSessionAgentSchema>;

/**
 * A persisted session event — Zod-inferred type from {@link MakaioSessionEventSchema}.
 *
 * This is the type returned by storage handlers and bus responses. It includes
 * the plugin catch-all variant (`type: string, payload: Record<string, unknown>`)
 * which prevents TypeScript `switch` narrowing.
 *
 * For code that needs discriminated-union narrowing (switch/case on `event.type`),
 * use {@link isKnownSessionEvent} to guard into {@link KnownSessionEvent} first.
 * @see KnownSessionEvent — narrowable discriminated union
 * @see isKnownSessionEvent — type guard for narrowing
 */
export type MakaioSessionEvent = z.infer<typeof MakaioSessionEventSchema>;

/**
 * Base envelope fields shared by every persisted session event.
 */
type SessionEventBase = z.infer<typeof SessionEventEnvelopeSchema>;

/**
 * Core event type keys that {@link isKnownSessionEvent} can confirm at runtime.
 *
 * Extracted from the intersection of {@link SessionEventTypeMap} keys and the
 * compile-time literal union of {@link SESSION_EVENT_TYPES}, so this type stays
 * in sync with the runtime guard automatically. Plugin-augmented keys (added via
 * declaration merging) are intentionally excluded — the guard cannot confirm them
 * without a runtime registry.
 */
type RuntimeKnownSessionEventType = Extract<keyof SessionEventTypeMap, (typeof SESSION_EVENT_TYPES)[number]>;

/**
 * Narrowable discriminated union of **core** session event types.
 *
 * Scoped to `RuntimeKnownSessionEventType` so the union precisely matches
 * what {@link isKnownSessionEvent} can confirm at runtime. Every variant carries
 * a literal `type` and the exact `payload` shape, enabling exhaustive
 * `switch(event.type)` narrowing without casts:
 * @example
 * ```typescript
 * if (isKnownSessionEvent(event)) {
 *   switch (event.type) {
 *     case 'turn.completed':
 *       console.log(event.payload.turnId); // narrowed, no cast
 *       break;
 *   }
 * }
 * ```
 *
 * **Plugin events:** extensions extend {@link SessionEventTypeMap} via declaration
 * merging, but their keys are excluded from this union because the runtime guard
 * only checks `SESSION_EVENT_TYPES`. Plugin events pass through the Zod catch-all
 * branch and return `false` from `isKnownSessionEvent`.
 */
export type KnownSessionEvent = {
  [K in RuntimeKnownSessionEventType]: SessionEventBase & {
    type: K;
    payload: SessionEventTypeMap[K];
  };
}[RuntimeKnownSessionEventType];

/**
 * Type guard that narrows a {@link MakaioSessionEvent} to {@link KnownSessionEvent}.
 *
 * Safe at Zod parse boundaries because `MakaioSessionEventSchema` validates core
 * event types via `z.discriminatedUnion`. The catch-all `PluginSessionEventSchema`
 * is excluded by its own refine (rejects core types), so any event whose `type`
 * matches a core literal is guaranteed to have the matching payload shape.
 *
 * Note: this guard checks the core `SESSION_EVENT_TYPES` list only. Plugin event
 * types are not included — they pass through the catch-all branch and will return
 * `false` here. If runtime registration of plugin event types is needed, a
 * separate registry mechanism should be introduced.
 * @param event - Any Zod-validated session event
 * @returns `true` when `event.type` is a known core session event type
 */
export function isKnownSessionEvent(event: MakaioSessionEvent): event is KnownSessionEvent {
  return (SESSION_EVENT_TYPES as readonly string[]).includes(event.type);
}

// Re-export extensible types from event schema
export type { SessionEventType, SessionEventPayload, SessionEventTypeMap } from './schemas/event.js';
