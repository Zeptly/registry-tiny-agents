/**
 * Resolver: declared range -> exact version -> content digest -> runtime lock.
 * Works purely on generated index documents (no network, no cross-repository access); peer indexes are whatever the
 * caller passes in. A reference that cannot be resolved is reported explicitly with a reason code, never omitted.
 * The runtime records the resulting lock in its own evidence.
 */
import type { Doc } from "./load.js";
import { isSemver, type RegistryRef } from "./ids.js";
import { compareSemver, satisfies } from "./semver.js";

export interface Resolved { registry: string; id: string; version: string; digest: string; sealDigest: string | null; maturity: string; location?: string }
export type UnresolvedCode = "no-peer-index" | "not-found" | "no-eligible-version" | "digest-mismatch";
export interface ResolveOptions { allowCandidates?: boolean }
export interface Resolution { resolved?: Resolved; unresolved?: { code: UnresolvedCode; message: string } }

export function resolveRef(indexes: Doc[], ref: RegistryRef, opts: ResolveOptions = {}): Resolution {
  if (!indexes.some((i) => i.registry === ref.registry)) {
    return { unresolved: { code: "no-peer-index", message: `no index for registry '${ref.registry}' was provided; resolution deferred` } };
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
  const entries = refs.map((r): Doc => {
    const requested: Doc = { registry: r.registry, id: r.id, version: r.version };
    if (r.digest) requested.digest = r.digest;
    const out = resolveRef(indexes, r, opts);
    if (out.resolved) { const { location: _l, ...resolved } = out.resolved; return { requested, status: "resolved", resolved }; }
    return { requested, status: "unresolved", unresolved: out.unresolved };
  });
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RuntimeLock", subject, entries };
}
