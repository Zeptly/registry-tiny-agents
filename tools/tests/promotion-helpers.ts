/**
 * Test-only builders that construct valid promoted canonical versions in DISPOSABLE copies of the synthetic example root.
 * They recompute digests inside the temp copy (never in the repository fixtures) so a test can start from a fully valid
 * state and then break exactly one thing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Doc } from "../src/load.js";
import { contentDigest, fileDigest, sealDir } from "../src/integrity.js";
import { idSegment } from "../src/layout.js";

const rd = (p: string): Doc => parse(readFileSync(p, "utf8"));
const wr = (p: string, d: unknown) => writeFileSync(p, stringify(d, { lineWidth: 0, aliasDuplicateObjects: false }));

export interface Reviewer { identity: string; role: "maintainer" | "security" | "privacy" }
export const R = (role: Reviewer["role"], n = 1): Reviewer => ({ identity: `PLACEHOLDER-reviewer-${role}-${n}`, role });

/** Recompute every digest-bound record of one version directory (attestations, approvals, documents, submission). */
export function rebind(dir: string): string {
  const bpPath = join(dir, "blueprint.yaml");
  const bp = rd(bpPath);
  const digest = contentDigest(bp);
  for (const a of bp.attestations) a.subjectDigest = digest;
  for (const a of bp.security.approvals) a.subjectDigest = digest;
  const suiteDoc = rd(join(dir, bp.spec.evaluation.suite));
  for (const a of bp.attestations) if (a.type === "evaluation") a.suite = { id: suiteDoc.id, version: suiteDoc.version, digest: fileDigest(join(dir, bp.spec.evaluation.suite)) };
  wr(bpPath, bp);
  for (const a of bp.attestations) {
    if (!String(a.ref).startsWith("file:")) continue;
    const p = join(dir, a.ref.slice(5));
    const d = rd(p);
    d.subjectDigest = digest;
    if (a.type === "evaluation") d.suiteDigest = fileDigest(join(dir, bp.spec.evaluation.suite));
    wr(p, d);
  }
  const promo = join(dir, "promotion.yaml");
  if (existsSync(promo)) { const d = rd(promo); d.subjectDigest = digest; wr(promo, d); }
  const subPath = join(dir, "submission.yaml");
  if (existsSync(subPath)) {
    const sub = rd(subPath);
    const san = bp.attestations.find((a: Doc) => a.type === "sanitisation");
    sub.artifacts = { subjectDigest: digest, sanitisationReportDigest: fileDigest(join(dir, san.ref.slice(5))), evalSuiteDigest: fileDigest(join(dir, bp.spec.evaluation.suite)) };
    wr(subPath, sub);
  }
  return digest;
}

export interface PromoteOpts {
  version?: string;
  reviewers: Reviewer[];
  mutate?: (bp: Doc) => void;
  /** write approvals into blueprint.security.approvals (default true) */
  approvals?: boolean;
}

/** Promote a candidate directory (relative to root) to a sealed canonical version; returns the canonical directory. */
export function promoteCandidate(root: string, candidateRel: string, o: PromoteOpts): string {
  const src = join(root, candidateRel);
  const bp0 = rd(join(src, "blueprint.yaml"));
  const version = o.version ?? "1.0.0";
  const dest = join(root, "blueprints", "canonical", idSegment(bp0.metadata.id), version);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  rmSync(join(dest, "submission.yaml"), { force: true });

  const suite = rd(join(dest, "evals", "suite.yaml"));
  mkdirSync(join(dest, "evals", "results"), { recursive: true });
  const cases = suite.cases.map((c: Doc) => c.id);
  wr(join(dest, "evals", "results", "synthetic-run-0001.yaml"), {
    resultVersion: "eval-result/v1alpha1", synthetic: true, subject: { id: bp0.metadata.id }, subjectDigest: "sha256:" + "0".repeat(64),
    suiteDigest: "sha256:" + "0".repeat(64), runner: "SYNTHETIC fabricated result - not a real evaluation run",
    summary: { cases: cases.length, passed: cases.length, passRate: 1 }, caseResults: cases.map((c: string) => ({ case: c, passed: true })),
  });
  const bp = rd(join(dest, "blueprint.yaml"));
  bp.metadata.version = version; bp.metadata.maturity = "canonical";
  o.mutate?.(bp);
  bp.attestations = [
    ...bp.attestations.filter((a: Doc) => a.type === "sanitisation" || a.type === "recurrence"),
    { type: "evaluation", ref: "file:evals/results/synthetic-run-0001.yaml", suite: { id: suite.id, version: suite.version, digest: "sha256:" + "0".repeat(64) }, result: "pass", subjectDigest: "sha256:" + "0".repeat(64) },
    { type: "security-review", ref: "evidence://synthetic/security-review/0001", subjectDigest: "sha256:" + "0".repeat(64), outcome: "pass" },
  ];
  bp.security.approvals = o.approvals === false ? [] : o.reviewers.map((r) => ({ role: r.role, identity: r.identity, subjectDigest: "sha256:" + "0".repeat(64) }));
  wr(join(dest, "blueprint.yaml"), bp);
  wr(join(dest, "promotion.yaml"), {
    promotionVersion: "promotion/v1alpha1", synthetic: true, promotedFrom: { maturity: "candidate", version: bp0.metadata.version },
    decidedAt: "2026-03-01T00:00:00Z", policyVersion: 0, reviewers: o.reviewers, gatesChecked: ["eval-pass", "sanitisation-report", "security-review", "human-review"],
    subjectDigest: "sha256:" + "0".repeat(64), notes: "SYNTHETIC record for a test fixture. No real review took place.",
  });
  rebind(dest);
  sealDir(dest);
  rmSync(src, { recursive: true, force: true });
  return dest;
}

/** Derive a `refined` candidate of the canonical example (example.structured-summary 1.0.0 -> 1.1.0). */
export function makeRefinedCandidate(root: string, over: { sourceRef?: (parent: Doc) => Doc; recurrence?: Doc } = {}): string {
  const parentDir = join(root, "blueprints/canonical/example.structured-summary/1.0.0");
  const parentBp = rd(join(parentDir, "blueprint.yaml"));
  const parentDigest = contentDigest(parentBp);
  const rel = "blueprints/candidates/example.structured-summary/1.1.0";
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  cpSync(parentDir, dir, { recursive: true });
  for (const f of ["integrity.json", "promotion.yaml"]) rmSync(join(dir, f));
  rmSync(join(dir, "evals", "results"), { recursive: true, force: true });
  const bp = rd(join(dir, "blueprint.yaml"));
  const parentRef = { registry: "tiny-agents", id: bp.metadata.id, version: "1.0.0", digest: parentDigest, digestAlgorithm: "zeptly-jcs-v1" };
  bp.metadata.version = "1.1.0"; bp.metadata.maturity = "candidate";
  bp.metadata.origin = { type: "evolved", evolution: { kind: "refined", sourceRefs: [over.sourceRef ? over.sourceRef(parentRef) : parentRef] } };
  bp.spec.lineage = { recurrence: over.recurrence ?? { distinctWorkspaceCount: 3, executionCount: 12 } };
  bp.provenance.transformations = [{ type: "clustering", tool: { name: "synthetic-clustering-placeholder", version: "0" } }];
  bp.security.approvals = [];
  bp.attestations = bp.attestations.filter((a: Doc) => a.type === "sanitisation");
  bp.attestations.push({ type: "recurrence", ref: "evidence://synthetic/recurrence/0101", subjectDigest: "sha256:" + "0".repeat(64) });
  wr(join(dir, "blueprint.yaml"), bp);
  rebind(dir);
  return rel;
}

/** Add `n` skills (each entry carries a `role` field) to a candidate and keep every derived/bound record consistent. */
export function addSkills(dir: string, n: number): void {
  const bp = rd(join(dir, "blueprint.yaml"));
  for (let i = 1; i <= n; i++) {
    const ref = { registry: "skills", id: `demo.skill-${i}`, version: "^1.0.0" };
    bp.spec.skills.push({ key: `skill_${i}`, ref, role: `Synthetic skill ${i} used by the first step.`, required: false });
    bp.references.push(ref);
    bp.spec.adaptation.mustPreserve.push({ target: { kind: "skill", ref: `skill_${i}` }, invariant: "The referenced skill stays in use." });
  }
  bp.spec.procedure.steps[0].usesSkills = Array.from({ length: n }, (_, i) => `skill_${i + 1}`);
  wr(join(dir, "blueprint.yaml"), bp);
  rebind(dir);
}
