// lane: typescript6 ProgramSession.transpileModule: the loader compiles what Node's type stripping cannot load
// The Node loader compiles a `.tsx` file with the project's TypeScript, after it rewrites the calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SERDE, frameLine, lineOf, project, run, write } from './support/loader-project.js';
import { workspace } from './support/process.js';

const PARSE_MONEY = `const money = parse<TMoney>('{"currency":"USD","value":"1"}');`;
const H = 'export const h = (tag: string, props: object | null, ...children: unknown[]): object => ({ tag, props, children });';

/** A `.tsx` view that builds its element with the project's own `h`, so the output shows which factory the tsconfig named. */
const VIEW = `import { parse } from '${SERDE}';
import type { TMoney } from './money.model.ts';
import './money.model.ts';

${H}
${PARSE_MONEY}
const trace = new Error('where am I').stack;
console.log(JSON.stringify(<b title={money.currency}>{money.value}</b>));
console.log(trace);
`;

const JSX_PROJECT = { compilerOptions: { jsx: 'react', jsxFactory: 'h' }, include: ['src/**/*.ts', 'src/**/*.tsx'] } as const;

test('a .tsx file runs rewritten, its JSX follows the tsconfig, and a stack frame names its original line', async (t) => {
  // protects: T-380 the Node loader loads .tsx files
  const root = await project(t, 'loader-tsx', JSX_PROJECT);
  write(root, 'src/view.tsx', VIEW);
  const result = await run(root, 'src/view.tsx');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split('\n')[0]!), { tag: 'b', props: { title: 'USD' }, children: ['1'] });
  assert.equal(frameLine(result.stdout, path.join(root, 'src/view.tsx')), lineOf(VIEW, 'const trace'), result.stdout);
});

test('a relative .js import names the .tsx source that has no built file', async (t) => {
  // protects: T-380 a .tsx module is imported the way TypeScript names it
  const root = await project(t, 'loader-tsx-import', JSX_PROJECT);
  write(root, 'src/badge.tsx', `${H}\nexport const badge = <i>{'ok'}</i>;\n`);
  write(root, 'src/main.ts', "import { badge } from './badge.js';\nconsole.log(JSON.stringify(badge));\n");
  const result = await run(root, 'src/main.ts');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { tag: 'i', props: null, children: ['ok'] });
});

test('a .tsx file in a project with no jsx option fails the run with the file and the option to set', async (t) => {
  // protects: T-380 a .tsx file with no jsx option stops with a golem error, not a Node syntax error
  const root = await project(t, 'loader-tsx-no-jsx', { include: JSX_PROJECT.include });
  write(root, 'src/view.tsx', VIEW);
  const result = await run(root, 'src/view.tsx');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /GolemHostError: golem cannot compile .*view\.tsx: set compilerOptions\.jsx in .*tsconfig\.json/, result.stderr);
});
