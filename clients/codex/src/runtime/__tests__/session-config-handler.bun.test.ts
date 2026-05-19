/**
 * Tests for the Codex session config setup handler.
 *
 * All tests exercise real filesystem I/O against temporary directories — no
 * mocks are used. This validates the directory creation, file copying, and
 * config priming logic against the actual implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCodexSessionConfigSetup } from '../session-config-handler.js';

/**
 * Build a minimal valid {@link SessionConfigSetupRequest} for test use.
 * @param sessionDir - Absolute path to the session config directory.
 * @param baseConfigDir - Absolute path to the base config directory.
 * @param projectDir - Optional project directory.
 * @returns Minimal valid setup request.
 */
function makeSetupRequest(
  sessionDir: string,
  baseConfigDir: string,
  projectDir?: string,
): Parameters<typeof handleCodexSessionConfigSetup>[0] {
  return {
    sessionDir,
    baseConfigDir,
    platform: 'linux',
    configInheritance: 'full',
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
}

describe('handleCodexSessionConfigSetup', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-session-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('copies base config and primes session dir', async () => {
    const baseDir = path.join(tmpDir, 'base');
    const sessionDir = path.join(tmpDir, 'session');
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(baseDir, 'config.toml'), 'model = "gpt-5"\n', 'utf-8');

    const result = await handleCodexSessionConfigSetup(makeSetupRequest(sessionDir, baseDir));

    expect(result.env?.CODEX_HOME).toBe(sessionDir);
    const content = await fs.readFile(path.join(sessionDir, 'config.toml'), 'utf-8');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('check_for_update_on_startup = false');
  });

  it('creates session dir when it does not exist', async () => {
    const baseDir = path.join(tmpDir, 'base');
    const sessionDir = path.join(tmpDir, 'new-session');
    await fs.mkdir(baseDir, { recursive: true });

    await handleCodexSessionConfigSetup(makeSetupRequest(sessionDir, baseDir));

    const stat = await fs.stat(sessionDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('copies auth.json when present in base dir', async () => {
    const baseDir = path.join(tmpDir, 'base');
    const sessionDir = path.join(tmpDir, 'session');
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(baseDir, 'auth.json'), '{"token":"abc"}', 'utf-8');

    await handleCodexSessionConfigSetup(makeSetupRequest(sessionDir, baseDir));

    const content = await fs.readFile(path.join(sessionDir, 'auth.json'), 'utf-8');
    expect(content).toBe('{"token":"abc"}');
  });

  it('skips file copy when auth.json is missing in base dir', async () => {
    const baseDir = path.join(tmpDir, 'base');
    const sessionDir = path.join(tmpDir, 'session');
    await fs.mkdir(baseDir, { recursive: true });

    await handleCodexSessionConfigSetup(makeSetupRequest(sessionDir, baseDir));

    const exists = await fs
      .stat(path.join(sessionDir, 'auth.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('skips copy step when sessionDir and baseConfigDir resolve to the same path', async () => {
    const sameDir = path.join(tmpDir, 'shared');
    await fs.mkdir(sameDir, { recursive: true });

    const result = await handleCodexSessionConfigSetup(makeSetupRequest(sameDir, sameDir));

    // Prime should still run; CODEX_HOME should point to sameDir.
    expect(result.env?.CODEX_HOME).toBe(sameDir);
    const content = await fs.readFile(path.join(sameDir, 'config.toml'), 'utf-8');
    expect(content).toContain('check_for_update_on_startup = false');
  });

  it('returns CODEX_HOME env var pointing to sessionDir', async () => {
    const baseDir = path.join(tmpDir, 'base');
    const sessionDir = path.join(tmpDir, 'session');
    await fs.mkdir(baseDir, { recursive: true });

    const result = await handleCodexSessionConfigSetup(makeSetupRequest(sessionDir, baseDir));

    expect(result.env).toEqual({ CODEX_HOME: sessionDir });
  });
});
