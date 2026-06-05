import {
  type BusBroadcastMessage,
  type BusEventMessage,
  type BusRequestMessage,
  type BusTransport,
  type IMakaioBus,
  type ObservedBusMessage,
  projectSubjectTelemetryFacts,
} from '@makaio/bus-core';
import { SubjectTelemetrySubjects } from '@makaio/contracts';
import type { ShutdownStep } from './boot-phase.js';
import type { UpstreamTelemetryBootOptions } from './boot-types.js';

/**
 * Returned by {@link attachUpstreamTelemetry} after the projected transport is connected
 * and the bus observer is attached.
 */
export interface AttachedUpstreamTelemetry {
  /** Shutdown step that detaches the observer and disconnects the inner transport. */
  readonly shutdown: ShutdownStep;
}

type ExportableObservedMessage = BusEventMessage | BusRequestMessage | BusBroadcastMessage;

const FACT_NAMESPACE = SubjectTelemetrySubjects.fact.$meta.namespace;
const FACT_SUBJECT = SubjectTelemetrySubjects.fact.subject;

/**
 * Decide whether an observed local bus message may be exported upstream.
 * @param bus - Runtime bus whose namespace registry owns routing metadata.
 * @param message - Observed bus message.
 * @returns True when the message is eligible for upstream telemetry export.
 */
function shouldExportObservedMessage(bus: IMakaioBus, message: ObservedBusMessage): boolean {
  if (message.transport !== undefined) {
    return false;
  }
  if (message.localOnly === true) {
    return false;
  }

  const fullSubject = `${message.namespace}.${message.subject}`;
  const registry = bus.getContext().namespaceRegistry;
  return !registry.isLocalSubject(fullSubject) && !registry.isCollectorOnlySubject(fullSubject);
}

/**
 * Convert an observed local bus message into the transport message shape used
 * by the projected telemetry transport.
 * @param message - Observed local bus message.
 * @returns Projectable bus message for telemetry export.
 */
function toExportableMessage(message: ObservedBusMessage): ExportableObservedMessage {
  if (message.type === 'event') {
    return {
      type: 'event',
      namespace: message.namespace,
      subject: message.subject,
      payload: message.payload,
      messageId: message.messageId,
      ...(message.correlationId !== undefined ? { correlationId: message.correlationId } : {}),
    };
  }
  return {
    type: message.type,
    namespace: message.namespace,
    subject: message.subject,
    payload: message.payload,
    messageId: message.messageId,
    correlationId: message.correlationId ?? message.messageId,
  };
}

/**
 * Export one observed local bus message as sanitized telemetry facts.
 * @param transport - Upstream transport that receives `subject-telemetry.fact` events.
 * @param bus - Runtime bus whose namespace registry drives projection.
 * @param machineId - Source machine identifier included in each fact.
 * @param options - Upstream telemetry options, including optional sidecar projector registry.
 * @param message - Observed local bus message.
 */
async function exportTelemetryFacts(
  transport: BusTransport,
  bus: IMakaioBus,
  machineId: string,
  options: UpstreamTelemetryBootOptions,
  message: ObservedBusMessage,
): Promise<void> {
  const projectable = toExportableMessage(message);
  const facts = projectSubjectTelemetryFacts({
    message: projectable,
    direction: 'outbound',
    observedAt: Date.now(),
    machineId,
    namespaceRegistry: bus.getContext().namespaceRegistry,
    projectorRegistry: options.projectorRegistry,
  });

  for (const fact of facts) {
    await transport.send({
      type: 'event',
      namespace: FACT_NAMESPACE,
      subject: FACT_SUBJECT,
      payload: fact,
      messageId: `${projectable.messageId}:telemetry:${fact.factId}`,
      correlationId: projectable.correlationId,
    });
  }
}

/**
 * Attach a projected telemetry exporter to a booted runtime bus.
 *
 * Observed local messages are projected into sanitized `subject-telemetry.fact`
 * events and forwarded upstream. The exporter is driven by
 * {@link IMakaioBus.observeMessages} instead of being registered as a normal
 * bus transport: upstream telemetry is a collector, not an application message
 * peer, and must observe local requests that would not otherwise route through
 * transport dispatch.
 *
 * The raw inner transport is never registered directly on the bus.
 * @param bus - Runtime bus whose namespace registry is used for projection.
 * @param machineId - Source machine identifier included in telemetry facts.
 * @param options - Upstream telemetry boot options.
 * @returns Shutdown hook for boot rollback/shutdown.
 */
export async function attachUpstreamTelemetry(
  bus: IMakaioBus,
  machineId: string,
  options: UpstreamTelemetryBootOptions,
): Promise<AttachedUpstreamTelemetry> {
  const transport = options.transport;

  await transport.connect();

  let disposeObserver: () => void;
  try {
    disposeObserver = bus.observeMessages((message) => {
      if (!shouldExportObservedMessage(bus, message)) {
        return;
      }
      void exportTelemetryFacts(transport, bus, machineId, options, message).catch((error: unknown) => {
        console.error('[upstream-telemetry] Failed to export subject telemetry fact', error);
      });
    });
  } catch (error) {
    await transport.disconnect().catch(() => undefined);
    throw error;
  }

  return {
    shutdown: async () => {
      disposeObserver();
      await transport.disconnect();
    },
  };
}
