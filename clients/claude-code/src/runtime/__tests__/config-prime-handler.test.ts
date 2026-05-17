/**
 * Unit tests for {@link handleClaudeCodeConfigPrime}.
 *
 * All tests use a real temporary directory to verify that the handler writes
 * `settings.json` correctly under each scenario. No mocks are used — the
 * filesystem is the implementation under test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleClaudeCodeConfigPrime } from '../config-prime-handler.js';

describe('handleClaudeCodeConfigPrime', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-prime-'));
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('writes DISABLE_AUTOUPDATER=1 while preserving existing env entries', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ env: { FOO: 'bar' } }), 'utf-8');

    const result = await handleClaudeCodeConfigPrime({
      clientId: 'claude-code',
      configDir,
      phase: 'session-create',
    });

    const settings = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf-8'));
    expect(result).toEqual({ primed: true });
    expect(settings).toEqual({ env: { FOO: 'bar', DISABLE_AUTOUPDATER: '1' } });
  });

  it('creates settings.json when it is missing', async () => {
    await handleClaudeCodeConfigPrime({
      clientId: 'claude-code',
      configDir,
      phase: 'managed-install',
    });

    const content = await fs.readFile(path.join(configDir, 'settings.json'), 'utf-8');
    expect(JSON.parse(content)).toEqual({ env: { DISABLE_AUTOUPDATER: '1' } });
  });

  it('preserves non-env settings fields', async () => {
    await fs.writeFile(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', env: { BAR: 'baz' } }),
      'utf-8',
    );

    await handleClaudeCodeConfigPrime({
      clientId: 'claude-code',
      configDir,
      phase: 'profile-create',
    });

    const settings = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.env).toEqual({ BAR: 'baz', DISABLE_AUTOUPDATER: '1' });
  });

  it('rejects non-object settings.json instead of replacing it', async () => {
    await fs.writeFile(path.join(configDir, 'settings.json'), '[]', 'utf-8');

    await expect(
      handleClaudeCodeConfigPrime({
        clientId: 'claude-code',
        configDir,
        phase: 'profile-create',
      }),
    ).rejects.toThrow('settings.json must contain an object');

    const content = await fs.readFile(path.join(configDir, 'settings.json'), 'utf-8');
    expect(content).toBe('[]');
  });

  it('is idempotent when DISABLE_AUTOUPDATER already set', async () => {
    await fs.writeFile(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ env: { DISABLE_AUTOUPDATER: '1' } }),
      'utf-8',
    );

    await handleClaudeCodeConfigPrime({
      clientId: 'claude-code',
      configDir,
      phase: 'session-create',
    });

    const settings = JSON.parse(await fs.readFile(path.join(configDir, 'settings.json'), 'utf-8'));
    expect(settings).toEqual({ env: { DISABLE_AUTOUPDATER: '1' } });
  });

  it('creates the configDir when it does not exist', async () => {
    const nestedDir = path.join(configDir, 'nested', 'config');

    await handleClaudeCodeConfigPrime({
      clientId: 'claude-code',
      configDir: nestedDir,
      phase: 'managed-install',
    });

    const settings = JSON.parse(await fs.readFile(path.join(nestedDir, 'settings.json'), 'utf-8'));
    expect(settings).toEqual({ env: { DISABLE_AUTOUPDATER: '1' } });
  });
});
