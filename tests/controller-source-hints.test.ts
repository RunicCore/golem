import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { command, golem } from './support/process.js';

const yaml = 'version: 1\nts-openapi:\n  docs:\n    - output: ./generated/openapi.json\n      info:\n        title: Catalog API\n        version: "1"\n';

async function generateStderr(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = createControllerFixture(t, { prefix: 'golem-controller-hints-', packageName: 'controller-hints', links: 'workspace', files: { 'golem.yaml': yaml, ...files } });
  const result = await command(root, process.execPath, [golem, 'generate'], { allowFailure: true });
  assert.notEqual(result.code, 0);
  return result.stderr;
}

// protects: T-325 NEST1002 tells a golem.yaml user to set sources of the controller job
test('NEST1002 tells a golem.yaml user to list the controller files in sources of the controller job', async (t: TestContext) => {
  const stderr = await generateStderr(t, { 'src/readme.ts': 'export {};\n' });
  assert.match(stderr, /NEST1002: .*sources` of the controller job/);
  assert.doesNotMatch(stderr, /context\./);
});

// protects: T-325 NEST1001 tells a golem.yaml user to set sources of the controller job
test('NEST1001 tells a golem.yaml user to list the files that declare the controller in sources of the controller job', async (t: TestContext) => {
  const stderr = await generateStderr(t, { 'src/catalog.controller.ts': 'export class Catalog {}\n' });
  assert.match(stderr, /NEST1001: .*sources` of the controller job/);
  assert.doesNotMatch(stderr, /context\./);
});
