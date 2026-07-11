import type { IMakaioBus } from '@makaio/bus-core';
import {
  ProviderContextSchema,
  SessionSubjects,
  type AIReasoningLevel,
  type ProviderContext,
  type ReasoningLevelMap,
} from '@makaio/contracts';
import {
  ProviderContextActivationError,
  ProviderContextActivationRollbackError,
} from '@makaio/services-core/provider-context';
import type { AIAgentConnector } from '../connector/index.js';
import { providerContextsEqual } from '../config/provider-context-equality.js';
import { AgentProviderContextActivation } from './agent-provider-context-activation.js';
import { AgentRuntimePersistenceError } from './agent-runtime-persistence-error.js';
import type { AgentRuntimeMutationManagerConfig } from './agent-runtime-mutation-manager-config.js';
import { confirmModelChange } from './model-change-warning.js';
import type { AgentModelChangeRequestPayload, AgentModelChangeResponsePayload } from './types.js';

interface ModelSwapOptions {
  readonly connector: AIAgentConnector;
  readonly currentModel: string;
  readonly newModel: string;
  readonly reasoningEffort: AIReasoningLevel | undefined;
  readonly previousReasoningEffort: AIReasoningLevel | undefined;
  readonly providerContext: ProviderContext | undefined;
  readonly isProviderChange: boolean;
  readonly skipWarning: boolean | undefined;
}

/** Dependencies for model, provider, and reasoning runtime mutations. */
export interface AgentModelMutationManagerConfig {
  /** Stable agent identifier. */
  readonly agentId: string;
  /** Optional owning session for edit-history events. */
  readonly sessionId?: string;
  /** Global bus for activation, confirmation, and public events. */
  readonly globalBus: IMakaioBus;
  /** Read the active connector generation. */
  readonly getConnector: () => AIAgentConnector;
  /** Replace the connector while the caller owns the runtime barrier. */
  readonly swapConnectorUnlocked: AgentRuntimeMutationManagerConfig['swapConnectorUnlocked'];
  /** Emit the normalized model-changed event. */
  readonly emitModelChanged: AgentRuntimeMutationManagerConfig['emitModelChanged'];
  /** Read the current provider context. */
  readonly getProviderContext: () => ProviderContext | undefined;
  /** Publish the committed provider context in agent memory. */
  readonly setProviderContext: (providerContext: ProviderContext) => void;
  /** Publish the committed reasoning effort in agent memory. */
  readonly setReasoningEffort: (reasoningEffort: AIReasoningLevel | undefined) => void;
  /** Resolve model-supported reasoning levels. */
  readonly resolveSupportedReasoningLevels: (model: string) => ReasoningLevelMap | undefined;
  /** Durably persist committed model/provider fields. */
  readonly persistRuntimeMutation: (changes: { model?: string; providerConfigId?: string | null }) => Promise<void>;
}

/** Own model, provider, and reasoning mutations inside the agent-wide runtime barrier. */
export class AgentModelMutationManager {
  private stagedModelChange?: AgentModelChangeRequestPayload;

  /**
   * Create a model/provider mutation collaborator.
   * @param config - Runtime dependencies owned by the parent mutation manager
   */
  public constructor(private readonly config: AgentModelMutationManagerConfig) {}

  /** Apply the latest staged model mutation while the enclosing turn lock is held. */
  public async applyStagedMutation(): Promise<void> {
    const connector = this.config.getConnector();
    if (connector.getProcessingState() !== 'idle') return;

    const staged = this.stagedModelChange;
    if (staged === undefined) return;
    this.stagedModelChange = undefined;
    const result = await this.handle(staged);
    if (!result.success) {
      throw new Error(`Failed to apply staged model change: ${result.reason ?? 'unknown error'}`);
    }
  }

  /**
   * Apply a model/provider/reasoning request while the caller owns the runtime barrier.
   * @param payload - Model change request payload
   * @returns Model mutation response payload
   */
  public async handle(payload: AgentModelChangeRequestPayload): Promise<AgentModelChangeResponsePayload> {
    const connector = this.config.getConnector();
    const { newModel: rawNewModel, reasoningEffort, skipWarning } = payload;
    const providerContext =
      payload.providerContext === undefined ? undefined : ProviderContextSchema.parse(payload.providerContext);
    const currentModel = connector.model;
    const previousReasoningEffort = connector.currentReasoningEffort;
    const isProviderChange = this.hasProviderContextChanged(this.config.getProviderContext(), providerContext);

    if (rawNewModel === undefined && reasoningEffort === undefined && !isProviderChange) {
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

    if (rawNewModel === undefined && !isProviderChange) {
      if (reasoningEffort === undefined) return { success: true, swapped: false };
      return this.handleReasoningOnlyChange(connector, currentModel, previousReasoningEffort, reasoningEffort);
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
   * Apply an in-place reasoning-effort change or replace the connector.
   * @param connector - Connector generation observed at mutation ingress
   * @param currentModel - Model that remains active during this reasoning-only change
   * @param previousReasoningEffort - Effort active before the mutation
   * @param reasoningEffort - Requested effort
   * @returns Reasoning mutation response
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
    // Resolve before the swap so a replacement generation is constructed with
    // its target effort; adapters may consume reasoning only at start.
    const resolvedEffort = this.resolveReasoningEffort(
      reasoningEffort,
      previousReasoningEffort,
      connector.supportedReasoningLevels,
    );
    let changedInPlace: boolean;
    try {
      changedInPlace = await connector.changeReasoningInPlace(reasoningEffort).catch(() => false);
      if (!changedInPlace) {
        await this.config.swapConnectorUnlocked({ model: connector.model, reasoningEffort: resolvedEffort });
      }
    } catch {
      return { success: false, reason: 'reasoning_change_failed: connector_mutation_failed' };
    }

    const newConnector = this.config.getConnector();
    try {
      newConnector.currentReasoningEffort = resolvedEffort;
      this.config.setReasoningEffort(resolvedEffort);
    } catch {
      return { success: false, reason: 'reasoning_change_committed_postprocess_failed' };
    }

    try {
      await this.config.emitModelChanged({
        previousModel: currentModel,
        newModel: currentModel,
        previousReasoningEffort,
        newReasoningEffort: resolvedEffort,
      });
    } catch {
      return { success: false, reason: 'reasoning_change_committed_event_failed' };
    }
    return {
      success: true,
      swapped: !changedInPlace,
      model: currentModel,
      appliedReasoningEffort: resolvedEffort,
      supportedReasoningLevels: newConnector.supportedReasoningLevels,
    };
  }

  /**
   * Replace a model/provider connector and then finalize its committed state.
   * @param options - Complete model/provider swap inputs
   * @returns Model mutation response
   */
  private async handleModelSwap(options: ModelSwapOptions): Promise<AgentModelChangeResponsePayload> {
    const { connector, currentModel, newModel, providerContext, isProviderChange, skipWarning } = options;
    const changedInPlace = !isProviderChange && (await connector.changeModelInPlace(newModel).catch(() => false));
    let requestEditHistory = false;

    if (changedInPlace) {
      connector.model = newModel;
    } else {
      try {
        const warningResponse = await this.confirmConnectorSwap(currentModel, newModel, skipWarning);
        if (!warningResponse.proceed) return warningResponse.result;
        requestEditHistory = warningResponse.requestEditHistory;
      } catch (error) {
        return { success: false, reason: modelMutationFailureReason(error) };
      }

      let activation: AgentProviderContextActivation | undefined;
      try {
        if (isProviderChange && providerContext !== undefined) {
          activation = await AgentProviderContextActivation.prepare(this.config.globalBus, providerContext);
        }
        await this.config.swapConnectorUnlocked(
          {
            model: newModel,
            // Construct the replacement with the effort finalizeModelSwap will
            // commit, so construction-time reasoning consumers see it too.
            reasoningEffort: this.resolveReasoningEffort(
              options.reasoningEffort,
              options.previousReasoningEffort,
              this.config.resolveSupportedReasoningLevels(newModel),
            ),
            ...(providerContext && { providerContext }),
          },
          async () => activation?.commit(),
        );
      } catch (error) {
        if (activation !== undefined) {
          try {
            await activation.rollbackPending();
          } catch (rollbackError) {
            const sanitizedPrimary = new Error('Model/provider connector replacement failed.');
            throw new AggregateError(
              [sanitizedPrimary, rollbackError],
              'Model/provider replacement and account activation rollback both failed.',
              { cause: sanitizedPrimary },
            );
          }
        }
        if (error instanceof ProviderContextActivationRollbackError) {
          throw new AggregateError(
            [new Error('Model/provider account activation commit failed.'), error],
            'Model/provider account activation commit and rollback both failed.',
          );
        }
        return { success: false, reason: modelMutationFailureReason(error) };
      }
    }

    try {
      return await this.finalizeModelSwap(options, changedInPlace, requestEditHistory);
    } catch (error) {
      return {
        success: false,
        reason:
          error instanceof AgentRuntimePersistenceError
            ? 'model_change_committed_persistence_failed'
            : 'model_change_committed_postprocess_failed',
      };
    }
  }

  /**
   * Apply reasoning, durable persistence, and public events after connector commit.
   * @param options - Original model/provider swap inputs
   * @param changedInPlace - Whether the current connector changed its model directly
   * @param requestEditHistory - Whether post-commit history editing was requested
   * @returns Successful committed model mutation response
   */
  private async finalizeModelSwap(
    options: ModelSwapOptions,
    changedInPlace: boolean,
    requestEditHistory: boolean,
  ): Promise<AgentModelChangeResponsePayload> {
    const { currentModel, newModel, reasoningEffort, previousReasoningEffort, providerContext, isProviderChange } =
      options;
    const connector = this.config.getConnector();
    if (providerContext !== undefined && isProviderChange) {
      this.config.setProviderContext(providerContext);
    }
    connector.supportedReasoningLevels = this.config.resolveSupportedReasoningLevels(newModel);
    const supportedReasoningLevels = connector.supportedReasoningLevels;
    const resolvedEffort = this.resolveReasoningEffort(
      reasoningEffort,
      previousReasoningEffort,
      supportedReasoningLevels,
    );
    connector.currentReasoningEffort = resolvedEffort;
    this.config.setReasoningEffort(resolvedEffort);
    if (resolvedEffort !== undefined) {
      await connector.changeReasoningInPlace(resolvedEffort).catch(() => undefined);
    }

    const persistedProviderConfigId =
      isProviderChange && providerContext !== undefined
        ? providerContext.state === 'resolved'
          ? providerContext.providerConfigId
          : null
        : undefined;
    if (currentModel !== newModel || persistedProviderConfigId !== undefined) {
      await this.config.persistRuntimeMutation({
        ...(currentModel !== newModel && { model: newModel }),
        ...(persistedProviderConfigId !== undefined && { providerConfigId: persistedProviderConfigId }),
      });
    }
    if (currentModel !== newModel || resolvedEffort !== previousReasoningEffort) {
      await this.config.emitModelChanged({
        previousModel: currentModel,
        newModel,
        previousReasoningEffort,
        newReasoningEffort: resolvedEffort,
      });
    }
    if (requestEditHistory && this.config.sessionId) {
      await this.config.globalBus.emit(SessionSubjects.connectorSwap.editRequested, {
        sessionId: this.config.sessionId,
        agentId: this.config.agentId,
        previousModel: currentModel,
        newModel,
      });
    }
    return {
      success: true,
      swapped: !changedInPlace,
      model: newModel,
      appliedReasoningEffort: resolvedEffort,
      supportedReasoningLevels,
    };
  }

  /**
   * Resolve the requested effort through the current model's fallback chain.
   * @param requestedEffort - Explicit effort requested by the caller
   * @param previousEffort - Effort active on the previous connector
   * @param supportedLevels - Levels supported by the committed model
   * @returns Supported effort or undefined when reasoning is unavailable
   */
  private resolveReasoningEffort(
    requestedEffort: AIReasoningLevel | undefined,
    previousEffort: AIReasoningLevel | undefined,
    supportedLevels: ReasoningLevelMap | undefined,
  ): AIReasoningLevel | undefined {
    if (!supportedLevels || Object.keys(supportedLevels).length === 0) return undefined;
    const isSupported = (level: AIReasoningLevel): boolean => level in supportedLevels;
    if (requestedEffort !== undefined && isSupported(requestedEffort)) return requestedEffort;
    if (previousEffort !== undefined && isSupported(previousEffort)) return previousEffort;
    if (isSupported('medium')) return 'medium';
    return Object.keys(supportedLevels)[0] as AIReasoningLevel;
  }

  /**
   * Confirm a connector replacement when the model identifier changes.
   * @param currentModel - Model active before replacement
   * @param newModel - Requested model
   * @param skipWarning - Whether a trusted caller bypassed confirmation
   * @returns Confirmation decision and optional edit-history request
   */
  private async confirmConnectorSwap(
    currentModel: string,
    newModel: string,
    skipWarning: boolean | undefined,
  ): Promise<
    { proceed: true; requestEditHistory: boolean } | { proceed: false; result: AgentModelChangeResponsePayload }
  > {
    if (currentModel === newModel) return { proceed: true, requestEditHistory: false };
    const warningResult = await confirmModelChange({
      bus: this.config.globalBus,
      agentId: this.config.agentId,
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
   * Compare every provider-context field that influences connector construction.
   * @param current - Provider context currently active
   * @param next - Provider context requested by the mutation
   * @returns Whether connector construction inputs differ
   */
  private hasProviderContextChanged(current: ProviderContext | undefined, next: ProviderContext | undefined): boolean {
    if (next === undefined) return false;
    return !providerContextsEqual(current, next);
  }
}

/**
 * Convert pre-commit model/provider failures into credential-free diagnostics.
 * @param error - Activation, rollback, or connector failure
 * @returns Stable pre-commit failure reason
 */
function modelMutationFailureReason(error: unknown): string {
  if (error instanceof ProviderContextActivationError) {
    return `model_change_failed: provider_activation_${error.code}`;
  }
  if (error instanceof ProviderContextActivationRollbackError) {
    return 'model_change_failed: provider_activation_rollback_failed';
  }
  return 'model_change_failed: connector_replacement_failed';
}
