/**
 * Page Section Types
 *
 * Defines the core types for the page section infrastructure.
 * Page sections are registered components that appear within parent pages
 * (e.g., settings sections within the Settings page).
 * @packageDocumentation
 */

import type { ComponentLike, IconComponentLike } from '../utils/component-types.js';

/**
 * Props passed to all page section components.
 *
 * Page sections use these props for navigation and styling.
 */
export interface PageSectionProps {
  /**
   * Navigate back to the parent page's overview.
   * Call this when user clicks back or cancels.
   */
  onNavigateBack: () => void;
  /**
   * Navigate to another path within the parent page.
   * @param path - Path to navigate to
   */
  onNavigate: (path: string) => void;
  /** Optional CSS class name for styling */
  className?: string;
}

/**
 * Status types for page sections.
 * Discriminated union for type-safe status badge rendering.
 */
export type PageSectionStatus =
  | { type: 'connected'; label?: string }
  | { type: 'connecting'; label?: string }
  | { type: 'disconnected'; label?: string }
  | { type: 'warning'; label: string }
  | { type: 'error'; label: string }
  | { type: 'not-configured' }
  | { type: 'configured'; count?: number };

/**
 * Definition of a page section available in the system.
 *
 * Page sections registered here appear in parent page navigation
 * and can be routed to via their parent page.
 */
export interface PageSectionDefinition<TProps extends PageSectionProps = PageSectionProps> {
  /** Unique identifier within parent page */
  id: string;
  /** ID of the parent page this section belongs to */
  parentPageId: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional icon component */
  icon?: IconComponentLike;
  /** Optional category for grouping within parent page */
  category?: string;
  /**
   * Order within category.
   *
   * Lower numbers appear first. Default: 100.
   */
  order?: number;
  /** Section content component */
  component: ComponentLike<TProps>;
  /**
   * Optional function to get current status for overview card.
   *
   * Called when rendering the overview to show status badges.
   * Return null to show no status.
   * @returns Current status or null
   */
  getStatus?: () => PageSectionStatus | null;
}
