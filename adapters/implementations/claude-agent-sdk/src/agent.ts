import {
  ClaudeCodeAgent as ClaudeCodeAgentBase,
  type ClaudeConnectorNamespace,
} from '@makaio/ai-adapters-claude-shared';
import type { AgentStartResult, NormalizedMessageInput, StartAgentOptions } from '@makaio/ai-adapters-core';
import { AgentSubjects, ClientSubjects } from '@makaio/contracts';
import type { MessageInput } from '@makaio/contracts';
import { buildClientSessionBase, emitBestEffort } from '@makaio/subsystem-client';
import { ClaudeSdkConnector } from './connector.js';
import { ClaudeCodeConnectorNamespace } from './namespace/index.js';

/**
 * Claude Code Agent - Concrete agent for the adapter:claude-code namespace.
 *
 * Extends the shared ClaudeCodeAgent base class, providing the
 * namespace-specific subjects seam and Claude Code-specific client observation
 * bridge. Content block handling, tool approval routing, and usage tracking
 * are inherited from the base.
 *
 * Event Flow:
 * - ClaudeSdkConnector emits SDK events to scoped bus (adapter:claude-code.*)
 * - ClaudeCodeAgentBase (base) processes and routes to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 */
export class ClaudeCodeAgent extends ClaudeCodeAgentBase<'adapter:claude-code', ClaudeSdkConnector> {
  private clientSessionObservationsWired = false;
  private lastRuntimeObservationKey?: string;
  private inFlightRuntimeObservationKey?: string;
  private pendingRuntimeObservationRetryKey?: string;

  /**
   * Return the connector namespace subjects for this adapter.
   *
   * Provides the adapter:claude-code subjects to the shared base class
   * so it can subscribe to the correct scoped bus events.
   * @returns Subjects from the adapter:claude-code namespace
   */
  protected getSubjects(): ClaudeConnectorNamespace<'adapter:claude-code'>['subjects'] {
    return ClaudeCodeConnectorNamespace.subjects;
  }

  /**
   * Wire shared Claude agent events, then install stable global observations
   * owned by the concrete agent layer.
   * @param connector - Connector instance to wire.
   */
  protected override wireEvents(connector: ClaudeSdkConnector): void {
    super.wireEvents(connector);
    this.wireClientSessionObservations();
  }

  /**
   * Initialize the agent and publish runtime evidence after the connector has
   * confirmed its adapter session ID.
   * @param options - Optional initialization options.
   * @returns Confirmed adapter session ID, or `undefined` for unconfirmed fork sessions.
   */
  public override async initialize(options?: StartAgentOptions): Promise<string | undefined> {
    const confirmedId = await super.initialize(options);
    this.observeCurrentRuntime();
    return confirmedId;
  }

  /**
   * Start the agent and publish runtime evidence after the initial turn creates
   * or resumes the adapter session.
   * @param message - Initial user message.
   * @param options - Optional start options.
   * @returns Agent start result from the connector.
   */
  public override async start(
    message: NormalizedMessageInput | MessageInput,
    options?: StartAgentOptions,
  ): Promise<AgentStartResult> {
    const result = await super.start(message, options);
    this.observeCurrentRuntime();
    return result;
  }

  /**
   * Build the shared payload base for `client.session.*` observations.
   * @returns Base payload with client ID, source, timestamp, and session IDs.
   */
  private getClientSessionBase() {
    return buildClientSessionBase({
      clientId: this.config.clientId ?? 'claude-code',
      sessionId: this.sessionId,
      adapterSessionId: this.connector?.adapterSessionId,
    });
  }

  /**
   * Wire stable global bus subscriptions for client session observations.
   *
   * These subscriptions are owned by the agent and survive connector swaps.
   */
  private wireClientSessionObservations(): void {
    if (this.clientSessionObservationsWired) {
      return;
    }
    this.clientSessionObservationsWired = true;

    const filteredBus = this.globalBus.withFilter({ agentId: this.agentId });

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.started, () => {
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.started, this.getClientSessionBase());
        });
        this.observeCurrentRuntime();
      }),
    );

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.turn.started, () => {
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.turn.started, this.getClientSessionBase());
        });
      }),
    );

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.turn.completed, () => {
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.turn.completed, this.getClientSessionBase());
        });
      }),
    );

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.user_message.sent, (ctx) => {
        const prompt = ctx.payload.content.message;
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.userPrompt.submitted, {
            ...this.getClientSessionBase(),
            ...(prompt !== undefined && { prompt }),
          });
        });
      }),
    );
  }

  /**
   * Publish best-effort runtime evidence for the current connector session.
   */
  private observeCurrentRuntime(): void {
    const adapterSessionId = this.connector?.adapterSessionId;
    if (!adapterSessionId) {
      return;
    }

    const clientId = this.config.clientId ?? 'claude-code';
    const observationKey = `${clientId}:${this.sessionId ?? ''}:${adapterSessionId}`;
    if (observationKey === this.lastRuntimeObservationKey) {
      return;
    }
    if (observationKey === this.inFlightRuntimeObservationKey) {
      this.pendingRuntimeObservationRetryKey = observationKey;
      return;
    }
    if (this.pendingRuntimeObservationRetryKey !== observationKey) {
      this.pendingRuntimeObservationRetryKey = undefined;
    }
    this.inFlightRuntimeObservationKey = observationKey;

    void this.globalBus
      .requestOptional(ClientSubjects.runtime.observe, {
        clientId,
        source: { layer: 'adapter', producer: 'claude-agent-sdk' },
        observedAt: Date.now(),
        adapterSessionId,
        ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
      })
      .then((result) => {
        if (this.inFlightRuntimeObservationKey !== observationKey) {
          return;
        }

        // The key is reserved before dispatch to collapse rapid lifecycle
        // signals for the same native session. A duplicate signal that arrives
        // while an unhandled request is in flight becomes one pending retry;
        // handled observations keep the key cached and discard the retry.
        if (result?.handled) {
          this.lastRuntimeObservationKey = observationKey;
          this.inFlightRuntimeObservationKey = undefined;
          if (this.pendingRuntimeObservationRetryKey === observationKey) {
            this.pendingRuntimeObservationRetryKey = undefined;
          }
          return;
        }

        this.retryPendingRuntimeObservation(observationKey);
      })
      .catch(() => {
        if (this.inFlightRuntimeObservationKey === observationKey) {
          this.retryPendingRuntimeObservation(observationKey);
        }
      });
  }

  /**
   * Clear an unhandled observation reservation and replay one duplicate
   * lifecycle signal if it arrived while the request was in flight.
   * @param observationKey - Runtime observation key that just settled unhandled.
   */
  private retryPendingRuntimeObservation(observationKey: string): void {
    const shouldRetry = this.pendingRuntimeObservationRetryKey === observationKey;
    this.inFlightRuntimeObservationKey = undefined;
    this.pendingRuntimeObservationRetryKey = undefined;

    if (shouldRetry) {
      this.observeCurrentRuntime();
    }
  }
}
