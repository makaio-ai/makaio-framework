import type { EdgeName } from '../journal/identifiers.js';

/**
 * Names the part of an HTTP request that carries a second credential.
 */
export interface HttpSecondPresentation {
  /** Name of the part of the request, chosen by the mount, that carries the second credential. */
  readonly part: string;
}

/**
 * An HTTP mount of an extension: a prefix with exactly one handling at the
 * boundary. The host builds a separate sub-application for each entry, puts the
 * boundary check in front of it and mounts it under the prefix; `mount`
 * receives that sub-application and can mount nothing outside the prefix.
 *
 * An entry with `edge` is the route of an inbound edge and does not ask the
 * verifier chain. Setting `edge` and `secondPresentation` on the same entry is
 * an activation error, as are a prefix the host already uses and an `edge`
 * that names no edge of the extension.
 */
export interface HttpMountContribution {
  /** Prefix under which the host mounts the sub-application. */
  readonly prefix: string;
  /**
   * Mounts the routes of the entry on its own sub-application.
   * @param app - The sub-application of this entry.
   */
  mount(app: unknown): void;
  /**
   * The mount receives deliveries of this edge. The host does not ask the
   * verifier chain; the edge checks authenticity itself.
   */
  readonly edge?: EdgeName;
  /**
   * The mount accepts a second credential in the named part of the request,
   * next to the caller's credential. The handler sees the verified result as
   * its second party.
   */
  readonly secondPresentation?: HttpSecondPresentation;
}
