import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { compareSemver } from "./semver.js";
import { FILES } from "./layout.js";
import { validateRoot, type LoadedVersion } from "./validate.js";

/** Deterministic: no timestamps, fixed key order, sorted entries. Format and publication are PROVISIONAL. */
export function buildIndex(rootArg: string): { text: string; errors: number } {
  const v = validateRoot(rootArg);
  const errors = v.diagnostics.filter((d) => d.severity === "error").length;
  const entry = (x: LoadedVersion) => ({
    id: x.id,
    version: x.version,
    maturity: x.maturity,
    origin: x.blueprint.origin,
    provenanceClass: x.provenanceClass,
    lifecycle: x.lifecycle,
    name: x.blueprint.metadata.name,
    taskClass: x.blueprint.metadata.taskClass,
    summary: x.blueprint.intent.summary,
    capabilities: x.blueprint.capabilities.map((c: { capability: string }) => c.capability).sort(),
    skills: x.blueprint.skills.map((s: { ref: unknown }) => s.ref),
    synthetic: x.blueprint.metadata.synthetic,
    path: `blueprints/${x.maturity === "canonical" ? "canonical" : "candidates"}/${x.id}/${x.version}`,
    blueprintDigest: x.blueprintDigest,
    sealDigest: x.sealDigest ?? null,
  });
  const sorted = [...v.versions].sort((a, b) => a.id.localeCompare(b.id) || compareSemver(a.version, b.version) || a.maturity.localeCompare(b.maturity));
  const ids = [...new Set(sorted.map((x) => x.id))];
  const latest = (id: string, m: string) => {
    const c = sorted.filter((x) => x.id === id && x.maturity === m && x.lifecycle === "active");
    return c.length ? c[c.length - 1]!.version : null;
  };
  const doc = {
    indexFormat: "tiny-agent-registry-index/v0-provisional",
    registryPurpose: v.purpose,
    entries: sorted.map(entry),
    resolution: ids.map((id) => ({ id, latestActiveCanonical: latest(id, "canonical"), latestActiveCandidate: latest(id, "candidate") })),
  };
  return { text: JSON.stringify(doc, null, 2) + "\n", errors };
}

export function writeIndex(root: string, check: boolean): { ok: boolean; message: string } {
  const { text, errors } = buildIndex(root);
  if (errors) return { ok: false, message: `registry has ${errors} validation error(s); refusing to build index` };
  const out = join(root, FILES.indexOut);
  if (check) {
    const cur = existsSync(out) ? readFileSync(out, "utf8") : null;
    return cur === text ? { ok: true, message: `${out} is up to date` } : { ok: false, message: `${out} is stale; run 'npm run index'` };
  }
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(out, text);
  return { ok: true, message: `wrote ${out}` };
}
