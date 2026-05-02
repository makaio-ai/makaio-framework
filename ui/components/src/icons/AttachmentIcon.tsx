/**
 * AttachmentIcon - Paperclip attachment icon
 */
import { DEFAULT_ICON_PROPS, type IconProps } from './Icon.types.js';

/**
 * Paperclip icon for attachment/file upload actions.
 * @param props - Icon props
 * @returns SVG attachment icon
 */
export function AttachmentIcon({
  size = DEFAULT_ICON_PROPS.size,
  className,
  'aria-hidden': ariaHidden = DEFAULT_ICON_PROPS['aria-hidden'],
  'aria-label': ariaLabel,
}: IconProps) {
  return (
    <svg
      data-component="AttachmentIcon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
    >
      <path
        d="M17.5 9.16667L10.4167 16.25C9.22917 17.4375 7.60417 17.4375 6.41667 16.25C5.22917 15.0625 5.22917 13.4375 6.41667 12.25L13.5 5.16667C14.2708 4.39583 15.4792 4.39583 16.25 5.16667C17.0208 5.9375 17.0208 7.14583 16.25 7.91667L9.58333 14.5833C9.22917 14.9375 8.64583 14.9375 8.29167 14.5833C7.9375 14.2292 7.9375 13.6458 8.29167 13.2917L14.1667 7.41667"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
