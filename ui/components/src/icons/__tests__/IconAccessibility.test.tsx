// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CloseIcon } from '../CloseIcon.js';

describe('icon accessibility props', () => {
  it('forwards aria-label for non-decorative icon usage', () => {
    render(<CloseIcon aria-hidden={false} aria-label="Close dialog" />);

    const icon = screen.getByLabelText('Close dialog');
    expect(icon.getAttribute('aria-hidden')).toBe('false');
  });
});
