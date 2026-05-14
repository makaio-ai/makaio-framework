import { createBusNamespace } from '@makaio/core';
import { ApprovalSchemas } from './schemas.js';

/** Bus namespace definition for approval request/response subjects. */
export const ApprovalNamespace = createBusNamespace('approval', ApprovalSchemas);

/** Typed bus subjects for the approval namespace. */
export const ApprovalSubjects = ApprovalNamespace.subjects;
