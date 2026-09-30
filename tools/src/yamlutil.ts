import { parseManifestText } from "./manifest.js";
/** Strict (Protocol v0.2 subset) parse of YAML text held in memory; throws one Error listing the problems. */
export const yamlParse = (s: string): Record<string, any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = parseManifestText(s, "yaml");
  if (!r.doc) throw new Error(r.problems.map((p) => `${p.message} [${p.code}]`).join("; "));
  return r.doc as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
