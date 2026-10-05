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

/** The codec ids a models job writes under `.golem/`, beside the owned-output inventory: the table a rewrite reads. */
export const CODEC_KEYS_FILE = 'codec-keys.json';

/** The codec key file of the golem.yaml in `configDirectory`. */
export function codecKeysPath(configDirectory: string): string {
  return path.join(configDirectory, '.golem', CODEC_KEYS_FILE);
}

/** The `iobject-plugin-keys.ts` table that SDKs generated before the model manifest held codec ids wrote into the program. */
export const CODEC_KEY_FILE = 'iobject-plugin-keys.ts';

/** A generated companion (`*.generated.ts`, `.mts`, `.cts`), the codec key file or an old key table: the files a rewrite depends on. */
export function isGeneratedModelFile(filename: string): boolean {
  const base = path.basename(filename);
  return /\.generated\.[cm]?ts$/.test(filename) || base === CODEC_KEY_FILE
    || (base === CODEC_KEYS_FILE && path.basename(path.dirname(filename)) === '.golem');
}
