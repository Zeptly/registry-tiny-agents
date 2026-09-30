/**
 * Resolver: declared range -> exact version -> content digest -> runtime lock.
 * Works purely on generated index documents (no network, no cross-repository access); peer indexes are whatever the
 * caller passes in. A reference that cannot be resolved is reported explicitly with a reason code, never omitted.
 * The runtime records the resulting lock in its own evidence.
 *
 * Domain isolation (registry-local): every resolution runs in exactly ONE domain, `production` (default) or `example`
 * (must be requested explicitly). Every supplied index must declare a matching `purpose`, and every entry a boolean
 * `synthetic` consistent with it; otherwise resolution fails with a DomainError. An ID prefix is never the only guard.
 */
import type { Doc } from "./load.js";
import { isSemver, type RegistryRef } from "./ids.js";
import { compareSemver, isValidRange, satisfies } from "./semver.js";

export interface Resolved { registry: string; id: string; version: string; digest: string; sealDigest: string | null; maturity: string; location?: string }
/** `invalid-range` is a registry-LOCAL code (the shared code list is not yet specified). */
export type UnresolvedCode = "no-peer-index" | "not-found" | "no-eligible-version" | "digest-mismatch" | "invalid-range";
export type Domain = "production" | "example";
export interface ResolveOptions { allowCandidates?: boolean; domain?: Domain }

export type DomainErrorCode = "domain-mismatch" | "missing-domain-metadata" | "conflicting-domain-metadata";
/** Registry-LOCAL input error: the supplied indexes are not valid for the requested resolution domain. */
export class DomainError extends Error {
  constructor(public code: DomainErrorCode, public problems: { code: DomainErrorCode; message: string }[]) {
    super(`${code}: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "DomainError";
  }
}

/** Throws DomainError unless every index declares the requested domain consistently (index purpose + per-entry synthetic). */
export function assertIndexDomains(indexes: Doc[], domain: Domain): void {
  const problems: { code: DomainErrorCode; message: string }[] = [];
  indexes.forEach((ix, k) => {
    const label = `index #${k + 1} (registry '${String(ix?.registry)}')`;
    const purpose = ix?.purpose;
    if (purpose !== "production" && purpose !== "example") { problems.push({ code: "missing-domain-metadata", message: `${label} has no valid 'purpose' (production|example)` }); return; }
    if (!Array.isArray(ix.entries)) { problems.push({ code: "missing-domain-metadata", message: `${label} has no 'entries' array` }); return; }
    const untyped = (ix.entries as Doc[]).filter((e) => typeof e?.synthetic !== "boolean");
    if (untyped.length) problems.push({ code: "missing-domain-metadata", message: `${label} has ${untyped.length} entr${untyped.length === 1 ? "y" : "ies"} without a boolean 'synthetic' (first: '${String(untyped[0]?.id)}')` });
    const bad = (ix.entries as Doc[]).filter((e) => (purpose === "production" ? e.synthetic === true : e.synthetic === false));
    if (bad.length) problems.push({ code: "conflicting-domain-metadata", message: `${label} declares purpose '${purpose}' but contains ${purpose === "production" ? "synthetic" : "non-synthetic"} entry '${String(bad[0]?.id)}'` });
    if (purpose !== domain) problems.push({ code: "domain-mismatch", message: `${label} declares purpose '${purpose}' but the resolution domain is '${domain}'${domain === "production" ? " (example resolution must be requested explicitly)" : ""}` });
  });
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
  const all = indexes.filter((i) => i.registry === ref.registry).flatMap((i) => i.entries as Doc[]).filter((e) => e.id === ref.id);
  if (!all.length) return { unresolved: { code: "not-found", message: `no ${ref.registry} artifact with id '${ref.id}' in the provided index` } };
  const exact = isSemver(ref.version);
  const eligible = all.filter((e) => {
    if (e.lifecycle === "revoked") return false;
    if (e.maturity !== "canonical" && !opts.allowCandidates) return false;
    if (e.lifecycle === "deprecated" && !exact) return false; // deprecated versions resolve only by exact pin
    return exact ? e.version === ref.version : satisfies(e.version, ref.version);
  });
  if (!eligible.length) return { unresolved: { code: "no-eligible-version", message: `no eligible version satisfies '${ref.version}' (revoked, deprecated-by-range and candidate versions are excluded)` } };
  const pinned = ref.digest ? eligible.filter((e) => e.digest === ref.digest) : eligible;
  if (!pinned.length) return { unresolved: { code: "digest-mismatch", message: "no eligible version matches the pinned digest" } };
  const pick = pinned.reduce((a, b) => (compareSemver(a.version, b.version) >= 0 ? a : b));
  return { resolved: { registry: pick.registry, id: pick.id, version: pick.version, digest: pick.digest, sealDigest: pick.sealDigest ?? null, maturity: pick.maturity, location: pick.location } };
}

/** Deterministic lock: one entry per reference, in the order given; no timestamps. */
export function buildLock(indexes: Doc[], subject: { registry: string; id: string; version: string; digest: string }, refs: RegistryRef[], opts: ResolveOptions = {}): Doc {
  assertIndexDomains(indexes, opts.domain ?? "production");
  const entries = refs.map((r): Doc => {
    const requested: Doc = { registry: r.registry, id: r.id, version: r.version };
    if (r.digest) requested.digest = r.digest;
    const out = resolveRef(indexes, r, opts);
    if (out.resolved) { const { location: _l, ...resolved } = out.resolved; return { requested, status: "resolved", resolved }; }
    return { requested, status: "unresolved", unresolved: out.unresolved };
  });
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RuntimeLock", subject, entries };
}
