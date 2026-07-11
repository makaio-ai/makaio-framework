import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const keyringObservation = vi.hoisted(() => ({ moduleLoads: 0, entryCreations: 0 }));

vi.mock('@napi-rs/keyring', () => {
  keyringObservation.moduleLoads += 1;
  return {
    AsyncEntry: class {
      public constructor(_service: string, _account: string) {
        keyringObservation.entryCreations += 1;
      }

      public async getPassword(): Promise<string> {
        return '{"token":"keyring"}';
      }

      public async setPassword(_value: string): Promise<void> {}

      public async deleteCredential(): Promise<void> {}
    },
  };
});

import { CodexNativeAuthStore, identifyCodexAuthHome } from '../native-auth-store.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe('CodexNativeAuthStore native keyring loading', () => {
  it('keeps file auth addon-free and imports the keyring module once on first keyring access', async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-lazy-keyring-'));
    temporaryPaths.push(codexHome);
    await fs.writeFile(path.join(codexHome, 'auth.json'), '{"token":"file"}');
    const identity = await identifyCodexAuthHome(codexHome);
    const store = new CodexNativeAuthStore();

    await expect(store.readEffective(identity, 'file')).resolves.toMatchObject({
      credential: { backend: 'file', value: '{"token":"file"}' },
    });
    expect(keyringObservation).toEqual({ moduleLoads: 0, entryCreations: 0 });

    await expect(store.readEffective(identity, 'keyring')).resolves.toMatchObject({
      credential: { backend: 'keyring', value: '{"token":"keyring"}' },
    });
    await store.readEffective(identity, 'keyring');
    expect(keyringObservation).toEqual({ moduleLoads: 1, entryCreations: 2 });
  });
});
