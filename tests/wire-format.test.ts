import test from 'node:test';

import { fileFixtureScope, onceShared } from './fixture-project.js';
import { assertWireClaimHolds, buildWireClaims, wireClaimsProject, type WireClaim } from './support/wire-claim-project.js';

const MODEL_CLAIMS: readonly WireClaim[] = [
  { claim: 'tags drop and literals stay literal, for the alias and the handwritten class', fixture: 'kinds' },
  { claim: 'a tagged literal keeps its tag, mutually assignable with the emitted type', fixture: 'tagged-literals' },
  { claim: 'a Date is a string and a TSerde field is its deserializer input', fixture: 'dates-and-serde' },
  { claim: 'tuples with optional, rest, labeled and readonly positions map each position', fixture: 'tuples' },
  { claim: 'readonly arrays and tuples, explicit undefined and generic optional tuple positions', fixture: 'readonly-and-optional-tuples' },
  { claim: 'arrays, records, unknown, null, unions and optional fields map element-wise', fixture: 'containers' },
  { claim: 'model-typed record values, tuple positions, tuple rest, union members and array items', fixture: 'model-containers' },
  { claim: 'object intersections, unions of intersections, a literal with a non-tag object, and a root intersection', fixture: 'intersections' },
  { claim: 'nested, projected, recursive and union-selected models map to their own emitted type', fixture: 'nested-models' },
  { claim: 'constraint tags on objects and arrays are dropped', fixture: 'constraint-tags' },
];

// One build checks every claim; each test reads the compiler errors of its own fixture folder.
const fileScope = fileFixtureScope();
const claimsBuild = onceShared(() => buildWireClaims(wireClaimsProject(fileScope, MODEL_CLAIMS.map(({ fixture }) => fixture), false).root));

for (const { claim, fixture } of MODEL_CLAIMS) {
  test(`WireFormat<T> equals the emitted JSON type: ${claim}`, async () => {
    assertWireClaimHolds(await claimsBuild(), fixture);
  });
}
