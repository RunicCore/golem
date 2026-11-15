import { join as joinPath, relative, sep } from 'node:path';
import { compareText, type ResolvedGolemProfile } from '@exprtlabs/golem/generator-api';
import {
  blockComment,
  code,
  emitCodecRuntimeCode,
  fileImports,
  fromWireFunctionName,
  identifier,
  ImportSource,
  isCode,
  join,
  lineBreak,
  MODEL_IMPORT_ORDER,
  moduleSpecifier,
  MODULE_CONSTANT_HELPERS,
  placeHelpers,
  render,
  runtimeLinesOf,
  sdkCodecsFile,
  sdkCodecsTable,
  RUNTIME_SERDE,
  toWireFunctionName,
  writesWireStringify,
  type Code,
  type ImportOptions,
  type Piece,
} from '@exprtlabs/golem/internal/emitter';
import { canonicalPath } from '@exprtlabs/golem/internal/generator-support';
import type { SchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { golemModeComponents, type GolemModeManifest } from '@exprtlabs/golem/manifest';
import { codedError, sdkSchemaGraph, type ManifestIndex } from '@exprtlabs/golem/internal/type-analysis';
import type { PlanValidators, SdkValidatorsInput } from '@exprtlabs/golem/internal/validation-plan';
import { PACKAGE_VERSION } from './package-info.js';

/** An SDK of mode golem that this models job compiles and writes the codecs file for, with its schema graph. */
export interface GolemSdk {
  readonly manifest: GolemModeManifest;
  /** The SDK's `model-manifest.json`, which the manifest was read from. */
  readonly file: string;
  /** The SDK folder relative to the golem.yaml folder, written with `/`: the scope of the SDK's root and export names. */
  readonly scope: string;
  /** The file the SDK's operation modules import (`sdkCodecsFile`). */
  readonly codecsFile: string;
  /** The sealed schema graph of the manifest's nodes, and the node of each operation value that converts something (`sdkSchemaGraph`). */
  readonly graph: SchemaGraph;
  readonly valueNodes: ReadonlyMap<string, string>;
}

/**
 * The golem-mode SDKs of the job, by scope. The openapi jobs of mode `golem` name their output folders in `sdkOutputs`, and
 * a manifest belongs to the folder it sits in; one that no such job writes has no codecs file to go with it.
 */
export function golemSdks(
  index: ManifestIndex,
  where: { readonly directory: string; readonly output: string; readonly sdkOutputs: readonly string[]; readonly profile: ResolvedGolemProfile },
): readonly GolemSdk[] {
  const outputs = new Map(where.sdkOutputs.map((output) => [canonicalPath(joinPath(output, 'model-manifest.json')), output] as const));
  return index.golemModeManifests.map(({ file, manifest }) => {
    const sdkOutput = outputs.get(canonicalPath(file));
    if (sdkOutput === undefined) {
      throw codedError('GOLEM_SDK_JOB_MISSING', `The SDK manifest ${file} is in mode golem, but no openapi job of mode golem in this golem.yaml writes its folder, so the model block cannot name the codecs file for it. Set the SDK to mode standalone, or add its openapi job with mode golem to this golem.yaml.`);
    }
    return {
      manifest,
      file,
      scope: relative(where.directory, sdkOutput).split(sep).join('/'),
      codecsFile: sdkCodecsFile({ modelsOutput: where.output, configDirectory: where.directory, sdkOutput }),
      ...sdkSchemaGraph(manifest, where.profile.validation),
    };
  }).sort((left, right) => compareText(left.scope, right.scope));
}

/** The name of an operation root of an SDK in the models validators module: the root name of the manifest under the SDK's scope, so two SDKs with one operation name do not collide. */
const scopedRoot = (sdk: GolemSdk, root: string): string => `${sdk.scope}:${root}`;

/** The operation roots of the golem-mode SDKs, for `compileSdkValidators`: each SDK's roots under its scope, with the resources they reach. */
export function sdkValidatorOperations(sdks: readonly GolemSdk[]): SdkValidatorsInput['operations'] {
  return sdks.flatMap((sdk) => {
    const roots = sdk.manifest.operations.flatMap(({ validation }) => Object.entries(validation?.roots ?? {})).map(([name, root]) => [scopedRoot(sdk, name), root] as const);
    return roots.length === 0 ? [] : [{ roots: Object.fromEntries(roots), resources: sdk.manifest.validationResources ?? {} }];
  });
}

/** The order of the names in each import of the runtime parts of the file. */
const IMPORT_OPTIONS: ImportOptions = {
  typeNames: 'ordered',
  modules: ['conversion', 'temporal', 'serde'],
  order: MODEL_IMPORT_ORDER,
};

/** The generated validators module and what it exports: the SDK's operation roots, under their scoped names, and the models' codec ids. */
interface SdkValidators {
  readonly file: string;
  readonly compiled: PlanValidators;
}

/**
 * The file a golem-mode SDK imports: the codecs of the SDK's converting nodes, and `sdkCodecs`, the table with one member per operation.
 * An operation has a member when the SDK validates or one of its values converts. A client operation encodes its request and decodes its response.
 */
export function sdkCodecsSource(
  sdk: GolemSdk,
  validators: SdkValidators | undefined,
  profile: ResolvedGolemProfile,
): string {
  const validated = validators && { source: new ImportSource(moduleSpecifier(sdk.codecsFile, validators.file)), compiled: validators.compiled };
  const exported = (map: ReadonlyMap<string, string>, id: string): string => {
    const name = map.get(id);
    if (name === undefined) throw new Error(`The generated validators module has no validator for ${JSON.stringify(id)}.`);
    return name;
  };
  const components = golemModeComponents(sdk.manifest);
  const codecRuntime = emitCodecRuntimeCode(sdk.graph, {
    validationLevel: profile.validation,
    serde: RUNTIME_SERDE,
    ...(validated ? {
      validatorName: (id: string) => validated.source.name(exported(validated.compiled.exports, id)),
      fastCheckName: (id: string) => {
        const name = validated.compiled.fastExports.get(id);
        return name === undefined ? undefined : validated.source.name(name);
      },
      passCheckNames: (id: string) => {
        const pass = validated.compiled.passExports.get(id);
        return pass === undefined ? undefined : { structure: validated.source.name(pass.structure), predicates: validated.source.name(pass.predicates) };
      },
    } : {}),
    issueSource: 'OpenAPI',
    projectsInstanceState: true,
    // The SDK reads no registry: a client calls the table, and an app model calls the node codecs by name.
    registerCodecs: false,
    exportAnonymousCodecs: true,
    // An app model that holds a node writes the wire value of the node with this function (`NestedImportedSerde.wireStringify`).
    exportWireStringify: (node) => writesWireStringify(node, profile.validation),
    exportStripPlans: true,
    modelBases: { basesOf: (id) => components.get(id)?.bases ?? [] },
  });
  const root = (from: NonNullable<typeof validated>, name: string): Code => from.source.name(exported(from.compiled.exports, scopedRoot(sdk, name)));
  const operations = sdk.manifest.operations.map((operation) => {
    const checks = operation.validation;
    return {
      name: operation.name,
      codecOf: (at: readonly string[], conversion: 'fromWire' | 'toWire'): Code | undefined => {
        const node = sdk.valueNodes.get(JSON.stringify([operation.name, ...at]));
        return node === undefined ? undefined : identifier((conversion === 'fromWire' ? fromWireFunctionName : toWireFunctionName)(node));
      },
      shape: {
        values: operation.values.map(({ at }) => at),
        ...(checks && validated ? {
          checks: {
            input: root(validated, checks.input),
            ...(checks.headers === undefined ? {} : { requestHeaders: root(validated, checks.headers) }),
            responses: checks.responses.map((item) => ({ key: item.key, code: root(validated, item.root) })),
            responseHeaders: checks.responseHeaders.map((item) => ({ key: item.key, code: root(validated, item.root) })),
          },
        } : {}),
      },
    };
  });
  const body: Piece[] = [codecRuntime, sdkCodecsTable(operations)];
  // What the code calls decides the runtime imports and which helpers the file defines.
  const calls = join(body.filter(isCode), code`\n`);
  const runtimeLines = runtimeLinesOf(calls, IMPORT_OPTIONS);
  const bodyLines = placeHelpers(calls, body, MODULE_CONSTANT_HELPERS);
  const sources = validated ? [validated.source] : [];
  const lines: readonly Code[] = [
    blockComment(`Generated by @exprtlabs/golem-model ${PACKAGE_VERSION}. Do not edit.`),
    ...runtimeLines('conversion', 'temporal', 'serde'),
    ...fileImports(join(bodyLines, code`\n`), sources),
    code``,
    ...bodyLines,
  ];
  return render(code`${join(lines, lineBreak)}`);
}
