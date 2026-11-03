import type { Derived } from './index.js';

declare const derived: Derived;
const b: undefined = derived.b;

void b;
