import type { TransportRequestOrigin } from '@makaio/core';

type RetireExchange = (code?: 1008 | 1011, reply?: TransportRequestOrigin) => void;

/**
 * Report a verifier's synchronous throw or rejected promise as a denial.
 * @param verify - Invoke the owner authority for this message.
 * @returns The owner's decision, or false on failure.
 */
export async function verifyRunMessageOrDeny(verify: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await verify()) === true;
  } catch {
    return false;
  }
}

interface ExchangeRetirement {
  readonly retire: RetireExchange;
  readonly forceDetach: () => void;
  readonly clearAuthentication: () => void;
  readonly terminate: () => void;
}

/**
 * Retire a verified socket even when the transport failed to bind graceful cleanup.
 * @param binding - Native teardown and optional transport retirement.
 * @param clearAuthentication - Drop the socket's authenticated state.
 * @param reply - Optional final response to preserve during graceful retirement.
 */
export function retireVerifiedExchange(
  binding: { readonly retire?: RetireExchange; readonly terminate: () => void },
  clearAuthentication: () => void,
  reply?: TransportRequestOrigin,
): void {
  if (binding.retire !== undefined) {
    binding.retire(1008, reply);
    return;
  }
  try {
    clearAuthentication();
  } finally {
    binding.terminate();
  }
}

/**
 * Force native teardown if graceful retirement cannot detach a connection.
 * @param retirement - Graceful and hard teardown of the same exchange socket.
 * @returns A retirement callback safe to invoke after a commit.
 */
export function withForcedRetirement(retirement: ExchangeRetirement): RetireExchange {
  return (code, reply) => {
    try {
      retirement.retire(code, reply);
    } catch {
      try {
        retirement.forceDetach();
      } finally {
        try {
          retirement.clearAuthentication();
        } finally {
          retirement.terminate();
        }
      }
    }
  };
}
