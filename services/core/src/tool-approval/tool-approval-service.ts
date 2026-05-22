import type { IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import {
  AgentSubjects,
  ApprovalSubjects,
  HarnessSubjects,
  type AgentToolApproveRequest,
  type AgentToolApproveResponse,
  type ApprovalPolicy,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AgentStorageSubjects, SessionStorageSubjects } from '../session/index.js';
import { extractToolFilePath } from '@makaio/tools-core';
import {
  applyCapabilityOverrides,
  enrichApprovalRequest,
  resolveEnrichedBasePolicy,
  resolveFileAccessContext,
  resolveHarnessLevelPolicy,
} from './tool-approval-rules.js';
import {
  type FileAccessContext,
  type HarnessResolution,
  type PolicyResolutionResult,
  type RawEnrichedPolicyResult,
  type ToolApprovalServiceOptions,
} from './tool-approval-types.js';

export type { ToolApprovalServiceOptions };

/**
 * Resolves and applies tool approval policies based on the
 * persona → profile → harness → system default cascade.
 *
 * Replaces the blanket auto-approve handler that was previously
 * in bus-server. Registered in the core runtime lifecycle.
 *
 * When a file access rule provider is configured,
 * `.makaioignore` rules are evaluated before the policy cascade as an absolute
 * deny layer — no policy (not even `full-access`) can bypass them.
 */
export class ToolApprovalService extends BaseService {
  /** Minimal logger seam so policy-resolution failures are observable in tests and production. */
  private readonly logger = console;
  private readonly options: ToolApprovalServiceOptions;

  /**
   * Creates a new ToolApprovalService instance.
   * @param bus - Bus instance used to resolve policy data and register approval handlers
   * @param options - Optional configuration including a file access rule provider
   */
  public constructor(bus: IMakaioBus, options: ToolApprovalServiceOptions = {}) {
    super(bus);
    this.options = options;
  }

  /**
   * Register the tool approval handler.
   */
  protected async onInit(): Promise<void> {
    this.registerHandler(AgentSubjects.toolApprove, async (ctx) => {
      // Fetch agent metadata and the enriched-policy RPC result once here so both
      // the file-access check and the policy cascade share the same data without
      // a redundant bus hop.
      const agent = await this.getAgentMetadata(ctx.payload.agentId, ctx.payload.sessionId);
      const hasPersonaOrProfile = Boolean(agent?.personaId || agent?.profileId);
      const rawEnrichedPolicy =
        hasPersonaOrProfile && ctx.payload.toolName
          ? await this.fetchRawEnrichedPolicy(agent?.personaId, agent?.profileId, ctx.payload.toolName)
          : undefined;

      const fileAccessContext = resolveFileAccessContext(agent, rawEnrichedPolicy, this.options.fileAccessRuleProvider);
      // .makaioignore is the absolute deny floor — always evaluated first.
      const fileAccessDenyReason = await this.checkFileAccessDenyReason(ctx.payload, fileAccessContext);
      if (fileAccessDenyReason) {
        ctx.setResult({
          action: 'deny',
          message: fileAccessDenyReason,
          shouldAbort: false,
        });
        return;
      }

      // Check session-level override (highest-precedence policy layer).
      const sessionOverride = await this.resolveSessionOverride(ctx.payload.sessionId);
      if (sessionOverride === 'full-access') {
        ctx.setResult({ action: 'allow' });
        return;
      }
      if (sessionOverride === 'reject') {
        ctx.setResult({
          action: 'deny',
          message: 'Tool use rejected by session approval policy override',
          shouldAbort: false,
        });
        return;
      }

      const resolved = await this.resolvePolicyWithContext(
        { adapterName: ctx.payload.adapterName, toolName: ctx.payload.toolName },
        agent,
        rawEnrichedPolicy,
      );

      // 'always-ask' override wins; otherwise use the resolved cascade policy and cached UI context.
      const effectivePolicy = sessionOverride === 'always-ask' ? 'always-ask' : resolved.policy;

      switch (effectivePolicy) {
        case 'full-access':
          ctx.setResult({ action: 'allow' });
          return;

        case 'reject':
          ctx.setResult({
            action: 'deny',
            message: 'Tool use rejected by approval policy',
            shouldAbort: false,
          });
          return;

        case 'always-ask':
          await this.dispatchAlwaysAskApproval(ctx.payload, ctx.setResult.bind(ctx), resolved);
          return;
      }
    });
  }

  /**
   * Dispatch an `always-ask` approval request to the approval queue.
   * Subscribes to the agent session-closed event so that a pending approval
   * is automatically cancelled when the agent disconnects. The subscription is
   * cleaned up in the `finally` block regardless of outcome.
   * @param payload - Tool approval request payload
   * @param setResult - Callback to set the handler result on the request context
   * @param resolved - Pre-resolved policy context used to enrich the request
   */
  private async dispatchAlwaysAskApproval(
    payload: AgentToolApproveRequest,
    setResult: (result: AgentToolApproveResponse) => void,
    resolved: PolicyResolutionResult,
  ): Promise<void> {
    const enriched = enrichApprovalRequest(payload, resolved);
    const controller = new AbortController();

    // Filter by agentId + adapterSessionId so one closed adapter session cannot cancel another's approval.
    const unsubSessionClosed = this.bus.on(
      AgentSubjects.session.closed,
      () => {
        controller.abort();
      },
      { filter: { agentId: enriched.agentId, adapterSessionId: payload.adapterSessionId } },
    );

    try {
      const response = await this.bus.requestOptional(ApprovalSubjects.request, enriched, {
        timeout: 0,
        signal: controller.signal,
      });

      if (response.handled && response.data.action === 'allow') {
        setResult({
          action: 'allow',
          ...(response.data.updatedInput && { updatedInput: response.data.updatedInput }),
        });
      } else {
        const denyMsg =
          response.handled && response.data.action === 'deny'
            ? (response.data.message ?? 'User denied tool execution')
            : 'No approval handler available';
        setResult({ action: 'deny', message: denyMsg, shouldAbort: false });
      }
    } catch {
      setResult({
        action: 'deny',
        message: controller.signal.aborted
          ? 'Approval cancelled — agent session closed'
          : 'Tool approval request failed',
        shouldAbort: false,
      });
    } finally {
      unsubSessionClosed();
    }
  }

  /**
   * Evaluate `.makaioignore` file access rules before policy cascade handling.
   * @param payload - Incoming tool approval payload
   * @param context - CWD and directory constraints for rule evaluation
   * @returns Deny message when access should be blocked, otherwise undefined
   */
  private async checkFileAccessDenyReason(
    payload: {
      toolName?: string;
      args?: Record<string, unknown>;
    },
    context: FileAccessContext,
  ): Promise<string | undefined> {
    // Requires agent cwd to resolve file paths and load .makaioignore hierarchy.
    // When cwd is unavailable, pre-check is skipped and downstream checks apply.
    if (!this.options.fileAccessRuleProvider || !context.cwd) {
      return undefined;
    }

    const filePath = extractToolFilePath(payload.toolName, payload.args, context.cwd);
    if (!filePath) {
      return undefined;
    }

    try {
      const rules = await this.options.fileAccessRuleProvider(context.cwd, context.allowedDirectories);
      return rules.isDenied(filePath) ? `Access denied: '${filePath}' is restricted by .makaioignore rules` : undefined;
    } catch {
      return 'Access denied: file access rules could not be evaluated';
    }
  }

  /**
   * Execute the `approval.resolveEnrichedPolicy` RPC exactly once and return the
   * raw discriminated result. Callers apply their own fail-closed semantics.
   * Errors are logged here since this is the single call site for the RPC.
   * @param personaId - Optional persona ID from agent metadata
   * @param profileId - Optional profile ID from agent metadata
   * @param toolName - Tool name forwarded to the RPC
   * @returns Handled result with response data, or unhandled sentinel on failure
   */
  private async fetchRawEnrichedPolicy(
    personaId: string | undefined,
    profileId: string | undefined,
    toolName: string,
  ): Promise<RawEnrichedPolicyResult> {
    try {
      return await this.bus.requestOptional(ApprovalSubjects.resolveEnrichedPolicy, {
        toolName,
        personaId,
        profileId,
      });
    } catch (error) {
      this.logger.error('[ToolApprovalService] approval.resolveEnrichedPolicy failed; falling back to fail-closed', {
        toolName,
        personaId,
        profileId,
        error,
      });
      return { handled: false };
    }
  }

  /**
   * Resolves the effective approval policy for a tool approval request,
   * returning the policy alongside cached harness context.
   *
   * Policy cascade: persona/profile (via host-tier RPC) → harness → system default.
   * After resolving the base policy, applies capability-based overrides from
   * the harness using most-restrictive-wins semantics.
   * @param request - Adapter name and tool name from the approval payload
   * @param agent - Pre-fetched agent metadata, or null if unavailable
   * @param rawEnrichedPolicy - Pre-fetched enriched-policy RPC result shared with the file-access check
   * @returns Resolved policy and associated context
   */
  private async resolvePolicyWithContext(
    request: { adapterName: string; toolName?: string },
    agent: MakaioSessionAgent | null,
    rawEnrichedPolicy: RawEnrichedPolicyResult | undefined,
  ): Promise<PolicyResolutionResult> {
    const adapterName = agent?.adapterName ?? request.adapterName;
    const enrichedBase = resolveEnrichedBasePolicy(agent?.personaId, agent?.profileId, rawEnrichedPolicy);
    const harnessResolution = await this.resolveHarnessPolicy(adapterName, agent?.harnessId, agent?.clientId);

    // Persona/profile policy takes precedence over all harness-level settings.
    // If no persona/profile policy, check per-tool override first, then fall back to harness base.
    const harnessPolicy = resolveHarnessLevelPolicy(harnessResolution, request.toolName);
    const effectiveBasePolicy: ApprovalPolicy = enrichedBase?.policy ?? harnessPolicy ?? 'always-ask';

    let finalPolicy = effectiveBasePolicy;
    if (harnessResolution?.capabilityOverrides && harnessResolution.toolCapabilityMap && request.toolName) {
      finalPolicy = applyCapabilityOverrides(
        effectiveBasePolicy,
        request.toolName,
        harnessResolution.capabilityOverrides,
        harnessResolution.toolCapabilityMap,
      );
    }

    return {
      policy: finalPolicy,
      harness: harnessResolution,
      agent,
      resolvedAdapterName: adapterName,
      ...(enrichedBase?.personaName && { personaName: enrichedBase.personaName }),
      ...(enrichedBase?.profileName && { profileName: enrichedBase.profileName }),
    };
  }

  /**
   * Look up agent metadata from storage by agentId.
   * @param agentId - The agent identifier
   * @param sessionId - Optional session ID for scoped lookup
   * @returns Agent metadata, or null if not found
   */
  private async getAgentMetadata(agentId: string, sessionId?: string): Promise<MakaioSessionAgent | null> {
    try {
      if (sessionId) {
        const { agents } = await this.bus.request(AgentStorageSubjects.listBySession, { sessionId });
        return agents.find((a) => a.agentId === agentId) ?? null;
      }

      // Fallback: direct lookup
      const result = await this.bus.requestOptional(AgentStorageSubjects.get, { agentId });
      return result.handled ? result.data.agent : null;
    } catch {
      return null;
    }
  }

  /**
   * Check for a session-level approval policy override.
   * Uses `requestOptional` so that when no session storage handler is registered
   * (e.g., in tests or lightweight runtimes) the method gracefully returns
   * `undefined` and the existing policy cascade runs unchanged.
   * @param sessionId - Session to check
   * @returns Override policy or undefined when not set or unavailable
   */
  private async resolveSessionOverride(sessionId?: string): Promise<ApprovalPolicy | undefined> {
    if (!sessionId) return undefined;
    try {
      const result = await this.bus.requestOptional(SessionStorageSubjects.get, { sessionId });
      return result.handled ? (result.data.session?.approvalPolicyOverride ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve harness policy for the given adapter; returns undefined on failure.
   * @param adapterName - Adapter type name
   * @param harnessId - Explicit harness ID; overrides the default harness lookup
   * @param clientId - Client ID for client-scoped harness resolution
   * @returns Harness resolution carrying base policy and capability override data, or undefined when resolution fails
   */
  private async resolveHarnessPolicy(
    adapterName: string,
    harnessId?: string,
    clientId?: string,
  ): Promise<HarnessResolution | undefined> {
    try {
      const harness = await this.bus.request(HarnessSubjects.resolve, {
        adapterName,
        ...(harnessId && { profileHarnessId: harnessId }),
        ...(clientId && { clientId }),
      });
      return {
        approvalPolicy: harness.approvalPolicy,
        capabilityOverrides: harness.capabilityOverrides,
        toolCapabilityMap: harness.toolCapabilityMap,
        toolApprovalOverrides: harness.toolApprovalOverrides,
      };
    } catch {
      return undefined;
    }
  }
}
