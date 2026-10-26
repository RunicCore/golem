import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { fixturePath, type FixtureScope } from '../fixture-project.js';
import { buildModelProject, createModelProject, writeModelGolemYaml, type ModelProject } from '../model-project.js';
import type { CommandResult } from './process.js';

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

/** One project for several claims of one profile: each fixture in its own folder below src, with its own copy of wire-assert.ts. */
export function wireClaimsProject(scope: FixtureScope, fixtures: readonly string[], mobx: boolean): ModelProject {
  const project = createModelProject(scope, {
    prefix: 'golem-wire-format-',
    name: 'wire-format',
    linkWorkspaceNodeModules: true,
    compilerOptions: { noEmit: true },
  });
  for (const fixture of fixtures) {
    const folder = path.join(project.sourceRoot, fixture);
    fs.cpSync(fixturePath(`wire-format/${fixture}`), folder, { recursive: true });
    fs.copyFileSync(fixturePath('wire-format/wire-assert.ts'), path.join(folder, 'wire-assert.ts'));
  }
  writeModelGolemYaml(project.root, { mobx, validation: true });
  return project;
}

/** Builds a project of several claims once; each claim then reads the compiler errors of its own folder. */
export function buildWireClaims(root: string): Promise<CommandResult> {
  return buildModelProject(root, [], { allowFailure: true });
}

const COMPILER_ERROR = /^src\/[^(]+\(\d+,\d+\): error TS\d+/;

/** The claim of `fixture` holds when the shared build reports no compiler error in its folder; a build that fails without one fails every claim. */
export function assertWireClaimHolds(result: CommandResult, fixture: string): void {
  if (result.code === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  const errors = output.split('\n').map(line => line.trim()).filter(line => COMPILER_ERROR.test(line));
  assert.notEqual(errors.length, 0, `the shared build failed without a compiler error:\n${output}`);
  assert.deepEqual(errors.filter(line => line.startsWith(`src/${fixture}/`)), [], output);
}
