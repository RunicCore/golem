import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import type { Validator } from '@exprtlabs/golem/validation';
import { compile } from '@exprtlabs/golem/internal/validator-compiler';

import { JSON_SCHEMA_2020_12_ID, JSON_SCHEMA_2020_12_META_SCHEMAS } from '#openapi/openapi-schemas/json-schema-2020-12';

import { compileValidatorModule, compileValidators, type FastCheck } from './support/compiled-validators.js';
import { workspace } from './support/process.js';

// The official JSON-Schema-Test-Suite, draft 2020-12 (see SOURCE.md next to the files). Every case runs unless a
// row of EXCLUSIONS names it; a row says why golem gives a different answer, and a row with a `diagnostic` also
// has a test that the schema it names fails to compile with that diagnostic.

interface SuiteTest {
  readonly description: string;
  readonly data: unknown;
  readonly valid: boolean;
}

interface SuiteGroup {
  readonly description: string;
  readonly schema: unknown;
  readonly tests: readonly SuiteTest[];
}

interface Exclusion {
  /** Path inside the draft2020-12 folder. */
  readonly file: string;
  /** The group's description; without it the row covers the whole file. */
  readonly group?: string;
  /** The case's description; without `group` it covers the case in every group of the file. */
  readonly test?: string;
  readonly reason: string;
  /** The compile error of the first schema the row covers. A row without one names a difference that compiles. */
  readonly diagnostic?: { readonly code: string; readonly unknownFormats?: 'error' };
}

const INTEGER_NOT_SAFE = 'an integer beyond Number.MAX_SAFE_INTEGER is rejected: a JSON number in JavaScript has already been rounded when it is read';
const NOT_SUPPORTED = { code: 'VALIDATE_UNSUPPORTED_KEYWORD' } as const;
const NOT_RESOLVED = { code: 'VALIDATE_UNRESOLVED_REF' } as const;
const UNKNOWN_FORMAT = { code: 'VALIDATE_UNKNOWN_FORMAT', unknownFormats: 'error' } as const;

const DYNAMIC_REF = 'golem supports neither $dynamicRef nor $dynamicAnchor';
const REMOTE_DOCUMENT = 'the schema refers to a document the suite serves from localhost:1234; golem resolves no remote documents, and only the test folder is vendored';
const FORMAT_ASSERTED = 'golem checks the formats it implements, so a value that does not fit the format is invalid; the suite expects an annotation only';
const LEGACY_DEPENDENCIES = 'dependencies is a draft 7 keyword outside the 2020-12 dialect; golem implements dependentRequired and dependentSchemas';
const FORMAT_NOT_IMPLEMENTED = 'golem does not implement this format; an unknown format only warns and is not checked';

const EXCLUSIONS: readonly Exclusion[] = [
  { file: 'dynamicRef.json', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'optional/dynamicRef.json', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'unevaluatedItems.json', group: 'unevaluatedItems with $dynamicRef', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'unevaluatedProperties.json', group: 'unevaluatedProperties with $dynamicRef', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'refRemote.json', reason: REMOTE_DOCUMENT, diagnostic: NOT_RESOLVED },
  { file: 'format.json', test: 'invalid email string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid regex string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid ipv4 string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid ipv6 string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid hostname string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid date string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid date-time string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid time string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid uri string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid uri-reference string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid uuid string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid duration string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid json-pointer string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'format.json', test: 'invalid relative-json-pointer string is only an annotation by default', reason: FORMAT_ASSERTED },
  { file: 'optional/cross-draft.json', reason: REMOTE_DOCUMENT, diagnostic: NOT_RESOLVED },
  { file: 'optional/dependencies-compatibility.json', reason: LEGACY_DEPENDENCIES },
  { file: 'vocabulary.json', reason: 'golem validates with the 2020-12 vocabularies and does not read the vocabularies a custom $schema meta-schema selects' },
  { file: 'optional/format/idn-email.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/idn-hostname.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/iri.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/iri-reference.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/uri-template.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/hostname.json', group: 'validation of A-label (punycode) host names', reason: 'every case needs IDNA (punycode) validation; golem checks the ASCII rules of RFC 1123 only' },
  { file: 'optional/bignum.json', group: 'integer', test: 'a bignum is an integer', reason: INTEGER_NOT_SAFE },
  { file: 'optional/bignum.json', group: 'integer', test: 'a negative bignum is an integer', reason: INTEGER_NOT_SAFE },
  { file: 'optional/float-overflow.json', group: 'all integers are multiples of 0.5, if overflow is handled', reason: INTEGER_NOT_SAFE },
];

function jsonFiles(directory: string): string[] {
  return readdirSync(directory).sort().flatMap(name => {
    const entry = path.join(directory, name);
    if (statSync(entry).isDirectory()) return jsonFiles(entry);
    return name.endsWith('.json') ? [entry] : [];
  });
}

const suiteRoot = path.join(workspace, 'tests/fixtures/json-schema-test-suite/draft2020-12');

const suite = jsonFiles(suiteRoot).map(entry => ({
  file: path.relative(suiteRoot, entry).split(path.sep).join('/'),
  groups: JSON.parse(readFileSync(entry, 'utf8')) as readonly SuiteGroup[],
}));

function covers(row: Exclusion, file: string, group: SuiteGroup, testCase?: SuiteTest): boolean {
  return row.file === file
    && (row.group === undefined || row.group === group.description)
    && (row.test === undefined || (testCase !== undefined && row.test === testCase.description));
}

// A row that matches no group or case is stale; fail loudly at load instead of skipping silently.
for (const row of EXCLUSIONS) {
  const found = suite.some(({ file, groups }) => groups.some(group => group.tests.some(testCase => covers(row, file, group, testCase))));
  if (!found) throw new Error(`Exclusion row matches no suite case: ${JSON.stringify(row)}`);
}

const compiled = new Map<SuiteGroup, Promise<Validator>>();

// A schema that `$ref`s the dialect meta-schema gets the vendored meta-schema and its vocabularies as resources.
function usesDialectMetaSchema(group: SuiteGroup): boolean {
  return JSON.stringify(group.schema).includes(`"$ref":"${JSON_SCHEMA_2020_12_ID}"`);
}

function validatorOf(group: SuiteGroup): Promise<Validator> {
  const known = compiled.get(group);
  if (known) return known;
  const created = compileValidators({
    roots: { root: group.schema },
    ...(usesDialectMetaSchema(group) ? { resources: JSON_SCHEMA_2020_12_META_SCHEMAS } : {}),
  }).then(validators => validators.root);
  compiled.set(group, created);
  return created;
}

const compiledSanity = new Map<SuiteGroup, Promise<Validator>>();

/** The same schema compiled at the sanity level. */
function sanityValidatorOf(group: SuiteGroup): Promise<Validator> {
  const known = compiledSanity.get(group);
  if (known) return known;
  const created = compileValidators({
    roots: { root: group.schema },
    ...(usesDialectMetaSchema(group) ? { resources: JSON_SCHEMA_2020_12_META_SCHEMAS } : {}),
    level: 'sanity',
  }).then(validators => validators.root);
  compiledSanity.set(group, created);
  return created;
}

const compiledFast = new Map<SuiteGroup, Promise<FastCheck | undefined>>();

/** The root's fast check with `fastPath` on; undefined when the root has none (a validation function, an evaluation record, or no check with a fast form). */
function fastCheckOf(group: SuiteGroup): Promise<FastCheck | undefined> {
  const known = compiledFast.get(group);
  if (known) return known;
  const created = compileValidatorModule({
    roots: { root: group.schema },
    ...(usesDialectMetaSchema(group) ? { resources: JSON_SCHEMA_2020_12_META_SCHEMAS } : {}),
    fastPath: true,
  }).then(module => module.fastByRoot.root);
  compiledFast.set(group, created);
  return created;
}

for (const { file, groups } of suite) {
  for (const group of groups) {
    for (const testCase of group.tests) {
      if (EXCLUSIONS.some(row => covers(row, file, group, testCase))) continue;
      test(`${file} / ${group.description} / ${testCase.description}`, async () => {
        const validate = await validatorOf(group);
        const issues = validate(testCase.data, true);
        assert.equal(issues.length === 0, testCase.valid, `all errors: ${JSON.stringify(issues)}`);
        assert.equal(validate(testCase.data, false).length === 0, testCase.valid, 'first error only');
        // protects: R-71 sanity accepts all that full accepts: the flag on the full module and the sanity module alike
        if (testCase.valid) {
          assert.deepEqual(validate(testCase.data, true, true), [], 'full module, sanity flag');
          assert.deepEqual((await sanityValidatorOf(group))(testCase.data, true), [], 'sanity module');
        }
        // The fast check gives the same answer in both directions; a root without one takes the full route.
        const isValid = await fastCheckOf(group);
        assert.equal(isValid === undefined ? testCase.valid : isValid(testCase.data), testCase.valid, 'fast check');
      });
    }
  }
}

for (const row of EXCLUSIONS) {
  const { diagnostic } = row;
  if (diagnostic === undefined) continue;
  const group = suite
    .filter(({ file }) => file === row.file)
    .flatMap(({ groups }) => groups)
    .find(candidate => row.group === undefined || candidate.description === row.group);
  if (group === undefined) throw new Error(`Exclusion row matches no suite group: ${JSON.stringify(row)}`);
  test(`excluded ${row.file}${row.group === undefined ? '' : ` / ${row.group}`}: its first schema fails with ${diagnostic.code}`, () => {
    const result = compile({ roots: new Map([['root', group.schema]]) }, { unknownFormats: diagnostic.unknownFormats ?? 'warn' });
    assert.equal(result.source, '');
    assert.ok(
      result.diagnostics.some(entry => entry.code === diagnostic.code && entry.severity === GolemDiagnosticSeverity.Error),
      `diagnostics: ${JSON.stringify(result.diagnostics)}`,
    );
  });
}
