import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadValidatedDocument } from '#openapi/generator';
import {
  ALL_GENERATION_PROFILES,
  artifactBasenames,
  compileStrictUnusedSdk,
  generateMaterializedSdk,
  openApiFixture,
} from './helpers.js';

test('full-feature fixture compiles with noUnusedLocals for every profile', async (t) => {
  const document = await loadValidatedDocument(openApiFixture('complex-openapi.yaml'), {});
  for (const profile of ALL_GENERATION_PROFILES) {
    const output = path.join(createFixtureProject(t, `golem-openapi-complex-${profile.mobx}-${profile.validation}-`), 'sdk');
    // MobX needs the golem mode: the helper generates that SDK and runs the models job for its codecs.
    const result = await generateMaterializedSdk(document, { output, name: 'MerchantPayments', profile });
    assert.ok(artifactBasenames(result.artifacts).includes('client.ts'));
    compileStrictUnusedSdk(output);
  }
});
