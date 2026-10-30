import type { Visit } from './index.js';

declare const visit: Visit;
const m: { at?: Date } = visit.m;

void m;
