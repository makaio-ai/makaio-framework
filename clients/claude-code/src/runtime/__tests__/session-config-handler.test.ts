import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeCredentialMockState = vi.hoisted(() => ({
  inheritCalls: [] as Array<{ sourceConfigDir: string; sessionDir: string; platform: NodeJS.Platform }>,
  clearCalls: [] as Array<{ sessionDir: string; platform: NodeJS.Platform }>,
}));

// Native credential inheritance has its own real-filesystem coverage; this
// handler suite mocks the platform boundary to focus on config materialization.
vi.mock('../native-credentials.js', () => ({
  inheritClaudeCodeNativeCredentialsForSession: vi.fn(
    async (request: { sourceConfigDir: string; sessionDir: string; platform: NodeJS.Platform }) => {
      nativeCredentialMockState.inheritCalls.push(request);
      return { prepared: true };
    },
  ),
  clearClaudeCodeNativeCredentialsForSession: vi.fn(
    async (request: { sessionDir: string; platform: NodeJS.Platform }) => {
      nativeCredentialMockState.clearCalls.push(request);
    },
  ),
}));

import { handleClaudeCodeSessionConfigSetup } from '../session-config-handler.js';

describe('handleClaudeCodeSessionConfigSetup', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    nativeCredentialMockState.inheritCalls.length = 0;
    nativeCredentialMockState.clearCalls.length = 0;
    let dir = tempDirs.pop();
    while (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
      dir = tempDirs.pop();
    }
  });

  /**
   * Create and track a temporary directory.
   * @param prefix - Directory name prefix.
   * @returns Temporary directory path.
   */
  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  /**
   * Read a JSON file as an object.
   * @param filePath - Path to the JSON file.
   * @returns Parsed object.
   */
  async function readJson(filePath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, unknown>;
  }

  it('uses native Claude config as immutable source when no profile base exists', async () => {
    const homeDir = await makeTempDir('makaio-claude-home-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    const nativeConfigDir = path.join(homeDir, '.claude');
    await fs.mkdir(nativeConfigDir, { recursive: true });
    await fs.writeFile(path.join(nativeConfigDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');
    vi.stubEnv('HOME', homeDir);

    const result = await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sessionDir,
      platform: 'darwin',
      configInheritance: 'full',
    });

    await expect(fs.readFile(path.join(sessionDir, 'settings.json'), 'utf-8')).resolves.toBe('{"theme":"dark"}');
    await expect(fs.readFile(path.join(nativeConfigDir, 'settings.json'), 'utf-8')).resolves.toBe('{"theme":"dark"}');
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: sessionDir });
  });

  it('full inheritance scrubs stale Makaio wiring from copied settings files', async () => {
    const sourceDir = await makeTempDir('makaio-claude-source-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    await fs.writeFile(
      path.join(sourceDir, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'makaio hook received claude-code SessionStart' },
                { type: 'command', command: 'echo keep-session-start' },
              ],
            },
          ],
        },
        statusLine: {
          type: 'command',
          command: 'makaio claude statusline --upstream-args-json \'["-c","echo keep-status"]\'',
        },
      }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(sourceDir, 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'makaio hook received claude-code Stop' }] }],
        },
        enabledPlugins: { 'user-plugin': true },
      }),
      'utf-8',
    );

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sourceDir,
      platform: 'darwin',
      configInheritance: 'full',
    });

    const settings = await readJson(path.join(sessionDir, 'settings.json'));
    expect(settings['theme']).toBe('dark');
    expect(settings['statusLine']).toEqual({ type: 'command', command: 'echo keep-status' });
    const hooks = settings['hooks'] as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks['SessionStart'][0].hooks.map((hook) => hook.command)).toEqual(['echo keep-session-start']);

    const localSettings = await readJson(path.join(sessionDir, 'settings.local.json'));
    expect(localSettings['hooks']).toEqual({});
    expect(localSettings['enabledPlugins']).toEqual({ 'user-plugin': true });
  });

  it('auth-only inheritance creates empty settings and delegates native credential inheritance', async () => {
    const sourceDir = await makeTempDir('makaio-claude-source-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    await fs.writeFile(path.join(sourceDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');
    await fs.writeFile(path.join(sourceDir, 'settings.local.json'), '{"enabledPlugins":{"user-plugin":true}}', 'utf-8');

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sourceDir,
      platform: 'linux',
      configInheritance: 'auth-only',
    });

    await expect(fs.readFile(path.join(sessionDir, 'settings.json'), 'utf-8')).resolves.toBe('{}');
    await expect(fs.access(path.join(sessionDir, 'settings.local.json'))).rejects.toThrow();
    expect(nativeCredentialMockState.inheritCalls).toEqual([
      { sourceConfigDir: sourceDir, sessionDir, platform: 'linux' },
    ]);
  });

  it('auth-only inheritance copies only Claude auth state from native global state', async () => {
    const homeDir = await makeTempDir('makaio-claude-home-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    const nativeConfigDir = path.join(homeDir, '.claude');
    await fs.mkdir(nativeConfigDir, { recursive: true });
    await fs.writeFile(path.join(nativeConfigDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');
    await fs.writeFile(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: 'acct-1', emailAddress: 'user@example.test' },
        customApiKeyResponses: { approved: true },
        userID: 'user-1',
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.118',
        projects: { '/repo': { history: [] } },
        cachedStatsigGates: { gate: true },
      }),
      'utf-8',
    );
    vi.stubEnv('HOME', homeDir);

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sessionDir,
      platform: 'darwin',
      configInheritance: 'auth-only',
    });

    const state = await readJson(path.join(sessionDir, '.claude.json'));
    expect(state).toEqual({
      oauthAccount: { accountUuid: 'acct-1', emailAddress: 'user@example.test' },
      customApiKeyResponses: { approved: true },
      userID: 'user-1',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.118',
    });
  });

  it('auth-only inheritance reads profile-local state when the profile dir is named .claude', async () => {
    const profileParentDir = await makeTempDir('makaio-claude-profile-parent-');
    const sourceDir = path.join(profileParentDir, '.claude');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(profileParentDir, '.claude.json'), '{"userID":"parent-state"}', 'utf-8');
    await fs.writeFile(path.join(sourceDir, '.claude.json'), '{"userID":"profile-state"}', 'utf-8');

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sourceDir,
      platform: 'linux',
      configInheritance: 'auth-only',
    });

    const state = await readJson(path.join(sessionDir, '.claude.json'));
    expect(state).toEqual({ userID: 'profile-state' });
  });

  it('auth-only inheritance adds only the current project folder trust marker', async () => {
    const homeDir = await makeTempDir('makaio-claude-home-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    const projectDir = await makeTempDir('makaio-claude-project-');
    const nativeConfigDir = path.join(homeDir, '.claude');
    await fs.mkdir(nativeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: {
          '/other/repo': {
            hasTrustDialogAccepted: false,
            history: [{ display: 'do not copy' }],
          },
        },
      }),
      'utf-8',
    );
    vi.stubEnv('HOME', homeDir);

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sessionDir,
      projectDir,
      platform: 'darwin',
      configInheritance: 'auth-only',
    });

    const projectKey = await fs.realpath(projectDir);
    const state = await readJson(path.join(sessionDir, '.claude.json'));
    expect(state).toEqual({
      hasCompletedOnboarding: true,
      projects: {
        [projectKey]: {
          hasTrustDialogAccepted: true,
        },
      },
    });
  });

  it('auth-only inheritance delegates macOS native credential inheritance', async () => {
    const homeDir = await makeTempDir('makaio-claude-home-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    await fs.mkdir(path.join(homeDir, '.claude'), { recursive: true });
    vi.stubEnv('HOME', homeDir);

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sessionDir,
      platform: 'darwin',
      configInheritance: 'auth-only',
    });

    expect(nativeCredentialMockState.inheritCalls).toEqual([
      { sourceConfigDir: path.join(homeDir, '.claude'), sessionDir, platform: 'darwin' },
    ]);
  });

  it('empty inheritance creates empty settings and delegates native credential cleanup', async () => {
    const sourceDir = await makeTempDir('makaio-claude-source-');
    const sessionDir = await makeTempDir('makaio-claude-session-');
    await fs.writeFile(path.join(sourceDir, 'settings.json'), '{"theme":"dark"}', 'utf-8');

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sourceDir,
      platform: 'linux',
      configInheritance: 'empty',
    });

    await expect(fs.readFile(path.join(sessionDir, 'settings.json'), 'utf-8')).resolves.toBe('{}');
    expect(nativeCredentialMockState.clearCalls).toEqual([{ sessionDir, platform: 'linux' }]);
  });

  it('empty inheritance delegates macOS native credential cleanup', async () => {
    const sourceDir = await makeTempDir('makaio-claude-source-');
    const sessionDir = await makeTempDir('makaio-claude-session-');

    await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: sourceDir,
      platform: 'darwin',
      configInheritance: 'empty',
    });

    expect(nativeCredentialMockState.clearCalls).toEqual([{ sessionDir, platform: 'darwin' }]);
  });
});
