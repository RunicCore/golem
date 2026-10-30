import type { M, Visit } from './index.js';

declare const visit: Visit;
const x: M | undefined = visit.m.x;

void x;
