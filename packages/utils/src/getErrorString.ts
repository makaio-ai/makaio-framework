/**
 * Extracts error message string from various error types
 * @param error - Error value to extract message from
 * @returns Error message string or 'Unknown error'
 */
export function getErrorString(error: string | Error | undefined) {
  if (!error) {
    return 'Unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  return error.message || 'Unknown error';
}
