import type { ContributionName, ExtensionName } from '@makaio/core';

/**
 * Augmentable map: contribution kind to type of one entry.
 * A package that declares a kind augments it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by packages
export interface MakaioContributionKinds {}

/** The open slot on an extension. Key: `<declaring extension>.<kind>`. */
export type OpenContributions = {
  [K in keyof MakaioContributionKinds]?: MakaioContributionKinds[K][];
} & Record<string, unknown[]>;

/** Type of one entry of a kind; `unknown` for kinds no package has augmented. */
export type OpenContributionEntryOf<K extends string> = K extends keyof MakaioContributionKinds
  ? MakaioContributionKinds[K]
  : unknown;

/** Entries one extension contributed for a kind. */
export interface OpenContributionSet<T = unknown> {
  readonly extension: ExtensionName;
  readonly entries: readonly T[];
}

/** Read capability of the extension that owns a kind. */
export interface OpenContributionReader {
  /**
   * Entries of all extensions that are active at the moment of the call, for a kind this extension owns.
   * The result is the state at the call: do not cache it; call again when you need the entries, because
   * extensions start and stop while the host runs. Throws for a kind this extension does not own.
   * Each `entries` array is frozen; the entries in it are shared references owned by the contributor and must
   * not be mutated (the kernel never touches or deep-freezes entries).
   */
  of<K extends ContributionName>(kind: K): ReadonlyArray<OpenContributionSet<OpenContributionEntryOf<K>>>;
}
