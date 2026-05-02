import { useId, type SVGProps } from 'react';

/**
 * Logo display variant
 */
export type LogoVariant = 'full' | 'monochrome';

/**
 * Makaio Logo props
 */
export interface LogoProps extends SVGProps<SVGSVGElement> {
  /** Accessible title for the logo */
  title?: string;

  /**
   * Display variant:
   * - `full`: Colored rings with brand colors (default)
   * - `monochrome`: Single color using currentColor, suitable for icons/buttons
   */
  variant?: LogoVariant;
}

/**
 * Makaio Logo Component
 *
 * Inline SVG of the Makaio logo for portable usage across web packages.
 * Accepts standard SVG props for sizing and styling.
 * @param props - Standard SVG props passed to the root svg element
 */
export function Logo(props: LogoProps) {
  const {
    title = 'Makaio logo',
    variant = 'full',
    'aria-label': ariaLabel,
    'aria-hidden': ariaHidden,
    ...rest
  } = props;

  const isMonochrome = variant === 'monochrome';
  const clipPathId = useId();
  const resolvedClipPathId = `makaio-logo-clip-right-arch-${clipPathId}`;
  const shouldHide = ariaHidden === true || ariaHidden === 'true';
  const resolvedAriaLabel = ariaLabel ?? title;

  return (
    <svg
      data-component="Logo"
      viewBox="0 0 400 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
      role={shouldHide ? undefined : 'img'}
      aria-label={shouldHide ? undefined : resolvedAriaLabel}
      aria-hidden={ariaHidden}
    >
      {!shouldHide && title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={resolvedClipPathId}>
          <rect x="14" y="-50" width="100" height="150" transform="rotate(-15 14 5)" />
        </clipPath>
      </defs>

      <g transform="translate(200, 200)" strokeWidth="24" strokeLinecap="round" fill="none">
        <path
          d="M -92 92 A 130 130 0 0 1 -92 -92"
          stroke={isMonochrome ? 'currentColor' : 'var(--color-kai-ring-violet, #8a2be2)'}
          opacity={isMonochrome ? 0.6 : 0.8}
        />
        <path
          d="M -112.6 -65 A 130 130 0 0 1 112.6 -65"
          stroke={isMonochrome ? 'currentColor' : 'var(--color-kai-ring-cyan, #00bfff)'}
          opacity={isMonochrome ? 0.7 : 0.8}
        />
        <path
          d="M 92 -92 A 130 130 0 0 1 92 92"
          stroke={isMonochrome ? 'currentColor' : 'var(--color-kai-ring-gold, #ffd700)'}
          opacity={isMonochrome ? 0.8 : 0.8}
        />
        <path
          d="M 120 50 A 130 130 0 0 1 0 130"
          stroke={isMonochrome ? 'currentColor' : 'var(--color-kai-ring-orange, #ff8c00)'}
          opacity={isMonochrome ? 0.7 : 0.8}
        />
        <path
          d="M 50 120 A 130 130 0 0 1 -120 50"
          stroke={isMonochrome ? 'currentColor' : 'var(--color-kai-ring-pink, #ff1493)'}
          opacity={isMonochrome ? 0.6 : 0.8}
        />
      </g>

      <g
        transform="translate(195, 195) scale(1.5)"
        stroke={isMonochrome ? 'currentColor' : 'var(--color-logo-white)'}
        strokeWidth="9"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M -42 35 L -42 -5 A 21 21 0 0 1 0 -5 L 0 35" />
        <g clipPath={`url(#${resolvedClipPathId})`}>
          <path d="M 4 -5 A 21 21 0 0 1 46 -5 L 46 35" />
        </g>
      </g>
    </svg>
  );
}
