/**
 * Identity and reference helpers (Zeptly Registry Protocol v0.1).
 * References are STRUCTURED {registry, id, version, digest?}; no string serialisation is part of the data model.
 * `describeRef` is for messages only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_DIR } from "./load.js";

const common = JSON.parse(readFileSync(join(SCHEMA_DIR, "common.schema.json"), "utf8"));
const ID_RE = new RegExp(common.$defs.registryId.pattern);
const SEMVER_RE = new RegExp(common.$defs.semver.pattern);

export const REGISTRY_NAME = "tiny-agents";

export interface RegistryRef {
  registry: string;
  id: string;
  version: string;
  digest?: string | null;
  digestAlgorithm?: string;
}

export const isRegistryId = (s: string): boolean => ID_RE.test(s) && s.length <= common.$defs.registryId.maxLength;
export const isSemver = (s: string): boolean => SEMVER_RE.test(s);

/** Message-only rendering. Not a serialisation format. */
export const describeRef = (r: RegistryRef): string =>
  `${r.registry}/${r.id}@${r.version}${r.digest ? `#${r.digest.slice(0, 19)}…` : ""}`;
