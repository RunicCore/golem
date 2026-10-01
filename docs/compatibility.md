# Compatibility and stability

Check which versions Golem supports and which APIs stay stable.

## Supported versions

| Requirement | Version |
| --- | --- |
| Node.js | `>=22.15.0` |
| TypeScript | `~7.0.2` |
| `ttsc` | `~0.30.4` |
| NestJS | `^11.0.0` (`@nestjs/common`) |
| OpenAPI input documents | 3.1, 3.2 |
| OpenAPI output (`openapiVersion`) | `3.2.0` (default) or `3.1.2` |

TypeScript 5 and 6 don't compile the generated code.

CI runs the unit suite on Node.js 22.15.0 and 24, on Ubuntu and Windows; Windows jobs are allowed to fail.

OpenAPI feature support depends on the document version and generation profile ([OpenAPI client support](/reference/openapi-support)).

## Stability

The configuration format (`version: 1`) and the public subpaths listed on this page follow semver from 1.0.0. Until then, a release candidate may change them; each change is listed in [Release notes](/changelog).

## Public API

Public subpaths of `@exprtlabs/golem` follow semver from 1.0.0: [`model`](/reference/runtime-api#model), [`validation`](/reference/runtime-api#validation), [`ajv`](/reference/runtime-api#ajv), [`mobx`](/reference/runtime-api#mobx), [`mobx-validation`](/reference/runtime-api#mobx-validation), [`errors`](/reference/runtime-api#errors), [`client`](/reference/runtime-api#client), [`conversion`](/reference/runtime-api#conversion), [`tags`](/reference/runtime-api#tags), [`temporal`](/reference/runtime-api#temporal), [`serde`](/reference/runtime-api#serde), [`nest`](/reference/runtime-api#nest), [`ttsc-plugin`](/reference/runtime-api#ttsc-plugin), [`generator-api`](/reference/runtime-api#generator-api) and [`manifest`](/reference/runtime-api#manifest).

Internal subpaths `cli`, `emitter`, `schema`, `schema-graph`, `ajv-tooling`, `type-analysis`, `generated-paths` and `ts` may change in any release.

## Feature defaults

- Validation is enabled by default. MobX, `ajvStandalone` and `allowAny` are disabled by default.
- Feature flags apply to every job. An individual `IObject` or `IModel` can override `allowAny` and `validation`.
- Callback and webhook types are generated; your application implements their handlers.
- Response links are emitted as metadata; clients don't follow them automatically.
