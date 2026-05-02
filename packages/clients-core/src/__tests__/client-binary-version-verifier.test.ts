/**
 * Tests for {@link verifyInstalledVersion}.
 *
 * Coverage:
 * - Success path: stdout contains the expected version token
 * - Absolute command path is rejected before exec is called
 * - Path escape via `..` segments is rejected before exec is called
 * - exec failure is wrapped with a clear error message
 * - Version mismatch throws a clear error message, including near-miss tokens
 * - Leading `v` normalization: `v1.2.3` expected matches `1.2.3` output and vice versa
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyInstalledVersion } from '../client-binary-version-verifier.js';
import type { StrategyDependencies } from '../binary-strategies/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal exec mock that resolves with the given stdout string.
 * @param stdout - String to resolve with when exec is called
 * @returns Vitest mock function with the exec signature
 */
function makeExec(stdout: string): StrategyDependencies['exec'] {
  return vi.fn().mockResolvedValue(stdout);
}

/**
 * Build a minimal exec mock that rejects with the given error message.
 * @param message - Error message for the rejection
 * @returns Vitest mock function with the exec signature
 */
function makeFailingExec(message: string): StrategyDependencies['exec'] {
  return vi.fn().mockRejectedValue(new Error(message));
}

/**
 * Create a real install directory with a placeholder binary file.
 *
 * The verifier canonicalizes paths with `realpath()` before it invokes the
 * injected exec seam, so tests need real files even when exec itself is mocked.
 * @param root - Temp directory root for this test
 * @returns Absolute install path and executable path
 */
async function createInstallTree(root: string): Promise<{ installPath: string; executablePath: string }> {
  const installPath = path.join(root, 'test-client', '1.2.3');
  const executablePath = path.join(installPath, 'bin', 'test-client');
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.writeFile(executablePath, '#!/bin/sh\n');
  return {
    installPath: await fs.realpath(installPath),
    executablePath: await fs.realpath(executablePath),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION_COMMAND: [string, ...string[]] = ['bin/test-client', '--version'];
const EXPECTED_VERSION = '1.2.3';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('verifyInstalledVersion', () => {
  let tmpDir: string;
  let installPath: string;
  let executablePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-version-verifier-'));
    ({ installPath, executablePath } = await createInstallTree(tmpDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  it('resolves when stdout contains the expected version token', async () => {
    const exec = makeExec('test-client version 1.2.3 (linux/amd64)');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).resolves.toBeUndefined();
  });

  it('resolves when stdout equals exactly the expected version', async () => {
    const exec = makeExec('1.2.3');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).resolves.toBeUndefined();
  });

  it('resolves command arguments to the install path and passes cwd', async () => {
    const exec = makeExec('1.2.3');
    await verifyInstalledVersion(exec, installPath, ['bin/test-client', '--version', '--json'], EXPECTED_VERSION);

    expect(exec).toHaveBeenCalledWith(executablePath, ['--version', '--json'], {
      cwd: installPath,
    });
  });

  // -------------------------------------------------------------------------
  // v-prefix normalization
  // -------------------------------------------------------------------------

  it('resolves when expected version has a leading v and stdout does not', async () => {
    const exec = makeExec('test-client 1.2.3');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, 'v1.2.3')).resolves.toBeUndefined();
  });

  it('resolves when expected version has no leading v but stdout has one', async () => {
    const exec = makeExec('test-client v1.2.3');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, '1.2.3')).resolves.toBeUndefined();
  });

  it('resolves when stdout has an uppercase leading V', async () => {
    const exec = makeExec('test-client V1.2.3');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, '1.2.3')).resolves.toBeUndefined();
  });

  it('resolves when both expected and stdout versions have a leading v', async () => {
    const exec = makeExec('v1.2.3');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, 'v1.2.3')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Path security: absolute command path
  // -------------------------------------------------------------------------

  it('throws without calling exec when command path is absolute', async () => {
    const exec = makeExec('1.2.3');
    await expect(
      verifyInstalledVersion(exec, installPath, ['/usr/bin/test-client', '--version'], EXPECTED_VERSION),
    ).rejects.toThrow('must be a relative path');
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws without calling exec when command path is Windows-rooted', async () => {
    const exec = makeExec('1.2.3');
    await expect(
      verifyInstalledVersion(exec, installPath, ['\\Windows\\System32\\cmd.exe', '--version'], EXPECTED_VERSION),
    ).rejects.toThrow('must be a relative path');
    expect(exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Path security: .. traversal
  // -------------------------------------------------------------------------

  it('throws without calling exec when command path contains ..', async () => {
    const exec = makeExec('1.2.3');
    await expect(
      verifyInstalledVersion(exec, installPath, ['../../bin/evil', '--version'], EXPECTED_VERSION),
    ).rejects.toThrow('must not contain path traversal');
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws without calling exec for a single .. path segment', async () => {
    const exec = makeExec('1.2.3');
    await expect(
      verifyInstalledVersion(exec, installPath, ['../other-binary', '--version'], EXPECTED_VERSION),
    ).rejects.toThrow('must not contain path traversal');
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws without calling exec when a symlinked command resolves outside the install directory', async () => {
    const outsideBinary = path.join(tmpDir, 'outside-binary');
    await fs.writeFile(outsideBinary, '#!/bin/sh\n');
    const symlinkPath = path.join(installPath, 'bin', 'outside-link');
    await fs.symlink(outsideBinary, symlinkPath);

    const exec = makeExec('1.2.3');
    await expect(
      verifyInstalledVersion(exec, installPath, ['bin/outside-link', '--version'], EXPECTED_VERSION),
    ).rejects.toThrow('resolves outside installPath');
    expect(exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Exec failure
  // -------------------------------------------------------------------------

  it('throws a clear error when the command fails to execute', async () => {
    const exec = makeFailingExec('Permission denied');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).rejects.toThrow(
      'Version verification failed',
    );
  });

  it('wraps the original exec error message in the thrown error', async () => {
    const exec = makeFailingExec('ENOENT: no such file or directory');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).rejects.toThrow(
      'ENOENT: no such file or directory',
    );
  });

  // -------------------------------------------------------------------------
  // Version mismatch
  // -------------------------------------------------------------------------

  it('throws a clear error when stdout does not contain the expected version', async () => {
    const exec = makeExec('test-client 2.0.0');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).rejects.toThrow(
      'Version mismatch',
    );
  });

  it('throws when stdout only contains the expected version as a substring of another token', async () => {
    const exec = makeExec('test-client 1.2.30');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).rejects.toThrow(
      'Version mismatch',
    );
  });

  it('throws when stdout contains the expected version inside a larger numeric token', async () => {
    const exec = makeExec('test-client 11.2.3');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, EXPECTED_VERSION)).rejects.toThrow(
      'Version mismatch',
    );
  });

  it('includes expected and actual version in the mismatch error', async () => {
    const exec = makeExec('test-client 9.9.9');
    await expect(verifyInstalledVersion(exec, installPath, VERSION_COMMAND, '1.2.3')).rejects.toThrow(
      'expected "1.2.3"',
    );
  });
});
