import { createBusNamespace } from '@makaio/core';
import { SkillSchemas } from './schemas.js';

/** Bus namespace definition for `skill.*` lifecycle RPCs and events. */
export const SkillNamespace = createBusNamespace('skill', SkillSchemas);

/** Typed bus subjects for `skill.*`. */
export const SkillSubjects = SkillNamespace.subjects;
