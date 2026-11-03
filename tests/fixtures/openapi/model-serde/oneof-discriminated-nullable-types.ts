import type { Cat, Dog, Visit } from './types.js';

declare const visit: Visit;
const pet: Dog | Cat = visit.pet;

void pet;
