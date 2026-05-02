import { forwardRef, useEffect, useId, useRef, type TextareaHTMLAttributes } from 'react';
import styles from './Textarea.module.scss';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Label text displayed above the textarea */
  label?: string;
  /** Error message - overrides helperText when present */
  error?: string;
  /** Helper text shown below textarea */
  helperText?: string;
  /** Enable auto-resize based on content */
  autoResize?: boolean;
  /** Minimum number of rows to display */
  minRows?: number;
  /** Maximum number of rows before scrolling */
  maxRows?: number;
  /** Error state */
  errorState?: boolean;
}

/**
 * Textarea component
 *
 * Multi-line text input with label, auto-resize, and validation states.
 * Styled with amber accent focus glow matching the Aura theme.
 * @param props - Component props
 * @returns Textarea component
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    label,
    error,
    helperText,
    autoResize = false,
    minRows = 3,
    maxRows,
    errorState = false,
    disabled,
    className,
    id,
    style,
    rows = minRows,
    'aria-describedby': ariaDescribedBy,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const hasError = errorState || !!error;
  const displayText = error || helperText;
  // Merge the caller-supplied descriptions with the helper/error text instead
  // of letting either source overwrite the other.
  const descriptionId = displayText ? `${textareaId}-description` : undefined;
  const mergedDescribedBy =
    [ariaDescribedBy, descriptionId].filter((value): value is string => Boolean(value)).join(' ') || undefined;

  // Forward refs to both internal ref and external ref
  const setRef = (textarea: HTMLTextAreaElement | null) => {
    internalRef.current = textarea;
    if (typeof ref === 'function') {
      ref(textarea);
    } else if (ref) {
      ref.current = textarea;
    }
  };

  // Auto-resize effect
  useEffect(() => {
    if (!autoResize || !internalRef.current) return;

    const textarea = internalRef.current;

    const resize = () => {
      textarea.style.height = 'auto';
      const newHeight = textarea.scrollHeight;

      if (maxRows && maxRows > 0) {
        // lineHeight can be 'normal' (unitless keyword) when no explicit
        // line-height is set. parseFloat returns NaN in that case, so fall
        // back to fontSize * 1.2 (CSS spec default for 'normal').
        const computedStyle = getComputedStyle(textarea);
        const parsedLineHeight = Number.parseFloat(computedStyle.lineHeight);
        const lineHeight = Number.isFinite(parsedLineHeight)
          ? parsedLineHeight
          : Number.parseFloat(computedStyle.fontSize) * 1.2;
        const maxHeight = lineHeight * maxRows;
        textarea.style.height = `${Math.min(newHeight, maxHeight)}px`;
        textarea.style.overflowY = newHeight > maxHeight ? 'auto' : 'hidden';
      } else {
        textarea.style.height = `${newHeight}px`;
        textarea.style.overflowY = 'hidden';
      }
    };

    // Initial resize
    resize();

    // Add event listeners
    textarea.addEventListener('input', resize);
    window.addEventListener('resize', resize);

    return () => {
      textarea.removeEventListener('input', resize);
      window.removeEventListener('resize', resize);
    };
  }, [autoResize, maxRows, minRows, props.value]);

  const wrapperClassNames = [styles.wrapper, className].filter(Boolean).join(' ');

  const textareaClassNames = [styles.textarea, hasError && styles.error, disabled && styles.disabled]
    .filter(Boolean)
    .join(' ');

  const textareaStyle = {
    ...style,
    '--min-rows': minRows,
  } as React.CSSProperties;

  return (
    <div data-component="Textarea" className={wrapperClassNames}>
      {label && (
        <label htmlFor={textareaId} className={styles.label}>
          {label}
        </label>
      )}
      <textarea
        ref={setRef}
        id={textareaId}
        className={textareaClassNames}
        disabled={disabled}
        style={textareaStyle}
        rows={autoResize ? minRows : rows}
        aria-invalid={hasError || undefined}
        aria-describedby={mergedDescribedBy}
        {...props}
      />
      {displayText && (
        <div id={descriptionId} className={`${styles.helperText} ${hasError ? styles.errorText : ''}`}>
          {displayText}
        </div>
      )}
    </div>
  );
});
