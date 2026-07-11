import type { ProviderContext } from '@makaio/contracts';

/**
 * Compare two refs-only provider-context snapshots structurally.
 *
 * Authentication refs are compared as opaque identities. This function never
 * resolves or logs credential material, while still treating record key order
 * as irrelevant and detecting any normalized auth-definition change.
 * @param left - First provider context.
 * @param right - Second provider context.
 * @returns Whether both contexts describe the same provider runtime state.
 */
export function providerContextsEqual(left: ProviderContext | undefined, right: ProviderContext | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.state !== right.state) {
    return false;
  }
  if (left.state === 'unresolved' || right.state === 'unresolved') {
    return left.state === right.state;
  }
  return (
    left.providerConfigId === right.providerConfigId &&
    left.definitionId === right.definitionId &&
    jsonValuesEqual(left.endpointOverrides, right.endpointOverrides) &&
    jsonValuesEqual(left.auth, right.auth) &&
    jsonValuesEqual(left.capabilities, right.capabilities)
  );
}

/**
 * Compare JSON-safe contract values without relying on object key order.
 * @param left - First JSON-safe value
 * @param right - Second JSON-safe value
 * @returns Whether both values are structurally equal
 */
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
  );
}

/**
 * Narrow an unknown JSON value to an object record.
 * @param value - Unknown value to inspect
 * @returns Whether the value is a non-array object record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
