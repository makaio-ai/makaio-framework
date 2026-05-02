import type { ClientAccountIdentifier } from '@makaio/contracts/client';

interface ClientAccountRecord {
  clientAccountId: string;
  displayLabel?: string;
  identifiers: Map<string, ClientAccountIdentifier>;
}

/**
 * Result returned when account identifiers are observed or ingested.
 */
export interface ClientAccountUpsertResult {
  /** Stable in-memory account ID selected or created for the identifier set. */
  readonly clientAccountId: string;
  /** Latest non-empty display label retained for the account, if any. */
  readonly displayLabel?: string;
  /** Any prior account IDs folded into the canonical account during upsert. */
  readonly mergedAccountIds: ReadonlyArray<string>;
}

/**
 * In-memory registry that canonicalizes client accounts across identifiers.
 *
 * Identifiers are scoped by `clientId`, `scheme`, and `value`, so the same raw
 * identifier value used by different clients does not collide.
 */
export class ClientAccountRegistry {
  private nextAccountSequence = 1;
  private readonly accountIdsByIdentifier = new Map<string, string>();
  private readonly accounts = new Map<string, ClientAccountRecord>();

  /**
   * Upsert an account record for the provided identifiers.
   *
   * Reuses an existing account ID when any identifier is already known, and
   * folds all supplied identifiers onto the canonical account mapping.
   * @param options - Client/account identity inputs to observe
   * @returns Canonical account ID plus any merged prior IDs
   */
  public upsertAccount(options: {
    clientId: string;
    identifiers: ReadonlyArray<ClientAccountIdentifier>;
    displayLabel?: string;
  }): ClientAccountUpsertResult {
    const normalizedDisplayLabel = normalizeDisplayLabel(options.displayLabel);
    const uniqueIdentifierEntries = new Map<string, ClientAccountIdentifier>();

    for (const identifier of options.identifiers) {
      uniqueIdentifierEntries.set(
        createIdentifierKey(options.clientId, identifier.scheme, identifier.value),
        identifier,
      );
    }

    const strongMatches = collectMatchedAccountIds(uniqueIdentifierEntries, this.accountIdsByIdentifier, 'strong');
    const aliasMatches = collectMatchedAccountIds(uniqueIdentifierEntries, this.accountIdsByIdentifier, 'alias');
    const clientAccountId =
      strongMatches[0] ??
      (aliasMatches.length === 1
        ? aliasMatches[0]
        : aliasMatches.length > 1
          ? chooseCanonicalAccountId(aliasMatches)
          : this.createAccount());
    const accountsToMerge =
      strongMatches.length > 0 ? collectMergeCandidates(clientAccountId, strongMatches, aliasMatches) : [];
    const mergedAccountIds = accountsToMerge.flatMap((accountId) => this.mergeInto(clientAccountId, accountId));
    const account = this.accounts.get(clientAccountId);

    if (!account) {
      throw new Error(`Client account registry invariant violated: missing account ${clientAccountId}`);
    }

    for (const [identifierKey, identifier] of uniqueIdentifierEntries) {
      const existingAccountId = this.accountIdsByIdentifier.get(identifierKey);
      if (
        strongMatches.length === 0 &&
        identifier.strength === 'alias' &&
        existingAccountId !== undefined &&
        existingAccountId !== clientAccountId
      ) {
        continue;
      }

      account.identifiers.set(identifierKey, identifier);
      this.accountIdsByIdentifier.set(identifierKey, clientAccountId);
    }

    if (normalizedDisplayLabel !== undefined) {
      account.displayLabel = normalizedDisplayLabel;
    }

    return {
      clientAccountId,
      displayLabel: account.displayLabel,
      mergedAccountIds,
    };
  }

  /**
   * Remove all in-memory state.
   */
  public clear(): void {
    this.accountIdsByIdentifier.clear();
    this.accounts.clear();
    this.nextAccountSequence = 1;
  }

  private createAccount(): string {
    const clientAccountId = `client-account-${this.nextAccountSequence}`;
    this.nextAccountSequence += 1;
    this.accounts.set(clientAccountId, {
      clientAccountId,
      identifiers: new Map(),
    });
    return clientAccountId;
  }

  private mergeInto(targetAccountId: string, sourceAccountId: string): string[] {
    if (targetAccountId === sourceAccountId) {
      return [];
    }

    const target = this.accounts.get(targetAccountId);
    const source = this.accounts.get(sourceAccountId);

    if (!target || !source) {
      return [];
    }

    for (const [identifierKey, identifier] of source.identifiers) {
      target.identifiers.set(identifierKey, identifier);
      this.accountIdsByIdentifier.set(identifierKey, targetAccountId);
    }

    if (target.displayLabel === undefined && source.displayLabel !== undefined) {
      target.displayLabel = source.displayLabel;
    }

    this.accounts.delete(sourceAccountId);
    return [sourceAccountId];
  }
}

/**
 * Build the registry lookup key for an observed identifier.
 * @param clientId - Stable client identifier
 * @param scheme - Identifier scheme name
 * @param value - Identifier value
 * @returns Composite lookup key
 */
function createIdentifierKey(clientId: string, scheme: string, value: string): string {
  return `${clientId}\u0000${scheme}\u0000${value}`;
}

/**
 * Normalize display labels so empty values do not overwrite prior labels.
 * @param displayLabel - Potentially empty display label
 * @returns Trimmed label or undefined when empty
 */
function normalizeDisplayLabel(displayLabel: string | undefined): string | undefined {
  const trimmed = displayLabel?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Collect distinct matched account IDs for identifiers of a given strength.
 * @param identifiers - Unique identifier keys and payloads provided for the upsert
 * @param accountIdsByIdentifier - Existing registry mapping
 * @param strength - Identifier strength to include
 * @returns Sorted distinct account IDs for the requested strength
 */
function collectMatchedAccountIds(
  identifiers: ReadonlyMap<string, ClientAccountIdentifier>,
  accountIdsByIdentifier: ReadonlyMap<string, string>,
  strength: ClientAccountIdentifier['strength'],
): string[] {
  const matchedAccountIds = new Set<string>();

  for (const [identifierKey, identifier] of identifiers) {
    if (identifier.strength !== strength) {
      continue;
    }

    const clientAccountId = accountIdsByIdentifier.get(identifierKey);
    if (clientAccountId !== undefined) {
      matchedAccountIds.add(clientAccountId);
    }
  }

  return Array.from(matchedAccountIds).sort(compareClientAccountIds);
}

/**
 * Choose a deterministic canonical account ID from multiple matches.
 * @param clientAccountIds - Candidate account IDs
 * @returns Deterministically selected canonical account ID
 */
function chooseCanonicalAccountId(clientAccountIds: ReadonlyArray<string>): string {
  return [...clientAccountIds].sort(compareClientAccountIds)[0]!;
}

/**
 * Compare generated client account IDs by numeric sequence when present.
 * @param left - First candidate account ID
 * @param right - Second candidate account ID
 * @returns Sort order preserving creation sequence for generated account IDs
 */
function compareClientAccountIds(left: string, right: string): number {
  const leftSequence = parseClientAccountSequence(left);
  const rightSequence = parseClientAccountSequence(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return left.localeCompare(right);
}

/**
 * Parse the numeric sequence from generated client account IDs.
 * @param clientAccountId - Candidate account ID
 * @returns Numeric suffix, or null when the ID is not generated by this registry
 */
function parseClientAccountSequence(clientAccountId: string): number | null {
  const match = clientAccountId.match(/^client-account-(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Collect merge candidates when strong identifier evidence is present.
 * @param canonicalAccountId - Canonical account ID selected for the upsert
 * @param strongMatches - Existing accounts matched by strong identifiers
 * @param aliasMatches - Existing accounts matched by alias identifiers
 * @returns Sorted account IDs that should be merged into the canonical account
 */
function collectMergeCandidates(
  canonicalAccountId: string,
  strongMatches: ReadonlyArray<string>,
  aliasMatches: ReadonlyArray<string>,
): string[] {
  const mergeCandidates = new Set<string>([...strongMatches, ...aliasMatches]);
  mergeCandidates.delete(canonicalAccountId);
  return Array.from(mergeCandidates).sort(compareClientAccountIds);
}
