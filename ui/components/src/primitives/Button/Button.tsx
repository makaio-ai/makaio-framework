import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.scss';

/**
 * Button visual variants
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * Button size presets
 */
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * Base button props shared by all button variants.
 * @param variant - Visual style variant (primary, secondary, ghost, danger)
 * @param size - Size preset (sm: 28px, md: 36px, lg: 44px)
 * @param fullWidth - Stretch button to full width of container
 * @param leftIcon - Icon element to display before label
 * @param rightIcon - Icon element to display after label
 * @param loading - Show loading spinner and disable interaction
 * @param disabled - Native disabled state
 * @param type - Button type attribute; defaults to `'button'` to prevent
 *   accidental form submission. Pass `type="submit"` explicitly when
 *   form-submit behavior is required.
 * @param className - Additional CSS classes
 * @param children - Button label content
 */
type BaseButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Visual style variant */
  variant?: ButtonVariant;
  /** Size preset */
  size?: ButtonSize;
  /** Full width button */
  fullWidth?: boolean;
  /** Left icon element */
  leftIcon?: ReactNode;
  /** Right icon element */
  rightIcon?: ReactNode;
  /** Loading state */
  loading?: boolean;
};

/**
 * Discriminated union enforcing that `iconOnly: true` requires `aria-label`,
 * so every icon-only button always has an accessible name (WCAG 2.1 SC 4.1.2).
 */
type IconOnlyAccessibility = { iconOnly?: false | undefined } | { iconOnly: true; 'aria-label': string };

/**
 * Button component props.
 *
 * When `iconOnly` is `true`, `aria-label` is required so the button always
 * has an accessible name.
 * @param ref - Forwarded ref to underlying button element
 */
export type ButtonProps = BaseButtonProps & IconOnlyAccessibility;

/**
 * Button component
 *
 * Primary interactive element for triggering actions with Aura theme styling.
 * Supports multiple variants, sizes, loading states, and icon placements.
 * @example
 * ```tsx
 * <Button variant="primary" size="md" loading={isLoading}>
 *   Submit
 * </Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    fullWidth = false,
    iconOnly = false,
    leftIcon,
    rightIcon,
    loading = false,
    disabled,
    type = 'button',
    className,
    children,
    ...props
  },
  ref,
) {
  const classNames = [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth && styles.fullWidth,
    iconOnly && styles.iconOnly,
    loading && styles.loading,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      data-component="Button"
      ref={ref}
      className={classNames}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      type={type}
      {...props}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {leftIcon && !loading && <span className={styles.icon}>{leftIcon}</span>}
      {children != null && <span className={styles.label}>{children}</span>}
      {rightIcon && !loading && <span className={styles.icon}>{rightIcon}</span>}
    </button>
  );
});
