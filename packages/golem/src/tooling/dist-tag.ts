/**
 * The npm dist-tag for a golem release version: the prerelease channel (`1.0.0-rc` or `1.0.0-rc.2` → `rc`), or `latest`
 * for a stable version. The generator packages are published in lockstep under the same tag.
 */
export function distTagForVersion(version: string): string {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  return prerelease ?? 'latest';
}
