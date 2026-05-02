import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import type { AgentContext } from './types.js';

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
  /** Async fallback to wait for adapter session ID. */
  getAdapterSessionId: () => Promise<string>;
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
  ): Promise<T & AgentContext & AgentPayloadEventFields> {
    const messageId = overrideMessageId ?? this.config.getCurrentMessageId();
    const turnId = this.config.getCurrentTurnId();
    const payloadEventFields = payload as Partial<AgentPayloadEventFields>;
    const includeEventMetadata = options?.includeEventMetadata ?? true;
    const eventMetadataDefaults = includeEventMetadata ? this.config.getEventMetadataDefaults() : {};
    const adapterSessionId =
      this.config.getConnectorAdapterSessionId() ??
      this.config.getLastKnownAdapterSessionId() ??
      (await this.config.getAdapterSessionId());
    const clientId = includeEventMetadata ? (payloadEventFields.clientId ?? eventMetadataDefaults.clientId) : undefined;
    const providerConfigId = includeEventMetadata
      ? (payloadEventFields.providerConfigId ?? eventMetadataDefaults.providerConfigId)
      : undefined;
    const occurredAt = includeEventMetadata
      ? (payloadEventFields.occurredAt ?? eventMetadataDefaults.occurredAt)
      : undefined;

    this.config.setLastKnownAdapterSessionId(adapterSessionId);

    const base = this.config.getAgentContextBase();
    return {
      ...payload,
      agentId: base.agentId,
      adapterId: base.adapterId,
      adapterName: base.adapterName,
      adapterSessionId,
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
    payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext> & { messageId?: string },
    options?: EmitGlobalOptions,
  ): Promise<void> {
    const enrichedPayload = await this.enrichPayload(payload as object, payload.messageId, options);
    await this.config.globalBus.emit(
      subject as Parameters<IMakaioBus['emit']>[0],
      enrichedPayload as Parameters<IMakaioBus['emit']>[1],
    );
  }
}
