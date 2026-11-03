import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { createFixtureProject } from '../fixture-project.js';

type Mapping = 'first' | 'second';

/**
 * A project whose `@mapped` path alias resolves to `first.ts` or `second.ts`, so a program shows which version of
 * the tsconfig it was built from by the files it contains.
 */
export interface PathMappedProject {
  readonly root: string;
  readonly tsconfig: string;
  /** A package manifest; changing it invalidates module resolution. */
  readonly manifest: string;
  /** Imports `@mapped`. */
  readonly app: string;
  /** In a directory the project's first program does not open. */
  readonly sdk: string;
  writeMapping(mapping: Mapping): void;
  /** Change the manifest to a content with another size. */
  changeManifest(): void;
  /** Which mapped file the program contains. */
  mappingOf(program: { getSourceFiles(): readonly { readonly fileName: string }[] }): Mapping | undefined;
}

export function pathMappedProject(t: TestContext, prefix: string): PathMappedProject {
  const root = createFixtureProject(t, `${prefix}-`);
  const tsconfig = path.join(root, 'tsconfig.json');
  const manifest = path.join(root, 'package.json');
  const app = path.join(root, 'src/app.ts');
  const sdk = path.join(root, 'sdk/value.ts');
  fs.mkdirSync(path.dirname(app));
  fs.mkdirSync(path.dirname(sdk));
  fs.writeFileSync(manifest, '{"type":"module"}');
  fs.writeFileSync(app, "import type { Mapped } from '@mapped';\nexport type App = Mapped;\n");
  fs.writeFileSync(sdk, 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'first.ts'), 'export type Mapped = 1;\n');
  fs.writeFileSync(path.join(root, 'second.ts'), 'export type Mapped = 2;\n');
  const writeMapping = (mapping: Mapping): void => {
    fs.writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', paths: { '@mapped': [`./${mapping}.ts`] } },
      include: ['src', 'sdk'],
    }));
  };
  writeMapping('first');
  let manifestChanges = 0;
  return {
    root,
    tsconfig,
    manifest,
    app,
    sdk,
    writeMapping,
    changeManifest: () => fs.writeFileSync(manifest, `{"type":"module"${' '.repeat(++manifestChanges)}}`),
    mappingOf: (program) => {
      const names = program.getSourceFiles().map(file => path.resolve(file.fileName));
      return (['first', 'second'] as const).find(mapping => names.includes(path.join(root, `${mapping}.ts`)));
    },
  };
}
