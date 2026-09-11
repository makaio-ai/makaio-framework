import {
  ARTIFACT_COLLECTION_ELEMENT_SEGMENT,
  artifactPatchFilterName,
  artifactPatchInstructions,
  artifactPatchSegments,
  defineOwnValue,
  inspectArtifactDataLocation,
  isJsonObject,
  jsonEquals,
  ownValue,
  readPropertyPath,
  type ArtifactPatchArrayFilter,
  type ArtifactPatchDocument,
  type ArtifactPatchError,
  type ArtifactPatchOperationResult,
  type ArtifactPatchOperator,
  type ArtifactPatchSegment,
  type ArtifactSchemaFragment,
} from '@makaio/contracts';

/** A patched payload together with what each instruction changed. */
export interface ArtifactPatchApplication {
  /** The patched payload, detached from the revision it was derived from. */
  readonly data: Record<string, unknown>;
  /** One entry per applied instruction, in application order. */
  readonly operations: readonly ArtifactPatchOperationResult[];
}

/** Relaxations of the declaration rule that only a migration may ask for. */
export interface ArtifactPatchApplyOptions {
  /**
   * Let `$unset` remove a property the schema does not declare. Set when the
   * patch migrates to another schema version: a property the target dropped is
   * exactly what the caller has to remove, and the target schema's validation
   * of the completed payload decides whether the result is acceptable.
   */
  readonly allowUndeclaredRemovals?: boolean;
}

/** Outcome of applying a patch document to one payload. */
export type ArtifactPatchApplicationResult =
  | { readonly ok: true; readonly application: ArtifactPatchApplication }
  | { readonly ok: false; readonly error: ArtifactPatchError };

/**
 * One place a terminal instruction operates on, resolved against the payload.
 *
 * The two variants are the only shapes a resolved place can have, so an
 * operator never has to re-derive whether it holds a property or an element.
 */
type PatchTarget =
  | { readonly kind: 'property'; readonly container: Record<string, unknown>; readonly key: string }
  | { readonly kind: 'element'; readonly container: unknown[]; readonly index: number };

/** Compiled equality conditions for one array filter placeholder. */
type CompiledFilter = readonly { readonly path: readonly string[]; readonly operand: unknown }[];

/**
 * Reduce a patch path to the location shape the kind schema declares.
 *
 * A position and a filter select the same declared item schema, so both become
 * the shared element token before the declaration is checked.
 * @param segments - Classified path segments.
 * @returns Segments with every element selector replaced by the element token.
 */
function toSchemaLocation(segments: readonly ArtifactPatchSegment[]): string[] {
  return segments.map((segment) => (segment.kind === 'property' ? segment.name : ARTIFACT_COLLECTION_ELEMENT_SEGMENT));
}

/**
 * Decide whether every schema variant declares an array at a location.
 * @param fragments - Schema fragments covering the location.
 * @returns Whether all of them declare an array.
 */
function declaresArray(fragments: readonly ArtifactSchemaFragment[]): boolean {
  return (
    fragments.length > 0 && fragments.every((fragment) => typeof fragment !== 'boolean' && fragment.type === 'array')
  );
}

/**
 * Compile one array filter into its equality conditions.
 *
 * Every key starts with the placeholder name, so dropping the first part
 * leaves the path relative to the element — empty for the bare name, which
 * compares the element itself.
 * @param filter - Filter entry as written by the caller.
 * @returns Property paths relative to the element and their expected values.
 */
function compileFilter(filter: ArtifactPatchArrayFilter): CompiledFilter {
  return Object.entries(filter).map(([key, operand]) => ({ path: key.split('.').slice(1), operand }));
}

/**
 * Index the declared array filters by the placeholder each one binds.
 * @param patch - Patch document already accepted by its schema.
 * @returns Compiled conditions keyed by placeholder name.
 */
function compileFilters(patch: ArtifactPatchDocument): ReadonlyMap<string, CompiledFilter> {
  const compiled = new Map<string, CompiledFilter>();
  for (const filter of patch.arrayFilters ?? []) {
    // The document schema already rejected a filter binding none or several names.
    const name = artifactPatchFilterName(filter);
    if (name !== undefined) compiled.set(name, compileFilter(filter));
  }
  return compiled;
}

/**
 * Decide whether one collection element satisfies a filter.
 * @param element - Candidate element.
 * @param conditions - Compiled equality conditions.
 * @returns Whether every condition holds.
 */
function matchesFilter(element: unknown, conditions: CompiledFilter): boolean {
  return conditions.every(({ path, operand }) => jsonEquals(readPropertyPath(element, path), operand));
}

/**
 * Decide whether one collection element satisfies a `$pull` condition.
 *
 * An object condition matches by its declared fields, as in Mongo, so removing
 * an entry does not require reproducing the whole element. Any other condition
 * compares the element itself.
 * @param element - Candidate element.
 * @param condition - Condition written by the caller.
 * @returns Whether the element is selected for removal.
 */
function matchesPullCondition(element: unknown, condition: unknown): boolean {
  if (!isJsonObject(condition)) return jsonEquals(element, condition);
  if (!isJsonObject(element)) return false;
  return Object.entries(condition).every(([key, operand]) => jsonEquals(ownValue(element, key), operand));
}

/**
 * Resolve the places one segment addresses inside a set of containers.
 *
 * This is the single traversal rule: every step of a path and the terminal
 * step alike are resolved here, so an intermediate segment can never disagree
 * with the last one about what it addresses.
 * @param containers - Values the previous segment resolved to.
 * @param segment - Classified segment to resolve.
 * @param filters - Compiled conditions by placeholder name.
 * @param requireExisting - Whether an object property must already be present.
 * @returns Addressed places, empty when the segment selects nothing.
 */
function resolveTargets(
  containers: readonly unknown[],
  segment: ArtifactPatchSegment,
  filters: ReadonlyMap<string, CompiledFilter>,
  requireExisting: boolean,
): PatchTarget[] {
  const targets: PatchTarget[] = [];
  for (const container of containers) {
    if (segment.kind === 'property') {
      if (!isJsonObject(container)) continue;
      if (requireExisting && !Object.hasOwn(container, segment.name)) continue;
      targets.push({ kind: 'property', container, key: segment.name });
      continue;
    }
    if (!Array.isArray(container)) continue;
    if (segment.kind === 'index') {
      if (segment.index < container.length) targets.push({ kind: 'element', container, index: segment.index });
      continue;
    }
    const conditions = filters.get(segment.placeholder) ?? [];
    container.forEach((element, index) => {
      if (matchesFilter(element, conditions)) targets.push({ kind: 'element', container, index });
    });
  }
  return targets;
}

/**
 * Read the value a resolved target currently holds.
 * @param target - Resolved place within a container.
 * @returns The current value, or undefined when the place is empty.
 */
function readTarget(target: PatchTarget): unknown {
  return target.kind === 'property' ? ownValue(target.container, target.key) : target.container[target.index];
}

/**
 * Write a value into a resolved target.
 * @param target - Resolved place within a container.
 * @param value - JSON value to store.
 */
function writeTarget(target: PatchTarget, value: unknown): void {
  if (target.kind === 'property') defineOwnValue(target.container, target.key, value);
  else target.container[target.index] = value;
}

/**
 * Walk a payload down to the containers holding the addressed terminal segment.
 * @param data - Payload being patched.
 * @param segments - Classified segments above the terminal one.
 * @param filters - Compiled conditions by placeholder name.
 * @returns Containers reached along the path, or the segment that stopped the walk.
 */
function resolveContainers(
  data: Record<string, unknown>,
  segments: readonly ArtifactPatchSegment[],
  filters: ReadonlyMap<string, CompiledFilter>,
):
  | { readonly ok: true; readonly containers: readonly unknown[] }
  | { readonly ok: false; readonly segment: ArtifactPatchSegment } {
  let containers: readonly unknown[] = [data];
  for (const segment of segments) {
    const targets = resolveTargets(containers, segment, filters, true);
    if (targets.length === 0) return { ok: false, segment };
    // A property and a position each address exactly one place per container, so
    // resolving fewer of them than there are containers means a selected branch
    // could not be traversed. Traversal is all-or-nothing across the selected
    // branches: continuing would apply the instruction to a subset and report
    // that partial write as a complete one. Only a filter may legitimately
    // select a different number of places than it was offered containers.
    if (segment.kind !== 'filter' && targets.length < containers.length) return { ok: false, segment };
    containers = targets.map(readTarget);
  }
  return { ok: true, containers };
}

/**
 * Spell one segment the way the caller wrote it.
 * @param segment - Classified path segment.
 * @returns The segment's original text.
 */
function segmentText(segment: ArtifactPatchSegment): string {
  if (segment.kind === 'property') return segment.name;
  return segment.kind === 'index' ? String(segment.index) : `$[${segment.placeholder}]`;
}

/**
 * Describe a rejected instruction.
 * @param code - Stable failure classification.
 * @param operator - Operator whose instruction failed.
 * @param path - Path that failed.
 * @param message - Human-readable explanation.
 * @param repair - Concrete next step that would make the same request succeed.
 * @returns Structured rejection for the response.
 */
function patchError(
  code: ArtifactPatchError['code'],
  operator: ArtifactPatchOperator,
  path: string,
  message: string,
  repair: string,
): ArtifactPatchError {
  return { code, message, operator, path, repair };
}

/**
 * Describe an instruction that addressed nothing.
 *
 * Mongo would treat this as a no-op. Here it is a failure, because a write that
 * silently changed nothing is indistinguishable from one that succeeded.
 * @param operator - Operator whose instruction addressed nothing.
 * @param path - Path that addressed nothing.
 * @param message - Human-readable explanation.
 * @returns Structured rejection for the response.
 */
function noMatch(operator: ArtifactPatchOperator, path: string, message: string): ArtifactPatchError {
  return patchError(
    'NO_MATCH',
    operator,
    path,
    message,
    'Addressing nothing is a failure, not a silent no-op: check the match values against the current revision.',
  );
}

/**
 * Apply one `$set` instruction.
 *
 * A declared property that this revision does not carry is introduced rather
 * than treated as a miss, because optional absence is a valid instance state.
 * Each target receives its own copy, so two matched entries never end up
 * sharing one value.
 * @param targets - Addressed places.
 * @param value - Value to store at each of them.
 * @returns Number of changed places.
 */
function applySet(targets: readonly PatchTarget[], value: unknown): number {
  for (const target of targets) writeTarget(target, structuredClone(value));
  return targets.length;
}

/**
 * Apply one `$unset` instruction.
 *
 * Targets were resolved with the existence requirement, so each one names a
 * property the revision carries.
 * @param targets - Addressed object properties.
 * @returns Number of removed properties.
 */
function applyUnset(targets: readonly PatchTarget[]): number {
  for (const target of targets) {
    if (target.kind === 'property') Reflect.deleteProperty(target.container, target.key);
  }
  return targets.length;
}

/**
 * Apply one `$push` instruction.
 *
 * A declared collection that this revision does not carry is created, as Mongo
 * does, so appending the first entry does not need a separate write.
 * @param targets - Addressed collections.
 * @param value - Element to append to each of them.
 * @returns Number of changed collections, or undefined when a target is not a collection.
 */
function applyPush(targets: readonly PatchTarget[], value: unknown): number | undefined {
  for (const target of targets) {
    const current = readTarget(target);
    if (current === undefined) {
      writeTarget(target, [structuredClone(value)]);
      continue;
    }
    if (!Array.isArray(current)) return undefined;
    current.push(structuredClone(value));
  }
  return targets.length;
}

/**
 * Apply one `$pull` instruction.
 * @param targets - Addressed collections.
 * @param condition - Condition selecting the elements to remove.
 * @returns Number of removed elements, or undefined when a target is not a collection.
 */
function applyPull(targets: readonly PatchTarget[], condition: unknown): number | undefined {
  let removed = 0;
  for (const target of targets) {
    const current = readTarget(target);
    if (!Array.isArray(current)) return undefined;
    const retained = current.filter((element) => !matchesPullCondition(element, condition));
    removed += current.length - retained.length;
    current.splice(0, current.length, ...retained);
  }
  return removed;
}

/**
 * Dispatch one instruction to its operator implementation.
 * @param operator - Operator being applied.
 * @param targets - Addressed places.
 * @param operand - Value or condition written by the caller.
 * @returns Number of changed places, or undefined when a target has the wrong shape.
 */
function applyOperator(
  operator: ArtifactPatchOperator,
  targets: readonly PatchTarget[],
  operand: unknown,
): number | undefined {
  switch (operator) {
    case '$set':
      return applySet(targets, operand);
    case '$unset':
      return applyUnset(targets);
    case '$push':
      return applyPush(targets, operand);
    case '$pull':
      return applyPull(targets, operand);
  }
}

/**
 * Reject an instruction whose operator cannot address the segment it names.
 * @param operator - Operator being applied.
 * @param terminal - Classified terminal segment.
 * @param path - Complete patch path.
 * @returns A rejection, or undefined when the target shape is supported.
 */
function unsupportedTarget(
  operator: ArtifactPatchOperator,
  terminal: ArtifactPatchSegment,
  path: string,
): ArtifactPatchError | undefined {
  if (terminal.kind === 'property') return undefined;
  if (operator === '$unset') {
    return patchError(
      'UNSUPPORTED_TARGET',
      operator,
      path,
      `$unset addresses object properties; '${path}' addresses a collection entry.`,
      'Remove a collection entry with $pull instead of $unset.',
    );
  }
  if (operator === '$push' || operator === '$pull') {
    return patchError(
      'UNSUPPORTED_TARGET',
      operator,
      path,
      `${operator} addresses a collection; '${path}' addresses one of its entries.`,
      `Point ${operator} at the collection itself, without the trailing entry selector.`,
    );
  }
  return undefined;
}

/**
 * Check that the kind schema declares the location an instruction addresses.
 * @param dataSchema - Serialized artifact data schema.
 * @param operator - Operator being applied.
 * @param path - Complete patch path.
 * @param segments - Classified path segments.
 * @returns A rejection, or undefined when the location is declared as required.
 */
function checkDeclaration(
  dataSchema: Record<string, unknown>,
  operator: ArtifactPatchOperator,
  path: string,
  segments: readonly ArtifactPatchSegment[],
): ArtifactPatchError | undefined {
  const fragments = inspectArtifactDataLocation(dataSchema, toSchemaLocation(segments));
  if (fragments === undefined) {
    return patchError(
      'PATH_NOT_DECLARED',
      operator,
      path,
      `The artifact kind does not declare '${path}'.`,
      'Correct the path to one the kind schema declares; a misspelled field is never created.',
    );
  }
  if ((operator === '$push' || operator === '$pull') && !declaresArray(fragments)) {
    return patchError(
      'TARGET_NOT_A_COLLECTION',
      operator,
      path,
      `The artifact kind declares '${path}' as something other than a collection.`,
      `Use $set to replace '${path}', or point ${operator} at a declared collection.`,
    );
  }
  return undefined;
}

/**
 * Apply one instruction to the payload.
 * @param data - Payload being patched in place.
 * @param instruction - Operator, path and operand written by the caller.
 * @param filters - Compiled conditions by placeholder name.
 * @param dataSchema - Serialized artifact data schema.
 * @param options - Relaxations that only a migration may ask for.
 * @returns What the instruction changed, or why it was rejected.
 */
function applyInstruction(
  data: Record<string, unknown>,
  instruction: { readonly operator: ArtifactPatchOperator; readonly path: string; readonly value: unknown },
  filters: ReadonlyMap<string, CompiledFilter>,
  dataSchema: Record<string, unknown>,
  options: ArtifactPatchApplyOptions,
): ArtifactPatchOperationResult | ArtifactPatchError {
  const { operator, path, value } = instruction;
  const segments = artifactPatchSegments(path);
  const terminal = segments.at(-1);
  // The path grammar guarantees at least one segment.
  if (terminal === undefined) return noMatch(operator, path, `'${path}' addresses nothing.`);

  // The operator/target mismatch is the more specific diagnosis, so it is
  // reported before the declaration of the location it could never address.
  const unsupported = unsupportedTarget(operator, terminal, path);
  if (unsupported) return unsupported;
  const declaration = checkDeclaration(dataSchema, operator, path, segments);
  // A migration removes what the target schema no longer declares: the old
  // property is exactly the location the target cannot name, and refusing it
  // would make every destructive migration impossible. Only `$unset` qualifies:
  // pulling entries from an undeclared collection leaves the collection the
  // target refuses, so the collection itself is what has to go. The removal
  // still has to address something the revision carries; resolution below is
  // unchanged, and the target schema judges the completed payload.
  const removesUndeclared =
    options.allowUndeclaredRemovals === true && declaration?.code === 'PATH_NOT_DECLARED' && operator === '$unset';
  if (declaration && !removesUndeclared) return declaration;

  const containers = resolveContainers(data, segments.slice(0, -1), filters);
  if (!containers.ok) {
    const stopped = segmentText(containers.segment);
    return containers.segment.kind === 'property'
      ? patchError(
          'PATH_NOT_RESOLVABLE',
          operator,
          path,
          `This revision has no value at '${stopped}' along '${path}'.`,
          `Set the value at '${stopped}' before addressing anything below it.`,
        )
      : noMatch(operator, path, `'${stopped}' in '${path}' addressed no entry in this revision.`);
  }

  // $set introduces a declared-but-absent optional property, and $push creates a
  // declared-but-absent collection; the removing operators need something to remove.
  const requireExisting = operator === '$unset' || operator === '$pull';
  const targets = resolveTargets(containers.containers, terminal, filters, requireExisting);
  if (targets.length === 0) return noMatch(operator, path, `'${path}' addressed no entry in this revision.`);
  // The same all-or-nothing rule the walk applies, for the last step: a terminal
  // position missing from one of the selected collections would otherwise change
  // the others and report the partial result as the whole instruction. Terminal
  // property narrowing is not a miss — $set and $push introduce the property in
  // every branch, and for $unset and $pull an absent property is already the
  // requested post-state.
  if (terminal.kind === 'index' && targets.length < containers.containers.length) {
    return noMatch(operator, path, `'${path}' addressed no entry in every selected collection of this revision.`);
  }

  const matched = applyOperator(operator, targets, value);
  if (matched === undefined) {
    return patchError(
      'TARGET_NOT_A_COLLECTION',
      operator,
      path,
      `The value at '${path}' is not a collection in this revision.`,
      `Use $set to replace '${path}', or point ${operator} at a collection.`,
    );
  }
  if (matched === 0) return noMatch(operator, path, `'${path}' changed nothing in this revision.`);
  return { operator, path, matched };
}

/**
 * Apply a complete patch document to one artifact payload.
 *
 * The payload is copied first, so a rejected patch leaves the caller's value
 * untouched and no partially applied result can escape. Instructions run in the
 * order {@link artifactPatchInstructions} reports, so the same document always
 * produces the same result.
 * @param data - Payload of the revision the patch was written against.
 * @param patch - Patch document already accepted by its schema.
 * @param dataSchema - Serialized data schema of the effective kind.
 * @param options - Relaxations that only a migration may ask for.
 * @returns The patched payload, or the first rejected instruction.
 */
export function applyArtifactPatch(
  data: Record<string, unknown>,
  patch: ArtifactPatchDocument,
  dataSchema: Record<string, unknown>,
  options: ArtifactPatchApplyOptions = {},
): ArtifactPatchApplicationResult {
  const draft = structuredClone(data);
  const filters = compileFilters(patch);
  const operations: ArtifactPatchOperationResult[] = [];
  for (const instruction of artifactPatchInstructions(patch)) {
    const outcome = applyInstruction(draft, instruction, filters, dataSchema, options);
    if ('code' in outcome) return { ok: false, error: outcome };
    operations.push(outcome);
  }
  return { ok: true, application: { data: draft, operations } };
}
