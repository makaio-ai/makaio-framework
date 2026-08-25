/**
 * `@makaio/services-core/code-execution`
 *
 * Routing service for the `code-execution.execute` subject: selects exactly
 * one locally registered provider, owns the invocation's effective budget,
 * and normalizes every path to one terminal outcome.
 *
 * The package is opt-in. A host composes {@link codeExecutionPackage} only
 * when it is willing to execute submitted code under the trust its registered
 * providers declare.
 */
export { CodeExecutionService } from './code-execution-service.js';
export { codeExecutionPackage, CodeExecutionServiceToken } from './package.js';
export { createEffectiveExecutionSignal } from './execution-signal.js';
export type { EffectiveExecutionSignal, EffectiveExecutionSignalOptions } from './execution-signal.js';
export { selectCodeExecutionProvider } from './provider-selection.js';
export type {
  CodeExecutionProviderRejected,
  CodeExecutionProviderSelected,
  CodeExecutionProviderSelection,
  CodeExecutionSelectionFailureCode,
} from './provider-selection.js';
