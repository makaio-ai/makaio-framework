/**
 * `@makaio/sdk` — TypeScript SDK for the Makaio bus protocol.
 *
 * Single-package import for external consumers. Provides a {@link BusClient}
 * and re-exports the bus subject namespaces that SDK consumers need.
 * @example
 * ```ts
 * import { BusClient, AgentSubjects, SessionSubjects } from '@makaio/sdk';
 *
 * const client = new BusClient();
 * await client.connect();
 *
 * client.subscribe(AgentSubjects.$all, (ctx) => {
 *   console.info(ctx.subject, ctx.payload);
 * });
 *
 * await client.request(SessionSubjects.sendMessage, {
 *   sessionId: crypto.randomUUID(),
 *   agent: { kind: 'canonical-model', model: 'gemini-2.5-pro' },
 *   message: 'Hello from the SDK!',
 * });
 *
 * client.close();
 * ```
 * @packageDocumentation
 */

// Client
export { BusClient, probeHealth } from './bus-client.js';
export type {
  BusClientOptions,
  ServerHealth,
  EventHandler,
  RequestHandler,
  HandlerOptions,
  OnceOptions,
} from './bus-client.js';

// Bus subject namespaces — re-exported so consumers never import @makaio/contracts directly
export { AgentSubjects, AgentNamespace } from '@makaio/contracts';
export { SessionSubjects, SessionNamespace } from '@makaio/contracts';
export { AdapterSubjects, AdapterNamespace } from '@makaio/contracts';
export { ToolSubjects, ToolNamespace } from '@makaio/contracts';
export { ApprovalSubjects, ApprovalNamespace } from '@makaio/contracts';
