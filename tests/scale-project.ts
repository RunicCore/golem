import { copyFixtureFile } from './fixture-project.js';
import { scaleModelSource } from './fixture-templates/models/scale.js';
import { command } from './support/process.js';
import { buildModelProject, createModelProject, generatedModelFiles, writeModelGolemYaml, writeModelSources } from './model-project.js';
import type { TestContext } from 'node:test';

/** The generation profile of every scale project. */
export const SCALE_PROFILE = { mobx: false, validation: true } as const;

/** Write `count` scale models into the source folder of a model project. */
export function writeScaleModels(sourceRoot: string, count: number): void {
  const sources: Record<string, ReturnType<typeof scaleModelSource>> = {};
  for (let index = 0; index < count; index++) sources[`item-${index}.model.ts`] = scaleModelSource({ index });
  writeModelSources(sourceRoot, sources);
}

/** Write `count` scale models into a validating project whose golem.yaml names the scale profile. */
export function createScaleProject(t: TestContext, count: number): { readonly root: string } {
  const { root, sourceRoot } = createModelProject(t, {
    prefix: `golem-companions-${count}-`,
    name: null,
    allowJs: true,
    linkWorkspaceNodeModules: true,
  });
  writeScaleModels(sourceRoot, count);
  writeModelGolemYaml(root, SCALE_PROFILE);
  return { root };
}

/** Build the project, whose models job generates the companions once, and execute every model, which catches invalid shared bindings. Returns the generated files. */
export async function compileAndVerifyScaleProject(root: string, count: number): Promise<ReturnType<typeof generatedModelFiles>> {
  await buildModelProject(root);
  const verifier = copyFixtureFile(root, 'models/model-generation-scale/verify.mjs', 'verify.mjs');
  await command(root, process.execPath, [verifier, String(count)]);
  return generatedModelFiles(root);
}
