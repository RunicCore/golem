// A third-party generator that registers its own block. The block takes `output` (a folder), and optionally `input` (a file the job reads)
// and `needsCodecs` (the job needs the codecs host that the models job provides, as a golem SDK does).
const path = require('node:path');

exports.plan = {
  declare({ directory, block }) {
    const output = path.resolve(directory, block.output);
    const facts = {
      id: 'acme',
      outputs: [{ path: output, kind: 'folder' }],
      ownedRoots: [],
      inputFiles: block.input === undefined ? [] : [path.resolve(directory, block.input)],
      inputFolders: [],
      readsProgram: false,
      provides: [],
      needs: block.needsCodecs === true ? ['CodecsHost'] : [],
      hooks: [],
      watch: [],
    };
    return [{ facts, options: {} }];
  },
};
