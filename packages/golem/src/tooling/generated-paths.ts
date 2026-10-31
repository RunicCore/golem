import path from 'node:path';

/** Default directory for shared model files, relative to the models job root. Public at 1.0. */
export const DEFAULT_MODEL_OUTPUT = 'src/generated/models';

export function defaultModelOutput(root: string): string {
  return path.join(root, DEFAULT_MODEL_OUTPUT);
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
