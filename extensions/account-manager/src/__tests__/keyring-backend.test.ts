import { randomUUID } from 'node:crypto';
import { AsyncEntry } from '@napi-rs/keyring';
import { afterAll, describe, expect, it } from 'vitest';
import { KeyringBackend } from '../backends/keyring-backend.js';

const service = `makaio-test-keyring-backend-${randomUUID()}`;
const account = 'test-account';

describe.skipIf(process.platform !== 'darwin')('KeyringBackend', () => {
  afterAll(async () => {
    try {
      await new AsyncEntry(service, account).deleteCredential();
    } catch (error) {
      // NoEntry means the credential was never written or was already cleaned
      // up — that is fine. Any other error is unexpected, so re-throw.
      if (!(error instanceof Error && error.name === 'NoEntry')) {
        throw error;
      }
    }
  });

  it('read returns null when no entry exists', async () => {
    const backend = new KeyringBackend(service, account);
    const result = await backend.read();
    expect(result).toBeNull();
  });

  it('write then read round-trips the value', async () => {
    const backend = new KeyringBackend(service, account);
    await backend.write('round-trip-token');
    const result = await backend.read();
    expect(result).toBe('round-trip-token');
  });

  it('overwrite: second write replaces the first', async () => {
    const backend = new KeyringBackend(service, account);
    await backend.write('value-a');
    await backend.write('value-b');
    const result = await backend.read();
    expect(result).toBe('value-b');
  });

  it('round-trips a JSON payload with unicode characters', async () => {
    const payload = JSON.stringify({
      token: 'sk-abc123',
      label: 'café ☕ résumé',
      nested: { emoji: '🔑', cjk: '日本語' },
    });
    const backend = new KeyringBackend(service, account);
    await backend.write(payload);
    const result = await backend.read();
    expect(result).toBe(payload);
  });
});
