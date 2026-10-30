import { join as joinPath, relative, sep } from 'node:path';
import { compareText } from '@exprtlabs/golem/generator-api';
import { canonicalPath } from '@exprtlabs/golem/internal/generator-support';
import { sdkCodecsFile } from '@exprtlabs/golem/internal/emitter';
import type { GolemModeManifest } from '@exprtlabs/golem/manifest';
import type { ManifestIndex } from '@exprtlabs/golem/internal/type-analysis';
import type { SdkValidatorsInput } from '@exprtlabs/golem/internal/validation-plan';

/** An SDK of mode golem that this models job compiles and writes the codecs file for. */
export interface GolemSdk {
  readonly manifest: GolemModeManifest;
  /** The SDK folder relative to the golem.yaml folder, written with `/`: the scope of the SDK's root and export names. */
  readonly scope: string;
  /** The file the SDK's operation modules import (`sdkCodecsFile`). */
  readonly codecsFile: string;
}

/**
 * The golem-mode SDKs of the job, by scope. The openapi jobs of mode `golem` name their output folders in `sdkOutputs`, and
 * a manifest belongs to the folder it sits in; one that no such job writes has no codecs file to go with it.
 */
export function golemSdks(
  index: ManifestIndex,
  where: { readonly directory: string; readonly output: string; readonly sdkOutputs: readonly string[] },
): readonly GolemSdk[] {
  const outputs = new Map(where.sdkOutputs.map((output) => [canonicalPath(joinPath(output, 'model-manifest.json')), output] as const));
  return index.golemModeManifests.map(({ file, manifest }) => {
    const sdkOutput = outputs.get(canonicalPath(file));
    if (sdkOutput === undefined) {
      throw new Error(`The SDK manifest ${file} is in mode golem, but no openapi job of mode golem in this golem.yaml writes its folder, so the models job cannot name the codecs file for it.`);
    }
    return { manifest, scope: relative(where.directory, sdkOutput).split(sep).join('/'), codecsFile: sdkCodecsFile({ modelsOutput: where.output, configDirectory: where.directory, sdkOutput }) };
  }).sort((left, right) => compareText(left.scope, right.scope));
}

/** The name of an operation root of an SDK in the models validators module: the root name of the manifest under the SDK's scope, so two SDKs with one operation name do not collide. */
export const scopedRoot = (sdk: GolemSdk, root: string): string => `${sdk.scope}:${root}`;

/** The operation roots of the golem-mode SDKs, for `compileSdkValidators`: each SDK's roots under its scope, with the resources they reach. */
export function sdkValidatorOperations(sdks: readonly GolemSdk[]): SdkValidatorsInput['operations'] {
  return sdks.flatMap((sdk) => sdk.manifest.validationResources === undefined ? [] : [{
    roots: Object.fromEntries(sdk.manifest.operations.flatMap(({ validation }) => Object.entries(validation?.roots ?? {})).map(([name, root]) => [scopedRoot(sdk, name), root])),
    resources: sdk.manifest.validationResources,
  }]);
}
