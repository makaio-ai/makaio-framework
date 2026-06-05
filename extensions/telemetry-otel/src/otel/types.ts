/**
 * OTel emitter interface contract.
 *
 * Defines the emitter abstraction so the service layer can inject a test
 * double without depending on the real SDK.
 * @packageDocumentation
 */

import type { SpanDraft } from '../contracts/index.js';

/**
 * Emits completed span drafts through a real telemetry backend.
 *
 * Implementations receive a batch of fully-resolved {@link SpanDraft} objects
 * and are responsible for translating them to the underlying telemetry API,
 * such as the OTel SDK.
 */
export interface ISpanEmitter {
  /**
   * Export a batch of span drafts as completed OTel spans.
   * @param drafts - Fully-resolved span drafts to export in order.
   * @returns A promise that resolves when all drafts have been emitted.
   */
  emit(drafts: readonly SpanDraft[]): Promise<void>;
  /**
   * Flush pending spans and shut down the underlying exporter.
   *
   * Called during service destroy to drain the {@link BatchSpanProcessor}
   * queue before the process exits. Implementations that hold no processor
   * may omit this method.
   * @returns A promise that resolves when the shutdown is complete.
   */
  shutdown?(): Promise<void>;
}
