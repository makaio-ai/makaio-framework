import type {
  AgentRole,
  AgentSelectionBase,
  CompressionMode,
  IMakaioSession,
  MessageInput,
  ProviderContext,
  ResponseSchemaDescriptor,
  SessionContext,
  TurnInitiator,
} from '@makaio/contracts';
import type { LaunchAttachAgentInput } from './attach-runtime-options.js';

/** Identity metadata persisted after an attach agent starts. */
export interface AttachIdentity {
  adapterName: string;
  sessionId: string;
  role: AgentRole;
  timestamp: number;
  personaId?: string;
  profileId?: string;
  harnessId?: string;
  providerConfigId?: string;
  compressionMode?: CompressionMode;
  model?: string;
  cwd?: string;
}

/** Fully resolved inputs for starting and optionally dispatching an attach turn. */
export interface ResolvedAttachExecution {
  launch: LaunchAttachAgentInput;
  identity: AttachIdentity;
  session: IMakaioSession;
  initialMessage: MessageInput | undefined;
  responseSchema: ResponseSchemaDescriptor | undefined;
  initiator: TurnInitiator;
  sessionContext: SessionContext | undefined;
  assertAttachCommitAllowed: () => void;
  assertInitialMessageAdmission: (() => void) | undefined;
}

/** Inputs accepted by the shared public and trusted-local attach implementation. */
export interface AttachAgentParams {
  readonly sessionId: string;
  readonly agent: AgentSelectionBase;
  readonly initialMessage?: MessageInput;
  readonly responseSchema?: ResponseSchemaDescriptor;
  readonly source?: 'extension' | 'user' | 'system';
  readonly extensionId?: string;
  readonly assertAttachCommitAllowed?: () => void;
  readonly assertInitialMessageAdmission?: () => void;
  readonly role?: AgentRole;
  readonly harnessId?: string;
  readonly resolvedProviderContext?: ProviderContext;
}
