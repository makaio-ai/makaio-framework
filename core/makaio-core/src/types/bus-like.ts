import type { RequestMessagePayload } from './message.js';
import type { SubjectDefinition } from './subjects.js';

type EventSubjectLike = SubjectDefinition & {
  readonly $meta: {
    readonly isRequest: false;
    readonly channel: false;
  };
};

type RequestSubjectLike = SubjectDefinition & {
  readonly $meta: {
    readonly isRequest: true;
    readonly channel: false;
    readonly payload: RequestMessagePayload;
  };
};

/**
 * Emit options a contracts-owned helper can express through {@link MakaioBusLike}.
 *
 * Only routing is modelled. A helper that hands a live object to a subject has
 * to be able to say "this does not leave the process" — the full bus option bag
 * (message ids, correlation ids) belongs to callers, not to a contract helper.
 *
 * Transport names are spelled as bare registry keys rather than as the bus
 * transport registry's own key union, which lives in `@makaio/bus-core` and
 * must not become a dependency of this layer. Both the list and the set form
 * are admitted because a bus implementation must stay assignable to this seam,
 * and the only value the seam itself needs to express is the empty list, which
 * every bus implementation reads as local-only.
 */
export interface BusLikeEmitOptions {
  /**
   * Transports to relay the event to.
   *
   * An empty list suppresses transport dispatch entirely; omitting the option
   * relays the event to every ready transport.
   */
  readonly transports?: ReadonlySet<string | number> | readonly (string | number)[];
}

/**
 * Minimal structural bus seam for contracts-owned helpers.
 *
 * This deliberately does not re-model `@makaio/bus-core`'s generic overloads.
 * Bus-core owns the full magic inference surface; this type only covers the
 * event/request calls that contract helper APIs make without importing bus-core.
 */
export interface MakaioBusLike {
  /** Emit an event. */
  emit<Subject extends EventSubjectLike>(
    subject: Subject,
    payload: Subject['$meta']['payload'],
    options?: BusLikeEmitOptions,
  ): Promise<void>;

  /** Send a request and await a response. */
  request<Subject extends RequestSubjectLike>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
  ): Promise<Subject['$meta']['payload']['response']>;
}
