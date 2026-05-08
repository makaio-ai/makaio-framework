// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { pageDefinitionRegistry, type PageDefinition } from '@makaio/ui-kernel';
import { usePageOverlayStore } from '@makaio/ui-hooks';
import { SheetOverlay } from '../SheetOverlay.js';

function resetOverlayState(): void {
  usePageOverlayStore.getState().close();
  pageDefinitionRegistry.clear();
  document.body.style.overflow = '';
}

function registerPage(overrides: Partial<PageDefinition> = {}): void {
  pageDefinitionRegistry.register({
    id: 'test-sheet',
    name: 'Test Sheet',
    mode: 'sheet',
    level: 'any',
    component: async () => ({
      default: () => <button type="button">Sheet action</button>,
    }),
    ...overrides,
  });
}

describe('SheetOverlay', () => {
  afterEach(() => {
    resetOverlayState();
  });

  it('renders sheet-mode pages and traps focus inside the overlay', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open trigger';
    document.body.appendChild(trigger);
    trigger.focus();

    registerPage();
    usePageOverlayStore.getState().openPage('test-sheet');

    render(<SheetOverlay />);

    const dialog = await screen.findByRole('dialog', { name: 'Test Sheet' });
    const closeButton = within(dialog).getByRole('button', { name: 'Close' });
    const sheetAction = await screen.findByRole('button', { name: 'Sheet action' });

    expect(document.activeElement).toBe(closeButton);

    sheetAction.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Test Sheet' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('retries a failed lazy page load without closing the overlay', async () => {
    const componentLoader = vi
      .fn<() => Promise<{ default: () => JSX.Element }>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce({
        default: () => <span>Recovered page</span>,
      });

    registerPage({ component: componentLoader });
    usePageOverlayStore.getState().openPage('test-sheet');

    render(<SheetOverlay />);

    expect(await screen.findByText('Failed to load page.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Recovered page')).toBeInTheDocument();
    expect(usePageOverlayStore.getState().activePageId).toBe('test-sheet');
    expect(componentLoader).toHaveBeenCalledTimes(2);
  });
});
