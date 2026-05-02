// @vitest-environment jsdom
/**
 * Tests for CollapsibleSection a11y invariants.
 *
 * C1: Focusable children inside a collapsed section must not be reachable via
 * keyboard. The `inert` attribute on the content div prevents all keyboard
 * interaction with its subtree when the section is collapsed.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleSection } from '../CollapsibleSection.js';

describe('CollapsibleSection', () => {
  it('renders with correct ARIA attributes on trigger and region', () => {
    render(
      <CollapsibleSection id="test-section" title="My Section">
        <button>Inner action</button>
      </CollapsibleSection>,
    );

    const trigger = screen.getByRole('button', { name: /My Section/i });
    expect(trigger.id).toBe('test-section-trigger');
    expect(trigger.getAttribute('aria-controls')).toBe('test-section-content');

    const region = document.getElementById('test-section-content');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('region');
    expect(region!.getAttribute('aria-labelledby')).toBe('test-section-trigger');
  });

  /**
   * C1 regression guard: collapsed content must be inert so focusable
   * descendants are unreachable via keyboard.
   */
  it('content region is inert when collapsed (C1)', () => {
    render(
      <CollapsibleSection id="c1-section" title="Collapsible" defaultExpanded={false}>
        <button>Focusable child</button>
      </CollapsibleSection>,
    );

    const region = document.getElementById('c1-section-content');
    expect(region).not.toBeNull();
    // `inert` attribute must be present when collapsed
    expect(region!.hasAttribute('inert')).toBe(true);
  });

  it('content region is not inert when expanded (C1)', () => {
    render(
      <CollapsibleSection id="c1-expanded" title="Collapsible" defaultExpanded={true}>
        <button>Focusable child</button>
      </CollapsibleSection>,
    );

    const region = document.getElementById('c1-expanded-content');
    expect(region).not.toBeNull();
    expect(region!.hasAttribute('inert')).toBe(false);
  });

  it('removes inert when section is expanded by toggle click (C1)', () => {
    render(
      <CollapsibleSection id="c1-toggle" title="Toggle Test" defaultExpanded={false}>
        <button>Focusable child</button>
      </CollapsibleSection>,
    );

    const trigger = screen.getByRole('button', { name: /Toggle Test/i });
    const region = document.getElementById('c1-toggle-content');
    expect(region!.hasAttribute('inert')).toBe(true);

    fireEvent.click(trigger);
    expect(region!.hasAttribute('inert')).toBe(false);

    fireEvent.click(trigger);
    expect(region!.hasAttribute('inert')).toBe(true);
  });
});
