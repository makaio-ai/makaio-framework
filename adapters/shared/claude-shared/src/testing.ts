/**
 * Test utilities for Claude adapter integration tests.
 * @packageDocumentation
 */

import { createChannelEndpoint, MakaioBus } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';

/**
 * Register a credential channel that resolves every ref to a fixed plaintext value.
 *
 * Useful for integration tests that need credential resolution without a full
 * credential store. The returned function tears down both the channel token
 * handler and the channel endpoint.
 * @param value - Plaintext credential value returned for every resolve request
 * @returns Cleanup function that removes all registered handlers
 */
export function setupFixedCredentialBus(value: string): () => void {
  const cleanups: Array<() => void> = [];
  const token = `test-credential-token-${crypto.randomUUID()}`;

  cleanups.push(
    MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
      ctx.setResult({ token });
    }),
  );

  const endpoint = createChannelEndpoint(
    MakaioBus.getContext(),
    'credentials',
    (channel) => {
      channel.on(CredentialSubjects.resolve, (ctx) => {
        ctx.setResult({ value });
      });
    },
    { token },
  );
  cleanups.push(() => endpoint.close());

  return () => {
    for (const fn of cleanups) fn();
  };
}
