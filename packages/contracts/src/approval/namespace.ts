import { MakaioBus } from '@makaio/bus-core';
import { ApprovalSchemas } from './schemas.js';

/** Registered bus namespace for approval request/response subjects. */
export const ApprovalNamespace = MakaioBus.registerNamespace('approval', ApprovalSchemas);

/** Typed bus subjects for the approval namespace. */
export const ApprovalSubjects = ApprovalNamespace.subjects;
