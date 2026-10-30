import path from 'node:path';
import { code, ImportSource, literal, moduleSpecifier, SDK_CODECS_EXPORT, type Code } from '@exprtlabs/golem/internal/emitter';

/** How one generated file of the SDK reads the codecs of operations. */
interface OperationCodecsAt {
  /** The import sources of the codecs, so `fileImports` places their imports apart from the file's other modules. */
  readonly sources: () => readonly ImportSource[];
  /** The local names the file's codec imports bind, which the file claims. */
  readonly claimed: readonly string[];
  /** The code that reads the codecs of the operation. In a standalone SDK `alias` names the import of the operation's own module; the golem mode imports its table once. */
  readonly read: (operation: string, alias: string) => Code;
}

/** For the file at `importer`, given relative to the SDK folder, the way that file reads the codecs of operations. */
export type OperationCodecsFor = (importer: string) => OperationCodecsAt;

/** A standalone SDK writes `codecs/<operation>.ts` for each operation with codecs, and the operation module imports the one it calls. */
export const standaloneCodecs: OperationCodecsFor = (importer) => {
  const sources = new Map<string, ImportSource>();
  const sourceOf = (operation: string): ImportSource => {
    let source = sources.get(operation);
    if (!source) {
      source = new ImportSource(moduleSpecifier(path.posix.join('/', importer), `/codecs/${operation}.ts`));
      sources.set(operation, source);
    }
    return source;
  };
  return {
    sources: () => [...sources.values()],
    claimed: [],
    read: (operation, alias) => sourceOf(operation).name('operationCodecs', { alias }),
  };
};

/** The local name of the `sdkCodecs` table in a file of a golem-mode SDK. */
const TABLE_ALIAS = '__golemSdkCodecs';

/** An SDK of mode golem reads its codecs from the table the models job writes at `codecsFile`, by the operation name. */
export function golemCodecs(output: string, codecsFile: string): OperationCodecsFor {
  return (importer) => {
    const table = new ImportSource(moduleSpecifier(path.join(output, importer), codecsFile));
    return {
      sources: () => [table],
      claimed: [TABLE_ALIAS],
      read: (operation) => code`${table.name(SDK_CODECS_EXPORT, { alias: TABLE_ALIAS })}[${literal(operation)}]`,
    };
  };
}
