/**
 * The single string ordering used anywhere output must be deterministic (index entries, canonical JSON keys,
 * seal file order): ascending Unicode code point. Locale-free by construction (never `localeCompare`).
 * Differs from JS default `sort()` (UTF-16 code units) only for astral characters vs U+E000..U+FFFF.
 */
export function compareCodePoints(a: string, b: string): number {
  const x = a[Symbol.iterator](), y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next(), q = y.next();
    if (p.done || q.done) return p.done && q.done ? 0 : p.done ? -1 : 1;
    const c = p.value.codePointAt(0)!, d = q.value.codePointAt(0)!;
    if (c !== d) return c < d ? -1 : 1;
  }
}

export const sortCodePoints = (xs: readonly string[]): string[] => [...xs].sort(compareCodePoints);

/**
 * UTF-16 code-unit order: the key ordering RFC 8785 (JCS) mandates for canonical JSON. Used ONLY for JSON canonicalization;
 * index and path ordering use `compareCodePoints`. The two differ for astral characters vs U+E000..U+FFFF.
 */
export const compareUtf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
