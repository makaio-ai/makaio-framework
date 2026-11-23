/** Retained value signal shared by the provider's two terminal fact families. */
export interface ReplayOnceSignal<T extends object> {
  /** Publish the retained value at most once. */
  readonly publish: (createValue: () => T) => void;
  /** Observe the retained value, replaying it after publication. */
  readonly observe: (observer: (value: T) => void) => () => void;
}

/**
 * Create an at-most-once signal that replays its retained value to late observers.
 *
 * The value producer runs before the signal becomes observable. Callers can
 * therefore perform required local cleanup in the producer without exposing
 * a completion or conclusion before that cleanup succeeds.
 * @param observerFailureLabel - Stable log prefix identifying the signal's observer family.
 * @returns Publisher and observer registration for one retained value.
 */
export function createReplayOnceSignal<T extends object>(observerFailureLabel: string): ReplayOnceSignal<T> {
  const observers = new Set<(value: T) => void>();
  let value: T | undefined;

  return {
    publish: (createValue): void => {
      if (value !== undefined) return;
      const nextValue = createValue();
      value = nextValue;
      const pending = [...observers];
      observers.clear();
      for (const observer of pending) {
        try {
          observer(nextValue);
        } catch (error) {
          console.error(`${observerFailureLabel} observer failed:`, error);
        }
      }
    },
    observe: (observer): (() => void) => {
      if (value !== undefined) {
        observer(value);
        return () => undefined;
      }
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}
