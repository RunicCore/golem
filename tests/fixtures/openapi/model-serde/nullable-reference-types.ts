import type { Pet, Visit } from './types.js';

declare const visit: Visit;
const pet: Pet | null = visit.pet;
visit.pet = null;

void pet;
