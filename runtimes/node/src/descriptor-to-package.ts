import type { MakaioExtension } from '@makaio/contracts';
import type { ExtensionManifest } from '@makaio/contracts/extension';

/**
 * Extract the common {@link MakaioExtension} base fields from a descriptor.
 *
 * Used by synthesized-package factories (CLI-only, browser-only, detached) to
 * avoid repeating the same optional-field spread across three call sites.
 * @param descriptor - Extension descriptor whose base fields are extracted.
 * @returns Partial {@link MakaioExtension} containing identity and gate fields.
 */
export function descriptorToBasePackage(
  descriptor: ExtensionManifest,
): Pick<MakaioExtension, 'name' | 'displayName' | 'version' | 'surface' | 'dependencies' | 'requires' | 'provides'> {
  return {
    name: descriptor.name,
    displayName: descriptor.displayName,
    version: descriptor.version,
    ...(descriptor.surface !== undefined ? { surface: descriptor.surface } : {}),
    ...(descriptor.dependencies !== undefined ? { dependencies: descriptor.dependencies } : {}),
    ...(descriptor.requires !== undefined ? { requires: descriptor.requires } : {}),
    ...(descriptor.provides !== undefined ? { provides: descriptor.provides } : {}),
  };
}
