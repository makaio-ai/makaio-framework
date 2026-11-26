import { z } from 'zod';
import type { JsonValue, WorkflowWorkerBusAuth } from '@makaio/contracts';
import type { OrderedWorkerBootstrapAuth } from '@makaio/contracts/workflow';

export type StockLaunchAuth = WorkflowWorkerBusAuth | OrderedWorkerBootstrapAuth;

/** Stock client process cases use the ordered launch channel. */
export type StockExchangeScenario =
  | 'stock-success'
  | 'stock-dns-retry'
  | 'stock-refused'
  | 'stock-untrusted'
  | 'stock-lost'
  | 'stock-legacy'
  | 'stock-dropped'
  | 'stock-expired'
  | 'stock-offline'
  | 'stock-retry'
  | 'stock-deadline'
  | 'stock-shutdown'
  | 'stock-no-decoder';

/** One independent host and client scenario. */
export type ExchangeScenario =
  | StockExchangeScenario
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
  | 'proof-replay'
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

export const ExchangeHostStartSchema = z.strictObject({
  database: z.string(),
  proof: z.string(),
  expiredAt: z.number().optional(),
  port: z.number().optional(),
});
export type ExchangeHostStart = z.infer<typeof ExchangeHostStartSchema>;

export const ExchangePeerStartSchema = z.strictObject({
  port: z.number(),
  proof: z.string(),
});
export type ExchangePeerStart = z.infer<typeof ExchangePeerStartSchema>;

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
  | { kind: 'host-loaded' }
  | { kind: 'ready'; port: number }
  | { kind: 'restarted'; port: number }
  | { kind: 'transport-stopped'; abortedBeforeRelease: boolean }
  | { kind: 'stock-launch'; auth: StockLaunchAuth }
  | { kind: 'stock-attempt' }
  | { kind: 'stock-dns-interrupted' }
  | { kind: 'stock-clock-expired' }
  | { kind: 'stock-accepted'; payload: JsonValue | undefined; principal: string }
  | { kind: 'stock-stopped'; code: string; decoderRequired?: boolean }
  | { kind: 'shutdown-finished'; aborted: boolean; routed: boolean }
  | { kind: 'phase'; phase: string; ms: number }
  | { kind: 'stock-winner'; payload: JsonValue; expiresAt: string }
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
  | 'expire-input'
  | 'expire-bootstrap'
  | 'expire-replay';

/** Keep a real refusal release window in one process test per host and dialect. */
export const MEASURED_REFUSAL = 'proof-interrupted';

export const TEST_EXCHANGE_BUDGET = 512;
export const RUN_ID = 'booked-run';
export const TEST_SUBJECT = 'exchangeTest.ping';
