import { createBusNamespace, type EventMessagePayload, type SubjectDefinition, type SubjectRecord } from '@makaio/core';
import { InboundHookSourceSchema, RawInboundHookPayloadSchema, type RawInboundHookPayload } from './schemas.js';

type RawInboundHookSubjectRecord = SubjectRecord<'received', EventMessagePayload<RawInboundHookPayload>>;

/**
 * Subject definition for the raw inbound hook event in a concrete
 * `hook:<source>` namespace.
 */
export type RawInboundHookReceivedSubject = SubjectDefinition<
  RawInboundHookSubjectRecord,
  'received',
  `hook:${string}`
>;

/**
 * Normalize a hook source identifier to the canonical form used in
 * `hook:<source>` namespaces.
 * @param source - Raw source string (e.g., `'Git'`, `'CLAUDE-CODE'`).
 * @returns Canonical lowercase source identifier.
 */
export function normalizeInboundHookSource(source: string): string {
  return InboundHookSourceSchema.parse(source.trim().toLowerCase());
}

/**
 * Create a bus namespace definition for the given inbound hook source.
 *
 * The namespace is suitable for registration via `bus.registerNamespace()`.
 * @param source - Stable source identifier (e.g., `'git'`, `'claude-code'`).
 * @returns Bus namespace definition scoped to `hook:<source>`.
 */
export function createInboundHookNamespace(source: string) {
  const normalizedSource = normalizeInboundHookSource(source);
  return createBusNamespace(`hook:${normalizedSource}`, {
    received: RawInboundHookPayloadSchema,
  });
}

/**
 * Build a non-owning subject definition for `hook:<source>.received`.
 *
 * This is intentionally not a namespace registration. Namespace owners
 * register the full `hook:<source>` namespace at boot time; the ingress
 * bridge only needs to emit the raw event without accidentally registering
 * a narrower schema before the concrete owner loads.
 * @param source - Stable source identifier (e.g., `'git'`, `'claude-code'`).
 * @returns Non-owning subject definition for the source's raw hook ingress.
 */
export function createInboundHookReceivedSubject(source: string): RawInboundHookReceivedSubject {
  const normalizedSource = normalizeInboundHookSource(source);

  // `payload` is a type-level phantom used only for inference — it is never
  // accessed at runtime. Cast the whole object rather than fabricating a
  // phantom value on the field itself (mirrors nestSubjectDefinitions).
  return {
    subject: 'received',
    $meta: {
      namespace: `hook:${normalizedSource}`,
      isRequest: false,
      local: false,
      channel: false,
    },
  } as RawInboundHookReceivedSubject;
}
