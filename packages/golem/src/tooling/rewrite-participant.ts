// The rewrite participant of an extension (page "What an extension declares"). Core runs the participants of the extensions that a
// golem.yaml block turns on, in golem check, golem build, Vite, esbuild and the Node loader alike. Core names no package and no extension.
// This file holds the contract and the loading; it imports no TypeScript at run time, so an extension entry may import it.
import { pathToFileURL } from 'node:url';

import { displayPath, isRecord } from './plan-support.js';
import type { GolemDiagnostic, ModelBoundaryValue } from './generator-core.js';
import type { RewriteEdit } from './rewrite.js';
import type * as ts from './typescript-ns.js';

export type { RewriteEdit };

/** An extension that a block turns on: its `extensions:` entry in golem.yaml, resolved to the entry its package registers. */
export interface EnabledExtension {
  /** The package that registers the block, and so the extension. */
  readonly package: string;
  readonly block: string;
  /** The name under `extensions:`. */
  readonly name: string;
  /** The absolute file of the extension entry; it is not loaded until a rewrite host starts. */
  readonly entry: string;
  /** The value under the name in golem.yaml; an empty entry is `{}`. */
  readonly options: Readonly<Record<string, unknown>>;
}

/** What core lends a participant for one file: the import insertion helper and its judgment of models. */
export interface RewriteCore {
  /** The project root; the paths of the diagnostics are relative to it. */
  readonly root: string;
  /**
   * Imports `name` from the module `from` for the file under the alias `__golem_<name>`, so edit text can call `__golem_<name>(...)`.
   * One module for each name: a second module for the same name is an error diagnostic at `node`.
   */
  importName(node: ts.Node, name: string, from: string): void;
  /** Makes the file load the module that registers codec `id`, so the codec exists when the rewritten code asks for it. `typeName` is the type as the file spells it. */
  loadCodecModule(id: string, typeName?: ts.EntityName): void;
  /** The codec id of a declaration (its key, or for a class the model whose generated base it extends); `''` when it has none. The key tables it came from count as files the rewrite read. */
  codecIdOf(symbol: ts.Symbol): string;
  /** Whether the symbol is a golem model by its declaration, not by a key table that a new model may not be in yet. */
  isGolemModel(symbol: ts.Symbol): boolean;
  /** A diagnostic located at `node`. */
  locate(node: ts.Node, code: string, message: string, severity?: GolemDiagnostic['severity']): GolemDiagnostic;
}

/** What a participant is asked about one source file. */
export interface RewriteParticipantInput {
  /** The TypeScript seam of the project: an extension never picks TypeScript itself. */
  readonly ts: typeof ts;
  readonly checker: ts.TypeChecker;
  readonly file: ts.SourceFile;
  /** The project root: the tsconfig folder. */
  readonly root: string;
  /** The codec ids of the project's `.golem/codec-keys.json`. */
  readonly codecKeys: {
    /** The id of the named declaration in the file; `''` when the key tables give it none or more than one. */
    idFor(filename: string, name: string): string;
    /** The absolute file of the generated module that registers the codec; undefined when no key file names it. */
    moduleOf(id: string): string | undefined;
  };
  /** The value of the `ModelBoundary` contract; undefined without a provider. */
  readonly boundary: ModelBoundaryValue | undefined;
  /** How many classes register for each model across the program's files, by codec id. Counted on first use. */
  modelClasses(): ReadonlyMap<string, number>;
  /** The value under the extension's name in golem.yaml. */
  readonly options: Readonly<Record<string, unknown>>;
  readonly core: RewriteCore;
}

export interface RewriteParticipantResult {
  /**
   * Edits to the file's text, as `RewriteEdit`: UTF-16 offsets, with `expect` the original text of the range. Core checks each range against
   * the file, and no edit may overlap an edit of core or of another participant (an insertion at an edit's border is fine).
   */
  readonly edits?: readonly RewriteEdit[];
  /** Absolute files the participant read besides the source, such as a table: a change to one of them scans the file again. */
  readonly reads?: readonly string[];
  readonly diagnostics?: readonly GolemDiagnostic[];
}

export type RewriteParticipant = (input: RewriteParticipantInput) => RewriteParticipantResult;

/** What an extension entry exports as `extension`. */
export interface GolemExtension {
  readonly rewrite?: RewriteParticipant;
  /**
   * The participants that fill hooks, by hook name. A job offers a hook by name (`JobFacts.hooks`) and defines its contract, so the type of a participant
   * belongs to the package of that job; core only routes it. A name that no job of the golem.yaml offers stops the run.
   */
  readonly hooks?: Readonly<Record<string, unknown>>;
}

/** An enabled extension with what its entry exports. */
export interface LoadedExtension {
  readonly extension: EnabledExtension;
  readonly rewrite?: RewriteParticipant;
  /** The participants by hook name; empty when the entry fills no hook. */
  readonly hooks: Readonly<Record<string, unknown>>;
}

/** A participant with the extension that it belongs to. */
export interface LoadedParticipant {
  readonly extension: EnabledExtension;
  readonly participant: RewriteParticipant;
}

/**
 * An extension's code failed or broke the contract: it did not load, it threw, or it returned edits that do not fit the file. It is a
 * fault in the extension's package, not in the project, so the run fails with the package named and nothing is skipped.
 */
export class ExtensionFaultError extends Error {
  constructor(extension: EnabledExtension, what: string, options?: { cause: unknown }) {
    super(`Extension "${extension.name}" of ${extension.package} (block ${extension.block}) ${what}. This is a fault in ${extension.package}; golem stops here.`, options);
    this.name = 'ExtensionFaultError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads the entries of the extensions that blocks turn on, in the order of golem.yaml, and checks what each exports. An entry loads with `import()`,
 * because `require()` of an ES module fails inside a Node loader hook. A rewrite host calls this in its asynchronous project start, after it
 * picked the project's TypeScript; the pipeline calls it before the jobs run.
 */
export async function loadExtensions(extensions: readonly EnabledExtension[]): Promise<readonly LoadedExtension[]> {
  const loaded: LoadedExtension[] = [];
  for (const extension of extensions) {
    let module: unknown;
    try { module = await import(pathToFileURL(extension.entry).href); }
    catch (error) { throw new ExtensionFaultError(extension, `did not load (${displayPath(extension.entry)}): ${describe(error)}`, { cause: error }); }
    const exported = isRecord(module) ? module.extension : undefined;
    if (!isRecord(exported)) throw new ExtensionFaultError(extension, `must export "extension" from ${displayPath(extension.entry)}`);
    if (exported.rewrite !== undefined && typeof exported.rewrite !== 'function') throw new ExtensionFaultError(extension, 'exports an "extension" whose "rewrite" is not a function');
    if (exported.hooks !== undefined && (!isRecord(exported.hooks) || Object.values(exported.hooks).some(participant => participant === undefined || participant === null))) {
      throw new ExtensionFaultError(extension, 'exports an "extension" whose "hooks" is not an object of participants by hook name');
    }
    loaded.push({ extension, ...(exported.rewrite === undefined ? {} : { rewrite: exported.rewrite as RewriteParticipant }), hooks: (exported.hooks ?? {}) as Readonly<Record<string, unknown>> });
  }
  return loaded;
}

/** The rewrite participants of the loaded extensions, in the order of golem.yaml. */
export async function loadRewriteParticipants(extensions: readonly EnabledExtension[]): Promise<readonly LoadedParticipant[]> {
  return (await loadExtensions(extensions)).flatMap(({ extension, rewrite }) => rewrite === undefined ? [] : [{ extension, participant: rewrite }]);
}

/** The edits of a participant's result, each checked against the file text: whole numbers, in range, and `expect` the text of the range. */
export function checkedEdits(extension: EnabledExtension, file: string, text: string, result: unknown): readonly RewriteEdit[] {
  if (!isRecord(result)) throw new ExtensionFaultError(extension, `returned no result object for ${displayPath(file)}`);
  const { edits } = result;
  if (edits === undefined) return [];
  if (!Array.isArray(edits)) throw new ExtensionFaultError(extension, `returned edits that are no array for ${displayPath(file)}`);
  for (const edit of edits as unknown[]) {
    const fits = isRecord(edit) && Number.isInteger(edit.start) && Number.isInteger(edit.end) && typeof edit.expect === 'string' && typeof edit.text === 'string'
      && (edit.start as number) >= 0 && (edit.start as number) <= (edit.end as number) && (edit.end as number) <= text.length
      && text.slice(edit.start as number, edit.end as number) === edit.expect;
    if (!fits) throw new ExtensionFaultError(extension, `returned an edit for ${displayPath(file)} that is out of range or does not match the text it expects: ${JSON.stringify(edit)}`);
  }
  return edits as readonly RewriteEdit[];
}

/** Whether two edits cover some of the same text. Two insertions never do; an insertion at the border of an edit does not; one inside it does. */
export function editsOverlap(left: RewriteEdit, right: RewriteEdit): boolean {
  const leftInserts = left.start === left.end;
  const rightInserts = right.start === right.end;
  if (leftInserts && rightInserts) return false;
  if (leftInserts) return right.start < left.start && left.start < right.end;
  if (rightInserts) return left.start < right.start && right.start < left.end;
  return left.start < right.end && right.start < left.end;
}
