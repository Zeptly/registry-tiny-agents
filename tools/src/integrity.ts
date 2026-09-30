/**
 * Digest contract `zeptly-jcs-v1` (Zeptly Registry Protocol v0.2 §3-§5); see docs/CANONICALIZATION.md.
 *  - artifact `digest` = sha256(JCS(artifact projection)); the projection is an explicit allow-list (below);
 *  - directory `seal`  = sha256(JCS({registry, id, version, payload: [{path, sha256}]})), payload paths in code-point
 *    order, payload = the permitted payload files of the version directory (policy `files.payload`).
 * A change to any rule requires a new `digestAlgorithm` identifier and new vectors.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, inspectTree } from "./layout.js";
import { DEFAULT_POLICY, readYaml, type Doc } from "./load.js";
import { jcs } from "./jcs.js";
import { textPolicyProblem, type TextProblemCode } from "./textpolicy.js";
import { compareCodePoints } from "./order.js";
import { CanonicalizationError, validateValueDomain } from "./valuedomain.js";

export const DIGEST_ALGORITHM = "zeptly-jcs-v1";
export const INTEGRITY_VERSION = "integrity/v0.2";

export const sha256 = (data: Buffer | string): string => "sha256:" + createHash("sha256").update(data).digest("hex");
export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
export const fileDigest = (path: string): string => sha256(readFileSync(path));

/** Deprecated name kept for the vectors: canonical JSON is RFC 8785 JCS. */
export const canonicalJson = jcs;

/**
 * The artifact projection. INCLUDED: apiVersion, kind, metadata.{id,registry,origin,synthetic}, spec, references,
 * provenance, security.{classification,capabilities}. EXCLUDED: metadata.version, metadata.maturity, lifecycle (an overlay,
 * never part of the manifest), attestations, security.approvals (governance records bound to the digest by `subjectDigest`).
 * Runtime approval requirements live in `spec.capabilities[].approval` and therefore ARE covered.
 * An allow-list, so a field added to the envelope later is excluded until the contract is deliberately versioned.
 */
export function artifactProjection(doc: Doc): Doc {
  const pick = (o: Doc | undefined, keys: string[]): Doc => {
    const out: Doc = {};
    for (const k of keys) if (o && Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    return out;
  };
  return {
    ...pick(doc, ["apiVersion", "kind"]),
    metadata: pick(doc.metadata, ["id", "registry", "origin", "synthetic"]),
    ...pick(doc, ["spec", "references", "provenance"]),
    security: pick(doc.security, ["classification", "capabilities"]),
  };
}

export function contentDigest(doc: Doc): string {
  // Validate the value domain BEFORE projecting/cloning: JSON.stringify would turn NaN/Infinity into null and drop undefined.
  const problems = validateValueDomain(doc);
  if (problems.length) throw new CanonicalizationError(problems);
  return sha256(jcs(artifactProjection(doc)));
}

export interface PayloadEntry { path: string; sha256: string }
export interface Seal { integrityVersion: string; digestAlgorithm: string; registry: string; id: string; version: string; digest: string; payload: PayloadEntry[] }

export const payloadPatterns = (policy: Doc): RegExp[] => (policy.files.payload as string[]).map((r) => new RegExp(r));

/** Seal digest over an explicit payload list (shared by the validator, the CLI and the vectors). */
export function sealDigest(registry: string, id: string, version: string, payload: PayloadEntry[]): string {
  const sorted = [...payload].sort((a, b) => compareCodePoints(a.path, b.path));
  return sha256(jcs({ registry, id, version, payload: sorted.map((p) => ({ path: p.path, sha256: p.sha256 })) }));
}

/** Payload files of a version directory: regular files matching the policy payload patterns, code-point order. */
export function payloadFiles(dir: string, patterns: RegExp[]): string[] {
  return inspectTree(dir).files.filter((f) => patterns.some((re) => re.test(f))).sort(compareCodePoints);
}

export class SealInputError extends Error {
  constructor(public code: "case-collision" | "not-permitted" | TextProblemCode, public path: string, message: string) { super(`${path}: ${message} [${code}]`); this.name = "SealInputError"; }
}

/**
 * Pure seal computation over in-memory files (the vectors run this directly). Rejects, before hashing: paths that are not
 * permitted payload files, case-colliding paths, and payload bytes that are not UTF-8 / BOM-free / LF-only.
 */
export function sealFromFiles(who: { registry: string; id: string; version: string }, files: Record<string, Buffer>, patterns: RegExp[]): Seal {
  const seen = new Map<string, string>();
  for (const p of Object.keys(files).sort(compareCodePoints)) {
    const k = p.toLowerCase(), other = seen.get(k);
    if (other !== undefined) throw new SealInputError("case-collision", p, `collides with '${other}' when case is ignored`);
    seen.set(k, p);
  }
  const payload: PayloadEntry[] = [];
  for (const p of Object.keys(files).sort(compareCodePoints)) {
    if (!patterns.some((re) => re.test(p))) continue;
    const t = textPolicyProblem(files[p]!);
    if (t) throw new SealInputError(t.code, p, t.message);
    payload.push({ path: p, sha256: sha256Hex(files[p]!) });
  }
  return { integrityVersion: INTEGRITY_VERSION, digestAlgorithm: DIGEST_ALGORITHM, ...who, digest: sealDigest(who.registry, who.id, who.version, payload), payload };
}

export function computeSeal(dir: string, who: { registry: string; id: string; version: string }, patterns: RegExp[]): Seal {
  const files: Record<string, Buffer> = {};
  for (const f of inspectTree(dir).files) files[f] = patterns.some((re) => re.test(f)) ? readFileSync(join(dir, f)) : Buffer.alloc(0); // non-payload files are never read here
  return sealFromFiles(who, files, patterns);
}

export function sealDir(dir: string): void {
  const bp = readYaml(join(dir, FILES.blueprint));
  const policy = readYaml(DEFAULT_POLICY);
  const seal = computeSeal(dir, { registry: bp.metadata.registry, id: bp.metadata.id, version: bp.metadata.version }, payloadPatterns(policy));
  writeFileSync(join(dir, FILES.integrity), JSON.stringify(seal, null, 2) + "\n");
}
