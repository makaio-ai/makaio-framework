import { isMintedCallContext } from '@makaio/bus-core';
import type {
  CredentialResolverContribution,
  RunCredentialBinding,
  RunCredentialPort,
} from '@makaio/contracts/credential';
import { ConfigError, MAKAIO_JOB_RUN_PARTY_KIND } from '@makaio/core';
import { abortableWait } from '@makaio/utils';
import { extensionGenerationSignal } from './extension-generation.js';
import type { ContributionProcessor, KernelHostContext, KernelMakaioExtension } from './types.js';

type ResolverActivation = {
  readonly generation: AbortSignal;
  readonly isActive: () => boolean;
};

type ResolverRegistration = {
  readonly owner: string;
  readonly contribution: CredentialResolverContribution;
  readonly resolve: CredentialResolverContribution['resolve'];
  readonly lifetime: AbortController;
  activation?: ResolverActivation;
};

const REFUSED = Object.freeze({ kind: 'purpose-not-granted' } as const);

/** A host tried to activate a second credential resolver. */
export class DuplicateCredentialResolverError extends ConfigError {
  public constructor() {
    super('A credential resolver is already declared.');
  }
}

/** Tracks the single credential resolver contributed by active extensions. */
export class CredentialResolverContributions<THostContext extends KernelHostContext = KernelHostContext>
  implements ContributionProcessor<THostContext>
{
  private registration?: ResolverRegistration;

  /** Host access to the active resolver and run binding. */
  public readonly hostAccess = Object.freeze({
    activeResolver: this.activeResolver.bind(this),
    bindRun: this.bindRun.bind(this),
  });

  /**
   * @param pkg - Declaring extension.
   * @returns Whether activation needs a resolver context.
   */
  public filter(pkg: KernelMakaioExtension<THostContext>): boolean {
    return pkg.credentialResolver !== undefined;
  }

  /**
   * Reserve the resolver slot while its declaring extension starts.
   * @param owner - Declaring extension.
   * @param pkg - Manifest supplied by the coordinator.
   */
  public processActivating(owner: string, pkg: KernelMakaioExtension<THostContext>): void {
    const contribution = pkg.credentialResolver;
    if (contribution === undefined) return;
    if (this.registration !== undefined) throw new DuplicateCredentialResolverError();
    this.registration = {
      owner,
      contribution,
      resolve: contribution.resolve.bind(contribution),
      lifetime: new AbortController(),
    };
  }

  /**
   * Publish the resolver for this activation only.
   * @param owner - Declaring extension.
   * @param _pkg - Manifest supplied by the coordinator.
   * @param ctx - Context of the activating extension.
   */
  public async processActivated(
    owner: string,
    _pkg: KernelMakaioExtension<THostContext>,
    ctx: THostContext,
  ): Promise<void> {
    const registration = this.registration;
    if (registration?.owner === owner) {
      registration.activation = Object.freeze({
        generation: extensionGenerationSignal(ctx.identity),
        isActive: () => ctx.hasExtension(owner),
      });
    }
  }

  /**
   * Withdraw the resolver on stop or activation rollback.
   * @param owner - Stopped extension.
   */
  public async processStopped(owner: string): Promise<void> {
    this.withdraw(owner);
  }

  /**
   * End the registration synchronously before the rest of extension teardown.
   * @param owner - Stopped extension.
   */
  public withdraw(owner: string): void {
    const registration = this.registration;
    if (registration?.owner !== owner) return;
    this.registration = undefined;
    registration.lifetime.abort();
  }

  /**
   * @returns The current contribution for an authorized journal write.
   */
  public activeResolver(): CredentialResolverContribution | undefined {
    const registration = this.registration;
    return this.isCurrent(registration, registration?.activation) ? registration?.contribution : undefined;
  }

  /**
   * Tie a port to a checked booking and the current resolver activation.
   * @param binding - The authenticated run, booked scopes and owner-managed lifetime.
   * @returns A port which refuses requests outside that binding.
   */
  public bindRun(binding: RunCredentialBinding): RunCredentialPort {
    const { call, requester, signal: lifetime } = Object.freeze({ ...binding });
    const scopes = Object.freeze(binding.scopes.map((scope) => Object.freeze({ ...scope })));
    const authenticated = isMintedCallContext(call) && call.caller.kind === MAKAIO_JOB_RUN_PARTY_KIND;
    const registration = authenticated ? this.registration : undefined;
    const activation = registration?.activation;

    const current = (): boolean => !lifetime.aborted && this.isCurrent(registration, activation);

    return Object.freeze<RunCredentialPort>({
      modelScope: (target) => {
        if (!current()) return undefined;
        const matches = scopes.filter((scope) => scope.baseEquipment === 'model' && scope.target === target);
        return matches.length === 1 ? matches[0] : undefined;
      },
      withCredential: async (requestCall, scope, signal, effect) => {
        if (requestCall !== call || registration === undefined || activation === undefined) return REFUSED;
        const { purpose, target } = Object.freeze({ ...scope });
        if (!scopes.some((allowed) => allowed.purpose === purpose && allowed.target === target)) return REFUSED;

        const requestSignal = AbortSignal.any([lifetime, signal, activation.generation, registration.lifetime.signal]);
        const isCurrent = (): boolean => !requestSignal.aborted && current();
        if (!isCurrent()) return REFUSED;
        const input = Object.freeze({ requester, purpose, target, signal: requestSignal });
        try {
          const resolution = registration.resolve(call, input).catch(() => undefined);
          const grant = await abortableWait(resolution, requestSignal);
          if (!isCurrent() || grant?.success !== true) return REFUSED;
          const value = await effect(grant.value, requestSignal);
          return isCurrent() ? { kind: 'granted', value, isCurrent } : REFUSED;
        } catch {
          return REFUSED;
        }
      },
    });
  }

  /**
   * Check the registration identity and activation generation at the point of use.
   * @param registration - Captured resolver registration.
   * @param activation - Captured activation containing the generation.
   * @returns Whether the captured registration is still active.
   */
  private isCurrent(
    registration: ResolverRegistration | undefined,
    activation: ResolverActivation | undefined,
  ): boolean {
    return (
      registration !== undefined &&
      activation !== undefined &&
      this.registration === registration &&
      registration.activation?.generation === activation.generation &&
      !activation.generation.aborted &&
      activation.isActive()
    );
  }
}
