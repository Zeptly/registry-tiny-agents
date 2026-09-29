/**
 * Resolver: declared range -> exact version -> content digest -> runtime lock.
 * Works purely on generated index documents (no network, no cross-repository access); peer indexes are
 * whatever the caller passes in. The runtime records the resulting lock in its own evidence.
 */
import type { Doc } from "./load.js";
import { isSemver, type RegistryRef } from "./ids.js";
import { compareSemver, satisfies } from "./semver.js";

export interface Resolved { registry: string; id: string; version: string; digest: string; sealDigest: string | null; maturity: string; location?: string }
export interface ResolveOptions { allowCandidates?: boolean }

export function resolveRef(indexes: Doc[], ref: RegistryRef, opts: ResolveOptions = {}): { resolved?: Resolved; reason?: string } {
  const all = indexes.flatMap((i) => i.entries as Doc[]).filter((e) => e.registry === ref.registry && e.id === ref.id);
  if (!all.length) return { reason: `no ${ref.registry} artifact with id '${ref.id}' in the provided indexes` };
  const exact = isSemver(ref.version);
  const eligible = all.filter((e) => {
    if (e.lifecycle === "revoked") return false;
    if (e.maturity !== "canonical" && !opts.allowCandidates) return false;
    if (e.lifecycle === "deprecated" && !exact) return false; // deprecated versions resolve only by exact pin
    return exact ? e.version === ref.version : satisfies(e.version, ref.version);
  });
  if (!eligible.length) return { reason: `no eligible version satisfies '${ref.version}' (revoked, deprecated-by-range and candidate versions are excluded)` };
  const withDigest = ref.digest ? eligible.filter((e) => e.digest === ref.digest) : eligible;
  if (!withDigest.length) return { reason: `no eligible version matches the pinned digest` };
  const pick = withDigest.reduce((a, b) => (compareSemver(a.version, b.version) >= 0 ? a : b));
  return { resolved: { registry: pick.registry, id: pick.id, version: pick.version, digest: pick.digest, sealDigest: pick.sealDigest ?? null, maturity: pick.maturity, location: pick.location } };
}

/** Deterministic lock: entries follow the order of `refs`; no timestamps. */
export function buildLock(indexes: Doc[], refs: RegistryRef[], opts: ResolveOptions = {}): Doc {
  const entries: Doc[] = [], unresolved: Doc[] = [];
  for (const r of refs) {
    const requested: Doc = { registry: r.registry, id: r.id, version: r.version };
    if (r.digest) requested.digest = r.digest;
    const out = resolveRef(indexes, r, opts);
    if (out.resolved) { const { location: _l, ...resolved } = out.resolved; entries.push({ requested, resolved }); }
    else unresolved.push({ requested, reason: out.reason });
  }
  return { apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RuntimeLock", entries, unresolved };
}
