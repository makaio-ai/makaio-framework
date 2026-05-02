import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Input.module.scss';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Size preset */
  size?: InputSize;
  /** Label text */
  label?: string;
  /** Helper text shown below input */
  helperText?: string;
  /** Error text (overrides helperText when present) */
  errorText?: string;
  /** Error state */
  error?: boolean;
  /** Left icon element */
  leftIcon?: ReactNode;
  /** Right icon element */
  rightIcon?: ReactNode;
}

/**
 * Input component
 *
 * Text input with label, icons, and validation states.
 * Features amber glow on focus matching the Aura design system.
 * @param props - Component props
 * @returns Input component
 * @example
 * ```tsx
 * <Input
 *   label="Email"
 *   placeholder="Enter your email"
 *   errorText="Invalid email format"
 *   leftIcon={<MailIcon />}
 * />
 * ```
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = 'md',
    label,
    helperText,
    errorText,
    error = false,
    leftIcon,
    rightIcon,
    disabled,
    className,
    id,
    'aria-describedby': ariaDescribedBy,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hasError = error || !!errorText;
  const displayText = errorText || helperText;
  // Stable id linking the helper/error text to the input via
  // aria-describedby. Only set when there is visible helper/error text.
  const descriptionId = displayText ? `${inputId}-description` : undefined;
  const mergedAriaDescribedBy =
    [ariaDescribedBy, descriptionId].filter((value): value is string => Boolean(value)).join(' ') || undefined;

  const wrapperClassNames = [styles.wrapper, className].filter(Boolean).join(' ');

  const inputClassNames = [
    styles.input,
    styles[size],
    hasError && styles.error,
    disabled && styles.disabled,
    leftIcon && styles.hasLeftIcon,
    rightIcon && styles.hasRightIcon,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div data-component="Input" className={wrapperClassNames}>
      {label && (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      )}
      <div className={styles.inputContainer}>
        {leftIcon && (
          <span className={styles.leftIcon} aria-hidden="true">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={inputClassNames}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={mergedAriaDescribedBy}
          {...props}
        />
        {rightIcon && (
          <span className={styles.rightIcon} aria-hidden="true">
            {rightIcon}
          </span>
        )}
      </div>
      {displayText && (
        <div id={descriptionId} className={`${styles.helperText} ${hasError ? styles.errorText : ''}`}>
          {displayText}
        </div>
      )}
    </div>
  );
});
