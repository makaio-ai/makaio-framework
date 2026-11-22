import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { SubjectDirectoryListRequestSchema, SubjectDirectoryListResponseSchema } from './schemas.js';

/**
 * Bus schemas of the subject directory.
 *
 * The directory is the sum of the subject declarations of the active extensions. It is read-only.
 */
export const SubjectDirectorySchemas = {
  list: { request: SubjectDirectoryListRequestSchema, response: SubjectDirectoryListResponseSchema },
} satisfies SchemaRecord;

/** Subject directory bus namespace, domain `makaio:subjects`. */
export const SubjectDirectoryNamespace = createBusNamespace('makaio:subjects', SubjectDirectorySchemas);

/** Typed subjects of the subject directory, for `bus.request()` and `bus.on()`. */
export const SubjectDirectorySubjects = SubjectDirectoryNamespace.subjects;
