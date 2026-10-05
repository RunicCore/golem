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
}

/** Compiles the roots, writes the module to a temp directory, imports it and returns its `validators`. */
export async function compileValidators(input: CompiledValidatorInput): Promise<Readonly<Record<string, Validator>>> {
  const { source, diagnostics } = compile(
    {
      roots: new Map(Object.entries(input.roots)),
      resources: new Map(Object.entries(input.resources ?? {})),
      validations: new Map(Object.entries(input.validations ?? {})),
    },
    { unknownFormats: input.unknownFormats ?? 'warn', runtimeModule },
  );
  const errors = diagnostics.filter(entry => entry.severity === GolemDiagnosticSeverity.Error);
  if (errors.length > 0) throw new Error(`Compile failed: ${errors.map(entry => `${entry.code} ${entry.message}`).join('; ')}`);
  const directory = mkdtempSync(path.join(tmpdir(), 'golem-validators-'));
  try {
    const file = path.join(directory, 'validators.mjs');
    writeFileSync(file, source);
    for (const [name, text] of Object.entries(input.modules ?? {})) writeFileSync(path.join(directory, name), text);
    const loaded = await import(pathToFileURL(file).href) as { readonly validators: Readonly<Record<string, Validator>> };
    return loaded.validators;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Compiles one schema as the root named `root`. */
export async function compileSchema(schema: unknown): Promise<Validator> {
  return (await compileValidators({ roots: { root: schema } })).root;
}
