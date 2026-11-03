import type { Visit } from './index.js';

declare const visit: Visit;
const id: string = visit.m.id;
const at: Date | undefined = visit.m.at;
const variant: string | undefined = visit.m.kind === 'a' ? visit.m.a : visit.m.b;

void id;
void at;
void variant;
