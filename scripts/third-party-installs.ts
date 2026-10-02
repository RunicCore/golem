import fs from 'node:fs';

// Every third-party package spec the packed and browser tests pass to
// `npm install`. The tests import these specs, and `test:prepare` installs the
// whole list to fill the npm cache, so the two cannot drift apart. Packages
// that a test installs from a fixture's own manifest are warmed from that
// manifest, not listed here; the Nest specs below read the same manifest so
// there is one place to change a Nest version.
const versions = { mobx: '^6.13.0', ajv: '^8.20.0', 'ajv-formats': '^3.0.1', typescript: '~7.0.2', typescript6: '~6.0.3' };

const nestAppManifest: { dependencies: Record<string, string> } = JSON.parse(
  fs.readFileSync(new URL('../../tests/fixtures/packed/nest-app/package.json', import.meta.url), 'utf8'),
);

function nestAppSpec(name: string): string {
  const version = nestAppManifest.dependencies[name];
  if (!version) throw new Error(`tests/fixtures/packed/nest-app/package.json does not declare ${name}.`);
  return `${name}@${version}`;
}

export const NEST_COMMON = nestAppSpec('@nestjs/common');
export const NEST_SWAGGER = nestAppSpec('@nestjs/swagger');
export const MOBX = `mobx@${versions.mobx}`;
export const AJV = `ajv@${versions.ajv}`;
export const AJV_FORMATS = `ajv-formats@${versions['ajv-formats']}`;
export const AJV_PINNED = 'ajv@8.20.0';
export const AJV_FORMATS_PINNED = 'ajv-formats@3.0.1';
export const ESBUILD = 'esbuild@0.25.12';
export const TYPESCRIPT = `typescript@${versions.typescript}`;
export const TYPESCRIPT6 = `typescript@${versions.typescript6}`;

export const THIRD_PARTY_INSTALLS: readonly string[] = [
  NEST_COMMON, NEST_SWAGGER,
  MOBX, AJV, AJV_FORMATS, AJV_PINNED, AJV_FORMATS_PINNED,
  ESBUILD, TYPESCRIPT, TYPESCRIPT6,
];
