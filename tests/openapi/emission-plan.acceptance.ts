import { createFixtureProject } from '../fixture-project.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { generate } from '#openapi/generator';
import {
  ALL_GENERATION_PROFILES,
  artifactBasenames,
  compileStrictUnusedSdk,
  materializeGeneratedSdk,
  openApiFixture,
} from './helpers.js';

test('full-feature fixture compiles with noUnusedLocals for every profile', async (t) => {
  for (const profile of ALL_GENERATION_PROFILES) {
    const output = path.join(createFixtureProject(t, `runic-openapi-complex-${profile.mobx}-${profile.validation}-`), 'sdk');
    const result = await generate({
      input: openApiFixture('complex-openapi.yaml'),
      output,
      name: 'MerchantPayments',
      profile,
    });
    materializeGeneratedSdk(result.artifacts, output);
    assert.ok(artifactBasenames(result.artifacts).includes('client.ts'));
    assert.ok(artifactBasenames(result.artifacts).includes('inbound.ts'));
    compileStrictUnusedSdk(output);
  }
});
