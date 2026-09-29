/**
 * The only module that knows the on-disk layout of a registry root. Logical identity lives in the
 * document (`metadata.id` / `metadata.version` / `metadata.maturity`); layout is a derived location.
 *
 *   <root>/registry.yaml
 *   <root>/blueprints/{candidates,canonical}/<segment(id)>/<version>/...
 *   <root>/upstreams/<source>/{source.yaml,lock.json}
 *   <root>/index/registry-index.json
 *
 * Discovery never parses directory names into identity. Consumers locate artifacts through the index
 * `location` field; `expectedDir` is used to create artifacts and to lint that they sit where tooling puts them.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Maturity = "candidate" | "canonical";
export const MATURITY_DIR: Record<Maturity, string> = { candidate: "candidates", canonical: "canonical" };

export const FILES = {
  root: "registry.yaml",
  blueprint: "blueprint.yaml",
  lifecycle: "lifecycle.yaml",
  integrity: "integrity.json",
  promotion: "promotion.yaml",
  submission: "submission.yaml",
  indexOut: join("index", "registry-index.json"),
} as const;

/** Filesystem-safe encoding of a logical id: unreserved characters verbatim, everything else `~XX`. */
export function idSegment(id: string): string {
  return [...Buffer.from(id, "utf8")].map((b) => {
    const ch = String.fromCharCode(b);
    return /[a-z0-9._-]/.test(ch) ? ch : `~${b.toString(16).padStart(2, "0")}`;
  }).join("");
}

/** A discovered version directory. Identity is NOT derived from the path. */
export interface VersionDir { zone: Maturity; dir: string; rel: string }

const subdirs = (d: string) =>
  existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith(".") && statSync(join(d, n)).isDirectory()).sort() : [];

export const toPosix = (p: string) => p.split(sep).join("/");

export function expectedDir(root: string, maturity: Maturity, id: string, version: string): string {
  return join(root, "blueprints", MATURITY_DIR[maturity], idSegment(id), version);
}

export function discoverVersionDirs(root: string): VersionDir[] {
  const out: VersionDir[] = [];
  for (const zone of ["candidate", "canonical"] as const) {
    const base = join(root, "blueprints", MATURITY_DIR[zone]);
    for (const seg of subdirs(base)) for (const ver of subdirs(join(base, seg))) {
      const dir = join(base, seg, ver);
      out.push({ zone, dir, rel: toPosix(relative(root, dir)) });
    }
  }
  return out;
}

export const listUpstreamSources = (root: string): string[] => subdirs(join(root, "upstreams"));

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out.push(toPosix(relative(dir, p)));
    }
  };
  walk(dir);
  return out;
}
