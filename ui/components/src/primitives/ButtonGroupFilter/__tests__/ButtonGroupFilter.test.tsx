// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ButtonGroupFilter, type ButtonGroupOption } from '../ButtonGroupFilter.js';

describe('ButtonGroupFilter', () => {
  it('exposes the button set as a labelled group', () => {
    const options: ButtonGroupOption<'all' | 'open' | 'closed'>[] = [
      { value: 'all', label: 'All' },
      { value: 'open', label: 'Open' },
      { value: 'closed', label: 'Closed' },
    ];

    render(<ButtonGroupFilter value="all" onChange={() => undefined} options={options} label="Status" />);

    const group = screen.getByRole('group', { name: /status/i });
    expect(group).toBeTruthy();

    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(options.length);
    expect(buttons.map((b) => b.textContent)).toEqual(options.map((o) => o.label));
  });
});
