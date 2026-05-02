/**
 * SendIcon - Paper plane send/submit icon
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Paper plane icon for send/submit actions.
 * @param props - Icon props
 * @returns SVG send icon
 */
export function SendIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      data-component="SendIcon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
