import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { A, B, C, EXAMPLE, append, edit, errors, has, tempRoot } from "./helpers.js";
import { REPO_ROOT, DEFAULT_POLICY, readYaml, readJson, schemaErrors, type Doc } from "../src/load.js";
import { describeRef, isRegistryId } from "../src/ids.js";
import { compareSemver, satisfies } from "../src/semver.js";
import { buildIndex } from "../src/index-gen.js";
import { checkImmutability } from "../src/immutability.js";
import { Scanner } from "../src/scan.js";
import { validateRoot } from "../src/validate.js";
import { contentDigest } from "../src/integrity.js";
import { idSegment } from "../src/layout.js";
import { buildLock, resolveRef } from "../src/resolve.js";

const BP = `${A}/blueprint.yaml`, BB = `${B}/blueprint.yaml`, BC = `${C}/blueprint.yaml`;

// ---- baseline ------------------------------------------------------------------------------

test("repository root and synthetic example root validate cleanly", () => {
  assert.deepEqual(errors(REPO_ROOT), []);
  assert.deepEqual(errors(EXAMPLE), []);
});

test("production root is empty and its index cannot contain synthetic entries", () => {
  assert.equal(validateRoot(REPO_ROOT).versions.length, 0);
  const prod = readJson(join(REPO_ROOT, "index", "registry-index.json"));
  assert.equal(prod.domain, "production");
  assert.ok(prod.entries.every((e: Doc) => e.domain === "production"));
  // schema-level guard: an index whose top-level domain disagrees with synthetic entries is rejected by the resolver (see domain tests)
  const ex = readJson(join(EXAMPLE, "index", "registry-index.json"));
  assert.deepEqual(schemaErrors("index", ex), []);
  assert.ok(schemaErrors("index", { ...ex, domain: "staging" }).length > 0);
  assert.ok(schemaErrors("index", { ...ex, digestAlgorithm: "zeptly-jcs-v0" }).length > 0);
});

test("indexes are deterministic, up to date, and carry the protocol fields", () => {
  for (const root of [REPO_ROOT, EXAMPLE]) {
    const a = buildIndex(root).text, b = buildIndex(root).text;
    assert.equal(a, b);
    assert.equal(a, readFileSync(join(root, "index", "registry-index.json"), "utf8"));
  }
  const idx = readJson(join(EXAMPLE, "index", "registry-index.json"));
  for (const e of idx.entries) for (const f of ["registry", "id", "version", "digest", "digestAlgorithm", "sealDigest", "maturity", "lifecycle", "origin", "location", "domain"]) assert.ok(f in e, `missing ${f}`);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(idx)), "index must not contain timestamps");
});

// ---- envelope ------------------------------------------------------------------------------

test("common envelope: kind, metadata.{id,version,registry}, references, provenance, security, attestations", () => {
  const bp = readYaml(join(EXAMPLE, BP));
  assert.equal(bp.apiVersion, "registry.zeptly.dev/v1alpha1");
  assert.equal(bp.kind, "TinyAgentBlueprint");
  assert.equal(bp.metadata.registry, "tiny-agents");
  for (const k of ["references", "provenance", "security", "attestations", "spec"]) assert.ok(k in bp, k);
  const r = tempRoot();
  edit(r, BP, (d) => { delete d.metadata.registry; });
  assert.ok(has(errors(r), "schema(blueprint)"));
});

test("maturity, origin and lifecycle are independent; lifecycle is overlay-only", () => {
  const bp = readYaml(join(EXAMPLE, BP));
  assert.equal(bp.metadata.maturity, "canonical");
  assert.equal(bp.metadata.origin.type, "native");
  assert.equal(bp.metadata.lifecycle, undefined);
  const r = tempRoot();
  edit(r, BP, (d) => { d.metadata.lifecycle = "active"; });
  assert.ok(has(errors(r), "lifecycle"));
  // origin and maturity vary independently across the examples
  const idx = readJson(join(EXAMPLE, "index", "registry-index.json"));
  const combos = new Set(idx.entries.map((e: Doc) => `${e.maturity}/${e.origin.type}`));
  assert.ok(combos.has("canonical/native") && combos.has("candidate/evolved") && combos.has("candidate/upstream-seed"));
});

test("references are structural objects (digest optional or null); strings and unknown fields are rejected", () => {
  const ok = { registry: "skills", id: "some.skill", version: "^1.0.0", digest: null };
  const good = tempRoot();
  edit(good, BP, (d) => { d.references[0] = ok; d.spec.skills[0].ref = ok; });
  assert.ok(!has(errors(good), "schema(blueprint)"));
  const bad = tempRoot();
  edit(bad, BP, (d) => { d.references[0] = "skills:some.skill@^1.0.0"; });
  assert.ok(has(errors(bad), "schema(blueprint)"));
  assert.equal(describeRef({ registry: "skills", id: "x.y", version: "1.0.0" }), "skills/x.y@1.0.0");
  assert.ok(isRegistryId("research.web-fact-check"));
  assert.ok(!isRegistryId("bad_id.underscore") && !isRegistryId("Upper.case") && !isRegistryId("a..b") && !isRegistryId("-a.b"));
});

test("envelope fields derived from spec must agree (references, security.capabilities, approvals)", () => {
  const r = tempRoot();
  edit(r, BP, (d) => { d.references = []; });
  assert.ok(has(errors(r), "references must equal"));
  const r2 = tempRoot();
  edit(r2, BP, (d) => { d.security.capabilities[0].effect = "irreversible"; });
  assert.ok(has(errors(r2), "security.capabilities must equal"));
  const r3 = tempRoot();
  edit(r3, BP, (d) => { d.security.approvals = []; });
  assert.ok(has(errors(r3), "security.approvals must mirror promotion.yaml reviewers"));
  const r4 = tempRoot();
  edit(r4, BB, (d) => { d.security.approvals = [{ role: "maintainer", identity: "PLACEHOLDER-x", subjectDigest: d.attestations[0].subjectDigest }]; });
  assert.ok(has(errors(r4), "candidates carry no governance approvals"));
});

test("origin, lineage and provenance tell one consistent story", () => {
  const r = tempRoot();
  edit(r, BP, (d) => { d.spec.lineage = { recurrence: { distinctWorkspaceCount: 3, executionCount: 10 } }; });
  const es = errors(r);
  assert.ok(has(es, "native blueprints require spec.lineage.native"));
  assert.ok(has(es, "spec.lineage.recurrence is not allowed for origin native"));
  const r2 = tempRoot();
  edit(r2, BC, (d) => { d.provenance.sourceRefs = []; d.provenance.transformations = []; });
  const es2 = errors(r2);
  assert.ok(has(es2, "require an upstream provenance.sourceRefs"));
  assert.ok(has(es2, "normalisation transformation"));
});

// ---- semver ranges ------------------------------------------------------------------------

test("semver comparison and range matching", () => {
  assert.ok(compareSemver("0.9.0", "1.0.0") < 0);
  assert.ok(compareSemver("1.0.0-rc.1", "1.0.0") < 0);
  const yes: [string, string][] = [["1.2.3", "^1.0.0"], ["1.2.3", "~1.2.0"], ["1.2.3", "1.x"], ["1.2.3", "*"], ["1.2.3", ">=1.0.0 <2.0.0"], ["0.1.5", "^0.1.0"], ["2.0.0", "^1.0.0 || ^2.0.0"], ["1.0.0", "1.0.0"]];
  const no: [string, string][] = [["2.0.0", "^1.0.0"], ["1.3.0", "~1.2.0"], ["0.2.0", "^0.1.0"], ["1.0.0-rc.1", "^1.0.0"], ["1.0.1", "1.0.0"]];
  for (const [v, r] of yes) assert.ok(satisfies(v, r), `${v} should satisfy ${r}`);
  for (const [v, r] of no) assert.ok(!satisfies(v, r), `${v} should not satisfy ${r}`);
});

// ---- protocol: abstract capabilities only -------------------------------------------------

test("concrete MCP/provider configuration keys are rejected", () => {
  const r = tempRoot();
  edit(r, BC, (d) => { d.spec.servers = [{ command: "x" }]; d.spec.modelPolicy.model = "x"; });
  const es = errors(r);
  assert.ok(has(es, "servers"));
  assert.ok(has(es, "additional") || has(es, "forbidden-key"));
});

test("executable commands, endpoints, credentials, concrete model ids, workspace ids and emails are rejected", () => {
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
    edit(r, BC, (d) => { d.spec.procedure.steps[1].instruction = `${text} {{slot.answer_style}}`; });
    assert.ok(has(errors(r), `[${detector}]`), `expected ${detector} for: ${text}`);
  }
});

test("secrets hidden in YAML comments are caught; the scanner never echoes matches", () => {
  const r = tempRoot();
  append(r, BC, "\n# key AKIAABCDEFGHIJKLMNOP\n");
  assert.ok(has(errors(r), "secret-aws"));
  const s = new Scanner(readYaml(DEFAULT_POLICY).privacy);
  const f = s.scanValue({ note: "AKIAABCDEFGHIJKLMNOP" }, "f");
  assert.equal(f.length, 1);
  assert.ok(!JSON.stringify(f).includes("AKIAABCDEFGHIJKLMNOP"));
});

test("attestations carry pointers only, never content", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.attestations[1].transcript = "raw content"; });
  assert.ok(has(errors(r), "transcript"));
});

test("no runtime tapes or sensitive payloads: unexpected file types and oversized files are rejected", () => {
  const r = tempRoot();
  writeFileSync(join(r, B, "trajectory.jsonl"), '{"role":"user"}\n');
  assert.ok(has(errors(r), "filename allow-list"));
  const r2 = tempRoot();
  append(r2, `${B}/evals/suite.yaml`, "# " + "a".repeat(300_000) + "\n");
  assert.ok(has(errors(r2), "exceeds"));
  const r3 = tempRoot();
  edit(r3, BB, (d) => { d.attestations.push({ type: "recurrence", ref: "evidence://prod/session/abc", subjectDigest: d.attestations[0].subjectDigest }); });
  assert.ok(has(errors(r3), "synthetic roots require 'evidence://synthetic/'"));
});

// ---- adaptation contract ------------------------------------------------------------------

test("every step/slot/skill/capability must be classified exactly once", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.spec.adaptation.mayAlter.pop(); });
  assert.ok(has(errors(r), "is not classified"));
  const r2 = tempRoot();
  edit(r2, BB, (d) => { d.spec.adaptation.locked.push({ target: { kind: "step", ref: "classify" }, reason: "dup" }); });
  assert.ok(has(errors(r2), "classified more than once"));
});

test("compiler/runtime may never alter the security envelope", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.spec.adaptation.mayAlter.push({ target: { kind: "security" }, operations: ["tighten"], bounds: "x" }); });
  assert.ok(has(errors(r), "must not include 'security'"));
  const r2 = tempRoot();
  edit(r2, BB, (d) => { d.spec.adaptation.locked = d.spec.adaptation.locked.filter((e: Doc) => e.target.kind !== "security"); });
  assert.ok(has(errors(r2), "adaptation.locked must include the security envelope"));
});

test("slots and placeholders must agree", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.spec.procedure.steps[1].instruction = "Use {{slot.nonexistent}}"; });
  const es = errors(r);
  assert.ok(has(es, "undeclared slot"));
  assert.ok(has(es, "never referenced"));
});

test("effect classes: irreversible needs approval, compensable needs compensation, maxEffect bounds all", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.spec.capabilities[1].effect = "irreversible"; delete d.spec.capabilities[1].compensation; });
  const es = errors(r);
  assert.ok(has(es, "requires approval"));
  assert.ok(has(es, "exceeds spec.effects.maxEffect"));
  const r2 = tempRoot();
  edit(r2, BB, (d) => { delete d.spec.capabilities[1].compensation; });
  assert.ok(has(errors(r2), "must describe its compensation"));
});

// ---- provenance classes / recurrence policy -----------------------------------------------

test("a deliberately designed (native) blueprint needs no recurrence evidence", () => {
  const bp = readYaml(join(EXAMPLE, BP));
  assert.equal(bp.metadata.origin.type, "native");
  assert.equal(bp.spec.lineage.recurrence, undefined);
  assert.deepEqual(errors(EXAMPLE), []);
});

test("discovered candidates must meet the recurrence policy (default 3, but only as policy)", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.spec.lineage.recurrence.distinctWorkspaceCount = 2; });
  assert.ok(has(errors(r), "2 distinct workspaces < policy minimum 3"));
  const pol = readYaml(DEFAULT_POLICY);
  pol.wisdomOfComputeDefaults.recurrence.minDistinctWorkspaces = 2;
  const p = join(mkdtempSync(join(tmpdir(), "pol-")), "policy.yaml");
  writeFileSync(p, stringify(pol, { aliasDuplicateObjects: false }));
  assert.ok(!has(errors(r, p), "distinct workspaces")); // remaining errors are only the stale attestations caused by this edit
});

test("refined candidates require canonical parents pinned by digest", () => {
  const mk = () => {
    const r = tempRoot();
    const dest = join(r, "blueprints/candidates/example.structured-summary/1.1.0");
    mkdirSync(dest, { recursive: true });
    cpSync(join(r, A), dest, { recursive: true });
    for (const f of ["integrity.json", "promotion.yaml"]) rmSync(join(dest, f));
    return r;
  };
  const rel = "blueprints/candidates/example.structured-summary/1.1.0/blueprint.yaml";
  const parentDigest = contentDigest(readYaml(join(EXAMPLE, BP)));
  const refine = (r: string, sourceRefs: Doc[]) => edit(r, rel, (d) => {
    d.metadata.version = "1.1.0"; d.metadata.maturity = "candidate"; d.metadata.origin = { type: "evolved", evolution: { kind: "refined", sourceRefs } };
    d.spec.lineage = { recurrence: { distinctWorkspaceCount: 3, executionCount: 12 } };
    d.provenance.transformations = [{ type: "clustering", tool: { name: "synthetic", version: "0" } }];
  });
  const parent = { registry: "tiny-agents", id: "example.structured-summary", version: "1.0.0", digest: parentDigest, digestAlgorithm: "zeptly-jcs-v1" };

  const good = mk(); refine(good, [parent]);
  const es = errors(good).filter((e) => e.includes("structured-summary/1.1.0"));
  for (const bad of ["recurrence", "parent", "greater than every canonical", "sourceRefs"]) assert.ok(!has(es, bad), `${bad}: ${es.join("\n")}`);

  const noDigest = mk(); refine(noDigest, [{ ...parent, digest: undefined }]);
  assert.ok(has(errors(noDigest), "must carry the exact digest"));
  const wrongDigest = mk(); refine(wrongDigest, [{ ...parent, digest: "sha256:" + "0".repeat(64) }]);
  assert.ok(has(errors(wrongDigest), "digest does not match the canonical parent"));
  const missing = mk(); refine(missing, [{ ...parent, id: "example.missing" }]);
  assert.ok(has(errors(missing), "is not an exact canonical version"));
  const none = mk(); refine(none, []);
  assert.ok(has(errors(none), "'refined' blueprints must list sourceRefs"));
});

// ---- maturity / lifecycle / immutability --------------------------------------------------

test("candidate versioning rules", () => {
  const r = tempRoot();
  const dest = join(r, "blueprints/candidates/example.request-triage/1.0.0");
  cpSync(join(r, B), dest, { recursive: true });
  edit(r, "blueprints/candidates/example.request-triage/1.0.0/blueprint.yaml", (d) => { d.metadata.version = "1.0.0"; });
  assert.ok(has(errors(r), "must be 0.y.z"));
});

test("canonical content is sealed: any edit breaks the integrity digest", () => {
  const r = tempRoot();
  // the manifest is represented by the ARTIFACT digest (stale attestations and promotion record), the payload by the SEAL
  edit(r, BP, (d) => { d.spec.intent.summary = "Changed after publication."; });
  assert.ok(has(errors(r), "stale: subjectDigest"));
  const r2 = tempRoot();
  append(r2, `${A}/evals/suite.yaml`, "# tampered\n");
  assert.ok(has(errors(r2), "sealed content changed"));
});

test("lifecycle is an append-only overlay: it changes neither digest nor seal, and is indexed independently", () => {
  const r = tempRoot();
  const before = readJson(join(EXAMPLE, "index", "registry-index.json")).entries.find((e: Doc) => e.id === "example.structured-summary");
  edit(r, `${A}/lifecycle.yaml`, (d) => { d.state = "deprecated"; d.history.push({ state: "deprecated", at: "2026-03-01T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" }); });
  assert.deepEqual(errors(r), []);
  const after = JSON.parse(buildIndex(r).text).entries.find((e: Doc) => e.id === "example.structured-summary");
  assert.equal(after.lifecycle, "deprecated");
  assert.equal(after.digest, before.digest);
  assert.equal(after.sealDigest, before.sealDigest);
  const bad = tempRoot();
  edit(bad, `${A}/lifecycle.yaml`, (d) => {
    d.history.push({ state: "revoked", at: "2026-03-01T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" });
    d.history.push({ state: "active", at: "2026-03-02T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" });
  });
  assert.ok(has(errors(bad), "illegal lifecycle transition revoked -> active"));
});

test("canonical promotion requires reviewers, roles, passing evals and required attestations", () => {
  const r = tempRoot();
  edit(r, `${A}/promotion.yaml`, (d) => { d.reviewers = []; });
  assert.ok(has(errors(r), "needs >= 1 reviewers"));
  const r2 = tempRoot();
  edit(r2, BP, (d) => { d.attestations = d.attestations.filter((a: Doc) => a.type !== "evaluation"); });
  const es = errors(r2);
  assert.ok(has(es, "promotion requires an attestation of type 'evaluation'"));
  assert.ok(has(es, "promotion requires a passing evaluation attestation bound to suite digest"));
  const r3 = tempRoot();
  edit(r3, BP, (d) => { d.attestations = d.attestations.filter((a: Doc) => a.type !== "security-review"); });
  assert.ok(has(errors(r3), "promotion requires an attestation of type 'security-review'"));
});

// ---- digest-bound attestations ------------------------------------------------------------

test("attestations fail when the subject digest is stale", () => {
  const r = tempRoot();
  edit(r, BB, (d) => { d.spec.intent.summary = "Edited after the attestations were made."; });
  const es = errors(r);
  assert.ok(has(es, "attestations[0](sanitisation): stale"));
  assert.ok(has(es, "attestations[1](recurrence): stale"));
  assert.ok(has(es, "report subjectDigest does not match"));
  assert.ok(has(es, "submission subjectDigest does not match"));
  const r2 = tempRoot();
  append(r2, `${A}/evals/suite.yaml`, "# touched\n");
  assert.ok(has(errors(r2), "suiteDigest does not match"));
  const r3 = tempRoot();
  edit(r3, `${A}/promotion.yaml`, (d) => { d.subjectDigest = "sha256:" + "1".repeat(64); });
  assert.ok(has(errors(r3), "promotion record subjectDigest does not match"));
});

test("promotion does not invalidate attestations: digest excludes attestations, version and maturity", () => {
  const bp = readYaml(join(EXAMPLE, BP));
  const d0 = contentDigest(bp);
  const moved = JSON.parse(JSON.stringify(bp));
  moved.metadata.version = "2.0.0"; moved.metadata.maturity = "candidate"; moved.attestations = [];
  assert.equal(contentDigest(moved), d0);
  moved.spec.intent.summary = "different";
  assert.notEqual(contentDigest(moved), d0);
});

// ---- synthetic / production isolation -----------------------------------------------------

test("synthetic and placeholder content is confined to example roots", () => {
  const r = tempRoot();
  edit(r, "registry.yaml", (d) => { d.domain = "production"; });
  const es = errors(r);
  assert.ok(has(es, "synthetic content is not allowed in a production registry root"));
  assert.ok(has(es, "placeholder identity"));
  assert.ok(has(es, "reserved for the synthetic namespace"));
  assert.ok(has(es, "synthetic evidence reference in a production root"));
  const r2 = tempRoot();
  edit(r2, BP, (d) => { d.metadata.synthetic = false; });
  assert.ok(has(errors(r2), "synthetic registry roots require synthetic: true"));
});

test("upstream seeds resolve to a declared source; nothing may be imported while specified-only", () => {
  const r = tempRoot();
  edit(r, BC, (d) => { d.provenance.sourceRefs[0].upstream.source = "unknown-source"; });
  assert.ok(has(errors(r), "has no <root>/upstreams/ descriptor"));
  const lock = readJson(join(REPO_ROOT, "upstreams/huggingface-tiny-agents/lock.json"));
  assert.equal(lock.entries.length, 0);
  assert.equal(lock.pinnedRevision, null);
});

// ---- identity decoupled from layout -------------------------------------------------------

test("logical identity comes from the document, not from directory names", () => {
  assert.equal(idSegment("example.a-b_c"), "example.a-b_c");
  assert.equal(idSegment("Ab/c"), "~41b~2fc"); // ids outside the safe set are encoded for the filesystem
  const r = tempRoot();
  renameSync(join(r, "blueprints/candidates/example.request-triage"), join(r, "blueprints/candidates/arbitrary-dir"));
  const v = validateRoot(r);
  assert.ok(v.versions.some((x) => x.id === "example.request-triage" && x.location === "blueprints/candidates/arbitrary-dir/0.1.0"));
  assert.ok(v.diagnostics.some((d) => d.message.includes("not at its expected location 'blueprints/candidates/example.request-triage/0.1.0'")));
});

test("index reports artifact location; consumers need not derive paths from ids", () => {
  const idx = readJson(join(EXAMPLE, "index", "registry-index.json"));
  const e = idx.entries.find((x: Doc) => x.id === "example.structured-summary");
  assert.equal(e.location, "blueprints/canonical/example.structured-summary/1.0.0");
});

// ---- local reference checks ---------------------------------------------------------------

test("tiny-agents references are checked structurally and against the root; other registries need no network", () => {
  const r = tempRoot();
  const ref = { registry: "tiny-agents", id: "example.structured-summary", version: "1.0.0", digest: "sha256:" + "0".repeat(64), digestAlgorithm: "zeptly-jcs-v1" };
  edit(r, BB, (d) => {
    d.spec.skills.push({ key: "sub", ref, role: "x", required: false });
    d.references.push(ref);
  });
  assert.ok(has(errors(r), "digest does not match the referenced canonical version"));
  const r2 = tempRoot();
  const self = { registry: "tiny-agents", id: "example.request-triage", version: "0.1.0" };
  edit(r2, BB, (d) => { d.spec.skills.push({ key: "sub", ref: self, role: "x", required: false }); d.references.push(self); });
  assert.ok(has(errors(r2), "must not reference itself"));
  assert.deepEqual(errors(EXAMPLE), []); // the skills reference is unresolvable offline yet valid
});

// ---- exact runtime locks ------------------------------------------------------------------

const entry = (id: string, version: string, over: Doc = {}): Doc => ({ registry: "tiny-agents", id, version, digest: "sha256:" + version.replace(/\D/g, "").padEnd(64, "a"), sealDigest: null, digestAlgorithm: "zeptly-jcs-v1", maturity: "canonical", lifecycle: "active", domain: "production", origin: { type: "native" }, location: `x/${id}/${version}`, ...over });
const idxOf = (...entries: Doc[]): Doc => ({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RegistryIndex", registry: "tiny-agents", digestAlgorithm: "zeptly-jcs-v1", domain: "production", entries });

test("resolver turns ranges into exact version + digest; candidates, revoked and deprecated-by-range are excluded", () => {
  const idx = idxOf(entry("x.y", "1.0.0"), entry("x.y", "1.2.0"), entry("x.y", "1.3.0", { lifecycle: "deprecated" }), entry("x.y", "1.4.0", { lifecycle: "revoked" }), entry("x.y", "2.0.0"), entry("x.y", "0.9.0", { maturity: "candidate" }));
  const ref = (version: string, extra: Doc = {}) => ({ registry: "tiny-agents", id: "x.y", version, ...extra });
  assert.equal(resolveRef([idx], ref("^1.0.0")).resolved?.version, "1.2.0");
  assert.equal(resolveRef([idx], ref("*")).resolved?.version, "2.0.0");
  assert.equal(resolveRef([idx], ref("1.3.0")).resolved?.version, "1.3.0"); // exact pin may select deprecated
  assert.equal(resolveRef([idx], ref("1.4.0")).unresolved?.code, "no-eligible-version"); // revoked never resolves
  assert.equal(resolveRef([idx], ref("^0.9.0")).unresolved?.code, "no-eligible-version"); // candidate excluded by default
  assert.equal(resolveRef([idx], ref("^0.9.0"), { allowCandidates: true }).resolved?.version, "0.9.0");
  assert.equal(resolveRef([idx], ref("^1.0.0", { digest: "sha256:" + "f".repeat(64), digestAlgorithm: "zeptly-jcs-v1" })).unresolved?.code, "digest-mismatch");
  const pinned = resolveRef([idx], ref("^1.0.0")).resolved!;
  assert.equal(resolveRef([idx], ref("^1.0.0", { digest: pinned.digest, digestAlgorithm: "zeptly-jcs-v1" })).resolved?.digest, pinned.digest);
});

test("lock is deterministic, schema-valid, and lists foreign references explicitly as unresolved (never omitted)", () => {
  const idx = readJson(join(EXAMPLE, "index", "registry-index.json"));
  const bp = readYaml(join(EXAMPLE, BP));
  const me = idx.entries.find((e: Doc) => e.id === "example.structured-summary");
  const subject = { registry: "tiny-agents", id: me.id, version: me.version, digest: me.digest };
  const ex = { domain: "synthetic" as const }; // the synthetic index must be resolved explicitly as the synthetic domain
  const a = buildLock([idx], subject, bp.references, ex), b = buildLock([idx], subject, bp.references, ex);
  assert.deepEqual(a, b);
  assert.deepEqual(schemaErrors("runtime-lock", a), []);
  assert.equal(a.entries.length, bp.references.length); // one entry per declared reference
  assert.equal(a.entries[0].status, "unresolved");
  assert.equal(a.entries[0].unresolved.code, "no-peer-index");
  assert.equal(a.entries[0].requested.registry, "skills");
  // same reference with a supplied peer index resolves (mechanics only; synthetic index)
  const peer = idxOf(entry("synthetic.summarise-text", "1.2.0", { registry: "skills", domain: "synthetic" }));
  peer.registry = "skills"; peer.domain = "synthetic";
  const c = buildLock([idx, peer], subject, bp.references, ex);
  assert.equal(c.entries[0].status, "resolved");
  assert.equal(c.entries[0].resolved.version, "1.2.0");
  assert.deepEqual(schemaErrors("runtime-lock", c), []);
  // peer index present but artifact absent -> not-found, still explicit
  const d = buildLock([idx, { ...peer, entries: [] }], subject, bp.references, ex);
  assert.equal(d.entries[0].unresolved.code, "not-found");
});

// ---- git immutability ---------------------------------------------------------------------

test("git immutability check: published canonical files cannot change; lifecycle is append-only", () => {
  const d = mkdtempSync(join(tmpdir(), "imm-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  cpSync(join(EXAMPLE, "blueprints"), join(d, "blueprints"), { recursive: true });
  git("add", "-A"); git("commit", "-q", "-m", "base");
  const lc = join(d, A, "lifecycle.yaml");

  const doc = parse(readFileSync(lc, "utf8"));
  doc.state = "deprecated"; doc.history.push({ state: "deprecated", at: "2026-03-01T00:00:00Z", reason: "x", actor: "PLACEHOLDER-a" });
  writeFileSync(lc, stringify(doc, { aliasDuplicateObjects: false }));
  git("commit", "-qam", "deprecate");
  assert.deepEqual(checkImmutability(d, "HEAD~1"), []);

  writeFileSync(join(d, A, "blueprint.yaml"), readFileSync(join(d, A, "blueprint.yaml"), "utf8") + "\n# edit\n");
  git("commit", "-qam", "tamper");
  assert.ok(checkImmutability(d, "HEAD~1").some((x) => x.message.includes("immutable")));

  const doc2 = parse(readFileSync(lc, "utf8")); doc2.history[0].reason = "rewritten";
  writeFileSync(lc, stringify(doc2, { aliasDuplicateObjects: false })); git("commit", "-qam", "rewrite");
  assert.ok(checkImmutability(d, "HEAD~1").some((x) => x.message.includes("append-only")));

  writeFileSync(join(d, A, "extra.yaml"), "a: 1\n"); git("add", "-A"); git("commit", "-qm", "add");
  assert.ok(checkImmutability(d, "HEAD~1").some((x) => x.message.includes("already-published")));
});
