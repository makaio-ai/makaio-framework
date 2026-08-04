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
  /**
   * Persist latest adapterSessionId after resolution.
   *
   * May be asynchronous: the owning agent uses this sink to announce a moved
   * provider identity, and enrichment awaits it so no event carrying the new ID
   * is published before the movement is recorded.
   */
  setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => void | Promise<void>;
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
   * The `lastKnownAdapterSessionId` bridges connector swaps *for stamping only*:
   * when the old connector is gone and the new one is not yet wired, the cached
   * value carries the confirmed ID from the previous connector. The recording
   * sink is deliberately not given that fallback — see the inline note.
   *
   * No async *resolution* fallback is used. `connector.getAdapterSessionId()`
   * may resolve with a provisional placeholder for fork sessions. Enrichment
   * must never stamp unconfirmed IDs — omitting the field is safe since R8
   * schemas allow it optional.
   *
   * The recording sink is awaited even though resolution stays synchronous: it
   * announces a moved provider identity, and that movement must be recorded
   * before this event advertises the new ID. Recording an unchanged ID — the
   * case for all but the first event of a generation — resolves without I/O.
   * @returns Confirmed adapter session ID or `undefined`
   */
  private async resolveConfirmedAdapterSessionId(): Promise<string | undefined> {
    const sample = this.config.getConnectorAdapterSessionId();
    // The sink gets the connector sample alone — never the cached fallback the
    // returned value falls back to. The two answer different questions: stamping
    // needs the best identity to *report*, while the sink is told which identity
    // the agent is *currently on*, and the cache deliberately keeps serving the
    // abandoned identity after a movement left it behind. Passing the fallback
    // in let the tracker re-point an inherited resume target at that abandoned
    // provider thread.
    //
    // Invoked unconditionally, including for an unresolved sample: recording
    // `undefined` leaves the tracker's cache alone but re-drives a parked
    // undelivered movement. Enrichment is the seam's only retry clock, and an
    // agent whose connector confirms nothing is exactly the one whose
    // unconfirmed movement is still outstanding.
    await this.config.setLastKnownAdapterSessionId(sample);
    return sample ?? this.config.getLastKnownAdapterSessionId();
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
    // Key presence, not value, gates the executing-turn fallback: a payload
    // that includes `turnId: undefined` declares itself intentionally
    // turn-less (e.g. user_message.sent for a no-turn submission) and must
    // not inherit the still-executing turn's id.
    const turnId = 'turnId' in payloadEventFields ? payloadEventFields.turnId : this.config.getCurrentTurnId();
    const adapterSessionId = await this.resolveConfirmedAdapterSessionId();
    const { clientId, providerConfigId, occurredAt } = this.resolveEventMetadata(
      payloadEventFields,
      options?.includeEventMetadata ?? true,
    );

    const base = this.config.getAgentContextBase();
    const enriched = {
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
    // An intentionally turn-less payload spreads its `turnId: undefined` key
    // into the result above — drop it so absent fields stay absent, per the
    // emitter contract documented on the base event schema.
    if (turnId === undefined && 'turnId' in enriched) {
      delete (enriched as Record<string, unknown>).turnId;
    }
    return enriched;
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
