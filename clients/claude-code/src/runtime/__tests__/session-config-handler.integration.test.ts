import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleClaudeCodeSessionConfigSetup } from '../session-config-handler.js';

describe('handleClaudeCodeSessionConfigSetup filesystem integration', () => {
  /**
   * Read a JSON file as an object.
   * @param filePath - Path to the JSON file.
   * @returns Parsed object.
   */
  async function readJson(filePath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
  }

  it('materializes auth-only config and filesystem credentials with real file operations', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-session-config-'));
    try {
      const sourceDir = path.join(rootDir, 'source');
      const sessionDir = path.join(rootDir, 'session');
      const projectDir = path.join(rootDir, 'project');
      await fs.mkdir(sourceDir);
      await fs.mkdir(sessionDir);
      await fs.mkdir(projectDir);
      await fs.writeFile(path.join(sourceDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');
      await fs.writeFile(
        path.join(sourceDir, 'settings.local.json'),
        '{"enabledPlugins":{"user-plugin":true}}',
        'utf-8',
      );
      await fs.writeFile(path.join(sourceDir, '.credentials.json'), '{"refreshToken":"initial"}', 'utf-8');
      await fs.writeFile(
        path.join(sourceDir, '.claude.json'),
        JSON.stringify({
          userID: 'user-1',
          hasCompletedOnboarding: true,
          projects: { '/other/repo': { hasTrustDialogAccepted: false } },
        }),
        'utf-8',
      );

      const result = await handleClaudeCodeSessionConfigSetup({
        sessionDir,
        baseConfigDir: sourceDir,
        projectDir,
        platform: 'linux',
        configInheritance: 'auth-only',
      });

      expect(result).toEqual({ env: { CLAUDE_CONFIG_DIR: sessionDir } });
      await expect(fs.readFile(path.join(sessionDir, 'settings.json'), 'utf-8')).resolves.toBe('{}');
      await expect(fs.access(path.join(sessionDir, 'settings.local.json'))).rejects.toThrow();
      expect(await fs.readlink(path.join(sessionDir, '.credentials.json'))).toBe(
        path.join(sourceDir, '.credentials.json'),
      );

      await fs.writeFile(path.join(sourceDir, '.credentials.json'), '{"refreshToken":"rotated"}', 'utf-8');
      await expect(fs.readFile(path.join(sessionDir, '.credentials.json'), 'utf-8')).resolves.toBe(
        '{"refreshToken":"rotated"}',
      );

      const projectKey = await fs.realpath(projectDir);
      expect(await readJson(path.join(sessionDir, '.claude.json'))).toEqual({
        userID: 'user-1',
        hasCompletedOnboarding: true,
        projects: {
          [projectKey]: {
            hasTrustDialogAccepted: true,
          },
        },
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
