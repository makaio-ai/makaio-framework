import { z } from 'zod';
import { createContractStorageNamespace } from '../storage-namespace-definition.js';
import { SkillRecordInputSchema, SkillRecordSchema, SkillQuerySchema, type SkillRecordInput } from './schemas.js';

/**
 * Storage namespace for database-backed skills.
 *
 * Discovery remains internal to the platform skill service. These subjects only
 * expose persistence for explicit database-backed records.
 */
export const SkillStorageNamespace = createContractStorageNamespace('skill', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ skill: SkillRecordSchema.nullable() }),
    },
    set: {
      request: z.object({ skill: SkillRecordInputSchema }),
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
    list: {
      request: SkillQuerySchema,
      response: z.object({ skills: z.array(SkillRecordSchema) }),
    },
    getEffective: {
      request: SkillQuerySchema,
      response: z.object({ skills: z.array(SkillRecordSchema) }),
    },
  },
});

/** Typed bus subjects for `storage:skill.*`. */
export const SkillStorageSubjects = SkillStorageNamespace.subjects;

/**
 * Validate scope invariants for a database-backed skill.
 *
 * Invariants:
 * - `global`: no `projectId`, no `sessionId`
 * - `project`: requires `projectId`, no `sessionId`
 * - `session`: requires `sessionId`, `projectId` optional for context
 * @param skill - Skill input about to be persisted
 * @throws Error when the scope fields do not match the declared scope
 */
export function validateSkillScope(skill: SkillRecordInput): void {
  if (skill.scope === 'global') {
    if (skill.projectId || skill.sessionId) {
      throw new Error('Global scope skills must not have projectId or sessionId');
    }
    return;
  }

  if (skill.scope === 'project') {
    if (!skill.projectId) {
      throw new Error('Project scope skills require projectId');
    }
    if (skill.sessionId) {
      throw new Error('Project scope skills must not have sessionId');
    }
    return;
  }

  if (!skill.sessionId) {
    throw new Error('Session scope skills require sessionId');
  }
}
