// The editor schema of golem.yaml (page "Registration"): one JSON Schema that core merges from its root keys and the schema part of each registered package.
// It is core's own record under `.golem/`, not a job output. Editors read it for completion; nothing in golem reads it back.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, realOutputFiles } from './outputs.js';
import type { OutputFiles } from './outputs.js';
import { displayPath, isRecord } from './plan-support.js';
import type { PackageRegistry, PackageRegistration } from './package-registry.js';

const EDITOR_SCHEMA_FILE = 'schema.json';

/** The editor schema of the golem.yaml in `configDirectory`. */
export function editorSchemaPath(configDirectory: string): string {
  return path.join(configDirectory, '.golem', EDITOR_SCHEMA_FILE);
}

type JsonObject = Record<string, unknown>;

/** The root keys that core reads itself. A package block is any other key. */
const ROOT_PROPERTIES: JsonObject = {
  version: { const: 1, description: 'The configuration format version. It is independent of the package release.' },
  tsconfig: { type: 'string', minLength: 1, default: 'tsconfig.json', description: "The project's tsconfig, relative to golem.yaml." },
  validation: { enum: [true, false, 'sanity'], default: true, description: 'The level of the generated run-time checks.' },
  allowAny: { type: 'boolean', default: false, description: 'Permit fields typed any or unknown in models.' },
  exact: { type: 'boolean', default: true, description: 'Reject extra properties in models.' },
  unknownFormats: { enum: ['warn', 'error'], default: 'error', description: 'The action for a schema format that golem does not check.' },
  mobx: { type: 'boolean', default: false, description: 'MobX observability hooks.' },
};

/** The names of the root keys, in schema order. */
export const ROOT_KEYS: readonly string[] = Object.keys(ROOT_PROPERTIES);

export interface EditorSchema {
  /** The text of .golem/schema.json. */
  readonly text: string;
  /** One line for each schema part that was left out, with the package and the cause. */
  readonly warnings: readonly string[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The schema part of `registration`, or the cause why it cannot be used. A part is external input: nothing here stops loading. */
function readPart(file: string): { readonly part: JsonObject } | { readonly cause: string } {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    return { cause: code === 'ENOENT' || code === 'ENOTDIR' ? `${displayPath(file)} does not exist` : `${displayPath(file)} cannot be read: ${describe(error)}` };
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { return { cause: `${displayPath(file)} is not valid JSON: ${describe(error)}` }; }
  if (!isRecord(value)) return { cause: `${displayPath(file)} must hold a JSON Schema object` };
  return { part: value };
}

/**
 * The editor schema for `registry`: the root keys, and under its block name the part of each package. A package without a part, or with
 * one that is missing or malformed, still has its block allowed, with any content: the package validates it, and the editor stays quiet.
 */
export function buildEditorSchema(registry: PackageRegistry): EditorSchema {
  const properties: JsonObject = { ...ROOT_PROPERTIES };
  const warnings: string[] = [];
  for (const registration of registry.packages) {
    properties[registration.block] = partOf(registration, warnings);
  }
  const schema: JsonObject = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'golem.yaml',
    type: 'object',
    required: ['version'],
    properties,
    additionalProperties: false,
  };
  return { text: `${JSON.stringify(schema, null, 2)}\n`, warnings };
}

function partOf(registration: PackageRegistration, warnings: string[]): JsonObject {
  if (registration.schema === undefined) return {};
  const read = readPart(registration.schema);
  if ('part' in read) return read.part;
  warnings.push(`golem: the schema part of ${registration.name} is left out of ${path.join('.golem', EDITOR_SCHEMA_FILE)}: ${read.cause}. The editor does not complete the "${registration.block}" block.`);
  return {};
}

/** Write the editor schema beside the other records of `.golem/`. Returns the warnings for the caller to show. */
export function writeEditorSchema(configDirectory: string, registry: PackageRegistry, files: OutputFiles = realOutputFiles): readonly string[] {
  const { text, warnings } = buildEditorSchema(registry);
  atomicWrite(editorSchemaPath(configDirectory), text, files);
  return warnings;
}
