/**
 * A positive whole number from an environment value, or `fallback`.
 *
 * `ConfigService.get<number>()` does not convert: the generic is a type
 * assertion, and the value is the string the environment holds. Anything that
 * does arithmetic with it must parse it first.
 */
export function positiveIntFromEnv(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
