import { callFromReceive } from '@makaio/bus-core/kernel-api';
import {
  ConnectionExchangeConfigurationError,
  type ConnectionExchangeAdmission,
  type ConnectionExchangeSetup,
  type ConnectionExchangeSetupContext,
} from '@makaio/bus-transport-websocket';
import type { JsonValue, ProviderAllocationRef } from '@makaio/contracts';
import {
  WORKER_EXCHANGE_MAX_BYTES,
  WorkerExchangeRequestSchema,
  WorkerRunIdentityRequestSchema,
  type WorkerExchangeReply,
  type WorkerRunIdentityRequest,
} from '@makaio/contracts/boundary';
import {
  encodeWorkerExchangeReply,
  prepareWorkerRedemption,
  verifyWorkerRunIdentity,
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
   * Revalidate the verified run and publish under the owner's local terminal ordering boundary.
   * @param run - Private identity metadata verified under the owner lock.
   * @param signal - Current host and connection lifetime.
   * @param publish - Synchronous route publication outside the SQL transaction.
   */
  withRunPromotion(
    run: { readonly jobRunId: string; readonly revocationKey: string; readonly expiresAt: string },
    signal: AbortSignal,
    publish: () => void,
  ): Promise<void>;
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
 * Validate the host's exchange policy before accepting any worker work.
 * @param host - Host lifetime and reply constraints.
 * @param options - Explicit worker proof and promotion policy.
 * @returns The exchange wire policy.
 */
function checkExchangeConfiguration(host: WorkerRedemptionHost, options: WorkerConnectionExchangeOptions) {
  if (!(host.operationSignal instanceof AbortSignal)) {
    throw new ConnectionExchangeConfigurationError('WS_INVALID_EXCHANGE_HOST_SIGNAL');
  }
  if (typeof options.withRunPromotion !== 'function') {
    throw new ConnectionExchangeConfigurationError('WS_MISSING_WORKER_PROMOTION');
  }
  return workerConnectionExchangePolicy(options, host.exchangeReplyByteLimit);
}

/**
 * Resolve the wire policy shared by the boot delegate and the bound exchange.
 * @param options - Configured capacity and byte limit.
 * @param replyLimit - Optional stricter limit from dispatch.
 * @returns The exchange wire policy.
 */
export function workerConnectionExchangePolicy(
  options: Pick<WorkerConnectionExchangeOptions, 'maxBytes' | 'maxPendingExchanges'>,
  replyLimit?: number,
) {
  const maxBytes = Math.min(
    options.maxBytes ?? WORKER_EXCHANGE_MAX_BYTES,
    replyLimit ?? WORKER_EXCHANGE_MAX_BYTES,
    WORKER_EXCHANGE_MAX_BYTES,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < Buffer.byteLength(JSON.stringify(refused))) {
    throw new RangeError('Invalid worker connection exchange budget');
  }
  return { maxBytes, maxPendingExchanges: options.maxPendingExchanges, refusal: JSON.stringify(refused) };
}

/**
 * Carry one verified acceptance into the shared host promotion boundary.
 * @param admission - Bootstrap or identity-only acceptance from the owner.
 * @param promote - Host's final authority recheck and ordering callback.
 * @param signal - Current setup and host lifetime.
 * @returns A worker admission that cannot publish outside the host boundary.
 */
function bindRunPromotion(
  admission: ConnectionExchangeAdmission,
  promote: WorkerConnectionExchangeOptions['withRunPromotion'],
  signal: AbortSignal,
): ConnectionExchangeAdmission {
  const { caller, revocationKey, expiresAt } = admission;
  return {
    ...admission,
    withPromotion: (publish) => promote({ jobRunId: caller.id, revocationKey, expiresAt }, signal, publish),
  };
}

/**
 * Wire the named worker exchange to an authorized host without enabling it at boot.
 * Keep this setup test-only until host composition provides verified local
 * takeover and terminal invalidation across participating hosts.
 * @param host - Authorized dispatch host and order storage.
 * @param options - Host proof verifier and effective transport budget.
 * @returns The explicit setup policy to install on a WebSocket server.
 */
export function createWorkerConnectionExchange(
  host: WorkerRedemptionHost,
  options: WorkerConnectionExchangeOptions,
): ConnectionExchangeSetup {
  const base: WorkerRedemptionHost = Object.freeze({ ...host, requireIssuerIdentityKey: true });
  const policy = checkExchangeConfiguration(base, options);
  const { maxBytes } = policy;
  const withRunPromotion = options.withRunPromotion.bind(options);
  const verifyProof = options.verifyProof.bind(options);
  return {
    ...policy,
    async admit(frame, context) {
      const { connectionId, deadline, signal, markProofVerified, markVerifiedRevocationKey } = context;
      const request = parseRequest(frame);
      if (request === undefined) return undefined;
      const operationSignal = AbortSignal.any([base.operationSignal, signal]);
      try {
        if ('kind' in request) {
          const admission = await admitIdentity(base, request, { ...context, signal: operationSignal }, maxBytes);
          return admission === undefined ? undefined : bindRunPromotion(admission, withRunPromotion, operationSignal);
        }
        const { presented } = request;
        const call = callFromReceive({ transportName: 'websocket', connectionId }, undefined, undefined, () => {});
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
            const result = await prepared.commit(call, tx);
            if (result.reject === undefined && result.revocationKey !== undefined) {
              markVerifiedRevocationKey?.(result.revocationKey);
            }
            return result;
          },
          { signal: operationSignal },
        );
        checkExchangeLifetime(operationSignal, deadline);
        if (accepted.reject !== undefined || accepted.expiresAt === undefined || accepted.revocationKey === undefined) {
          return undefined;
        }
        return bindRunPromotion(
          {
            reply: encodeWorkerExchangeReply(accepted, maxBytes),
            caller: accepted.party,
            expiresAt: accepted.expiresAt,
            revocationKey: accepted.revocationKey,
            hostSignal: base.operationSignal,
          },
          withRunPromotion,
          operationSignal,
        );
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
 * Confirm the stored identity through the same admission path as bootstrap.
 * @param host - Dispatch host and the durable owner.
 * @param request - Protected runtime presentation.
 * @param context - Lifetime and verification marker for this exchange.
 * @param maxBytes - Effective WebSocket reply budget.
 * @returns Credential-free admission metadata, if live.
 */
async function admitIdentity(
  host: WorkerRedemptionHost,
  request: WorkerRunIdentityRequest,
  { deadline, signal, markProofVerified, markVerifiedRevocationKey }: ConnectionExchangeSetupContext,
  maxBytes: number,
) {
  checkExchangeLifetime(signal, deadline);
  const identity = await verifyWorkerRunIdentity(host, request, signal, (key) => {
    markProofVerified();
    markVerifiedRevocationKey?.(key);
  });
  checkExchangeLifetime(signal, deadline);
  if (identity === undefined || Date.parse(identity.expiresAt) <= Date.now()) return undefined;
  const reply = JSON.stringify({
    type: 'connection-exchange-result',
    identity: { jobRunId: identity.party.id, expiresAt: identity.expiresAt },
  });
  if (Buffer.byteLength(reply) > maxBytes) return undefined;
  return {
    reply,
    caller: identity.party,
    expiresAt: identity.expiresAt,
    revocationKey: identity.revocationKey,
    hostSignal: host.operationSignal,
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
    const bootstrap = WorkerExchangeRequestSchema.safeParse(parsed);
    if (bootstrap.success) return deepFreeze(bootstrap.data);
    const identity = WorkerRunIdentityRequestSchema.safeParse(parsed);
    return identity.success ? deepFreeze(identity.data) : undefined;
  } catch {
    return undefined;
  }
}
