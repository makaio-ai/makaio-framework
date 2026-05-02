import { DeferredPromise } from '@makaio/utils';
import type { JsonValue, Message, MessageDeliveryMode } from '@makaio/contracts';
import type { MessageResult, MessageState } from './types.js';
import type { NormalizedMessageInput } from '../utils/normalizeMessageInput.js';

export class MessageHandle {
  protected readonly deferredCompletion: DeferredPromise<MessageResult>;
  protected readonly deferredAcknowledgement: DeferredPromise<boolean>;
  public state: MessageState;
  private isAcknowledged: boolean | undefined = undefined;
  private completionResult: MessageResult | undefined = undefined;

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
  ) {
    this.deferredCompletion = new DeferredPromise<MessageResult>();
    this.deferredAcknowledgement = new DeferredPromise<boolean>();
    this.state = 'queued';
    this._messageHistory = messageHistory;
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

    this.deferredAcknowledgement.reject(new Error('Message cancelled'));
    this.deferredCompletion.resolve({
      outcome: 'cancelled',
    });

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
   * Mark message turn as completed
   * @param result - The result message or null if no result available
   */
  public markCompleted(result: MessageResult): void {
    if (this.completionResult === undefined) {
      this.updateState('completed');
      this.completionResult = result;
      this.deferredCompletion.resolve(result);

      // Also resolve acknowledgment promise if not yet resolved (e.g., for superseded/cancelled messages)
      // This prevents orphaned acknowledgment timeouts from firing after completion
      if (this.isAcknowledged === undefined) {
        this.isAcknowledged = false;
        this.deferredAcknowledgement.resolve(false);
      }
    } else {
      console.warn(`markCompleted called for messageId: ${this.messageId} but already completed.`);
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
