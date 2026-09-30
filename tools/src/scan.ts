/**
 * Privacy / no-concrete-config scanner (defence in depth, independent of the sanitisation report).
 * Walks every key and string value of a parsed file and raw-scans comments and markdown.
 * Matched text is never echoed; findings carry only detector id, path and length.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseFileChecked, type Doc } from "./load.js";

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
    if (Array.isArray(value)) {
      // An array of "role: text" strings is a transcript; an array of objects that merely carry a `role` field
      // (skills, approvals, reviewers, ...) is NOT. Object turns are detected individually below.
      const prefixed = value.filter((v) => typeof v === "string" && TURN_PREFIX.test(v)).length;
      const f: Finding[] = prefixed >= 2 ? [{ file, path, detector: "transcript-structure", message: "array of speaker-prefixed lines looks like a conversation transcript" }] : [];
      return [...f, ...value.flatMap((v, i) => this.scanValue(v, file, `${path}[${i}]`))];
    }
    if (value && typeof value === "object") {
      const turn: Finding[] = isConversationTurn(value as Doc)
        ? [{ file, path, detector: "transcript-structure", message: "object with a conversation role (user/assistant/system/tool/…) and message content looks like a conversation turn" }] : [];
      return [...turn, ...Object.entries(value as Doc).flatMap(([k, v]) => {
        const p = path ? `${path}.${k}` : k;
        const f: Finding[] = this.keys.has(k.toLowerCase())
          ? [{ file, path: p, detector: "forbidden-key", message: `key '${k}' is forbidden in registry content` }]
          : [];
        return [...f, ...this.scanText(k, file, `${p}#key`), ...this.scanValue(v, file, p)];
      })];
    }
    return [];
  }

  /** Scan an already-parsed document plus its raw text (YAML comments are not part of the parsed value). */
  scanParsed(doc: unknown, raw: string, file: string): Finding[] {
    const findings: Finding[] = [];
    if (!file.endsWith(".json")) {
      for (const [i, line] of raw.split("\n").entries()) {
        const m = /(^|\s)#(.*)$/.exec(line);
        if (m) findings.push(...this.scanText(m[2]!, file, `<comment line ${i + 1}>`));
      }
    }
    findings.push(...this.scanValue(doc, file));
    return findings;
  }

  /** Never throws: unreadable or unparseable files produce a `parse-error` finding instead of an exception. */
  scanFile(file: string): Finding[] {
    const ext = extname(file);
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (e) { return [{ file, path: "", detector: "parse-error", message: `cannot read file: ${(e as Error).message}` }]; }
    if (ext === ".md") return this.scanText(raw, file, "<markdown>");
    if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") {
      return [{ file, path: "", detector: "unexpected-file-type", message: `file type '${ext}' is not allowed in registry content` }];
    }
    const r = parseFileChecked(file);
    if (!r.doc) return r.problems.map((m) => ({ file, path: "", detector: "parse-error", message: m }));
    return this.scanParsed(r.doc, raw, file);
  }
}

const CONVERSATION_ROLES = new Set(["user", "assistant", "system", "tool", "function", "human", "ai", "developer"]);
const ROLE_KEYS = new Set(["role", "from", "speaker"]);
const CONTENT_KEYS = new Set(["content", "text", "message", "parts", "value", "tool_calls", "toolcalls", "tool_call_id", "function_call"]);
const TURN_PREFIX = /^\s{0,16}(?:user|assistant|system|human|ai|tool)\s{0,4}:/i;

/** A conversation turn = a conversation-role value in a role-like key AND a message-content sibling key. */
function isConversationTurn(o: Doc): boolean {
  const keys = Object.keys(o);
  const roleKey = keys.find((k) => ROLE_KEYS.has(k.toLowerCase()) && typeof o[k] === "string" && CONVERSATION_ROLES.has((o[k] as string).trim().toLowerCase()));
  return roleKey !== undefined && keys.some((k) => CONTENT_KEYS.has(k.toLowerCase()));
}
