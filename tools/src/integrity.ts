/** PROVISIONAL digest/sealing convention: sha256 over sorted `<path>\0<file sha256>\n` lines. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, listFilesRecursive } from "./layout.js";

export const sha256 = (data: Buffer | string): string => "sha256:" + createHash("sha256").update(data).digest("hex");
export const fileDigest = (path: string): string => sha256(readFileSync(path));

/** Files covered by the seal: everything except the two mutable/derived files. */
export const sealedFiles = (dir: string): string[] =>
  listFilesRecursive(dir).filter((f) => f !== FILES.lifecycle && f !== FILES.integrity);

export function computeIntegrity(dir: string): { integrityVersion: string; digest: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const f of sealedFiles(dir)) files[f] = fileDigest(join(dir, f));
  const lines = Object.keys(files).sort().map((f) => `${f}\0${files[f]!.slice("sha256:".length)}\n`).join("");
  return { integrityVersion: "integrity/v0-provisional", digest: sha256(lines), files };
}

export function sealDir(dir: string): void {
  writeFileSync(join(dir, FILES.integrity), JSON.stringify(computeIntegrity(dir), null, 2) + "\n");
}
