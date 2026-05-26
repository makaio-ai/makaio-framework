/**
 * React hook for querying bus request subjects with loading, data, and error state.
 *
 * Fires a bus request on mount (and when dependencies change) and exposes
 * the result as a React state triple: `{ data, loading, error }`. Supports
 * declarative refetch triggers via `refetchOn` and a `skip` flag to pause
 * fetching while keeping previously loaded data in place.
 * @packageDocumentation
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SubjectDefinition } from '@makaio/core';
import { useBus } from './bus-provider.js';

/**
 * Internal serialization state for the request object.
 *
 * Tracks whether the request can be JSON round-tripped so that the effect
 * dependency can be a stable primitive (the JSON string) rather than the
 * original object reference, which would cause an infinite loop.
 */
interface RequestSerializationState {
  readonly serialized?: string;
  readonly deserializable: boolean;
}

const NON_SERIALIZABLE_REQUEST_DEPENDENCY = 'non-serializable-request';

/**
 * Options for {@link useBusQuery}.
 * @typeParam Subject - The bus subject definition for the request.
 */
export interface UseBusQueryOptions<Subject extends SubjectDefinition> {
  /**
   * The bus subject definition representing the request to execute.
   *
   * Must be a request-type subject (one with `request` and `response` fields).
   */
  readonly subject: Subject;

  /**
   * The payload to send with the request.
   *
   * Must be JSON-serializable so it can be used as a stable effect dependency.
   */
  readonly request: Subject['$meta']['payload'] extends { request: infer Request } ? Request : never;

  /**
   * When `true`, the query is not sent and any previously loaded data is retained.
   *
   * Toggling from `true` back to `false` triggers an immediate refetch.
   * @defaultValue false
   */
  readonly skip?: boolean;

  /**
   * Optional list of event subjects whose emission should trigger a refetch.
   *
   * Each subject in the array is subscribed to when the hook mounts. When any
   * of those events fire the query is re-executed automatically.
   */
  readonly refetchOn?: readonly SubjectDefinition[];
}

/**
 * Result returned by {@link useBusQuery}.
 * @typeParam Response - The response payload type from the bus subject.
 */
export interface UseBusQueryResult<Response> {
  /** The most recently resolved response, or `undefined` before the first successful fetch. */
  readonly data: Response | undefined;

  /** `true` while a request is in flight. */
  readonly loading: boolean;

  /** Set when the most recent request threw or the bus returned an error. */
  readonly error: Error | undefined;

  /**
   * Imperatively trigger a refetch regardless of the current `skip` flag.
   *
   * The `skip` guard is bypassed: if you call `refetch()` while `skip` is `true`
   * the request is still sent.
   */
  readonly refetch: () => void;
}

/**
 * Query a bus request subject and expose the result as React state.
 *
 * The hook fires an async bus request on mount and re-fires whenever `subject`,
 * `request`, or `skip` change. Use `refetchOn` to subscribe to bus events that
 * should invalidate the cached result and trigger a fresh request.
 * @param options - Query configuration.
 * @returns Reactive query state including data, loading, error, and a manual refetch callback.
 * @example
 * ```tsx
 * const { data, loading, error } = useBusQuery({
 *   subject: MyNamespace.subjects.getItem,
 *   request: { id: itemId },
 *   refetchOn: [MyNamespace.subjects.itemChanged],
 * });
 * ```
 */
export function useBusQuery<Subject extends SubjectDefinition>({
  subject,
  request,
  skip = false,
  refetchOn = [],
}: UseBusQueryOptions<Subject>): UseBusQueryResult<
  Subject['$meta']['payload'] extends { response: infer Response } ? Response : never
> {
  type Request = Subject['$meta']['payload'] extends { request: infer ResolvedRequest } ? ResolvedRequest : never;
  type Response = Subject['$meta']['payload'] extends { response: infer ResolvedResponse } ? ResolvedResponse : never;

  const bus = useBus();

  const [data, setData] = useState<Response | undefined>();
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState<Error | undefined>();

  // Serialize the request to a stable string so the effect dependency doesn't
  // retrigger on every render when the caller creates a new object literal each time.
  const requestState = useMemo((): RequestSerializationState => {
    if (request === undefined) return { deserializable: true };
    try {
      const serialized = JSON.stringify(request);
      return serialized === undefined ? { deserializable: false } : { serialized, deserializable: true };
    } catch {
      return { deserializable: false };
    }
  }, [request]);

  // Use the JSON string as the dependency when possible. Non-serializable
  // payloads share one stable key so inline invalid objects fail once instead
  // of re-running the effect after every error render.
  const requestDependency = requestState.deserializable ? requestState.serialized : NON_SERIALIZABLE_REQUEST_DEPENDENCY;

  const requestForDispatch = useMemo((): Request | undefined => {
    if (!requestState.deserializable) return undefined;
    if (requestState.serialized === undefined) return undefined;
    return JSON.parse(requestState.serialized) as Request;
  }, [requestDependency, requestState.deserializable, requestState.serialized]);

  // Keep a stable ref to `refetchOn` so the subscription effect callback
  // always sees the current array without needing to list it as a dependency.
  const refetchOnRef = useRef(refetchOn);
  refetchOnRef.current = refetchOn;

  // Derive a stable string key from the subject identities in `refetchOn`.
  // This only changes when the actual set of subjects changes, preventing
  // subscription teardown/resubscribe when callers pass an inline array literal
  // that produces a new reference on every render.
  //
  // We hold the computed key in a ref and only replace it when the string
  // itself changes, so `refetchOnKey` is always the same object reference
  // across renders where the subjects did not change.
  const computedKey = useMemo(
    () => refetchOn.map(getSubjectIdentityKey).join(','),
    // `refetchOn` is an array whose referential identity changes on every render
    // when the caller passes an inline literal. The ref + key pattern below
    // handles the instability: re-subscribing is controlled by `refetchOnKey`.
    [refetchOn],
  );
  const refetchOnKeyRef = useRef(computedKey);
  if (refetchOnKeyRef.current !== computedKey) {
    refetchOnKeyRef.current = computedKey;
  }
  const refetchOnKey = refetchOnKeyRef.current;

  // Monotonically increasing request ID used to discard stale responses when
  // a new request starts before the previous one resolves.
  const requestIdRef = useRef(0);

  const refetch = useCallback(async () => {
    const currentId = ++requestIdRef.current;

    setLoading(true);
    setError(undefined);

    try {
      if (!requestState.deserializable) {
        throw new Error('useBusQuery request must be JSON-serializable.');
      }

      const result = (await bus.request(
        subject as never,
        requestForDispatch as Subject['$meta']['payload']['request'],
      )) as Response;

      if (currentId === requestIdRef.current) {
        setData(result);
      }
    } catch (caught) {
      if (currentId === requestIdRef.current) {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    } finally {
      if (currentId === requestIdRef.current) {
        setLoading(false);
      }
    }
    // `request` is intentionally excluded: we depend on `requestDependency`
    // (the JSON-serialized form) rather than the object reference to avoid
    // infinite loops when the caller creates a new object literal each render.
  }, [bus, subject, requestDependency, requestForDispatch, requestState.deserializable]);

  // Fire the query whenever dependencies change (and skip → false).
  // `skip` is listed so that toggling from true → false triggers a fresh fetch.
  useEffect(() => {
    if (skip) return;
    void refetch();
  }, [refetch, skip]);

  // Subscribe to refetch-trigger events.
  // `refetchOnKey` is a stable string derived from subject identities —
  // it only changes when the actual subjects change, not on every render.
  // `refetchOnRef` provides the current array at subscription time without
  // adding the unstable array reference to the dependency list.
  useEffect(() => {
    if (skip) return;
    if (refetchOnRef.current.length === 0) return;
    const unsubscribes = refetchOnRef.current.map((eventSubject) =>
      bus.on(eventSubject as never, (() => void refetch()) as never),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    // `refetchOnRef` intentionally excluded: it is a stable ref whose `.current`
    // is always up-to-date; re-subscribing is controlled by `refetchOnKey`.
  }, [bus, refetchOnKey, refetch, skip]);

  return { data, loading, error, refetch };
}

/**
 * Build the subscription identity key for a refetch trigger subject.
 * @param subject - Subject definition used as a refetch trigger.
 * @returns Stable identity key including routing-relevant metadata.
 */
function getSubjectIdentityKey(subject: SubjectDefinition): string {
  return JSON.stringify({
    subject: String(subject.subject),
    meta: subject.$meta,
  });
}
