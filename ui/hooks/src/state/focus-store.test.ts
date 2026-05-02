/**
 * Focus Store Tests
 *
 * Tests for focus context state management with Zustand.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFocusStore, INITIAL_FOCUS_STATE } from './focus-store.js';
import type { FocusContextObject } from './focus-store.js';
import type { FocusContextLayout } from '../types/widget-layout.js';

describe('useFocusStore', () => {
  beforeEach(() => {
    // Reset to the production bootstrap state, not a hand-duplicated fixture.
    useFocusStore.setState(INITIAL_FOCUS_STATE);
  });

  describe('initial state', () => {
    it('should have chat as default focus context', () => {
      const state = useFocusStore.getState();

      expect(state.activeFocus.id).toBe('chat');
      expect(state.activeFocus.name).toBe('Chat');
      expect(state.activeFocus.isPreset).toBe(true);
    });

    it('should have quick prompt suggestions for chat context', () => {
      const state = useFocusStore.getState();
      const suggestions = state.activeFocus.quickPromptSuggestions;

      expect(suggestions).toBeDefined();
      expect(suggestions).toHaveLength(3);
      expect(suggestions?.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    });

    it('should not have a layout initially', () => {
      const state = useFocusStore.getState();

      expect(state.activeFocus.layout).toBeUndefined();
    });
  });

  describe('setActiveFocus', () => {
    it('should set focus context by preset ID', () => {
      const { setActiveFocus } = useFocusStore.getState();

      setActiveFocus('git');

      const state = useFocusStore.getState();
      expect(state.activeFocus.id).toBe('git');
      expect(state.activeFocus.name).toBe('Git');
      expect(state.activeFocus.isPreset).toBe(true);
    });

    it('should include quick prompt suggestions for git context', () => {
      const { setActiveFocus } = useFocusStore.getState();

      setActiveFocus('git');

      const state = useFocusStore.getState();
      const suggestions = state.activeFocus.quickPromptSuggestions;

      expect(suggestions).toBeDefined();
      expect(suggestions).toHaveLength(3);
      expect(suggestions?.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    });

    it('should switch to review context', () => {
      const { setActiveFocus } = useFocusStore.getState();

      setActiveFocus('review');

      const state = useFocusStore.getState();
      expect(state.activeFocus.id).toBe('review');
      expect(state.activeFocus.name).toBe('Code Review');
    });

    it('should switch to planning context', () => {
      const { setActiveFocus } = useFocusStore.getState();

      setActiveFocus('planning');

      const state = useFocusStore.getState();
      expect(state.activeFocus.id).toBe('planning');
      expect(state.activeFocus.name).toBe('Planning');
    });

    it('should switch to settings context', () => {
      const { setActiveFocus } = useFocusStore.getState();

      setActiveFocus('settings');

      const state = useFocusStore.getState();
      expect(state.activeFocus.id).toBe('settings');
      expect(state.activeFocus.name).toBe('Settings');
    });

    it('should keep current focus and log when preset id is invalid at runtime', () => {
      const { setActiveFocus } = useFocusStore.getState();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      setActiveFocus('git');
      const beforeInvalid = useFocusStore.getState().activeFocus;

      (setActiveFocus as (focusId: string) => void)('invalid-focus');

      const state = useFocusStore.getState();
      expect(state.activeFocus).toEqual(beforeInvalid);
      expect(consoleSpy).toHaveBeenCalledWith('[focusStore] Unknown focus preset id: invalid-focus');
      consoleSpy.mockRestore();
    });
  });

  describe('setActiveFocusContext', () => {
    it('should set custom focus context object', () => {
      const { setActiveFocusContext } = useFocusStore.getState();
      const customContext: FocusContextObject = {
        id: 'custom-context',
        name: 'Custom Context',
        isPreset: false,
        quickPromptSuggestions: ['Custom prompt'],
      };

      setActiveFocusContext(customContext);

      const state = useFocusStore.getState();
      expect(state.activeFocus).toEqual(customContext);
    });

    it('should set focus context with layout', () => {
      const { setActiveFocusContext } = useFocusStore.getState();
      const layout: FocusContextLayout = {
        version: 1,
        widgets: [
          {
            widgetId: 'test-widget',
            size: 'medium',
          },
        ],
      };
      const context: FocusContextObject = {
        id: 'custom-with-layout',
        name: 'Custom with Layout',
        layout,
      };

      setActiveFocusContext(context);

      const state = useFocusStore.getState();
      expect(state.activeFocus.layout).toEqual(layout);
    });
  });

  describe('setFocusContextLayout', () => {
    it('should update layout for current focus context', () => {
      const { setFocusContextLayout } = useFocusStore.getState();
      const layout: FocusContextLayout = {
        version: 1,
        widgets: [
          {
            widgetId: 'widget-1',
            size: 'small',
          },
          {
            widgetId: 'widget-2',
            size: 'large',
          },
        ],
      };

      setFocusContextLayout(layout);

      const state = useFocusStore.getState();
      expect(state.activeFocus.layout).toEqual(layout);
      expect(state.activeFocus.layout?.widgets).toHaveLength(2);
    });

    it('should preserve other context properties when updating layout', () => {
      const { setFocusContextLayout } = useFocusStore.getState();
      const layout: FocusContextLayout = {
        version: 1,
        widgets: [],
      };

      setFocusContextLayout(layout);

      const state = useFocusStore.getState();
      expect(state.activeFocus.id).toBe('chat');
      expect(state.activeFocus.name).toBe('Chat');
      expect(state.activeFocus.isPreset).toBe(true);
      expect(state.activeFocus.quickPromptSuggestions).toBeDefined();
    });

    it('should replace existing layout', () => {
      const { setFocusContextLayout } = useFocusStore.getState();
      const firstLayout: FocusContextLayout = {
        version: 1,
        widgets: [{ widgetId: 'widget-1', size: 'small' }],
      };
      const secondLayout: FocusContextLayout = {
        version: 1,
        widgets: [{ widgetId: 'widget-2', size: 'large' }],
      };

      setFocusContextLayout(firstLayout);
      setFocusContextLayout(secondLayout);

      const state = useFocusStore.getState();
      expect(state.activeFocus.layout).toEqual(secondLayout);
      expect(state.activeFocus.layout?.widgets).toHaveLength(1);
      expect(state.activeFocus.layout?.widgets[0].widgetId).toBe('widget-2');
    });
  });

  describe('getFocusContextLayout', () => {
    it('should return undefined when no layout is set', () => {
      const { getFocusContextLayout } = useFocusStore.getState();

      const layout = getFocusContextLayout();

      expect(layout).toBeUndefined();
    });

    it('should return layout when set', () => {
      const { setFocusContextLayout, getFocusContextLayout } = useFocusStore.getState();
      const expectedLayout: FocusContextLayout = {
        version: 1,
        widgets: [
          {
            widgetId: 'test-widget',
            size: 'medium',
          },
        ],
      };

      setFocusContextLayout(expectedLayout);
      const layout = getFocusContextLayout();

      expect(layout).toEqual(expectedLayout);
    });
  });

  describe('integration scenarios', () => {
    it('should reset preset layout when switching away and back', () => {
      const { setActiveFocus, setFocusContextLayout, getFocusContextLayout } = useFocusStore.getState();
      const chatLayout: FocusContextLayout = {
        version: 1,
        widgets: [{ widgetId: 'chat-widget', size: 'large' }],
      };

      // Set layout for chat
      setFocusContextLayout(chatLayout);
      expect(getFocusContextLayout()).toEqual(chatLayout);

      // Switch to git
      setActiveFocus('git');

      // Chat layout should not affect git context
      expect(getFocusContextLayout()).toBeUndefined();

      // Switch back to chat
      setActiveFocus('chat');

      // Note: In real implementation, each context would maintain its own layout
      // For now, this test documents the current behavior where layout is per-context
      // but only stored on the active context object.
      // Switching back to chat reloads the preset, so the layout set earlier is lost.
      expect(getFocusContextLayout()).toBeUndefined();
      expect(useFocusStore.getState().activeFocus.id).toBe('chat');
    });

    it('should support custom context creation and activation', () => {
      const { setActiveFocusContext } = useFocusStore.getState();
      const customContext: FocusContextObject = {
        id: 'my-custom-context',
        name: 'My Custom Context',
        isPreset: false,
        layout: {
          version: 1,
          widgets: [
            {
              widgetId: 'custom-widget',
              size: 'medium',
              x: 10,
              y: 20,
            },
          ],
        },
        quickPromptSuggestions: ['Custom prompt 1', 'Custom prompt 2'],
      };

      setActiveFocusContext(customContext);

      const state = useFocusStore.getState();
      expect(state.activeFocus).toEqual(customContext);
      expect(state.activeFocus.layout?.widgets).toHaveLength(1);
      expect(state.activeFocus.layout?.widgets[0].widgetId).toBe('custom-widget');
    });
  });
});
