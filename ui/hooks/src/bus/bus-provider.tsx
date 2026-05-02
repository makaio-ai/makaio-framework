/**
 * Bus context provider and hook for the framework layer.
 *
 * Provides a minimal `BusProvider` component and `useBus` hook that
 * expose an `IMakaioBus` instance to the React component tree via context.
 * This is the framework-level equivalent of the host's `BusProvider` —
 * no SharedWorker guard or host-specific features.
 * @packageDocumentation
 */

import { createContext, useContext, type ReactNode, type JSX } from 'react';
import type { IMakaioBus } from '@makaio/bus-core';

/**
 * React context carrying the active bus instance.
 *
 * Components must be rendered inside a `BusProvider` to access this context.
 */
export const BusContext = createContext<IMakaioBus | null>(null);

/**
 * Props for {@link BusProvider}.
 */
export interface BusProviderProps {
  /**
   * Pre-connected bus instance to expose via context.
   *
   * Required so framework surfaces make their bus bootstrap explicit instead of
   * silently falling back to the global singleton.
   */
  bus: IMakaioBus;

  /** React children rendered inside the bus context. */
  children: ReactNode;
}

/**
 * Provides the connected `IMakaioBus` instance to the React component tree.
 *
 * The bus transport must be established before this component mounts.
 * On the Electron path, pass the `MakaioBus` singleton after calling
 * `MakaioBus.connect()` in the bootstrap function.
 * @param props - Provider configuration.
 * @returns React provider wrapping children with the active bus context.
 */
export function BusProvider({ bus, children }: BusProviderProps): JSX.Element {
  return <BusContext.Provider value={bus}>{children}</BusContext.Provider>;
}

/**
 * Hook to access the bus instance from React context.
 *
 * Must be called inside a component tree that is wrapped in `BusProvider`.
 * @returns The active `IMakaioBus` instance.
 * @throws When called outside a `BusProvider`.
 * @example
 * ```tsx
 * function MyComponent() {
 *   const bus = useBus();
 *   const handleClick = () => void bus.emit(MySubjects.clicked, {});
 *   return <button onClick={handleClick}>Click</button>;
 * }
 * ```
 */
export function useBus(): IMakaioBus {
  const bus = useContext(BusContext);
  if (!bus) {
    throw new Error('useBus must be used within a BusProvider');
  }
  return bus;
}

/**
 * Hook to optionally access the bus instance from React context.
 *
 * Unlike {@link useBus}, this hook does not throw when called outside a
 * `BusProvider`. It returns `null` when no provider is mounted, allowing
 * components to degrade gracefully rather than crash.
 *
 * Use this for components that can meaningfully render without a bus (e.g.
 * by disabling interactive affordances). Prefer {@link useBus} for components
 * that have no useful state without a bus.
 * @returns The active `IMakaioBus` instance, or `null` if no provider is mounted.
 */
export function useOptionalBus(): IMakaioBus | null {
  return useContext(BusContext);
}
