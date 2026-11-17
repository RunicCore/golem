import { pathToFileURL } from 'node:url';
import type { Validator } from '@exprtlabs/golem/validation';
import { isGeneratedClientClass, isGeneratedModelClass, requireRecord, type GeneratedClientClass, type GeneratedModelClass } from '../openapi/helpers.js';

async function importFile(file: string): Promise<Record<string, unknown>> {
  return requireRecord(await import(pathToFileURL(file).href), file);
}

function exportsModelClasses<Name extends string>(module: Record<string, unknown>, names: readonly Name[]): module is Record<Name, GeneratedModelClass> {
  return names.every((name) => isGeneratedModelClass(module[name]));
}

/** The generated model classes that the built module `file` exports under `names`; a missing export or one that is no generated model class throws. */
export async function loadModelClasses<Name extends string>(file: string, names: readonly Name[]): Promise<Record<Name, GeneratedModelClass>> {
  const module = await importFile(file);
  if (!exportsModelClasses(module, names)) {
    throw new TypeError(`${file} must export the generated model classes ${names.filter((name) => !isGeneratedModelClass(module[name])).join(', ')}`);
  }
  return module;
}

/** The generated client class that the built module `file` exports as `name`; a missing export or one that is no class throws. */
export async function loadClientClass(file: string, name: string): Promise<GeneratedClientClass> {
  const client = (await importFile(file))[name];
  if (!isGeneratedClientClass(client)) throw new TypeError(`${file} must export the client class ${name}`);
  return client;
}

/** The class that the built module `file` exports as `name`, for a class that is no generated model or client, such as a controller; a missing export or one that is no class throws. */
export async function loadClass(file: string, name: string): Promise<Function> {
  const value = (await importFile(file))[name];
  if (typeof value !== 'function') throw new TypeError(`${file} must export the class ${name}`);
  return value;
}

function isValidator(value: unknown): value is Validator {
  return typeof value === 'function';
}

/** The generated validator that the built validators module `file` exports as `name`; a missing export or one that is no function throws. */
export async function loadValidator(file: string, name: string): Promise<Validator> {
  const value = (await importFile(file))[name];
  if (!isValidator(value)) throw new TypeError(`${file} must export the validator ${name}`);
  return value;
}
