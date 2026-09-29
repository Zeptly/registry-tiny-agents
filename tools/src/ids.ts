/**
 * PROVISIONAL identifier and cross-registry reference conventions.
 *
 * This is the ONLY module (with schema/common.schema.json) that knows the syntax of ids and
 * reference strings. References are STRUCTURED in data files; string forms exist only for display.
 * When the cross-registry protocol is reconciled, change this file and common.schema.json.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "./load.js";

const common = JSON.parse(readFileSync(join(SCHEMA_DIR, "common.schema.json"), "utf8"));
const ID_RE = new RegExp(common.$defs.registryId.pattern);
const SEMVER_RE = new RegExp(common.$defs.semver.pattern);

export interface RegistryRef {
  registry: string;
  id: string;
  version: string;
  digest?: string;
}

export const isRegistryId = (s: string): boolean => ID_RE.test(s) && s.length <= common.$defs.registryId.maxLength;
export const isSemver = (s: string): boolean => SEMVER_RE.test(s);

/** PROVISIONAL display form: `registry-<registry>:<id>@<range>[#<digest>]`. */
export function formatRef(ref: RegistryRef): string {
  return `registry-${ref.registry}:${ref.id}@${ref.version}${ref.digest ? `#${ref.digest}` : ""}`;
}

export function parseRef(text: string): RegistryRef {
  const m = /^registry-([a-z][a-z0-9-]*):([^@#\s]+)@([^#\s]+)(?:#(\S+))?$/.exec(text);
  if (!m) throw new Error(`not a reference string: ${text}`);
  const ref: RegistryRef = { registry: m[1]!, id: m[2]!, version: m[3]! };
  if (m[4]) ref.digest = m[4];
  return ref;
}
