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
  | 'stock-no-decoder'
  | 'stock-reconnect'
  | 'stock-listener-outage'
  | 'stock-before-sync';

/** One independent host and client scenario. */
export type ExchangeScenario =
  | StockExchangeScenario
  | 'boot-protected'
  | 'boot-default'
  | 'boot-supported'
  | 'capacity'
  | 'silent'
  | 'committed'
  | 'correlation'
  | 'rollback'
  | 'dropped'
  | 'dropped-digest'
  | 'dropped-commit'
  | 'host-aborted'
  | 'local-revoke'
  | 'local-promotion'
  | 'local-promotion-aborts'
  | 'local-promotion-hangs'
  | 'local-promotion-repeats'
  | 'two-host-revoke'
  | 'local-takeover'
  | 'local-takeover-invalidates'
  | 'local-takeover-identity'
  | 'local-expiry'
  | 'storage-interrupted'
  | 'storage-read-interrupted'
  | 'deadline-after-begin'
  | 'deadline-after-commit'
  | 'transport-stopped'
  | 'foreign'
  | 'unknown'
  | 'wrong-secret'
  | 'identity-wrong'
  | 'identity-missing'
  | 'identity-closed'
  | 'identity-expired'
  | 'identity-revoked'
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
  omitLegacyAuth: z.boolean().optional(),
  exerciseOutcome: z.boolean().optional(),
  externalExchange: z
    .strictObject({
      host: z.string(),
      security: z.enum(['tls', 'verified-ingress', 'unprotected']),
      maxBytes: z.number().optional(),
      tlsIssue: z.enum(['empty-cert', 'empty-key', 'malformed-cert', 'mismatched-key']).optional(),
      ingressVerifier: z.enum(['missing', 'throws', 'truthy', 'promise']).optional(),
    })
    .optional(),
  bindHost: z.literal('::ffff:127.0.0.1').optional(),
  rejectBindHost: z.enum(['0.0.0.0', 'localhost']).optional(),
  expiredAt: z.number().optional(),
  port: z.number().optional(),
  wake: z
    .strictObject({
      role: z.enum(['owner', 'listener']),
      terminal: z.string(),
      fence: z.string(),
      listenerTag: z.string().optional(),
    })
    .optional(),
});
export type ExchangeHostStart = z.infer<typeof ExchangeHostStartSchema>;
export type ExchangeWakeScope = NonNullable<ExchangeHostStart['wake']>;

export const ExchangePeerStartSchema = z.strictObject({
  port: z.number(),
  proof: z.string(),
  otherRun: z.boolean().optional(),
  host: z.string().optional(),
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
  readonly issuerKeyMatches?: boolean;
}

export type ExchangeMessage =
  | { kind: 'host-loaded' }
  | { kind: 'boot-listening'; port: number }
  | { kind: 'boot-rejected'; message: string; port: number; transportRegistered: boolean; code?: string }
  | { kind: 'boot-owner-held' }
  | { kind: 'boot-ending'; closed: boolean; connections: number }
  | { kind: 'boot-revoked'; connections: number }
  | { kind: 'boot-snapshot'; reads: number; proofChecks: number; promotions: number; accepted: boolean; bound: boolean }
  | { kind: 'ready'; port: number; exchangePort?: number }
  | { kind: 'boot-worker-redeemed' }
  | { kind: 'outcome-committed'; connections: number }
  | { kind: 'outcome-response'; decision: 'accepted' | 'refused' }
  | { kind: 'outcome-after-close'; rejected: boolean }
  | { kind: 'restarted'; port: number }
  | { kind: 'transport-stopped'; abortedBeforeRelease: boolean }
  | { kind: 'stock-launch'; auth: StockLaunchAuth }
  | { kind: 'stock-attempt' }
  | { kind: 'stock-dns-interrupted' }
  | { kind: 'stock-reconnect-dial-held' }
  | { kind: 'identity-attempt' }
  | { kind: 'before-sync' }
  | { kind: 'valid-bootstrap' }
  | { kind: 'run-closed' }
  | { kind: 'local-terminal'; closed: boolean; revoked: boolean; grace: boolean; facts: number }
  | { kind: 'local-transition-held'; closed: boolean; revoked: boolean; grace: boolean; facts: number }
  | { kind: 'local-promotion-queued' }
  | { kind: 'local-promotion-reading'; completedTerminalTurns: number }
  | { kind: 'local-promotion-hook-ended' }
  | { kind: 'local-route'; delivered: boolean }
  | { kind: 'local-route-delivered' }
  | { kind: 'local-takeover-published'; retiredDuringPublication: boolean }
  | { kind: 'local-takeover-identity'; expiresAt: string }
  | { kind: 'local-peer-paused' }
  | { kind: 'local-native-closed' }
  | { kind: 'local-retired'; direct: boolean; subscribed: boolean }
  | { kind: 'local-delivery'; delivered: boolean }
  | { kind: 'local-inbound-held' }
  | { kind: 'remote-rollback-fence'; terminalWakes: number; closed: boolean; revoked: boolean; facts: number }
  | { kind: 'remote-terminal-fact'; facts: number }
  | { kind: 'remote-listener-disconnected' }
  | { kind: 'remote-reconnect-held' }
  | { kind: 'remote-reconcile-held' }
  | { kind: 'remote-promotion-held' }
  | { kind: 'remote-resync-superseded' }
  | { kind: 'remote-resync-reconciled'; facts: number; terminalWakes: number }
  | { kind: 'stock-status'; expiresAt: string }
  | { kind: 'stock-status-checked'; cancelAdvertised: boolean }
  | { kind: 'stock-cancelled' }
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
  | 'boot-snapshot'
  | 'submit-rollback'
  | 'submit-result'
  | 'probe-retiring'
  | 'release-outcome'
  | 'boot-close'
  | 'boot-rollback'
  | 'boot-revoke-without-notification'
  | 'release'
  | 'release-terminal'
  | 'release-reconcile'
  | 'release-native-close'
  | 'pause-wire'
  | 'resume-wire'
  | 'drop'
  | 'stop'
  | 'abort-host'
  | 'close-run'
  | 'cancel-worker'
  | 'rollback-run'
  | 'grace-run'
  | 'probe'
  | 'probe-held'
  | 'probe-delivery'
  | 'probe-local-route'
  | 'stop-transport'
  | 'replay'
  | 'present'
  | 'expire-input'
  | 'release-reconnect-dial'
  | 'expire-bootstrap'
  | 'expire-replay';

export const OTHER_RUN_ID = 'other-run';
export const STOCK_CANCEL_SUBJECT = 'workflow.exchange-execution.cancel';
export const LOCAL_DELIVERY_SUBJECT = 'exchangeTest.localDelivery';

/** Keep a real refusal release window in one process test per host and dialect. */
export const MEASURED_REFUSAL = 'proof-interrupted';

export const TEST_EXCHANGE_BUDGET = 512;
export const RUN_ID = 'booked-run';
export const TEST_SUBJECT = 'exchangeTest.ping';
