/**
 * RFC 8785 JSON Canonicalization Scheme (Protocol v0.2 §3), restricted to the manifest value domain.
 *  - object keys sorted by UTF-16 code units; arrays keep their order;
 *  - strings use ECMAScript JSON.stringify escaping (RFC 8785 §3.2.2); output is UTF-8;
 *  - numbers use ECMAScript Number-to-string (RFC 8785 §3.2.2.3; -0 serialises as 0); non-finite numbers are rejected;
 *  - no Unicode normalisation; no line-ending rewriting.
 * Unsupported values (undefined, functions, symbols, bigint, Date, Map, NaN, Infinity, lone surrogates) throw.
 */
import { compareUtf16 } from "./order.js";

export function jcs(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      if (!v.isWellFormed()) throw new Error("jcs: string contains a lone surrogate");
      return JSON.stringify(v);
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("jcs: non-finite number");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error("jcs: unsupported object type (only plain objects and arrays)");
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort(compareUtf16).map((k) => `${jcs(k)}:${jcs(o[k])}`).join(",")}}`;
    }
    default: throw new Error(`jcs: unsupported ${typeof v}`);
  }
}
