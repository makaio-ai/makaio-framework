import { afterEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() =>
  vi.fn<(file: string, args: readonly string[], callback: ExecFileCallback) => void>(),
);

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: readonly string[], callback: ExecFileCallback) => execFileMock(file, args, callback),
}));

import { keychainDelete, keychainRead, keychainWrite } from '../keychain.js';

describe('macOS keychain utility', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it('never propagates write command arguments containing the hex-encoded credential', async () => {
    const credential = 'secret-json-credential';
    const encoded = Buffer.from(credential, 'utf-8').toString('hex');
    execFileMock.mockImplementation((_file, args, callback) => {
      callback(new Error(`security failed: ${args.join(' ')}`), '', `credential=${encoded}`);
    });

    const write = keychainWrite('service', 'account', credential);

    await expect(write).rejects.toThrow('macOS keychain write failed');
    await expect(write).rejects.not.toThrow(credential);
    await expect(write).rejects.not.toThrow(encoded);
  });

  it('keeps item-not-found behavior without exposing other read failures', async () => {
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback(Object.assign(new Error('missing'), { code: 44 }), '', '');
    });
    await expect(keychainRead('service', 'account')).resolves.toBeNull();

    const secret = 'password-from-security-stderr';
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback(Object.assign(new Error(`security returned ${secret}`), { code: 1 }), '', `password: "${secret}"`);
    });
    const read = keychainRead('service', 'account');
    await expect(read).rejects.toThrow('macOS keychain read failed');
    await expect(read).rejects.not.toThrow(secret);
  });

  it('treats an absent delete as success and sanitizes every other failure', async () => {
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback(Object.assign(new Error('missing'), { code: 44 }), '', '');
    });
    await expect(keychainDelete('service', 'account')).resolves.toBeUndefined();

    const secret = 'secret-bearing-delete-context';
    execFileMock.mockImplementationOnce((_file, _args, callback) => {
      callback(new Error(secret), '', secret);
    });
    const deletion = keychainDelete('service', 'account');
    await expect(deletion).rejects.toThrow('macOS keychain delete failed');
    await expect(deletion).rejects.not.toThrow(secret);
  });
});
