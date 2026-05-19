/// <reference types="bun-types" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  FRAMEWORK_FALLBACK_WINDOW,
  resolveInitialCustomData,
  resolveInitialWindowId,
  resolveInitialWindowState,
} from '../src/startup-env.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  mock.restore();
});

describe('startup-env', () => {
  describe('resolveInitialWindowId', () => {
    it('defaults to framework-shell:main when MAKAIO_INITIAL_WINDOW is unset', () => {
      delete process.env['MAKAIO_INITIAL_WINDOW'];
      expect(resolveInitialWindowId()).toBe(FRAMEWORK_FALLBACK_WINDOW);
    });

    it('defaults to framework-shell:main when MAKAIO_INITIAL_WINDOW is empty', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = '';
      expect(resolveInitialWindowId()).toBe(FRAMEWORK_FALLBACK_WINDOW);
    });

    it('defaults to framework-shell:main when MAKAIO_INITIAL_WINDOW is whitespace-only', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = '   ';
      expect(resolveInitialWindowId()).toBe(FRAMEWORK_FALLBACK_WINDOW);
    });

    it('trims surrounding whitespace from MAKAIO_INITIAL_WINDOW before returning it', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = '  test-app.manager:main  ';
      expect(resolveInitialWindowId()).toBe('test-app.manager:main');
    });

    it('returns the qualified ID from MAKAIO_INITIAL_WINDOW when set', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = 'test-app.manager:main';
      expect(resolveInitialWindowId()).toBe('test-app.manager:main');
    });

    it('passes through arbitrary qualified IDs without validation', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = 'my-package:custom-window';
      expect(resolveInitialWindowId()).toBe('my-package:custom-window');
    });

    it('treats an explicit framework-shell override as an override', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = FRAMEWORK_FALLBACK_WINDOW;
      expect(resolveInitialWindowState()).toEqual({
        registrationId: FRAMEWORK_FALLBACK_WINDOW,
        isOverride: true,
      });
    });
  });

  describe('resolveInitialCustomData', () => {
    it('collects custom startup data keys and excludes the window key', () => {
      process.env['MAKAIO_INITIAL_WINDOW'] = 'test-app.settings:main';
      process.env['MAKAIO_INITIAL_PROJECT_ID'] = 'project-123';
      process.env['MAKAIO_INITIAL_SESSION_ID'] = 'session-456';
      process.env['MAKAIO_INITIAL_USER_PROMPT'] = 'hello';

      expect(resolveInitialCustomData()).toEqual({
        projectId: 'project-123',
        sessionId: 'session-456',
        userPrompt: 'hello',
      });
    });
  });
});
