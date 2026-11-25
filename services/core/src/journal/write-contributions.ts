import type { CredentialResolverContribution, JsonValue } from '@makaio/contracts';
import type { WriteParticipantContribution, WriterContribution } from '@makaio/contracts/journal';
import { ContributionNameSchema, localContributionName, MakaioError } from '@makaio/core';
import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import { compileJsonSchemaCheck } from '@makaio/contracts/shared';

/** A writer bound to its declaring extension and its compiled content schema. */
export interface RegisteredWriter {
  readonly owner: string;
  readonly contribution: WriterContribution;
  accepts(content: JsonValue): boolean;
}

interface WriteContributions {
  readonly writers: ReadonlyMap<string, RegisteredWriter>;
  readonly participants: ReadonlyMap<string, WriteParticipantContribution>;
  readonly credentialResolver?: CredentialResolverContribution;
  isActive?: () => boolean;
}

/**
 * Validate the name of a contribution.
 * @param owner - Declaring extension.
 * @param name - Full contribution name.
 */
function assertOwned(owner: string, name: string): void {
  if (!ContributionNameSchema.safeParse(name).success || localContributionName(owner, name) === undefined) {
    throw new MakaioError(`Invalid write contribution name "${name}" for extension "${owner}".`);
  }
}

/**
 * Compile one writer's content schema in isolation.
 * @param owner - Declaring extension.
 * @param contribution - Writer manifest entry.
 * @returns The validated registration.
 */
function registerWriter(owner: string, contribution: WriterContribution): RegisteredWriter {
  const validate = compileJsonSchemaCheck(contribution.contentSchema);
  return { owner, contribution, accepts: (content) => validate(content).valid };
}

/** Publishes typed journal write contributions on activation and withdraws them on stop. */
export class WriteContributionProcessor implements ContributionProcessor {
  private readonly entries = new Map<string, WriteContributions>();

  /**
   * @param pkg - Declaring extension.
   * @returns Whether the extension declares external write contributions.
   */
  public filter(pkg: KernelMakaioExtension): boolean {
    return Boolean(pkg.writers?.length || pkg.writeParticipants?.length || pkg.credentialResolver);
  }

  /**
   * Stage all contributions after validating names and rejecting duplicates.
   * @param owner - Declaring extension.
   * @param pkg - Declaring manifest.
   */
  public processActivating(owner: string, pkg: KernelMakaioExtension): void {
    const writers = new Map<string, RegisteredWriter>();
    const participants = new Map<string, WriteParticipantContribution>();
    const staged = [...this.entries.values()];
    for (const writer of pkg.writers ?? []) {
      assertOwned(owner, writer.writer);
      if (writers.has(writer.writer) || staged.some((entry) => entry.writers.has(writer.writer))) {
        throw new MakaioError(`Duplicate writer "${writer.writer}".`);
      }
      writers.set(writer.writer, registerWriter(owner, writer));
    }
    for (const participant of pkg.writeParticipants ?? []) {
      assertOwned(owner, participant.name);
      if (participants.has(participant.name) || staged.some((entry) => entry.participants.has(participant.name))) {
        throw new MakaioError(`Duplicate write participant "${participant.name}".`);
      }
      participants.set(participant.name, { name: participant.name, prepare: participant.prepare.bind(participant) });
    }
    if (pkg.credentialResolver && staged.some((entry) => entry.credentialResolver)) {
      throw new MakaioError('A credential resolver is already declared.');
    }
    this.entries.set(owner, { writers, participants, credentialResolver: pkg.credentialResolver });
  }

  /**
   * Attach the coordinator's live activation check.
   * @param owner - Declaring extension.
   * @param _pkg - Declaring manifest.
   * @param ctx - Activating extension context.
   */
  public async processActivated(
    owner: string,
    _pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void> {
    const entry = this.entries.get(owner);
    if (entry) entry.isActive = () => ctx.hasExtension(owner);
  }

  /**
   * Withdraw all contributions of an extension on stop or activation rollback.
   * @param owner - Declaring extension.
   */
  public async processStopped(owner: string): Promise<void> {
    this.entries.delete(owner);
  }

  /**
   * @param name - Full writer name.
   * @returns The writer from the active extension, if present.
   */
  public writer(name: string): RegisteredWriter | undefined {
    for (const entry of this.entries.values()) {
      const writer = entry.writers.get(name);
      if (writer && entry.isActive?.()) return writer;
    }
    return undefined;
  }

  /**
   * @param owner - Extension that created the intent.
   * @param name - Full participant name.
   * @returns An active participant owned by the extension, if present.
   */
  public participant(owner: string, name: string): WriteParticipantContribution | undefined {
    const entry = this.entries.get(owner);
    return entry?.isActive?.() ? entry.participants.get(name) : undefined;
  }

  /**
   * @returns The active resolver, if present.
   */
  public credentialResolver(): CredentialResolverContribution | undefined {
    for (const entry of this.entries.values()) {
      if (entry.credentialResolver && entry.isActive?.()) return entry.credentialResolver;
    }
    return undefined;
  }
}
