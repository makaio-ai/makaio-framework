/**
 * Subject telemetry namespace definition.
 *
 * Import `./schemas` when only pure Zod schemas are needed. Composition roots
 * register this namespace explicitly to enable schema validation and typed
 * subject routing for subject telemetry facts.
 * @example
 * ```typescript
 * // Emit a sanitized telemetry fact
 * await MakaioBus.emit(SubjectTelemetrySubjects.fact, {
 *   factId: 'fact-abc123',
 *   observedAt: Date.now(),
 *   namespace: 'session',
 *   subject: 'session.created',
 *   messageType: 'event',
 *   direction: 'local',
 *   messageId: 'msg-xyz789',
 *   attributes: { sessionId: 'sess-001' },
 * });
 *
 * // Subscribe to incoming telemetry facts
 * MakaioBus.on(SubjectTelemetrySubjects.fact, (ctx) => {
 *   const { factId, subject, observedAt } = ctx.payload;
 *   // Forward to telemetry sink
 * });
 * ```
 */
import { createBusNamespace } from '@makaio/core';
import { SubjectTelemetrySchemas } from './schemas.js';

/** Framework contract namespace for sanitized bus subject telemetry facts. */
export const SubjectTelemetryNamespace = createBusNamespace('subject-telemetry', SubjectTelemetrySchemas);

/** Typed subjects for sanitized bus subject telemetry facts. */
export const SubjectTelemetrySubjects = SubjectTelemetryNamespace.subjects;
