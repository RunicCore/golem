import {
  generate as models,
  apiVersion as modelsVersion,
  discoverModelSources,
  discoverModelManifests,
  generatedFilename,
  isModelSource,
} from '@exprtlabs/golem-model/generator';
import type { ModelCodegenContext, ModelCodegenResult } from '@exprtlabs/golem-model/generator';
import { generate as openapi, apiVersion as openapiVersion } from '@exprtlabs/golem-openapi/generator';
import type { OpenApiGenerationContext, OpenApiGenerationResult } from '@exprtlabs/golem-openapi/generator';
import type { CodegenArtifact, CodegenResult } from '@exprtlabs/golem/generator-api';

const modelVersion: 1 = modelsVersion;
const sdkVersion: 1 = openapiVersion;

function modelContract(context: ModelCodegenContext): ModelCodegenResult {
  const result: CodegenResult = models(context);
  const artifact: CodegenArtifact | undefined = result.artifacts[0];
  return { artifacts: artifact ? [artifact] : [], manifestPaths: result.manifestPaths, watchInputs: result.watchInputs };
}

function sdkContract(context: OpenApiGenerationContext): Promise<OpenApiGenerationResult> {
  return openapi(context);
}

const source: string = generatedFilename('/src/item.model.ts');
const matches: boolean = isModelSource(source);
const paths: string[] = [...discoverModelSources(), ...discoverModelManifests()];
void [modelVersion, sdkVersion, modelContract, sdkContract, paths, matches];
