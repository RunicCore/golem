import type { Visit } from './index.js';

declare const visit: Visit;
const at: Date | undefined = visit.m?.at;
const b: Date | undefined = visit.m?.b;

void at; void b;
