import { Transform } from 'class-transformer';

/**
 * Boolean query-string flag for a DTO property.
 *
 * Why this exists rather than a plain `@Transform(({ value }) => ...)`:
 * the global `ValidationPipe` runs with `enableImplicitConversion`, so
 * class-transformer coerces a `boolean`-typed property with `Boolean(value)`
 * *before* any custom transform sees it — and `Boolean('false')` is `true`.
 * Every "is false" filter therefore silently matched the `true` rows.
 * Reading the untouched value off the source object (`obj[key]`) is the only
 * way to see what the client actually sent.
 *
 * Absent or unparseable values fall back to `defaultValue` (`undefined` by
 * default, which `@IsOptional()` then skips — i.e. "no filter").
 */
export function ToBoolean(defaultValue?: boolean): PropertyDecorator {
  return Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key];
    return parseBooleanQueryValue(raw) ?? defaultValue;
  });
}

/** `'true'`/`'1'` → true, `'false'`/`'0'` → false, anything else → undefined. */
export function parseBooleanQueryValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
  }
  return undefined;
}
