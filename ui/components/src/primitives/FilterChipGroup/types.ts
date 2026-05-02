import type { BadgeVariant } from '../Badge/Badge.js';

/**
 * A single filter option.
 * @typeParam T - The value type
 */
export interface FilterOption<T> {
  /** Unique identifier for stable equality checks */
  id: string;
  /** The value this option represents */
  value: T;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
  /** Badge color variant */
  variant?: BadgeVariant;
}
