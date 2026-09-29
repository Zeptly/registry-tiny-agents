/**
 * Enforces the immutable canonical version-directory model against a Git base ref:
 * files under blueprints/canonical/<id>/<version>/ may not be modified, deleted or added to after
 * the directory first appears — except lifecycle.yaml, whose history is append-only.
 */
import { execFileSync } from "node:child_process";
import { yamlParse } from "./yamlutil.js";
import type { Diagnostic } from "./validate.js";

const RE = /^((?:.*\/)?blueprints\/canonical\/[^/]+\/[^/]+)\/(.+)$/;

export function checkImmutability(repoDir: string, base: string, head = "HEAD"): Diagnostic[] {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, encoding: "utf8" });
  const ds: Diagnostic[] = [];
  const err = (where: string, message: string) => ds.push({ severity: "error", where, message });
  try { git("rev-parse", "--verify", `${base}^{commit}`); } catch { return [{ severity: "error", where: "git", message: `base ref '${base}' not found` }]; }
  // Compare against the merge base so unrelated commits that landed on the base branch are not misread as reverts.
  try { base = git("merge-base", base, head).trim(); } catch { return [{ severity: "error", where: "git", message: `no merge base between '${base}' and '${head}'` }]; }

  const out = git("diff", "--name-status", "--no-renames", `${base}`, head, "--", ":(glob)**/blueprints/canonical/**");
  for (const line of out.split("\n").filter(Boolean)) {
    const [status, path] = line.split("\t") as [string, string];
    const m = RE.exec(path);
    if (!m) continue;
    const [, dir, rest] = m as unknown as [string, string, string];
    if (status === "A") {
      const existing = git("ls-tree", "-r", "--name-only", base, "--", dir).trim();
      if (existing && rest !== "lifecycle.yaml") err(path, "file added to an already-published canonical version directory");
    } else if (rest === "lifecycle.yaml" && status === "M") {
      const before = yamlParse(git("show", `${base}:${path}`)).history as unknown[];
      const after = yamlParse(git("show", `${head}:${path}`)).history as unknown[];
      if (after.length < before.length || JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) err(path, "lifecycle history is append-only");
    } else {
      err(path, `published canonical content is immutable (status ${status}); publish a new version or change lifecycle instead`);
    }
  }
  return ds;
}
