import type { IMakaioBus } from '@makaio/bus-core';
import { dep, extensionToken, type MakaioNodeExtension } from '@makaio/contracts';
import { CapabilityToken } from '../capability/package.js';
import { CodeExecutionService } from './code-execution-service.js';

/** Token for the code-execution routing service. */
export const CodeExecutionServiceToken = extensionToken<CodeExecutionService>('code-execution');

/**
 * Opt-in package that registers the `code-execution.execute` handler.
 *
 * Deliberately **not** part of the framework core package list. The subject's
 * namespace is always registered, so any host can route and validate it, but
 * composing a handler for it means this host is willing to execute submitted
 * code with whatever trust its registered providers declare. That is a
 * composition decision, and it is made by naming this package.
 *
 * The capability registry is a hard dependency rather than a lazy bus lookup:
 * without it there is no provider bucket to select from, and a router that
 * started anyway would answer every invocation with `provider_unavailable`
 * while looking healthy.
 */
export const codeExecutionPackage: MakaioNodeExtension<IMakaioBus> = {
  name: CodeExecutionServiceToken.name,
  displayName: 'Code Execution',
  version: '0.1.0',
  critical: true,
  dependencies: [dep(CapabilityToken.name)],
  /**
   * Creates a new {@link CodeExecutionService} bound to the package bus.
   * @param ctx - Runtime context providing the bus and the capability registry.
   * @returns Uninitialized service instance; host calls `init()`.
   * @throws When the capability registry service is not available.
   */
  create: (ctx) => {
    const capabilities = ctx.getService(CapabilityToken);
    if (capabilities === undefined) {
      throw new Error('CapabilityService is not available for CodeExecutionService');
    }
    return new CodeExecutionService(ctx.bus, capabilities);
  },
};
