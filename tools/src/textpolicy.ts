/**
 * Line-ending / encoding policy for every text file in a registry root (Protocol v0.2 §3):
 * UTF-8 (which excludes encoded lone surrogates), no byte-order mark, LF-only (no CR), no NUL. Hashes are taken over
 * the raw bytes, so this policy is what makes seals identical on every platform. Rejected, never normalised.
 */
export type TextProblemCode = "bom" | "nul" | "carriage-return" | "invalid-utf8";
export interface TextProblem { code: TextProblemCode; message: string }

export function textPolicyProblem(buf: Buffer): TextProblem | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { code: "bom", message: "byte-order mark is not allowed (UTF-8 without BOM required)" };
  if (buf.includes(0x00)) return { code: "nul", message: "NUL byte is not allowed" };
  if (buf.includes(0x0d)) return { code: "carriage-return", message: "carriage return (CR/CRLF) is not allowed; files must use LF line endings" };
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return { code: "invalid-utf8", message: "file is not valid UTF-8 (this includes encoded lone surrogates)" }; }
  return null;
}

/** Message-only convenience wrapper. */
export function textPolicyViolation(buf: Buffer): string | null {
  return textPolicyProblem(buf)?.message ?? null;
}
