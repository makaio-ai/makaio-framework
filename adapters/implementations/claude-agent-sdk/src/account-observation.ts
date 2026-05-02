import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
// This adapter intentionally depends on the framework-owned Claude client package.
// `@makaio/client-claude-code` is a framework seam, not host wiring.
import { buildClaudeAccountOrgUuidIdentifier } from '@makaio/client-claude-code';
import {
  type ClientAccountIdentifier,
  type ClientSessionAccountObserveRequest,
  type ClientSessionLocator,
} from '@makaio/contracts/client';
import type { RequestSessionAccountObservation } from './account-observation-requester.js';

type ClaudeApiProvider = NonNullable<AccountInfo['apiProvider']>;

const CLAUDE_API_PROVIDERS: ReadonlyArray<ClaudeApiProvider> = [
  'firstParty',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
];
// Keep a local UUID normalizer so the raw Claude payload and dedupe key use the
// same canonical casing before `buildClaudeAccountOrgUuidIdentifier(...)`
// decides whether the evidence is strong enough to emit.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ClaudeAccountInfoQueryInstance {
  /** Best-effort SDK control method for the authenticated account snapshot. */
  accountInfo?: () => Promise<unknown>;
}

/**
 * Normalized Claude account evidence retained in account observations.
 *
 * UUID fields are adapter-owned extensions beyond the current SDK typings so
 * future Claude runtimes can reuse the same evidence model when the SDK starts
 * surfacing stronger identifiers.
 */
export interface ClaudeObservedAccountInfo extends Record<string, unknown> {
  /** Stable Claude account UUID when exposed by the SDK. */
  readonly accountUuid?: string;
  /** Stable Claude organization UUID when exposed by the SDK. */
  readonly orgUuid?: string;
  /** Normalized email address retained as source evidence and display-label input. */
  readonly email?: string;
  /** Organization label reported by Claude. */
  readonly organization?: string;
  /** Subscription or plan label reported by Claude. */
  readonly subscriptionType?: string;
  /** OAuth token provenance reported by Claude. */
  readonly tokenSource?: string;
  /** API key provenance reported by Claude. */
  readonly apiKeySource?: string;
  /** Active Claude API backend when reported by the SDK. */
  readonly apiProvider?: AccountInfo['apiProvider'];
}

/**
 * Stable Claude payload emitted through `client.session.account.observe`.
 *
 * `identifiers` carries the canonical account-linking evidence, while
 * `accountInfo` preserves the source-specific fields the Claude client runtime
 * can reuse without inventing its own normalization contract.
 */
export interface ClaudeAccountObservationPayload extends Record<string, unknown> {
  /** Human-readable label preferred by account-linking and status surfaces. */
  readonly displayLabel?: string;
  /** Canonical client-account identifiers derived from the normalized evidence. */
  readonly identifiers: ReadonlyArray<ClientAccountIdentifier>;
  /** Source-specific Claude account evidence. */
  readonly accountInfo: ClaudeObservedAccountInfo;
}

/**
 * Runtime context needed to emit a session-scoped Claude account observation.
 */
export interface ClaudeAccountObservationContext {
  /** Makaio session identifier when the adapter is attached to one. */
  readonly sessionId?: string;
  /** Provider session identifier once the Claude SDK has confirmed it. */
  readonly adapterSessionId?: string;
  /** Lazy accessor for the live SDK query instance. */
  readonly getQueryInstance: () => ClaudeAccountInfoQueryInstance | undefined;
}

/**
 * Best-effort observation emitter for completed Claude SDK turns.
 *
 * The emitter caches the last normalized payload for the connector session so
 * successfully handled unchanged account snapshots do not re-emit on every successful turn.
 */
export class ClaudeAccountObservationEmitter {
  private lastObservationKey?: string;
  private readonly inFlightObservationKeys = new Set<string>();
  private readonly pendingObservationRetryKeys = new Set<string>();

  public constructor(
    private readonly requestObservation: RequestSessionAccountObservation,
    private readonly clientId: string,
  ) {}

  /**
   * Fetch the current account snapshot and emit it when the normalized payload changed.
   * @param context - Connector session context used to resolve account info and locators
   */
  public async emitIfChanged(context: ClaudeAccountObservationContext): Promise<void> {
    const queryInstance = context.getQueryInstance();
    if (!queryInstance || typeof queryInstance.accountInfo !== 'function') {
      return;
    }

    let rawAccountInfo: unknown;
    try {
      rawAccountInfo = await queryInstance.accountInfo();
    } catch {
      return;
    }

    const payload = normalizeClaudeAccountObservationPayload(rawAccountInfo);
    if (!payload) {
      return;
    }

    const locator = buildSessionLocator(context.sessionId, context.adapterSessionId);
    if (!locator) {
      return;
    }

    // Dedup key uses payload only, not the locator. Overlapping calls with
    // the same account data but different locators (e.g., sessionId enrichment
    // mid-flight) collapse into one observation. This is intentional: the
    // observation system reconciles locators server-side, so re-emitting
    // identical payload with a newer locator adds no signal.
    const observationKey = JSON.stringify(payload);
    if (observationKey === this.lastObservationKey) {
      return;
    }

    const observationBase = {
      locator,
      clientId: this.clientId,
      source: 'claude-agent-sdk',
      kind: 'account-info',
      payload,
    } as const;

    // Completed turns can overlap because the connector does not await
    // post-turn observation hooks. Suppress concurrent duplicates, but remember
    // that another identical turn completed so declined/failed observations can
    // retry once the in-flight request settles.
    if (this.inFlightObservationKeys.has(observationKey)) {
      this.pendingObservationRetryKeys.add(observationKey);
      return;
    }

    await this.requestObservationWithRetry(observationKey, observationBase);
  }

  private async requestObservationWithRetry(
    observationKey: string,
    observationBase: Omit<ClientSessionAccountObserveRequest, 'observedAt'>,
  ): Promise<void> {
    while (true) {
      this.inFlightObservationKeys.add(observationKey);
      let handled = false;
      try {
        const result = await this.requestObservation({
          ...observationBase,
          observedAt: Date.now(),
        });
        handled = result.handled && result.data.handled;
        if (handled) {
          this.lastObservationKey = observationKey;
        }
      } catch {
        // Account observation is best-effort and must not affect turn completion.
      } finally {
        this.inFlightObservationKeys.delete(observationKey);
      }

      if (handled) {
        this.pendingObservationRetryKeys.delete(observationKey);
        return;
      }

      if (!this.pendingObservationRetryKeys.delete(observationKey)) {
        return;
      }
    }
  }
}

/**
 * Normalize a raw Claude SDK account snapshot into the adapter-owned evidence model.
 * @param rawAccountInfo - Account info returned by the Claude SDK control API
 * @returns Stable observation payload, or null when no strong canonical identifier can be derived
 */
export function normalizeClaudeAccountObservationPayload(
  rawAccountInfo: unknown,
): ClaudeAccountObservationPayload | null {
  const accountInfo = normalizeClaudeObservedAccountInfo(rawAccountInfo);
  const identifiers = buildCanonicalIdentifiers(accountInfo);
  if (identifiers.length === 0) {
    return null;
  }

  return {
    displayLabel: accountInfo.email ?? accountInfo.organization,
    identifiers,
    accountInfo,
  };
}

/**
 * Normalize the source-specific Claude fields into a stable record.
 * @param rawAccountInfo - Raw account info returned by the SDK
 * @returns Normalized Claude account evidence
 */
function normalizeClaudeObservedAccountInfo(rawAccountInfo: unknown): ClaudeObservedAccountInfo {
  const record = asRecord(rawAccountInfo);
  if (!record) {
    return {};
  }

  const normalized = {
    accountUuid: normalizeUuid(record['accountUuid']),
    orgUuid: normalizeUuid(record['orgUuid']),
    email: normalizeEmail(record['email']),
    organization: normalizeString(record['organization']),
    subscriptionType: normalizeString(record['subscriptionType']),
    tokenSource: normalizeString(record['tokenSource']),
    apiKeySource: normalizeString(record['apiKeySource']),
    apiProvider: normalizeApiProvider(record['apiProvider']),
  } satisfies ClaudeObservedAccountInfo;

  return dropUndefinedFields(normalized);
}

/**
 * Build canonical identifiers accepted by `client.account.observe`.
 * @param accountInfo - Normalized Claude account evidence
 * @returns Strong UUID evidence when available
 */
function buildCanonicalIdentifiers(accountInfo: ClaudeObservedAccountInfo): ClientAccountIdentifier[] {
  const strongIdentifier = buildClaudeAccountOrgUuidIdentifier(accountInfo.accountUuid, accountInfo.orgUuid);
  if (strongIdentifier) {
    return [strongIdentifier];
  }

  return [];
}

/**
 * Build the session locator required by `client.session.account.observe`.
 * @param sessionId - Makaio session identifier, if known
 * @param adapterSessionId - Provider session identifier, if known
 * @returns Best available locator, or undefined when neither identifier exists
 */
function buildSessionLocator(
  sessionId: string | undefined,
  adapterSessionId: string | undefined,
): ClientSessionLocator | undefined {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedAdapterSessionId = normalizeString(adapterSessionId);

  if (normalizedSessionId && normalizedAdapterSessionId) {
    return {
      kind: 'both',
      sessionId: normalizedSessionId,
      adapterSessionId: normalizedAdapterSessionId,
    };
  }

  if (normalizedSessionId) {
    return {
      kind: 'session',
      sessionId: normalizedSessionId,
    };
  }

  if (normalizedAdapterSessionId) {
    return {
      kind: 'adapter-session',
      adapterSessionId: normalizedAdapterSessionId,
    };
  }

  return undefined;
}

/**
 * Normalize UUID-like inputs so dedupe and canonical identifiers share the same casing.
 * @param value - Potential UUID field from Claude account metadata
 * @returns Lowercased UUID string when valid
 */
function normalizeUuid(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized && UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined;
}

/**
 * Normalize an optional string field.
 * @param value - Unknown input value
 * @returns Trimmed string when present and non-empty
 */
function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Normalize an email-like field into a stable lowercase value.
 * @param value - Unknown email-like value
 * @returns Lowercased email when present and non-empty
 */
function normalizeEmail(value: unknown): string | undefined {
  const email = normalizeString(value);
  return email?.toLowerCase();
}

/**
 * Normalize the SDK API provider field against the known provider enum.
 * @param value - Unknown provider value
 * @returns Supported Claude API provider, when recognized
 */
function normalizeApiProvider(value: unknown): ClaudeApiProvider | undefined {
  return typeof value === 'string' && CLAUDE_API_PROVIDERS.includes(value as ClaudeApiProvider)
    ? (value as ClaudeApiProvider)
    : undefined;
}

/**
 * Narrow an arbitrary value to a plain object record.
 * @param value - Unknown input value
 * @returns Record when the value is a non-array object
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Remove undefined fields so the dedupe key is stable across equivalent payloads.
 * @param record - Record that may contain undefined entries
 * @returns Record without undefined values
 */
function dropUndefinedFields<T extends Record<string, unknown>>(record: T): T {
  const normalizedEntries = Object.entries(record).filter(([, value]) => value !== undefined);
  return Object.fromEntries(normalizedEntries) as T;
}
