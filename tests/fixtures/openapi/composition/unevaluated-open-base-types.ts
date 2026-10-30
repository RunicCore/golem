import type { Derived } from './index.js';

declare const derived: Derived;
const a: string | undefined = derived.a;
const b: Date | undefined = derived.b;

void a; void b;
