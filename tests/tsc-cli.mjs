#!/usr/bin/env node
/**
 * tsc launcher for tests that type-check generated SDKs and consumers outside any project root. It accepts a short
 * tsc-style file list by writing a temporary tsconfig and invoking `tsc -p`. These sources hold no rewrite sites, so they
 * need no `golem build`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc');
const args = process.argv.slice(2);
const env = { ...process.env, NODE_PATH: join(repoRoot, 'node_modules') };

if (args.some((arg) => arg === '-p' || arg === '--project' || arg === '-b' || arg === '--build')) {
  const result = spawnSync(process.execPath, [tsc, ...args], { stdio: 'inherit', env });
  process.exit(result.status ?? 1);
}

const booleanFlags = new Set([
  '--noEmit',
  '--strict',
  '--skipLibCheck',
  '--noUnusedLocals',
  '--noUnusedParameters',
  '--noEmitOnError',
]);
const valueFlags = new Set([
  '--target',
  '--module',
  '--moduleResolution',
  '--lib',
  '--outDir',
  '--rootDir',
]);

const compilerOptions = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  skipLibCheck: true,
  typeRoots: [join(repoRoot, 'node_modules/@types')],
};
const files = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const [name, inline] = arg.startsWith('--') && arg.includes('=')
    ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
    : [arg, undefined];
  if (booleanFlags.has(name)) {
    compilerOptions[name.slice(2)] = true;
    continue;
  }
  if (valueFlags.has(name)) {
    const value = inline ?? args[index + 1];
    if (inline === undefined) index += 1;
    if (name === '--lib' || name === '--types') {
      compilerOptions[name.slice(2)] = String(value).split(',');
    } else {
      compilerOptions[name.slice(2)] = value;
    }
    continue;
  }
  if (arg.startsWith('-')) {
    process.stderr.write(`tsc-cli.mjs: unsupported flag ${arg}\n`);
    process.exit(2);
  }
  files.push(isAbsolute(arg) ? arg : resolve(process.cwd(), arg));
}

function commonRootDir(filenames) {
  if (filenames.length === 0) return undefined;
  const parts = filenames.map((filename) => dirname(filename).split('/'));
  const first = parts[0] ?? [];
  let count = first.length;
  for (const current of parts.slice(1)) {
    let shared = 0;
    while (shared < count && shared < current.length && current[shared] === first[shared]) shared += 1;
    count = shared;
  }
  return first.slice(0, Math.max(count, 1)).join('/') || '/';
}

const cwd = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'tsc-cli-'));
const resolvedOutDir = compilerOptions.outDir
  ? (isAbsolute(String(compilerOptions.outDir)) ? String(compilerOptions.outDir) : resolve(cwd, String(compilerOptions.outDir)))
  : undefined;
const resolvedRootDir = compilerOptions.rootDir
  ? (isAbsolute(String(compilerOptions.rootDir)) ? String(compilerOptions.rootDir) : resolve(cwd, String(compilerOptions.rootDir)))
  : commonRootDir(files);
let status = 1;
try {
  writeFileSync(join(directory, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      ...compilerOptions,
      types: compilerOptions.types ?? ['node'],
      ...(resolvedOutDir ? { outDir: resolvedOutDir } : {}),
      ...(resolvedRootDir ? { rootDir: resolvedRootDir } : {}),
    },
    files,
  }, null, 2)}\n`);

  const result = spawnSync(process.execPath, [tsc, '-p', join(directory, 'tsconfig.json')], {
    stdio: 'inherit',
    env,
    cwd,
  });
  status = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exit(status);
