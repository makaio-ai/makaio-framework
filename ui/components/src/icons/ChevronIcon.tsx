/**
 * ChevronIcon - Directional chevron/arrow icon
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Extended props for ChevronIcon with direction support
 */
export interface ChevronIconProps extends IconProps {
  /**
   * Direction the chevron should point
   * @defaultValue 'right'
   */
  direction?: 'left' | 'right' | 'up' | 'down';
}

/**
 * Path data for each chevron direction
 */
const CHEVRON_PATHS: Record<NonNullable<ChevronIconProps['direction']>, string> = {
  left: 'm15 18-6-6 6-6',
  right: 'm9 18 6-6-6-6',
  up: 'm18 15-6-6-6 6',
  down: 'm6 9 6 6 6-6',
};

/**
 * Directional chevron icon.
 * @param props - Icon props with direction
 * @returns SVG chevron icon
 */
export function ChevronIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
  direction = 'right',
}: ChevronIconProps) {
  return (
    <svg
      data-component="ChevronIcon"
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
      <path d={CHEVRON_PATHS[direction]} />
    </svg>
  );
}
