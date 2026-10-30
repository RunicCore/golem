import type { Pet, Visit } from './types.js';

declare const visit: Visit;
const either: Pet | string | null = visit.either;

visit.either = null;

void either;
