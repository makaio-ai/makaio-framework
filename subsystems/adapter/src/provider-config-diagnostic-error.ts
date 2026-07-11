/** Stable diagnostic categories for rejected provider-config files. */
export type ProviderConfigDiagnosticCode =
  | 'legacy-provider-config'
  | 'unsupported-provider-config-version'
  | 'invalid-provider-config';

/**
 * Typed startup/write diagnostic for a provider-config file that cannot be
 * interpreted under the canonical normalized-auth contract.
 */
export class ProviderConfigDiagnosticError extends Error {
  /** Stable machine-readable diagnostic code. */
  public readonly code: ProviderConfigDiagnosticCode;
  /** Safe file name or provider-config identifier rejected by the repository. */
  public readonly source: string;

  /**
   * Create a provider-config diagnostic.
   * @param code - Stable diagnostic category.
   * @param source - Safe file name or config identifier being parsed.
   * @param detail - Safe structural detail that contains no credential values.
   */
  public constructor(code: ProviderConfigDiagnosticCode, source: string, detail: string) {
    super(`Provider config "${source}" cannot be loaded: ${detail}`);
    this.name = 'ProviderConfigDiagnosticError';
    this.code = code;
    this.source = source;
  }
}
