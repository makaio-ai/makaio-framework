import { HarnessSubjects, type HarnessDefinition } from '@makaio/contracts';

/** Result of an optional harness lookup — either unhandled or resolved. */
type OptionalHarnessResult = Promise<{ handled: false } | { handled: true; data: HarnessDefinition }>;

/**
 * Minimal requester contract for harness lookups.
 *
 * Supports both ID-based lookup (`HarnessSubjects.get`) and adapter-scoped
 * default lookup (`HarnessSubjects.getDefault`).
 */
export interface HarnessRequester {
  requestOptional(subject: typeof HarnessSubjects.get, payload: { id: string }): OptionalHarnessResult;
  requestOptional(
    subject: typeof HarnessSubjects.getDefault,
    payload: { adapterName?: string; clientId?: string },
  ): OptionalHarnessResult;
}

/**
 * Resolve SDK-native tool names disabled by the active harness for an adapter.
 *
 * When `harnessId` is provided, fetches that specific harness by ID.
 * Otherwise falls back to the adapter's default harness via `adapterName` and
 * optional `clientId` so that client-scoped harnesses are considered.
 *
 * Uses optional request semantics so callers can run without harness registration
 * (for example, in lightweight test runtimes).
 * @param requester - Bus-like requester supporting requestOptional for harness subjects
 * @param adapterName - Adapter name used to look up the default harness (fallback path)
 * @param harnessId - Optional explicit harness ID; takes precedence over the default lookup
 * @param clientId - Optional client identifier for client-scoped default harness lookup
 * @returns Disabled native tool names, or an empty array when unavailable
 */
export async function resolveDisabledNativeTools(
  requester: HarnessRequester,
  adapterName: string,
  harnessId?: string,
  clientId?: string,
): Promise<readonly string[]> {
  const result =
    harnessId !== undefined
      ? await requester.requestOptional(HarnessSubjects.get, { id: harnessId })
      : await requester.requestOptional(HarnessSubjects.getDefault, { adapterName, clientId });
  return result.handled ? result.data.nativeTools.disabled : [];
}
