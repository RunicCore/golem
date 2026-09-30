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
