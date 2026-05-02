import { BusError } from './bus-error.js';

/**
 * Thrown when a remote peer attempts to invoke a local-only subject over a
 * transport. Local subjects are never serializable and must not be routed
 * across process or network boundaries.
 */
export class LocalSubjectError extends BusError {
  /**
   * @param subject - The local-only subject that was invoked remotely
   */
  public constructor(subject: string) {
    super(
      `Subject "${subject}" is local-only and cannot be invoked over a transport. ` +
        `Register a non-local handler on each node that needs to respond to this subject.`,
      subject,
    );
    this.name = 'LocalSubjectError';
  }
}
