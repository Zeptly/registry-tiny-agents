/**
 * Line-ending / encoding policy for every text file in a registry root:
 * UTF-8, no byte-order mark, LF-only (no CR), no NUL. Hashes are taken over the raw bytes, so this policy is what
 * makes seals identical on every platform. `.gitattributes` enforces `eol=lf` on checkout; validation enforces it here.
 */
export function textPolicyViolation(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "byte-order mark is not allowed (UTF-8 without BOM required)";
  if (buf.includes(0x00)) return "NUL byte is not allowed";
  if (buf.includes(0x0d)) return "carriage return (CR/CRLF) is not allowed; files must use LF line endings";
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return "file is not valid UTF-8"; }
  return null;
}
