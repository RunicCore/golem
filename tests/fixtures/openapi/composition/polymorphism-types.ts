import type { Cat, Dog, Pet } from './index.js';

// Pet is the union of its variants, discriminated by kind.
declare const pet: Pet;
const variant: Cat | Dog = pet;
const born: Date | undefined = pet.kind === 'cat' ? pet.born : undefined;

void variant;
void born;
