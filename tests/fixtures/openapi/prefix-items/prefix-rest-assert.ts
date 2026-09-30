
import type { PutRestTupleOperationSuccessBody } from './types.js';
const empty: PutRestTupleOperationSuccessBody = [];
const short: PutRestTupleOperationSuccessBody = ['a'];
const full: PutRestTupleOperationSuccessBody = ['a', 1];
const rest: PutRestTupleOperationSuccessBody = ['a', 1, true, false];
void empty; void short; void full; void rest;
// @ts-expect-error wrong element type in prefix
const wrong: PutRestTupleOperationSuccessBody = [1];
void wrong;
