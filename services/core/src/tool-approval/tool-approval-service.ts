import path from 'node:path';
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
import { extractToolFilePath, extractToolRawFilePath } from '@makaio/tools-core';
import {
  applyCapabilityOverrides,
  canonicalizePath,
  enrichApprovalRequest,
  evaluateToolGrant,
  isCanonicalPathWithin,
  resolveEnrichedBasePolicy,
  resolveFileAccessContext,
  resolveHarnessLevelPolicy,
  type ToolGrantVerdict,
} from './tool-approval-rules.js';
import {
  type FileAccessContext,
  type HarnessResolution,
  type PolicyResolutionResult,
  type RawEnrichedPolicyResult,
  type ToolApprovalServiceOptions,
} from './tool-approval-types.js';

export type { ToolApprovalServiceOptions };

/** Outcome of the agent row lookup: a lookup `error` is distinct from a missing row. */
type AgentLookupResult = { kind: 'found'; agent: MakaioSessionAgent } | { kind: 'absent' } | { kind: 'error' };

/**
 * Merge the cascade policy with the tool-list grant, the session override, and the agent lookup outcome.
 * @param cascadePolicy - Policy resolved by the persona/profile → harness → default cascade
 * @param toolGrant - Tool-list verdict (a `deny` verdict never reaches this merge)
 * @param sessionOverride - Session-level override, if any
 * @param agentLookupFailed - Whether the agent row lookup threw
 * @returns Effective policy to apply
 */
function mergeEffectivePolicy(
  cascadePolicy: ApprovalPolicy,
  toolGrant: ToolGrantVerdict,
  sessionOverride: ApprovalPolicy | undefined,
  agentLookupFailed: boolean,
): ApprovalPolicy {
  // A session 'always-ask' override replaces the cascade result, a tool-list grant included.
  if (sessionOverride === 'always-ask') return 'always-ask';
  if (cascadePolicy === 'reject') return 'reject';
  // A failed agent lookup forces 'always-ask' unless the cascade rejects.
  if (agentLookupFailed) return 'always-ask';
  // A tool-list grant replaces a cascade 'always-ask' (headless).
  return toolGrant.kind === 'granted' ? 'full-access' : cascadePolicy;
}

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
 *
 * The agent's stored tool lists (`allowedTools` / `disallowedTools`) deny unlisted
 * calls and grant listed ones without a human, but a grant only replaces an
 * `always-ask` cascade policy — a `reject` policy or a session `always-ask`
 * override still wins. See the package README for the full check order.
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
      const lookup = await this.getAgentMetadata(ctx.payload.agentId, ctx.payload.sessionId);
      const agent = lookup.kind === 'found' ? lookup.agent : null;
      const agentLookupFailed = lookup.kind === 'error';
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
      if (sessionOverride === 'reject') {
        ctx.setResult({
          action: 'deny',
          message: 'Tool use rejected by session approval policy override',
          shouldAbort: false,
        });
        return;
      }

      // The agent's tool lists deny unlisted calls ahead of any allowing policy.
      // The lists live only on the agent row: when the lookup fails, or no row exists
      // (host without agent storage, ephemeral start, swallowed best-effort row write), this
      // layer yields `none`. Both framework start paths (lead start, attach start) persist the
      // row before adapter dispatch, so the first turn already finds it; a row may still lack
      // `cwd` when the caller named none (the file-access check above fails closed on that).
      // Only claude-agent-sdk carries its own allowlist gate; claude-code-cli enforces only
      // the denylist and claude-code-tmux neither, so an allowing policy would run an unlisted
      // call unchecked. A lookup error therefore falls back to asking (see below): interactive
      // sessions ask a human, headless calls are denied for lack of an approval handler.
      // A missing row keeps the cascade: the request carries no lists, so it cannot be told
      // apart from an agent without lists, and failing closed would downgrade every such agent.
      // This gap predates the stored lists (develop allowed unlisted CLI calls the same way).
      // TODO(FACT-247): adapters without their own gate carry the lists (or a flag) on the
      // approval request so a missing row fails closed; tmux rejects starts with lists.
      // TODO(FACT-75): adapter-side availability limit (`--tools <nativeAvailableTools>`) for CLI/tmux.
      const toolGrant = evaluateToolGrant(agent, ctx.payload.toolName, ctx.payload.args, rawEnrichedPolicy);
      if (toolGrant.kind === 'deny') {
        ctx.setResult({ action: 'deny', message: toolGrant.message, shouldAbort: false });
        return;
      }

      if (sessionOverride === 'full-access' && !agentLookupFailed) {
        ctx.setResult({ action: 'allow' });
        return;
      }

      const resolved = await this.resolvePolicyWithContext(
        { adapterName: ctx.payload.adapterName, toolName: ctx.payload.toolName },
        agent,
        rawEnrichedPolicy,
      );

      switch (mergeEffectivePolicy(resolved.policy, toolGrant, sessionOverride, agentLookupFailed)) {
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
      {
        filter: {
          agentId: enriched.agentId,
          ...(payload.adapterSessionId !== undefined && { adapterSessionId: payload.adapterSessionId }),
        },
      },
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
   * Evaluate `.makaioignore` file access rules and the directory allowlist before policy
   * cascade handling.
   *
   * The rules are tested against both the lexical and the canonical (symlink-resolved)
   * target, so an in-tree symlink cannot alias a denied path such as `.git/config`. A
   * target that cannot be canonicalized safely (dangling symlink, non-`ENOENT` error) is
   * denied; a missing file canonicalizes through its nearest existing ancestor, so a Write
   * of a new file stays possible. A symlinked cwd itself is not covered: the rules are
   * cwd-relative, so a canonical spelling outside the lexical cwd is not matched (same
   * limit as `createPathValidator` in the filesystem extension).
   *
   * A raw path argument with a `..` segment (split on `/` and `\`) is denied outright:
   * `path.resolve` collapses `..` before symlinks are followed, so `link/../config` with
   * `link -> .git/subdir` would be checked as `<cwd>/config` while the OS opens
   * `<cwd>/.git/config`. This also denies harmless spellings such as `src/../README.md`.
   *
   * The allowlist is `agent.allowedDirectories`, else the profile's. A target whose
   * canonical path lies outside every entry is denied, so an empty list denies every
   * native file-tool call with a path, matching the runtime contract and the filesystem
   * extension's path validator. An absent list (`undefined`) adds no containment. An
   * agent with a `profileId` but no own list gets `[]` when the profile RPC is unhandled
   * or fails, so such a host denies all native file-tool calls with a path; hosts without
   * a profile service set the agent's `allowedDirectories` or leave `profileId` unset.
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
    if (!this.options.fileAccessRuleProvider) {
      return undefined;
    }

    // The rules hang off the agent cwd. Without one (no agent row, a failed lookup, or a
    // row whose caller named no cwd) a file-tool call cannot be evaluated and fails closed,
    // so a later full-access override or tool-list grant cannot allow it. The root base
    // only detects whether the call names a path; it is never evaluated.
    const filePath = extractToolFilePath(payload.toolName, payload.args, context.cwd ?? path.sep);
    if (!filePath) {
      return undefined;
    }
    if (!context.cwd) {
      return 'Access denied: file access rules could not be evaluated: agent has no working directory';
    }
    const rawPath = extractToolRawFilePath(payload.toolName, payload.args);
    if (rawPath?.split(/[\\/]/).includes('..')) {
      return `Access denied: '${rawPath}' contains a '..' segment; file access rules need a path without parent references`;
    }

    const canonicalPath = canonicalizePath(filePath);
    try {
      const rules = await this.options.fileAccessRuleProvider(context.cwd, context.allowedDirectories);
      if (
        rules.isDenied(filePath) ||
        (canonicalPath !== undefined && canonicalPath !== filePath && rules.isDenied(canonicalPath))
      ) {
        return `Access denied: '${filePath}' is restricted by .makaioignore rules`;
      }
    } catch {
      return 'Access denied: file access rules could not be evaluated';
    }
    if (canonicalPath === undefined) {
      return `Access denied: file access rules could not be evaluated: '${filePath}' cannot be resolved safely`;
    }
    const { allowedDirectories } = context;
    if (allowedDirectories !== undefined && !isCanonicalPathWithin(allowedDirectories, canonicalPath, context.cwd)) {
      return `Access denied: '${filePath}' is outside the agent's allowed directories`;
    }
    return undefined;
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
   *
   * An unhandled storage request (no agent storage registered, e.g. lightweight runtimes
   * and tests) counts as `absent`: without a storage handler no agent rows exist. Only a
   * thrown request (storage or transport failure) is an `error`. `absent` does not mean
   * "no tool lists": see TODO(FACT-247) in the approval handler.
   * @param agentId - The agent identifier
   * @param sessionId - Optional session ID for scoped lookup
   * @returns `found` with the agent row, `absent` when no row exists, or `error` when the lookup failed
   */
  private async getAgentMetadata(agentId: string, sessionId?: string): Promise<AgentLookupResult> {
    try {
      let agent: MakaioSessionAgent | null | undefined;
      if (sessionId) {
        const result = await this.bus.requestOptional(AgentStorageSubjects.listBySession, { sessionId });
        agent = result.handled ? result.data.agents.find((a) => a.agentId === agentId) : undefined;
      } else {
        // Fallback: direct lookup
        const result = await this.bus.requestOptional(AgentStorageSubjects.get, { agentId });
        agent = result.handled ? result.data.agent : undefined;
      }
      return agent ? { kind: 'found', agent } : { kind: 'absent' };
    } catch (error) {
      this.logger.warn('[ToolApprovalService] agent lookup failed; forcing always-ask', { agentId, sessionId, error });
      return { kind: 'error' };
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
