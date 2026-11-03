import type { GetItemOperationInput } from './types.js';

const valid: GetItemOperationInput = { path: { id: 5 }, query: { tag: 3 } };
void valid;
// @ts-expect-error the operation parameter overrides the path parameter's schema to an integer
const wrongId: GetItemOperationInput = { path: { id: '5' } };
void wrongId;
