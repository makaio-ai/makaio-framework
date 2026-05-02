// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IconSidebar, type NavItem } from '../IconSidebar.js';

describe('IconSidebar', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('disables nav items that do not expose a click handler', () => {
    const onClick = vi.fn();
    const navItems: NavItem[] = [
      { id: 'home', label: 'Home', icon: <span>H</span>, onClick },
      { id: 'settings', label: 'Settings', icon: <span>S</span> },
    ];

    render(<IconSidebar navItems={navItems} />);

    const homeButton = screen.getByRole('button', { name: 'Home' });
    const settingsButton = screen.getByRole('button', { name: 'Settings' });

    expect(homeButton.hasAttribute('disabled')).toBe(false);
    expect(settingsButton.hasAttribute('disabled')).toBe(true);

    fireEvent.click(homeButton);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
