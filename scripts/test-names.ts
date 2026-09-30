import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test names in a node TAP report, subtests joined to their parents with " > ".
// Node prints a subtest's result before its parent's, so names come from the
// pre-order `# Subtest:` lines.
export function testNames(tap: string): Set<string> {
  const names = new Set<string>();
  const stack: string[] = [];
  for (const line of tap.split(/\r?\n/)) {
    const match = /^((?: {4})*)# Subtest: (.*)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length / 4;
    stack.length = depth;
    stack.push(match[2]);
    names.add(stack.join(' > '));
  }
  return names;
}

// Usage: node .build/scripts/test-names.js <before.tap> <after.tap>
// Prints names only in the first report, then names only in the second; exits 1 if either is non-empty.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [before, after] = process.argv.slice(2);
  if (!before || !after) throw new Error('Usage: node .build/scripts/test-names.js <before.tap> <after.tap>');
  const a = testNames(fs.readFileSync(before, 'utf8'));
  const b = testNames(fs.readFileSync(after, 'utf8'));
  const removed = [...a].filter(name => !b.has(name)).sort();
  const added = [...b].filter(name => !a.has(name)).sort();
  process.stdout.write(`removed (${removed.length}):\n${removed.join('\n')}\nadded (${added.length}):\n${added.join('\n')}\n`);
  if (removed.length || added.length) process.exitCode = 1;
}
