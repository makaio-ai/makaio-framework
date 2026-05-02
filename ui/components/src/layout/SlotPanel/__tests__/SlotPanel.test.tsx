/**
 * \@vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SlotPanel } from '../SlotPanel.js';

describe('SlotPanel', () => {
  it('renders with data-component and default padding', () => {
    const { container } = render(
      <SlotPanel>
        <div>Content</div>
      </SlotPanel>,
    );

    const root = container.querySelector('[data-component="SlotPanel"]');
    expect(root).toBeTruthy();
    expect(root?.className).toContain('padding-md');
  });

  it('supports custom padding', () => {
    const { container } = render(
      <SlotPanel padding="sm">
        <div>Content</div>
      </SlotPanel>,
    );

    const root = container.querySelector('[data-component="SlotPanel"]');
    expect(root?.className).toContain('padding-sm');
  });
});
