import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatProblem, parseManifestBytes, type ParseProblem } from "./manifest.js";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readdirSync } from "node:fs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCHEMA_DIR = join(REPO_ROOT, "schema");
export const DEFAULT_POLICY = join(REPO_ROOT, "policy", "registry-policy.yaml");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export class ManifestError extends Error {
  constructor(public file: string, public problems: ParseProblem[]) {
    super(`${file}: ${problems.map(formatProblem).join("; ")}`);
    this.name = "ManifestError";
  }
}

/**
 * Parse a YAML/JSON file WITHOUT throwing, under the Protocol v0.2 manifest subset (see manifest.ts).
 * `problems` are human-readable (they end in `[code]`); `diagnostics` are the structured form (code, path, line, column).
 * A document with any problem is never returned, so nothing downstream can hash or validate it.
 */
export function parseFileChecked(path: string): { doc?: Doc; problems: string[]; diagnostics: ParseProblem[] } {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch (e) {
    const p: ParseProblem = { code: "syntax-error", path: "<root>", message: `cannot read file: ${(e as Error).message}` };
    return { problems: [formatProblem(p)], diagnostics: [p] };
  }
  const r = parseManifestBytes(bytes, path.endsWith(".json") ? "json" : "yaml");
  return r.doc ? { doc: r.doc as Doc, problems: [], diagnostics: [] } : { problems: r.problems.map(formatProblem), diagnostics: r.problems };
}

function readStrict(path: string): Doc {
  const r = parseFileChecked(path);
  if (!r.doc) throw new ManifestError(path, r.diagnostics);
  return r.doc;
}
export const readYaml = (path: string): Doc => readStrict(path);
export const readJson = (path: string): Doc => readStrict(path);
export const readData = (path: string): Doc => readStrict(path);
export const exists = existsSync;

// CJS/ESM interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020: any = (Ajv2020Module as any).default ?? Ajv2020Module;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (addFormatsModule as any).default ?? addFormatsModule;

export type SchemaName =
  | "blueprint" | "eval-suite" | "eval-result" | "sanitisation-report" | "submission" | "lifecycle"
  | "integrity" | "promotion" | "registry-root" | "upstream-source" | "upstream-lock" | "policy" | "index" | "runtime-lock";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ajv: any;
function getAjv() {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  for (const f of readdirSync(SCHEMA_DIR).filter((n) => n.endsWith(".schema.json")).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")));
  }
  return ajv;
}

/** Returns a list of human-readable schema errors (empty = valid). */
export function schemaErrors(name: SchemaName, data: unknown): string[] {
  const validate = getAjv().getSchema(`urn:zeptly:tiny-agents:schema:${name}`);
  if (!validate) throw new Error(`unknown schema ${name}`);
  if (validate(data)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (validate.errors as any[]).map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
}
