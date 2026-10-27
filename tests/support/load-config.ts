import { resolveConfig, validateConfigInputs, type GolemConfig } from '#golem/config';

/** The configuration as `golem generate` reads it: resolved, then checked against the files on disk. */
export function loadConfig(filename: string): GolemConfig {
  const config = resolveConfig(filename);
  validateConfigInputs(config);
  return config;
}
