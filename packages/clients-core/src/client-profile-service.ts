/**
 * Service for `client.profile.*` CRUD operations.
 *
 * Bridges the public `client.profile.*` bus subjects to the internal
 * `client-profile:storage.*` persistence layer, adding the filesystem
 * lifecycle (directory creation / removal) that the storage layer
 * intentionally omits.
 * @packageDocumentation
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { BaseService } from '@makaio/service-base';
import { ClientProfileStorageSubjects, type ClientProfileRecord } from './storage/profile-storage-namespace.js';
import { canonicalizeClientId } from './client-session-observed-semantics.js';

/**
 * Resolve a child path and verify that it remains inside the expected base.
 * @param basePath - Absolute base directory that owns the child path.
 * @param childPath - Candidate child path.
 * @param operation - Operation name used in error messages.
 * @returns Resolved child path.
 */
function assertPathWithinBase(basePath: string, childPath: string, operation: string): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedChild = path.resolve(childPath);
  const relative = path.relative(resolvedBase, resolvedChild);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return resolvedChild;
  }
  throw new Error(`${operation} refused to access path outside client profile root`);
}

/**
 * Handles the `client.profile.*` bus subjects, providing full CRUD for named
 * client configuration profiles plus filesystem directory management.
 *
 * Filesystem layout managed by this service:
 * ```
 * {clientsBasePath}/{clientId}/profiles/{name}/
 * ```
 */
export class ClientProfileService extends BaseService {
  /**
   * @param bus - Bus instance used for handler registration and storage requests
   * @param clientsBasePath - Absolute path to the top-level clients directory
   *   (e.g. `~/.makaio/clients/`)
   */
  public constructor(
    bus: IMakaioBus,
    private readonly clientsBasePath: string,
  ) {
    super(bus);
  }

  /**
   * Register all `client.profile.*` handlers.
   */
  protected override async onInit(): Promise<void> {
    this.registerCreateHandler();
    this.registerListHandler();
    this.registerGetHandler();
    this.registerUpdateHandler();
    this.registerDeleteHandler();
    this.registerSetDefaultHandler();
  }

  /**
   * Register the `client.profile.create` handler.
   */
  private registerCreateHandler(): void {
    this.registerHandler(ClientSubjects.profile.create, async (ctx) => {
      const clientId = canonicalizeClientId(ctx.payload.clientId, 'profile.create');
      const { name, description } = ctx.payload;

      // Reject duplicates before touching the filesystem.
      const existing = await this.bus.request(ClientProfileStorageSubjects.get, { clientId, name });
      if (existing.record !== null) {
        throw new Error(`Profile '${name}' already exists for client '${clientId}'`);
      }

      const profilesBasePath = path.join(this.clientsBasePath, clientId, 'profiles');
      const configDir = assertPathWithinBase(profilesBasePath, path.join(profilesBasePath, name), 'profile.create');
      await fs.mkdir(configDir, { recursive: true });

      const now = Date.now();
      const profile: ClientProfileRecord = {
        id: randomUUID(),
        clientId,
        name,
        description: description ?? null,
        configDir,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };

      await this.bus.request(ClientProfileStorageSubjects.set, profile);
      ctx.setResult({ profile });
    });
  }

  /**
   * Register the `client.profile.list` handler.
   */
  private registerListHandler(): void {
    this.registerHandler(ClientSubjects.profile.list, async (ctx) => {
      const clientId = canonicalizeClientId(ctx.payload.clientId, 'profile.list');
      const result = await this.bus.request(ClientProfileStorageSubjects.list, { clientId });
      ctx.setResult({ profiles: result.records });
    });
  }

  /**
   * Register the `client.profile.get` handler.
   */
  private registerGetHandler(): void {
    this.registerHandler(ClientSubjects.profile.get, async (ctx) => {
      const clientId = canonicalizeClientId(ctx.payload.clientId, 'profile.get');
      const result = await this.bus.request(ClientProfileStorageSubjects.get, {
        clientId,
        name: ctx.payload.name,
      });
      ctx.setResult({ profile: result.record });
    });
  }

  /**
   * Register the `client.profile.update` handler.
   */
  private registerUpdateHandler(): void {
    this.registerHandler(ClientSubjects.profile.update, async (ctx) => {
      const clientId = canonicalizeClientId(ctx.payload.clientId, 'profile.update');
      const { name, description } = ctx.payload;

      const existing = await this.bus.request(ClientProfileStorageSubjects.get, { clientId, name });
      if (existing.record === null) {
        throw new Error(`Profile '${name}' not found for client '${clientId}'`);
      }

      const updated: ClientProfileRecord = {
        ...existing.record,
        description: description !== undefined ? description : existing.record.description,
        updatedAt: Date.now(),
      };

      await this.bus.request(ClientProfileStorageSubjects.set, updated);
      ctx.setResult({ profile: updated });
    });
  }

  /**
   * Register the `client.profile.delete` handler.
   */
  private registerDeleteHandler(): void {
    this.registerHandler(ClientSubjects.profile.delete, async (ctx) => {
      const clientId = canonicalizeClientId(ctx.payload.clientId, 'profile.delete');
      const { name } = ctx.payload;

      const existing = await this.bus.request(ClientProfileStorageSubjects.get, { clientId, name });
      if (existing.record !== null) {
        const profilesBasePath = path.join(this.clientsBasePath, clientId, 'profiles');
        assertPathWithinBase(profilesBasePath, existing.record.configDir, 'profile.delete');
        await fs.rm(existing.record.configDir, { recursive: true, force: true });
      }

      const result = await this.bus.request(ClientProfileStorageSubjects.delete, { clientId, name });
      ctx.setResult({ success: result.success });
    });
  }

  /**
   * Register the `client.profile.setDefault` handler.
   */
  private registerSetDefaultHandler(): void {
    this.registerHandler(ClientSubjects.profile.setDefault, async (ctx) => {
      const clientId = canonicalizeClientId(ctx.payload.clientId, 'profile.setDefault');
      const { name } = ctx.payload;

      const result = await this.bus.request(ClientProfileStorageSubjects.setDefault, { clientId, name });
      if (result.record === null) {
        throw new Error(`Profile '${name}' not found for client '${clientId}'`);
      }

      ctx.setResult({ profile: result.record });
    });
  }
}
