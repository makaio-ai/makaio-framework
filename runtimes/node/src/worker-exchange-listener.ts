import { strict as assert } from 'node:assert';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import type { CoreBootOptions, TransportReadyInfo } from './boot-types.js';
import type { WorkerConnectionExchangeOptions } from './worker-connection-exchange.js';

/** Connected peer and headers for one native HTTP upgrade. */
export interface WorkerExchangeIngressRequest {
  /** Address of the immediate TCP peer, supplied by the listener. */
  readonly peerAddress: string | undefined;
  /** Native request headers. Verify the ingress itself before trusting forwarded data. */
  readonly headers: Headers;
}

/** How the listener establishes encrypted worker transport. */
export type WorkerExchangeListenerSecurity =
  | {
      readonly kind: 'tls';
      /** PEM certificate chain presented to remote workers. */
      readonly cert: string;
      /** PEM private key for the listener. */
      readonly key: string;
    }
  | {
      readonly kind: 'verified-ingress';
      /**
       * Verify that the immediate peer is an authorized ingress and that it
       * terminated TLS for this upgrade. Forwarded headers alone do not establish trust.
       * The verifier runs synchronously, must return quickly, and must return exactly `true` to accept.
       * @param request - Peer address and headers from the native listener.
       * @returns Whether this upgrade came through the trusted TLS ingress.
       */
      readonly verifyIngress: (request: WorkerExchangeIngressRequest) => boolean;
    };

/** Protected worker listener for deployments running one host per database. */
export interface SingleHostWorkerExchangeOptions extends Omit<WorkerConnectionExchangeOptions, 'withRunPromotion'> {
  /** TCP address for the exchange-only listener. Port zero requests an ephemeral port. */
  readonly listen: { readonly host: string; readonly port: number };
  /** Either native TLS or a verified TLS-terminating ingress. */
  readonly security: WorkerExchangeListenerSecurity;
}

const configurationMessages = {
  'protection-required': 'Worker exchange requires TLS or a verified TLS ingress',
  'conflicting-options': 'Only one worker exchange may be configured',
  'dispatch-required': 'Worker exchange requires an ordered dispatch host with atomic redemption',
  'listener-required': 'Worker exchange requires a native listener created during boot',
  'invalid-bind': 'Worker exchange requires a TCP host and port',
  'invalid-tls': 'Worker exchange TLS credentials could not configure the listener',
  'listen-failed': 'Worker exchange listener could not start',
} as const;

/** Invalid configuration for the native worker exchange listener. */
export class WorkerExchangeListenerConfigurationError extends Error {
  /**
   * @param code - Safe classification of the listener failure.
   */
  public constructor(public readonly code: keyof typeof configurationMessages) {
    super(configurationMessages[code]);
    this.name = 'WorkerExchangeListenerConfigurationError';
  }
}

/** Native listener owned by runtime boot. @internal */
export interface WorkerExchangeListener {
  readonly address: TransportReadyInfo;
  close(): Promise<void>;
}

/**
 * Validate boot policy before either platform opens a listener.
 * @param options - Shared boot options.
 * @returns The configuration if the supported exchange is enabled.
 * @internal
 */
export function readSingleHostWorkerExchange(options: CoreBootOptions): SingleHostWorkerExchangeOptions | undefined {
  const exchange = options.singleHostWorkerExchange;
  if (exchange === undefined) return undefined;
  if (options.workerExchangeTest !== undefined) {
    throw new WorkerExchangeListenerConfigurationError('conflicting-options');
  }
  const { listen, security } = exchange;
  checkListenerSecurity(security);
  if (
    typeof listen?.host !== 'string' ||
    listen.host.trim() === '' ||
    !Number.isInteger(listen.port) ||
    listen.port < 0 ||
    listen.port > 65535
  ) {
    throw new WorkerExchangeListenerConfigurationError('invalid-bind');
  }
  if (typeof options.workerDispatch?.source.readRedemptionCredentials !== 'function') {
    throw new WorkerExchangeListenerConfigurationError('dispatch-required');
  }
  return exchange;
}

/**
 * Reject unprotected binds and invalid native TLS credentials before opening a socket.
 * @param security - Protection declared by the boot caller.
 */
function checkListenerSecurity(security: WorkerExchangeListenerSecurity | undefined): void {
  if (
    !(
      (security?.kind === 'tls' && typeof security.cert === 'string' && typeof security.key === 'string') ||
      (security?.kind === 'verified-ingress' && typeof security.verifyIngress === 'function')
    )
  ) {
    throw new WorkerExchangeListenerConfigurationError('protection-required');
  }
  if (security.kind === 'tls') checkTlsCredentials(security);
}

/**
 * Check the leaf and key as a pair before letting TLS assign them to algorithm slots.
 * @param credentials - PEM chain and signing key for the exchange listener.
 */
function checkTlsCredentials({ cert, key }: Extract<WorkerExchangeListenerSecurity, { kind: 'tls' }>): void {
  try {
    assert(new X509Certificate(cert).checkPrivateKey(createPrivateKey(key)));
    createSecureContext({ cert, key });
  } catch {
    throw new WorkerExchangeListenerConfigurationError('invalid-tls');
  }
}
