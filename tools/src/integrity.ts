/** PROVISIONAL digest/sealing convention: sha256 over sorted `<path>\0<file sha256>\n` lines. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, listFilesRecursive } from "./layout.js";
import type { Doc } from "./load.js";

export const sha256 = (data: Buffer | string): string => "sha256:" + createHash("sha256").update(data).digest("hex");
export const fileDigest = (path: string): string => sha256(readFileSync(path));

/** Files covered by the seal: everything except the two mutable/derived files. */
export const sealedFiles = (dir: string): string[] =>
  listFilesRecursive(dir).filter((f) => f !== FILES.lifecycle && f !== FILES.integrity);

export function computeIntegrity(dir: string): { integrityVersion: string; digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const f of sealedFiles(dir)) files[f] = fileDigest(join(dir, f));
  const lines = Object.keys(files).sort().map((f) => `${f}\0${files[f]!.slice("sha256:".length)}\n`).join("");
  return { integrityVersion: "integrity/v0-provisional", digest: sha256(lines), files };
}

export function sealDir(dir: string): void {
  writeFileSync(join(dir, FILES.integrity), JSON.stringify(computeIntegrity(dir), null, 2) + "\n");
}

/** Deterministic JSON: object keys sorted recursively, no insignificant whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Doc;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The artifact `digest` (Registry Protocol: exact digest) = content identity of what attestations assess.
 * Excludes `attestations` (they cannot contain their own subject digest) and the governance-state fields
 * `metadata.version` / `metadata.maturity`, so promotion does not invalidate evaluations of unchanged content.
 * The directory seal (`integrity.json`) is a separate integrity mechanism over ALL files.
 */
export function contentDigest(doc: Doc): string {
  const c = JSON.parse(JSON.stringify(doc)) as Doc;
  delete c.attestations;
  if (c.metadata) { delete c.metadata.version; delete c.metadata.maturity; }
  return sha256(canonicalJson(c));
}
