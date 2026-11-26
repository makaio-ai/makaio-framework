import { callFromReceive } from '@makaio/bus-core/kernel-api';
import { ConnectionExchangeConfigurationError, type ConnectionExchangeSetup } from '@makaio/bus-transport-websocket';
import type { JsonValue, ProviderAllocationRef } from '@makaio/contracts';
import {
  WORKER_EXCHANGE_MAX_BYTES,
  WorkerExchangeRequestSchema,
  type WorkerExchangeReply,
} from '@makaio/contracts/boundary';
import {
  encodeWorkerExchangeReply,
  prepareWorkerRedemption,
  WorkerExchangeReplyTooLargeError,
  WorkerRedemptionError,
  type WorkerRedemptionHost,
} from '@makaio/services-core/internal/worker-provider-host-binding';
import { deepFreeze } from '@makaio/utils';

/** Host policy for the proof presented by a worker. */
export interface WorkerConnectionExchangeOptions {
  /** Maximum unconfirmed exchanges allowed concurrently by this host. */
  readonly maxPendingExchanges: number;
  /** A stricter effective ingress or receiving message limit, when applicable. */
  readonly maxBytes?: number;
  /**
   * Verify proof against the allocation independently established by supervision.
   * @param proof - Parsed evidence from the setup envelope.
   * @param allocation - Provider allocation to which the proof must be bound.
   * @param signal - Both the proof deadline and originating connection lifetime.
   * @returns The proof's expiry, or undefined for invalid proof.
   */
  verifyProof(proof: JsonValue, allocation: ProviderAllocationRef, signal: AbortSignal): Promise<string | undefined>;
}

const refused: WorkerExchangeReply = { type: 'connection-exchange-result', reject: 'rejected' };

/**
 * Wire the named worker exchange to an authorized host without enabling it at boot.
 * Enable only in tests until local and cross-host revocation enforce one live session per run identity.
 * @param host - Authorized dispatch host and order storage.
 * @param options - Host proof verifier and effective transport budget.
 * @returns The explicit setup policy to install on a WebSocket server.
 */
export function createWorkerConnectionExchange(
  host: WorkerRedemptionHost,
  options: WorkerConnectionExchangeOptions,
): ConnectionExchangeSetup {
  const base = Object.freeze({ ...host });
  if (!(base.operationSignal instanceof AbortSignal)) {
    throw new ConnectionExchangeConfigurationError('WS_INVALID_EXCHANGE_HOST_SIGNAL');
  }
  const verifyProof = options.verifyProof.bind(options);
  const maxBytes = Math.min(
    options.maxBytes ?? WORKER_EXCHANGE_MAX_BYTES,
    base.exchangeReplyByteLimit ?? WORKER_EXCHANGE_MAX_BYTES,
    WORKER_EXCHANGE_MAX_BYTES,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < Buffer.byteLength(JSON.stringify(refused))) {
    throw new RangeError('Invalid worker connection exchange budget');
  }
  return {
    maxBytes,
    maxPendingExchanges: options.maxPendingExchanges,
    refusal: JSON.stringify(refused),
    async admit(frame, { connectionId, deadline, signal, markProofVerified }) {
      const request = parseRequest(frame);
      if (request === undefined) return undefined;
      const { presented } = request;
      const operationSignal = AbortSignal.any([base.operationSignal, signal]);
      const call = callFromReceive({ transportName: 'websocket', connectionId }, undefined, undefined, () => {});
      try {
        const prepared = await prepareWorkerRedemption(
          { ...base, exchangeReplyByteLimit: maxBytes, operationSignal },
          call,
          presented,
          {
            kind: 'externally-visible',
            verifyPlatform: (allocation, proofSignal) => verifyProof(presented.proof, allocation, proofSignal),
          },
          deadline,
        ).catch((error: unknown) => {
          // Preparation exposes this classification only after the independent proof passed.
          if (error instanceof WorkerRedemptionError && error.code === 'retryable') markProofVerified();
          throw error;
        });
        if (prepared.commit === undefined) return undefined;
        markProofVerified();
        checkExchangeLifetime(operationSignal, deadline);
        const accepted = await base.database.transaction(
          async (tx) => {
            // A blocked BEGIN can return before its queued timeout callback runs.
            checkExchangeLifetime(operationSignal, deadline);
            return await prepared.commit(call, tx);
          },
          { signal: operationSignal },
        );
        checkExchangeLifetime(operationSignal, deadline);
        if (accepted.reject !== undefined || accepted.expiresAt === undefined || accepted.revocationKey === undefined) {
          return undefined;
        }
        return {
          reply: encodeWorkerExchangeReply(accepted, maxBytes),
          caller: accepted.party,
          expiresAt: accepted.expiresAt,
          revocationKey: accepted.revocationKey,
          hostSignal: base.operationSignal,
        };
      } catch (error) {
        if (
          error instanceof WorkerExchangeReplyTooLargeError ||
          (error instanceof WorkerRedemptionError && error.code === 'rejected')
        ) {
          return undefined;
        }
        throw new WorkerRedemptionError('retryable', 'Worker connection exchange interrupted');
      }
    },
  };
}

/**
 * Reject work once the connection lifetime or absolute deadline ends.
 * @param signal - Combined connection and host lifetime.
 * @param deadline - Absolute exchange deadline in epoch milliseconds.
 */
function checkExchangeLifetime(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (Date.now() >= deadline) throw new WorkerRedemptionError('retryable', 'Worker setup deadline elapsed');
}

/**
 * Validate the exchange name, credentials and proof without retaining parse errors.
 * @param frame - Size-bounded UTF-8 message from the transport.
 * @returns A detached, frozen presentation when it matches the worker exchange.
 */
function parseRequest(frame: string) {
  try {
    const parsed: unknown = JSON.parse(frame);
    const result = WorkerExchangeRequestSchema.safeParse(parsed);
    return result.success ? deepFreeze(result.data) : undefined;
  } catch {
    return undefined;
  }
}
