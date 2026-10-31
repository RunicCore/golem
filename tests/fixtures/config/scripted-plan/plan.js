// A plan entry for the config tests. The block lists its jobs as facts, so a test can lay out any job graph in golem.yaml.
import path from 'node:path';

const list = (value) => value ?? [];

export const plan = {
  declare({ directory, block, profile, exact, tsconfig }) {
    return block.jobs.map((job) => ({
      facts: {
        id: job.id,
        outputs: list(job.outputs).map((output) => ({ path: path.resolve(directory, output.path), kind: output.kind ?? 'file', ...(output.importedByApp ? { importedByApp: true } : {}) })),
        ownedRoots: list(job.roots).map((root) => path.resolve(directory, root)),
        inputFiles: list(job.inputFiles).map((file) => path.resolve(directory, file)),
        inputFolders: [],
        readsProgram: job.readsProgram === true,
        provides: list(job.provides),
        needs: list(job.needs),
        hooks: [],
        watch: [],
      },
      options: { seen: { profile, tsconfig, ...(exact === undefined ? {} : { exact }) } },
      provided: Object.fromEntries(list(job.provides).map((name) => [name, { from: job.id, directory }])),
    }));
  },
  // The second pass: a job that provides a contract reads the folders of the jobs that need it, and every job keeps the values it was given.
  link(job, { needed, consumers }) {
    const folders = Object.values(consumers).flat().flatMap((facts) => facts.outputs.map((output) => output.path));
    return {
      facts: { ...job.facts, inputFolders: folders },
      options: { ...job.options, needed, consumers: Object.fromEntries(Object.entries(consumers).map(([name, jobs]) => [name, jobs.map((facts) => facts.id)])) },
    };
  },
};
