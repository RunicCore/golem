import fs from 'node:fs';
import path from 'node:path';

// The incremental test build does not remove output for renamed or deleted
// test sources. Delete emitted JavaScript whose TypeScript source is gone and
// keep the rest, so unchanged tests are not recompiled.
const sources = path.resolve('tests');
const output = path.resolve('.build/tests');

function visit(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
      if (fs.readdirSync(filename).length === 0) fs.rmdirSync(filename);
      continue;
    }
    const emitted = /\.js(?:\.map)?$/.exec(entry.name);
    if (!emitted) continue;
    const source = path.join(sources, path.relative(output, filename)).slice(0, -emitted[0].length) + '.ts';
    if (!fs.existsSync(source)) fs.rmSync(filename);
  }
}

visit(output);
