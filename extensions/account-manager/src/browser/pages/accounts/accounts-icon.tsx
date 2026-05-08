/**
 * Accounts page icon.
 *
 * Inline SVG icon used for the accounts page sidebar entry.
 * Default-exported to satisfy the lazy-import contract declared in
 * {@link PageDeclaration.icon}.
 * @packageDocumentation
 */

import type { JSX } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props accepted by the accounts icon component.
 */
interface AccountsIconProps {
  /** Icon size in pixels. Defaults to 16. */
  size?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Accounts icon — a simple user-group glyph rendered as inline SVG.
 *
 * The icon uses `currentColor` so it inherits the text colour of its context.
 * @param props - Icon props.
 * @returns Inline SVG icon element.
 */
export default function AccountsIcon({ size = 16 }: AccountsIconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      data-component="AccountsIcon"
    >
      {/* Primary user circle */}
      <circle cx="6" cy="5" r="2.5" />
      {/* Secondary user circle (offset) */}
      <circle cx="11" cy="4" r="2" />
      {/* Primary user body */}
      <path d="M1 13c0-2.761 2.239-5 5-5s5 2.239 5 5H1z" />
      {/* Secondary user body (partial, right side) */}
      <path d="M11 12c0-1.657-.895-3.1-2.207-3.848A5.99 5.99 0 0 1 11 8c2.209 0 4 1.791 4 4h-4z" />
    </svg>
  );
}
