import type { TSnapshotFields, TSnapshotInit, TSnapshotJSON } from './snapshot.model.generated.js';

const fields: TSnapshotFields = { names: ['north'], pair: ['head'], trailing: ['head', 1, true], required: 'ok', nested: {} };
const initializer: TSnapshotInit = { names: ['north'], pair: ['head'], trailing: ['head', 1, true], required: 'ok', nested: {} };
const wire: TSnapshotJSON = { names: ['north'], pair: ['head'], trailing: ['head', 1, true], required: 'ok', nested: {} };
const readonlyNames: readonly string[] = ['south'];
const readonlyPair: readonly [head: string, count?: number] = ['head'];
const readonlyTrailing: readonly [head: string, ...middle: number[], tail: boolean] = ['head', 1, true];
const compatibleInitializer: TSnapshotInit = { names: readonlyNames, pair: readonlyPair, trailing: readonlyTrailing, required: 'ok', nested: {} };
const explicitUndefined: TSnapshotInit = { explicitUndefined: ['head', undefined] };
const genericUndefined: TSnapshotInit = { genericUndefined: [undefined] };
// @ts-expect-error optional tuple slots preserve exact optional semantics
const invalidTuple: TSnapshotInit = { pair: ['head', undefined] };
// @ts-expect-error instantiated generic optional tuples stay exact
const invalidGeneric: TSnapshotInit = { generic: [undefined] };
// @ts-expect-error generated field properties stay readonly
fields.names = [];
// @ts-expect-error generated field arrays stay readonly
fields.names.push('mutable');
// @ts-expect-error generated tuple positions stay readonly
fields.pair[0] = 'mutable';
// @ts-expect-error generated rest tuple positions stay readonly
fields.trailing[1] = 2;
// @ts-expect-error initializer arrays stay readonly
initializer.names.push('mutable');
// @ts-expect-error initializer tuple positions stay readonly
initializer.pair[0] = 'mutable';
// @ts-expect-error wire arrays stay readonly
wire.names.push('mutable');
// @ts-expect-error optional values do not accept explicit undefined under exact optional semantics
const invalidOptional: TSnapshotInit = { names: [], pair: ['head'], trailing: ['head', false], required: 'ok', nested: {}, optional: undefined };

void [fields, initializer, wire, compatibleInitializer, explicitUndefined, genericUndefined, invalidTuple, invalidGeneric, invalidOptional];
