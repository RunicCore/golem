import fs from 'node:fs';
import path from 'node:path';
import { createFixtureProject, linkProjectPackages, listProjectDependencies, writeGeneratedArtifacts, type FixtureScope } from '../../fixture-project.js';
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

/** A project source that imports the module of `NestModelInterceptor`. It turns the NestJS side of the rewrite on, as the file that registers the interceptor does in an app. */
export const NEST_INTERCEPTOR_SOURCE = "export { NestModelInterceptor } from '@exprtlabs/golem/nest';\n";

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

const GOLEM_PACKAGES = ['golem', 'golem-model', 'golem-openapi', 'golem-ts-openapi'].map(name => `@exprtlabs/${name}`);

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
