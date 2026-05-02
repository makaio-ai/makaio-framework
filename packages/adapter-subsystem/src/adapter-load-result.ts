export type AdapterLoadFailure = { success: false; error: string };
export type AdapterLoadResult = { success: true } | AdapterLoadFailure;

type AdapterLoadFailureOptions = {
  level?: 'warn' | 'error';
  cause?: unknown;
  logMessage?: string;
};

/**
 * Log a load failure consistently and return the bus response shape.
 * @param message - Human-readable error sent back to the caller.
 * @param options - Optional log level and underlying cause.
 * @returns Failure result matching the dynamic-load response contract.
 */
export function failAdapterLoad(message: string, options: AdapterLoadFailureOptions = {}): AdapterLoadFailure {
  const { level = 'error', cause, logMessage = message } = options;
  if (cause !== undefined) {
    if (level === 'warn') {
      console.warn(`[adapter-runtime] ${logMessage}:`, cause);
    } else {
      console.error(`[adapter-runtime] ${logMessage}:`, cause);
    }
  } else if (level === 'warn') {
    console.warn(`[adapter-runtime] ${logMessage}`);
  } else {
    console.error(`[adapter-runtime] ${logMessage}`);
  }
  return { success: false, error: message };
}
