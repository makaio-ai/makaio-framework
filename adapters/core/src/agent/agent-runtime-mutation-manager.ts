import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionAgent } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import type { AIAgentConnector } from '../connector/index.js';
import { AgentCredentialChangeManager } from './agent-credential-change-manager.js';
import { AgentMcpServersMutationManager } from './agent-mcp-servers-mutation-manager.js';
import { AgentModelMutationManager } from './agent-model-mutation-manager.js';
import { AgentRuntimePersistenceError } from './agent-runtime-persistence-error.js';
import type { AgentRuntimeMutationManagerConfig } from './agent-runtime-mutation-manager-config.js';
import { CredentialChangeSequencer } from './credential-change-sequencer.js';
import type {
  AgentCredentialChangeRequestPayload,
  AgentCredentialChangeResponsePayload,
  AgentCwdChangeRequestPayload,
  AgentCwdChangeResponsePayload,
  AgentMcpServersSetRequestPayload,
  AgentMcpServersSetResponsePayload,
  AgentModelChangeRequestPayload,
  AgentModelChangeResponsePayload,
} from './types.js';

/** Coordinate every runtime mutation through one agent-wide exclusivity seam. */
export class AgentRuntimeMutationManager {
  private readonly agentId: string;
  private readonly globalBus: IMakaioBus;
  private readonly getConnector: () => AIAgentConnector;
  private readonly runExclusive: AgentRuntimeMutationManagerConfig['runExclusive'];
  private readonly swapConnectorUnlocked: AgentRuntimeMutationManagerConfig['swapConnectorUnlocked'];
  private readonly emitCwdChanged: AgentRuntimeMutationManagerConfig['emitCwdChanged'];
  private readonly mcpServersMutationManager: AgentMcpServersMutationManager;
  private readonly modelMutationManager: AgentModelMutationManager;
  private readonly credentialChangeManager: AgentCredentialChangeManager;
  private readonly credentialChangeSequencer = new CredentialChangeSequencer();

  /**
   * Create the agent-level runtime mutation coordinator.
   * @param config - Runtime collaborators and the shared exclusivity function
   */
  public constructor(config: AgentRuntimeMutationManagerConfig) {
    this.agentId = config.agentId;
    this.globalBus = config.globalBus;
    this.getConnector = config.getConnector;
    this.runExclusive = config.runExclusive;
    this.swapConnectorUnlocked = config.swapConnectorUnlocked;
    this.emitCwdChanged = config.emitCwdChanged;
    this.mcpServersMutationManager = new AgentMcpServersMutationManager({
      getConnector: config.getConnector,
      swapConnectorUnlocked: config.swapConnectorUnlocked,
      setMcpSessionContext: config.setMcpSessionContext,
    });
    this.modelMutationManager = new AgentModelMutationManager({
      agentId: config.agentId,
      sessionId: config.sessionId,
      globalBus: config.globalBus,
      getConnector: config.getConnector,
      swapConnectorUnlocked: config.swapConnectorUnlocked,
      emitModelChanged: config.emitModelChanged,
      getProviderContext: config.getProviderContext,
      setProviderContext: config.setProviderContext,
      setReasoningEffort: config.setReasoningEffort,
      resolveSupportedReasoningLevels: config.resolveSupportedReasoningLevels,
      persistRuntimeMutation: (call, changes) => this.persistRuntimeMutation(call, changes),
    });
    this.credentialChangeManager = new AgentCredentialChangeManager({
      globalBus: config.globalBus,
      sequencer: this.credentialChangeSequencer,
      runExclusive: config.runExclusive,
      getConnector: config.getConnector,
      getProviderContext: config.getProviderContext,
      setProviderContext: config.setProviderContext,
      swapConnectorUnlocked: config.swapConnectorUnlocked,
      persistProviderConfigId: (call, providerConfigId) => this.persistRuntimeMutation(call, { providerConfigId }),
    });
  }

  /**
   * Handle `agent.cwd.change` through the shared runtime barrier.
   * @param call - Call context of the `agent.cwd.change` request
   * @param payload - CWD change request payload
   * @returns CWD mutation response payload
   */
  public async handleCwdChange(
    call: CallContext,
    payload: AgentCwdChangeRequestPayload,
  ): Promise<AgentCwdChangeResponsePayload> {
    return this.runExclusive(() => this.handleCwdChangeUnlocked(call, payload));
  }

  /**
   * Apply one CWD change while the agent-wide runtime barrier is held.
   * @param call - Call context of the `agent.cwd.change` request
   * @param payload - CWD change request payload
   * @returns CWD mutation response payload
   */
  private async handleCwdChangeUnlocked(
    call: CallContext,
    payload: AgentCwdChangeRequestPayload,
  ): Promise<AgentCwdChangeResponsePayload> {
    const connector = this.getConnector();
    const { newCwd } = payload;
    if (connector.cwd === newCwd) return { success: true };
    if (connector.getProcessingState() !== 'idle') return { success: false, reason: 'turn_active' };

    const previousCwd = connector.cwd;
    try {
      const changedInPlace = await connector.changeCwdInPlace(newCwd).catch(() => false);
      if (changedInPlace) {
        connector.cwd = newCwd;
      } else {
        await this.swapConnectorUnlocked(call, { cwd: newCwd });
      }
    } catch {
      return { success: false, reason: 'cwd_change_failed: connector_replacement_failed' };
    }

    try {
      await this.persistRuntimeMutation(call, { cwd: newCwd });
    } catch (error) {
      if (error instanceof AgentRuntimePersistenceError) {
        return { success: false, reason: 'cwd_change_committed_persistence_failed' };
      }
      throw error;
    }

    try {
      await this.emitCwdChanged(call, { previousCwd, newCwd });
    } catch {
      return { success: false, reason: 'cwd_change_committed_event_failed' };
    }
    return { success: true, previousCwd };
  }

  /**
   * Apply all staged replacements while the enclosing turn barrier is held.
   * @param call - Call context of the turn dispatch that applies the staged replacements
   */
  private async applyStagedMutationsUnlocked(call: CallContext): Promise<void> {
    if (this.getConnector().getProcessingState() !== 'idle') return;
    await this.modelMutationManager.applyStagedMutation(call);
    await this.mcpServersMutationManager.applyStagedMutation(call);
  }

  /**
   * Serialize staged mutations and the complete turn pre-hook-to-send boundary.
   * @param call - Call context of the turn being dispatched
   * @param dispatch - Turn dispatch work that must observe one connector generation
   * @returns Dispatch result
   */
  public runTurnDispatch<T>(call: CallContext, dispatch: () => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      // Staged collaborators expose unlocked methods specifically for this
      // already-held turn boundary; reacquisition would deadlock the dispatch.
      await this.applyStagedMutationsUnlocked(call);
      return dispatch();
    });
  }

  /**
   * Handle `agent.mcp.servers.set` through the shared runtime barrier.
   * @param call - Call context of the `agent.mcp.servers.set` request
   * @param payload - MCP server replacement request payload
   * @returns MCP mutation response payload
   */
  public async handleMcpServersSet(
    call: CallContext,
    payload: AgentMcpServersSetRequestPayload,
  ): Promise<AgentMcpServersSetResponsePayload> {
    return this.runExclusive(() => this.mcpServersMutationManager.handleMcpServersSet(call, payload));
  }

  /**
   * Handle `agent.model.change` through the shared runtime barrier.
   * @param call - Call context of the `agent.model.change` request
   * @param payload - Model/provider/reasoning mutation request
   * @returns Model mutation response payload
   */
  public async handleModelChange(
    call: CallContext,
    payload: AgentModelChangeRequestPayload,
  ): Promise<AgentModelChangeResponsePayload> {
    return this.runExclusive(() => this.modelMutationManager.handle(call, payload));
  }

  /**
   * Handle credential rotation through the same turn/mutation barrier.
   * @param call - Call context of the `agent.credential.change` request
   * @param payload - Credential change request payload
   * @returns Credential mutation response payload
   */
  public async handleCredentialChanged(
    call: CallContext,
    payload: AgentCredentialChangeRequestPayload,
  ): Promise<AgentCredentialChangeResponsePayload> {
    return this.credentialChangeManager.handle(call, payload);
  }

  /**
   * Persist committed runtime fields and require an affirmative storage result.
   * @param call - Call context of the mutation being persisted
   * @param changes - CWD/model/provider mutations to persist
   */
  private async persistRuntimeMutation(
    call: CallContext,
    changes: Partial<Pick<MakaioSessionAgent, 'cwd' | 'model'>> & { providerConfigId?: string | null },
  ): Promise<void> {
    try {
      const result = await this.globalBus.requestOptional(call, AgentStorageSubjects.updateRuntime, {
        agentId: this.agentId,
        cwd: changes.cwd,
        model: changes.model,
        providerConfigId: changes.providerConfigId,
      });
      if (!result.handled || !result.data.success) throw new AgentRuntimePersistenceError();
    } catch (error) {
      if (error instanceof AgentRuntimePersistenceError) throw error;
      // Storage details stay private; callers only need to know the live state
      // committed while its durable representation did not.
      throw new AgentRuntimePersistenceError();
    }
  }
}
