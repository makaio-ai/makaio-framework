/**
 * Creates a monotonic clock that returns strictly increasing timestamps.
 *
 * `Date.now()` can repeat within the same millisecond; import-session
 * upsert created-detection relies on comparing the returned `discoveredAt`
 * against the attempted insert value. The returned function guarantees a
 * strictly increasing integer per instance.
 * @returns A function that produces the next monotonic timestamp in milliseconds
 */
export function createMonotonicClock(): () => number {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}
