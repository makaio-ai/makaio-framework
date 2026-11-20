/**
 * Generate a unique ID with a given prefix.
 * @param prefix - The prefix for the ID
 * @returns A unique identifier string
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sleep for a specified duration.
 * @param ms - Duration in milliseconds
 * @returns A promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
