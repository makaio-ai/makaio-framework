import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptBootstrapAwaitStartResponseSchema,
  ExecutionAttemptSubjects,
  type ExecutionAttemptBootstrapStartRefusalReason,
} from '@makaio/contracts';
import { runWorkerBootstrapExchange } from './worker-bootstrap-exchange.js';
import { installOperationDeliveryEndpoint, type OperationDeliveryEndpoint } from './runtime-registration-client.js';

/** Synchronously acquired connection ownership, including an unfinished connect. */
export interface BootstrapRuntimeConnection {
  /** Fresh isolated bus, owned until close or successful transfer. */
  readonly bus: IMakaioBus;
  /**
   * Connect authentication and subscription readiness.
   * @param signal - Cancellation of this pre-registration connection phase.
   */
  connect(signal: AbortSignal): Promise<void>;
  /** Revoke this session, including an unfinished connection. */
  close(): void | Promise<void>;
}

/** Endpoint ownership is acquired during the cancellable connection phase. */
interface BootstrapRuntimeSession {
  readonly connection: BootstrapRuntimeConnection;
  endpoint?: OperationDeliveryEndpoint;
}

/** One surviving authenticated connection whose start permission was granted. */
export interface StartedWorkerRuntime {
  readonly connection: BootstrapRuntimeConnection;
  readonly endpoint: OperationDeliveryEndpoint;
}

/** Durable Attempt identity and provider-specific connection acquisition. */
export interface BootstrapWorkerRuntimeOptions {
  readonly executionAttemptId: string;
  readonly runtimeIncarnationId: string;
  readonly bootstrapDeadlineAt: string;
  readonly signal: AbortSignal;
  readonly createConnection: () => BootstrapRuntimeConnection;
}

/** Explicit Authority refusal: reconnecting cannot turn it into permission. */
export class BootstrapStartRefusedError extends Error {
  /**
   * @param refusalReason - Non-secret refusal from the authoritative start gate.
   */
  public constructor(public readonly refusalReason: ExecutionAttemptBootstrapStartRefusalReason) {
    super(`Worker bootstrap start refused: ${refusalReason}`);
    this.name = 'BootstrapStartRefusedError';
  }
}

/**
 * Install the endpoint and await durable allocation permission before registration.
 * A failed connection and its endpoint are revoked before a fresh session starts.
 * @param options - Attempt budget, identity and synchronous connection factory.
 * @returns The surviving control connection and installed operation endpoint.
 */
export async function bootstrapWorkerRuntime(options: BootstrapWorkerRuntimeOptions): Promise<StartedWorkerRuntime> {
  const { session } = await runWorkerBootstrapExchange({
    bootstrapDeadlineAt: options.bootstrapDeadlineAt,
    signal: options.signal,
    createSession: (): BootstrapRuntimeSession => ({
      connection: options.createConnection(),
    }),
    connect: async (session, signal) => {
      await session.connection.connect(signal);
      signal.throwIfAborted();
      session.endpoint = await installOperationDeliveryEndpoint(session.connection.bus, options, {}, signal);
    },
    exchange: async (session, { signal, timeoutMs }) => {
      const response = ExecutionAttemptBootstrapAwaitStartResponseSchema.parse(
        await session.connection.bus.request(
          ExecutionAttemptSubjects.bootstrap.awaitStart,
          { executionAttemptId: options.executionAttemptId },
          { signal, timeout: timeoutMs },
        ),
      );
      if (response.status === 'refused') throw new BootstrapStartRefusedError(response.reason);
      return response.status === 'pending' ? { status: 'pending' } : { status: 'complete', value: undefined };
    },
    dispose: async (session) => {
      session.endpoint?.cleanup();
      await session.connection.close();
    },
  });
  // Connection completion includes endpoint installation; permission cannot
  // arrive before this ownership handle exists.
  if (session.endpoint === undefined) throw new Error('Bootstrap completed without an operation endpoint');
  return { connection: session.connection, endpoint: session.endpoint };
}
