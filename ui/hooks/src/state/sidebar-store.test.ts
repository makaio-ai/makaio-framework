// @vitest-environment jsdom

/**
 * Sidebar Store Tests
 *
 * Tests for sidebar collapsed state per navigation level with localStorage persistence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSidebarStore } from './sidebar-store.js';

declare module '@makaio/contracts' {
  interface UiNavigationLevelMap {
    detail: true;
    workspace: true;
  }
}

describe('useSidebarStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useSidebarStore.persist.clearStorage();
    useSidebarStore.setState({ collapsedByLevel: {} });
  });

  describe('initial state', () => {
    it('should have empty collapsedByLevel', () => {
      const state = useSidebarStore.getState();
      expect(state.collapsedByLevel).toEqual({});
    });

    it('should default to expanded (not collapsed) for all levels', () => {
      const { isCollapsed } = useSidebarStore.getState();
      expect(isCollapsed('root')).toBe(false);
      expect(isCollapsed('workspace')).toBe(false);
      expect(isCollapsed('detail')).toBe(false);
    });
  });

  describe('toggle', () => {
    it('should collapse an expanded sidebar', () => {
      useSidebarStore.getState().toggle('root');
      expect(useSidebarStore.getState().isCollapsed('root')).toBe(true);
    });

    it('should expand a collapsed sidebar', () => {
      useSidebarStore.setState({ collapsedByLevel: { root: true } });
      const { toggle } = useSidebarStore.getState();
      toggle('root');
      expect(useSidebarStore.getState().isCollapsed('root')).toBe(false);
    });

    it('should only affect the targeted level', () => {
      const { toggle } = useSidebarStore.getState();
      toggle('detail');

      const state = useSidebarStore.getState();
      expect(state.isCollapsed('detail')).toBe(true);
      expect(state.isCollapsed('root')).toBe(false);
      expect(state.isCollapsed('workspace')).toBe(false);
    });
  });

  describe('setCollapsed', () => {
    it('should set collapsed state explicitly', () => {
      const { setCollapsed } = useSidebarStore.getState();
      setCollapsed('workspace', true);
      expect(useSidebarStore.getState().isCollapsed('workspace')).toBe(true);
    });

    it('should set expanded state explicitly', () => {
      useSidebarStore.setState({
        collapsedByLevel: { workspace: true },
      });
      const { setCollapsed } = useSidebarStore.getState();
      setCollapsed('workspace', false);
      expect(useSidebarStore.getState().isCollapsed('workspace')).toBe(false);
    });

    it('should not affect other levels', () => {
      useSidebarStore.setState({
        collapsedByLevel: { root: true },
      });
      const { setCollapsed } = useSidebarStore.getState();
      setCollapsed('detail', true);

      const state = useSidebarStore.getState();
      expect(state.isCollapsed('root')).toBe(true);
      expect(state.isCollapsed('detail')).toBe(true);
      expect(state.isCollapsed('workspace')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('should persist to localStorage', () => {
      const { toggle } = useSidebarStore.getState();
      toggle('root');

      const stored = localStorage.getItem('makaio-sidebar');
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).state.collapsedByLevel).toEqual({ root: true });
    });

    it('should restore state from localStorage', async () => {
      localStorage.setItem(
        'makaio-sidebar',
        JSON.stringify({
          state: { collapsedByLevel: { detail: true, root: false } },
          version: 0,
        }),
      );

      await useSidebarStore.persist.rehydrate();

      const state = useSidebarStore.getState();
      expect(state.isCollapsed('detail')).toBe(true);
      expect(state.isCollapsed('root')).toBe(false);
      expect(state.isCollapsed('workspace')).toBe(false);
    });
  });
});
