import type { Visit } from './index.js';

declare const visit: Visit;
const at: Date | undefined = visit.m.at;
const name: string | undefined = visit.m.name;

void at; void name;
