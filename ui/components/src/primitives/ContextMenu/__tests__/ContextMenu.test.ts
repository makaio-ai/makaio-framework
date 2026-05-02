/**
 * \@vitest-environment jsdom
 */

import { createElement } from 'react';
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from '../ContextMenu.js';
import type { ContextMenuAction, CategoryConfig } from '../ContextMenu.types.js';
import { describeContextMenuBehavior } from './context-menu-behavior.js';

const CATEGORY_CONFIG: Record<string, CategoryConfig> = {
  view: { label: 'View', order: 0 },
  clipboard: { label: 'Clipboard', order: 1 },
  navigate: { label: 'Navigate', order: 2 },
  plugin: { label: 'Plugins', order: 3 },
};

/**
 * Creates a set of test actions covering multiple categories.
 */
function createTestActions(): ContextMenuAction[] {
  return [
    {
      id: 'view-item',
      label: 'View Item',
      category: 'view',
      icon: 'eye',
      shortcut: 'Cmd+V',
    },
    {
      id: 'copy-path',
      label: 'Copy Path',
      category: 'clipboard',
      icon: 'copy',
      shortcut: 'Cmd+C',
    },
    {
      id: 'open-external',
      label: 'Open External',
      category: 'navigate',
    },
    {
      id: 'plugin-action',
      label: 'Plugin Action',
      category: 'plugin',
    },
  ];
}

describe('ContextMenu', () => {
  let mockOnClose: Mock<() => void>;
  let mockOnExecute: (actionId: string) => void;

  beforeEach(() => {
    mockOnClose = vi.fn();
    mockOnExecute = vi.fn();
  });

  const renderMenu = (actions: ContextMenuAction[] = createTestActions(), header?: ReturnType<typeof createElement>) =>
    render(
      createElement(ContextMenu, {
        actions,
        position: { x: 100, y: 200 },
        onClose: () => mockOnClose(),
        onExecute: mockOnExecute,
        categoryConfig: CATEGORY_CONFIG,
        ariaLabel: 'Test actions',
        header,
      }),
    );

  describe('basic rendering', () => {
    it('renders menu container with aria-label', () => {
      renderMenu();
      // role="menu" is intentionally omitted — see ContextMenu.tsx JSDoc.
      // The container retains aria-label for context; it renders as a generic div.
      const menu = document.querySelector('[data-component="ContextMenu"]') as HTMLElement;
      expect(menu).toBeTruthy();
      expect(menu.getAttribute('aria-label')).toBe('Test actions');
    });

    it('positions menu at specified coordinates', () => {
      renderMenu();
      const menu = document.querySelector('[data-component="ContextMenu"]') as HTMLElement;
      expect(menu.style.left).toBe('100px');
      expect(menu.style.top).toBe('200px');
    });

    it('renders all action labels', () => {
      renderMenu();
      expect(screen.getByText('View Item')).toBeTruthy();
      expect(screen.getByText('Copy Path')).toBeTruthy();
      expect(screen.getByText('Open External')).toBeTruthy();
      expect(screen.getByText('Plugin Action')).toBeTruthy();
    });

    it('renders keyboard shortcuts when provided', () => {
      renderMenu();
      expect(screen.getByText('Cmd+V')).toBeTruthy();
      expect(screen.getByText('Cmd+C')).toBeTruthy();
    });

    it('renders empty state when no actions available', () => {
      renderMenu([]);
      expect(screen.getByText('No actions available')).toBeTruthy();
    });

    it('renders optional header content', () => {
      const header = createElement('span', { 'data-testid': 'custom-header' }, 'Header Text');
      renderMenu(createTestActions(), header);
      expect(screen.getByTestId('custom-header')).toBeTruthy();
      expect(screen.getByText('Header Text')).toBeTruthy();
    });

    it('does not render header section when no header provided', () => {
      const { container } = renderMenu();
      // The header div should not be present
      const headerDiv = container.querySelector('[class*="header"]');
      expect(headerDiv).toBeFalsy();
    });
  });

  describe('category grouping and sorting', () => {
    it('groups actions by category with proper labels', () => {
      renderMenu();
      expect(screen.getByText('View', { exact: true })).toBeTruthy();
      expect(screen.getByText('Clipboard', { exact: true })).toBeTruthy();
      expect(screen.getByText('Navigate', { exact: true })).toBeTruthy();
      expect(screen.getByText('Plugins', { exact: true })).toBeTruthy();
    });

    it('sorts categories in configured order', () => {
      renderMenu();
      const labels = Array.from(screen.queryAllByText(/^(View|Clipboard|Navigate|Plugins)$/)).map(
        (el) => el.textContent,
      );
      expect(labels).toEqual(['View', 'Clipboard', 'Navigate', 'Plugins']);
    });

    it('renders only categories with actions', () => {
      const limitedActions: ContextMenuAction[] = [
        { id: 'a', label: 'Action A', category: 'view' },
        { id: 'b', label: 'Action B', category: 'plugin' },
      ];

      renderMenu(limitedActions);
      expect(screen.getByText('View', { exact: true })).toBeTruthy();
      expect(screen.getByText('Plugins', { exact: true })).toBeTruthy();
      expect(screen.queryByText('Clipboard', { exact: true })).toBeFalsy();
      expect(screen.queryByText('Navigate', { exact: true })).toBeFalsy();
    });
  });

  describe('action execution', () => {
    it('calls onExecute with action ID when action clicked', () => {
      renderMenu();
      const button = screen.getByText('View Item').closest('button');
      fireEvent.click(button!);

      expect(mockOnExecute).toHaveBeenCalledTimes(1);
      expect(mockOnExecute).toHaveBeenCalledWith('view-item');
    });

    it('calls onClose after action execution', () => {
      renderMenu();
      const button = screen.getByText('Copy Path').closest('button');
      fireEvent.click(button!);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describeContextMenuBehavior({
    renderMenu: () => renderMenu(),
    getMenuContainer: () => document.querySelector('[data-component="ContextMenu"]') as HTMLElement,
    getOnClose: () => mockOnClose,
    expectedItemCount: 4,
  });
});
