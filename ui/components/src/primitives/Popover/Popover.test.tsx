/**
 * \@vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type JSX } from 'react';
import { Popover } from './Popover.js';

/**
 * Render a Popover with default trigger/content for behavior tests.
 * @param props - Optional Popover prop overrides.
 * @returns Nothing.
 */
function renderPopover(props?: Partial<Parameters<typeof Popover>[0]>): void {
  render(
    <Popover trigger={<button aria-label="Open settings">Open</button>} {...props}>
      <div>Panel content</div>
    </Popover>,
  );
}

describe('Popover', () => {
  it('toggles open/closed in uncontrolled mode', () => {
    renderPopover();

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape key', () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on outside click', () => {
    renderPopover();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('supports controlled mode', () => {
    function Controlled(): JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <Popover trigger={<button aria-label="Open settings">Open</button>} open={open} onOpenChange={setOpen}>
          <div>Panel content</div>
        </Popover>
      );
    }

    render(<Controlled />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('applies end alignment class', () => {
    renderPopover({ open: true, align: 'end' });
    const panel = screen.getByRole('dialog');
    expect(panel.className).toContain('end');
  });

  it('wires ARIA relationship and dialog label', () => {
    renderPopover({ open: true, ariaLabel: 'Display settings popover' });
    const trigger = screen.getByRole('button', { name: 'Open settings' });
    const panel = screen.getByRole('dialog', { name: 'Display settings popover' });

    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.getAttribute('id'));
  });

  it('supports keyboard activation on non-button trigger', () => {
    const onOpenChange = vi.fn();
    render(
      <Popover trigger={<div aria-label="Non-button trigger">Open</div>} onOpenChange={onOpenChange}>
        <div>Panel content</div>
      </Popover>,
    );

    const trigger = screen.getByRole('button', { name: 'Non-button trigger' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
