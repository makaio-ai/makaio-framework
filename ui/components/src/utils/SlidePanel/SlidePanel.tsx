/**
 * SlidePanel - A slide-in panel from the right (with seam for bottom on mobile)
 */

import { useId, useRef, type ReactNode } from 'react';
import { useEscapeKey, useBodyScrollLock, useFocusOnOpen, useFocusTrap } from '../dom-hooks.js';
import { CloseIcon } from '../../icons/index.js';
import styles from './SlidePanel.module.scss';

export interface SlidePanelProps {
  /** Whether the panel is open */
  isOpen: boolean;
  /** Close handler */
  onClose: () => void;
  /** Panel title */
  title: string;
  /** Panel subtitle */
  subtitle?: string;
  /** Panel content */
  children: ReactNode;
  /** Width of the panel */
  width?: 'sm' | 'md' | 'lg';
  /** Position - seam for mobile and left-side panels */
  position?: 'left' | 'right' | 'bottom';
}

/**
 * Slide-in panel component for forms and detail views.
 *
 * Features:
 * - Slides in from right (or bottom for mobile)
 * - Overlay backdrop that closes on click
 * - Escape key closes
 * - Smooth CSS transitions
 * - Glass panel styling with theme tokens
 * @param props - Component props
 * @returns SlidePanel component
 */
export function SlidePanel({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  width = 'md',
  position = 'right',
}: SlidePanelProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // TODO(backlog): make SlidePanel stack-safe for overlapping modals so only
  // the topmost panel owns Escape handling, scroll locking, and focus restore.
  useEscapeKey(onClose, isOpen);
  useBodyScrollLock(isOpen);
  useFocusOnOpen(panelRef, isOpen);
  useFocusTrap(panelRef, isOpen);

  const containerClassNames = [styles.container, isOpen && styles.open, styles[position]].filter(Boolean).join(' ');

  const panelClassNames = [styles.panel, styles[`width-${width}`]].filter(Boolean).join(' ');

  return (
    <div data-component="SlidePanel" className={containerClassNames}>
      {/*
       * Overlay backdrop — rendered as a <button> so it is focusable and
       * activatable by keyboard, satisfying WCAG 2.1 SC 2.1.1 (Keyboard).
       */}
      <button type="button" className={styles.overlay} onClick={onClose} aria-label="Close panel" />

      {/*
       * aria-hidden keeps the panel out of the a11y tree when closed.
       * We intentionally do NOT use the HTML `hidden` attribute here:
       * `hidden` sets `display:none` immediately, which would suppress
       * the CSS exit transition on `.panel` (transform 350ms). The
       * container's `visibility` transition (350ms delay) already gates
       * interaction and visual exposure during exit.
       */}
      <div
        ref={panelRef}
        className={panelClassNames}
        role="dialog"
        aria-labelledby={titleId}
        aria-modal={isOpen ? true : undefined}
        aria-hidden={!isOpen}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close panel">
            <CloseIcon size={20} />
          </button>
        </header>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
