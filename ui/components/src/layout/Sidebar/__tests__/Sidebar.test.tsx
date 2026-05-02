// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NavSidebar, type NavSidebarItem } from '../Sidebar.js';
import { ShieldCheck } from 'lucide-react';

describe('NavSidebar', () => {
  it('renders non-link items without emitting anchors', () => {
    const items: NavSidebarItem[] = [{ label: 'Read-only Item' }];

    const { container } = render(<NavSidebar items={items} />);
    expect(screen.getByText('Read-only Item')).toBeTruthy();
    expect(container.querySelector('a[href]')).toBeNull();
  });

  it('renders duplicate labels without React key warnings', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items: NavSidebarItem[] = [{ label: 'Duplicate' }, { label: 'Duplicate' }];

    try {
      render(<NavSidebar items={items} />);
      expect(screen.getAllByText('Duplicate')).toHaveLength(2);
      expect(
        consoleErrorSpy.mock.calls.some(
          ([message]) =>
            typeof message === 'string' && message.includes('Each child in a list should have a unique "key" prop'),
        ),
      ).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('renders action items as non-submit buttons', () => {
    const onClick = vi.fn();
    const items: NavSidebarItem[] = [{ label: 'Run', onClick }];

    render(<NavSidebar items={items} />);

    const button = screen.getByRole('button', { name: 'Run' });
    expect(button.getAttribute('type')).toBe('button');
  });

  it('renders collapse toggle as non-submit button', () => {
    render(<NavSidebar collapsed onToggleCollapse={vi.fn()} />);

    const toggle = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(toggle.getAttribute('type')).toBe('button');
  });

  it('keeps collapsed action items accessible by label', () => {
    const items: NavSidebarItem[] = [{ label: 'Run', icon: <ShieldCheck size={16} />, onClick: vi.fn() }];

    render(<NavSidebar collapsed items={items} />);

    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  });

  it('keeps collapsed link items accessible by label', () => {
    const items: NavSidebarItem[] = [{ label: 'Approvals', icon: <ShieldCheck size={16} />, path: '/approvals' }];

    render(<NavSidebar collapsed items={items} />);

    expect(screen.getByRole('link', { name: 'Approvals' })).toBeTruthy();
  });

  describe('badge', () => {
    it('renders badge when count is greater than 0', () => {
      const items: NavSidebarItem[] = [{ label: 'Approvals', icon: <ShieldCheck size={16} />, badge: 3 }];

      render(<NavSidebar items={items} />);

      expect(screen.getByText('3')).toBeTruthy();
    });

    it('does not render badge when count is 0', () => {
      const items: NavSidebarItem[] = [{ label: 'Approvals', icon: <ShieldCheck size={16} />, badge: 0 }];

      const { container } = render(<NavSidebar items={items} />);

      // Badge span should not be present
      expect(container.querySelector('[class*="badge"]')).toBeNull();
    });

    it('does not render badge when badge prop is undefined', () => {
      const items: NavSidebarItem[] = [{ label: 'Approvals', icon: <ShieldCheck size={16} /> }];

      const { container } = render(<NavSidebar items={items} />);

      expect(container.querySelector('[class*="badge"]')).toBeNull();
    });

    it('renders "99+" when count exceeds 99', () => {
      const items: NavSidebarItem[] = [{ label: 'Approvals', icon: <ShieldCheck size={16} />, badge: 100 }];

      render(<NavSidebar items={items} />);

      expect(screen.getByText('99+')).toBeTruthy();
    });

    it('renders exact count for values at the boundary (99)', () => {
      const items: NavSidebarItem[] = [{ label: 'Approvals', icon: <ShieldCheck size={16} />, badge: 99 }];

      render(<NavSidebar items={items} />);

      expect(screen.getByText('99')).toBeTruthy();
    });
  });
});
