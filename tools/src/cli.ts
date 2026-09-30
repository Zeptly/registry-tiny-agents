#!/usr/bin/env node
import { resolve } from "node:path";
import { formatDiagnostics, validateRoot } from "./validate.js";
import { writeIndex } from "./index-gen.js";
import { sealDir, fileDigest } from "./integrity.js";
import { checkImmutability } from "./immutability.js";
import { Scanner } from "./scan.js";
import { DEFAULT_POLICY, ManifestError, REPO_ROOT, parseFileChecked, readYaml, schemaErrors, type Doc } from "./load.js";
import { DomainError, buildLock, resolveRef, type Domain } from "./resolve.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.includes(`--${n}`);
const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const VALUE_FLAGS = ["policy", "base", "index", "registry", "id", "range", "digest", "digest-algorithm", "version", "domain"];
const opts = (n: string) => rest.flatMap((a, i) => (a === `--${n}` && rest[i + 1] ? [rest[i + 1]!] : []));
const positional = rest.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes((rest[i - 1] ?? "").slice(2)));

const USAGE = `usage:
  registry validate <root> [--policy <file>]     validate a registry root
  registry index <root> [--check]                (re)generate or verify the deterministic index
  registry scan <file...>                        run the privacy scanner on files
  registry seal <version-dir>                    write integrity.json for a version directory
  registry digest <file>                         print a file digest
  registry resolve --index <file>... --registry <r> --id <id> --range <range> [--digest <d>] [--allow-candidates] [--domain production|synthetic]
  registry lock <root> --id <id> --range <range> [--index <file>...] [--allow-candidates] [--domain production|synthetic]
                                                 (default domain: production; synthetic indexes need --domain synthetic)
                                                 resolve an artifact and ALL its references to an exact runtime lock
                                                 (unresolved references are listed explicitly, complete=false)
exit codes: 0 ok | 1 valid request that cannot be satisfied (unresolved reference) | 2 malformed input, validation error,
            stale index, immutability violation, privacy finding or domain error
  registry check-immutability --base <ref>       verify canonical dirs are unchanged vs a Git ref`;

/** Parse a YAML/JSON file or throw one Error that carries every problem (never a raw parser stack trace). */
function readChecked(path: string): Doc {
  const r = parseFileChecked(path);
  if (!r.doc) throw new ManifestError(path, r.diagnostics);
  return r.doc;
}
/** Production is the default; synthetic resolution must be requested explicitly. */
function parseDomain(v: string | undefined): Domain {
  if (v === undefined || v === "production") return "production";
  if (v === "synthetic") return "synthetic";
  throw new Error("--domain must be 'production' or 'synthetic'");
}

function main(): number {
  switch (cmd) {
    case "validate": {
      const r = validateRoot(positional[0] ?? ".", { policyPath: opt("policy") });
      const errors = r.diagnostics.filter((d) => d.severity === "error").length;
      if (r.diagnostics.length) console.log(formatDiagnostics(r.diagnostics));
      console.log(`${r.root} [${r.domain}]: ${r.versions.length} blueprint version(s), ${errors} error(s)`);
      return errors ? 2 : 0;
    }
    case "index": {
      const r = writeIndex(positional[0] ?? ".", flag("check"));
      console.log(r.message);
      return r.ok ? 0 : 2;
    }
    case "scan": {
      const s = new Scanner(readYaml(DEFAULT_POLICY).privacy);
      const fs = positional.flatMap((f) => s.scanFile(resolve(f)));
      fs.forEach((f) => console.log(`${f.file}: ${f.path}: ${f.message} [${f.detector}]`));
      return fs.length ? 2 : 0;
    }
    case "seal": sealDir(resolve(positional[0] ?? "")); console.log("sealed"); return 0;
    case "digest": console.log(fileDigest(resolve(positional[0] ?? ""))); return 0;
    case "check-immutability": {
      const ds = checkImmutability(REPO_ROOT, opt("base") ?? "origin/main");
      if (ds.length) console.log(formatDiagnostics(ds));
      console.log(`immutability: ${ds.length} violation(s)`);
      return ds.length ? 2 : 0;
    }
    case "resolve": {
      const idx = opts("index").map((f) => readChecked(resolve(f)));
      const ref = { registry: opt("registry") ?? "", id: opt("id") ?? "", version: opt("range") ?? "", ...(opt("digest") ? { digest: opt("digest"), digestAlgorithm: opt("digest-algorithm") ?? "zeptly-jcs-v1" } : {}) };
      const out = resolveRef(idx, ref, { allowCandidates: flag("allow-candidates"), domain: parseDomain(opt("domain")) });
      console.log(JSON.stringify(out, null, 2));
      return out.resolved ? 0 : 1;
    }
    case "lock": {
      const root = resolve(positional[0] ?? ".");
      const domain = parseDomain(opt("domain"));
      const own = readChecked(resolve(root, "index", "registry-index.json"));
      const marker = parseFileChecked(resolve(root, "registry.yaml"));
      if (marker.doc && marker.doc.domain !== own.domain) {
        throw new DomainError("conflicting-domain-metadata", [{ code: "conflicting-domain-metadata", message: `registry.yaml domain '${marker.doc.domain}' conflicts with index domain '${own.domain}'` }]);
      }
      const idx = [own, ...opts("index").map((f) => readChecked(resolve(f)))];
      const allowCandidates = flag("allow-candidates");
      const top = resolveRef(idx, { registry: "tiny-agents", id: opt("id") ?? "", version: opt("range") ?? "" }, { allowCandidates, domain });
      if (!top.resolved) { console.log(JSON.stringify(top, null, 2)); return 1; }
      const bp = readChecked(resolve(root, top.resolved.location ?? "", "blueprint.yaml"));
      const lock = buildLock(idx, { registry: top.resolved.registry, id: top.resolved.id, version: top.resolved.version, digest: top.resolved.digest }, bp.references, { allowCandidates, domain });
      const bad = schemaErrors("runtime-lock", lock);
      if (bad.length) { console.error(bad.join("\n")); return 2; }
      console.log(JSON.stringify(lock, null, 2));
      return lock.complete ? 0 : 1;
    }
    default: console.log(USAGE); return cmd ? 2 : 0;
  }
}
function run(): number {
  try { return main(); } catch (e) {
    if (e instanceof DomainError) { console.error(JSON.stringify({ error: { code: e.code, problems: e.problems } }, null, 2)); return 2; }
    if (e instanceof ManifestError) { console.error(JSON.stringify({ error: { code: "malformed-input", file: e.file, problems: e.problems } }, null, 2)); return 2; }
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
}
process.exit(run());
