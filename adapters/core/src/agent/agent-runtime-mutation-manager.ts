import {
  SessionSubjects,
  type MakaioSessionAgent,
  type AIReasoningLevel,
  type ReasoningLevelMap,
  type ProviderContext,
} from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import { activateProviderContextStrict, buildProviderContext } from '@makaio/services-core/provider-context';
import type { IMakaioBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../connector/index.js';
import { CredentialChangeSequencer } from './credential-change-sequencer.js';
import { confirmModelChange } from './model-change-warning.js';
import { AgentMcpServersMutationManager } from './agent-mcp-servers-mutation-manager.js';
import type {
  AgentRuntimeConnectorOverrides,
  AgentRuntimeMutationManagerConfig,
} from './agent-runtime-mutation-manager-config.js';
import type {
  AgentModelChangeRequestPayload,
  AgentModelChangeResponsePayload,
  AgentMcpServersSetRequestPayload,
  AgentMcpServersSetResponsePayload,
  AgentCwdChangeRequestPayload,
  AgentCwdChangeResponsePayload,
  AgentCredentialChangeRequestPayload,
  AgentCredentialChangeResponsePayload,
} from './types.js';

/**
 * Handles runtime mutation requests for AIAgent (cwd/model/credential changes).
 */
export class AgentRuntimeMutationManager {
  private readonly agentId: string;
  private readonly sessionId?: string;
  private readonly globalBus: IMakaioBus;
  private readonly getConnector: () => AIAgentConnector;
  private readonly swapConnector: (configOverrides?: Partial<AgentRuntimeConnectorOverrides>) => Promise<void>;
  private readonly emitCwdChanged: AgentRuntimeMutationManagerConfig['emitCwdChanged'];
  private readonly emitModelChanged: AgentRuntimeMutationManagerConfig['emitModelChanged'];
  private readonly getProviderContext: () => ProviderContext | undefined;
  private readonly setProviderContext: (providerContext: ProviderContext) => void;
  private readonly setReasoningEffort: (reasoningEffort: AIReasoningLevel | undefined) => void;
  private readonly setMcpSessionContext: AgentRuntimeMutationManagerConfig['setMcpSessionContext'];
  private readonly resolveSupportedReasoningLevels: (model: string) => ReasoningLevelMap | undefined;
  private readonly mcpServersMutationManager: AgentMcpServersMutationManager;
  private readonly credentialChangeSequencer = new CredentialChangeSequencer();
  private stagedModelChange?: AgentModelChangeRequestPayload;

  public constructor(config: AgentRuntimeMutationManagerConfig) {
    this.agentId = config.agentId;
    this.sessionId = config.sessionId;
    this.globalBus = config.globalBus;
    this.getConnector = config.getConnector;
    this.swapConnector = config.swapConnector;
    this.emitCwdChanged = config.emitCwdChanged;
    this.emitModelChanged = config.emitModelChanged;
    this.getProviderContext = config.getProviderContext;
    this.setProviderContext = config.setProviderContext;
    this.setReasoningEffort = config.setReasoningEffort;
    this.setMcpSessionContext = config.setMcpSessionContext;
    this.resolveSupportedReasoningLevels = config.resolveSupportedReasoningLevels;
    this.mcpServersMutationManager = new AgentMcpServersMutationManager({
      getConnector: this.getConnector,
      swapConnector: this.swapConnector,
      setMcpSessionContext: this.setMcpSessionContext,
    });
  }

  /**
   * Handle `agent.cwd.change` request.
   * @param payload - CWD change request payload
   * @returns CWD mutation response payload
   */
  public async handleCwdChange(payload: AgentCwdChangeRequestPayload): Promise<AgentCwdChangeResponsePayload> {
    const connector = this.getConnector();
    const { newCwd } = payload;

    if (connector.cwd === newCwd) {
      return { success: true };
    }

    if (connector.getProcessingState() !== 'idle') return { success: false, reason: 'turn_active' };

    try {
      const previousCwd = connector.cwd;
      const changedInPlace = await connector.changeCwdInPlace(newCwd).catch(() => false);

      if (changedInPlace) {
        connector.cwd = newCwd;
      } else {
        await this.swapConnector({ cwd: newCwd });
      }

      await this.persistRuntimeMutation({ cwd: newCwd });
      await this.emitCwdChanged({ previousCwd, newCwd });
      return { success: true, previousCwd };
    } catch (error) {
      return { success: false, reason: `cwd_change_failed: ${(error as Error).message}` };
    }
  }

  /**
   * Apply staged runtime mutations before dispatching the next user turn.
   *
   * Staged changes are accepted while a turn is active, but they must not touch
   * the live connector until the next turn boundary. The turn executor calls
   * this before handing a new message to the connector, when the connector is
   * expected to be idle.
   */
  public async applyStagedMutations(): Promise<void> {
    const connector = this.getConnector();
    if (connector.getProcessingState() !== 'idle') return;

    const stagedModelChange = this.stagedModelChange;
    if (stagedModelChange !== undefined) {
      this.stagedModelChange = undefined;
      const result = await this.handleModelChange(stagedModelChange);
      if (!result.success) {
        throw new Error(`Failed to apply staged model change: ${result.reason ?? 'unknown error'}`);
      }
    }

    await this.mcpServersMutationManager.applyStagedMutation();
  }

  /**
   * Handle `agent.mcp.servers.set` request.
   * @param payload - MCP server replacement request payload
   * @returns MCP mutation response payload
   */
  public async handleMcpServersSet(
    payload: AgentMcpServersSetRequestPayload,
  ): Promise<AgentMcpServersSetResponsePayload> {
    return this.mcpServersMutationManager.handleMcpServersSet(payload);
  }

  /**
   * Handle `agent.model.change` request.
   *
   * Implements a four-branch decision tree based on the presence of `newModel`
   * and `reasoningEffort` in the request payload:
   *
   * - Both present   → change model, then apply reasoningEffort (with fallback)
   * - Model only     → change model, run fallback chain for reasoning
   * - Effort only    → change reasoning in-place, no model swap logic
   * - Neither        → no-op (return current state)
   * @param payload - Model change request payload
   * @returns Model mutation response payload
   */
  public async handleModelChange(payload: AgentModelChangeRequestPayload): Promise<AgentModelChangeResponsePayload> {
    const connector = this.getConnector();
    const { newModel: rawNewModel, reasoningEffort, skipWarning } = payload;
    // Cast is safe: zod validated the incoming payload, so credentialRefs values
    // are genuine CredentialRef-branded strings. Zod loses the brand when inferring
    // through union schemas, so we restore it here with a single-step cast.
    const providerContext = payload.providerContext as ProviderContext | undefined;
    const currentModel = connector.model;
    const previousReasoningEffort = connector.currentReasoningEffort;
    const currentProviderContext = this.getProviderContext();
    const isProviderChange = this.hasProviderContextChanged(currentProviderContext, providerContext);

    if (!rawNewModel && !reasoningEffort && !isProviderChange) {
      return { success: true, swapped: false };
    }

    if (connector.getProcessingState() !== 'idle') {
      if (payload.turnActiveBehavior === 'stageForNextTurn') {
        this.stagedModelChange = { ...payload, turnActiveBehavior: 'reject' };
        return {
          success: true,
          swapped: false,
          staged: true,
          ...(rawNewModel !== undefined && { model: rawNewModel }),
        };
      }
      return { success: false, reason: 'turn_active' };
    }

    if (!rawNewModel && !isProviderChange) {
      return this.handleReasoningOnlyChange(connector, currentModel, previousReasoningEffort, reasoningEffort!);
    }

    const newModel = rawNewModel ?? currentModel;
    if (currentModel === newModel && !isProviderChange) {
      if (reasoningEffort !== undefined) {
        return this.handleReasoningOnlyChange(connector, currentModel, previousReasoningEffort, reasoningEffort);
      }
      return { success: true, swapped: false };
    }

    return this.handleModelSwap({
      connector,
      currentModel,
      newModel,
      reasoningEffort,
      previousReasoningEffort,
      providerContext,
      isProviderChange,
      skipWarning,
    });
  }

  /**
   * Apply an in-place reasoning-effort change when no model swap is requested.
   * @param connector - The active connector
   * @param currentModel - Current model identifier
   * @param previousReasoningEffort - Reasoning effort before this change
   * @param reasoningEffort - Requested effort level
   * @returns Model mutation response payload
   */
  private async handleReasoningOnlyChange(
    connector: AIAgentConnector,
    currentModel: string,
    previousReasoningEffort: AIReasoningLevel | undefined,
    reasoningEffort: AIReasoningLevel,
  ): Promise<AgentModelChangeResponsePayload> {
    if (connector.getProcessingState() !== 'idle') {
      return { success: false, reason: 'turn_active' };
    }
    try {
      const changedInPlace = await connector.changeReasoningInPlace(reasoningEffort).catch(() => false);

      if (!changedInPlace) {
        // Connector cannot apply reasoning in-place; fall through to a swap so
        // connector state and in-memory state remain consistent.
        await this.swapConnector({ model: connector.model });
      }

      // After a successful in-place change or swap, validate the requested
      // effort against the new connector's supported levels. The swap may
      // have replaced the connector with one that has different capabilities,
      // so we must not blindly assign without going through the fallback chain.
      const newConnector = this.getConnector();
      const resolvedEffort = this.resolveReasoningEffort(
        reasoningEffort,
        previousReasoningEffort,
        newConnector.supportedReasoningLevels,
      );
      newConnector.currentReasoningEffort = resolvedEffort;
      this.setReasoningEffort(resolvedEffort);

      await this.emitModelChanged({
        previousModel: currentModel,
        newModel: currentModel,
        previousReasoningEffort,
        newReasoningEffort: resolvedEffort,
      });
      return {
        success: true,
        swapped: !changedInPlace,
        model: currentModel,
        appliedReasoningEffort: resolvedEffort,
        supportedReasoningLevels: newConnector.supportedReasoningLevels,
      };
    } catch (error) {
      return { success: false, reason: `reasoning_change_failed: ${(error as Error).message}` };
    }
  }

  /**
   * Execute the model-swap path, settling the connector then resolving reasoning.
   *
   * **Fallback chain** for reasoning when the request does not specify an effort level:
   * 1. Previous connector's `currentReasoningEffort` — if supported by the new model
   * 2. `'medium'` — if supported by the new model
   * 3. First key declared in the new model's `supportedReasoningLevels`
   * 4. `undefined` — model does not support reasoning
   * @param options - Swap options bundle
   * @returns Model mutation response payload
   */
  private async handleModelSwap(options: {
    connector: AIAgentConnector;
    currentModel: string;
    newModel: string;
    reasoningEffort: AIReasoningLevel | undefined;
    previousReasoningEffort: AIReasoningLevel | undefined;
    providerContext: ProviderContext | undefined;
    /** True when the incoming providerContext differs from the agent's current provider. */
    isProviderChange: boolean;
    skipWarning: boolean | undefined;
  }): Promise<AgentModelChangeResponsePayload> {
    const {
      connector,
      currentModel,
      newModel,
      reasoningEffort,
      previousReasoningEffort,
      providerContext,
      isProviderChange,
      skipWarning,
    } = options;
    try {
      // A provider switch always forces a connector swap (credentials/endpoint cannot change in-place).
      const changedInPlace = !isProviderChange && (await connector.changeModelInPlace(newModel).catch(() => false));

      if (changedInPlace) {
        connector.model = newModel;
        connector.supportedReasoningLevels = this.resolveSupportedReasoningLevels(newModel);
      } else {
        const warningResponse = await this.confirmConnectorSwap(currentModel, newModel, skipWarning);
        if (!warningResponse.proceed) return warningResponse.result;
        await this.swapConnector({ model: newModel, ...(providerContext && { providerContext }) });
        if (providerContext) this.setProviderContext(providerContext);
        const swappedConnector = this.getConnector();
        swappedConnector.supportedReasoningLevels = this.resolveSupportedReasoningLevels(newModel);
        if (warningResponse.requestEditHistory && this.sessionId) {
          await this.globalBus.emit(SessionSubjects.connectorSwap.editRequested, {
            sessionId: this.sessionId,
            agentId: this.agentId,
            previousModel: currentModel,
            newModel,
          });
        }
      }

      const newConnector = this.getConnector();
      const supportedReasoningLevels = newConnector.supportedReasoningLevels;
      const resolvedEffort = this.resolveReasoningEffort(
        reasoningEffort,
        previousReasoningEffort,
        supportedReasoningLevels,
      );
      newConnector.currentReasoningEffort = resolvedEffort;
      this.setReasoningEffort(resolvedEffort);

      if (resolvedEffort !== undefined) {
        await newConnector.changeReasoningInPlace(resolvedEffort).catch(() => {
          // Best-effort: reasoning failures do not abort the model change.
        });
      }

      const shouldEmitModelChanged = currentModel !== newModel || resolvedEffort !== previousReasoningEffort;
      if (currentModel !== newModel || isProviderChange) {
        await this.persistRuntimeMutation({
          ...(currentModel !== newModel && { model: newModel }),
          ...(isProviderChange && providerContext && { providerConfigId: providerContext.providerConfigId }),
        });
      }
      if (shouldEmitModelChanged) {
        await this.emitModelChanged({
          previousModel: currentModel,
          newModel,
          previousReasoningEffort,
          newReasoningEffort: resolvedEffort,
        });
      }
      return {
        success: true,
        swapped: !changedInPlace,
        model: newModel,
        appliedReasoningEffort: resolvedEffort,
        supportedReasoningLevels,
      };
    } catch (error) {
      return { success: false, reason: `model_change_failed: ${(error as Error).message}` };
    }
  }

  /**
   * Resolve the reasoning effort to apply after a model change.
   *
   * Fallback chain:
   * 1. Requested `effort` — if supported by the new model
   * 2. Previous connector's `currentReasoningEffort` — if supported by the new model
   * 3. `'medium'` — if supported by the new model
   * 4. First key declared in `supportedReasoningLevels`
   * 5. `undefined` — model does not support reasoning
   * @param requestedEffort - Effort level from the change request (may be absent)
   * @param previousEffort - Current connector's reasoning effort before the change
   * @param supportedLevels - Reasoning levels declared by the new model
   * @returns The resolved reasoning level, or `undefined` if unsupported
   */
  private resolveReasoningEffort(
    requestedEffort: AIReasoningLevel | undefined,
    previousEffort: AIReasoningLevel | undefined,
    supportedLevels: ReasoningLevelMap | undefined,
  ): AIReasoningLevel | undefined {
    if (!supportedLevels || Object.keys(supportedLevels).length === 0) {
      return undefined;
    }

    const isSupported = (level: AIReasoningLevel): boolean => level in supportedLevels;

    if (requestedEffort !== undefined && isSupported(requestedEffort)) return requestedEffort;
    if (previousEffort !== undefined && isSupported(previousEffort)) return previousEffort;
    if (isSupported('medium')) return 'medium';

    const firstKey = Object.keys(supportedLevels)[0] as AIReasoningLevel;
    return firstKey;
  }

  /**
   * Confirm a connector swap when the model itself changes.
   *
   * Provider-only swaps skip the dialog because there is no model transition to
   * explain to the user. Model changes retain the existing warning/edit-history
   * workflow.
   * @param currentModel - Active model before the requested swap
   * @param newModel - Requested target model
   * @param skipWarning - Whether trusted callers opted out of the warning UI
   * @returns Proceed/result tuple for the caller
   */
  private async confirmConnectorSwap(
    currentModel: string,
    newModel: string,
    skipWarning: boolean | undefined,
  ): Promise<
    { proceed: true; requestEditHistory: boolean } | { proceed: false; result: AgentModelChangeResponsePayload }
  > {
    if (currentModel === newModel) {
      return { proceed: true, requestEditHistory: false };
    }

    const warningResult = await confirmModelChange({
      bus: this.globalBus,
      agentId: this.agentId,
      currentModel,
      nextModel: newModel,
      skipWarning,
    });
    if (!warningResult.proceed) {
      return { proceed: false, result: { success: false, reason: 'cancelled' } };
    }
    return { proceed: true, requestEditHistory: warningResult.requestEditHistory };
  }

  /**
   * Compare provider contexts using the full public-bus shape.
   *
   * Provider switches are not limited to config identity. Endpoint overrides,
   * credential refs, and env-var mappings all influence connector behaviour, so
   * callers that mutate any of those fields must force a connector rebuild.
   * @param current - Persisted agent provider context
   * @param next - Incoming provider context from the mutation request
   * @returns True when the effective provider configuration changed
   */
  private hasProviderContextChanged(current: ProviderContext | undefined, next: ProviderContext | undefined): boolean {
    if (next === undefined) return false;
    if (current === undefined) return true;

    return (
      current.providerConfigId !== next.providerConfigId ||
      current.definitionId !== next.definitionId ||
      !this.haveEqualStringRecords(current.endpointOverrides, next.endpointOverrides) ||
      !this.haveEqualStringRecords(current.credentialEnvVars, next.credentialEnvVars) ||
      !this.haveEqualStringRecords(current.credentialRefs, next.credentialRefs)
    );
  }

  /**
   * Compare two string-keyed records, treating absent and empty consistently.
   * @param left - First record
   * @param right - Second record
   * @returns True when both records contain the same keys and values
   */
  private haveEqualStringRecords(
    left: Record<string, string> | undefined,
    right: Record<string, string> | undefined,
  ): boolean {
    if (left === right) return true;

    // Treat undefined and empty {} as semantically equivalent (no overrides).
    const leftKeys = left ? Object.keys(left) : [];
    const rightKeys = right ? Object.keys(right) : [];
    if (leftKeys.length !== rightKeys.length) return false;

    // Implicit: if left has key 'a' but right doesn't, right!['a'] returns
    // undefined, failing the === comparison. Explicit hasOwnProperty checks
    // would be clearer but add lines with no behavioral difference.
    return leftKeys.every((key) => left![key] === right![key]);
  }

  /**
   * Handle a credential rotation request.
   *
   * When a turn is active, returns `{ success: false, reason: 'turn_active' }`.
   * Otherwise:
   * 1. Rebuilds provider context from storage (validates providerConfigId)
   * 2. Fires `credential.activate` so extensions prepare native stores
   * 3. Swaps the connector with updated providerContext (forces re-resolution)
   * @param payload - Credential change request payload
   * @returns Success/failure result
   */
  public async handleCredentialChanged(
    payload: AgentCredentialChangeRequestPayload,
  ): Promise<AgentCredentialChangeResponsePayload> {
    // Reject stale credential.change events that target a provider config the
    // agent has already moved away from (e.g. dispatched before a model.change
    // switched providers). Cross-provider swaps go through handleModelChange.
    const currentProviderConfigId = this.getProviderContext()?.providerConfigId;
    if (currentProviderConfigId && currentProviderConfigId !== payload.providerConfigId) {
      return { success: false, reason: 'provider_mismatch' };
    }
    if (!this.credentialChangeSequencer.queue(payload.providerConfigId, payload.changeSequence)) {
      return { success: false, reason: 'stale_change' };
    }
    return this.credentialChangeSequencer.runExclusive(async () => {
      const lockedProviderConfigId = this.getProviderContext()?.providerConfigId;
      if (lockedProviderConfigId && lockedProviderConfigId !== payload.providerConfigId) {
        this.credentialChangeSequencer.release(payload.providerConfigId, payload.changeSequence);
        return { success: false, reason: 'provider_mismatch' };
      }
      if (!this.credentialChangeSequencer.isLatest(payload.providerConfigId, payload.changeSequence)) {
        return { success: false, reason: 'stale_change' };
      }
      const connector = this.getConnector();
      if (connector.getProcessingState() !== 'idle') {
        this.credentialChangeSequencer.release(payload.providerConfigId, payload.changeSequence);
        return { success: false, reason: 'turn_active' };
      }
      // Cast is safe: zod validated the incoming payload, so credentialRefs values
      // are genuine CredentialRef-branded strings. Zod loses the brand when inferring
      // through union schemas, so we restore it here with a single-step cast.
      const credentialRefs = payload.credentialRefs as ProviderContext['credentialRefs'];
      // Build a full context from storage FIRST so we validate the providerConfigId
      // before firing the side-effectful credential.activate hook. This prevents
      // account-manager state mutation for an invalid or deleted config.
      // Then overlay the (possibly rotated) credential refs from the change payload —
      // the stored config may not yet reflect the rotation that triggered this event.
      try {
        const updatedContext = await buildProviderContext(this.globalBus, payload.providerConfigId);
        updatedContext.credentialRefs = credentialRefs;
        if (!this.credentialChangeSequencer.isLatest(payload.providerConfigId, payload.changeSequence)) {
          return { success: false, reason: 'stale_change' };
        }
        await activateProviderContextStrict(this.globalBus, updatedContext);
        if (!this.credentialChangeSequencer.isLatest(payload.providerConfigId, payload.changeSequence)) {
          return { success: false, reason: 'stale_change' };
        }
        if (connector.getProcessingState() !== 'idle') {
          this.credentialChangeSequencer.release(payload.providerConfigId, payload.changeSequence);
          return { success: false, reason: 'turn_active' };
        }
        await this.swapConnector({ providerContext: updatedContext });
        this.setProviderContext(updatedContext);
        this.credentialChangeSequencer.markApplied(payload.providerConfigId, payload.changeSequence);
        await this.persistRuntimeMutation({ providerConfigId: updatedContext.providerConfigId });
        return { success: true, swapped: true };
      } catch (error) {
        this.credentialChangeSequencer.release(payload.providerConfigId, payload.changeSequence);
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, reason: `credential_swap_failed: ${message}` };
      }
    });
  }

  /**
   * Persist runtime field updates to agent storage.
   * @param changes - CWD/model/provider mutations to persist
   */
  private async persistRuntimeMutation(
    changes: Partial<Pick<MakaioSessionAgent, 'cwd' | 'model' | 'providerConfigId'>>,
  ): Promise<void> {
    await this.globalBus.requestOptional(AgentStorageSubjects.updateRuntime, {
      agentId: this.agentId,
      cwd: changes.cwd,
      model: changes.model,
      providerConfigId: changes.providerConfigId,
    });
  }
}
