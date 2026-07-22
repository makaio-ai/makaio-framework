/**
 * \@makaio/bus-core
 *
 * Type-safe event bus with support for both events and requests.
 *
 * ## Features
 * - **Unified API**: Single `on()` method for both events and requests
 * - **Type Safety**: Full TypeScript inference from subject definitions
 * - **Zero-Cost Abstraction**: Subjects are just strings at runtime
 * - **Distributed Ownership**: Each package defines and owns its subjects
 * - **Middleware Support**: Request handlers can form a chain
 * - **Validation**: Optional Zod validation in development mode
 *
 * ## Basic Usage
 *
 * ### Define Subjects
 * ```typescript
 * import { SubjectRegistry } from '@makaio/bus-core';
 * import { z } from 'zod';
 *
 * const { namespace: AdapterSubjects } = MakaioBus.registerNamespace('adapter', {
 *   // Event: fire-and-forget
 *   initialized: z.object({ adapterName: z.string() }),
 *
 *   // Request: request-response
 *   getCapabilities: {
 *     request: z.object({ adapterName: z.string() }),
 *     response: z.object({ capabilities: z.array(z.string()) }),
 *   },
 * });
 * ```
 *
 * ### Use Events
 * ```typescript
 * import { MakaioBus, BusSubjects } from '@makaio/bus-core';
 *
 * // Listen for events
 * MakaioBus.on(BusSubjects.adapter.initialized, (payload) => {
 *   console.debug('Adapter initialized:', payload.adapterName);
 * });
 *
 * // Emit events
 * await MakaioBus.emit(BusSubjects.adapter.initialized, {
 *   adapterName: 'claude'
 * });
 * ```
 *
 * ### Use Requests
 * ```typescript
 * // Handle requests
 * MakaioBus.on(BusSubjects.adapter.getCapabilities, (context) => {
 *   const capabilities = loadCapabilities(context.payload.adapterName);
 *   context.setResult({ capabilities });
 * });
 *
 * // Make requests
 * const result = await MakaioBus.request(
 *   BusSubjects.adapter.getCapabilities,
 *   { adapterName: 'claude' }
 * );
 * console.debug(result.capabilities);
 * ```
 */

export { getFullSubjectForSubjectDefinition } from './utils/subject-transformation.js';

export { getSubjectFromBusMessage, deserializeTransportError } from './utils/index.js';
export { isRequestSchema } from './utils/is-request-schema.js';

export { matchesSubscription, matchesAnySubscription } from './utils/subscription-matching.js';

export { parseBusUrl } from './utils/url-config.js';
export type { BusUrlConfig } from './utils/url-config.js';

export {
  BusError,
  ChannelAuthError,
  ChannelClosedError,
  ChannelOnlyError,
  CONNECTION_LOST_ERROR_CODE,
  ConnectionLostError,
  LocalSubjectError,
  NO_HANDLER_ERROR_CODE,
  NoHandlerError,
  RequestError,
  TimeoutError,
  ValidationError,
} from './errors/index.js';

export type { OnOptions } from './types/options.js';
export type { InterceptorContext } from './types/interceptor.js';
export type { BusNamespace, ScopedBusFor } from './types/namespace.js';

export type {
  BusTransport,
  BusReceiveHandler,
  BusMessage,
  BusEventMessage,
  BusRequestMessage,
  BusResponseMessage,
  BusBroadcastMessage,
  BusBroadcastResponseMessage,
  BusSubscribeMessage,
  BusUnsubscribeMessage,
  BusSubscribeSyncCompleteMessage,
  BusSubscriptionAckMessage,
  BusHeartbeatMessage,
  BusTransportError,
} from './types/transports.js';

export { MakaioBus, createBusInstance, createBusContext } from './bus.js';
export { waitForSubscriptionPropagation } from './methods/on.js';
export type { ScopedBus } from './bus.js';
export type { ConnectOptions, IMakaioBus, MakaioBusContext, TransportRegistration } from './types/bus.js';

/**
 * Extend a registered subject's schema when operating on an explicit bus context.
 *
 * Most consumers should use `MakaioBus.extendSubject()` instead, which binds
 * the singleton context automatically. This function form is for scoped or
 * isolated bus contexts (e.g., in tests or multi-bus setups).
 * @public
 */
export { defineSubjectExtension, extendSubjectImpl as extendSubject } from './extend-subject.js';
export type {
  DefinedSubjectExtension,
  ExtendedSubjectDefinition,
  SubjectExtension,
  RequestSubjectExtension,
  EventSubjectExtension,
} from './extend-subject.js';

export { createFilteredBus } from './filtered-bus.js';
export type { IFilteredBus } from './filtered-bus.js';

export { matchesFilter, mergeFilters, getPath } from './utils/payload-filter.js';
export { DEFAULT_REQUEST_TIMEOUT_MS } from './types/options.js';
export { OnceAbortError } from './methods/once.js';

export type {
  BusTransportRegistry,
  BusTransportKeys,
  BusValidationMode,
  NamespaceRegistrationOptions,
  SchemaViolationCallback,
  SchemaViolationReport,
} from './registries/index.js';
export { isNoHandlerErrorForSubject } from './utils/transport.js';

export type { OptionalResult } from '@makaio/core';

export type { BroadcastContext, BroadcastResult } from './methods/broadcast.js';

export { localSubject } from './utils/local-schema.js';
export { collectorOnlySubject } from '@makaio/core';
export { channelSubject } from './utils/channel-schema.js';
export { defaultTransports, hostLocalRequest } from '@makaio/core';

export type { IDirectChannel, ChannelEndpoint, ChannelEndpointOptions } from './channel/index.js';
export { SystemChannelSchemas, createChannelEndpoint, openChannel } from './channel/index.js';

export { CorrelationTracker } from './utils/correlation-tracker.js';
export type { ConnectedPayload, DisconnectedPayload } from './lifecycle.js';
export type { ExtensionNamespaceConfig } from './extension-namespace-types.js';
export {
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  shouldReceiveMessage,
  handleCorrelationResponse,
  trackMessageCorrelation,
  serializeTransportError,
} from './utils/transport-helpers.js';

export { BusLifecycle } from './lifecycle.js';

export { buildSubscribeMessage, buildUnsubscribeMessage } from './subscribe-message.js';
export type { SubscriptionEntry } from './subscribe-message.js';
export type { SubscriptionDeliveryClass } from './types/transports.js';

export { createExtensionNamespace } from './create-extension-namespace.js';
export type {
  ExtensionNamespace,
  ExtensionNamespaceExtensions,
  ExtensionNamespaceFromConfig,
} from './extension-namespace-types.js';

export { __resetWarnedSubjects } from './utils/warn-unregistered.js';

export {
  createProjectedTelemetryTransport,
  createSubjectTelemetryProjectorRegistry,
  projectSubjectTelemetryFacts,
} from './observability/index.js';
export type { ProjectableBusMessage, SubjectTelemetryProjectionInput } from './observability/index.js';
export type {
  ProjectedTelemetryTransportOptions,
  SubjectTelemetryAttributes,
  SubjectTelemetryProjector,
  SubjectTelemetryProjectorInput,
  SubjectTelemetryProjectorRegistry,
} from './observability/index.js';
export type { BusMessageObserver, ObservedBusMessage } from './types/bus.js';
