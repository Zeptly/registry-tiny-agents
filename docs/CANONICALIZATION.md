# Canonicalization, digests and line endings

One policy, used everywhere digests are computed. Golden vectors in `tools/tests/normalization.test.ts` (expected
values produced by an independent Python implementation) pin every rule below.

## Canonical JSON (`tools/src/integrity.ts` `canonicalJson`)

Input: the parsed data model of a YAML/JSON document (null, boolean, finite number, string, array, object with string
keys). Output: UTF-8 JSON text with:

* no insignificant whitespace;
* object keys in **ascending Unicode code-point order** (`tools/src/order.ts`, locale-free; never `localeCompare`);
* array order preserved;
* strings as ECMAScript `JSON.stringify` (escapes `"`, `\`, and control characters below U+0020 as `\b \f \n \r \t` or
  lower-case `\u00xx`; everything else, including U+007F and U+2028/2029, is emitted raw); strings must be well-formed
  Unicode (lone surrogates are rejected);
* numbers as ECMAScript Number-to-string (`1.0` → `1`, `1e21` → `1e+21`, `-0` → `0`); `NaN`/`Infinity` are rejected;
* no Unicode normalisation: strings are hashed as authored.

This is RFC 8785 (JCS)-like but **not identical**: JCS orders keys by UTF-16 code unit, this policy by code point (they
differ only for characters outside the BMP versus U+E000–U+FFFF).

## Artifact digest (`contentDigest`)

`sha256:` + hex of SHA-256 over the canonical JSON of `blueprint.yaml` after removing:

* `metadata.version`, `metadata.maturity`  (governance state; promotion must not invalidate assessed content);
* `attestations`  (cannot contain the digest of a document that contains them);
* `security.approvals`  (governance approval records made after content is final).

Lifecycle is not part of the document (overlay file `lifecycle.yaml`). Included: identity (`metadata.id`,
`metadata.registry`, `metadata.origin`, `metadata.synthetic`), `spec`, `references`, `provenance`, and
`security.classification` / `security.capabilities`.

## Directory seal (`computeIntegrity`, `integrity.json`; canonical versions)

SHA-256 over lines `<posix path>\0<lower-case hex SHA-256 of the file's raw bytes>\n`, paths in code-point order,
covering every file in the version directory except `lifecycle.yaml` (mutable overlay) and `integrity.json` (the seal
itself). It covers the canonical payload: blueprint, evaluation suite and results, sanitisation report, promotion
record, submission.

## Line endings and encoding (`tools/src/textpolicy.ts`)

Every text file must be **UTF-8, no BOM, LF-only (no CR), no NUL**. `.gitattributes` forces `eol=lf` on checkout and
`registry validate` rejects violations, so seals are byte-identical on every platform. Digests and seals never
normalise line endings; the policy makes normalisation unnecessary.

## Ordering

Index entries: `id` (code-point order), then SemVer ascending, then maturity (code-point order). Seal paths, canonical
JSON keys and index `capabilities` use the same comparator.
