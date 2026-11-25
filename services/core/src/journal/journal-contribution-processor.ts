import type { AccountResolverContribution, EdgeName, InboundEdgeContribution } from '@makaio/contracts';
import { ContributionNameSchema, localContributionName, MakaioError } from '@makaio/core';
import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import type { SubjectDirectory } from './subject-directory.js';

type JournalActivationErrorCode =
  | 'invalid-contribution-name'
  | 'name-not-owned'
  | 'subject-not-recorded'
  | 'duplicate-edge'
  | 'duplicate-reader'
  | 'reader-owner-conflict'
  | 'duplicate-account-resolver';

/** Invalid journal contribution declaration. */
export class JournalActivationError extends MakaioError {
  /**
   * @param code - Machine-readable activation failure.
   * @param extension - Declaring extension.
   * @param contribution - Name of the failing contribution.
   * @param reason - Details of the failure.
   */
  public constructor(
    public readonly code: JournalActivationErrorCode,
    public readonly extension: string,
    public readonly contribution: string,
    reason: string,
  ) {
    super(`${code}: extension "${extension}", contribution "${contribution}": ${reason}`);
  }
}

interface JournalContributions {
  readonly edges: ReadonlyMap<EdgeName, InboundEdgeContribution>;
  readonly resolver?: AccountResolverContribution;
  hasExtension?: KernelExtensionContext['hasExtension'];
}

/**
 * Validate a journal contribution name against the manifest's owner.
 * @param extension - Declaring extension.
 * @param contribution - Edge or resolver name.
 */
function validateName(extension: string, contribution: string): void {
  if (!ContributionNameSchema.safeParse(contribution).success) {
    throw new JournalActivationError('invalid-contribution-name', extension, contribution, 'Expected an owned name');
  }
  if (localContributionName(extension, contribution) === undefined) {
    throw new JournalActivationError(
      'name-not-owned',
      extension,
      contribution,
      'Contribution belongs to another owner',
    );
  }
}

/** Stages inbound edges and account resolvers alongside their owners' lifecycle. */
export class JournalContributionProcessor implements ContributionProcessor {
  private readonly contributions = new Map<string, JournalContributions>();

  /**
   * Register this processor after the subject directory so their staging order matches their dependencies.
   * @param directory - Directory providing staged subject declarations.
   */
  public constructor(private readonly directory: SubjectDirectory) {}

  /**
   * Select extensions declaring journal contributions for publication.
   * @param pkg - Manifest supplied by the coordinator.
   * @returns Whether this extension contributes edges or a resolver.
   */
  public filter(pkg: KernelMakaioExtension): boolean {
    return Boolean(pkg.edges?.length || pkg.accountResolver);
  }

  /**
   * Validate and stage the extension's journal contributions as a unit.
   * @param name - Declaring extension.
   * @param pkg - Manifest supplied by the coordinator.
   */
  public processActivating(name: string, pkg: KernelMakaioExtension): void {
    if (!this.filter(pkg)) return;

    const edges = new Map<EdgeName, InboundEdgeContribution>();
    for (const edge of pkg.edges ?? []) {
      validateName(name, edge.edge);
      if (edges.has(edge.edge) || [...this.contributions.values()].some((staged) => staged.edges.has(edge.edge))) {
        throw new JournalActivationError('duplicate-edge', name, edge.edge, 'Edge name is already declared');
      }
      for (const subject of edge.subjects) {
        const entry = this.directory.stagedSubjectFor(subject);
        if (entry?.extension !== name) {
          throw new JournalActivationError(
            'name-not-owned',
            name,
            edge.edge,
            `Subject "${subject}" is not owned by the extension`,
          );
        }
        if (entry.type !== 'event' || entry.retention !== 'recorded') {
          throw new JournalActivationError(
            'subject-not-recorded',
            name,
            edge.edge,
            `Subject "${subject}" is not recorded`,
          );
        }
      }
      edges.set(edge.edge, {
        ...edge,
        subjects: [...edge.subjects],
        ...(edge.objectTypes && { objectTypes: [...edge.objectTypes] }),
      });
    }

    const resolver = pkg.accountResolver;
    if (resolver) {
      validateName(name, resolver.resolver);
      for (const [owner, staged] of this.contributions) {
        if (staged.resolver) {
          throw new JournalActivationError(
            'duplicate-account-resolver',
            name,
            resolver.resolver,
            `Extension "${owner}" already declares a resolver`,
          );
        }
      }
    }

    this.contributions.set(name, { edges, resolver });
  }

  /**
   * Make staged contributions available when their owner becomes active.
   * @param name - Declaring extension.
   * @param _pkg - Manifest supplied by the coordinator.
   * @param ctx - Extension context providing the live activation check.
   */
  public async processActivated(name: string, _pkg: KernelMakaioExtension, ctx: KernelExtensionContext): Promise<void> {
    const staged = this.contributions.get(name);
    if (staged) staged.hasExtension = ctx.hasExtension;
  }

  /**
   * Withdraw all journal contributions on stop or rollback.
   * @param name - Extension being stopped or rolled back.
   */
  public async processStopped(name: string): Promise<void> {
    this.contributions.delete(name);
  }

  /**
   * Find an edge belonging to an active extension.
   * @param extension - Edge owner.
   * @param edgeName - Full edge name.
   * @returns The live definition, if present.
   */
  public edgeFor(extension: string, edgeName: EdgeName): InboundEdgeContribution | undefined {
    const staged = this.contributions.get(extension);
    return staged?.hasExtension?.(extension) ? staged.edges.get(edgeName) : undefined;
  }

  /**
   * Find an extension's edge for cursor reads, including during service startup.
   * @param extension - Edge owner.
   * @param edgeName - Full edge name.
   * @returns The staged or live definition, if present.
   */
  public stagedEdgeFor(extension: string, edgeName: EdgeName): InboundEdgeContribution | undefined {
    return this.contributions.get(extension)?.edges.get(edgeName);
  }

  /**
   * Find the account resolver supplied by an active extension, if any.
   * @returns The live resolver contribution.
   */
  public accountResolver(): AccountResolverContribution | undefined {
    for (const [name, staged] of this.contributions) {
      if (staged.resolver && staged.hasExtension?.(name)) return staged.resolver;
    }
    return undefined;
  }
}
