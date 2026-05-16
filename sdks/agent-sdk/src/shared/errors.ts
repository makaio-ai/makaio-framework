/** Thrown when credentials cannot be resolved for a provider. */
export class MakaioCredentialError extends Error {
  public override readonly name = 'MakaioCredentialError';
  public readonly provider: string;

  /**
   * @param provider - Provider identifier (e.g. 'openai', 'anthropic').
   * @param envVarNames - Environment variable names the user can set.
   */
  public constructor(provider: string, envVarNames: string[]) {
    const envHint =
      envVarNames.length > 0
        ? `Set ${envVarNames.join(' or ')} environment variable`
        : 'Configure credentials in Makaio settings';
    super(`No API key found for provider '${provider}'. ${envHint}.`);
    this.provider = provider;
  }
}

/** Thrown when bus connection fails (only relevant in /core mode). */
export class MakaioConnectionError extends Error {
  public override readonly name = 'MakaioConnectionError';
  public readonly url: string;

  /**
   * @param url - WebSocket URL that failed.
   * @param reason - Failure reason.
   */
  public constructor(url: string, reason: string) {
    super(
      `Failed to connect to Makaio bus at ${url}: ${reason}\n` +
        `Make sure Makaio is running ('makaio serve' or Makaio.app).`,
    );
    this.url = url;
  }
}

/** Thrown when a Claude-compatible SDK method has no Makaio runtime contract yet. */
export class MakaioUnsupportedFeatureError extends Error {
  public override readonly name = 'MakaioUnsupportedFeatureError';
  public readonly feature: string;

  /**
   * @param feature - SDK feature that cannot be executed.
   * @param reason - Contract-level reason the feature is unavailable.
   */
  public constructor(feature: string, reason: string) {
    super(`${feature} is not supported by this Makaio runtime: ${reason}`);
    this.feature = feature;
  }
}

/** Thrown when canonical model resolution fails. */
export class MakaioModelError extends Error {
  public override readonly name = 'MakaioModelError';
  public readonly model: string;
  public readonly reason: 'ambiguous' | 'not-found' | 'parse-error';
  public readonly suggestions: string[];

  /**
   * @param model - The model string that failed resolution.
   * @param reason - Why resolution failed.
   * @param suggestions - Qualified model names the user could use instead.
   */
  public constructor(model: string, reason: 'ambiguous' | 'not-found' | 'parse-error', suggestions: string[] = []) {
    const detail =
      reason === 'ambiguous'
        ? `Model '${model}' matches multiple providers. Use a qualified name:\n${suggestions.map((s) => `  - ${s}`).join('\n')}`
        : reason === 'not-found'
          ? `Model '${model}' not found in any enabled provider.`
          : `Invalid model name '${model}'.`;
    super(detail);
    this.model = model;
    this.reason = reason;
    this.suggestions = suggestions;
  }
}
