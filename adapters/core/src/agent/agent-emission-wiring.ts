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
import type { ProviderContext } from '@makaio/contracts';
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
