# Third party notices

The OpenAPI conformance fixtures under `tests/openapi/fixtures/upstream` are
vendored for reproducible generator checks. Their provenance, upstream commit
identifiers, and applicable licenses are recorded in the adjacent
`PROVENANCE.md` and `licenses/` files. The fixtures remain under their original
MIT or Apache-2.0 terms; this package does not claim ownership of those
documents.

The OpenAPI document schemas in `src/openapi-schemas/` are derived from
`https://spec.openapis.org/oas/3.1/schema/2026-08-03` (sha256 59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6) and
`https://spec.openapis.org/oas/3.2/schema/2026-08-30` (sha256 ec53db6e114b768ff2d273b232bda210f51b70c5e57d57ac8daf7e8496a6e073),
published by the OpenAPI Initiative under the Apache License 2.0. Each
`$dynamicRef: "#meta"` is replaced by `$ref: "#/$defs/schema"` so golem's
validator compiler can compile them; `scripts/vendor-openapi-schemas.ts` reproduces the files.
The Apache License 2.0 text ships with this package as `LICENSES/Apache-2.0.txt`.

The JSON Schema 2020-12 meta-schema in `src/openapi-schemas/json-schema-2020-12.ts`
was produced from Ajv 8's bundled copy of the upstream meta-schemas
`https://json-schema.org/draft/2020-12/schema` and its `meta/` vocabulary
schemas (core, applicator, unevaluated, validation, meta-data,
format-annotation, content), published by the JSON Schema organization. The
sha256 of the copy's files in that order is
1ea2456fb0988458861a90632d9c8a2afaa7d391aa335d9b12cff3b6c743f957; the copy keeps
the `$vocabulary` entries. Each `$dynamicRef: "#meta"` is replaced by a `$ref`
to the meta-schema and each `$dynamicAnchor` is removed so golem's validator
compiler can compile them. The next run of `scripts/vendor-openapi-schemas.ts`
(`npm run vendor:openapi-schemas`) takes the upstream bytes and records their
sha256 here and in the file header.
