import { describe, it, expect } from 'vitest';
import { detectShell, getColorEnv, type Platform } from '../../src/utils/platform.js';

describe('Platform utilities', () => {
  describe('detectShell', () => {
    describe('posix platform', () => {
      const platform: Platform = 'posix';

      it('returns SHELL env var when set', () => {
        const env = { SHELL: '/bin/zsh' };
        expect(detectShell(platform, env)).toBe('/bin/zsh');
      });

      it('returns bash as default when SHELL not set', () => {
        const env = {};
        expect(detectShell(platform, env)).toBe('bash');
      });

      it('returns bash when SHELL is undefined', () => {
        const env = { SHELL: undefined };
        expect(detectShell(platform, env)).toBe('bash');
      });

      it('returns bash when SHELL is empty string', () => {
        const env = { SHELL: '' };
        expect(detectShell(platform, env)).toBe('bash');
      });
    });

    describe('windows platform', () => {
      const platform: Platform = 'windows';

      it('returns powershell regardless of env', () => {
        expect(detectShell(platform, {})).toBe('powershell');
        expect(detectShell(platform, { SHELL: '/bin/bash' })).toBe('powershell');
        expect(detectShell(platform, { ComSpec: 'cmd.exe' })).toBe('powershell');
      });
    });
  });

  describe('getColorEnv', () => {
    it('returns empty object when colors enabled', () => {
      const env = getColorEnv(true);
      expect(env).toEqual({});
    });

    it('returns NO_COLOR and FORCE_COLOR when colors disabled', () => {
      const env = getColorEnv(false);
      expect(env).toEqual({
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      });
    });
  });
});
