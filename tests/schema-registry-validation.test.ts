import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibError } from '@exprtlabs/codegen/errors';
import { createRegistryOperationValidators, createRegistryValidators, type RuntimeValidationEngine, type RuntimeValidator } from '@exprtlabs/codegen/validation';

function recordingEngine(missing: ReadonlySet<string> = new Set()): RuntimeValidationEngine & { added: string[] } {
  const added: string[] = [];
  const schemas = new Map<string, RuntimeValidator>();
  return {
    added,
    addSchema(_schema, id) { added.push(id); schemas.set(id, Object.assign(() => true, { errors: null })); },
    getSchema(reference) {
      if (missing.has(reference)) return undefined;
      // A registered resource is found by id; a fragment reference compiles on demand.
      return schemas.get(reference) ?? (reference.includes('#') ? Object.assign(() => true, { errors: null }) : undefined);
    },
  };
}

const data = {
  schemaRegistry: { $id: 'urn:t:schemas' },
  runtimeSchemaRegistry: { $defs: { money: { $id: 'urn:t:schemas:money' }, bad: [1] } },
  schemaNames: ['Money'] as const,
  operationNames: ['getMoney'] as const,
  operationResponseSchemaEntries: [['getMoney', '200', 'application/json']] as const,
  schemaReference: (name: 'Money') => `urn:t:schemas#/$defs/${name}`,
  operationInputReference: (name: 'getMoney') => `urn:t:schemas#/operations/${name}/input`,
  operationResponseReference: (name: 'getMoney', status: string, type: string) => `urn:t:schemas#/operations/${name}/${status}/${type}`,
};

test('registry validators register the registry and each resource once, then compile every schema', () => {
  const engine = recordingEngine();
  const validators = createRegistryValidators(engine, data);
  assert.deepEqual([...validators.keys()], ['Money']);
  createRegistryValidators(engine, data);
  assert.deepEqual(engine.added, ['urn:t:schemas', 'urn:t:schemas:money']);
});

test('operation validators key responses by status and media type', () => {
  const validators = createRegistryOperationValidators(recordingEngine(), data);
  assert.deepEqual([...validators.get('getMoney')!.responses.keys()], ['200:application/json']);
});

test('a schema the engine cannot compile fails with validation_unavailable', () => {
  assert.throws(() => createRegistryValidators(recordingEngine(new Set(['urn:t:schemas#/$defs/Money'])), data),
    (error: unknown) => error instanceof LibError && error.kind === 'validation_unavailable' && /Money/.test(error.message));
});
