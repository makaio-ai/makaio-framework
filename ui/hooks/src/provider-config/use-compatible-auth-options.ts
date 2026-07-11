import { useEffect, useState } from 'react';
import type { CompatibleAuthOption } from '@makaio/services-core/adapter-subsystem';
import { useBus } from '../bus/bus-provider.js';
import { listCompatibleAuthOptions } from './selectors.js';

/** Reactive result for one definition's adapter-compatible auth methods. */
export interface UseCompatibleAuthOptionsResult {
  readonly options: CompatibleAuthOption[];
  readonly isLoading: boolean;
  readonly error: Error | null;
}

/**
 * Load the safe adapter-compatible authentication methods for one definition.
 * @param definitionId - Provider definition ID, or empty while no definition is selected.
 * @returns Current options plus loading and error state.
 */
export function useCompatibleAuthOptions(definitionId: string): UseCompatibleAuthOptionsResult {
  const bus = useBus();
  const [options, setOptions] = useState<CompatibleAuthOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    if (!definitionId) {
      setOptions([]);
      setIsLoading(false);
      setError(null);
      return () => {
        active = false;
      };
    }

    setIsLoading(true);
    setError(null);
    void listCompatibleAuthOptions(bus, definitionId)
      .then((nextOptions) => {
        if (active) setOptions(nextOptions);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setOptions([]);
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [bus, definitionId]);

  return { options, isLoading, error };
}
