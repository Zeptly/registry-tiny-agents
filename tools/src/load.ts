import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateValueDomain } from "./valuedomain.js";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { readdirSync } from "node:fs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SCHEMA_DIR = join(REPO_ROOT, "schema");
export const DEFAULT_POLICY = join(REPO_ROOT, "policy", "registry-policy.yaml");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export function readYaml(path: string): Doc {
  return parse(readFileSync(path, "utf8"), { uniqueKeys: true }) as Doc;
}
export function readJson(path: string): Doc {
  return JSON.parse(readFileSync(path, "utf8")) as Doc;
}
export function readData(path: string): Doc {
  return path.endsWith(".json") ? readJson(path) : readYaml(path);
}
export const exists = existsSync;

/**
 * Parse a YAML/JSON file WITHOUT throwing. Returns the document, or a list of human-readable problems
 * (syntax errors with line/column, duplicate keys, unsupported/non-finite/unsafe values, lone surrogates with JSON paths).
 * A document with any problem is never returned, so nothing downstream can hash or validate it.
 */
export function parseFileChecked(path: string): { doc?: Doc; problems: string[] } {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { return { problems: [`cannot read file: ${(e as Error).message}`] }; }
  let doc: Doc;
  try {
    doc = (path.endsWith(".json") ? JSON.parse(text) : parse(text, { uniqueKeys: true })) as Doc;
  } catch (e) {
    const err = e as Error & { linePos?: { line: number; col: number }[]; code?: string };
    const pos = err.linePos?.[0] ? ` (line ${err.linePos[0].line}, column ${err.linePos[0].col})` : "";
    return { problems: [`cannot parse ${path.endsWith(".json") ? "JSON" : "YAML"}: ${err.message.split("\n")[0]}${pos}`] };
  }
  const problems = validateValueDomain(doc).map((p) => `invalid value at ${p.path}: ${p.message} [${p.code}]`);
  return problems.length ? { problems } : { doc, problems: [] };
}

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
    ajv.addSchema(readJson(join(SCHEMA_DIR, f)));
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
