import type { Derived } from './index.js';

declare const derived: Derived;
const a: string | undefined = derived.a;
const b: string | undefined = derived.b;
const c: string | undefined = derived.c;

void a; void b; void c;
