# Maintaining OpenAPI support information

The typed capability registry in `capabilities.ts` is the source for support statuses, version/profile coverage and limitations. Its internal JSON also connects capability records to the regression suite.

Each test link lists its verification layers: generation, type checking, schema compilation, adapter validation, generated-client execution or HTTP integration. Link integrity checks only confirm that a maintained test exists. Run the owning suite to establish behavior; neither the number of support rows nor a passing compilation measures full OpenAPI conformance.

```sh
npm run generate:openapi-compliance
npm run check:openapi-compliance
```

The generated `MATRIX.md` is a consumer support reference. The documentation build derives its own consumer dataset from the same registry; internal test records are excluded from the site and npm package.

Update the typed registry and its owning tests together when support changes, then regenerate the derived files. Third-party fixture attribution is retained in `THIRD_PARTY_NOTICES.md`.
