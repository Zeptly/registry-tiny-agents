import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A, B, EXAMPLE, append, edit, errors, has, tempRoot } from "./helpers.js";
import { REPO_ROOT, DEFAULT_POLICY, readJson, readYaml, type Doc } from "../src/load.js";
import { canonicalJson, computeIntegrity, contentDigest } from "../src/integrity.js";
import { compareCodePoints, sortCodePoints } from "../src/order.js";
import { buildIndex } from "../src/index-gen.js";
import { Scanner } from "../src/scan.js";
import { textPolicyViolation } from "../src/textpolicy.js";

// Expected values below were computed by an INDEPENDENT implementation (Python json + hashlib), not by this code.

test("golden vectors: canonical JSON (code-point key order, ECMAScript numbers/strings, no whitespace)", () => {
  const vectors: [string, string][] = [
    ['{"b":1,"a":[true,null,"é"]}', '{"a":[true,null,"é"],"b":1}'],
    // U+FB01 sorts BEFORE U+10000 by code point (UTF-16 code-unit order would reverse them)
    ['{"\\ud800\\udc00":2,"\\ufb01":1}', '{"ﬁ":1,"\u{10000}":2}'],
    ["[0.1,1e21,-0,2.5,100]", "[0.1,1e+21,0,2.5,100]"],
    ['"a\\"b\\\\c\\n\\t\\u0001\\u007f\\u2028é"', '"a\\"b\\\\c\\n\\t\\u0001\x7f é"'],
  ];
  for (const [input, expected] of vectors) assert.equal(canonicalJson(JSON.parse(input)), expected);
  assert.throws(() => canonicalJson({ n: Infinity }));
  assert.throws(() => canonicalJson("\ud800"));
  assert.throws(() => canonicalJson({ u: undefined }));
});

const GOLDEN_DOC = () => ({
  apiVersion: "registry.zeptly.dev/v1alpha1",
  kind: "TinyAgentBlueprint",
  metadata: { id: "golden.example", version: "9.9.9", registry: "tiny-agents", maturity: "candidate", origin: { type: "native" }, synthetic: true },
  spec: { z: [1, 2.5, 0, "é", "\u{10000}"], a: { "ﬁ": 1, "\u{10000}": 2 } },
  references: [],
  provenance: { createdAt: "2026-01-01T00:00:00Z", authors: [], sourceRefs: [], transformations: [] },
  security: { classification: "internal", capabilities: [], approvals: [{ role: "maintainer", identity: "x", subjectDigest: "sha256:00" }] },
  attestations: [{ type: "evaluation", ref: "file:x", subjectDigest: "sha256:00" }],
});

test("golden vector: artifact digest, and exactly which fields it excludes/includes", () => {
  const GOLDEN = "sha256:d39f5110e9fb3e8cdff3ba8f540fabb094927093c64ae981dd7d002e74993b1a";
  assert.equal(contentDigest(GOLDEN_DOC()), GOLDEN);
  // excluded: metadata.version, metadata.maturity, attestations, security.approvals
  const ex = GOLDEN_DOC() as Doc;
  ex.metadata.version = "1.0.0"; ex.metadata.maturity = "canonical"; ex.attestations = []; ex.security.approvals = [];
  assert.equal(contentDigest(ex), GOLDEN);
  // included: identity, spec, references, provenance, security classification/capabilities
  const changes: ((d: Doc) => void)[] = [
    (d) => { d.metadata.id = "golden.other"; },
    (d) => { d.metadata.origin.type = "evolved"; },
    (d) => { d.spec.z.push(3); },
    (d) => { d.references.push({ registry: "skills", id: "a.b", version: "1.0.0" }); },
    (d) => { d.provenance.authors.push({ kind: "human", identity: "x" }); },
    (d) => { d.security.classification = "restricted"; },
    (d) => { d.security.capabilities.push({ capability: "a.b", effect: "reversible" }); },
  ];
  for (const c of changes) { const d = GOLDEN_DOC() as Doc; c(d); assert.notEqual(contentDigest(d), GOLDEN); }
  // insensitive to key order in the source document
  const rev = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(GOLDEN_DOC()).reverse())));
  assert.equal(contentDigest(rev), GOLDEN);
});

test("golden vector: directory seal (raw bytes, code-point path order, excludes lifecycle.yaml and integrity.json)", () => {
  const d = mkdtempSync(join(tmpdir(), "seal-"));
  mkdirSync(join(d, "evals", "results"), { recursive: true });
  const files: Record<string, string> = { "blueprint.yaml": "a: 1\n", "evals/suite.yaml": "b: 2\n", "evals/results/r.yaml": "d: 4\n", "promotion.yaml": "c: 3\n" };
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  writeFileSync(join(d, "lifecycle.yaml"), "state: active\n");
  writeFileSync(join(d, "integrity.json"), "{}\n");
  const seal = computeIntegrity(d);
  assert.equal(seal.digest, "sha256:81b304d711a9bb79b2666e220ead17f259feaf03de3a917f21792eee5a04f07c");
  assert.deepEqual(Object.keys(seal.files), ["blueprint.yaml", "evals/results/r.yaml", "evals/suite.yaml", "promotion.yaml"]);
  // lifecycle changes never move the seal
  writeFileSync(join(d, "lifecycle.yaml"), "state: revoked\n");
  assert.equal(computeIntegrity(d).digest, seal.digest);
});

test("pinned example vectors: artifact digest and seal of the synthetic canonical example", () => {
  const e = readJson(join(EXAMPLE, "index", "registry-index.json")).entries.find((x: Doc) => x.id === "example.structured-summary");
  assert.equal(e.digest, contentDigest(readYaml(join(EXAMPLE, A, "blueprint.yaml"))));
  assert.equal(e.digest, "sha256:7c953f60067a549e67b8a454971638cc26abe0d9ab17f7176a7ee5ba59eb78ea");
  assert.equal(e.sealDigest, computeIntegrity(join(EXAMPLE, A)).digest);
});

test("text policy: UTF-8, no BOM, LF only, no NUL", () => {
  assert.equal(textPolicyViolation(Buffer.from("a: 1\nb: 2\n")), null);
  assert.match(textPolicyViolation(Buffer.from("a: 1\r\n")) ?? "", /carriage return/);
  assert.match(textPolicyViolation(Buffer.from([0xef, 0xbb, 0xbf, 0x61])) ?? "", /byte-order mark/);
  assert.match(textPolicyViolation(Buffer.from([0x61, 0x00])) ?? "", /NUL/);
  assert.match(textPolicyViolation(Buffer.from([0xc3, 0x28])) ?? "", /UTF-8/);
  const r = tempRoot();
  append(r, `${B}/blueprint.yaml`, "# note\r\n");
  assert.ok(has(errors(r), "text policy: carriage return"));
});

test("comparator: explicit code-point order, locale independent", () => {
  assert.deepEqual(sortCodePoints(["b", "a", "B", "_", "-", ".", "1", "ﬁ", "\u{10000}"]), ["-", ".", "1", "B", "_", "a", "b", "ﬁ", "\u{10000}"]);
  assert.ok(compareCodePoints("ﬁ", "\u{10000}") < 0); // default sort() would order these the other way
  assert.equal(compareCodePoints("a", "a"), 0);
  assert.ok(compareCodePoints("a", "ab") < 0);
  const ids = ["ab", "a1", "a.b", "a-b"];
  assert.deepEqual(sortCodePoints(ids), ["a-b", "a.b", "a1", "ab"]);
});

test("index: built twice is byte-identical, with entries in code-point order and no locale dependence", () => {
  for (const root of [REPO_ROOT, EXAMPLE]) assert.equal(buildIndex(root).text, buildIndex(root).text);
  const ids = JSON.parse(buildIndex(EXAMPLE).text).entries.map((e: Doc) => e.id);
  assert.deepEqual(ids, sortCodePoints(ids));
});

test("index: origin mirrors metadata.origin (evolution kind only under origin.evolution); no derived class field", () => {
  const idx = readJson(join(EXAMPLE, "index", "registry-index.json"));
  const b = idx.entries.find((e: Doc) => e.id === "example.request-triage");
  assert.deepEqual(b.origin, { type: "evolved", evolution: { kind: "discovered" } });
  assert.equal(idx.entries.find((e: Doc) => e.id === "example.structured-summary").origin.evolution, undefined);
  assert.ok(idx.entries.every((e: Doc) => !("provenanceClass" in e) && !("evolutionKind" in e)));
  const bp = readYaml(join(EXAMPLE, B, "blueprint.yaml"));
  assert.equal(bp.metadata.origin.evolution.kind, "discovered");
  assert.equal(bp.provenance.evolution, undefined);
  assert.equal(bp.spec.lineage.evolution, undefined);
  const r = tempRoot();
  edit(r, `${B}/blueprint.yaml`, (d) => { d.provenance.evolution = { kind: "discovered" }; });
  assert.ok(has(errors(r), "evolution")); // a second location for the kind is rejected by the closed schema
});

// ---- file allow-list, limits, symlinks, transcripts --------------------------------------------

test("filename allow-list: unexpected names are rejected before being read or scanned", () => {
  for (const name of ["notes.md", "README.md", "transcript.yaml", "evals/other.yaml", "session.json", "evals/results/UPPER.yaml", "x.tape"]) {
    const r = tempRoot();
    mkdirSync(join(r, B, "evals", "results"), { recursive: true });
    writeFileSync(join(r, B, name), "a: 1\n");
    assert.ok(has(errors(r), "filename allow-list"), name);
  }
  const ok = tempRoot();
  mkdirSync(join(ok, B, "evals", "results"), { recursive: true });
  writeFileSync(join(ok, B, "evals", "results", "run-1.yaml"), "a: 1\n");
  assert.ok(!has(errors(ok), "allow-list"));
});

test("size limits: per-file, per-directory and file-count", () => {
  const r = tempRoot();
  append(r, `${B}/evals/suite.yaml`, "# " + "a ".repeat(140_000) + "\n");
  assert.ok(has(errors(r), "exceeds 262144 bytes"));
  const r2 = tempRoot();
  mkdirSync(join(r2, B, "evals", "results"), { recursive: true });
  for (let i = 0; i < 33; i++) writeFileSync(join(r2, B, "evals", "results", `r${i}.yaml`), "a: 1\n");
  assert.ok(has(errors(r2), "max 32"));
});

test("symlinks are rejected and never followed (file, directory, and version-directory links)", () => {
  const r = tempRoot();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.yaml"), "token: AKIAABCDEFGHIJKLMNOP\n");
  mkdirSync(join(r, B, "evals", "results"), { recursive: true });
  symlinkSync(join(outside, "secret.yaml"), join(r, B, "evals", "results", "leak.yaml"));
  symlinkSync(outside, join(r, B, "linked-dir"));
  symlinkSync(join(r, B), join(r, "blueprints", "candidates", "aliased"));
  const es = errors(r);
  assert.ok(es.filter((e) => e.includes("symbolic links are not allowed")).length >= 3, es.join("\n"));
  assert.ok(!has(es, "secret-aws"), "link targets must not be read");
});

test("tape / trace / transcript detection in allowed files", () => {
  const cases: [string, (d: Doc) => void][] = [
    ["transcript-structure", (d) => { d.spec.intent.appliesWhen = [{ role: "user", content: "hi" } as never]; }],
    ["forbidden-key", (d) => { d.spec.messages = []; }],
    ["forbidden-key", (d) => { d.spec.trace = "x"; }],
    ["forbidden-key", (d) => { d.spec.session_id = "x"; }],
    ["transcript-turns", (d) => { d.spec.intent.summary = "user: hello\nassistant: hi there"; }],
    ["transcript-json-role", (d) => { d.spec.intent.summary = '{"role": "assistant", "x": 1}'; }],
    ["opaque-blob", (d) => { d.spec.intent.summary = "A".repeat(300); }],
  ];
  for (const [detector, mut] of cases) {
    const r = tempRoot();
    edit(r, `${B}/blueprint.yaml`, mut);
    assert.ok(has(errors(r), `[${detector}]`) || has(errors(r), detector), detector);
  }
});

test("scanner runs in bounded time on adversarial input at the size cap (no quadratic patterns)", () => {
  const s = new Scanner(readYaml(DEFAULT_POLICY).privacy);
  const N = 262_144;
  const inputs = ["a".repeat(N), "1".repeat(N), "a/".repeat(N / 2), ".".repeat(N), " ".repeat(N), "user:".repeat(N / 5), "a-".repeat(N / 2), "\n".repeat(N)];
  for (const input of inputs) {
    const t = Date.now();
    s.scanText(input, "f", "p");
    assert.ok(Date.now() - t < 3000, `scan took ${Date.now() - t} ms for ${JSON.stringify(input.slice(0, 8))}…`);
  }
});
