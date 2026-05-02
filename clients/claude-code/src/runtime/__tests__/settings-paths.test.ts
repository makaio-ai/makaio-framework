/**
 * Unit tests for Claude Code settings path resolution.
 *
 * Verifies that {@link resolveClaudeCodeSettingsPaths} resolves paths
 * correctly across all supported option combinations:
 *   - no options (default user-scope behaviour)
 *   - `configDir` override without `projectDir`
 *   - `configDir` + `projectDir` together
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

import { resolveClaudeCodeSettingsPaths } from '../settings-paths.js';

describe('resolveClaudeCodeSettingsPaths', () => {
  describe('no options (default behaviour)', () => {
    it('returns exactly one entry scoped to user', () => {
      const result = resolveClaudeCodeSettingsPaths();
      expect(result).toHaveLength(1);
      expect(result[0]?.scope).toBe('user');
    });

    it('places the user settings file at ~/.claude/settings.json', () => {
      const result = resolveClaudeCodeSettingsPaths();
      const expected = path.join(os.homedir(), '.claude', 'settings.json');
      expect(result[0]?.path).toBe(expected);
    });
  });

  describe('configDir override (no projectDir)', () => {
    it('returns exactly one entry scoped to user', () => {
      const result = resolveClaudeCodeSettingsPaths({ configDir: '/tmp/isolated' });
      expect(result).toHaveLength(1);
      expect(result[0]?.scope).toBe('user');
    });

    it('places the user settings file inside configDir, not ~/.claude', () => {
      const configDir = path.join(os.tmpdir(), 'isolated');
      const result = resolveClaudeCodeSettingsPaths({ configDir });
      expect(result[0]?.path).toBe(path.join(configDir, 'settings.json'));
    });

    it('does not include the default ~/.claude path', () => {
      const result = resolveClaudeCodeSettingsPaths({ configDir: path.join(os.tmpdir(), 'isolated') });
      const defaultPath = path.join(os.homedir(), '.claude', 'settings.json');
      expect(result[0]?.path).not.toBe(defaultPath);
    });
  });

  describe('configDir + projectDir', () => {
    it('returns three entries: user, project, local', () => {
      const configDir = path.join(os.tmpdir(), 'isolated');
      const projectDir = path.join(os.tmpdir(), 'my-project');
      const result = resolveClaudeCodeSettingsPaths({
        configDir,
        projectDir,
      });
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.scope)).toEqual(['user', 'project', 'local']);
    });

    it('user scope path resolves to configDir/settings.json', () => {
      const configDir = path.join(os.tmpdir(), 'isolated');
      const result = resolveClaudeCodeSettingsPaths({
        configDir,
        projectDir: path.join(os.tmpdir(), 'my-project'),
      });
      const userEntry = result.find((e) => e.scope === 'user');
      expect(userEntry?.path).toBe(path.join(configDir, 'settings.json'));
    });

    it('project scope path resolves to projectDir/.claude/settings.json', () => {
      const projectDir = path.join(os.tmpdir(), 'my-project');
      const result = resolveClaudeCodeSettingsPaths({
        configDir: path.join(os.tmpdir(), 'isolated'),
        projectDir,
      });
      const projectEntry = result.find((e) => e.scope === 'project');
      expect(projectEntry?.path).toBe(path.join(projectDir, '.claude', 'settings.json'));
    });

    it('local scope path resolves to projectDir/.claude/settings.local.json', () => {
      const projectDir = path.join(os.tmpdir(), 'my-project');
      const result = resolveClaudeCodeSettingsPaths({
        configDir: path.join(os.tmpdir(), 'isolated'),
        projectDir,
      });
      const localEntry = result.find((e) => e.scope === 'local');
      expect(localEntry?.path).toBe(path.join(projectDir, '.claude', 'settings.local.json'));
    });
  });

  describe('projectDir without configDir (original positional-arg behaviour)', () => {
    it('returns three entries: user, project, local', () => {
      const result = resolveClaudeCodeSettingsPaths({ projectDir: path.join(os.tmpdir(), 'some-project') });
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.scope)).toEqual(['user', 'project', 'local']);
    });

    it('user scope path is still ~/.claude/settings.json when no configDir given', () => {
      const result = resolveClaudeCodeSettingsPaths({ projectDir: '/some/project' });
      const expected = path.join(os.homedir(), '.claude', 'settings.json');
      expect(result.find((e) => e.scope === 'user')?.path).toBe(expected);
    });

    it('project scope path resolves relative to the provided projectDir', () => {
      const projectDir = path.join(os.tmpdir(), 'some-project');
      const result = resolveClaudeCodeSettingsPaths({ projectDir });
      expect(result.find((e) => e.scope === 'project')?.path).toBe(path.join(projectDir, '.claude', 'settings.json'));
    });
  });
});
