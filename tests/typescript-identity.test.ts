import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createFixtureProject, readFixture } from './fixture-project.js';
import { createControllerFixture } from './fixture-templates/controllers/project.js';
import { createModelProject } from './model-project.js';
import type { IdentityCase } from './support/identity-generate.js';
import { command, workspace } from './support/process.js';

const typescript6Root = process.env.GOLEM_TYPESCRIPT6_ROOT;
const skip = !typescript6Root && 'GOLEM_TYPESCRIPT6_ROOT is not set; run this in the test container, where the entrypoint installs TypeScript 6';

function modelProject(t: TestContext, name: string, fixtureDirectory: string, sources: readonly string[]): IdentityCase {
  const { root, sourceRoot } = createModelProject(t, { prefix: `golem-identity-${name}-`, name: `identity-${name}` });
  for (const source of sources) {
    fs.writeFileSync(path.join(sourceRoot, source), readFixture(`${fixtureDirectory}/${source}`));
  }
  return { name, kind: 'model', root };
}

function controllerProject(t: TestContext): IdentityCase {
  const root = createControllerFixture(t, {
    prefix: 'golem-identity-controller-',
    source: readFixture('controllers/controller/generates-a-static-nest-document-with-evaluated-routes-inheritance-uri-version/controller.ts'),
  });
  return { name: 'controller', kind: 'controller', root };
}

/** Generates every case in a child process and returns the artifact files it wrote, keyed by path relative to the output directory. */
async function generateArtifacts(t: TestContext, cases: readonly IdentityCase[], typescriptRoot: string | undefined): Promise<ReadonlyMap<string, string>> {
  const scratch = createFixtureProject(t, 'golem-identity-out-');
  const casesFile = path.join(scratch, 'cases.json');
  const outputDirectory = path.join(scratch, 'artifacts');
  fs.writeFileSync(casesFile, JSON.stringify(cases));
  // An explicit undefined removes GOLEM_TYPESCRIPT_ROOT even when this process runs in the TypeScript 6 lane.
  await command(workspace, process.execPath, [path.join(workspace, '.build/tests/support/identity-generate.js'), casesFile, outputDirectory], {
    env: { GOLEM_TYPESCRIPT_ROOT: typescriptRoot },
    timeout: 60_000,
  });
  const artifacts = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else artifacts.set(path.relative(outputDirectory, filename), fs.readFileSync(filename, 'latin1'));
    }
  };
  visit(outputDirectory);
  return new Map([...artifacts].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

test('TypeScript 6 and 7 generate byte-identical artifacts', { skip }, async t => {
  const cases = [
    // Each union-order model is generated alone, so the two programs create their literal types in different orders.
    modelProject(t, 'union-order-a', 'models/union-order', ['a.model.ts']),
    modelProject(t, 'union-order-b', 'models/union-order', ['b.model.ts']),
    modelProject(t, 'generic-default', 'models/identity/generic-default', ['codecs.ts', 'blob.model.ts']),
    modelProject(t, 'intersection', 'models/identity/intersection', ['parts.model.ts']),
    controllerProject(t),
  ];
  const seven = await generateArtifacts(t, cases, undefined);
  const six = await generateArtifacts(t, cases, typescript6Root);

  for (const item of cases) {
    assert.ok([...seven.keys()].some(artifact => artifact.startsWith(`${item.name}${path.sep}`)), `${item.name} must generate at least one artifact`);
  }
  assert.deepEqual([...six.keys()], [...seven.keys()], 'both versions write the same artifact paths');
  for (const [artifact, content] of seven) assert.equal(six.get(artifact), content, `${artifact} differs between TypeScript 6 and 7`);
});
