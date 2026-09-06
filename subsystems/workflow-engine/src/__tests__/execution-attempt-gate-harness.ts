import {
  createBusContext,
  createBusInstance,
  type BusBroadcastMessage,
  type BusMessage,
  type BusReceiveHandler,
  type BusRequestMessage,
  type BusResponseMessage,
  type BusTransport,
  type IMakaioBus,
} from '@makaio/bus-core';
import { ExecutionAttemptNamespace, type WorkflowRunResult } from '@makaio/contracts';
import type { TransportReceiveContext } from '@makaio/core';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import {
  createInMemoryAttemptRepository,
  allocateTestAttempt,
  workflowRunResultOutcomeCodec,
  type InMemoryAttemptRepository,
} from '../testing/index.js';

/**
 * Transport fixture that injects authenticated remote requests.
 *
 * Both authority gates take `executionId` from the authenticated peer and
 * refuse a caller that has none, so a gate cannot be exercised through a local
 * `bus.request`. This transport is the smallest thing that supplies a real
 * receive context: it hands a request to the bus's own receive handler and
 * records the response the bus sends back.
 */
export class AttemptGateTransport implements BusTransport {
  public readonly name = 'remote-execution-attempt';
  public readonly messages: BusMessage[] = [];
  private handler?: BusReceiveHandler;
  private sequence = 0;

  public send(message: BusRequestMessage): Promise<unknown>;
  public send(message: BusBroadcastMessage): Promise<Array<{ nodeId: string; payload: unknown }>>;
  public send(message: BusMessage): Promise<unknown | boolean | Array<{ nodeId: string; payload: unknown }>>;
  public send(message: BusMessage): Promise<unknown | boolean | Array<{ nodeId: string; payload: unknown }>> {
    if (message.type !== 'subscribe-sync-complete') this.messages.push(message);
    if (message.type === 'broadcast') return Promise.resolve([]);
    return Promise.resolve(true);
  }

  public onReceive(handler: BusReceiveHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async subscribe(): Promise<void> {}
  public async unsubscribe(): Promise<void> {}

  /**
   * Inject one authenticated request and return the response the bus produced.
   * @param namespace - Bus namespace of the subject.
   * @param subject - Subject name within the namespace.
   * @param payload - Request payload.
   * @param peer - Authenticated peer the receiving transport resolved.
   * @returns The response message the bus sent back.
   * @throws When the bus produced no response for the request.
   */
  public async requestAs(
    namespace: string,
    subject: string,
    payload: unknown,
    peer: TransportReceiveContext['peer'],
  ): Promise<BusResponseMessage> {
    this.sequence += 1;
    const correlationId = `attempt-gate-${this.sequence}`;
    await this.handler?.(
      { type: 'request', namespace, subject, payload, correlationId, messageId: `msg-${correlationId}` },
      { transportName: this.name, peer },
    );
    const response = this.messages.find(
      (message): message is BusResponseMessage =>
        message.type === 'response' && message.correlationId === correlationId,
    );
    if (!response) throw new Error(`No response was produced for '${namespace}.${subject}'`);
    return response;
  }
}

/**
 * Build the authenticated peer of one execution attempt.
 * @param executionAttemptId - Attempt the peer is bound to.
 * @param executionId - Authority-issued execution claim the peer carries.
 * @returns A receive-context peer of kind `workflow-execution-attempt`.
 */
export function attemptPeer(executionAttemptId: string, executionId: string): TransportReceiveContext['peer'] {
  return {
    kind: 'workflow-execution-attempt',
    id: executionAttemptId,
    authenticated: true,
    claims: { executionId },
  };
}

/** Bus, authority, repository, and transport one gate test runs against. */
export interface AttemptGateHarness {
  /** Bus the gate handlers are registered on. */
  readonly bus: IMakaioBus;
  /** Authority wrapping {@link repository}. */
  readonly authority: ExecutionAttemptAuthority<WorkflowRunResult>;
  /** Reference in-memory realization of the attempt port. */
  readonly repository: InMemoryAttemptRepository<WorkflowRunResult>;
  /** Transport that injects authenticated requests into {@link bus}. */
  readonly transport: AttemptGateTransport;
}

/**
 * Build an isolated bus with the ExecutionAttempt namespace and an authority.
 *
 * A fresh bus instance rather than the process-wide `MakaioBus`, so the probe
 * responders and readiness listeners of one case cannot reach another.
 * @returns The harness the gate tests drive.
 */
export function createAttemptGateHarness(): AttemptGateHarness {
  const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
  const authority = new ExecutionAttemptAuthority(repository);
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespace(ExecutionAttemptNamespace);
  const transport = new AttemptGateTransport();
  bus.registerTransport(transport);
  return { bus, authority, repository, transport };
}

/**
 * Drive one attempt to `allocated`, the state a runtime may register against.
 * @param harness - Gate harness owning the repository.
 * @param executionId - Owner the attempt belongs to.
 * @returns The allocated attempt's identifier.
 * @throws When provisioning does not start or the allocation is not recorded.
 */
export async function allocateAttempt(harness: AttemptGateHarness, executionId: string): Promise<string> {
  return allocateTestAttempt(harness.authority, executionId);
}
