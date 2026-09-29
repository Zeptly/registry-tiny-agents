/**
 * Digest conventions (see docs/CANONICALIZATION.md):
 *  - artifact `digest`  = sha256 over canonical JSON of the blueprint minus governance/derived fields;
 *  - directory `seal`   = sha256 over `<path>\0<sha256(raw bytes)>\n` lines, paths in code-point order.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, listFilesRecursive } from "./layout.js";
import type { Doc } from "./load.js";
import { compareCodePoints } from "./order.js";

export const sha256 = (data: Buffer | string): string => "sha256:" + createHash("sha256").update(data).digest("hex");
export const fileDigest = (path: string): string => sha256(readFileSync(path));

/** Files covered by the seal: everything except the two mutable/derived files. */
export const sealedFiles = (dir: string): string[] =>
  listFilesRecursive(dir).filter((f) => f !== FILES.lifecycle && f !== FILES.integrity);

export function computeIntegrity(dir: string): { integrityVersion: string; digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const f of sealedFiles(dir)) files[f] = fileDigest(join(dir, f));
  const lines = Object.keys(files).sort(compareCodePoints).map((f) => `${f}\0${files[f]!.slice("sha256:".length)}\n`).join("");
  return { integrityVersion: "integrity/v0-provisional", digest: sha256(lines), files };
}

export function sealDir(dir: string): void {
  writeFileSync(join(dir, FILES.integrity), JSON.stringify(computeIntegrity(dir), null, 2) + "\n");
}

/**
 * Canonical JSON: UTF-8 text, no insignificant whitespace, object keys in ascending code-point order, array order
 * preserved, strings as ECMAScript `JSON.stringify` (must be well-formed Unicode), numbers as ECMAScript
 * Number-to-string (finite only; -0 serialises as 0). No Unicode normalisation. Not identical to RFC 8785 for keys
 * outside the BMP (JCS orders by UTF-16 code unit; this orders by code point).
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      if (!v.isWellFormed()) throw new Error("canonicalJson: string contains a lone surrogate");
      return JSON.stringify(v);
    case "boolean": return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
      const o = v as Doc;
      return `{${Object.keys(o).sort(compareCodePoints).map((k) => `${canonicalJson(k)}:${canonicalJson(o[k])}`).join(",")}}`;
    }
    default: throw new Error(`canonicalJson: unsupported ${typeof v}`);
  }
}

/**
 * The artifact `digest`. Includes identity (`metadata.id/registry/origin/synthetic`), `spec`, `references`,
 * `provenance` and `security.classification/capabilities`. Excludes `metadata.version`, `metadata.maturity`,
 * `attestations` and `security.approvals` (governance records made after content is final); lifecycle is not part of
 * the document at all. The directory seal is a separate mechanism covering the canonical payload files.
 */
export function contentDigest(doc: Doc): string {
  const c = JSON.parse(JSON.stringify(doc)) as Doc;
  delete c.attestations;
  if (c.metadata) { delete c.metadata.version; delete c.metadata.maturity; }
  if (c.security) delete c.security.approvals;
  return sha256(canonicalJson(c));
}
