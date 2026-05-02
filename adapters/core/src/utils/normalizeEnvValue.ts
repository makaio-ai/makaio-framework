/**
 * Normalize blank environment values to `undefined`.
 * @param value - Raw environment value
 * @returns Trimmed value when non-empty
 */
export function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
