import type { RegistrableBusNamespaceDefinition } from '@makaio/core';
import { AdapterNamespace } from './adapter/namespace.js';
import { AgentNamespace } from './agent/namespace.js';
import { AgentResolutionNamespace } from './agent-resolution/namespace.js';
import { ApprovalNamespace } from './approval/namespace.js';
import { ArtifactNamespace } from './artifact/index.js';
import { CanonicalModelNamespace } from './canonical-model/namespace.js';
import { CapabilityNamespace } from './capability/namespace.js';
import { ClientNamespace } from './client/namespace.js';
import { ConfigNamespace } from './config/config-namespace.js';
import { CredentialNamespace } from './credential/namespace.js';
import { FacetNamespace } from './facet/namespace.js';
import { MaterializationNamespace } from './materialization/namespace.js';
import { HarnessNamespace } from './harness/namespace.js';
import { HostNamespace } from './host/namespace.js';
import { McpNamespace } from './mcp/namespace.js';
import { NativeSessionSupervisorNamespace } from './native-session-supervisor/namespace.js';
import { PlatformNamespace } from './platform/namespace.js';
import { GitHookNamespace } from './capabilities/git-hooks/namespace.js';
import { ReviewNamespace } from './capabilities/review/namespace.js';
import { SessionNamespace } from './session/namespace.js';
import { SkillNamespace } from './skill/namespace.js';
import { SubagentNamespace } from './subagent/namespace.js';
import { SubjectTelemetryNamespace } from './telemetry/namespace.js';
import { ToastNamespace } from './toast/namespace.js';
import { ToolNamespace } from './tool/namespace.js';
import { VariantNamespace } from './variant/namespace.js';
import { VCSNamespace } from './capabilities/vcs/namespace.js';
import { VCSEventsNamespace } from './capabilities/vcs/events.js';
import { VCSPRNamespace } from './capabilities/vcs-pr/namespace.js';
import { VisionNamespace } from './capabilities/vision/namespace.js';
import { VoiceNamespace } from './capabilities/voice/namespace.js';
import { WorkflowNamespace } from './workflow/namespace.js';
import { WorkflowBlocksNamespace } from './workflow-blocks/namespace.js';
import { WorkerNodeNamespace } from './worker-node/namespace.js';

import { MessageStorageNamespace } from './session/message-storage-namespace.js';
import { SessionEventStorageNamespace } from './session/session-event-storage-namespace.js';
import { SessionStorageNamespace } from './session/session-storage-namespace.js';
import { SkillStorageNamespace } from './skill/storage-namespace.js';

/**
 * All Tier-A framework contract bus namespace definitions.
 *
 * Composition roots register these at boot time to enable schema validation,
 * local-subject routing, and `extendSubject()` for all framework subjects:
 * @example
 * ```typescript
 * import { FrameworkContractNamespaces } from '@makaio/contracts';
 *
 * bus.registerNamespaces(FrameworkContractNamespaces);
 * ```
 */
// Each element is a specific BusNamespaceDefinition<LiteralDomain, ConcreteSchemas>.
// TypeScript cannot unify the deeply nested subject-tree types across the tuple's
// heterogeneous elements into BusNamespaceDefinition<string, ...>, so an explicit
// widening cast is required for registerNamespaces() compatibility.
export const FrameworkContractNamespaces: readonly RegistrableBusNamespaceDefinition[] = [
  AdapterNamespace,
  AgentNamespace,
  AgentResolutionNamespace,
  ApprovalNamespace,
  ArtifactNamespace,
  CanonicalModelNamespace,
  CapabilityNamespace,
  ClientNamespace,
  ConfigNamespace,
  CredentialNamespace,
  FacetNamespace,
  GitHookNamespace,
  MaterializationNamespace,
  HarnessNamespace,
  HostNamespace,
  McpNamespace,
  NativeSessionSupervisorNamespace,
  PlatformNamespace,
  ReviewNamespace,
  SessionNamespace,
  SkillNamespace,
  SubagentNamespace,
  SubjectTelemetryNamespace,
  ToastNamespace,
  ToolNamespace,
  VariantNamespace,
  VCSNamespace,
  VCSEventsNamespace,
  VCSPRNamespace,
  VisionNamespace,
  VoiceNamespace,
  WorkflowNamespace,
  WorkflowBlocksNamespace,
  WorkerNodeNamespace,
] as RegistrableBusNamespaceDefinition[];

/**
 * Framework storage namespace definitions from contracts.
 *
 * Registered separately by runtime storage initialization, alongside
 * `FrameworkContractNamespaces`. These definitions carry typed subject tokens
 * and Zod schemas for explicit composition-root registration.
 */
export const FrameworkStorageNamespaces: readonly RegistrableBusNamespaceDefinition[] = [
  MessageStorageNamespace,
  SessionEventStorageNamespace,
  SessionStorageNamespace,
  SkillStorageNamespace,
] as RegistrableBusNamespaceDefinition[];
