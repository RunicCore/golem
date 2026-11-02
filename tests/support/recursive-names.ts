import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from '../model-project.js';

/** Builds a project of `sources`, which must build, and returns its root and the names that the generated files give a `<name>Fields` type, sorted. */
export async function buildRecursiveNames(t: TestContext, sources: Record<string, string>, suffixes?: readonly string[]): Promise<{ readonly root: string; readonly names: string[] }> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-names-', name: 'recursive-names' });
  writeModelSources(sourceRoot, sources);
  writeModelGolemYaml(root, { validation: true });
  if (suffixes) fs.writeFileSync(path.join(root, 'golem.yaml'), `version: 1\nvalidation: true\nmodel:\n  suffixes: ${JSON.stringify(suffixes)}\n`);
  const built = await buildModelProject(root);
  assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
  const generated = Object.keys(sources).map(file => fs.readFileSync(path.join(sourceRoot, file.replace(/\.ts$/, '.generated.ts')), 'utf8')).join('\n');
  return { root, names: [...new Set([...generated.matchAll(/\btype (\w+)Fields\b/g)].map(match => match[1]!))].sort() };
}
