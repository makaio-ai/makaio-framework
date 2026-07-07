import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import type { AgentContext, AgentIdentity } from './types.js';

interface AgentPayloadEventMetadata {
  clientId?: string;
  providerConfigId?: string;
  occurredAt?: number;
}

interface AgentPayloadEventFields extends AgentPayloadEventMetadata {
  messageId?: string;
  turnId?: string;
  sessionId?: string;
}

interface EmitGlobalOptions {
  includeEventMetadata?: boolean;
}

/**
 * Dependencies for AgentPayloadEmitter.
 */
export interface AgentPayloadEmitterConfig {
  /** Global bus for outbound emissions. */
  globalBus: IMakaioBus;
  /** Stable agent identity fields. */
  getAgentContextBase: () => Pick<AgentContext, 'agentId' | 'adapterId' | 'adapterName'> & {
    sessionId?: string;
  };
  /** Current messageId from lifecycle tracker, if any. */
  getCurrentMessageId: () => string | undefined;
  /** Current turnId from lifecycle tracker, if any. */
  getCurrentTurnId: () => string | undefined;
  /** Connector adapterSessionId, if currently available. */
  getConnectorAdapterSessionId: () => string | undefined;
  /** Last known adapterSessionId cached across connector swaps. */
  getLastKnownAdapterSessionId: () => string | undefined;
  /** Persist latest adapterSessionId after resolution. */
  setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => void;
  /** Live event metadata defaults resolved from current runtime state. */
  getEventMetadataDefaults: () => AgentPayloadEventMetadata;
}

/**
 * Handles agent context enrichment and global bus emissions.
 */
export class AgentPayloadEmitter {
  private readonly config: AgentPayloadEmitterConfig;

  /**
   * Create a payload emitter with context resolution dependencies.
   * @param config - Config controlling agent-context enrichment and global emissions
   */
  public constructor(config: AgentPayloadEmitterConfig) {
    this.config = config;
  }

  /**
   * Resolve the confirmed adapter session ID from synchronous sources.
   *
   * `getConnectorAdapterSessionId` delegates to `getConfirmedAdapterSessionId()`
   * which returns `undefined` for unconfirmed fork sessions — the provider has
   * not yet assigned the child session ID. For non-fork sessions (fresh, resume,
   * non-Claude adapters) the locally-determined ID is authoritative and returned
   * immediately.
   *
   * The `lastKnownAdapterSessionId` bridges connector swaps: when the old
   * connector is gone and the new one is not yet wired, the cached value carries
   * the confirmed ID from the previous connector.
   *
   * No async fallback is used. `connector.getAdapterSessionId()` may resolve
   * with a provisional placeholder for fork sessions. Enrichment must never
   * stamp unconfirmed IDs — omitting the field is safe since R8 schemas allow
   * it optional.
   * @returns Confirmed adapter session ID or `undefined`
   */
  private resolveConfirmedAdapterSessionId(): string | undefined {
    const id = this.config.getConnectorAdapterSessionId() ?? this.config.getLastKnownAdapterSessionId();
    if (id !== undefined) {
      this.config.setLastKnownAdapterSessionId(id);
    }
    return id;
  }

  /**
   * Resolve event metadata fields, merging caller-provided values over live defaults.
   * @param payload - Payload fields that may carry metadata overrides
   * @param includeMetadata - Whether to include analytics metadata at all
   * @returns Resolved metadata fields
   */
  private resolveEventMetadata(
    payload: Partial<AgentPayloadEventMetadata>,
    includeMetadata: boolean,
  ): AgentPayloadEventMetadata {
    if (!includeMetadata) return {};
    const defaults = this.config.getEventMetadataDefaults();
    return {
      clientId: payload.clientId ?? defaults.clientId,
      providerConfigId: payload.providerConfigId ?? defaults.providerConfigId,
      occurredAt: payload.occurredAt ?? defaults.occurredAt,
    };
  }

  /**
   * Enrich payload with agent context fields.
   * @param payload - Base payload to enrich
   * @param overrideMessageId - Explicit messageId override from caller payload
   * @param options - Enrichment controls for optional analytics metadata defaults
   * @returns Enriched payload with agent context
   */
  public async enrichPayload<T extends object>(
    payload: T,
    overrideMessageId?: string,
    options?: EmitGlobalOptions,
  ): Promise<T & AgentIdentity & AgentPayloadEventFields> {
    const payloadEventFields = payload as Partial<AgentPayloadEventFields>;
    const messageId = overrideMessageId ?? this.config.getCurrentMessageId();
    const turnId = payloadEventFields.turnId ?? this.config.getCurrentTurnId();
    const adapterSessionId = this.resolveConfirmedAdapterSessionId();
    const { clientId, providerConfigId, occurredAt } = this.resolveEventMetadata(
      payloadEventFields,
      options?.includeEventMetadata ?? true,
    );

    const base = this.config.getAgentContextBase();
    return {
      ...payload,
      agentId: base.agentId,
      adapterId: base.adapterId,
      adapterName: base.adapterName,
      ...(adapterSessionId !== undefined && { adapterSessionId }),
      ...(messageId !== undefined && { messageId }),
      ...(turnId !== undefined && { turnId }),
      ...(base.sessionId !== undefined && { sessionId: base.sessionId }),
      ...(clientId !== undefined && { clientId }),
      ...(providerConfigId !== undefined && { providerConfigId }),
      ...(occurredAt !== undefined && { occurredAt }),
    };
  }

  /**
   * Emit enriched payload to global bus.
   * @param subject - Subject definition to emit
   * @param payload - Payload without AgentContext fields
   * @param options - Enrichment controls for optional analytics metadata defaults
   */
  public async emitGlobal<S extends SubjectDefinition>(
    subject: S,
    payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext> & { messageId?: string; turnId?: string },
    options?: EmitGlobalOptions,
  ): Promise<void> {
    const enrichedPayload = await this.enrichPayload(payload as object, payload.messageId, options);
    await this.config.globalBus.emit(
      subject as Parameters<IMakaioBus['emit']>[0],
      enrichedPayload as Parameters<IMakaioBus['emit']>[1],
    );
  }
}
