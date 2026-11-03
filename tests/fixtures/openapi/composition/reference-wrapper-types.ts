import type { Person, Visit } from './index.js';

declare const visit: Visit;
const owner: Person = visit.owner;

void owner;
