import { eq } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { ApprovalPolicySchema, ToolCapabilitySchema, HarnessSubjects } from '@makaio/contracts';
import { z } from 'zod';
import { createDrizzleCrudHandlers, createDrizzleListHandler } from '@makaio/storage-handlers';
import { HarnessStorageSubjects, type HarnessInput, type Harness, type HarnessListQuery } from './namespace.js';
import { harnessStorageSchema } from './schema.variants.js';

/** Type alias for the harness definitions table, used to type local variables. */
type HarnessDefinitionsTable = typeof harnessStorageSchema.sqlite.harnessDefinitions;
type DbRow = HarnessDefinitionsTable['$inferSelect'];

/**
 * Maps database row to Harness API type.
 * @param row - Database row from harness_definitions table
 * @returns Mapped Harness object
 */
function mapHarness(row: DbRow): Harness {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    adapterName: row.adapterName ?? undefined,
    clientId: row.clientId ?? undefined,
    env: row.env ?? undefined,
    credentials: row.credentials ?? undefined,
    cwd: row.cwd ?? undefined,
    approvalPolicy: ApprovalPolicySchema.parse(row.approvalPolicy),
    nativeTools: {
      enabled: row.nativeToolsEnabled,
      disabled: row.nativeToolsDisabled,
    },
    registryTools: {
      enabled: row.registryToolsEnabled,
      disabled: row.registryToolsDisabled,
    },
    skills:
      row.skillsEnabled || row.skillsDisabled
        ? {
            enabled: row.skillsEnabled ?? [],
            disabled: row.skillsDisabled ?? [],
          }
        : undefined,
    toolCapabilityMap: row.toolCapabilityMap
      ? z.record(z.string(), z.array(ToolCapabilitySchema)).parse(row.toolCapabilityMap)
      : undefined,
    capabilityOverrides: row.capabilityOverrides
      ? z.record(z.string(), ApprovalPolicySchema).parse(row.capabilityOverrides)
      : undefined,
    toolApprovalOverrides: row.toolApprovalOverrides
      ? z.record(z.string(), ApprovalPolicySchema).parse(row.toolApprovalOverrides)
      : undefined,
    isDefault: row.isDefault,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Maps HarnessInput to database values.
 * @param harness - Harness input from API
 * @returns Database values for insert/update
 */
function toDbValues(harness: HarnessInput): Partial<DbRow> {
  return {
    id: harness.id,
    name: harness.name,
    description: harness.description ?? null,
    adapterName: harness.adapterName ?? null,
    clientId: harness.clientId ?? null,
    env: harness.env ?? null,
    credentials: harness.credentials ?? null,
    cwd: harness.cwd ?? null,
    approvalPolicy: harness.approvalPolicy,
    nativeToolsEnabled: harness.nativeTools.enabled,
    nativeToolsDisabled: harness.nativeTools.disabled,
    registryToolsEnabled: harness.registryTools.enabled,
    registryToolsDisabled: harness.registryTools.disabled,
    skillsEnabled: harness.skills?.enabled ?? null,
    skillsDisabled: harness.skills?.disabled ?? null,
    toolCapabilityMap: harness.toolCapabilityMap ?? null,
    capabilityOverrides: harness.capabilityOverrides ?? null,
    toolApprovalOverrides: harness.toolApprovalOverrides ?? null,
    isDefault: harness.isDefault,
    enabled: harness.enabled,
  };
}

/**
 * Registers all Drizzle-based harness storage handlers with the bus.
 * @param bus - MakaioBus instance for message handling
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleHarnessStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { harnessDefinitions } = resolveSchema(db, harnessStorageSchema);

  const registerCrud = createDrizzleCrudHandlers({
    table: harnessDefinitions,
    subjects: {
      get: HarnessStorageSubjects.get,
      set: HarnessStorageSubjects.set,
      delete: HarnessStorageSubjects.delete,
    },
    idField: 'id',
    singularKey: 'harness',
    mapper: mapHarness,
    toDbValues,
    lifecycle: {
      created: HarnessSubjects.created,
      updated: HarnessSubjects.updated,
      deleted: HarnessSubjects.deleted,
    },
  });

  const registerList = createDrizzleListHandler({
    table: harnessDefinitions,
    subject: HarnessStorageSubjects.list,
    pluralKey: 'harnesses',
    mapper: mapHarness,
    buildPredicates: (payload: HarnessListQuery, table) => {
      const predicates = [];
      if (payload.adapterName) {
        predicates.push(eq(table.adapterName, payload.adapterName));
      }
      if (payload.clientId) {
        predicates.push(eq(table.clientId, payload.clientId));
      }
      if (payload.name) {
        predicates.push(eq(table.name, payload.name));
      }

      return predicates;
    },
  });

  const crudCleanup = registerCrud(bus, db);
  const listCleanup = registerList(bus, db);
  return () => {
    crudCleanup();
    listCleanup();
  };
}
