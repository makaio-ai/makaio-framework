/**
 * Analytics page context.
 *
 * Provides a shared {@link AnalyticsFilter} to all child widgets rendered
 * inside the analytics page canvas. The filter carries the selected account
 * scope and time range so widgets can request matching data without prop-drilling.
 * @packageDocumentation
 */

import { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Filter shape
// ---------------------------------------------------------------------------

/**
 * Named time range presets available in the analytics page header.
 *
 * - `'24h'` — last 24 hours.
 * - `'7d'`  — last 7 days.
 * - `'30d'` — last 30 days.
 */
export type AnalyticsRange = '24h' | '7d' | '30d';

/**
 * Shared analytics filter state provided by {@link AnalyticsPage}.
 *
 * Widgets consume this via {@link useAnalyticsContext}.
 */
export interface AnalyticsFilter {
  /** Credential-source client identifier for the selected account. */
  clientId: string;
  /** Account identifier within the client source. */
  accountId: string;
  /** Start of the selected range (epoch ms, inclusive). */
  from: number;
  /** End of the selected range (epoch ms, inclusive). */
  to: number;
  /** The named range preset currently selected. */
  range: AnalyticsRange;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * React context carrying the active {@link AnalyticsFilter}.
 *
 * The default value is `null`; consumers throw when called outside a provider
 * (see {@link useAnalyticsContext}).
 */
export const AnalyticsContext = createContext<AnalyticsFilter | null>(null);

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

/**
 * Returns the active {@link AnalyticsFilter} from the nearest
 * {@link AnalyticsContext} provider.
 *
 * The analytics page always wraps its canvas in a provider, so this hook is
 * safe to call from any widget rendered inside the analytics page.
 * @throws Error when called outside an {@link AnalyticsContext} provider.
 * @returns Current analytics filter.
 */
export function useAnalyticsContext(): AnalyticsFilter {
  const ctx = useContext(AnalyticsContext);

  if (ctx === null) {
    throw new Error('useAnalyticsContext must be called inside an AnalyticsContext.Provider');
  }

  return ctx;
}
