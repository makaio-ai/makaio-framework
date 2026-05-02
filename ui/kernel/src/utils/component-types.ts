/**
 * Minimal component contracts for the React-hosted kernel tier.
 *
 * Kernel domain contracts stay free of direct React imports; this file is the
 * single seam that maps those contracts onto the renderer's component model.
 * @packageDocumentation
 */

import type { ComponentType } from 'react';

/**
 * Structural component contract accepted by kernel registries.
 * @typeParam TProps - Props accepted by the component.
 */
export type ComponentLike<TProps extends object = Record<string, unknown>> = ComponentType<TProps>;

/**
 * Shared icon component props used by kernel-tier contracts.
 */
export interface IconComponentProps {
  size?: number;
  className?: string;
}

/**
 * Structural icon component contract for navigation/page metadata.
 */
export type IconComponentLike = ComponentLike<IconComponentProps>;

/**
 * Lazy-loaded component module shape.
 * @typeParam TProps - Props accepted by the default-exported component.
 */
export interface LazyComponentModule<TProps extends object = Record<string, unknown>> {
  default: ComponentLike<TProps>;
}
