import fs from 'node:fs';

/** The `.golem/codec-keys.json` the generator wrote in the benchmark project, found from the compiled `build` folder. */
const keys = (JSON.parse(fs.readFileSync(new URL('../.golem/codec-keys.json', import.meta.url), 'utf8')) as { keys: Record<string, string> }).keys;

const resolved = new Map<string, string>();

/** The full codec id of the model or class that a source file declares under `name`; the registry matches ids exactly. */
export function codecIdOf(name: string): string {
  const known = resolved.get(name);
  if (known !== undefined) return known;
  const ids = new Set(Object.entries(keys).filter(([declaration]) => declaration.endsWith(`#${name}`)).map(([, id]) => id));
  if (ids.size !== 1) throw new Error(`${name} has ${ids.size} codec ids in .golem/codec-keys.json.`);
  const id = [...ids][0]!;
  resolved.set(name, id);
  return id;
}
