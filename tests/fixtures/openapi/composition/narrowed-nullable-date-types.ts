import type { Derived } from './index.js';

declare const derived: Derived;
const deletedAt: Date | undefined = derived.deletedAt;

void deletedAt;
