import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { compareSemver } from "./semver.js";
import { compareCodePoints, sortCodePoints } from "./order.js";
import { FILES } from "./layout.js";
import { DIGEST_ALGORITHM } from "./integrity.js";
import { REGISTRY_NAME } from "./ids.js";
import { schemaErrors } from "./load.js";
import { validateRoot, type LoadedVersion } from "./validate.js";

/**
 * Deterministic derived data: no timestamps, fixed key order, sorted entries.
 * Protocol v0.2 §8: registry, id, version, artifact digest, directory seal, maturity, effective lifecycle, origin, location,
 * digest algorithm and domain. Entries sort by code-point id, then SemVer precedence, then digest (index order is separate
 * from JCS key ordering).
 */
export function buildIndex(rootArg: string): { text: string; errors: number } {
  const v = validateRoot(rootArg);
  const errors = v.diagnostics.filter((d) => d.severity === "error").length;
  const entry = (x: LoadedVersion) => ({
    registry: REGISTRY_NAME,
    id: x.id,
    version: x.version,
    digest: x.digest,
    digestAlgorithm: DIGEST_ALGORITHM,
    sealDigest: x.sealDigest ?? null,
    maturity: x.maturity,
    lifecycle: x.lifecycle,
    origin: { type: x.blueprint.metadata.origin.type, ...(x.blueprint.metadata.origin.evolution ? { evolution: { kind: x.blueprint.metadata.origin.evolution.kind } } : {}) },
    location: x.location,
    domain: v.domain as "production" | "synthetic",
    name: x.blueprint.spec.descriptor.name,
    taskClass: x.blueprint.spec.descriptor.taskClass,
    summary: x.blueprint.spec.intent.summary,
    capabilities: sortCodePoints(x.blueprint.security.capabilities.map((c: { capability: string }) => c.capability)),
    references: x.blueprint.references,
  });
  const sorted = [...v.versions].sort((a, b) => compareCodePoints(a.id, b.id) || compareSemver(a.version, b.version) || compareCodePoints(a.digest, b.digest));
  const doc = {
    apiVersion: "registry.zeptly.dev/v1alpha1",
    kind: "RegistryIndex",
    registry: REGISTRY_NAME,
    digestAlgorithm: DIGEST_ALGORITHM,
    domain: v.domain,
    entries: sorted.map(entry),
  };
  const bad = schemaErrors("index", doc);
  if (bad.length) throw new Error(`generated index violates its schema (synthetic content in a production index?): ${bad.join("; ")}`);
  return { text: JSON.stringify(doc, null, 2) + "\n", errors };
}

export function writeIndex(root: string, check: boolean): { ok: boolean; message: string } {
  let built: { text: string; errors: number };
  try { built = buildIndex(root); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (built.errors) return { ok: false, message: `registry has ${built.errors} validation error(s); refusing to build index` };
  const out = join(root, FILES.indexOut);
  if (check) {
    const cur = existsSync(out) ? readFileSync(out, "utf8") : null;
    return cur === built.text ? { ok: true, message: `${out} is up to date` } : { ok: false, message: `${out} is stale; run 'npm run index'` };
  }
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(out, built.text);
  return { ok: true, message: `wrote ${out}` };
}
