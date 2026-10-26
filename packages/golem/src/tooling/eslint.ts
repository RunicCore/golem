import type { Linter, Rule } from 'eslint';

import { openRewriteProject, type GolemHostOptions, type RewriteProject } from './rewrite-host.js';

export type { GolemHostOptions };

/** `cwd` is where `golem.yaml` is looked for when `config` and `GOLEM_CONFIG` name none. Default: the current directory. */
export interface GolemEslintOptions extends GolemHostOptions {
  readonly cwd?: string;
}

/** The rule that reports each serde call the golem hosts cannot rewrite: the errors of `golem check`, one scan path. */
function unrewritableSerdeCall(project: RewriteProject): Rule.RuleModule {
  return {
    meta: {
      type: 'problem',
      docs: { description: 'Report a stringify, parse, validate, assertValue, toWireFormat or fromWireFormat call that golem cannot rewrite, so it would throw when it runs.' },
      schema: [],
      messages: { unrewritable: '{{ code }}: {{ text }}' },
    },
    create(context) {
      return {
        Program() {
          for (const { code, message, line, column } of project.diagnose(context.filename, context.sourceCode.text)) {
            // The scanner counts columns from 1, ESLint from 0.
            context.report({ loc: { line: line ?? 1, column: (column ?? 1) - 1 }, messageId: 'unrewritable', data: { code, text: message } });
          }
        },
      };
    },
  };
}

/**
 * An ESLint flat-config object that turns on `golem/unrewritable-serde-call` for the TypeScript files, against the
 * golem.yaml named by `config`, `GOLEM_CONFIG` or `./golem.yaml` in `cwd`. The scan is the one the hosts run, with the
 * project's own TypeScript; the file's text is the text ESLint holds. The config needs a parser that reads TypeScript,
 * which another config object sets.
 */
export async function golem(options: GolemEslintOptions = {}): Promise<Linter.Config> {
  const { cwd = process.cwd(), ...host } = options;
  const project = await openRewriteProject({ cwd, ...host });
  return {
    name: 'golem',
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'],
    plugins: { golem: { rules: { 'unrewritable-serde-call': unrewritableSerdeCall(project) } } },
    rules: { 'golem/unrewritable-serde-call': 'error' },
  };
}
