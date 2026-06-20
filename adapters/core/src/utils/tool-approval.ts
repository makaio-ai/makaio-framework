/**
 * Shared tool approval types and utilities for adapter implementations.
 *
 * All adapters need the same identity context when requesting tool approval
 * via the global AgentSubjects.toolApprove bus subject. This module provides
 * the shared interface and registration logic to avoid duplicating it across adapters.
 */

import { MakaioBus, type IMakaioBus, type OnOptions } from '@makaio/bus-core';
import {
  AgentSubjects,
  AgentToolApproveSchema,
  type AgentToolApproveRequest,
  type AgentToolApproveResponse,
} from '@makaio/contracts';
import type { AIAgentConnector } from '../connector/index.js';
import type { RequestContext, ScopedSubjectDefinition } from '@makaio/core';
import { z } from 'zod';

/**
 * Context required to complete a global tool approval request.
 *
 * Provides adapter identity so the approval handler knows which
 * adapter/agent/session is requesting permission.
 */
export interface ToolApprovalContext {
  /** Adapter instance ID */
  adapterId: string;
  /** Adapter type name (e.g., 'gemini-sdk', 'openai-node') */
  adapterName: string;
  /** Agent ID within the adapter */
  agentId: string;
  /** Adapter-side session ID */
  adapterSessionId: string;
  /** Makaio session ID — required for approval routing to the owning tab */
  sessionId: string;
}

/**
 * Options controlling how scoped approval payloads are promoted to the global schema.
 */
export interface MergeScopedToolApprovalOptions {
  /**
   * Allow `payload.sessionId` to satisfy the global request when context lacks one.
   *
   * This should stay `false` for connector-scoped RPC handlers, which must rely on
   * agent context rather than connector-provided session identity. Enable only for
   * trusted call sites that already hold a canonical global approval payload.
   */
  allowPayloadSessionFallback?: boolean;
  /**
   * Allow payload identity fields (`agentId`, `adapterId`, `adapterName`,
   * `adapterSessionId`) to satisfy the global request when context lacks them.
   *
   * This should stay `false` for connector-scoped RPC handlers, which must rely on
   * agent context rather than connector-provided identity. Enable only for trusted
   * call sites that already hold a canonical global approval payload (e.g., direct
   * bus invocations that supply the full payload without a live agent context).
   */
  allowPayloadIdentityFallback?: boolean;
}

/**
 * Resolve a required string field for global tool approval from context or payload.
 *
 * Shared internal helper used by `resolveRequiredSessionId` and the identity
 * field resolution in `mergeScopedToolApproval`. Enforces strict context-first
 * semantics: payload fallback is gated behind an explicit opt-in flag.
 * @param contextValue - Value from agent context (trusted source)
 * @param payloadValue - Value from scoped payload (untrusted source)
 * @param fieldName - Field name used in the error message
 * @param sourceLabel - Short source label used in error messages
 * @param allowPayloadFallback - Whether trusted callers may reuse the payload value
 * @returns Resolved field value
 * @throws Error if the field is absent from all allowed sources
 */
function resolveRequiredField(
  contextValue: string | undefined,
  payloadValue: string | undefined,
  fieldName: string,
  sourceLabel: string,
  allowPayloadFallback: boolean,
): string {
  const resolved = contextValue ?? (allowPayloadFallback ? payloadValue : undefined);
  if (!resolved) {
    throw new Error(
      `[${sourceLabel}] toGlobalToolApproval: ${fieldName} must come from tool approval context` +
        (allowPayloadFallback ? ' or trusted payload' : ''),
    );
  }
  return resolved;
}

/**
 * Resolve the Makaio session ID required for global tool approval routing.
 *
 * Scoped connector payloads may omit `sessionId`; agent context should normally
 * provide it. Callers may optionally allow a payload fallback when their scoped
 * payload is already trusted to carry the same value.
 * @param contextSessionId - Session ID from agent context
 * @param payloadSessionId - Optional session ID from scoped payload
 * @param sourceLabel - Short source label used in error messages
 * @param allowPayloadSessionFallback - Whether trusted callers may reuse the payload session ID
 * @returns Resolved session ID
 * @throws Error if session ID is absent from all allowed sources
 */
export function resolveRequiredSessionId(
  contextSessionId: string | undefined,
  payloadSessionId: string | undefined,
  sourceLabel: string,
  allowPayloadSessionFallback = false,
): string {
  return resolveRequiredField(
    contextSessionId,
    payloadSessionId,
    'sessionId',
    sourceLabel,
    allowPayloadSessionFallback,
  );
}

/**
 * Merge a scoped tool approval payload with agent context into the global request shape.
 *
 * All five identity fields (`sessionId`, `agentId`, `adapterId`, `adapterName`,
 * `adapterSessionId`) must come from trusted agent context by default. Payload
 * fallback for each group is enabled via the corresponding option flag.
 * @param payload - Scoped approval payload emitted by the connector
 * @param context - Agent context used to enrich the scoped payload
 * @param sourceLabel - Short source label used in error messages
 * @param options - Controls whether trusted call sites may reuse payload identity
 * @returns Global tool approval request with all required identity fields resolved
 */
export function mergeScopedToolApproval(
  payload: ScopedToolApprovalRequest,
  context: Partial<ToolApprovalContext>,
  sourceLabel: string,
  options: MergeScopedToolApprovalOptions = {},
): AgentToolApproveRequest {
  const allowIdentity = options.allowPayloadIdentityFallback ?? false;

  // When payload identity fallback is enabled, context must supply either all four
  // identity fields or none. A partial context would produce a mixed-source tuple
  // (some fields from the trusted agent context, others from the untrusted payload),
  // which violates the atomicity invariant for adapter identity.
  if (allowIdentity) {
    // filter(Boolean) and resolveRequiredField both treat empty strings as absent —
    // the semantics are intentionally aligned so atomicity rejects partial context
    // before resolution can produce confusing per-field errors.
    const contextIdentityFields = [context.agentId, context.adapterId, context.adapterName, context.adapterSessionId];
    const presentCount = contextIdentityFields.filter(Boolean).length;
    if (presentCount > 0 && presentCount < contextIdentityFields.length) {
      throw new Error(
        `[${sourceLabel}] toGlobalToolApproval: context must supply all four identity fields ` +
          `(agentId, adapterId, adapterName, adapterSessionId) or none — ` +
          `partial context with allowPayloadIdentityFallback creates a mixed-source identity tuple`,
      );
    }
  }
  const sessionId = resolveRequiredSessionId(
    context.sessionId,
    payload.sessionId,
    sourceLabel,
    options.allowPayloadSessionFallback ?? false,
  );
  return {
    ...payload,
    agentId: resolveRequiredField(context.agentId, payload.agentId, 'agentId', sourceLabel, allowIdentity),
    adapterId: resolveRequiredField(context.adapterId, payload.adapterId, 'adapterId', sourceLabel, allowIdentity),
    adapterName: resolveRequiredField(
      context.adapterName,
      payload.adapterName,
      'adapterName',
      sourceLabel,
      allowIdentity,
    ),
    adapterSessionId: resolveRequiredField(
      context.adapterSessionId,
      payload.adapterSessionId,
      'adapterSessionId',
      sourceLabel,
      allowIdentity,
    ),
    sessionId,
  };
}

/**
 * Scoped tool approval schema for adapter connector buses.
 *
 * `sessionId` is optional here because the connector emits the approval request
 * before the agent layer has enriched it. The agent's `wireToolApprovalRpc`
 * (or equivalent) injects `sessionId` from its own context before forwarding
 * to the global `AgentSubjects.toolApprove` subject, where `sessionId` is required.
 *
 * Adapters with a genuinely different wire format (e.g., gemini-sdk's callId/name)
 * should define their own schema rather than extending this one.
 */
export const ScopedToolApprovalSchema = {
  request: AgentToolApproveSchema.request.extend({
    /** Makaio session ID — optional at connector layer; enriched by the agent. */
    sessionId: z.string().optional(),
  }),
  response: AgentToolApproveSchema.response,
};

/** Scoped tool approval request payload type — `sessionId` is optional at the connector layer. */
export type ScopedToolApprovalRequest = z.infer<typeof ScopedToolApprovalSchema.request>;

/** Scoped tool approval response payload type — identical to the global response. */
export type ScopedToolApprovalResponse = z.infer<typeof ScopedToolApprovalSchema.response>;

/**
 * Transform function signature: SDK payload → AgentToolApproveRequest.
 * @param payload - SDK-specific tool approval payload
 * @param context - Resolved tool approval context with adapter identity
 * @returns Global tool approval request for AgentSubjects.toolApprove
 */
export type ToGlobalToolApprovalFn<TPayload, TContext = ToolApprovalContext> = (
  payload: TPayload,
  context: TContext,
) => AgentToolApproveRequest;

/**
 * Transform function signature: AgentToolApproveResponse → SDK response format.
 * @param response - Global tool approval response from AgentSubjects.toolApprove
 * @returns SDK-compatible response format
 */
export type FromGlobalToolApprovalFn<TResponse> = (response: AgentToolApproveResponse) => TResponse;

/**
 * Minimal bus subscription interface for tool approval wiring.
 *
 * Parameterized over `TPayload` and `TResponse` to preserve full type safety
 * within the handler body. Avoids threading the connector's concrete `TBus`
 * generic through this shared factory, which would be a breaking API change
 * across every adapter implementation.
 * @typeParam TPayload - Tool approval request payload type for this adapter
 * @typeParam TResponse - Tool approval response type for this adapter
 */
interface IToolApprovalBus<TPayload, TResponse> {
  /**
   * Subscribe a handler to a scoped subject.
   *
   * The subject parameter accepts any ScopedSubjectDefinition rather than a
   * request-specific variant because the bus framework does not distinguish
   * request vs event subjects at the type level. This interface is used at a
   * single assignment site where the subject is always a request subject.
   * @param subject - Scoped subject definition to subscribe to
   * @param handler - Request handler receiving payload and setResult
   * @param options - Optional subscription options
   * @returns Unsubscribe function
   */
  on(
    subject: ScopedSubjectDefinition<string>,
    handler: (ctx: RequestContext<TPayload, TResponse>) => void | Promise<void>,
    options?: OnOptions,
  ): () => void;
}

/**
 * Factory: Create tool approval handler for adapter connector.
 *
 * Wires adapter-scoped tool approval subject → AgentSubjects.toolApprove.
 * Handles lazy context resolution to avoid race conditions with adapterSessionId.
 *
 * Used by both test harnesses (createTestConfig) and production (agent.ts).
 * @param subject - Adapter-scoped subject for tool approval requests
 * @param toGlobal - Transform SDK payload to global request
 * @param fromGlobal - Transform global response to SDK format
 * @returns Handler registration function
 * @example
 * ```typescript
 * // In gemini-sdk/src/tool-handling.ts
 * export const registerToolApprovalHandler = createToolApprovalHandler(
 *   GeminiConnectorSubjects.acp.tool_approval,
 *   toGlobalToolApproval,
 *   fromGlobalToolApproval,
 * );
 * ```
 */
export function createToolApprovalHandler<
  TPayload,
  // TContext is always an object interface (ToolApprovalContext or equivalent).
  // typeof context === 'function' below distinguishes lazy providers from value
  // contexts. A callable TContext would be misidentified, but all current and
  // expected adapter contexts are plain interfaces — constraining to
  // Record<string, unknown> would break TypeScript's interface-vs-type index
  // signature rules without adding real safety.
  TContext = ToolApprovalContext,
  TResponse = AgentToolApproveResponse,
>(
  subject: ScopedSubjectDefinition<string>,
  toGlobal: ToGlobalToolApprovalFn<TPayload, TContext>,
  fromGlobal: FromGlobalToolApprovalFn<TResponse>,
) {
  type ContextProvider = TContext | (() => Promise<TContext>);

  // The public parameter uses Pick<AIAgentConnector, 'on'> rather than
  // IToolApprovalBus because that is what every adapter passes in.
  // IToolApprovalBus is an internal narrowing interface — exposing it would
  // force adapters to import and thread an internal type for no safety gain.
  return function registerToolApprovalHandler(
    connector: Pick<AIAgentConnector, 'on'>,
    context: ContextProvider,
    globalBus: IMakaioBus = MakaioBus,
  ): () => void {
    const bus: IToolApprovalBus<TPayload, TResponse> = connector;
    return bus.on(subject, async (ctx) => {
      try {
        // Resolve context lazily if callback provided (avoids race condition with adapterSessionId)
        const resolvedContext: TContext =
          typeof context === 'function' ? await (context as () => Promise<TContext>)() : (context as TContext);
        const request = toGlobal(ctx.payload, resolvedContext);
        const globalResponse = await globalBus.request(AgentSubjects.toolApprove, request);
        ctx.setResult(fromGlobal(globalResponse));
      } catch (error) {
        console.error('[createToolApprovalHandler] Tool approval request failed:', error);
        const errorDetails = error instanceof Error ? `: ${error.message}` : '';
        ctx.setResult(
          fromGlobal({
            action: 'deny',
            message: `Tool approval request failed${errorDetails}`,
            shouldAbort: true,
          }),
        );
      }
    });
  };
}
