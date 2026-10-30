import type { Visit } from './types.js';

declare const visit: Visit;
const visits: Date[] | null = visit.visits;

void visits;
