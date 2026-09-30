/**
 * Manifest parser: the Zeptly Registry Protocol v0.2 JSON-compatible YAML subset (§2).
 *
 * Accepted: one YAML (or JSON) document whose mappings have string keys, whose scalars are null/bool/finite decimal
 * numbers/strings, in YAML 1.2 core semantics (so timestamps stay strings and yes/no/on/off are strings unless typed).
 * Rejected, with a structured diagnostic (code, JSON path, line, column) and never an exception:
 *   BOM, NUL, CR, invalid UTF-8 | syntax errors | multiple documents | duplicate keys | anchors, aliases, merge keys |
 *   non-string keys | tags outside the core scalar/collection set | non-JSON number spellings (hex, octal, `+1`, `.5`,
 *   `01`, `.inf`, `.nan`) | unsafe integers | non-finite numbers | lone surrogates.
 * A document with any problem is never returned, so nothing downstream can validate or hash it.
 */
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml";
import { textPolicyProblem } from "./textpolicy.js";
import { validateValueDomain } from "./valuedomain.js";

export type ParseProblemCode =
  | "bom" | "nul" | "carriage-return" | "invalid-utf8"
  | "syntax-error" | "empty-document" | "multiple-documents" | "duplicate-key"
  | "anchor" | "alias" | "merge-key" | "non-string-key" | "unsupported-tag" | "unsupported-number-syntax"
  | "non-finite-number" | "unsafe-integer" | "unsupported-type" | "lone-surrogate" | "circular-reference" | "too-deep" | "invalid-json";

export interface ParseProblem { code: ParseProblemCode; path: string; line?: number; column?: number; message: string }
export interface ParseResult { doc?: Record<string, unknown>; problems: ParseProblem[] }

const ALLOWED_TAGS = new Set(["str", "int", "float", "bool", "null", "map", "seq"].map((t) => `tag:yaml.org,2002:${t}`));
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

export function formatProblem(p: ParseProblem): string {
  const loc = p.line ? ` (line ${p.line}, column ${p.column})` : "";
  return `${p.path && p.path !== "<root>" ? `${p.path}: ` : ""}${p.message}${loc} [${p.code}]`;
}

export function parseManifestBytes(bytes: Buffer, format: "yaml" | "json"): ParseResult {
  const t = textPolicyProblem(bytes);
  if (t) return { problems: [{ code: t.code, path: "", message: t.message }] };
  return parseManifestText(bytes.toString("utf8"), format);
}

export function parseManifestText(text: string, format: "yaml" | "json" = "yaml"): ParseResult {
  const problems: ParseProblem[] = [];
  const lc = new LineCounter();
  const at = (node: { range?: [number, number, number] | null } | null | undefined) => {
    if (!node?.range) return {};
    const { line, col } = lc.linePos(node.range[0]);
    return { line, column: col };
  };
  const add = (code: ParseProblemCode, path: string, message: string, node?: Node | null) => problems.push({ code, path: path || "<root>", message, ...at(node) });

  let jsonValue: unknown;
  if (format === "json") {
    try { jsonValue = JSON.parse(text); } catch (e) { return { problems: [{ code: "invalid-json", path: "<root>", message: `invalid JSON: ${(e as Error).message}` }] }; }
  }
  let docs;
  try { docs = parseAllDocuments(text, { uniqueKeys: false, lineCounter: lc, version: "1.2", schema: "core", prettyErrors: false, strict: true }); }
  catch (e) { return { problems: [{ code: "syntax-error", path: "<root>", message: (e as Error).message.split("\n")[0]! }] }; }
  const list = Array.isArray(docs) ? docs : [docs];
  for (const d of list) for (const e of d.errors) {
    const at0 = e.pos?.[0] !== undefined ? lc.linePos(e.pos[0]) : undefined;
    problems.push({ code: "syntax-error", path: "<root>", message: `${e.message.split("\n")[0]}`, ...(at0 ? { line: at0.line, column: at0.col } : {}) });
  }
  if (problems.length) return { problems };
  if (list.length > 1) return { problems: [{ code: "multiple-documents", path: "<root>", message: "multiple YAML documents are not allowed" }] };
  const doc = list[0];
  if (!doc || doc.contents === null) return { problems: [{ code: "empty-document", path: "<root>", message: "document is empty" }] };

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return; // empty value (null)
    if (isAlias(node)) { add("alias", path, "aliases are not allowed", node); return; }
    const n = node as Node & { anchor?: string; tag?: string };
    if (n.anchor) add("anchor", path, "anchors are not allowed", n);
    if (n.tag && !ALLOWED_TAGS.has(n.tag)) add("unsupported-tag", path, `tag '${n.tag}' is not supported (only core !!str, !!int, !!float, !!bool, !!null, !!map, !!seq)`, n);
    if (isMap(node)) {
      const seen = new Set<string>();
      for (const pair of node.items) {
        const k = pair.key as unknown;
        if (!isScalar(k) || typeof k.value !== "string") { add("non-string-key", path, "mapping keys must be strings", (k as Node) ?? node); continue; }
        const key = k.value;
        const kp = path ? `${path}.${key}` : key;
        if (k.anchor) add("anchor", kp, "anchors are not allowed", k);
        if (k.tag && !ALLOWED_TAGS.has(k.tag)) add("unsupported-tag", kp, `tag '${k.tag}' is not supported`, k);
        if (key === "<<" && (k.type === "PLAIN" || k.type === undefined)) add("merge-key", kp, "merge keys (<<) are not allowed", k);
        if (seen.has(key)) add("duplicate-key", kp, `duplicate mapping key '${key}'`, k);
        seen.add(key);
        walk(pair.value, kp);
      }
    } else if (isSeq(node)) node.items.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isScalar(node) && typeof node.value === "number") {
      const src = typeof node.source === "string" ? node.source : String(node.value);
      if (!Number.isFinite(node.value)) add("non-finite-number", path, `non-finite number '${src}' is not allowed`, node);
      else if (!JSON_NUMBER.test(src)) add("unsupported-number-syntax", path, `number '${src}' is not a JSON decimal literal (hex, octal, leading zeros, '+', '.5' and '5.' are not allowed)`, node);
    }
  };
  walk(doc.contents, "");
  if (problems.length) return { problems };

  const value = format === "json" ? jsonValue : doc.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { problems: [{ code: "unsupported-type", path: "<root>", message: "the document root must be a mapping" }] };
  const vp = validateValueDomain(value);
  if (vp.length) return { problems: vp.map((p) => ({ code: p.code as ParseProblemCode, path: p.path, message: p.message })) };
  return { doc: value as Record<string, unknown>, problems: [] };
}
