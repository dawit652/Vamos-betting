/** A nested message tree where any branch or leaf may be left out. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

/**
 * Builds a complete message tree from a source tree (English) and the keys a
 * locale has translated so far. Missing keys fall back to the source text, so
 * a prepared-but-untranslated locale (Afaan Oromo, Tigrinya) still renders.
 */
export function withFallback<T extends object>(source: T, overrides: DeepPartial<T>): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const override = (overrides as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      result[key] = typeof override === 'string' && override.trim() !== '' ? override : value;
    } else {
      result[key] = withFallback(value as object, override ?? {});
    }
  }
  return result as T;
}
