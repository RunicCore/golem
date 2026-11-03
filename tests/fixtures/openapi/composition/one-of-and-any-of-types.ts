import type { Visit } from './index.js';

declare const visit: Visit;
const variant: string = visit.m.kind === 'a' ? visit.m.a : visit.m.b;
const at: Date = visit.m.at;

void variant;
void at;
