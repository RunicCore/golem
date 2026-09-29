import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_RECORDS,
  complianceMetadata,
  EVIDENCE_DECLARATIONS,
  OPENAPI_VERSIONS,
  PROFILE_IDS,
  validateCapabilitySource,
} from '../../packages/openapi-to-ts/compliance/capabilities.js';
import { renderComplianceMatrix } from '../../packages/openapi-to-ts/compliance/generate-matrix.js';
import { assertCaseTableIntegrity, INBOUND_CONTRACT_CASES, UPSTREAM_OPERATION_CASES } from './compliance-cases.js';
import { repoRoot } from './helpers.js';
import { buildSupportProjection, consumerCapabilityRecords } from '../../scripts/support-projection.js';

test('typed compliance records and evidence links are unique and complete', () => {
  validateCapabilitySource();
  assertCaseTableIntegrity();
  const evidenceIds = new Set(EVIDENCE_DECLARATIONS.map((evidence) => evidence.id));
  assert.equal(evidenceIds.size, EVIDENCE_DECLARATIONS.length);
  for (const evidence of EVIDENCE_DECLARATIONS) {
    assert.ok(evidence.file);
    assert.ok(evidence.testName);
    assert.ok(evidence.layers.length, `${evidence.id} must identify the verification boundary`);
    const evidenceSource = readFileSync(path.join(repoRoot(), evidence.file), 'utf8');
    assert.ok(
      [
        `test('${evidence.testName}'`,
        `test("${evidence.testName}"`,
        `test(\`${evidence.testName}\``,
      ].some((marker) => evidenceSource.includes(marker)),
      `${evidence.id} test ID is not declared by ${evidence.file}`,
    );
  }

  const recordIds = new Set<string>();
  for (const record of CAPABILITY_RECORDS) {
    assert.equal(recordIds.has(record.id), false, `duplicate capability record ${record.id}`);
    recordIds.add(record.id);
    assert.ok(OPENAPI_VERSIONS.includes(record.version));
    assert.ok(PROFILE_IDS.includes(record.profile));
    assert.ok(record.surface === 'runtime' || record.surface === 'types-contracts' || record.surface === 'metadata');
    assert.ok(record.limitations.length, `${record.id} limitation`);
    assert.ok(record.evidenceIds.length, `${record.id} evidence`);
    for (const evidenceId of record.evidenceIds) assert.ok(evidenceIds.has(evidenceId), `${record.id}: ${evidenceId}`);
    assert.match(record.id, new RegExp(`\\.${record.version.replace('.', '\\.') }\\.${record.profile}\\.${record.surface}$`));
  }

  const caseEvidenceIds = new Set([
    ...UPSTREAM_OPERATION_CASES.flatMap((item) => item.evidenceIds),
    ...INBOUND_CONTRACT_CASES.flatMap((item) => item.evidenceIds),
  ]);
  for (const evidenceId of caseEvidenceIds) assert.ok(evidenceIds.has(evidenceId), evidenceId);

  const metadata = complianceMetadata();
  const consumerRecords = consumerCapabilityRecords(metadata);
  const projection = buildSupportProjection(metadata);
  assert.doesNotMatch(JSON.stringify(projection), /"layers"|"testName"|"evidence"/);
  const corpusCount = CAPABILITY_RECORDS.filter((record) => record.capability === 'vendored-upstream-corpus').length;
  assert.ok(corpusCount > 0);
  assert.equal(consumerRecords.length, CAPABILITY_RECORDS.length - corpusCount);
  assert.equal(projection.capabilities.length, consumerRecords.length);
  assert.equal(projection.capabilities.some((record) => record.title === 'Published OpenAPI examples'), false);
});

test('standalone OpenAPI compliance matrix and distributable metadata match the typed source', () => {
  const script = path.join(repoRoot(), '.build/packages/openapi-to-ts/compliance/generate-matrix.js');
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const metadataFilename = path.join(repoRoot(), 'packages/openapi-to-ts/compliance/capabilities.json');
  const metadata: unknown = JSON.parse(readFileSync(metadataFilename, 'utf8'));
  assert.ok(typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata));
  if (typeof metadata === 'object' && metadata !== null) {
    const records = Reflect.get(metadata, 'capabilities');
    assert.ok(Array.isArray(records));
    assert.ok(records.every((record) => typeof record === 'object' && record !== null && !Array.isArray(record)));
  }
  assert.equal(existsSync(path.join(repoRoot(), 'packages/openapi-to-ts/capabilities.json')), false);

  const matrix = renderComplianceMatrix();
  assert.match(matrix, /\| Feature \| Version \| Surface \| MobX \| Validation \| Status \| Limitations \|/);
  assert.doesNotMatch(matrix, /\| Capability \|/);
  assert.doesNotMatch(matrix, /vendored-upstream-corpus|Published OpenAPI examples|checked for generation|TypeScript compilation|live service/);
  const rows = matrix.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Feature |'));
  const consumerRecords = consumerCapabilityRecords(complianceMetadata());
  assert.equal(rows.length, consumerRecords.length);
});
