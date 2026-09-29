import type { BlockedOperationInput } from './types.js';

const blockedEmpty: BlockedOperationInput = {};
void blockedEmpty;
// @ts-expect-error queryValue's content schema is `false`, so the field type is never, not string
const wrongQueryValue: BlockedOperationInput = { query: { queryValue: 'x' } };
void wrongQueryValue;
