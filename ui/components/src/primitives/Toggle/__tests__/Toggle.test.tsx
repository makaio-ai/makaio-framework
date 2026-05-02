// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Toggle } from '../Toggle.js';

describe('Toggle', () => {
  it('falls back to the accessible label when ariaLabel is empty', () => {
    const onChange = vi.fn();

    render(<Toggle checked={false} onChange={onChange} accessibleLabel="Visible label" ariaLabel="" />);

    const toggle = screen.getByRole('switch', { name: 'Visible label' });
    expect(toggle.getAttribute('aria-label')).toBe('Visible label');

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('falls back to the accessible label when ariaLabel is whitespace-only', () => {
    render(<Toggle checked={false} onChange={() => undefined} accessibleLabel="Visible label" ariaLabel="   " />);

    const toggle = screen.getByRole('switch', { name: 'Visible label' });
    expect(toggle.getAttribute('aria-label')).toBe('Visible label');
  });
});
