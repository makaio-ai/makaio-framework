import type { KernelMakaioExtension } from '@makaio/kernel';

const sourcePackages = new WeakMap<KernelMakaioExtension, KernelMakaioExtension>();

/**
 * Associate a copied extension package with its original loaded source package.
 * @param derivedPackage - Derived package produced during runtime composition.
 * @param sourcePackage - Package from which the derived package was copied.
 * @returns The derived package with source provenance recorded.
 */
export function retainExtensionPackageProvenance<T extends KernelMakaioExtension>(
  derivedPackage: T,
  sourcePackage: KernelMakaioExtension,
): T {
  sourcePackages.set(derivedPackage, getExtensionPackageSource(sourcePackage));
  return derivedPackage;
}

/**
 * Return the original loaded package from which a composed package derives.
 * @param extensionPackage - Loaded or derived extension package.
 * @returns The original package when provenance exists, otherwise the package itself.
 */
export function getExtensionPackageSource(extensionPackage: KernelMakaioExtension): KernelMakaioExtension {
  return sourcePackages.get(extensionPackage) ?? extensionPackage;
}
