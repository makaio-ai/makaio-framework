import type { IMakaioBus } from '@makaio/bus-core';
import type { RequestContext } from '@makaio/core';
import type { SendMessageRequest, SendMessageResponse, JsonValue } from '@makaio/contracts';
import type { PreUserMessageContext, PreUserMessagePayload } from '../types/hook-context.js';
import type { PreUserMessageHookOptions } from '../types/hook-options.js';
import { fetchSessionEnrichment, EMPTY_ENRICHMENT, type SessionEnrichment } from './session-enrichment.js';

/**
 * Build enriched PreUserMessage context from request middleware context.
 *
 * When sessionId is present in the payload, queries the bus to enrich
 * context with session, recentHistory, and project data.
 * @param rawCtx - Request context from agent.sendMessage RPC middleware
 * @param _options - Hook configuration options (currently unused)
 * @param bus - Bus instance for making requests
 * @returns PreUserMessage context with session enrichment when available
 */
export async function buildPreUserMessageContext(
  rawCtx: RequestContext<SendMessageRequest, SendMessageResponse>,
  _options: PreUserMessageHookOptions,
  bus: IMakaioBus,
): Promise<PreUserMessageContext> {
  // Turn context storage - populated by setTurnContext()
  const turnContext: Record<string, JsonValue> = {};

  // Attempt session enrichment if sessionId is provided
  const sessionId = rawCtx.payload.sessionId;
  const enriched = sessionId ? await fetchSessionEnrichment(bus, sessionId) : EMPTY_ENRICHMENT;

  return buildContextObject(rawCtx, bus, turnContext, enriched);
}

/**
 * Build the PreUserMessageContext object.
 * @param rawCtx - Request context from agent.sendMessage RPC middleware
 * @param bus - Bus instance for making requests
 * @param turnContext - Mutable storage for turn context
 * @param enriched - Enriched session/history/project data
 * @returns PreUserMessageContext object
 */
function buildContextObject(
  rawCtx: RequestContext<SendMessageRequest, SendMessageResponse>,
  bus: IMakaioBus,
  turnContext: Record<string, JsonValue>,
  enriched: SessionEnrichment,
): PreUserMessageContext {
  return {
    ...enriched.contextExtensions,
    // Pass through request context properties
    get payload() {
      // Cast to PreUserMessagePayload - agent-level SendMessageRequest is compatible
      return rawCtx.payload as PreUserMessagePayload;
    },
    messageId: rawCtx.messageId,
    correlationId: rawCtx.correlationId,
    replacePayload: (newPayload) => {
      // Only update message and sessionContext (match runner semantics)
      // Routing fields (agentId, adapterId, etc.) are intentionally immutable
      if ('message' in newPayload && newPayload.message !== undefined) {
        rawCtx.replacePayload({ ...rawCtx.payload, message: newPayload.message });
      }
      if ('sessionContext' in newPayload && newPayload.sessionContext !== undefined) {
        rawCtx.replacePayload({ ...rawCtx.payload, sessionContext: newPayload.sessionContext });
      }
    },
    next: rawCtx.next.bind(rawCtx),

    // Enriched fields
    hookEvent: 'PreUserMessage',
    session: enriched.session,
    recentHistory: enriched.recentHistory,
    contextExtensions: enriched.contextExtensions,
    bus,

    // Turn context API - stores locally, merged after handler completes
    setTurnContext(key: string, value: JsonValue) {
      turnContext[key] = value;
    },
    // Returns only context set by THIS hook instance (not earlier hooks)
    getTurnContext() {
      return { ...turnContext };
    },
    // Stub for type coherence - bus-layer context path is deprecated
    // Real abort functionality is in the runner
    abort: (reason?: string): never => {
      throw new Error(`abort() not supported in bus-layer context${reason ? `: ${reason}` : ''}`);
    },
  };
}
