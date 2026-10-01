import fs from 'node:fs';
import path from 'node:path';

/** Standalone source examples: one packed-consumer project per generator profile. */
export const SOURCE_EXAMPLES = ['model', 'openapi', 'combined', 'model-mobx', 'combined-mobx', 'showcase', 'nest-openapi', 'client-features'] as const;

/** Framework projects with their own toolchain. */
export const FRAMEWORK_EXAMPLES = ['react-mobx', 'payments'] as const;

/** Every maintained project under `examples/`. */
export const EXAMPLE_NAMES = [...SOURCE_EXAMPLES, ...FRAMEWORK_EXAMPLES] as const;

/** Reject an `examples/*` project that is missing from, or absent but listed in, the inventory. */
export function assertExampleInventory(workspaceRoot: string): void {
  const directory = path.join(path.resolve(workspaceRoot), 'examples');
  const present = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'package.json')))
    .map(entry => entry.name)
    .sort();
  const expected = [...EXAMPLE_NAMES].sort();
  if (present.join('\n') !== expected.join('\n')) {
    throw new Error(`examples/ projects (${present.join(', ')}) must match the maintained example inventory (${expected.join(', ')}).`);
  }
}
