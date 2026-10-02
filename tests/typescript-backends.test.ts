import assert from 'node:assert/strict';
import test from 'node:test';
import * as ts from '@exprtlabs/golem/ts';
import type * as Six from '#golem/typescript-ts6';
import type * as Seven from '#golem/typescript-ts7';
import type { TypeScriptBackend } from '#golem/typescript-types';

type MissingFrom<Backend> = Exclude<keyof TypeScriptBackend, keyof Backend>;
type MustBeNever<Names extends never> = Names;
// Each line stops compiling when its backend module lacks a name the seam declares.
export type SixProvidesTheSeam = MustBeNever<MissingFrom<typeof Six>>;
export type SevenProvidesTheSeam = MustBeNever<MissingFrom<typeof Seven>>;

test('every name the facade exports is defined on the active backend', () => {
  assert.deepEqual(Object.entries(ts).filter(([, value]) => value === undefined).map(([name]) => name), []);
  assert.match(ts.typescriptVersion, /^[67]\./);
});
