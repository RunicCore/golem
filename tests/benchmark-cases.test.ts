import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BENCH_ADAPTERS, BENCH_OPERATIONS, CASES, GROUPS, timedCases } from '../scripts/benchmark/cases.js';

test('every adapter belongs to exactly one group, and groups name only declared adapters', () => {
  const declared = new Set(BENCH_ADAPTERS.map(a => a.id));
  const owner = new Map<string, string>();
  for (const group of GROUPS) {
    for (const adapters of Object.values(group.operations)) {
      assert.equal(new Set(adapters).size, adapters.length, `${group.id}: duplicate adapter in one operation's list`);
      for (const adapter of adapters) {
        assert.ok(declared.has(adapter), `${group.id}: ${adapter} is not declared`);
        assert.ok(!owner.has(adapter) || owner.get(adapter) === group.id, `${adapter} is in ${owner.get(adapter)} and ${group.id}`);
        owner.set(adapter, group.id);
      }
    }
  }
  for (const adapter of BENCH_ADAPTERS) assert.equal(owner.get(adapter.id), adapter.group, adapter.id);
});

test('Typia is not timed on checkout and says why', () => {
  const typia = CASES.filter(c => c.payload === 'checkout' && c.adapter === 'typia');
  assert.equal(typia.length, BENCH_OPERATIONS.length, 'one unsupported case per operation it is timed on');
  assert.ok(typia.every(c => c.support === 'none' && /convert/.test(c.note ?? '')));
  assert.ok(!timedCases().some(c => c.payload === 'checkout' && c.adapter === 'typia'));
});

test('benchmark fixtures are fair: timed operations do no setup and Typia uses the exact variants', () => {
  const fixtures = path.resolve(import.meta.dirname, '../../scripts/benchmark/fixtures');
  for (const file of ['upstream/codegen.ts', 'features/comparison-features-codegen.ts', 'upstream/codegen-object.ts', 'features/comparison-features-codegen-object.ts']) {
    const source = readFileSync(path.join(fixtures, file), 'utf8');
    const timed = [...source.matchAll(/^\s*(?:'(?:object-to-model|model-to-object|text-to-model|model-to-text)'|validate): (?:\(\) => .*|decode),?$/gm)].map(m => m[0]);
    assert.ok(timed.length >= 3, `${file}: timed operations found`);
    // Each timed call goes straight to a codec resolved once per fixture (or the decode helper built on it).
    for (const line of timed) assert.match(line, /: (?:\(\) => (?:codec|checkout)\.\w+\([^()]*\),?|decode,?|\(\) => \{)$/, `${file}: ${line.trim()}`);
    assert.match(source, /const decode = \(\): object => checkout\.fromWireFormat\(input\.payload, decodeOptions\)|const codec = requireObjectCodec\(codecId\(input\)\);|const checkout = requireObjectCodec<TJsonCheckout>\('JsonCheckout'\);/, file);
  }
  const typia = readFileSync(path.join(fixtures, 'upstream/typia.ts'), 'utf8');
  assert.doesNotMatch(typia, /createIs<|createAssertParse<|createAssertStringify</, 'upstream/typia.ts');
  assert.match(typia, /createEquals</, 'upstream/typia.ts');
});

test('every timed Codegen case has a timed peer for the same payload and operation in its group', () => {
  const groupOf = new Map(BENCH_ADAPTERS.map(a => [a.id, a.group]));
  const codegen = new Set(BENCH_ADAPTERS.filter(a => a.library === '@exprtlabs/golem').map(a => a.id));
  for (const group of GROUPS) {
    for (const [operation, adapters] of Object.entries(group.operations)) {
      if (adapters.length === 0) continue;
      assert.ok(adapters.some(a => codegen.has(a)), `${group.id}/${operation} has no Codegen adapter`);
    }
  }
  const timed = timedCases();
  for (const c of timed.filter(c => codegen.has(c.adapter))) {
    assert.ok(timed.some(peer => !codegen.has(peer.adapter) && peer.payload === c.payload && peer.operation === c.operation
      && groupOf.get(peer.adapter) === groupOf.get(c.adapter)), `${c.payload}/${c.operation}/${c.adapter} has no timed peer`);
  }
});
