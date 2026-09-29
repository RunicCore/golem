# Vendored upstream OpenAPI fixtures

These files are copied into this package so conformance tests have no runtime
dependency on another repository or the network. Fixture content is unchanged;
only the directory layout differs from upstream. Exact source paths and commits
are recorded in `manifest.json`.

The corpus intentionally combines:

- all six OpenAPI 3.0 pass fixtures retained by the official OAI specification
  repository;
- Redocly's complete OpenAPI 3.1 Museum API example; and
- the complete set of focused OpenAPI 3.1 and 3.2 documents currently present
  in the `openapi-to-rust` conformance fixture directory.

Each upstream license is included under `licenses/`. Updating a fixture requires
updating its commit and original path in `manifest.json`; tests reject missing
files and a version that does not match the declared 3.0, 3.1, or 3.2 line.
