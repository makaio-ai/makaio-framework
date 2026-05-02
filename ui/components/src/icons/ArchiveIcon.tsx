/**
 * ArchiveIcon - Archive/storage icon
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Archive box icon for archiving actions.
 * @param props - Icon props
 * @returns SVG archive icon
 */
export function ArchiveIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      data-component="ArchiveIcon"
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
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}
