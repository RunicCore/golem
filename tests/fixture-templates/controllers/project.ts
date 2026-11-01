import fs from 'node:fs';
import path from 'node:path';
import { createFixtureProject, linkProjectPackages, listProjectDependencies, writeGeneratedArtifacts, type FixtureScope } from '../../fixture-project.js';
import { loadRewriteParticipants } from '#golem/rewrite-participant';
import { workspace } from '../../support/process.js';

export interface ControllerFixtureOptions {
  readonly prefix: string;
  readonly sourceFile?: string;
  readonly source?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly packageName?: string;
  readonly packageFields?: Readonly<Record<string, unknown>>;
  readonly tsconfig?: Readonly<Record<string, unknown>>;
  readonly links?: 'nest-declarations' | 'workspace' | 'none';
}

/** The rewrite participant of the nest extension as core loads it for `extensions: { nest: { nonModelInputs } }`, for each `nonModelInputs` value: what a golem.yaml with that entry gives a scan. */
export const NEST_PARTICIPANTS = Object.fromEntries(await Promise.all((['error', 'warn'] as const).map(async (nonModelInputs) => [nonModelInputs, await loadRewriteParticipants([{
  package: '@exprtlabs/golem-ts-openapi', block: 'ts-openapi', name: 'nest', entry: path.join(workspace, 'packages/golem-ts-openapi/dist/nest/rewrite-participant.js'), options: { nonModelInputs },
}])] as const))) as Record<'error' | 'warn', Awaited<ReturnType<typeof loadRewriteParticipants>>>;

const defaultTsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    experimentalDecorators: true,
    skipLibCheck: true,
  },
  include: ['src/**/*.ts'],
};

const GOLEM_PACKAGES = ['golem', 'golem-model', 'golem-openapi-ts', 'golem-ts-openapi'].map(name => `@exprtlabs/${name}`);

/** A project that links the workspace packages (every link but `none`) lists the golem packages as dependencies, so a block of golem.yaml finds its package. */
export function createControllerFixture(t: FixtureScope, options: ControllerFixtureOptions): string {
  const root = createFixtureProject(t, options.prefix);

  if (options.links === 'workspace') {
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } else if (options.links !== 'none') {
    linkProjectPackages(root, {
      '@nestjs/common': path.join(workspace, 'node_modules/@nestjs/common'),
      '@nestjs/swagger': path.join(workspace, 'node_modules/@nestjs/swagger'),
      ...Object.fromEntries(GOLEM_PACKAGES.map(name => [name, path.join(workspace, 'packages', name.slice('@exprtlabs/'.length))])),
    });
  }

  const packageJson = {
    ...(options.packageName === undefined ? {} : { name: options.packageName }),
    private: true,
    type: 'module',
    ...options.packageFields,
  };
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify(options.tsconfig ?? defaultTsconfig, null, 2)}\n`,
    ...(options.source === undefined ? {} : { [options.sourceFile ?? 'src/catalog.controller.ts']: options.source }),
    ...options.files,
  };
  writeGeneratedArtifacts(Object.entries(files).map(([relative, content]) => ({
    path: path.join(root, relative),
    content,
  })));
  if (options.links !== 'none') listProjectDependencies(root, GOLEM_PACKAGES);
  return root;
}
