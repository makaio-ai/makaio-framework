import {
  type Condition,
  type ConditionFinding,
  type FieldCondition,
  isJsonObject,
  type JsonSchema,
  jsonValueType,
  ownValue,
} from '@makaio/contracts/shared';
import { compile } from '@makaio/expression';
import { childPath, isAtOrBelow } from './condition-path.js';
import { matchesOperator, parseDateTime } from './evaluator.js';
import {
  describeSchemaValue,
  resolveSchemaPath,
  type SchemaValueDescription,
  type SchemaValueType,
} from './schema-path.js';

/**
 * Input of {@link validateCondition}.
 */
export interface ValidateConditionInput {
  /** Condition to check. */
  condition: Condition;
  /**
   * JSON Schema of the evaluation context object the condition reads. A field path resolves
   * from it like any deeper path: the first segment is known when `properties` lists it
   * (through `$ref`, `allOf`, `anyOf`) and optional unless `required` lists it. A first
   * segment `properties` does not list follows `additionalProperties`: `false` reports
   * `unknown-root`; a schema reports its type; `true` admits it as an optional field of
   * unknown type. A missing `additionalProperties` is open when the schema has no
   * `properties` and closed when it has (the first segment is then reported as
   * `unknown-root`), the same rule as at every deeper level.
   */
  context: JsonSchema;
}

/**
 * Where a field path leads, from the condition's point of view. `optionalPaths` lists the
 * prefixes of the field path (the path itself included) whose own step is optional, shortest
 * first; the field is absent exactly when one of them is.
 */
type FieldResolution =
  | { kind: 'unknown-root'; root: string }
  | { kind: 'unknown-path' }
  | { kind: 'open'; optionalPaths: readonly string[] }
  | { kind: 'known'; optionalPaths: readonly string[]; value: SchemaValueDescription };

/**
 * Field types an operator needs, for operators whose operand does not decide the type.
 * The field fits when it admits at least one of them.
 *
 * `$empty` asks about emptiness, which numbers and booleans do not have, so it is a
 * `type-mismatch` on them for both operands; `$empty: false` there means `$exists: true`,
 * and the message says so.
 */
const FIELD_TYPES_BY_OPERATOR: Readonly<Record<string, readonly SchemaValueType[]>> = {
  $contains: ['array'],
  $containsPrefix: ['array'],
  $startsWith: ['string'],
  $endsWith: ['string'],
  $glob: ['string'],
  $empty: ['string', 'array', 'object', 'null'],
};

/**
 * An operand the path to a leaf depends on: it has to reach `want` for the leaf's result to
 * decide the root.
 */
interface Partner {
  /** The operand subtree. */
  condition: Condition;
  /** Result the operand has to reach. */
  want: boolean;
}

/**
 * Context carried while walking the condition tree.
 */
interface Scope {
  /** Result the node has to reach for the root to match; `$not` flips it. */
  want: boolean;
  /**
   * Operands of every enclosing conjunction (an `$and` while `want` is true, an `$or` while
   * it is false), without the branch the walk is in. Operands of an enclosing disjunction
   * are not partners: the root can match through another one.
   */
  partners: readonly Partner[];
}

/**
 * Check a condition against the schemas of the values it reads, before it is activated.
 *
 * Findings, in tree order:
 * - `unknown-root` (error): the context schema does not admit a field's first segment.
 * - `unknown-path` (error): a closed schema does not admit the field path. Under an open
 *   schema every path is admitted.
 * - `type-mismatch` (error): the operator or its operand does not fit the field's type.
 *   Skipped when the type is unknown.
 * - `unguarded-negation` (error): a field condition on an optional field gives the result the
 *   root needs from it when the field is absent (`$ne`, `$nin`, or any other operator under
 *   `$not`), and every operand of every enclosing conjunction (an `$and` while the root needs
 *   `true`, an `$or` while it needs `false`; `$not` flips the need) can reach its needed result
 *   with that field absent. Operands of enclosing disjunctions impose nothing, so a match
 *   through an unrelated `$or` branch does not count. A nested field is absent when any
 *   optional prefix of its path is absent, so the check runs per optional prefix: a guard
 *   on the field, or on a path below the prefix, protects against that prefix; the finding
 *   stays only when some optional prefix is covered by no operand. A `{ $exists: true }` on
 *   the field in an enclosing `$and`, at any position, covers every prefix, so it rules the
 *   finding out, and so does any other operand that fails on an absent field. A guard on an
 *   ancestor covers only the prefixes at or above it. A field required on every step of its
 *   path needs no guard. A leaf whose operator is `$exists` is never reported: it asks about presence
 *   explicitly, so `{ $exists: false }` and `$not { $exists: true }` are valid.
 * - `expression-syntax` (error): an `$expr` does not compile.
 * - `expression-unchecked` (warning): an `$expr` compiles; it is not checked against the
 *   schemas.
 *
 * Finding paths use the notation of evaluation errors: `$and[1].$not.$expr`, or
 * `$or[0].field` / `$or[0].operator` for a field condition. The check is pure, deterministic
 * and never throws.
 * @param input - Condition and the JSON Schema of the evaluation context
 * @returns Findings; empty when the condition is fine
 */
export function validateCondition(input: ValidateConditionInput): ConditionFinding[] {
  const findings: ConditionFinding[] = [];
  visit(input.condition, '', { want: true, partners: [] }, input, findings);
  return findings;
}

/**
 * Thrown by {@link assertValidCondition} when a condition has error findings.
 */
export class ConditionValidationError extends Error {
  /** Every error-severity finding of the check, in tree order. */
  public readonly findings: readonly ConditionFinding[];

  /**
   * @param label - Caller's description of what was checked; the message prefix
   * @param findings - Error-severity findings of the check
   */
  public constructor(label: string, findings: readonly ConditionFinding[]) {
    const details = findings.map((finding) => `${finding.code} at '${finding.path}': ${finding.message}`).join('; ');
    super(`${label}: ${details}`);
    this.name = 'ConditionValidationError';
    this.findings = findings;
  }
}

/**
 * Check a condition like {@link validateCondition} and throw when it has error findings.
 *
 * The one place callers turn findings into a failure: a single {@link ConditionValidationError}
 * lists every error finding as `${label}: <code> at '<path>': <message>; ...`. Warnings do not
 * block activation; the caller reports them once, through its own logger.
 * @param input - Condition and the JSON Schema of the evaluation context
 * @param label - Message prefix naming what was checked, e.g. `Invalid span enricher rule condition in 'x'`
 * @returns The warning findings; empty when there are none
 * @throws When the check reports a finding with severity `error`, as a {@link ConditionValidationError}
 */
export function assertValidCondition(input: ValidateConditionInput, label: string): ConditionFinding[] {
  const findings = validateCondition(input);
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) throw new ConditionValidationError(label, errors);
  return findings.filter((finding) => finding.severity === 'warning');
}

/**
 * Check one node of the condition tree and its children.
 * @param condition - Node to check
 * @param path - Tree path of the node
 * @param scope - Wanted result and enclosing conjunction partners
 * @param input - Validation input
 * @param findings - Findings collected so far
 */
function visit(
  condition: Condition,
  path: string,
  scope: Scope,
  input: ValidateConditionInput,
  findings: ConditionFinding[],
): void {
  if ('$and' in condition) {
    visitOperands(condition.$and, childPath(path, '$and'), scope.want, scope, input, findings);
    return;
  }
  if ('$or' in condition) {
    visitOperands(condition.$or, childPath(path, '$or'), !scope.want, scope, input, findings);
    return;
  }
  if ('$not' in condition) {
    visit(condition.$not, childPath(path, '$not'), { ...scope, want: !scope.want }, input, findings);
    return;
  }
  if ('$expr' in condition) {
    findings.push(checkExpression(condition.$expr, childPath(path, '$expr')));
    return;
  }
  checkField(condition, path, scope, input, findings);
}

/**
 * Check the operands of an `$and` or `$or`. The operands are partners of one another when the
 * node is a conjunction under the wanted result: an `$and` while `true` is wanted, an `$or`
 * while `false` is wanted.
 * @param operands - Operands of the node
 * @param path - Tree path of the `$and` / `$or` key
 * @param isConjunction - Whether the node needs every operand to reach the wanted result
 * @param scope - Scope of the node
 * @param input - Validation input
 * @param findings - Findings collected so far
 */
function visitOperands(
  operands: readonly Condition[],
  path: string,
  isConjunction: boolean,
  scope: Scope,
  input: ValidateConditionInput,
  findings: ConditionFinding[],
): void {
  operands.forEach((child, index) => {
    const partners = isConjunction
      ? [
          ...scope.partners,
          ...operands.filter((_, other) => other !== index).map((condition) => ({ condition, want: scope.want })),
        ]
      : scope.partners;
    visit(child, `${path}[${index}]`, { want: scope.want, partners }, input, findings);
  });
}

/**
 * Check a field condition.
 * @param condition - Field condition
 * @param path - Tree path of the node
 * @param scope - Wanted result and enclosing conjunction partners
 * @param input - Validation input
 * @param findings - Findings collected so far
 */
function checkField(
  condition: FieldCondition,
  path: string,
  scope: Scope,
  input: ValidateConditionInput,
  findings: ConditionFinding[],
): void {
  const { field } = condition;
  const resolution = resolveField(field, input);

  if (resolution.kind === 'unknown-root') {
    const known = knownRoots(input.context).join(', ');
    findings.push(
      error(
        'unknown-root',
        childPath(path, 'field'),
        `Field "${field}" reads the unknown root "${resolution.root}"; known roots: ${known || 'none'}.`,
      ),
    );
    return;
  }
  if (resolution.kind === 'unknown-path') {
    findings.push(error('unknown-path', childPath(path, 'field'), `The schema does not admit the field "${field}".`));
    return;
  }

  const operatorPath = childPath(path, 'operator');
  const [name, operand] = operatorEntry(condition.operator);

  if (resolution.kind === 'known' && resolution.value.types !== undefined) {
    const mismatch =
      typeMismatch(name, operand, resolution.value.types, resolution.value.dateTime) ??
      itemMismatch(name, operand, field, input);
    if (mismatch !== undefined) {
      findings.push(error('type-mismatch', operatorPath, `Field "${field}": ${mismatch}`));
    }
  }

  if (
    name !== '$exists' &&
    matchesOperator(undefined, condition.operator) === scope.want &&
    resolution.optionalPaths.some((absentPath) =>
      scope.partners.every((partner) => canMatchWithAbsent(partner.condition, partner.want, absentPath)),
    )
  ) {
    findings.push(
      error(
        'unguarded-negation',
        operatorPath,
        `Field "${field}" is optional and the condition matches when it is absent; place ` +
          `{ field: "${field}", operator: { $exists: true } } in an enclosing $and.`,
      ),
    );
  }
}

/**
 * Resolve a field path against the context schema.
 * @param field - Dot-notation field path; the first segment is a property of the context
 * @param input - Validation input
 * @returns Where the path leads
 */
function resolveField(field: string, input: ValidateConditionInput): FieldResolution {
  const segments = field.split('.');
  const [root = ''] = segments;
  if (resolveSchemaPath(input.context, [root]).kind === 'unknown') return { kind: 'unknown-root', root };

  const resolution = resolveSchemaPath(input.context, segments);
  if (resolution.kind === 'unknown') return { kind: 'unknown-path' };
  const optionalPaths = resolution.optionalSteps.map((step) => segments.slice(0, step + 1).join('.'));
  if (resolution.kind === 'open') return { kind: 'open', optionalPaths };
  return {
    kind: 'known',
    optionalPaths,
    value: describeSchemaValue(resolution.schema, input.context),
  };
}

/**
 * Names the context schema lists in its own `properties`, for the `unknown-root` message.
 * @param context - Context schema
 * @returns Sorted property names
 */
function knownRoots(context: JsonSchema): string[] {
  const properties = ownValue(context, 'properties');
  return isJsonObject(properties) ? Object.keys(properties).sort() : [];
}

/**
 * Split a field operator into its name and operand. A bare scalar is `$eq`.
 * @param operator - Field operator
 * @returns Operator name and operand
 */
function operatorEntry(operator: FieldCondition['operator']): [string, unknown] {
  if (operator === null || typeof operator !== 'object') return ['$eq', operator];
  const [entry] = Object.entries(operator);
  return entry ?? ['', undefined];
}

/**
 * Whether a condition can evaluate to `want` while one path is absent. Field conditions on
 * the absent path or below it read an absent value and take the evaluator's own result on it;
 * every other operand (another field, an `$expr`) is free to take either result. `$and`, `$or` and `$not` combine
 * the operands the way evaluation does, so `$not` swaps the wanted result.
 * @param condition - Subtree to analyze
 * @param want - Result the subtree should reach
 * @param absentPath - Field path that is absent; everything below it is absent too
 * @returns Whether some values of the other operands let the subtree reach `want`
 */
function canMatchWithAbsent(condition: Condition, want: boolean, absentPath: string): boolean {
  if ('$and' in condition) {
    return want
      ? condition.$and.every((child) => canMatchWithAbsent(child, true, absentPath))
      : condition.$and.some((child) => canMatchWithAbsent(child, false, absentPath));
  }
  if ('$or' in condition) {
    return want
      ? condition.$or.some((child) => canMatchWithAbsent(child, true, absentPath))
      : condition.$or.every((child) => canMatchWithAbsent(child, false, absentPath));
  }
  if ('$not' in condition) return canMatchWithAbsent(condition.$not, !want, absentPath);
  if ('$expr' in condition || !isAtOrBelow(condition.field, absentPath)) return true;
  return matchesOperator(undefined, condition.operator) === want;
}

/**
 * Name the operator to use instead, for the one mismatch that has a replacement.
 * @param name - Operator name
 * @param operand - Operator operand
 * @returns A sentence starting with a space, or an empty string
 */
function replacementHint(name: string, operand: unknown): string {
  return name === '$empty' && operand === false ? ' Use { $exists: true } to test presence.' : '';
}

/**
 * Explain why an operator does not fit the field's type.
 * @param name - Operator name
 * @param operand - Operator operand
 * @param types - Types the field admits
 * @param dateTime - Whether the field's strings are date-times
 * @returns The explanation, or `undefined` when the operator fits
 */
function typeMismatch(
  name: string,
  operand: unknown,
  types: ReadonlySet<SchemaValueType>,
  dateTime: boolean,
): string | undefined {
  const allowed = `the field admits ${[...types].join(', ') || 'no value'}`;
  const wanted = Object.hasOwn(FIELD_TYPES_BY_OPERATOR, name) ? FIELD_TYPES_BY_OPERATOR[name] : undefined;
  if (wanted !== undefined) {
    if (wanted.some((type) => types.has(type))) return undefined;
    return `${name} needs ${wanted.join(' or ')}; ${allowed}.${replacementHint(name, operand)}`;
  }

  switch (name) {
    case '$eq':
    case '$ne': {
      const type = jsonValueType(operand);
      return types.has(type) ? undefined : `the operand of ${name} is ${type}; ${allowed}.`;
    }
    case '$in':
    case '$nin': {
      const entries: unknown[] = Array.isArray(operand) ? operand : [];
      const index = entries.findIndex((entry) => !types.has(jsonValueType(entry)));
      return index === -1 ? undefined : `entry ${index} of ${name} is ${jsonValueType(entries[index])}; ${allowed}.`;
    }
    case '$lt':
    case '$lte':
    case '$gt':
    case '$gte':
      return orderMismatch(name, operand, types, dateTime);
    default:
      return undefined;
  }
}

/**
 * Explain why an ordering operator does not fit the field's type or why its operand cannot
 * be compared. A string operand has to be an RFC 3339 date-time, as the evaluator reads it.
 * @param name - Operator name (`$lt`, `$lte`, `$gt` or `$gte`)
 * @param operand - Operator operand
 * @param types - Types the field admits
 * @param dateTime - Whether the field's strings are date-times
 * @returns The explanation, or `undefined` when the operator fits
 */
function orderMismatch(
  name: string,
  operand: unknown,
  types: ReadonlySet<SchemaValueType>,
  dateTime: boolean,
): string | undefined {
  const allowed = `the field admits ${[...types].join(', ') || 'no value'}`;
  const fits = typeof operand === 'number' ? types.has('number') : types.has('string') && dateTime;
  if (!fits) {
    return `${name} with a ${jsonValueType(operand)} operand needs a number field or a string field with format date-time; ${allowed}.`;
  }
  if (typeof operand === 'string' && parseDateTime(operand) === undefined) {
    return `the operand of ${name} is not an RFC 3339 date-time (a real calendar date and time with a time zone offset).`;
  }
  return undefined;
}

/**
 * Explain why a containment operator cannot match the items of an array field. Conservative:
 * it reports only when the schema names the item types; unknown, open or tuple items
 * (`prefixItems`, draft-07 `items` array) give no finding.
 * @param name - Operator name
 * @param operand - Operator operand
 * @param field - Dot-notation field path of the array
 * @param input - Validation input
 * @returns The explanation, or `undefined` when the operator may match or the items are unknown
 */
function itemMismatch(
  name: string,
  operand: unknown,
  field: string,
  input: ValidateConditionInput,
): string | undefined {
  if (name !== '$contains' && name !== '$containsPrefix') return undefined;

  const element = resolveSchemaPath(input.context, [...field.split('.'), '0']);
  if (element.kind !== 'known') return undefined;
  const { types } = describeSchemaValue(element.schema, input.context);
  if (types === undefined) return undefined;

  const items = `the items of the field admit ${[...types].join(', ') || 'no value'}`;
  if (name === '$containsPrefix') {
    return types.has('string') ? undefined : `$containsPrefix needs string items; ${items}.`;
  }
  const type = jsonValueType(operand);
  return types.has(type) ? undefined : `the operand of $contains is ${type}; ${items}.`;
}

/**
 * Check the syntax of an `$expr`.
 * @param expression - Expression source
 * @param path - Tree path of the expression
 * @returns `expression-syntax` when it does not compile, otherwise `expression-unchecked`
 */
function checkExpression(expression: string, path: string): ConditionFinding {
  try {
    compile(expression);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return error('expression-syntax', path, `The expression does not compile: ${reason}`);
  }
  return {
    severity: 'warning',
    code: 'expression-unchecked',
    path,
    message: 'The expression is checked for syntax only, not against the schemas.',
  };
}

/**
 * Build an error finding.
 * @param code - Finding code
 * @param path - Tree path
 * @param message - Explanation
 * @returns The finding
 */
function error(code: string, path: string, message: string): ConditionFinding {
  return { severity: 'error', code, path, message };
}
