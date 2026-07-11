import { describe, expect, it, vi } from 'vitest';

const keyringBehavior = vi.hoisted(() => ({ operation: 'read' as 'read' | 'write' | 'clear' }));

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    public constructor(_service: string, _account: string) {}

    public async getPassword(): Promise<string> {
      if (keyringBehavior.operation === 'read') throw new Error('native failure included credential-secret');
      return 'unused';
    }

    public async setPassword(_value: string): Promise<void> {
      if (keyringBehavior.operation === 'write') throw new Error('native failure included credential-secret');
    }

    public async deletePassword(): Promise<void> {
      if (keyringBehavior.operation === 'clear') throw new Error('native failure included credential-secret');
    }
  },
}));

import { KeyringBackend } from '../backends/keyring-backend.js';

describe('KeyringBackend error boundary', () => {
  it.each([
    'read',
    'write',
    'clear',
  ] as const)('does not expose a native failure while %s credentials', async (operation) => {
    keyringBehavior.operation = operation;
    const backend = new KeyringBackend('test-service', 'test-account');
    const request =
      operation === 'read'
        ? backend.read()
        : operation === 'write'
          ? backend.write('credential-secret')
          : backend.clear();

    await expect(request).rejects.toThrow(`Native keychain credential ${operation} failed`);
    await expect(request).rejects.not.toThrow('credential-secret');
  });
});
