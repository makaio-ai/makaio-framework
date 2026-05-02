/**
 * PlusIcon - Add/create action icon
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Plus icon for add/create actions.
 * @param props - Icon props
 * @returns SVG plus icon
 */
export function PlusIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      data-component="PlusIcon"
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
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}
