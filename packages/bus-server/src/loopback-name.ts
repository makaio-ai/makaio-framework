const PRIMARY_TRANSPORT = 'websocket';

/**
 * Normalize and validate the optional loopback transport name.
 * @param loopbackName - Optional transport registry key for loopback relay registration.
 * @returns Trimmed loopback name, or `undefined` when not provided.
 */
export function normalizeLoopbackName(loopbackName: string | undefined): string | undefined {
  const normalized = loopbackName?.trim();
  if (loopbackName !== undefined && (!normalized || normalized === PRIMARY_TRANSPORT)) {
    throw new Error(`Invalid loopbackName: expected non-empty transport name other than "${PRIMARY_TRANSPORT}"`);
  }
  return normalized;
}
