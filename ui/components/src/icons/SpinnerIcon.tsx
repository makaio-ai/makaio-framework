/**
 * SpinnerIcon - Loading spinner with animated arc
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Animated loading spinner icon.
 *
 * CSS animation should be applied via className for rotation effect.
 * @param props - Icon props
 * @returns SVG spinner icon
 */
export function SpinnerIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      data-component="SpinnerIcon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M12 2C17.5228 2 22 6.47715 22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
