// A package that provides the ModelBoundary contract from its `boundary:` block, so a docs job has a provider to receive.
import path from 'node:path';

export const plan = {
  declare({ directory, block }) {
    const root = path.resolve(directory, block.root);
    const output = path.resolve(directory, block.output ?? 'src/generated/models');
    return [{
      facts: { id: 'boundary', outputs: [{ path: output, kind: 'folder' }], ownedRoots: [root], inputFiles: [], inputFolders: [], readsProgram: false, provides: ['ModelBoundary'], needs: [], hooks: [], watch: [] },
      options: {},
      provided: { ModelBoundary: { root, directory, output, suffixes: block.suffixes ?? ['.model.ts', '.models.ts'] } },
    }];
  },
};
