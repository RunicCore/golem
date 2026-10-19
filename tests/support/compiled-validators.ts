import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GolemDiagnosticSeverity } from '@exprtlabs/golem/generator-api';
import type { Validator } from '@exprtlabs/golem/validation-runtime';
import { compile, type CompileOptions } from '@exprtlabs/golem/validator-compiler';

import { workspace } from './process.js';

/** The built runtime file; the emitted module sits in a temp directory where the package name does not resolve. */
const runtimeModule = pathToFileURL(path.join(workspace, 'packages/golem/dist/validation-runtime.js')).href;

export interface CompiledValidatorInput {
  readonly roots: Readonly<Record<string, unknown>>;
  readonly resources?: Readonly<Record<string, unknown>>;
  readonly unknownFormats?: CompileOptions['unknownFormats'];
  /** User validation functions, keyed by binding id; an `importPath` of `./name.mjs` reads a file of `modules`. */
  readonly validations?: Readonly<Record<string, { readonly importPath: string; readonly exportName: string }>>;
  /** Files written next to the emitted module, by file name. */
  readonly modules?: Readonly<Record<string, string>>;
  /** Compiles with `fastPath`, so the module also exports the fast check of each root that has one. */
  readonly fastPath?: boolean;
}

/** A generated fast check: true exactly when the root's validator reports no issue. */
export type FastCheck = (value: unknown) => boolean;

/** The validators of a compiled module: what it exports, and the export name of each root. */
export interface CompiledValidatorModule {
  /** Each root's validator, by root name. */
  readonly byRoot: Readonly<Record<string, Validator>>;
  /** Every validator the module exports, by export name: the scope a module that imports them runs in. */
  readonly byExport: Readonly<Record<string, Validator>>;
  /** The export name of each root, by root name. */
  readonly exports: ReadonlyMap<string, string>;
  /** The fast check of each root that has one, by root name; empty without `fastPath`. */
  readonly fastByRoot: Readonly<Record<string, FastCheck>>;
  /** The emitted module. */
  readonly source: string;
}

/** Compiles the roots, writes the module to a temp directory and imports it. */
export async function compileValidatorModule(input: CompiledValidatorInput): Promise<CompiledValidatorModule> {
  const { source, exports, fastExports, diagnostics } = compile(
    {
      roots: new Map(Object.entries(input.roots)),
      resources: new Map(Object.entries(input.resources ?? {})),
      validations: new Map(Object.entries(input.validations ?? {})),
    },
    { unknownFormats: input.unknownFormats ?? 'warn', runtimeModule, ...(input.fastPath ? { fastPath: true } : {}) },
  );
  const errors = diagnostics.filter(entry => entry.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw new Error(`Compile failed: ${errors.map(entry => `${entry.code} ${entry.message}`).join('; ')}`);
  const directory = mkdtempSync(path.join(tmpdir(), 'golem-validators-'));
  try {
    const file = path.join(directory, 'validators.mjs');
    writeFileSync(file, source);
    for (const [name, text] of Object.entries(input.modules ?? {})) writeFileSync(path.join(directory, name), text);
    const namespace = await import(pathToFileURL(file).href);
    const loaded: Readonly<Record<string, Validator>> = namespace;
    const fastChecks: Readonly<Record<string, FastCheck>> = namespace;
    const byExport = Object.fromEntries(Object.entries(loaded).filter(([name, value]) => typeof value === 'function' && name.startsWith('validate_')));
    return {
      byRoot: Object.fromEntries([...exports].map(([root, exported]) => [root, loaded[exported]] as const)),
      byExport,
      exports,
      fastByRoot: Object.fromEntries([...fastExports].map(([root, exported]) => [root, fastChecks[exported]] as const)),
      source,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Compiles the roots and returns the validator exported for each root, by root name. */
export async function compileValidators(input: CompiledValidatorInput): Promise<Readonly<Record<string, Validator>>> {
  return (await compileValidatorModule(input)).byRoot;
}

/** Compiles one schema as the root named `root`. */
export async function compileSchema(schema: unknown): Promise<Validator> {
  return (await compileValidators({ roots: { root: schema } })).root;
}

function planRoots(plan: { readonly schemas: Readonly<Record<string, object | boolean>> }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(plan.schemas).map(([id, schema]) => {
    if (typeof schema === 'boolean') return [id, schema] as const;
    // The plan id is the root's address; the schema's own `$id` repeats it.
    const { $id: _id, ...rest } = schema as Record<string, unknown>;
    return [id, rest] as const;
  }));
}

/** Compiles every schema of a validation plan, each under its plan id, as the generated validators module does. */
export async function compileValidationPlan(
  plan: { readonly schemas: Readonly<Record<string, object | boolean>> },
  input: Omit<CompiledValidatorInput, 'roots'> = {},
): Promise<Readonly<Record<string, Validator>>> {
  return compileValidators({ ...input, roots: planRoots(plan) });
}

/**
 * What a generated codec module needs to run on a plan's validators: the `validatorName` and, with `fastPath`, the
 * `fastCheckName` options for the emitter, and the scope that holds the validators and fast checks under those names.
 */
export async function compileValidationPlanBinding(
  plan: { readonly schemas: Readonly<Record<string, object | boolean>> },
  input: Omit<CompiledValidatorInput, 'roots'> = {},
): Promise<{
  readonly validatorName: (id: string) => string;
  readonly fastCheckName: (id: string) => string | undefined;
  readonly scope: Readonly<Record<string, Validator>>;
  readonly fastScope: Readonly<Record<string, FastCheck>>;
}> {
  const compiled = await compileValidatorModule({ ...input, roots: planRoots(plan) });
  const fastNames = new Map(Object.keys(compiled.fastByRoot).map(root => [root, `is_${(compiled.exports.get(root) ?? '').slice('validate_'.length)}`] as const));
  return {
    validatorName: id => {
      const name = compiled.exports.get(id);
      if (name === undefined) throw new Error(`No validator for ${id}`);
      return name;
    },
    fastCheckName: id => fastNames.get(id),
    scope: compiled.byExport,
    fastScope: Object.fromEntries([...fastNames].map(([root, name]) => [name, compiled.fastByRoot[root]] as const)),
  };
}
