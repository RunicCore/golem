// A third-party block with one job that offers the hook `hooked.note`. The job reads `input`, calls the participant of each extension that fills the hook
// (see generator.mjs) and writes `output`; `log` gets one line for each run of the generator.
const NOTE_HOOK = 'hooked.note';
exports.NOTE_HOOK = NOTE_HOOK;

const path = require('node:path');

exports.plan = {
  declare({ directory, block }) {
    const [output, input, log] = [block.output, block.input, block.log].map(name => path.resolve(directory, name));
    return [{
      facts: { id: 'hooked', outputs: [{ path: output, kind: 'file' }], ownedRoots: [], inputFiles: [input], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [NOTE_HOOK], watch: [] },
      options: { output, input, log },
    }];
  },
};
