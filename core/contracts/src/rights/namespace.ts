import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { RightAnswerSchema } from './right.js';
import {
  RightsChangedSchema,
  RightsListRequestSchema,
  RightsListResponseSchema,
  RightsResolveRequestSchema,
} from './schemas.js';

/**
 * Bus schemas of the rights.
 *
 * - `resolve` answers whether the caller holds one right in one context; the core sets the call context.
 * - `list` lists the declared rights, read-only.
 * - `changed` announces that rights or their answer sources changed; the core is the only sender.
 */
export const RightsSchemas = {
  resolve: { request: RightsResolveRequestSchema, response: RightAnswerSchema },
  list: { request: RightsListRequestSchema, response: RightsListResponseSchema },
  changed: RightsChangedSchema,
} satisfies SchemaRecord;

/** Rights bus namespace, domain `makaio:rights`. */
export const RightsNamespace = createBusNamespace('makaio:rights', RightsSchemas);

/** Typed subjects of the rights, for `bus.request()` and `bus.on()`. */
export const RightsSubjects = RightsNamespace.subjects;
