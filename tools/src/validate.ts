import { join, resolve, sep } from "node:path";
import { DEFAULT_POLICY, exists, readData, readYaml, schemaErrors, type Doc, type SchemaName } from "./load.js";
import { FILES, listFilesRecursive, listUpstreamSources, listVersionDirs, type Maturity, type VersionDir } from "./layout.js";
import { computeIntegrity, fileDigest } from "./integrity.js";
import { isRegistryId, isSemver } from "./ids.js";
import { compareSemver, parseSemver } from "./semver.js";
import { Scanner } from "./scan.js";

export interface Diagnostic { severity: "error" | "warning"; where: string; message: string }
export type ProvenanceClass = "native" | "upstream-seed" | "discovered" | "refined";

export interface LoadedVersion extends VersionDir {
  blueprint: Doc;
  provenanceClass: ProvenanceClass;
  lifecycle: string;
  blueprintDigest: string;
  sealDigest?: string;
}
export interface RootValidation { root: string; purpose: "production" | "example" | "unknown"; diagnostics: Diagnostic[]; versions: LoadedVersion[] }

export function provenanceClass(bp: Doc): ProvenanceClass {
  if (bp.origin === "native") return "native";
  if (bp.origin === "upstream-seed") return "upstream-seed";
  return bp.provenance?.evolution?.kind === "refined" ? "refined" : "discovered";
}

const PLACEHOLDER = /^PLACEHOLDER-/;
const ALLOWED_TRANSITIONS: Record<string, string[]> = { active: ["deprecated", "revoked"], deprecated: ["revoked"], revoked: [] };

export function validateRoot(rootArg: string, opts: { policyPath?: string } = {}): RootValidation {
  const root = resolve(rootArg);
  const diagnostics: Diagnostic[] = [];
  const err = (where: string, message: string) => diagnostics.push({ severity: "error", where, message });
  const warn = (where: string, message: string) => diagnostics.push({ severity: "warning", where, message });
  const schema = (where: string, name: SchemaName, data: unknown): boolean => {
    const es = schemaErrors(name, data);
    es.forEach((e) => err(where, `schema(${name}): ${e}`));
    return es.length === 0;
  };
  const load = (path: string, name: SchemaName, where = path): Doc | undefined => {
    if (!exists(path)) return undefined;
    let data: Doc;
    try { data = readData(path); } catch (e) { err(where, `cannot parse: ${(e as Error).message}`); return undefined; }
    return schema(where, name, data) ? data : undefined;
  };

  // ---- root marker + policy
  const rootDoc = load(join(root, FILES.root), "registry-root", FILES.root);
  if (!rootDoc) err(FILES.root, "missing or invalid registry root marker");
  const purpose = (rootDoc?.purpose as "production" | "example" | undefined) ?? "unknown";
  const policyPath = opts.policyPath ?? DEFAULT_POLICY;
  const policy = load(policyPath, "policy", "policy");
  if (!policy) { err("policy", "policy missing or invalid"); return { root, purpose, diagnostics, versions: [] }; }
  const scanner = new Scanner(policy.privacy);
  const isExample = purpose === "example";

  // Synthetic/placeholder rules per root purpose.
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

  // ---- version directories (pass 1: load + per-object checks)
  const versions: LoadedVersion[] = [];
  const dirs = listVersionDirs(root);
  for (const vd of dirs) {
    const where = `blueprints/${vd.maturity === "canonical" ? "canonical" : "candidates"}/${vd.id}/${vd.version}`;
    const dirOk = isRegistryId(vd.id) && isSemver(vd.version);
    if (!dirOk) { err(where, "directory name is not a valid <id>/<version>"); continue; }

    // file whitelist + scanner
    const files = listFilesRecursive(vd.dir);
    for (const f of files) {
      for (const fi of scanner.scanFile(join(vd.dir, f))) err(`${where}/${f}`, `privacy: ${fi.path || "<file>"}: ${fi.message} [${fi.detector}]`);
    }
    const required = [FILES.blueprint, FILES.lifecycle, FILES.sanitisation, ...(vd.maturity === "canonical" ? [FILES.integrity, FILES.promotion] : [])];
    for (const f of required) if (!files.includes(f)) err(where, `missing required file ${f}`);

    const bp = load(join(vd.dir, FILES.blueprint), "blueprint", `${where}/${FILES.blueprint}`);
    if (!bp) continue;
    if (bp.id !== vd.id) err(where, `blueprint id '${bp.id}' does not match directory`);
    if (bp.version !== vd.version) err(where, `blueprint version '${bp.version}' does not match directory`);
    if (bp.maturity !== vd.maturity) err(where, `blueprint maturity '${bp.maturity}' does not match location (${vd.maturity})`);
    const cls = provenanceClass(bp);
    syntheticRule(`${where}/blueprint.yaml metadata.synthetic`, bp.metadata.synthetic);
    if (isExample && !String(bp.metadata.name).startsWith("[SYNTHETIC]")) err(where, "example blueprint names must start with '[SYNTHETIC]'");
    bp.metadata.maintainers?.forEach((m: string) => actorRule(`${where} maintainers`, m));
    checkBlueprint(bp, vd, where, err, warn);
    checkEvidenceMarkers(bp, purpose, where, err);
    if (bp.provenance.upstream && !sources.has(bp.provenance.upstream.source)) err(where, `provenance.upstream.source '${bp.provenance.upstream.source}' has no <root>/upstreams/ descriptor`);
    if (vd.maturity === "canonical") {
      const v = parseSemver(vd.version);
      if (v.major < 1 || v.pre.length) err(where, "canonical versions must be >=1.0.0 and not prerelease");
    }

    // lifecycle
    const lc = load(join(vd.dir, FILES.lifecycle), "lifecycle", `${where}/lifecycle.yaml`);
    let lifecycle = "active";
    if (lc) { lifecycle = lc.state; checkLifecycle(lc, where, err, actorRule); }

    // integrity
    let sealDigest: string | undefined;
    if (exists(join(vd.dir, FILES.integrity))) {
      const integ = load(join(vd.dir, FILES.integrity), "integrity", `${where}/integrity.json`);
      if (integ) {
        const actual = computeIntegrity(vd.dir);
        if (integ.digest !== actual.digest) err(where, `sealed content changed: integrity.json digest ${integ.digest} != computed ${actual.digest}`);
        const a = Object.keys(actual.files).sort().join(","), b = Object.keys(integ.files).sort().join(",");
        if (a !== b) err(where, "integrity.json file list does not match directory contents");
        sealDigest = integ.digest;
      }
    }
    const blueprintDigest = fileDigest(join(vd.dir, FILES.blueprint));

    // sanitisation report
    const rep = load(join(vd.dir, bp.provenance.sanitisation.report), "sanitisation-report", `${where}/${bp.provenance.sanitisation.report}`);
    if (rep) {
      syntheticRule(`${where}/sanitisation-report synthetic`, rep.synthetic);
      actorRule(`${where}/sanitisation-report reviewer`, rep.reviewer.identity);
      if (rep.subject.id !== bp.id || rep.subject.version !== bp.version) err(where, "sanitisation report subject does not match blueprint");
      if (rep.blueprintDigest !== blueprintDigest) err(where, "sanitisation report digest does not match blueprint.yaml (report is stale)");
      for (const c of rep.checks) if (c.result !== "pass") err(where, `sanitisation check '${c.kind}' did not pass`);
      const kinds = new Set(rep.checks.map((c: Doc) => c.kind));
      for (const k of policy.privacy.requiredSanitisationChecks) if (!kinds.has(k)) err(where, `sanitisation report lacks required check '${k}'`);
      if (!rep.generalisation.tenantContentRemoved || !rep.generalisation.tenantSpecificValuesBoundToSlots) err(where, "sanitisation report does not attest generalisation");
    }

    // evaluation
    const evalInfo = checkEvaluation(bp, vd, where, load, syntheticRule, err, purpose);

    // submission
    const subPath = join(vd.dir, FILES.submission);
    if (exists(subPath)) {
      const sub = load(subPath, "submission", `${where}/submission.yaml`);
      if (sub) {
        syntheticRule(`${where}/submission synthetic`, sub.synthetic);
        actorRule(`${where}/submission submitter`, sub.submitter.identity);
        if (sub.subject.id !== bp.id || sub.subject.version !== bp.version) err(where, "submission subject does not match blueprint");
        if (sub.artifacts.blueprintDigest !== blueprintDigest) err(where, "submission blueprintDigest does not match blueprint.yaml");
        const repPath = join(vd.dir, bp.provenance.sanitisation.report);
        if (exists(repPath) && sub.artifacts.sanitisationReportDigest !== fileDigest(repPath)) err(where, "submission sanitisationReportDigest does not match report");
        const suitePath = join(vd.dir, bp.evaluation.suite);
        if (sub.artifacts.evalSuiteDigest && exists(suitePath) && sub.artifacts.evalSuiteDigest !== fileDigest(suitePath)) err(where, "submission evalSuiteDigest does not match suite");
      }
    }

    versions.push({ ...vd, blueprint: bp, provenanceClass: cls, lifecycle, blueprintDigest, sealDigest });
    (versions[versions.length - 1] as LoadedVersion & { _eval?: unknown })._eval = evalInfo;
  }

  // ---- pass 2: cross-object + class policy
  const canonicalOf = (id: string) => versions.filter((v) => v.maturity === "canonical" && v.id === id);
  const seen = new Set<string>();
  for (const v of versions) {
    const key = `${v.id}@${v.version}`;
    const where = `blueprints/${v.maturity}/${v.id}/${v.version}`;
    if (seen.has(key)) err(where, `version ${key} exists as both candidate and canonical`);
    seen.add(key);
    const bp = v.blueprint;
    const classPolicy = policy.classes[v.provenanceClass];

    // versioning
    const canon = canonicalOf(v.id);
    if (v.maturity === "candidate") {
      if (!canon.length && parseSemver(v.version).major !== 0) err(where, "a candidate with no canonical release must be 0.y.z");
      if (canon.length && !canon.every((c) => compareSemver(v.version, c.version) > 0)) err(where, "candidate version must be greater than every canonical version of the same id");
    }

    // origin-specific structure
    const ev = bp.provenance.evolution;
    if (ev) {
      if (ev.kind === "discovered" && (ev.parents?.length ?? 0) > 0) err(where, "'discovered' blueprints have no parents; use kind 'refined'");
      if (ev.kind === "refined" && !(ev.parents?.length > 0)) err(where, "'refined' blueprints must list parents");
      if (ev.recurrence.distinctWorkspaceCount > ev.recurrence.executionCount) err(where, "distinctWorkspaceCount cannot exceed executionCount");
    }

    // admission requirements (apply to candidates AND canonical)
    const adm = classPolicy.admission;
    const admRec = resolveRecurrence(adm.recurrence, policy);
    if (admRec) checkRecurrence(ev?.recurrence, admRec, `${where} (admission, class ${v.provenanceClass})`, err);
    if (adm.requireParentCanonical) {
      for (const p of ev?.parents ?? []) {
        const parent = versions.find((c) => c.maturity === "canonical" && c.id === p.id && c.version === p.version);
        if (!parent) err(where, `parent ${p.id}@${p.version} is not a canonical version in this registry`);
        else if (parent.lifecycle === "revoked") err(where, `parent ${p.id}@${p.version} is revoked`);
      }
    }
    if (adm.requireLicenceSpdx && !bp.provenance.upstream?.licence?.spdx) err(where, "upstream seed requires a declared licence SPDX id");

    // promotion requirements (canonical only)
    if (v.maturity === "canonical") {
      const pr = load(join(v.dir, FILES.promotion), "promotion", `${where}/promotion.yaml`);
      if (!pr) continue;
      const pol = classPolicy.promotion;
      syntheticRule(`${where}/promotion synthetic`, pr.synthetic);
      pr.reviewers.forEach((r: Doc) => actorRule(`${where}/promotion reviewer`, r.identity));
      if (pr.provenanceClass !== v.provenanceClass) err(where, `promotion record class '${pr.provenanceClass}' != derived class '${v.provenanceClass}'`);
      if (pr.policyVersion > policy.policyVersion) err(where, "promotion record cites a newer policy version than the current policy");
      if (pr.reviewers.length < pol.minHumanReviewers) err(where, `promotion needs >= ${pol.minHumanReviewers} reviewers for class ${v.provenanceClass}`);
      const roles = new Set(pr.reviewers.map((r: Doc) => r.role));
      for (const role of pol.requiredReviewerRoles ?? []) if (!roles.has(role)) err(where, `promotion lacks required reviewer role '${role}'`);
      const promRec = resolveRecurrence(pol.recurrence ?? "none", policy);
      if (promRec) checkRecurrence(ev?.recurrence, promRec, `${where} (promotion, class ${v.provenanceClass})`, err);
      if (pol.requireLicenceVerified && bp.provenance.upstream?.licence?.status !== "verified") err(where, "promotion requires verified upstream licence");
      if (pol.requireSecurityValidationPassed && bp.provenance.upstream?.securityValidation !== "passed") err(where, "promotion requires passed upstream security validation");
      if (pol.requireEvalPass) {
        const info = (v as LoadedVersion & { _eval?: { bestPassRate: number } })._eval;
        if (!info || info.bestPassRate < bp.evaluation.gates.minPassRate) err(where, `promotion requires an eval result with passRate >= ${bp.evaluation.gates.minPassRate}`);
      }
      if (!v.sealDigest) err(where, "canonical versions must be sealed");
    }
  }

  return { root, purpose, diagnostics, versions };
}

// ---------------------------------------------------------------------------------------------

type Err = (where: string, message: string) => void;

function resolveRecurrence(spec: unknown, policy: Doc): { minDistinctWorkspaces: number; minExecutions: number } | null {
  if (spec === "none") return null;
  if (spec === "default") return policy.wisdomOfComputeDefaults.recurrence;
  return spec as { minDistinctWorkspaces: number; minExecutions: number };
}

function checkRecurrence(rec: Doc | undefined, req: { minDistinctWorkspaces: number; minExecutions: number }, where: string, err: Err) {
  if (!rec) return err(where, "requires recurrence evidence (provenance.evolution.recurrence)");
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

function checkEvidenceMarkers(bp: Doc, purpose: string, where: string, err: Err) {
  for (const [i, e] of (bp.provenance.evidence ?? []).entries()) {
    if (purpose === "example" && (e.synthetic !== true || !String(e.ref).startsWith("SYNTHETIC-"))) err(where, `evidence[${i}] must be synthetic with a 'SYNTHETIC-' ref in an example root`);
    if (purpose === "production" && (e.synthetic === true || String(e.ref).startsWith("SYNTHETIC-"))) err(where, `evidence[${i}] is synthetic in a production root`);
  }
}

function checkBlueprint(bp: Doc, vd: VersionDir, where: string, err: Err, warn: Err) {
  const unique = (label: string, xs: string[]) => {
    const dup = xs.filter((x, i) => xs.indexOf(x) !== i);
    if (dup.length) err(where, `duplicate ${label}: ${[...new Set(dup)].join(", ")}`);
  };
  const steps: Doc[] = bp.procedure.steps, slots: Doc[] = bp.slots, skills: Doc[] = bp.skills, caps: Doc[] = bp.capabilities;
  unique("step ids", steps.map((s) => s.id));
  unique("slot names", slots.map((s) => s.name));
  unique("skill keys", skills.map((s) => s.key));
  unique("capability keys", caps.map((s) => s.key));
  unique("input names", bp.interface.inputs.map((s: Doc) => s.name));
  unique("output names", bp.interface.outputs.map((s: Doc) => s.name));

  // slots <-> procedure placeholders
  const slotNames = new Set(slots.map((s) => s.name));
  const used = new Set<string>();
  for (const s of steps) for (const m of String(s.instruction).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    const m1 = /^slot\.([a-z][a-z0-9_]*)$/.exec(m[1]!);
    if (!m1) err(where, `step '${s.id}': placeholder {{${m[1]}}} must be of the form {{slot.<name>}}`);
    else if (!slotNames.has(m1[1]!)) err(where, `step '${s.id}': undeclared slot '${m1[1]}'`);
    else used.add(m1[1]!);
  }
  for (const s of slots) {
    if (!used.has(s.name)) err(where, `slot '${s.name}' is never referenced by the procedure`);
    if (s.type === "enum" && !s.enum) err(where, `enum slot '${s.name}' needs an enum list`);
    if (s.type !== "enum" && s.enum) err(where, `non-enum slot '${s.name}' must not declare enum`);
    if (s.type === "enum" && s.default !== undefined && !s.enum?.includes(s.default)) err(where, `slot '${s.name}' default is not in enum`);
  }
  const capKeys = new Set(caps.map((c) => c.key)), skillKeys = new Set(skills.map((c) => c.key));
  for (const s of steps) {
    for (const k of s.usesCapabilities ?? []) if (!capKeys.has(k)) err(where, `step '${s.id}' uses unknown capability '${k}'`);
    for (const k of s.usesSkills ?? []) if (!skillKeys.has(k)) err(where, `step '${s.id}' uses unknown skill '${k}'`);
  }
  const usedCaps = new Set(steps.flatMap((s) => s.usesCapabilities ?? [])), usedSkills = new Set(steps.flatMap((s) => s.usesSkills ?? []));
  for (const c of caps) if (!usedCaps.has(c.key)) warn(where, `capability '${c.key}' is not used by any step`);
  for (const s of skills) if (!usedSkills.has(s.key)) warn(where, `skill '${s.key}' is not used by any step`);

  // capability effects (AgentGit-inspired classification)
  const rank = { reversible: 0, compensable: 1, irreversible: 2 } as const;
  for (const c of caps) {
    if (c.effect === "irreversible" && c.approval !== "required") err(where, `irreversible capability '${c.key}' requires approval: required`);
    if (c.effect === "compensable" && !c.compensation) err(where, `compensable capability '${c.key}' must describe its compensation`);
    if (rank[c.effect as keyof typeof rank] > rank[bp.securityClassification.maxEffect as keyof typeof rank]) err(where, `capability '${c.key}' exceeds securityClassification.maxEffect`);
  }

  // adaptation contract
  const groups: [string, Doc[]][] = [["mayAlter", bp.adaptation.mayAlter], ["mustPreserve", bp.adaptation.mustPreserve], ["locked", bp.adaptation.locked]];
  const refSets: Record<string, Set<string>> = { step: new Set(steps.map((s) => s.id)), slot: slotNames, skill: skillKeys, capability: capKeys };
  const classified = new Map<string, string[]>();
  for (const [g, entries] of groups) for (const e of entries) {
    const { kind, ref } = e.target;
    if (kind in refSets) {
      if (!ref) err(where, `adaptation.${g}: target kind '${kind}' requires ref`);
      else if (!refSets[kind]!.has(ref)) err(where, `adaptation.${g}: unknown ${kind} '${ref}'`);
      else classified.set(`${kind}:${ref}`, [...(classified.get(`${kind}:${ref}`) ?? []), g]);
    } else if (ref) err(where, `adaptation.${g}: target kind '${kind}' takes no ref`);
    if (g === "mayAlter" && ["securityClassification", "interface", "evaluation"].includes(kind)) err(where, `adaptation.mayAlter must not include '${kind}' (the compiler may never alter it)`);
  }
  for (const [kind, set] of Object.entries(refSets)) for (const ref of set) {
    const g = classified.get(`${kind}:${ref}`) ?? [];
    if (g.length === 0) err(where, `adaptation: ${kind} '${ref}' is not classified as mayAlter/mustPreserve/locked`);
    if (g.length > 1) err(where, `adaptation: ${kind} '${ref}' is classified more than once (${g.join(", ")})`);
  }
  if (!bp.adaptation.locked.some((e: Doc) => e.target.kind === "securityClassification")) err(where, "adaptation.locked must include securityClassification");

  // paths stay inside the version directory
  const inside = (p: string) => resolve(vd.dir, p).startsWith(resolve(vd.dir) + sep);
  for (const p of [bp.evaluation.suite, ...(bp.evaluation.results ?? []), bp.provenance.sanitisation.report]) {
    if (!inside(p)) err(where, `path '${p}' escapes the version directory`);
    else if (!exists(join(vd.dir, p))) err(where, `referenced file '${p}' does not exist`);
  }
}

function checkEvaluation(bp: Doc, vd: VersionDir, where: string, load: (p: string, n: SchemaName, w?: string) => Doc | undefined, syntheticRule: (w: string, f: unknown) => void, err: Err, _purpose: string) {
  const suitePath = join(vd.dir, bp.evaluation.suite);
  const suite = exists(suitePath) ? load(suitePath, "eval-suite", `${where}/${bp.evaluation.suite}`) : undefined;
  let bestPassRate = 0;
  if (suite) {
    syntheticRule(`${where}/eval suite synthetic`, suite.synthetic);
    const graders = new Set(suite.graders.map((g: Doc) => g.id));
    const caseIds = suite.cases.map((c: Doc) => c.id);
    if (new Set(caseIds).size !== caseIds.length) err(where, "duplicate eval case ids");
    for (const c of suite.cases) for (const x of c.expectations) if (!graders.has(x.grader)) err(where, `eval case '${c.id}' uses unknown grader '${x.grader}'`);
    const suiteDigest = fileDigest(suitePath);
    for (const rp of bp.evaluation.results ?? []) {
      const path = join(vd.dir, rp);
      const res = exists(path) ? load(path, "eval-result", `${where}/${rp}`) : undefined;
      if (!res) continue;
      syntheticRule(`${where}/${rp} synthetic`, res.synthetic);
      if (res.subject.id !== bp.id || res.subject.version !== bp.version) err(where, `${rp}: subject does not match blueprint`);
      if (res.suiteDigest !== suiteDigest) err(where, `${rp}: suiteDigest does not match the suite (stale result)`);
      const passed = res.caseResults.filter((c: Doc) => c.passed).length;
      if (res.summary.cases !== res.caseResults.length || res.summary.passed !== passed) err(where, `${rp}: summary does not match caseResults`);
      if (Math.abs(res.summary.passRate - passed / res.caseResults.length) > 1e-9) err(where, `${rp}: passRate does not match caseResults`);
      for (const c of res.caseResults) if (!caseIds.includes(c.case)) err(where, `${rp}: unknown case '${c.case}'`);
      bestPassRate = Math.max(bestPassRate, res.summary.passRate);
    }
  }
  return { bestPassRate };
}

export function formatDiagnostics(ds: Diagnostic[]): string {
  return ds.map((d) => `${d.severity.toUpperCase().padEnd(7)} ${d.where}: ${d.message}`).join("\n");
}
export { readYaml };
