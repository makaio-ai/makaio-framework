/**
 * Tests for resolveNavigation.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { WindowRegistry } from '@makaio/kernel';
import { resolveNavigation } from '../src/navigation-handler.js';
import { buildTestRegistry } from './fixtures.js';

describe('resolveNavigation', () => {
  let registry: WindowRegistry;

  beforeEach(() => {
    registry = buildTestRegistry();
  });

  describe('/apps/:packageName routes', () => {
    it('resolves /apps/:packageName/:windowId to an exact package-scoped window', () => {
      const result = resolveNavigation('/apps/test-app.dashboard/main', registry);
      expect(result?.qualifiedId).toBe('test-app.dashboard:main');
    });

    it('returns null for /apps/unknown-package', () => {
      expect(resolveNavigation('/apps/unknown-package', registry)).toBeNull();
    });

    it('passes query params through for explicit /apps routes', () => {
      const result = resolveNavigation('/apps/test-app.dashboard/main?projectId=abc', registry);
      expect(result?.params['projectId']).toBe('abc');
    });
  });

  describe('static singleton routes', () => {
    it('maps /test-app.dashboard:main (qualified) to test-app.dashboard:main', () => {
      const result = resolveNavigation('/test-app.dashboard:main', registry);
      expect(result?.qualifiedId).toBe('test-app.dashboard:main');
    });

    it('maps /test-app.monitor:main (qualified) to test-app.monitor:main', () => {
      const result = resolveNavigation('/test-app.monitor:main', registry);
      expect(result?.qualifiedId).toBe('test-app.monitor:main');
    });

    it('maps /test-app.manager:main (qualified) to test-app.manager:main', () => {
      const result = resolveNavigation('/test-app.manager:main', registry);
      expect(result?.qualifiedId).toBe('test-app.manager:main');
    });
  });

  describe('/apps/editor/:windowId routes', () => {
    it('resolves /apps/test-app.editor/main to test-app.editor:main', () => {
      const result = resolveNavigation('/apps/test-app.editor/main', registry);
      expect(result?.qualifiedId).toBe('test-app.editor:main');
    });

    it('passes query params through for editor routes', () => {
      const result = resolveNavigation('/apps/test-app.editor/main?projectId=abc-123', registry);
      expect(result?.qualifiedId).toBe('test-app.editor:main');
      expect(result?.params['projectId']).toBe('abc-123');
    });

    it('strips query string before matching', () => {
      const result = resolveNavigation('/apps/test-app.editor/main?tab=settings', registry);
      expect(result?.qualifiedId).toBe('test-app.editor:main');
    });
  });

  describe('/apps/editor session routes', () => {
    it('maps /apps/test-app.editor/main to test-app.editor:main without sessionId', () => {
      const result = resolveNavigation('/apps/test-app.editor/main', registry);
      expect(result?.qualifiedId).toBe('test-app.editor:main');
      expect(result?.params['sessionId']).toBeUndefined();
    });

    it('passes query params through for session routes', () => {
      const result = resolveNavigation('/apps/test-app.editor/main?sessionId=session-456', registry);
      expect(result?.qualifiedId).toBe('test-app.editor:main');
      expect(result?.params['sessionId']).toBe('session-456');
    });
  });

  describe('normalisation', () => {
    it('strips trailing slashes before matching', () => {
      expect(resolveNavigation('/apps/test-app.editor/main/', registry)?.qualifiedId).toBe('test-app.editor:main');
    });

    it('strips query strings before matching', () => {
      expect(resolveNavigation('/apps/test-app.dashboard/main?foo=bar', registry)?.qualifiedId).toBe(
        'test-app.dashboard:main',
      );
    });
  });

  describe('unrecognised routes', () => {
    it('returns null for an unknown single-segment path', () => {
      expect(resolveNavigation('/unknown', registry)).toBeNull();
    });

    it('returns null for the root path /', () => {
      expect(resolveNavigation('/', registry)).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(resolveNavigation('', registry)).toBeNull();
    });

    it('returns null for /apps without a packageName', () => {
      expect(resolveNavigation('/apps', registry)).toBeNull();
      expect(resolveNavigation('/apps/', registry)).toBeNull();
    });

    it('returns null for a deeply nested unrecognised path', () => {
      expect(resolveNavigation('/a/b/c', registry)).toBeNull();
    });
  });

  describe('empty registry', () => {
    it('returns null for all routes when registry is empty', () => {
      const empty = new WindowRegistry();
      expect(resolveNavigation('/test-app.dashboard:main', empty)).toBeNull();
      expect(resolveNavigation('/apps/test-app.dashboard/main', empty)).toBeNull();
    });
  });

  describe('ambiguous window ids across packages', () => {
    it('returns null for ambiguous /apps/:packageName when the package owns multiple windows', () => {
      registry.register('multi-window', 'Multi Window', { id: 'one', style: 'utility' });
      registry.register('multi-window', 'Multi Window', { id: 'two', style: 'utility' });

      expect(resolveNavigation('/apps/multi-window', registry)).toBeNull();
    });

    it('requires a qualified /apps/:packageName/:windowId route to disambiguate', () => {
      registry.register('multi-window', 'Multi Window', { id: 'one', style: 'utility' });
      registry.register('multi-window', 'Multi Window', { id: 'two', style: 'utility' });

      const result = resolveNavigation('/apps/multi-window/one', registry);
      expect(result?.qualifiedId).toBe('multi-window:one');
    });

    it('returns null for the unqualified /main when multiple packages register main', () => {
      // All test packages use window id 'main', so /main is inherently ambiguous.
      expect(resolveNavigation('/main', registry)).toBeNull();
    });
  });
});
