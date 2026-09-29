import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { validateRoot } from "../src/validate.js";
import { REPO_ROOT, type Doc } from "../src/load.js";

export const EXAMPLE = join(REPO_ROOT, "examples", "registry");
export const A = "blueprints/canonical/example.structured-summary/1.0.0";
export const B = "blueprints/candidates/example.request-triage/0.1.0";
export const C = "blueprints/candidates/example.seed-page-reader/0.1.0";

/** Copies the synthetic example root into a temp dir for mutation. */
export function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "reg-test-"));
  cpSync(EXAMPLE, d, { recursive: true });
  return d;
}
export function edit(root: string, rel: string, fn: (d: Doc) => void): void {
  const p = join(root, rel);
  const d = parse(readFileSync(p, "utf8")) as Doc;
  fn(d);
  writeFileSync(p, stringify(d));
}
export const append = (root: string, rel: string, text: string) => writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8") + text);
export function errors(root: string, policyPath?: string): string[] {
  return validateRoot(root, { policyPath }).diagnostics.filter((d) => d.severity === "error").map((d) => `${d.where}: ${d.message}`);
}
export const has = (es: string[], needle: string) => es.some((e) => e.includes(needle));
