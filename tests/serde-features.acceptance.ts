import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { copyFixture } from './fixture-project.js';
import { buildModelProject, createModelProject } from './model-project.js';
import { command, workspace } from './support/process.js';

// protects: request R-34 acceptance runs golem's own feature claims, never the benchmark scripts
// The consumer app (tests/fixtures/models/serde-features/src/cases.ts) is built with golem and run in its own process, once for each
// profile, because its codecs live in a process-wide registry. It throws on the first claim that fails: every case decodes from an
// object and from text, encodes back to the same wire, writes the same compact text, copies containers, leaves its input alone, and
// (validating) validates; the SDK-extending model rejects what its tags forbid; a draft with a bad value fails validation or keeps it.
const CASES = ['reuse', 'nested-10', 'nested-200', 'compose', 'tagged', 'combined', 'sdk-extend'];

for (const mode of ['conversion-only', 'validating'] as const) {
  test(`golem feature models convert, round-trip and validate as declared in ${mode} mode`, async (t) => {
    const { root } = createModelProject(t, {
      prefix: 'golem-serde-features-',
      linkWorkspaceNodeModules: true,
      // The workspace node_modules holds the package; the project lists it so the `openapi-ts` block finds it.
      packages: { '@exprtlabs/golem-openapi-ts': path.join(workspace, 'packages/golem-openapi-ts') },
      compilerOptions: { types: ['node'] },
    });
    copyFixture(root, 'models/serde-features');
    fs.writeFileSync(path.join(root, 'golem.yaml'), [
      'version: 1', `validation: ${mode === 'validating'}`,
      'openapi-ts:', '  sdks:', '    - input: money.yaml', '      output: src/sdk', '      name: Payments', '      mode: golem',
      'model: {}', '',
    ].join('\n'));
    await buildModelProject(root);
    const run = await command(root, process.execPath, [path.join(root, 'build/cases.js'), mode]);
    assert.deepEqual(JSON.parse(run.stdout), CASES);
  });
}
