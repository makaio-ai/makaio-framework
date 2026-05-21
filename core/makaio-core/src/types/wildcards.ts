import type { SubjectDefinition } from './subjects.js';
import type { MessagePayload } from './message.js';

export type WildcardSubject = '*';

export const WildcardSubjectKey = '*';

export type WildcardSubjectDefinition<Namespace extends string = string> = SubjectDefinition<
  Record<'*', MessagePayload>,
  WildcardSubject,
  Namespace
>;
