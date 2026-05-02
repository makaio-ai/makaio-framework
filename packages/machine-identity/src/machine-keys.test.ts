import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateMachineIdentity, validateMachineKeys } from './machine-keys.js';

const { getNativeHardwareMachineIdMock } = vi.hoisted(() => ({
  getNativeHardwareMachineIdMock: vi.fn<() => string | undefined>(),
}));

vi.mock('./native-id.js', async () => {
  const actual = await vi.importActual<typeof import('./native-id.js')>('./native-id.js');
  return {
    ...actual,
    getNativeHardwareMachineId: getNativeHardwareMachineIdMock,
  };
});

describe('loadOrCreateMachineIdentity', () => {
  let keysDir: string;

  beforeEach(async () => {
    keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-machine-keys-'));
    getNativeHardwareMachineIdMock.mockReset();
    getNativeHardwareMachineIdMock.mockReturnValue('hardware-machine-id');
  });

  afterEach(async () => {
    await fs.rm(keysDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('serializes concurrent initialization per keys directory', async () => {
    const generateKeySpy = vi.spyOn(globalThis.crypto.subtle, 'generateKey');

    const [firstIdentity, secondIdentity] = await Promise.all([
      loadOrCreateMachineIdentity(keysDir),
      loadOrCreateMachineIdentity(keysDir),
    ]);

    expect(firstIdentity.machineId).toBe(secondIdentity.machineId);
    expect(firstIdentity.publicKey).toBe(secondIdentity.publicKey);
    expect(firstIdentity.signingPublicKey).toBe(secondIdentity.signingPublicKey);
    expect(generateKeySpy).toHaveBeenCalledTimes(2);

    const validation = await validateMachineKeys(keysDir);
    expect(validation.status).toBe('complete');
  });

  it('keeps the cached machine id when native lookup later becomes available', async () => {
    getNativeHardwareMachineIdMock.mockReturnValueOnce(undefined).mockReturnValue('hardware-id-2');

    const firstIdentity = await loadOrCreateMachineIdentity(keysDir);
    const secondIdentity = await loadOrCreateMachineIdentity(keysDir);

    expect(secondIdentity.machineId).toBe(firstIdentity.machineId);
    expect(secondIdentity.publicKey).toBe(firstIdentity.publicKey);
    expect(secondIdentity.signingPublicKey).toBe(firstIdentity.signingPublicKey);
  });

  it('fails fast when machine.id is malformed but the keyset is otherwise complete', async () => {
    await loadOrCreateMachineIdentity(keysDir);

    await fs.writeFile(path.join(keysDir, 'machine.id'), 'hardware-machine-id:secondary');

    await expect(loadOrCreateMachineIdentity(keysDir)).rejects.toThrow(
      'Refusing to regenerate keys automatically to avoid identity rotation.',
    );

    const validation = await validateMachineKeys(keysDir);
    expect(validation.status).toBe('complete');
  });

  it('waits for an existing machine-key lock before initializing', async () => {
    const lockPath = path.join(keysDir, '.machine-keys.lock');
    const heldLock = await fs.open(lockPath, 'wx', 0o600);

    setTimeout(() => {
      void heldLock.close().then(() => fs.unlink(lockPath));
    }, 100);

    const identity = await loadOrCreateMachineIdentity(keysDir);

    expect(identity.machineId).toBe('hardware-machine-id');
    expect(await fs.stat(path.join(keysDir, 'machine.key'))).toBeDefined();
  });

  it('fails fast when key files are in a partial state', async () => {
    await fs.writeFile(path.join(keysDir, 'machine.id'), 'hardware-machine-id');
    await fs.writeFile(path.join(keysDir, 'machine.key'), 'partial-private-key');

    await expect(loadOrCreateMachineIdentity(keysDir)).rejects.toThrow(
      'Refusing to regenerate keys automatically because that would replace existing machine identity.',
    );

    const validation = await validateMachineKeys(keysDir);
    expect(validation.status).toBe('partial');
  });
});
