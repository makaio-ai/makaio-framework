import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionEditorSubjects } from '../../../session-editor/namespace.js';
import { actionRegistry } from '../action-registry.js';
import { registerListActionsHandler } from '../handlers.js';

describe('session-editor handlers', () => {
  beforeEach(() => {
    actionRegistry.reset();
  });

  describe('registerListActionsHandler', () => {
    it('returns empty array when no actions registered', async () => {
      const cleanup = registerListActionsHandler(MakaioBus);

      try {
        const { actions } = await MakaioBus.request(SessionEditorSubjects.listActions, {});
        expect(actions).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('returns UI-safe action summaries without execute method', async () => {
      // Register a test action
      actionRegistry.register({
        id: 'test-action',
        label: 'Test Action',
        description: 'A test action for unit testing',
        category: 'compression',
        execute: async () => ({ kind: 'messages', messages: [] }),
      });

      const cleanup = registerListActionsHandler(MakaioBus);

      try {
        const { actions } = await MakaioBus.request(SessionEditorSubjects.listActions, {});

        expect(actions).toHaveLength(1);
        expect(actions[0]).toEqual({
          id: 'test-action',
          label: 'Test Action',
          description: 'A test action for unit testing',
          category: 'compression',
        });

        // Verify execute method is NOT included
        expect(actions[0]).not.toHaveProperty('execute');
      } finally {
        cleanup();
      }
    });

    it('returns all registered actions grouped by category', async () => {
      // Register multiple actions
      actionRegistry.register({
        id: 'compress-1',
        label: 'Compression Action 1',
        description: 'First compression action',
        category: 'compression',
        execute: async () => ({ kind: 'messages', messages: [] }),
      });

      actionRegistry.register({
        id: 'extract-1',
        label: 'Extraction Action 1',
        description: 'First extraction action',
        category: 'extraction',
        execute: async () => ({ kind: 'context', json: {} }),
      });

      actionRegistry.register({
        id: 'transform-1',
        label: 'Transform Action 1',
        description: 'First transform action',
        category: 'transformation',
        execute: async () => ({ kind: 'messages', messages: [] }),
      });

      const cleanup = registerListActionsHandler(MakaioBus);

      try {
        const { actions } = await MakaioBus.request(SessionEditorSubjects.listActions, {});

        expect(actions).toHaveLength(3);

        // Verify categories are preserved
        expect(actions.find((a) => a.id === 'compress-1')?.category).toBe('compression');
        expect(actions.find((a) => a.id === 'extract-1')?.category).toBe('extraction');
        expect(actions.find((a) => a.id === 'transform-1')?.category).toBe('transformation');
      } finally {
        cleanup();
      }
    });

    it('cleanup function unregisters handler', async () => {
      const cleanup = registerListActionsHandler(MakaioBus);
      cleanup();

      // After cleanup, the handler should no longer be registered
      const result = await MakaioBus.requestOptional(SessionEditorSubjects.listActions, {});
      expect(result.handled).toBe(false);
    });
  });
});
