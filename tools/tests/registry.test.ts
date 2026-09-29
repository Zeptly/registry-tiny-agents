import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { A, B, C, EXAMPLE, append, edit, errors, has, tempRoot } from "./helpers.js";
import { REPO_ROOT, DEFAULT_POLICY, readYaml, readJson } from "../src/load.js";
import { formatRef, isRegistryId, parseRef } from "../src/ids.js";
import { compareSemver } from "../src/semver.js";
import { buildIndex } from "../src/index-gen.js";
import { checkImmutability } from "../src/immutability.js";
import { Scanner } from "../src/scan.js";
import { validateRoot } from "../src/validate.js";

test("repository root and synthetic example root validate cleanly", () => {
  assert.deepEqual(errors(REPO_ROOT), []);
  assert.deepEqual(errors(EXAMPLE), []);
});

test("production root is empty: no synthetic example leaks into the real catalogue", () => {
  assert.equal(validateRoot(REPO_ROOT).versions.length, 0);
});

test("committed indexes are up to date and deterministic", () => {
  for (const root of [REPO_ROOT, EXAMPLE]) {
    const a = buildIndex(root).text, b = buildIndex(root).text;
    assert.equal(a, b);
    assert.equal(a, readFileSync(join(root, "index", "registry-index.json"), "utf8"));
  }
});

test("reference/id serialisation is isolated and round-trips (PROVISIONAL)", () => {
  const ref = { registry: "skills", id: "synthetic.summarise-text", version: "^1.0.0" };
  assert.deepEqual(parseRef(formatRef(ref)), ref);
  const withDigest = { ...ref, digest: "sha256:" + "a".repeat(64) };
  assert.deepEqual(parseRef(formatRef(withDigest)), withDigest);
  assert.ok(isRegistryId("example.structured-summary"));
  assert.ok(!isRegistryId("Bad/Id"));
});

test("semver comparison", () => {
  assert.ok(compareSemver("0.9.0", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});

// ---- protocol: abstract capabilities only -------------------------------------------------

test("concrete MCP/provider configuration keys are rejected", () => {
  const r = tempRoot();
  edit(r, `${C}/blueprint.yaml`, (d) => { d.servers = [{ command: "x" }]; d.modelPolicy.model = "x"; });
  const es = errors(r);
  assert.ok(has(es, "servers"));
  assert.ok(has(es, "additional") || has(es, "forbidden-key"));
});

test("executable commands, endpoints, credentials, concrete model ids and workspace ids are rejected in text", () => {
  const cases: [string, string][] = [
    ["Run npx some-package to fetch data.", "executable-command"],
    ["Call https://internal.example/api for data.", "url"],
    ["Use password: hunter2hunter2 for access.", "secret-assignment"],
    ["Prefer gpt-4 for this step.", "concrete-model-id"],
    ["Learned from workspace_a1b2c3d4 runs.", "workspace-identifier"],
    ["Contact jane.doe@customer.example about it.", "email"],
  ];
  for (const [text, detector] of cases) {
    const r = tempRoot();
    edit(r, `${C}/blueprint.yaml`, (d) => { d.procedure.steps[1].instruction = `${text} {{slot.answer_style}}`; });
    assert.ok(has(errors(r), `[${detector}]`), `expected ${detector} for: ${text}`);
  }
});

test("secrets hidden in YAML comments are caught", () => {
  const r = tempRoot();
  append(r, `${C}/blueprint.yaml`, "\n# key AKIAABCDEFGHIJKLMNOP\n");
  assert.ok(has(errors(r), "secret-aws"));
});

test("scanner never echoes matched content", () => {
  const s = new Scanner(readYaml(DEFAULT_POLICY).privacy);
  const f = s.scanValue({ note: "AKIAABCDEFGHIJKLMNOP" }, "f");
  assert.equal(f.length, 1);
  assert.ok(!JSON.stringify(f).includes("AKIAABCDEFGHIJKLMNOP"));
});

test("evidence may not carry content, only the declared reference fields", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.provenance.evidence[0].transcript = "raw content"; });
  assert.ok(has(errors(r), "transcript"));
});

// ---- adaptation contract ------------------------------------------------------------------

test("every step/slot/skill/capability must be classified exactly once", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.adaptation.mayAlter.pop(); });
  assert.ok(has(errors(r), "is not classified"));
  const r2 = tempRoot();
  edit(r2, `${B}/blueprint.yaml`, (d) => { d.adaptation.locked.push({ target: { kind: "step", ref: "classify" }, reason: "dup" }); });
  assert.ok(has(errors(r2), "classified more than once"));
});

test("compiler may never alter the security classification", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.adaptation.mayAlter.push({ target: { kind: "securityClassification" }, operations: ["tighten"], bounds: "x" }); });
  assert.ok(has(errors(r), "must not include 'securityClassification'"));
});

test("slots and placeholders must agree", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.procedure.steps[1].instruction = "Use {{slot.nonexistent}}"; });
  const es = errors(r);
  assert.ok(has(es, "undeclared slot"));
  assert.ok(has(es, "never referenced"));
});

test("effect classes: irreversible needs approval, compensable needs compensation, maxEffect bounds all", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => {
    d.capabilities[1].effect = "irreversible"; delete d.capabilities[1].compensation;
  });
  const es = errors(r);
  assert.ok(has(es, "requires approval"));
  assert.ok(has(es, "exceeds securityClassification.maxEffect"));
  const r2 = tempRoot();
  edit(r2, `${B}/blueprint.yaml`, (d) => { delete d.capabilities[1].compensation; });
  assert.ok(has(errors(r2), "must describe its compensation"));
});

// ---- provenance classes / recurrence policy -----------------------------------------------

test("a deliberately designed (native) blueprint needs no recurrence evidence", () => {
  const bp = readYaml(join(EXAMPLE, A, "blueprint.yaml"));
  assert.equal(bp.origin, "native");
  assert.equal(bp.provenance.evolution, undefined);
  assert.deepEqual(errors(EXAMPLE), []);
});

test("discovered candidates must meet the recurrence policy (default 3, but only as policy)", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.provenance.evolution.recurrence.distinctWorkspaceCount = 2; });
  assert.ok(has(errors(r), "2 distinct workspaces < policy minimum 3"));

  // Changing the policy — not code — changes the outcome.
  const pol = readYaml(DEFAULT_POLICY);
  pol.wisdomOfComputeDefaults.recurrence.minDistinctWorkspaces = 2;
  const p = join(mkdtempSync(join(tmpdir(), "pol-")), "policy.yaml");
  writeFileSync(p, stringify(pol));
  assert.ok(!has(errors(r, p), "recurrence")); // remaining errors are only the stale digests caused by this edit
});

test("upstream seeds and refined candidates carry their own admission rules", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.provenance.evolution = { kind: "refined", parents: [], recurrence: { distinctWorkspaceCount: 4, executionCount: 37 }, method: { name: "m", version: "0" } }; });
  assert.ok(has(errors(r), "'refined' blueprints must list parents"));
  const r2 = tempRoot();
  edit(r2, `${B}/blueprint.yaml`, (d) => { d.provenance.evolution.kind = "refined"; d.provenance.evolution.parents = [{ id: "example.missing", version: "1.0.0" }]; });
  assert.ok(has(errors(r2), "is not a canonical version"));
  const r3 = tempRoot();
  edit(r3, `${C}/blueprint.yaml`, (d) => { d.provenance.upstream.licence.spdx = ""; });
  assert.ok(errors(r3).length > 0);
});

test("a refined candidate of a canonical blueprint is admitted when parent and recurrence are valid", () => {
  const r = tempRoot();
  const dest = join(r, "blueprints/candidates/example.structured-summary/1.1.0");
  mkdirSync(dest, { recursive: true });
  cpSync(join(r, A), dest, { recursive: true });
  for (const f of ["integrity.json", "promotion.yaml"]) rmSync(join(dest, f)); // candidates are not sealed
  edit(r, "blueprints/candidates/example.structured-summary/1.1.0/blueprint.yaml", (d) => {
    d.version = "1.1.0"; d.maturity = "candidate"; d.origin = "evolved";
    delete d.provenance.native;
    d.provenance.evolution = { kind: "refined", parents: [{ id: d.id, version: "1.0.0" }], recurrence: { distinctWorkspaceCount: 3, executionCount: 12 }, method: { name: "synthetic", version: "0" } };
  });
  const es = errors(r).filter((e) => e.includes("structured-summary/1.1.0"));
  // Only stale-attestation errors remain (report/eval digests were bound to the 1.0.0 text).
  assert.ok(!has(es, "recurrence"), es.join("\n"));
  assert.ok(!has(es, "parent"), es.join("\n"));
  assert.ok(!has(es, "greater than every canonical"), es.join("\n"));
});

// ---- maturity / lifecycle / immutability --------------------------------------------------

test("candidate versioning rules", () => {
  const r = tempRoot();
  const dest = join(r, "blueprints/candidates/example.request-triage/1.0.0");
  cpSync(join(r, B), dest, { recursive: true });
  edit(r, "blueprints/candidates/example.request-triage/1.0.0/blueprint.yaml", (d) => { d.version = "1.0.0"; });
  assert.ok(has(errors(r), "must be 0.y.z"));
});

test("canonical content is sealed: any edit breaks the integrity digest", () => {
  const r = tempRoot();
  edit(r, `${A}/blueprint.yaml`, (d) => { d.intent.summary = "Changed after publication."; });
  assert.ok(has(errors(r), "sealed content changed"));
});

test("lifecycle transitions are validated; revoked is terminal", () => {
  const r = tempRoot();
  edit(r, `${A}/lifecycle.yaml`, (d) => {
    d.state = "active";
    d.history.push({ state: "revoked", at: "2026-03-01T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" });
    d.history.push({ state: "active", at: "2026-03-02T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" });
  });
  assert.ok(has(errors(r), "illegal lifecycle transition revoked -> active"));
  const ok = tempRoot();
  edit(ok, `${A}/lifecycle.yaml`, (d) => { d.state = "deprecated"; d.history.push({ state: "deprecated", at: "2026-03-01T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" }); });
  assert.deepEqual(errors(ok), []); // lifecycle is outside the seal by design
});

test("canonical promotion requires reviewers, roles and passing evals per class policy", () => {
  const r = tempRoot();
  edit(r, `${A}/promotion.yaml`, (d) => { d.reviewers = []; });
  assert.ok(has(errors(r), "needs >= 1 reviewers"));
  const r2 = tempRoot();
  edit(r2, `${A}/blueprint.yaml`, (d) => { d.evaluation.gates.minPassRate = 1.0; d.evaluation.results = []; });
  assert.ok(has(errors(r2), "promotion requires an eval result"));
});

test("stale attestations are rejected (sanitisation digest, eval suite digest, submission digests)", () => {
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.intent.summary = "Edited after the report was written."; });
  const es = errors(r);
  assert.ok(has(es, "sanitisation report digest does not match"));
  assert.ok(has(es, "submission blueprintDigest does not match"));
  const r2 = tempRoot();
  append(r2, `${A}/evals/suite.yaml`, "# touched\n");
  assert.ok(has(errors(r2), "suiteDigest does not match"));
});

test("synthetic and placeholder content is confined to example roots", () => {
  const r = tempRoot();
  edit(r, "registry.yaml", (d) => { d.purpose = "production"; });
  const es = errors(r);
  assert.ok(has(es, "synthetic content is not allowed in a production registry root"));
  assert.ok(has(es, "placeholder identity"));
  const r2 = tempRoot();
  edit(r2, `${A}/blueprint.yaml`, (d) => { d.metadata.synthetic = false; });
  assert.ok(has(errors(r2), "example registry roots require synthetic: true"));
});

test("upstream seeds must resolve to a declared source; nothing may be imported while specified-only", () => {
  const r = tempRoot();
  edit(r, `${C}/blueprint.yaml`, (d) => { d.provenance.upstream.source = "unknown-source"; });
  assert.ok(has(errors(r), "has no <root>/upstreams/ descriptor"));
  const lock = readJson(join(REPO_ROOT, "upstreams/huggingface-tiny-agents/lock.json"));
  assert.equal(lock.entries.length, 0);
  assert.equal(lock.pinnedRevision, null);
});

test("git immutability check: published canonical files cannot change; lifecycle is append-only", () => {
  const d = mkdtempSync(join(tmpdir(), "imm-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  cpSync(join(EXAMPLE, "blueprints"), join(d, "blueprints"), { recursive: true });
  git("add", "-A"); git("commit", "-q", "-m", "base");
  const lc = join(d, A, "lifecycle.yaml");

  // legal: append lifecycle
  const doc = parse(readFileSync(lc, "utf8"));
  doc.state = "deprecated"; doc.history.push({ state: "deprecated", at: "2026-03-01T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" });
  writeFileSync(lc, stringify(doc));
  git("commit", "-qam", "deprecate");
  assert.deepEqual(checkImmutability(d, "HEAD~1"), []);

  // illegal: edit sealed file
  writeFileSync(join(d, A, "blueprint.yaml"), readFileSync(join(d, A, "blueprint.yaml"), "utf8") + "\n# edit\n");
  git("commit", "-qam", "tamper");
  assert.ok(checkImmutability(d, "HEAD~1").some((x) => x.message.includes("immutable")));

  // illegal: rewrite lifecycle history
  const doc2 = parse(readFileSync(lc, "utf8")); doc2.history[0].reason = "rewritten";
  writeFileSync(lc, stringify(doc2)); git("commit", "-qam", "rewrite");
  assert.ok(checkImmutability(d, "HEAD~1").some((x) => x.message.includes("append-only")));

  // illegal: add a file to a published version directory
  writeFileSync(join(d, A, "extra.yaml"), "a: 1\n"); git("add", "-A"); git("commit", "-qm", "add");
  assert.ok(checkImmutability(d, "HEAD~1").some((x) => x.message.includes("already-published")));
});
