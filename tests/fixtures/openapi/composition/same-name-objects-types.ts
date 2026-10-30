import type { Visit } from './index.js';

declare const visit: Visit;
const at: Date | undefined = visit.m.o?.at;
const b: string | undefined = visit.m.o?.b;
const when: Date | undefined = visit.m.o?.when;

void at; void b; void when;
