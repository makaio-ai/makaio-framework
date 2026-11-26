import {
  WORKER_EXCHANGE_MAX_BYTES,
  type ConnectionExchangeAccepted,
  type WorkerExchangeReply,
} from '@makaio/contracts/boundary';
import { canonicalStringify } from '@makaio/utils';

/** The stored reply cannot be delivered through the configured transport. */
export class WorkerExchangeReplyTooLargeError extends Error {
  public readonly code = 'reply-too-large';

  public constructor() {
    super('Worker exchange reply exceeds the message budget');
    this.name = 'WorkerExchangeReplyTooLargeError';
  }
}

/**
 * Encode the exact public reply checked in storage and sent by the transport.
 * @param accepted - Committed or proposed acceptance.
 * @param byteLimit - Effective limit if lower than the common default.
 * @returns Canonical UTF-8 JSON text.
 */
export function encodeWorkerExchangeReply(
  accepted: ConnectionExchangeAccepted,
  byteLimit = WORKER_EXCHANGE_MAX_BYTES,
): string {
  const reply: WorkerExchangeReply = { type: 'connection-exchange-result', payload: accepted.payload };
  const encoded = canonicalStringify(reply);
  if (!(Buffer.byteLength(encoded, 'utf8') <= Math.min(byteLimit, WORKER_EXCHANGE_MAX_BYTES))) {
    throw new WorkerExchangeReplyTooLargeError();
  }
  return encoded;
}
