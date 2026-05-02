import { forwardRef } from 'react';
import styles from './ContentHeader.module.scss';
import type { HeaderIconActionProps } from './types.js';

/**
 * HeaderIconAction component
 *
 * Icon-style action button for ContentHeader.
 * Circular button with active state support (e.g., for edit mode toggle).
 * @example
 * ```tsx
 * <HeaderIconAction
 *   icon={<EditIcon />}
 *   label="Toggle edit mode"
 *   active={isEditMode}
 *   onClick={toggleEditMode}
 * />
 * ```
 * @param props - Component props
 * @returns The rendered icon action button
 */
export const HeaderIconAction = forwardRef<HTMLButtonElement, HeaderIconActionProps>(
  ({ icon, label, onClick, disabled, active, className }, ref) => {
    const buttonClassNames = [styles.iconAction, active && styles.active, className].filter(Boolean).join(' ');

    return (
      <button
        ref={ref}
        type="button"
        className={buttonClassNames}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        data-component="HeaderIconAction"
      >
        {icon}
      </button>
    );
  },
);

HeaderIconAction.displayName = 'HeaderIconAction';
