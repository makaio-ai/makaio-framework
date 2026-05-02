// @vitest-environment jsdom
/**
 * Tests for CollapsibleGroup + CollapsibleSection integration.
 *
 * The critical invariant tested here (C8): toggling a sibling section must not
 * reset another section's expansion state. Prior to the C8 fix, `group` object
 * identity churn caused the registration effect to re-run on every sibling
 * toggle, unregistering and re-registering the section and resetting it to
 * `defaultExpanded`.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsibleGroup } from '../CollapsibleGroup.js';
import { CollapsibleSection } from '../CollapsibleSection.js';
import { useCollapsibleGroup } from '../CollapsibleContext.js';

function CollapsibleGroupActions() {
  const group = useCollapsibleGroup();
  if (!group) return null;

  return (
    <button type="button" onClick={group.expandAll}>
      Expand all
    </button>
  );
}

describe('CollapsibleGroup', () => {
  it('renders all child sections', () => {
    render(
      <CollapsibleGroup>
        <CollapsibleSection title="Section A">Content A</CollapsibleSection>
        <CollapsibleSection title="Section B">Content B</CollapsibleSection>
      </CollapsibleGroup>,
    );

    expect(screen.getByText('Section A')).toBeTruthy();
    expect(screen.getByText('Section B')).toBeTruthy();
  });

  it('expands and collapses a section by clicking its header', () => {
    render(
      <CollapsibleGroup>
        <CollapsibleSection title="Section A" defaultExpanded={false}>
          Content A
        </CollapsibleSection>
      </CollapsibleGroup>,
    );

    const toggle = screen.getByRole('button', { name: /Section A/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * Regression guard for C8: expansion state must survive sibling toggles.
   *
   * Before the fix, the effect dep array included the whole `group` context
   * object. `group` was recreated by `useMemo` whenever `expandedMap` changed,
   * so every toggle re-ran the registration effect for ALL sections, resetting
   * each one's expansion to `defaultExpanded`.
   */
  it('preserves section expansion state when a sibling is toggled (C8)', () => {
    render(
      <CollapsibleGroup>
        <CollapsibleSection id="a" title="Section A" defaultExpanded={false}>
          Content A
        </CollapsibleSection>
        <CollapsibleSection id="b" title="Section B" defaultExpanded={false}>
          Content B
        </CollapsibleSection>
      </CollapsibleGroup>,
    );

    const toggleA = screen.getByRole('button', { name: /Section A/i });
    const toggleB = screen.getByRole('button', { name: /Section B/i });

    // Expand section A
    fireEvent.click(toggleA);
    expect(toggleA.getAttribute('aria-expanded')).toBe('true');

    // Toggle section B — this must NOT reset section A
    fireEvent.click(toggleB);
    // Section A must remain expanded after toggling section B
    expect(toggleA.getAttribute('aria-expanded')).toBe('true');
    expect(toggleB.getAttribute('aria-expanded')).toBe('true');

    // Toggle section B again — section A must still be expanded
    fireEvent.click(toggleB);
    // Section A must remain expanded after second toggle of section B
    expect(toggleA.getAttribute('aria-expanded')).toBe('true');
  });

  it('accordion mode collapses other sections when one is expanded', () => {
    render(
      <CollapsibleGroup mode="accordion">
        <CollapsibleSection id="a" title="Section A" defaultExpanded={true}>
          Content A
        </CollapsibleSection>
        <CollapsibleSection id="b" title="Section B" defaultExpanded={false}>
          Content B
        </CollapsibleSection>
      </CollapsibleGroup>,
    );

    const toggleA = screen.getByRole('button', { name: /Section A/i });
    const toggleB = screen.getByRole('button', { name: /Section B/i });

    expect(toggleA.getAttribute('aria-expanded')).toBe('true');
    expect(toggleB.getAttribute('aria-expanded')).toBe('false');

    // Expanding B in accordion mode must collapse A
    fireEvent.click(toggleB);
    expect(toggleB.getAttribute('aria-expanded')).toBe('true');
    expect(toggleA.getAttribute('aria-expanded')).toBe('false');
  });

  it('accordion mode keeps only one default-expanded section open on mount', () => {
    render(
      <CollapsibleGroup mode="accordion">
        <CollapsibleSection id="a" title="Section A" defaultExpanded={true}>
          Content A
        </CollapsibleSection>
        <CollapsibleSection id="b" title="Section B" defaultExpanded={true}>
          Content B
        </CollapsibleSection>
      </CollapsibleGroup>,
    );

    const toggleA = screen.getByRole('button', { name: /Section A/i });
    const toggleB = screen.getByRole('button', { name: /Section B/i });

    expect(toggleA.getAttribute('aria-expanded')).toBe('true');
    expect(toggleB.getAttribute('aria-expanded')).toBe('false');
  });

  it('accordion mode preserves the one-open invariant for expandAll', () => {
    render(
      <CollapsibleGroup mode="accordion">
        <CollapsibleGroupActions />
        <CollapsibleSection id="a" title="Section A" defaultExpanded={false}>
          Content A
        </CollapsibleSection>
        <CollapsibleSection id="b" title="Section B" defaultExpanded={false}>
          Content B
        </CollapsibleSection>
      </CollapsibleGroup>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Expand all/i }));

    const toggleA = screen.getByRole('button', { name: /Section A/i });
    const toggleB = screen.getByRole('button', { name: /Section B/i });

    expect(toggleA.getAttribute('aria-expanded')).toBe('true');
    expect(toggleB.getAttribute('aria-expanded')).toBe('false');
  });
});
