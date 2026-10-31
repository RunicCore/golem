import path from 'node:path';
import type { GolemConfig, GolemJob } from '#golem/config';
import type { JobFacts } from '#golem/job-facts';

/** A job of `packageName` that declares only the destinations and contracts in `declared`. Its other facts are empty. */
export function jobWithFacts(id: string, packageName: string, declared: Partial<Pick<JobFacts, 'outputs' | 'ownedRoots' | 'provides'>>): GolemJob {
  const facts: JobFacts = { id, outputs: [], ownedRoots: [], inputFiles: [], inputFolders: [], readsProgram: false, provides: [], needs: [], hooks: [], watch: [], ...declared };
  return { id, package: packageName, block: id.split(':')[0], facts, options: {} };
}

/** The config of a project in `directory` that has the one `job`, with the files golem keeps beside its golem.yaml. */
export function configFor(directory: string, job: GolemJob): GolemConfig {
  return {
    directory,
    configFile: path.join(directory, 'golem.yaml'),
    inventoryFile: path.join(directory, '.golem/outputs.json'),
    tsconfig: path.join(directory, 'tsconfig.json'),
    profile: { mobx: false, validation: true },
    jobs: [job],
    jobPlan: { order: [job.id], providers: Object.fromEntries(job.facts.provides.map(contract => [contract, job.id])), programViews: {} },
    contracts: {},
  };
}
