import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { fixturePath } from '../fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, type ModelProject } from '../model-project.js';

export interface WireClaim {
  readonly claim: string;
  /** The directory under tests/fixtures/wire-format: its sources and its `*.wire-check.ts`, which state the claim as type assertions. */
  readonly fixture: string;
}

/** A project of its own for one claim: the fixture's check files fail the build when WireFormat<T> differs from the emitted JSON type. */
export function wireClaimProject(t: TestContext, fixture: string, mobx: boolean): ModelProject {
  const project = createModelProject(t, {
    prefix: 'golem-wire-format-',
    name: 'wire-format',
    linkWorkspaceNodeModules: true,
    compilerOptions: { noEmit: true },
  });
  fs.cpSync(fixturePath(`wire-format/${fixture}`), project.sourceRoot, { recursive: true });
  fs.copyFileSync(fixturePath('wire-format/wire-assert.ts'), path.join(project.sourceRoot, 'wire-assert.ts'));
  writeModelGolemYaml(project.root, { mobx, validation: true });
  return project;
}

export async function assertWireClaimBuilds(root: string): Promise<void> {
  const result = await buildModelProject(root, [], { allowFailure: true });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}
