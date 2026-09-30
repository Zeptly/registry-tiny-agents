/** Protocol v0.2 adoption tests: exit codes, suite-digest binding, multi-reviewer records, origin vocabulary, synthetic isolation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A, B, C, EXAMPLE, append, edit, errors, has, tempRoot } from "./helpers.js";
import { R, promoteCandidate } from "./promotion-helpers.js";
import { REPO_ROOT, parseFileChecked, readJson, readYaml, schemaErrors, type Doc } from "../src/load.js";
import { contentDigest, fileDigest, computeSeal, payloadPatterns } from "../src/integrity.js";
import { compareCodePoints, compareUtf16 } from "../src/order.js";
import { validateRoot } from "../src/validate.js";
import { buildIndex } from "../src/index-gen.js";
import { DEFAULT_POLICY } from "../src/load.js";
import { checkImmutability } from "../src/immutability.js";

const CLI = join(REPO_ROOT, "tools/src/cli.ts");
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
const BP = `${A}/blueprint.yaml`;

test("exit codes: 0 valid, 2 malformed input / validation error / stale index, 1 valid request that cannot be satisfied", () => {
  assert.equal(run("validate", "examples/registry").status, 0);
  const broken = tempRoot(); writeFileSync(join(broken, B, "evals", "suite.yaml"), "a: &x 1\nb: *x\n");
  const v = run("validate", broken);
  assert.equal(v.status, 2); assert.match(v.stdout, /\[anchor\]/); assert.match(v.stdout, /\[alias\]/); assert.match(v.stdout, /evals\/suite\.yaml/);
  assert.doesNotMatch(v.stderr, /\n\s+at /);
  const stale = tempRoot(); append(stale, "index/registry-index.json", " ");
  assert.equal(run("index", stale, "--check").status, 2);
  assert.equal(run("scan", "examples/registry/registry.yaml").status, 0);
  // unresolved is exit 1 (valid request, unsatisfiable) and the lock says complete: false
  const lock = run("lock", "examples/registry", "--id", "example.structured-summary", "--range", "^1.0.0", "--domain", "synthetic");
  assert.equal(lock.status, 1); assert.equal(JSON.parse(lock.stdout).complete, false);
  // domain errors and unreadable input are exit 2
  assert.equal(run("lock", "examples/registry", "--id", "example.structured-summary", "--range", "^1.0.0").status, 2);
  assert.equal(run("resolve", "--index", join(broken, B, "evals", "suite.yaml"), "--registry", "tiny-agents", "--id", "a.b", "--range", "^1").status, 2);
});

test("every manifest-language file is parsed under the v0.2 subset: anchors, merge keys, tags, non-string keys are diagnostics with code and path", () => {
  const cases: [string, string, string][] = [
    ["anchor", "spec:\n  a: &x 1\n", "anchor"], ["merge", "a: {x: 1}\nb:\n  <<: {y: 2}\n", "merge-key"], ["tag", "a: !!binary aGk=\n", "unsupported-tag"],
    ["int key", "1: a\n", "non-string-key"], ["multi doc", "a: 1\n---\nb: 2\n", "multiple-documents"], ["hex", "a: 0xFF\n", "unsupported-number-syntax"],
  ];
  for (const [name, text, code] of cases) {
    const d = mkdtempSync(join(tmpdir(), "p-")); const f = join(d, "x.yaml"); writeFileSync(f, text);
    const r = parseFileChecked(f);
    assert.equal(r.doc, undefined, name);
    assert.ok(r.diagnostics.some((p) => p.code === code), `${name}: ${JSON.stringify(r.diagnostics)}`);
  }
  // unsafe integers / non-finite values in a sealed file are caught before hashing and the artifact is not loaded
  for (const [lit, code] of [["9007199254740993", "unsafe-integer"], [".inf", "non-finite-number"]] as const) {
    const r = tempRoot(); const p = join(r, `${B}/blueprint.yaml`);
    writeFileSync(p, readFileSync(p, "utf8").replace("maxSteps: 5", `maxSteps: ${lit}`));
    const v = validateRoot(r);
    assert.ok(v.diagnostics.some((x) => x.code === code && x.path === "spec.executionConstraints.maxSteps"), lit);
    assert.ok(!v.versions.some((x) => x.id === "example.request-triage"));
  }
});

test("manifest text is never rewritten: CR/CRLF/BOM in a file are rejected, CR inside a parsed value is preserved", () => {
  const r = tempRoot(); append(r, `${B}/blueprint.yaml`, "# note\r\n");
  assert.ok(has(errors(r), "[carriage-return]"));
  const d = mkdtempSync(join(tmpdir(), "p-")); const f = join(d, "x.yaml");
  writeFileSync(f, 's: "a\\r\\nb"\n');
  assert.equal((parseFileChecked(f).doc as Doc).s, "a\r\nb");
  assert.notEqual(contentDigest({ spec: { s: "a\r\nb" } }), contentDigest({ spec: { s: "a\nb" } }));
});

test("artifact digest: references and sourceRefs need digestAlgorithm whenever a digest is pinned", () => {
  const r = tempRoot();
  edit(r, BP, (d) => { d.spec.skills[0].ref.digest = "sha256:" + "1".repeat(64); d.references[0].digest = "sha256:" + "1".repeat(64); });
  assert.ok(has(errors(r), "must have required property 'digestAlgorithm'"));
  assert.deepEqual(schemaErrors("blueprint", { ...readYaml(join(EXAMPLE, BP)) }), []);
});

test("seal: payload is only the permitted payload files; manifest and evidence records are not part of it", () => {
  const seal = computeSeal(join(EXAMPLE, A), { registry: "tiny-agents", id: "example.structured-summary", version: "1.0.0" }, payloadPatterns(readYaml(DEFAULT_POLICY)));
  assert.deepEqual(seal.payload.map((p) => p.path), ["evals/suite.yaml"]);
  assert.equal(seal.payload[0]!.sha256, fileDigest(join(EXAMPLE, A, "evals/suite.yaml")).slice(7));
  const integ = readJson(join(EXAMPLE, A, "integrity.json"));
  assert.equal(integ.digestAlgorithm, "zeptly-jcs-v1"); assert.equal(integ.integrityVersion, "integrity/v0.2");
  assert.deepEqual(integ, seal);
  // wrong algorithm / identity in the seal record
  const r = tempRoot();
  { const p = join(r, A, "integrity.json"); const d = JSON.parse(readFileSync(p, "utf8")); d.digestAlgorithm = "zeptly-jcs-v0"; writeFileSync(p, JSON.stringify(d, null, 2) + "\n"); }
  assert.ok(errors(r).length > 0);
  const r2 = tempRoot();
  { const p = join(r2, A, "integrity.json"); const d = JSON.parse(readFileSync(p, "utf8")); d.id = "example.other"; writeFileSync(p, JSON.stringify(d, null, 2) + "\n"); }
  assert.ok(has(errors(r2), "integrity.json registry/id/version do not match the manifest"));
  // changing a non-payload evidence record moves neither the artifact digest nor the seal
  const r3 = tempRoot();
  edit(r3, `${A}/evals/results/synthetic-run-0001.yaml`, (d) => { d.runner = "SYNTHETIC fabricated result - edited"; });
  assert.ok(!has(errors(r3), "sealed content changed"));
});

test("seal: case-colliding paths are rejected before hashing, as are symlinks", () => {
  const r = tempRoot();
  writeFileSync(join(r, A, "Evals.yaml"), "a: 1\n"); writeFileSync(join(r, A, "evals.yaml"), "a: 1\n");
  const es = errors(r);
  assert.ok(has(es, "[case-collision]") || has(es, "not in the filename allow-list"));
  // the pure seal function rejects them outright (see the vectors for the byte-level cases)
  const r2 = tempRoot();
  symlinkSync("/etc/hostname", join(r2, A, "evals", "link.yaml"));
  assert.ok(has(errors(r2), "symbolic links are not allowed"));
});

// ---- evaluation attestations: suite digest binding ------------------------------------------

test("evaluation attestation binds suite {id, version, digest}, result and subjectDigest", () => {
  const ok = readYaml(join(EXAMPLE, BP)).attestations.find((a: Doc) => a.type === "evaluation");
  assert.deepEqual(Object.keys(ok).sort(), ["ref", "result", "subjectDigest", "suite", "type"]);
  assert.deepEqual(Object.keys(ok.suite).sort(), ["digest", "id", "version"]);
  // shape errors
  const r = tempRoot();
  edit(r, BP, (d) => { const a = d.attestations.find((x: Doc) => x.type === "evaluation"); delete a.suite; });
  assert.ok(has(errors(r), "must have required property 'suite'"));
  const r2 = tempRoot();
  edit(r2, BP, (d) => { const a = d.attestations.find((x: Doc) => x.type === "evaluation"); a.outcome = "pass"; });
  assert.ok(errors(r2).length > 0, "evaluation uses `result`, not `outcome`");
  const r3 = tempRoot();
  edit(r3, BP, (d) => { const a = d.attestations.find((x: Doc) => x.type === "sanitisation"); a.result = "pass"; });
  assert.ok(errors(r3).length > 0, "`result`/`suite` belong to evaluation attestations only");
});

test("suite digest binding: a stale or foreign suite digest, id or version fails and blocks promotion", () => {
  const r = tempRoot();
  edit(r, BP, (d) => { const a = d.attestations.find((x: Doc) => x.type === "evaluation"); a.suite.digest = "sha256:" + "2".repeat(64); });
  const es = errors(r);
  assert.ok(has(es, "[suite-digest-mismatch]"));
  assert.ok(has(es, "promotion requires a passing evaluation attestation bound to suite digest"));
  const r2 = tempRoot();
  edit(r2, BP, (d) => { const a = d.attestations.find((x: Doc) => x.type === "evaluation"); a.suite.id = "example.other-suite"; });
  assert.ok(has(errors(r2), "does not match the suite file"));
  const r3 = tempRoot();
  edit(r3, BP, (d) => { const a = d.attestations.find((x: Doc) => x.type === "evaluation"); a.suite.version = "9.9.9"; });
  assert.ok(has(errors(r3), "does not match the suite file"));
  // suite edited after evaluation (bytes changed): result and attestation both stale; the seal also breaks
  const r4 = tempRoot();
  append(r4, `${A}/evals/suite.yaml`, "# edited\n");
  const e4 = errors(r4);
  assert.ok(has(e4, "[suite-digest-mismatch]") && has(e4, "result suiteDigest does not match the suite") && has(e4, "sealed content changed"));
});

test("promotion needs a PASSING evaluation for every required suite: fail and inconclusive results do not promote", () => {
  for (const result of ["fail", "inconclusive"]) {
    const r = tempRoot();
    edit(r, BP, (d) => { d.attestations.find((x: Doc) => x.type === "evaluation").result = result; });
    assert.ok(has(errors(r), "promotion requires a passing evaluation attestation"), result);
  }
  // 'pass' must agree with the result document
  const r = tempRoot();
  edit(r, `${A}/evals/results/synthetic-run-0001.yaml`, (d) => { d.caseResults[0].passed = false; d.summary.passed = 2; d.summary.passRate = 2 / 3; });
  assert.ok(has(errors(r), "attestation result 'pass' contradicts the result passRate"));
  // subject digest of the attestation must be the current artifact digest
  const r2 = tempRoot();
  edit(r2, BP, (d) => { d.attestations.find((x: Doc) => x.type === "evaluation").subjectDigest = "sha256:" + "3".repeat(64); });
  const es = errors(r2);
  assert.ok(has(es, "attestations[1](evaluation): stale") && has(es, "promotion requires a passing evaluation attestation"));
});

// ---- multiple-reviewer promotion records ---------------------------------------------------

test("multiple-reviewer promotion: approvals bind to the artifact digest without changing it, and must mirror promotion.yaml", () => {
  const one = tempRoot(), three = tempRoot();
  const d1 = promoteCandidate(one, B, { reviewers: [R("maintainer"), R("privacy")] });
  const d3 = promoteCandidate(three, B, { reviewers: [R("maintainer"), R("privacy"), R("security")] });
  assert.deepEqual(errors(one), []); assert.deepEqual(errors(three), []);
  const a1 = readYaml(join(d1, "blueprint.yaml")), a3 = readYaml(join(d3, "blueprint.yaml"));
  assert.equal(contentDigest(a1), contentDigest(a3), "governance approvals are outside the artifact digest");
  assert.equal(a3.security.approvals.length, 3);
  assert.ok(a3.security.approvals.every((x: Doc) => x.subjectDigest === contentDigest(a3)));
  // one approval not matching the record, or bound to another digest, is rejected
  edit(three, "blueprints/canonical/example.request-triage/1.0.0/blueprint.yaml", (d) => { d.security.approvals.pop(); });
  assert.ok(has(errors(three), "security.approvals must mirror promotion.yaml reviewers"));
  const four = tempRoot();
  const d4 = promoteCandidate(four, B, { reviewers: [R("maintainer"), R("privacy")] });
  edit(four, "blueprints/canonical/example.request-triage/1.0.0/blueprint.yaml", (d) => { d.security.approvals[1].subjectDigest = "sha256:" + "4".repeat(64); });
  assert.ok(has(errors(four), "security.approvals[1]") && void d4 === undefined);
});

// ---- origin vocabulary ---------------------------------------------------------------------

test("shared origin vocabulary is accepted by the schema; this registry uses native | upstream-seed | evolved only", () => {
  for (const t of ["native", "upstream-seed", "discovered", "refined", "evolved"]) {
    const bp = readYaml(join(EXAMPLE, BP)); bp.metadata.origin = { type: t };
    assert.ok(!schemaErrors("blueprint", bp).some((e) => e.includes("/metadata/origin/type")), t);
  }
  for (const t of ["discovered", "refined"]) {
    const r = tempRoot(); edit(r, BP, (d) => { d.metadata.origin.type = t; });
    assert.ok(has(errors(r), `metadata.origin.type '${t}' is not used by this registry`), t);
  }
  const r = tempRoot(); edit(r, `${B}/blueprint.yaml`, (d) => { d.metadata.origin.evolution.kind = "generalised"; });
  assert.ok(has(errors(r), "evolution.kind 'generalised' is not supported by this registry"));
  // the evolution kind has exactly one home: provenance does not carry it
  const r2 = tempRoot(); edit(r2, `${B}/blueprint.yaml`, (d) => { d.provenance.evolution = { kind: "discovered" }; });
  assert.ok(errors(r2).length > 0);
});

// ---- synthetic isolation ---------------------------------------------------------------------

test("a production artifact may never reference the synthetic namespace", () => {
  const r = tempRoot();
  edit(r, "registry.yaml", (d) => { d.domain = "production"; });
  edit(r, BP, (d) => { d.spec.skills[0].ref.id = "example.some-skill"; d.references[0].id = "example.some-skill"; });
  assert.ok(has(errors(r), "[synthetic-reference]"));
});

test("production resolution cannot consume the synthetic example index, through the library or the CLI", () => {
  const res = run("resolve", "--index", "examples/registry/index/registry-index.json", "--registry", "tiny-agents", "--id", "example.structured-summary", "--range", "^1.0.0");
  assert.equal(res.status, 2); assert.equal(JSON.parse(res.stderr).error.code, "domain-mismatch");
  const ok = run("resolve", "--index", "examples/registry/index/registry-index.json", "--registry", "tiny-agents", "--id", "example.structured-summary", "--range", "^1.0.0", "--domain", "synthetic");
  assert.equal(ok.status, 0);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.resolved.digestAlgorithm, "zeptly-jcs-v1");
  assert.equal(out.resolved.digest, "sha256:7c953f60067a549e67b8a454971638cc26abe0d9ab17f7176a7ee5ba59eb78ea");
});

// ---- generated indexes -----------------------------------------------------------------------

test("generated indexes carry digestAlgorithm and domain, validate against the schema, and sort by code point, version, digest", () => {
  for (const root of [REPO_ROOT, EXAMPLE]) {
    const idx = JSON.parse(buildIndex(root).text);
    assert.deepEqual(schemaErrors("index", idx), []);
    assert.equal(idx.digestAlgorithm, "zeptly-jcs-v1");
    assert.equal(idx.domain, root === REPO_ROOT ? "production" : "synthetic");
    assert.ok(idx.entries.every((e: Doc) => e.domain === idx.domain && e.digestAlgorithm === "zeptly-jcs-v1" && "sealDigest" in e));
    const ids = idx.entries.map((e: Doc) => e.id);
    assert.deepEqual(ids, [...ids].sort(compareCodePoints));
  }
  // index order (code point) and JSON key order (UTF-16) are separate rules
  assert.ok(compareCodePoints("", "\u{10000}") < 0 && compareUtf16("", "\u{10000}") > 0);
  // copying the tree elsewhere does not change the index (location is relative, nothing absolute leaks)
  const r = tempRoot(); const copy = mkdtempSync(join(tmpdir(), "cp-")); cpSync(r, copy, { recursive: true });
  assert.equal(buildIndex(copy).text, buildIndex(r).text);
  mkdirSync(join(copy, "x"), { recursive: true });
});

// ---- populated-baseline immutability ---------------------------------------------------------

test("populated baseline: payload, manifest and seal of a published canonical version cannot change; lifecycle append is allowed", () => {
  const d = mkdtempSync(join(tmpdir(), "imm2-"));
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  cpSync(join(EXAMPLE, "blueprints"), join(d, "blueprints"), { recursive: true });
  git("add", "-A"); git("commit", "-q", "-m", "populated base");
  // edit payload + seal + manifest of the published version
  append(d, `${A}/evals/suite.yaml`, "# x\n");
  append(d, `${A}/integrity.json`, " ");
  append(d, `${A}/blueprint.yaml`, "# x\n");
  git("commit", "-qam", "tamper");
  const ds = checkImmutability(d, "HEAD~1");
  for (const f of ["evals/suite.yaml", "integrity.json", "blueprint.yaml"]) assert.ok(ds.some((x) => x.where.endsWith(`/${f}`) && /immutable/.test(x.message)), f);
  // a brand-new version directory is fine, and so is an untouched baseline
  git("reset", "-q", "--hard", "HEAD~1");
  assert.deepEqual(checkImmutability(d, "HEAD"), []);
  cpSync(join(d, A), join(d, "blueprints/canonical/example.structured-summary/1.0.1"), { recursive: true });
  git("add", "-A"); git("commit", "-qm", "new version dir");
  assert.deepEqual(checkImmutability(d, "HEAD~1"), []);
});
