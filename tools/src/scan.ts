/**
 * Privacy / no-concrete-config scanner (defence in depth, independent of the sanitisation report).
 * Walks every key and string value of a parsed file and raw-scans comments and markdown.
 * Matched text is never echoed; findings carry only detector id, path and length.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { readData, type Doc } from "./load.js";

export interface Finding { file: string; path: string; detector: string; message: string }

interface PrivacyPolicy {
  forbiddenKeys: string[];
  forbiddenConcretePatterns: { id: string; pattern: string; flags?: string }[];
  pathExemptions: { detector: string; pathPattern: string }[];
}

export class Scanner {
  private keys: Set<string>;
  private patterns: { id: string; re: RegExp }[];
  private exemptions: { detector: string; re: RegExp }[];

  constructor(policy: PrivacyPolicy) {
    this.keys = new Set(policy.forbiddenKeys.map((k) => k.toLowerCase()));
    this.patterns = policy.forbiddenConcretePatterns.map((p) => ({ id: p.id, re: new RegExp(p.pattern, p.flags ?? "") }));
    this.exemptions = policy.pathExemptions.map((e) => ({ detector: e.detector, re: new RegExp(e.pathPattern) }));
  }

  scanText(text: string, file: string, path: string): Finding[] {
    const out: Finding[] = [];
    for (const p of this.patterns) {
      if (!p.re.test(text)) continue;
      if (this.exemptions.some((e) => e.detector === p.id && e.re.test(path))) continue;
      out.push({ file, path, detector: p.id, message: `matches '${p.id}' detector (${text.length} chars, not echoed)` });
    }
    return out;
  }

  scanValue(value: unknown, file: string, path = ""): Finding[] {
    if (typeof value === "string") return this.scanText(value, file, path);
    if (Array.isArray(value)) return value.flatMap((v, i) => this.scanValue(v, file, `${path}[${i}]`));
    if (value && typeof value === "object") {
      return Object.entries(value as Doc).flatMap(([k, v]) => {
        const p = path ? `${path}.${k}` : k;
        const f: Finding[] = this.keys.has(k.toLowerCase())
          ? [{ file, path: p, detector: "forbidden-key", message: `key '${k}' is forbidden in registry content` }]
          : [];
        return [...f, ...this.scanText(k, file, `${p}#key`), ...this.scanValue(v, file, p)];
      });
    }
    return [];
  }

  scanFile(file: string): Finding[] {
    const ext = extname(file);
    const raw = readFileSync(file, "utf8");
    if (ext === ".md") return this.scanText(raw, file, "<markdown>");
    if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") {
      return [{ file, path: "", detector: "unexpected-file-type", message: `file type '${ext}' is not allowed in registry content` }];
    }
    const findings: Finding[] = [];
    if (ext !== ".json") {
      // YAML comments are not part of the parsed value; scan them separately.
      for (const [i, line] of raw.split("\n").entries()) {
        const m = /(^|\s)#(.*)$/.exec(line);
        if (m) findings.push(...this.scanText(m[2]!, file, `<comment line ${i + 1}>`));
      }
    }
    findings.push(...this.scanValue(readData(file), file));
    return findings;
  }
}
