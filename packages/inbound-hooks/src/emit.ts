import type { IMakaioBus } from '@makaio/bus-core';
import { createInboundHookReceivedSubject } from './namespace.js';
import type { RawInboundHookPayload } from './schemas.js';

/**
 * Options controlling fail-open behavior for hook bus emissions.
 */
export interface InboundHookEmitOptions {
  /**
   * When `true`, bus failures are swallowed and the function resolves normally.
   * Defaults to `true` for native hooks where bus unavailability must not
   * crash the calling hook process.
   */
  readonly failOpen?: boolean;
}

/**
 * Emit a raw inbound hook payload on the source-scoped `hook:<source>.received`
 * subject.
 * @param bus - Bus instance with `emit` support.
 * @param source - Stable source identifier (e.g., `'git'`, `'claude-code'`).
 * @param payload - Raw hook payload to emit.
 * @param options - Emission options; `failOpen` defaults to `true`.
 */
export async function emitInboundHookReceived(
  bus: Pick<IMakaioBus, 'emit'>,
  source: string,
  payload: RawInboundHookPayload,
  options: InboundHookEmitOptions = {},
): Promise<void> {
  const failOpen = options.failOpen ?? true;
  try {
    await bus.emit(createInboundHookReceivedSubject(source), payload);
  } catch (error) {
    if (!failOpen) {
      throw error;
    }
  }
}
