// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from './Input.js';

describe('Input', () => {
  it('merges caller and helper aria-describedby ids', () => {
    render(<Input aria-describedby="external-description" helperText="Helpful copy" label="Name" />);

    const input = screen.getByLabelText('Name');
    const describedBy = input.getAttribute('aria-describedby');

    expect(describedBy).toContain('external-description');
    expect(describedBy).toMatch(/\S+-description/);
  });
});
