import type { TestContext } from 'node:test';

import type { GolemProfile } from '@exprtlabs/golem/generator-api';

import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources, type ModelProject } from '../model-project.js';
import { loadFunctions } from '../openapi/helpers.js';

/** Compare wire values as JSON data; prototype and absent-field details belong to the wire-format suite. */
export const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** A project that holds `sources` and has been built under `profile`. */
export async function buildRecursiveProject(
  t: TestContext,
  prefix: string,
  sources: Readonly<Record<string, string>>,
  profile: GolemProfile,
): Promise<ModelProject> {
  const project = createModelProject(t, { prefix, linkTypescript: true });
  writeModelSources(project.sourceRoot, sources);
  writeModelGolemYaml(project.root, profile);
  await buildModelProject(project.root);
  return project;
}

/** `wire(model, value)`: `value` through `fromWireFormat<model>` and `toWireFormat<model>` of the built codec file `file`, as JSON data. `models` names every model that the test passes to `wire`. */
export async function loadWireRoundTrip(file: string, models: readonly string[]): Promise<(model: string, value: unknown) => unknown> {
  const codecs = await loadFunctions(file, models.flatMap((model) => [`fromWireFormat${model}`, `toWireFormat${model}`]));
  return (model, value) => json(codecs[`toWireFormat${model}`](codecs[`fromWireFormat${model}`](value)));
}
