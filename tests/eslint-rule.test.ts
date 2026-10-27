// lane: typescript6 ProgramSession resolution updates in the ESLint rewrite project, which reopens its program for ESLint's text
// The ESLint config of `@exprtlabs/golem/eslint` reports, at lint time, each serde call that the golem hosts cannot rewrite.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Linter } from 'eslint';

import { runPipeline } from '#golem/cli';
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
  assert.equal(reported!.ruleId, 'golem/no-unrewritable-code');
  assert.equal(reported!.severity, 2);
  assert.equal(reported!.line, 3);
  assert.equal(reported!.column, 23);
  assert.match(reported!.message, /^RUNM1079: parse<TMoney> is used as a value, which golem cannot rewrite\. Call parse<TMoney>\(\.\.\.\) directly\.$/);
});

const DISABLE = '// eslint-disable-next-line golem/no-unrewritable-code';
const DECODE = 'export const decode = parse<TMoney>;';

test('an eslint-disable comment suppresses the report under the text parser, and the same words in a template do not', async (t) => {
  // protects: T-396 the text parser returns the real comments, so ESLint directives work
  const root = await project(t, 'eslint-rule-directives');
  write(root, 'src/use.ts', IMPORTS);
  assert.deepEqual(await lint(root, 'src/use.ts', `${IMPORTS}${DISABLE}\n${DECODE}\n`), []);
  assert.deepEqual(await lint(root, 'src/use.ts', `/* eslint-disable */\n${IMPORTS}${DECODE}\n`), []);
  const quoted = await lint(root, 'src/use.ts', `${IMPORTS}export const note = \`${DISABLE}\`;\n${DECODE}\n`);
  assert.deepEqual(quoted.map((message) => [message.ruleId, message.line]), [['golem/no-unrewritable-code', 4]]);
});

test('a report in a file with CRLF line breaks and a multi-line comment lands on its own line', async (t) => {
  // protects: T-396 lines and columns of reports and of comments follow ESLint's own count
  const root = await project(t, 'eslint-rule-crlf');
  write(root, 'src/use.ts', IMPORTS);
  const head = `${IMPORTS}/* a comment\nthat spans lines */\n`;
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  const [reported, ...rest] = await lint(root, 'src/use.ts', crlf(`${head}${DECODE}\n`));
  assert.equal(rest.length, 0);
  assert.deepEqual([reported!.line, reported!.column], [5, 23]);
  assert.deepEqual(await lint(root, 'src/use.ts', crlf(`${head}${DISABLE}\n${DECODE}\n`)), []);
});

test('the golem ESLint rule follows golem generate in a session that lints the same file again', async (t) => {
  // protects: T-396 a long ESLint session reads the generated files that golem generate wrote after it opened the program
  const root = await project(t, 'eslint-rule-regenerate', { generate: false });
  const text = `${IMPORTS}export const money = parse<TMoney>('{}');\n`;
  write(root, 'src/use.ts', text);
  const config = await golemEslint({ cwd: root, parser: 'text' });
  const linter = new Linter({ cwd: root });
  const file = path.join(root, 'src/use.ts');
  const before = linter.verify(text, [config], file);
  assert.deepEqual(before.map((message) => message.message.slice(0, 7)), ['RUNM106'], 'the model is not generated yet');
  await runPipeline(path.join(root, 'golem.yaml'));
  assert.deepEqual(linter.verify(text, [config], file), []);
});

test('the golem ESLint config sets a parser only when asked, so a typescript-eslint parser stays in use', async (t) => {
  // protects: T-396 the text parser is opt-in and never replaces the parser of the user's config
  const root = await project(t, 'eslint-rule-parser-option');
  write(root, 'src/use.ts', IMPORTS);
  const sample = `${IMPORTS}${DECODE}\n`;
  const file = path.join(root, 'src/use.ts');
  assert.equal((await golemEslint({ cwd: root })).languageOptions, undefined);
  // Without the option the user's parser decides: the default one cannot read this TypeScript, so the rule never sees it.
  assert.deepEqual(new Linter({ cwd: root }).verify(sample, [await golemEslint({ cwd: root })], file).map((message) => [message.ruleId, message.fatal]), [[null, true]]);
  assert.deepEqual((await lint(root, 'src/use.ts', sample)).map((message) => message.ruleId), ['golem/no-unrewritable-code']);
});

test('the golem ESLint config refuses to start without a golem.yaml', async (t) => {
  // protects: T-396 a project the rule cannot scan fails with the host's message, not with a pass
  const root = await project(t, 'eslint-rule-no-config', { generate: false });
  await assert.rejects(golemEslint({ cwd: path.join(root, 'src'), config: 'missing.yaml' }), /golem needs a golem\.yaml to rewrite parse<T>\(\) calls/);
});
