import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface SpiedCall { readonly name: string; readonly args: readonly unknown[] }

/**
 * Redirect the runtime exports named in `spied` (by subpath) that the built modules of a project import to wrappers that
 * record each call and run the real function; the test's own imports reach the real exports. `requests` lists the module
 * requests of the built modules. Start it after the build and before the first import of a built module, and `stop` it.
 */
export async function spyOnBuild(root: string, spied: Readonly<Record<string, readonly string[]>>) {
  fs.writeFileSync(path.join(root, 'spy-calls.mjs'), 'export const calls = [];\n');
  const redirects = new Map<string, string>();
  Object.entries(spied).forEach(([specifier, names], index) => {
    const file = path.join(root, `spy-${index}.mjs`);
    fs.writeFileSync(file, [
      `import * as real from '${specifier}';`,
      "import { calls } from './spy-calls.mjs';",
      `export * from '${specifier}';`,
      ...names.map((name) => `export const ${name} = (...args) => { calls.push({ name: '${name}', args }); return real.${name}(...args); };`),
    ].join('\n'));
    redirects.set(specifier, pathToFileURL(file).href);
  });
  const built = pathToFileURL(path.join(fs.realpathSync(root), 'build') + path.sep).href;
  const requests: { readonly specifier: string; readonly importer: string }[] = [];
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(built)) {
        requests.push({ specifier, importer: path.basename(fileURLToPath(context.parentURL)) });
        const redirect = redirects.get(specifier);
        if (redirect !== undefined) return { url: redirect, format: 'module', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const { calls } = await import(pathToFileURL(path.join(root, 'spy-calls.mjs')).href) as { calls: SpiedCall[] };
  return { calls, requests, stop: () => hooks.deregister() };
}
