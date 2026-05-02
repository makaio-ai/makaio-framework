/**
 * EmptyStateUI — error surface shown when browser extension loading fails.
 *
 * The framework loader uses `FrameworkShell` for empty/no-shell states and
 * reserves this component for loader/import failures before shell assembly.
 * @packageDocumentation
 */

import type { JSX } from 'react';
import { SHELL_BG_COLOR, SHELL_FONT_FAMILY, SHELL_TEXT_COLOR } from '@makaio/ui-kernel';

/**
 * Props for {@link EmptyStateUI}.
 */
export interface EmptyStateUIProps {
  /** Optional heading override for error variants. */
  title?: string;
  /** Primary message shown below the heading. */
  message?: string;
  /** Optional supporting detail line. */
  detail?: string;
}

/**
 * Minimal shell-level status surface for loader error states.
 *
 * Displays a minimal branded splash with a short explanation.  Uses inline
 * styles deliberately — this is a shell-level fallback that must not depend
 * on the theme system or any CSS module pipeline.
 * @param props - Optional copy overrides for loader error states.
 * @returns Fallback shell-level status UI.
 */
export function EmptyStateUI({
  title = 'Makaio',
  message = 'No extension provided workspace chrome.',
  detail = 'Waiting for extensions to load...',
}: EmptyStateUIProps = {}): JSX.Element {
  return (
    <div
      aria-live="polite"
      data-component="EmptyStateUI"
      role="status"
      style={{
        alignItems: 'center',
        backgroundColor: SHELL_BG_COLOR,
        color: SHELL_TEXT_COLOR,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: SHELL_FONT_FAMILY,
        height: '100vh',
        justifyContent: 'center',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{title}</h1>
      <p style={{ opacity: 0.6 }}>{message}</p>
      <p style={{ fontSize: '0.85rem', opacity: 0.4 }}>{detail}</p>
    </div>
  );
}
