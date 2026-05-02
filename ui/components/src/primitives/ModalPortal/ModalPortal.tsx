/**
 * ModalPortal - Renders children into document.body via React portal.
 *
 * Escapes stacking contexts (backdrop-filter, overflow:hidden, etc.)
 * that trap `position: fixed` elements inside panes/tiles.
 * Follows the same portal-layer pattern as ContextMenu and Tooltip.
 * @example
 * ```tsx
 * <ModalPortal>
 *   <ForkModal {...props} />
 * </ModalPortal>
 * ```
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ModalPortalProps {
  /** Content to render at the document body level */
  children: ReactNode;
}

/**
 * Renders children into a React portal at document.body,
 * escaping all ancestor stacking contexts.
 * @param children - Portal content rendered at the document root
 * @returns Portal-rendered children
 */
export function ModalPortal({ children }: ModalPortalProps) {
  const portalTarget = typeof document === 'undefined' ? null : document.body;
  // SSR and node-based tests have no DOM; in that environment render nothing.
  if (!portalTarget) return null;
  return createPortal(children, portalTarget);
}
