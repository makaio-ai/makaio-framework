/**
 * A real {@link GatewayLogger} that records what the gateway wrote.
 *
 * Not a spy on `console`: it is an ordinary implementation of the injection
 * point the router already exposes, so the tests assert on the gateway's actual
 * output contract rather than on how that output reaches a terminal. Suites
 * that do not assert on logging use it as a silent sink, keeping the test
 * runner's output free of per-request lines.
 */

import type { GatewayLogger, GatewayLogLevel } from '../../logging.js';

/** One line the gateway wrote, with the severity it chose. */
export interface CapturedLogLine {
  /** Severity the gateway selected for this line. */
  readonly level: GatewayLogLevel;
  /** The line itself, without the sink's `[gateway]` prefix. */
  readonly message: string;
}

/** A capturing logger together with what it has captured so far. */
export interface CapturingLogger {
  /** The sink to hand to `createGatewayRouter`. */
  readonly logger: GatewayLogger;
  /** Every line written so far, in order. */
  readonly lines: readonly CapturedLogLine[];
  /**
   * All captured lines joined by newlines, each prefixed with its level.
   *
   * The form to assert against when checking that a value never appears
   * anywhere in the gateway's output.
   */
  readonly text: string;
}

/**
 * Create a capturing logger.
 * @returns The sink plus live views over what it has captured.
 */
export function createCapturingLogger(): CapturingLogger {
  const lines: CapturedLogLine[] = [];
  return {
    logger: {
      /**
       * Capture an informational line.
       * @param message - The line the gateway wrote.
       */
      info(message: string): void {
        lines.push({ level: 'info', message });
      },
      /**
       * Capture a warning line.
       * @param message - The line the gateway wrote.
       */
      warn(message: string): void {
        lines.push({ level: 'warn', message });
      },
      /**
       * Capture an error line.
       * @param message - The line the gateway wrote.
       */
      error(message: string): void {
        lines.push({ level: 'error', message });
      },
    },
    get lines(): readonly CapturedLogLine[] {
      return lines;
    },
    get text(): string {
      return lines.map((line) => `${line.level} ${line.message}`).join('\n');
    },
  };
}
