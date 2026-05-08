/**
 * Shared DOM behaviour hooks for overlay and panel components.
 *
 * Plain DOM APIs only — no external dependencies. These hooks
 * centralise escape-key dismissal, body-scroll locking, and
 * focus-on-open/restore patterns that are otherwise duplicated
 * across `SheetOverlay`, `SlidePanel`, `Popover`, and `ContextMenu`.
 * @packageDocumentation
 */

import { type RefObject, useEffect } from 'react';

/** Number of active body scroll-lock consumers. */
let bodyScrollLockCount = 0;
/** Body overflow value captured before the first active scroll lock. */
let savedBodyOverflow = '';

/**
 * Attach a document-level `keydown` listener that calls `handler` when the
 * user presses Escape. The listener is attached only while `enabled` is true
 * and automatically removed on cleanup.
 * @param handler - Callback invoked when Escape is pressed.
 * @param enabled - When `false` the listener is not attached. Defaults to `true`.
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        handler();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, handler]);
}

/**
 * Lock `document.body` scroll while `enabled` is true.
 *
 * Saves and restores the previous `overflow` inline style so an existing
 * body-overflow policy is not lost when the overlay closes.
 * @param enabled - When `true` body scroll is locked; when `false` it is restored.
 */
export function useBodyScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (bodyScrollLockCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyScrollLockCount += 1;

    return () => {
      bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
      if (bodyScrollLockCount === 0) {
        document.body.style.overflow = savedBodyOverflow;
        savedBodyOverflow = '';
      }
    };
  }, [enabled]);
}

/** CSS selector for the standard focusable element set. */
const FOCUSABLE_SELECTOR = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * Focus the first focusable element inside `ref` when `enabled` becomes true.
 *
 * Falls back to focusing `ref` itself when no focusable descendant is found.
 * Restores focus to the previously-active element on cleanup (i.e. when the
 * overlay closes).
 *
 * Tab-cycle trapping is intentionally **not** included here. Components that
 * need full trap behaviour should pair this with {@link useFocusTrap}.
 * @param ref - Ref to the container whose first focusable child should receive focus.
 * @param enabled - When `true` focus management is active.
 */
export function useFocusOnOpen(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const container = ref.current;
    if (container) {
      const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? container).focus();
    }

    return () => {
      previousActiveElement?.focus();
    };
  }, [enabled, ref]);
}

/**
 * Keep Tab focus inside `ref` while `enabled` is true.
 *
 * This owns only the Tab-cycle contract. Pair with {@link useFocusOnOpen} when
 * the same overlay should also move initial focus and restore prior focus on
 * close.
 * @param ref - Ref to the focus containment root.
 * @param enabled - When `true`, Tab and Shift+Tab are trapped inside `ref`.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const container = ref.current;
    if (!container) {
      return;
    }

    const getFocusableElements = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
      );

    const handleTabKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') {
        return;
      }

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const isInsideContainer = activeElement !== null && container.contains(activeElement);

      if (!isInsideContainer) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);
    return () => {
      document.removeEventListener('keydown', handleTabKey);
    };
  }, [enabled, ref]);
}
