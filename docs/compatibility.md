# Compatibility and stability

Check which versions Golem supports and which APIs stay stable.

## Supported versions

| Requirement | Version |
| --- | --- |
| Node.js | `>=22.15.0` |
| TypeScript | `>=6.0.0 <7` or `>=7.0.0 <8` |
| NestJS | `^11.0.0` (`@nestjs/common`) |
| OpenAPI input documents | 3.1, 3.2 |
| OpenAPI output (`openapiVersion`) | `3.2.0` (default) or `3.1.2` |

Generation, `golem build` and the `parse<T>` rewrite run on TypeScript 6.0 and later 6.x, or on 7.x, and write the same files on both. TypeScript 5 isn't supported.

CI runs the unit suite on Node.js 22.15.0 and 24, on Ubuntu and Windows; Windows jobs are allowed to fail.

OpenAPI feature support depends on the document version and generation profile ([OpenAPI client support](/reference/openapi-support)).

## Stability

The configuration format (`version: 1`) and the public subpaths listed on this page follow semver from 1.0.0. Until then, a release candidate may change them; each change is listed in [Release notes](/changelog).

## Public API

Public subpaths of `@exprtlabs/golem` follow semver from 1.0.0: [`model`](/reference/runtime-api#model), [`validation`](/reference/runtime-api#validation), [`ajv`](/reference/runtime-api#ajv), [`mobx`](/reference/runtime-api#mobx), [`mobx-validation`](/reference/runtime-api#mobx-validation), [`errors`](/reference/runtime-api#errors), [`client`](/reference/runtime-api#client), [`conversion`](/reference/runtime-api#conversion), [`tags`](/reference/runtime-api#tags), [`temporal`](/reference/runtime-api#temporal), [`serde`](/reference/runtime-api#serde), [`nest`](/reference/runtime-api#nest), [`generator-api`](/reference/runtime-api#generator-api), [`manifest`](/reference/runtime-api#manifest), [`rewrite`](/reference/runtime-api#rewrite), [`loader`](/reference/runtime-api#loader), [`register`](/reference/runtime-api#register), [`vite`](/reference/runtime-api#vite) and [`esbuild`](/reference/runtime-api#esbuild).

Internal subpaths `cli`, `emitter`, `schema`, `schema-graph`, `ajv-tooling`, `type-analysis`, `generated-paths` and `ts` may change in any release.

## Feature defaults

- Validation is enabled by default. MobX, `ajvStandalone` and `allowAny` are disabled by default.
- Feature flags apply to every job. An individual `IObject` or `IModel` can override `allowAny` and `validation`.
- Callback and webhook types are generated; your application implements their handlers.
- Response links are emitted as metadata; clients don't follow them automatically.
