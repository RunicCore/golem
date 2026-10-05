import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compile } from '@exprtlabs/golem/validator-compiler';

import { compileSchema } from './support/compiled-validators.js';
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

const NOT_SUPPORTED = { code: 'VALIDATE_UNSUPPORTED_KEYWORD' } as const;
const NOT_RESOLVED = { code: 'VALIDATE_UNRESOLVED_REF' } as const;
const UNKNOWN_FORMAT = { code: 'VALIDATE_UNKNOWN_FORMAT', unknownFormats: 'error' } as const;

const DYNAMIC_REF = 'golem supports neither $dynamicRef nor $dynamicAnchor';
const DIALECT_META_SCHEMA = 'the dialect meta-schema uses $dynamicRef; vendored and proved in the OpenAPI document check task';
const REMOTE_DOCUMENT = 'the schema refers to a document the suite serves from localhost:1234; golem resolves no remote documents, and only the test folder is vendored';
const FORMAT_ASSERTED = 'golem checks the formats it implements, so a value that does not fit the format is invalid; the suite expects an annotation only';
const LEGACY_DEPENDENCIES = 'dependencies is a draft 7 keyword outside the 2020-12 dialect; golem implements dependentRequired and dependentSchemas';
const FORMAT_NOT_IMPLEMENTED = 'golem does not implement this format; an unknown format only warns and is not checked';

const EXCLUSIONS: readonly Exclusion[] = [
  { file: 'dynamicRef.json', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'optional/dynamicRef.json', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'unevaluatedItems.json', group: 'unevaluatedItems with $dynamicRef', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'unevaluatedProperties.json', group: 'unevaluatedProperties with $dynamicRef', reason: DYNAMIC_REF, diagnostic: NOT_SUPPORTED },
  { file: 'defs.json', group: 'validate definition against metaschema', reason: DIALECT_META_SCHEMA, diagnostic: NOT_RESOLVED },
  { file: 'ref.json', group: 'remote ref, containing refs itself', reason: DIALECT_META_SCHEMA, diagnostic: NOT_RESOLVED },
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
  { file: 'optional/cross-draft.json', reason: REMOTE_DOCUMENT, diagnostic: NOT_RESOLVED },
  { file: 'optional/dependencies-compatibility.json', reason: LEGACY_DEPENDENCIES },
  { file: 'vocabulary.json', reason: 'golem validates with the 2020-12 vocabularies and does not read the vocabularies a custom $schema meta-schema selects' },
  { file: 'optional/format/idn-email.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/idn-hostname.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/iri.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/iri-reference.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/json-pointer.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/relative-json-pointer.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/uri-template.json', reason: FORMAT_NOT_IMPLEMENTED, diagnostic: UNKNOWN_FORMAT },
  { file: 'optional/format/hostname.json', group: 'validation of A-label (punycode) host names', reason: 'every case needs IDNA (punycode) validation; golem checks the ASCII rules of RFC 1123 only' },
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

function validatorOf(group: SuiteGroup): Promise<Validator> {
  const known = compiled.get(group);
  if (known) return known;
  const created = compileSchema(group.schema);
  compiled.set(group, created);
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
