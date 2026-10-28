import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';

import type { GolemProfile } from '@exprtlabs/golem/generator-api';

import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources, type ModelProject } from '../model-project.js';

export type Codec = (value: unknown, options?: object) => unknown;
export type Codecs = Record<string, Codec>;

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

/** The generated codec module `build/<name>.model.generated.js` of a built project. */
export async function importCodecs(root: string, name: string): Promise<Codecs> {
  return await import(pathToFileURL(path.join(root, `build/${name}.model.generated.js`)).href) as Codecs;
}
