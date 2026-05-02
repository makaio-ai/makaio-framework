// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dropdown, type DropdownItem } from '../Dropdown.js';

describe('Dropdown', () => {
  it('announces the menu relationship from the trigger', () => {
    const items: DropdownItem[] = [{ id: 'settings', label: 'Settings', onClick: vi.fn() }];

    render(<Dropdown trigger={<span>Open menu</span>} items={items} />);

    const trigger = screen.getByRole('button', { name: /open menu/i });
    const menuId = trigger.getAttribute('aria-controls');

    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menuId).toBeTruthy();

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu').getAttribute('id')).toBe(menuId);
  });
});
