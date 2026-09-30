import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DEFAULT_POLICY, exists, parseFileChecked, readYaml, schemaErrors, type Doc, type SchemaName } from "./load.js";
import { FILES, discoverVersionDirs, expectedDir, findUnsafeEntries, inspectTree, listUpstreamSources, toPosix, type Maturity, type VersionDir } from "./layout.js";
import { textPolicyViolation } from "./textpolicy.js";
import { computeIntegrity, contentDigest, fileDigest } from "./integrity.js";
import { REGISTRY_NAME, describeRef, isSemver } from "./ids.js";
import { compareSemver, parseSemver, satisfies } from "./semver.js";
import { compareCodePoints } from "./order.js";
import { Scanner } from "./scan.js";

export interface Diagnostic { severity: "error" | "warning"; where: string; message: string }
export type ProvenanceClass = "native" | "upstream-seed" | "discovered" | "refined";

export interface LoadedVersion {
  zone: Maturity;
  dir: string;
  location: string;
  id: string;
  version: string;
  maturity: Maturity;
  blueprint: Doc;
  provenanceClass: ProvenanceClass;
  lifecycle: string;
  digest: string;
  sealDigest?: string;
}
export interface RootValidation { root: string; purpose: "production" | "example" | "unknown"; diagnostics: Diagnostic[]; versions: LoadedVersion[] }

export function provenanceClass(bp: Doc): ProvenanceClass {
  const t = bp.metadata.origin.type;
  if (t === "native" || t === "upstream-seed") return t;
  return bp.metadata.origin.evolution?.kind === "refined" ? "refined" : "discovered";
}

const PLACEHOLDER = /^PLACEHOLDER-/;
const SYNTHETIC_EVIDENCE = "evidence://synthetic/";
const ALLOWED_TRANSITIONS: Record<string, string[]> = { active: ["deprecated", "revoked"], deprecated: ["revoked"], revoked: [] };
const EFFECT_RANK = { reversible: 0, compensable: 1, irreversible: 2 } as const;

type Err = (where: string, message: string) => void;
type Recurrence = { minDistinctWorkspaces: number; minExecutions: number };

export function validateRoot(rootArg: string, opts: { policyPath?: string } = {}): RootValidation {
  const root = resolve(rootArg);
  const diagnostics: Diagnostic[] = [];
  const err: Err = (where, message) => diagnostics.push({ severity: "error", where, message });
  const warn: Err = (where, message) => diagnostics.push({ severity: "warning", where, message });
  const schema = (where: string, name: SchemaName, data: unknown): boolean => {
    const es = schemaErrors(name, data);
    es.forEach((e) => err(where, `schema(${name}): ${e}`));
    return es.length === 0;
  };
  // Every YAML/JSON file is parsed and value-checked exactly once. A file that fails (syntax, duplicate keys, invalid
  // values, policy rejection) is reported once and is never loaded, hashed or reported as valid.
  const parsed = new Map<string, { doc?: Doc; problems: string[]; reported: boolean }>();
  const parseChecked = (path: string, where: string): Doc | undefined => {
    let e = parsed.get(path);
    if (!e) { const r = parseFileChecked(path); e = { doc: r.doc, problems: r.problems, reported: false }; parsed.set(path, e); }
    if (!e.doc && !e.reported) { e.problems.forEach((m) => err(where, m)); e.reported = true; }
    return e.doc;
  };
  const reject = (path: string) => parsed.set(path, { problems: [], reported: true });
  const load = (path: string, name: SchemaName, where = path): Doc | undefined => {
    if (!exists(path)) return undefined;
    const data = parseChecked(path, where);
    if (!data) return undefined;
    return schema(where, name, data) ? data : undefined;
  };

  // ---- root marker + policy
  const rootDoc = load(join(root, FILES.root), "registry-root", FILES.root);
  if (!rootDoc) err(FILES.root, "missing or invalid registry root marker");
  const purpose = (rootDoc?.purpose as "production" | "example" | undefined) ?? "unknown";
  const policy = load(opts.policyPath ?? DEFAULT_POLICY, "policy", "policy");
  if (!policy) { err("policy", "policy missing or invalid"); return { root, purpose, diagnostics, versions: [] }; }
  const scanner = new Scanner(policy.privacy);

  const syntheticRule = (where: string, flag: unknown) => {
    if (purpose === "example" && flag !== true) err(where, "example registry roots require synthetic: true on every object");
    if (purpose === "production" && flag === true) err(where, "synthetic content is not allowed in a production registry root");
  };
  const actorRule = (where: string, actor: unknown) => {
    if (purpose === "production" && typeof actor === "string" && PLACEHOLDER.test(actor)) err(where, `placeholder identity '${actor}' is not allowed in a production registry root`);
  };

  // ---- upstream sources
  const sources = new Set<string>();
  for (const s of listUpstreamSources(root)) {
    const dir = join(root, "upstreams", s);
    const src = load(join(dir, "source.yaml"), "upstream-source", `upstreams/${s}/source.yaml`);
    if (!src) { if (!exists(join(dir, "source.yaml"))) err(`upstreams/${s}`, "missing source.yaml"); continue; }
    sources.add(s);
    if (src.id !== s) err(`upstreams/${s}/source.yaml`, `id '${src.id}' does not match directory '${s}'`);
    syntheticRule(`upstreams/${s}/source.yaml`, src.synthetic);
    const lockPath = join(dir, "lock.json");
    if (!exists(lockPath)) err(`upstreams/${s}`, "missing lock.json");
    else {
      const lock = load(lockPath, "upstream-lock", `upstreams/${s}/lock.json`);
      if (lock && lock.source !== s) err(`upstreams/${s}/lock.json`, "source does not match directory");
      if (lock && src.ingestion.status === "specified-only" && lock.entries.length > 0) err(`upstreams/${s}/lock.json`, "specified-only source must have no lock entries (nothing may be imported)");
    }
  }

  // ---- symlinks / special files anywhere in registry content: rejected, never followed
  for (const u of findUnsafeEntries(root)) err(u.rel, `${u.kind === "symlink" ? "symbolic links" : "special files"} are not allowed in registry content`);

  // ---- pass 1: each version directory (identity comes from the document, not the path)
  const versions: LoadedVersion[] = [];
  const evalBest = new Map<LoadedVersion, number>();
  for (const vd of discoverVersionDirs(root)) {
    const where = vd.rel;
    try {
    const tree = inspectTree(vd.dir);
    const files = tree.files;
    const allow = (policy.files.allow as string[]).map((r) => new RegExp(r));
    let dirBytes = 0;
    if (files.length > policy.limits.maxFilesPerVersion) err(where, `version directory holds ${files.length} files (max ${policy.limits.maxFilesPerVersion})`);
    for (const f of files) {
      const full = join(vd.dir, f);
      if (!allow.some((re) => re.test(f))) { reject(full); err(`${where}/${f}`, "file is not in the filename allow-list (policy files.allow); not read or scanned"); continue; }
      const size = statSync(full).size;
      dirBytes += size;
      if (size > policy.limits.maxFileBytes) { reject(full); err(`${where}/${f}`, `file exceeds ${policy.limits.maxFileBytes} bytes (registry Git holds procedure, not runtime payloads); not scanned`); continue; }
      const bytes = readFileSync(full);
      const bad = textPolicyViolation(bytes);
      if (bad) { reject(full); err(`${where}/${f}`, `text policy: ${bad}`); continue; }
      const doc = parseChecked(full, `${where}/${f}`);
      if (!doc) continue; // reported once by parseChecked; the file is not scanned, loaded or hashed
      for (const fi of scanner.scanParsed(doc, bytes.toString("utf8"), full)) err(`${where}/${f}`, `privacy: ${fi.path || "<file>"}: ${fi.message} [${fi.detector}]`);
    }
    if (dirBytes > policy.limits.maxVersionDirBytes) err(where, `version directory exceeds ${policy.limits.maxVersionDirBytes} bytes`);
    const bp = load(join(vd.dir, FILES.blueprint), "blueprint", `${where}/${FILES.blueprint}`);
    if (!bp) { if (!files.includes(FILES.blueprint)) err(where, "missing blueprint.yaml"); continue; }

    const id: string = bp.metadata.id, version: string = bp.metadata.version, maturity: Maturity = bp.metadata.maturity;
    if (maturity !== vd.zone) err(where, `metadata.maturity '${maturity}' does not match its zone (${vd.zone})`);
    const want = toPosix(expectedDir(root, maturity, id, version).slice(root.length + 1));
    if (want !== vd.rel) err(where, `artifact is not at its expected location '${want}'`);

    const required = [FILES.lifecycle, ...(maturity === "canonical" ? [FILES.integrity, FILES.promotion] : [])];
    for (const f of required) if (!files.includes(f)) err(where, `missing required file ${f}`);

    const cls = provenanceClass(bp);
    const digest = contentDigest(bp);
    syntheticRule(`${where}/blueprint.yaml metadata.synthetic`, bp.metadata.synthetic);
    if (purpose === "example" && !bp.spec.descriptor.name.startsWith("[SYNTHETIC]")) err(where, "example blueprint names must start with '[SYNTHETIC]'");
    const prefix = policy.namespaces.syntheticIdPrefix as string;
    if (purpose === "example" && !id.startsWith(prefix)) err(where, `example ids must start with '${prefix}'`);
    if (purpose === "production" && id.startsWith(prefix)) err(where, `ids starting with '${prefix}' are reserved for the synthetic namespace`);
    bp.provenance.authors.forEach((a: Doc) => actorRule(`${where} provenance.authors`, a.identity));

    checkBlueprint(bp, vd, where, err, warn);
    checkEnvelope(bp, where, err);
    checkOrigin(bp, sources, where, err);
    if (maturity === "canonical") {
      const v = parseSemver(version);
      if (v.major < 1 || v.pre.length) err(where, "canonical versions must be >=1.0.0 and not prerelease");
    }

    // lifecycle overlay
    const lc = load(join(vd.dir, FILES.lifecycle), "lifecycle", `${where}/lifecycle.yaml`);
    let lifecycle = "active";
    if (lc) { lifecycle = lc.state; checkLifecycle(lc, where, err, actorRule); }

    // directory seal
    let sealDigest: string | undefined;
    if (exists(join(vd.dir, FILES.integrity))) {
      const integ = load(join(vd.dir, FILES.integrity), "integrity", `${where}/integrity.json`);
      if (integ) {
        const actual = computeIntegrity(vd.dir);
        if (integ.digest !== actual.digest) err(where, `sealed content changed: integrity.json digest ${integ.digest} != computed ${actual.digest}`);
        const a = new Set(Object.keys(actual.files)), b = new Set(Object.keys(integ.files));
        if (a.size !== b.size || [...a].some((f) => !b.has(f))) err(where, "integrity.json file list does not match directory contents");
        sealDigest = integ.digest;
      }
    }

    const loaded: LoadedVersion = { zone: vd.zone, dir: vd.dir, location: vd.rel, id, version, maturity, blueprint: bp, provenanceClass: cls, lifecycle, digest, sealDigest };
    evalBest.set(loaded, checkAttestations(loaded, policy, load, syntheticRule, actorRule, purpose, err));
    if (maturity === "candidate" && bp.security.approvals.length) err(where, "candidates carry no governance approvals (security.approvals must be empty until promotion)");
    for (const [i, a] of (bp.security.approvals as Doc[]).entries()) {
      actorRule(`${where} security.approvals`, a.identity);
      if (a.subjectDigest !== digest) err(`${where} security.approvals[${i}]`, `stale: subjectDigest ${a.subjectDigest} != content digest ${digest}`);
    }

    // submission envelope (optional)
    if (exists(join(vd.dir, FILES.submission))) {
      const sub = load(join(vd.dir, FILES.submission), "submission", `${where}/submission.yaml`);
      if (sub) {
        syntheticRule(`${where}/submission synthetic`, sub.synthetic);
        actorRule(`${where}/submission submitter`, sub.submitter.identity);
        if (sub.subject.id !== id || sub.subject.version !== version) err(where, "submission subject does not match blueprint");
        if (sub.artifacts.subjectDigest !== digest) err(where, "submission subjectDigest does not match the artifact content digest (stale)");
        const sanAtt = bp.attestations.find((a: Doc) => a.type === "sanitisation" && a.ref.startsWith("file:"));
        if (sanAtt) {
          const p = join(vd.dir, sanAtt.ref.slice(5));
          if (exists(p) && sub.artifacts.sanitisationReportDigest !== fileDigest(p)) err(where, "submission sanitisationReportDigest does not match the report (stale)");
        }
        const suitePath = join(vd.dir, bp.spec.evaluation.suite);
        if (sub.artifacts.evalSuiteDigest && exists(suitePath) && sub.artifacts.evalSuiteDigest !== fileDigest(suitePath)) err(where, "submission evalSuiteDigest does not match the suite (stale)");
      }
    }
    versions.push(loaded);
    } catch (e) {
      // Safety net: no unexpected exception may escape as a stack trace or be mistaken for a successful validation.
      err(where, `unexpected failure while validating this version directory: ${(e as Error).message}`);
    }
  }

  // ---- pass 2: cross-object rules + class policy
  const canonicalOf = (id: string) => versions.filter((v) => v.maturity === "canonical" && v.id === id);
  const seen = new Set<string>();
  for (const v of versions) {
    const where = v.location;
    try {
    const key = `${v.id}@${v.version}`;
    if (seen.has(key)) err(where, `version ${key} exists more than once (candidate and/or canonical)`);
    seen.add(key);
    const bp = v.blueprint;
    const classPolicy = policy.classes[v.provenanceClass];

    const canon = canonicalOf(v.id);
    if (v.maturity === "candidate") {
      if (!canon.length && parseSemver(v.version).major !== 0) err(where, "a candidate with no canonical release must be 0.y.z");
      if (canon.length && !canon.every((c) => compareSemver(v.version, c.version) > 0)) err(where, "candidate version must be greater than every canonical version of the same id");
    }

    // references: structural only; local tiny-agents refs are additionally checked against this root
    for (const r of bp.references as Doc[]) {
      if (r.registry !== REGISTRY_NAME) continue;
      if (r.id === v.id) err(where, "artifact must not reference itself");
      const local = versions.filter((x) => x.maturity === "canonical" && x.id === r.id);
      if (r.digest) {
        const exact = local.find((x) => x.version === r.version);
        if (exact && exact.digest !== r.digest) err(where, `reference ${describeRef(r as never)}: digest does not match the referenced canonical version`);
      }
      if (!local.some((x) => satisfies(x.version, r.version))) warn(where, `reference ${describeRef(r as never)} matches no canonical version in this root`);
    }

    // admission (candidates AND canonical)
    const ev = bp.metadata.origin.evolution;
    const rec = bp.spec.lineage.recurrence;
    const adm = classPolicy.admission;
    const admRec = resolveRecurrence(adm.recurrence, policy);
    if (admRec) checkRecurrence(rec, admRec, `${where} (admission, class ${v.provenanceClass})`, err);
    if (adm.requireParentCanonical) {
      for (const p of ev?.sourceRefs ?? []) {
        const parent = versions.find((c) => c.maturity === "canonical" && c.id === p.id && c.version === p.version);
        if (p.registry !== REGISTRY_NAME) err(where, "evolution sourceRefs must reference the tiny-agents registry");
        else if (!isSemver(p.version) || !parent) err(where, `parent ${describeRef(p)} is not an exact canonical version in this registry`);
        else if (parent.lifecycle === "revoked") err(where, `parent ${describeRef(p)} is revoked`);
        else if (!p.digest) err(where, `parent ${describeRef(p)} must carry the exact digest`);
        else if (p.digest !== parent.digest) err(where, `parent ${describeRef(p)}: digest does not match the canonical parent`);
      }
    }
    if (adm.requireLicenceSpdx && !bp.spec.lineage.seed?.licence?.spdx) err(where, "upstream seed requires a declared licence SPDX id");

    // promotion (canonical only)
    if (v.maturity === "canonical") {
      const pr = load(join(v.dir, FILES.promotion), "promotion", `${where}/promotion.yaml`);
      if (!pr) continue;
      const pol = classPolicy.promotion;
      syntheticRule(`${where}/promotion synthetic`, pr.synthetic);
      pr.reviewers.forEach((r: Doc) => actorRule(`${where}/promotion reviewer`, r.identity));
      if (pr.subjectDigest !== v.digest) err(where, "promotion record subjectDigest does not match the artifact content digest (stale)");
      const want = (pr.reviewers as Doc[]).map((r) => `${r.role}:${r.identity}`).sort(compareCodePoints).join("|");
      const have = (bp.security.approvals as Doc[]).map((a) => `${a.role}:${a.identity}`).sort(compareCodePoints).join("|");
      if (want !== have) err(where, "security.approvals must mirror promotion.yaml reviewers (role + identity)");
      if (pr.policyVersion > policy.policyVersion) err(where, "promotion record cites a newer policy version than the current policy");
      if (pr.reviewers.length < pol.minHumanReviewers) err(where, `promotion needs >= ${pol.minHumanReviewers} reviewers for class ${v.provenanceClass}`);
      const roles = new Set(pr.reviewers.map((r: Doc) => r.role));
      for (const role of pol.requiredReviewerRoles ?? []) if (!roles.has(role)) err(where, `promotion lacks required reviewer role '${role}'`);
      const promRec = resolveRecurrence(pol.recurrence ?? "none", policy);
      if (promRec) checkRecurrence(rec, promRec, `${where} (promotion, class ${v.provenanceClass})`, err);
      if (pol.requireLicenceVerified && bp.spec.lineage.seed?.licence?.status !== "verified") err(where, "promotion requires verified upstream licence");
      if (pol.requireSecurityValidationPassed && bp.spec.lineage.seed?.securityValidation !== "passed") err(where, "promotion requires passed upstream security validation");
      if (pol.requireEvalPass && (evalBest.get(v) ?? 0) < bp.spec.evaluation.gates.minPassRate) err(where, `promotion requires an evaluation attestation with passRate >= ${bp.spec.evaluation.gates.minPassRate}`);
      for (const t of pol.requiredAttestations ?? []) if (!bp.attestations.some((a: Doc) => a.type === t)) err(where, `promotion requires an attestation of type '${t}'`);
      const sec = bp.attestations.find((a: Doc) => a.type === "security-review");
      if ((pol.requiredAttestations ?? []).includes("security-review") && sec && sec.outcome !== "pass") err(where, "security-review attestation must have outcome: pass");
      if (!v.sealDigest) err(where, "canonical versions must be sealed");
    }
    } catch (e) {
      err(where, `unexpected failure while applying class policy: ${(e as Error).message}`);
    }
  }
  return { root, purpose, diagnostics, versions };
}

// ---------------------------------------------------------------------------------------------

function resolveRecurrence(spec: unknown, policy: Doc): Recurrence | null {
  if (spec === "none") return null;
  if (spec === "default") return policy.wisdomOfComputeDefaults.recurrence;
  return spec as Recurrence;
}

function checkRecurrence(rec: Doc | undefined, req: Recurrence, where: string, err: Err) {
  if (!rec) return err(where, "requires recurrence evidence (spec.lineage.recurrence)");
  if (rec.distinctWorkspaceCount < req.minDistinctWorkspaces) err(where, `recurrence: ${rec.distinctWorkspaceCount} distinct workspaces < policy minimum ${req.minDistinctWorkspaces}`);
  if (rec.executionCount < req.minExecutions) err(where, `recurrence: ${rec.executionCount} executions < policy minimum ${req.minExecutions}`);
}

function checkLifecycle(lc: Doc, where: string, err: Err, actorRule: (w: string, a: unknown) => void) {
  const h: Doc[] = lc.history;
  if (h[0]?.state !== "active") err(where, "lifecycle history must start with 'active'");
  if (h[h.length - 1]?.state !== lc.state) err(where, "lifecycle state must equal the last history entry");
  for (let i = 1; i < h.length; i++) {
    if (!ALLOWED_TRANSITIONS[h[i - 1]!.state]?.includes(h[i]!.state)) err(where, `illegal lifecycle transition ${h[i - 1]!.state} -> ${h[i]!.state}`);
    if (Date.parse(h[i]!.at) < Date.parse(h[i - 1]!.at)) err(where, "lifecycle history must be chronological");
  }
  h.forEach((e) => actorRule(`${where} lifecycle actor`, e.actor));
  if (lc.supersededBy && lc.state === "active") err(where, "supersededBy requires deprecated or revoked state");
}

/** Envelope fields derived from `spec` must agree with it, so generic tooling can trust the envelope. */
function checkEnvelope(bp: Doc, where: string, err: Err) {
  const key = (r: Doc) => `${r.registry}/${r.id}@${r.version}#${r.digest ?? ""}`;
  const want = [...new Set((bp.spec.skills as Doc[]).map((s) => key(s.ref)))].sort();
  const have = (bp.references as Doc[]).map(key).sort();
  if (JSON.stringify(want) !== JSON.stringify(have)) err(where, "references must equal the set of references used in spec (skills[].ref)");
  const caps = (bp.spec.capabilities as Doc[]).map((c) => `${c.capability}:${c.effect}`).sort();
  const sec = (bp.security.capabilities as Doc[]).map((c) => `${c.capability}:${c.effect}`).sort();
  if (JSON.stringify(caps) !== JSON.stringify(sec)) err(where, "security.capabilities must equal spec.capabilities (capability + effect)");
}

/** metadata.origin, spec.lineage and provenance must tell one consistent story. */
function checkOrigin(bp: Doc, sources: Set<string>, where: string, err: Err) {
  const o = bp.metadata.origin, lin = bp.spec.lineage;
  const only = (k: string) => Object.keys(lin).filter((x) => x !== k);
  if (o.type === "native") {
    if (!lin.native) err(where, "native blueprints require spec.lineage.native");
    only("native").forEach((x) => err(where, `spec.lineage.${x} is not allowed for origin native`));
    if (o.evolution) err(where, "metadata.origin.evolution is only for origin evolved");
  } else if (o.type === "upstream-seed") {
    if (!lin.seed) err(where, "upstream seeds require spec.lineage.seed");
    only("seed").forEach((x) => err(where, `spec.lineage.${x} is not allowed for origin upstream-seed`));
    if (o.evolution) err(where, "metadata.origin.evolution is only for origin evolved");
    const ups = (bp.provenance.sourceRefs as Doc[]).filter((s) => s.upstream);
    if (!ups.length) err(where, "upstream seeds require an upstream provenance.sourceRefs entry");
    for (const s of ups) if (!sources.has(s.upstream.source)) err(where, `upstream source '${s.upstream.source}' has no <root>/upstreams/ descriptor`);
    if (!(bp.provenance.transformations as Doc[]).some((t) => t.type === "normalisation")) err(where, "upstream seeds require a normalisation transformation record");
  } else {
    if (!o.evolution) err(where, "evolved blueprints require metadata.origin.evolution");
    if (!lin.recurrence) err(where, "evolved blueprints require spec.lineage.recurrence");
    only("recurrence").forEach((x) => err(where, `spec.lineage.${x} is not allowed for origin evolved`));
    const ev = o.evolution;
    if (ev?.kind === "discovered" && ev.sourceRefs.length > 0) err(where, "'discovered' blueprints have no source refs; use kind 'refined'");
    if (ev?.kind === "refined" && ev.sourceRefs.length === 0) err(where, "'refined' blueprints must list sourceRefs");
    if (lin.recurrence && lin.recurrence.distinctWorkspaceCount > lin.recurrence.executionCount) err(where, "distinctWorkspaceCount cannot exceed executionCount");
    if (!(bp.provenance.transformations as Doc[]).some((t) => t.type === "clustering")) err(where, "evolved blueprints require a clustering transformation record");
  }
}

function checkBlueprint(bp: Doc, vd: VersionDir, where: string, err: Err, warn: Err) {
  const s = bp.spec;
  const unique = (label: string, xs: string[]) => {
    const dup = xs.filter((x, i) => xs.indexOf(x) !== i);
    if (dup.length) err(where, `duplicate ${label}: ${[...new Set(dup)].join(", ")}`);
  };
  const steps: Doc[] = s.procedure.steps, slots: Doc[] = s.slots, skills: Doc[] = s.skills, caps: Doc[] = s.capabilities;
  unique("step ids", steps.map((x) => x.id));
  unique("slot names", slots.map((x) => x.name));
  unique("skill keys", skills.map((x) => x.key));
  unique("capability keys", caps.map((x) => x.key));
  unique("input names", s.interface.inputs.map((x: Doc) => x.name));
  unique("output names", s.interface.outputs.map((x: Doc) => x.name));

  const slotNames = new Set(slots.map((x) => x.name));
  const used = new Set<string>();
  for (const st of steps) for (const m of String(st.instruction).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const m1 = /^slot\.([a-z][a-z0-9_]*)$/.exec(m[1]!);
    if (!m1) err(where, `step '${st.id}': placeholder {{${m[1]}}} must be of the form {{slot.<name>}}`);
    else if (!slotNames.has(m1[1]!)) err(where, `step '${st.id}': undeclared slot '${m1[1]}'`);
    else used.add(m1[1]!);
  }
  for (const sl of slots) {
    if (!used.has(sl.name)) err(where, `slot '${sl.name}' is never referenced by the procedure`);
    if (sl.type === "enum" && !sl.enum) err(where, `enum slot '${sl.name}' needs an enum list`);
    if (sl.type !== "enum" && sl.enum) err(where, `non-enum slot '${sl.name}' must not declare enum`);
    if (sl.type === "enum" && sl.default !== undefined && !sl.enum?.includes(sl.default)) err(where, `slot '${sl.name}' default is not in enum`);
  }
  const capKeys = new Set(caps.map((c) => c.key)), skillKeys = new Set(skills.map((c) => c.key));
  for (const st of steps) {
    for (const k of st.usesCapabilities ?? []) if (!capKeys.has(k)) err(where, `step '${st.id}' uses unknown capability '${k}'`);
    for (const k of st.usesSkills ?? []) if (!skillKeys.has(k)) err(where, `step '${st.id}' uses unknown skill '${k}'`);
  }
  const usedCaps = new Set(steps.flatMap((x) => x.usesCapabilities ?? [])), usedSkills = new Set(steps.flatMap((x) => x.usesSkills ?? []));
  for (const c of caps) if (!usedCaps.has(c.key)) warn(where, `capability '${c.key}' is not used by any step`);
  for (const k of skills) if (!usedSkills.has(k.key)) warn(where, `skill '${k.key}' is not used by any step`);

  // capability effects (AgentGit-inspired classification; no dependency)
  for (const c of caps) {
    if (c.effect === "irreversible" && c.approval !== "required") err(where, `irreversible capability '${c.key}' requires approval: required`);
    if (c.effect === "compensable" && !c.compensation) err(where, `compensable capability '${c.key}' must describe its compensation`);
    if (EFFECT_RANK[c.effect as keyof typeof EFFECT_RANK] > EFFECT_RANK[s.effects.maxEffect as keyof typeof EFFECT_RANK]) err(where, `capability '${c.key}' exceeds spec.effects.maxEffect`);
  }

  // adaptation contract: MAY alter / MUST preserve / LOCKED
  const groups: [string, Doc[]][] = [["mayAlter", s.adaptation.mayAlter], ["mustPreserve", s.adaptation.mustPreserve], ["locked", s.adaptation.locked]];
  const refSets: Record<string, Set<string>> = { step: new Set(steps.map((x) => x.id)), slot: slotNames, skill: skillKeys, capability: capKeys };
  const classified = new Map<string, string[]>();
  for (const [g, entries] of groups) for (const e of entries) {
    const { kind, ref } = e.target;
    if (kind in refSets) {
      if (!ref) err(where, `adaptation.${g}: target kind '${kind}' requires ref`);
      else if (!refSets[kind]!.has(ref)) err(where, `adaptation.${g}: unknown ${kind} '${ref}'`);
      else classified.set(`${kind}:${ref}`, [...(classified.get(`${kind}:${ref}`) ?? []), g]);
    } else if (ref) err(where, `adaptation.${g}: target kind '${kind}' takes no ref`);
    if (g === "mayAlter" && ["security", "interface", "evaluation"].includes(kind)) err(where, `adaptation.mayAlter must not include '${kind}' (the compiler may never alter it)`);
  }
  for (const [kind, set] of Object.entries(refSets)) for (const ref of set) {
    const g = classified.get(`${kind}:${ref}`) ?? [];
    if (g.length === 0) err(where, `adaptation: ${kind} '${ref}' is not classified as mayAlter/mustPreserve/locked`);
    if (g.length > 1) err(where, `adaptation: ${kind} '${ref}' is classified more than once (${g.join(", ")})`);
  }
  if (!s.adaptation.locked.some((e: Doc) => e.target.kind === "security")) err(where, "adaptation.locked must include the security envelope (the compiler/runtime must never alter it)");

  const inside = (p: string) => resolve(vd.dir, p).startsWith(resolve(vd.dir) + sep);
  const p = s.evaluation.suite;
  if (!inside(p)) err(where, `path '${p}' escapes the version directory`);
  else if (!exists(join(vd.dir, p))) err(where, `referenced file '${p}' does not exist`);
}

/** Verifies every attestation is bound to the CURRENT content digest; returns the best evaluation passRate. */
function checkAttestations(v: LoadedVersion, policy: Doc, load: (p: string, n: SchemaName, w?: string) => Doc | undefined,
  syntheticRule: (w: string, f: unknown) => void, actorRule: (w: string, a: unknown) => void, purpose: string, err: Err): number {
  const bp = v.blueprint, where = v.location;
  let best = 0;
  const suitePath = join(v.dir, bp.spec.evaluation.suite);
  const suite = exists(suitePath) ? load(suitePath, "eval-suite", `${where}/${bp.spec.evaluation.suite}`) : undefined;
  if (suite) {
    syntheticRule(`${where}/eval suite synthetic`, suite.synthetic);
    const graders = new Set(suite.graders.map((g: Doc) => g.id));
    const ids = suite.cases.map((c: Doc) => c.id);
    if (new Set(ids).size !== ids.length) err(where, "duplicate eval case ids");
    for (const c of suite.cases) for (const x of c.expectations) if (!graders.has(x.grader)) err(where, `eval case '${c.id}' uses unknown grader '${x.grader}'`);
  }
  if (!bp.attestations.some((a: Doc) => a.type === "sanitisation")) err(where, "a sanitisation attestation is required for every version");

  for (const [i, a] of (bp.attestations as Doc[]).entries()) {
    const aw = `${where} attestations[${i}](${a.type})`;
    if (a.subjectDigest !== v.digest) err(aw, `stale: subjectDigest ${a.subjectDigest} != content digest ${v.digest}`);
    const synthEvidence = a.ref.startsWith(SYNTHETIC_EVIDENCE);
    if (purpose === "example" && a.ref.startsWith("evidence://") && !synthEvidence) err(aw, `example roots require '${SYNTHETIC_EVIDENCE}' evidence refs`);
    if (purpose === "production" && synthEvidence) err(aw, "synthetic evidence reference in a production root");
    if ((a.type === "sanitisation" || a.type === "evaluation") && !a.ref.startsWith("file:")) { err(aw, `${a.type} attestations must reference an in-directory document (file:<path>)`); continue; }
    if (!a.ref.startsWith("file:")) continue;
    const rel = a.ref.slice(5);
    const path = join(v.dir, rel);
    if (!resolve(path).startsWith(resolve(v.dir) + sep) || !exists(path)) { err(aw, `referenced document '${rel}' does not exist in the version directory`); continue; }
    if (a.type === "sanitisation") {
      const rep = load(path, "sanitisation-report", `${where}/${rel}`);
      if (!rep) continue;
      syntheticRule(`${where}/${rel} synthetic`, rep.synthetic);
      actorRule(`${where}/${rel} reviewer`, rep.reviewer.identity);
      if (rep.subject.id !== v.id) err(aw, "report subject id does not match the artifact");
      if (rep.subjectDigest !== v.digest) err(aw, "report subjectDigest does not match the artifact content digest (stale report)");
      for (const c of rep.checks) if (c.result !== "pass") err(aw, `sanitisation check '${c.kind}' did not pass`);
      const kinds = new Set(rep.checks.map((c: Doc) => c.kind));
      for (const k of policy.privacy.requiredSanitisationChecks) if (!kinds.has(k)) err(aw, `report lacks required check '${k}'`);
      if (!rep.generalisation.tenantContentRemoved || !rep.generalisation.tenantSpecificValuesBoundToSlots) err(aw, "report does not attest generalisation");
    } else if (a.type === "evaluation") {
      const res = load(path, "eval-result", `${where}/${rel}`);
      if (!res) continue;
      syntheticRule(`${where}/${rel} synthetic`, res.synthetic);
      if (res.subject.id !== v.id) err(aw, "result subject id does not match the artifact");
      if (res.subjectDigest !== v.digest) err(aw, "result subjectDigest does not match the artifact content digest (stale result)");
      if (suite && res.suiteDigest !== fileDigest(suitePath)) err(aw, "result suiteDigest does not match the suite (stale result)");
      const passed = res.caseResults.filter((c: Doc) => c.passed).length;
      if (res.summary.cases !== res.caseResults.length || res.summary.passed !== passed) err(aw, "result summary does not match caseResults");
      if (Math.abs(res.summary.passRate - passed / res.caseResults.length) > 1e-9) err(aw, "result passRate does not match caseResults");
      if (suite) for (const c of res.caseResults) if (!suite.cases.some((x: Doc) => x.id === c.case)) err(aw, `result names unknown case '${c.case}'`);
      if (a.outcome === "pass" && res.summary.passRate < bp.spec.evaluation.gates.minPassRate) err(aw, "attestation outcome 'pass' contradicts the result passRate");
      best = Math.max(best, res.summary.passRate);
    }
  }
  return best;
}

export function formatDiagnostics(ds: Diagnostic[]): string {
  return ds.map((d) => `${d.severity.toUpperCase().padEnd(7)} ${d.where}: ${d.message}`).join("\n");
}
export { readYaml };
