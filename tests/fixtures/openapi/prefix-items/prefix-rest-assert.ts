
import type { PutTupleOperationSuccessBody } from './types.js';
const empty: PutTupleOperationSuccessBody = [];
const short: PutTupleOperationSuccessBody = ['a'];
const full: PutTupleOperationSuccessBody = ['a', 1];
const rest: PutTupleOperationSuccessBody = ['a', 1, true, false];
void empty; void short; void full; void rest;
// @ts-expect-error wrong element type in prefix
const wrong: PutTupleOperationSuccessBody = [1];
void wrong;
