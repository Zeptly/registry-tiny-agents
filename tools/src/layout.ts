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
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { compareCodePoints } from "./order.js";

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
export interface UnsafeEntry { rel: string; kind: "symlink" | "special" }

export const toPosix = (p: string) => p.split(sep).join("/");

/** Real (non-symlink) subdirectories only; symlinks and other entries are reported by `findUnsafeEntries`. */
const subdirs = (d: string) =>
  existsSync(d)
    ? readdirSync(d, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && e.isDirectory()).map((e) => e.name).sort(compareCodePoints)
    : [];

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

/**
 * Symlink-safe tree walk: uses lstat semantics, never follows links. Regular files are returned (code-point order);
 * symlinks and special files (fifo, socket, device) are returned separately and never traversed or read.
 */
export function inspectTree(dir: string): { files: string[]; unsafe: UnsafeEntry[] } {
  const files: string[] = [], unsafe: UnsafeEntry[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => compareCodePoints(a.name, b.name))) {
      const p = join(d, e.name);
      const rel = toPosix(relative(dir, p));
      if (e.isSymbolicLink()) unsafe.push({ rel, kind: "symlink" });
      else if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(rel);
      else unsafe.push({ rel, kind: "special" });
    }
  };
  if (existsSync(dir) && lstatSync(dir).isDirectory()) walk(dir);
  return { files, unsafe };
}

export const listFilesRecursive = (dir: string): string[] => inspectTree(dir).files;

/** Unsafe entries anywhere in the registry-content subtrees of a root (blueprints/, upstreams/, index/) and the marker. */
export function findUnsafeEntries(root: string): UnsafeEntry[] {
  const out: UnsafeEntry[] = [];
  for (const top of ["blueprints", "upstreams", "index"]) {
    const base = join(root, top);
    if (!existsSync(base) && !isLink(base)) continue;
    if (isLink(base)) { out.push({ rel: top, kind: "symlink" }); continue; }
    out.push(...inspectTree(base).unsafe.map((u) => ({ ...u, rel: `${top}/${u.rel}` })));
  }
  if (isLink(join(root, FILES.root))) out.push({ rel: FILES.root, kind: "symlink" });
  return out;
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
