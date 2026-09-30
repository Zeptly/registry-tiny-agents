/**
 * Runs the language-neutral zeptly-jcs-v1 vectors (vectors/zeptly-jcs-v1.json). The jcs/digest/seal values in that file
 * are produced and re-verified by an independent Python implementation (vectors/zeptly_jcs_v1.py, run in CI), so a
 * pass here means this TypeScript implementation agrees with a second, unrelated one byte for byte.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readYaml, type Doc } from "../src/load.js";
import { jcs } from "../src/jcs.js";
import { contentDigest, sealFromFiles, SealInputError } from "../src/integrity.js";
import { parseManifestBytes } from "../src/manifest.js";
import { DomainError, buildLock } from "../src/resolve.js";
import { schemaErrors } from "../src/load.js";

const V = JSON.parse(readFileSync(join(REPO_ROOT, "vectors", "zeptly-jcs-v1.json"), "utf8")) as Doc;
const bytesOf = (v: { text?: string; hex?: string }) => (v.hex !== undefined ? Buffer.from(v.hex, "hex") : Buffer.from(v.text ?? "", "utf8"));

test("vectors: the file declares the algorithm under test", () => {
  assert.equal(V.digestAlgorithm, "zeptly-jcs-v1");
  assert.equal(readYaml(join(REPO_ROOT, "policy", "registry-policy.yaml")).files.payload.length, V.seal.payloadPatterns.length);
});

test("vectors: JCS (UTF-16 key order, ECMAScript numbers, RFC 8785 escaping, no normalisation)", () => {
  for (const v of V.jcs as Doc[]) assert.equal(jcs(JSON.parse(v.input)), v.output, v.name);
  // explicit ordering assertion on the RFC 8785 sample (read from the text: JS objects reorder integer-like keys): "\r" < "1" < U+0080 < U+00F6 < U+20AC < U+1F600 < U+FB33
  const text = jcs(JSON.parse((V.jcs as Doc[]).find((x) => x.name === "rfc8785-section-3.2.3-keys")!.input));
  const pos = ['"\\r":', '"1":', "\u0080\":", "\u00f6\":", "\u20ac\":", "\u{1F600}\":", "\ufb33\":"].map((k) => text.indexOf(k));
  assert.ok(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1]!)), `unexpected key order: ${text}`);
  assert.throws(() => jcs({ n: Infinity })); assert.throws(() => jcs({ n: NaN })); assert.throws(() => jcs("\ud800")); assert.throws(() => jcs({ u: undefined }));
  assert.throws(() => jcs({ d: new Date(0) }), /unsupported object type/); assert.throws(() => jcs({ b: 1n }));
});

test("vectors: artifact digest, exclusions and inclusions", () => {
  for (const c of V.digest.cases as Doc[]) {
    assert.equal(contentDigest(c.doc), c.digest, c.name);
    for (const s of c.sameDigest) assert.equal(contentDigest(s.doc), c.digest, `${c.name}/same/${s.name}`);
    for (const d of c.differentDigest) assert.notEqual(contentDigest(d.doc), c.digest, `${c.name}/different/${d.name}`);
  }
});

const patterns = () => (V.seal.payloadPatterns as string[]).map((p) => new RegExp(p));
const filesOf = (o: Record<string, string | { hex: string }>) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, typeof x === "string" ? Buffer.from(x, "utf8") : Buffer.from(x.hex, "hex")]));

test("vectors: directory seal (payload selection, order, exclusions, mutation)", () => {
  for (const c of V.seal.cases as Doc[]) {
    const s = sealFromFiles(c.subject, filesOf(c.files), patterns());
    assert.equal(s.digest, c.seal, c.name);
    assert.deepEqual(s.payload, c.payload, c.name);
    assert.equal(s.digestAlgorithm, "zeptly-jcs-v1");
    for (const x of c.sameSeal ?? []) assert.equal(sealFromFiles(c.subject, filesOf({ ...c.files, ...x.files }), patterns()).digest, c.seal, `${c.name}/same/${x.name}`);
    for (const x of c.differentSeal ?? []) {
      const files = { ...c.files, ...(x.files ?? {}) }; for (const p of x.remove ?? []) delete files[p];
      assert.notEqual(sealFromFiles(x.subject ?? c.subject, filesOf(files), patterns()).digest, c.seal, `${c.name}/different/${x.name}`);
    }
  }
});

test("vectors: seal rejects CRLF, lone CR, BOM, NUL, invalid UTF-8 and case-colliding paths before hashing", () => {
  const who = { registry: "tiny-agents", id: "golden.reject", version: "1.0.0" };
  for (const c of V.seal.reject as Doc[]) {
    assert.throws(() => sealFromFiles(who, filesOf(c.files), patterns()), (e: unknown) => e instanceof SealInputError && e.code === c.code, c.name);
  }
});

test("vectors: manifest parser accepts exactly the JSON-compatible subset", () => {
  for (const v of V.parser.accept as Doc[]) {
    const r = parseManifestBytes(bytesOf(v), v.format);
    assert.deepEqual(r.problems, [], v.name);
    assert.deepEqual(r.doc, v.value, v.name);
  }
});

test("vectors: manifest parser rejects with a machine-readable code (and path), never an exception", () => {
  for (const v of V.parser.reject as Doc[]) {
    const r = parseManifestBytes(bytesOf(v), v.format);
    assert.equal(r.doc, undefined, v.name);
    assert.ok(r.problems.some((p) => p.code === v.code && (v.path === undefined || p.path === v.path)), `${v.name}: expected ${v.code}${v.path ? ` at ${v.path}` : ""}, got ${JSON.stringify(r.problems)}`);
  }
});

const summarise = (lock: Doc) => ({
  complete: lock.complete,
  entries: (lock.entries as Doc[]).map((e) => (e.status === "resolved" ? { status: "resolved", version: e.resolved.version, digest: e.resolved.digest } : { status: "unresolved", code: e.unresolved.code })),
});

test("vectors: resolver and RuntimeLock (every reference listed; domains never mixed)", () => {
  for (const c of V.lock.cases as Doc[]) {
    const run = () => buildLock(c.indexes, c.subject, c.refs, { domain: c.domain, allowCandidates: c.allowCandidates });
    if (c.expect.error) { assert.throws(run, (e: unknown) => e instanceof DomainError && e.code === c.expect.error, c.name); continue; }
    const lock = run();
    assert.deepEqual(summarise(lock), c.expect, c.name);
    assert.deepEqual(schemaErrors("runtime-lock", lock), [], `${c.name}: lock must validate against its schema`);
    assert.equal(lock.entries.length, c.refs.length, `${c.name}: one entry per declared reference`);
    assert.equal(lock.domain, c.domain); assert.equal(lock.digestAlgorithm, "zeptly-jcs-v1");
  }
  const f = V.lock.fullLock;
  assert.deepEqual(buildLock(f.indexes, f.subject, f.refs, { domain: f.domain }), f.lock);
});
