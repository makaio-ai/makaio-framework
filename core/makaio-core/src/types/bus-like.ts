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
 * Minimal structural bus seam for contracts-owned helpers.
 *
 * This deliberately does not re-model `@makaio/bus-core`'s generic overloads.
 * Bus-core owns the full magic inference surface; this type only covers the
 * event/request calls that contract helper APIs make without importing bus-core.
 */
export interface MakaioBusLike {
  /** Emit an event. */
  emit<Subject extends EventSubjectLike>(subject: Subject, payload: Subject['$meta']['payload']): Promise<void>;

  /** Send a request and await a response. */
  request<Subject extends RequestSubjectLike>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
  ): Promise<Subject['$meta']['payload']['response']>;
}
