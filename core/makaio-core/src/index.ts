// Bus namespace definition
export { createBusNamespace } from './bus-namespace-definition.js';
export type {
  BusNamespaceDefinition,
  NamespaceRegistrationOptions,
  RegistrableBusNamespaceDefinition,
  SchemaViolationReport,
} from './bus-namespace-definition.js';

// Subject helpers
export {
  nestSubjectDefinitions,
  getFullSubjectForSubjectDefinition,
  isRequestSchema,
  localSubject,
  isLocalSchema,
  channelSubject,
  isChannelSchema,
  unwrapSchema,
} from './subject-helpers/index.js';
export type { BusSubjects, NestedSubjectDefinitions, FlatSubjectDefinitions } from './subject-helpers/index.js';

// Context
export type { MakaioContext } from './context/index.js';
export { createMakaioContext } from './context/index.js';

// Errors
export {
  MakaioError,
  InvalidModelError,
  DirectoryNotFoundError,
  ConfigError,
  RateLimitError,
  AuthenticationError,
  ModelUnavailableError,
  QuotaExceededError,
} from './errors/index.js';

// Types
export { isOperatorObject, WildcardSubjectKey } from './types/index.js';
export type {
  AnyHandler,
  AnyMessageContext,
  BaseSubjectSchema,
  ChannelSubjectSchema,
  ContextForSubjectDefinition,
  EventContext,
  EventHandler,
  EventMessagePayload,
  EventSchema,
  ExtractSubjectPayload,
  ExtractSubjectResponse,
  FilterablePayloadIntersection,
  FilterOperator,
  FilterPayloadFromSchemas,
  HandlerForSubjectDefinition,
  IConfigStorage,
  InferSchemaPayload,
  InferSubjectMeta,
  LocalSubjectSchema,
  MessagePayload,
  OptionalResult,
  PayloadFilter,
  PrincipalContext,
  RequestContext,
  RequestHandler,
  RequestMessagePayload,
  RequestSchema,
  SchemaRecord,
  ScopedSubjectDefinition,
  SubjectDefinition,
  SubjectRecord,
  SubjectRecordFromSchemaRecord,
  SubjectSchema,
  TransportPeerContext,
  TransportReceiveContext,
  TypedPayloadFilter,
  WildcardSubject,
  WildcardContext,
  WildcardSubjectDefinition,
  WildcardUnifiedHandler,
  MakaioBusLike,
} from './types/index.js';
