// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Textarea } from '../Textarea.js';

describe('Textarea', () => {
  it('merges caller-supplied description ids with helper text', () => {
    render(<Textarea id="notes" label="Notes" helperText="Helpful" aria-describedby="external-id" />);

    const textarea = screen.getByLabelText('Notes');
    expect(textarea.getAttribute('aria-describedby')).toBe('external-id notes-description');
    expect(screen.getByText('Helpful').getAttribute('id')).toBe('notes-description');
  });
});
