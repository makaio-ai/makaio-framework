/**
 * Shared props interface for all icon components.
 *
 * Icons are pure SVG wrappers with standardized sizing and accessibility.
 */
export interface IconProps {
  /**
   * Icon size in pixels (applies to both width and height)
   * @defaultValue 16
   */
  size?: number;

  /**
   * Additional CSS class name
   */
  className?: string;

  /**
   * Whether the icon is decorative and should be hidden from screen readers
   * @defaultValue true
   */
  'aria-hidden'?: boolean;

  /**
   * Accessible name for non-decorative icon usage.
   * Supply this when `'aria-hidden'` is false.
   * Concrete icon wrappers forward both accessibility props to the SVG; see
   * IconAccessibility.test.tsx for the locked contract.
   */
  'aria-label'?: string;
}

/**
 * Default icon props applied to all icons
 */
export const DEFAULT_ICON_PROPS: Required<Pick<IconProps, 'size' | 'aria-hidden'>> = {
  size: 16,
  'aria-hidden': true,
};
