/**
 * The only module that knows the on-disk layout of a registry root.
 *
 *   <root>/registry.yaml
 *   <root>/blueprints/{candidates,canonical}/<id>/<version>/...
 *   <root>/upstreams/<source>/{source.yaml,lock.json}
 *   <root>/index/registry-index.json
 *
 * The <id> path segment is the id VERBATIM (ids are filesystem-safe by schema), so a future id
 * syntax change needs no layout logic beyond the schema pattern.
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
  sanitisation: "sanitisation-report.yaml",
  promotion: "promotion.yaml",
  submission: "submission.yaml",
  indexOut: join("index", "registry-index.json"),
} as const;

export interface VersionDir { maturity: Maturity; id: string; version: string; dir: string }

const subdirs = (d: string) =>
  existsSync(d) ? readdirSync(d).filter((n) => !n.startsWith(".") && statSync(join(d, n)).isDirectory()).sort() : [];

export function versionDirPath(root: string, maturity: Maturity, id: string, version: string): string {
  return join(root, "blueprints", MATURITY_DIR[maturity], id, version);
}

export function listVersionDirs(root: string): VersionDir[] {
  const out: VersionDir[] = [];
  for (const maturity of ["candidate", "canonical"] as const) {
    const base = join(root, "blueprints", MATURITY_DIR[maturity]);
    for (const id of subdirs(base)) for (const version of subdirs(join(base, id))) {
      out.push({ maturity, id, version, dir: join(base, id, version) });
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
      if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out;
}
