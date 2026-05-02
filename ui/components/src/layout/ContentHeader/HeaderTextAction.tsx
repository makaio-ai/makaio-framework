import { forwardRef } from 'react';
import styles from './ContentHeader.module.scss';
import type { HeaderTextActionProps } from './types.js';

/**
 * HeaderTextAction component
 *
 * Text-style action button for ContentHeader.
 * Mirrors NavSidebar navigation item hover behavior.
 * @example
 * ```tsx
 * <HeaderTextAction onClick={handleSave}>Save Changes</HeaderTextAction>
 * ```
 * @param props - Component props
 * @returns The rendered text action button
 */
export const HeaderTextAction = forwardRef<HTMLButtonElement, HeaderTextActionProps>(
  ({ children, onClick, disabled, className }, ref) => {
    const buttonClassNames = [styles.textAction, className].filter(Boolean).join(' ');

    return (
      <button
        data-component="HeaderTextAction"
        ref={ref}
        type="button"
        className={buttonClassNames}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </button>
    );
  },
);

HeaderTextAction.displayName = 'HeaderTextAction';
