import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { createFixtureProject, linkProjectPackages, writeGeneratedArtifacts } from '../../fixture-project.js';
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

export function createControllerFixture(t: TestContext, options: ControllerFixtureOptions): string {
  const root = createFixtureProject(t, options.prefix);

  if (options.links === 'workspace') {
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  } else if (options.links !== 'none') {
    linkProjectPackages(root, {
      '@nestjs/common': path.join(workspace, 'node_modules/@nestjs/common'),
      '@nestjs/swagger': path.join(workspace, 'node_modules/@nestjs/swagger'),
      '@exprtlabs/golem': path.join(workspace, 'packages/golem'),
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
  return root;
}
