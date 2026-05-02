/**
 * Analytics page icon.
 *
 * Inline SVG icon used for the analytics page sidebar entry.
 * Default-exported to satisfy the lazy-import contract declared in
 * {@link PageDeclaration.icon}.
 * @packageDocumentation
 */

import type { JSX } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props accepted by the analytics icon component.
 */
interface AnalyticsIconProps {
  /** Icon size in pixels. Defaults to 16. */
  size?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Analytics icon — a simple bar-chart glyph rendered as inline SVG.
 *
 * The icon uses `currentColor` so it inherits the text colour of its context.
 * @param props - Icon props.
 * @returns Inline SVG icon element.
 */
export default function AnalyticsIcon({ size = 16 }: AnalyticsIconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      data-component="AnalyticsIcon"
    >
      <rect x="1" y="9" width="3" height="6" rx="0.5" />
      <rect x="6" y="5" width="3" height="10" rx="0.5" />
      <rect x="11" y="2" width="3" height="13" rx="0.5" />
    </svg>
  );
}
