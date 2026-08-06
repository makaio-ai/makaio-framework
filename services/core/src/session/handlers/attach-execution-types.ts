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
import type { AttachLaunchTarget } from './attach-runtime-options.js';
import type { OwnedAdapterInstance } from '../utils/resolution.js';

/** Identity metadata carried onto the agent row an attach owns. */
export interface AttachIdentity {
  adapterName: string;
  sessionId: string;
  role: AgentRole;
  personaId?: string;
  profileId?: string;
  harnessId?: string;
  providerConfigId?: string;
  compressionMode?: CompressionMode;
  model?: string;
  cwd?: string;
}

/**
 * The **structural** locality verdict for a resume attach.
 *
 * Structural only: it says what the session rows and the adapter's declared
 * capability allow. Whether the provider session is actually free is the
 * reservation's answer, and it can turn a `native` verdict here into a degrade.
 */
export interface AttachLocalityResult {
  /** Adapter session ID for a structurally native resume, or `undefined`. */
  readonly resumeAdapterSessionId: string | undefined;
  /** Session context carrying the verdict, present only for a non-native one. */
  readonly attachSessionContext: SessionContext | undefined;
}

/** Fully resolved inputs for starting and optionally dispatching an attach turn. */
export interface ResolvedAttachExecution {
  launch: AttachLaunchTarget;
  identity: AttachIdentity;
  locality: AttachLocalityResult;
  /** Lead the caller observed on the session row, or `null` when it names none. */
  expectedLeadAgentId: string | null;
  /**
   * Instance the attach dispatches to, and the machine every one of its ownership
   * acts names — one value, because it is one key.
   *
   * `machineId` is absent only when this runtime named no machine of its own and
   * the caller named none either, in which case the authority acts under its
   * composed identity and there are no two identities to mix.
   */
  instance: OwnedAdapterInstance;
  session: IMakaioSession;
  initialMessage: MessageInput | undefined;
  responseSchema: ResponseSchemaDescriptor | undefined;
  initiator: TurnInitiator;
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
