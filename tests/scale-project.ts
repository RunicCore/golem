import { copyFixtureFile, writeGeneratedArtifacts } from './fixture-project.js';
import { scaleModelSource } from './fixture-templates/models/scale.js';
import { generate } from '#model/generator';
import { command } from './support/process.js';
import { compileModelProject, createModelProject, writeModelSources } from './model-project.js';
import type { TestContext } from 'node:test';

/** Write `count` scale models into a standalone-validation project and generate their companions. */
export function generateScaleProject(t: TestContext, count: number): { readonly root: string; readonly result: ReturnType<typeof generate> } {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: `runic-companions-${count}-`,
    name: null,
    allowJs: true,
    linkWorkspaceNodeModules: true,
  });
  const sources: Record<string, ReturnType<typeof scaleModelSource>> = {};
  for (let index = 0; index < count; index++) sources[`item-${index}.model.ts`] = scaleModelSource({ index });
  writeModelSources(sourceRoot, sources);
  return { root, result: generate({ root, profile: { mobx: false, validation: true, ajvStandalone: true } }) };
}

/** Compile the generated companions and execute every model, which catches invalid shared bindings. */
export async function compileAndVerifyScaleProject(root: string, result: ReturnType<typeof generate>, count: number): Promise<void> {
  writeGeneratedArtifacts(result.artifacts);
  await compileModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-generation-scale/verify.mjs', 'verify.mjs');
  await command(root, process.execPath, [verifier, String(count)]);
}
