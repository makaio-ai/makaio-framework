// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilterChipGroup } from '../FilterChipGroup.js';
import type { FilterOption } from '../types.js';

describe('FilterChipGroup', () => {
  it('derives the all-selected state from membership instead of array length', () => {
    const onChange = vi.fn();
    const options: FilterOption<string>[] = [
      { id: 'alpha', value: 'alpha', label: 'Alpha' },
      { id: 'beta', value: 'beta', label: 'Beta' },
      { id: 'gamma', value: 'gamma', label: 'Gamma' },
    ];
    const selected = [options[0], options[0], options[0]];

    render(<FilterChipGroup options={options} selected={selected} onChange={onChange} />);

    const allButton = screen.getByRole('button', { name: /all/i });
    const alphaButton = screen.getByRole('button', { name: /alpha/i });
    const betaButton = screen.getByRole('button', { name: /beta/i });

    expect(allButton.getAttribute('aria-pressed')).toBe('false');
    expect(alphaButton.getAttribute('aria-pressed')).toBe('true');
    expect(betaButton.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(allButton);
    expect(onChange).toHaveBeenCalledWith(options);
  });

  it('emits a canonical selection when toggling a chip with a duplicate-filled selected array', () => {
    const onChange = vi.fn();
    const options: FilterOption<string>[] = [
      { id: 'alpha', value: 'alpha', label: 'Alpha' },
      { id: 'beta', value: 'beta', label: 'Beta' },
      { id: 'gamma', value: 'gamma', label: 'Gamma' },
    ];
    // alpha appears three times — duplicates must not propagate to onChange
    const selected = [options[0], options[0], options[0]];

    render(<FilterChipGroup options={options} selected={selected} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /beta/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    // Should receive exactly [alpha, beta] — no duplicate alpha entries
    expect(onChange).toHaveBeenCalledWith([options[0], options[1]]);
  });
});
