// lane: typescript6 TypeChecker.typeToString and createScanner of the classic API: it prints a union in the order in which the checker met its members, and golem names from the sorted text
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildModelProject, createModelProject, writeModelGolemYaml, writeModelSources } from './model-project.js';

const HEAD = "import type { IModel } from '@exprtlabs/golem/model';\n";

/** The names that the generated files give a `<name>Fields` type, for one project. */
async function projectionNames(t: TestContext, sources: Record<string, string>): Promise<string[]> {
  const { root, sourceRoot } = createModelProject(t, { prefix: 'golem-recursive-names-', name: 'recursive-names' });
  writeModelSources(sourceRoot, sources);
  writeModelGolemYaml(root, { mobx: false, validation: true });
  const built = await buildModelProject(root);
  assert.equal(built.code, 0, `${built.stdout}${built.stderr}`);
  const generated = Object.keys(sources).map(file => fs.readFileSync(path.join(sourceRoot, file.replace(/\.ts$/, '.generated.ts')), 'utf8')).join('\n');
  return [...new Set([...generated.matchAll(/\b(\w+)Fields\b/g)].map(match => match[1]!))].sort();
}

test('a generic instance named by a literal union argument gets one name whichever way TypeScript orders the union', async (t: TestContext) => {
  // protects: T-512 F-37 the same files on both TypeScript lines: Page<'east' | 'west'> is PageEastWest whichever literal the checker meets first, also when the union sits inside another type
  const sources = (union: string, nested: string): Record<string, string> => ({
    'a.model.ts': `${HEAD}export interface Page<T> { items: T[]; next?: Page<T> }\nexport type TA = IModel<{ p: Page<number> }>;\n`,
    'z.model.ts': `${HEAD}export interface Page<T> { rows: T[]; next?: Page<T> }\nexport type TZ = IModel<{ p: Page<${union}>; q: Page<Record<${nested}, number>> }>;\n`,
  });
  const forward = await projectionNames(t, sources("'east' | 'west'", "'north' | 'south'"));
  const reversed = await projectionNames(t, sources("'west' | 'east'", "'south' | 'north'"));
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward, ['Page', 'PageEastWest', 'PageRecordNorthSouthNumber', 'PageRecordNorthSouthNumberRows', 'TA', 'TZ']);
});

test('variants of a union that no authored member names are numbered the same whichever way TypeScript orders a union inside them', async (t: TestContext) => {
  // protects: T-512 F-37 the number of an unmatched union variant follows its text, which holds a literal union: it must not follow the order in which the checker met the literals
  const sources = (first: string): Record<string, string> => ({
    'v.model.ts': `${HEAD}type U = { tag: ${first}; ok: true; next?: U } | { tag: 'a' | 'c'; ok: false; next?: U };\ninterface Shapes { v: U }\nexport type TV = IModel<{ v: Shapes['v'] }>;\n`,
  });
  const forward = await projectionNames(t, sources("'a' | 'b'"));
  const reversed = await projectionNames(t, sources("'b' | 'a'"));
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward, ['TV', 'TVV1', 'TVV1Next2']);
});
