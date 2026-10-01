import path from 'node:path';

/**
 * The ttsc caches every test-time ttsc run shares. The plugin binary cache is keyed by the plugin sources, not by
 * the project's location, so a fixture project or the pack step's staging copy reuses the workspace's build instead
 * of building its own. A build in a throwaway directory also writes Go cache entries keyed by that directory's
 * random path, which no later run can reuse (about 1.6 GiB per pack step before this shared cache).
 */
export function ttscCacheEnv(workspace: string): { readonly TTSC_CACHE_DIR: string; readonly TTSC_GO_CACHE_DIR: string } {
  const cacheDir = path.join(workspace, 'node_modules/.cache/ttsc');
  return { TTSC_CACHE_DIR: cacheDir, TTSC_GO_CACHE_DIR: path.join(cacheDir, 'go-build') };
}
