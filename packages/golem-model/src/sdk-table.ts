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
  TEMPORAL_SERDE,
  toWireFunctionName,
  type Code,
  type ImportOptions,
  type Piece,
} from '@exprtlabs/golem/internal/emitter';
import { canonicalPath } from '@exprtlabs/golem/internal/generator-support';
import type { SchemaGraph } from '@exprtlabs/golem/internal/schema-graph';
import { golemModeComponents, type GolemModeManifest } from '@exprtlabs/golem/manifest';
import type { ManifestIndex } from '@exprtlabs/golem/internal/type-analysis';
import type { PlanValidators, SdkValidatorsInput } from '@exprtlabs/golem/internal/validation-plan';
import { PACKAGE_VERSION } from './package-info.js';

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
 * An operation has a member when the SDK validates or one of its values converts. A client operation encodes its request and decodes its response;
 * an inbound one (a webhook or callback) is the other way round, so its request tables hold `fromWire` and its response tables `toWire`.
 */
export function sdkCodecsSource(
  sdk: GolemSdk,
  built: { readonly graph: SchemaGraph; readonly valueNodes: ReadonlyMap<string, string> },
  validators: SdkValidators | undefined,
  profile: ResolvedGolemProfile,
): string {
  const validatorsSource = validators && new ImportSource(moduleSpecifier(sdk.codecsFile, validators.file));
  const exported = (map: ReadonlyMap<string, string>, id: string): string => {
    const name = map.get(id);
    if (name === undefined) throw new Error(`The generated validators module has no validator for ${JSON.stringify(id)}.`);
    return name;
  };
  const names = (map: ReadonlyMap<string, string>, id: string): Code | undefined => {
    const name = map.get(id);
    return name === undefined || validatorsSource === undefined ? undefined : validatorsSource.name(name);
  };
  const components = golemModeComponents(sdk.manifest);
  const codecRuntime = emitCodecRuntimeCode(built.graph, {
    validationLevel: profile.validation,
    serde: TEMPORAL_SERDE,
    ...(validators && validatorsSource ? {
      validatorName: (id: string) => validatorsSource.name(exported(validators.compiled.exports, id)),
      fastCheckName: (id: string) => names(validators.compiled.fastExports, id),
      passCheckNames: (id: string) => {
        const pass = validators.compiled.passExports.get(id);
        return pass === undefined ? undefined : { structure: validatorsSource.name(pass.structure), predicates: validatorsSource.name(pass.predicates) };
      },
    } : {}),
    issueSource: 'OpenAPI',
    projectsInstanceState: true,
    // The SDK reads no registry: a client calls the table, and an app model calls the node codecs by name.
    registerCodecs: false,
    exportAnonymousCodecs: true,
    modelBases: { basesOf: (id) => components.get(id)?.bases ?? [] },
  });
  const operations = sdk.manifest.operations.map((operation) => {
    const checks = operation.validation;
    const root = (name: string): Code => validatorsSource!.name(exported(validators!.compiled.exports, scopedRoot(sdk, name)));
    return {
      name: operation.name,
      codecOf: (at: readonly string[], conversion: 'fromWire' | 'toWire'): Code | undefined => {
        const node = built.valueNodes.get(JSON.stringify([operation.name, ...at]));
        return node === undefined ? undefined : identifier((conversion === 'fromWire' ? fromWireFunctionName : toWireFunctionName)(node));
      },
      shape: {
        inbound: operation.inbound === true,
        values: operation.values.map(({ at }) => at),
        wireChecked: operation.wireChecked ?? [],
        ...(checks && validatorsSource && validators ? {
          checks: {
            input: root(checks.input),
            ...(checks.headers === undefined ? {} : { requestHeaders: root(checks.headers) }),
            responses: checks.responses.map((item) => ({ key: item.key, code: root(item.root) })),
            responseHeaders: checks.responseHeaders.map((item) => ({ key: item.key, code: root(item.root) })),
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
  const sources = validatorsSource ? [validatorsSource] : [];
  const lines: readonly Code[] = [
    blockComment(`Generated by @exprtlabs/golem-model ${PACKAGE_VERSION}. Do not edit.`),
    ...runtimeLines('conversion', 'temporal', 'serde'),
    ...fileImports(join(bodyLines, code`\n`), sources),
    code``,
    ...bodyLines,
  ];
  return render(code`${join(lines, lineBreak)}`);
}
