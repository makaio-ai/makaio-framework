/**
 * Relay envelope helpers.
 */

import { describe, it, expect } from 'bun:test';
import type { BusMessage } from '@makaio/bus-core';
import { decryptRelayEnvelope, encryptRelayEnvelope } from '../e2e-relay-envelope.js';

describe('relay envelope helpers', () => {
  it('encrypts and decrypts full messages (including payload-less types)', async () => {
    const sessionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

    const message: BusMessage = {
      type: 'subscribe',
      subjects: { 'agent.*': [] },
      filters: {
        'agent.*': { agentId: 'agent-1' },
      },
    };

    const envelope = await encryptRelayEnvelope(message, sessionKey);
    const decrypted = await decryptRelayEnvelope(envelope, sessionKey);

    expect(decrypted).toEqual(message);
  });
});
