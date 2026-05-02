/** Options for CodexSource installation and config probing. */
export interface CodexSourceOptions {
  /** Root directory of the Codex installation/config. */
  codexHome?: string;
}

/**
 * Shape of the `tokens` object in Codex's `auth.json` (ChatGPT OAuth mode).
 */
export interface CodexTokens {
  refresh_token?: string;
  access_token?: string;
  id_token?: string;
  account_id?: string;
}

/** Top-level shape of `~/.codex/auth.json` */
export interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: CodexTokens;
  last_refresh?: string;
}

/** Identity fields extracted from Codex id_token claims. */
export interface IdTokenIdentity {
  /** Display name claim, when present. */
  name: string | null;
  /** Email claim, when present. */
  email: string | null;
  /** ChatGPT plan type from the OpenAI auth namespace, when present. */
  planType: string | undefined;
}
