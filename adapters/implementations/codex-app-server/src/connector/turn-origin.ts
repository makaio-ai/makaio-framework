/**
 * Origin decision for the Codex App-Server connector.
 *
 * Provider notifications and server requests identify their turn by a provider turn id, while the
 * connector tracks operations by message handle. {@link TurnOrigin} maps one to the other and
 * fixes the emitter of a callback to the outcome of that lookup.
 * @packageDocumentation
 */

import type { Forbid, ForbiddenKeys, MessageHandle } from '@makaio/ai-adapters-core';
import type { EmitSubject } from '@makaio/bus-core';
import type { SystemPrompt } from '@makaio/contracts';
import type { ScopedSubjectDefinition } from '@makaio/core';
import type { CodexAppServerBus } from '../namespaces/index.js';
import type { CodexCallEmit, CodexTurnEmit } from './turn-flow-handlers.js';
import type { ApprovalPolicy, CodexAppServerConfig, ReasoningEffort, SandboxMode } from './types.js';

/** Turn settings of a connector: the provider config wins over the top-level config fields. */
export interface CodexTurnSettings {
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly sandboxMode: SandboxMode | undefined;
  readonly reasoningEffort: ReasoningEffort | undefined;
}

/**
 * Resolve the approval policy, sandbox mode and reasoning effort of a connector config.
 * @param config - Connector configuration, possibly carrying the same settings in `providerConfig`
 * @returns The effective settings
 */
export function resolveCodexTurnSettings(config: CodexAppServerConfig): CodexTurnSettings {
  const fullConfig = config as CodexAppServerConfig & {
    providerConfig?: { approvalPolicy?: string; sandboxMode?: string; reasoningEffort?: string };
  };
  return {
    approvalPolicy: (fullConfig.providerConfig?.approvalPolicy as ApprovalPolicy) ?? fullConfig.approvalPolicy,
    sandboxMode: (fullConfig.providerConfig?.sandboxMode as SandboxMode) ?? fullConfig.sandboxMode,
    reasoningEffort: (fullConfig.providerConfig?.reasoningEffort as ReasoningEffort) ?? fullConfig.reasoningEffort,
  };
}

/**
 * Reduce a system prompt to the text the provider receives.
 * @param prompt - System prompt as captured from the start options
 * @returns The prompt text, or `null` when no prompt was set
 */
export function resolveSystemPromptText(prompt: SystemPrompt | undefined): string | null {
  if (prompt === undefined) return null;
  return typeof prompt === 'string' ? prompt : prompt.content;
}

/** The emitters the turn flow receives. */
export interface TurnFlowEmitters {
  /** Emits under the call passed first. */
  readonly emit: CodexCallEmit;
  /** Emits with the observer context. */
  readonly emitObserved: CodexTurnEmit;
}

/**
 * Decides which operation a provider callback belongs to and binds the callback's emitter to that decision.
 *
 * The association between a provider turn id and a message handle is published synchronously at the
 * `turn/started` ingress and pairs the id with the handle pending at that moment. A lookup only returns
 * that handle while it is still the pending one, so a provider id is never combined with a newer pending
 * handle and a completed, replaced or cleared handle is never attributed, whichever code path changed
 * the slot.
 */
export class TurnOrigin {
  private association: { readonly providerTurnId: string; readonly handle: MessageHandle } | undefined;

  /**
   * Create the origin decision bound to the connector's pending-handle slot and emitters.
   * @param getPending - Reads the handle currently pending turn completion
   * @param emitForCall - Emitter that sends under the call passed to it
   * @param emitObserved - Emitter that sends with the observer context
   */
  public constructor(
    private readonly getPending: () => MessageHandle | undefined,
    private readonly emitForCall: CodexCallEmit,
    private readonly emitObserved: CodexTurnEmit,
  ) {}

  /**
   * The emitters the turn flow receives.
   * @returns The call-first emitter and the observing emitter
   */
  public get emitters(): TurnFlowEmitters {
    return { emit: this.emitForCall, emitObserved: this.emitObserved };
  }

  /** The origin hooks the notification handlers use to decide an operation at their ingress. */
  public readonly notificationHooks = {
    publishTurnAssociation: (providerTurnId: string): void => this.publish(providerTurnId),
    handleForTurn: (turnId: string): MessageHandle | undefined => this.handleFor(turnId),
    bindEmit: (turnId: string | undefined): CodexTurnEmit => this.bindEmit(this.handleFor(turnId)),
  };

  /**
   * Associate a provider turn id with the handle pending right now.
   * @param providerTurnId - Turn id the provider announced in `turn/started`
   */
  public publish(providerTurnId: string): void {
    const handle = this.getPending();
    this.association = handle === undefined ? undefined : { providerTurnId, handle };
  }

  /**
   * Resolve the handle a notification or request belongs to. Read synchronously at callback ingress.
   * @param turnId - Provider turn id the callback carries, or `undefined` when it carries none: the
   * most recent started, not yet completed turn then counts
   * @returns The still-pending handle of that turn, or `undefined` when no live operation is attributable
   */
  public handleFor(turnId: string | undefined): MessageHandle | undefined {
    const association = this.association;
    if (association === undefined || association.handle !== this.getPending()) return undefined;
    return turnId === undefined || turnId === association.providerTurnId ? association.handle : undefined;
  }

  /**
   * Bind an emitter to one lookup outcome.
   * @param handle - Handle resolved at callback ingress, or `undefined` when none is attributable
   * @returns Emitter forwarding the handle's call, or observing when there is no handle
   */
  public bindEmit(handle: MessageHandle | undefined): CodexTurnEmit {
    const { emitForCall, emitObserved } = this;
    return <S extends ScopedSubjectDefinition<CodexAppServerBus['namespace']>>(
      subject: EmitSubject<S>,
      payload: Forbid<S['$meta']['payload'], ForbiddenKeys>,
    ) => (handle !== undefined ? emitForCall<S>(handle.call, subject, payload) : emitObserved<S>(subject, payload));
  }
}
