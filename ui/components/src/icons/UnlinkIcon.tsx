/**
 * UnlinkIcon - Broken link/disconnect icon
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Broken link icon for disconnect/unlink actions.
 * @param props - Icon props
 * @returns SVG unlink icon
 */
export function UnlinkIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      data-component="UnlinkIcon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    >
      <path d="M18.84 2.38C17.5 1.05 15.58 1 13.71 2.45L8.67 6.36c-1.63 1.27-2.12 2.9-1.55 4.63l-3.83 3.83c-.78.78-.78 2.05 0 2.83L7.35 18.71c.78.78 2.05.78 2.83 0l3.83-3.83c1.73.57 3.36.08 4.63-1.55l3.91-5.04C23 6.42 22.95 4.5 21.62 3.16z" />
      <line x1="2" y1="22" x2="22" y2="2" />
    </svg>
  );
}
