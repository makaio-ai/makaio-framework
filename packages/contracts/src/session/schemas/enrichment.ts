import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Session enrichment schemas.
 *
 * Provides an optional bus RPC seam that host code can register to
 * supply additional context fields for session hook contexts. Framework
 * callers use `requestOptional` — no handler registered means empty
 * extensions (graceful degradation, OSS-safe).
 */
export const SessionEnrichmentSchemas = {
  /**
   * Enrich session hook context with optional host-owned fields.
   *
   * Subject: `session.enrichContext`
   * Type: Request (RPC, optional)
   *
   * Framework code calls `bus.requestOptional(SessionSubjects.enrichContext, { sessionId })`
   * inside `fetchSessionEnrichment`. Host registers a handler that returns
   * arbitrary key/value context extensions (e.g., `project`, `worktree`).
   * When no handler is registered, `requestOptional` returns `{ handled: false }`
   * and the hook context carries only framework-owned fields.
   *
   * Host adds TypeScript visibility via declaration merging on
   * `SessionHookContext` in `@makaio/hooks`.
   * @example
   * ```typescript
   * // Host handler (registers the enrichment provider)
   * bus.on(SessionSubjects.enrichContext, async (ctx) => {
   *   const scope = await readSessionScope(db, ctx.payload.sessionId);
   *   const project = scope?.projectId
   *     ? await bus.request(ProjectSubjects.get, { projectId: scope.projectId }).catch(() => null)
   *     : null;
   *   ctx.setResult({
   *     project: project?.project ?? undefined,
   *     worktree: undefined,
   *   });
   * });
   * ```
   */
  enrichContext: {
    request: z.object({
      /** Session ID whose hook context is being enriched. */
      sessionId: z.string(),
    }),
    response: z.record(z.string(), z.unknown()),
  },
} satisfies SchemaRecord;
