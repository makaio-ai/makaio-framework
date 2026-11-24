/** Machine-readable code of {@link HostOnlyRightsError}. */
export const HOST_ONLY_RIGHTS_ERROR_CODE = 'host-only-rights';

/**
 * Thrown by every method of the rights capability a composition that runs
 * outside the host process gives its extensions (or the workflow worker's
 * own worker-local toolset context, which has no extension coordinator at
 * all): rights resolve only in the host process, so there is no hub there
 * to ask, grant, or deny through.
 *
 * Named and coded like {@link AccessDeniedError} so a caller recognizes the
 * refusal by `instanceof`/`code`, never by matching the message text.
 */
export class HostOnlyRightsError extends Error {
  /** Machine-readable code of the error. */
  public readonly code = HOST_ONLY_RIGHTS_ERROR_CODE;

  /**
   * @param message - Human-readable description; defaults to naming the host-process rule.
   */
  public constructor(message = 'Rights resolve only in the host process.') {
    super(message);
    this.name = 'HostOnlyRightsError';
  }
}
