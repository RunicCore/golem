import type { Derived } from './index.js';

declare const derived: Derived;
const kind: 'cat' = derived.kind;
const at: Date | undefined = derived.at;

void kind; void at;
