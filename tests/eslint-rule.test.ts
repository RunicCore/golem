// lane: typescript6 ProgramSession resolution updates in the ESLint rewrite project, which reopens its program for ESLint's text
// The ESLint config of `@exprtlabs/golem/eslint` reports, at lint time, each serde call that the golem hosts cannot rewrite.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Linter } from 'eslint';

import { golem as golemEslint } from '#golem/eslint';
import { SERDE, project, write } from './support/loader-project.js';

const IMPORTS = `import { parse } from '${SERDE}';\nimport type { TMoney } from './money.model.ts';\n`;

/** The config a project with no ESLint parser for TypeScript uses: the text parser of the config is the only parser. */
async function lint(root: string, file: string, text: string) {
  return new Linter({ cwd: root }).verify(text, [await golemEslint({ cwd: root, parser: 'text' })], path.join(root, file));
}

test('the golem ESLint rule reports parse<T> used as a value at its line and column, and passes a direct call', async (t) => {
  // protects: T-396 an unrewritable serde call is reported at lint time, with the position the build reports
  const root = await project(t, 'eslint-rule');
  write(root, 'src/use.ts', IMPORTS);
  assert.deepEqual(await lint(root, 'src/use.ts', `${IMPORTS}export const money = parse<TMoney>('{}');\n`), []);
  const [reported, ...rest] = await lint(root, 'src/use.ts', `${IMPORTS}export const decode = parse<TMoney>;\n`);
  assert.equal(rest.length, 0);
  assert.equal(reported!.ruleId, 'golem/unrewritable-serde-call');
  assert.equal(reported!.severity, 2);
  assert.equal(reported!.line, 3);
  assert.equal(reported!.column, 23);
  assert.match(reported!.message, /^RUNM1079: parse<TMoney> is used as a value, which golem cannot rewrite\. Call parse<TMoney>\(\.\.\.\) directly\.$/);
});

test('the golem ESLint config sets a parser only when asked, so a typescript-eslint parser stays in use', async (t) => {
  // protects: T-396 the text parser is opt-in and never replaces the parser of the user's config
  const root = await project(t, 'eslint-rule-parser-option');
  assert.equal((await golemEslint({ cwd: root })).languageOptions, undefined);
  assert.ok((await golemEslint({ cwd: root, parser: 'text' })).languageOptions?.parser);
});

test('the golem ESLint config refuses to start without a golem.yaml', async (t) => {
  // protects: T-396 a project the rule cannot scan fails with the host's message, not with a pass
  const root = await project(t, 'eslint-rule-no-config', { generate: false });
  await assert.rejects(golemEslint({ cwd: path.join(root, 'src'), config: 'missing.yaml' }), /golem needs a golem\.yaml to rewrite parse<T>\(\) calls/);
});
