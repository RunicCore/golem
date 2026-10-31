import path from 'node:path';
import type { GolemPlanEntry, PlanContext } from '@exprtlabs/golem/generator-api';

/** A tiny extension package as an author writes it: the plan entry reads the `acme:` block of golem.yaml and declares one job that owns one folder. */
function parseBlock(block: unknown): { readonly output: string; readonly fields: Readonly<Record<string, string>> } {
  const { output, fields } = (block ?? {}) as { output?: unknown; fields?: unknown };
  if (typeof output !== 'string' || typeof fields !== 'object' || fields === null) throw new TypeError('acme needs output and fields.');
  return { output, fields: fields as Readonly<Record<string, string>> };
}

export const plan: GolemPlanEntry = {
  declare({ directory, block, profile }: PlanContext) {
    const { output, fields } = parseBlock(block);
    const folder = path.resolve(directory, output);
    return [{
      facts: { id: 'acme', outputs: [{ path: folder, kind: 'folder' }], ownedRoots: [], inputFiles: [], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [], watch: [] },
      options: { directory, output: folder, options: { fields }, profile },
    }];
  },
};
