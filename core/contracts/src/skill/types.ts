import type { SkillActivationTrigger, SkillDeactivationReason } from './schemas.js';

export type {
  ActiveSkillState,
  ActivatedSkillMetadata,
  SkillActivateRequest,
  SkillActivateResponse,
  SkillActivationMode,
  SkillActivationTrigger,
  SkillCatalogEntry,
  SkillCatalogTurnEntry,
  SkillDeactivationReason,
  SkillFrontmatter,
  SkillGetActiveSkillsRequest,
  SkillGetActiveSkillsResponse,
  SkillGetCatalogRequest,
  SkillGetCatalogResponse,
  SkillQuery,
  SkillRecord,
  SkillRecordInput,
  SkillReinjection,
  SkillRuntimePolicy,
  SkillScope,
  SkillSource,
  SkillTurnEntry,
} from './schemas.js';

declare module '@makaio/contracts' {
  interface SessionEventTypeMap {
    /** Skill catalog built for a session agent. */
    'skill.catalog.built': {
      agentId: string;
      cwd: string;
      adapterId?: string;
      skillNames: string[];
    };
    /** Skill activated for a session agent. */
    'skill.activated': {
      agentId: string;
      skillName: string;
      trigger: SkillActivationTrigger;
      turnNumber?: number;
    };
    /** Skill deactivated for a session agent. */
    'skill.deactivated': {
      agentId: string;
      skillName: string;
      reason: SkillDeactivationReason;
    };
  }
}
