/**
 * Value-domain validation for parsed registry documents. Runs on the PARSED value BEFORE any JSON cloning,
 * canonicalization or hashing, so an unsupported value can never be silently converted to null or another
 * representation, and a numeric literal that the parser already rounded can never reach a digest.
 *
 * Supported: null, boolean, finite number, well-formed string, plain array, plain object (string keys).
 * Additionally rejected: integer-valued numbers outside the safe-integer range (|n| > 2^53 - 1). Because every
 * integer literal above 2^53 - 1 parses to a double >= 2^53 (and negatives symmetrically), checking the parsed value
 * catches every spelling that could round silently: long integer literals, hex/octal integers, `9007199254740993.0`,
 * `9.007199254740993e15`, `90071992547409930e-1`, `1e21`, ... Fractional numbers are unaffected.
 */
export type ValueProblemCode = "non-finite-number" | "unsafe-integer" | "unsupported-type" | "lone-surrogate" | "circular-reference" | "too-deep";
export interface ValueProblem { path: string; code: ValueProblemCode; message: string }

const MAX_DEPTH = 64;

export function validateValueDomain(value: unknown, rootPath = ""): ValueProblem[] {
  const out: ValueProblem[] = [];
  const ancestors = new Set<object>();
  const at = (p: string) => p || "<root>";
  const add = (path: string, code: ValueProblemCode, message: string) => out.push({ path: at(path), code, message });

  const walk = (v: unknown, path: string, depth: number): void => {
    if (v === null || typeof v === "boolean") return;
    switch (typeof v) {
      case "string":
        if (!v.isWellFormed()) add(path, "lone-surrogate", "string contains an unpaired surrogate (invalid Unicode)");
        return;
      case "number":
        if (!Number.isFinite(v)) add(path, "non-finite-number", `non-finite number (${String(v)}) is not allowed`);
        else if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) add(path, "unsafe-integer", "integer-valued number outside the safe integer range (|n| > 9007199254740991); the source literal may have been rounded by the parser");
        return;
      case "object": break;
      default:
        add(path, "unsupported-type", `unsupported value of type ${typeof v}`);
        return;
    }
    const o = v as object;
    if (ancestors.has(o)) { add(path, "circular-reference", "circular reference"); return; }
    if (depth > MAX_DEPTH) { add(path, "too-deep", `nesting deeper than ${MAX_DEPTH}`); return; }
    const proto = Object.getPrototypeOf(o);
    const isArray = Array.isArray(o);
    if (!isArray && proto !== Object.prototype && proto !== null) { add(path, "unsupported-type", `unsupported object type (${(o as { constructor?: { name?: string } }).constructor?.name ?? "unknown"})`); return; }
    ancestors.add(o);
    if (isArray) (o as unknown[]).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    else for (const [k, x] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (!k.isWellFormed()) add(`${p}#key`, "lone-surrogate", "object key contains an unpaired surrogate (invalid Unicode)");
      walk(x, p, depth + 1);
    }
    ancestors.delete(o);
  };
  walk(value, rootPath, 0);
  return out;
}

export class CanonicalizationError extends Error {
  constructor(public problems: ValueProblem[]) {
    super(`value cannot be canonicalized: ${problems.slice(0, 3).map((p) => `${p.path}: ${p.message}`).join("; ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
    this.name = "CanonicalizationError";
  }
}
