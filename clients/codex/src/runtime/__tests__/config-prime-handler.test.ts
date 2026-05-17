/**
 * Tests for the Codex config-prime handler.
 *
 * All tests exercise real filesystem I/O against temporary directories — no
 * mocks are used. This validates the atomic write path, idempotency, and
 * key-replacement logic against the actual implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCodexConfigPrime } from '../config-prime-handler.js';

describe('handleCodexConfigPrime', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-codex-prime-'));
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('writes check_for_update_on_startup = false while preserving existing config', async () => {
    await fs.writeFile(path.join(configDir, 'config.toml'), 'model = "gpt-5.5"\n', 'utf-8');

    const result = await handleCodexConfigPrime({ clientId: 'codex', configDir, phase: 'session-create' });

    const content = await fs.readFile(path.join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('check_for_update_on_startup = false');
    expect(content).toContain('model = "gpt-5.5"');
    expect(result).toEqual({ primed: true });
  });

  it('creates config.toml when missing', async () => {
    await handleCodexConfigPrime({ clientId: 'codex', configDir, phase: 'managed-install' });

    const content = await fs.readFile(path.join(configDir, 'config.toml'), 'utf-8');
    expect(content).toBe('check_for_update_on_startup = false\n');
  });

  it('replaces existing check_for_update_on_startup = true', async () => {
    await fs.writeFile(
      path.join(configDir, 'config.toml'),
      'check_for_update_on_startup = true\nmodel = "gpt-5"\n',
      'utf-8',
    );

    await handleCodexConfigPrime({ clientId: 'codex', configDir, phase: 'session-create' });

    const content = await fs.readFile(path.join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('check_for_update_on_startup = false');
    expect(content).not.toContain('check_for_update_on_startup = true');
  });

  it('writes check_for_update_on_startup at the TOML root before tables', async () => {
    await fs.writeFile(
      path.join(configDir, 'config.toml'),
      'model = "gpt-5"\n[profiles.default]\nmodel = "gpt-5.5"\n',
      'utf-8',
    );

    await handleCodexConfigPrime({ clientId: 'codex', configDir, phase: 'session-create' });

    const content = await fs.readFile(path.join(configDir, 'config.toml'), 'utf-8');
    expect(content).toBe(
      'model = "gpt-5"\ncheck_for_update_on_startup = false\n[profiles.default]\nmodel = "gpt-5.5"\n',
    );
  });

  it('is idempotent', async () => {
    await fs.writeFile(path.join(configDir, 'config.toml'), 'check_for_update_on_startup = false\n', 'utf-8');

    await handleCodexConfigPrime({ clientId: 'codex', configDir, phase: 'session-create' });

    const content = await fs.readFile(path.join(configDir, 'config.toml'), 'utf-8');
    expect(content).toBe('check_for_update_on_startup = false\n');
  });

  it('creates the config directory when it does not exist', async () => {
    const nestedDir = path.join(configDir, 'deep', 'nested');

    await handleCodexConfigPrime({ clientId: 'codex', configDir: nestedDir, phase: 'profile-create' });

    const content = await fs.readFile(path.join(nestedDir, 'config.toml'), 'utf-8');
    expect(content).toBe('check_for_update_on_startup = false\n');
  });

  it('handles CRLF line endings by normalizing to LF', async () => {
    await fs.writeFile(
      path.join(configDir, 'config.toml'),
      'model = "gpt-5"\r\ncheck_for_update_on_startup = true\r\n',
      'utf-8',
    );

    await handleCodexConfigPrime({ clientId: 'codex', configDir, phase: 'session-create' });

    const content = await fs.readFile(path.join(configDir, 'config.toml'), 'utf-8');
    expect(content).toContain('check_for_update_on_startup = false');
    expect(content).not.toContain('check_for_update_on_startup = true');
  });
});
