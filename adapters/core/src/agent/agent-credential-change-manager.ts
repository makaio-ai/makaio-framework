import { ResolvedProviderContextSchema, type ProviderContext } from '@makaio/contracts';
import {
  ProviderContextActivationError,
  ProviderContextActivationRollbackError,
} from '@makaio/services-core/provider-context';
import type { IMakaioBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../connector/index.js';
import type { AgentRuntimeMutationManagerConfig } from './agent-runtime-mutation-manager-config.js';
import type { AgentCredentialChangeRequestPayload, AgentCredentialChangeResponsePayload } from './types.js';
import type { CredentialChangeSequencer } from './credential-change-sequencer.js';
import { AgentProviderContextActivation } from './agent-provider-context-activation.js';
import { AgentRuntimePersistenceError } from './agent-runtime-persistence-error.js';

type CredentialChangeGuardReason = 'stale_change' | 'turn_active';

/** Dependencies for the credential-change transaction lifecycle. */
export interface AgentCredentialChangeManagerConfig {
  /** Global bus used to activate provider accounts. */
  readonly globalBus: IMakaioBus;
  /** Monotonic sequence owner for provider credential notifications. */
  readonly sequencer: CredentialChangeSequencer;
  /** Agent-wide connector mutation exclusivity boundary. */
  readonly runExclusive: <T>(action: () => Promise<T>) => Promise<T>;
  /** Read the active connector generation. */
  readonly getConnector: () => AIAgentConnector;
  /** Read the agent's current provider context. */
  readonly getProviderContext: () => ProviderContext | undefined;
  /** Commit the new provider context to agent memory. */
  readonly setProviderContext: (providerContext: ProviderContext) => void;
  /** Replace the connector while preserving lifecycle rollback. */
  readonly swapConnectorUnlocked: AgentRuntimeMutationManagerConfig['swapConnectorUnlocked'];
  /** Persist the selected provider config after connector commit. */
  readonly persistProviderConfigId: (providerConfigId: string) => Promise<void>;
}

/** Internal control-flow signal for a failed final credential-change guard. */
class CredentialChangeGuardError extends Error {
  public constructor(public readonly reason: CredentialChangeGuardReason) {
    super(`Credential change guard rejected (${reason}).`);
    this.name = 'CredentialChangeGuardError';
  }
}

/** Own the account-activation and connector-swap credential transaction. */
export class AgentCredentialChangeManager {
  /**
   * Create the credential mutation collaborator.
   * @param config - Credential sequence, activation, swap, and persistence dependencies
   */
  public constructor(private readonly config: AgentCredentialChangeManagerConfig) {}

  /**
   * Queue and apply a schema-validated credential rotation snapshot.
   * @param payload - Credential change request payload
   * @returns Credential mutation result
   */
  public async handle(payload: AgentCredentialChangeRequestPayload): Promise<AgentCredentialChangeResponsePayload> {
    const nextProviderContext = ResolvedProviderContextSchema.parse(payload.providerContext);
    const providerConfigId = nextProviderContext.providerConfigId;
    if (this.hasProviderMismatch(providerConfigId)) {
      return { success: false, reason: 'provider_mismatch' };
    }
    if (!this.config.sequencer.queue(providerConfigId, payload.changeSequence)) {
      return { success: false, reason: 'stale_change' };
    }
    return this.config.runExclusive(() => this.applyQueuedChange(nextProviderContext, payload.changeSequence));
  }

  /**
   * Apply one queued change while holding the turn-dispatch barrier.
   * @param nextProviderContext - Canonical provider context to activate
   * @param changeSequence - Monotonic credential change sequence
   * @returns Credential mutation result
   */
  private async applyQueuedChange(
    nextProviderContext: ReturnType<typeof ResolvedProviderContextSchema.parse>,
    changeSequence: number,
  ): Promise<AgentCredentialChangeResponsePayload> {
    const providerConfigId = nextProviderContext.providerConfigId;
    if (this.hasProviderMismatch(providerConfigId)) {
      this.config.sequencer.release(providerConfigId, changeSequence);
      return { success: false, reason: 'provider_mismatch' };
    }
    if (!this.config.sequencer.isLatest(providerConfigId, changeSequence)) {
      return { success: false, reason: 'stale_change' };
    }
    const connector = this.config.getConnector();
    if (connector.getProcessingState() !== 'idle') {
      this.config.sequencer.release(providerConfigId, changeSequence);
      return { success: false, reason: 'turn_active' };
    }

    let activation: AgentProviderContextActivation | undefined;
    try {
      this.assertGuard(providerConfigId, changeSequence, connector);
      activation = await AgentProviderContextActivation.prepare(this.config.globalBus, nextProviderContext);
      this.assertGuard(providerConfigId, changeSequence, connector);
      await this.config.swapConnectorUnlocked({ providerContext: nextProviderContext }, async () => {
        this.assertGuard(providerConfigId, changeSequence, connector);
        await activation?.commit();
      });
      this.config.setProviderContext(nextProviderContext);
      this.config.sequencer.markApplied(providerConfigId, changeSequence);
      await this.config.persistProviderConfigId(providerConfigId);
      return { success: true, swapped: true };
    } catch (error) {
      this.config.sequencer.release(providerConfigId, changeSequence);
      return this.handleFailure(error, activation);
    }
  }

  /**
   * Roll back pending activation and map failures to credential-free responses.
   * @param error - Failure raised while activating or swapping the connector
   * @param activation - Mutable transaction state for the activation attempt
   * @returns Credential-free mutation failure response
   */
  private async handleFailure(
    error: unknown,
    activation: AgentProviderContextActivation | undefined,
  ): Promise<AgentCredentialChangeResponsePayload> {
    if (activation !== undefined) {
      try {
        await activation.rollbackPending();
      } catch (rollbackError) {
        const sanitizedPrimary = sanitizeCredentialChangeError(error);
        throw new AggregateError(
          [sanitizedPrimary, rollbackError],
          'Credential change and account activation rollback both failed.',
          { cause: sanitizedPrimary },
        );
      }
    }
    if (error instanceof AgentRuntimePersistenceError) {
      // The connector, provider context, and account activation are already
      // committed. Reject with a typed error instead of claiming swap failure.
      throw error;
    }
    if (error instanceof ProviderContextActivationRollbackError) {
      throw new AggregateError(
        [new Error('Credential activation commit failed.'), error],
        'Credential activation commit and rollback both failed.',
      );
    }
    if (error instanceof CredentialChangeGuardError) {
      return { success: false, reason: error.reason };
    }
    return {
      success: false,
      reason:
        error instanceof ProviderContextActivationError
          ? `credential_activation_failed:${error.code}`
          : 'credential_swap_failed',
    };
  }

  /**
   * Check whether the agent has already moved to a different provider config.
   * @param providerConfigId - Provider config targeted by the queued change
   * @returns Whether the active agent now points at another provider config
   */
  private hasProviderMismatch(providerConfigId: string): boolean {
    const current = this.config.getProviderContext();
    return current?.state === 'resolved' && current.providerConfigId !== providerConfigId;
  }

  /**
   * Revalidate sequence ownership and connector idleness at transaction boundaries.
   * @param providerConfigId - Provider config targeted by the transaction
   * @param changeSequence - Sequence that must still own the mutation barrier
   * @param connector - Original connector that must remain idle until commit
   */
  private assertGuard(providerConfigId: string, changeSequence: number, connector: AIAgentConnector): void {
    if (!this.config.sequencer.isLatest(providerConfigId, changeSequence)) {
      throw new CredentialChangeGuardError('stale_change');
    }
    if (connector.getProcessingState() !== 'idle') {
      throw new CredentialChangeGuardError('turn_active');
    }
  }
}

/**
 * Replace arbitrary connector/provider errors with one credential-free aggregate member.
 * @param error - Connector, guard, or account-activation failure to sanitize
 * @returns Credential-free error safe to aggregate across the bus boundary
 */
function sanitizeCredentialChangeError(error: unknown): Error {
  if (error instanceof CredentialChangeGuardError) {
    return new Error(`Credential change rejected (${error.reason}).`);
  }
  if (error instanceof ProviderContextActivationError || error instanceof ProviderContextActivationRollbackError) {
    return new Error('Credential account activation failed.');
  }
  return new Error('Credential connector replacement failed.');
}
