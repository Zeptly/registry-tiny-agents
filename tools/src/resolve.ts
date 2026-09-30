/**
 * Resolver: declared range -> exact version -> content digest -> runtime lock.
 * Works purely on generated index documents (no network, no cross-repository access); peer indexes are whatever the
 * caller passes in. A reference that cannot be resolved is reported explicitly with a reason code, never omitted.
 * The runtime records the resulting lock in its own evidence.
 *
 * Domain isolation (Protocol v0.2 §6): every resolution runs in exactly ONE domain, `production` (default) or `synthetic`
 * (must be requested explicitly). Every supplied index must declare that `domain`, and every entry must repeat it;
 * indexes of different domains are never mixed; otherwise resolution fails with a DomainError. An ID prefix is never the
 * only guard. Only `zeptly-jcs-v1` indexes are accepted. Transitive resolution and cycle detection are runtime concerns.
 */
import type { Doc } from "./load.js";
import { isSemver, type RegistryRef } from "./ids.js";
import { compareSemver, isValidRange, satisfies } from "./semver.js";

export interface Resolved { registry: string; id: string; version: string; digest: string; digestAlgorithm: string; sealDigest: string | null; maturity: string; location?: string }
/** `invalid-range` is a registry-LOCAL code (the shared code list is not yet specified). */
export type UnresolvedCode = "no-peer-index" | "not-found" | "no-eligible-version" | "digest-mismatch" | "invalid-range";
export type Domain = "production" | "synthetic";
export interface ResolveOptions { allowCandidates?: boolean; domain?: Domain }

export type DomainErrorCode = "domain-mismatch" | "missing-domain-metadata" | "conflicting-domain-metadata" | "mixed-domains" | "unsupported-digest-algorithm";
/** Registry-LOCAL input error: the supplied indexes are not valid for the requested resolution domain. */
export class DomainError extends Error {
  constructor(public code: DomainErrorCode, public problems: { code: DomainErrorCode; message: string }[]) {
    super(`${code}: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "DomainError";
  }
}

export const DIGEST_ALGORITHM = "zeptly-jcs-v1";

/** Throws DomainError unless every index declares the requested domain (and the supported digest algorithm) consistently. */
export function assertIndexDomains(indexes: Doc[], domain: Domain): void {
  const problems: { code: DomainErrorCode; message: string }[] = [];
  const declared = new Set<string>();
  indexes.forEach((ix, k) => {
    const label = `index #${k + 1} (registry '${String(ix?.registry)}')`;
    const d = ix?.domain;
    if (d !== "production" && d !== "synthetic") { problems.push({ code: "missing-domain-metadata", message: `${label} has no valid 'domain' (production|synthetic)` }); return; }
    declared.add(d);
    if (!Array.isArray(ix.entries)) { problems.push({ code: "missing-domain-metadata", message: `${label} has no 'entries' array` }); return; }
    if (ix.digestAlgorithm !== DIGEST_ALGORITHM) problems.push({ code: "unsupported-digest-algorithm", message: `${label} declares digestAlgorithm '${String(ix.digestAlgorithm)}'; only '${DIGEST_ALGORITHM}' is supported` });
    const untyped = (ix.entries as Doc[]).filter((e) => e?.domain !== "production" && e?.domain !== "synthetic");
    if (untyped.length) problems.push({ code: "missing-domain-metadata", message: `${label} has ${untyped.length} entr${untyped.length === 1 ? "y" : "ies"} without a valid 'domain' (first: '${String(untyped[0]?.id)}')` });
    const bad = (ix.entries as Doc[]).filter((e) => (e?.domain === "production" || e?.domain === "synthetic") && e.domain !== d);
    if (bad.length) problems.push({ code: "conflicting-domain-metadata", message: `${label} declares domain '${d}' but contains ${bad[0]!.domain} entry '${String(bad[0]?.id)}'` });
    const badAlg = (ix.entries as Doc[]).filter((e) => e?.digestAlgorithm !== DIGEST_ALGORITHM);
    if (badAlg.length) problems.push({ code: "unsupported-digest-algorithm", message: `${label} entry '${String(badAlg[0]?.id)}' does not declare digestAlgorithm '${DIGEST_ALGORITHM}'` });
    if (d !== domain) problems.push({ code: "domain-mismatch", message: `${label} declares domain '${d}' but the resolution domain is '${domain}'${domain === "production" ? " (synthetic resolution must be requested explicitly)" : ""}` });
  });
  if (declared.size > 1) problems.unshift({ code: "mixed-domains", message: "production and synthetic indexes cannot be mixed in one resolution" });
  if (problems.length) throw new DomainError(problems[0]!.code, problems);
}
export interface Resolution { resolved?: Resolved; unresolved?: { code: UnresolvedCode; message: string } }

export function resolveRef(indexes: Doc[], ref: RegistryRef, opts: ResolveOptions = {}): Resolution {
  assertIndexDomains(indexes, opts.domain ?? "production");
  if (!indexes.some((i) => i.registry === ref.registry)) {
    return { unresolved: { code: "no-peer-index", message: `no index for registry '${ref.registry}' was provided; resolution deferred` } };
  }
  if (!isSemver(ref.version) && !isValidRange(ref.version)) {
    return { unresolved: { code: "invalid-range", message: `'${ref.version}' is not a valid version or range in the supported subset (exact, ^, ~, x/*, comparators >= > <= < = glued to a version, space = AND, || = OR)` } };
  }
  if (ref.digest && ref.digestAlgorithm !== DIGEST_ALGORITHM) {
    return { unresolved: { code: "digest-mismatch", message: `digest pin requires digestAlgorithm '${DIGEST_ALGORITHM}' (got '${String(ref.digestAlgorithm)}')` } };
  }
  const all = indexes.filter((i) => i.registry === ref.registry).flatMap((i) => i.entries as Doc[]).filter((e) => e.id === ref.id);
  if (!all.length) return { unresolved: { code: "not-found", message: `no ${ref.registry} artifact with id '${ref.id}' in the provided index` } };
  const exact = isSemver(ref.version);
  const eligible = all.filter((e) => {
    if (e.lifecycle === "revoked") return false;
    if (e.maturity !== "canonical" && !opts.allowCandidates) return false;
    if (e.lifecycle === "deprecated" && !exact) return false; // deprecated versions resolve only by exact pin
    return exact ? e.version === ref.version : satisfies(e.version, ref.version);
  });
  if (!eligible.length) return { unresolved: { code: "no-eligible-version", message: `no eligible version satisfies '${ref.version}' (revoked, deprecated-by-range, candidate and unrequested prerelease versions are excluded)` } };
  // the version is selected first (highest eligible); a digest pin must then match THAT entry (Protocol v0.2 §6)
  const pick = eligible.reduce((a, b) => (compareSemver(a.version, b.version) >= 0 ? a : b));
  if (ref.digest && pick.digest !== ref.digest) return { unresolved: { code: "digest-mismatch", message: `the selected version ${pick.version} has digest ${pick.digest}, which does not match the pinned digest` } };
  return { resolved: { registry: pick.registry, id: pick.id, version: pick.version, digest: pick.digest, digestAlgorithm: pick.digestAlgorithm, sealDigest: pick.sealDigest ?? null, maturity: pick.maturity, location: pick.location } };
}

/** Deterministic RuntimeLock: one entry per declared reference, in the order given; no timestamps; `complete` only when all resolved. */
export function buildLock(indexes: Doc[], subject: { registry: string; id: string; version: string; digest: string }, refs: RegistryRef[], opts: ResolveOptions = {}): Doc {
  const domain = opts.domain ?? "production";
  assertIndexDomains(indexes, domain);
  const entries = refs.map((r): Doc => {
    const requested: Doc = { registry: r.registry, id: r.id, version: r.version };
    if (r.digest) { requested.digest = r.digest; requested.digestAlgorithm = r.digestAlgorithm; }
    const out = resolveRef(indexes, r, opts);
    if (out.resolved) { const { location: _l, ...resolved } = out.resolved; return { requested, status: "resolved", resolved }; }
    return { requested, status: "unresolved", unresolved: out.unresolved };
  });
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RuntimeLock", digestAlgorithm: DIGEST_ALGORITHM, domain, subject, complete: entries.every((e) => e.status === "resolved"), entries };
}
