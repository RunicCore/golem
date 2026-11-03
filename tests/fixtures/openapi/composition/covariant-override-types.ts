import type { Cat, Derived } from './index.js';

declare const derived: Derived;
const pet: Cat | undefined = derived.pet;
const pets: readonly Cat[] | undefined = derived.pets;

void pet; void pets;
