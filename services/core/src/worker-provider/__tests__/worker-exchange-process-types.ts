/** One independent host and client scenario. */
export type ExchangeScenario =
  | 'capacity'
  | 'silent'
  | 'committed'
  | 'correlation'
  | 'rollback'
  | 'dropped'
  | 'dropped-digest'
  | 'dropped-commit'
  | 'host-aborted'
  | 'storage-interrupted'
  | 'storage-read-interrupted'
  | 'deadline-after-begin'
  | 'deadline-after-commit'
  | 'transport-stopped'
  | 'foreign'
  | 'unknown'
  | 'wrong-secret'
  | 'revoked'
  | 'expired'
  | 'proof'
  | 'proof-interrupted'
  | 'plaintext'
  | 'untrusted'
  | 'malformed'
  | 'oversized'
  | 'just-under'
  | 'exact'
  | 'over'
  | 'stored-over'
  | 'anonymous'
  | 'legacy';

export type ExchangeRuntime = 'node' | 'bun';

export interface ExchangeSnapshot {
  readonly unchanged: boolean;
  readonly redeemed: boolean;
  readonly bound: boolean;
  readonly deadlineMatches: boolean;
  readonly received: number;
  readonly advertised: number;
  readonly noCredentials: boolean;
  readonly digestReadFollowups?: number;
}

export type ExchangeMessage =
  | { kind: 'ready'; port: number }
  | { kind: 'restarted'; port: number }
  | { kind: 'transport-stopped'; abortedBeforeRelease: boolean }
  | { kind: 'precommit' }
  | { kind: 'pending-correlation' }
  | { kind: 'preframes' }
  | { kind: 'peer-gone' }
  | { kind: 'capacity-refused'; status: number; latencyMs: number }
  | { kind: 'silent-closed'; code: number }
  | { kind: 'input-window' }
  | { kind: 'digest' }
  | { kind: 'digest-finished' }
  | { kind: 'commit' }
  | { kind: 'committed' }
  | { kind: 'exchange-finished' }
  | { kind: 'snapshot'; snapshot: ExchangeSnapshot }
  | { kind: 'closed'; code: number; reply: string | undefined; latencyMs: number; successReplies?: number }
  | { kind: 'accepted'; bytes: number; principal: string }
  | { kind: 'tls-rejected' }
  | { kind: 'failed'; stage: string };

export type ExchangeCommand =
  | 'snapshot'
  | 'release'
  | 'drop'
  | 'stop'
  | 'abort-host'
  | 'stop-transport'
  | 'replay'
  | 'present'
  | 'expire-input';

/** Keep a real refusal release window in one process test per host and dialect. */
export const MEASURED_REFUSAL = 'proof-interrupted';

export const TEST_EXCHANGE_BUDGET = 512;
export const RUN_ID = 'booked-run';
export const TEST_SUBJECT = 'exchangeTest.ping';
