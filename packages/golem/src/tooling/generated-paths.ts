import path from 'node:path';

/** Default directory for shared model files, relative to the models job root. Public at 1.0. */
export const DEFAULT_MODEL_OUTPUT = 'src/generated/models';
/** Operation-codec registry written by a controllers job, relative to its root. Public at 1.0. */
export const OPERATION_CODEC_REGISTRY = 'src/generated/operation-codecs.ts';

export function defaultModelOutput(root: string): string {
  return path.join(root, DEFAULT_MODEL_OUTPUT);
}

export function operationCodecRegistryPath(root: string): string {
  return path.join(root, OPERATION_CODEC_REGISTRY);
}

/** True when a portable (forward-slash) path ends at the registry location. */
export function isOperationCodecRegistry(portablePath: string): boolean {
  return portablePath === OPERATION_CODEC_REGISTRY || portablePath.endsWith(`/${OPERATION_CODEC_REGISTRY}`);
}

/** The registry export that maps `<Controller>.<method>` to the model ids of that method's slots. */
export const OPERATION_METHOD_KEYS_EXPORT = 'OPERATION_METHOD_KEYS';

/** The model ids of one controller method in the registry: `input` and `query` hold a whole `@Body()` and `@Query()` model, `fields` a one-field `@Body('name')` or `@Query('name')` model. */
export interface OperationMethodCodecs {
  readonly input?: string;
  readonly output?: string;
  readonly query?: string;
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * The slot of a method's registry entry that holds the model of a `@Body()` or `@Query()` parameter: `input` or `query` for the whole
 * model, `body:name` or `query:name` for a one-field parameter, which `fields` keys the same way.
 */
export function operationCodecSlot(location: 'body' | 'query', name?: string): string {
  if (name !== undefined) return `${location}:${name}`;
  return location === 'body' ? 'input' : 'query';
}

/** The id a registry slot and a `nestModelUnion` site give a union of models: the ids of its variants in written order, joined by `|`. */
export function nestUnionCodecId(variantIds: readonly string[]): string {
  return variantIds.join('|');
}

/** Whether a registry id names a union of models rather than one model. */
export function isNestUnionCodecId(id: string): boolean {
  return id.includes('|');
}

/** The model id a method's registry entry holds in the slot, if any. */
export function operationSlotCodec(entry: OperationMethodCodecs, slot: string): string | undefined {
  if (slot === 'input') return entry.input;
  if (slot === 'query') return entry.query;
  return entry.fields?.[slot];
}

/** The codec ids a models job writes under `.golem/`, beside the owned-output inventory: the table a rewrite reads. */
export const CODEC_KEYS_FILE = 'codec-keys.json';

/** The codec key file of the golem.yaml in `configDirectory`. */
export function codecKeysPath(configDirectory: string): string {
  return path.join(configDirectory, '.golem', CODEC_KEYS_FILE);
}

/** A generated companion (`*.generated.ts`, `.mts`, `.cts`) or the codec key file: the files a rewrite depends on. */
export function isGeneratedModelFile(filename: string): boolean {
  const base = path.basename(filename);
  return /\.generated\.[cm]?ts$/.test(filename)
    || (base === CODEC_KEYS_FILE && path.basename(path.dirname(filename)) === '.golem');
}
