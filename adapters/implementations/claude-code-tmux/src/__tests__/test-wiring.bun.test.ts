import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import type { ProviderDefinitionInput } from '@makaio/contracts';
import { ClientSubjects } from '@makaio/contracts/client';
import { createTestConfig } from '../test/index.js';

const providerDefinitions: ProviderDefinitionInput[] = [
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet', fastModel: 'claude-haiku' },
  { id: 'anthropic-oauth', name: 'Anthropic OAuth', defaultModel: 'claude-sonnet', fastModel: 'claude-haiku' },
];

describe('Claude Code tmux conformance wiring', () => {
  let cleanup: (() => void | Promise<void>) | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    MakaioBus.__resetHandlers?.();
  });

  it('writes hook settings into configDir rather than project .claude', async () => {
    const config = await createTestConfig({ providerDefinitions });
    cleanup = config.cleanup;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmux-wiring-'));
    const projectDir = path.join(tmpDir, 'project');
    const configDir = path.join(tmpDir, 'session-config');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(configDir, { recursive: true });

    await MakaioBus.request(ClaudeCodeClientSubjects.wiring.apply, {
      scope: 'user',
      projectDir,
      configDir,
      makaioCommand: 'makaio',
    });

    await expect(fs.stat(path.join(configDir, 'settings.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(projectDir, '.claude', 'settings.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cleans up shared hook bridge even when session config destroy fails', async () => {
    const config = await createTestConfig({ providerDefinitions });
    const cleanupForTest = config.cleanup;
    if (cleanupForTest === undefined) {
      throw new Error('Expected test config cleanup');
    }
    cleanup = cleanupForTest;
    await config.createConnector({
      cwd: os.tmpdir(),
      agentId: 'agent-cleanup-failure',
      sessionId: 'session-cleanup-failure',
      model: 'claude-sonnet',
      reasoningEffort: 'low',
    });

    const unsubscribe = MakaioBus.on(ClientSubjects.sessionConfig.destroy, () => {
      throw new Error('destroy failed');
    });

    await expect(cleanupForTest()).resolves.toBeUndefined();
    cleanup = undefined;
    unsubscribe?.();
  });
});
