import type { IMakaioBus, InterceptorContext } from '@makaio/bus-core';
import type { StepFinished } from '@makaio/contracts';
import type { PostStepContext } from '../types/hook-context.js';
import { fetchSessionEnrichment, EMPTY_ENRICHMENT } from './session-enrichment.js';

/**
 * Build PostStep context from interceptor context.
 *
 * Extracts step completion data and provides a clean API for hooks.
 * Enriches with session, recentHistory, project, and step content.
 * @param rawCtx - Interceptor context from step.finished event
 * @param bus - Bus instance for making requests
 * @returns PostStepContext for hook handlers
 */
export async function buildPostStepContext(
  rawCtx: InterceptorContext<StepFinished>,
  bus: IMakaioBus,
): Promise<PostStepContext> {
  const payload = rawCtx.payload;

  // Fetch session enrichment (step content is already in payload)
  const enriched = payload.sessionId ? await fetchSessionEnrichment(bus, payload.sessionId) : EMPTY_ENRICHMENT;

  return {
    // Host extensions first — framework fields below take precedence.
    ...enriched.contextExtensions,
    hookEvent: 'PostStep',
    // Step identifiers
    sessionId: payload.sessionId,
    agentId: payload.agentId,
    adapterId: payload.adapterId,
    adapterName: payload.adapterName,
    messageId: payload.messageId,
    stepType: payload.stepType,
    blockIndex: payload.blockIndex,
    stepContent: payload.content,
    // Full payload for advanced use
    payload,
    // Correlation
    correlationId: rawCtx.correlationId,
    // Session enrichment
    session: enriched.session,
    recentHistory: enriched.recentHistory,
    contextExtensions: enriched.contextExtensions,
    bus,
    // Interceptor controls
    async next() {
      await rawCtx.next();
    },
    stopPropagation: rawCtx.stopPropagation.bind(rawCtx),
  };
}
