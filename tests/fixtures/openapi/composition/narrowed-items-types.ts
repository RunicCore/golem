import type { Derived } from './index.js';

declare const derived: Derived;
const stamps: readonly Date[] | undefined = derived.stamps;

void stamps;
