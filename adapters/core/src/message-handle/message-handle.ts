import { DeferredPromise } from '@makaio/utils';
import type {
  CacheStrategy,
  JsonValue,
  Message,
  MessageDeliveryMode,
  ResponseSchemaDescriptor,
  RequestCorrelationContext,
} from '@makaio/contracts';
import type { MessageResult, MessageState } from './types.js';
import type { NormalizedMessageInput } from '../utils/normalizeMessageInput.js';

type CompletionTransform = (result: MessageResult) => MessageResult | Promise<MessageResult>;
type CompletionObserver = (result: MessageResult) => void;
type CompletionNotification = (handle: MessageHandle, result: MessageResult) => void | Promise<void>;

export class MessageHandle {
  protected readonly deferredCompletion: DeferredPromise<MessageResult>;
  protected readonly deferredAcknowledgement: DeferredPromise<boolean>;
  public state: MessageState;
  private isAcknowledged: boolean | undefined = undefined;
  private completionResult: MessageResult | undefined = undefined;
  private completionStarted = false;
  private readonly completionTransforms: CompletionTransform[] = [];
  private readonly completionObservers: CompletionObserver[] = [];

  /** If this message was merged into another, the winner's messageId */
  public mergedInto?: string;
  /** If this is the merge winner, messageIds that were folded in */
  public mergedFrom?: string[];
  /** If this message was superseded by replace/immediate, the replacer's messageId */
  public supersededBy?: string;
  /** Adapter session ID - resolved when processing starts */
  private readonly deferredAdapterSessionId = new DeferredPromise<string>();
  private _adapterSessionId?: string;

  /** Curated message history from sessionContext (mutable for merge propagation) */
  private _messageHistory?: Message[];

  /** Shared cache strategy type from contracts keeps handle options and session context aligned. */
  private _cacheStrategy?: CacheStrategy;

  /** Turn-scoped context from PreUserMessage hooks (mutable for merge propagation) */
  private _turnContext?: Record<string, JsonValue>;

  public constructor(
    public readonly messageId: string,
    public readonly message: NormalizedMessageInput,
    public readonly deliveryMode: MessageDeliveryMode,
    /** Curated message history from sessionContext */
    messageHistory?: Message[],
    /** Turn-scoped context from PreUserMessage hooks */
    turnContext?: Record<string, JsonValue>,
    /**
     * Per-turn structured-output schema descriptor.
     * When present, the agent validates the terminal message against this
     * schema before resolving completion and emitting terminal events.
     */
    public readonly responseSchema?: ResponseSchemaDescriptor,
    /**
     * Internal structured-output retry turns must stay hidden from user-message
     * lifecycle events while still taking precedence over queued user turns.
     */
    public readonly internalRetry = false,
    /** Caller-expressed caching intent for the injected history prefix */
    cacheStrategy?: CacheStrategy,
    /** Content-free transport correlation for provider requests. */
    public readonly requestCorrelation?: RequestCorrelationContext,
  ) {
    this.deferredCompletion = new DeferredPromise<MessageResult>();
    this.deferredAcknowledgement = new DeferredPromise<boolean>();
    this.state = 'queued';
    this._messageHistory = messageHistory;
    this._cacheStrategy = cacheStrategy;
    this._turnContext = turnContext;
  }

  /**
   * Curated message history from sessionContext
   * @returns The message history array or undefined if not set
   */
  public get messageHistory(): Message[] | undefined {
    return this._messageHistory;
  }

  /** Set messageHistory (used by merge strategies to propagate history) */
  public set messageHistory(value: Message[] | undefined) {
    this._messageHistory = value;
  }

  /**
   * Caller-expressed caching intent for the injected history prefix
   * @returns The cache strategy or undefined if not set
   */
  public get cacheStrategy(): CacheStrategy | undefined {
    return this._cacheStrategy;
  }

  /** Set cacheStrategy (used by merge strategies to propagate) */
  public set cacheStrategy(value: CacheStrategy | undefined) {
    this._cacheStrategy = value;
  }

  /**
   * Turn-scoped context from PreUserMessage hooks
   * @returns The turn context record or undefined if not set
   */
  public get turnContext(): Record<string, JsonValue> | undefined {
    return this._turnContext;
  }

  /** Set turnContext (used by merge strategies to propagate context) */
  public set turnContext(value: Record<string, JsonValue> | undefined) {
    this._turnContext = value;
  }

  /**
   * Get adapter session ID synchronously (undefined if not yet set)
   * @returns The adapter session ID or undefined if not yet set
   */
  public get adapterSessionId(): string | undefined {
    return this._adapterSessionId;
  }

  /**
   * Set adapter session ID (called by connector when processing starts)
   */
  public set adapterSessionId(value: string | undefined) {
    if (value && !this._adapterSessionId) {
      this._adapterSessionId = value;
      this.deferredAdapterSessionId.resolve(value);
    }
  }

  /**
   * Wait for adapter session ID to be set
   * @returns Promise resolving to session ID when processing starts
   */
  public waitForAdapterSessionId(): Promise<string> {
    if (this._adapterSessionId) return Promise.resolve(this._adapterSessionId);
    return this.deferredAdapterSessionId.getPromise();
  }

  /**
   * Whether the message was successfully delivered to the provider.
   *
   * Returns `true` only when {@link markAcknowledged} was called with
   * `delivered = true` (the default). Handles that were completed before
   * dispatch (merged, superseded, rejected) auto-resolve acknowledgment
   * with `false`, so this getter returns `false` for them.
   *
   * Used by {@link MessageLifecycleTracker} to decide whether
   * `agent.turn.completed` should pair with an earlier `agent.turn.started`.
   * @returns `true` when the handle was acknowledged as delivered
   */
  public get wasDelivered(): boolean {
    return this.isAcknowledged === true;
  }

  public get isProcessed(): boolean {
    return this.state === 'completed' || this.state === 'cancelled';
  }

  public getState(): MessageState {
    return this.state;
  }

  /**
   * Update message state
   * @param state - New message state
   */
  public updateState(state: MessageState): void {
    this.state = state;
  }

  /**
   * Cancel a pending message
   * @returns True if cancelled, false if already submitted/completed
   */
  public async cancel(): Promise<boolean> {
    this.updateState('cancelled');
    this.completionStarted = true;
    this.completionResult = { outcome: 'cancelled' };

    this.deferredAcknowledgement.reject(new Error('Message cancelled'));
    this.deferredCompletion.resolve(this.completionResult);

    return true;
  }

  /**
   * Mark message as acknowledged
   * @param delivered - Whether message was successfully delivered to provider
   * (e.g. false if immediate message arrived too late)
   */
  public markAcknowledged(delivered = true): void {
    if (this.isAcknowledged === undefined) {
      this.isAcknowledged = delivered;
      this.updateState('acknowledged');
      this.deferredAcknowledgement.resolve(delivered);
    }
  }

  /**
   * Register a transform that canonicalizes the terminal result before
   * {@link waitForCompletion} resolves.
   * @param transform - Transform applied to the raw provider completion result
   */
  public addCompletionTransform(transform: CompletionTransform): void {
    if (this.completionStarted) {
      throw new Error('Cannot add a completion transform after completion has started');
    }
    this.completionTransforms.push(transform);
  }

  /**
   * Register an observer that runs after all completion transforms have
   * produced the canonical terminal result, but before completion resolves.
   * @param observer - Observer called with the final completion result
   */
  public addCompletionObserver(observer: CompletionObserver): void {
    if (this.completionStarted) {
      throw new Error('Cannot add a completion observer after completion has started');
    }
    this.completionObservers.push(observer);
  }

  /**
   * Mark message turn as completed
   * @param result - The result message or null if no result available
   */
  public markCompleted(result: MessageResult): void {
    if (!this.completionStarted) {
      this.completionStarted = true;
      this.updateState('completed');

      // Also resolve acknowledgment promise if not yet resolved (e.g., for superseded/cancelled messages)
      // This prevents orphaned acknowledgment timeouts from firing after completion
      if (this.isAcknowledged === undefined) {
        this.isAcknowledged = false;
        this.deferredAcknowledgement.resolve(false);
      }

      void this.resolveCompletion(result);
    } else {
      console.warn(`markCompleted called for messageId: ${this.messageId} but already completed.`);
    }
  }

  /**
   * Apply registered completion transforms and publish the canonical result.
   * @param result - Raw provider completion result
   */
  private async resolveCompletion(result: MessageResult): Promise<void> {
    let finalResult = result;
    try {
      for (const transform of this.completionTransforms) {
        finalResult = await transform(finalResult);
      }
    } catch (error) {
      finalResult = {
        outcome: 'error',
        error: error instanceof Error ? error : String(error),
      };
    }
    this.completionResult = finalResult;
    this.notifyCompletionObservers(finalResult);
    this.deferredCompletion.resolve(finalResult);
  }

  /**
   * Notify registered completion observers without changing terminal outcome.
   * @param result - Canonical completion result
   */
  private notifyCompletionObservers(result: MessageResult): void {
    for (const observer of this.completionObservers) {
      try {
        observer(result);
      } catch (error) {
        console.warn(`[MessageHandle] completion observer failed for messageId: ${this.messageId}`, error);
      }
    }
  }

  public async waitForAcknowledgment(timeoutMs?: number) {
    if (this.isAcknowledged !== undefined) return this.isAcknowledged;

    if (timeoutMs) {
      const race = Promise.race([
        this.deferredAcknowledgement.getPromise(),
        new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('Acknowledgment timeout')), timeoutMs)),
      ]);
      const result = await race;
      if (result instanceof Error) {
        this.markCompleted({ outcome: 'error', error: result });
        throw result;
      }
      return result;
    }

    return this.deferredAcknowledgement.getPromise();
  }

  public async waitForCompletion(timeoutMs?: number) {
    if (this.completionResult) return this.completionResult;

    if (timeoutMs) {
      const race = await Promise.race([
        this.deferredCompletion.getPromise(),
        new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('Completion timeout')), timeoutMs)),
      ]);

      if (race instanceof Error) throw race;

      return race;
    }
    return this.deferredCompletion.getPromise();
  }
}

/**
 * Complete a handle while notifying a callback with the transformed final result.
 *
 * `markCompleted()` starts async completion transforms before resolving
 * waiters. Connector/session layers that cache `lastResult` must observe the
 * final transformed value, not the raw provider result they pass into
 * `markCompleted()`.
 * @param handle - Message handle being completed
 * @param result - Raw provider completion result
 * @param onComplete - Optional notification callback receiving the final result
 * @returns Promise that settles after the final-result callback completes
 */
export function markCompletedWithFinalResult(
  handle: MessageHandle,
  result: MessageResult,
  onComplete?: CompletionNotification,
): Promise<void> {
  const shouldNotify = onComplete !== undefined && !handle.isProcessed;
  handle.markCompleted(result);
  if (!shouldNotify) return Promise.resolve();
  return handle.waitForCompletion().then(async (finalResult) => {
    try {
      await onComplete(handle, finalResult);
    } catch (error: unknown) {
      console.warn(`[MessageHandle] completion notification failed for messageId: ${handle.messageId}`, error);
    }
  });
}
