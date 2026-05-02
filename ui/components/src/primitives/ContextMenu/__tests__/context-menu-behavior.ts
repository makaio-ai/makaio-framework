/**
 * Shared behavioral test suite for context menu components.
 *
 * Covers keyboard interactions, click-outside behavior, and accessibility
 * assertions common to ContextMenu and its consumers (e.g. FileContextMenu).
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

type OnCloseSpy = ReturnType<typeof vi.fn>;

/**
 * Configuration for the shared context menu behavior test suite.
 * @param renderMenu - Renders the menu under test
 * @param getMenuContainer - Returns the rendered menu root element
 * @param getOnClose - Returns the onClose mock spy (vi.fn() instance)
 * @param expectedItemCount - Expected number of action buttons rendered
 */
export interface ContextMenuBehaviorConfig {
  /** Renders the context menu with default actions. */
  renderMenu: () => void;
  /**
   * Returns the root element of the rendered menu.
   * Used for click-inside tests where role="menu" is not present.
   * Prefer querying by aria-label or data-component attribute.
   */
  getMenuContainer: () => HTMLElement;
  /** Returns the onClose mock spy. */
  getOnClose: () => OnCloseSpy;
  /**
   * Expected number of action button elements.
   * Note: role="menuitem" is intentionally absent — see ContextMenu.tsx JSDoc.
   * Use role="button" count instead.
   */
  expectedItemCount: number;
}

/**
 * Describes shared behavioral tests for any context menu component.
 *
 * Asserts keyboard interaction (Escape closes, other keys ignored),
 * click-outside behavior, and accessibility patterns.
 * @param config - Test configuration
 */
export function describeContextMenuBehavior(config: ContextMenuBehaviorConfig): void {
  describe('keyboard interactions', () => {
    it('closes menu when Escape key is pressed', () => {
      config.renderMenu();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(config.getOnClose()).toHaveBeenCalledTimes(1);
    });

    it('does not close on other key presses', () => {
      config.renderMenu();
      fireEvent.keyDown(document, { key: 'Enter' });
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(config.getOnClose()).not.toHaveBeenCalled();
    });
  });

  describe('click outside behavior', () => {
    it('closes menu when clicking outside', () => {
      config.renderMenu();
      fireEvent.click(document.body);
      expect(config.getOnClose()).toHaveBeenCalledTimes(1);
    });

    it('does not close when clicking inside menu', () => {
      config.renderMenu();
      // role="menu" is intentionally omitted — use the container element instead.
      // See ContextMenu.tsx JSDoc for rationale.
      const menu = config.getMenuContainer();
      fireEvent.click(menu);
      expect(config.getOnClose()).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('renders expected number of action buttons', () => {
      config.renderMenu();
      // role="menuitem" is intentionally omitted — see ContextMenu.tsx JSDoc.
      // Actions are plain <button type="button"> elements inside <li> items.
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBe(config.expectedItemCount);
    });

    it('renders action buttons with type="button"', () => {
      config.renderMenu();
      const buttons = screen.getAllByRole('button');
      buttons.forEach((button) => {
        expect(button.getAttribute('type')).toBe('button');
      });
    });
  });
}
