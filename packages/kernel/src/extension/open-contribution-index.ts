import type { OpenContributionEntryOf, OpenContributionReader, OpenContributionSet } from '@makaio/contracts';
import { ContributionNameSchema, localContributionName } from '@makaio/core';
import type { ContributionName, ExtensionName } from '@makaio/core';
import type { ContributionProcessor } from './types.js';

/**
 * Checks for a plain object: non-null, not an array, prototype `Object.prototype` or `null`.
 * Rejects arrays, `Map`, `Set` and class instances.
 * @param value - Value to check.
 * @returns True for a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Kernel-internal index over the open slot (`openContributions`) of active extensions.
 *
 * The index checks only the shape of a slot (keys are contribution names, values are
 * arrays). It never reads a field of an entry: only the extension that owns a kind
 * interprets its entries, through the reader from {@link OpenContributionIndex.readerFor}.
 */
export class OpenContributionIndex {
  /** Entries per extension and kind. Map insertion order is activation order. */
  private readonly slots = new Map<ExtensionName, ReadonlyMap<string, readonly unknown[]>>();

  /**
   * Validates the slot of one extension and stores it, replacing an earlier slot of the same extension.
   * Nothing is stored when the slot is malformed.
   * @param extension - Name of the contributing extension.
   * @param slot - The extension's `openContributions` field, if any. Unchecked: it comes from an imported module.
   * `undefined` means no slot and clears the extension's earlier slot.
   * @throws Error when the slot is not a plain object, a key is not a contribution name, or a value is not an array.
   */
  public activate(extension: ExtensionName, slot: unknown): void {
    if (slot === undefined) {
      this.slots.delete(extension);
      return;
    }
    if (!isPlainObject(slot)) {
      throw new Error(`Open contributions of extension '${extension}' must be an object keyed by contribution name`);
    }
    const staged = new Map<string, readonly unknown[]>();
    for (const [key, value] of Object.entries(slot)) {
      if (!ContributionNameSchema.safeParse(key).success) {
        throw new Error(
          `Open contribution kind '${key}' of extension '${extension}' is not a contribution name (<owner>.<kind>)`,
        );
      }
      if (!Array.isArray(value)) {
        throw new Error(`Open contributions of kind '${key}' of extension '${extension}' must be an array`);
      }
      staged.set(key, Object.freeze([...value]));
    }

    this.slots.delete(extension);
    if (staged.size > 0) {
      this.slots.set(extension, staged);
    }
  }

  /**
   * Removes the entries of one extension. Unknown extensions are ignored.
   * @param extension - Name of the extension that stopped.
   */
  public deactivate(extension: ExtensionName): void {
    this.slots.delete(extension);
  }

  /**
   * Creates a reader bound to one extension.
   * @param owner - Name of the extension that reads.
   * @returns Reader whose `of` throws for kinds `owner` does not own.
   */
  public readerFor(owner: ExtensionName): OpenContributionReader {
    return {
      of: <K extends ContributionName>(kind: K): ReadonlyArray<OpenContributionSet<OpenContributionEntryOf<K>>> => {
        if (localContributionName(owner, kind) === undefined) {
          throw new Error(`Extension '${owner}' does not own contribution kind '${kind}'`);
        }
        const sets: Array<OpenContributionSet<OpenContributionEntryOf<K>>> = [];
        for (const [extension, kinds] of this.slots) {
          const entries = kinds.get(kind);
          if (entries === undefined) continue;
          // Entries are opaque to the kernel; the owner knows the entry type of its kind.
          // The stored array is already frozen in `activate`.
          sets.push(Object.freeze({ extension, entries: entries as readonly OpenContributionEntryOf<K>[] }));
        }
        return Object.freeze(sets);
      },
    };
  }

  /**
   * Lists kinds that have entries while no active extension owns them.
   * Ownership is decided by `localContributionName`, so an owner may contain dots.
   * @param activeNames - Names of the active extensions.
   * @returns Unclaimed kinds, each once, in first-seen order.
   */
  public unclaimedKinds(activeNames: Iterable<ExtensionName>): ContributionName[] {
    const active = [...activeNames];
    const kinds = new Set<string>();
    for (const slot of this.slots.values()) {
      for (const [kind, entries] of slot) {
        if (entries.length > 0) kinds.add(kind);
      }
    }
    return [...kinds].filter((kind) => !active.some((name) => localContributionName(name, kind) !== undefined));
  }
}

/**
 * Creates the contribution processor that feeds the index from extensions' `openContributions`.
 * @param index - Index to keep in step with the active extensions.
 * @returns Processor handling extensions that declare an open slot.
 */
export function createOpenContributionProcessor(index: OpenContributionIndex): ContributionProcessor {
  return {
    filter: (pkg) => pkg.openContributions !== undefined,
    async processActivated(name, pkg) {
      index.activate(name, pkg.openContributions);
    },
    async processStopped(name) {
      index.deactivate(name);
    },
  };
}
