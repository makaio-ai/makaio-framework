import { MakaioBus } from '@makaio/bus-core';
import { SkillSchemas } from './schemas.js';

/** Registered Makaio bus namespace for `skill.*` lifecycle RPCs and events. */
export const SkillNamespace = MakaioBus.registerNamespace('skill', SkillSchemas);

/** Typed bus subjects for `skill.*`. */
export const SkillSubjects = SkillNamespace.subjects;
