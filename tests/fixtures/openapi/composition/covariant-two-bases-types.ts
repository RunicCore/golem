import type { Cat, Derived } from './index.js';

declare const derived: Derived;
const named: Cat | undefined = derived.named;

void named;
