import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { OPERATIONS, type FixtureModule } from './fixture-contract.js';

const [modulePath, validationText] = process.argv.slice(2);
if (!modulePath || !['true', 'false'].includes(validationText)) throw new Error('Usage: feature-check-worker.js <casesModule> <true|false>');
const suite: FixtureModule = await import(pathToFileURL(modulePath).href);
const fixtures = await suite.createFixtures(validationText === 'true');
for (const fixture of fixtures) await fixture.verify();
let checksum = 0;
const cases: string[] = [];
for (const fixture of fixtures) {
  for (const operation of OPERATIONS) {
    const run = fixture.operations[operation];
    if (!run) continue;
    checksum = (checksum + await run()) % 2_147_483_647;
    cases.push(`${fixture.name}/${operation}`);
  }
}
assert.ok(Number.isFinite(checksum) && checksum > 0, 'feature check must consume finite, nonzero results');
process.stdout.write(JSON.stringify({ checksum, cases, fixtures: fixtures.map(f => f.name) }));
