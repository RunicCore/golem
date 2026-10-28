import path from 'node:path';
import type { GolemConfig, GolemJob } from '#golem/config';

/** The config of a project in `directory` that has the one `job`, with the files golem keeps beside its golem.yaml. */
export function configFor(directory: string, job: GolemJob): GolemConfig {
  return {
    directory,
    configFile: path.join(directory, 'golem.yaml'),
    inventoryFile: path.join(directory, '.golem/outputs.json'),
    tsconfig: path.join(directory, 'tsconfig.json'),
    profile: { mobx: false, validation: true },
    jobs: [job],
  };
}
