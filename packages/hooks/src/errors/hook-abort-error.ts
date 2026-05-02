/**
 * Thrown by hooks to abort message processing.
 *
 * This error propagates through AIAgent to the session layer,
 * which emits user_message.completed with outcome 'cancelled'.
 */
export class HookAbortError extends Error {
  public readonly code = 'HOOK_ABORT';

  public constructor(
    public readonly hookName: string,
    public readonly reason?: string,
  ) {
    super(`Message aborted by hook: ${hookName}${reason ? ` - ${reason}` : ''}`);
    this.name = 'HookAbortError';
  }
}
