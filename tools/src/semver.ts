/** SemVer parsing, comparison and a deliberately small range grammar (exact, ^, ~, x/*, comparators, AND by space, OR by ||). */
export interface Semver { major: number; minor: number; patch: number; pre: string[] }

export function parseSemver(v: string): Semver {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new Error(`invalid semver: ${v}`);
  return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ? m[4].split(".") : [] };
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p < +q ? -1 : 1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

type Cmp = { op: ">=" | ">" | "<=" | "<" | "="; v: string };

/** Expand one range token into comparators, or null if the token is not understood. */
function expand(token: string): Cmp[] | null {
  if (token === "*" || token === "x" || token === "X") return [{ op: ">=", v: "0.0.0" }];
  const cmp = /^(>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?$/.exec(token);
  const caret = /^([\^~])(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(token);
  const n = (s: string | undefined) => (s === undefined || /[xX*]/.test(s) ? undefined : +s);
  if (caret) {
    const [, kind, a, b, c, pre] = caret;
    const M = +a!, m = b === undefined ? 0 : +b, p = c === undefined ? 0 : +c;
    const lo = `${M}.${m}.${p}${pre ?? ""}`;
    let hi: string;
    if (kind === "~") hi = b === undefined ? `${M + 1}.0.0` : `${M}.${m + 1}.0`;
    else if (M > 0 || b === undefined) hi = `${M + 1}.0.0`;
    else if (m > 0 || c === undefined) hi = `0.${m + 1}.0`;
    else hi = `0.0.${p + 1}`;
    return [{ op: ">=", v: lo }, { op: "<", v: hi }];
  }
  if (cmp) {
    const [, op, a, b, c, pre] = cmp;
    const M = +a!, m = n(b), p = n(c);
    if (!op || op === "=") {
      if (m !== undefined && p !== undefined) return [{ op: "=", v: `${M}.${m}.${p}${pre ?? ""}` }];
      if (m === undefined) return [{ op: ">=", v: `${M}.0.0` }, { op: "<", v: `${M + 1}.0.0` }];
      return [{ op: ">=", v: `${M}.${m}.0` }, { op: "<", v: `${M}.${m + 1}.0` }];
    }
    return [{ op: op as Cmp["op"], v: `${M}.${m ?? 0}.${p ?? 0}${pre ?? ""}` }];
  }
  return null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  return range.split("||").some((alt) => {
    const toks = alt.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return false;
    const cmps = toks.map(expand);
    if (cmps.some((c) => c === null)) return false;
    // Prereleases only match ranges that themselves mention a prerelease (SemVer range convention).
    if (v.pre.length && !toks.some((t) => t.includes("-"))) return false;
    return (cmps as Cmp[][]).flat().every(({ op, v: rv }) => {
      const c = compareSemver(version, rv);
      return op === "=" ? c === 0 : op === ">=" ? c >= 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c < 0;
    });
  });
}

/**
 * True when every `||` alternative is a non-empty, space-separated list of tokens in the supported range subset
 * (exact, ^, ~, x/* partials, comparators >= > <= < = glued to a version). The same grammar `satisfies` evaluates.
 */
export function isValidRange(range: string): boolean {
  if (range.length === 0 || range.length > 64) return false;
  return range.split("||").every((alt) => {
    const toks = alt.trim().split(/\s+/).filter(Boolean);
    return toks.length > 0 && toks.every((t) => expand(t) !== null);
  });
}
