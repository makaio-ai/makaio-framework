import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDefaultReceiverCommand, resolveInstallReceiverCommand } from '../cli/install-command.js';

const tempDirs: string[] = [];

/**
 * Create a temporary directory and register it for cleanup after the test.
 * @param prefix - Prefix for the temporary directory name.
 * @returns Absolute path to the created temporary directory.
 */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('resolveDefaultReceiverCommand', () => {
  it('resolves the compiled receiver entrypoint next to the extension CLI module', () => {
    const command = resolveDefaultReceiverCommand(
      'file:///opt/makaio/extensions/git-hooks/dist/cli/install-command.mjs',
      '/usr/bin/node',
    );

    expect(command).toEqual(['/usr/bin/node', '/opt/makaio/extensions/git-hooks/dist/bin/git-hook-receiver.mjs']);
  });

  it('keeps source-mode receiver resolution absolute for local test runs', () => {
    const command = resolveDefaultReceiverCommand(
      'file:///repo/framework/extensions/git-hooks/src/cli/install-command.ts',
      '/usr/bin/node',
    );

    expect(command).toEqual(['/usr/bin/node', '/repo/framework/extensions/git-hooks/src/bin/git-hook-receiver.ts']);
  });
});

describe('resolveInstallReceiverCommand', () => {
  it('accepts an explicit absolute executable receiver command', async () => {
    const dir = await makeTempDir('makaio-git-hooks-receiver-command-');
    const receiver = path.join(dir, 'receiver');
    await fs.writeFile(receiver, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await expect(resolveInstallReceiverCommand({ receiverCommand: receiver })).resolves.toEqual([receiver]);
  });

  it('rejects an explicit receiver command that would require PATH lookup', async () => {
    await expect(resolveInstallReceiverCommand({ receiverCommand: 'makaio-git-hook-receiver' })).rejects.toThrow(
      'absolute',
    );
  });

  it('rejects an explicit receiver command that is not executable', async () => {
    const dir = await makeTempDir('makaio-git-hooks-receiver-command-');
    const receiver = path.join(dir, 'receiver');
    await fs.writeFile(receiver, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

    await expect(resolveInstallReceiverCommand({ receiverCommand: receiver })).rejects.toThrow('executable');
  });

  it('rejects default receiver resolution when the receiver entrypoint is missing', async () => {
    const dir = await makeTempDir('makaio-git-hooks-receiver-command-');
    const moduleUrl = new URL(`file://${path.join(dir, 'dist', 'cli', 'install-command.mjs')}`).href;

    await expect(resolveInstallReceiverCommand({}, { moduleUrl, nodeExecutable: process.execPath })).rejects.toThrow(
      'receiver entrypoint',
    );
  });
});
