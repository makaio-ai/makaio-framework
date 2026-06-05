import { SubjectTelemetrySubjects } from '@makaio/contracts';
import type { BusMessage, BusReceiveHandler, BusTransport, BusTransportError } from '../types/transports.js';
import type { NamespaceRegistry } from '../registries/index.js';
import { projectSubjectTelemetryFacts } from './subject-telemetry-projector.js';
import type { ProjectableBusMessage } from './subject-telemetry-projector.js';
import type { SubjectTelemetryProjectorRegistry } from './projector-registry.js';

/**
 * Configuration options for {@link createProjectedTelemetryTransport}.
 */
export interface ProjectedTelemetryTransportOptions {
  /**
   * Unique name for this transport instance.
   *
   * Must be unique within a single bus instance (used as the registry key).
   */
  readonly name: string;
  /**
   * The underlying transport that receives projected telemetry fact events.
   *
   * All projected facts are forwarded to this transport as
   * `subject-telemetry.fact` events. No raw application payloads are forwarded.
   */
  readonly inner: BusTransport;
  /**
   * Namespace registry used to resolve schemas for attribute projection.
   *
   * Obtain via `bus.getContext().namespaceRegistry`.
   */
  readonly namespaceRegistry: NamespaceRegistry;
  /**
   * Optional sidecar projector registry for namespace-owned attribute extraction.
   *
   * When provided, sidecar projectors registered for a message's namespace and
   * subject take precedence over schema-driven attribute projection.
   */
  readonly projectorRegistry?: SubjectTelemetryProjectorRegistry;
  /**
   * Optional source machine identifier embedded in each projected fact.
   *
   * When omitted, the `machineId` field is absent from emitted facts.
   */
  readonly machineId?: string;
  /**
   * Optional clock override for deterministic testing.
   *
   * When provided, called instead of `Date.now()` to obtain the `observedAt`
   * timestamp for each projected fact. Defaults to `Date.now`.
   * @returns Current Unix timestamp in milliseconds.
   */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const FACT_NAMESPACE = SubjectTelemetrySubjects.fact.$meta.namespace;
const FACT_SUBJECT = SubjectTelemetrySubjects.fact.subject;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Guard for message types that can be projected into telemetry facts.
 *
 * Only outbound application messages — events, requests, and broadcasts —
 * carry meaningful payload context. Transport-level control messages
 * (responses, subscribe, heartbeat, etc.) are either inbound or carry no
 * projectable payload.
 * @param message - Candidate bus message.
 * @returns `true` when the message type is `event`, `request`, or `broadcast`.
 */
function isProjectable(message: BusMessage): message is ProjectableBusMessage {
  return message.type === 'event' || message.type === 'request' || message.type === 'broadcast';
}

/**
 * Project a projectable message and forward each resulting fact to the inner
 * transport as a `subject-telemetry.fact` event.
 * @param inner - The underlying transport to forward facts to.
 * @param message - The projectable outbound bus message.
 * @param namespaceRegistry - Registry for resolving payload schemas.
 * @param projectorRegistry - Optional sidecar projector registry.
 * @param machineId - Optional source machine identifier for each fact.
 * @param now - Clock function for the `observedAt` timestamp.
 */
async function forwardProjectedFacts(
  inner: BusTransport,
  message: ProjectableBusMessage,
  namespaceRegistry: NamespaceRegistry,
  projectorRegistry: SubjectTelemetryProjectorRegistry | undefined,
  machineId: string | undefined,
  now: () => number,
): Promise<void> {
  const facts = projectSubjectTelemetryFacts({
    message,
    direction: 'outbound',
    observedAt: now(),
    machineId,
    namespaceRegistry,
    projectorRegistry,
  });

  for (const fact of facts) {
    await inner.send({
      type: 'event',
      namespace: FACT_NAMESPACE,
      subject: FACT_SUBJECT,
      payload: fact,
      messageId: `${message.messageId}:telemetry:${fact.factId}`,
      correlationId: message.correlationId,
    });
  }
}

/**
 * Build the `send` method for the projected transport.
 *
 * Projectable messages (`event`, `request`, `broadcast`) are projected into
 * telemetry facts and forwarded to the inner transport. Non-projectable
 * messages are silently dropped — this transport is outbound-only and no
 * raw application payload should be relayed upstream.
 * @param inner - The underlying transport.
 * @param namespaceRegistry - Registry for resolving payload schemas.
 * @param projectorRegistry - Optional sidecar projector registry.
 * @param machineId - Optional source machine identifier.
 * @param now - Clock function.
 * @returns A `send` function matching the {@link BusTransport} interface contract.
 */
function buildSend(
  inner: BusTransport,
  namespaceRegistry: NamespaceRegistry,
  projectorRegistry: SubjectTelemetryProjectorRegistry | undefined,
  machineId: string | undefined,
  now: () => number,
): BusTransport['send'] {
  return async function send(message: BusMessage, _timeout?: number): Promise<unknown> {
    if (!isProjectable(message)) {
      // Only project event/request/broadcast. All other message types are silently dropped.
      return true;
    }
    await forwardProjectedFacts(inner, message, namespaceRegistry, projectorRegistry, machineId, now);
    if (message.type === 'request') {
      throw new Error(
        'Projected telemetry transport cannot satisfy request responses; exclude it from request routing.',
      );
    }
    if (message.type === 'broadcast') {
      // broadcast.ts iterates the return value — return an empty array so no
      // remote results are injected into the local broadcast aggregation.
      return [];
    }
    return true;
  } as BusTransport['send'];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a one-way outbound transport that projects bus messages into sanitized
 * {@link SubjectTelemetryFact} events and forwards only those facts upstream.
 *
 * ## Behavior
 *
 * **Outbound (send):**
 * - Projectable messages (`event`, `request`, `broadcast`) are projected into
 *   `subject-telemetry.fact` events via {@link projectSubjectTelemetryFacts}
 *   and forwarded to `inner.send()`. The raw application payload is never
 *   forwarded.
 * - Non-projectable messages (`response`, `subscribe`, `heartbeat`, etc.) are
 *   silently dropped. This transport is strictly outbound; control and response
 *   messages must not be relayed to the upstream collector.
 *
 * **Inbound (onReceive):**
 * - The transport registers a receive handler on `inner` but silently drops all
 *   inbound messages. Control messages (`heartbeat`, `subscribe-ack`,
 *   `subscribe-sync-complete`) are consumed silently. Application messages
 *   arriving from upstream are dropped to prevent raw remote data from
 *   propagating into the local bus.
 *
 * Connection and readiness operations delegate to `inner`. Subscription
 * advertisement is deliberately not forwarded: this transport is telemetry-only
 * and must not make the upstream collector believe it can route application
 * subjects back to this runtime.
 * @param options - Configuration including the inner transport, namespace
 *   registry, optional machine ID, and optional clock override.
 * @returns A {@link BusTransport} that emits only projected telemetry facts.
 */
export function createProjectedTelemetryTransport(options: ProjectedTelemetryTransportOptions): BusTransport {
  const { inner, namespaceRegistry, projectorRegistry, machineId, now = Date.now } = options;

  const transport: BusTransport = {
    name: options.name,

    send: buildSend(inner, namespaceRegistry, projectorRegistry, machineId, now),

    onReceive(_handler: BusReceiveHandler): () => void {
      // Register on inner to participate in lifecycle, but discard all inbound
      // messages — this transport is outbound-only. Control messages
      // (heartbeat, subscribe-ack, subscribe-sync-complete) are silently
      // consumed; application messages from upstream are dropped to prevent
      // raw remote data from entering the local bus.
      return inner.onReceive(async () => {
        // All inbound messages silently dropped.
      });
    },

    connect(): Promise<void> {
      return inner.connect();
    },

    disconnect(): Promise<void> {
      return inner.disconnect();
    },

    subscribe(): Promise<void> {
      return Promise.resolve();
    },

    unsubscribe(): Promise<void> {
      return Promise.resolve();
    },

    get ready(): Promise<void> | undefined {
      return inner.ready;
    },

    get onNewReadySession(): ((promise: Promise<void>) => void) | undefined {
      return inner.onNewReadySession;
    },

    set onNewReadySession(cb: ((promise: Promise<void>) => void) | undefined) {
      inner.onNewReadySession = cb;
    },

    get onConnected(): (() => void) | undefined {
      return inner.onConnected;
    },

    set onConnected(cb: (() => void) | undefined) {
      inner.onConnected = cb;
    },

    get onDisconnected(): (() => void) | undefined {
      return inner.onDisconnected;
    },

    set onDisconnected(cb: (() => void) | undefined) {
      inner.onDisconnected = cb;
    },

    isReady(): boolean {
      return inner.isReady?.() ?? true;
    },

    cancelRequest(correlationId: string, error?: Error): void {
      inner.cancelRequest?.(correlationId, error);
    },

    onBroadcastResults(
      correlationId: string,
      results: ReadonlyArray<{ nodeId: string; payload: unknown }>,
      error?: BusTransportError,
    ): void {
      inner.onBroadcastResults?.(correlationId, results, error);
    },
  };

  // Conditionally wire optional methods that depend on inner's capabilities.
  if (inner.reconnect) {
    transport.reconnect = () => inner.reconnect!();
  }

  return transport;
}
