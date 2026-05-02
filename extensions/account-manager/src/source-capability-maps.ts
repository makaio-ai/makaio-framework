import type { ICredentialSource } from './interfaces/credential-source.js';
import type { ILabelProvider } from './interfaces/label-provider.js';
import type { IUsageProvider } from './interfaces/usage-provider.js';
import type { CredentialSourceWithOptionalLabel, LabelSource } from './handlers/index.js';

/**
 * Builds a map from client id to label-capable source.
 * @param sources - Credential sources registered with AccountManager
 * @returns Label-resolver source map
 */
export function buildLabelSources(sources: CredentialSourceWithOptionalLabel[]): Map<string, LabelSource> {
  const map = new Map<string, LabelSource>();
  for (const source of sources) {
    if (isLabelProvider(source)) {
      map.set(source.clientId, { clientId: source.clientId, resolveLabel: source.resolveLabel.bind(source) });
    }
  }
  return map;
}

/**
 * Builds a map from client id to usage-capable source.
 * @param sources - Credential sources registered with AccountManager
 * @returns Usage-provider source map
 */
export function buildUsageSources(sources: CredentialSourceWithOptionalLabel[]): Map<string, IUsageProvider> {
  const map = new Map<string, IUsageProvider>();
  for (const source of sources) {
    if (isUsageProvider(source)) {
      map.set(source.clientId, { resolveUsage: source.resolveUsage.bind(source) });
    }
  }
  return map;
}

/**
 * Returns whether the source implements {@link ILabelProvider}.
 * @param source - Credential source to test
 * @returns Whether the source can resolve labels
 */
function isLabelProvider(
  source: ICredentialSource & Partial<ILabelProvider>,
): source is ICredentialSource & ILabelProvider {
  return typeof source.resolveLabel === 'function';
}

/**
 * Returns whether the source implements {@link IUsageProvider}.
 * @param source - Credential source to test
 * @returns Whether the source can resolve usage
 */
function isUsageProvider(
  source: ICredentialSource & Partial<IUsageProvider>,
): source is ICredentialSource & IUsageProvider {
  return typeof source.resolveUsage === 'function';
}
