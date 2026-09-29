
import type { PutTupleOperationSuccessBody } from './types.js';
const empty: PutTupleOperationSuccessBody = [];
const short: PutTupleOperationSuccessBody = ['a'];
const full: PutTupleOperationSuccessBody = ['a', 1];
void empty; void short; void full;
// @ts-expect-error wrong element type
const wrong: PutTupleOperationSuccessBody = [1];
// @ts-expect-error excess positional value is not in the type
const extra: PutTupleOperationSuccessBody = ['a', 1, true];
void wrong; void extra;
