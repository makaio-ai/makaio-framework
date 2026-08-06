/**
 * Wiring for everything an agent stamps onto its outbound events.
 *
 * Three concerns travel together here because they are all resolved *per
 * emitted event* from live runtime state rather than captured at construction:
 * the agent's identity fields, the analytics metadata defaults (client and
 * provider config, event time), and the provider-session identity enrichment
 * publishes. The last one is the reason they belong in one place: sampling the
 * connector's session identity and recording it on the movement seam are two
 * halves of one rule (see `agent-adapter-session-movement.ts`), and separating
 * them from the emitter they feed is what previously invited a caller to read
 * the raw connector accessor instead.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type ProviderContext } from '@makaio/contracts';
import type { MessageHandle } from '../message-handle/index.js';
import type { AgentPayloadEmitter } from './agent-payload-emitter.js';
import type { MessageLifecycleTracker } from './message-lifecycle-tracker.js';
import { createAgentPayloadEmitter } from './agent-internal-factories.js';
import {
  providerCommittedAdapterSessionId,
  type AdapterSessionConfirmationSource,
  type ConfirmedAdapterSessionTracker,
} from './agent-adapter-session-movement.js';

/**
 * The runtime state emission wiring reads on every emitted event.
 *
 * `AIAgentConfig` satisfies this structurally, so the owning agent hands its own
 * config over: `providerContext` is re-resolved at runtime, and reading it from
 * the live config is what keeps a rotated provider configuration visible to the
 * events emitted after it.
 */
export interface AgentEmissionWiringHost {
  /** Stable agent identifier. */
  readonly agentId: string;
  /** Adapter instance identifier. */
  readonly adapterId: string;
  /** Adapter type name (e.g. `'claude-code'`). */
  readonly adapterName: string;
  /** Owning Makaio session, when the agent runs inside one. */
  readonly sessionId?: string;
  /** Client that owns this agent, when the runtime attributes one. */
  readonly clientId?: string;
  /** Provider configuration state, used as the metadata fallback. */
  readonly providerContext?: ProviderContext;
  /**
   * Whether this agent's provider session is the adapter's to publish yet.
   *
   * Absent means yes; see {@link AgentPayloadEmitterConfig.isProviderKeyPublishable}.
   */
  readonly isProviderKeyPublishable?: () => boolean;
}

/**
 * The connector facts emission wiring samples: its provider-session
 * confirmation state and the provider configuration it runs on.
 */
export type EmissionConnectorSource = AdapterSessionConfirmationSource & {
  /** Provider configuration the connector was created with, when known. */
  readonly providerConfigId?: string;
};

/**
 * Create the payload emitter that enriches and publishes an agent's events.
 * @param input - Bus, live agent state, lifecycle tracker, movement tracker and connector accessor
 * @returns Payload emitter wired to this agent's live runtime state
 */
export function createAgentEmissionWiring(input: {
  /** Global bus the enriched events are published on. */
  globalBus: IMakaioBus;
  /** Live agent state supplying identity and metadata defaults. */
  host: AgentEmissionWiringHost;
  /** Tracker resolving the current message and turn ids. */
  lifecycleTracker: MessageLifecycleTracker;
  /** Owner of the confirmed provider-session identity and the movement seam. */
  adapterSessionTracker: ConfirmedAdapterSessionTracker;
  /** Accessor for the active connector; `undefined` before the first one is created. */
  getConnector: () => EmissionConnectorSource | undefined;
}): AgentPayloadEmitter {
  const { host, adapterSessionTracker, getConnector } = input;
  return createAgentPayloadEmitter({
    globalBus: input.globalBus,
    getAgentContextBase: () => ({
      agentId: host.agentId,
      adapterId: host.adapterId,
      adapterName: host.adapterName,
      sessionId: host.sessionId,
    }),
    lifecycleTracker: input.lifecycleTracker,
    // Enrichment samples the connector on every emitted event, so it must not
    // read the raw accessor: while an armed resume target is still reported as
    // authoritative, the dispatch in flight may already have announced its
    // rotation away from it (see `providerCommittedAdapterSessionId`).
    getConnectorAdapterSessionId: () => {
      const connector = getConnector();
      return connector === undefined ? undefined : providerCommittedAdapterSessionId(connector);
    },
    getLastKnownAdapterSessionId: () => adapterSessionTracker.lastKnownAdapterSessionId,
    setLastKnownAdapterSessionId: (adapterSessionId) => adapterSessionTracker.record(adapterSessionId),
    ...(host.isProviderKeyPublishable !== undefined && {
      isProviderKeyPublishable: host.isProviderKeyPublishable,
    }),
    getEventMetadataDefaults: () => ({
      clientId: host.clientId,
      providerConfigId:
        getConnector()?.providerConfigId ??
        (host.providerContext?.state === 'resolved' ? host.providerContext.providerConfigId : undefined),
      occurredAt: Date.now(),
    }),
  });
}

/**
 * Create the callback every connector generation reports a submitted message
 * through.
 *
 * Emission wiring rather than agent state: it stamps one outbound event from the
 * handle it is given and reads nothing else, which is why the connector lifecycle
 * owner can build a fresh one per generation from the same emitter.
 * @param emitGlobal - Enriched global event emitter
 * @returns Callback publishing `user_message.sent` for a submitted handle
 */
export function createOnMessageSentEmitter(
  emitGlobal: AgentPayloadEmitter['emitGlobal'],
): (handle: MessageHandle) => void {
  return (handle) => {
    // user_message.sent describes the message being submitted, not the
    // executing turn — and it fires before the handle is tracked. Neither
    // enrichment's getCurrentTurnId() (resolves to the still-executing
    // turn) nor any shared tracker field (mutable — overlapping sends
    // overwrite it before a hook-delayed first send emits) is safe here.
    // The handle carries its lifecycle turnId (threaded from
    // agent.sendMessage.turnId at dispatch); requestCorrelation.turnId is
    // deliberately NOT used — it is transport correlation and may exist
    // when no lifecycle turn does, which would leave sent unpaired with
    // acknowledged/completed. The key is set even when undefined so a
    // no-turn submission stays turn-less instead of inheriting the
    // executing turn's id via enrichment.
    void emitGlobal(AgentSubjects.user_message.sent, {
      messageId: handle.messageId,
      content: handle.message,
      deliveryMode: handle.deliveryMode,
      turnId: handle.turnId,
    });
  };
}
