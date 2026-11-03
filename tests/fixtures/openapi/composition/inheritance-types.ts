import type { Derived } from './index.js';

declare const derived: Derived;
const baseAt: Date = derived.baseAt;
const derivedAt: Date = derived.derivedAt;
const label: string | undefined = derived.label;

void baseAt; void derivedAt; void label;
