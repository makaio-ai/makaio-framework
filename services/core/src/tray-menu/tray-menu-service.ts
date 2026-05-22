import type { IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import {
  TrayMenuEntrySchema,
  TrayMenuGroupSchema,
  type TrayMenuEntry,
  type TrayMenuGroup,
  type TrayMenuListEntry,
} from './schemas.js';
import { TrayMenuSubjects } from './namespace.js';

/** Sort order for tray menu sections. */
const SECTION_ORDER: Record<TrayMenuEntry['section'], number> = {
  utilities: 0,
  tools: 1,
  views: 2,
};

interface TrayMenuBucket {
  /** Section used for top-level sorting. */
  section: TrayMenuEntry['section'];
  /** Priority used for top-level sorting. */
  priority: number;
  /** Label used as a deterministic tie-breaker. */
  label: string;
  /** Entries emitted by this bucket. */
  entries: TrayMenuListEntry[];
}

/**
 * In-memory registry for package-contributed tray menu entries.
 *
 * Registrations are idempotent and keyed by owning package. The service owns
 * tray menu state for every host surface; renderers consume it through the
 * `host:tray.list` RPC and observe mutations through `host:tray.changed`.
 */
export class TrayMenuService extends BaseService {
  /** Dependency tokens required before this service. */
  public static readonly needs = [] as const;
  public static readonly critical = true as const;

  /**
   * Factory for DI container startup.
   * @param ctx - Start context providing the bus
   * @returns Initialized TrayMenuService instance
   */
  public static async create(ctx: { bus: IMakaioBus }): Promise<TrayMenuService> {
    const service = new TrayMenuService(ctx.bus);
    await service.init();
    return service;
  }

  private readonly entries = new Map<string, TrayMenuEntry>();
  private readonly groups = new Map<string, TrayMenuGroup>();
  private readonly groupEntryIds = new Map<string, Set<string>>();

  /**
   * Create a tray menu service.
   * @param bus - Bus instance used for tray menu subjects
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected onInit(): void {
    this.registerHandler(TrayMenuSubjects.register, async (ctx) => {
      const entry = TrayMenuEntrySchema.parse(ctx.payload.entry);
      this.assertEntryCanRegister(entry);
      this.entries.set(this.entryKey(entry.packageName, entry.entryId), entry);
      // Always emit changed, even for identical re-registrations. The tray
      // rebuild is a single native menu update — the cost of a no-op rebuild
      // is negligible compared to the fragility of deep-equality checks.
      await this.emitChanged();
      ctx.setResult({ entryId: entry.entryId });
    });

    this.registerHandler(TrayMenuSubjects.unregister, async (ctx) => {
      const removed = this.entries.delete(this.entryKey(ctx.payload.packageName, ctx.payload.entryId));
      if (removed) await this.emitChanged();
      ctx.setResult({ removed });
    });

    this.registerHandler(TrayMenuSubjects.group.register, async (ctx) => {
      const group = TrayMenuGroupSchema.parse(ctx.payload.group);
      const entryIds = this.collectGroupEntryIds(group);
      this.assertGroupCanRegister(group, entryIds);
      const key = this.groupKey(group.packageName, group.groupId);
      this.groups.set(key, group);
      this.groupEntryIds.set(key, entryIds);
      await this.emitChanged();
      ctx.setResult({ groupId: group.groupId });
    });

    this.registerHandler(TrayMenuSubjects.group.unregister, async (ctx) => {
      const key = this.groupKey(ctx.payload.packageName, ctx.payload.groupId);
      const removed = this.groups.delete(key);
      this.groupEntryIds.delete(key);
      if (removed) await this.emitChanged();
      ctx.setResult({ removed });
    });

    this.registerHandler(TrayMenuSubjects.list, (ctx) => {
      ctx.setResult({ entries: this.listEntries() });
    });
  }

  protected onDestroy(): void {
    this.entries.clear();
    this.groups.clear();
    this.groupEntryIds.clear();
  }

  private listEntries(): TrayMenuListEntry[] {
    const buckets: TrayMenuBucket[] = [
      ...Array.from(this.entries.values(), (entry) => ({
        section: entry.section,
        priority: entry.priority,
        label: entry.label,
        entries: [entry],
      })),
      ...Array.from(this.groups.values(), (group) => {
        const entries = group.entries.map((entry) => ({
          ...entry,
          packageName: group.packageName,
          section: group.section,
          groupId: group.groupId,
        }));
        return {
          section: group.section,
          priority: group.priority,
          label: entries[0]?.label ?? group.groupId,
          entries,
        };
      }),
    ];

    return buckets
      .sort((a, b) => {
        const sectionDelta = SECTION_ORDER[a.section] - SECTION_ORDER[b.section];
        if (sectionDelta !== 0) return sectionDelta;
        const priorityDelta = a.priority - b.priority;
        if (priorityDelta !== 0) return priorityDelta;
        if (a.label < b.label) return -1;
        if (a.label > b.label) return 1;
        return 0;
      })
      .flatMap((bucket) => bucket.entries);
  }

  private assertEntryCanRegister(entry: TrayMenuEntry): void {
    for (const group of this.groups.values()) {
      const entryIds = this.groupEntryIds.get(this.groupKey(group.packageName, group.groupId));
      if (group.packageName === entry.packageName && entryIds?.has(entry.entryId)) {
        throw new Error(`Tray menu entry "${entry.packageName}:${entry.entryId}" already exists in a group`);
      }
    }
  }

  private assertGroupCanRegister(group: TrayMenuGroup, entryIds: ReadonlySet<string>): void {
    const groupKey = this.groupKey(group.packageName, group.groupId);
    for (const entryId of entryIds) {
      if (this.entries.has(this.entryKey(group.packageName, entryId))) {
        throw new Error(`Tray menu entry "${group.packageName}:${entryId}" already exists as a standalone entry`);
      }
      for (const existingGroup of this.groups.values()) {
        const existingGroupKey = this.groupKey(existingGroup.packageName, existingGroup.groupId);
        const existingEntryIds = this.groupEntryIds.get(existingGroupKey);
        if (
          existingGroup.packageName === group.packageName &&
          existingGroupKey !== groupKey &&
          existingEntryIds?.has(entryId)
        ) {
          throw new Error(`Tray menu entry "${group.packageName}:${entryId}" already exists in another group`);
        }
      }
    }
  }

  private collectGroupEntryIds(group: TrayMenuGroup): Set<string> {
    const entryIds = new Set<string>();
    for (const entry of group.entries) {
      if (entryIds.has(entry.entryId)) {
        throw new Error(
          `Tray menu group "${group.packageName}:${group.groupId}" contains duplicate entry "${entry.entryId}"`,
        );
      }
      entryIds.add(entry.entryId);
    }
    return entryIds;
  }

  private async emitChanged(): Promise<void> {
    await this.bus.emit(TrayMenuSubjects.changed, {});
  }

  private entryKey(packageName: string, entryId: string): string {
    return JSON.stringify([packageName, entryId]);
  }

  private groupKey(packageName: string, groupId: string): string {
    return JSON.stringify([packageName, groupId]);
  }
}
