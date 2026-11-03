import type { Linter, Rule } from 'eslint';

import { lineStarts } from './source-map.js';
import { openRewriteProject, type GolemHostOptions, type RewriteProject } from './rewrite-host.js';

export type { GolemHostOptions };

/** `cwd` is where `golem.yaml` is looked for when `config` and `GOLEM_CONFIG` name none. Default: the current directory. */
export interface GolemEslintOptions extends GolemHostOptions {
  readonly cwd?: string;
  /** `'text'` also sets a parser that gives ESLint an empty program with the comments of the file, for a project with no ESLint parser for TypeScript. Without it, another config object sets the parser. */
  readonly parser?: 'text';
}

/** The 1-based line and 0-based column of an offset of `code`, as ESLint counts them. */
function locator(code: string): (offset: number) => { line: number; column: number } {
  const starts = lineStarts(code);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle; else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! };
  };
}

/**
 * The rule reads the text of the file, so ESLint needs no syntax tree: this parser returns a valid empty program and no scope
 * analysis. It does return the comments, which ESLint reads for `eslint-disable` and the other directives.
 */
function textParser(project: RewriteProject): Linter.Parser {
  return {
    meta: { name: 'golem-text' },
    parseForESLint: (code, options) => {
      const at = locator(code);
      const comments = options?.filePath === undefined ? [] : project.comments(options.filePath, code).map(({ block, pos, end }) => ({
        type: block ? 'Block' : 'Line',
        value: code.slice(pos + 2, block ? end - 2 : end),
        range: [pos, end],
        loc: { start: at(pos), end: at(end) },
      }));
      return { ast: { type: 'Program', body: [], comments, tokens: [], sourceType: 'module', range: [0, code.length], loc: { start: { line: 1, column: 0 }, end: at(code.length) } } };
    },
  };
}

/** The rule that reports each error of the rewrite scan of a file, the errors that `golem check` reports: code that no golem host can rewrite. */
function noUnrewritableCode(project: RewriteProject): Rule.RuleModule {
  return {
    meta: {
      type: 'problem',
      docs: { description: 'Report code that golem cannot rewrite' },
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
 * An ESLint flat-config object that turns on `golem/no-unrewritable-code` for the TypeScript files, against the
 * golem.yaml named by `config`, `GOLEM_CONFIG` or `./golem.yaml` in `cwd`. The scan is the one the hosts run, with the
 * project's own TypeScript; the file's text is the text ESLint holds. The config needs a parser: another config object
 * sets one that reads TypeScript, or `parser: 'text'` sets the parser of this config.
 */
export async function golem(options: GolemEslintOptions = {}): Promise<Linter.Config> {
  const { cwd = process.cwd(), parser, ...host } = options;
  const project = await openRewriteProject({ cwd, ...host });
  return {
    name: 'golem',
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'],
    ...(parser === 'text' ? { languageOptions: { parser: textParser(project) } } : {}),
    plugins: { golem: { rules: { 'no-unrewritable-code': noUnrewritableCode(project) } } },
    rules: { 'golem/no-unrewritable-code': 'error' },
  };
}
