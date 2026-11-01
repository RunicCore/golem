import { resolveConfig, validateConfigInputs, type GolemConfig } from '#golem/config';

/** The configuration as `golem generate` reads it: resolved, then checked against the files on disk. */
export async function loadConfig(filename: string): Promise<GolemConfig> {
  const config = await resolveConfig(filename);
  validateConfigInputs(config);
  return config;
}
