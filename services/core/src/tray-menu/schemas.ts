import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/** Visual grouping for system tray menu entries. */
export const TrayMenuSectionSchema = z.enum(['utilities', 'tools', 'views']);

/** Opaque metadata echoed back to the owning package on click. */
export const TrayMenuMetadataSchema = z.record(z.string(), z.unknown());

/** A single package-owned tray menu entry. */
export const TrayMenuEntrySchema = z.object({
  /** Owning package name. */
  packageName: z.string(),
  /** Unique entry identifier within the owning package. */
  entryId: z.string(),
  /** Display label shown in the menu. */
  label: z.string(),
  /** Visual grouping section. */
  section: TrayMenuSectionSchema,
  /** Sort order within section. Lower values render first. */
  priority: z.number().int().default(50),
  /** Whether the entry is clickable. */
  enabled: z.boolean().default(true),
  /** Opaque data echoed back on click. */
  metadata: TrayMenuMetadataSchema.optional(),
});

/** A group entry inherits its owning package and section from the group. */
export const TrayMenuGroupEntrySchema = TrayMenuEntrySchema.omit({
  packageName: true,
  section: true,
});

/** Ordered group of tray entries contributed by one package. */
export const TrayMenuGroupSchema = z.object({
  /** Owning package name. */
  packageName: z.string(),
  /** Unique group identifier within the owning package. */
  groupId: z.string(),
  /** Ordered entries; order is preserved within the group. Must be non-empty. */
  entries: z.array(TrayMenuGroupEntrySchema).min(1),
  /** Visual grouping section for every entry in the group. */
  section: TrayMenuSectionSchema,
  /** Sort order for the group within section. */
  priority: z.number().int().default(50),
});

/** Flattened list entry returned to tray renderers. */
export const TrayMenuListEntrySchema = TrayMenuEntrySchema.extend({
  /** Owning group identifier when the entry came from a group. */
  groupId: z.string().optional(),
});

/** Payload emitted when a tray entry is clicked. */
export const TrayMenuItemClickedSchema = z.object({
  /** Owning package name. */
  packageName: z.string(),
  /** Clicked entry identifier. */
  entryId: z.string(),
  /** Owning group identifier when the clicked entry came from a group. */
  groupId: z.string().optional(),
  /** Opaque metadata originally registered with the clicked entry. */
  metadata: TrayMenuMetadataSchema.optional(),
});

/** Tray menu domain schemas. */
export const TrayMenuSchemas = {
  register: {
    request: z.object({ entry: TrayMenuEntrySchema }),
    response: z.object({ entryId: z.string() }),
  },
  unregister: {
    request: z.object({ packageName: z.string(), entryId: z.string() }),
    response: z.object({ removed: z.boolean() }),
  },
  'group.register': {
    request: z.object({ group: TrayMenuGroupSchema }),
    response: z.object({ groupId: z.string() }),
  },
  'group.unregister': {
    request: z.object({ packageName: z.string(), groupId: z.string() }),
    response: z.object({ removed: z.boolean() }),
  },
  'item.clicked': TrayMenuItemClickedSchema,
  changed: z.object({}),
  list: {
    request: z.object({}),
    response: z.object({ entries: z.array(TrayMenuListEntrySchema) }),
  },
} satisfies SchemaRecord;

/** A package-owned tray menu entry. */
export type TrayMenuEntry = z.infer<typeof TrayMenuEntrySchema>;

/** Flattened tray menu entry returned by `host:tray.list`. */
export type TrayMenuListEntry = z.infer<typeof TrayMenuListEntrySchema>;

/** A grouped package tray menu contribution. */
export type TrayMenuGroup = z.infer<typeof TrayMenuGroupSchema>;

/** Payload emitted when a tray menu entry is clicked. */
export type TrayMenuItemClicked = z.infer<typeof TrayMenuItemClickedSchema>;
