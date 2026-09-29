#!/usr/bin/env node
import { resolve } from "node:path";
import { formatDiagnostics, validateRoot } from "./validate.js";
import { writeIndex } from "./index-gen.js";
import { sealDir, fileDigest } from "./integrity.js";
import { checkImmutability } from "./immutability.js";
import { Scanner } from "./scan.js";
import { DEFAULT_POLICY, REPO_ROOT, readYaml } from "./load.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.includes(`--${n}`);
const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const VALUE_FLAGS = ["policy", "base"];
const positional = rest.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes((rest[i - 1] ?? "").slice(2)));

const USAGE = `usage:
  registry validate <root> [--policy <file>]     validate a registry root
  registry index <root> [--check]                (re)generate or verify the deterministic index
  registry scan <file...>                        run the privacy scanner on files
  registry seal <version-dir>                    write integrity.json for a version directory
  registry digest <file>                         print a file digest
  registry check-immutability --base <ref>       verify canonical dirs are unchanged vs a Git ref`;

function main(): number {
  switch (cmd) {
    case "validate": {
      const r = validateRoot(positional[0] ?? ".", { policyPath: opt("policy") });
      const errors = r.diagnostics.filter((d) => d.severity === "error").length;
      if (r.diagnostics.length) console.log(formatDiagnostics(r.diagnostics));
      console.log(`${r.root} [${r.purpose}]: ${r.versions.length} blueprint version(s), ${errors} error(s)`);
      return errors ? 1 : 0;
    }
    case "index": {
      const r = writeIndex(positional[0] ?? ".", flag("check"));
      console.log(r.message);
      return r.ok ? 0 : 1;
    }
    case "scan": {
      const s = new Scanner(readYaml(DEFAULT_POLICY).privacy);
      const fs = positional.flatMap((f) => s.scanFile(resolve(f)));
      fs.forEach((f) => console.log(`${f.file}: ${f.path}: ${f.message} [${f.detector}]`));
      return fs.length ? 1 : 0;
    }
    case "seal": sealDir(resolve(positional[0] ?? "")); console.log("sealed"); return 0;
    case "digest": console.log(fileDigest(resolve(positional[0] ?? ""))); return 0;
    case "check-immutability": {
      const ds = checkImmutability(REPO_ROOT, opt("base") ?? "origin/main");
      if (ds.length) console.log(formatDiagnostics(ds));
      console.log(`immutability: ${ds.length} violation(s)`);
      return ds.length ? 1 : 0;
    }
    default: console.log(USAGE); return cmd ? 2 : 0;
  }
}
process.exit(main());
