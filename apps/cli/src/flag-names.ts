/**
 * Convert a schema field name into a long CLI flag name.
 *
 * Commander exposes `--client-id` as `clientId` in `cmd.opts()`, so both the
 * live-schema and manifest-driven code paths must register the same kebab-case
 * long flag to preserve a single CLI surface.
 * @param value - Schema field name.
 * @returns Long CLI option name without the leading `--`.
 */
export function toCliLongOptionName(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
