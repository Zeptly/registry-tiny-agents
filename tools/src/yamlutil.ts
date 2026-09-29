import { parse } from "yaml";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const yamlParse = (s: string): Record<string, any> => parse(s);
