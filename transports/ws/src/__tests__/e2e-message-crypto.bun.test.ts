/**
 * Tests for E2E message encryption/decryption helpers.
 */

import { describe, it, expect } from 'bun:test';
import type { BusBroadcastResponseMessage, BusResponseMessage } from '@makaio/bus-core';
import { encryptMessage, decryptMessage } from '../e2e-message-crypto.js';

async function createSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('E2E message crypto', () => {
  it('encrypts and decrypts response results', async () => {
    const sessionKey = await createSessionKey();
    const response: BusResponseMessage = {
      type: 'response',
      correlationId: 'corr-1',
      result: { ok: true, count: 3 },
    };

    const encrypted = await encryptMessage(response, sessionKey);
    expect(encrypted.type).toBe('response');
    expect(encrypted.e2e?.nonce).toBeDefined();
    if (encrypted.type === 'response') {
      expect(typeof encrypted.result).toBe('string');
    }

    const decrypted = await decryptMessage(encrypted, sessionKey);
    expect(decrypted).toEqual(response);
  });

  it('encrypts and decrypts broadcast-response results', async () => {
    const sessionKey = await createSessionKey();
    const response: BusBroadcastResponseMessage = {
      type: 'broadcast-response',
      correlationId: 'corr-2',
      results: [
        { nodeId: 'node-1', payload: { value: 1 } },
        { nodeId: 'node-2', payload: { value: 2 } },
      ],
    };

    const encrypted = await encryptMessage(response, sessionKey);
    expect(encrypted.type).toBe('broadcast-response');
    expect(encrypted.e2e?.nonce).toBeDefined();
    if (encrypted.type === 'broadcast-response') {
      expect(typeof encrypted.results).toBe('string');
    }

    const decrypted = await decryptMessage(encrypted, sessionKey);
    expect(decrypted).toEqual(response);
  });
});
