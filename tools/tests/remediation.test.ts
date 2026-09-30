import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { A, B, C, EXAMPLE, append, edit, errors, has, tempRoot } from "./helpers.js";
import { R, addSkills, makeRefinedCandidate, promoteCandidate } from "./promotion-helpers.js";
import { DEFAULT_POLICY, REPO_ROOT, parseFileChecked, readJson, readYaml, schemaErrors, type Doc } from "../src/load.js";
import { Scanner } from "../src/scan.js";
import { validateRoot } from "../src/validate.js";
import { buildIndex, writeIndex } from "../src/index-gen.js";
import { CanonicalizationError, validateValueDomain } from "../src/valuedomain.js";
import { canonicalJson, contentDigest } from "../src/integrity.js";
import { isValidRange } from "../src/semver.js";
import { DomainError, assertIndexDomains, buildLock, resolveRef } from "../src/resolve.js";

const CLI = join(REPO_ROOT, "tools/src/cli.ts");
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
const scanner = () => new Scanner(readYaml(DEFAULT_POLICY).privacy);
const detectors = (v: unknown) => [...new Set(scanner().scanValue(v, "f").map((f) => f.detector))];
const tmp = () => mkdtempSync(join(tmpdir(), "rem-"));
const BB = `${B}/blueprint.yaml`;

// =================================================================================================
// 1. Transcript detector: role-bearing arrays are not transcripts; real transcripts still are
// =================================================================================================

test("role-bearing arrays of legitimate records are not transcripts (skills, approvals, reviewers)", () => {
  assert.deepEqual(detectors({ skills: [{ key: "a", ref: {}, role: "Does a thing", required: true }, { key: "b", ref: {}, role: "Does another", required: false }, { key: "c", ref: {}, role: "Third", required: false }] }), []);
  assert.deepEqual(detectors({ approvals: [{ role: "maintainer", identity: "a", subjectDigest: "d" }, { role: "security", identity: "b", subjectDigest: "d" }, { role: "privacy", identity: "c", subjectDigest: "d" }] }), []);
  assert.deepEqual(detectors({ reviewers: [{ identity: "a", role: "maintainer" }, { identity: "b", role: "security" }] }), []);
});

test("genuine transcript structures are still rejected (contextual: conversation role + message content)", () => {
  const turns = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
  assert.deepEqual(detectors({ t: turns }), ["transcript-structure"]);
  assert.deepEqual(detectors({ role: "tool", content: "x" }), ["transcript-structure"]);
  assert.deepEqual(detectors({ from: "human", value: "hello" }), ["transcript-structure"]);
  assert.deepEqual(detectors({ t: [{ role: "System", text: "be nice" }] }), ["transcript-structure"]);
  assert.ok(detectors({ t: [{ role: "assistant", tool_calls: [] }] }).includes("transcript-structure")); // tool_calls is also a forbidden key
  assert.ok(detectors({ t: ["user: hi", "assistant: hello"] }).includes("transcript-structure"));
  assert.ok(detectors("user: hi\nassistant: hello").includes("transcript-turns"));
  assert.ok(detectors('{"role": "assistant", "x": 1}').includes("transcript-json-role"));
  // a conversation role WITHOUT message content, or content WITHOUT a conversation role, is not a turn
  assert.deepEqual(detectors({ role: "user", id: 1 }), []);
  assert.deepEqual(detectors({ role: "maintainer", content: "x" }), []);
});

test("transcript fixtures are rejected end-to-end inside otherwise valid documents (eval suite inputs)", () => {
  for (const [label, inputs] of [
    ["role/content turns", { turns: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }],
    ["from/value turns", { turns: [{ from: "human", value: "hi" }, { from: "ai", value: "hello" }] }],
    ["speaker-prefixed lines", { lines: ["user: hi", "assistant: hello"] }],
  ] as [string, Doc][]) {
    const r = tempRoot();
    edit(r, `${B}/evals/suite.yaml`, (d) => { d.cases[0].inputs = inputs; });
    assert.ok(has(errors(r), "[transcript-structure]"), label);
  }
});

test("a candidate with several skills validates (each skill entry carries a role field)", () => {
  for (const n of [2, 3]) {
    const r = tempRoot();
    addSkills(join(r, B), n);
    assert.deepEqual(errors(r), [], `${n} skills`);
  }
});

test("promotion with multiple reviewers/approvals validates for every class (valid cases)", () => {
  // upstream-seed (2 reviewers: maintainer + security)
  let r = tempRoot();
  promoteCandidate(r, C, { reviewers: [R("maintainer"), R("security")], mutate: (bp) => { bp.spec.lineage.seed.licence.status = "verified"; bp.spec.lineage.seed.securityValidation = "passed"; } });
  assert.deepEqual(errors(r), [], "upstream-seed");
  // discovered (2 reviewers: maintainer + privacy)
  r = tempRoot();
  promoteCandidate(r, B, { reviewers: [R("maintainer"), R("privacy")] });
  assert.deepEqual(errors(r), [], "discovered");
  // refined (2 reviewers: maintainer + privacy; pinned parent digest)
  r = tempRoot();
  promoteCandidate(r, makeRefinedCandidate(r), { version: "1.1.0", reviewers: [R("maintainer"), R("privacy")] });
  assert.deepEqual(errors(r), [], "refined");
  // more reviewers than required still validates (3 approvals, 3 roles)
  r = tempRoot();
  promoteCandidate(r, B, { reviewers: [R("maintainer"), R("privacy"), R("security")] });
  assert.deepEqual(errors(r), [], "discovered with three reviewers");
  // native: the synthetic canonical example (single reviewer) remains valid
  assert.deepEqual(errors(EXAMPLE), [], "native");
});

test("promotion negative cases per class (reviewer counts/roles, licence, security validation, recurrence, parent pin)", () => {
  const seed = (o: { reviewers: ReturnType<typeof R>[]; licence?: string; sec?: string }) => { const r = tempRoot(); promoteCandidate(r, C, { reviewers: o.reviewers, mutate: (bp) => { bp.spec.lineage.seed.licence.status = o.licence ?? "verified"; bp.spec.lineage.seed.securityValidation = o.sec ?? "passed"; } }); return errors(r); };
  assert.ok(has(seed({ reviewers: [R("maintainer")] }), "needs >= 2 reviewers for class upstream-seed"));
  assert.ok(has(seed({ reviewers: [R("maintainer", 1), R("maintainer", 2)] }), "lacks required reviewer role 'security'"));
  assert.ok(has(seed({ reviewers: [R("maintainer"), R("security")], licence: "unverified" }), "verified upstream licence"));
  assert.ok(has(seed({ reviewers: [R("maintainer"), R("security")], sec: "not-run" }), "passed upstream security validation"));

  const disc = (o: { reviewers: ReturnType<typeof R>[]; workspaces?: number }) => { const r = tempRoot(); promoteCandidate(r, B, { reviewers: o.reviewers, mutate: (bp) => { if (o.workspaces !== undefined) bp.spec.lineage.recurrence.distinctWorkspaceCount = o.workspaces; } }); return errors(r); };
  assert.ok(has(disc({ reviewers: [R("maintainer")] }), "needs >= 2 reviewers for class discovered"));
  assert.ok(has(disc({ reviewers: [R("maintainer", 1), R("security")] }), "lacks required reviewer role 'privacy'"));
  assert.ok(has(disc({ reviewers: [R("maintainer"), R("privacy")], workspaces: 2 }), "2 distinct workspaces < policy minimum 3"));

  const ref = (sourceRef: (p: Doc) => Doc, reviewers = [R("maintainer"), R("privacy")]) => { const r = tempRoot(); promoteCandidate(r, makeRefinedCandidate(r, { sourceRef }), { version: "1.1.0", reviewers }); return errors(r); };
  assert.ok(has(ref((p) => ({ ...p, digest: "sha256:" + "0".repeat(64) })), "digest does not match the canonical parent"));
  assert.ok(has(ref((p) => { const { digest: _d, ...rest } = p; return rest; }), "must carry the exact digest"));
  assert.ok(has(ref((p) => p, [R("maintainer")]), "needs >= 2 reviewers for class refined"));

  // approvals must mirror promotion reviewers; transcript detector must not be what stops a 2-entry record
  const r = tempRoot();
  promoteCandidate(r, B, { reviewers: [R("maintainer"), R("privacy")], approvals: false });
  const es = errors(r);
  assert.ok(has(es, "security.approvals must mirror promotion.yaml reviewers"));
  assert.ok(!has(es, "transcript-structure"));
});

// =================================================================================================
// 2. Controlled validation errors (no stack traces, no hashing of invalid documents)
// =================================================================================================

function brokenRoot(rel: string, content: string): string { const r = tempRoot(); writeFileSync(join(r, rel), content); return r; }

test("invalid YAML produces a file/line diagnostic, never an exception, and the artifact is not loaded", () => {
  const r = brokenRoot(`${B}/evals/suite.yaml`, "a: [unclosed\n");
  let v!: ReturnType<typeof validateRoot>;
  assert.doesNotThrow(() => { v = validateRoot(r); });
  const d = v.diagnostics.find((x) => x.where.endsWith("evals/suite.yaml") && x.message.startsWith("cannot parse YAML"));
  assert.ok(d, JSON.stringify(v.diagnostics.slice(0, 3)));
  assert.match(d!.message, /line \d+, column \d+/);
  assert.equal(v.diagnostics.filter((x) => x.where.endsWith("evals/suite.yaml") && x.severity === "error").length, 1, "reported exactly once");
});

test("duplicate YAML keys and invalid blueprint syntax are diagnostics, and nothing is hashed or indexed", () => {
  const r = tempRoot();
  edit(r, BB, () => undefined);
  const p = join(r, BB);
  writeFileSync(p, readFileSync(p, "utf8").replace("kind: TinyAgentBlueprint", "kind: TinyAgentBlueprint\nkind: TinyAgentBlueprint"));
  let v!: ReturnType<typeof validateRoot>;
  assert.doesNotThrow(() => { v = validateRoot(r); });
  assert.ok(v.diagnostics.some((x) => x.where.endsWith(`${B}/blueprint.yaml`) && /Map keys must be unique/.test(x.message)));
  assert.ok(!v.versions.some((x) => x.id === "example.request-triage"), "invalid document must not be loaded (so it is never hashed)");
  assert.ok(buildIndex(r).errors > 0);
  assert.equal(writeIndex(r, true).ok, false);
  assert.equal(writeIndex(r, false).ok, false);
});

test("lone-surrogate strings and keys are rejected with a JSON path; the document is not hashed", () => {
  const r = tempRoot();
  const p = join(r, BB);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(\n  descriptor:\n(?:.*\n)*?    description: ).*/, '$1"x\\ud800y"'));
  let v!: ReturnType<typeof validateRoot>;
  assert.doesNotThrow(() => { v = validateRoot(r); });
  const d = v.diagnostics.find((x) => x.message.includes("[lone-surrogate]"));
  assert.ok(d, JSON.stringify(v.diagnostics.slice(0, 3)));
  assert.match(d!.message, /spec\.descriptor\.description/);
  assert.ok(!v.versions.some((x) => x.id === "example.request-triage"));
  // a lone surrogate in a KEY
  const k = tempRoot();
  const q = join(k, BB);
  writeFileSync(q, readFileSync(q, "utf8") + '"bad\\ud800key": 1\n');
  assert.ok(validateRoot(k).diagnostics.some((x) => x.message.includes("#key") && x.message.includes("[lone-surrogate]")));
});

test("parse failures in unreferenced, sealed and JSON files are also controlled", () => {
  const extra = tempRoot();
  mkdirSync(join(extra, B, "evals", "results"), { recursive: true });
  writeFileSync(join(extra, B, "evals", "results", "extra.yaml"), "a: 1\na: 2\n");
  assert.ok(validateRoot(extra).diagnostics.some((x) => x.where.endsWith("evals/results/extra.yaml") && /Map keys must be unique/.test(x.message)));
  const sealed = brokenRoot(`${A}/integrity.json`, '{"digest": ');
  let v!: ReturnType<typeof validateRoot>;
  assert.doesNotThrow(() => { v = validateRoot(sealed); });
  assert.ok(v.diagnostics.some((x) => x.where.endsWith("integrity.json") && x.message.startsWith("cannot parse JSON")));
  assert.ok(v.diagnostics.some((x) => /canonical versions must be sealed/.test(x.message)), "an unreadable seal is never treated as valid");
  const policyless = new Scanner(readYaml(DEFAULT_POLICY).privacy).scanFile(join(extra, B, "evals", "results", "extra.yaml"));
  assert.equal(policyless[0]?.detector, "parse-error");
});

test("CLI: broken YAML yields diagnostics on stdout, exit 1, and no stack trace", () => {
  const r = brokenRoot(`${B}/evals/suite.yaml`, "a: [unclosed\n");
  const res = run("validate", r);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /cannot parse YAML/);
  assert.match(res.stdout, /evals\/suite\.yaml/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
  assert.doesNotMatch(res.stdout, /\b0 error\(s\)/);
});

test("CLI: unexpected input errors are reported as 'error:' with exit 2, not a stack trace", () => {
  const res = run("lock", join(tmp(), "nonexistent-root"), "--id", "x.y", "--range", "^1.0.0");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^error: /);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

// =================================================================================================
// 3. Numeric and unsupported values (validated before JSON cloning)
// =================================================================================================

const withNumber = (literal: string) => { const d = tmp(); const f = join(d, "x.yaml"); writeFileSync(f, `n: ${literal}\n`); return parseFileChecked(f); };

test("source-level: integer literals and exponent forms that would round silently are rejected", () => {
  for (const lit of ["12345678901234567890", "-12345678901234567890", "9007199254740992", "9007199254740993", "-9007199254740993", "9007199254740993.0",
    "9.007199254740993e15", "90071992547409930e-1", "9007199254740993e0", "1e21", "1E21", "1e300", "0x20000000000001", "0o400000000000000001", "9007199254740992.5"]) {
    const r = withNumber(lit);
    assert.equal(r.doc, undefined, `${lit} must be rejected`);
    assert.match(r.problems.join("\n"), /n: integer-valued number outside the safe integer range.*\[unsafe-integer\]/, lit);
  }
});

test("source-level: non-finite numbers are rejected before they can become null", () => {
  for (const lit of [".inf", "-.inf", ".Inf", ".nan", ".NaN"]) {
    const r = withNumber(lit);
    assert.equal(r.doc, undefined, lit);
    assert.match(r.problems.join("\n"), /\[non-finite-number\]/, lit);
  }
});

test("source-level: valid numbers keep their behaviour (safe integers, fractions, small exponents)", () => {
  const ok: [string, number][] = [["0", 0], ["-0", -0], ["42", 42], ["9007199254740991", Number.MAX_SAFE_INTEGER], ["-9007199254740991", -Number.MAX_SAFE_INTEGER], ["1e3", 1000], ["1.5e2", 150], ["0x1F", 31], ["2.5", 2.5], ["0.1", 0.1], ["-0.25", -0.25], ["1e-7", 1e-7], ["1234567.891", 1234567.891], ["9007199254740991.0", Number.MAX_SAFE_INTEGER]];
  for (const [lit, want] of ok) { const r = withNumber(lit); assert.deepEqual(r.problems, [], lit); assert.ok(Object.is((r.doc as Doc).n, want), `${lit} -> ${(r.doc as Doc).n}`); }
  assert.equal(canonicalJson({ n: 0.1, m: 2.5, k: 1e-7 }), '{"k":1e-7,"m":2.5,"n":0.1}');
});

test("JSON files get the same numeric checks", () => {
  const d = tmp(); const f = join(d, "x.json");
  writeFileSync(f, '{"n": 12345678901234567890}'); assert.match(parseFileChecked(f).problems.join(), /unsafe-integer/);
  writeFileSync(f, '{"n": 1.5}'); assert.deepEqual(parseFileChecked(f).problems, []);
});

test("value domain: unsupported types, cycles and invalid Unicode are rejected before JSON cloning", () => {
  class X { a = 1 }
  const cyc: Doc = { a: {} }; cyc.a.back = cyc;
  const cases: [string, unknown, string][] = [
    ["undefined", { a: undefined }, "unsupported-type"], ["bigint", { a: 10n }, "unsupported-type"], ["symbol", { a: Symbol("s") }, "unsupported-type"],
    ["function", { a: () => 1 }, "unsupported-type"], ["Date", { a: new Date(0) }, "unsupported-type"], ["Map", { a: new Map() }, "unsupported-type"],
    ["Set", { a: new Set() }, "unsupported-type"], ["Uint8Array", { a: new Uint8Array(1) }, "unsupported-type"], ["class instance", { a: new X() }, "unsupported-type"],
    ["NaN", { a: NaN }, "non-finite-number"], ["Infinity", { a: Infinity }, "non-finite-number"], ["-Infinity", { a: [-Infinity] }, "non-finite-number"],
    ["circular", cyc, "circular-reference"], ["lone high surrogate", { a: "\ud800" }, "lone-surrogate"], ["lone low surrogate", { a: ["x", "\udc00"] }, "lone-surrogate"],
    ["unsafe integer", { a: 2 ** 53 }, "unsafe-integer"],
  ];
  for (const [label, v, code] of cases) assert.ok(validateValueDomain(v).some((p) => p.code === code), label);
  assert.deepEqual(validateValueDomain({ a: [1, 2.5, "é", "\u{1F600}", null, true, { b: -0 }] }), []);
  assert.ok(validateValueDomain({ a: { b: [1, { c: NaN }] } }).some((p) => p.path === "a.b[1].c"));
});

test("contentDigest/canonicalJson throw instead of silently converting (no NaN/Infinity -> null, no Date -> {})", () => {
  assert.throws(() => contentDigest({ spec: { n: Infinity } }), CanonicalizationError);
  assert.throws(() => contentDigest({ spec: { n: NaN } }), /non-finite/);
  assert.throws(() => contentDigest({ spec: { n: undefined } }), /unsupported/);
  assert.throws(() => contentDigest({ spec: { n: 2 ** 60 } }), /safe integer/);
  assert.throws(() => contentDigest({ spec: { s: "\ud800" } }), /lone surrogate|unpaired/);
  assert.throws(() => canonicalJson({ d: new Date(0) }), /unsupported object type/);
  assert.notEqual(contentDigest({ spec: { n: 1 } }), contentDigest({ spec: { n: 2 } }));
});

test("validation of a real blueprint reports the JSON path of an invalid value and does not load it", () => {
  for (const [label, mutate, code, path] of [
    ["huge integer", (t: string) => t.replace("maxSteps: 5", "maxSteps: 12345678901234567890"), "unsafe-integer", "spec.executionConstraints.maxSteps"],
    ["exponent form", (t: string) => t.replace("maxSteps: 5", "maxSteps: 9.007199254740993e15"), "unsafe-integer", "spec.executionConstraints.maxSteps"],
    ["infinity", (t: string) => t.replace("maxSteps: 5", "maxSteps: .inf"), "non-finite-number", "spec.executionConstraints.maxSteps"],
  ] as [string, (t: string) => string, string, string][]) {
    const r = tempRoot(); const p = join(r, BB); writeFileSync(p, mutate(readFileSync(p, "utf8")));
    const v = validateRoot(r);
    assert.ok(v.diagnostics.some((d) => d.message.includes(`[${code}]`) && d.message.includes(path)), label);
    assert.ok(!v.versions.some((x) => x.id === "example.request-triage"), label);
  }
});

// =================================================================================================
// 4. Domain isolation during resolution
// =================================================================================================

const ix = (purpose: string | undefined, entries: Doc[], registry = "tiny-agents"): Doc => ({ apiVersion: "registry.zeptly.dev/v1alpha1", kind: "RegistryIndex", registry, ...(purpose ? { purpose } : {}), entries });
const ent = (id: string, version: string, synthetic: boolean | undefined, registry = "tiny-agents"): Doc => ({ registry, id, version, digest: "sha256:" + "a".repeat(64), sealDigest: null, maturity: "canonical", lifecycle: "active", origin: { type: "native" }, location: `x/${id}/${version}`, ...(synthetic === undefined ? {} : { synthetic }) });
const refOf = (id: string, version = "^1.0.0", registry = "tiny-agents") => ({ registry, id, version });
const domErr = (fn: () => unknown): DomainError => { try { fn(); } catch (e) { assert.ok(e instanceof DomainError, String(e)); return e as DomainError; } throw new Error("expected DomainError"); };

test("domain: valid production resolution and valid example resolution work separately", () => {
  const prod = ix("production", [ent("real.thing", "1.2.0", false)]);
  const exa = ix("example", [ent("example.thing", "1.0.0", true)]);
  assert.equal(resolveRef([prod], refOf("real.thing")).resolved?.version, "1.2.0"); // default domain = production
  assert.equal(resolveRef([prod], refOf("real.thing"), { domain: "production" }).resolved?.version, "1.2.0");
  assert.equal(resolveRef([exa], refOf("example.thing"), { domain: "example" }).resolved?.version, "1.0.0");
  assert.equal(buildLock([prod], { registry: "tiny-agents", id: "s.s", version: "1.0.0", digest: "sha256:" + "b".repeat(64) }, [refOf("real.thing")]).entries[0].status, "resolved");
});

test("domain: production resolution rejects example indexes; example resolution must be explicit", () => {
  const exa = ix("example", [ent("example.thing", "1.0.0", true)]);
  const e1 = domErr(() => resolveRef([exa], refOf("example.thing")));
  assert.equal(e1.code, "domain-mismatch");
  assert.match(e1.message, /index #1 .* declares purpose 'example' but the resolution domain is 'production'.*explicitly/);
  assert.equal(domErr(() => resolveRef([exa], refOf("example.thing"), { domain: "production" })).code, "domain-mismatch");
  assert.equal(resolveRef([exa], refOf("example.thing"), { domain: "example" }).resolved?.id, "example.thing");
});

test("domain: mixed index inputs are rejected in both directions and name the offending index", () => {
  const prod = ix("production", [ent("real.thing", "1.0.0", false)]);
  const exa = ix("example", [ent("example.thing", "1.0.0", true)]);
  const e1 = domErr(() => resolveRef([prod, exa], refOf("real.thing")));
  assert.equal(e1.code, "domain-mismatch"); assert.match(e1.message, /index #2/);
  const e2 = domErr(() => resolveRef([exa, prod], refOf("example.thing"), { domain: "example" }));
  assert.equal(e2.code, "domain-mismatch"); assert.match(e2.message, /index #2 .* declares purpose 'production' but the resolution domain is 'example'/);
  domErr(() => buildLock([prod, exa], { registry: "tiny-agents", id: "s.s", version: "1.0.0", digest: "sha256:" + "b".repeat(64) }, []));
});

test("domain: synthetic targets and conflicting metadata fail clearly (metadata, not ID prefix)", () => {
  // synthetic target inside a production-purpose index
  const e1 = domErr(() => resolveRef([ix("production", [ent("real.thing", "1.0.0", false), ent("leaked.synthetic", "1.0.0", true)])], refOf("real.thing")));
  assert.equal(e1.code, "conflicting-domain-metadata"); assert.match(e1.message, /'production' but contains synthetic entry 'leaked\.synthetic'/);
  // non-synthetic entry inside an example-purpose index
  const e2 = domErr(() => resolveRef([ix("example", [ent("example.x", "1.0.0", false)])], refOf("example.x"), { domain: "example" }));
  assert.equal(e2.code, "conflicting-domain-metadata"); assert.match(e2.message, /non-synthetic entry/);
  // the prefix is irrelevant: an 'example.'-prefixed id with synthetic:false in a production index is accepted,
  // a plain id with synthetic:true is rejected
  assert.equal(resolveRef([ix("production", [ent("example.looks-synthetic", "1.0.0", false)])], refOf("example.looks-synthetic")).resolved?.id, "example.looks-synthetic");
  assert.equal(domErr(() => resolveRef([ix("production", [ent("plain.id", "1.0.0", true)])], refOf("plain.id"))).code, "conflicting-domain-metadata");
});

test("domain: missing domain metadata fails clearly", () => {
  assert.equal(domErr(() => resolveRef([ix(undefined, [ent("a.b", "1.0.0", false)])], refOf("a.b"))).code, "missing-domain-metadata");
  assert.equal(domErr(() => resolveRef([ix("staging", [ent("a.b", "1.0.0", false)])], refOf("a.b"))).code, "missing-domain-metadata");
  const e = domErr(() => resolveRef([ix("production", [ent("a.b", "1.0.0", undefined)])], refOf("a.b")));
  assert.equal(e.code, "missing-domain-metadata"); assert.match(e.message, /without a boolean 'synthetic' \(first: 'a\.b'\)/);
  assert.equal(domErr(() => resolveRef([{ registry: "tiny-agents", purpose: "production" }], refOf("a.b"))).code, "missing-domain-metadata");
  assert.equal(domErr(() => assertIndexDomains([{ registry: "x" } as Doc], "production")).problems.length, 1);
});

test("domain: explicit foreign-reference reporting is preserved", () => {
  const prod = ix("production", [ent("real.thing", "1.0.0", false)]);
  const out = buildLock([prod], { registry: "tiny-agents", id: "s.s", version: "1.0.0", digest: "sha256:" + "b".repeat(64) }, [refOf("real.thing"), refOf("other.skill", "^1.0.0", "skills")]);
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[1].status, "unresolved");
  assert.equal(out.entries[1].unresolved.code, "no-peer-index");
  assert.deepEqual(schemaErrors("runtime-lock", out), []);
});

test("domain CLI: example roots need --domain example; conflicting root/index metadata fails; production default", () => {
  const a = run("lock", "examples/registry", "--id", "example.structured-summary", "--range", "^1.0.0");
  assert.equal(a.status, 2);
  assert.equal(JSON.parse(a.stderr).error.code, "domain-mismatch");
  const b = run("lock", "examples/registry", "--id", "example.structured-summary", "--range", "^1.0.0", "--domain", "example");
  assert.equal(b.status, 1); // skills reference is unresolved (no peer index), reported explicitly
  const lock = JSON.parse(b.stdout);
  assert.equal(lock.entries[0].unresolved.code, "no-peer-index");
  assert.deepEqual(schemaErrors("runtime-lock", lock), []);
  // root marker says production, index says example
  const r = tempRoot(); edit(r, "registry.yaml", (d) => { d.purpose = "production"; });
  const c = run("lock", r, "--id", "example.structured-summary", "--range", "^1.0.0", "--domain", "example");
  assert.equal(c.status, 2); assert.equal(JSON.parse(c.stderr).error.code, "conflicting-domain-metadata");
  // the real (production) root resolves in the default domain; empty index -> not-found
  const d = run("lock", ".", "--id", "example.structured-summary", "--range", "^1.0.0");
  assert.equal(d.status, 1); assert.equal(JSON.parse(d.stdout).unresolved.code, "not-found");
  // invalid --domain value
  assert.equal(run("lock", ".", "--id", "x.y", "--range", "^1", "--domain", "staging").status, 2);
  // resolve with mixed indexes
  const e = run("resolve", "--index", "index/registry-index.json", "--index", "examples/registry/index/registry-index.json", "--registry", "tiny-agents", "--id", "x.y", "--range", "^1");
  assert.equal(e.status, 2); assert.equal(JSON.parse(e.stderr).error.code, "domain-mismatch");
});

// =================================================================================================
// 5. Malformed version ranges
// =================================================================================================

test("malformed ranges produce invalid-range (local code), not 'no eligible version'", () => {
  const prod = ix("production", [ent("a.b", "1.2.0", false)]);
  for (const bad of ["^^^", "abc", ">=", "", "v1.0.0", "1.0.0 - 2.0.0", ">= 1.0.0", "^1.0.0 ||", "|| ^1", "~", "1.0.0.0", "^1.0.0 abc"]) {
    const out = resolveRef([prod], refOf("a.b", bad));
    assert.equal(out.unresolved?.code, "invalid-range", JSON.stringify(bad));
    assert.match(out.unresolved!.message, /not a valid version or range/);
    assert.equal(isValidRange(bad), false, JSON.stringify(bad));
  }
});

test("the supported range subset is unchanged and still resolves; valid-but-unsatisfiable is a different code", () => {
  const prod = ix("production", [ent("a.b", "1.0.0", false), ent("a.b", "1.2.0", false), ent("a.b", "2.0.0", false)]);
  const good: [string, string][] = [["1.2.0", "1.2.0"], ["=1.0.0", "1.0.0"], ["^1.0.0", "1.2.0"], ["~1.2.0", "1.2.0"], ["1.x", "1.2.0"], ["1", "1.2.0"], ["1.2", "1.2.0"], [">=1.0.0 <2.0.0", "1.2.0"], ["^1.0.0 || ^2.0.0", "2.0.0"], ["*", "2.0.0"], ["<=1.0.0", "1.0.0"], [">1.2.0", "2.0.0"]];
  for (const [range, want] of good) { assert.equal(isValidRange(range), true, range); assert.equal(resolveRef([prod], refOf("a.b", range)).resolved?.version, want, range); }
  assert.equal(resolveRef([prod], refOf("a.b", "^9.0.0")).unresolved?.code, "no-eligible-version");
  assert.equal(resolveRef([prod], refOf("a.b", "9.9.9")).unresolved?.code, "no-eligible-version");
  assert.equal(resolveRef([prod], refOf("nope.nope", "^1.0.0")).unresolved?.code, "not-found");
});

test("invalid-range in a lock entry: schema-valid, explicit, and the foreign no-peer-index code is unchanged", () => {
  const prod = ix("production", [ent("a.b", "1.2.0", false)]);
  const out = buildLock([prod], { registry: "tiny-agents", id: "s.s", version: "1.0.0", digest: "sha256:" + "b".repeat(64) }, [refOf("a.b", "^^^"), refOf("x.y", "^^^", "skills"), refOf("a.b", "^1.0.0")]);
  assert.deepEqual(out.entries.map((e: Doc) => e.status === "resolved" ? "resolved" : e.unresolved.code), ["invalid-range", "no-peer-index", "resolved"]);
  assert.deepEqual(schemaErrors("runtime-lock", out), []);
  const r = run("resolve", "--index", "index/registry-index.json", "--registry", "tiny-agents", "--id", "x.y", "--range", "^^^");
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).unresolved.code, "invalid-range");
});

// =================================================================================================
// Preserved contracts
// =================================================================================================

test("preserved: valid fixtures still validate and their digests, seal and indexes are unchanged", () => {
  assert.deepEqual(errors(REPO_ROOT), []);
  assert.deepEqual(errors(EXAMPLE), []);
  const e = readJson(join(EXAMPLE, "index", "registry-index.json")).entries.find((x: Doc) => x.id === "example.structured-summary");
  assert.equal(e.digest, "sha256:7c953f60067a549e67b8a454971638cc26abe0d9ab17f7176a7ee5ba59eb78ea");
  assert.equal(e.sealDigest, "sha256:6ea9d9edb7418f9f961a56de3d2afc1a8978041ab94714659d4d92ddeb5d43c1");
  for (const root of [REPO_ROOT, EXAMPLE]) assert.equal(buildIndex(root).text, readFileSync(join(root, "index", "registry-index.json"), "utf8"));
  void parse; void stringify; void cpSync; void append; void C;
});
