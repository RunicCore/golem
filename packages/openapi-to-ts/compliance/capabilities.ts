/**
 * Typed source for the package compliance metadata.
 *
 * The JSON emitted from this module is distributable metadata. Keep capability
 * claims tied to a version, generation profile, surface, and declared evidence
 * so a corpus count cannot silently become a blanket runtime claim.
 */

export const OPENAPI_VERSIONS = ['3.1', '3.2'] as const;
export type OpenApiVersion = (typeof OPENAPI_VERSIONS)[number];

export const GENERATION_PROFILES = {
  'mobx-off-validation-off': { mobx: false, validation: false },
  'mobx-off-validation-on': { mobx: false, validation: true },
  'mobx-on-validation-off': { mobx: true, validation: false },
  'mobx-on-validation-on': { mobx: true, validation: true },
} as const;
export type GenerationProfileId = keyof typeof GENERATION_PROFILES;
export const PROFILE_IDS = Object.keys(GENERATION_PROFILES) as GenerationProfileId[];

export type CapabilitySurface = 'runtime' | 'types-contracts' | 'metadata';
export type CapabilityStatus =
  | 'supported'
  | 'partial'
  | 'validation-only'
  | 'opt-in'
  | 'unsupported'
  | 'not-applicable';

export const STATUS_LABELS: Readonly<Record<CapabilityStatus, string>> = {
  supported: 'Supported',
  partial: 'Partial',
  'validation-only': 'Validation only',
  'opt-in': 'Opt-in',
  unsupported: 'Unsupported',
  'not-applicable': 'N/A',
};

export const STATUS_MEANINGS: Readonly<Record<string, string>> = {
  Supported: 'available for this OpenAPI version and configuration',
  Partial: 'available with the limitations described below',
  'Validation only': 'the document is checked and preserved, without a generated runtime implementation',
  'Opt-in': 'requires additional configuration or an application-supplied implementation',
  Unsupported: 'not implemented; the generator reports why it cannot use this input',
  'N/A': 'the capability does not apply to this OpenAPI version or generation profile',
};

export type VerificationLayer = 'generation' | 'type-check' | 'schema-compilation' | 'adapter-validation' | 'generated-client' | 'http-integration' | 'model-runtime' | 'metadata';

export interface EvidenceDeclaration {
  readonly id: string;
  readonly file: string;
  readonly testName: string;
  readonly kind: 'compile' | 'wire' | 'metadata' | 'negative' | 'contract';
  readonly layers: readonly VerificationLayer[];
  readonly description: string;
}

export const EVIDENCE_DECLARATIONS = [
  {
    id: 'upstream-public-generation',
    file: 'tests/openapi/upstream-conformance.integration.ts',
    testName: 'typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation',
    kind: 'compile',
    layers: ['generation', 'type-check'],
    description: 'Every pinned fixture is loaded through the public generator and strict-compiled for every declared profile.',
  },
  {
    id: 'upstream-profile-surfaces',
    file: 'tests/openapi/upstream-conformance.integration.ts',
    testName: 'typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation',
    kind: 'metadata',
    layers: ['metadata'],
    description: 'The artifact inventory is checked against outbound, inbound, links, component, and validation consumers.',
  },
  {
    id: 'upstream-operation-cases',
    file: 'tests/openapi/upstream-conformance.integration.ts',
    testName: 'typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'An explicit case table covers each normalized outbound operation and fails on new or skipped operations.',
  },
  {
    id: 'upstream-ajv-native-codecs',
    file: 'tests/openapi/upstream-conformance.integration.ts',
    testName: 'typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'Validation-enabled clients use the generated Ajv registry; JSON, empty, form, and binary media use native codecs.',
  },
  {
    id: 'upstream-inbound-contracts',
    file: 'tests/openapi/upstream-conformance.integration.ts',
    testName: 'typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation',
    kind: 'contract',
    layers: ['type-check'],
    description: 'Callback and webhook operations are strict-compiled as inbound ports and are excluded from outbound execution counts.',
  },
  {
    id: 'conformance-sse-envelope',
    file: 'tests/openapi/conformance.test.ts',
    testName: 'OpenAPI 3.2 querystring, sequential stream, and binary responses work on the wire',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'SSE frames preserve the protocol envelope including data, event, id, and retry fields.',
  },
  {
    id: 'conformance-item-schema-version-gate',
    file: 'tests/openapi/streams.test.ts',
    testName: 'itemSchema is rejected for OpenAPI 3.1 before SDK generation',
    kind: 'negative',
    layers: ['generation'],
    description: 'The itemSchema keyword is rejected before SDK generation on OpenAPI 3.1; the stream surface begins on the 3.2 feature line.',
  },
  {
    id: 'conformance-default-codecs',
    file: 'tests/openapi/conformance.test.ts',
    testName: 'generated client serializes path, repeated query, form body and API-key auth',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'Built-in parameter and body codecs are exercised with concrete wire assertions.',
  },
  {
    id: 'conformance-custom-codec-boundaries',
    file: 'tests/openapi/conformance.test.ts',
    testName: 'OpenAPI 3.2 querystring, sequential stream, and binary responses work on the wire',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'Custom stream and advanced multipart codecs are tested only at their explicit media-type boundaries.',
  },
  {
    id: 'conformance-links-metadata',
    file: 'tests/openapi/upstream-conformance.integration.ts',
    testName: 'typed upstream corpus cases generate, strict-compile, and execute every accounted outbound operation',
    kind: 'metadata',
    layers: ['metadata'],
    description: 'Link Objects are generated and type-checked as metadata; no link execution claim is made.',
  },
  {
    id: 'conformance-inbound-contracts',
    file: 'tests/openapi/conformance.test.ts',
    testName: 'normalizes callbacks and webhooks into typed inbound contracts',
    kind: 'contract',
    layers: ['generation'],
    description: 'Callbacks and webhooks are normalized into framework-neutral inbound contracts.',
  },
  {
    id: 'conformance-conditional-annotation',
    file: 'tests/ajv-engine.test.ts',
    testName: 'the OpenAPI Ajv engine enforces $dynamicRef/$dynamicAnchor recursion, unevaluatedProperties, and allErrors',
    kind: 'negative',
    layers: ['adapter-validation'],
    description: 'Conditional and annotation-dependent semantics remain runtime-authoritative; TypeScript inference is recorded as partial.',
  },
  {
    id: 'conformance-content-parameter-validation',
    file: 'tests/openapi/parameters.test.ts',
    testName: 'generated content parameters validate before execute with runtime and standalone Ajv',
    kind: 'negative',
    layers: ['generated-client', 'adapter-validation'],
    description: 'Content-based querystring, query, header, and path parameters reject invalid input before serialization and do not call fetch in either validation adapter profile.',
  },
  {
    id: 'conformance-content-parameter-false-schema',
    file: 'tests/openapi/parameters.test.ts',
    testName: 'parameter content false schemas remain false during normalization and are rejected before fetch',
    kind: 'negative',
    layers: ['generation', 'schema-compilation'],
    description: 'An explicit false schema in parameter content remains false through normalization and the emitted runtime registry, preserving the never input contract.',
  },
  {
    id: 'conformance-advanced-constraints',
    file: 'tests/openapi/schema-semantics.test.ts',
    testName: 'generated SDK enforces conditional request and response schemas with runtime and standalone Ajv',
    kind: 'negative',
    layers: ['generated-client', 'adapter-validation'],
    description: 'Conditional request violations are rejected before fetch and conditional response violations are rejected after decoding in both runtime and standalone Ajv profiles.',
  },
  {
    id: 'conformance-remote-reference-policy',
    file: 'tests/openapi/schema-projection.test.ts',
    testName: 'undeclared HTTPS schema refs stay blocked without network',
    kind: 'negative',
    layers: ['generation'],
    description: 'Remote references are an explicit opt-in boundary with host and resource limits.',
  },
  {
    id: 'compliance-source-integrity',
    file: 'tests/openapi/compliance-matrix.test.ts',
    testName: 'typed compliance records and evidence links are unique and complete',
    kind: 'metadata',
    layers: ['metadata'],
    description: 'Capability, profile, version, surface, status, limitation, and evidence links are validated before matrix generation.',
  },
  {
    id: "directional-required-and-neutral-models",
    file: "tests/projection-integration.test.ts",
    testName: "public directional projection handles repeated aliases and allOf requirements without weakening neutral or required-only schemas",
    kind: "wire",
    layers: ['generated-client'],
    description: "Public generation, strict types, default Ajv, sibling allOf constraints and neutral model validation are exercised together.",
  },
  {
    id: 'local-resource-targets',
    file: 'tests/resource-projection.test.ts',
    testName: 'public resource graph distinguishes whole, scalar, and nested targets with relative resource scope',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'Public generation, strict consumer types and default Ajv agree on whole resources, URI fragments and nested relative identifiers without network access.',
  },
  {
    id: 'uri-model-types',
    file: 'tests/openapi/resource-types.test.ts',
    testName: 'public generate types URI $id refs, directional imports, nested models, and validation',
    kind: 'wire',
    layers: ['generation', 'type-check', 'model-runtime'],
    description: 'HTTPS, URN and relative references retain typed request/response contracts, nested model conversion and explicit model validation.',
  },
  {
    id: "response-precedence",
    file: "tests/openapi/response-selection.test.ts",
    testName: "selects exact status then exact media, then type/*, then */* without status fallthrough",
    kind: "wire",
    layers: ['generated-client'],
    description: "Exact/range/default status selection precedes exact/type/global media selection; codecs use the selected contract and actual wire media.",
  },
  {
    id: 'response-codec-cleanup',
    file: 'tests/decoder-cleanup.test.ts',
    testName: 'decoder failures cancel an unconsumed generated response body',
    kind: 'wire',
    layers: ['generated-client'],
    description: 'Protocol, decoder and validation failures cancel unconsumed bodies and preserve the original error; stream overrides select actual media before declared wildcards.',
  },
  {
    id: "literal-headers",
    file: "tests/openapi/headers-cookies.test.ts",
    testName: "header simple values stay literal and never percent-decode",
    kind: "wire",
    layers: ['generated-client'],
    description: "Header arrays and objects preserve literal spaces and percent sequences.",
  },
  {
    id: "cookie-style-32",
    file: "tests/openapi/headers-cookies.test.ts",
    testName: "OAS 3.2 style cookie stringifies without URI encoding while form cookies keep encoding",
    kind: "wire",
    layers: ['generated-client'],
    description: "The 3.2 cookie style differs deliberately from the legacy form cookie encoding.",
  },
  {
    id: "tuple-prefixes",
    file: "tests/openapi/prefix-items.test.ts",
    testName: "prefixItems unions compile in strict TypeScript and validate on default Ajv",
    kind: "compile",
    layers: ['type-check', 'adapter-validation'],
    description: "Prefix-length tuple unions preserve short arrays and positional types, with runtime bounds enforced by Ajv.",
  },
  {
    id: "json-sequence-framing",
    file: "tests/openapi/streams.test.ts",
    testName: "JSON-seq rejects truncated primitives at EOF and malformed records, cancelling the reader",
    kind: "negative",
    layers: ['generated-client'],
    description: "RS framing, primitive whitespace, fatal UTF-8 and reader cleanup are tested independently of schema validation.",
  },
  {
    id: "false-item-schema",
    file: "tests/openapi/streams.test.ts",
    testName: "itemSchema false emits AsyncIterable<never>; validation-on rejects the first item and validation-off still yields",
    kind: "wire",
    layers: ['generated-client'],
    description: "A false item schema is present; the global profile controls schema enforcement while framing remains active.",
  },
  {
    id: "bounded-remote-bodies",
    file: "tests/openapi/remote-refs.test.ts",
    testName: "maxRefBytes ignores understated Content-Length and cancels on the first exceeding chunk",
    kind: "negative",
    layers: ['generation'],
    description: "Received bytes are bounded during streaming, including absent or understated Content-Length.",
  },
  {
    id: "lean-output-profiles",
    file: "tests/openapi/emission-plan.test.ts",
    testName: "full-feature fixture compiles with noUnusedLocals for every profile",
    kind: "compile",
    layers: ['generation', 'type-check'],
    description: "A strict noUnused consumer checks helper and import closure across every profile.",
  },
  {
    id: 'oas-discriminator-variants',
    file: 'tests/openapi/discriminator.test.ts',
    testName: 'OAS discriminator mappings select allOf variants in model decode, encode, and the shared codec',
    kind: 'wire',
    layers: ['generation', 'type-check', 'model-runtime'],
    description: 'Explicit (reference and bare-name) and implicit mappings narrow each allOf variant to a required literal tag; model decode, nested fields and parse/stringify select the variant and reject unknown tags.',
  },
  {
    id: 'oas-discriminator-required',
    file: 'tests/openapi/discriminator.test.ts',
    testName: 'discriminator-less object unions name the schema and suggest a discriminator',
    kind: 'negative',
    layers: ['generation'],
    description: 'A oneOf of object models without a discriminator or const tags fails generation and names the schema.',
  },
  {
    id: 'oas-discriminator-declared-tag',
    file: 'tests/openapi/discriminator.test.ts',
    testName: 'every variant must declare the discriminator property',
    kind: 'negative',
    layers: ['generation'],
    description: 'A variant that does not declare the discriminator property fails generation instead of losing the tag on encode.',
  },
  {
    id: 'oas-discriminator-inheritance',
    file: 'tests/openapi/discriminator.test.ts',
    testName: 'a discriminator inherited through allOf without oneOf is reported as unsupported',
    kind: 'negative',
    layers: ['generation'],
    description: 'A discriminator on a base schema without oneOf/anyOf produces a generation warning instead of silently decoding the base.',
  },
  {
    id: 'transport-hardening',
    file: 'tests/openapi/transport-hardening.test.ts',
    testName: 'generated transport honors OAS security, encoding, response, and stream rules',
    kind: 'wire',
    layers: ['generation', 'generated-client'],
    description: 'Cookie parameters and cookie API keys warn at generation and are still sent from Node; optional security, UTF-8 Basic credentials, allowReserved, nested deepObject, body-less and undeclared responses, and SSE framing are exercised on the wire.',
  },
] as const satisfies readonly EvidenceDeclaration[];

export type EvidenceId = (typeof EVIDENCE_DECLARATIONS)[number]['id'];

export interface CapabilityRecord {
  readonly id: string;
  readonly capability: string;
  readonly title: string;
  readonly version: OpenApiVersion;
  readonly profile: GenerationProfileId;
  readonly surface: CapabilitySurface;
  readonly status: CapabilityStatus;
  readonly limitations: readonly string[];
  readonly evidenceIds: readonly EvidenceId[];
}

export const REPRESENTATION_BOUNDARIES = [
  'General negation and conditional schemas are not faithfully representable as TypeScript structural types; generated runtime validation remains authoritative.',
  'TypeScript does not provide exact unevaluated-property semantics across composition; generated runtime validation enforces them when validation is enabled.',
  'Callbacks and webhooks are inbound contracts only. Generated as types; your app implements the handlers.',
  'Response Link Objects are metadata only; evaluating runtime expressions remains application-owned.',
  'Unknown format names are annotations in the default Ajv engine; applications can supply an engine with custom format validators.',
  'OpenAPI 3.1 does not define the itemSchema stream surface used by this generator. Streams need OpenAPI 3.2.',
] as const;

export const CAPABILITY_TITLES: Readonly<Record<string, string>> = {
  'document-input-and-structural-validation': 'OpenAPI document validation',
  'standard-http-operations': 'HTTP client methods',
  'component-and-operation-types': 'Schema and operation types',
  'directional-component-types': 'Separate request and response types',
  'generated-runtime-validation': 'Request and response validation',
  'native-json-form-empty-and-binary-codecs': 'JSON, forms, empty and binary bodies',
  'custom-codec-boundaries': 'Custom media types and codecs',
  'unconfigured-structured-media': 'Media types without a codec',
  'item-schema-streams': 'Streaming response items',
  'sse-envelope': 'Server-sent event fields',
  'callbacks-and-webhooks': 'Callbacks and webhooks',
  'response-links': 'Links between operations',
  'conditional-and-annotation-inference': 'Conditional and negated schemas',
  'remote-references': 'Remote schema references',
  'profile-specific-public-artifacts': 'Optional generated modules',
  'model-manifest-profile-identity': 'Sharing SDK models with frontend models',
  'vendored-upstream-corpus': 'Published OpenAPI examples',
  'response-status-and-media-precedence': 'Response status and media selection',
  'literal-simple-headers': 'Simple header values',
  'cookie-parameter-style': 'Cookie parameter style',
  'prefix-items-tuples': 'Tuple types',
  'discriminated-model-unions': 'Discriminated model unions',
  'inherited-discriminator': 'Discriminator inherited through allOf',
  'browser-cookie-parameters': 'Cookie parameters and cookie API keys in browsers',
};

type CapabilitySeed = Omit<CapabilityRecord, 'id' | 'title' | 'version' | 'profile' | 'status'> & {
  readonly capability: string;
};

function recordsFor(
  seed: CapabilitySeed,
  versions: readonly OpenApiVersion[],
  profiles: readonly GenerationProfileId[],
  statuses: Readonly<Record<OpenApiVersion, CapabilityStatus>> | CapabilityStatus,
): readonly CapabilityRecord[] {
  return versions.flatMap((version) => profiles.map((profile) => ({
    ...seed,
    title: CAPABILITY_TITLES[seed.capability],
    id: `${seed.capability}.${version}.${profile}.${seed.surface}`,
    version,
    profile,
    status: typeof statuses === 'string' ? statuses : statuses[version],
  })));
}

const ALL_PROFILES = PROFILE_IDS;
const VALIDATION_PROFILES = PROFILE_IDS.filter((profile) => GENERATION_PROFILES[profile].validation);
const NO_VALIDATION_PROFILES = PROFILE_IDS.filter((profile) => !GENERATION_PROFILES[profile].validation);

export const CAPABILITY_RECORDS: readonly CapabilityRecord[] = [
  ...recordsFor({
    capability: 'document-input-and-structural-validation',
    surface: 'runtime',
    limitations: ['Accepts OpenAPI 3.1 and 3.2 documents; OpenAPI 3.0 is rejected. Input checking remains enabled when runtime validation is off.'],
    evidenceIds: ['upstream-public-generation'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'standard-http-operations',
    surface: 'runtime',
    limitations: ['Generates methods for outgoing HTTP requests. Callbacks and webhooks have types but no server implementation.'],
    evidenceIds: ['upstream-operation-cases'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'component-and-operation-types',
    surface: 'types-contracts',
    limitations: ['Structural TypeScript types do not replace runtime JSON Schema evaluation.'],
    evidenceIds: ['upstream-profile-surfaces', 'local-resource-targets', 'uri-model-types'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'directional-component-types',
    surface: 'types-contracts',
    limitations: ['Request and response types follow readOnly and writeOnly on properties, resolved references and unconditional allOf branches. Conditional annotations may not narrow the types.'],
    evidenceIds: ['upstream-profile-surfaces', 'directional-required-and-neutral-models'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'partial'),
  ...recordsFor({
    capability: 'generated-runtime-validation',
    surface: 'runtime',
    limitations: ['Validation is emitted and used only for profiles with validation enabled. Unknown format names are annotations unless a custom engine defines them.'],
    evidenceIds: [
      'upstream-ajv-native-codecs',
      'conformance-content-parameter-validation',
      'conformance-content-parameter-false-schema',
      'conformance-advanced-constraints',
    ],
  }, OPENAPI_VERSIONS, VALIDATION_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'generated-runtime-validation',
    surface: 'runtime',
    limitations: ['Validation is intentionally disabled for this profile; protocol codecs still run.'],
    evidenceIds: ['upstream-profile-surfaces'],
  }, OPENAPI_VERSIONS, NO_VALIDATION_PROFILES, 'not-applicable'),
  ...recordsFor({
    capability: 'native-json-form-empty-and-binary-codecs',
    surface: 'runtime',
    limitations: ['Structured media types outside the built-in codecs require an exact media-type codec.'],
    evidenceIds: ['upstream-ajv-native-codecs', 'conformance-default-codecs'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'custom-codec-boundaries',
    surface: 'runtime',
    limitations: ['Custom encoders, decoders, serializers, and stream framers are caller-supplied per media type (exact key, then type/subtype, then `*/*`).'],
    evidenceIds: ['conformance-custom-codec-boundaries', 'response-codec-cleanup'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'opt-in'),
  ...recordsFor({
    capability: 'unconfigured-structured-media',
    surface: 'runtime',
    limitations: ['Provide a codec for structured media types without built-in support; otherwise the client call rejects when it needs that codec.'],
    evidenceIds: ['conformance-custom-codec-boundaries'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'unsupported'),
  ...recordsFor({
    capability: 'item-schema-streams',
    surface: 'runtime',
    limitations: ['Streaming with itemSchema requires OpenAPI 3.2.'],
    evidenceIds: ['conformance-item-schema-version-gate'],
  }, ['3.1'], ALL_PROFILES, 'not-applicable'),
  ...recordsFor({
    capability: 'item-schema-streams',
    surface: 'runtime',
    limitations: ['Reads NDJSON, JSON-seq and SSE streams. Other framing requires a custom decoder.'],
    evidenceIds: ['conformance-item-schema-version-gate', 'conformance-sse-envelope', 'json-sequence-framing', 'false-item-schema'],
  }, ['3.2'], ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'sse-envelope',
    surface: 'runtime',
    limitations: ['Streaming with itemSchema requires OpenAPI 3.2.'],
    evidenceIds: ['conformance-item-schema-version-gate'],
  }, ['3.1'], ALL_PROFILES, 'not-applicable'),
  ...recordsFor({
    capability: 'sse-envelope',
    surface: 'runtime',
    limitations: ['Only protocol fields defined by the SSE envelope are surfaced; application payload decoding remains caller-owned.'],
    evidenceIds: ['conformance-sse-envelope'],
  }, ['3.2'], ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'callbacks-and-webhooks',
    surface: 'types-contracts',
    limitations: ['Generates types for incoming requests. Implement the handler in your server framework.'],
    evidenceIds: ['upstream-inbound-contracts', 'conformance-inbound-contracts'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'callbacks-and-webhooks',
    surface: 'runtime',
    limitations: ['The standalone client does not receive or dispatch callbacks and webhooks.'],
    evidenceIds: ['upstream-inbound-contracts'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'not-applicable'),
  ...recordsFor({
    capability: 'response-links',
    surface: 'metadata',
    limitations: ['Link targets and runtime expressions are emitted as metadata; application code evaluates them.'],
    evidenceIds: ['conformance-links-metadata'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'conditional-and-annotation-inference',
    surface: 'types-contracts',
    limitations: ['TypeScript types cannot express all conditional and negated constraints. Enable runtime validation to enforce them.'],
    evidenceIds: ['conformance-conditional-annotation', 'conformance-advanced-constraints'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'partial'),
  ...recordsFor({
    capability: 'remote-references',
    surface: 'runtime',
    limitations: ['HTTPS references require explicit enablement, host allowlisting, and resource limits.'],
    evidenceIds: ['conformance-remote-reference-policy', 'bounded-remote-bodies'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'opt-in'),
  ...recordsFor({
    capability: 'profile-specific-public-artifacts',
    surface: 'metadata',
    limitations: ['Generates only the modules needed by your operations, models and selected MobX/validation settings.'],
    evidenceIds: ['upstream-profile-surfaces', 'lean-output-profiles'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'model-manifest-profile-identity',
    surface: 'metadata',
    limitations: ['SDK and frontend generation must use the same MobX and validation settings.'],
    evidenceIds: ['upstream-profile-surfaces'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: 'vendored-upstream-corpus',
    surface: 'types-contracts',
    limitations: ['Published examples are checked for generation and TypeScript compilation. This does not mean every operation has been exercised against a live service.'],
    evidenceIds: ['upstream-public-generation', 'upstream-operation-cases'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: "response-status-and-media-precedence",
    surface: "runtime",
    limitations: ["Protocol selection is active in every profile; a media mismatch does not fall through to another status."],
    evidenceIds: ["response-precedence"],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: "literal-simple-headers",
    surface: "runtime",
    limitations: ["Simple headers are literal; URI decoding is not applied."],
    evidenceIds: ["literal-headers"],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'supported'),
  ...recordsFor({
    capability: "cookie-parameter-style",
    surface: "runtime",
    limitations: ["The cookie style starts on 3.2; form-style cookies retain their existing encoding."],
    evidenceIds: ["cookie-style-32"],
  }, OPENAPI_VERSIONS, ALL_PROFILES, { '3.1': 'not-applicable', '3.2': 'supported' }),
  ...recordsFor({
    capability: "prefix-items-tuples",
    surface: "types-contracts",
    limitations: ["Prefix positions and authored bounds are represented without undefined slots. Numeric length constraints beyond authored prefix positions remain runtime-only."],
    evidenceIds: ["tuple-prefixes"],
  }, OPENAPI_VERSIONS, ALL_PROFILES, { '3.1': 'partial', '3.2': 'partial' }),
  ...recordsFor({
    capability: 'discriminated-model-unions',
    surface: 'runtime',
    limitations: ['oneOf/anyOf of component models with a discriminator decode to the selected variant model and reject unknown tags. Explicit mappings (reference or component name), implicit mappings by raw component name, and several values for one variant are supported; variant models keep their declared tag type. Every variant must declare the discriminator property; generation rejects a variant that does not. A union with a variant that another union also selects has no union model class; fields typed by it still decode through its tag table. Unions without a discriminator need a required const tag on each object variant.'],
    evidenceIds: ['oas-discriminator-variants', 'oas-discriminator-required', 'oas-discriminator-declared-tag'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'partial'),
  ...recordsFor({
    capability: 'inherited-discriminator',
    surface: 'runtime',
    limitations: ['A discriminator on a base schema that subtypes extend through allOf, without a oneOf/anyOf, does not select a subtype. Generation reports a warning; declare a oneOf/anyOf union with the discriminator instead.'],
    evidenceIds: ['oas-discriminator-inheritance'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'unsupported'),
  ...recordsFor({
    capability: 'browser-cookie-parameters',
    surface: 'runtime',
    limitations: ['The client sends cookie parameters and cookie API keys as a Cookie header, which works from Node. Browsers forbid scripts from setting Cookie, so generation warns (OPENAPI_BROWSER_COOKIE); in a browser rely on a same-origin cookie instead.'],
    evidenceIds: ['transport-hardening'],
  }, OPENAPI_VERSIONS, ALL_PROFILES, 'partial'),
] as const;

export interface ComplianceMetadata {
  readonly schemaVersion: 2;
  readonly statuses: Readonly<Record<string, string>>;
  readonly profiles: Readonly<Record<GenerationProfileId, { readonly mobx: boolean; readonly validation: boolean }>>;
  readonly evidence: readonly EvidenceDeclaration[];
  readonly capabilities: readonly CapabilityRecord[];
  readonly representationBoundaries: readonly string[];
}

export function validateCapabilitySource(): void {
  const evidenceIds = new Set<string>();
  for (const evidence of EVIDENCE_DECLARATIONS) {
    if (evidenceIds.has(evidence.id)) throw new Error(`duplicate compliance evidence id: ${evidence.id}`);
    evidenceIds.add(evidence.id);
  }

  const capabilityIds = new Set<string>();
  for (const record of CAPABILITY_RECORDS) {
    if (capabilityIds.has(record.id)) throw new Error(`duplicate compliance capability id: ${record.id}`);
    capabilityIds.add(record.id);
    if (!record.title) throw new Error(`compliance capability has no readable title: ${record.id}`);
    if (!record.limitations.length) throw new Error(`compliance capability has no limitation: ${record.id}`);
    if (!record.evidenceIds.length) throw new Error(`compliance capability has no evidence: ${record.id}`);
    for (const evidenceId of record.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`compliance capability ${record.id} references undeclared evidence ${evidenceId}`);
      }
    }
  }
}

export function complianceMetadata(): ComplianceMetadata {
  validateCapabilitySource();
  return {
    schemaVersion: 2,
    statuses: STATUS_MEANINGS,
    profiles: GENERATION_PROFILES,
    evidence: EVIDENCE_DECLARATIONS,
    capabilities: CAPABILITY_RECORDS,
    representationBoundaries: REPRESENTATION_BOUNDARIES,
  };
}
