/**
 * Collapsible Context
 *
 * React context for coordinating multiple CollapsibleSection components
 * within a CollapsibleGroup.
 */

import { createContext, useContext } from 'react';
import type { CollapsibleContextValue } from './types.js';

/**
 * Context for CollapsibleGroup coordination.
 * Null when used outside a group (standalone mode).
 */
export const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

/**
 * Hook to access CollapsibleGroup context.
 * @returns Context value or null when used outside a group
 */
export function useCollapsibleGroup(): CollapsibleContextValue | null {
  return useContext(CollapsibleContext);
}
