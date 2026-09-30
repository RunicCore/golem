// Every third-party package spec the packed and browser tests pass to
// `npm install`. The tests import these specs, and `test:prepare` installs the
// whole list to fill the npm cache, so the two cannot drift apart. Packages
// that the tests install from a maintained example's own manifest are warmed
// from that manifest, not listed here.
const versions = { mobx: '^6.13.0', ajv: '^8.20.0', 'ajv-formats': '^3.0.1', typescript: '~7.0.2', ttsc: '~0.30.4' };

/** Version shared by the Nest packages the packed tests install next to the example manifest's own. */
export const NEST_VERSION = '11.2.3';
export const NEST_COMMON = `@nestjs/common@${NEST_VERSION}`;
export const NEST_SWAGGER = '@nestjs/swagger@11.4.7';
export const NEST_PLATFORM_FASTIFY = `@nestjs/platform-fastify@${NEST_VERSION}`;
export const MOBX = `mobx@${versions.mobx}`;
export const AJV = `ajv@${versions.ajv}`;
export const AJV_FORMATS = `ajv-formats@${versions['ajv-formats']}`;
export const AJV_PINNED = 'ajv@8.20.0';
export const AJV_FORMATS_PINNED = 'ajv-formats@3.0.1';
export const ESBUILD = 'esbuild@0.25.12';
export const TYPESCRIPT = `typescript@${versions.typescript}`;
export const TTSC = `ttsc@${versions.ttsc}`;

export const THIRD_PARTY_INSTALLS: readonly string[] = [
  NEST_COMMON, NEST_SWAGGER, NEST_PLATFORM_FASTIFY,
  MOBX, AJV, AJV_FORMATS, AJV_PINNED, AJV_FORMATS_PINNED,
  ESBUILD, TYPESCRIPT, TTSC,
];
